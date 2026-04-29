/**
 * @fileoverview 超轻量级发布订阅模式 (EventBus)
 * 用于跨页面、跨组件的数据通信。
 */

class EventBus {
  constructor() {
    this.listeners = {};
  }

  /**
   * 订阅事件
   * @param {string} eventName 
   * @param {Function} callback 
   */
  on(eventName, callback) {
    if (!this.listeners[eventName]) {
      this.listeners[eventName] = [];
    }
    this.listeners[eventName].push(callback);
  }

  /**
   * 取消订阅
   * @param {string} eventName 
   * @param {Function} callback 
   */
  off(eventName, callback) {
    if (!this.listeners[eventName]) return;
    this.listeners[eventName] = this.listeners[eventName].filter(cb => cb !== callback);
  }

  /**
   * 触发事件
   * @param {string} eventName 
   * @param {any} data 
   */
  emit(eventName, data) {
    if (!this.listeners[eventName]) return;
    this.listeners[eventName].forEach(callback => {
      try {
        callback(data);
      } catch (e) {
        console.error(`[EventBus] Error in callback for event "${eventName}":`, e);
      }
    });
  }
}

module.exports = new EventBus();
