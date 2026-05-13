/**
 * @fileoverview 采集端 (Peripheral / GATT Server + VisionKit OCR)
 *
 * Phase 3 v2：
 *   - OCR pump 节流 + 单 ROI 轮询，严禁 30 帧暴力采集
 *   - ROI 拖动/缩放拆分：mode 'move' | 'resize-se'
 *   - wx.requestAnimationFrame 节流 touchmove（局部 setData，path 语法）
 *   - OCR 锚点局部更新（只写 rawText，不覆盖坐标）
 *   - 登录 + 白名单双重门控（isLogin && isInWhitelist）
 *   - VKSession 错误过滤（saaa/node js 底层错误不弹 Toast）
 *   - BLE 校验升级为 CRC-8/SMBUS（ble-protocol.js v2）
 *
 * 长时运行（数小时直播）：
 *   - 定时温和重建 VK 会话；手动 OCR 失败堆积时延迟温和重建
 *   - onHide 停相机帧泵、onShow 恢复，减轻后台无效回调
 *   - BLE notify 失败指数退避 + 定时补发，避免半连接写风暴
 *   - OCR 解析后仅按 frameKey 去重；仅 3 个 ROI（主/客分、时间），24 秒与节次改人工，减轻 CPU 与跳秒
 *   - 时间 ROI 优先调度 + 短窗「时钟回跳」暂缓整帧 notify（阈值偏保守，减少对顺计时干扰）
 *   - 现场实体记分牌由技术台改分为主；大单帧比分跳变用 streak 确认，截断式误读(111→11)要求更多连续一致帧
 *   - 比分待确认时仍推送「上一已确认比分 + 新时间」，避免时间因整帧暂缓而累积跳秒
 *
 * ROI 选区数据结构（归一化坐标，相对于相机预览区）：
 *   { x: 0-1, y: 0-1, w: 0-1, h: 0-1, label: string, rawText: string, pctStyle: string }
 */

var BLE = require('../../../utils/ble-protocol.js');
var REQ = require('../../../utils/request.js');

var STORAGE_KEY_ROIS = 'sync_lab_rois_v1';
/** 当前 OCR 队列 ROI 数量：主队分、客队分、时间（已移除 24 秒 ROI）。 */
var OCR_ROI_COUNT = 3;
var OCR_MIN_INTERVAL_MS = 160;
var OCR_PUMP_INTERVAL_MS = 120;
/** 单 ROI runOCR 超时（略收紧，避免长时间占用导致时间 ROI 断层）。 */
var OCR_RUN_TIMEOUT_MS = 720;
var OCR_TIMEOUT_SETTLE_MS = 0;
var OCR_MAX_VARIANTS_PER_RUN = 3;
/** 时间 ROI 刷新间隔（收紧以减轻跳秒观感）。 */
var OCR_TIME_REFRESH_MS = 160;
/** 比分 ROI 刷新间隔（略放宽，把时间槽让给时钟）。 */
var OCR_SCORE_REFRESH_MS = 720;
/**
 * 距上次时间 ROI 解析成功超过该毫秒时，在队列中优先时间 ROI。
 * @type {number}
 */
var OCR_TIME_PRIORITY_MS = 150;
/**
 * 任一侧相对上一提交比分变化 ≥ 该阈值时，需连续两帧解析出相同 (主,客) 分才接受，
 * 抑制 118→8、150→1 等丢位误读；常规单回合得分变化通常低于该值。
 * @type {number}
 */
var OCR_SCORE_JUMP_CONFIRM_THRESHOLD = 10;
/**
 * 大单帧跳变后若 OCR 读回与上一提交相差在该范围内，视为抖回上一稳定值，清除待确认。
 * @type {number}
 */
var OCR_SCORE_JUMP_REVERT_EPSILON = 4;
/**
 * 仅当用户在「本采集页」点按改分/重置时短旁路大单帧门禁（技术台改分走现场记分牌，不经过此处）。
 * @type {number}
 */
var OCR_SCORE_JUMP_MANUAL_GUARD_MS = 1500;
/** 一般大单帧跳变需连续多少帧解析出相同 (主,客) 分才接受。 */
var OCR_SCORE_JUMP_STREAK_NORMAL = 2;
/**
 * 疑似「高位截断」误读（如 111→11）时要求更多连续一致帧，减轻稳定误读过关。
 * @type {number}
 */
var OCR_SCORE_JUMP_STREAK_TRUNC = 5;
/** 长时运行：约 50 分钟温和重建 VK 会话，降低 session 僵死与内存爬升风险 */
var OCR_SESSION_REBUILD_MS = 50 * 60 * 1000;
/** 健康检查间隔（重建判定、后台恢复） */
var OCR_HEALTH_INTERVAL_MS = 60 * 1000;
/** 连续 runOCR 超时/异常达到该次数后触发温和重建（滑动窗口内） */
var OCR_MANUAL_FAIL_THRESHOLD = 8;
var OCR_MANUAL_FAIL_WINDOW_MS = 90 * 1000;
/** BLE notify 失败后最大退避（毫秒），避免半连接时写特征风暴 */
var BLE_NOTIFY_BACKOFF_MAX_MS = 8000;
var BLE_NOTIFY_BACKOFF_BASE_MS = 220;
var ROI_MIN_SIZE = 0.05; // 归一化最小宽/高，防止缩至 0

var DEFAULT_ROIS = [
  { x: 0.05, y: 0.15, w: 0.25, h: 0.20, label: '主队分', rawText: '' },
  { x: 0.70, y: 0.15, w: 0.25, h: 0.20, label: '客队分', rawText: '' },
  { x: 0.30, y: 0.35, w: 0.40, h: 0.18, label: '时间', rawText: '' }
];

/** @type {WechatMiniprogram.BLEPeripheralServer | null} */
var _server = null;
var _connectedDeviceId = '';
var _cameraContext = null;
var _cameraFrameListener = null;

/** @type {any} VKSession 实例 */
var _vkSession = null;
var _lastHandleTs = 0;   // OCR 锚点兜底门控时间戳
var _pendingOcrFrame = null;
var _lastCommittedFrameKey = '';
var _bleStarting = false;
var _ocrBootTimer = 0;
var _ocrSessionToken = 0;
var _ocrAnchorWatchdogTimer = 0;
var _ocrAnchorEventCount = 0;
var _ocrNativeTextEventCount = 0;
var _ocrAnchorLogSeq = 0;
var _ocrPumpTimer = 0;
var _ocrPumpFrameCount = 0;
var _ocrPumpLastTickTs = 0;
var _ocrRunBusy = false;
var _ocrRunLastTs = 0;
var _ocrRunState = null;
var _ocrRunTimeout = 0;
var _ocrTimeoutSettleUntil = 0;
var _ocrQueueCursor = 0;
var _ocrManualMode = false;
/** 最近一次时间 ROI 解析出合法 mm:ss 的墙钟时间戳（供时间优先调度）。 */
var _ocrLastTimeSuccessTs = 0;
/** 最近一次成功 BLE 提交的墙钟时间戳（供单帧时钟回跳检测）。 */
var _lastNotifyWallAt = 0;
/** 待下一帧复核的帧快照（时间疑似 OCR 跳变时暂缓 _notify）。 */
var _timeJumpHoldFrame = null;
/** 大单帧比分跳变待确认：同分值 streak 达标后放行。 */
var _scoreJumpHold = null;
/** 最近一次本采集页内手动改分时间（技术台改分不经过；仅短旁路用）。 */
var _manualScoreEditAt = 0;
var _lastCommittedFrame = null;
var _lastRejectedStableFrameKey = '';
var _lastRejectedStableFrameCount = 0;
var _ocrLastRoiRunTs = [0, 0, 0];
var _ocrRoiBackoffUntil = [0, 0, 0];
/** VK 会话启动时间戳，用于定时温和重建 */
var _ocrSessionStartedAt = 0;
/** 周期性 OCR 健康检查 */
var _ocrHealthTimer = 0;
/** 手动 OCR 在滑动窗口内的失败时间戳（timeout / run 抛错） */
var _ocrManualFailTimestamps = [];
/** 是否因小程序 onHide 暂停了相机帧泵（onShow 恢复） */
var _ocrPausedForBackground = false;
/** BLE notify 退避截止时刻 */
var _bleNotifyBackoffUntil = 0;
/** BLE notify 失败次数（用于指数退避） */
var _bleNotifyFailStreak = 0;
/** 退避结束后补发一次的定时器 */
var _bleNotifyRetryTimer = 0;

/** 相机预览区实际 px 尺寸 */
var _previewW = 0;
var _previewH = 0;

/**
 * 拖拽/缩放状态
 * mode: 'move'      → 拖动整体，修改 x/y
 *       'resize-se' → 拖动右下角柄，修改 w/h
 */
var _dragging = null;
// rAF pending 防抖（touchmove 去重）
var _rafPending = false;
var _rafTouchX = 0;
var _rafTouchY = 0;
var _lastRoiTickTs = 0;

/** 兼容性 requestAnimationFrame */
var _rAF = (function () {
  try {
    if (typeof wx !== 'undefined' && typeof wx.requestAnimationFrame === 'function') {
      return function (cb) { return wx.requestAnimationFrame(cb); };
    }
  } catch (e) { }
  return function (cb) { return setTimeout(cb, 16); };
})();

function _getVkBootDelayMs() {
  try {
    var sys = wx.getSystemInfoSync();
    if (sys && sys.platform === 'ios') return 980;
  } catch (e) { }
  return 760;
}

function _getCameraRemountDelayMs() {
  try {
    var sys = wx.getSystemInfoSync();
    if (sys && sys.platform === 'ios') return 220;
  } catch (e) { }
  return 120;
}

