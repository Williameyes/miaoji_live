/**
 * 小程序本地「用户文件」占用估算：平台无剩余配额 API，只能遍历 + stat/getFileInfo 累加。
 * iOS 主路径使用 readdirSync/statSync 同步 walk；档位与 totalMb 取 max(walk, clipBytes) 兜底漏计。
 */

/** 用于「严重」告警的参考上限（字节），与微信文档约 200MB 同量级 */
const CLIP_STORAGE_SEVERE_BYTES = 100 * 1024 * 1024;
/** 「注意」档位（字节） */
const CLIP_STORAGE_WARN_BYTES = 50 * 1024 * 1024;
/**
 * 沙盒总占用（USER_DATA_PATH）档位：滚动分段等可能未写入 MIAOXIE_CLIPS，
 * 若仅按高光路径估算会漏判「实际已很满」。
 */
const USER_DATA_WARN_BYTES = 100 * 1024 * 1024;
const USER_DATA_SEVERE_BYTES = 150 * 1024 * 1024;

const clipsStorage = require('./miaoxie-clips-storage.js');

/**
 * 拼接沙盒路径（避免重复或缺失斜杠）。
 * @param {string} base
 * @param {string} name
 * @returns {string}
 */
function joinSandboxPath(base, name) {
  if (!base || typeof base !== 'string') return typeof name === 'string' ? name : '';
  if (!name || typeof name !== 'string') return base;
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  const n = name.startsWith('/') ? name.slice(1) : name;
  return `${b}/${n}`;
}

/**
 * 单文件字节数（statSync；iOS 上比 getFileInfo 更稳定）。
 * @param {WechatMiniprogram.FileSystemManager} fs
 * @param {string} filePath
 * @returns {number}
 */
function fileSizeBytesSync(fs, filePath) {
  if (!filePath || typeof filePath !== 'string') return 0;
  try {
    const st = fs.statSync(filePath);
    if (st && typeof st.size === 'number' && st.size >= 0) {
      return st.size;
    }
  } catch (e) { /* ignore */ }
  return 0;
}

/**
 * 单文件字节数（优先 getFileInfo，失败或 size=0 时回退 statSync）。
 * @param {WechatMiniprogram.FileSystemManager} fs
 * @param {string} filePath
 * @returns {Promise<number>}
 */
function fileSizeBytesAsync(fs, filePath) {
  return new Promise((resolve) => {
    if (!filePath || typeof filePath !== 'string') {
      resolve(0);
      return;
    }
    fs.getFileInfo({
      filePath,
      success(res) {
        const sz = typeof res.size === 'number' ? res.size : 0;
        resolve(sz > 0 ? sz : fileSizeBytesSync(fs, filePath));
      },
      fail() {
        resolve(fileSizeBytesSync(fs, filePath));
      }
    });
  });
}

/**
 * 读取目录项名称（兼容 readdir / readdirSync 不同返回结构）。
 * @param {unknown} res
 * @returns {string[]}
 */
function readDirEntryNames(res) {
  if (Array.isArray(res)) return res;
  if (res && typeof res === 'object') {
    const obj = /** @type {{ files?: string[], fileList?: string[] }} */ (res);
    if (Array.isArray(obj.files)) return obj.files;
    if (Array.isArray(obj.fileList)) return obj.fileList;
  }
  return [];
}

/**
 * 同步递归遍历目录累计字节（与 orphan prune 同路径，iOS 上比异步 readdir 更可靠）。
 * @param {WechatMiniprogram.FileSystemManager} fs
 * @param {string} dirPath
 * @returns {number}
 */
function walkUserDataBytesSync(fs, dirPath) {
  if (!fs || !dirPath) return 0;
  const names = readDirEntryNames(fs.readdirSync(dirPath));
  if (names.length === 0) return 0;
  let sum = 0;
  names.forEach((name) => {
    if (!name) return;
    const full = joinSandboxPath(dirPath, name);
    let isDir = false;
    try {
      const st = fs.statSync(full);
      isDir = !!(st && typeof st.isDirectory === 'function' && st.isDirectory());
      if (!isDir) {
        sum += fileSizeBytesSync(fs, full);
        return;
      }
    } catch (eStat) {
      return;
    }
    sum += walkUserDataBytesSync(fs, full);
  });
  return sum;
}

