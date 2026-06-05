/**
 * @fileoverview 推广广场扫码落地页（主包）：解析 scene 后跳转分包推广广场。
 * 小程序码 page 须指向主包页面，避免扫码「页面不存在」。
 */

const {
  resolvePromoTargetMatchId,
  buildPromoSquarePageUrl
} = require('../../utils/promo-entry.js');
const { writePromoSquareMatchId } = require('../../utils/promo-square-cache.js');

Page({
  /**
   * @param {Record<string, string | undefined>} options
   * @returns {void}
   */
  onLoad: function (options) {
    const matchId = resolvePromoTargetMatchId(options);
    if (!matchId) {
      wx.showToast({ title: '无效的推广链接', icon: 'none' });
      setTimeout(function () {
        wx.switchTab({ url: '/pages/index/index' });
      }, 1200);
      return;
    }
    writePromoSquareMatchId(matchId);
    wx.redirectTo({
      url: buildPromoSquarePageUrl(matchId),
      fail: function () {
        wx.showToast({ title: '打开推广广场失败', icon: 'none' });
        setTimeout(function () {
          wx.switchTab({ url: '/pages/index/index' });
        }, 1200);
      }
    });
  }
});
