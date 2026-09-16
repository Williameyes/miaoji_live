// packageLab/pages/radar-lab/score-sniffer/index.js
import {
  startScoreSniffer,
  stopScoreSniffer,
  fetchScoreSnifferStatus,
  confirmScoreSnifferCandidate,
  configureScoreSnifferRoi
} from '../../../services/radar-api';

Page({
  data: {
    rawText: '',
    sportOptions: ['篮球 (basketball)', '羽毛球 (badminton)', '通用/足球 (general)'],
    sportCodes: ['basketball', 'badminton', 'general'],
    sportIndex: 0,
    
    isSniffing: false,
    actionLoading: false,
    sessionId: '',
    
    session: null,
    currentScore: {
      team_a: '主队',
      team_b: '客队',
      score_a: 0,
      score_b: 0,
      period: '第1节',
      clock: '10:00'
    },
    candidates: [],
    statusLabel: '等待启动',
    refreshTick: Date.now(),

    // 首帧半自动画框标注数据
    roiYPercent: 88,
    roiAXPercent: 44,
    roiBXPercent: 57,
    boxA: { top: 88, left: 44, width: 8, height: 7 },
    boxB: { top: 88, left: 57, width: 8, height: 7 },
    submittingRoi: false
  },

  pollTimer: null,

  onUnload() {
    this.stopPolling();
  },

  onInputRawText(e) {
    this.setData({ rawText: e.detail.value });
  },

  onSportChange(e) {
    this.setData({ sportIndex: Number(e.detail.value) });
  },

  async onToggleSniffer() {
    if (this.data.isSniffing) {
      // 停止
      wx.showModal({
        title: '确认停止',
        content: '确定要停止当前比分嗅探任务吗？',
        success: async (res) => {
          if (res.confirm) {
            this.setData({ actionLoading: true });
            try {
              await stopScoreSniffer(this.data.sessionId);
              this.stopPolling();
              this.setData({
                isSniffing: false,
                statusLabel: '已停止'
              });
              wx.showToast({ title: '已停止嗅探', icon: 'success' });
            } catch (err) {
              wx.showToast({ title: err.message || '停止失败', icon: 'none' });
            } finally {
              this.setData({ actionLoading: false });
            }
          }
        }
      });
    } else {
      // 启动
      if (!this.data.rawText.trim()) {
        wx.showToast({ title: '请先粘贴直播间链接或口令', icon: 'none' });
        return;
      }
      this.setData({ actionLoading: true });
      try {
        const sport = this.data.sportCodes[this.data.sportIndex];
        const res = await startScoreSniffer({
          raw_text: this.data.rawText.trim(),
          sport_type: sport
        });
        
        const sessionId = res.session_id;
        this.setData({
          sessionId,
          isSniffing: true,
          statusLabel: '探针嗅探中...'
        });
        wx.showToast({ title: '已派发嗅探任务', icon: 'success' });
        this.startPolling();
      } catch (err) {
        wx.showToast({ title: err.message || '启动失败', icon: 'none' });
      } finally {
        this.setData({ actionLoading: false });
      }
    }
  },

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.loadStatus();
    }, 3000);
    this.loadStatus();
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  async loadStatus() {
    if (!this.data.sessionId) return;
    try {
      const res = await fetchScoreSnifferStatus(this.data.sessionId);
      const session = res.session;
      const candidates = res.candidates || [];
      
      let curScore = this.data.currentScore;
      if (session && session.current_score) {
        try {
          curScore = typeof session.current_score === 'string' ? JSON.parse(session.current_score) : session.current_score;
        } catch (e) {}
      }

      let label = '嗅探中';
      if (session) {
        if (session.status === 'awaiting_roi') label = '首帧已就绪，等待标注';
        else if (session.status === 'reconnecting') label = '断流重连中 (5分钟自愈)';
        else if (session.status === 'ended') label = '已完赛结单';
      }

      this.setData({
        session,
        currentScore: curScore,
        candidates,
        statusLabel: label,
        refreshTick: Date.now()
      });
    } catch (e) {
      // 静默处理轮询异常
    }
  },

  onSliderYChange(e) {
    const val = Number(e.detail.value);
    this.setData({
      roiYPercent: val,
      'boxA.top': val,
      'boxB.top': val
    });
  },

  onSliderAXChange(e) {
    const val = Number(e.detail.value);
    this.setData({
      roiAXPercent: val,
      'boxA.left': val
    });
  },

  onSliderBXChange(e) {
    const val = Number(e.detail.value);
    this.setData({
      roiBXPercent: val,
      'boxB.left': val
    });
  },

  async onSubmitRoiAnnotation() {
    if (!this.data.sessionId) return;
    this.setData({ submittingRoi: true });

    const y = this.data.roiYPercent;
    const ax = this.data.roiAXPercent;
    const bx = this.data.roiBXPercent;
    const w = this.data.boxA.width;
    const h = this.data.boxA.height;

    // 转换为 0~1000 归一化坐标 [ymin, xmin, ymax, xmax]
    const digit_bboxes = {
      score_a: [Math.round(y * 10), Math.round(ax * 10), Math.round((y + h) * 10), Math.round((ax + w) * 10)],
      score_b: [Math.round(y * 10), Math.round(bx * 10), Math.round((y + h) * 10), Math.round((bx + w) * 10)]
    };
    const scoreboard_bbox = [Math.round(y * 10), Math.round((ax - 15) * 10), Math.round((y + h) * 10), Math.round((bx + w + 15) * 10)];

    try {
      await configureScoreSnifferRoi(this.data.sessionId, {
        digit_bboxes,
        scoreboard_bbox
      });
      wx.showToast({ title: '标注成功，开始比分监控！', icon: 'success' });
      // 立即刷新状态
      setTimeout(() => this.loadStatus(), 1000);
    } catch (err) {
      wx.showToast({ title: err.message || '提交标注失败', icon: 'none' });
    } finally {
      this.setData({ submittingRoi: false });
    }
  },

  onOpenBindModal(e) {
    const candidateId = e.currentTarget.dataset.id;
    wx.showModal({
      title: '绑定官方赛程',
      editable: true,
      placeholderText: '请输入对应的官方场次 match_id',
      success: async (res) => {
        if (res.confirm && res.content) {
          const matchId = Number(res.content.trim());
          if (!matchId) {
            wx.showToast({ title: '请输入有效的数字 match_id', icon: 'none' });
            return;
          }
          try {
            await confirmScoreSnifferCandidate({
              candidate_id: candidateId,
              bind_match_id: matchId
            });
            wx.showToast({ title: '绑定成功！', icon: 'success' });
            this.loadStatus();
          } catch (err) {
            wx.showToast({ title: err.message || '绑定失败', icon: 'none' });
          }
        }
      }
    });
  }
});
