/**
 * File readiness helpers for recorder chunks.
 *
 * A chunk is allowed into ReplayBuffer only after it is visible to the mini
 * program file system and has a non-trivial size. This avoids indexing empty
 * or still-finalizing recorder outputs.
 */

const DEFAULT_MIN_BYTES = 1024;

/** 极低码率阈值（字节/秒），低于此视为空壳。 */
const HOLLOW_MAX_BYTES_PER_SEC = 1500;

/** 短段绝对体积下限（字节）。 */
const HOLLOW_SHORT_ABSOLUTE_MIN_BYTES = 16384;

/** 长段绝对体积下限（字节）。 */
const HOLLOW_LONG_ABSOLUTE_MIN_BYTES = 65536;

/**
 * @param {number} wallDurationMs
 * @returns {number}
 */
function segmentDurationSec(wallDurationMs) {
  return Math.max(1, Math.floor(Number(wallDurationMs) || 0) / 1000);
}

/**
 * 按墙钟时长估算 rolling 段合理最小体积（用于裁剪产物校验）。
 * @param {number} wallDurationMs
 * @returns {number}
 */
function estimateMinSegmentBytes(wallDurationMs) {
  const durSec = segmentDurationSec(wallDurationMs);
  return Math.max(HOLLOW_SHORT_ABSOLUTE_MIN_BYTES, durSec * 4000);
}

/**
 * 判断 rolling 段是否为空壳（有墙钟跨度但几乎无有效编码数据）。
 * 采用分层阈值，避免 Android 长段低码率误拒（如 264KB/81s）。
 * @param {number} sizeBytes
 * @param {number} wallDurationMs
 * @returns {boolean}
 */
function isHollowSegment(sizeBytes, wallDurationMs) {
  const size = Math.max(0, Math.floor(Number(sizeBytes) || 0));
  const wallMs = Math.max(0, Math.floor(Number(wallDurationMs) || 0));
  const durSec = segmentDurationSec(wallMs);

  if (size < DEFAULT_MIN_BYTES) return true;
  if (wallMs < 500) return size < HOLLOW_SHORT_ABSOLUTE_MIN_BYTES;
  /** 1.5–3s 段也按码率判空壳，避免相机刚重建时 2KB 级假段混入高光。 */
  if (wallMs >= 1500 && size / durSec < HOLLOW_MAX_BYTES_PER_SEC) return true;
  if (wallMs >= 3000 && size < HOLLOW_SHORT_ABSOLUTE_MIN_BYTES) return true;
  if (wallMs >= 10000 && size < HOLLOW_LONG_ABSOLUTE_MIN_BYTES) return true;
  if (wallMs >= 5000 && size / durSec < HOLLOW_MAX_BYTES_PER_SEC) return true;
  return false;
}

/**
 * 探测时长与文件体积严重不匹配（Android 空壳 mp4 常见 getVideoInfo 虚报时长）。
 * @param {number} sizeBytes
 * @param {number} durationMs
 * @returns {boolean}
 */
function isSuspiciousDurationProbe(sizeBytes, durationMs) {
  return isHollowSegment(sizeBytes, durationMs);
}

function getFs() {
  if (typeof wx === 'undefined' || !wx.getFileSystemManager) return null;
  return wx.getFileSystemManager();
}

function getFileInfo(filePath) {
  return new Promise((resolve) => {
    const fs = getFs();
    if (!fs || !filePath) {
      resolve(null);
      return;
    }
    if (fs.getFileInfo) {
      fs.getFileInfo({
        filePath,
        success: (res) => resolve(res || null),
        fail: () => resolve(null)
      });
      return;
    }
    try {
      const st = fs.statSync(filePath);
      resolve(st || null);
    } catch (e) {
      resolve(null);
    }
  });
}

function accessFile(filePath) {
  return new Promise((resolve) => {
    const fs = getFs();
    if (!fs || !filePath) {
      resolve(false);
      return;
    }
    if (fs.access) {
      fs.access({
        path: filePath,
        success: () => resolve(true),
        fail: () => resolve(false)
      });
      return;
    }
    try {
      fs.statSync(filePath);
      resolve(true);
    } catch (e) {
      resolve(false);
    }
  });
}

function checkFileReady(filePath, opts) {
  const minBytes =
    opts && typeof opts.minBytes === 'number' && opts.minBytes > 0
      ? opts.minBytes
      : DEFAULT_MIN_BYTES;
  if (!filePath) return Promise.resolve({ ready: false, size: 0, reason: 'missing' });
  return getFileInfo(filePath)
    .then((info) => {
      if (!info) return { ready: false, size: 0, reason: 'missing' };
      const size = info && typeof info.size === 'number' ? info.size : 0;
      if (size < minBytes) {
        return { ready: false, size, reason: 'too_small' };
      }
      return { ready: true, size, reason: 'ok' };
    });
}

/**
 * Poll until a recorder temp file becomes readable, or timeout.
 *
 * @param {string} filePath
 * @param {{ minBytes?: number, maxWaitMs?: number, pollMs?: number }} [opts]
 * @returns {Promise<{ ready: boolean, size: number, reason: string }>}
 */
function waitForFileReady(filePath, opts) {
  const options = opts || {};
  const maxWaitMs =
    typeof options.maxWaitMs === 'number' && options.maxWaitMs > 0
      ? options.maxWaitMs
      : 0;
  const pollMs =
    typeof options.pollMs === 'number' && options.pollMs > 0
      ? options.pollMs
      : 80;
  if (!maxWaitMs) {
    return checkFileReady(filePath, options);
  }
  const startedAt = Date.now();
  const poll = () => checkFileReady(filePath, options).then((result) => {
    if (result.ready) return result;
    if (Date.now() - startedAt >= maxWaitMs) return result;
    return new Promise((resolve) => {
      setTimeout(() => {
        poll().then(resolve);
      }, pollMs);
    });
  });
  return poll();
}

module.exports = {
  DEFAULT_MIN_BYTES,
  HOLLOW_SHORT_ABSOLUTE_MIN_BYTES,
  HOLLOW_LONG_ABSOLUTE_MIN_BYTES,
  HOLLOW_MAX_BYTES_PER_SEC,
  estimateMinSegmentBytes,
  isHollowSegment,
  isSuspiciousDurationProbe,
  checkFileReady,
  waitForFileReady,
  getFileInfo,
  accessFile
};
