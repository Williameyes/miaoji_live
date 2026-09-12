/**
 * @fileoverview 雷达实验室页面访问控制（与 sync-lab 白名单一致，实验/内测功能）。
 */

const { getToken } = require('../../utils/request.js');
const { checkSyncLabWhitelist } = require('../../utils/sync-lab-whitelist.js');

/**
 * 判断是否为 403 无权访问错误。
 * @param {unknown} err
 * @returns {boolean}
 */
function isForbiddenError(err) {
  if (!err || typeof err !== 'object') return false;
  const e = /** @type {{ errorCode?: string, statusCode?: number }} */ (err);
  return e.errorCode === 'FORBIDDEN' || e.statusCode === 403;
}

/**
 * 403 时提示并返回列表页。
 * @param {Object} [opts]
 * @param {string} [opts.fallbackUrl] - 默认 OAM 场次列表
 * @returns {void}
 */
function handleRadarForbidden(opts) {
  const options = opts || {};
  const fallbackUrl =
    options.fallbackUrl || '/packageLab/pages/radar-lab/oam/oam';
  wx.showToast({ title: '无权查看', icon: 'none' });
  setTimeout(function () {
    wx.redirectTo({
      url: fallbackUrl,
      fail: function () {
        wx.navigateBack({ delta: 1 });
      }
    });
  }, 600);
}

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
    wx.showToast({ title: '请先登录后使用管理功能', icon: 'none', duration: 1500 });
    if (options.redirectBack) {
      setTimeout(function () {
        wx.navigateBack({ delta: 1 });
      }, 1000);
    }
    return false;
  }
  if (!checkSyncLabWhitelist()) {
    wx.showToast({ title: '该功能仅对内测白名单用户开放', icon: 'none', duration: 1500 });
    if (options.redirectBack) {
      setTimeout(function () {
        wx.navigateBack({ delta: 1 });
      }, 1000);
    }
    return false;
  }
  return true;
}

/**
 * 校验比赛管理基础权限（已登录用户即可使用）。
 * @param {Object} [opts]
 * @param {boolean} [opts.redirectBack] - 未登录提示后是否 navigateBack
 * @returns {boolean}
 */
function ensureMatchManageAccess(opts) {
  const options = opts || {};
  const token = getToken();
  if (!token) {
    wx.showToast({ title: '请先登录后使用比赛管理功能', icon: 'none', duration: 1500 });
    if (options.redirectBack) {
      setTimeout(function () {
        wx.navigateBack({ delta: 1 });
      }, 1000);
    }
    return false;
  }
  return true;
}

/**
 * 检查当前用户是否具备白名单特权（AI批量导入、监控挂载等）。
 * @returns {boolean}
 */
function isRadarWhitelistUser() {
  return checkSyncLabWhitelist();
}

module.exports = {
  isForbiddenError,
  handleRadarForbidden,
  ensureRadarLabAccess,
  ensureMatchManageAccess,
  isRadarWhitelistUser
};

