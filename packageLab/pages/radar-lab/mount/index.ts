/**
 * @fileoverview 雷达实验多模态挂载页面逻辑。
 */

declare const Page: any;
declare const wx: any;
declare const require: any;

const { ensureRadarLabAccess } = require('../../../utils/radar-access');
const { fetchMatchDetail, fetchMatchList } = require('../../../services/radar-api');
const { addMatchRadarTask } = require('../../../services/match-radar.service');

interface AddMatchTaskRequest {
  match_id: number;
  raw_text: string;
  capabilities?: {
    enable_ad_verify: boolean;
    enable_score_ocr: boolean;
    enable_audio_record: boolean;
    enable_video_record: boolean;
  };
  score_ocr?: {
    sport_type: 'basketball' | 'badminton' | 'generic';
    team_a?: string;
    team_b?: string;
  };
  recorder?: {
    segment_duration_sec?: number;
    video_max_height?: number;
    local_retention_hours?: number;
  };
}

interface PageData {
  showAddForm: boolean;
  activeMatches: any[];
  loading: boolean;
  matchId: string;
  rawText: string;
  enable_ad_verify: boolean;
  enable_score_ocr: boolean;
  enable_audio_record: boolean;
  enable_video_record: boolean;
  sportTypes: string[];
  sportTypeValues: ('generic' | 'basketball' | 'badminton')[];
  sportTypeIndex: number;
  segment_duration_sec: string | number;
  local_retention_hours: string | number;
  showAdvanced: boolean;
  matchTitle: string;
  submitting: boolean;
  teamA?: string;
  teamB?: string;
}

