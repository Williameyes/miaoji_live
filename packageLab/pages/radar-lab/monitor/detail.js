/**
 * @fileoverview 单场监控详情：曲线、挂载口令、关闭监控（无场次选择）。
 */

const { ensureRadarLabAccess, isForbiddenError, handleRadarForbidden } = require('../../../utils/radar-access.js');
const { checkSyncLabWhitelist } = require('../../../../utils/sync-lab-whitelist.js');
const {
  addMatchTask,
  triggerMatchProbe,
  stopMatchMonitoring,
  fetchMatchStreamData,
  fetchMatchDetail,
  setMatchAds,
  settleMatch,
  fetchPromoPendingApplications,
  fetchMatchMonitorStatus,
  deleteMatch
} = require('../../../services/radar-api.js');
const {
  addMatchRadarTask,
  fetchMatchScoreSnapshots,
  fetchMatchMediaSegments
} = require('../../../services/match-radar.service.js');
const {
  normalizeTimeline,
  drawTimelineChart,
  formatCompactCount,
  parseUserCount
} = require('../../../utils/radar-chart.js');

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 20000;

/** Logo 原图上传上限（字节） */
const LOGO_MAX_UPLOAD_SIZE = 200 * 1024;

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

/** @type {Record<string, string>} */
const SETTLEMENT_LABELS = {
  pending: '待清算',
  settled: '已清算'
};

/** @type {Record<string, string>} */
const SETTLEMENT_BADGE = {
  pending: 'rl-badge-warn',
  settled: 'rl-badge-ok'
};

/**
 * @param {number} amount
 * @returns {string}
 */
function formatMoney(amount) {
  if (!amount || amount <= 0) return '未配置';
  const fixed = Number(amount).toFixed(2);
  return '¥' + fixed.replace(/\.00$/, '');
}

/**
 * 格式化截图捕获时间。
 * @param {number} unixSec
 * @returns {string}
 */
function formatSnapshotCapturedAt(unixSec) {
  if (!unixSec || !Number.isFinite(Number(unixSec))) return '—';
  const d = new Date(Number(unixSec) * 1000);
  const pad = function (n) {
    return String(n).padStart(2, '0');
  };
  return (
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes()) +
    ':' +
    pad(d.getSeconds())
  );
}

/**
 * 运动类型展示文案。
 * @param {string} sportType
 * @returns {string}
 */
function formatSportTypeLabel(sportType) {
  const map = {
    basketball: '篮球',
    badminton: '羽毛球',
    generic: '通用'
  };
  return map[sportType] || sportType || '通用';
}

/**
 * 格式化截图文件大小。
 * @param {number} bytes
 * @returns {string}
 */
function formatSnapshotSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return n + ' B';
  return (n / 1024).toFixed(1) + ' KB';
}

/**
 * 依据会话状态和旧状态共同解析要展示的文案与徽章类名。
 * @param {string} sessionStatus
 * @param {string} matchStatus
 * @returns {{label: string, badgeClass: string}}
 */
function resolveStatusDisplay(sessionStatus, matchStatus) {
  if (sessionStatus === 'stopping') {
    return {
      label: '正在停止…',
      badgeClass: 'rl-badge-warn'
    };
  }
  if (sessionStatus === 'ended') {
    return {
      label: '已结束',
      badgeClass: 'rl-badge-muted'
    };
  }
  if (sessionStatus === 'active') {
    return {
      label: '监控中',
      badgeClass: 'rl-badge-ok'
    };
  }
  if (sessionStatus === 'idle') {
    if (matchStatus === 'waiting_radar') {
      return {
        label: '等待雷达',
        badgeClass: 'rl-badge-warn'
      };
    }
    return {
      label: '准备就绪',
      badgeClass: 'rl-badge-muted'
    };
  }
  const mapLabel = {
    waiting_radar: '等待雷达',
    monitoring: '监控中',
    ended: '已结束',
    interrupted: '已中断'
  };
  const mapBadge = {
    waiting_radar: 'rl-badge-warn',
    monitoring: 'rl-badge-ok',
    ended: 'rl-badge-muted',
    interrupted: 'rl-badge-warn'
  };
  return {
    label: mapLabel[matchStatus] || matchStatus || '未知',
    badgeClass: mapBadge[matchStatus] || 'rl-badge-muted'
  };
}

