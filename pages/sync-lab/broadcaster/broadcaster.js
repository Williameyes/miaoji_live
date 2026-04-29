/**
 * @fileoverview 直播端 (Central / GATT Client)
 * 职责：扫描 "SG_XXXX" 设备、连接、订阅 notify、解码7字节包、更新UI；断线自动重连。
 * v2: 移除 Read Polling，纯靠 Notify 推送。
 */

var BLE = require('../../../utils/ble-protocol.js');

/** 重连间隔（ms）*/
var RECONNECT_INTERVAL_MS = 5000;
/** 扫描超时（ms）*/
var SCAN_TIMEOUT_MS = 20000;

var _reconnectTimer = null;
var _scanTimeoutTimer = null;
var _targetDeviceId = '';
var _targetServiceId = '';
var _targetCharId = '';
var _prevFrame = null; // 上一帧，用于连续帧一致性校验
var _rxPacketCount = 0;

Page({
  data: {
    statusBarHeight: 0,
    /** 'idle' | 'scanning' | 'connecting' | 'connected' | 'reconnecting' */
    bleState: 'idle',
    bleStateText: '未连接',
    matchCodeInput: '',  // 用户输入的4位码
    connectedName: '',
    homeScore: 0,
    awayScore: 0,
    period: 1,
    minutes: 10,
    seconds: 0,
    shotClock: 24,
    /** 收到异常帧时提示 */
    anomalyHint: '',
    rxPacketCount: 0,
    lastFrameText: '',
    lastRxAtText: '',
    debugMode: true
  },

  onLoad: function () {
    var sys = wx.getSystemInfoSync();
    this.setData({ statusBarHeight: sys.statusBarHeight || 0 });
    wx.setKeepScreenOn({ keepScreenOn: true });
    console.log('[Broadcaster] Page Loaded');
  },

  onUnload: function () {
    this._cleanup();
    wx.setKeepScreenOn({ keepScreenOn: false });
    console.log('[Broadcaster] Page Unloaded');
  },

  // ─── 输入匹配码 ─────────────────────────────────────

  onMatchCodeInput: function (e) {
    this.setData({ matchCodeInput: String(e.detail.value || '').replace(/\D/g, '').slice(0, 4) });
  },

  // ─── 开始扫描 ────────────────────────────────────────

  onConnectTap: function () {
    var code = this.data.matchCodeInput;
    if (code.length !== 4) {
      wx.showToast({ title: '请输入采集端4位匹配码', icon: 'none' });
      return;
    }
    if (this.data.bleState !== 'idle') return;
    var self = this;
    this._cleanup(function () {
      self._startScan(BLE.DEVICE_NAME_PREFIX + code);
    });
  },

  _startScan: function (targetName) {
    var self = this;
    _targetDeviceId = '';
    _targetServiceId = '';
    _targetCharId = '';
    _prevFrame = null;
    _rxPacketCount = 0;
    this.setData({ rxPacketCount: 0, lastFrameText: '', lastRxAtText: '', anomalyHint: '' });

    console.log('[Broadcaster] Starting scan for:', targetName);

    wx.openBluetoothAdapter({
      mode: 'central',
      success: function () {
        self.setData({ bleState: 'scanning', bleStateText: '扫描中…' });
        try { wx.offBluetoothDeviceFound(); } catch (e) { }

        // 扫描超时
        _scanTimeoutTimer = setTimeout(function () {
          if (self.data.bleState === 'scanning') {
            wx.stopBluetoothDevicesDiscovery();
            self.setData({ bleState: 'idle', bleStateText: '未找到设备，请重试' });
            console.warn('[Broadcaster] Scan timeout, device not found');
          }
        }, SCAN_TIMEOUT_MS);

        wx.onBluetoothDeviceFound(function (res) {
          var devices = res.devices || [];
          for (var i = 0; i < devices.length; i++) {
            var d = devices[i];
            var name = d.name || d.localName || '';
            if (name === targetName) {
              console.log('[Broadcaster] Device found:', name, 'ID:', d.deviceId);
              wx.stopBluetoothDevicesDiscovery();
              clearTimeout(_scanTimeoutTimer);
              _targetDeviceId = d.deviceId;
              self.setData({ bleState: 'connecting', bleStateText: '连接中…', connectedName: name });
              self._connect();
              break;
            }
          }
        });

        wx.startBluetoothDevicesDiscovery({
          services: [BLE.SERVICE_UUID],
          allowDuplicatesKey: false,
          success: function() {
            console.log('[Broadcaster] Discovery started');
          },
          fail: function (err) {
            self.setData({ bleState: 'idle', bleStateText: '扫描启动失败' });
            console.error('[Broadcaster] startDiscovery fail', err);
          }
        });
      },
      fail: function (err) {
        wx.showToast({ title: '蓝牙初始化失败', icon: 'none' });
        console.error('[Broadcaster] openBluetoothAdapter fail', err);
      }
    });
  },

  // ─── 连接 ────────────────────────────────────────────

  _connect: function () {
    var self = this;
    if (!_targetDeviceId) return;

    console.log('[Broadcaster] Connecting to:', _targetDeviceId);

    wx.createBLEConnection({
      deviceId: _targetDeviceId,
      success: function () {
        console.log('[Broadcaster] Connection success');
        self.setData({ bleState: 'connected', bleStateText: '已连接 ✓' });
        wx.vibrateShort({ type: 'medium' });
        self._bindDisconnectListener();
        self._discoverServices();
      },
      fail: function (err) {
        console.error('[Broadcaster] createBLEConnection fail', err);
        self._scheduleReconnect();
      }
    });
  },

  _bindDisconnectListener: function () {
    var self = this;
    try { wx.offBLEConnectionStateChange(); } catch (e) { }
    wx.onBLEConnectionStateChange(function (res) {
      if (res.deviceId === _targetDeviceId && !res.connected) {
        console.log('[Broadcaster] BLE disconnected res=', res);
        self.setData({ bleState: 'reconnecting', bleStateText: '断线，重连中…' });
        self._scheduleReconnect();
      }
    });
  },

  // ─── 发现服务 & 订阅 notify ───────────────────────────

  _discoverServices: function () {
    var self = this;
    console.log('[Broadcaster] Discovering services for:', _targetDeviceId);
    wx.getBLEDeviceServices({
      deviceId: _targetDeviceId,
      success: function (res) {
        var services = res.services || [];
        console.log('[Broadcaster] Services found:', services.length);
        for (var i = 0; i < services.length; i++) {
          if (services[i].uuid.toLowerCase() === BLE.SERVICE_UUID.toLowerCase()) {
            _targetServiceId = services[i].uuid;
            console.log('[Broadcaster] Target service found:', _targetServiceId);
            self._discoverCharacteristics();
            return;
          }
        }
        console.error('[Broadcaster] Target service not found in list');
        self._scheduleReconnect();
      },
      fail: function (err) {
        console.error('[Broadcaster] getBLEDeviceServices fail', err);
        self._scheduleReconnect();
      }
    });
  },

  _discoverCharacteristics: function () {
    var self = this;
    console.log('[Broadcaster] Discovering characteristics for service:', _targetServiceId);
    wx.getBLEDeviceCharacteristics({
      deviceId: _targetDeviceId,
      serviceId: _targetServiceId,
      success: function (res) {
        var chars = res.characteristics || [];
        console.log('[Broadcaster] Characteristics found:', chars.length);
        for (var i = 0; i < chars.length; i++) {
          var c = chars[i];
          if (c.uuid.toLowerCase() === BLE.CHAR_SCORE_UUID.toLowerCase()) {
            _targetCharId = c.uuid;
            console.log('[Broadcaster] Target characteristic found:', _targetCharId, 'properties:', c.properties);
            self._subscribeNotify(c.uuid);
            return;
          }
        }
        console.error('[Broadcaster] Target characteristic not found in list');
      },
      fail: function (err) {
        console.error('[Broadcaster] getBLEDeviceCharacteristics fail', err);
      }
    });
  },

  _subscribeNotify: function (charId) {
    var self = this;
    console.log('[Broadcaster] Subscribing notify for char:', charId);
    wx.notifyBLECharacteristicValueChange({
      deviceId: _targetDeviceId,
      serviceId: _targetServiceId,
      characteristicId: charId,
      state: true,
      success: function () {
        console.log('[Broadcaster] Notify subscription SUCCESS for char:', charId);
        self._listenValues();
        // 订阅成功后立刻读一次初始值
        self._readCurrentValue(charId);
      },
      fail: function (err) {
        console.error('[Broadcaster] notifyBLECharacteristicValueChange FAIL', err);
        wx.showToast({ title: '通知订阅失败', icon: 'none' });
      }
    });
  },

  _listenValues: function () {
    var self = this;
    console.log('[Broadcaster] Starting to listen for value changes');
    try { wx.offBLECharacteristicValueChange(); } catch (e) { }
    wx.onBLECharacteristicValueChange(function (res) {
      if (res.deviceId !== _targetDeviceId) return;
      
      var hex = toHex(res.value);
      console.log('[Broadcaster] RX Data: char=%s len=%s hex=%s', res.characteristicId, res.value && res.value.byteLength, hex);

      if (!res.value || res.value.byteLength !== BLE.PACKET_LENGTH) {
        console.warn('[Broadcaster] RX Ignored: invalid packet length');
        return;
      }
      var decoded = BLE.decodePacket(res.value);
      if (!decoded) {
        console.error('[Broadcaster] RX Ignored: CRC Checksum fail');
        return;
      }
      _rxPacketCount += 1;
      var nextFrameText = [
        decoded.homeScore + ':' + decoded.awayScore,
        'Q' + decoded.period,
        zeroPad2(decoded.minutes) + ':' + zeroPad2(decoded.seconds),
        '24=' + decoded.shotClock
      ].join(' · ');
      var nextRxAtText = formatClockTime(new Date());
      console.log('[Broadcaster] RX Frame #%s: %s', _rxPacketCount, nextFrameText);
      
      // 纠错：与上一帧比较逻辑合理性
      if (_prevFrame && !BLE.isLogicallyValid(_prevFrame, decoded)) {
        console.warn('[Broadcaster] RX Ignored: Logical validation failed', decoded);
        self.setData({
          anomalyHint: '⚠️ 异常帧，已跳过',
          rxPacketCount: _rxPacketCount,
          lastFrameText: nextFrameText,
          lastRxAtText: nextRxAtText
        });
        wx.vibrateShort({ type: 'light' });
        setTimeout(function () { self.setData({ anomalyHint: '' }); }, 2000);
        return;
      }
      
      _prevFrame = decoded;
      self.setData({
        homeScore: decoded.homeScore,
        awayScore: decoded.awayScore,
        period:    decoded.period,
        minutes:   decoded.minutes,
        seconds:   decoded.seconds,
        shotClock: decoded.shotClock,
        anomalyHint: '',
        rxPacketCount: _rxPacketCount,
        lastFrameText: nextFrameText,
        lastRxAtText: nextRxAtText
      });
    });
  },

  _readCurrentValue: function (charId) {
    console.log('[Broadcaster] Reading current value for char:', charId);
    wx.readBLECharacteristicValue({
      deviceId: _targetDeviceId,
      serviceId: _targetServiceId,
      characteristicId: charId,
      success: function (res) {
        console.log('[Broadcaster] readBLECharacteristicValue triggered');
      },
      fail: function (err) {
        console.warn('[Broadcaster] readBLECharacteristicValue fail', err);
      }
    });
  },

  // ─── 断线重连 ─────────────────────────────────────────

  _scheduleReconnect: function () {
    var self = this;
    clearTimeout(_reconnectTimer);
    if (_targetDeviceId) {
      try { 
        console.log('[Broadcaster] Closing connection for reconnecting...');
        wx.closeBLEConnection({ deviceId: _targetDeviceId }); 
      } catch (e) { }
    }
    this.setData({ bleState: 'reconnecting', bleStateText: '断线，' + (RECONNECT_INTERVAL_MS / 1000) + 's 后重连…' });
    _reconnectTimer = setTimeout(function () {
      if (self.data.bleState === 'reconnecting' && _targetDeviceId) {
        console.log('[Broadcaster] Reconnecting now...');
        self.setData({ bleStateText: '重连中…' });
        self._connect();
      }
    }, RECONNECT_INTERVAL_MS);
  },

  // ─── 断开 ─────────────────────────────────────────────

  onDisconnectTap: function () {
    console.log('[Broadcaster] Manual disconnect requested');
    this._cleanup();
    this.setData({ bleState: 'idle', bleStateText: '未连接', connectedName: '', matchCodeInput: '' });
  },

  _cleanup: function (done) {
    var doneCalled = false;
    var finalize = function () {
      if (doneCalled) return;
      doneCalled = true;
      if (typeof done === 'function') done();
    };

    console.log('[Broadcaster] Cleaning up BLE resources');
    clearTimeout(_reconnectTimer);
    clearTimeout(_scanTimeoutTimer);
    _reconnectTimer = null;
    _scanTimeoutTimer = null;
    try { wx.offBluetoothDeviceFound(); } catch (e) { }
    try { wx.offBLEConnectionStateChange(); } catch (e) {}
    try { wx.offBLECharacteristicValueChange(); } catch (e) {}
    if (_targetDeviceId) {
      try { wx.closeBLEConnection({ deviceId: _targetDeviceId }); } catch (e) {}
    }
    try { wx.stopBluetoothDevicesDiscovery(); } catch (e) {}
    _targetDeviceId = '';
    _targetServiceId = '';
    _targetCharId = '';
    _prevFrame = null;
    _rxPacketCount = 0;
    try {
      wx.closeBluetoothAdapter({
        complete: function () { 
          console.log('[Broadcaster] Bluetooth Adapter closed');
          finalize(); 
        }
      });
    } catch (e) {
      finalize();
    }
  }
});

function zeroPad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function formatClockTime(d) {
  if (!d) return '';
  return [
    zeroPad2(d.getHours()),
    zeroPad2(d.getMinutes()),
    zeroPad2(d.getSeconds())
  ].join(':');
}

function toHex(buf) {
  if (!buf || !buf.byteLength) return '';
  var view = new Uint8Array(buf);
  var out = [];
  for (var i = 0; i < view.length; i++) {
    var hex = view[i].toString(16);
    out.push(hex.length < 2 ? '0' + hex : hex);
  }
  return out.join(' ');
}
