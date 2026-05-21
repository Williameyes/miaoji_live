/**
 * File readiness helpers for recorder chunks.
 *
 * A chunk is allowed into ReplayBuffer only after it is visible to the mini
 * program file system and has a non-trivial size. This avoids indexing empty
 * or still-finalizing recorder outputs.
 */

const DEFAULT_MIN_BYTES = 1024;

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

module.exports = {
  DEFAULT_MIN_BYTES,
  checkFileReady,
  getFileInfo,
  accessFile
};