/**
 * 用户在本采集页手动改分后极短窗口内放宽大单帧门禁（技术台改分仅反映在现场记分牌，主流程不依赖此项）。
 * @returns {void}
 */
function bumpManualScoreEditGate() {
  _manualScoreEditAt = Date.now();
  _scoreJumpHold = null;
}

// ─────────────────────────────────────────────────────────────────────────────

Page({
  data: {
    statusBarHeight: 0,
    /** 登录 + 白名单双重门控 */
    isLogin: false,
    isInWhitelist: false,
    // BLE 状态
    bleState: 'idle',
    bleStateText: '未开启',
    matchCode: '',
    // 比赛数据
    homeScore: 0,
    awayScore: 0,
    period: 1,
    minutes: 10,
    seconds: 0,
    shotClock: 24,
    // OCR
    ocrEnabled: false,
    debugMode: false,
    /** @type {Array<{x,y,w,h,label,rawText,pctStyle}>} */
    rois: DEFAULT_ROIS.map(function (r) { return Object.assign({}, r); }),
    cameraMounted: true,
    previewPxW: 0,
    previewPxH: 0,
    selectedRoiIdx: -1,
    debugText: '',
    ocrTransitioning: false
  },

  // ─── 生命周期 ────────────────────────────────────────

  onLoad: function () {
    var sys = wx.getSystemInfoSync();
    var camW = sys.windowWidth || 667;
    var camH = sys.windowHeight || 375;
    _previewW = camW;
    _previewH = camH;
    this.setData({
      statusBarHeight: sys.statusBarHeight || 0,
      previewPxW: camW,
      previewPxH: camH
    });
    _cameraContext = wx.createCameraContext(this);
    wx.setKeepScreenOn({ keepScreenOn: true });
    this._checkAccess();
    this._loadRois();
  },

  onCameraInit: function () {
    _cameraContext = wx.createCameraContext(this);
    console.log('[Collector][OCR] camera init, context refreshed');
  },

  onCameraError: function (e) {
    console.error('[Collector] camera error', e.detail);
    wx.showToast({ title: '相机启动失败', icon: 'none' });
  },

  onUnload: function () {
    this._stopOcr(true);
    this._stopAll();
    wx.setKeepScreenOn({ keepScreenOn: false });
  },

  /**
   * 小程序进入后台：停止相机帧监听，减少无意义回调与半停相机导致的堆积。
   * 不销毁 VK，回到前台后由 onShow 恢复泵（手动 OCR 模式）。
   */
  onHide: function () {
    if (!this.data.ocrEnabled) return;
    _ocrPausedForBackground = true;
    this._cancelOcrFramePump();
    console.log('[Collector][OCR] paused frame pump (onHide)');
  },

  /**
   * 回到前台：若 OCR 仍开启且此前因后台暂停了帧泵，在手动模式下重新挂载监听。
   */
  onShow: function () {
    if (!_ocrPausedForBackground || !this.data.ocrEnabled) return;
    _ocrPausedForBackground = false;
    var session = _vkSession;
    if (!session || !_ocrManualMode) return;
    var token = _ocrSessionToken;
    console.log('[Collector][OCR] resume frame pump after foreground token=%s', token);
    this._startOcrFramePump(session, token);
  },

  // ─── 访问控制 ────────────────────────────────────────

  /**
   * 登录 + 白名单检查。
   * - isLogin:       globalData.userInfo 非 null 或 Storage 中存在 token
   * - isInWhitelist: sync_lab_whitelist 为空（开发阶段放行）或包含当前 openid
   */
  _checkAccess: function () {
    var app = getApp();
    var gd = (app && app.globalData) || {};
    var token = REQ.getToken ? REQ.getToken() : wx.getStorageSync('token');
    var isLogin = !!(token || (gd.userInfo && gd.userInfo.openid));

    var whitelist = wx.getStorageSync('sync_lab_whitelist') || [];
    var openid = (gd.userInfo && gd.userInfo.openid) || wx.getStorageSync('openid') || '';
    // 白名单为空 → 开发阶段默认放行；非空 → 必须命中
    var isInWhitelist = !whitelist.length || (!!openid && whitelist.indexOf(openid) !== -1);

    this.setData({ isLogin: isLogin, isInWhitelist: isInWhitelist });
    if (!isLogin || !isInWhitelist) {
      console.warn('[Collector] access denied — isLogin:', isLogin, 'isInWhitelist:', isInWhitelist);
    }
  },

  // ─── ROI 持久化 ──────────────────────────────────────

  _loadRois: function () {
    try {
      var saved = wx.getStorageSync(STORAGE_KEY_ROIS);
      if (saved && Array.isArray(saved) && saved.length) {
        var normalized = saved.slice(0);
        var migrated = false;
        if (normalized.length >= 4) {
          normalized = normalized.slice(0, 3);
          migrated = true;
        }
        if (normalized.length === 3) {
          this.setData({ rois: _withPctStyle(normalized) });
          if (migrated) {
            this._saveRois();
          }
          return;
        }
      }
    } catch (e) { }
    this.setData({ rois: _withPctStyle(DEFAULT_ROIS.map(function (r) { return Object.assign({}, r); })) });
  },

  _saveRois: function () {
    var raw = this.data.rois.map(function (r) {
      return { x: r.x, y: r.y, w: r.w, h: r.h, label: r.label, rawText: '' };
    });
    try { wx.setStorageSync(STORAGE_KEY_ROIS, raw); } catch (e) { }
  },

  // ─── ROI 整体拖动 ────────────────────────────────────

  onRoiBodyTouchStart: function (e) {
    var idx = parseInt(e.currentTarget.dataset.idx, 10);
    var touch = e.touches[0];
    var roi = this.data.rois[idx];
    _dragging = {
      mode: 'move',
      index: idx,
      startX: touch.clientX,
      startY: touch.clientY,
      origX: roi.x,
      origY: roi.y,
      origW: roi.w,
      origH: roi.h
    };
    _rafPending = false;
    this.setData({ selectedRoiIdx: idx });
  },

  onRoiBodyTouchMove: function (e) {
    if (!_dragging || _dragging.mode !== 'move') return;
    if (!e.touches || !e.touches.length) return;
    _rafTouchX = e.touches[0].clientX;
    _rafTouchY = e.touches[0].clientY;
    if (_rafPending) return;
    _rafPending = true;
    var self = this;
    _rAF(function () {
      _rafPending = false;
      if (!_dragging || _dragging.mode !== 'move') return;
      var now = Date.now();
      if (now - _lastRoiTickTs < 16) return;
      _lastRoiTickTs = now;
      var idx = _dragging.index;
      var pw = _previewW || 375;
      var ph = _previewH || 667;
      var newX = Math.max(0, Math.min(1 - _dragging.origW,
        _dragging.origX + (_rafTouchX - _dragging.startX) / pw));
      var newY = Math.max(0, Math.min(1 - _dragging.origH,
        _dragging.origY + (_rafTouchY - _dragging.startY) / ph));
      if (isNaN(newX) || isNaN(newY)) return;
      var curr = self.data.rois[idx];
      if (curr && curr.x === newX && curr.y === newY) return;
      var update = {};
      update['rois[' + idx + '].x'] = newX;
      update['rois[' + idx + '].y'] = newY;
      update['rois[' + idx + '].pctStyle'] = _computePctStyle(newX, newY, _dragging.origW, _dragging.origH);
      self.setData(update);
    });
  },

  // ─── ROI 右下角缩放 ──────────────────────────────────

  onRoiResizeTouchStart: function (e) {
    var idx = parseInt(e.currentTarget.dataset.idx, 10);
    var touch = e.touches[0];
    var roi = this.data.rois[idx];
    _dragging = {
      mode: 'resize-se',
      index: idx,
      startX: touch.clientX,
      startY: touch.clientY,
      origX: roi.x,
      origY: roi.y,
      origW: roi.w,
      origH: roi.h
    };
    _rafPending = false;
    this.setData({ selectedRoiIdx: idx });
  },

  onRoiResizeTouchMove: function (e) {
    if (!_dragging || _dragging.mode !== 'resize-se') return;
    if (!e.touches || !e.touches.length) return;
    _rafTouchX = e.touches[0].clientX;
    _rafTouchY = e.touches[0].clientY;
    if (_rafPending) return;
    _rafPending = true;
    var self = this;
    _rAF(function () {
      _rafPending = false;
      if (!_dragging || _dragging.mode !== 'resize-se') return;
      var now = Date.now();
      if (now - _lastRoiTickTs < 16) return;
      _lastRoiTickTs = now;
      var idx = _dragging.index;
      var pw = _previewW || 375;
      var ph = _previewH || 667;
      var newW = Math.max(ROI_MIN_SIZE, Math.min(1 - _dragging.origX,
        _dragging.origW + (_rafTouchX - _dragging.startX) / pw));
      var newH = Math.max(ROI_MIN_SIZE, Math.min(1 - _dragging.origY,
        _dragging.origH + (_rafTouchY - _dragging.startY) / ph));
      if (isNaN(newW) || isNaN(newH)) return;
      var curr = self.data.rois[idx];
      if (curr && curr.w === newW && curr.h === newH) return;
      var update = {};
      update['rois[' + idx + '].w'] = newW;
      update['rois[' + idx + '].h'] = newH;
      update['rois[' + idx + '].pctStyle'] = _computePctStyle(_dragging.origX, _dragging.origY, newW, newH);
      self.setData(update);
    });
  },

  /** 拖动/缩放结束：统一清理并持久化 */
  onRoiTouchEnd: function () {
    _dragging = null;
    _rafPending = false;
    _lastRoiTickTs = 0;
    this._saveRois();
  },

  // ─── 节次快选 ────────────────────────────────────────

  onSetPeriod: function (e) {
    var p = parseInt(e.currentTarget.dataset.p, 10);
    if (!p || p < 1 || p > 8) return;
    this.setData({ period: p });
    this._notify();
  },

  // ─── OCR 开关 ────────────────────────────────────────

  onToggleOcr: function () {
    if (this.data.ocrTransitioning) return;
    if (this.data.ocrEnabled || _vkSession || _ocrBootTimer) {
      this._stopOcr(false);
      return;
    }
    this._startOcr();
  },

  onToggleDebug: function () {
    this.setData({ debugMode: !this.data.debugMode });
  },

  _startOcr: function () {
    var self = this;
    var token = ++_ocrSessionToken;
    if (_ocrBootTimer) {
      clearTimeout(_ocrBootTimer);
      _ocrBootTimer = 0;
    }
    this._stopOcrSession();
    this.setData({ ocrTransitioning: true, cameraMounted: true }, function () {
      _ocrBootTimer = setTimeout(function () {
        _ocrBootTimer = 0;
        self._bootOcrSession(token);
      }, 80);
    });
  },

  _bootOcrSession: function (token) {
    var self = this;
    if (token !== _ocrSessionToken) return;
    _lastHandleTs = 0;
    _pendingOcrFrame = null;
    _lastCommittedFrameKey = '';
    _lastCommittedFrame = null;
    _lastRejectedStableFrameKey = '';
    _lastRejectedStableFrameCount = 0;
    _ocrAnchorEventCount = 0;
    _ocrNativeTextEventCount = 0;
    _ocrAnchorLogSeq = 0;
    _ocrQueueCursor = 0;
    _ocrManualMode = false;
    _ocrLastRoiRunTs = [0, 0, 0];
    _ocrRoiBackoffUntil = [0, 0, 0];
    _ocrLastTimeSuccessTs = Date.now();
    _timeJumpHoldFrame = null;
    _scoreJumpHold = null;
    _manualScoreEditAt = 0;
    _lastNotifyWallAt = 0;
    if (_ocrAnchorWatchdogTimer) {
      clearTimeout(_ocrAnchorWatchdogTimer);
      _ocrAnchorWatchdogTimer = 0;
    }
    var session = null;
    try {
      session = wx.createVKSession({ track: { OCR: { mode: 2 } } });
    } catch (eCreate) {
      self._stopOcrSession();
      self._restoreCameraPreview(function () {
        self.setData({ ocrEnabled: false, ocrTransitioning: false });
      });
      console.error('[Collector] createVKSession fail', eCreate);
      wx.showToast({ title: 'OCR 初始化失败', icon: 'none' });
      return;
    }
    _vkSession = session;
    console.log('[Collector][OCR] boot session token=%s delay=%s preview=%sx%s rois=%o', token, 80, _previewW, _previewH, this.data.rois);
    session.start(function (err) {
      if (token !== _ocrSessionToken) {
        try { session.stop(); } catch (eStale) { }
        try { session.destroy && session.destroy(); } catch (eDestroyStale) { }
        return;
      }
      if (err) {
        var msg = (err.errMsg || '').toLowerCase();
        // 过滤 SDK 内部底层报错（saaa_config / node js），不暴露给用户
        var isSdkInternal = msg.indexOf('node js') !== -1 || msg.indexOf('saaa') !== -1;
        self._stopOcrSession();
        self._restoreCameraPreview(function () {
          self.setData({ ocrEnabled: false, ocrTransitioning: false });
        });
        if (!isSdkInternal) {
          wx.showToast({ title: 'OCR 启动失败', icon: 'none' });
        }
        console.error('[Collector] VKSession start fail', err);
        return;
      }
      self.setData({ ocrEnabled: true, ocrTransitioning: false });
      self._startOcrHealthTimer();
      console.log('[Collector] VKSession started (native anchors first)');
      _ocrAnchorWatchdogTimer = setTimeout(function () {
        if (_vkSession === session && _ocrNativeTextEventCount === 0 && !_ocrManualMode) {
          console.warn('[Collector][OCR] no native text anchors within 3000ms, fallback to manual ROI pump');
          _ocrManualMode = true;
          self._startOcrFramePump(session, token);
        }
      }, 3000);

      session.on('updateAnchors', function (a) {
        if (_vkSession !== session) return;
        if (_ocrManualMode) {
          self._onOcrRunResult(a);
        } else {
          self._handleOcrAnchors(Array.isArray(a) ? a : []);
        }
      });
    });
  },

  _onOcrRunResult: function (anchors) {
    _ocrAnchorEventCount += 1;
    var list = Array.isArray(anchors) ? anchors : [];
    if (this.data.debugMode && _ocrAnchorLogSeq < 12) {
      var sample = list.length ? summarizeAnchorForLog(list[0]) : null;
      console.log('[Collector][OCR] event=updateAnchors seq=%s count=%s sample=%o', _ocrAnchorEventCount, list.length, sample);
      _ocrAnchorLogSeq += 1;
    } else if (this.data.debugMode && _ocrAnchorEventCount % 60 === 0) {
      console.log('[Collector][OCR] event=updateAnchors seq=%s count=%s', _ocrAnchorEventCount, list.length);
    }

    if (!_ocrRunState || !_ocrRunBusy) {
      if (this.data.debugMode) {
        console.log('[Collector][OCR] unexpected anchor event outside manual run');
      }
      return;
    }

    if (_ocrRunTimeout) {
      clearTimeout(_ocrRunTimeout);
      _ocrRunTimeout = 0;
    }

    var roiIdx = _ocrRunState.currentIdx;
    var text = collectAnchorTexts(list).join(' ').trim();
    if (this.data.debugMode) {
      console.log('[Collector][OCR] roi result idx=%s label=%s text=%s', roiIdx, this.data.rois[roiIdx] && this.data.rois[roiIdx].label, text);
    }
    if (this._shouldRetryCurrentVariant(roiIdx, text)) {
      this._advanceCurrentVariantOrQueue('invalid-text');
      return;
    }
    _ocrRunState.rawTexts[roiIdx] = text;
    this._applyPartialOcrPreview(_ocrRunState.rawTexts);
    _ocrRunState.queuePos += 1;
    this._runNextRoiOcr();
  },

  _startOcrFramePump: function (session, token) {
    var self = this;
    this._cancelOcrFramePump();
    _ocrPumpFrameCount = 0;
    _ocrPumpLastTickTs = 0;
    if (!_cameraContext || typeof _cameraContext.onCameraFrame !== 'function') {
      console.error('[Collector][OCR] onCameraFrame unavailable');
      return;
    }
    console.log('[Collector][OCR] native frame listener start interval=%s', OCR_PUMP_INTERVAL_MS);
    try {
      _cameraFrameListener = _cameraContext.onCameraFrame(function (frame) {
        if (_vkSession !== session || token !== _ocrSessionToken) return;
        _ocrPumpFrameCount += 1;
        var frameW = frame && frame.width ? frame.width : 0;
        var frameH = frame && frame.height ? frame.height : 0;
        if (_ocrPumpFrameCount <= 3 || _ocrPumpFrameCount % 300 === 0) {
          console.log('[Collector][OCR] pump seq=%s frame=%s size=%sx%s', _ocrPumpFrameCount, !!(frame && frame.data), frameW, frameH);
        }
        if (frame && frame.data && frameW > 0 && frameH > 0) {
          var now = Date.now();
          if (now - _ocrPumpLastTickTs < OCR_PUMP_INTERVAL_MS) return;
          _ocrPumpLastTickTs = now;
          self._maybeRunManualOcr(session, token, frame.data, frameW, frameH);
        }
      });
      _cameraFrameListener.start();
    } catch (eStart) {
      console.error('[Collector][OCR] onCameraFrame start fail', eStart);
    }
  },

  _cancelOcrFramePump: function () {
    if (_cameraFrameListener) {
      try { _cameraFrameListener.stop(); } catch (eStop) { }
      _cameraFrameListener = null;
    }
    _ocrPumpFrameCount = 0;
    _ocrPumpLastTickTs = 0;
  },

  _maybeRunManualOcr: function (session, token, rgbaBuffer, frameW, frameH) {
    var now = Date.now();
    if (_ocrRunBusy) return;
    if (now < _ocrTimeoutSettleUntil) return;
    if (now - _ocrRunLastTs < OCR_MIN_INTERVAL_MS) return;
    if (token !== _ocrSessionToken) return;
    if (!rgbaBuffer || !rgbaBuffer.byteLength) {
      if (_ocrAnchorLogSeq < 20) {
        console.warn('[Collector][OCR] camera frame empty size=%sx%s', frameW, frameH);
        _ocrAnchorLogSeq += 1;
      }
      return;
    }

    if (typeof session.runOCR !== 'function') {
      console.error('[Collector][OCR] session.runOCR unavailable');
      return;
    }

    _ocrRunLastTs = now;
    _ocrRunBusy = true;
    var queue = buildOcrQueue(now, this.data.rois);
    if (!queue.length) {
      _ocrRunBusy = false;
      return;
    }
    _ocrRunState = {
      session: session,
      token: token,
      frameWidth: frameW,
      frameHeight: frameH,
      rgba: new Uint8Array(rgbaBuffer),
      rawTexts: this.data.rois.map(function (roi) { return roi.rawText || ''; }),
      queue: [queue[0]],
      queuePos: 0,
      currentIdx: -1
    };
    if (this.data.debugMode) {
      console.log('[Collector][OCR] queue=%o', _ocrRunState.queue.map(function (idx) { return idx + ':' + ((_ocrRunState.rawTexts[idx] && _ocrRunState.rawTexts[idx].slice(0, 12)) || ''); }));
      console.log('[Collector][OCR] manual run start frame=%sx%s bytes=%s', frameW, frameH, rgbaBuffer.byteLength);
    }
    this._runNextRoiOcr();
  },

  _runNextRoiOcr: function () {
    var self = this;
    var state = _ocrRunState;
    if (!state || !_ocrRunBusy) return;
    if (state.token !== _ocrSessionToken || _vkSession !== state.session) {
      this._finishManualOcrRun(true);
      return;
    }
    if (state.queuePos >= state.queue.length) {
      this._finishManualOcrRun(false);
      return;
    }

    state.currentIdx = state.queue[state.queuePos];
    state.currentVariants = cropRgbaCandidatesByRoi(
      state.rgba,
      state.frameWidth,
      state.frameHeight,
      this.data.rois[state.currentIdx]
    );
    state.currentVariantPos = 0;
    if (!state.currentVariants || !state.currentVariants.length) {
      console.warn('[Collector][OCR] crop empty idx=%s roi=%o', state.currentIdx, this.data.rois[state.currentIdx]);
      state.queuePos += 1;
      this._runNextRoiOcr();
      return;
    }
    this._runCurrentVariant();
  },

  _runCurrentVariant: function () {
    var self = this;
    var state = _ocrRunState;
    if (!state || !_ocrRunBusy) return;
    var roi = this.data.rois[state.currentIdx];
    var crop = state.currentVariants[state.currentVariantPos];
    if (!crop) {
      console.warn('[Collector][OCR] crop empty idx=%s roi=%o', state.currentIdx, roi);
      this._advanceCurrentVariantOrQueue('empty');
      return;
    }

    if (this.data.debugMode) {
      console.log('[Collector][OCR] runOCR idx=%s label=%s variant=%s/%s crop=%sx%s', state.currentIdx, roi.label, state.currentVariantPos + 1, state.currentVariants.length, crop.width, crop.height);
    }
    _ocrLastRoiRunTs[state.currentIdx] = Date.now();
    _ocrRunTimeout = setTimeout(function () {
      console.warn('[Collector][OCR] runOCR timeout idx=%s label=%s', state.currentIdx, roi.label);
      _ocrRunTimeout = 0;
      if (!_ocrRunState) return;
      _ocrRoiBackoffUntil[state.currentIdx] = Date.now() + 1500;
      self._applyPartialOcrPreview(_ocrRunState.rawTexts);
      self._advanceCurrentVariantOrQueue('timeout');
    }, OCR_RUN_TIMEOUT_MS);

    try {
      state.session.runOCR({
        frameBuffer: crop.buffer,
        width: crop.width,
        height: crop.height
      });
    } catch (eRun) {
      if (_ocrRunTimeout) {
        clearTimeout(_ocrRunTimeout);
        _ocrRunTimeout = 0;
      }
      _ocrRoiBackoffUntil[state.currentIdx] = Date.now() + 1500;
      console.error('[Collector][OCR] runOCR fail idx=%s label=%s err=%o', state.currentIdx, roi.label, eRun);
      this._advanceCurrentVariantOrQueue('fail');
    }
  },

  _advanceCurrentVariantOrQueue: function (reason) {
    var state = _ocrRunState;
    if (!state) return;
    if (reason === 'timeout' || reason === 'fail') {
      this._recordManualOcrFailure(reason);
    }
    if (state.currentVariants &&
      state.currentVariantPos + 1 < state.currentVariants.length &&
      state.currentVariantPos + 1 < OCR_MAX_VARIANTS_PER_RUN) {
      state.currentVariantPos += 1;
      if (this.data.debugMode) {
        console.log('[Collector][OCR] retry variant idx=%s label=%s reason=%s next=%s/%s', state.currentIdx, this.data.rois[state.currentIdx] && this.data.rois[state.currentIdx].label, reason, state.currentVariantPos + 1, state.currentVariants.length);
      }
      this._runCurrentVariant();
      return;
    }
    state.queuePos += 1;
    this._runNextRoiOcr();
  },

  _shouldRetryCurrentVariant: function (roiIdx, text) {
    var state = _ocrRunState;
    if (!state || !state.currentVariants || state.currentVariants.length <= 1) return false;
    if (roiIdx === 0 || roiIdx === 1) {
      return parseScore(text) === null;
    }
    if (roiIdx === 2) {
      return parseTime(text) === null;
    }
    return false;
  },

  _finishManualOcrRun: function (aborted) {
    if (_ocrRunTimeout) {
      clearTimeout(_ocrRunTimeout);
      _ocrRunTimeout = 0;
    }
    var state = _ocrRunState;
    _ocrRunBusy = false;
    _ocrRunState = null;
    if (!aborted) _ocrTimeoutSettleUntil = 0;
    if (!state || aborted) return;
    _ocrManualFailTimestamps = [];
    if (this.data.debugMode) {
      console.log('[Collector][OCR] manual run done roiTexts=%o', state.rawTexts);
    }
    this._applyOcrRoiTexts(state.rawTexts);
  },

  _stopOcr: function (skipRemount) {
    ++_ocrSessionToken;
    if (_ocrBootTimer) {
      clearTimeout(_ocrBootTimer);
      _ocrBootTimer = 0;
    }
    this._stopOcrSession();
    if (skipRemount) {
      this.setData({ ocrEnabled: false, ocrTransitioning: false });
      return;
    }
    this.setData({ ocrEnabled: false, ocrTransitioning: false, cameraMounted: true });
  },

  _stopOcrSession: function () {
    this._clearOcrHealthTimer();
    if (_ocrAnchorWatchdogTimer) {
      clearTimeout(_ocrAnchorWatchdogTimer);
      _ocrAnchorWatchdogTimer = 0;
    }
    if (_ocrRunTimeout) {
      clearTimeout(_ocrRunTimeout);
      _ocrRunTimeout = 0;
    }
    _ocrAnchorEventCount = 0;
    _ocrNativeTextEventCount = 0;
    _ocrAnchorLogSeq = 0;
    _ocrRunBusy = false;
    _ocrRunState = null;
    _ocrRunLastTs = 0;
    _ocrTimeoutSettleUntil = 0;
    _ocrQueueCursor = 0;
    _ocrManualMode = false;
    _ocrLastRoiRunTs = [0, 0, 0];
    _ocrRoiBackoffUntil = [0, 0, 0];
    _ocrLastTimeSuccessTs = Date.now();
    _timeJumpHoldFrame = null;
    _scoreJumpHold = null;
    _manualScoreEditAt = 0;
    _lastNotifyWallAt = 0;
    if (_vkSession) {
      this._cancelOcrFramePump();
      try {
        if (typeof _vkSession.off === 'function') {
          _vkSession.off('updateAnchors');
        }
      } catch (eOff) { }
      try { _vkSession.stop(); } catch (e) { }
      try { _vkSession.destroy && _vkSession.destroy(); } catch (eDestroy) { }
      _vkSession = null;
    }
    _lastHandleTs = 0;
    _pendingOcrFrame = null;
    _lastCommittedFrameKey = '';
    _lastCommittedFrame = null;
    _lastRejectedStableFrameKey = '';
    _lastRejectedStableFrameCount = 0;
    _ocrPausedForBackground = false;
    _ocrSessionStartedAt = 0;
    _ocrManualFailTimestamps = [];
  },

  /**
   * 停止 OCR 健康检查定时器。
   */
  _clearOcrHealthTimer: function () {
    if (_ocrHealthTimer) {
      clearInterval(_ocrHealthTimer);
      _ocrHealthTimer = 0;
    }
  },

  /**
   * VK 启动成功后开始计时，周期性检查是否需要温和重建会话。
   */
  _startOcrHealthTimer: function () {
    var self = this;
    this._clearOcrHealthTimer();
    _ocrSessionStartedAt = Date.now();
    _ocrHealthTimer = setInterval(function () {
      self._onOcrHealthTick();
    }, OCR_HEALTH_INTERVAL_MS);
  },

  /**
   * 健康检查：会话存活过久则温和重建，避免 VK 长时间僵死与内存爬升。
   */
  _onOcrHealthTick: function () {
    if (!_vkSession || !this.data.ocrEnabled || this.data.ocrTransitioning) return;
    var started = _ocrSessionStartedAt || 0;
    if (!started) return;
    if (Date.now() - started >= OCR_SESSION_REBUILD_MS) {
      this._softRestartOcrSession('uptime');
    }
  },

  /**
   * 记录手动 OCR 单次失败（超时/run 抛错），滑动窗口内过多则温和重建 VK。
   * @param {string} reason 失败原因标记
   */
  _recordManualOcrFailure: function (reason) {
    if (!_ocrManualMode) return;
    var now = Date.now();
    _ocrManualFailTimestamps.push(now);
    while (
      _ocrManualFailTimestamps.length &&
      (now - _ocrManualFailTimestamps[0]) > OCR_MANUAL_FAIL_WINDOW_MS
    ) {
      _ocrManualFailTimestamps.shift();
    }
    if (_ocrManualFailTimestamps.length >= OCR_MANUAL_FAIL_THRESHOLD) {
      console.warn('[Collector][OCR] manual fail threshold reached reason=%s count=%s', reason, _ocrManualFailTimestamps.length);
      _ocrManualFailTimestamps = [];
      var self = this;
      setTimeout(function () {
        self._softRestartOcrSession('manual-fail');
      }, 0);
    }
  },

  /**
   * 温和重建 VK OCR 会话：不关闭 BLE，不打断用户「OCR 已开」状态，仅 stop/destroy 后重新 boot。
   * @param {string} reason 日志用原因
   */
  _softRestartOcrSession: function (reason) {
    if (!this.data.ocrEnabled || this.data.ocrTransitioning) return;
    var self = this;
    console.warn('[Collector][OCR] soft VK session rebuild reason=%s', reason || '');
    var token = ++_ocrSessionToken;
    if (_ocrBootTimer) {
      clearTimeout(_ocrBootTimer);
      _ocrBootTimer = 0;
    }
    this._clearOcrHealthTimer();
    this._stopOcrSession();
    this.setData({ ocrTransitioning: true }, function () {
      _ocrBootTimer = setTimeout(function () {
        _ocrBootTimer = 0;
        self._bootOcrSession(token);
      }, 200);
    });
  },

  _applyOcrRoiTexts: function (rawTexts) {
    var rois = this.data.rois;
    var debugMode = this.data.debugMode;
    var changed = false;
    var update = {};
    for (var i = 0; i < rawTexts.length; i++) {
      if ((rois[i] && rois[i].rawText) !== rawTexts[i]) {
        update['rois[' + i + '].rawText'] = rawTexts[i];
        changed = true;
      }
    }
    if (debugMode) {
      var debugLines = [];
      for (var di = 0; di < rawTexts.length; di++) {
        debugLines.push((rois[di] && rois[di].label ? rois[di].label : ('ROI' + di)) + ': ' + rawTexts[di]);
      }
      var nextDebugText = debugLines.join('\n');
      if (nextDebugText !== this.data.debugText) {
        update.debugText = nextDebugText;
        changed = true;
      }
    }
    if (changed) this.setData(update);

    if (debugMode) {
      console.log('[Collector][OCR] roiTexts=%o', rawTexts);
    }
    var parsedRois = rois.map(function (roi, idx) {
      return Object.assign({}, roi, { rawText: rawTexts[idx] });
    });
    this._applyParsedPreview(parsedRois);
    this._parseAndMaybeNotify(parsedRois);
  },

  _applyPartialOcrPreview: function (rawTexts) {
    var rois = this.data.rois.map(function (roi, idx) {
      return Object.assign({}, roi, { rawText: rawTexts[idx] || '' });
    });
    this._applyParsedPreview(rois);
  },

  _restoreCameraPreview: function (done) {
    if (typeof done === 'function') done();
  },

  // ─── OCR 锚点处理（兜底门控 + 局部 setData）────────

  /**
   * 兜底物理锁定：距上次处理不足 OCR_MIN_INTERVAL_MS 直接丢弃，不做任何计算。
   * setData 仅更新各 ROI 的 rawText，不触碰坐标/pctStyle。
   * debugText 仅在 debugMode 开启时写入。
   */
  _handleOcrAnchors: function (anchors) {
    _ocrAnchorEventCount += 1;
    var now = Date.now();
    if (now - _lastHandleTs < OCR_MIN_INTERVAL_MS) return;
    _lastHandleTs = now;

    if (!anchors || !anchors.length) {
      console.log('[Collector][OCR] gate pass but anchors empty');
    }

    var rois = this.data.rois;
    var rawTexts = rois.map(function () {
      return '';
    });
    var debugMode = this.data.debugMode;
    var debugLines = debugMode ? [] : null;
    var roiBounds = [];
    var changed = false;
    var update = {};

    for (var bi = 0; bi < rois.length; bi++) {
      roiBounds.push({
        left: rois[bi].x,
        top: rois[bi].y,
        right: rois[bi].x + rois[bi].w,
        bottom: rois[bi].y + rois[bi].h
      });
    }

    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      var text = typeof anchor.text === 'string' ? anchor.text.trim() : '';
      if (!text) {
        if (_ocrAnchorLogSeq < 20) {
          console.log('[Collector][OCR] anchor without text %o', summarizeAnchorForLog(anchor));
          _ocrAnchorLogSeq += 1;
        }
        continue;
      }
      var geo = extractAnchorCenter(anchor);
      if (!geo) {
        if (debugLines) debugLines.push(text + ' (no-geo)');
        if (_ocrAnchorLogSeq < 20) {
          console.log('[Collector][OCR] text with no geo text=%s sample=%o', text, summarizeAnchorForLog(anchor));
          _ocrAnchorLogSeq += 1;
        }
        continue;
      }
      var cx = geo.x;
      var cy = geo.y;
      var geoTag = geo.source || 'unknown';

      if (debugLines) debugLines.push(text + ' (' + cx.toFixed(2) + ',' + cy.toFixed(2) + ', ' + geoTag + ')');

      for (var r = 0; r < roiBounds.length; r++) {
        var roi = roiBounds[r];
        if (cx >= roi.left && cx <= roi.right && cy >= roi.top && cy <= roi.bottom) {
          rawTexts[r] = rawTexts[r] ? rawTexts[r] + ' ' + text : text;
        }
      }
    }

    for (var ri = 0; ri < rawTexts.length; ri++) {
      if (rawTexts[ri]) {
        _ocrNativeTextEventCount += 1;
      }
      if ((rois[ri] && rois[ri].rawText) !== rawTexts[ri]) {
        update['rois[' + ri + '].rawText'] = rawTexts[ri];
        changed = true;
      }
    }
    if (debugLines !== null) {
      if (!debugLines.length) debugLines.push('anchors: 0');
      var nextDebugText = debugLines.join('\n');
      if (nextDebugText !== this.data.debugText) {
        update.debugText = nextDebugText;
        changed = true;
      }
    }
    if (changed) this.setData(update);

    // 构造 rois 副本供解析（直接读当前 data.rois，rawText 已在 update 中）
    var parsedRois = rois.map(function (roi, idx) {
      return Object.assign({}, roi, { rawText: rawTexts[idx] });
    });
    if (debugMode) {
      console.log('[Collector][OCR] roiTexts=%o', rawTexts);
    }
    this._applyParsedPreview(parsedRois);
    this._parseAndMaybeNotify(parsedRois);
  },

  _applyParsedPreview: function (rois) {
    var next = {};
    var changed = false;
    var homeScore = parseScore(rois[0].rawText);
    var awayScore = parseScore(rois[1].rawText);
    var timeInfo = parseTime(rois[2].rawText);

    if (homeScore !== null && homeScore !== this.data.homeScore) {
      next.homeScore = homeScore;
      changed = true;
    }
    if (awayScore !== null && awayScore !== this.data.awayScore) {
      next.awayScore = awayScore;
      changed = true;
    }
    if (timeInfo) {
      if (timeInfo.minutes !== this.data.minutes) {
        next.minutes = timeInfo.minutes;
        changed = true;
      }
      if (timeInfo.seconds !== this.data.seconds) {
        next.seconds = timeInfo.seconds;
        changed = true;
      }
    }

    if (!changed) return;
    if (this.data.debugMode) {
      console.log('[Collector][OCR] preview update=%o', next);
    }
    this.setData(next);
  },

  /**
   * 在比分尚待 streak 确认时，仍将「上一已确认主客分 + 新时间」写入 data 并 notify，
   * 避免整帧 return 导致 BLE 时间停更、下一帧一次性补秒产生跳 2s。
   * @param {{ minutes: number, seconds: number } | null} timeInfo
   * @param {number} wallMs
   * @returns {void}
   */
  _emitTimeOnlyIfChanged: function (timeInfo, wallMs) {
    if (!timeInfo || !_lastCommittedFrame) return;
    if (!_server || !_connectedDeviceId) return;
    var prevT = ocrFrameClockSec(_lastCommittedFrame);
    var newT = (Number(timeInfo.minutes) || 0) * 60 + (Number(timeInfo.seconds) || 0);
    if (newT === prevT) return;
    this.setData({
      minutes: timeInfo.minutes,
      seconds: timeInfo.seconds,
      homeScore: _lastCommittedFrame.homeScore,
      awayScore: _lastCommittedFrame.awayScore,
      period: this.data.period,
      shotClock: this.data.shotClock
    });
    _lastNotifyWallAt = wallMs;
    this._notify();
  },

  /**
   * 解析 ROI 文字 → 比赛状态；节次与 24 秒仅人工，OCR 不解析。
   * 对「短墙钟间隔内比赛时钟异常回跳」暂缓整帧 notify，待下一帧复核。
   */
  _parseAndMaybeNotify: function (rois) {
    var homeScore = parseScore(rois[0].rawText);
    var awayScore = parseScore(rois[1].rawText);
    var timeInfo = parseTime(rois[2] && rois[2].rawText ? rois[2].rawText : '');
    /**
     * 时间优先调度依赖「时间 ROI 是否刚产出可读时钟」，与整帧是否可提交无关。
     * 若仅在此处更新 _ocrLastTimeSuccessTs，在比分尚未解析成功时提前 return 会导致
     * timeStarved 恒真、队列永远只跑时间 ROI → 比分永远为 null。
     */
    if (timeInfo) {
      _ocrLastTimeSuccessTs = Date.now();
    }

    if (homeScore === null || awayScore === null) {
      if (this.data.debugMode) {
        console.log('[Collector][OCR] parse skip home=%s away=%s raw=%o', homeScore, awayScore, rois.map(function (r) { return r.rawText; }));
      }
      return;
    }

    var wallPre = Date.now();
    var bypassScoreJumpHold =
      wallPre - (_manualScoreEditAt || 0) < OCR_SCORE_JUMP_MANUAL_GUARD_MS;
    if (bypassScoreJumpHold) {
      _scoreJumpHold = null;
    } else if (_lastCommittedFrame) {
      var dMax = maxScoreDeltaVsCommitted(_lastCommittedFrame, homeScore, awayScore);
      if (dMax >= OCR_SCORE_JUMP_CONFIRM_THRESHOLD) {
        var truncH = isLikelyTruncateGlitch(_lastCommittedFrame.homeScore, homeScore);
        var truncA = isLikelyTruncateGlitch(_lastCommittedFrame.awayScore, awayScore);
        var needStreak = (truncH || truncA) ? OCR_SCORE_JUMP_STREAK_TRUNC : OCR_SCORE_JUMP_STREAK_NORMAL;

        if (
          Math.abs(homeScore - _lastCommittedFrame.homeScore) <= OCR_SCORE_JUMP_REVERT_EPSILON &&
          Math.abs(awayScore - _lastCommittedFrame.awayScore) <= OCR_SCORE_JUMP_REVERT_EPSILON
        ) {
          _scoreJumpHold = null;
        } else if (
          _scoreJumpHold &&
          _scoreJumpHold.homeScore === homeScore &&
          _scoreJumpHold.awayScore === awayScore
        ) {
          _scoreJumpHold.streak = (_scoreJumpHold.streak || 1) + 1;
        } else {
          _scoreJumpHold = {
            homeScore: homeScore,
            awayScore: awayScore,
            streak: 1,
            since: wallPre
          };
        }

        if (_scoreJumpHold && (_scoreJumpHold.streak || 1) < needStreak) {
          if (this.data.debugMode) {
            console.log(
              '[Collector][OCR] score jump hold dMax=%s need=%s streak=%s h=%s a=%s trunc=%s/%s',
              dMax,
              needStreak,
              _scoreJumpHold.streak,
              homeScore,
              awayScore,
              truncH,
              truncA
            );
          }
          this._emitTimeOnlyIfChanged(timeInfo, wallPre);
          return;
        }
        _scoreJumpHold = null;
      } else {
        _scoreJumpHold = null;
      }
    } else {
      _scoreJumpHold = null;
    }

    var period = this.data.period;
    var shotClock = this.data.shotClock;
    var frame = {
      homeScore: homeScore,
      awayScore: awayScore,
      period: period,
      minutes: timeInfo ? timeInfo.minutes : this.data.minutes,
      seconds: timeInfo ? timeInfo.seconds : this.data.seconds,
      shotClock: shotClock
    };

    var wall = Date.now();

    if (_timeJumpHoldFrame && _timeJumpHoldFrame._holdSince) {
      var holdAge = wall - _timeJumpHoldFrame._holdSince;
      if (holdAge > 900) {
        _timeJumpHoldFrame = null;
      } else {
        var hg = ocrFrameClockSec(_timeJumpHoldFrame);
        var ng = ocrFrameClockSec(frame);
        var pg = _lastCommittedFrame ? ocrFrameClockSec(_lastCommittedFrame) : ng;
        if (Math.abs(ng - hg) <= 1) {
          frame.minutes = _timeJumpHoldFrame.minutes;
          frame.seconds = _timeJumpHoldFrame.seconds;
          _timeJumpHoldFrame = null;
        } else if (_lastCommittedFrame && Math.abs(ng - pg) <= 2) {
          _timeJumpHoldFrame = null;
        } else {
          return;
        }
      }
    }

    if (_lastCommittedFrame && timeInfo && _lastNotifyWallAt) {
      var dt = wall - _lastNotifyWallAt;
      if (isSuspiciousGameClockSkip(_lastCommittedFrame, frame, dt)) {
        _timeJumpHoldFrame = {
          homeScore: frame.homeScore,
          awayScore: frame.awayScore,
          period: frame.period,
          minutes: frame.minutes,
          seconds: frame.seconds,
          shotClock: frame.shotClock,
          _holdSince: wall
        };
        return;
      }
    }

    var frameKey = buildFrameKey(frame);
    if (this.data.debugMode) {
      console.log('[Collector][OCR] parsed frame=%o key=%s', frame, frameKey);
    }
    if (frameKey === _lastCommittedFrameKey) {
      _pendingOcrFrame = null;
      return;
    }
    if (this.data.debugMode) {
      console.log('[Collector][OCR] immediate commit=%o prev=%o', frame, _lastCommittedFrame);
    }
    this.setData({
      homeScore: frame.homeScore,
      awayScore: frame.awayScore,
      period: frame.period,
      minutes: frame.minutes,
      seconds: frame.seconds,
      shotClock: frame.shotClock
    });
    _pendingOcrFrame = null;
    _lastCommittedFrame = Object.assign({}, frame);
    _lastCommittedFrameKey = frameKey;
    _lastRejectedStableFrameKey = '';
    _lastRejectedStableFrameCount = 0;
    _lastNotifyWallAt = wall;
    this._notify();
  },

  // ─── BLE：启动 / 停止 ────────────────────────────────

  onStartTap: function () {
    if (_bleStarting || this.data.bleState !== 'idle') return;
    var self = this;
    _bleStarting = true;
    this.setData({ bleStateText: '初始化蓝牙…' });
    this._stopAll(function () {
      wx.openBluetoothAdapter({
        mode: 'peripheral',
        success: function () { self._createServer(); },
        fail: function (err) {
          _bleStarting = false;
          self.setData({ bleState: 'idle', bleStateText: '蓝牙初始化失败' });
          wx.showToast({ title: '蓝牙初始化失败', icon: 'none' });
          console.error('[Collector] openBluetoothAdapter fail', err);
        }
      });
    }, true);
  },

  _createServer: function () {
    var self = this;
    var code = BLE.generateMatchCode();
    this.setData({ matchCode: code });
    wx.createBLEPeripheralServer({
      success: function (res) {
        _server = res.server;
        self._addServiceAndAdvertise(BLE.DEVICE_NAME_PREFIX + code);
      },
      fail: function (err) {
        _bleStarting = false;
        self.setData({ bleState: 'idle', bleStateText: '创建GATT服务失败' });
        wx.showToast({ title: '创建GATT服务失败', icon: 'none' });
        console.error('[Collector] createBLEPeripheralServer fail', err);
      }
    });
  },

  _addServiceAndAdvertise: function (deviceName) {
    var self = this;
    if (!_server) return;
    _server.addService({
      service: {
        uuid: BLE.SERVICE_UUID,
        characteristics: [{
          uuid: BLE.CHAR_SCORE_UUID,
          properties: { read: true, notify: true, indicate: true },
          permission: {
            read: true, readEncrypted: false,
            write: true, writeEncrypted: false
          },
          descriptors: [{
            uuid: BLE.CCCD_UUID,
            permission: { read: true, write: true }
          }],
          value: new ArrayBuffer(BLE.PACKET_LENGTH)
        }]
      },
      success: function () {
        self._bindServerEvents();
        self._startAdv(deviceName);
      },
      fail: function (err) {
        _bleStarting = false;
        self.setData({ bleState: 'idle', bleStateText: '注册特征值失败' });
        wx.showToast({ title: '注册特征值失败，请重试', icon: 'none' });
        console.error('[Collector] addService fail', err);
      }
    });
  },

  _bindServerEvents: function () {
    var self = this;
    if (!_server) return;
    try { wx.offBLEPeripheralConnectionStateChanged(); } catch (e) { }

    wx.onBLEPeripheralConnectionStateChanged(function (res) {
      if (res.connected) {
        _connectedDeviceId = res.deviceId || '';
        _bleNotifyFailStreak = 0;
        _bleNotifyBackoffUntil = 0;
        if (_bleNotifyRetryTimer) {
          clearTimeout(_bleNotifyRetryTimer);
          _bleNotifyRetryTimer = 0;
        }
        self.setData({ bleState: 'connected', bleStateText: '已连接 ✓' });
        wx.vibrateShort({ type: 'medium' });
        console.log('[Collector] Central connected:', _connectedDeviceId);
      } else {
        _connectedDeviceId = '';
        if (_bleNotifyRetryTimer) {
          clearTimeout(_bleNotifyRetryTimer);
          _bleNotifyRetryTimer = 0;
        }
        _bleNotifyFailStreak = 0;
        _bleNotifyBackoffUntil = 0;
        self.setData({ bleState: 'advertising', bleStateText: '广播中，等待连接…' });
        console.log('[Collector] Central disconnected');
      }
    });

    _server.onCharacteristicReadRequest(function (res) {
      if (!_server) return;
      var d = self.data;
      _server.writeCharacteristicValue({
        serviceId: BLE.SERVICE_UUID,
        characteristicId: BLE.CHAR_SCORE_UUID,
        value: BLE.encodePacket({
          homeScore: d.homeScore, awayScore: d.awayScore, period: d.period,
          minutes: d.minutes, seconds: d.seconds, shotClock: d.shotClock
        }),
        needNotify: false,
        callbackType: 'read'
      });
    });
  },

  _startAdv: function (deviceName) {
    var self = this;
    if (!_server) return;
    _server.startAdvertising({
      advertiseRequest: {
        connectable: true,
        deviceName: deviceName,
        serviceUuids: [BLE.SERVICE_UUID]
      },
      success: function () {
        _bleStarting = false;
        self.setData({ bleState: 'advertising', bleStateText: '广播中，等待连接…' });
      },
      fail: function (err) {
        _bleStarting = false;
        self.setData({ bleState: 'idle', bleStateText: '广播启动失败' });
        wx.showToast({ title: '广播启动失败', icon: 'none' });
        console.error('[Collector] startAdvertising fail', err);
      }
    });
  },

  onStopTap: function () {
    this._stopOcr(false);
    this._stopAll();
    this.setData({ bleState: 'idle', bleStateText: '未开启', matchCode: '' });
  },

  _stopAll: function () {
    var doneCalled = false;
    var finish = arguments[0];
    var keepStarting = !!arguments[1];
    var finalize = function () {
      if (doneCalled) return;
      doneCalled = true;
      if (typeof finish === 'function') finish();
    };

    try { wx.offBLEPeripheralConnectionStateChanged(); } catch (e) { }
    if (_bleNotifyRetryTimer) {
      clearTimeout(_bleNotifyRetryTimer);
      _bleNotifyRetryTimer = 0;
    }
    _bleNotifyFailStreak = 0;
    _bleNotifyBackoffUntil = 0;
    if (_server) {
      try { _server.stopAdvertising(); } catch (e) { }
      try { _server.close(); } catch (e) { }
      _server = null;
    }
    _connectedDeviceId = '';
    if (!keepStarting) _bleStarting = false;
    try {
      wx.closeBluetoothAdapter({
        complete: function () { finalize(); }
      });
    } catch (e) {
      finalize();
    }
  },

  // ─── 模拟加分（OCR 关闭时可用）─────────────────────

  onHomeScorePlus: function () {
    bumpManualScoreEditGate();
    this.setData({ homeScore: this.data.homeScore + 1 });
    this._notify();
  },
  onAwayScorePlus: function () {
    bumpManualScoreEditGate();
    this.setData({ awayScore: this.data.awayScore + 1 });
    this._notify();
  },
  onPeriodPlus: function () {
    bumpManualScoreEditGate();
    if (this.data.period < 8) this.setData({ period: this.data.period + 1 });
    this._notify();
  },
  onReset: function () {
    bumpManualScoreEditGate();
    this.setData({ homeScore: 0, awayScore: 0, period: 1, minutes: 10, seconds: 0, shotClock: 24 });
    this._notify();
  },

  // ─── BLE 推送 notify ─────────────────────────────────

  /**
   * 在退避窗口结束后补发当前比分（读最新 this.data）。
   */
  _flushBleNotifyIfReady: function () {
    var self = this;
    if (!_server || !_connectedDeviceId) return;
    var now = Date.now();
    if (now < _bleNotifyBackoffUntil) {
      if (!_bleNotifyRetryTimer) {
        var waitMs = Math.max(50, _bleNotifyBackoffUntil - now);
        _bleNotifyRetryTimer = setTimeout(function () {
          _bleNotifyRetryTimer = 0;
          self._flushBleNotifyIfReady();
        }, waitMs);
      }
      return;
    }
    var d = self.data;
    _server.writeCharacteristicValue({
      serviceId: BLE.SERVICE_UUID,
      characteristicId: BLE.CHAR_SCORE_UUID,
      value: BLE.encodePacket({
        homeScore: d.homeScore, awayScore: d.awayScore, period: d.period,
        minutes: d.minutes, seconds: d.seconds, shotClock: d.shotClock
      }),
      needNotify: true,
      success: function () {
        _bleNotifyFailStreak = 0;
        _bleNotifyBackoffUntil = 0;
        console.log('[Collector] notify ok', d.homeScore, d.awayScore, d.minutes, d.seconds, d.shotClock);
      },
      fail: function (err) {
        _bleNotifyFailStreak = Math.min(_bleNotifyFailStreak + 1, 12);
        var pow = Math.min(Math.max(_bleNotifyFailStreak - 1, 0), 8);
        var backoff = Math.min(
          BLE_NOTIFY_BACKOFF_MAX_MS,
          Math.round(BLE_NOTIFY_BACKOFF_BASE_MS * Math.pow(2, pow))
        );
        _bleNotifyBackoffUntil = Date.now() + backoff;
        console.warn('[Collector] notify fail — backoff %sms streak=%s err=%o', backoff, _bleNotifyFailStreak, err);
        if (!_bleNotifyRetryTimer) {
          _bleNotifyRetryTimer = setTimeout(function () {
            _bleNotifyRetryTimer = 0;
            self._flushBleNotifyIfReady();
          }, backoff);
        }
      }
    });
  },

  _notify: function () {
    _lastCommittedFrame = {
      homeScore: this.data.homeScore,
      awayScore: this.data.awayScore,
      period: this.data.period,
      minutes: this.data.minutes,
      seconds: this.data.seconds,
      shotClock: this.data.shotClock
    };
    if (!_server || !_connectedDeviceId) return;
    this._flushBleNotifyIfReady();
  }
});

