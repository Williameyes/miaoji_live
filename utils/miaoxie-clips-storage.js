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

module.exports = {
  CLIPS_KEY,
  normalizeMatchIdKey,
  readClipsMapSafe,
  writeClipsMapSafe,
  mergeDefaultClipBucketIfTargetEmpty
};
