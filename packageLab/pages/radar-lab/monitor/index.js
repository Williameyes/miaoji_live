/**
 * @fileoverview 监测中心：采集中场次 + 推广专场统一管理入口。
 */

const { ensureRadarLabAccess } = require('../../../utils/radar-access.js');
const { fetchMatchList, fetchMatchDetail } = require('../../../services/radar-api.js');
const { formatStartTimeDisplay } = require('../../../utils/radar-datetime.js');
const { formatCompactCount, parseUserCount } = require('../../../utils/radar-chart.js');

/** 列表轮询间隔（毫秒） */
const LIST_POLL_MS = 20000;

/** @type {Record<string, string>} */
const STATUS_LABELS = {
  waiting_radar: '等待雷达',
  monitoring: '监测中',
  ended: '已结束',
  interrupted: '已中断'
};

/** 采集中 Tab 仅展示 monitoring 状态 */
const ACTIVE_STATUS = 'monitoring';

Page({
  data: {
    activeTab: 'active',
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
   * 切换 Tab：采集中 / 推广专场。
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onTabChange: function (e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab || tab === this.data.activeTab) return;
    this.setData({ activeTab: tab });
    this._reloadList();
  },

  /**
   * 从服务端拉取列表。
   * @param {boolean} [silent]
   * @returns {Promise<void>}
   */
  _reloadList: function (silent) {
    const self = this;
    const tab = this.data.activeTab;
    if (!silent) {
      this.setData({ loading: true });
    }
    const query =
      tab === 'active'
        ? { status: ACTIVE_STATUS }
        : {};
    return fetchMatchList(query)
      .then(function (list) {
        const filtered =
          tab === 'promo'
            ? list.filter(function (m) {
                return m.promoEnabled && m.matchStatus !== 'ended';
              })
            : list;
        const rows = self._mapRows(filtered);
        self.setData({ matchRows: rows, loading: false });
        if (tab === 'promo' && rows.length) {
          self._hydratePromoRows(rows);
        }
      })
      .catch(function (err) {
        self.setData({ loading: false });
        if (!silent) {
          wx.showToast({ title: err.message || '加载失败', icon: 'none' });
        }
      });
  },

  /**
   * @param {import('../../../utils/radar-model.js').RadarMatchView[]} list
   * @returns {Array<Record<string, unknown>>}
   */
  _mapRows: function (list) {
    return list.map(function (m) {
      return {
        id: m.id,
        teamA: m.teamA,
        teamB: m.teamB,
        startTimeText: formatStartTimeDisplay(m.startTime),
        tournamentName: m.tournamentName || '—',
        statusLabel: STATUS_LABELS[m.matchStatus] || m.matchStatus || '—',
        currentOnline: m.currentOnline
          ? formatCompactCount(parseUserCount(m.currentOnline))
          : '—',
        promoTitle: m.promoTitle || '',
        hasPromo: Boolean(m.promoEnabled),
        hasPool: (m.totalPool || 0) > 0
      };
    });
  },

  /**
   * match/list 可能不含推广字段，以 detail 为准补全推广专场列表。
   * @param {Array<Record<string, unknown>>} rows
   * @returns {void}
   */
  _hydratePromoRows: function (rows) {
    const self = this;
    Promise.all(
      rows.map(function (row) {
        return fetchMatchDetail(row.id)
          .then(function (detail) {
            if (!detail || !detail.promoEnabled || detail.matchStatus === 'ended') {
              return null;
            }
            return {
              id: String(row.id),
              promoTitle: detail.promoTitle || '',
              statusLabel: STATUS_LABELS[detail.matchStatus] || detail.matchStatus || '—',
              hasPromo: true
            };
          })
          .catch(function () {
            return null;
          });
      })
    ).then(function (details) {
      const detailMap = {};
      const validIds = {};
      details.forEach(function (item) {
        if (item) {
          detailMap[item.id] = item;
          validIds[item.id] = true;
        }
      });
      const nextRows = self.data.matchRows
        .filter(function (row) {
          return validIds[String(row.id)];
        })
        .map(function (row) {
          const patch = detailMap[String(row.id)];
          return patch ? Object.assign({}, row, patch) : row;
        });
      self.setData({ matchRows: nextRows });
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
   * 进入单场监测详情。
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onOpenDetail: function (e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const focusAds = this.data.activeTab === 'promo' ? '&focus_ads=1' : '';
    wx.navigateTo({
      url:
        '/packageLab/pages/radar-lab/monitor/detail?match_id=' +
        encodeURIComponent(id) +
        focusAds
    });
  }
});