// ─── 纯函数工具 ──────────────────────────────────────────────────────────────

/**
 * 计算单个 ROI 的百分比定位字符串（供 WXML style 绑定）。
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @returns {string}
 */
function _computePctStyle(x, y, w, h) {
  return 'left:' + (x * 100).toFixed(1) + '%;' +
    'top:' + (y * 100).toFixed(1) + '%;' +
    'width:' + (w * 100).toFixed(1) + '%;' +
    'height:' + (h * 100).toFixed(1) + '%;';
}

/**
 * 为 ROI 数组每个元素补充 pctStyle 字段。
 * @param {Array} rois
 * @returns {Array}
 */
function _withPctStyle(rois) {
  return rois.map(function (r) {
    return Object.assign({}, r, { pctStyle: _computePctStyle(r.x, r.y, r.w, r.h) });
  });
}

/** 从字符串中提取合法比分数字（0-999）。 */
function parseScore(raw) {
  if (!raw) return null;
  var text = String(raw);
  var re = /\d{1,3}/g;
  var match = null;
  var candidates = [];
  while ((match = re.exec(text))) {
    var digits = match[0];
    var start = match.index;
    var end = start + digits.length;
    var nextChar = text.charAt(end);
    var prevChar = start > 0 ? text.charAt(start - 1) : '';
    var touchesTeamLabel = nextChar === '队' || prevChar === '队';
    candidates.push({
      digits: digits,
      touchesTeamLabel: touchesTeamLabel,
      start: start
    });
  }
  if (!candidates.length) return null;

  var filtered = candidates.filter(function (item) {
    return !item.touchesTeamLabel;
  });
  if (!filtered.length) return null;

  var parsed = [];
  for (var i = 0; i < filtered.length; i++) {
    var n = parseInt(filtered[i].digits, 10);
    if (!isNaN(n) && n >= 0 && n <= 999) {
      parsed.push({
        value: n,
        digits: filtered[i].digits,
        start: filtered[i].start
      });
    }
  }
  if (!parsed.length) return null;

  parsed.sort(function (a, b) {
    if (a.digits.length !== b.digits.length) return b.digits.length - a.digits.length;
    return b.start - a.start;
  });

  return parsed[0].value;
}

