/**
 * @fileoverview 采集端 (Peripheral / GATT Server + VisionKit OCR)
 *
 * Phase 3 v2：
 *   - 2Hz 时间戳门控（_lastHandleTs），严禁 30 帧暴力采集
 *   - ROI 拖动/缩放拆分：mode 'move' | 'resize-se'
 *   - wx.requestAnimationFrame 节流 touchmove（局部 setData，path 语法）
 *   - OCR 锚点局部更新（只写 rawText，不覆盖坐标）
 *   - 登录 + 白名单双重门控（isLogin && isInWhitelist）
 *   - VKSession 错误过滤（saaa/node js 底层错误不弹 Toast）
 *   - BLE 校验升级为 CRC-8/SMBUS（ble-protocol.js v2）
 *
 * ROI 选区数据结构（归一化坐标，相对于相机预览区）：
 *   { x: 0-1, y: 0-1, w: 0-1, h: 0-1, label: string, rawText: string, pctStyle: string }
 */

var BLE = require('../../../utils/ble-protocol.js');
var REQ = require('../../../utils/request.js');

var STORAGE_KEY_ROIS = 'sync_lab_rois_v1';
var OCR_MIN_INTERVAL_MS = 240;
var OCR_PUMP_INTERVAL_MS = 120;
var OCR_RUN_TIMEOUT_MS = 180;
var OCR_TIME_REFRESH_MS = 240;
var OCR_SHOT_REFRESH_MS = 420;
var OCR_SCORE_REFRESH_MS = 600;
var ROI_MIN_SIZE = 0.05; // 归一化最小宽/高，防止缩至 0

var DEFAULT_ROIS = [
  { x: 0.05, y: 0.15, w: 0.25, h: 0.20, label: '主队分', rawText: '' },
  { x: 0.70, y: 0.15, w: 0.25, h: 0.20, label: '客队分', rawText: '' },
  { x: 0.30, y: 0.35, w: 0.40, h: 0.18, label: '时间', rawText: '' },
  { x: 0.70, y: 0.60, w: 0.25, h: 0.15, label: '24秒', rawText: '' }
];

/** @type {WechatMiniprogram.BLEPeripheralServer | null} */
var _server = null;
var _connectedDeviceId = '';
var _cameraContext = null;
var _cameraFrameListener = null;

