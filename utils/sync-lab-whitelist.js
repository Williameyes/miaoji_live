/**
 * @fileoverview sync-lab 入口与 Live 自动记分共用的 OpenID 白名单（单一数据源）。
 */

const { STORAGE_USER_INFO_KEY } = require('./request.js');

/**
 * 自动同步实验功能白名单 OpenID。
 * 与「我的」页 sync-lab / 直播雷达入口、直播节次长按自动记分能力位对齐。
 */
const SYNC_LAB_OPENID_WHITELIST = [
  'owImn7cUbBnTEk2Mx9IyZDnbVR1I',
  'owImn7YI-B-Zm8PCXCEW7BDiu--E',
  'owImn7d3tOlRRlyhLMggkDNYZBr4'
];

/**
 * 检查当前已登录用户的 OpenID 是否在 sync-lab / 自动记分实验白名单内。
 * OpenID 从 `globalData.userInfo` 或 Storage 缓存中读取，无需网络请求。
 * @returns {boolean}
 */
function checkSyncLabWhitelist() {
  let openid = '';
  try {
    const app = getApp();
    const gi = app.globalData && app.globalData.userInfo;
    if (gi && typeof gi === 'object') {
      const o = /** @type {Record<string, unknown>} */ (gi);
      if (typeof o.openid === 'string') {
        openid = o.openid.trim();
      }
    }
  } catch (e) {
    return false;
  }
  if (!openid) {
    try {
      const cached = wx.getStorageSync(STORAGE_USER_INFO_KEY);
      if (cached && typeof cached === 'object') {
        const c = /** @type {Record<string, unknown>} */ (cached);
        if (typeof c.openid === 'string') {
          openid = c.openid.trim();
        }
      }
    } catch (e2) {
      // 忽略缓存读取异常
    }
  }
  return openid.length > 0 && SYNC_LAB_OPENID_WHITELIST.indexOf(openid) !== -1;
}

module.exports = {
  checkSyncLabWhitelist
};