/**
 * 异步递归遍历目录（保留供低版本探测；主路径请用 walkUserDataBytesSync）。
 * @param {WechatMiniprogram.FileSystemManager} fs
 * @param {string} dirPath
 * @returns {Promise<number>}
 */
function walkUserDataBytes(fs, dirPath) {
  return new Promise((resolve) => {
    fs.readdir({
      dirPath,
      success(res) {
        const names = readDirEntryNames(res);
        if (names.length === 0) {
          resolve(0);
          return;
        }
        let remaining = names.length;
        let sum = 0;
        names.forEach((name) => {
          const full = joinSandboxPath(dirPath, name);
          fs.stat({
            path: full,
            success(st) {
              const isDir = st && typeof st.isDirectory === 'function' && st.isDirectory();
              if (isDir) {
                walkUserDataBytes(fs, full).then((sub) => {
                  sum += sub;
                  remaining -= 1;
                  if (remaining === 0) resolve(sum);
                });
              } else {
                const statSize = st && typeof st.size === 'number' && st.size > 0 ? st.size : 0;
                if (statSize > 0) {
                  sum += statSize;
                  remaining -= 1;
                  if (remaining === 0) resolve(sum);
                  return;
                }
                fileSizeBytesAsync(fs, full).then((sz) => {
                  sum += sz;
                  remaining -= 1;
                  if (remaining === 0) resolve(sum);
                });
              }
            },
            fail() {
              remaining -= 1;
              if (remaining === 0) resolve(sum);
            }
          });
        });
      },
      fail() {
        resolve(0);
      }
    });
  });
}

/**
 * 估算 wx.env.USER_DATA_PATH 下已用字节（同步 walk，避免 iOS 异步 readdir 漏计）。
 * @returns {Promise<number>}
 */
function estimateUserDataPathUsageBytes() {
  try {
    const fs = wx.getFileSystemManager();
    const root = wx.env.USER_DATA_PATH;
    if (!root || typeof root !== 'string') {
      return Promise.resolve(0);
    }
    return Promise.resolve(walkUserDataBytesSync(fs, root));
  } catch (e) {
    return Promise.resolve(0);
  }
}

/**
 * 从 MIAOXIE_CLIPS 收集所有片段路径（去重），并累加 getFileInfo.size。
 * @returns {Promise<number>}
 */
function estimateClipSegmentsBytesFromStorage() {
  const fs = wx.getFileSystemManager();
  const rawMap = clipsStorage.readClipsMapSafe();
  const clipsMap = rawMap || {};
  /** @type {Set<string>} */
  const paths = new Set();
  Object.keys(clipsMap).forEach((matchId) => {
    const list = clipsMap[matchId];
    if (!Array.isArray(list)) return;
    list.forEach((it) => {
      if (!it || typeof it !== 'object' || it.exportedToAlbum) return;
      clipsStorage.collectClipFilePaths(it).forEach((p) => paths.add(p));
    });
  });
  const arr = Array.from(paths);
  if (arr.length === 0) return Promise.resolve(0);
  return Promise.all(arr.map((p) => fileSizeBytesAsync(fs, p))).then((sizes) =>
    sizes.reduce((a, b) => a + b, 0)
  );
}

/**
 * 读取 KV storage 占用（与视频文件无关，仅供首页参考）。
 * @returns {{ currentKb: number, limitKb: number }}
 */
function getKvStorageInfoSafe() {
  try {
    const info = wx.getStorageInfoSync();
    const currentKb = Number(info && info.currentSize);
    const limitKb = Number(info && info.limitSize);
    return {
      currentKb: Number.isFinite(currentKb) ? currentKb : 0,
      limitKb: Number.isFinite(limitKb) ? limitKb : 10240
    };
  } catch (e) {
    return { currentKb: 0, limitKb: 10240 };
  }
}