/** 解析 "分:秒" 格式。 */
function parseTime(raw) {
  if (!raw) return null;
  var text = String(raw);
  var exact = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})(?!.*\d\s*[:：]\s*\d{2})/);
  var m = null;
  var s = null;
  if (exact) {
    m = parseInt(exact[1], 10);
    s = parseInt(exact[2], 10);
  } else {
    var pairs = text.match(/\d{1,2}/g);
    if (!pairs || pairs.length < 2) return null;
    m = parseInt(pairs[pairs.length - 2], 10);
    s = parseInt(pairs[pairs.length - 1], 10);
  }
  if (isNaN(m) || isNaN(s) || m < 0 || m > 10 || s < 0 || s > 59) return null;
  if (m === 10 && s !== 0) return null;
  return { minutes: m, seconds: s };
}

/**
 * 将帧中的分:秒转为便于比较的总秒数（仅用于同节内 OCR 跳变启发式）。
 * @param {{ minutes?: number, seconds?: number }} f
 * @returns {number}
 */
function ocrFrameClockSec(f) {
  if (!f) return 0;
  return (Number(f.minutes) || 0) * 60 + (Number(f.seconds) || 0);
}

/**
 * 在较短墙钟间隔内，比赛时钟相对上一提交「多跳了」若干秒则视为可疑 OCR，暂缓 notify。
 * @param {{ minutes?: number, seconds?: number }} prev
 * @param {{ minutes?: number, seconds?: number }} next
 * @param {number} wallDtMs
 * @returns {boolean}
 */
