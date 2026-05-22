/**
 * @fileoverview 直播雷达实验室入口：OAM / 监控 / 战报三大模块。
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
   * 跳转 OAM 维护页。
   * @returns {void}
   */
  onGoOam: function () {
    if (!ensureRadarLabAccess()) return;
    wx.navigateTo({ url: '/pages/radar-lab/oam/oam' });
  },

  /**
   * 跳转监控现场页。
   * @returns {void}
   */
  onGoMonitor: function () {
    if (!ensureRadarLabAccess()) return;
    wx.navigateTo({ url: '/pages/radar-lab/monitor/monitor' });
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
