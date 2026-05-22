/**
 * @fileoverview 雷达实验室页面访问控制（与 sync-lab / 自动同步白名单一致）。
 */

const { getToken } = require('./request.js');
const { checkSyncLabWhitelist } = require('./sync-lab-whitelist.js');

/**
 * 校验登录 + 白名单；不通过时提示并返回 false。
 * @param {Object} [opts]
 * @param {boolean} [opts.redirectBack] - 无权限时 navigateBack
 * @returns {boolean}
 */
function ensureRadarLabAccess(opts) {
  const options = opts || {};
  const token = getToken();
  if (!token) {
    wx.showToast({ title: '请先登录', icon: 'none' });
    if (options.redirectBack) {
      setTimeout(function () {
        wx.navigateBack({ delta: 1 });
      }, 600);
    }
    return false;
  }
  if (!checkSyncLabWhitelist()) {
    wx.showToast({ title: '暂无使用权限', icon: 'none' });
    if (options.redirectBack) {
      setTimeout(function () {
        wx.navigateBack({ delta: 1 });
      }, 600);
    }
    return false;
  }
  return true;
}

module.exports = {
  ensureRadarLabAccess
};
