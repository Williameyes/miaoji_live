/**
 * @fileoverview 单场监控详情：曲线、挂载口令、关闭监控（无场次选择）。
 */

const { ensureRadarLabAccess } = require('../../../utils/radar-access.js');
const {
  addMatchTask,
  stopMatchMonitoring,
  fetchMatchStreamData,
  fetchMatchDetail
} = require('../../../services/radar-api.js');
const {
  normalizeTimeline,
  drawTimelineChart,
  formatCompactCount,
  parseUserCount
} = require('../../../utils/radar-chart.js');

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 20000;

/** @type {Record<string, string>} */
const STATUS_LABELS = {
  waiting_radar: '等待雷达',
  monitoring: '监控中',
  ended: '已结束',
  interrupted: '已中断'
};

/** @type {Record<string, string>} */
const STATUS_BADGE = {
  waiting_radar: 'rl-badge-warn',
  monitoring: 'rl-badge-ok',
  ended: 'rl-badge-muted',
  interrupted: 'rl-badge-warn'
};

Page({
  data: {
    matchId: '',
    matchTitle: '',
    tournamentName: '',
    matchStatus: '',
    statusLabel: '',
    statusBadgeClass: 'rl-badge-muted',
    currentOnline: '—',
    peakOnline: '—',
    timelineEmpty: true,
    polling: false,
    showBindModal: false,
    bindRawText: '',
    submitting: false,
    canStop: false,
    canvasReady: false,
    loading: true
  },

  /** @type {number | null} */
  _pollTimer: null,
  /** @type {CanvasRenderingContext2D | null} */
  _chartCtx: null,
  /** @type {number} */
  _canvasWidth: 0,
  /** @type {number} */
  _canvasHeight: 0,
  /** @type {Array<{timestamp:number,userCount:number}>} */
  _timelinePoints: [],

  /**
   * @param {Record<string, string>} query
   * @returns {void}
   */
  onLoad: function (query) {
    if (!ensureRadarLabAccess({ redirectBack: true })) return;
    const matchId = query && query.match_id ? String(query.match_id) : '';
    if (!matchId) {
      wx.showToast({ title: '缺少场次信息', icon: 'none' });
      setTimeout(function () {
        wx.navigateBack();
      }, 600);
      return;
    }
    this.setData({ matchId: matchId });
    this._loadMatchMeta(matchId);
  },

  /**
   * @returns {void}
   */
  onShow: function () {
    if (this.data.matchId) {
      this._fetchStreamOnce();
      this._startPolling();
    }
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
   * @returns {void}
   */
  onReady: function () {
    if (this.data.matchId) {
      this._initCanvas();
    }
  },

  /**
   * 拉取场次元信息（队名、赛事名）。
   * @param {string} matchId
   * @returns {void}
   */
  _loadMatchMeta: function (matchId) {
    const self = this;
    fetchMatchDetail(matchId)
      .then(function (detail) {
        const title = detail
          ? detail.teamA + ' vs ' + detail.teamB
          : '场次 #' + matchId;
        self.setData({
          matchTitle: title,
          tournamentName: detail ? detail.tournamentName : '',
          loading: false
        });
      })
      .catch(function () {
        self.setData({
          matchTitle: '场次 #' + matchId,
          loading: false
        });
      });
  },

  /**
   * @returns {void}
   */
  _initCanvas: function () {
    const self = this;
    const query = wx.createSelectorQuery();
    query
      .select('#heatCanvas')
      .fields({ node: true, size: true })
      .exec(function (res) {
        const item = res && res[0];
        if (!item || !item.node) return;
        const canvas = item.node;
        const ctx = canvas.getContext('2d');
        const dpr = wx.getSystemInfoSync().pixelRatio || 2;
        const width = item.width;
        const height = item.height;
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);
        self._chartCtx = ctx;
        self._canvasWidth = width;
        self._canvasHeight = height;
        self.setData({ canvasReady: true });
        self._redrawChart();
      });
  },

  /**
   * @returns {void}
   */
  _redrawChart: function () {
    if (!this._chartCtx || !this._canvasWidth) return;
    drawTimelineChart(
      this._chartCtx,
      this._canvasWidth,
      this._canvasHeight,
      this._timelinePoints,
      { showEmptyLabel: false }
    );
  },

  /**
   * @returns {void}
   */
  _startPolling: function () {
    const self = this;
    this._stopPolling();
    if (!this.data.matchId) return;
    this.setData({ polling: true });
    this._pollTimer = setInterval(function () {
      self._fetchStreamOnce();
    }, POLL_INTERVAL_MS);
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
   * 下拉刷新曲线与状态。
   * @returns {void}
   */
  onPullDownRefresh: function () {
    const self = this;
    Promise.all([
      fetchMatchDetail(this.data.matchId).then(function (detail) {
        if (detail) {
          self.setData({
            matchTitle: detail.teamA + ' vs ' + detail.teamB,
            tournamentName: detail.tournamentName
          });
        }
      }),
      this._fetchStreamOnce()
    ]).finally(function () {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * 拉取一次 stream_data。
   * @returns {Promise<void>}
   */
  _fetchStreamOnce: function () {
    const self = this;
    const matchId = this.data.matchId;
    if (!matchId) return Promise.resolve();
    return fetchMatchStreamData(matchId)
      .then(function (res) {
        const status =
          typeof res.match_status === 'string' ? res.match_status : '';
        const timeline = normalizeTimeline(
          /** @type {unknown[]} */ (res.timeline_data || [])
        );
        self._timelinePoints = timeline;
        const canStop = status === 'monitoring' || status === 'waiting_radar';
        self.setData({
          matchStatus: status,
          statusLabel: STATUS_LABELS[status] || status || '未知',
          statusBadgeClass: STATUS_BADGE[status] || 'rl-badge-muted',
          currentOnline: formatCompactCount(parseUserCount(res.current_online_count)),
          peakOnline: formatCompactCount(parseUserCount(res.peak_user_count)),
          timelineEmpty: !timeline.length,
          canStop: canStop
        });
        self._redrawChart();
      })
      .catch(function (err) {
        console.warn('[RadarDetail] stream_data fail', err);
      });
  },

  /**
   * @returns {void}
   */
  onOpenBindModal: function () {
    this.setData({ showBindModal: true, bindRawText: '' });
  },

  /**
   * @returns {void}
   */
  onCloseBindModal: function () {
    this.setData({ showBindModal: false });
  },

  /**
   * @param {WechatMiniprogram.Input} e
   * @returns {void}
   */
  onBindInput: function (e) {
    this.setData({ bindRawText: e.detail.value });
  },

  /**
   * @returns {void}
   */
  onSubmitBind: function () {
    const self = this;
    const matchId = this.data.matchId;
    const rawText = (this.data.bindRawText || '').trim();
    if (!rawText) {
      wx.showToast({ title: '请粘贴抖音口令', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    addMatchTask(matchId, rawText)
      .then(function (res) {
        const enqueued = res.task_enqueued !== false;
        const dup = typeof res.duplicate_reason === 'string' ? res.duplicate_reason : '';
        if (enqueued) {
          wx.showToast({ title: '已启动监控', icon: 'success' });
        } else {
          const hint =
            dup === 'already_monitoring'
              ? '该路已在监控中'
              : dup === 'queue_pending'
                ? '任务已在队列中'
                : '未重复入队';
          wx.showToast({ title: hint, icon: 'none' });
        }
        self.setData({ showBindModal: false });
        self._fetchStreamOnce();
      })
      .catch(function (err) {
        wx.showToast({ title: err.message || '挂载失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ submitting: false });
      });
  },

  /**
   * @returns {void}
   */
  onStopMonitoring: function () {
    const self = this;
    const matchId = this.data.matchId;
    wx.showModal({
      title: '关闭监控',
      content: '将结束该场次全部直播雷达任务，雷达端会在下次上报时自动退出。确定继续？',
      confirmText: '关闭',
      confirmColor: '#ef4444',
      success: function (res) {
        if (!res.confirm) return;
        self._doStopMonitoring(matchId);
      }
    });
  },

  /**
   * @param {string} matchId
   * @returns {void}
   */
  _doStopMonitoring: function (matchId) {
    const self = this;
    this.setData({ submitting: true });
    stopMatchMonitoring(matchId)
      .then(function () {
        wx.showToast({ title: '监控已关闭', icon: 'success' });
        self._fetchStreamOnce();
      })
      .catch(function (err) {
        if (err.errorCode === 'MATCH_ALREADY_ENDED') {
          wx.showToast({ title: '场次已结束', icon: 'none' });
          self._fetchStreamOnce();
          return;
        }
        wx.showToast({ title: err.message || '关闭失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ submitting: false });
      });
  },

  /**
   * @returns {void}
   */
  stopModalBubble: function () {}
});
