/**
 * @fileoverview 全局单例蓝牙管理器 (BLE Manager)
 * 职责：维护连接状态、监听数据更新、全局分发解析后的比分数据。
 */

const BLE = require('../utils/ble-protocol.js');
const eventBus = require('../utils/eventBus.js');

class BLEManager {
  constructor() {
    if (BLEManager.instance) {
      return BLEManager.instance;
    }

    // 状态维护
    this.deviceId = '';
    this.serviceId = '';
    this.characteristicId = '';
    this.characteristicProperties = null;
    this.isConnected = false;
    this.bleState = 'idle'; // idle, scanning, connecting, connected, reconnecting

    this._rxPacketCount = 0;

    /**
     * 上一次 emit 的时间戳（ms），用于节流窗口判定。
     * @type {number}
     */
    this._lastEmitTime = 0;
    /**
     * 上一次已 emit 的解码数据快照（与下一次 decoded 做脏检查比对）。
     * 注意：脏检查不纳入 rxCount / timestamp 等高频变化字段。
     * @type {?object}
     */
    this._lastEmittedData = null;
    /**
     * 节流挂起的 trailing emit 定时器（保证停流瞬间最后一帧仍能送达）。
     * @type {?number}
     */
    this._emitTimer = null;

    this._onWxBleConnectionStateChangeBound = this._onWxBleConnectionStateChange.bind(this);
    this._onWxBleCharacteristicValueChangeBound = this._onWxBleCharacteristicValueChange.bind(this);

    BLEManager.instance = this;
  }

  /**
   * 微信底层：连接状态回调（需固定引用以便 off）。
   * @param {WechatMiniprogram.OnBLEConnectionStateChangeListenerResult} res
   * @returns {void}
   */
  _onWxBleConnectionStateChange(res) {
    if (res.deviceId === this.deviceId && !res.connected) {
      console.log('[BLEManager] BLE Disconnected');
      this.isConnected = false;
      this.bleState = 'idle';
      this._resetEmitThrottleState();
      eventBus.emit('BLE_CONNECTION_UPDATE', { connected: false });
    }
  }

  /**
   * 微信底层：特征值 notify 回调（需固定引用以便 off）。
   * @param {WechatMiniprogram.OnBLECharacteristicValueChangeListenerResult} res
   * @returns {void}
   */
  _onWxBleCharacteristicValueChange(res) {
    if (res.deviceId !== this.deviceId) return;
    if (res.characteristicId !== this.characteristicId) return;

    const buffer = res.value;
    if (!buffer || buffer.byteLength !== BLE.PACKET_LENGTH) {
      return;
    }

    const decoded = BLE.decodePacket(buffer);
    if (!decoded) {
      console.warn('[BLEManager] CRC Checksum failed, dropping frame');
      return;
    }

    this._rxPacketCount++;

    const last = this._lastEmittedData;
    const isDirty = !last
      || decoded.homeScore !== last.homeScore
      || decoded.awayScore !== last.awayScore
      || decoded.minutes !== last.minutes
      || decoded.seconds !== last.seconds
      || decoded.period !== last.period
      || decoded.shotClock !== last.shotClock
      || decoded.ocrEnabled !== last.ocrEnabled;

    if (!isDirty) {
      return;
    }

    const payload = {
      homeScore: decoded.homeScore,
      awayScore: decoded.awayScore,
      period: decoded.period,
      minutes: decoded.minutes,
      seconds: decoded.seconds,
      shotClock: decoded.shotClock,
      ocrEnabled: !!decoded.ocrEnabled,
      ocrTransitioning: !!decoded.ocrTransitioning,
      rxCount: this._rxPacketCount,
      timestamp: Date.now()
    };

    const now = Date.now();
    const since = now - this._lastEmitTime;
    const THROTTLE_MS = 250;
    if (since < THROTTLE_MS) {
      if (this._emitTimer) {
        clearTimeout(this._emitTimer);
        this._emitTimer = null;
      }
      const trailingDecoded = decoded;
      const trailingPayload = payload;
      this._emitTimer = setTimeout(() => {
        this._emitTimer = null;
        this._lastEmitTime = Date.now();
        this._lastEmittedData = trailingDecoded;
        trailingPayload.timestamp = this._lastEmitTime;
        eventBus.emit('BLE_DATA_UPDATE', trailingPayload);
      }, THROTTLE_MS - since);
      return;
    }

    if (this._emitTimer) {
      clearTimeout(this._emitTimer);
      this._emitTimer = null;
    }
    this._lastEmitTime = now;
    this._lastEmittedData = decoded;
    eventBus.emit('BLE_DATA_UPDATE', payload);
  }

