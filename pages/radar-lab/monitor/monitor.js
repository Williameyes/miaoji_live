/**
 * @fileoverview 雷达监控现场：多路合流热度曲线、挂载口令、关闭监控。
 */

const { ensureRadarLabAccess } = require('../../../utils/radar-access.js');
const {
  addMatchTask,
  stopMatchMonitoring,
  fetchMatchStreamData
} = require('../../../services/radar-api.js');
const { findMatch, readAssets } = require('../../../utils/radar-local-store.js');
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
    matches: [],
    canvasReady: false
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
   * 页面加载。
   * @param {Record<string, string>} query
   * @returns {void}
   */
  onLoad: function (query) {
    if (!ensureRadarLabAccess({ redirectBack: true })) return;
    const matchId = query && query.match_id ? String(query.match_id) : '';
    this._initMatchContext(matchId);
    this._loadMatchList();
  },

  /**
   * 页面显示：恢复轮询。
   * @returns {void}
   */
  onShow: function () {
    if (this.data.matchId) {
      this._fetchStreamOnce();
      this._startPolling();
    }
  },

  /**
   * 页面隐藏：暂停轮询。
   * @returns {void}
   */
  onHide: function () {
    this._stopPolling();
  },

  /**
   * 页面卸载。
   * @returns {void}
   */
  onUnload: function () {
    this._stopPolling();
  },

  /**
   * 初始化场次上下文。
   * @param {string} matchId
   * @returns {void}
   */
  _initMatchContext: function (matchId) {
    const local = matchId ? findMatch(matchId) : null;
    const title = local
      ? local.teamA + ' vs ' + local.teamB
      : matchId
        ? '场次 #' + matchId
        : '请选择或输入场次';
    this.setData({
      matchId: matchId,
      matchTitle: title
    });
    if (matchId) {
      const self = this;
      setTimeout(function () {
        self._initCanvas();
      }, 80);
    }
  },

  /**
   * 加载本地场次供快速选择。
   * @returns {void}
   */
  _loadMatchList: function () {
    const assets = readAssets();
    this.setData({ matches: assets.matches.slice(0, 20) });
  },

  /**
   * 手动输入场次 ID。
   * @param {WechatMiniprogram.Input} e
   * @returns {void}
   */
  onMatchIdInput: function (e) {
    this.setData({ matchId: e.detail.value.trim() });
  },

  /**
   * 确认加载场次。
   * @returns {void}
   */
  onLoadMatch: function () {
    const matchId = this.data.matchId;
    if (!matchId) {
      wx.showToast({ title: '请输入场次 ID', icon: 'none' });
      return;
    }
    this._initMatchContext(matchId);
    this._fetchStreamOnce();
    this._startPolling();
  },

  /**
   * 从列表选择场次。
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onPickMatch: function (e) {
    const matchId = e.currentTarget.dataset.id;
    if (!matchId) return;
    this._initMatchContext(String(matchId));
    this.setData({ matchId: String(matchId) });
    this._fetchStreamOnce();
    this._startPolling();
  },

  /**
   * 页面就绪：初始化 Canvas 2D。
   * @returns {void}
   */
  onReady: function () {
    this._initCanvas();
  },

  /**
   * 初始化 Canvas 2D 上下文。
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
   * 重绘曲线。
   * @returns {void}
   */
  _redrawChart: function () {
    if (!this._chartCtx || !this._canvasWidth) return;
    drawTimelineChart(
      this._chartCtx,
      this._canvasWidth,
      this._canvasHeight,
      this._timelinePoints
    );
  },

  /**
   * 启动轮询。
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
   * 停止轮询。
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
   * 拉取一次 stream_data。
   * @returns {void}
   */
  _fetchStreamOnce: function () {
    const self = this;
    const matchId = this.data.matchId;
    if (!matchId) return;
    fetchMatchStreamData(matchId)
      .then(function (res) {
        const status =
          typeof res.match_status === 'string' ? res.match_status : '';
        const timeline = normalizeTimeline(
          /** @type {unknown[]} */ (res.timeline_data || [])
        );
        self._timelinePoints = timeline;
        const currentRaw = res.current_online_count;
        const peakRaw = res.peak_user_count;
        const canStop = status === 'monitoring' || status === 'waiting_radar';
        self.setData({
          matchStatus: status,
          statusLabel: STATUS_LABELS[status] || status || '未知',
          statusBadgeClass: STATUS_BADGE[status] || 'rl-badge-muted',
          currentOnline: formatCompactCount(parseUserCount(currentRaw)),
          peakOnline: formatCompactCount(parseUserCount(peakRaw)),
          timelineEmpty: !timeline.length,
          canStop: canStop
        });
        self._redrawChart();
      })
      .catch(function (err) {
        console.warn('[RadarMonitor] stream_data fail', err);
      });
  },

  /**
   * 打开绑定雷达弹窗。
   * @returns {void}
   */
  onOpenBindModal: function () {
    if (!this.data.matchId) {
      wx.showToast({ title: '请先加载场次', icon: 'none' });
      return;
    }
    this.setData({ showBindModal: true, bindRawText: '' });
  },

  /**
   * 关闭绑定弹窗。
   * @returns {void}
   */
  onCloseBindModal: function () {
    this.setData({ showBindModal: false });
  },

  /**
   * 口令输入。
   * @param {WechatMiniprogram.Input} e
   * @returns {void}
   */
  onBindInput: function (e) {
    this.setData({ bindRawText: e.detail.value });
  },

  /**
   * 提交挂载雷达任务。
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
   * 关闭监控：二次确认后调用 stop_monitoring。
   * @returns {void}
   */
  onStopMonitoring: function () {
    const self = this;
    const matchId = this.data.matchId;
    if (!matchId) return;
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
   * 执行 stop_monitoring 请求。
   * @param {string} matchId
   * @returns {void}
   */
  _doStopMonitoring: function (matchId) {
    const self = this;
    this.setData({ submitting: true });
    stopMatchMonitoring(matchId)
      .then(function (res) {
        const released = Array.isArray(res.workers_released) ? res.workers_released.length : 0;
        const removed = res.queue_tasks_removed || 0;
        wx.showToast({
          title: '已关闭 · 释放' + released + '路',
          icon: 'none',
          duration: 2500
        });
        console.log('[RadarMonitor] stop_monitoring ok', {
          removed: removed,
          released: released
        });
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
   * 阻止弹窗冒泡。
   * @returns {void}
   */
  stopModalBubble: function () {}
});
