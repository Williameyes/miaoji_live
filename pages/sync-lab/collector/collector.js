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

var STORAGE_KEY_ROIS     = 'sync_lab_rois_v1';
var OCR_MIN_INTERVAL_MS  = 500;  // 2Hz 物理锁
var ROI_MIN_SIZE         = 0.05; // 归一化最小宽/高，防止缩至 0

var DEFAULT_ROIS = [
  { x: 0.05, y: 0.15, w: 0.25, h: 0.20, label: '主队分', rawText: '' },
  { x: 0.70, y: 0.15, w: 0.25, h: 0.20, label: '客队分', rawText: '' },
  { x: 0.30, y: 0.35, w: 0.40, h: 0.18, label: '时间',   rawText: '' },
  { x: 0.70, y: 0.60, w: 0.25, h: 0.15, label: '24秒',   rawText: '' }
];

/** @type {WechatMiniprogram.BLEPeripheralServer | null} */
var _server           = null;
var _connectedDeviceId = '';

/** @type {any} VKSession 实例 */
var _vkSession     = null;
var _lastHandleTs  = 0;   // 2Hz 门控时间戳
var _pendingOcrFrame = null;

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
var _rafPending  = false;
var _rafTouchX   = 0;
var _rafTouchY   = 0;

// ─────────────────────────────────────────────────────────────────────────────

