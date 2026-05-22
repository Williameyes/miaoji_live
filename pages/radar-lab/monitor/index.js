/**
 * @fileoverview 实时监控：展示服务端正在监控中的场次列表。
 */

const { ensureRadarLabAccess } = require('../../../utils/radar-access.js');
const { fetchMatchList } = require('../../../services/radar-api.js');
const { formatStartTimeDisplay } = require('../../../utils/radar-datetime.js');
const { formatCompactCount, parseUserCount } = require('../../../utils/radar-chart.js');

/** 列表轮询间隔（毫秒） */
const LIST_POLL_MS = 20000;

/** @type {Record<string, string>} */
const STATUS_LABELS = {
  waiting_radar: '等待雷达',
  monitoring: '监控中',
  ended: '已结束',
  interrupted: '已中断'
};

/** 仅展示正在采集（monitoring）的场次 */
const ACTIVE_STATUS = 'monitoring';

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
   * 从服务端拉取监控中场次。
   * @param {boolean} [silent]
   * @returns {Promise<void>}
   */
  _reloadList: function (silent) {
    const self = this;
    if (!silent) {
      this.setData({ loading: true });
    }
    return fetchMatchList({ status: ACTIVE_STATUS })
      .then(function (list) {
        const rows = list.map(function (m) {
          return {
            id: m.id,
            teamA: m.teamA,
            teamB: m.teamB,
            startTimeText: formatStartTimeDisplay(m.startTime),
            tournamentName: m.tournamentName || '—',
            statusLabel: STATUS_LABELS[m.matchStatus] || m.matchStatus || '监控中',
            currentOnline: m.currentOnline
              ? formatCompactCount(parseUserCount(m.currentOnline))
              : '—'
          };
        });
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
   * 进入单场监控详情。
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onOpenDetail: function (e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: '/pages/radar-lab/monitor/detail?match_id=' + encodeURIComponent(id)
    });
  }
});
