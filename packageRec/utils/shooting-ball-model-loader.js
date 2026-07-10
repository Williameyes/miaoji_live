/**
 * @fileoverview 投篮训练 YOLO ONNX 模型：按需下载、本地缓存、创建推理 Session。
 */

var modelConfig = require('../constants/shooting-ball-model-config.js');
var fileStorageEstimate = require('../../utils/file-storage-estimate.js');

var STORAGE_VERSION_KEY = 'shooting_ball_model_version';
/** 模型体积（字节，含少量余量） */
var MODEL_BYTES_ESTIMATE = 13 * 1024 * 1024;
/** 微信用户文件目录参考上限（字节） */
var USER_DATA_QUOTA_BYTES = 200 * 1024 * 1024;

/**
 * 获取本地模型绝对路径。
 * @returns {string}
 */
function getLocalModelPath() {
  var root = wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH : '';
  return root + '/' + modelConfig.MODEL_FILE_NAME;
}

/**
 * 是否为本地文件存储配额错误。
 * @param {string} msg
 * @returns {boolean}
 */
function isStorageLimitError(msg) {
  var s = msg || '';
  return s.indexOf('storage limit') >= 0 ||
    s.indexOf('maximum size') >= 0 ||
    s.indexOf('file storage') >= 0;
}

/**
 * 检查本地是否已有缓存模型。
 * @returns {Promise<boolean>}
 */
function hasCachedModel() {
  var path = getLocalModelPath();
  return new Promise(function (resolve) {
    if (!path) {
      resolve(false);
      return;
    }
    wx.getFileSystemManager().access({
      path: path,
      success: function () { resolve(true); },
      fail: function () { resolve(false); }
    });
  });
}

/**
 * 读取已缓存的模型版本。
 * @returns {string}
 */
function getCachedVersion() {
  try {
    return wx.getStorageSync(STORAGE_VERSION_KEY) || '';
  } catch (e) {
    return '';
  }
}

/**
 * 写入模型版本标记。
 * @param {string} version
 * @returns {void}
 */
function setCachedVersion(version) {
  try {
    wx.setStorageSync(STORAGE_VERSION_KEY, version);
  } catch (e) {}
}

/**
 * 删除本地模型缓存。
 * @returns {Promise<void>}
 */
function clearCachedModel() {
  var path = getLocalModelPath();
  return new Promise(function (resolve) {
    try {
      wx.removeStorageSync(STORAGE_VERSION_KEY);
    } catch (eRm) {}
    if (!path) {
      resolve();
      return;
    }
    wx.getFileSystemManager().unlink({
      filePath: path,
      complete: function () { resolve(); }
    });
  });
}

/**
 * 删除投篮训练诊断 JSON（仅保留最新 1 份）。
 * @param {WechatMiniprogram.FileSystemManager} fs
 * @param {string} root
 * @returns {number}
 */
function pruneShootingDebugExportsSync(fs, root) {
  if (!fs || !root) return 0;
  var names = [];
  try {
    names = fs.readdirSync(root) || [];
  } catch (eRd) {
    return 0;
  }
  var files = names
    .filter(function (n) {
      return n && /^shooting-training-debug-\d+\.json$/i.test(String(n));
    })
    .map(function (name) {
      var m = String(name).match(/^shooting-training-debug-(\d+)\.json$/i);
      return { name: name, ts: m ? Number(m[1]) : 0 };
    })
    .filter(function (it) { return it.ts > 0; })
    .sort(function (a, b) { return b.ts - a.ts; });
  var removed = 0;
  for (var i = 1; i < files.length; i++) {
    try {
      fs.unlinkSync(root + '/' + files[i].name);
      removed++;
    } catch (eUn) {}
  }
  return removed;
}

/**
 * 下载模型前尽量释放沙盒空间（不删索引内高光片段）。
 * @returns {Promise<{ usageBytes: number, usageMb: number, pruned: { removedMp4: number, removedAudit: number, removedDebug: number } }>}
 */
