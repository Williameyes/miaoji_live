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
    /** 回放视频是否需要旋转 90 度（竖屏素材在横屏页中的适配） */
    replayVideoNeedRotate: false,
    /** 回放视频旋转角度：仅在需要旋转时生效（90 或 -90） */
    replayVideoRotateDeg: 90,
    isReplaying: false,
    replaySrc: '',
    replayQueue: [],
    replayIndex: 0,

    // 相机焦距相关
    zoom: 1,
    maxZoom: 10,
    distance: 0,
    lastZoom: 1,
    /** 左右球队色块宽度（px），按队名字符数估算，避免 flex:1 拉满半屏 */
    teamGroupWidthPxA: 0,
    teamGroupWidthPxB: 0,
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
  /** 已落盘为高光的上一条滚动片段序号；避免多次长按反复拷贝同一段 rolling 文件 */
  lastHighlightConsumedSegNo: 0,
  lastSegmentAt: 0,
  lastRecordStartAt: 0,
  startRecordFailStreak: 0,
  /** rolling 缓冲最多保留的段数；抖音/外录等场景下 copy 较慢，过小易丢段 */
  rollingBufferMax: 10,
  /** 正在将分段写入本地 rolling（copyFile 等），此时禁止看门狗误启新段，避免长直播后写盘变慢导致管线错乱 */
  rollingFsBusy: false,
  /** 进入回放前 REPLAY 全屏转场总时长（需与 WXSS 中 replayBadgeMotion 时长一致） */
  replayIntroDurationMs: 1000,
  /** 回到直播转场总时长（需与 WXSS 中 liveBadgeMotion 时长一致） */
  replayOutroDurationMs: 720,

  onLoad: function() {
    /** 相机 bindinitdone 完成前禁止 startRecord，否则部分机型预览一直黑屏 */
    this._cameraInitDone = false;
    this._rollingKickoffTimer = null;
    this.rollingFsBusy = false;
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
    const wSide = this.computeTeamGroupWidthPx();
    this.setData({
      matchConfig: latestConfig,
      cameraContext: cameraContext,
      teamGroupWidthPxA: wSide,
      teamGroupWidthPxB: wSide
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

    // 强制横屏（需要 pageOrientation: "auto"）
    if (wx.setPageOrientation) {
      wx.setPageOrientation({ orientation: 'landscape' });
    }
  },

  // 相机初始化完成回调
  onCameraInit: function(e) {
    const maxZoom = e.detail.maxZoom || 5;
    this.setData({ maxZoom: maxZoom });
    this.updateZoom(1.0);
    if (this._rollingKickoffTimer) {
      clearTimeout(this._rollingKickoffTimer);
      this._rollingKickoffTimer = null;
    }
    this._cameraInitDone = true;
    this.tryStartRollingWhenCameraReady();
  },

  /**
   * 在相机预览就绪后再启动滚动分段，避免首屏即 startRecord 导致预览黑屏。
   * 注意：不可因 isRecording 直接 return——会话切换后旧段 stopOneSegment 会早退且不置 false，
   * 会遗留「假 true」，此处若拦截则永远无法 startRollingRecording，高光永远无片段。
   * @returns {void}
   */
  tryStartRollingWhenCameraReady: function() {
    if (!this.rollingActive || !this._cameraInitDone) return;
    if (!this.data.cameraContext) return;
    this.startRollingRecording();
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
    /**
     * 从后台返回、或系统/其他 App（如手游录屏直播）占用相机管线时，原生录制常被挂起，
     * 但 data.isRecording 仍为 true。startRollingRecording 首行会因「正在录制」直接 return，
     * 片段永不写入 segmentBuffer，长按高光会一直「未捕捉到可用片段」。
     * 故每次展示页面前先结束残留分段，并在 stopRecord 完成后再拉起新一轮滚动录制。
     */
    this.rollingActive = true;
    this.rollingSessionId += 1;
    const sessionIdForRolling = this.rollingSessionId;
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
    const wSide = this.computeTeamGroupWidthPx();
    this.setData({
      matchConfig: latestConfig,
      teamGroupWidthPxA: wSide,
      teamGroupWidthPxB: wSide
    });
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

    // 每次展示时重新强制横屏（防止从其他竖屏页返回后方向被重置）
    if (wx.setPageOrientation) {
      wx.setPageOrientation({ orientation: 'landscape' });
    }

    /**
     * 每次展示都必须走 stopRollingRecording：无录制时不会调用相机 stopRecord（见实现），
     * 仅清理定时器并回调；有录制时收口原生 startRecord，避免 rollingSessionId 递增后
     * 旧会话 stopOneSegment 早退导致 isRecording 永久为 true、滚动永远无法重启。
     * 分段启动仍放在相机 initdone 之后（tryStartRollingWhenCameraReady），避免首屏黑屏。
     */
    const kickoffRolling = () => {
      if (!this.rollingActive || sessionIdForRolling !== this.rollingSessionId) return;
      if (this._rollingKickoffTimer) {
        clearTimeout(this._rollingKickoffTimer);
        this._rollingKickoffTimer = null;
      }
      if (this._cameraInitDone) {
        this.tryStartRollingWhenCameraReady();
        return;
      }
      /** 绝不伪造 initdone：未触发时强行 startRecord 会打断预览导致黑屏；仅延后重试 */
      this._rollingKickoffTimer = setTimeout(() => {
        this._rollingKickoffTimer = null;
        if (!this.rollingActive || sessionIdForRolling !== this.rollingSessionId) return;
        this.tryStartRollingWhenCameraReady();
      }, 1800);
    };
    this.stopRollingRecording(kickoffRolling);
    if (this.data.drawerMode === 1) {
      this.refreshDrawerHighlights();
    }
    if (wx.nextTick) {
      wx.nextTick(() => this.updateTeamGroupWidth(true));
    } else {
      setTimeout(() => this.updateTeamGroupWidth(true), 0);
    }
  },

  onReady: function() {
    if (wx.nextTick) {
      wx.nextTick(() => this.updateTeamGroupWidth(true));
    } else {
      setTimeout(() => this.updateTeamGroupWidth(true), 0);
    }
  },

  /**
   * 与 WXS `limitTeamName`（最多 12 字）一致，用于非宽度逻辑时可读展示长度。
   *
   * @param {string} name 原始队名
   * @returns {number}
   */
  getDisplayTeamNameCharCount: function(name) {
    const s = String(name || '');
    return Math.min(Array.from(s).length, 12);
  },

  /**
   * 单侧球队区（队名+比分）固定宽度：按 12 个中文字符占位 + 左右边距估算，与队名实际长短无关。
   *
   * @returns {number} 宽度（px）
   */
  computeTeamGroupWidthPx: function() {
    const DISPLAY_CHAR_SLOTS = 12;
    const sys = wx.getSystemInfoSync();
    const ww = sys.windowWidth || 375;
    const rpxToPx = ww / 750;
    /** 队名区宽度 = 12 字槽位 + 分数固定槽位 + 二者间距 + 左右内边距。 */
    const NAME_CHAR_RPX = 20;
    const SCORE_SLOT_RPX = 40;
    const CONTENT_GAP_RPX = 8;
    const ROW_PADDING_RPX = 20;
    const MIN_RPX = 108;
    let needRpx =
      DISPLAY_CHAR_SLOTS * NAME_CHAR_RPX
      + SCORE_SLOT_RPX
      + CONTENT_GAP_RPX
      + ROW_PADDING_RPX;
    needRpx = Math.max(needRpx, MIN_RPX);
    let widthPx = needRpx * rpxToPx;
    const boardPx = ww * 0.98;
    /** 需与 `.period-center-outer` 的最小宽度 + padding 保持一致。 */
    const centerRpx = 80;
    const maxSidePx = Math.max(72, (boardPx - centerRpx * rpxToPx) / 2 - 4);
    widthPx = Math.min(widthPx, maxSidePx);
    return Math.round(widthPx);
  },

  /**
   * 根据当前 `matchConfig` 刷新左右色块宽度（横竖屏切换时也会重算）。
   *
   * @param {boolean} [force] 为 true 时跳过「数值接近则跳过」优化，避免 onShow 只改 matchConfig 时宽度未刷新
   * @returns {void}
   */
  updateTeamGroupWidth: function(force) {
    const wSide = this.computeTeamGroupWidthPx();
    if (
      !force &&
      Math.abs(wSide - (this.data.teamGroupWidthPxA || 0)) < 0.5 &&
      Math.abs(wSide - (this.data.teamGroupWidthPxB || 0)) < 0.5
    ) {
      return;
    }
    this.setData({ teamGroupWidthPxA: wSide, teamGroupWidthPxB: wSide });
  },

  onUnload: function() {
    this.rollingActive = false;
    this._cameraInitDone = false;
    if (this._rollingKickoffTimer) {
      clearTimeout(this._rollingKickoffTimer);
      this._rollingKickoffTimer = null;
    }
    if (this.pendingHighlight && this.pendingHighlight.timeout) {
      clearTimeout(this.pendingHighlight.timeout);
    }
    this.pendingHighlight = null;
    this.segmentBuffer = [];
    this.lastHighlightConsumedSegNo = 0;
    this.rollingFsBusy = false;
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
    if (!this.data.cameraContext) return;
    /** 已在录时勿重复拉起，避免双 startRecord；假阳性 isRecording 由 onShow 的 stopRollingRecording 收口 */
    if (this.data.isRecording) return;
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
        /** copy 尚未完成时不能认为「空闲」，否则会在长直播、磁盘变慢时并行 startRecord */
        if (this.rollingFsBusy) return;
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
        /** 在 copy 完成前就刷新心跳，避免仅依赖 finalize 时写盘慢导致看门狗误判空闲 */
        this.lastSegmentAt = Date.now();
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

  /**
   * 停止滚动分段录制并清理定时器。
   * @param {function(): void} [onStopped] 在录制状态已释放后调用（无录制时下一 tick 调用）
   * @returns {void}
   */
  stopRollingRecording: function(onStopped) {
    if (this.rollingWatchdogTimer) {
      clearInterval(this.rollingWatchdogTimer);
      this.rollingWatchdogTimer = null;
    }
    if (this.segmentStopTimer) {
      clearTimeout(this.segmentStopTimer);
      this.segmentStopTimer = null;
    }
    let finishOnce = false;
    /**
     * 将 isRecording 置 false 后再执行 onStopped，避免 setData 未完成时 startRollingRecording
     * 仍读到 isRecording === true 而直接 return。
     */
    const finish = () => {
      if (finishOnce) return;
      finishOnce = true;
      this.lastRecordStartAt = 0;
      let stoppedRan = false;
      const runStopped = () => {
        if (stoppedRan || typeof onStopped !== 'function') return;
        stoppedRan = true;
        if (wx.nextTick) wx.nextTick(onStopped);
        else setTimeout(onStopped, 0);
      };
      if (this.data.isRecording) {
        this.setData({ isRecording: false }, runStopped);
        setTimeout(runStopped, 120);
      } else {
        runStopped();
      }
    };
    if (this.data.cameraContext && this.data.isRecording) {
      try {
        this.data.cameraContext.stopRecord({
          success: finish,
          fail: finish
        });
      } catch (e) {
        finish();
      }
    } else {
      finish();
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
    this.rollingFsBusy = true;
    return this.ensureRollingDir().then(() => new Promise((resolve) => {
      const fs = wx.getFileSystemManager();
      const rollingDir = this.getRollingDir();
      const rollingPath = `${rollingDir}/seg_${segNo}.mp4`;
      const finalizeSegment = (savedPath) => {
        this.segmentBuffer.push({ path: savedPath, segNo });
        const maxBuf = this.rollingBufferMax || 10;
        if (this.segmentBuffer.length > maxBuf) {
          const removed = this.segmentBuffer.splice(0, this.segmentBuffer.length - maxBuf);
          // 清理被淘汰的 rolling 文件（不影响已保存为高光的副本）
          removed.forEach((it) => {
            if (!it || !it.path) return;
            if (it.path.indexOf(this.getRollingDir()) !== 0) return;
            try { fs.unlinkSync(it.path); } catch (e) {}
          });
        }

        // 缓冲尚空时用户已触发保存：等「尚未保存过」的片段落盘。
        // 仅用 segNo > minSegNoExclusive：若再要求 segNo >= startSegNo，在 copy 乱序或
        // segmentCounter 已前进时，会先来的较小 seg 被永久跳过，大序号若未落盘则一直超时。
        if (this.pendingHighlight && !this.pendingHighlight.finalizing && this.pendingHighlight.waitNext) {
          const minEx =
            typeof this.pendingHighlight.minSegNoExclusive === 'number'
              ? this.pendingHighlight.minSegNoExclusive
              : 0;
          if (segNo > minEx) {
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
              matchId: waitPending.matchId,
              cover: waitPending.cover,
              finalizing: false,
              sourceSegNo: segNo,
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
    }))
      .catch(() => Promise.resolve())
      .finally(() => {
        this.rollingFsBusy = false;
      });
  },

  /**
   * 高光等待超时或长期无新段时，尝试结束异常分段并重新拉起滚动录制（外录/磁盘慢场景）。
   * copy 进行中时延后执行，避免与相机分段并发冲突。
   *
   * @param {function(): void} [onDone] 恢复尝试结束后的回调
   * @param {number} [busyRetries] 内部参数：等待 rollingFsBusy 解除的重试次数
   * @returns {void}
   */
  recoverRollingPipelineForHighlight: function(onDone, busyRetries) {
    const maxBusyWait = 40;
    const n = typeof busyRetries === 'number' ? busyRetries : 0;
    if (this.rollingFsBusy && n < maxBusyWait) {
      setTimeout(() => {
        this.recoverRollingPipelineForHighlight(onDone, n + 1);
      }, 200);
      return;
    }
    /**
     * 高光超时只做「软恢复」：重置失败计数并 tryStart。
     * 禁止此处调用 stopRollingRecording→stopRecord：预览正常时中断分段录制极易整屏黑屏。
     * 会话级假死仍由 onShow 的 stopRollingRecording 收口。
     */
    this.startRecordFailStreak = 0;
    const kick = () => {
      this.tryStartRollingWhenCameraReady();
      if (typeof onDone === 'function') onDone();
    };
    if (wx.nextTick) wx.nextTick(kick);
    else setTimeout(kick, 0);
  },

  /**
   * 在滚动缓冲中选取 segNo 最大且严格大于 consumed 的条目。
   * copyFile 完成顺序可能与录制顺序不一致，不能仅用数组最后一项作为「最新段」。
   *
   * @param {number} consumed 已保存为高光的最大 segNo
   * @returns {{ path: string, segNo: number } | null}
   */
  pickBestRollingEntryAfterConsumed: function(consumed) {
    const minExclusive = typeof consumed === 'number' ? consumed : 0;
    let best = null;
    const buf = this.segmentBuffer || [];
    for (let i = 0; i < buf.length; i += 1) {
      const it = buf[i];
      if (!it || !it.path || typeof it.segNo !== 'number') continue;
      if (it.segNo <= minExclusive) continue;
      if (!best || it.segNo > best.segNo) best = it;
    }
    return best;
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

    /** 再次尝试拉起滚动分段（补救 init 与 onShow 竞态；与 tryStart 内聚，不重复判断 isRecording 误杀） */
    this.tryStartRollingWhenCameraReady();

    /** 判定成功，立即触发震动反馈（不再显示视觉标记，避免被录屏） */
    this.vibrate('heavy');

    this.lastHighlightRequestAt = now;
    const matchName = this.data.matchConfig.matchName || '未命名比赛';
    const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    const id = `${now}`;
    const startSegNo = this.segmentCounter;
    const consumed = this.lastHighlightConsumedSegNo || 0;
    /** 取 segNo 最大的可用段，避免异步落盘乱序时误把「尾部元素」当成最新段 */
    const freshEntry = this.pickBestRollingEntryAfterConsumed(consumed);

    if (freshEntry) {
      this.finalizeHighlight({
        id,
        createdAt: now,
        startSegNo,
        matchName,
        matchId: currentMatchId,
        cover: this.data.defaultCover,
        finalizing: false,
        sourceSegNo: freshEntry.segNo,
        preSegments: [freshEntry.path],
        postSegments: []
      });
      return;
    }

    const waitPending = {
      id,
      createdAt: now,
      startSegNo,
      minSegNoExclusive: consumed,
      matchName,
      matchId: currentMatchId,
      cover: this.data.defaultCover,
      finalizing: false,
      waitNext: true,
      timeout: null
    };
    const waitHighlightMs = this.segmentDurationMs * 5 + 12000;
    waitPending.timeout = setTimeout(() => {
      if (this.pendingHighlight && this.pendingHighlight.id === id) {
        this.pendingHighlight = null;
        this.recoverRollingPipelineForHighlight(() => {
          wx.showToast({ title: '未捕捉到可用片段', icon: 'none' });
        });
      }
    }, waitHighlightMs);
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
      if (typeof pending.sourceSegNo === 'number' && pending.sourceSegNo > 0) {
        this.lastHighlightConsumedSegNo = Math.max(
          this.lastHighlightConsumedSegNo || 0,
          pending.sourceSegNo
        );
      }

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
    this.updateTeamGroupWidth(true);
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
      this.updateTeamGroupWidth(true);
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
    this.updateTeamGroupWidth(true);
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
    
    // 回放前确保横屏（防止相机录制时方向切换导致回放竖屏）
    if (wx.setPageOrientation) {
      wx.setPageOrientation({ orientation: 'landscape' });
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
       replaySrc: '',
       replayVideoNeedRotate: false,
       replayVideoRotateDeg: 90
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
   * 确保回放以当前设定倍速播放（部分机型仅属性不生效，需 VideoContext）。
   */
  onReplayVideoPlay: function() {
    const rate = this.data.replayPlaybackRate || 0.75;
    try {
      const ctx = wx.createVideoContext('replayVideo', this);
      if (ctx && ctx.playbackRate) ctx.playbackRate(rate);
    } catch (e) {}
  },

  /**
   * 回放元信息加载完成后，根据视频宽高判断是否需要旋转。
   * @param {WechatMiniprogram.CustomEvent} e
   * @returns {void}
   */
  onReplayVideoLoadedMeta: function(e) {
    const detail = (e && e.detail) || {};
    const width = Number(detail.width || 0);
    const height = Number(detail.height || 0);
    const needRotate = width > 0 && height > 0 && height > width;
    const rotateDeg = needRotate ? this.getReplayRotateDegForDevice() : 90;
    this.setData({
      replayVideoNeedRotate: needRotate,
      replayVideoRotateDeg: rotateDeg
    });
    this.onReplayVideoPlay();
  },

  /**
   * 根据设备品牌选择回放旋转方向。
   * 仅对小米系设备做反向旋转修正，避免影响 iPhone 与其他安卓机型。
   * @returns {number} 90 或 -90
   */
  getReplayRotateDegForDevice: function() {
    try {
      const sys = wx.getSystemInfoSync();
      const brand = String((sys && sys.brand) || '').toLowerCase();
      const model = String((sys && sys.model) || '').toLowerCase();
      const isXiaomi =
        brand.indexOf('xiaomi') >= 0
        || brand.indexOf('redmi') >= 0
        || model.indexOf('xiaomi') >= 0
        || model.indexOf('redmi') >= 0;
      return isXiaomi ? -90 : 90;
    } catch (err) {
      return 90;
    }
  },

  /**
   * 切换回放倍速，立即通过 VideoContext 生效。
   * @param {WechatMiniprogram.TouchEvent} e data-rate: 0.5 | 0.75 | 1.0
   */
  onReplaySpeedChange: function(e) {
    const rate = parseFloat(e.currentTarget.dataset.rate);
    if (!rate || isNaN(rate)) return;
    this.setData({ replayPlaybackRate: rate });
    try {
      const ctx = wx.createVideoContext('replayVideo', this);
      if (ctx && ctx.playbackRate) ctx.playbackRate(rate);
    } catch (err) {}
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
