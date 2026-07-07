/**
 * @fileoverview 投篮训练诊断日志导出为 JSON 文件，供 wx.shareFileMessage 分享（对齐 Live 审计导出）。
 */

/**
 * @typedef {Object} ShootingTrainingExportResult
 * @property {boolean} ok
 * @property {string} path
 * @property {string} fileName
 * @property {number} size
 * @property {string} [error]
 */

/**
 * 将诊断快照与日志写入用户目录 JSON 文件（同步，兼容旧调用）。
 * @param {Record<string, unknown>} snapshot 当前运行快照
 * @param {string[]} logLines 环形日志行
 * @returns {ShootingTrainingExportResult}
 */
function exportDebugToFile(snapshot, logLines) {
  var built = buildExportPayload(snapshot, logLines);
  if (!built.ok) return built.result;
  return writePayloadSync(built.content, built.fileName);
}

/**
 * 异步写入诊断 JSON，避免 writeFileSync 阻塞触摸响应。
 * @param {Record<string, unknown>} snapshot
 * @param {string[]} logLines
 * @param {(result: ShootingTrainingExportResult) => void} callback
 * @returns {void}
 */
function exportDebugToFileAsync(snapshot, logLines, callback) {
  var built = buildExportPayload(snapshot, logLines);
  if (!built.ok) {
    if (typeof callback === 'function') callback(built.result);
    return;
  }
  writePayloadAsync(built.content, built.fileName, callback);
}

/**
 * @param {Record<string, unknown>} snapshot
 * @param {string[]} logLines
 * @returns {{ ok: boolean, content?: string, fileName?: string, result?: ShootingTrainingExportResult }}
 */
function buildExportPayload(snapshot, logLines) {
  var ts = Date.now();
  var fileName = 'shooting-training-debug-' + ts + '.json';
  var payload = {
    exportedAt: ts,
    module: 'shooting-training',
    snapshot: snapshot || {},
    logs: Array.isArray(logLines) ? logLines : []
  };
  try {
    return { ok: true, content: JSON.stringify(payload), fileName: fileName };
  } catch (eJson) {
    return {
      ok: false,
      result: { ok: false, path: '', fileName: '', size: 0, error: String(eJson) }
    };
  }
}

/**
 * @param {string} content
 * @param {string} fileName
 * @returns {ShootingTrainingExportResult}
 */
function writePayloadSync(content, fileName) {
  var fs = null;
  var root = '';
  try {
    fs = wx.getFileSystemManager();
    root = wx.env.USER_DATA_PATH;
  } catch (e) {
    return { ok: false, path: '', fileName: '', size: 0, error: 'fs_unavailable' };
  }
  if (!fs || !root) {
    return { ok: false, path: '', fileName: '', size: 0, error: 'fs_unavailable' };
  }
  try {
    var filePath = root + '/' + fileName;
    fs.writeFileSync(filePath, content, 'utf8');
    return {
      ok: true,
      path: filePath,
      fileName: fileName,
      size: content.length
    };
  } catch (eWrite) {
    return {
      ok: false,
      path: '',
      fileName: '',
      size: 0,
      error: String(eWrite)
    };
  }
}

/**
 * @param {string} content
 * @param {string} fileName
 * @param {(result: ShootingTrainingExportResult) => void} callback
 * @returns {void}
 */
function writePayloadAsync(content, fileName, callback) {
  var fs = null;
  var root = '';
  try {
    fs = wx.getFileSystemManager();
    root = wx.env.USER_DATA_PATH;
  } catch (e) {
    if (typeof callback === 'function') {
      callback({ ok: false, path: '', fileName: '', size: 0, error: 'fs_unavailable' });
    }
    return;
  }
  if (!fs || !root) {
    if (typeof callback === 'function') {
      callback({ ok: false, path: '', fileName: '', size: 0, error: 'fs_unavailable' });
    }
    return;
  }
  var filePath = root + '/' + fileName;
  fs.writeFile({
    filePath: filePath,
    data: content,
    encoding: 'utf8',
    success: function () {
      if (typeof callback === 'function') {
        callback({
          ok: true,
          path: filePath,
          fileName: fileName,
          size: content.length
        });
      }
    },
    fail: function (err) {
      if (typeof callback === 'function') {
        callback({
          ok: false,
          path: '',
          fileName: '',
          size: 0,
          error: err && err.errMsg ? err.errMsg : 'write_fail'
        });
      }
    }
  });
}

module.exports = {
  exportDebugToFile: exportDebugToFile,
  exportDebugToFileAsync: exportDebugToFileAsync
};
