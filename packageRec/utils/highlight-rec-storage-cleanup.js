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
    var p = list[i];
    if (p && typeof p === 'string') {
      keep.add(p);
      var idx = p.lastIndexOf('/');
      if (idx >= 0) {
        var base = p.substring(idx + 1);
        if (base) {
          keep.add(base);
        }
      }
    }
  }
  return keep;
}

/**
 * 微信 FileSystemManager 异步 API 包装
 */
function readdirPromise(fs, dirPath) {
  return new Promise(function (resolve) {
    fs.readdir({
      dirPath: dirPath,
      success: function (res) {
        resolve(res && res.files ? res.files : []);
      },
      fail: function () {
        resolve([]);
      }
    });
  });
}

function statPromise(fs, fullPath) {
  return new Promise(function (resolve) {
    fs.stat({
      path: fullPath,
      success: function (res) {
        resolve(res && res.stats ? res.stats : null);
      },
      fail: function () {
        resolve(null);
      }
    });
  });
}

function unlinkPromise(fs, fullPath) {
  return new Promise(function (resolve) {
    fs.unlink({
      filePath: fullPath,
      success: function () {
        resolve(true);
      },
      fail: function () {
        resolve(false);
      }
    });
  });
}

/**
 * 异步递归删除目录下不在 keepSet 内的 mp4/mp3。
 */
function unlinkOrphanMediaUnderDirAsync(fs, dirPath, keepSet) {
  return readdirPromise(fs, dirPath).then(function (names) {
    var removedCount = 0;
    var chain = Promise.resolve();

    names.forEach(function (name) {
      if (!name) return;
      var full = dirPath + '/' + name;
      chain = chain.then(function () {
        return statPromise(fs, full).then(function (st) {
          if (!st) return;
          var isDir = typeof st.isDirectory === 'function' ? st.isDirectory() : false;
          if (isDir) {
            return unlinkOrphanMediaUnderDirAsync(fs, full, keepSet).then(function (subRemoved) {
              removedCount += subRemoved;
            });
          }
          var lower = String(name).toLowerCase();
          if (lower.indexOf('.mp4') < 0 && lower.indexOf('.mp3') < 0) return;
          if (keepSet.has(full) || keepSet.has(name)) return;

          return unlinkPromise(fs, full).then(function (ok) {
            if (ok) removedCount += 1;
          });
        });
      });
    });

    return chain.then(function () {
      return removedCount;
    });
  });
}

/**
 * 异步清理过期的 highlight_audit_*.txt（保留最新若干份）。
 */
function pruneStaleHighlightAuditFilesAsync(fs, root, maxKeep) {
  var cap = Math.max(1, Math.floor(Number(maxKeep) || HIGHLIGHT_AUDIT_MAX_KEEP));
  return readdirPromise(fs, root).then(function (names) {
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

    var removedCount = 0;
    var chain = Promise.resolve();
    for (var j = cap; j < auditFiles.length; j++) {
      (function (fileObj) {
        chain = chain.then(function () {
          return unlinkPromise(fs, root + '/' + fileObj.name).then(function (ok) {
            if (ok) removedCount += 1;
          });
        });
      })(auditFiles[j]);
    }
    return chain.then(function () {
      return removedCount;
    });
  });
}

/**
 * 异步非阻塞清理副机拍摄产生的孤儿媒体与过期审计文件。
 */
function pruneHighlightRecSandboxAsync(activeKeepPaths, opts) {
  var options = opts && typeof opts === 'object' ? opts : {};
  var keepSet = buildKeepSet(activeKeepPaths);
  var removedMedia = 0;
  var removedAudit = 0;

  if (typeof wx === 'undefined' || typeof wx.getFileSystemManager !== 'function') {
    return Promise.resolve({ removedMedia: 0, removedAudit: 0 });
  }
  var fs = wx.getFileSystemManager();
  var root = wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH : '';
  if (!fs || !root) {
    return Promise.resolve({ removedMedia: 0, removedAudit: 0 });
  }

  return unlinkOrphanMediaUnderDirAsync(fs, root + '/highlight_rec_rolling', keepSet)
    .then(function (count1) {
      removedMedia += count1;
      return unlinkOrphanMediaUnderDirAsync(fs, 'wxfile://tmp', keepSet);
    })
    .then(function (countTmp) {
      removedMedia += countTmp;
      return readdirPromise(fs, root);
    })
    .then(function (rootNames) {
      var chain = Promise.resolve();
      rootNames.forEach(function (fileName) {
        if (!fileName) return;
        var lower = String(fileName).toLowerCase();
        if (lower.indexOf('.mp4') < 0 && lower.indexOf('.mp3') < 0) return;
        var fullPath = root + '/' + fileName;
        if (keepSet.has(fullPath) || keepSet.has(fileName)) return;

        chain = chain.then(function () {
          return unlinkPromise(fs, fullPath).then(function (ok) {
            if (ok) removedMedia += 1;
          });
        });
      });
      return chain;
    })
    .then(function () {
      return pruneStaleHighlightAuditFilesAsync(fs, root, HIGHLIGHT_AUDIT_MAX_KEEP);
    })
    .then(function (auditCount) {
      removedAudit = auditCount;
      if ((removedMedia > 0 || removedAudit > 0) && options.reason) {
        console.info('[highlight_rec_storage_cleanup_async]', options.reason, removedMedia, removedAudit);
      }
      return { removedMedia: removedMedia, removedAudit: removedAudit };
    })
    .catch(function (err) {
      console.warn('[highlight_rec_storage_cleanup_async] error:', err);
      return { removedMedia: removedMedia, removedAudit: removedAudit };
    });
}

/**
 * 同步方法保留向后兼容
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
    if (keepSet.has(full) || keepSet.has(name)) continue;
    try {
      fs.unlinkSync(full);
      removed += 1;
    } catch (eUn) { /* ignore */ }
  }
  return removed;
}

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
    removedMedia += unlinkOrphanMediaUnderDirSync(fs, 'wxfile://tmp', keepSet);

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
      if (keepSet.has(fullPath) || keepSet.has(fileName)) continue;
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
  pruneHighlightRecSandbox: pruneHighlightRecSandbox,
  pruneHighlightRecSandboxAsync: pruneHighlightRecSandboxAsync
};