function isSuspiciousGameClockSkip(prev, next, wallDtMs) {
  if (!prev || !next || wallDtMs >= 2000) return false;
  var prevT = ocrFrameClockSec(prev);
  var nextT = ocrFrameClockSec(next);
  if (nextT >= prevT) return false;
  var drop = prevT - nextT;
  var plausible = Math.floor(wallDtMs / 280) + 4;
  return drop > plausible && drop <= 45;
}

/**
 * 相对上一提交帧的主/客分单边最大变化量。
 * @param {{ homeScore?: number, awayScore?: number } | null} prev
 * @param {number} h
 * @param {number} a
 * @returns {number}
 */
function maxScoreDeltaVsCommitted(prev, h, a) {
  if (!prev) return 0;
  return Math.max(
    Math.abs(h - (Number(prev.homeScore) || 0)),
    Math.abs(a - (Number(prev.awayScore) || 0))
  );
}

/**
 * 判断新比分是否相对上一提交更像「高位数字被 OCR 吃掉」(如 111→11)。
 * @param {number} prev
 * @param {number} next
 * @returns {boolean}
 */
function isLikelyTruncateGlitch(prev, next) {
  if (prev == null || next == null) return false;
  if (next >= prev) return false;
  if (prev < 22 || prev - next < 9) return false;
  var ps = String(prev);
  var ns = String(next);
  if (!ns.length) return false;
  return ps.indexOf(ns) === 0;
}