Page({
  data: {
    statusBarHeight: 0,
    /** 登录 + 白名单双重门控 */
    isLogin:        false,
    isInWhitelist:  false,
    // BLE 状态
    bleState:       'idle',
    bleStateText:   '未开启',
    matchCode:      '',
    // 比赛数据
    homeScore:  0,
    awayScore:  0,
    period:     1,
    minutes:    10,
    seconds:    0,
    shotClock:  24,
    // OCR
    ocrEnabled:      false,
    debugMode:       false,
    /** @type {Array<{x,y,w,h,label,rawText,pctStyle}>} */
    rois:            DEFAULT_ROIS.map(function(r) { return Object.assign({}, r); }),
    previewPxW:      0,
    previewPxH:      0,
    selectedRoiIdx: -1,
    debugText:       ''
  },

  // ─── 生命周期 ────────────────────────────────────────

  onLoad: function () {
    var sys = wx.getSystemInfoSync();
    var camW = sys.windowWidth  || 667;
    var camH = sys.windowHeight || 375;
    _previewW = camW;
    _previewH = camH;
    this.setData({
      statusBarHeight: sys.statusBarHeight || 0,
      previewPxW: camW,
      previewPxH: camH
    });
    wx.setKeepScreenOn({ keepScreenOn: true });
    this._checkAccess();
    this._loadRois();
  },

  onCameraError: function (e) {
    console.error('[Collector] camera error', e.detail);
    wx.showToast({ title: '相机启动失败', icon: 'none' });
  },

  onUnload: function () {
    this._stopOcr();
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
    var app  = getApp();
    var gd   = (app && app.globalData) || {};
    var token = REQ.getToken ? REQ.getToken() : wx.getStorageSync('token');
    var isLogin = !!(token || (gd.userInfo && gd.userInfo.openid));

    var whitelist = wx.getStorageSync('sync_lab_whitelist') || [];
    var openid    = (gd.userInfo && gd.userInfo.openid) || wx.getStorageSync('openid') || '';
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
    } catch (e) {}
    this.setData({ rois: _withPctStyle(DEFAULT_ROIS.map(function(r) { return Object.assign({}, r); })) });
  },

  _saveRois: function () {
    var raw = this.data.rois.map(function(r) {
      return { x: r.x, y: r.y, w: r.w, h: r.h, label: r.label, rawText: '' };
    });
    try { wx.setStorageSync(STORAGE_KEY_ROIS, raw); } catch (e) {}
  },

  // ─── ROI 整体拖动 ────────────────────────────────────

  onRoiBodyTouchStart: function (e) {
    var idx   = parseInt(e.currentTarget.dataset.idx, 10);
    var touch = e.touches[0];
    var roi   = this.data.rois[idx];
    _dragging = {
      mode:   'move',
      index:  idx,
      startX: touch.clientX,
      startY: touch.clientY,
      origX:  roi.x,
      origY:  roi.y,
      origW:  roi.w,
      origH:  roi.h
    };
    _rafPending = false;
    this.setData({ selectedRoiIdx: idx });
  },

  onRoiBodyTouchMove: function (e) {
    if (!_dragging || _dragging.mode !== 'move') return;
    _rafTouchX = e.touches[0].clientX;
    _rafTouchY = e.touches[0].clientY;
    if (_rafPending) return;
    _rafPending = true;
    var self = this;
    wx.requestAnimationFrame(function () {
      _rafPending = false;
      if (!_dragging || _dragging.mode !== 'move') return;
      var idx  = _dragging.index;
      var newX = Math.max(0, Math.min(1 - _dragging.origW,
                   _dragging.origX + (_rafTouchX - _dragging.startX) / _previewW));
      var newY = Math.max(0, Math.min(1 - _dragging.origH,
                   _dragging.origY + (_rafTouchY - _dragging.startY) / _previewH));
      var update = {};
      update['rois[' + idx + '].x']        = newX;
      update['rois[' + idx + '].y']        = newY;
      update['rois[' + idx + '].pctStyle'] = _computePctStyle(newX, newY, _dragging.origW, _dragging.origH);
      self.setData(update);
    });
  },

  // ─── ROI 右下角缩放 ──────────────────────────────────

  onRoiResizeTouchStart: function (e) {
    var idx   = parseInt(e.currentTarget.dataset.idx, 10);
    var touch = e.touches[0];
    var roi   = this.data.rois[idx];
    _dragging = {
      mode:   'resize-se',
      index:  idx,
      startX: touch.clientX,
      startY: touch.clientY,
      origX:  roi.x,
      origY:  roi.y,
      origW:  roi.w,
      origH:  roi.h
    };
    _rafPending = false;
    this.setData({ selectedRoiIdx: idx });
  },

  onRoiResizeTouchMove: function (e) {
    if (!_dragging || _dragging.mode !== 'resize-se') return;
    _rafTouchX = e.touches[0].clientX;
    _rafTouchY = e.touches[0].clientY;
    if (_rafPending) return;
    _rafPending = true;
    var self = this;
    wx.requestAnimationFrame(function () {
      _rafPending = false;
      if (!_dragging || _dragging.mode !== 'resize-se') return;
      var idx  = _dragging.index;
      var newW = Math.max(ROI_MIN_SIZE, Math.min(1 - _dragging.origX,
                   _dragging.origW + (_rafTouchX - _dragging.startX) / _previewW));
      var newH = Math.max(ROI_MIN_SIZE, Math.min(1 - _dragging.origY,
                   _dragging.origH + (_rafTouchY - _dragging.startY) / _previewH));
      var update = {};
      update['rois[' + idx + '].w']        = newW;
      update['rois[' + idx + '].h']        = newH;
      update['rois[' + idx + '].pctStyle'] = _computePctStyle(_dragging.origX, _dragging.origY, newW, newH);
      self.setData(update);
    });
  },

  /** 拖动/缩放结束：统一清理并持久化 */
  onRoiTouchEnd: function () {
    _dragging   = null;
    _rafPending = false;
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
    if (this.data.ocrEnabled) {
      this._stopOcr();
      this.setData({ ocrEnabled: false });
    } else {
      this._startOcr();
    }
  },

  onToggleDebug: function () {
    this.setData({ debugMode: !this.data.debugMode });
  },

  _startOcr: function () {
    var self = this;
    if (_vkSession) { this._stopOcr(); }
    _lastHandleTs = 0;

    _vkSession = wx.createVKSession({ track: { OCR: { mode: 1 } } });
    _vkSession.start(function (err) {
      if (err) {
        var msg = (err.errMsg || '').toLowerCase();
        // 过滤 SDK 内部底层报错（saaa_config / node js），不暴露给用户
        var isSdkInternal = msg.indexOf('node js') !== -1 || msg.indexOf('saaa') !== -1;
        if (!isSdkInternal) {
          wx.showToast({ title: 'OCR 启动失败', icon: 'none' });
        }
        console.error('[Collector] VKSession start fail', err);
        _vkSession = null;
        return;
      }
      self.setData({ ocrEnabled: true });
      console.log('[Collector] VKSession started (2Hz throttle)');

      _vkSession.on('addAnchors',    function (a) { if (a && a.length) self._handleOcrAnchors(a); });
      _vkSession.on('updateAnchors', function (a) { if (a && a.length) self._handleOcrAnchors(a); });
    });
  },

  _stopOcr: function () {
    if (_vkSession) {
      try { _vkSession.stop(); } catch (e) {}
      _vkSession = null;
    }
    _lastHandleTs  = 0;
    _pendingOcrFrame = null;
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

    var rois      = this.data.rois;
    var rawTexts  = ['', '', '', ''];
    var debugMode = this.data.debugMode;
    var debugLines = debugMode ? [] : null;

    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      var text   = typeof anchor.text === 'string' ? anchor.text.trim() : '';
      if (!text) continue;
      var pts = anchor.points;
      if (!pts || pts.length < 2) continue;

      var cx = 0, cy = 0;
      for (var p = 0; p < pts.length; p++) { cx += pts[p].x; cy += pts[p].y; }
      cx /= pts.length; cy /= pts.length;

      // 像素坐标归一化
      if (cx > 1 || cy > 1) {
        cx = cx / (_previewW || 667);
        cy = cy / (_previewH || 375);
      }

      if (debugLines) debugLines.push(text + ' (' + cx.toFixed(2) + ',' + cy.toFixed(2) + ')');

      for (var r = 0; r < rois.length; r++) {
        var roi = rois[r];
        if (cx >= roi.x && cx <= roi.x + roi.w && cy >= roi.y && cy <= roi.y + roi.h) {
          rawTexts[r] = rawTexts[r] ? rawTexts[r] + ' ' + text : text;
        }
      }
    }

    // 局部 setData：只更新 rawText（path 语法，不覆盖坐标/pctStyle）
    var update = {};
    for (var ri = 0; ri < rawTexts.length; ri++) {
      update['rois[' + ri + '].rawText'] = rawTexts[ri];
    }
    if (debugLines !== null) {
      update.debugText = debugLines.join('\n');
    }
    this.setData(update);

    // 构造 rois 副本供解析（直接读当前 data.rois，rawText 已在 update 中）
    var parsedRois = rois.map(function(roi, idx) {
      return Object.assign({}, roi, { rawText: rawTexts[idx] });
    });
    this._parseAndMaybeNotify(parsedRois);
  },

  /**
   * 解析 ROI 文字 → 比赛状态；连续两帧一致 + 逻辑校验后更新 UI 并触发 BLE 推送。
   */
  _parseAndMaybeNotify: function (rois) {
    var homeScore = parseScore(rois[0].rawText);
    var awayScore = parseScore(rois[1].rawText);
    var timeInfo  = parseTime(rois[2].rawText);
    var shotClock = parseShotClock(rois[3].rawText);

    if (homeScore === null || awayScore === null) return;

    var frame = {
      homeScore: homeScore,
      awayScore: awayScore,
      period:    this.data.period,
      minutes:   timeInfo ? timeInfo.minutes : this.data.minutes,
      seconds:   timeInfo ? timeInfo.seconds : this.data.seconds,
      shotClock: shotClock !== null ? shotClock : this.data.shotClock
    };

    if (_pendingOcrFrame && framesEqual(_pendingOcrFrame, frame)) {
      var prev = {
        homeScore: this.data.homeScore, awayScore: this.data.awayScore,
        period:    this.data.period,    shotClock: this.data.shotClock
      };
      if (BLE.isLogicallyValid(prev, frame)) {
        this.setData({
          homeScore: frame.homeScore,
          awayScore: frame.awayScore,
          minutes:   frame.minutes,
          seconds:   frame.seconds,
          shotClock: frame.shotClock
        });
        this._notify();
      }
      _pendingOcrFrame = null;
    } else {
      _pendingOcrFrame = frame;
    }
  },

  // ─── BLE：启动 / 停止 ────────────────────────────────

  onStartTap: function () {
    if (this.data.bleState !== 'idle') return;
    var self = this;
    wx.openBluetoothAdapter({
      mode: 'peripheral',
      success: function () { self._createServer(); },
      fail: function (err) {
        wx.showToast({ title: '蓝牙初始化失败', icon: 'none' });
        console.error('[Collector] openBluetoothAdapter fail', err);
      }
    });
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
          properties: { read: true, notify: true },
          permission: {
            read: true, readEncrypted: false,
            write: false, writeEncrypted: false
          },
          value: new ArrayBuffer(BLE.PACKET_LENGTH)
        }]
      },
      success: function () {
        self._bindServerEvents();
        self._startAdv(deviceName);
      },
      fail: function (err) {
        wx.showToast({ title: '注册特征值失败，请重试', icon: 'none' });
        console.error('[Collector] addService fail', err);
      }
    });
  },

  _bindServerEvents: function () {
    var self = this;
    if (!_server) return;

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
        serviceId:        BLE.SERVICE_UUID,
        characteristicId: BLE.CHAR_SCORE_UUID,
        value: BLE.encodePacket({
          homeScore: d.homeScore, awayScore: d.awayScore, period: d.period,
          minutes: d.minutes, seconds: d.seconds, shotClock: d.shotClock
        }),
        needNotify:   false,
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
        deviceName:  deviceName,
        serviceUuids: [BLE.SERVICE_UUID]
      },
      success: function () {
        self.setData({ bleState: 'advertising', bleStateText: '广播中，等待连接…' });
      },
      fail: function (err) {
        wx.showToast({ title: '广播启动失败', icon: 'none' });
        console.error('[Collector] startAdvertising fail', err);
      }
    });
  },

  onStopTap: function () {
    this._stopAll();
    this.setData({ bleState: 'idle', bleStateText: '未开启', matchCode: '' });
  },

  _stopAll: function () {
    try { wx.offBLEPeripheralConnectionStateChanged(); } catch (e) {}
    if (_server) {
      try { _server.stopAdvertising(); } catch (e) {}
      try { _server.close(); } catch (e) {}
      _server = null;
    }
    _connectedDeviceId = '';
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
    if (!_server || !_connectedDeviceId) return;
    var d = this.data;
    _server.writeCharacteristicValue({
      serviceId:        BLE.SERVICE_UUID,
      characteristicId: BLE.CHAR_SCORE_UUID,
      value: BLE.encodePacket({
        homeScore: d.homeScore, awayScore: d.awayScore, period: d.period,
        minutes: d.minutes, seconds: d.seconds, shotClock: d.shotClock
      }),
      needNotify: true,
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
  return 'left:'   + (x * 100).toFixed(1) + '%;' +
         'top:'    + (y * 100).toFixed(1) + '%;' +
         'width:'  + (w * 100).toFixed(1) + '%;' +
         'height:' + (h * 100).toFixed(1) + '%;';
}

/**
 * 为 ROI 数组每个元素补充 pctStyle 字段。
 * @param {Array} rois
 * @returns {Array}
 */
function _withPctStyle(rois) {
  return rois.map(function(r) {
    return Object.assign({}, r, { pctStyle: _computePctStyle(r.x, r.y, r.w, r.h) });
  });
}

/** 从字符串中提取第一个合法比分数字（0-255）。 */
function parseScore(raw) {
  if (!raw) return null;
  var cleaned = raw.replace(/[^0-9]/g, '');
  if (!cleaned) return null;
  var n = parseInt(cleaned, 10);
  if (isNaN(n) || n < 0 || n > 255) return null;
  return n;
}

/** 解析 "分:秒" 格式。 */
function parseTime(raw) {
  if (!raw) return null;
  var parts = raw.replace(/[^0-9]+/g, ':').split(':').filter(function(s) { return s.length > 0; });
  if (parts.length < 2) return null;
  var m = parseInt(parts[0], 10);
  var s = parseInt(parts[1], 10);
  if (isNaN(m) || isNaN(s) || m < 0 || m > 59 || s < 0 || s > 59) return null;
  return { minutes: m, seconds: s };
}

/** 从字符串中提取进攻时钟数值（0-24）。 */
function parseShotClock(raw) {
  if (!raw) return null;
  var cleaned = raw.replace(/[^0-9]/g, '');
  if (!cleaned) return null;
  var n = parseInt(cleaned, 10);
  if (isNaN(n) || n < 0 || n > 24) return null;
  return n;
}

/** 比较两帧是否完全相同（连续帧一致性校验）。 */
function framesEqual(a, b) {
  if (!a || !b) return false;
  return a.homeScore === b.homeScore && a.awayScore === b.awayScore &&
         a.minutes   === b.minutes   && a.seconds   === b.seconds   &&
         a.shotClock === b.shotClock;
}