  /**
   * 移除本管理器注册的微信 BLE 监听，避免断开后仍触发回调。
   * @returns {void}
   */
  _removeWxBleListeners() {
    try {
      wx.offBLECharacteristicValueChange(this._onWxBleCharacteristicValueChangeBound);
    } catch (e0) { }
    try {
      wx.offBLEConnectionStateChange(this._onWxBleConnectionStateChangeBound);
    } catch (e1) { }
  }

  /**
   * 初始化并开始连接
   * @param {string} targetDeviceId
   * @param {string} targetServiceId
   * @param {string} targetCharId
   */
  async connect(targetDeviceId, targetServiceId, targetCharId) {
    this.deviceId = targetDeviceId;
    this.targetServiceId = targetServiceId.toLowerCase();
    this.targetCharId = targetCharId.toLowerCase();

    console.log('[BLEManager] Connecting to device:', targetDeviceId);

    try {
      wx.offBLEConnectionStateChange(this._onWxBleConnectionStateChangeBound);
      wx.onBLEConnectionStateChange(this._onWxBleConnectionStateChangeBound);

      await wx.createBLEConnection({ deviceId: targetDeviceId });
      this.isConnected = true;
      this.bleState = 'connected';
      console.log('[BLEManager] Connection success');

      await this._discoverServices();

      await this._subscribeNotify();

      eventBus.emit('BLE_CONNECTION_UPDATE', { connected: true, deviceId: targetDeviceId });
      return true;
    } catch (err) {
      console.error('[BLEManager] Connection flow failed:', err);
      this.bleState = 'idle';
      this.isConnected = false;
      try {
        await wx.closeBLEConnection({ deviceId: targetDeviceId });
      } catch (e) { }
      this._removeWxBleListeners();
      this.deviceId = '';
      this.serviceId = '';
      this.characteristicId = '';
      this.characteristicProperties = null;
      this._resetEmitThrottleState();
      throw err;
    }
  }

  /**
   * 发现服务与特征值
   */
  async _discoverServices() {
    console.log('[BLEManager] Discovering services...');
    const res = await wx.getBLEDeviceServices({ deviceId: this.deviceId });
    const services = res.services || [];

    let foundService = null;
    for (const s of services) {
      if (s.uuid.toLowerCase() === this.targetServiceId) {
        foundService = s.uuid;
        break;
      }
    }

    if (!foundService) {
      throw new Error('Target service not found');
    }
    this.serviceId = foundService;
    console.log('[BLEManager] Service found:', this.serviceId);

    const resChars = await wx.getBLEDeviceCharacteristics({
      deviceId: this.deviceId,
      serviceId: this.serviceId
    });
    const chars = resChars.characteristics || [];
    let foundChar = null;
    let foundCharProperties = null;
    for (const c of chars) {
      if (c.uuid.toLowerCase() === this.targetCharId) {
        foundChar = c.uuid;
        foundCharProperties = c.properties || null;
        break;
      }
    }

    if (!foundChar) {
      throw new Error('Target characteristic not found');
    }
    this.characteristicId = foundChar;
    this.characteristicProperties = foundCharProperties;
    console.log('[BLEManager] Characteristic found:', this.characteristicId, foundCharProperties);
  }

