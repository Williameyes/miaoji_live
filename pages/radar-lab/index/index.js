/**
 * @fileoverview 直播雷达实验室入口：赛事 / 场次维护、监控、战报。
 */

const { ensureRadarLabAccess } = require('../../../utils/radar-access.js');

Page({
  data: {},

  /**
   * 页面加载：白名单校验。
   * @returns {void}
   */
  onLoad: function () {
    ensureRadarLabAccess({ redirectBack: true });
  },

  /**
   * 跳转场次维护页。
   * @returns {void}
   */
  onGoOam: function () {
    if (!ensureRadarLabAccess()) return;
    wx.navigateTo({ url: '/pages/radar-lab/oam/oam' });
  },

  /**
   * 跳转赛事维护页。
   * @returns {void}
   */
  onGoTournament: function () {
    if (!ensureRadarLabAccess()) return;
    wx.navigateTo({ url: '/pages/radar-lab/oam/tournament-list/tournament-list' });
  },

  /**
   * 跳转实时监控列表页。
   * @returns {void}
   */
  onGoMonitor: function () {
    if (!ensureRadarLabAccess()) return;
    wx.navigateTo({ url: '/pages/radar-lab/monitor/index' });
  },

  /**
   * 跳转战报宣发页。
   * @returns {void}
   */
  onGoPoster: function () {
    if (!ensureRadarLabAccess()) return;
    wx.navigateTo({ url: '/pages/radar-lab/poster/poster' });
  }
});
