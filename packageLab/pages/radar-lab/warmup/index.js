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
  cookie_invalid: 'Cookie失效',
  like_failed: '点赞失败',
  comment_failed: '评论失败',
  pool_too_small: '词库不足',
  room_serialized_skip: '串行跳过'
};

const WARMUP_RECORDS_KEY = 'RADAR_WARMUP_RECORDS_MAP';

/**
 * 读取本地持久化的预热场次记录字典
 * @returns {Record<string, { jobId?: string, status?: string, updatedAt?: number }>}
 */
function getWarmupRecordsMap() {
  try {
    const data = wx.getStorageSync(WARMUP_RECORDS_KEY);
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    return {};
  }
}

/**
 * 持久化记录某场次有预热任务
 * @param {string|number} matchId
 * @param {Record<string, unknown>} [info]
 */
function recordWarmupMatch(matchId, info) {
  if (!matchId) return;
  try {
    const map = getWarmupRecordsMap();
    map[String(matchId)] = Object.assign({}, map[String(matchId)] || {}, info || {}, {
      updatedAt: Date.now()
    });
    wx.setStorageSync(WARMUP_RECORDS_KEY, map);
  } catch (e) {
    console.warn('[Warmup] recordWarmupMatch fail', e);
  }
}

Page({
  data: {
    // 列表模式与筛选 Tab
    listStatusTab: 'all', // 'all' | 'monitoring' | 'ended'
    directMatchIdInput: '',
    activeMatches: [],
    loading: false,

    // 新增预热弹窗相关状态
    showNewWarmupModal: false,
    newWarmupMatchId: '',
    availableMatchOptions: [],
    newWarmupPickerIndex: 0,

    // 当前选中的场次
    selectedMatchId: '',
    selectedMatchTitle: '',
    boundAnchors: [],
    submitting: false,

    // 战报与配置界面切换
    showConfigForm: false,
    reportLoading: false,

    // 历史交单战报数据
    warmupJobId: '',
    warmupStatus: '',
    warmupStatusLabel: '',
    warmupAccountCount: 3,
    warmupCompletedCount: 0,
    warmupProgressPercent: 0,
    warmupEnqueuedCount: 0,
    warmupResults: [],
    warmupReport: null,
    hasInvalidAccounts: false,
    invalidAccounts: [],

    // 预热表单字段
    warmupSourceMode: 'select',
    warmupInputText: '',
    warmupLiveUrl: '',
    warmupDurationMin: 45,
    warmupCommentsText: '',

    // 调度参数与预览
    useTiledPlan: true,
    totalShowDurationMin: 60,
    overlapRatio: 0.45,
    maxConcurrentPerRoom: 2,
    previewPlan: {
      sessionDurationMin: 0,
      overlapMin: 0,
      staggerDelayMin: 0
    }
  },

  /** @type {number | null} */
  _warmupPollTimer: null,

  onLoad: function (options) {
    if (!ensureRadarLabAccess({ redirectBack: true })) return;
    this.updatePlanPreview();

    const targetMatchId = options && (options.match_id || options.id);
    if (targetMatchId) {
      this.onSelectMatchById(targetMatchId);
    } else {
      this.loadActiveMatches();
    }
  },

  onShow: function () {
    if (this.data.warmupJobId && (this.data.warmupStatus === 'running' || this.data.warmupStatus === 'pending') && !this._warmupPollTimer) {
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
   * 切换场次状态 Tab
   */
  onSwitchListTab: function (e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.listStatusTab) return;
    this.setData({ listStatusTab: tab });
    this.loadActiveMatches();
  },

  /**
   * 输入直接跳转的场次 ID
   */
  onDirectMatchIdInput: function (e) {
    this.setData({ directMatchIdInput: e.detail.value });
  },

  /**
   * 按直接输入的场次 ID 进入预热
   */
  onGoDirectMatch: function () {
    const id = String(this.data.directMatchIdInput || '').trim();
    if (!id) {
      wx.showToast({ title: '请输入场次 ID', icon: 'none' });
      return;
    }
    this.onSelectMatchById(id);
  },

  /**
   * 前往场次维护创建场次
   */
  onGoOam: function () {
    wx.navigateTo({ url: '/packageLab/pages/radar-lab/oam/oam' });
  },

  /**
   * 前往雷达挂载启动监控
   */
  onGoMount: function () {
    wx.navigateTo({ url: '/packageLab/pages/radar-lab/mount/index' });
  },

  /**
   * 加载场次列表
   */
  loadActiveMatches: function () {
    const self = this;
    this.setData({ loading: true });

    const query = {};
    const tab = this.data.listStatusTab;
    if (tab === 'monitoring') {
      query.status = 'monitoring,waiting_radar';
    } else if (tab === 'ended') {
      query.status = 'ended';
    }

    const localWarmupMap = getWarmupRecordsMap();

    fetchMatchList(query)
      .then(function (list) {
        const matches = (list || [])
          .filter(function (item) {
            const hasWarmupLocal = Boolean(localWarmupMap[String(item.id)]);
            const hasWarmupRemote = Boolean(item.warmupStatus || item.warmupJobId || item.hasWarmup);
            return hasWarmupLocal || hasWarmupRemote;
          })
          .map(function (item) {
            const status = item.matchStatus || 'monitoring';
            const disp = STATUS_DISPLAY[status] || { label: '监控中', cls: 'rl-badge-ok' };
            
            const localInfo = localWarmupMap[String(item.id)] || {};
            const warmupStatus = item.warmupStatus || localInfo.status || '';
            const warmupBadgeLabel = WARMUP_STATUS_LABELS[warmupStatus] || (warmupStatus ? warmupStatus : '预热中');

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
              startTimeText: startTimeText,
              warmupBadgeLabel: warmupBadgeLabel,
              hasWarmupBadge: Boolean(warmupStatus)
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
   * 列表点击选择场次
   */
  onSelectMatch: function (e) {
    const matchId = e.currentTarget.dataset.id;
    if (!matchId) return;
    this.onSelectMatchById(matchId, false);
  },

  /**
   * 按 ID 选中场次并加载详情与历史战报
   * @param {string|number} matchId
   * @param {boolean} [forceConfig] 是否强制打开预热配置表单
   */
  onSelectMatchById: function (matchId, forceConfig) {
    const match = this.data.activeMatches.find(function (item) {
      return String(item.id) === String(matchId);
    });

    const self = this;
    wx.showLoading({ title: '加载场次战报…', mask: true });
    
    fetchMatchDetail(matchId)
      .then(function (detail) {
        const anchors = detail && detail.boundAnchors ? detail.boundAnchors : [];
        const title = (detail && detail.teamA && detail.teamB)
          ? (detail.teamA + ' vs ' + detail.teamB)
          : (match ? (match.teamA + ' vs ' + match.teamB) : '场次 #' + matchId);

        self.setData({
          selectedMatchId: String(matchId),
          selectedMatchTitle: title,
          boundAnchors: anchors,
          warmupSourceMode: anchors.length > 0 ? 'select' : 'input',
          warmupInputText: '',
          warmupLiveUrl: anchors.length > 0 ? anchors[0].liveUrl : '',
          warmupAccountCount: 3,
          warmupCommentsText: '',
          showConfigForm: Boolean(forceConfig)
        });
        self.updatePlanPreview();
        return self._loadMatchWarmupReport(matchId);
      })
      .then(function () {
        if (forceConfig) {
          self.setData({ showConfigForm: true });
        }
        wx.hideLoading();
      })
      .catch(function (err) {
        wx.hideLoading();
        wx.showToast({ title: err.message || '加载详情失败', icon: 'none' });
      });
  },

  /**
   * 按 matchId 加载最新一条预热交单战报
   */
  _loadMatchWarmupReport: function (matchId, isPolling) {
    const self = this;
    if (!isPolling) {
      this.setData({ reportLoading: true });
    }

    return fetchWarmupStatus({ match_id: matchId })
      .then(function (res) {
        self.setData({ reportLoading: false });
        if (res && res.job_id) {
          const status = res.status || 'running';
          const accountCount = Number(res.account_count || self.data.warmupAccountCount || 3);
          const completedCount = Number(res.completed_count || 0);
          const rawResults = Array.isArray(res.results) ? res.results : [];
          
          let totalLikes = 0;
          let totalDurationSec = 0;
          let commentsSentCount = 0;

          const results = rawResults.map(function (item) {
            const itemStatus = item.status || 'pending';
            totalLikes += (item.likes_done || 0);
            totalDurationSec += (item.duration_sec || 0);
            if (item.comment_sent) {
              commentsSentCount += 1;
            }
            return Object.assign({}, item, {
              statusLabel: RESULT_STATUS_LABELS[itemStatus] || itemStatus
            });
          });

          const percent = Math.min(100, Math.floor((completedCount / accountCount) * 100));
          const invalidAccounts = res.invalid_accounts || (res.summary ? res.summary.invalid_accounts : []) || [];
          const hasInvalid = Array.isArray(invalidAccounts) && invalidAccounts.length > 0;

          const reportSummary = {
            totalLikes: res.summary ? res.summary.total_likes : totalLikes,
            totalDurationMin: Math.round(((res.summary ? res.summary.total_duration_sec : totalDurationSec) / 60) * 10) / 10,
            commentsSentCount: res.summary ? res.summary.comments_sent_count : commentsSentCount,
            completedCount: completedCount,
            accountCount: accountCount,
            createdAtText: res.created_at ? res.created_at.replace('T', ' ').slice(0, 19) : ''
          };

          self.setData({
            warmupJobId: res.job_id,
            warmupStatus: status,
            warmupStatusLabel: WARMUP_STATUS_LABELS[status] || status,
            warmupAccountCount: accountCount,
            warmupCompletedCount: completedCount,
            warmupProgressPercent: percent,
            warmupResults: results,
            warmupReport: Object.assign({}, res, { summaryDisplay: reportSummary }),
            hasInvalidAccounts: hasInvalid,
            invalidAccounts: invalidAccounts,
            showConfigForm: false
          });

          recordWarmupMatch(matchId, {
            jobId: res.job_id,
            status: status
          });

          if (status === 'running' || status === 'pending') {
            self._startWarmupPolling();
          } else {
            self._stopWarmupPolling();
          }
        } else {
          // 暂无预热记录，直接打开配置下发表单
          self.setData({
            warmupJobId: '',
            warmupReport: null,
            hasInvalidAccounts: false,
            invalidAccounts: [],
            showConfigForm: true
          });
        }
      })
      .catch(function (err) {
        self.setData({ reportLoading: false });
        console.warn('[WarmupIndex] loadMatchWarmupReport fail', err);
        // 查询报错时默认展示配置面板
        self.setData({ showConfigForm: true });
      });
  },

  /**
   * 手动刷新战报
   */
  onRefreshReport: function () {
    const matchId = this.data.selectedMatchId;
    if (!matchId) return;
    wx.showLoading({ title: '刷新中…', mask: true });
    this._loadMatchWarmupReport(matchId, false)
      .then(function () {
        wx.hideLoading();
        wx.showToast({ title: '战报已更新', icon: 'success' });
      })
      .catch(function () {
        wx.hideLoading();
      });
  },

  /**
   * 复制重新登录命令
   */
  onCopyLoginCommand: function (e) {
    const account = e.currentTarget.dataset.account || '';
    const cmd = 'python capture_login.py --account ' + account;
    wx.setClipboardData({
      data: cmd,
      success: function () {
        wx.showToast({ title: '已复制登录命令', icon: 'success' });
      }
    });
  },

  /**
   * 展开预热配置面板
   */
  onShowConfigForm: function () {
    this.setData({
      showConfigForm: true
    });
  },

  /**
   * 隐藏预热配置面板，返回战报
   */
  onHideConfigForm: function () {
    if (this.data.warmupJobId) {
      this.setData({
        showConfigForm: false
      });
    } else {
      this.onBackToList();
    }
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
      payload.like_budget_min = 2600;
      payload.like_budget_max = 3200;
      payload.stagger_min_sec = 60;
      payload.stagger_max_sec = 120;
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
          recordWarmupMatch(matchId, {
            jobId: res.job_id,
            status: 'running'
          });
          self.setData({
            warmupJobId: res.job_id,
            warmupEnqueuedCount: Number(res.enqueued_count || payload.account_count),
            warmupStatus: 'running',
            warmupStatusLabel: '运行中',
            warmupCompletedCount: 0,
            warmupProgressPercent: 0,
            showConfigForm: false
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
    const matchId = this.data.selectedMatchId;
    if (!matchId) {
      this._stopWarmupPolling();
      return;
    }

    this._loadMatchWarmupReport(matchId, true);
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
      showConfigForm: false,
      warmupSourceMode: 'select',
      warmupInputText: '',
      warmupLiveUrl: '',
      warmupJobId: '',
      warmupEnqueuedCount: 0,
      warmupStatus: '',
      warmupStatusLabel: '',
      warmupCompletedCount: 0,
      warmupResults: [],
      warmupProgressPercent: 0,
      warmupReport: null,
      hasInvalidAccounts: false,
      invalidAccounts: []
    });
    this.loadActiveMatches();
  },

  /**
   * 重置，重新预热
   */
  onResetWarmup: function () {
    this.setData({
      showConfigForm: true
    });
  },

  /**
   * 打开新增预热弹窗
   */
  onOpenNewWarmupModal: function () {
    const self = this;
    this.setData({
      showNewWarmupModal: true,
      newWarmupMatchId: '',
      newWarmupPickerIndex: 0
    });

    // 异步拉取全部可用场次供用户快速选择
    fetchMatchList({})
      .then(function (list) {
        const options = (list || []).map(function (m) {
          const statusDisp = STATUS_DISPLAY[m.matchStatus] || { label: m.matchStatus || '待采集' };
          const title = (m.teamA && m.teamB) ? (m.teamA + ' vs ' + m.teamB) : '未命名场次';
          const seqText = m.matchSeq ? ('#' + m.matchSeq + ' ') : '';
          return {
            id: String(m.id),
            label: seqText + title + ' (ID:' + m.id + ' · ' + statusDisp.label + ')'
          };
        });
        self.setData({
          availableMatchOptions: options
        });
      })
      .catch(function (err) {
        console.warn('[Warmup] fetch available matches failed', err);
      });
  },

  /**
   * 关闭新增预热弹窗
   */
  onCloseNewWarmupModal: function () {
    this.setData({
      showNewWarmupModal: false,
      newWarmupMatchId: ''
    });
  },

  /**
   * 新增预热输入场次 ID
   */
  onNewWarmupInputId: function (e) {
    this.setData({
      newWarmupMatchId: e.detail.value
    });
  },

  /**
   * 新增预热选择场次
   */
  onNewWarmupPickerChange: function (e) {
    const idx = Number(e.detail.value);
    const options = this.data.availableMatchOptions || [];
    const selected = options[idx];
    this.setData({
      newWarmupPickerIndex: idx,
      newWarmupMatchId: selected ? selected.id : ''
    });
  },

  /**
   * 确认新增预热，跳转进入预热配置
   */
  onConfirmNewWarmup: function () {
    let targetId = String(this.data.newWarmupMatchId || '').trim();
    if (!targetId && this.data.availableMatchOptions && this.data.availableMatchOptions.length > 0) {
      const selected = this.data.availableMatchOptions[this.data.newWarmupPickerIndex];
      if (selected) {
        targetId = selected.id;
      }
    }

    if (!targetId) {
      wx.showToast({ title: '请选择或输入场次 ID', icon: 'none' });
      return;
    }

    this.setData({ showNewWarmupModal: false });
    this.onSelectMatchById(targetId, true);
  }
});
