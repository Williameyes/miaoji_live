/**
 * @fileoverview 直播端 (Central / GATT Client)
 * 职责：扫描 "SG_XXXX" 设备、连接、订阅 notify、解码7字节包、更新UI；断线自动重连。
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
var _prevFrame = null; // 上一帧，用于连续帧一致性校验

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
    anomalyHint: ''
  },

  onLoad: function () {
    var sys = wx.getSystemInfoSync();
    this.setData({ statusBarHeight: sys.statusBarHeight || 0 });
    wx.setKeepScreenOn({ keepScreenOn: true });
  },

  onUnload: function () {
    this._cleanup();
    wx.setKeepScreenOn({ keepScreenOn: false });
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
    this._startScan(BLE.DEVICE_NAME_PREFIX + code);
  },

  _startScan: function (targetName) {
    var self = this;
    _targetDeviceId = '';
    _targetServiceId = '';
    _prevFrame = null;

    wx.openBluetoothAdapter({
      mode: 'central',
      success: function () {
        self.setData({ bleState: 'scanning', bleStateText: '扫描中…' });

        // 扫描超时
        _scanTimeoutTimer = setTimeout(function () {
          if (self.data.bleState === 'scanning') {
            wx.stopBluetoothDevicesDiscovery();
            self.setData({ bleState: 'idle', bleStateText: '未找到设备，请重试' });
          }
        }, SCAN_TIMEOUT_MS);

        wx.onBluetoothDeviceFound(function (res) {
          var devices = res.devices || [];
          for (var i = 0; i < devices.length; i++) {
            var d = devices[i];
            var name = d.name || d.localName || '';
            if (name === targetName) {
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

    wx.createBLEConnection({
      deviceId: _targetDeviceId,
      success: function () {
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
    wx.onBLEConnectionStateChange(function (res) {
      if (res.deviceId === _targetDeviceId && !res.connected) {
        console.log('[Broadcaster] disconnected, will reconnect');
        self.setData({ bleState: 'reconnecting', bleStateText: '断线，重连中…' });
        self._scheduleReconnect();
      }
    });
  },

  // ─── 发现服务 & 订阅 notify ───────────────────────────

  _discoverServices: function () {
    var self = this;
    wx.getBLEDeviceServices({
      deviceId: _targetDeviceId,
      success: function (res) {
        var services = res.services || [];
        for (var i = 0; i < services.length; i++) {
          if (services[i].uuid.toLowerCase() === BLE.SERVICE_UUID.toLowerCase()) {
            _targetServiceId = services[i].uuid;
            self._discoverCharacteristics();
            return;
          }
        }
        console.error('[Broadcaster] service not found');
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
    wx.getBLEDeviceCharacteristics({
      deviceId: _targetDeviceId,
      serviceId: _targetServiceId,
      success: function (res) {
        var chars = res.characteristics || [];
        for (var i = 0; i < chars.length; i++) {
          var c = chars[i];
          if (c.uuid.toLowerCase() === BLE.CHAR_SCORE_UUID.toLowerCase()) {
            self._subscribeNotify(c.uuid);
            return;
          }
        }
        console.error('[Broadcaster] characteristic not found');
      },
      fail: function (err) {
        console.error('[Broadcaster] getBLEDeviceCharacteristics fail', err);
      }
    });
  },

  _subscribeNotify: function (charId) {
    var self = this;
    wx.notifyBLECharacteristicValueChange({
      deviceId: _targetDeviceId,
      serviceId: _targetServiceId,
      characteristicId: charId,
      state: true,
      success: function () {
        console.log('[Broadcaster] notify subscribed');
        self._listenValues();
      },
      fail: function (err) {
        console.error('[Broadcaster] notifyBLECharacteristicValueChange fail', err);
      }
    });
  },

  _listenValues: function () {
    var self = this;
    wx.onBLECharacteristicValueChange(function (res) {
      if (res.deviceId !== _targetDeviceId) return;
      var decoded = BLE.decodePacket(res.value);
      if (!decoded) {
        console.warn('[Broadcaster] XOR checksum fail, frame dropped');
        return;
      }
      // 纠错：与上一帧比较逻辑合理性
      if (_prevFrame && !BLE.isLogicallyValid(_prevFrame, decoded)) {
        self.setData({ anomalyHint: '⚠️ 异常帧，已跳过' });
        wx.vibrateShort({ type: 'light' });
        setTimeout(function () { self.setData({ anomalyHint: '' }); }, 2000);
        console.warn('[Broadcaster] logically invalid frame, skipped', decoded);
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
        anomalyHint: ''
      });
    });
  },

  // ─── 断线重连 ─────────────────────────────────────────

  _scheduleReconnect: function () {
    var self = this;
    clearTimeout(_reconnectTimer);
    this.setData({ bleState: 'reconnecting', bleStateText: '断线，' + (RECONNECT_INTERVAL_MS / 1000) + 's 后重连…' });
    _reconnectTimer = setTimeout(function () {
      if (self.data.bleState === 'reconnecting' && _targetDeviceId) {
        self.setData({ bleStateText: '重连中…' });
        self._connect();
      }
    }, RECONNECT_INTERVAL_MS);
  },

  // ─── 断开 ─────────────────────────────────────────────

  onDisconnectTap: function () {
    this._cleanup();
    this.setData({ bleState: 'idle', bleStateText: '未连接', connectedName: '', matchCodeInput: '' });
  },

  _cleanup: function () {
    clearTimeout(_reconnectTimer);
    clearTimeout(_scanTimeoutTimer);
    _reconnectTimer = null;
    _scanTimeoutTimer = null;
    try { wx.offBLEConnectionStateChange(); } catch (e) {}
    try { wx.offBLECharacteristicValueChange(); } catch (e) {}
    if (_targetDeviceId) {
      try { wx.closeBLEConnection({ deviceId: _targetDeviceId }); } catch (e) {}
    }
    try { wx.stopBluetoothDevicesDiscovery(); } catch (e) {}
    try { wx.closeBluetoothAdapter(); } catch (e) {}
    _targetDeviceId = '';
    _targetServiceId = '';
    _prevFrame = null;
  }
});
