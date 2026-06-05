/**
 * @fileoverview 雷达管理端列表 scope（mine / all）与当前用户管理员判定。
 */

const { STORAGE_USER_INFO_KEY, getToken } = require('../../utils/request.js');

/**
 * 从 globalData 或 Storage 读取当前用户信息。
 * @returns {Record<string, unknown> | null}
 */
function readCurrentUserInfo() {
  try {
    const app = getApp();
    const gi = app.globalData && app.globalData.userInfo;
    if (gi && typeof gi === 'object') {
      return /** @type {Record<string, unknown>} */ (gi);
    }
  } catch (e) {
    // getApp 在极少数时机可能不可用
  }
  try {
    const cached = wx.getStorageSync(STORAGE_USER_INFO_KEY);
    if (cached && typeof cached === 'object') {
      return /** @type {Record<string, unknown>} */ (cached);
    }
  } catch (e2) {
    // 忽略缓存读取异常
  }
  return null;
}

/**
 * 当前登录用户是否为系统管理员（仅用于列表 scope=all）。
 * @returns {boolean}
 */
function isCurrentUserAdmin() {
  if (!getToken()) return false;
  const info = readCurrentUserInfo();
  return info != null && info.isAdmin === true;
}

/**
 * 管理列表 scope：管理员可查看全部，普通用户仅本人可管理数据。
 * @returns {'mine' | 'all'}
 */
function getRadarListScope() {
  return isCurrentUserAdmin() ? 'all' : 'mine';
}

module.exports = {
  readCurrentUserInfo,
  isCurrentUserAdmin,
  getRadarListScope
};
