/**
 * @fileoverview 高光素材机性能档位：视录分离 + 独立收音。
 * 竖持 9:16 / 横置 16:9（横置须物理旋转手机，与直播页一致）。
 */

const deviceRecordProfile = require('../../utils/device-record-profile.js');

/** @type {'portrait'|'landscape'} */
var ASPECT_PORTRAIT = 'portrait';
/** @type {'portrait'|'landscape'} */
var ASPECT_LANDSCAPE = 'landscape';

/** @type {Object|null} */
var cachedProfile = null;

/** @type {string} */
var cachedKey = '';

/**
 * 是否为小米/Redmi 系 Android。
 * @returns {boolean}
 */
function isXiaomiAndroid() {
  if (typeof wx === 'undefined' || typeof wx.getSystemInfoSync !== 'function') return false;
  try {
    var sys = wx.getSystemInfoSync();
    if (String(sys.platform || '').toLowerCase() !== 'android') return false;
    var brand = String(sys.brand || sys.manufacturer || '').toLowerCase();
    return brand.indexOf('xiaomi') >= 0 || brand.indexOf('redmi') >= 0;
  } catch (e) {
    return false;
  }
}

/**
 * 规范化画幅模式。
 *
 * @param {string|undefined} mode
 * @returns {'portrait'|'landscape'}
 */
function normalizeAspectMode(mode) {
  return mode === ASPECT_LANDSCAPE ? ASPECT_LANDSCAPE : ASPECT_PORTRAIT;
}

/**
 * 编码画布尺寸（偶数像素）。
 *
 * @param {boolean} lowEnd
 * @param {boolean} use1080p
 * @param {'portrait'|'landscape'} aspectMode
 * @returns {{ canvasWidth: number, canvasHeight: number, label: string, aspectLabel: string }}
 */
function resolveCanvasSize(lowEnd, use1080p, aspectMode) {
  var landscape = aspectMode === ASPECT_LANDSCAPE;
  if (lowEnd) {
    return landscape
      ? { canvasWidth: 854, canvasHeight: 480, label: '480p', aspectLabel: '16:9' }
      : { canvasWidth: 480, canvasHeight: 854, label: '480p', aspectLabel: '9:16' };
  }
  if (use1080p) {
    return landscape
      ? { canvasWidth: 1920, canvasHeight: 1080, label: '1080p', aspectLabel: '16:9' }
      : { canvasWidth: 1080, canvasHeight: 1920, label: '1080p', aspectLabel: '9:16' };
  }
  return landscape
    ? { canvasWidth: 1280, canvasHeight: 720, label: '720p', aspectLabel: '16:9' }
    : { canvasWidth: 720, canvasHeight: 1280, label: '720p', aspectLabel: '9:16' };
}

/**
 * 估算文件开头黑场时长（ms）：MediaRecorder 起录到首帧有效内容之间的空白。
 *
 * @param {number} warmupFrames
 * @param {number} fps
 * @returns {number}
 */
function computeContentLeadInSkipMs(warmupFrames, fps) {
  var frames = Math.max(0, Math.floor(Number(warmupFrames) || 0));
  var rate = Math.max(12, Math.floor(Number(fps) || 24));
  return Math.ceil((frames / rate) * 1000) + 800;
}

/**
 * 获取素材机录制/预览档位。
 *
 * @param {{ use1080p?: boolean, actionMode?: boolean, aspectMode?: string }} [options]
 * @returns {Object}
 */
function getHighlightRecProfile(options) {
  var opts = options || {};
  var base = deviceRecordProfile.getDeviceRecordProfile();
  var lowEnd = base.tier === '480p';
  var xiaomi = isXiaomiAndroid();
  var use1080p = !lowEnd && !!opts.use1080p;
  var actionMode = !lowEnd && !!opts.actionMode;
  var aspectMode = normalizeAspectMode(opts.aspectMode);
  var cacheKey = (lowEnd ? '480' : (use1080p ? '1080' : '720'))
    + (actionMode ? '_action' : '')
    + (aspectMode === ASPECT_LANDSCAPE ? '_land' : '_port');

  if (cachedProfile && cachedKey === cacheKey) {
    return cachedProfile;
  }

  var canvas = resolveCanvasSize(lowEnd, use1080p, aspectMode);
  var recordFps = lowEnd ? 20 : 24;
  var encoderLiveWarmupFrames = lowEnd ? 12 : 24;
  var videoBitsPerSecondKbps = lowEnd ? 3200 : (use1080p ? (xiaomi ? 6800 : 6200) : (xiaomi ? 5200 : 4800));
  if (actionMode && !lowEnd) {
    videoBitsPerSecondKbps += use1080p ? 1200 : 1000;
    videoBitsPerSecondKbps = Math.min(use1080p ? 8000 : 6800, videoBitsPerSecondKbps);
  }

  cachedKey = cacheKey;
  cachedProfile = {
    cacheKey: cacheKey,
    tier: lowEnd ? '480p' : (use1080p ? '1080p' : '720p'),
    use1080p: use1080p,
    actionMode: actionMode,
    aspectMode: aspectMode,
    aspectLabel: canvas.aspectLabel,
    lockCenterFocus: !actionMode,
    exposureCompensationEv: actionMode ? -0.7 : 0,
    cameraResolution: (use1080p || actionMode) ? 'high' : 'medium',
    cameraFrameSize: 'large',
    chunkDurationMs: 50000,
    staggerMs: 8000,
    rollingMaxFiles: 2,
    bufferTargetMs: 90000,
    canvasWidth: canvas.canvasWidth,
    canvasHeight: canvas.canvasHeight,
    /** 标准导出分辨率文案，如 1280×720 */
    exportResolution: canvas.canvasWidth + '×' + canvas.canvasHeight,
    qualityLabel: canvas.label,
    recordFps: recordFps,
    encoderLiveWarmupFrames: encoderLiveWarmupFrames,
    warmupMinFrames: 8,
    contentLeadInSkipMs: computeContentLeadInSkipMs(encoderLiveWarmupFrames, recordFps),
    videoBitsPerSecondKbps: videoBitsPerSecondKbps,
    highlightFlushMinIntervalMs: 3000,
    highlightLeadMs: 8000,
    audioSegmentMs: 50000,
    audioMaxSegments: 4,
    audioFormat: 'mp3',
    skipMediaContainerTrim: !!base.skipMediaContainerTrim
  };
  return cachedProfile;
}

/**
 * 清除缓存（仅测试用）。
 * @returns {void}
 */
function resetHighlightRecProfileCache() {
  cachedProfile = null;
  cachedKey = '';
}

module.exports = {
  ASPECT_PORTRAIT: ASPECT_PORTRAIT,
  ASPECT_LANDSCAPE: ASPECT_LANDSCAPE,
  getHighlightRecProfile: getHighlightRecProfile,
  isXiaomiAndroid: isXiaomiAndroid,
  normalizeAspectMode: normalizeAspectMode,
  resetHighlightRecProfileCache: resetHighlightRecProfileCache
};
