// packageLab/pages/radar-lab/score-sniffer/index.js
const {
  fetchScoreSnifferList,
  startScoreSniffer,
  stopScoreSniffer,
  fetchScoreSnifferStatus,
  configureScoreSnifferRoi,
  confirmScoreSnifferCandidate
} = require('../../../services/radar-api');

Page({
  data: {
    // 视图模式: 'list' (任务列表) | 'detail' (监控/标注详情) | 'create' (新增嗅探)
    viewMode: 'list',

    // 任务列表
    taskList: [],
    listLoading: false,

    // 当前详情会话
    sessionId: '',
    session: null,
    currentScore: {
      team_a: '主队',
      team_b: '客队',
      score_a: 0,
      score_b: 0,
      period: '待识别',
      clock: '00:00'
    },
    candidates: [],
    statusLabel: '空闲',
    isSniffing: false,

    // 新增嗅探表单
    rawText: '',
    sportIndex: 0,
    sportOptions: ['篮球 (全场/半场/节次)', '羽毛球 (局分/盘分)', '通用多节赛事'],
    sportCodes: ['basketball', 'badminton', 'generic'],
    actionLoading: false,

    // 单框标注参数 (整体记分牌框，包含队名与比分)
    roiYPercent: 85.0,     // 记分牌 Y 轴垂直位置 (60%~98%)
    roiXPercent: 15.0,     // 记分牌 X 轴水平位置 (5%~60%)
    roiWidthPercent: 70.0, // 记分牌宽度 (20%~90%)
    roiHeightPercent: 10.0,// 记分牌高度 (4%~30%)
    zoomLevel: 1.0,        // 缩放视角: 1.0 | 1.8 | 2.5
    submittingRoi: false,
    showSizeTuning: true,  // 默认展开尺寸调节，方便单框微调

    refreshTick: Date.now()
  },

  pollTimer: null,

  onLoad(options) {
    if (options && options.session_id) {
      this.selectSession(options.session_id);
    } else {
      this.loadTaskList();
    }
  },

  onShow() {
    if (this.data.viewMode === 'list') {
      this.loadTaskList();
    }
  },

  onUnload() {
    this.stopPolling();
  },

  onPullDownRefresh() {
    if (this.data.viewMode === 'list') {
      this.loadTaskList().then(() => wx.stopPullDownRefresh());
    } else {
      this.loadStatus().then(() => wx.stopPullDownRefresh());
    }
  },

  // =========================================================================
  // 1. 任务列表管理
  // =========================================================================
  async loadTaskList() {
    this.setData({ listLoading: true });
    try {
      const res = await fetchScoreSnifferList();
      const list = (res && res.list) || [];
      const formatted = list.map(item => {
        let scoreObj = null;
        if (item.current_score) {
          try {
            scoreObj = typeof item.current_score === 'string' ? JSON.parse(item.current_score) : item.current_score;
          } catch (e) {}
        }
        let badge = { text: '已结束', cls: 'rl-badge-muted' };
        if (item.status === 'awaiting_roi') {
          badge = { text: '待画框标注', cls: 'rl-badge-warn' };
        } else if (item.status === 'sniffing') {
          badge = { text: '实时嗅探中', cls: 'rl-badge-ok' };
        } else if (item.status === 'reconnecting') {
          badge = { text: '信号重连中', cls: 'rl-badge-danger' };
        }

        let scoreDisplay = '等待锁定中';
        if (scoreObj && (scoreObj.team_a || scoreObj.score_a !== undefined)) {
          scoreDisplay = ;
          if (scoreObj.period) {
            scoreDisplay += ;
          }
        } else if (item.status === 'awaiting_roi') {
          scoreDisplay = '首帧已就绪，待画框';
        }

        const createdAtStr = (item.created_at || '').replace('T', ' ').substring(0, 16);

        return {
          ...item,
          scoreDisplay,
          badge,
          createdAtStr,
          scoreObj
        };
      });

      this.setData({
        taskList: formatted,
        listLoading: false
      });
    } catch (err) {
      wx.showToast({ title: err.message || '获取列表失败', icon: 'none' });
      this.setData({ listLoading: false });
    }
  },

  onGoCreate() {
    this.setData({
      viewMode: 'create',
      rawText: ''
    });
  },

  onBackToList() {
    this.stopPolling();
    this.setData({
      viewMode: 'list',
      sessionId: '',
      session: null
    });
    this.loadTaskList();
  },

  selectSession(sessionId) {
    this.setData({
      sessionId,
      viewMode: 'detail'
    });
    this.startPolling();
  },

  onTapSessionItem(e) {
    const sessionId = e.currentTarget.dataset.id;
    if (sessionId) {
      this.selectSession(sessionId);
    }
  },

  async onStopSessionFromList(e) {
    const sessionId = e.currentTarget.dataset.id;
    if (!sessionId) return;
    wx.showModal({
      title: '确认停止',
      content: '确定要停止该比分嗅探任务吗？',
      success: async (res) => {
        if (res.confirm) {
          try {
            await stopScoreSniffer(sessionId);
            wx.showToast({ title: '已停止', icon: 'success' });
            this.loadTaskList();
          } catch (err) {
            wx.showToast({ title: err.message || '停止失败', icon: 'none' });
          }
        }
      }
    });
  },

  // =========================================================================
  // 2. 发起新嗅探
  // =========================================================================
  onInputRawText(e) {
    this.setData({ rawText: e.detail.value });
  },

  onSportChange(e) {
    this.setData({ sportIndex: Number(e.detail.value) });
  },

  async onSubmitCreateSniffer() {
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
      wx.showToast({ title: '已成功派单', icon: 'success' });
      // 直接切换到该会话的监控详情
      this.selectSession(sessionId);
    } catch (err) {
      wx.showToast({ title: err.message || '启动失败', icon: 'none' });
    } finally {
      this.setData({ actionLoading: false });
    }
  },

  // =========================================================================
  // 3. 轮询监控与详情状态
  // =========================================================================
  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      this.loadStatus();
    }, 2500);
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

      let label = '空闲';
      let sniffing = false;
      if (session) {
        if (session.status === 'awaiting_roi') {
          label = '等待画框标注';
          sniffing = true;
        } else if (session.status === 'sniffing') {
          label = '实时嗅探中';
          sniffing = true;
        } else if (session.status === 'reconnecting') {
          label = '信号断开重试';
          sniffing = true;
        } else if (session.status === 'ended') {
          label = '已结束';
          sniffing = false;
        }
      }

      this.setData({
        session,
        currentScore: curScore,
        candidates,
        statusLabel: label,
        isSniffing: sniffing,
        refreshTick: Date.now()
      });
    } catch (err) {
      console.error('loadStatus error', err);
    }
  },

  async onStopCurrentSession() {
    if (!this.data.sessionId) return;
    wx.showModal({
      title: '确认停止',
      content: '确定要停止当前比分嗅探任务吗？',
      success: async (res) => {
        if (res.confirm) {
          try {
            await stopScoreSniffer(this.data.sessionId);
            this.stopPolling();
            this.setData({
              isSniffing: false,
              statusLabel: '已停止'
            });
            wx.showToast({ title: '已停止嗅探', icon: 'success' });
            setTimeout(() => this.loadStatus(), 500);
          } catch (err) {
            wx.showToast({ title: err.message || '停止失败', icon: 'none' });
          }
        }
      }
    });
  },

  // =========================================================================
  // 4. 单框画框标注与微调 (整体记分牌框)
  // =========================================================================
  onSetZoom(e) {
    const zoom = Number(e.currentTarget.dataset.zoom) || 1.0;
    this.setData({ zoomLevel: zoom });
  },

  onSliderYChange(e) {
    const val = Number(Number(e.detail.value).toFixed(1));
    this.setData({ roiYPercent: val });
  },

  onStepY(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const next = Math.max(50, Math.min(98, Number((this.data.roiYPercent + delta).toFixed(1))));
    this.setData({ roiYPercent: next });
  },

  onSliderXChange(e) {
    const val = Number(Number(e.detail.value).toFixed(1));
    this.setData({ roiXPercent: val });
  },

  onStepX(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const next = Math.max(0, Math.min(60, Number((this.data.roiXPercent + delta).toFixed(1))));
    this.setData({ roiXPercent: next });
  },

  onSliderWidthChange(e) {
    const val = Number(Number(e.detail.value).toFixed(1));
    this.setData({ roiWidthPercent: val });
  },

  onStepWidth(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const next = Math.max(20, Math.min(98, Number((this.data.roiWidthPercent + delta).toFixed(1))));
    this.setData({ roiWidthPercent: next });
  },

  onSliderHeightChange(e) {
    const val = Number(Number(e.detail.value).toFixed(1));
    this.setData({ roiHeightPercent: val });
  },

  onStepHeight(e) {
    const delta = Number(e.currentTarget.dataset.delta);
    const next = Math.max(4, Math.min(30, Number((this.data.roiHeightPercent + delta).toFixed(1))));
    this.setData({ roiHeightPercent: next });
  },

  async onSubmitRoiAnnotation() {
    if (!this.data.sessionId) return;
    this.setData({ submittingRoi: true });

    const y = this.data.roiYPercent;
    const x = this.data.roiXPercent;
    const w = this.data.roiWidthPercent;
    const h = this.data.roiHeightPercent;

    // 转换为 0~1000 归一化坐标 [ymin, xmin, ymax, xmax]
    const scoreboard_bbox = [
      Math.round(y * 10),
      Math.round(x * 10),
      Math.round((y + h) * 10),
      Math.round((x + w) * 10)
    ];

    try {
      await configureScoreSnifferRoi(this.data.sessionId, {
        scoreboard_bbox,
        digit_bboxes: { scoreboard: scoreboard_bbox }
      });
      wx.showToast({ title: '标注成功，开启监控！', icon: 'success' });
      setTimeout(() => this.loadStatus(), 800);
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
