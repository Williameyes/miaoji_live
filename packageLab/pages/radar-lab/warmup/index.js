/**
 * @fileoverview 直播间预热功能独立控制台
 */

const { ensureRadarLabAccess } = require('../../../utils/radar-access.js');
const { fetchMatchList, fetchMatchDetail, sendWarmup, fetchWarmupStatus } = require('../../../services/radar-api.js');

/** 场次状态对应名称与样式 */
const STATUS_DISPLAY = {
  waiting_radar: { label: '等待雷达', cls: 'rl-badge-warn' },
  monitoring: { label: '监测中', cls: 'rl-badge-ok' },
  ended: { label: '已结束', cls: 'rl-badge-muted' },
  interrupted: { label: '已中断', cls: 'rl-badge-warn' }
};

Page({
  data: {
    // 列表模式
    activeMatches: [],
    loading: false,

    // 配置与预热模式
    selectedMatchId: '',
    selectedMatchTitle: '',
    boundAnchors: [],
    submitting: false,

    // 预热表单字段
    warmupSourceMode: 'select',
    warmupInputText: '',
    warmupLiveUrl: '',
    warmupAccountCount: 3,
    warmupDurationMin: 30,
    warmupCommentsText: '',

    // 新增调度参数与预览
    useTiledPlan: true,
    totalShowDurationMin: 120,
    overlapRatio: 0.45,
    maxConcurrentPerRoom: 2,
    previewPlan: {
      sessionDurationMin: 0,
      overlapMin: 0,
      staggerDelayMin: 0
    },

    // 预热进度与轮询字段
    warmupJobId: '',
    warmupEnqueuedCount: 0,
    warmupStatus: '',
    warmupStatusLabel: '',
    warmupCompletedCount: 0,
    warmupResults: [],
    warmupProgressPercent: 0
  },

  /** @type {number | null} */
  _warmupPollTimer: null,

  onLoad: function () {
    if (!ensureRadarLabAccess({ redirectBack: true })) return;
    this.loadActiveMatches();
    this.updatePlanPreview();
  },

  onShow: function () {
    if (this.data.warmupJobId && !this._warmupPollTimer) {
      this._startWarmupPolling();
    }
  },

  onHide: function () {
    this._stopWarmupPolling();
  },

  onUnload: function () {
    this._stopWarmupPolling();
  },

  /**
   * 加载监测中的场次列表
   */
  loadActiveMatches: function () {
    const self = this;
    this.setData({ loading: true });
    
    // 只拉取监控中/准备监控的场次
    fetchMatchList({ status: 'monitoring,waiting_radar' })
      .then(function (list) {
        const matches = (list || []).map(function (item) {
          const status = item.matchStatus || 'monitoring';
          const disp = STATUS_DISPLAY[status] || { label: '监控中', cls: 'rl-badge-ok' };
          
          let startTimeText = '';
          if (item.startTime) {
            const date = new Date(item.startTime);
            startTimeText = (date.getMonth() + 1) + '/' + date.getDate() + ' ' + 
              String(date.getHours()).padStart(2, '0') + ':' + 
              String(date.getMinutes()).padStart(2, '0');
          }

          return Object.assign({}, item, {
            statusLabel: disp.label,
            statusBadgeClass: disp.cls,
            startTimeText: startTimeText
          });
        });
        self.setData({
          activeMatches: matches,
          loading: false
        });
      })
      .catch(function (err) {
        console.warn('[WarmupIndex] fetchMatchList fail', err);
        self.setData({ loading: false });
        wx.showToast({ title: err.message || '加载场次失败', icon: 'none' });
      });
  },

  /**
   * 选择场次并加载详情
   */
  onSelectMatch: function (e) {
    const matchId = e.currentTarget.dataset.id;
    if (!matchId) return;

    const match = this.data.activeMatches.find(function (item) {
      return String(item.id) === String(matchId);
    });

    const self = this;
    wx.showLoading({ title: '加载场次详情…', mask: true });
    
    fetchMatchDetail(matchId)
      .then(function (detail) {
        wx.hideLoading();
        const anchors = detail && detail.boundAnchors ? detail.boundAnchors : [];
        self.setData({
          selectedMatchId: String(matchId),
          selectedMatchTitle: match ? (match.teamA + ' vs ' + match.teamB) : '场次 #' + matchId,
          boundAnchors: anchors,
          warmupSourceMode: anchors.length > 0 ? 'select' : 'input',
          warmupInputText: '',
          warmupLiveUrl: anchors.length > 0 ? anchors[0].liveUrl : '',
          warmupAccountCount: 3,
          warmupCommentsText: '',
          warmupJobId: '',
          warmupEnqueuedCount: 0,
          warmupStatus: '',
          warmupStatusLabel: '',
          warmupCompletedCount: 0,
          warmupResults: [],
          warmupProgressPercent: 0
        });
        self.updatePlanPreview();
      })
      .catch(function (err) {
        wx.hideLoading();
        wx.showToast({ title: err.message || '加载详情失败', icon: 'none' });
      });
  },

  /**
   * 切换直播间选择
   */
  onAnchorSelectChange: function (e) {
    this.setData({
      warmupLiveUrl: e.detail.value
    });
  },

  /**
   * 切换目标直播间来源模式
   */
  onSwitchSourceMode: function (e) {
    const mode = e.currentTarget.dataset.mode;
    this.setData({
      warmupSourceMode: mode
    });
  },

  /**
   * 输入直播间口令或链接
   */
  onWarmupInputText: function (e) {
    this.setData({
      warmupInputText: e.detail.value
    });
  },

  /**
   * 账号数 Slider 调整
   */
  onWarmupAccountChange: function (e) {
    this.setData({
      warmupAccountCount: Number(e.detail.value)
    });
    this.updatePlanPreview();
  },

  onTotalDurationChange: function (e) {
    this.setData({
      totalShowDurationMin: Number(e.detail.value)
    });
    this.updatePlanPreview();
  },

  onOverlapRatioChange: function (e) {
    this.setData({
      overlapRatio: Number(e.detail.value)
    });
    this.updatePlanPreview();
  },

  onMaxConcurrentChange: function (e) {
    this.setData({
      maxConcurrentPerRoom: Number(e.detail.value)
    });
  },

  onToggleTiledPlan: function (e) {
    this.setData({
      useTiledPlan: e.detail.value
    });
    this.updatePlanPreview();
  },

  updatePlanPreview: function () {
    const accountCount = this.data.warmupAccountCount;
    const totalSec = this.data.totalShowDurationMin * 60;
    const ratio = this.data.overlapRatio;

    if (accountCount <= 0 || totalSec <= 0) return;

    let sessionSec = 0;
    let overlapSec = 0;
    let rawStep = 0;

    if (accountCount === 1) {
      sessionSec = totalSec;
      overlapSec = 0;
    } else {
      const safeRatio = Math.min(0.8, Math.max(0, ratio));
      const denominator = accountCount - (accountCount - 1) * safeRatio;
      sessionSec = Math.round(totalSec / denominator);
      rawStep = (totalSec - sessionSec) / (accountCount - 1);
      overlapSec = Math.max(0, sessionSec - Math.round(rawStep));
    }

    this.setData({
      'previewPlan.sessionDurationMin': Math.round(sessionSec / 60 * 10) / 10,
      'previewPlan.overlapMin': Math.round(overlapSec / 60 * 10) / 10,
      'previewPlan.staggerDelayMin': Math.round(rawStep / 60 * 10) / 10
    });
  },

  /**
   * 评论框输入
   */
  onWarmupCommentsInput: function (e) {
    this.setData({
      warmupCommentsText: e.detail.value
    });
  },

  /**
   * 提交预热任务
   */
  onSubmitWarmup: function () {
    const self = this;
    const matchId = this.data.selectedMatchId;
    if (!matchId) return;

    const isSelectMode = this.data.warmupSourceMode === 'select' && this.data.boundAnchors.length > 0;
    let liveUrl = '';
    let rawText = '';
    
    if (isSelectMode) {
      liveUrl = this.data.warmupLiveUrl;
      if (!liveUrl) {
        wx.showToast({ title: '请先选择目标直播间', icon: 'none' });
        return;
      }
    } else {
      const text = this.data.warmupInputText.trim();
      if (!text) {
        wx.showToast({ title: '请先输入直播间口令或链接', icon: 'none' });
        return;
      }
      if (text.indexOf('http') === 0) {
        liveUrl = text;
      } else {
        rawText = text;
      }
    }

    const comments = this.data.warmupCommentsText
      .split('\n')
      .map(function (line) {
        return line.trim();
      })
      .filter(function (line) {
        return line.length > 0;
      });

    const payload = {
      match_id: Number(matchId),
      account_count: this.data.warmupAccountCount,
      warmup_mode: 'presence_light'
    };

    if (this.data.useTiledPlan) {
      payload.total_show_duration_sec = this.data.totalShowDurationMin * 60;
      payload.overlap_ratio = this.data.overlapRatio;
      payload.max_concurrent_per_room = this.data.maxConcurrentPerRoom;
      payload.warmup_duration_sec = Math.round(this.data.previewPlan.sessionDurationMin * 60);
    } else {
      payload.warmup_duration_sec = this.data.warmupDurationMin * 60;
      payload.like_budget_min = 200;
      payload.like_budget_max = 300;
      payload.stagger_min_sec = 30;
      payload.stagger_max_sec = 90;
    }

    if (liveUrl) {
      payload.live_url = liveUrl;
    } else if (rawText) {
      payload.raw_text = rawText;
    }

    if (comments.length > 0) {
      payload.comment_pool = comments;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中…', mask: true });

    sendWarmup(payload)
      .then(function (res) {
        wx.hideLoading();
        if (res && res.job_id) {
          self.setData({
            warmupJobId: res.job_id,
            warmupEnqueuedCount: Number(res.enqueued_count || payload.account_count),
            warmupStatus: 'running',
            warmupStatusLabel: '运行中',
            warmupCompletedCount: 0,
            warmupProgressPercent: 0
          });
          wx.showToast({ title: '下发预热成功', icon: 'success' });
          self._startWarmupPolling();
        } else {
          wx.showToast({ title: '下发预热失败', icon: 'none' });
        }
      })
      .catch(function (err) {
        wx.hideLoading();
        const msg = err && err.message ? err.message : '下发预热失败';
        wx.showModal({
          title: '提示',
          content: msg,
          showCancel: false
        });
      })
      .finally(function () {
        self.setData({ submitting: false });
      });
  },

  /**
   * 开启预热轮询
   */
  _startWarmupPolling: function () {
    this._stopWarmupPolling();
    const self = this;
    this._warmupPollTimer = setInterval(function () {
      self._pollWarmupStatus();
    }, 3000);
    this._pollWarmupStatus();
  },

  /**
   * 停止预热轮询
   */
  _stopWarmupPolling: function () {
    if (this._warmupPollTimer) {
      clearInterval(this._warmupPollTimer);
      this._warmupPollTimer = null;
    }
  },

  /**
   * 轮询获取任务状态
   */
  _pollWarmupStatus: function () {
    const self = this;
    const jobId = this.data.warmupJobId;
    if (!jobId) {
      this._stopWarmupPolling();
      return;
    }

    fetchWarmupStatus(jobId)
      .then(function (res) {
        if (!res || res.job_id !== self.data.warmupJobId) return;

        const status = res.status || 'running';
        const accountCount = Number(res.account_count || self.data.warmupAccountCount || 3);
        const completedCount = Number(res.completed_count || 0);

        const WARMUP_STATUS_LABELS = {
          pending: '排队中',
          running: '运行中',
          completed: '已完成',
          partial_failed: '部分失败',
          failed: '已失败'
        };

        const RESULT_STATUS_LABELS = {
          success: '成功',
          failed: '失败',
          running: '进行中',
          pending: '等待中',
          room_serialized_skip: '串行跳过'
        };

        const rawResults = Array.isArray(res.results) ? res.results : [];
        const results = rawResults.map(function (item) {
          const itemStatus = item.status || 'pending';
          return Object.assign({}, item, {
            statusLabel: RESULT_STATUS_LABELS[itemStatus] || itemStatus
          });
        });

        const percent = Math.min(100, Math.floor((completedCount / accountCount) * 100));

        self.setData({
          warmupStatus: status,
          warmupStatusLabel: WARMUP_STATUS_LABELS[status] || status,
          warmupCompletedCount: completedCount,
          warmupResults: results,
          warmupProgressPercent: percent
        });

        if (status === 'completed' || status === 'partial_failed' || status === 'failed') {
          self._stopWarmupPolling();
          wx.showToast({
            title: '预热已结束',
            icon: 'none'
          });
        }
      })
      .catch(function (err) {
        console.warn('[WarmupIndex] poll warmup status fail', err);
      });
  },

  /**
   * 返回列表
   */
  onBackToList: function () {
    this._stopWarmupPolling();
    this.setData({
      selectedMatchId: '',
      selectedMatchTitle: '',
      boundAnchors: [],
      warmupSourceMode: 'select',
      warmupInputText: '',
      warmupLiveUrl: '',
      warmupJobId: '',
      warmupEnqueuedCount: 0,
      warmupStatus: '',
      warmupStatusLabel: '',
      warmupCompletedCount: 0,
      warmupResults: [],
      warmupProgressPercent: 0
    });
    this.loadActiveMatches();
  },

  /**
   * 重置，重新预热
   */
  onResetWarmup: function () {
    this.setData({
      warmupSourceMode: 'select',
      warmupInputText: '',
      warmupJobId: '',
      warmupEnqueuedCount: 0,
      warmupStatus: '',
      warmupStatusLabel: '',
      warmupCompletedCount: 0,
      warmupResults: [],
      warmupProgressPercent: 0
    });
  }
});