  /**
   * 订阅特征值变化通知
   */
  async _subscribeNotify() {
    console.log('[BLEManager] Subscribing to notify:', this.characteristicId);

    try {
      await wx.notifyBLECharacteristicValueChange({
        deviceId: this.deviceId,
        serviceId: this.serviceId,
        characteristicId: this.characteristicId,
        state: true
      });

      console.log('[BLEManager] Notify subscription SUCCESS');
      this._startListening();

      wx.readBLECharacteristicValue({
        deviceId: this.deviceId,
        serviceId: this.serviceId,
        characteristicId: this.characteristicId
      });
    } catch (err) {
      console.error('[BLEManager] Notify subscription FAILED:', err);
      throw err;
    }
  }

  /**
   * 启动数据监听
   */
  _startListening() {
    console.log('[BLEManager] Starting value change listener');
    wx.offBLECharacteristicValueChange(this._onWxBleCharacteristicValueChangeBound);
    wx.onBLECharacteristicValueChange(this._onWxBleCharacteristicValueChangeBound);
  }

  /**
   * 断开 GATT 连接并清理本端连接态（不关闭系统蓝牙适配器，供快连「断旧连新」等场景复用）。
   * @returns {Promise<void>}
   */
  async disconnect() {
    if (!this.deviceId) return;

    try {
      await wx.closeBLEConnection({ deviceId: this.deviceId });
    } catch (err) {
      console.error('[BLEManager] Disconnect failed:', err);
    }
    this.isConnected = false;
    this.bleState = 'idle';
    this._removeWxBleListeners();
    this.deviceId = '';
    this.serviceId = '';
    this.characteristicId = '';
    this.characteristicProperties = null;
    this._resetEmitThrottleState();
    console.log('[BLEManager] Disconnected manually');
  }

  /**
   * 彻底释放 Central 侧蓝牙资源：停扫、断连、移除 notify/连接监听、`closeBluetoothAdapter`。
   * 直播页在手动记分模式下调用，避免后台扫描与 notify 回调占用。
   *
   * @param {{ emitDisconnected?: boolean }} [opts] emitDisconnected 默认 true，向 EventBus 广播断开
   * @returns {Promise<void>}
   */
  shutdownCentralStack(opts) {
    const self = this;
    const emitDisconnected = !(opts && opts.emitDisconnected === false);
    this._resetEmitThrottleState();

    try {
      wx.stopBluetoothDevicesDiscovery();
    } catch (e0) { }

    const did = this.deviceId;
    const closeConn = did
      ? wx.closeBLEConnection({ deviceId: did }).catch(function () { })
      : Promise.resolve();

    return closeConn.then(function () {
      self._removeWxBleListeners();
      self.deviceId = '';
      self.serviceId = '';
      self.characteristicId = '';
      self.characteristicProperties = null;
      self.isConnected = false;
      self.bleState = 'idle';

      return new Promise(function (resolve) {
        wx.closeBluetoothAdapter({
          complete: function () {
            if (emitDisconnected) {
              try {
                eventBus.emit('BLE_CONNECTION_UPDATE', { connected: false });
              } catch (eE) { }
            }
            resolve();
          }
        });
      });
    });
  }

  /**
   * 复位脏检查 / 节流相关状态。
   * 用于连接断开、主动断开等场景，避免：
   * 1) trailing setTimeout 在已断开后仍 emit 一次「假数据」；
   * 2) 下次（哪怕换设备）连接首帧因与 `_lastEmittedData` 相同而被脏检查吞掉。
   * 注意：不重置 `_rxPacketCount`，保留累计计数供调试页观察。
   * @private
   * @returns {void}
   */
  _resetEmitThrottleState() {
    if (this._emitTimer) {
      clearTimeout(this._emitTimer);
      this._emitTimer = null;
    }
    this._lastEmitTime = 0;
    this._lastEmittedData = null;
  }

  /**
   * 获取当前状态
   */
  getState() {
    return {
      isConnected: this.isConnected,
      bleState: this.bleState,
      deviceId: this.deviceId,
      characteristicProperties: this.characteristicProperties,
      rxCount: this._rxPacketCount
    };
  }
}

module.exports = new BLEManager();