Page({
  data: {
    matchId: '',
    matchTitle: '',
    tournamentName: '',
    matchStatus: '',
    monitorSessionStatus: 'idle',
    endReason: '',
    statusLabel: '',
    statusBadgeClass: 'rl-badge-muted',
    currentOnline: '—',
    peakOnline: '—',
    totalPoolNumber: 0,
    totalPoolText: '未配置',
    minViewersText: '未配置',
    adsCountText: '—',
    adsVersionText: '—',
    settlementStatus: 'pending',
    settlementLabel: '待清算',
    settlementBadgeClass: 'rl-badge-warn',
    financialSettledAt: '',
    canSettle: false,
    canOpenSettlement: false,
    settleDisabledTip: '等待全场监控结束',
    logoBrandName: '',
    uploadingLogo: false,
    timelineEmpty: true,
    polling: false,
    showBindModal: false,
    bindRawText: '',
    submitting: false,
    canStop: false,
    canProbe: false,
    promoEnabled: false,
    promoTitle: '',
    pendingCount: 0,
    focusAds: false,
    canvasReady: false,
    loading: true,
    
    // 实验功能白名单与配置
    isInWhitelist: false,
    showModalLab: false,
    enable_ad_verify: false,
    enable_score_ocr: false,
    enable_audio_record: false,
    enable_video_record: false,
    sportTypes: ['通用', '篮球', '羽毛球'],
    sportTypeValues: ['generic', 'basketball', 'badminton'],
    sportTypeIndex: 0,
    segment_duration_sec: 300,
    local_retention_hours: 24,
    scoreSnapshots: [],
    scoreSnapshotsEmpty: true,
    mediaSegments: null,
    mediaSummary: null,
    mediaCounts: null,
    mediaStatus: null,
    boundAnchors: [],
    canManage: true
  },

  /** @type {number | null} */
  _pollTimer: null,
  /** @type {number | null} */
  _monitorStatusTimer: null,
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
    const inWhitelist = checkSyncLabWhitelist();
    this.setData({
      matchId: matchId,
      focusAds: query && query.focus_ads === '1',
      isInWhitelist: inWhitelist
    });
    if (inWhitelist) {
      this.restorePreferences();
    }
    this._loadMatchMeta(matchId);
    this._refreshPendingCount(matchId);
  },

  /**
   * @returns {void}
   */
  onShow: function () {
    if (this.data.matchId) {
      this._loadMatchMeta(this.data.matchId, true);
      this._refreshPendingCount(this.data.matchId);
      this._fetchStreamOnce();
      this._fetchMonitorStatusOnce();
      this._startPolling();
      this._startMonitorStatusPolling();
    }
  },

  /**
   * @returns {void}
   */
  onHide: function () {
    this._stopPolling();
    this._stopMonitorStatusPolling();
  },

  /**
   * @returns {void}
   */
  onUnload: function () {
    this._stopPolling();
    this._stopMonitorStatusPolling();
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
   * 拉取场次元信息（队名、赛事名、商业配置）。
   * @param {string} matchId
   * @param {boolean} [silent]
   * @returns {void}
   */
  _loadMatchMeta: function (matchId, silent) {
    const self = this;
    fetchMatchDetail(matchId)
      .then(function (detail) {
        if (detail) {
          self._applyMatchDetail(detail);
          return;
        }
        self.setData({
          matchTitle: '场次 #' + matchId,
          loading: false
        });
      })
      .catch(function (err) {
        if (isForbiddenError(err)) {
          handleRadarForbidden();
          return;
        }
        if (!silent) {
          self.setData({
            matchTitle: '场次 #' + matchId,
            loading: false
          });
        }
      });
  },

  /**
   * @param {import('../../../utils/radar-model.js').RadarMatchView} detail
   * @returns {void}
   */
  _applyMatchDetail: function (detail) {
    const status = detail.matchStatus || this.data.matchStatus;
    const settlementStatus = detail.settlementStatus || 'pending';
    const flags = this._buildSettleFlags({
      matchStatus: status,
      settlementStatus: settlementStatus,
      totalPoolNumber: detail.totalPool || 0
    });
    const sessionStatus = detail.monitorSessionStatus || this.data.monitorSessionStatus || 'idle';
    const display = resolveStatusDisplay(sessionStatus, status);
    const canProbe =
      settlementStatus !== 'settled' &&
      (sessionStatus === 'active' || sessionStatus === 'idle') &&
      detail.canManage !== false;
    this.setData(Object.assign({
      matchTitle: detail.teamA + ' vs ' + detail.teamB,
      teamA: detail.teamA,
      teamB: detail.teamB,
      tournamentName: detail.tournamentName,
      matchStatus: status,
      monitorSessionStatus: sessionStatus,
      statusLabel: display.label,
      statusBadgeClass: display.badgeClass,
      totalPoolNumber: detail.totalPool || 0,
      totalPoolText: formatMoney(detail.totalPool || 0),
      minViewersText: detail.minViewers > 0 ? String(detail.minViewers) + ' 人' : '未配置',
      adsCountText: detail.adsCount > 0 ? String(detail.adsCount) + ' 个' : '—',
      adsVersionText: detail.adsVersion > 0 ? 'v' + detail.adsVersion : '—',
      settlementStatus: settlementStatus,
      settlementLabel: SETTLEMENT_LABELS[settlementStatus] || settlementStatus || '待清算',
      settlementBadgeClass: SETTLEMENT_BADGE[settlementStatus] || 'rl-badge-warn',
      financialSettledAt: detail.financialSettledAt || '',
      promoEnabled: Boolean(detail.promoEnabled),
      promoTitle: detail.promoTitle || '',
      boundAnchors: detail.boundAnchors || [],
      canProbe: canProbe,
      canManage: detail.canManage !== false,
      loading: false
    }, flags));
    if (this.data.isInWhitelist && this.data.matchId) {
      this._fetchScoreTimelineAndMedia(this.data.matchId);
    }
  },

  /**
   * 刷新待审批推广申请数量。
   * @param {string} matchId
   * @returns {void}
   */
  _refreshPendingCount: function (matchId) {
    const self = this;
    if (!matchId) return;
    fetchPromoPendingApplications(matchId)
      .then(function (body) {
        const list = Array.isArray(body.applications) ? body.applications : [];
        self.setData({ pendingCount: list.length });
      })
      .catch(function () {
        self.setData({ pendingCount: 0 });
      });
  },

  /**
   * @param {{matchStatus?: string, settlementStatus?: string, totalPoolNumber?: number}} next
   * @returns {{canSettle: boolean, canOpenSettlement: boolean, settleDisabledTip: string}}
   */
  _buildSettleFlags: function (next) {
    const matchStatus = next.matchStatus || this.data.matchStatus;
    const settlementStatus = next.settlementStatus || this.data.settlementStatus;
    const totalPoolNumber =
      typeof next.totalPoolNumber === 'number' ? next.totalPoolNumber : this.data.totalPoolNumber;
    if (settlementStatus === 'settled') {
      return {
        canSettle: false,
        canOpenSettlement: true,
        settleDisabledTip: '本场已清算'
      };
    }
    if (matchStatus !== 'ended') {
      return {
        canSettle: false,
        canOpenSettlement: false,
        settleDisabledTip: '等待全场监控结束'
      };
    }
    if (!totalPoolNumber || totalPoolNumber <= 0) {
      return {
        canSettle: false,
        canOpenSettlement: false,
        settleDisabledTip: '请先配置广告奖池金额'
      };
    }
    return {
      canSettle: true,
      canOpenSettlement: false,
      settleDisabledTip: ''
    };
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
   * @returns {void}
   */
  _startMonitorStatusPolling: function () {
    const self = this;
    this._stopMonitorStatusPolling();
    if (!this.data.matchId) return;
    this._monitorStatusTimer = setInterval(function () {
      self._fetchMonitorStatusOnce();
    }, 8000);
  },

  /**
   * @returns {void}
   */
  _stopMonitorStatusPolling: function () {
    if (this._monitorStatusTimer) {
      clearInterval(this._monitorStatusTimer);
      this._monitorStatusTimer = null;
    }
  },

  /**
   * 拉取并更新监控状态。
   * @returns {Promise<void>}
   */
  _fetchMonitorStatusOnce: function () {
    const self = this;
    const matchId = this.data.matchId;
    if (!matchId) return Promise.resolve();

    return fetchMatchMonitorStatus(matchId)
      .then(function (res) {
        if (res) {
          const sessionStatus = res.monitor_session_status || 'idle';
          const matchStatus = res.match_status || self.data.matchStatus;
          const display = resolveStatusDisplay(sessionStatus, matchStatus);

          const nextData = {
            monitorSessionStatus: sessionStatus,
            matchStatus: matchStatus,
            statusLabel: display.label,
            statusBadgeClass: display.badgeClass
          };

          if (res.end_reason) {
            nextData.endReason = res.end_reason;
            if (sessionStatus === 'ended') {
              const reasonMap = {
                force_stopped_by_user: '手动中止',
                stream_closed: '直播已关闭',
                duration_limit: '超时结束',
                worker_error: '服务异常',
                watchdog_timeout: '超时自动结束'
              };
              const reasonText = reasonMap[res.end_reason] || res.end_reason;
              nextData.statusLabel = '已结束 (' + reasonText + ')';
            }
          }

          const canStop = sessionStatus === 'active';
          const canProbe = (sessionStatus === 'active' || sessionStatus === 'idle') && self.data.canManage;

          nextData.canStop = canStop;
          nextData.canProbe = canProbe;

          if (sessionStatus === 'ended') {
            self._stopMonitorStatusPolling();
            self._loadMatchMeta(matchId, true);
            self._fetchStreamOnce();
          }

          self.setData(nextData);
        }
      })
      .catch(function (err) {
        console.warn('[RadarDetail] fetch monitor_status fail', err);
      });
  },

  /**
   * 下拉刷新曲线与状态。
   * @returns {void}
   */
  onPullDownRefresh: function () {
    const self = this;
    const matchId = this.data.matchId;
    const promises = [
      fetchMatchDetail(matchId).then(function (detail) {
        if (detail) {
          self.setData({
            matchTitle: detail.teamA + ' vs ' + detail.teamB,
            teamA: detail.teamA,
            teamB: detail.teamB,
            tournamentName: detail.tournamentName,
            boundAnchors: detail.boundAnchors || []
          });
        }
      }),
      this._fetchStreamOnce(),
      this._fetchMonitorStatusOnce()
    ];
    if (checkSyncLabWhitelist() && matchId) {
      this._fetchScoreTimelineAndMedia(matchId);
    }
    Promise.all(promises).finally(function () {
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
    if (checkSyncLabWhitelist()) {
      this._fetchScoreTimelineAndMedia(matchId);
    }
    return fetchMatchStreamData(matchId)
      .then(function (res) {
        const status =
          typeof res.match_status === 'string' ? res.match_status : '';
        const sessionStatus = self.data.monitorSessionStatus || 'idle';
        const display = resolveStatusDisplay(sessionStatus, status);
        const timeline = normalizeTimeline(
          /** @type {unknown[]} */ (res.timeline_data || [])
        );
        self._timelinePoints = timeline;
        const canStop = sessionStatus === 'active';
        const canProbe = (sessionStatus === 'active' || sessionStatus === 'idle') && self.data.canManage;
        const flags = self._buildSettleFlags({ matchStatus: status });
        self.setData(Object.assign({
          matchStatus: status,
          monitorSessionStatus: sessionStatus,
          statusLabel: display.label,
          statusBadgeClass: display.badgeClass,
          currentOnline: formatCompactCount(parseUserCount(res.current_online_count)),
          peakOnline: formatCompactCount(parseUserCount(res.peak_user_count)),
          timelineEmpty: !timeline.length,
          canStop: canStop,
          canProbe: canProbe
        }, flags));
        self._redrawChart();
      })
      .catch(function (err) {
        console.warn('[RadarDetail] stream_data fail', err);
      });
  },

  /**
   * 拉取记分牌截图与录制媒体数据（仅白名单用户）。
   * @param {string|number} matchId
   * @returns {void}
   */
  _fetchScoreTimelineAndMedia: function (matchId) {
    const self = this;
    if (!checkSyncLabWhitelist()) return;
    const mId = Number(matchId);
    if (!mId || isNaN(mId)) return;

    fetchMatchScoreSnapshots(mId)
      .then(function (res) {
        if (res && res.success) {
          const rawSnapshots = Array.isArray(res.snapshots) ? res.snapshots : [];
          const anchorNameMap = {};
          (self.data.boundAnchors || []).forEach(function (anchor) {
            if (anchor && anchor.sec_user_id) {
              anchorNameMap[anchor.sec_user_id] = anchor.anchor_name || anchor.sec_user_id;
            }
          });
          const snapshots = rawSnapshots.map(function (item) {
            const secUserId = item && item.sec_user_id ? item.sec_user_id : '';
            const rawUrl = item && item.snapshot_url ? item.snapshot_url : '';
            // Append cache buster using item.timestamp or current time if missing
            const ts = item && item.timestamp ? item.timestamp : Date.now();
            const snapshotUrl = rawUrl ? (rawUrl + (rawUrl.indexOf('?') >= 0 ? '&' : '?') + 't=' + ts) : '';
            return Object.assign({}, item, {
              anchorLabel: anchorNameMap[secUserId] || secUserId || '未知主播',
              capturedAtText: formatSnapshotCapturedAt(item && item.timestamp),
              sportTypeLabel: formatSportTypeLabel(item && item.sport_type),
              imageSizeText: formatSnapshotSize(item && item.image_bytes),
              snapshot_url: snapshotUrl
            });
          });
          self.setData({
            scoreSnapshots: snapshots,
            scoreSnapshotsEmpty: snapshots.length === 0
          });
        }
      })
      .catch(function (err) {
        console.warn('[RadarDetail] fetch score_snapshots fail', err);
      });

    fetchMatchMediaSegments(mId)
      .then(function (res) {
        if (res && res.success) {
          self.setData({
            mediaSegments: res.segments || [],
            mediaSummary: res.summary || null,
            mediaCounts: res.counts || null,
            mediaStatus: res.recorder_status || null,
            mediaStorageLocation: res.storage_location || 'radar_local'
          });
        }
      })
      .catch(function (err) {
        console.warn('[RadarDetail] fetch media_segments fail', err);
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
    const matchId = Number(this.data.matchId);
    const rawText = (this.data.bindRawText || '').trim();
    if (!rawText) {
      wx.showToast({ title: '请粘贴抖音口令', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });

    let requestPromise;
    if (this.data.isInWhitelist) {
      const params = {
        match_id: matchId,
        raw_text: rawText,
        capabilities: {
          enable_ad_verify: this.data.enable_ad_verify,
          enable_score_ocr: this.data.enable_score_ocr,
          enable_audio_record: this.data.enable_audio_record,
          enable_video_record: this.data.enable_video_record
        }
      };

      if (this.data.enable_score_ocr) {
        params.score_ocr = {
          sport_type: this.data.sportTypeValues[this.data.sportTypeIndex],
          team_a: this.data.teamA || '',
          team_b: this.data.teamB || ''
        };
      }

      if (this.data.enable_audio_record || this.data.enable_video_record) {
        params.recorder = {
          segment_duration_sec: Number(this.data.segment_duration_sec) || 300,
          local_retention_hours: Number(this.data.local_retention_hours) || 24
        };
      }

      requestPromise = addMatchRadarTask(params);
    } else {
      requestPromise = addMatchTask(matchId, rawText);
    }

    requestPromise
      .then(function (res) {
        if (self.data.isInWhitelist) {
          self.savePreferences();
        }
        const enqueued = res.task_enqueued !== false;
        const dup = typeof res.duplicate_reason === 'string' ? res.duplicate_reason : '';
        if (enqueued) {
          wx.showToast({ title: '监测已启动', icon: 'success' });
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

  restorePreferences: function () {
    try {
      const prefs = wx.getStorageSync('radar_lab_capabilities_prefs');
      if (prefs && typeof prefs === 'object') {
        this.setData({
          enable_ad_verify: !!prefs.enable_ad_verify,
          enable_score_ocr: !!prefs.enable_score_ocr,
          enable_audio_record: !!prefs.enable_audio_record,
          enable_video_record: !!prefs.enable_video_record,
          sportTypeIndex: typeof prefs.sportTypeIndex === 'number' ? prefs.sportTypeIndex : 0,
          segment_duration_sec: prefs.segment_duration_sec != null ? prefs.segment_duration_sec : 300,
          local_retention_hours: prefs.local_retention_hours != null ? prefs.local_retention_hours : 24
        });
      }
    } catch (e) {
      console.warn('[RadarDetail] restorePreferences fail', e);
    }
  },

  savePreferences: function () {
    const prefs = {
      enable_ad_verify: this.data.enable_ad_verify,
      enable_score_ocr: this.data.enable_score_ocr,
      enable_audio_record: this.data.enable_audio_record,
      enable_video_record: this.data.enable_video_record,
      sportTypeIndex: this.data.sportTypeIndex,
      segment_duration_sec: Number(this.data.segment_duration_sec) || 300,
      local_retention_hours: Number(this.data.local_retention_hours) || 24
    };
    try {
      wx.setStorageSync('radar_lab_capabilities_prefs', prefs);
    } catch (e) {
      console.warn('[RadarDetail] savePreferences fail', e);
    }
  },

  onToggleModalLab: function () {
    this.setData({ showModalLab: !this.data.showModalLab });
  },

  /**
   * 预览记分牌截图大图。
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onPreviewScoreSnapshot: function (e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.showLoading({ title: '加载中…', mask: true });
    wx.downloadFile({
      url: url,
      success: function (res) {
        wx.hideLoading();
        if (res.statusCode >= 200 && res.statusCode < 300 && res.tempFilePath) {
          wx.previewImage({
            current: res.tempFilePath,
            urls: [res.tempFilePath]
          });
        } else {
          wx.showToast({ title: '下载图片失败', icon: 'none' });
        }
      },
      fail: function (err) {
        wx.hideLoading();
        wx.showToast({ title: '加载图片失败', icon: 'none' });
        console.error('[Preview] downloadFile fail', err);
      }
    });
  },

  /**
   * 手动刷新记分牌截图。
   * @returns {void}
   */
  onRefreshScoreSnapshots: function () {
    const self = this;
    const matchId = this.data.matchId;
    if (!matchId) return;

    wx.showLoading({ title: '刷新中…', mask: true });
    const mId = Number(matchId);
    fetchMatchScoreSnapshots(mId)
      .then(function (res) {
        wx.hideLoading();
        if (res && res.success) {
          const rawSnapshots = Array.isArray(res.snapshots) ? res.snapshots : [];
          const anchorNameMap = {};
          (self.data.boundAnchors || []).forEach(function (anchor) {
            if (anchor && anchor.sec_user_id) {
              anchorNameMap[anchor.sec_user_id] = anchor.anchor_name || anchor.sec_user_id;
            }
          });
          const snapshots = rawSnapshots.map(function (item) {
            const secUserId = item && item.sec_user_id ? item.sec_user_id : '';
            const rawUrl = item && item.snapshot_url ? item.snapshot_url : '';
            const ts = item && item.timestamp ? item.timestamp : Date.now();
            const snapshotUrl = rawUrl ? (rawUrl + (rawUrl.indexOf('?') >= 0 ? '&' : '?') + 't=' + ts) : '';
            return Object.assign({}, item, {
              anchorLabel: anchorNameMap[secUserId] || secUserId || '未知主播',
              capturedAtText: formatSnapshotCapturedAt(item && item.timestamp),
              sportTypeLabel: formatSportTypeLabel(item && item.sport_type),
              imageSizeText: formatSnapshotSize(item && item.image_bytes),
              snapshot_url: snapshotUrl
            });
          });
          self.setData({
            scoreSnapshots: snapshots,
            scoreSnapshotsEmpty: snapshots.length === 0
          });
          wx.showToast({ title: '已更新至最新', icon: 'success' });
        } else {
          wx.showToast({ title: '刷新失败', icon: 'none' });
        }
      })
      .catch(function (err) {
        wx.hideLoading();
        wx.showToast({ title: err.message || '刷新失败', icon: 'none' });
        console.warn('[RadarDetail] manual fetch score_snapshots fail', err);
      });
  },

  onAdVerifyChange: function (e) {
    this.setData({ enable_ad_verify: e.detail.value });
  },

  onScoreOcrChange: function (e) {
    this.setData({ enable_score_ocr: e.detail.value });
  },

  onAudioRecordChange: function (e) {
    this.setData({ enable_audio_record: e.detail.value });
  },

  onVideoRecordChange: function (e) {
    this.setData({ enable_video_record: e.detail.value });
  },

  onSportTypeChange: function (e) {
    this.setData({ sportTypeIndex: Number(e.detail.value) });
  },

  onSegmentDurationInput: function (e) {
    this.setData({ segment_duration_sec: e.detail.value });
  },

  onRetentionHoursInput: function (e) {
    this.setData({ local_retention_hours: e.detail.value });
  },

  /**
   * @param {WechatMiniprogram.Input} e
   * @returns {void}
   */
  onLogoBrandInput: function (e) {
    this.setData({ logoBrandName: e.detail.value });
  },

  /**
   * @returns {void}
   */
  onChooseLogo: function () {
    if (this.data.settlementStatus === 'settled') {
      wx.showToast({ title: '本场已清算，不能修改广告物料', icon: 'none' });
      return;
    }
    const self = this;
    const handleFile = function (file) {
      if (!file || !file.tempFilePath) return;
      if (file.size && file.size > LOGO_MAX_UPLOAD_SIZE) {
        wx.showToast({ title: 'Logo 请控制在 200KB 以内', icon: 'none' });
        return;
      }
      self._uploadLogo(file.tempFilePath);
    };
    if (wx.chooseMedia) {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
        success: function (res) {
          handleFile(res.tempFiles && res.tempFiles[0]);
        }
      });
      return;
    }
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: function (res) {
        handleFile({
          tempFilePath: res.tempFilePaths && res.tempFilePaths[0],
          size: res.tempFiles && res.tempFiles[0] ? res.tempFiles[0].size : 0
        });
      }
    });
  },

  /**
   * @param {string} filePath
   * @returns {void}
   */
  _uploadLogo: function (filePath) {
    const self = this;
    this.setData({ uploadingLogo: true });
    wx.showLoading({ title: '上传中…', mask: true });
    setMatchAds({
      matchId: this.data.matchId,
      brandName: String(this.data.logoBrandName || '').trim(),
      filePath: filePath
    })
      .then(function (res) {
        wx.hideLoading();
        const msg = typeof res.message === 'string' && res.message ? res.message : 'Logo 已上传';
        wx.showToast({ title: msg.length > 12 ? 'Logo 已上传' : msg, icon: 'success' });
        self.setData({ logoBrandName: '' });
        self._loadMatchMeta(self.data.matchId, true);
      })
      .catch(function (err) {
        wx.hideLoading();
        wx.showToast({ title: err.message || '上传失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ uploadingLogo: false });
      });
  },

  /**
   * @returns {void}
   */
  onSettleMatch: function () {
    const self = this;
    if (!this.data.canSettle) {
      wx.showToast({ title: this.data.settleDisabledTip || '暂不能清算', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '一键财务清算',
      content: '将按推广分占比生成本场结算单，清算后广告物料不可再修改。确定继续？',
      confirmText: '清算',
      success: function (res) {
        if (!res.confirm) return;
        self._doSettleMatch();
      }
    });
  },

  /**
   * @returns {void}
   */
  _doSettleMatch: function () {
    const self = this;
    this.setData({ submitting: true });
    wx.showLoading({ title: '清算中…', mask: true });
    settleMatch(this.data.matchId)
      .then(function () {
        wx.hideLoading();
        wx.showToast({ title: '清算完成', icon: 'success' });
        self._loadMatchMeta(self.data.matchId, true);
        setTimeout(function () {
          self.onOpenSettlement();
        }, 450);
      })
      .catch(function (err) {
        wx.hideLoading();
        wx.showToast({ title: err.message || '清算失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ submitting: false });
      });
  },

  /**
   * @returns {void}
   */
  onOpenSettlement: function () {
    if (!this.data.matchId) return;
    wx.navigateTo({
      url:
        '/packageLab/pages/radar-lab/settlement/detail?match_id=' +
        encodeURIComponent(this.data.matchId)
    });
  },

  /**
   * 手动触发一轮探测（对已绑定主播重新入队，可多次调用）。
   * @returns {void}
   */
  onTriggerProbe: function () {
    const self = this;
    const matchId = this.data.matchId;
    if (!matchId || !this.data.canProbe) {
      wx.showToast({ title: '当前状态不可探测', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '再次探测',
      content: '将触发雷达对已绑定主播采集一轮在线数据，不会开启持续轮询。确定继续？',
      confirmText: '探测',
      success: function (res) {
        if (!res.confirm) return;
        self._doTriggerProbe(matchId);
      }
    });
  },

  /**
   * @param {string} matchId
   * @returns {void}
   */
  _doTriggerProbe: function (matchId) {
    const self = this;
    this.setData({ submitting: true });
    triggerMatchProbe(matchId)
      .then(function (res) {
        const enqueued = res.task_enqueued !== false;
        const count =
          typeof res.tasks_enqueued === 'number'
            ? res.tasks_enqueued
            : typeof res.anchors_probed === 'number'
              ? res.anchors_probed
              : 0;
        if (enqueued || count > 0) {
          wx.showToast({
            title: count > 0 ? '已触发 ' + count + ' 路探测' : '探测已触发',
            icon: 'success'
          });
        } else {
          wx.showToast({ title: '暂无待探测主播', icon: 'none' });
        }
        self._fetchStreamOnce();
        self._loadMatchMeta(matchId, true);
      })
      .catch(function (err) {
        const msg = err && err.message ? err.message : '探测失败';
        wx.showToast({ title: msg, icon: 'none' });
      })
      .finally(function () {
        self.setData({ submitting: false });
      });
  },

  /**
   * 跳转推广发布页。
   * @returns {void}
   */
  onOpenPromoPublish: function () {
    const matchId = this.data.matchId;
    if (!matchId) return;
    wx.navigateTo({
      url:
        '/packageLab/pages/radar-lab/oam/promo-publish/promo-publish?match_id=' +
        encodeURIComponent(matchId)
    });
  },

  /**
   * 复制已绑定主播直播间链接。
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onCopyAnchorLink: function (e) {
    const link = e.currentTarget.dataset.link;
    if (!link) return;
    wx.setClipboardData({
      data: link,
      success: function () {
        wx.showToast({ title: '已复制链接', icon: 'success' });
      }
    });
  },

  /**
   * 跳转推广审批页。
   * @returns {void}
   */
  onOpenPromoReview: function () {
    const matchId = this.data.matchId;
    if (!matchId) return;
    wx.navigateTo({
      url:
        '/packagePromo/pages/promo-review/promo-review?target_match_id=' +
        encodeURIComponent(matchId)
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
      .then(function (res) {
        const isStopping = res && res.monitor_session_status === 'stopping';
        const alreadyEnded = res && res.already_ended;
        if (isStopping) {
          wx.showToast({ title: '正在停止…', icon: 'loading' });
          self.setData({
            monitorSessionStatus: 'stopping',
            statusLabel: '正在停止…',
            statusBadgeClass: 'rl-badge-warn',
            canStop: false,
            canProbe: false
          });
        } else if (alreadyEnded) {
          wx.showToast({ title: '监控已结束', icon: 'success' });
          self.setData({
            monitorSessionStatus: 'ended',
            statusLabel: '已结束',
            statusBadgeClass: 'rl-badge-muted',
            canStop: false,
            canProbe: false
          });
        } else {
          wx.showToast({ title: '已发送停止指令', icon: 'success' });
        }
        self._fetchMonitorStatusOnce();
        self._loadMatchMeta(matchId, true);
        self._fetchStreamOnce();
      })
      .catch(function (err) {
        if (err.errorCode === 'MATCH_ALREADY_ENDED') {
          wx.showToast({ title: '监控已结束', icon: 'none' });
          self._fetchMonitorStatusOnce();
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
  onDeleteMatch: function () {
    const matchId = this.data.matchId;
    if (!matchId) return;

    if (this.data.matchStatus === 'monitoring') {
      wx.showModal({
        title: '提示',
        content: '该场次监控中，须先结束监控',
        showCancel: false
      });
      return;
    }

    const self = this;
    wx.showModal({
      title: '确认删除',
      content: '确定删除场次「' + (this.data.teamA || '') + ' VS ' + (this.data.teamB || '') + '」？删除后无法恢复显示。',
      confirmText: '删除',
      confirmColor: '#ef4444',
      success: function (res) {
        if (res.confirm) {
          self.setData({ submitting: true });
          wx.showLoading({ title: '正在删除…', mask: true });
          deleteMatch(matchId)
            .then(function () {
              wx.hideLoading();
              wx.showToast({ title: '删除成功', icon: 'success' });
              setTimeout(function () {
                wx.navigateBack();
              }, 1000);
            })
            .catch(function (err) {
              wx.hideLoading();
              self.setData({ submitting: false });
              wx.showToast({ title: err.message || '删除失败', icon: 'none' });
            });
        }
      }
    });
  },

  /**
   * @returns {void}
   */
  stopModalBubble: function () {}
});
