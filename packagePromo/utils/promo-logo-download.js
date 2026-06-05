/**
 * @fileoverview 推广 Logo 批量下载并保存到相册。
 */

/**
 * 请求相册写入权限；拒绝时引导用户打开设置。
 * @returns {Promise<void>}
 */
function ensurePhotosAlbumAuth() {
  return new Promise(function (resolve, reject) {
    wx.getSetting({
      success: function (res) {
        const auth = res.authSetting && res.authSetting['scope.writePhotosAlbum'];
        if (auth === true) {
          resolve();
          return;
        }
        wx.authorize({
          scope: 'scope.writePhotosAlbum',
          success: function () {
            resolve();
          },
          fail: function () {
            wx.showModal({
              title: '需要相册权限',
              content: '保存 Logo 需要写入相册权限，请在设置中开启',
              confirmText: '去设置',
              success: function (modalRes) {
                if (modalRes.confirm) {
                  wx.openSetting({
                    success: function (settingRes) {
                      if (
                        settingRes.authSetting &&
                        settingRes.authSetting['scope.writePhotosAlbum']
                      ) {
                        resolve();
                      } else {
                        reject(new Error('用户未授权相册权限'));
                      }
                    },
                    fail: function () {
                      reject(new Error('打开设置失败'));
                    }
                  });
                } else {
                  reject(new Error('用户拒绝相册权限'));
                }
              }
            });
          }
        });
      },
      fail: function () {
        reject(new Error('获取权限状态失败'));
      }
    });
  });
}

/**
 * 下载单张 Logo 并保存到相册。
 * @param {string} imageUrl - API 域名下的 Logo URL
 * @returns {Promise<void>}
 */
function downloadAndSaveLogo(imageUrl) {
  return new Promise(function (resolve, reject) {
    if (!imageUrl || typeof imageUrl !== 'string') {
      reject(new Error('无效的图片地址'));
      return;
    }
    wx.downloadFile({
      url: imageUrl,
      success: function (res) {
        if (res.statusCode !== 200 || !res.tempFilePath) {
          reject(new Error('下载失败 HTTP ' + res.statusCode));
          return;
        }
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: function () {
            resolve();
          },
          fail: function (err) {
            const msg = err && err.errMsg ? err.errMsg : '保存相册失败';
            reject(new Error(msg));
          }
        });
      },
      fail: function (err) {
        const msg = err && err.errMsg ? err.errMsg : '下载失败';
        reject(new Error(msg));
      }
    });
  });
}

/**
 * 顺序下载多张 Logo 到相册。
 * @param {Array<{ image_url?: string, imageUrl?: string }>} ads
 * @param {(current: number, total: number) => void} [onProgress]
 * @returns {Promise<{ saved: number, failed: number }>}
 */
function downloadAllLogos(ads, onProgress) {
  const list = Array.isArray(ads) ? ads : [];
  const urls = list
    .map(function (item) {
      if (!item || typeof item !== 'object') return '';
      return typeof item.image_url === 'string'
        ? item.image_url
        : typeof item.imageUrl === 'string'
          ? item.imageUrl
          : '';
    })
    .filter(function (u) {
      return u.length > 0;
    });

  if (urls.length === 0) {
    return Promise.resolve({ saved: 0, failed: 0 });
  }

  return ensurePhotosAlbumAuth().then(function () {
    let saved = 0;
    let failed = 0;
    const total = urls.length;

    /**
     * 递归顺序保存，避免并发触发相册限制。
     * @param {number} index
     * @returns {Promise<{ saved: number, failed: number }>}
     */
    function saveNext(index) {
      if (index >= total) {
        return Promise.resolve({ saved: saved, failed: failed });
      }
      if (typeof onProgress === 'function') {
        onProgress(index + 1, total);
      }
      return downloadAndSaveLogo(urls[index])
        .then(function () {
          saved += 1;
          return saveNext(index + 1);
        })
        .catch(function () {
          failed += 1;
          return saveNext(index + 1);
        });
    }

    return saveNext(0);
  });
}

module.exports = {
  ensurePhotosAlbumAuth,
  downloadAndSaveLogo,
  downloadAllLogos
};