function prepareStorageForModel() {
  return fileStorageEstimate.estimateUserDataPathUsageBytes().then(function (usageBefore) {
    var fs = wx.getFileSystemManager();
    var root = wx.env.USER_DATA_PATH;
    var pruned = fileStorageEstimate.pruneSandboxOrphanMediaSync(new Set(), {
      reason: 'shooting_ball_model'
    });
    var removedAudit = 0;
    var removedDebug = 0;
    try {
      removedAudit = fileStorageEstimate.pruneStaleAuditExportFilesSync(fs, root, 1);
      removedDebug = pruneShootingDebugExportsSync(fs, root);
    } catch (ePrune) {}
    return fileStorageEstimate.estimateUserDataPathUsageBytes().then(function (usageAfter) {
      return {
        usageBytes: usageAfter,
        usageMb: Math.round((usageAfter / (1024 * 1024)) * 10) / 10,
        pruned: {
          removedMp4: pruned.removedMp4,
          removedAudit: removedAudit,
          removedDebug: removedDebug
        }
      };
    });
  });
}

/**
 * 将下载临时文件落盘到目标路径（优先 rename 避免双倍占用）。
 * @param {string} tempFilePath
 * @param {string} destPath
 * @returns {Promise<string>}
 */
function persistDownloadedModel(tempFilePath, destPath) {
  var fs = wx.getFileSystemManager();
  return new Promise(function (resolve, reject) {
    function onFail(err) {
      var msg = err && err.errMsg ? err.errMsg : String(err);
      reject(new Error(msg));
    }

    function trySaveFile() {
      fs.saveFile({
        tempFilePath: tempFilePath,
        filePath: destPath,
        success: function (saveRes) {
          setCachedVersion(modelConfig.MODEL_VERSION);
          resolve(saveRes.savedFilePath || destPath);
        },
        fail: onFail
      });
    }

    function tryCopyFile() {
      if (typeof fs.copyFile !== 'function') {
        trySaveFile();
        return;
      }
      fs.copyFile({
        srcPath: tempFilePath,
        destPath: destPath,
        success: function () {
          setCachedVersion(modelConfig.MODEL_VERSION);
          resolve(destPath);
        },
        fail: function () {
          trySaveFile();
        }
      });
    }

    try {
      fs.unlinkSync(destPath);
    } catch (eUn) {}

    if (typeof fs.rename === 'function') {
      fs.rename({
        oldPath: tempFilePath,
        newPath: destPath,
        success: function () {
          setCachedVersion(modelConfig.MODEL_VERSION);
          resolve(destPath);
        },
        fail: function () {
          tryCopyFile();
        }
      });
      return;
    }
    tryCopyFile();
  });
}

/**
 * 下载远程 ONNX 并保存到 USER_DATA_PATH。
 * @param {(loaded: number, total: number) => void} [onProgress]
 * @returns {Promise<string>}
 */
function downloadModel(onProgress) {
  var destPath = getLocalModelPath();
  if (!destPath) {
    return Promise.reject(new Error('USER_DATA_PATH 不可用'));
  }

  return prepareStorageForModel().then(function (storageInfo) {
    if (storageInfo.usageBytes + MODEL_BYTES_ESTIMATE > USER_DATA_QUOTA_BYTES) {
      return Promise.reject(new Error(
        'STORAGE_FULL:本地已用约' + storageInfo.usageMb + 'MB，需约12MB下载模型。' +
        '请返回首页删除旧高光片段，或先「下载至相册并清空」后再试。'
      ));
    }
    return new Promise(function (resolve, reject) {
      var task = wx.downloadFile({
        url: modelConfig.MODEL_DOWNLOAD_URL,
        success: function (res) {
          if (!res || res.statusCode !== 200 || !res.tempFilePath) {
            reject(new Error('模型下载失败 HTTP ' + (res && res.statusCode)));
            return;
          }
          persistDownloadedModel(res.tempFilePath, destPath).then(resolve).catch(reject);
        },
        fail: function (err) {
          reject(new Error((err && err.errMsg) || '下载模型失败'));
        }
      });

      if (task && typeof task.onProgressUpdate === 'function' && typeof onProgress === 'function') {
        task.onProgressUpdate(function (evt) {
          onProgress(evt.totalBytesWritten || 0, evt.totalBytesExpectedToWrite || 0);
        });
      }
    });
  });
}

/**
 * 确保模型文件存在（版本不一致时重新下载）。
 * @param {(loaded: number, total: number) => void} [onProgress]
 * @returns {Promise<string>}
 */
function ensureModelFile(onProgress) {
  var needDownload = getCachedVersion() !== modelConfig.MODEL_VERSION;
  return hasCachedModel().then(function (exists) {
    if (exists && !needDownload) {
      return getLocalModelPath();
    }
    return clearCachedModel().then(function () {
      return downloadModel(onProgress);
    });
  });
}