/** 构造解析后比赛帧的去重 key（仅用于 OCR → setData 去重，非「N 帧一致」门禁）。 */
function buildFrameKey(frame) {
  return [
    frame.homeScore,
    frame.awayScore,
    frame.period,
    frame.minutes,
    frame.seconds,
    frame.shotClock
  ].join('|');
}

function collectAnchorTexts(anchors) {
  if (!anchors || !anchors.length) return [];
  var list = [];
  for (var i = 0; i < anchors.length; i++) {
    var t = anchors[i] && typeof anchors[i].text === 'string' ? anchors[i].text.trim() : '';
    if (t) list.push(t);
  }
  return list;
}

function cropRgbaCandidatesByRoi(rgba, frameWidth, frameHeight, roi) {
  var rect = buildRoiCropRect(frameWidth, frameHeight, roi);
  if (!rect) return [];
  if (roi.label === '主队分') {
    return buildCropVariants(rgba, frameWidth, frameHeight, [
      rect,
      expandRect(rect, frameWidth, frameHeight, { dx: -0.08, dy: -0.08, dw: 0.16, dh: 0.16 }),
      expandRect(rect, frameWidth, frameHeight, { dx: 0.08, dy: -0.04, dw: -0.08, dh: 0.08 })
    ]);
  }
  if (roi.label === '客队分') {
    return buildCropVariants(rgba, frameWidth, frameHeight, [
      rect,
      expandRect(rect, frameWidth, frameHeight, { dx: -0.08, dy: -0.08, dw: 0.16, dh: 0.16 }),
      expandRect(rect, frameWidth, frameHeight, { dx: 0.00, dy: -0.04, dw: -0.10, dh: 0.08 })
    ]);
  }
  if (roi.label === '时间') {
    return buildCropVariants(rgba, frameWidth, frameHeight, [
      rect,
      expandRect(rect, frameWidth, frameHeight, { dx: -0.06, dy: -0.12, dw: 0.12, dh: 0.24 }),
      expandRect(rect, frameWidth, frameHeight, { dx: 0.04, dy: -0.06, dw: -0.08, dh: 0.12 })
    ]);
  }
  return buildCropVariants(rgba, frameWidth, frameHeight, [rect]);
}

