/**
 * @fileoverview 我的推广：已通过审批的推广列表，支持一键下载 Logo。
 */

const { getToken } = require('../../../utils/request.js');
const { listMyPromos } = require('../../services/promo.service.js');
const { downloadAllLogos } = require('../../utils/promo-logo-download.js');

Page({
  data: {
    loading: true,
    promotions: [],
    errorText: '',
    downloadingIndex: -1
  },

  /**
   * 页面加载。
   * @returns {void}
   */
  onLoad: function () {},

  /**
   * 页面显示时刷新列表。
   * @returns {void}
   */
  onShow: function () {
    if (!getToken()) {
      this.setData({
        loading: false,
        promotions: [],
        errorText: '请先登录后查看'
      });
      return;
    }
    this.loadPromotions();
  },

  /**
   * 拉取已通过审批的推广列表。
   * @returns {void}
   */
  loadPromotions: function () {
    const self = this;
    self.setData({ loading: true, errorText: '' });
    listMyPromos()
      .then(function (body) {
        const raw = Array.isArray(body.promotions) ? body.promotions : [];
        const promotions = raw.map(function (item) {
          const p = item && typeof item === 'object' ? item : {};
          return {
            applicationId: p.application_id,
            targetMatchId: p.target_match_id,
            promoTitle: String(p.promo_title || ''),
            totalPool: Number(p.total_pool) || 0,
            approvedAt: String(p.approved_at || ''),
            ads: Array.isArray(p.ads) ? p.ads : []
          };
        });
        self.setData({ loading: false, promotions: promotions });
      })
      .catch(function (err) {
        const msg = err && err.message ? err.message : '加载失败';
        self.setData({ loading: false, errorText: msg, promotions: [] });
      });
  },

  /**
   * 一键下载某场推广的全部 Logo。
   * @param {Object} e
   * @returns {void}
   */
  onDownloadAllTap: function (e) {
    const index = e.currentTarget.dataset.index;
    const list = this.data.promotions;
    if (typeof index !== 'number' && typeof index !== 'string') return;
    const idx = Number(index);
    const promo = list[idx];
    if (!promo || !Array.isArray(promo.ads) || promo.ads.length === 0) {
      wx.showToast({ title: '暂无可下载 Logo', icon: 'none' });
      return;
    }
    const self = this;
    self.setData({ downloadingIndex: idx });
    wx.showLoading({ title: '下载中 0/' + promo.ads.length, mask: true });
    downloadAllLogos(promo.ads, function (current, total) {
      wx.showLoading({ title: '下载中 ' + current + '/' + total, mask: true });
    })
      .then(function (result) {
        wx.hideLoading();
        self.setData({ downloadingIndex: -1 });
        if (result.saved === 0 && result.failed > 0) {
          wx.showToast({ title: '全部下载失败', icon: 'none' });
          return;
        }
        const tip =
          result.failed > 0
            ? '已保存 ' + result.saved + ' 张，' + result.failed + ' 张失败'
            : '已保存 ' + result.saved + ' 张到相册';
        wx.showToast({ title: tip, icon: 'none', duration: 2500 });
      })
      .catch(function (err) {
        wx.hideLoading();
        self.setData({ downloadingIndex: -1 });
        const msg = err && err.message ? err.message : '下载失败';
        wx.showToast({ title: msg, icon: 'none' });
      });
  },

  /**
   * 复制母比赛 ID 到剪贴板（live.js 载入时需要）。
   * @param {Object} e
   * @returns {void}
   */
  onCopyMatchIdTap: function (e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.setClipboardData({
      data: String(id),
      success: function () {
        wx.showToast({ title: '已复制母比赛 ID', icon: 'success' });
      }
    });
  }
});
