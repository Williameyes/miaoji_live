/**
 * @fileoverview 推广监测：带广告/推广配置的场次（发布、小程序码、审批入口）。
 */

const { ensureRadarLabAccess } = require('../../../utils/radar-access.js');
const { LIST_POLL_MS, fetchMonitorRows } = require('../../../utils/monitor-list-core.js');

Page({
  data: {
    matchRows: [],
    loading: true,
    polling: false
  },

  /** @type {number | null} */
  _pollTimer: null,

  /**
   * @returns {void}
   */
  onLoad: function () {
    if (!ensureRadarLabAccess({ redirectBack: true })) return;
  },

  /**
   * @returns {void}
   */
  onShow: function () {
    this._reloadList();
    this._startPolling();
  },

  /**
   * @returns {void}
   */
  onHide: function () {
    this._stopPolling();
  },

  /**
   * @returns {void}
   */
  onUnload: function () {
    this._stopPolling();
  },

  /**
   * 下拉刷新。
   * @returns {void}
   */
  onPullDownRefresh: function () {
    const self = this;
    this._reloadList(true).finally(function () {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * @param {boolean} [silent]
   * @returns {Promise<void>}
   */
  _reloadList: function (silent) {
    const self = this;
    if (!silent) {
      this.setData({ loading: true });
    }
    return fetchMonitorRows('promo')
      .then(function (rows) {
        self.setData({ matchRows: rows, loading: false });
      })
      .catch(function (err) {
        self.setData({ loading: false });
        if (!silent) {
          wx.showToast({ title: err.message || '加载失败', icon: 'none' });
        }
      });
  },

  /**
   * @returns {void}
   */
  _startPolling: function () {
    const self = this;
    this._stopPolling();
    this.setData({ polling: true });
    this._pollTimer = setInterval(function () {
      self._reloadList(true);
    }, LIST_POLL_MS);
  },

  /**
   * @returns {void}
   */
  _stopPolling: function () {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this.setData({ polling: false });
  },

  /**
   * 进入推广发布/管理页。
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onOpenPromoManage: function (e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url:
        '/packageLab/pages/radar-lab/oam/promo-publish/promo-publish?match_id=' +
        encodeURIComponent(id)
    });
  }
});