function buildCropVariants(rgba, frameWidth, frameHeight, rects) {
  var crops = [];
  for (var i = 0; i < rects.length; i++) {
    var crop = cropRgbaRect(rgba, frameWidth, frameHeight, rects[i]);
    if (crop) crops.push(crop);
  }
  return crops;
}

function buildRoiCropRect(frameWidth, frameHeight, roi) {
  if (!frameWidth || !frameHeight || !roi) return null;
  var x = Math.max(0, Math.floor(roi.x * frameWidth));
  var y = Math.max(0, Math.floor(roi.y * frameHeight));
  var w = Math.max(8, Math.floor(roi.w * frameWidth));
  var h = Math.max(8, Math.floor(roi.h * frameHeight));

  if (roi.label === '主队分') {
    x = Math.max(0, x - Math.floor(w * 0.04));
    w = Math.min(frameWidth - x, Math.floor(w * 1.04));
  } else if (roi.label === '客队分') {
    x = Math.max(0, x - Math.floor(w * 0.04));
    w = Math.min(frameWidth - x, Math.floor(w * 1.04));
  } else if (roi.label === '时间') {
    y = Math.max(0, y - Math.floor(h * 0.08));
    h = Math.min(frameHeight - y, Math.floor(h * 1.16));
  }

  var padX = Math.max(2, Math.floor(w * 0.05));
  var padY = Math.max(2, Math.floor(h * (roi.label === '时间' ? 0.06 : 0.10)));
  x = Math.max(0, x - padX);
  y = Math.max(0, y - padY);
  w = Math.min(frameWidth - x, w + padX * 2);
  h = Math.min(frameHeight - y, h + padY * 2);
  if (w <= 0 || h <= 0) return null;
  return { x: x, y: y, w: w, h: h };
}