/**
 * 将字节数四舍五入为 MB（保留 1 位小数）。
 * @param {number} bytes
 * @returns {number}
 */
function bytesToMbRounded(bytes) {
  const n = typeof bytes === 'number' && bytes >= 0 ? bytes : 0;
  return Math.round((n / (1024 * 1024)) * 10) / 10;
}

/**
 * 根据高光片段体积与沙盒总占用给出健康度（两路合并取较高档位），并生成说明文案。
 * totalMb / 沙盒档位使用 max(walk, clip)，避免 iOS walk 漏计时 totalMb 远低于 clipMb。
 * @param {number} clipBytes 高光关联本地文件总字节
 * @param {number} userDataBytes USER_DATA_PATH walk 字节（原始遍历值）
 * @returns {{
 *   clipMb: number,
 *   totalMb: number,
 *   userDataWalkMb: number,
 *   userDataWalkBytes: number,
 *   effectiveTotalBytes: number,
 *   level: 'ok' | 'warn' | 'severe',
 *   hintText: string
 * }}
 */
function getClipStorageHealthHint(clipBytes, userDataBytes) {
  const c = typeof clipBytes === 'number' && clipBytes >= 0 ? clipBytes : 0;
  const walked = typeof userDataBytes === 'number' && userDataBytes >= 0 ? userDataBytes : 0;
  const effectiveTotalBytes = Math.max(walked, c);
  const clipMb = bytesToMbRounded(c);
  const userDataWalkMb = bytesToMbRounded(walked);
  const totalMb = bytesToMbRounded(effectiveTotalBytes);
  const clipSevere = c >= CLIP_STORAGE_SEVERE_BYTES;
  const clipWarn = c >= CLIP_STORAGE_WARN_BYTES;
  const totalSevere = effectiveTotalBytes >= USER_DATA_SEVERE_BYTES;
  const totalWarn = effectiveTotalBytes >= USER_DATA_WARN_BYTES;
  let level = 'ok';
  if (clipSevere || totalSevere) {
    level = 'severe';
  } else if (clipWarn || totalWarn) {
    level = 'warn';
  }
  let hintText = '';
  if (level === 'severe') {
    if (clipSevere && totalSevere) {
      hintText =
        `高光片段约 ${clipMb} MB，本机小程序文件约 ${totalMb} MB（空间严重紧张）：新片段可能保存失败，请删除旧片段或使用「下载至相册并清空」`;
    } else if (clipSevere) {
      hintText =
        `高光片段文件约 ${clipMb} MB（≥100MB ）：新片段可能保存失败，请删除旧片段或使用「下载至相册并清空」`;
    } else {
      hintText =
        `本机小程序文件约 ${totalMb} MB（含录像缓冲等，偏高）：新片段可能保存失败，请删除旧片段或使用「下载至相册并清空」`;
    }
  } else if (level === 'warn') {
    if (clipWarn && totalWarn) {
      hintText =
        `高光片段约 ${clipMb} MB，本机小程序文件约 ${totalMb} MB（注意）：长时间开播前建议清理或导出至相册`;
    } else if (clipWarn) {
      hintText = `高光片段文件约 ${clipMb} MB（≥50MB ）：长时间开播前建议清理或导出至相册`;
    } else {
      hintText = `本机小程序文件约 ${totalMb} MB（≥100MB ）：长时间开播前建议清理或导出高光至相册`;
    }
  } else {
    hintText = `高光片段约 ${clipMb} MB，本机约 ${totalMb} MB`;
  }
  return {
    clipMb,
    totalMb,
    userDataWalkMb,
    userDataWalkBytes: walked,
    effectiveTotalBytes,
    level,
    hintText
  };
}

/** @deprecated 保留兼容，新代码请用 getClipStorageHealthHint */
function getUserFileStorageHint(usedBytes) {
  return getClipStorageHealthHint(usedBytes, usedBytes);
}

/** 本地快照键：缓存最后一次估算，供直播页与 globalData 对齐 */
const FILE_STORAGE_LIVE_SNAPSHOT_KEY = 'miaoxie_file_storage_snapshot';

