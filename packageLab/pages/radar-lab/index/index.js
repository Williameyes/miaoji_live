/**
 * @fileoverview 直播雷达实验室入口：赛事 / 场次维护、监控、战报。
 */

const { ensureMatchManageAccess, isRadarWhitelistUser } = require('../../../utils/radar-access.js');

Page({
  data: {
    isWhitelist: false
  },

  /**
   * 页面加载：登录鉴权。
   * @returns {void}
   */
  onLoad: function () {
    if (!ensureMatchManageAccess({ redirectBack: true })) return;
  },

  /**
   * 页面展示：刷新白名单特权状态。
   * @returns {void}
   */
  onShow: function () {
    this.setData({
      isWhitelist: isRadarWhitelistUser()
    });
  },

  /**
   * 跳转场次维护页。
   * @returns {void}
   */
  onGoOam: function () {
    if (!ensureMatchManageAccess()) return;
    wx.navigateTo({ url: '/packageLab/pages/radar-lab/oam/oam' });
  },

  /**
   * 跳转赛事维护页。
   * @returns {void}
   */
  onGoTournament: function () {
    if (!ensureMatchManageAccess()) return;
    wx.navigateTo({ url: '/packageLab/pages/radar-lab/oam/tournament-list/tournament-list' });
  }
});
