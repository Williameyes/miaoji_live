/** @const {string} 高光按场次分桶的 Storage 主键 */
const CLIPS_KEY = 'MIAOXIE_CLIPS';

/**
 * 将任意 matchId 规范为与 `MIAOXIE_MATCHES[].id` 一致的字符串桶键。
 * @param {unknown} raw 原始 ID（可能来自 number / 空串）
 * @returns {string} 去空白后的字符串，非法时为 ''
 */
function normalizeMatchIdKey(raw) {
  if (raw == null) return '';
  return String(raw).trim();
}

/**
 * 安全读取高光 clips 映射表。禁止在返回 null 时用 `{}` 再写入，否则会覆盖整库。
 * @returns {Record<string, unknown[]>|null} 正常对象；缺失键为 `{}`；损坏为 null
 */
function readClipsMapSafe() {
  try {
    const raw = wx.getStorageSync(CLIPS_KEY);
    if (raw == null || raw === '') return {};
    if (typeof raw !== 'object' || Array.isArray(raw)) return null;
    return /** @type {Record<string, unknown[]>} */ (raw);
  } catch (e) {
    return null;
  }
}

/**
 * 写回高光映射表（捕获配额等异常）。
 * @param {Record<string, unknown>} map 映射表
 * @returns {boolean} 是否写入成功
 */
function writeClipsMapSafe(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
  try {
    wx.setStorageSync(CLIPS_KEY, map);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 历史逻辑在 matchId 为空时会把高光写入 `default` 桶，首页按真实场次 ID 读取会得到 0 条。
 * 当当前场次桶为空、存在 `default` 桶时，将 `default` 合并到当前场次并删除 `default`。
 * @param {string} currentMatchIdKey Storage `currentMatchId`
 * @returns {boolean} 是否成功写回 Storage
 */
function mergeDefaultClipBucketIfTargetEmpty(currentMatchIdKey) {
  const targetId = normalizeMatchIdKey(currentMatchIdKey);
  if (!targetId) return false;
  const map = readClipsMapSafe();
  if (!map) return false;
  const def = map.default;
  if (!Array.isArray(def) || def.length === 0) return false;
  const cur = map[targetId];
  if (Array.isArray(cur) && cur.length > 0) return false;
  map[targetId] = def.slice();
  delete map.default;
  return writeClipsMapSafe(map);
}

/**
 * 收集高光条目关联的本地文件路径（segments / replaySegment / replayPlan / wxfile 封面）。
 * @param {Record<string, unknown>|null|undefined} item
 * @returns {string[]}
 */
function collectClipFilePaths(item) {
  /** @type {Set<string>} */
  const paths = new Set();
  if (!item || typeof item !== 'object') return [];
  const segs = item.segments;
  if (Array.isArray(segs)) {
    segs.forEach((p) => {
      if (p && typeof p === 'string') paths.add(p);
    });
  }
  const rp = item.replaySegment;
  if (rp && typeof rp === 'string') paths.add(rp);
  const plan = item.replayPlan;
  if (Array.isArray(plan)) {
    plan.forEach((entry) => {
      if (entry && entry.path && typeof entry.path === 'string') paths.add(entry.path);
    });
  }
  const cover = item.cover;
  if (cover && typeof cover === 'string' && cover.indexOf('wxfile://') === 0) {
    paths.add(cover);
  }
  return Array.from(paths);
}

/**
 * 同步探测单条视频路径是否可播放（存在且体积 ≥ 64B）。
 * @param {string} p
 * @returns {boolean}
 */
function isClipPathPlayable(p) {
  if (!p || typeof p !== 'string') return false;
  try {
    const st = wx.getFileSystemManager().statSync(p);
    const sz = st && typeof st.size === 'number' ? st.size : 0;
    return sz >= 64;
  } catch (eStat) {
    return false;
  }
}

/**
 * 判断高光索引条目是否已无可用视频文件。
 * @param {Record<string, unknown>|null|undefined} item
 * @returns {boolean}
 */
function isClipEntryDead(item) {
  const paths = collectClipFilePaths(item);
  if (paths.length === 0) return true;
  return paths.every((p) => !isClipPathPlayable(p));
}

/**
 * 从映射表移除「索引在但视频文件已不可用」的高光，并尝试 unlink 残留路径。
 * @param {Record<string, unknown[]>} map
 * @returns {number} 删除条数
 */
function pruneUnplayableClipsFromMap(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return 0;
  const fs = wx.getFileSystemManager();
  let removed = 0;
  Object.keys(map).forEach((matchId) => {
    const list = map[matchId];
    if (!Array.isArray(list)) return;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const it = list[i];
      if (!isClipEntryDead(it)) continue;
      collectClipFilePaths(/** @type {Record<string, unknown>} */ (it)).forEach((p) => {
        try {
          fs.unlinkSync(p);
        } catch (eUn) {/* ignore */}
      });
      list.splice(i, 1);
      removed += 1;
    }
    if (list.length === 0) {
      delete map[matchId];
    }
  });
  return removed;
}

/**
 * 清理 legacy `highlight_list` 中视频文件已不可用条目。
 * @returns {number} 删除条数
 */
function pruneUnplayableLegacyList() {
  let legacyList = [];
  try {
    legacyList = wx.getStorageSync('highlight_list') || [];
  } catch (eRead) {
    return 0;
  }
  if (!Array.isArray(legacyList) || legacyList.length === 0) return 0;
  const fs = wx.getFileSystemManager();
  /** @type {Record<string, unknown>[]} */
  const kept = [];
  let removed = 0;
  legacyList.forEach((it) => {
    if (isClipEntryDead(it)) {
      collectClipFilePaths(it).forEach((p) => {
        try {
          fs.unlinkSync(p);
        } catch (eUn) {/* ignore */}
      });
      removed += 1;
      return;
    }
    kept.push(it);
  });
  if (removed > 0) {
    try {
      wx.setStorageSync('highlight_list', kept);
    } catch (eWrite) {/* ignore */}
  }
  return removed;
}

module.exports = {
  CLIPS_KEY,
  normalizeMatchIdKey,
  readClipsMapSafe,
  writeClipsMapSafe,
  mergeDefaultClipBucketIfTargetEmpty,
  collectClipFilePaths,
  isClipPathPlayable,
  isClipEntryDead,
  pruneUnplayableClipsFromMap,
  pruneUnplayableLegacyList
};