/**
 * 将估算结果写入本地快照（与 `app.globalData.fileStorageEstimate` 同步），避免仅依赖内存被覆盖或未写完就跳页。
 *
 * @param {{
 *   clipBytes?: number,
 *   userDataBytes?: number,
 *   userDataWalkBytes?: number,
 *   effectiveTotalBytes?: number,
 *   clipMb?: number,
 *   totalMb?: number,
 *   userDataWalkMb?: number,
 *   healthLevel?: string,
 *   hintText?: string,
 *   at?: number
 * }} est
 * @returns {void}
 */
function writeFileStorageEstimateSnapshot(est) {
  if (!est || typeof est !== 'object') return;
  try {
    wx.setStorageSync(FILE_STORAGE_LIVE_SNAPSHOT_KEY, {
      clipBytes: est.clipBytes,
      userDataBytes: est.userDataBytes,
      userDataWalkBytes: est.userDataWalkBytes,
      effectiveTotalBytes: est.effectiveTotalBytes,
      clipMb: est.clipMb,
      totalMb: est.totalMb,
      userDataWalkMb: est.userDataWalkMb,
      healthLevel: est.healthLevel,
      hintText: est.hintText,
      at: typeof est.at === 'number' && Number.isFinite(est.at) ? est.at : Date.now()
    });
  } catch (e) {}
}

/**
 * 读取最近一次存储估算快照（可能为 null）。
 *
 * @returns {{
 *   clipBytes?: number,
 *   userDataBytes?: number,
 *   clipMb?: number,
 *   totalMb?: number,
 *   healthLevel?: string,
 *   hintText?: string,
 *   at?: number
 * }|null}
 */
function readFileStorageEstimateSnapshot() {
  try {
    const r = wx.getStorageSync(FILE_STORAGE_LIVE_SNAPSHOT_KEY);
    if (!r || typeof r !== 'object') return null;
    return r;
  } catch (e) {
    return null;
  }
}

/** 审计导出 JSON 在 USER_DATA 根目录最多保留份数 */
const AUDIT_EXPORT_MAX_KEEP = 2;

/**
 * 判断路径是否应保留（indexed 高光或当前 rolling 活跃层）。
 * @param {string} filePath
 * @param {Set<string>} keepSet
 * @returns {boolean}
 */
function isSandboxMediaPathKept(filePath, keepSet) {
  if (!filePath || typeof filePath !== 'string') return true;
  return keepSet.has(filePath);
}

/**
 * 递归扫描目录下 mp4，删除不在 keepSet 内的孤儿文件。
 * @param {WechatMiniprogram.FileSystemManager} fs
 * @param {string} dirPath
 * @param {Set<string>} keepSet
 * @returns {number} 删除文件数
 */
function unlinkOrphanMp4UnderDirSync(fs, dirPath, keepSet) {
  let removed = 0;
  if (!fs || !dirPath) return removed;
  let names = [];
  try {
    names = fs.readdirSync(dirPath) || [];
  } catch (eRd) {
    return removed;
  }
  names.forEach((name) => {
    if (!name) return;
    const full = `${dirPath}/${name}`;
    let isDir = false;
    try {
      const st = fs.statSync(full);
      isDir = st && typeof st.isDirectory === 'function' && st.isDirectory();
    } catch (eStat) {
      return;
    }
    if (isDir) {
      removed += unlinkOrphanMp4UnderDirSync(fs, full, keepSet);
      return;
    }
    if (String(name).toLowerCase().indexOf('.mp4') < 0) return;
    if (isSandboxMediaPathKept(full, keepSet)) return;
    try {
      fs.unlinkSync(full);
      removed += 1;
    } catch (eUn) { /* ignore */ }
  });
  return removed;
}

/**
 * 清理 USER_DATA 根目录下过期的 live-audit-*.json 导出（保留最新若干份）。
 * @param {WechatMiniprogram.FileSystemManager} fs
 * @param {string} root
 * @param {number} [maxKeep]
 * @returns {number} 删除文件数
 */
