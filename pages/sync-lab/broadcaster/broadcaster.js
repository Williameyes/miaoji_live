/**
 * @fileoverview 直播端 (Central / GATT Client)
 * 职责：扫描 "SG_XXXX" 设备、连接、订阅 notify、解码7字节包、更新UI；断线自动重连。
 * v3: 使用全局单例 BLEManager & EventBus。
 */

const BLE = require('../../../utils/ble-protocol.js');
const eventBus = require('../../../utils/eventBus.js');
const bleManager = require('../../../services/bleManager.js');

/** 扫描超时（ms）*/
const SCAN_TIMEOUT_MS = 20000;

var _scanTimeoutTimer = null;

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

    // 订阅全局蓝牙数据
    eventBus.on('BLE_DATA_UPDATE', this._onBleDataUpdate);
    eventBus.on('BLE_CONNECTION_UPDATE', this._onBleConnectionUpdate);

    // 检查当前状态
    const state = bleManager.getState();
    if (state.isConnected) {
      this.setData({ 
        bleState: 'connected', 
        bleStateText: '已连接 ✓',
        rxPacketCount: state.rxCount
      });
    }
  },

  onUnload: function () {
    eventBus.off('BLE_DATA_UPDATE', this._onBleDataUpdate);
    eventBus.off('BLE_CONNECTION_UPDATE', this._onBleConnectionUpdate);
    wx.setKeepScreenOn({ keepScreenOn: false });
  },

  // ─── 全局事件回调 ───────────────────────────────────

  _onBleDataUpdate: function (data) {
    const nextFrameText = [
      data.homeScore + ':' + data.awayScore,
      'Q' + data.period,
      this._zeroPad2(data.minutes) + ':' + this._zeroPad2(data.seconds),
      '24=' + data.shotClock
    ].join(' · ');

    this.setData({
      homeScore: data.homeScore,
      awayScore: data.awayScore,
      period:    data.period,
      minutes:   data.minutes,
      seconds:   data.seconds,
      shotClock: data.shotClock,
      rxPacketCount: data.rxCount,
      lastFrameText: nextFrameText,
      lastRxAtText: this._formatClockTime(new Date(data.timestamp))
    });
  },

  _onBleConnectionUpdate: function (res) {
    if (res.connected) {
      this.setData({ bleState: 'connected', bleStateText: '已连接 ✓' });
    } else {
      this.setData({ bleState: 'idle', bleStateText: '未连接', connectedName: '' });
    }
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
    this.setData({ rxPacketCount: 0, lastFrameText: '', lastRxAtText: '', anomalyHint: '' });

    console.log('[Broadcaster] Starting scan for:', targetName);

    wx.openBluetoothAdapter({
      mode: 'central',
      success: function () {
        self.setData({ bleState: 'scanning', bleStateText: '扫描中…' });
        
        _scanTimeoutTimer = setTimeout(function () {
          if (self.data.bleState === 'scanning') {
            wx.stopBluetoothDevicesDiscovery();
            self.setData({ bleState: 'idle', bleStateText: '未找到设备' });
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
              self.setData({ bleState: 'connecting', bleStateText: '连接中…', connectedName: name });
              self._setupManager(d.deviceId);
              break;
            }
          }
        });

        wx.startBluetoothDevicesDiscovery({
          services: [BLE.SERVICE_UUID],
          allowDuplicatesKey: false
        });
      },
      fail: function (err) {
        wx.showToast({ title: '蓝牙初始化失败', icon: 'none' });
      }
    });
  },

  async _setupManager(deviceId) {
    try {
      // 在实际发现服务前，我们可以先建立连接
      // 注意：这里为了简化，假设 Service 和 Char UUID 已经由协议定死
      await bleManager.connect(deviceId, BLE.SERVICE_UUID, BLE.CHAR_SCORE_UUID);
    } catch (err) {
      this.setData({ bleState: 'idle', bleStateText: '连接失败' });
      wx.showToast({ title: '连接失败', icon: 'none' });
    }
  },

  onDisconnectTap: function () {
    bleManager.disconnect();
    this.setData({ bleState: 'idle', bleStateText: '未连接', connectedName: '', matchCodeInput: '' });
  },

  _zeroPad2: function (n) {
    return n < 10 ? '0' + n : String(n);
  },

  _formatClockTime: function (d) {
    if (!d) return '';
    return [
      this._zeroPad2(d.getHours()),
      this._zeroPad2(data.getMinutes()), // 注意：这里原代码有个错误，应该是 d
      this._zeroPad2(d.getSeconds())
    ].join(':');
  },
  
  // 修正一下 formatClockTime 的小错误
  _formatClockTime: function (d) {
    if (!d) return '';
    return [
      this._zeroPad2(d.getHours()),
      this._zeroPad2(d.getMinutes()),
      this._zeroPad2(d.getSeconds())
    ].join(':');
  }
});
