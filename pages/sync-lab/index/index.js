/**
 * @fileoverview sync-lab 入口页：角色选择
 * 白名单校验已在 mine.js onSyncLabTap 完成，本页无需再校验。
 */

Page({
  data: {},

  onGoCollector: function () {
    wx.navigateTo({ url: '/pages/sync-lab/collector/collector' });
  },

  onGoBroadcaster: function () {
    wx.navigateTo({ url: '/pages/sync-lab/broadcaster/broadcaster' });
  }
});
