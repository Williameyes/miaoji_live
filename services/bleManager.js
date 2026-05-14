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

      // 全局分发
      eventBus.emit('BLE_DATA_UPDATE', {
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
      });
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
      console.log('[BLEManager] Disconnected manually');
    } catch (err) {
      console.error('[BLEManager] Disconnect failed:', err);
    }
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
