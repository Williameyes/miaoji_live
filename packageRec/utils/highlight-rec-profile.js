/**
 * @fileoverview 高光素材机性能档位：视录分离 + 独立收音。
 * 竖持 9:16 / 横置 16:9（横置须物理旋转手机，与直播页一致）。
 */

const deviceRecordProfile = require('../../utils/device-record-profile.js');

/** @type {'native'|'preview_record'} */
var REC_MODE_NATIVE = 'native';
/** @type {'native'|'preview_record'} */
var REC_MODE_PREVIEW_RECORD = 'preview_record';

/** @type {'portrait'|'portrait_4_3'|'landscape'|'landscape_4_3'} */
var ASPECT_PORTRAIT = 'portrait';
var ASPECT_PORTRAIT_4_3 = 'portrait_4_3';
var ASPECT_LANDSCAPE = 'landscape';
var ASPECT_LANDSCAPE_4_3 = 'landscape_4_3';

/** @type {Object|null} */
var cachedProfile = null;

/** @type {string} */
var cachedKey = '';

/**
 * 规范化录制模式。
 *
 * @param {string|undefined} mode
 * @returns {'native'|'preview_record'}
 */
function normalizeRecMode(mode) {
  return mode === REC_MODE_PREVIEW_RECORD ? REC_MODE_PREVIEW_RECORD : REC_MODE_NATIVE;
}

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
 * @returns {'portrait'|'portrait_4_3'|'landscape'|'landscape_4_3'}
 */
function normalizeAspectMode(mode) {
  if (mode === ASPECT_LANDSCAPE) return ASPECT_LANDSCAPE;
  if (mode === ASPECT_LANDSCAPE_4_3) return ASPECT_LANDSCAPE_4_3;
  if (mode === ASPECT_PORTRAIT_4_3) return ASPECT_PORTRAIT_4_3;
  return ASPECT_PORTRAIT;
}

/**
 * 编码画布尺寸（偶数像素）。
 *
 * @param {boolean} lowEnd
 * @param {boolean} use1080p
 * @param {'portrait'|'portrait_4_3'|'landscape'|'landscape_4_3'} aspectMode
 * @returns {{ canvasWidth: number, canvasHeight: number, label: string, aspectLabel: string }}
 */
function resolveCanvasSize(lowEnd, use1080p, aspectMode) {
  if (aspectMode === ASPECT_LANDSCAPE) {
    if (lowEnd) return { canvasWidth: 854, canvasHeight: 480, label: '480p', aspectLabel: '16:9' };
    if (use1080p) return { canvasWidth: 1920, canvasHeight: 1080, label: '1080p', aspectLabel: '16:9' };
    return { canvasWidth: 1280, canvasHeight: 720, label: '720p', aspectLabel: '16:9' };
  }
  if (aspectMode === ASPECT_LANDSCAPE_4_3) {
    if (lowEnd) return { canvasWidth: 640, canvasHeight: 480, label: '480p', aspectLabel: '4:3' };
    if (use1080p) return { canvasWidth: 1440, canvasHeight: 1080, label: '1080p', aspectLabel: '4:3' };
    return { canvasWidth: 960, canvasHeight: 720, label: '720p', aspectLabel: '4:3' };
  }
  if (aspectMode === ASPECT_PORTRAIT_4_3) {
    if (lowEnd) return { canvasWidth: 480, canvasHeight: 640, label: '480p', aspectLabel: '3:4' };
    if (use1080p) return { canvasWidth: 1080, canvasHeight: 1440, label: '1080p', aspectLabel: '3:4' };
    return { canvasWidth: 720, canvasHeight: 960, label: '720p', aspectLabel: '3:4' };
  }
  // ASPECT_PORTRAIT (default 9:16)
  if (lowEnd) return { canvasWidth: 480, canvasHeight: 854, label: '480p', aspectLabel: '9:16' };
  if (use1080p) return { canvasWidth: 1080, canvasHeight: 1920, label: '1080p', aspectLabel: '9:16' };
  return { canvasWidth: 720, canvasHeight: 1280, label: '720p', aspectLabel: '9:16' };
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
 * @param {{ use1080p?: boolean, actionMode?: boolean, aspectMode?: string, recMode?: string }} [options]
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
  var recMode = normalizeRecMode(opts.recMode);
  var cacheKey = recMode
    + '_' + (lowEnd ? '480' : (use1080p ? '1080' : '720'))
    + (actionMode ? '_action' : '')
    + '_' + aspectMode;

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
    recMode: recMode,
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
    /** 原生模式动态分段时长：1080p (8Mbps) 选 60 秒 (~60MB)，720p (4Mbps) 选 120 秒 (~60MB)。双分段共 ~120MB，留出 80MB 余量绝对低于 200MB 配额 */
    nativeSegmentMs: use1080p ? 60000 : 120000,
    /**
     * 原生模式导出跳过 MediaContainer 裁切，整段 stopRecord 落盘文件直存相册，避免长时监看后裁切失败。
     * 视录分离仍走 8s 裁切 + 音轨 mux。
     */
    skipMediaContainerTrim: recMode === REC_MODE_NATIVE || !!base.skipMediaContainerTrim,
    /** 原生模式是否为整段直存（与 skipMediaContainerTrim 同步，供 UI/日志使用） */
    nativeDirectExport: recMode === REC_MODE_NATIVE
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
  REC_MODE_NATIVE: REC_MODE_NATIVE,
  REC_MODE_PREVIEW_RECORD: REC_MODE_PREVIEW_RECORD,
  ASPECT_PORTRAIT: ASPECT_PORTRAIT,
  ASPECT_PORTRAIT_4_3: ASPECT_PORTRAIT_4_3,
  ASPECT_LANDSCAPE: ASPECT_LANDSCAPE,
  ASPECT_LANDSCAPE_4_3: ASPECT_LANDSCAPE_4_3,
  getHighlightRecProfile: getHighlightRecProfile,
  isXiaomiAndroid: isXiaomiAndroid,
  normalizeAspectMode: normalizeAspectMode,
  normalizeRecMode: normalizeRecMode,
  resetHighlightRecProfileCache: resetHighlightRecProfileCache
};