function expandRect(rect, frameWidth, frameHeight, delta) {
  if (!rect) return null;
  var dx = Math.floor(rect.w * (delta.dx || 0));
  var dy = Math.floor(rect.h * (delta.dy || 0));
  var dw = Math.floor(rect.w * (delta.dw || 0));
  var dh = Math.floor(rect.h * (delta.dh || 0));
  var x = Math.max(0, rect.x + dx);
  var y = Math.max(0, rect.y + dy);
  var w = Math.min(frameWidth - x, Math.max(8, rect.w + dw));
  var h = Math.min(frameHeight - y, Math.max(8, rect.h + dh));
  if (w <= 0 || h <= 0) return null;
  return { x: x, y: y, w: w, h: h };
}

function cropRgbaRect(rgba, frameWidth, frameHeight, rect) {
  if (!rgba || !rect) return null;
  var x = rect.x;
  var y = rect.y;
  var w = rect.w;
  var h = rect.h;
  if (w <= 0 || h <= 0) return null;
  var out = new Uint8Array(w * h * 4);
  for (var row = 0; row < h; row++) {
    var srcStart = ((y + row) * frameWidth + x) * 4;
    var srcEnd = srcStart + w * 4;
    out.set(rgba.subarray(srcStart, srcEnd), row * w * 4);
  }
  return {
    buffer: out.buffer,
    width: w,
    height: h
  };
}

function summarizeAnchorForLog(anchor) {
  if (!anchor || typeof anchor !== 'object') return anchor;
  return {
    id: anchor.id,
    type: anchor.type,
    text: anchor.text,
    hasPoints: !!(anchor.points && anchor.points.length),
    pointsLen: anchor.points && anchor.points.length ? anchor.points.length : 0,
    origin: anchor.origin || null,
    size: anchor.size || null,
    keys: Object.keys(anchor).slice(0, 12)
  };
}

function extractAnchorCenter(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;

  var pts = anchor.points;
  if (pts && pts.length) {
    var px = 0;
    var py = 0;
    for (var i = 0; i < pts.length; i++) {
      px += Number(pts[i].x) || 0;
      py += Number(pts[i].y) || 0;
    }
    px = px / pts.length;
    py = py / pts.length;
    return normalizeAnchorPoint(px, py, 'points');
  }

  var origin = anchor.origin;
  var size = anchor.size;
  if (origin && size) {
    return normalizeAnchorPoint(
      (Number(origin.x) || 0) + (Number(size.width) || 0) / 2,
      (Number(origin.y) || 0) + (Number(size.height) || 0) / 2,
      'origin+size'
    );
  }

  if (origin && typeof origin.x !== 'undefined' && typeof origin.y !== 'undefined') {
    return normalizeAnchorPoint(Number(origin.x) || 0, Number(origin.y) || 0, 'origin');
  }

  return null;
}

function normalizeAnchorPoint(x, y, source) {
  if (!isFinite(x) || !isFinite(y)) return null;
  var nx = x;
  var ny = y;
  if (nx > 1 || ny > 1) {
    nx = nx / (_previewW || 667);
    ny = ny / (_previewH || 375);
  }
  if (!isFinite(nx) || !isFinite(ny)) return null;
  return { x: nx, y: ny, source: source };
}

function buildOcrQueue(now, rois) {
  var n = OCR_ROI_COUNT;
  var due = [];
  var intervals = [OCR_SCORE_REFRESH_MS, OCR_SCORE_REFRESH_MS, OCR_TIME_REFRESH_MS];
  var i;
  for (i = 0; i < n; i++) {
    if ((_ocrRoiBackoffUntil[i] || 0) > now) continue;
    if (shouldRunRoi(now, i, intervals[i])) due.push(i);
  }

  var timeStarved =
    (now - (_ocrLastTimeSuccessTs || 0)) >= OCR_TIME_PRIORITY_MS &&
    ((_ocrRoiBackoffUntil[2] || 0) <= now);
  if (timeStarved && due.indexOf(2) === -1) {
    due.push(2);
  }

  if (!due.length) {
    for (var fi = 0; fi < n; fi++) {
      var fallbackIdx = (fi + _ocrQueueCursor) % n;
      if ((_ocrRoiBackoffUntil[fallbackIdx] || 0) <= now) {
        due.push(fallbackIdx);
        break;
      }
    }
  }

  var missing = [];
  if ((!rois[0] || !rois[0].rawText) && ((_ocrRoiBackoffUntil[0] || 0) <= now)) missing.push(0);
  if ((!rois[1] || !rois[1].rawText) && ((_ocrRoiBackoffUntil[1] || 0) <= now)) missing.push(1);
  if ((!rois[2] || !rois[2].rawText) && ((_ocrRoiBackoffUntil[2] || 0) <= now)) missing.push(2);
  for (var mi = 0; mi < missing.length; mi++) {
    if (due.indexOf(missing[mi]) === -1) due.push(missing[mi]);
  }

  due.sort(function (a, b) {
    if (timeStarved) {
      if (a === 2 && b !== 2) return -1;
      if (b === 2 && a !== 2) return 1;
    }
    var lastA = _ocrLastRoiRunTs[a] || 0;
    var lastB = _ocrLastRoiRunTs[b] || 0;
    if (lastA !== lastB) return lastA - lastB;
    return rotationDistance(a) - rotationDistance(b);
  });

  var picked = due[0];
  _ocrQueueCursor = (picked + 1) % n;
  return [picked];
}

function shouldRunRoi(now, idx, intervalMs) {
  return now - (_ocrLastRoiRunTs[idx] || 0) >= intervalMs;
}

function rotationDistance(idx) {
  return (idx - _ocrQueueCursor + OCR_ROI_COUNT) % OCR_ROI_COUNT;
}