/**
 * 获取当前推理配置（写入诊断日志）。
 * @returns {{ precisionLevel: number, allowNpu: boolean, platform: string }}
 */
function getInferenceMeta() {
  var platform = '-';
  try {
    platform = wx.getSystemInfoSync().platform || '-';
  } catch (e) {}
  return {
    precisionLevel: modelConfig.PRECISION_LEVEL,
    allowNpu: modelConfig.getAllowNpu(),
    platform: platform
  };
}

/**
 * 创建并加载推理 Session。
 * @param {string} modelPath
 * @param {boolean} [allowNpuOverride] 显式指定是否启用 NPU（用于运行时降级重建 Session），省略则读配置默认值
 * @returns {Promise<WechatMiniprogram.InferenceSession>}
 */
function createSession(modelPath, allowNpuOverride) {
  if (typeof wx.createInferenceSession !== 'function') {
    return Promise.reject(new Error('当前基础库不支持 AI 推理，请升级微信'));
  }

  var inferMeta = getInferenceMeta();
  if (typeof allowNpuOverride === 'boolean') {
    inferMeta = { precisionLevel: inferMeta.precisionLevel, allowNpu: allowNpuOverride, platform: inferMeta.platform };
  }

  return new Promise(function (resolve, reject) {
    var settled = false;
    var typicalShape = {};
    typicalShape[modelConfig.INPUT_TENSOR] = [1, 3, modelConfig.INPUT_SIZE, modelConfig.INPUT_SIZE];
    var session = wx.createInferenceSession({
      model: modelPath,
      precisionLevel: inferMeta.precisionLevel,
      allowNPU: inferMeta.allowNpu,
      allowQuantize: false,
      typicalShape: typicalShape
    });

    session.onLoad(function () {
      if (settled) return;
      settled = true;
      resolve(session);
    });

    session.onError(function (err) {
      if (settled) return;
      settled = true;
      var msg = err && (err.errMsg || err.message) ? (err.errMsg || err.message) : String(err);
      reject(new Error('模型加载失败: ' + msg));
    });

    setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error('模型加载超时'));
    }, 60000);
  });
}

/**
 * 下载（如需）并创建 Session；存储满时自动清理一次后重试。
 * @param {(loaded: number, total: number) => void} [onProgress]
 * @param {{ onStatus?: function(string): void }} [opts]
 * @returns {Promise<{ session: WechatMiniprogram.InferenceSession, modelPath: string, inferenceMeta: Object }>}
 */
function loadModel(onProgress, opts) {
  opts = opts || {};
  var retried = false;

  /**
   * @returns {Promise<{ session: WechatMiniprogram.InferenceSession, modelPath: string, inferenceMeta: Object }>}
   */
  function attempt() {
    return ensureModelFile(onProgress).then(function (modelPath) {
      return createSession(modelPath).then(function (session) {
        return {
          session: session,
          modelPath: modelPath,
          inferenceMeta: getInferenceMeta()
        };
      });
    });
  }

  return attempt().catch(function (err) {
    var msg = err && err.message ? err.message : String(err);
    if (retried || !isStorageLimitError(msg)) {
      throw err;
    }
    retried = true;
    if (typeof opts.onStatus === 'function') {
      opts.onStatus('存储空间不足，正在清理缓存…');
    }
    return clearCachedModel()
      .then(function () { return prepareStorageForModel(); })
      .then(function () { return attempt(); });
  });
}

/**
 * 销毁 Session。
 * @param {WechatMiniprogram.InferenceSession|null} session
 * @returns {void}
 */
function destroySession(session) {
  if (!session) return;
  try {
    if (typeof session.destroy === 'function') session.destroy();
  } catch (e) {}
}

module.exports = {
  getLocalModelPath: getLocalModelPath,
  hasCachedModel: hasCachedModel,
  getCachedVersion: getCachedVersion,
  clearCachedModel: clearCachedModel,
  prepareStorageForModel: prepareStorageForModel,
  downloadModel: downloadModel,
  ensureModelFile: ensureModelFile,
  createSession: createSession,
  loadModel: loadModel,
  destroySession: destroySession,
  isStorageLimitError: isStorageLimitError,
  getInferenceMeta: getInferenceMeta
};
