const app = getApp();

Page({
  data: {
    matchConfig: {
      matchName: '',
      matchNameColor: '#E64340',
      teamA: { name: '队 A', bgColor: '#E64340', textColor: '#FFFFFF', score: 0 },
      teamB: { name: '队 B', bgColor: '#10AEFF', textColor: '#FFFFFF', score: 0 },
      period: 0
    },
    periods: app.globalData.periods,
    statusBarHeight: 0,
    cameraContext: null,
    isRecording: false,
    longPressTimer: null,
    periodFlash: false,

    /** 抽屉模式: 0=隐藏 1=抽屉打开 */
    drawerMode: 0,
    /** 左侧比赛管理列表数据 */
    matchList: [],
    /** 颜色设置浮层：是否可见 */
    showColorModal: false,
    /** 颜色设置浮层：当前操作的比赛数据 */
    colorModalMatch: null,
    /** 颜色设置浮层：当前选中的队（teamA / teamB），共用色盘指向 */
    colorModalTeam: 'teamA',
    /** 快选颜色球色板（24 色：8 列 × 3 行，仅一个纯黑） */
    colorBalls: [
      '#DC2626', '#EA580C', '#F59E0B', '#EAB308', '#84CC16', '#16A34A', '#059669', '#0D9488',
      '#14B8A6', '#06B6D4', '#0EA5E9', '#3B82F6', '#6366F1', '#7C3AED', '#A855F7', '#C026D3',
      '#DB2777', '#E11D48', '#F43F5E', '#FFFFFF', '#E2E8F0', '#94A3B8', '#475569', '#000000'
    ],
    drawerHighlights: [],
    defaultCover: 'data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"160\" height=\"90\" viewBox=\"0 0 160 90\"><rect width=\"160\" height=\"90\" rx=\"12\" ry=\"12\" fill=\"%2322262f\"/><path d=\"M66 58V32l28 13-28 13z\" fill=\"%23ffffff\" fill-opacity=\"0.75\"/></svg>',

    showReplayMask: false,
    replayMaskText: 'REPLAY',
    /** 转场样式：replay 进入回放 / live 回到直播 */
    replayMaskKind: 'replay',
    /** 回放倍速（与直播区分观感） */
    replayPlaybackRate: 0.75,
    isReplaying: false,
    replaySrc: '',
    replayQueue: [],
    replayIndex: 0,

    // 相机焦距相关
    zoom: 1,
    maxZoom: 10,
    distance: 0,
    lastZoom: 1,
    teamGroupWidthPx: 0,
    showGuide: false
  },

  // 辅助变量
  lastSetZoomTime: 0,
  suppressScoreTap: false,
  /** 滚动录制单段时长（毫秒）。8s 与单次高光时长一致，显著减少 start/stop 次数与资源占用。 */
  segmentDurationMs: 8000,
  segmentStopTimer: null,
  rollingWatchdogTimer: null,
  segmentCounter: 0,
  pendingHighlight: null,
  segmentBuffer: [],
  rollingActive: false,
  rollingSessionId: 0,
  lastHighlightRequestAt: 0,
  lastHighlightSignature: '',
  lastSegmentAt: 0,
  lastRecordStartAt: 0,
  startRecordFailStreak: 0,
  /** rolling 缓冲最多保留的段数（每段 {@link segmentDurationMs}），仅用于最近一段高光取样与少量冗余。 */
  rollingBufferMax: 3,
  /** 进入回放前 REPLAY 全屏转场总时长（需与 WXSS 中 replayBadgeMotion 时长一致） */
  replayIntroDurationMs: 1000,
  /** 回到直播转场总时长（需与 WXSS 中 liveBadgeMotion 时长一致） */
  replayOutroDurationMs: 720,

  onLoad: function() {
    const cameraContext = wx.createCameraContext();

    // 优先从 MIAOXIE_MATCHES 中按 currentMatchId 定位当前场次数据
    const currentMatchId =
      wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    let sourceConfig = app.globalData.matchConfig || wx.getStorageSync('matchConfig');
    if (currentMatchId) {
      const matches = wx.getStorageSync('MIAOXIE_MATCHES');
      if (Array.isArray(matches)) {
        const found = matches.find((m) => m.id === currentMatchId);
        if (found) sourceConfig = found;
      }
    }

    const latestConfig = this.normalizeMatchConfig(sourceConfig);
    this.setData({
      matchConfig: latestConfig,
      cameraContext: cameraContext
    });
    app.globalData.matchConfig = latestConfig;
    wx.setStorageSync('matchConfig', latestConfig);
    
    // 1. 隐藏小程序左上角的返回/主页按钮（沉浸式第一步）
    if (wx.hideHomeButton) {
      wx.hideHomeButton();
    }
    
    // 2. 动态设置窗口背景色为纯黑
    wx.setBackgroundColor({
      backgroundColor: '#000000',
      backgroundColorTop: '#000000',
      backgroundColorBottom: '#000000',
    });
    
    // 3. 强制状态栏/导航栏为黑色
    wx.setNavigationBarColor({
      frontColor: '#ffffff',
      backgroundColor: '#000000',
      animation: { duration: 0 }
    });
    
    // 保持屏幕常亮
    wx.setKeepScreenOn({ 
      keepScreenOn: true,
      fail: () => {
        setTimeout(() => wx.setKeepScreenOn({ keepScreenOn: true }), 1000);
      }
    });
  },

  onReady: function() {
    if (wx.nextTick) {
      wx.nextTick(() => this.updateTeamGroupWidth());
    } else {
      setTimeout(() => this.updateTeamGroupWidth(), 0);
    }
  },

  // 相机初始化完成回调
  onCameraInit: function(e) {
    const maxZoom = e.detail.maxZoom || 5;
    this.setData({ maxZoom: maxZoom });
    this.updateZoom(1.0);
  },

  updateZoom: function(zoomVal) {
    const actualZoom = Math.max(1, Math.min(this.data.maxZoom, zoomVal));
    
    // 只在数值发生实质变化时更新，减少 setData 频率
    if (Math.abs(this.data.zoom - actualZoom) < 0.01) return;

    this.setData({
      zoom: actualZoom
    });
    if (this.data.cameraContext && this.data.cameraContext.setZoom) {
      this.data.cameraContext.setZoom({
        zoom: actualZoom
      });
    }
  },



  // 辅助变量
  lastZoomVal: 1.0,
  isPinching: false,
  /** 多指触控状态锁：双指缩放期间为 true，用于屏蔽空白区域长按事件，避免两者冲突 */
  isMultiTouch: false,
  touchPointsMap: {},
  pinchStartDistance: 0,
  pinchStartZoom: 1,

  // 双指缩放逻辑
  onTouchStart: function(e) {
    if (e.touches && e.touches.length >= 2) {
      this.isPinching = true;
      this.isMultiTouch = true;
      this.pinchStartDistance = this.getDistance(e.touches[0], e.touches[1]);
      this.pinchStartZoom = this.data.zoom;
    }
  },

  onTouchMove: function(e) {
    if (e.touches && e.touches.length >= 2) {
      this.isMultiTouch = true;
    }
    if (!this.isPinching || !e.touches || e.touches.length < 2 || this.pinchStartDistance <= 0) {
      return;
    }
    const currentDistance = this.getDistance(e.touches[0], e.touches[1]);
    if (currentDistance <= 0) return;
    
    const ratio = currentDistance / this.pinchStartDistance;
    const newZoomVal = this.pinchStartZoom * ratio;
    this.updateZoom(newZoomVal);
  },

  onTouchEnd: function(e) {
    this.onScoreTouchEnd(); // 防止干扰计分长按
    if (!e.touches || e.touches.length === 0) {
      this.isPinching = false;
      this.pinchStartDistance = 0;
      // 延迟重置多指锁，避免 touchend 与 longpress 事件时序竞争
      setTimeout(() => {
        this.isMultiTouch = false;
      }, 200);
    } else if (!e.touches || e.touches.length < 2) {
      this.isPinching = false;
      this.pinchStartDistance = 0;
    } else if (this.isPinching) {
      // 仍然有两个或以上手指在屏幕上，重置缩放基准
      this.pinchStartDistance = this.getDistance(e.touches[0], e.touches[1]);
      this.pinchStartZoom = this.data.zoom;
    }
  },

  getDistance: function(p1, p2) {
    const x = p2.pageX - p1.pageX;
    const y = p2.pageY - p1.pageY;
    return Math.sqrt(x * x + y * y);
  },

  hexToRgba: function(hex, opacity) {
    const color = (hex || '#000000').replace('#', '');
    const fullHex = color.length === 3
      ? color.split('').map((c) => c + c).join('')
      : color;
    const r = parseInt(fullHex.substr(0, 2), 16);
    const g = parseInt(fullHex.substr(2, 2), 16);
    const b = parseInt(fullHex.substr(4, 2), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  },

  getContrastColor: function(hexcolor) {
    if (!hexcolor) return '#000000';
    let color = hexcolor.replace('#', '');
    if (color.length === 3) {
      color = color.split('').map((c) => c + c).join('');
    }
    if (color.length !== 6) return '#000000';
    const r = parseInt(color.substr(0, 2), 16);
    const g = parseInt(color.substr(2, 2), 16);
    const b = parseInt(color.substr(4, 2), 16);
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return yiq >= 128 ? '#000000' : '#FFFFFF';
  },

  normalizeMatchConfig: function(config) {
    const base = config || this.data.matchConfig;
    const normalizedConfig = JSON.parse(JSON.stringify(base || {}));
    if (!normalizedConfig.matchNameColor) normalizedConfig.matchNameColor = '#E64340';

    ['teamA', 'teamB'].forEach((teamKey) => {
      const teamDefaults = teamKey === 'teamA'
        ? { name: '队 A', bgColor: '#E64340', textColor: '#FFFFFF', score: 0 }
        : { name: '队 B', bgColor: '#10AEFF', textColor: '#FFFFFF', score: 0 };
      const sourceTeam = normalizedConfig[teamKey] || {};
      const bgColor = sourceTeam.bgColor || sourceTeam.color || teamDefaults.bgColor;
      const textColor = this.getContrastColor(bgColor);
      normalizedConfig[teamKey] = {
        ...teamDefaults,
        ...sourceTeam,
        bgColor,
        rgbaBg: this.hexToRgba(bgColor, 0.8),
        textColor
      };
    });

    if (typeof normalizedConfig.period !== 'number') {
      normalizedConfig.period = 0;
    }
    return normalizedConfig;
  },

  onShow: function() {
    this.rollingActive = true;
    this.rollingSessionId += 1;
    this.lastSegmentAt = Date.now();
    this.lastRecordStartAt = 0;
    this.startRecordFailStreak = 0;

    // 优先从 MIAOXIE_MATCHES 读取当前场次，保持与 index 页数据同步
    const currentMatchId =
      wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    let sourceConfig = app.globalData.matchConfig || wx.getStorageSync('matchConfig');
    if (currentMatchId) {
      const matches = wx.getStorageSync('MIAOXIE_MATCHES');
      if (Array.isArray(matches)) {
        const found = matches.find((m) => m.id === currentMatchId);
        if (found) sourceConfig = found;
      }
    }
    const latestConfig = this.normalizeMatchConfig(sourceConfig);
    this.setData({ matchConfig: latestConfig });
    app.globalData.matchConfig = latestConfig;
    wx.setStorageSync('matchConfig', latestConfig);

    // 检查是否已读操作指南
    const hasReadGuide = wx.getStorageSync('hasReadGuide');
    if (!hasReadGuide) {
      this.setData({ showGuide: true });
    }

    // 权限检查
    wx.getSetting({
      success: (res) => {
        if (!res.authSetting['scope.camera'] || !res.authSetting['scope.record']) {
          wx.authorize({
            scope: 'scope.camera',
            success: () => {
              wx.authorize({ scope: 'scope.record' });
            }
          });
        }
      }
    });

    // 再次确保常亮（部分机型进入页后需要重复设置）
    wx.setKeepScreenOn({ 
      keepScreenOn: true,
      fail: () => {
        setTimeout(() => wx.setKeepScreenOn({ keepScreenOn: true }), 1000);
      }
    });

    // 启动滚动录制（用于导播高光）
    this.startRollingRecording();
    if (this.data.drawerMode === 1) {
      this.refreshDrawerHighlights();
    }
    if (wx.nextTick) {
      wx.nextTick(() => this.updateTeamGroupWidth());
    } else {
      setTimeout(() => this.updateTeamGroupWidth(), 0);
    }
  },

  updateTeamGroupWidth: function() {
    const sysInfo = wx.getSystemInfoSync();
    const windowWidth = sysInfo.windowWidth || 375;
    const rpxToPx = windowWidth / 750;

    const query = wx.createSelectorQuery().in(this);
    query.selectAll('.team-name-measure').boundingClientRect((rects) => {
      if (!rects || rects.length < 2) return;
      const nameWidthPx = Math.max(rects[0]?.width || 0, rects[1]?.width || 0);

      const paddingRpx = 30;
      const gapRpx = 8;
      const scoreAreaRpx = 42;
      const extraPx = (paddingRpx + gapRpx + scoreAreaRpx) * rpxToPx;

      const periodMinRpx = 60;
      const maxTeamPx = Math.max(0, (windowWidth * 0.86 - periodMinRpx * rpxToPx) / 2);
      const minTeamPx = 120 * rpxToPx;

      const targetPx = Math.min(Math.max(nameWidthPx + extraPx, minTeamPx), maxTeamPx);
      const widthPx = Math.round(targetPx);

      if (widthPx > 0 && widthPx !== this.data.teamGroupWidthPx) {
        this.setData({ teamGroupWidthPx: widthPx });
      }
    }).exec();
  },

  onUnload: function() {
    this.rollingActive = false;
    if (this.pendingHighlight && this.pendingHighlight.timeout) {
      clearTimeout(this.pendingHighlight.timeout);
    }
    this.pendingHighlight = null;
    this.segmentBuffer = [];
    if (this.rollingWatchdogTimer) {
      clearInterval(this.rollingWatchdogTimer);
      this.rollingWatchdogTimer = null;
    }
    this.stopRollingRecording();
  },

  // 节次切换
  onPeriodTap: function() {
    let { period } = this.data.matchConfig;
    period = (period + 1) % this.data.periods.length;
    this.setData({ 'matchConfig.period': period });
    this.vibrate('light');
  },

  // 核心计分逻辑
  onScoreTap: function(e) {
    const { team, type } = e.currentTarget.dataset;
    if (this.suppressScoreTap) {
      this.suppressScoreTap = false;
      return;
    }
    this.applyScoreChange(team, type);
    if (type === 'plus') {
      this.vibrate('medium');
    } else if (type === 'minus') {
      this.vibrate('light');
    }
    this.persistConfig();
  },

  applyScoreChange: function(team, type) {
    let score = this.data.matchConfig[team].score;
    if (type === 'plus') {
      score += 1;
    } else if (type === 'minus') {
      score = Math.max(0, score - 1);
    }
    this.setData({ [`matchConfig.${team}.score`]: score });
  },

  onBackTap: function() {
    this.closeAllDrawers();
    this.stopRollingRecording();
    wx.navigateBack();
  },

  onPeriodLongPress: function() {
    this.requestHighlightCapture();
  },

  // 长按连续计分
  onScoreLongPress: function(e) {
    const { team, type } = e.currentTarget.dataset;
    this.vibrate('heavy');
    this.suppressScoreTap = true;
    if (this.data.longPressTimer) {
      clearInterval(this.data.longPressTimer);
    }
    this.applyScoreChange(team, type);
    const timer = setInterval(() => {
      this.applyScoreChange(team, type);
    }, 120);

    this.setData({ longPressTimer: timer });
  },

  // 停止长按
  onScoreTouchEnd: function() {
    if (this.data.longPressTimer) {
      clearInterval(this.data.longPressTimer);
      this.setData({ longPressTimer: null });
      this.persistConfig();
    }
    setTimeout(() => {
      this.suppressScoreTap = false;
    }, 0);
  },

  // 震动反馈
  vibrate: function(type) {
    // 兼容性与稳定性修复：
    // 1. iOS 优先使用 type 参数以获得细腻的触觉反馈。
    // 2. Android 部分机型在传入 type 时可能失效或无响应，故直接调用无参版以确保触发。
    try {
      const sys = wx.getSystemInfoSync();
      if (sys.platform === 'ios') {
        wx.vibrateShort({ type: type || 'medium' });
      } else {
        wx.vibrateShort();
      }
    } catch (e) {
      // 兜底
      if (wx.vibrateShort) wx.vibrateShort();
    }
  },

  /**
   * 高光保存成功时的触觉反馈。异步落盘完成后 iOS 常不再算「用户手势」，故需配合长按瞬间的震动；
   * Android 优先长震，失败则短震组合。
   */
  vibrateHighlightSaved: function() {
    const fallback = () => {
      this.vibrate('heavy');
      setTimeout(() => this.vibrate('heavy'), 160);
      setTimeout(() => this.vibrate('medium'), 320);
    };
    if (wx.vibrateLong) {
      wx.vibrateLong({
        success: () => {
          setTimeout(() => this.vibrate('medium'), 80);
        },
        fail: fallback
      });
    } else {
      fallback();
    }
  },

  getHighlightDir: function() {
    return `${wx.env.USER_DATA_PATH}/highlights`;
  },

  /**
   * 滚动录制缓存目录（用于提高高光保存稳定性）。
   * 注意：这里存的是最近若干段“已落盘”的视频片段，避免 temp 文件被系统回收。
   * @returns {string}
   */
  getRollingDir: function() {
    return `${this.getHighlightDir()}/_rolling`;
  },

  ensureHighlightDir: function() {
    const fs = wx.getFileSystemManager();
    const dirPath = this.getHighlightDir();
    return new Promise((resolve) => {
      fs.access({
        path: dirPath,
        success: () => resolve(),
        fail: () => {
          fs.mkdir({
            dirPath,
            recursive: true,
            success: () => resolve(),
            fail: () => resolve()
          });
        }
      });
    });
  },

  /**
   * 确保滚动录制缓存目录存在。
   * @returns {Promise<void>}
   */
  ensureRollingDir: function() {
    const fs = wx.getFileSystemManager();
    const dirPath = this.getRollingDir();
    return new Promise((resolve) => {
      fs.access({
        path: dirPath,
        success: () => resolve(),
        fail: () => {
          fs.mkdir({
            dirPath,
            recursive: true,
            success: () => resolve(),
            fail: () => resolve()
          });
        }
      });
    });
  },

  startRollingRecording: function() {
    if (!this.data.cameraContext || this.data.isRecording) return;
    const sessionId = this.rollingSessionId;
    Promise.all([this.ensureHighlightDir(), this.ensureRollingDir()]).then(() => {
      if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
      if (this.rollingWatchdogTimer) {
        clearInterval(this.rollingWatchdogTimer);
      }
      /**
       * 录制看门狗：如果录制意外断流（例如 startRecord 连续失败），自动拉起。
       */
      this.rollingWatchdogTimer = setInterval(() => {
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        const now = Date.now();
        const isStuckRecording = this.data.isRecording
          && this.lastRecordStartAt > 0
          && (now - this.lastRecordStartAt > this.segmentDurationMs * 2.8);
        if (isStuckRecording) {
          try {
            this.data.cameraContext.stopRecord({
              complete: () => {
                this.setData({ isRecording: false });
                this.lastRecordStartAt = 0;
                setTimeout(() => this.startOneSegment(sessionId, 0), 120);
              }
            });
          } catch (e) {
            this.setData({ isRecording: false });
            this.lastRecordStartAt = 0;
            setTimeout(() => this.startOneSegment(sessionId, 0), 120);
          }
          return;
        }
        if (this.data.isRecording) return;
        const streamIdleTooLong = now - this.lastSegmentAt > this.segmentDurationMs * 3;
        if (!streamIdleTooLong) return;
        this.startOneSegment(sessionId, 0);
      }, this.segmentDurationMs * 3);
      this.startOneSegment(sessionId);
    });
  },

  startOneSegment: function(sessionId, retryCount = 0) {
    if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
    if (!this.data.cameraContext) return;
    this.data.cameraContext.startRecord({
      success: () => {
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        this.startRecordFailStreak = 0;
        this.lastRecordStartAt = Date.now();
        this.setData({ isRecording: true });
        if (this.segmentStopTimer) clearTimeout(this.segmentStopTimer);
        this.segmentStopTimer = setTimeout(() => {
          this.stopOneSegment(sessionId);
        }, this.segmentDurationMs);
      },
      fail: () => {
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        this.startRecordFailStreak += 1;
        // 关键修复：不能在少量失败后停止，否则 segmentCounter 会冻结，后续高光重复。
        const nextRetry = retryCount + 1;
        const delay = Math.min(1500, 220 + nextRetry * 140);
        if (this.startRecordFailStreak >= 5) {
          this.startRecordFailStreak = 0;
          this.setData({ isRecording: false });
          this.lastRecordStartAt = 0;
          setTimeout(() => this.startOneSegment(sessionId, 0), 900);
          return;
        }
        setTimeout(() => this.startOneSegment(sessionId, nextRetry), delay);
      }
    });
  },

  stopOneSegment: function(sessionId) {
    if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
    if (!this.data.cameraContext || !this.data.isRecording) return;
    this.data.cameraContext.stopRecord({
      success: (res) => {
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        this.setData({ isRecording: false });
        this.lastRecordStartAt = 0;
        const tempPath = res && res.tempVideoPath ? res.tempVideoPath : '';
        this.segmentCounter += 1;
        if (tempPath) {
          // 关键时序修复：
          // 先固定当前片段，再开始下一段录制，避免 tempPath 被后续录制复用/覆盖。
          this.onSegmentRecorded(tempPath, this.segmentCounter).finally(() => {
            setTimeout(() => this.startOneSegment(sessionId), 0);
          });
          return;
        }
        setTimeout(() => this.startOneSegment(sessionId), 0);
      },
      fail: () => {
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        this.setData({ isRecording: false });
        this.lastRecordStartAt = 0;
        setTimeout(() => this.startOneSegment(sessionId), 200);
      }
    });
  },

  stopRollingRecording: function() {
    if (this.rollingWatchdogTimer) {
      clearInterval(this.rollingWatchdogTimer);
      this.rollingWatchdogTimer = null;
    }
    if (this.segmentStopTimer) {
      clearTimeout(this.segmentStopTimer);
      this.segmentStopTimer = null;
    }
    if (this.data.cameraContext && this.data.isRecording) {
      try {
        this.data.cameraContext.stopRecord({
          success: () => {
            this.lastRecordStartAt = 0;
            this.setData({ isRecording: false });
          },
          fail: () => {
            this.lastRecordStartAt = 0;
            this.setData({ isRecording: false });
          }
        });
      } catch (e) {
        this.lastRecordStartAt = 0;
        this.setData({ isRecording: false });
      }
    }
  },

  /**
   * 将单段录制结果写入滚动缓存。
   * @param {string} tempPath 临时视频路径
   * @param {number} segNo 片段序号
   * @returns {Promise<void>}
   */
  onSegmentRecorded: function(tempPath, segNo) {
    // 关键修复：把每个 segment 立刻保存到本地 rolling 目录，避免 tempVideoPath 后续失效。
    return this.ensureRollingDir().then(() => new Promise((resolve) => {
      const fs = wx.getFileSystemManager();
      const rollingDir = this.getRollingDir();
      const rollingPath = `${rollingDir}/seg_${segNo}.mp4`;
      const finalizeSegment = (savedPath) => {
        this.segmentBuffer.push({ path: savedPath, segNo });
        this.lastSegmentAt = Date.now();
        const maxBuf = this.rollingBufferMax || 3;
        if (this.segmentBuffer.length > maxBuf) {
          const removed = this.segmentBuffer.splice(0, this.segmentBuffer.length - maxBuf);
          // 清理被淘汰的 rolling 文件（不影响已保存为高光的副本）
          removed.forEach((it) => {
            if (!it || !it.path) return;
            if (it.path.indexOf(this.getRollingDir()) !== 0) return;
            try { fs.unlinkSync(it.path); } catch (e) {}
          });
        }

        // 缓冲尚空时用户已触发保存：等第一段录制完成后再落盘（仍是一段 8s）
        if (this.pendingHighlight && !this.pendingHighlight.finalizing && this.pendingHighlight.waitNext) {
          if (segNo > this.pendingHighlight.startSegNo) {
            const waitPending = this.pendingHighlight;
            this.pendingHighlight = null;
            if (waitPending.timeout) {
              clearTimeout(waitPending.timeout);
              waitPending.timeout = null;
            }
            this.finalizeHighlight({
              id: waitPending.id,
              createdAt: waitPending.createdAt,
              startSegNo: waitPending.startSegNo,
              matchName: waitPending.matchName,
              cover: waitPending.cover,
              finalizing: false,
              preSegments: [savedPath],
              postSegments: []
            });
          }
        }
        resolve();
      };

      // 优先 copyFile，避免 saveFile 配额/持久化限制导致缓冲不更新而反复引用旧片段。
      if (fs.copyFile) {
        fs.copyFile({
          srcPath: tempPath,
          destPath: rollingPath,
          success: () => finalizeSegment(rollingPath),
          fail: () => {
            fs.saveFile({
              tempFilePath: tempPath,
              filePath: rollingPath,
              success: (r) => finalizeSegment((r && r.savedFilePath) ? r.savedFilePath : rollingPath),
              fail: () => {
                // 最后兜底：至少使用当次 temp 路径，避免 segmentBuffer 长时间卡在旧片段。
                finalizeSegment(tempPath);
              }
            });
          }
        });
        return;
      }
      fs.saveFile({
        tempFilePath: tempPath,
        filePath: rollingPath,
        success: (r) => finalizeSegment((r && r.savedFilePath) ? r.savedFilePath : rollingPath),
        fail: () => finalizeSegment(tempPath)
      });
    })).catch(() => Promise.resolve());
  },

  /**
   * 长按节次：保存「刚结束的一段」完整滚动片段（时长约 {@link segmentDurationMs}，默认 8s）。
   * 不额外拍照封面，避免与录制并行增加相机压力与闪屏。
   */
  requestHighlightCapture: function() {
    if (this.data.drawerMode > 0) {
      wx.showToast({ title: '请先关闭抽屉再保存高光', icon: 'none' });
      return;
    }
    if (this.data.isReplaying) {
      wx.showToast({ title: '回放中无法保存高光', icon: 'none' });
      return;
    }
    const now = Date.now();
    // 强制防抖：10s 时间锁，防止重复保存片段（略大于 segmentDurationMs）
    const minGap = 10000; 
    if (now - this.lastHighlightRequestAt < minGap) {
      wx.showToast({ title: '操作过快，请稍后再试', icon: 'none' });
      return;
    }
    if (this.pendingHighlight) {
      wx.showToast({ title: '正在保存片段，请稍候', icon: 'none' });
      return;
    }

    /** 判定成功，立即触发震动反馈（不再显示视觉标记，避免被录屏） */
    this.vibrate('heavy');

    this.lastHighlightRequestAt = now;
    const matchName = this.data.matchConfig.matchName || '未命名比赛';
    const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    const id = `${now}`;
    const startSegNo = this.segmentCounter;
    const lastEntry = this.segmentBuffer.length > 0      ? this.segmentBuffer[this.segmentBuffer.length - 1]
      : null;

    if (lastEntry && lastEntry.path) {
      this.finalizeHighlight({
        id,
        createdAt: now,
        startSegNo,
        matchName,
        matchId: currentMatchId,
        cover: this.data.defaultCover,
        finalizing: false,
        preSegments: [lastEntry.path],
        postSegments: []
      });
      return;
    }

    const waitPending = {
      id,
      createdAt: now,
      startSegNo,
      matchName,
      matchId: currentMatchId,
      cover: this.data.defaultCover,
      finalizing: false,
      waitNext: true,
      timeout: null
    };
    waitPending.timeout = setTimeout(() => {
      if (this.pendingHighlight && this.pendingHighlight.id === id) {
        this.pendingHighlight = null;
        wx.showToast({ title: '未捕捉到可用片段', icon: 'none' });
      }
    }, this.segmentDurationMs * 2 + 3000);
    this.pendingHighlight = waitPending;
  },

  finalizeHighlight: function(pending) {
    if (!pending || pending.finalizing) return;
    pending.finalizing = true;
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }
    const segments = [...pending.preSegments, ...pending.postSegments].filter(Boolean);
    if (segments.length === 0) {
      wx.showToast({ title: '未捕捉到可用片段', icon: 'none' });
      return;
    }
    const fs = wx.getFileSystemManager();
    const dir = this.getHighlightDir();

    const copyOne = (srcPath, idx) => new Promise((resolve) => {
      const filePath = `${dir}/${pending.id}_${idx}.mp4`;
      if (fs.copyFile) {
        fs.copyFile({
          srcPath,
          destPath: filePath,
          success: () => resolve(filePath),
          fail: () => resolve('')
        });
        return;
      }
      // 兼容性兜底：没有 copyFile 的情况下，尽量用 saveFile（但它通常只支持 tempFilePath）
      fs.saveFile({
        tempFilePath: srcPath,
        filePath,
        success: (r) => resolve((r && r.savedFilePath) ? r.savedFilePath : filePath),
        fail: () => resolve('')
      });
    });

    Promise.all(segments.map((p, i) => copyOne(p, i))).then((saved) => {
      const savedPaths = saved.filter(Boolean);
      if (savedPaths.length === 0) {
        wx.showToast({ title: '保存失败，请稍后重试', icon: 'none' });
        return;
      }
      
      const replaySegment = savedPaths[savedPaths.length - 1] || savedPaths[0] || '';
      
      // 提取视频首帧作为封面
      const extractCover = () => {
        if (!replaySegment) return Promise.resolve(this.data.defaultCover);
        return new Promise((resolve) => {
          if (wx.createVideoMessageReceiver || wx.getVideoInfo) {
            // 小程序原生提取首帧通常需要通过 media-container 或特定 API
            // 这里使用更通用的方式：如果有视频，尝试获取视频信息并作为占位，
            // 实际上小程序端最稳妥的离线首帧提取是利用 <video> 组件的 bindloadedmetadata 配合 canvas
            // 但在后台逻辑中，我们优先尝试使用 wx.getVideoInfo 配合后端的首帧服务或者小程序本地缓存
            // 鉴于目前是离线场景，我们利用小程序 video 组件自带的 thumb-extractor 逻辑（如果有）
            // 或者直接在 finalize 阶段记录，在 UI 层通过微信 video 的 poster 属性逻辑处理
            resolve(replaySegment + '?x-oss-process=video/snapshot,t_0,f_jpg'); // 伪代码，部分云存储支持
          } else {
            resolve(this.data.defaultCover);
          }
        });
      };

      // 修正：小程序本地视频提取首帧最稳妥方法是 wx.getVideoInfo (如果支持) 
      // 或者在 save 成功后，UI 渲染时直接使用视频组件展示。
      // 为了性能和兼容性，我们先记录视频路径，封面逻辑在 refreshDrawerHighlights 中优化。
      
      const item = {
        id: pending.id,
        matchName: pending.matchName,
        matchId: pending.matchId,
        createdAt: pending.createdAt,
        timeText: this.formatTime(pending.createdAt),
        cover: pending.cover || this.data.defaultCover,
        segments: savedPaths,
        replaySegment: replaySegment
      };
      const signature = savedPaths.join('|');
      if (signature && signature === this.lastHighlightSignature) {
        wx.showToast({ title: '与上一条片段重复，已忽略', icon: 'none' });
        return;
      }
      this.lastHighlightSignature = signature;
      
      // 重构：根据 matchId 存储高光
      const clipsMap = wx.getStorageSync('MIAOXIE_CLIPS') || {};
      const matchId = pending.matchId || 'default';
      if (!clipsMap[matchId]) clipsMap[matchId] = [];
      clipsMap[matchId].unshift(item);
      wx.setStorageSync('MIAOXIE_CLIPS', clipsMap);

      // 向后兼容：保留一份全局列表（可选，但为了防止老版本逻辑报错建议保留）
      const list = this.getHighlightList();
      list.unshift(item);
      wx.setStorageSync('highlight_list', list);

      this.vibrateHighlightSaved();
      this.flashPeriod();
      if (this.data.drawerMode === 1) {
        this.refreshDrawerHighlights();
      }
    });
  },

  formatTime: function(ts) {
    const d = new Date(ts);
    const pad = (n) => `${n}`.padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  },

  getHighlightList: function(matchId) {
    if (matchId) {
      const clipsMap = wx.getStorageSync('MIAOXIE_CLIPS') || {};
      return Array.isArray(clipsMap[matchId]) ? clipsMap[matchId] : [];
    }
    const raw = wx.getStorageSync('highlight_list');
    return Array.isArray(raw) ? raw : [];
  },

  onBackgroundLongPress: function() {
    if (this.isMultiTouch) return;
    this.openDrawerMode1();
  },

  dismissGuide: function() {
    this.setData({ showGuide: false });
    wx.setStorageSync('hasReadGuide', true);
  },

  /**
   * 打开抽屉（mode 1）：左侧比赛列表 + 右侧高光缩略图
   */
  openDrawerMode1: function() {
    this.refreshDrawerHighlights();
    this.loadMatchList();
    this.setData({ drawerMode: 1 });
  },

  /**
   * 关闭所有抽屉，回到 mode 0
   */
  closeAllDrawers: function() {
    if (this.data.drawerMode !== 0) {
      this.setData({ drawerMode: 0 });
    }
  },

  /** 向后兼容：内部调用 closeDrawer 的地方统一走 closeAllDrawers */
  closeDrawer: function() {
    this.closeAllDrawers();
  },

  stopDrawerBubbling: function() { return; },
  stopLeftDrawerBubbling: function() { return; },

  onDrawerBackdropMove: function(e) {
    const touch = (e.touches && e.touches[0]) ? e.touches[0] : null;
    if (!touch) return;
    const sys = wx.getSystemInfoSync();
    const w = sys.windowWidth || 375;
    if (touch.pageX < 16 || touch.pageX > w - 16) {
      this.closeAllDrawers();
    }
  },

  /**
   * 从 MIAOXIE_MATCHES 加载完整比赛列表，标记当前场次
   */
  loadMatchList: function() {
    const currentMatchId =
      wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    const matches = Array.isArray(raw) ? raw : [];
    const matchList = matches.map((m) => ({ ...m, isCurrent: m.id === currentMatchId }));
    this.setData({ matchList });
  },

  /**
   * 点击比赛卡片：关闭抽屉，弹出颜色设置浮层
   * @param {WechatMiniprogram.TouchEvent} e data-id
   */
  openColorModal: function(e) {
    const { id } = e.currentTarget.dataset;
    const match = this.data.matchList.find((m) => m.id === id);
    if (!match) return;
    const cloned = JSON.parse(JSON.stringify(match));
    ['teamA', 'teamB'].forEach((t) => {
      if (cloned[t] && typeof cloned[t].bgColor === 'string') {
        cloned[t].bgColor = cloned[t].bgColor.toUpperCase();
      }
    });
    this.setData({
      drawerMode: 0,
      showColorModal: true,
      colorModalMatch: cloned,
      colorModalTeam: 'teamA'
    });
  },

  /**
   * 关闭颜色设置浮层
   */
  closeColorModal: function() {
    this.setData({ showColorModal: false, colorModalMatch: null });
  },

  /** 阻止颜色浮层内部点击冒泡到遮罩关闭 */
  stopColorModalBubbling: function() { return; },

  /**
   * 浮层中选中队伍名，切换共用色盘指向
   * @param {WechatMiniprogram.TouchEvent} e data-team
   */
  onSelectModalTeam: function(e) {
    const { team } = e.currentTarget.dataset;
    if (team === 'teamA' || team === 'teamB') {
      this.setData({ colorModalTeam: team });
    }
  },

  /**
   * 从颜色浮层切换场次：更新 currentMatchId 并关闭浮层
   */
  onSwitchMatchFromModal: function() {
    const modal = this.data.colorModalMatch;
    if (!modal || !modal.id) return;
    
    // 如果已经是当前场次，点击应关闭浮层
    if (modal.isCurrent) {
      this.closeColorModal();
      return;
    }

    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    if (!Array.isArray(raw)) return;
    const idx = raw.findIndex((m) => m.id === modal.id);
    if (idx < 0) return;
    const found = raw[idx];
    if (!found.teamA || !found.teamA.name || !found.teamB || !found.teamB.name) {
      wx.showToast({ title: '该比赛队名不完整', icon: 'none' });
      return;
    }
    /** 将浮层内最新颜色写回 Storage，再切换场次 */
    raw[idx].teamA = { ...found.teamA, ...modal.teamA };
    raw[idx].teamB = { ...found.teamB, ...modal.teamB };
    wx.setStorageSync('MIAOXIE_MATCHES', raw);
    const merged = raw[idx];
    wx.setStorageSync('currentMatchId', modal.id);
    app.globalData.currentMatchId = modal.id;
    const normalizedConfig = this.normalizeMatchConfig(merged);
    app.globalData.matchConfig = normalizedConfig;
    wx.setStorageSync('matchConfig', normalizedConfig);
    this.setData({ matchConfig: normalizedConfig });
    this.closeColorModal();
    this.loadMatchList();
    this.refreshDrawerHighlights(); // 切换后立即刷新高光列表
    this.vibrate('medium');
    wx.showToast({ title: '已切换', icon: 'success', duration: 800 });
  },

  /**
   * 修改某场比赛的队服颜色球（点击色球直接生效）
   * @param {WechatMiniprogram.TouchEvent} e data-match-id / data-team / data-color
   */
  onChangeTeamColor: function(e) {
    const { color } = e.currentTarget.dataset;
    const modal = this.data.colorModalMatch;
    if (!modal) return;
    const matchId = modal.id;
    const team = this.data.colorModalTeam;

    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    if (!Array.isArray(raw)) return;
    const idx = raw.findIndex((m) => m.id === matchId);
    if (idx < 0) return;

    const colorUpper = (color || '').toUpperCase();
    const textColor = this.getContrastColor(colorUpper);
    raw[idx][team] = {
      ...raw[idx][team],
      bgColor: colorUpper,
      textColor: textColor
    };
    wx.setStorageSync('MIAOXIE_MATCHES', raw);

    const currentMatchId =
      wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    if (matchId === currentMatchId) {
      const updated = this.normalizeMatchConfig(raw[idx]);
      this.setData({ matchConfig: updated });
      app.globalData.matchConfig = updated;
      wx.setStorageSync('matchConfig', updated);
    }

    const updatedModal = JSON.parse(JSON.stringify(modal));
    updatedModal[team] = {
      ...updatedModal[team],
      bgColor: colorUpper,
      textColor: textColor
    };
    this.setData({ colorModalMatch: updatedModal });

    this.loadMatchList();
  },

  /**
   * 切换到指定场次，加载数据并关闭抽屉
   * @param {WechatMiniprogram.TouchEvent} e data-id
   */
  onSwitchMatch: function(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    if (!Array.isArray(raw)) return;
    const match = raw.find((m) => m.id === id);
    if (!match) return;

    if (!match.teamA.name || !match.teamB.name) {
      wx.showToast({ title: '该比赛队名不完整', icon: 'none' });
      return;
    }

    wx.setStorageSync('currentMatchId', id);
    app.globalData.currentMatchId = id;
    const normalizedConfig = this.normalizeMatchConfig(match);
    app.globalData.matchConfig = normalizedConfig;
    wx.setStorageSync('matchConfig', normalizedConfig);
    this.setData({ matchConfig: normalizedConfig });
    this.closeAllDrawers();
    this.refreshDrawerHighlights(); // 切换后立即刷新高光列表
    this.vibrate('medium');
    wx.showToast({ title: '已切换', icon: 'success', duration: 800 });
  },

  refreshDrawerHighlights: function() {
    const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    const list = this.getHighlightList(currentMatchId).slice(0, 50);
    const drawerHighlights = list.map((it) => {
      // 这里的逻辑必须保证 item 独立性，不再共用全局变量
      return {
        id: it.id,
        // 如果 cover 还是默认图，且有视频片段，则标记需要提取封面
        cover: it.cover || this.data.defaultCover,
        videoPath: it.replaySegment || (it.segments && it.segments[0]) || '',
        needsCover: (!it.cover || it.cover === this.data.defaultCover)
      };
    });
    this.setData({ drawerHighlights });
  },

  onDrawerImageError: function(e) {
    const { id } = e.currentTarget.dataset;
    const updated = (this.data.drawerHighlights || []).map((it) => {
      if (it.id === id) {
        return { ...it, cover: this.data.defaultCover };
      }
      return it;
    });
    this.setData({ drawerHighlights: updated });
  },

  onDrawerSelect: function(e) {
    const { id } = e.currentTarget.dataset;
    const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    const list = this.getHighlightList(currentMatchId);
    const item = list.find((x) => x.id === id);
    if (!item) return;
    this.closeAllDrawers();
    this.startReplay(item);
  },

  /**
   * 长按删除高光
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onDeleteHighlight: function(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除高光',
      content: '确定要永久删除这段高光视频吗？',
      confirmColor: '#E64340',
      success: (res) => {
        if (res.confirm) {
          this.doDeleteHighlight(id);
        }
      }
    });
  },

  /** 真正执行删除逻辑（双端一致） */
  doDeleteHighlight: function(id) {
    const fs = wx.getFileSystemManager();
    
    // 1. 处理 MIAOXIE_CLIPS
    const clipsMap = wx.getStorageSync('MIAOXIE_CLIPS') || {};
    let foundInClips = false;
    for (const matchId in clipsMap) {
      const idx = clipsMap[matchId].findIndex(x => x.id === id);
      if (idx >= 0) {
        const item = clipsMap[matchId][idx];
        (item.segments || []).forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
        clipsMap[matchId].splice(idx, 1);
        foundInClips = true;
        break;
      }
    }
    if (foundInClips) {
      wx.setStorageSync('MIAOXIE_CLIPS', clipsMap);
    }

    // 2. 处理 legacy highlight_list
    const legacyList = wx.getStorageSync('highlight_list') || [];
    const legacyIdx = legacyList.findIndex(x => x.id === id);
    if (legacyIdx >= 0) {
      const item = legacyList[legacyIdx];
      (item.segments || []).forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
      legacyList.splice(legacyIdx, 1);
      wx.setStorageSync('highlight_list', legacyList);
    }

    wx.showToast({ title: '已删除', icon: 'success' });
    this.refreshDrawerHighlights();
  },

  startReplay: function(item) {
    const target = (item && item.replaySegment)
      || ((item && Array.isArray(item.segments) && item.segments[item.segments.length - 1]) ? item.segments[item.segments.length - 1] : '');
    if (!target) return;

    // 安全性检查：检查物理文件是否存在
    const fs = wx.getFileSystemManager();
    try {
      fs.accessSync(target);
    } catch (e) {
      wx.showModal({
        title: '文件已移除',
        content: '该视频文件已不存在，系统将自动清理无效记录。',
        showCancel: false,
        success: () => {
          this.doDeleteHighlight(item.id);
        }
      });
      return;
    }
    
    // 总时长 1.0s (1000ms)
     // 1. 0.35s 快速进场 (遮罩全黑)
     // 2. 0.65s 优雅淡出 (视频开始播放)
     const introMs = 1000;
     const peakMs = 350; 

     this.setData({
       showReplayMask: true,
       replayMaskText: 'REPLAY',
       replayMaskKind: 'replay',
       replayQueue: [],
       replayIndex: 0,
       replaySrc: ''
     });

     // 在 0.35s 强制执行播放逻辑
     setTimeout(() => {
       this.setData({ isReplaying: true, replaySrc: target });
     }, peakMs);

     // 在 1.0s 彻底隐藏遮罩
     setTimeout(() => {
       this.setData({ showReplayMask: false });
     }, introMs);
  },

  /**
   * 结束回放并播放回到直播的转场（正常播完或用户点击中断）。
   * @param {boolean} stopPlayer 是否立即停止 video（点击中断时为 true）
   */
  finishReplayToLive: function(stopPlayer) {
    if (stopPlayer) {
      try {
        const ctx = wx.createVideoContext('replayVideo', this);
        if (ctx && ctx.stop) ctx.stop();
      } catch (e) {}
    }
    const outroMs = this.data.replayOutroDurationMs || 720;
    this.setData({
      isReplaying: false,
      replaySrc: '',
      replayQueue: [],
      replayIndex: 0,
      showReplayMask: true,
      replayMaskText: 'LIVE',
      replayMaskKind: 'live'
    });
    setTimeout(() => {
      this.setData({ showReplayMask: false, replayMaskText: 'REPLAY', replayMaskKind: 'replay' });
    }, outroMs);
  },

  onReplayEnded: function() {
    this.finishReplayToLive(false);
  },

  /**
   * 回放中点击屏幕：中断播放并进入直播转场。
   */
  onReplayInterruptTap: function() {
    if (!this.data.isReplaying) return;
    this.finishReplayToLive(true);
  },

  /**
   * 确保回放以较慢倍速播放（部分机型仅属性不生效，需 VideoContext）。
   */
  onReplayVideoPlay: function() {
    const rate = this.data.replayPlaybackRate || 0.75;
    try {
      const ctx = wx.createVideoContext('replayVideo', this);
      if (ctx && ctx.playbackRate) ctx.playbackRate(rate);
    } catch (e) {}
  },

  flashPeriod: function() {
    this.setData({ periodFlash: true });
    setTimeout(() => this.setData({ periodFlash: false }), 160);
  },

  persistConfig: function() {
    const normalizedConfig = this.normalizeMatchConfig(this.data.matchConfig);
    this.setData({ matchConfig: normalizedConfig });
    wx.setStorageSync('matchConfig', normalizedConfig);
    app.globalData.matchConfig = normalizedConfig;

    // 将最新比分/节次实时回写到 MIAOXIE_MATCHES，保持首页数据同步
    const currentMatchId =
      wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    if (currentMatchId) {
      const matches = wx.getStorageSync('MIAOXIE_MATCHES');
      if (Array.isArray(matches)) {
        const idx = matches.findIndex((m) => m.id === currentMatchId);
        if (idx >= 0) {
          matches[idx] = {
            ...matches[idx],
            teamA: { ...matches[idx].teamA, score: normalizedConfig.teamA.score },
            teamB: { ...matches[idx].teamB, score: normalizedConfig.teamB.score },
            period: normalizedConfig.period
          };
          wx.setStorageSync('MIAOXIE_MATCHES', matches);
        }
      }
    }
  }
})
