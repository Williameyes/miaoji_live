/**
 * @fileoverview 直播端 WebSocket 客户端：HTTP 换 Token → WSS 长连接，指数退避重连。
 */

const API = require('../config/api.js');
const { fetchWsToken } = require('../utils/ws-token-request.js');

/** @type {string} WSS 网关根地址（由 HTTPS BaseURL 推导） */
const WS_BASE_URL = String(API.API_BASE_URL || '').replace(/^http/i, 'ws');

/** @type {string} 获取一次性 Token 的 HTTP 路径（仅供文档引用，实际见 utils/ws-token-request.js） */
const WS_TOKEN_PATH = '/api/get_token';

/** @type {string} WebSocket 握手路径 */
const WS_SOCKET_PATH = '/gaoguang-ws';

/** @type {number[]} 断线重连退避序列（毫秒），上限 15 秒 */
const WS_RECONNECT_DELAYS_MS = [3000, 6000, 12000, 15000];

/** @type {string} 上次成功连入的房间号 Storage 键 */
const STORAGE_LAST_ROOM_ID = 'live_ws_last_room_id';

/**
 * 计算 WebSocket 断线重连等待毫秒（3→6→12，上限 15 秒）。
 * @param {number} attempt 已断开次数（从 1 起）
 * @returns {number}
 */
function getWsReconnectDelayMs(attempt) {
  const idx = Math.max(0, Math.min(attempt - 1, WS_RECONNECT_DELAYS_MS.length - 1));
  return WS_RECONNECT_DELAYS_MS[idx];
}

/**
 * 创建直播端 WebSocket 客户端实例。
 * @param {{
 *   onOpen?: () => void,
 *   onMessage?: (data: string) => void,
 *   onClose?: () => void,
 *   onError?: (err: object) => void,
 *   onPhase?: (phase: string, detail?: string) => void
 * }} handlers 生命周期回调
 * @returns {{
 *   connect: (roomId: string) => void,
 *   disconnect: (manual?: boolean) => void,
 *   isConnected: () => boolean,
 *   getRoomId: () => string
 * }}
 */
function createLiveWsClient(handlers) {
  /** @type {WechatMiniprogram.SocketTask | null} */
  let socketTask = null;
  let roomId = '';
  let connecting = false;
  let manualClose = false;
  let reconnectAttempt = 0;
  /** @type {number | null} */
  let reconnectTimer = null;
  const cb = handlers || {};

  /**
   * 通知连接阶段变化。
   * @param {string} phase 阶段标识
   * @param {string} [detail] 附加说明
   * @returns {void}
   */
  function emitPhase(phase, detail) {
    if (typeof cb.onPhase === 'function') {
      cb.onPhase(phase, detail || '');
    }
  }

  /**
   * 清除重连定时器。
   * @returns {void}
   */
  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /**
   * 调度指数退避重连。
   * @returns {void}
   */
  function scheduleReconnect() {
    if (manualClose || !roomId || reconnectTimer) return;
    reconnectAttempt += 1;
    const delay = getWsReconnectDelayMs(reconnectAttempt);
    emitPhase('reconnecting', String(delay));
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (manualClose || !roomId) return;
      connect(roomId);
    }, delay);
  }

  /**
   * 建立 WebSocket 长连接（先取 Token 再 connectSocket）。
   * @param {string} nextRoomId 6 位房间号
   * @returns {void}
   */
  function connect(nextRoomId) {
    if (connecting) return;
    const safeRoomId = String(nextRoomId || '').replace(/\D/g, '').slice(0, 6);
    if (safeRoomId.length !== 6) {
      emitPhase('error', 'roomId invalid');
      return;
    }
    roomId = safeRoomId;
    connecting = true;
    manualClose = false;
    emitPhase('token');

    fetchWsToken(roomId).then(function (token) {
      if (manualClose) {
        connecting = false;
        return;
      }
      emitPhase('handshake');
      const wsUrl = WS_BASE_URL + WS_SOCKET_PATH +
        '?roomId=' + encodeURIComponent(roomId) +
        '&token=' + encodeURIComponent(token);
      try {
        if (socketTask) {
          try { socketTask.close({}); } catch (eClose) { /* ignore */ }
          socketTask = null;
        }
        socketTask = wx.connectSocket({ url: wsUrl });
      } catch (errConnect) {
        connecting = false;
        emitPhase('error', 'connectSocket throw');
        console.error('[LiveWS] connectSocket throw', errConnect);
        return;
      }

      socketTask.onOpen(function () {
        connecting = false;
        reconnectAttempt = 0;
        clearReconnectTimer();
        emitPhase('connected');
        if (typeof cb.onOpen === 'function') cb.onOpen();
      });

      socketTask.onMessage(function (msg) {
        if (!msg || msg.data == null) return;
        if (typeof cb.onMessage === 'function') {
          cb.onMessage(String(msg.data));
        }
      });

      socketTask.onError(function (err) {
        console.warn('[LiveWS] error', err);
        if (typeof cb.onError === 'function') cb.onError(err || {});
      });

      socketTask.onClose(function () {
        connecting = false;
        socketTask = null;
        if (typeof cb.onClose === 'function') cb.onClose();
        if (manualClose) {
          emitPhase('idle');
          return;
        }
        scheduleReconnect();
      });
    }).catch(function (err) {
      connecting = false;
      emitPhase('error', 'token fail');
      console.error('[LiveWS] get_token fail', err);
      if (typeof cb.onError === 'function') cb.onError(err || {});
    });
  }

  /**
   * 断开 WebSocket；manual=true 时不触发自动重连。
   * @param {boolean} [manual] 是否为用户主动断开
   * @returns {void}
   */
  function disconnect(manual) {
    manualClose = !!manual;
    connecting = false;
    clearReconnectTimer();
    reconnectAttempt = 0;
    if (socketTask) {
      try { socketTask.close({}); } catch (e) { /* ignore */ }
      socketTask = null;
    }
    if (manual) {
      roomId = '';
      emitPhase('idle');
    }
  }

  /**
   * 当前是否已建立 WSS 连接。
   * @returns {boolean}
   */
  function isConnected() {
    return !!socketTask && !connecting && !manualClose;
  }

  /**
   * 当前房间号。
   * @returns {string}
   */
  function getRoomId() {
    return roomId;
  }

  return {
    connect: connect,
    disconnect: disconnect,
    isConnected: isConnected,
    getRoomId: getRoomId
  };
}

module.exports = {
  createLiveWsClient: createLiveWsClient,
  STORAGE_LAST_ROOM_ID: STORAGE_LAST_ROOM_ID,
  getWsReconnectDelayMs: getWsReconnectDelayMs
};
