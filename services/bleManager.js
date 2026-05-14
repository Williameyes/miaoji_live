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

    this._prevFrame = null;
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

    BLEManager.instance = this;
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
      // 1. 建立连接
      await wx.createBLEConnection({ deviceId: targetDeviceId });
      this.isConnected = true;
      this.bleState = 'connected';
      console.log('[BLEManager] Connection success');

      // 监听断开
      wx.onBLEConnectionStateChange((res) => {
        if (res.deviceId === this.deviceId && !res.connected) {
          console.log('[BLEManager] BLE Disconnected');
          this.isConnected = false;
          this.bleState = 'idle';
          this._resetEmitThrottleState();
          eventBus.emit('BLE_CONNECTION_UPDATE', { connected: false });
        }
      });

      // 2. 发现服务 (必须步骤，否则无法后续操作)
      await this._discoverServices();

      // 3. 订阅通知
      await this._subscribeNotify();
      
      eventBus.emit('BLE_CONNECTION_UPDATE', { connected: true, deviceId: targetDeviceId });
      return true;
    } catch (err) {
      console.error('[BLEManager] Connection flow failed:', err);
      this.bleState = 'idle';
      // 出错时尝试断开，清理状态
      try { wx.closeBLEConnection({ deviceId: targetDeviceId }); } catch (e) {}
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

    // 发现特征值
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
      
      // 订阅后读一次初始值
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
    wx.offBLECharacteristicValueChange();
    wx.onBLECharacteristicValueChange((res) => {
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

      // 逻辑验证
      if (this._prevFrame && !BLE.isLogicallyValid(this._prevFrame, decoded)) {
        console.warn('[BLEManager] Logically invalid frame, skipping notify');
        return;
      }

      this._prevFrame = decoded;
      this._rxPacketCount++;

      // ── 脏检查：只对比影响视觉的实质性核心字段 ──
      // 坚决不把 rxCount / timestamp 纳入对比，避免「内容未变但因时间戳变更触发 setData」。
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
        // 视觉无变化，静默丢弃，保护下游 UI 主线程与 live-pusher 编码资源。
        return;
      }

      // ── 组装 payload（保留 rxCount/timestamp 给调试页使用，UI 层不应写入 setData）──
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

      // ── 节流：最高 250ms 一次；停流瞬间通过 trailing setTimeout 兜底最后一帧 ──
      const now = Date.now();
      const since = now - this._lastEmitTime;
      const THROTTLE_MS = 250;
      if (since < THROTTLE_MS) {
        if (this._emitTimer) {
          clearTimeout(this._emitTimer);
          this._emitTimer = null;
        }
        // 闭包内捕获本次 decoded / payload；定时器触发时若期间已被新帧顶替，新帧会再次进入该分支并替换定时器。
        const trailingDecoded = decoded;
        const trailingPayload = payload;
        this._emitTimer = setTimeout(() => {
          this._emitTimer = null;
          this._lastEmitTime = Date.now();
          this._lastEmittedData = trailingDecoded;
          // trailing 触发时刷新 timestamp，避免下游基于该字段做过期判断时误判。
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
    });
  }

  /**
   * 断开连接并清理
   */
  async disconnect() {
    if (!this.deviceId) return;
    
    try {
      await wx.closeBLEConnection({ deviceId: this.deviceId });
      this.isConnected = false;
      this.bleState = 'idle';
      this.deviceId = '';
      this.serviceId = '';
      this.characteristicId = '';
      this.characteristicProperties = null;
      this._resetEmitThrottleState();
      console.log('[BLEManager] Disconnected manually');
    } catch (err) {
      console.error('[BLEManager] Disconnect failed:', err);
    }
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
    this._prevFrame = null;
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