Page({
  data: {
    showAddForm: false,
    activeMatches: [],
    loading: false,
    matchId: '',
    rawText: '',
    enable_ad_verify: false,
    enable_score_ocr: false,
    enable_audio_record: false,
    enable_video_record: false,
    sportTypes: ['通用', '篮球', '羽毛球'],
    sportTypeValues: ['generic', 'basketball', 'badminton'],
    sportTypeIndex: 0,
    segment_duration_sec: 300,
    local_retention_hours: 24,
    showAdvanced: false,
    matchTitle: '',
    submitting: false
  },

  /**
   * 页面加载：白名单权限校验 & 恢复上次偏好。
   */
  onLoad: function () {
    if (!ensureRadarLabAccess({ redirectBack: true })) return;
    this.restorePreferences();
  },

  /**
   * 页面显示：每次显示页面都重新拉取监测中的列表。
   */
  onShow: function () {
    this._reloadActiveMatches();
  },

  /**
   * 恢复用户上次选择的雷达插件参数偏好。
   */
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
      console.warn('[RadarLabMount] restorePreferences fail', e);
    }
  },

  /**
   * 记忆用户偏好。
   */
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
      console.warn('[RadarLabMount] savePreferences fail', e);
    }
  },

  /**
   * 场次 ID 改变事件。
   */
  onMatchIdInput: function (e: any) {
    this.setData({
      matchId: e.detail.value
    });
  },

  /**
   * 场次 ID 失焦事件，自动加载详情，方便用户确认队名。
   */
  onMatchIdBlur: function (e: any) {
    const val = e.detail.value;
    const matchId = Number(val);
    if (!matchId || isNaN(matchId)) {
      this.setData({ matchTitle: '' });
      return;
    }
    const self = this;
    fetchMatchDetail(matchId)
      .then((detail: any) => {
        if (detail) {
          self.setData({
            matchTitle: `${detail.teamA} vs ${detail.teamB} (赛事: ${detail.tournamentName || '未知'})`,
            teamA: detail.teamA,
            teamB: detail.teamB
          });
        } else {
          self.setData({ matchTitle: '未查到该场次' });
        }
      })
      .catch((err: any) => {
        self.setData({ matchTitle: '拉取场次失败: ' + (err.message || '未知错误') });
      });
  },

  /**
   * 抖音分享口令 / 链接改变。
   */
  onRawTextInput: function (e: any) {
    this.setData({
      rawText: e.detail.value
    });
  },

  /**
   * 广告物料核销开关改变。
   */
  onAdVerifyChange: function (e: any) {
    this.setData({
      enable_ad_verify: e.detail.value
    });
  },

  /**
   * 比分 OCR 开关改变。
   */
  onScoreOcrChange: function (e: any) {
    this.setData({
      enable_score_ocr: e.detail.value
    });
  },

  /**
   * 音频录制开关改变。
   */
  onAudioRecordChange: function (e: any) {
    this.setData({
      enable_audio_record: e.detail.value
    });
  },

  /**
   * 视频录制开关改变。
   */
  onVideoRecordChange: function (e: any) {
    this.setData({
      enable_video_record: e.detail.value
    });
  },

  /**
   * 运动类型 Picker 选项改变。
   */
  onSportTypeChange: function (e: any) {
    this.setData({
      sportTypeIndex: Number(e.detail.value)
    });
  },

  /**
   * 分片时长输入改变。
   */
  onSegmentDurationInput: function (e: any) {
    this.setData({
      segment_duration_sec: e.detail.value
    });
  },

  /**
   * 本地保留时间输入改变。
   */
  onRetentionHoursInput: function (e: any) {
    this.setData({
      local_retention_hours: e.detail.value
    });
  },

  /**
   * 折叠/展开高级设置。
   */
  onToggleAdvanced: function () {
    this.setData({
      showAdvanced: !this.data.showAdvanced
    });
  },

  /**
   * 提交挂载任务。
   */
  onSubmit: function () {
    const matchId = Number(this.data.matchId);
    const rawText = (this.data.rawText || '').trim();

    if (!matchId || isNaN(matchId)) {
      wx.showToast({ title: '请输入有效的场次 ID', icon: 'none' });
      return;
    }
    if (!rawText) {
      wx.showToast({ title: '请输入抖音口令或链接', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '提交中...', mask: true });

    const params: AddMatchTaskRequest = {
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

    const self = this;
    addMatchRadarTask(params)
      .then((res: any) => {
        wx.hideLoading();
        self.savePreferences();
        
        const enqueued = res.task_enqueued !== false;
        if (enqueued) {
          wx.showToast({ title: '挂载成功', icon: 'success' });
          setTimeout(() => {
            wx.navigateTo({
              url: `/packageLab/pages/radar-lab/monitor/detail?match_id=${matchId}`
            });
          }, 1000);
        } else {
          const hint = res.duplicate_reason === 'already_monitoring'
            ? '该场次已在监测中'
            : res.duplicate_reason === 'queue_pending'
              ? '任务已在队列中'
              : '挂载任务未重复入队';
          wx.showModal({
            title: '挂载结果',
            content: hint,
            showCancel: true,
            confirmText: '去详情',
            success: (smRes: any) => {
              if (smRes.confirm) {
                wx.navigateTo({
                  url: `/packageLab/pages/radar-lab/monitor/detail?match_id=${matchId}`
                });
              }
            }
          });
        }
      })
      .catch((err: any) => {
        wx.hideLoading();
        wx.showModal({
          title: '提交失败',
          content: err.message || '请求服务端失败，请重试',
          showCancel: false
        });
      })
      .finally(() => {
        self.setData({ submitting: false });
      });
  },

  /**
   * 加载正在采集和排队等待中的雷达监控场次。
   */
  _reloadActiveMatches: function () {
    const self = this;
    this.setData({ loading: true });
    
    const { formatStartTimeDisplay } = require('../../../utils/radar-datetime.js');
    const STATUS_BADGE: Record<string, string> = {
      waiting_radar: 'rl-badge-info',
      monitoring: 'rl-badge-primary',
      ended: 'rl-badge-muted',
      interrupted: 'rl-badge-danger'
    };
    const STATUS_LABELS: Record<string, string> = {
      waiting_radar: '等待雷达',
      monitoring: '采集中',
      ended: '已结赛',
      interrupted: '已中断'
    };

    fetchMatchList({ status: 'monitoring,waiting_radar' })
      .then((matches: any[]) => {
        const activeMatches = matches.map((m: any) => {
          return {
            id: m.id,
            teamA: m.teamA,
            teamB: m.teamB,
            startTimeText: formatStartTimeDisplay(m.startTime),
            tournamentName: m.tournamentName || '—',
            statusLabel: STATUS_LABELS[m.matchStatus] || m.matchStatus || '未知',
            statusBadgeClass: STATUS_BADGE[m.matchStatus] || 'rl-badge-muted'
          };
        });
        self.setData({
          activeMatches: activeMatches,
          loading: false
        });
      })
      .catch((err: any) => {
        self.setData({ loading: false });
        wx.showToast({ title: err.message || '加载列表失败', icon: 'none' });
      });
  },

  /**
   * 切换到新增挂载表单页面。
   */
  onShowForm: function () {
    this.setData({
      showAddForm: true,
      matchId: '',
      rawText: '',
      matchTitle: '',
      teamA: '',
      teamB: ''
    });
  },

  /**
   * 返回到监测中的列表页面。
   */
  onHideForm: function () {
    this.setData({
      showAddForm: false
    });
    this._reloadActiveMatches();
  },

  /**
   * 跳转至单场监控详情。
   */
  onGoMonitorDetail: function (e: any) {
    const matchId = e.currentTarget.dataset.id;
    if (!matchId) return;
    wx.navigateTo({
      url: `/packageLab/pages/radar-lab/monitor/detail?match_id=${matchId}`
    });
  }
});