/** @type {any} VKSession 实例 */
var _vkSession = null;
var _lastHandleTs = 0;   // 2Hz 门控时间戳
var _pendingOcrFrame = null;
var _lastCommittedFrameKey = '';
var _bleStarting = false;
var _ocrBootTimer = 0;
var _ocrSessionToken = 0;
var _ocrAnchorWatchdogTimer = 0;
var _ocrAnchorEventCount = 0;
var _ocrAnchorLogSeq = 0;
var _ocrPumpTimer = 0;
var _ocrPumpFrameCount = 0;
var _ocrPumpLastTickTs = 0;
var _ocrRunBusy = false;
var _ocrRunLastTs = 0;
var _ocrRunState = null;
var _ocrRunTimeout = 0;
var _lastCommittedFrame = null;
var _lastRejectedStableFrameKey = '';
var _lastRejectedStableFrameCount = 0;
var _ocrLastRoiRunTs = [0, 0, 0, 0];

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
      if (saved && Array.isArray(saved) && saved.length === 4) {
        this.setData({ rois: _withPctStyle(saved) });
        return;
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
    _ocrAnchorLogSeq = 0;
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
      console.log('[Collector] VKSession started (2Hz throttle)');
      _ocrAnchorWatchdogTimer = setTimeout(function () {
        if (_vkSession === session && _ocrAnchorEventCount === 0) {
          console.warn('[Collector][OCR] no anchor events within 3000ms after start');
        }
      }, 3000);

      session.on('updateAnchors', function (a) {
        if (_vkSession !== session) return;
        self._onOcrRunResult(a);
      });
      self._startOcrFramePump(session, token);
    });
  },

  _onOcrRunResult: function (anchors) {
    _ocrAnchorEventCount += 1;
    var list = Array.isArray(anchors) ? anchors : [];
    if (_ocrAnchorLogSeq < 12) {
      var sample = list.length ? summarizeAnchorForLog(list[0]) : null;
      console.log('[Collector][OCR] event=updateAnchors seq=%s count=%s sample=%o', _ocrAnchorEventCount, list.length, sample);
      _ocrAnchorLogSeq += 1;
    } else if (_ocrAnchorEventCount % 10 === 0) {
      console.log('[Collector][OCR] event=updateAnchors seq=%s count=%s', _ocrAnchorEventCount, list.length);
    }

    if (!_ocrRunState || !_ocrRunBusy) {
      console.log('[Collector][OCR] unexpected anchor event outside manual run');
      return;
    }

    if (_ocrRunTimeout) {
      clearTimeout(_ocrRunTimeout);
      _ocrRunTimeout = 0;
    }

    var roiIdx = _ocrRunState.currentIdx;
    var text = collectAnchorTexts(list).join(' ').trim();
    console.log('[Collector][OCR] roi result idx=%s label=%s text=%s', roiIdx, this.data.rois[roiIdx] && this.data.rois[roiIdx].label, text);
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
        if (_ocrPumpFrameCount <= 3 || _ocrPumpFrameCount % 20 === 0) {
          console.log('[Collector][OCR] pump seq=%s frame=%s size=%sx%s', _ocrPumpFrameCount, !!(frame && frame.data), frameW, frameH);
        }
        if (frame && frame.data && frameW > 0 && frameH > 0) {
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
    _ocrRunState = {
      session: session,
      token: token,
      frameWidth: frameW,
      frameHeight: frameH,
      rgba: new Uint8Array(rgbaBuffer),
      rawTexts: this.data.rois.map(function (roi) { return roi.rawText || ''; }),
      queue: buildOcrQueue(now, this.data.rois),
      queuePos: 0,
      currentIdx: -1
    };
    if (!_ocrRunState.queue.length) return;
    console.log('[Collector][OCR] queue=%o', _ocrRunState.queue.map(function (idx) { return idx + ':' + ((_ocrRunState.rawTexts[idx] && _ocrRunState.rawTexts[idx].slice(0, 12)) || ''); }));
    console.log('[Collector][OCR] manual run start frame=%sx%s bytes=%s', frameW, frameH, rgbaBuffer.byteLength);
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

    console.log('[Collector][OCR] runOCR idx=%s label=%s variant=%s/%s crop=%sx%s', state.currentIdx, roi.label, state.currentVariantPos + 1, state.currentVariants.length, crop.width, crop.height);
    _ocrLastRoiRunTs[state.currentIdx] = Date.now();
    _ocrRunTimeout = setTimeout(function () {
      console.warn('[Collector][OCR] runOCR timeout idx=%s label=%s', state.currentIdx, roi.label);
      _ocrRunTimeout = 0;
      if (!_ocrRunState) return;
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
      console.error('[Collector][OCR] runOCR fail idx=%s label=%s err=%o', state.currentIdx, roi.label, eRun);
      this._advanceCurrentVariantOrQueue('fail');
    }
  },

  _advanceCurrentVariantOrQueue: function (reason) {
    var state = _ocrRunState;
    if (!state) return;
    if (state.currentVariants && state.currentVariantPos + 1 < state.currentVariants.length) {
      state.currentVariantPos += 1;
      console.log('[Collector][OCR] retry variant idx=%s label=%s reason=%s next=%s/%s', state.currentIdx, this.data.rois[state.currentIdx] && this.data.rois[state.currentIdx].label, reason, state.currentVariantPos + 1, state.currentVariants.length);
      this._runCurrentVariant();
      return;
    }
    state.queuePos += 1;
    this._runNextRoiOcr();
  },

  _shouldRetryCurrentVariant: function (roiIdx, text) {
    var state = _ocrRunState;
    if (!state || !state.currentVariants || state.currentVariants.length <= 1) return false;
    if (roiIdx === 3) {
      return parseShotClock(text) === null;
    }
    if (roiIdx === 0 || roiIdx === 1) {
      return parseScore(text) === null;
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
    if (!state || aborted) return;
    console.log('[Collector][OCR] manual run done roiTexts=%o', state.rawTexts);
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
    if (_ocrAnchorWatchdogTimer) {
      clearTimeout(_ocrAnchorWatchdogTimer);
      _ocrAnchorWatchdogTimer = 0;
    }
    if (_ocrRunTimeout) {
      clearTimeout(_ocrRunTimeout);
      _ocrRunTimeout = 0;
    }
    _ocrAnchorEventCount = 0;
    _ocrAnchorLogSeq = 0;
    _ocrRunBusy = false;
    _ocrRunState = null;
    _ocrRunLastTs = 0;
    _ocrLastRoiRunTs = [0, 0, 0, 0];
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

    console.log('[Collector][OCR] roiTexts=%o', rawTexts);
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

  // ─── OCR 锚点处理（2Hz 门控 + 局部 setData）────────

  /**
   * 2Hz 物理锁定：距上次处理不足 500ms 直接丢弃，不做任何计算。
   * setData 仅更新各 ROI 的 rawText，不触碰坐标/pctStyle。
   * debugText 仅在 debugMode 开启时写入。
   */
  _handleOcrAnchors: function (anchors) {
    var now = Date.now();
    if (now - _lastHandleTs < OCR_MIN_INTERVAL_MS) return;
    _lastHandleTs = now;

    if (!anchors || !anchors.length) {
      console.log('[Collector][OCR] gate pass but anchors empty');
    }

    var rois = this.data.rois;
    var rawTexts = ['', '', '', ''];
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
    console.log('[Collector][OCR] roiTexts=%o', rawTexts);
    this._applyParsedPreview(parsedRois);
    this._parseAndMaybeNotify(parsedRois);
  },

  _applyParsedPreview: function (rois) {
    var next = {};
    var changed = false;
    var homeScore = parseScore(rois[0].rawText);
    var awayScore = parseScore(rois[1].rawText);
    var timeInfo = parseTime(rois[2].rawText);
    var period = parsePeriod(rois[2].rawText);
    var shotClock = parseShotClock(rois[3].rawText);

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
    if (period !== null && period !== this.data.period) {
      next.period = period;
      changed = true;
    }
    if (shotClock !== null && shotClock !== this.data.shotClock) {
      next.shotClock = shotClock;
      changed = true;
    }

    if (!changed) return;
    console.log('[Collector][OCR] preview update=%o', next);
    this.setData(next);
  },

  /**
   * 解析 ROI 文字 → 比赛状态；联调阶段只做去重，拿到有效数值就立刻推送。
   */
  _parseAndMaybeNotify: function (rois) {
    var homeScore = parseScore(rois[0].rawText);
    var awayScore = parseScore(rois[1].rawText);
    var timeInfo = parseTime(rois[2].rawText);
    var period = parsePeriod(rois[2].rawText);
    var shotClock = parseShotClock(rois[3].rawText);

    if (homeScore === null || awayScore === null) {
      console.log('[Collector][OCR] parse skip home=%s away=%s raw=%o', homeScore, awayScore, rois.map(function (r) { return r.rawText; }));
      return;
    }

    var frame = {
      homeScore: homeScore,
      awayScore: awayScore,
      period: period !== null ? period : this.data.period,
      minutes: timeInfo ? timeInfo.minutes : this.data.minutes,
      seconds: timeInfo ? timeInfo.seconds : this.data.seconds,
      shotClock: shotClock !== null ? shotClock : this.data.shotClock
    };
    var frameKey = buildFrameKey(frame);
    console.log('[Collector][OCR] parsed frame=%o key=%s', frame, frameKey);
    if (frameKey === _lastCommittedFrameKey) {
      return;
    }
    console.log('[Collector][OCR] immediate commit=%o prev=%o', frame, _lastCommittedFrame);
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
        self.setData({ bleState: 'connected', bleStateText: '已连接 ✓' });
        wx.vibrateShort({ type: 'medium' });
        console.log('[Collector] Central connected:', _connectedDeviceId);
      } else {
        _connectedDeviceId = '';
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

  onHomeScorePlus: function () { this.setData({ homeScore: this.data.homeScore + 1 }); this._notify(); },
  onAwayScorePlus: function () { this.setData({ awayScore: this.data.awayScore + 1 }); this._notify(); },
  onPeriodPlus: function () {
    if (this.data.period < 8) this.setData({ period: this.data.period + 1 });
    this._notify();
  },
  onReset: function () {
    this.setData({ homeScore: 0, awayScore: 0, period: 1, minutes: 10, seconds: 0, shotClock: 24 });
    this._notify();
  },

  // ─── BLE 推送 notify ─────────────────────────────────

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
    var d = this.data;
    _server.writeCharacteristicValue({
      serviceId: BLE.SERVICE_UUID,
      characteristicId: BLE.CHAR_SCORE_UUID,
      value: BLE.encodePacket({
        homeScore: d.homeScore, awayScore: d.awayScore, period: d.period,
        minutes: d.minutes, seconds: d.seconds, shotClock: d.shotClock
      }),
      needNotify: true,
      success: function () { console.log('[Collector] notify ok', d.homeScore, d.awayScore, d.minutes, d.seconds, d.shotClock); },
      fail: function (err) { console.warn('[Collector] notify fail', err); }
    });
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

/** 从字符串中提取第一个合法比分数字（0-255）。 */
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

  var candidate = filtered[0].digits;
  for (var i = 1; i < filtered.length; i++) {
    if (filtered[i].digits.length > candidate.length) {
      candidate = filtered[i].digits;
      continue;
    }
    if (filtered[i].digits.length === candidate.length) {
      candidate = filtered[i].digits;
    }
  }
  var n = parseInt(candidate, 10);
  if (isNaN(n) || n < 0 || n > 255) return null;
  return n;
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
  if (isNaN(m) || isNaN(s) || m < 0 || m > 59 || s < 0 || s > 59) return null;
  return { minutes: m, seconds: s };
}

function parsePeriod(raw) {
  if (!raw) return null;
  var text = String(raw);
  var match = text.match(/第\s*(\d)\s*[节节]/);
  if (match) {
    var n = parseInt(match[1], 10);
    if (!isNaN(n) && n >= 1 && n <= 8) return n;
  }
  var fallback = text.match(/\b([1-8])\b(?=.*[节QqPp])/);
  if (fallback) {
    var p = parseInt(fallback[1], 10);
    if (!isNaN(p) && p >= 1 && p <= 8) return p;
  }
  return null;
}

/** 从字符串中提取进攻时钟数值（0-24）。 */
function parseShotClock(raw) {
  if (!raw) return null;
  var matches = String(raw).match(/\d{1,2}/g);
  if (!matches || !matches.length) return null;
  var n = parseInt(matches[matches.length - 1], 10);
  if (isNaN(n) || n < 0 || n > 24) return null;
  return n;
}

/** 比较两帧是否完全相同（连续帧一致性校验）。 */
function framesEqual(a, b) {
  if (!a || !b) return false;
  return a.homeScore === b.homeScore && a.awayScore === b.awayScore &&
    a.minutes === b.minutes && a.seconds === b.seconds &&
    a.shotClock === b.shotClock;
}

/**
 * 连续两次 OCR 不要求整帧完全相同。
 * 只要比分/节次一致，且比赛时钟与 24 秒处于合理递减范围内，就认为可以提交最新帧。
 */
function framesStableEnough(a, b) {
  if (!a || !b) return false;
  if (a.homeScore !== b.homeScore || a.awayScore !== b.awayScore || a.period !== b.period) {
    return false;
  }

  var gameClockDelta = Math.abs(frameClockSeconds(a) - frameClockSeconds(b));
  if (gameClockDelta > 3) return false;

  var shotDelta = Math.abs((a.shotClock || 0) - (b.shotClock || 0));
  if (shotDelta <= 4) return true;

  return b.shotClock === 24 || b.shotClock === 14;
}

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

function frameClockSeconds(frame) {
  if (!frame) return 0;
  return ((Number(frame.minutes) || 0) * 60) + (Number(frame.seconds) || 0);
}

function shouldForceResyncFromStableFrame(prev, next) {
  if (!prev || !next) return false;
  if (prev.period !== next.period) return false;
  if (next.homeScore > 255 || next.awayScore > 255) return false;
  if (next.shotClock < 0 || next.shotClock > 24) return false;

  var scoreDrop = (prev.homeScore - next.homeScore) + (prev.awayScore - next.awayScore);
  if (scoreDrop < 4) return false;

  var nextClock = frameClockSeconds(next);
  if (nextClock <= 0) return false;

  return true;
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
      expandRect(rect, frameWidth, frameHeight, { dx: -0.28, dy: -0.04, dw: 0.24, dh: 0.08 }),
      expandRect(rect, frameWidth, frameHeight, { dx: -0.12, dy: -0.08, dw: 0.18, dh: 0.14 })
    ]);
  }
  if (roi.label === '客队分') {
    return buildCropVariants(rgba, frameWidth, frameHeight, [
      rect,
      expandRect(rect, frameWidth, frameHeight, { dx: 0.06, dy: -0.04, dw: 0.24, dh: 0.10 }),
      expandRect(rect, frameWidth, frameHeight, { dx: -0.08, dy: -0.10, dw: 0.18, dh: 0.16 })
    ]);
  }
  if (roi.label !== '24秒') {
    var single = cropRgbaRect(rgba, frameWidth, frameHeight, rect);
    return single ? [single] : [];
  }
  return buildCropVariants(rgba, frameWidth, frameHeight, [
    rect,
    expandRect(rect, frameWidth, frameHeight, { dx: -0.08, dy: -0.08, dw: 0.12, dh: 0.12 }),
    expandRect(rect, frameWidth, frameHeight, { dx: 0.12, dy: -0.10, dw: 0.18, dh: 0.16 }),
    expandRect(rect, frameWidth, frameHeight, { dx: -0.14, dy: 0.00, dw: 0.20, dh: 0.10 })
  ]);
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
    x = x + Math.floor(w * 0.36);
    w = Math.max(8, Math.floor(w * 0.64));
  } else if (roi.label === '客队分') {
    x = Math.max(0, x - Math.floor(w * 0.12));
    y = Math.max(0, y - Math.floor(h * 0.08));
    w = Math.min(frameWidth - x, Math.floor(w * 1.08));
    h = Math.min(frameHeight - y, Math.floor(h * 1.16));
  } else if (roi.label === '时间') {
    y = y + Math.floor(h * 0.20);
    h = Math.max(8, Math.floor(h * 0.72));
  } else if (roi.label === '24秒') {
    x = Math.max(0, x - Math.floor(w * 0.25));
    y = Math.max(0, y - Math.floor(h * 0.22));
    w = Math.min(frameWidth - x, Math.floor(w * 1.55));
    h = Math.min(frameHeight - y, Math.floor(h * 1.55));
  }

  var padX = Math.max(2, Math.floor(w * (roi.label === '24秒' ? 0.10 : 0.05)));
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
  var queue = [];
  if (shouldRunRoi(now, 2, OCR_TIME_REFRESH_MS)) queue.push(2);
  if (shouldRunRoi(now, 3, OCR_SHOT_REFRESH_MS)) queue.push(3);
  if (shouldRunRoi(now, 0, OCR_SCORE_REFRESH_MS)) queue.push(0);
  if (shouldRunRoi(now, 1, OCR_SCORE_REFRESH_MS)) queue.push(1);

  if (!queue.length) queue.push(2);

  if ((!rois[1] || !rois[1].rawText) && queue.indexOf(1) === -1) {
    queue.push(1);
  }
  if ((!rois[3] || !rois[3].rawText) && queue.indexOf(3) === -1) {
    queue.splice(Math.min(1, queue.length), 0, 3);
  }
  return queue;
}

function shouldRunRoi(now, idx, intervalMs) {
  return now - (_ocrLastRoiRunTs[idx] || 0) >= intervalMs;
}
