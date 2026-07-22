/**
 * @fileoverview 副机拍摄沙盒清理：回收 rolling 目录与根目录孤儿媒体，降低 200MB 配额耗尽概率。
 */

/** highlight 审计 txt 在 USER_DATA 根目录最多保留份数 */
var HIGHLIGHT_AUDIT_MAX_KEEP = 2;

/**
 * 将路径列表转为 Set。
 *
 * @param {string[]} [paths]
 * @returns {Set<string>}
 */
function buildKeepSet(paths) {
  var keep = new Set();
  var list = Array.isArray(paths) ? paths : [];
  for (var i = 0; i < list.length; i++) {
    if (list[i] && typeof list[i] === 'string') {
      keep.add(list[i]);
    }
  }
  return keep;
}

/**
 * 递归删除目录下不在 keepSet 内的 mp4/mp3。
 *
 * @param {WechatMiniprogram.FileSystemManager} fs
 * @param {string} dirPath
 * @param {Set<string>} keepSet
 * @returns {number}
 */
function unlinkOrphanMediaUnderDirSync(fs, dirPath, keepSet) {
  var removed = 0;
  if (!fs || !dirPath) return removed;
  var names = [];
  try {
    names = fs.readdirSync(dirPath) || [];
  } catch (eRd) {
    return removed;
  }
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (!name) continue;
    var full = dirPath + '/' + name;
    var isDir = false;
    try {
      var st = fs.statSync(full);
      isDir = st && typeof st.isDirectory === 'function' && st.isDirectory();
    } catch (eStat) {
      continue;
    }
    if (isDir) {
      removed += unlinkOrphanMediaUnderDirSync(fs, full, keepSet);
      continue;
    }
    var lower = String(name).toLowerCase();
    if (lower.indexOf('.mp4') < 0 && lower.indexOf('.mp3') < 0) continue;
    if (keepSet.has(full)) continue;
    try {
      fs.unlinkSync(full);
      removed += 1;
    } catch (eUn) { /* ignore */ }
  }
  return removed;
}

/**
 * 清理过期的 highlight_audit_*.txt（保留最新若干份）。
 *
 * @param {WechatMiniprogram.FileSystemManager} fs
 * @param {string} root
 * @param {number} [maxKeep]
 * @returns {number}
 */
function pruneStaleHighlightAuditFilesSync(fs, root, maxKeep) {
  var cap = Math.max(1, Math.floor(Number(maxKeep) || HIGHLIGHT_AUDIT_MAX_KEEP));
  if (!fs || !root) return 0;
  var names = [];
  try {
    names = fs.readdirSync(root) || [];
  } catch (eRd) {
    return 0;
  }
  var auditFiles = [];
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    if (!name || !/^highlight_audit_\d+\.txt$/i.test(String(name))) continue;
    var m = String(name).match(/^highlight_audit_(\d+)\.txt$/i);
    var ts = m ? Number(m[1]) : 0;
    if (ts > 0) auditFiles.push({ name: name, ts: ts });
  }
  auditFiles.sort(function (a, b) {
    return b.ts - a.ts;
  });
  if (auditFiles.length <= cap) return 0;
  var removed = 0;
  for (var j = cap; j < auditFiles.length; j++) {
    try {
      fs.unlinkSync(root + '/' + auditFiles[j].name);
      removed += 1;
    } catch (eUn) { /* ignore */ }
  }
  return removed;
}

/**
 * 清理副机拍摄产生的孤儿媒体与过期审计文件。
 *
 * @param {string[]} [activeKeepPaths] 当前 rolling 应保留的路径
 * @param {{ reason?: string }} [opts]
 * @returns {{ removedMedia: number, removedAudit: number }}
 */
function pruneHighlightRecSandbox(activeKeepPaths, opts) {
  var options = opts && typeof opts === 'object' ? opts : {};
  var keepSet = buildKeepSet(activeKeepPaths);
  var removedMedia = 0;
  var removedAudit = 0;
  try {
    if (typeof wx === 'undefined' || typeof wx.getFileSystemManager !== 'function') {
      return { removedMedia: 0, removedAudit: 0 };
    }
    var fs = wx.getFileSystemManager();
    var root = wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH : '';
    if (!fs || !root) {
      return { removedMedia: 0, removedAudit: 0 };
    }

    removedMedia += unlinkOrphanMediaUnderDirSync(fs, root + '/highlight_rec_rolling', keepSet);

    var rootNames = [];
    try {
      rootNames = fs.readdirSync(root) || [];
    } catch (eRoot) {
      rootNames = [];
    }
    for (var i = 0; i < rootNames.length; i++) {
      var fileName = rootNames[i];
      if (!fileName) continue;
      var lower = String(fileName).toLowerCase();
      if (lower.indexOf('.mp4') < 0 && lower.indexOf('.mp3') < 0) continue;
      var fullPath = root + '/' + fileName;
      if (keepSet.has(fullPath)) continue;
      try {
        fs.unlinkSync(fullPath);
        removedMedia += 1;
      } catch (eUn) { /* ignore */ }
    }

    removedAudit = pruneStaleHighlightAuditFilesSync(fs, root, HIGHLIGHT_AUDIT_MAX_KEEP);

    if ((removedMedia > 0 || removedAudit > 0) && options.reason) {
      console.info('[highlight_rec_storage_cleanup]', options.reason, removedMedia, removedAudit);
    }
  } catch (e) {
    return { removedMedia: removedMedia, removedAudit: removedAudit };
  }
  return { removedMedia: removedMedia, removedAudit: removedAudit };
}

module.exports = {
  HIGHLIGHT_AUDIT_MAX_KEEP: HIGHLIGHT_AUDIT_MAX_KEEP,
  pruneHighlightRecSandbox: pruneHighlightRecSandbox
};
