/**
 * 直播录制档位探测：低端 Android 自动降级 480p，减轻 MediaCodec 并发压力。
 * onCameraFrame 使用 medium 抽帧（与 resolution=high 预览独立），降低取帧/绘制发热。
 */

/** 720p 16:9 录制画布。 */
const RECORD_PROFILE_720P = {
  tier: '720p',
  canvasWidth: 1280,
  canvasHeight: 720,
  recordFrameSize: 'medium',
  skipMediaContainerTrim: false
};

/** 480p 16:9 编码画布（853×480）；抽帧 medium，预览仍由 camera resolution=high 决定。 */
const RECORD_PROFILE_480P = {
  tier: '480p',
  canvasWidth: 853,
  canvasHeight: 480,
  recordFrameSize: 'medium',
  skipMediaContainerTrim: true
};

/**
 * 低端机 rolling 单段全量拷贝体积上限（字节）。
 * 480p@3600kbps×30s 约 13MB，留余量至 16MB。
 */
const LOW_END_ROLLING_FULL_COPY_CAP_BYTES = Math.floor(16 * 1024 * 1024);

/** @type {typeof RECORD_PROFILE_720P|null} */
let cachedProfile = null;

/**
 * @returns {string}
 */
function getHostPlatform() {
  if (typeof wx === 'undefined' || typeof wx.getSystemInfoSync !== 'function') {
    return '';
  }
  try {
    return String(wx.getSystemInfoSync().platform || '').toLowerCase();
  } catch (e) {
    return '';
  }
}

/**
 * 解析 Android 主版本号。
 * @param {string} [system]
 * @returns {number}
 */
function parseAndroidMajorVersion(system) {
  const m = String(system || '').match(/Android\s+(\d+(?:\.\d+)?)/i);
  if (!m) return 0;
  const major = parseInt(String(m[1]).split('.')[0], 10);
  return Number.isFinite(major) ? major : 0;
}

/**
 * 是否为低端 Android（Android 11 及以下、低 benchmark、低内存）。
 * @returns {boolean}
 */
function isLowEndAndroidDevice() {
  if (getHostPlatform() !== 'android') return false;
  if (typeof wx === 'undefined' || typeof wx.getSystemInfoSync !== 'function') {
    return false;
  }
  try {
    const sys = wx.getSystemInfoSync();
    const androidMajor = parseAndroidMajorVersion(sys.system);
    if (androidMajor > 0 && androidMajor <= 12) return true;
    const benchmark = Number(sys.benchmarkLevel);
    /** 微信 benchmarkLevel 越低性能越差，≤20 视为中端及以下。 */
    if (Number.isFinite(benchmark) && benchmark > 0 && benchmark <= 20) return true;
    const memMb = Number(sys.memorySize);
    if (Number.isFinite(memMb) && memMb > 0 && memMb <= 4096) return true;
  } catch (e) {
    return false;
  }
  return false;
}

/**
 * 获取当前设备录制档位（进程内缓存）。
 * @returns {typeof RECORD_PROFILE_720P}
 */
function getDeviceRecordProfile() {
  if (cachedProfile) return cachedProfile;
  cachedProfile = isLowEndAndroidDevice()
    ? Object.assign({}, RECORD_PROFILE_480P)
    : Object.assign({}, RECORD_PROFILE_720P);
  return cachedProfile;
}

/**
 * 是否应在高光固化时跳过 MediaContainer trim，直接全量拷贝。
 * @returns {boolean}
 */
function shouldSkipMediaContainerTrimForHighlight() {
  return !!getDeviceRecordProfile().skipMediaContainerTrim;
}

/**
 * 清除缓存（仅测试用）。
 * @returns {void}
 */
function resetDeviceRecordProfileCache() {
  cachedProfile = null;
}

module.exports = {
  RECORD_PROFILE_720P,
  RECORD_PROFILE_480P,
  LOW_END_ROLLING_FULL_COPY_CAP_BYTES,
  parseAndroidMajorVersion,
  isLowEndAndroidDevice,
  getDeviceRecordProfile,
  shouldSkipMediaContainerTrimForHighlight,
  resetDeviceRecordProfileCache
};