function pruneStaleAuditExportFilesSync(fs, root, maxKeep) {
  const cap = Math.max(1, Math.floor(Number(maxKeep) || AUDIT_EXPORT_MAX_KEEP));
  if (!fs || !root) return 0;
  let names = [];
  try {
    names = fs.readdirSync(root) || [];
  } catch (eRd) {
    return 0;
  }
  const auditFiles = names
    .filter((n) => n && /^live-audit-\d+\.json$/i.test(String(n)))
    .map((name) => {
      const m = String(name).match(/^live-audit-(\d+)\.json$/i);
      const ts = m ? Number(m[1]) : 0;
      return { name, ts };
    })
    .filter((it) => it.ts > 0)
    .sort((a, b) => b.ts - a.ts);
  if (auditFiles.length <= cap) return 0;
  let removed = 0;
  for (let i = cap; i < auditFiles.length; i += 1) {
    try {
      fs.unlinkSync(`${root}/${auditFiles[i].name}`);
      removed += 1;
    } catch (eUn) { /* ignore */ }
  }
  return removed;
}

/**
 * 同步清理沙盒内「索引外 / rolling 外」的 mp4 与过期审计导出。
 * @param {Set<string>} [activeKeepSet] 当前录制应保留的 rolling 路径
 * @param {{ reason?: string }} [opts]
 * @returns {{ removedMp4: number, removedAudit: number }}
 */
function pruneSandboxOrphanMediaSync(activeKeepSet, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  /** @type {Set<string>} */
  const keepSet = new Set();
  clipsStorage.collectAllIndexedClipPaths().forEach((p) => keepSet.add(p));
  if (activeKeepSet instanceof Set) {
    activeKeepSet.forEach((p) => keepSet.add(p));
  } else if (Array.isArray(activeKeepSet)) {
    activeKeepSet.forEach((p) => {
      if (p && typeof p === 'string') keepSet.add(p);
    });
  }
  let removedMp4 = 0;
  let removedAudit = 0;
  try {
    const fs = wx.getFileSystemManager();
    const root = wx.env.USER_DATA_PATH;
    if (!fs || !root) {
      return { removedMp4: 0, removedAudit: 0 };
    }
    removedMp4 += unlinkOrphanMp4UnderDirSync(fs, `${root}/highlights`, keepSet);
    let rootNames = [];
    try {
      rootNames = fs.readdirSync(root) || [];
    } catch (eRoot) {
      rootNames = [];
    }
    rootNames.forEach((name) => {
      if (!name || String(name).toLowerCase().indexOf('.mp4') < 0) return;
      const full = `${root}/${name}`;
      if (isSandboxMediaPathKept(full, keepSet)) return;
      try {
        fs.unlinkSync(full);
        removedMp4 += 1;
      } catch (eUn) { /* ignore */ }
    });
    removedAudit = pruneStaleAuditExportFilesSync(fs, root, AUDIT_EXPORT_MAX_KEEP);
  } catch (e) {
    return { removedMp4, removedAudit };
  }
  if ((removedMp4 > 0 || removedAudit > 0) && options.reason) {
    try {
      console.info('[sandbox_orphan_prune]', options.reason, removedMp4, removedAudit);
    } catch (eLog) { /* ignore */ }
  }
  return { removedMp4, removedAudit };
}

module.exports = {
  CLIP_STORAGE_WARN_BYTES,
  CLIP_STORAGE_SEVERE_BYTES,
  USER_DATA_WARN_BYTES,
  USER_DATA_SEVERE_BYTES,
  AUDIT_EXPORT_MAX_KEEP,
  estimateUserDataPathUsageBytes,
  estimateClipSegmentsBytesFromStorage,
  getKvStorageInfoSafe,
  getClipStorageHealthHint,
  getUserFileStorageHint,
  fileSizeBytesAsync,
  fileSizeBytesSync,
  walkUserDataBytesSync,
  writeFileStorageEstimateSnapshot,
  readFileStorageEstimateSnapshot,
  pruneSandboxOrphanMediaSync,
  pruneStaleAuditExportFilesSync
};
