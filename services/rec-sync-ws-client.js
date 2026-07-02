/**
 * @fileoverview rec 通道 WebSocket 客户端（高光素材同步，与记分 score 通道隔离）
 */

const API = require('../config/api.js');
const { fetchWsToken } = require('../utils/ws-token-request.js');

/** @type {string} WSS 网关根地址（由 HTTPS BaseURL 推导） */
const WS_BASE_URL = String(API.API_BASE_URL || '').replace(/^http/i, 'ws');

/** @type {number[]} 断线重连退避序列（毫秒） */
const RECONNECT_DELAYS_MS = [3000, 6000, 12000, 15000];

/** @type {number} 心跳间隔（毫秒） */
const HEARTBEAT_INTERVAL_MS = 15000;

/** @type {number} 握手超时（socket 阶段） */
const HANDSHAKE_SOCKET_TIMEOUT_MS = 15000;

/** @type {number} 握手超时（token 阶段） */
const HANDSHAKE_TOKEN_TIMEOUT_MS = 10000;

/**
 * 简易 UUID v4 生成器，避免对外部库的依赖
 * @returns {string}
 */
function generateUUID() {
  var d = Date.now();
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    d += performance.now(); // use high-precision timer if available
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = (d + Math.random() * 16) % 16 | 0;
    d = Math.floor(d / 16);
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * 安全调用日志记录器
 */
function safeLog(logger, event, detail) {
  if (typeof logger !== 'function') return;
  try {
    logger(event, detail || {});
  } catch (e) {
    console.error('[RecSyncWS] Log error:', e);
  }
}

/**
 * 创建 rec 通道 WebSocket 客户端
 * @param {{
 *   onOpen?: () => void,
 *   onClose?: () => void,
 *   onError?: (err: object) => void,
 *   onTrigger?: (payload: { triggerId: string, relay_t: number }) => void,
 *   logger?: (event: string, detail?: object) => void
 * }} handlers
 */
function createRecSyncWsClient(handlers) {
  var socketTask = null;
  var roomId = '';
  var role = ''; // 'controller' | 'recorder'
  var connecting = false;
  var manualClose = false;
  var reconnectAttempt = 0;

  var reconnectTimer = null;
  var heartbeatTimer = null;
  var handshakeTimer = null;

  var openedAt = 0;
  var heartbeatSeq = 0;

  var cb = handlers || {};
  var logger = cb.logger;

  function clearTimers() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
  }

  function startHeartbeat() {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
    }
    heartbeatTimer = setTimeout(function () {
      sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  function sendHeartbeat() {
    if (!socketTask || manualClose) return;
    heartbeatSeq += 1;
    var packet = JSON.stringify({
      type: 'REC_HEARTBEAT',
      hb_seq: heartbeatSeq,
      sys_t: Date.now()
    });

    socketTask.send({
      data: packet,
      success: function () {
        startHeartbeat();
      },
      fail: function (err) {
        safeLog(logger, 'heartbeat_send_fail', { errMsg: err.errMsg });
        handleFailure('heartbeat_fail');
      }
    });
  }

  function handleFailure(reason) {
    if (manualClose || !roomId) return;
    safeLog(logger, 'failure', { reason: reason });
    clearTimers();
    connecting = false;
    if (socketTask) {
      try { socketTask.close({}); } catch (e) {}
      socketTask = null;
    }
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (manualClose || !roomId || reconnectTimer) return;
    reconnectAttempt += 1;
    var idx = Math.max(0, Math.min(reconnectAttempt - 1, RECONNECT_DELAYS_MS.length - 1));
    var delay = RECONNECT_DELAYS_MS[idx];

    safeLog(logger, 'reconnect_scheduled', { attempt: reconnectAttempt, delay: delay });
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (manualClose || !roomId) return;
      connect(roomId, role);
    }, delay);
  }

  function armHandshakeWatchdog(stage) {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
    }
    var timeout = stage === 'socket' ? HANDSHAKE_SOCKET_TIMEOUT_MS : HANDSHAKE_TOKEN_TIMEOUT_MS;
    handshakeTimer = setTimeout(function () {
      handshakeTimer = null;
      if (manualClose) return;
      if (openedAt > 0) return;

      safeLog(logger, 'handshake_timeout', { stage: stage, timeout: timeout });
      connecting = false;
      if (socketTask) {
        try { socketTask.close({}); } catch (e) {}
        socketTask = null;
      }
      scheduleReconnect();
    }, timeout);
  }

  function connect(nextRoomId, nextRole) {
    if (connecting) return;
    var safeRoomId = String(nextRoomId || '').replace(/\D/g, '').slice(0, 6);
    if (safeRoomId.length !== 6) {
      safeLog(logger, 'invalid_room_id', { roomId: nextRoomId });
      if (typeof cb.onError === 'function') {
        cb.onError(new Error('invalid roomId'));
      }
      return;
    }

    roomId = safeRoomId;
    role = nextRole || 'controller';
    connecting = true;
    manualClose = false;
    openedAt = 0;

    safeLog(logger, 'connect_start', { roomId: roomId, role: role, attempt: reconnectAttempt });
    armHandshakeWatchdog('token');

    fetchWsToken(roomId, 'rec').then(function (token) {
      if (manualClose) {
        connecting = false;
        clearTimers();
        return;
      }

      armHandshakeWatchdog('socket');
      var wsUrl = WS_BASE_URL + '/gaoguang-ws?roomId=' + roomId + '&channel=rec&token=' + encodeURIComponent(token);
      
      try {
        if (socketTask) {
          try { socketTask.close({}); } catch (e) {}
          socketTask = null;
        }

        socketTask = wx.connectSocket({
          url: wsUrl,
          fail: function (err) {
            connecting = false;
            clearTimers();
            safeLog(logger, 'connect_socket_fail', { errMsg: err.errMsg });
            if (typeof cb.onError === 'function') {
              cb.onError(err);
            }
            scheduleReconnect();
          }
        });
      } catch (errConnect) {
        connecting = false;
        clearTimers();
        safeLog(logger, 'connect_socket_throw', { errMsg: errConnect.message });
        scheduleReconnect();
        return;
      }

      socketTask.onOpen(function () {
        connecting = false;
        clearTimers();
        openedAt = Date.now();
        reconnectAttempt = 0;

        safeLog(logger, 'socket_open', { roomId: roomId, role: role });

        // 连接成功后发送 REC_JOIN
        var joinPacket = JSON.stringify({
          type: 'REC_JOIN',
          role: role
        });

        socketTask.send({
          data: joinPacket,
          success: function () {
            startHeartbeat();
            if (typeof cb.onOpen === 'function') {
              cb.onOpen();
            }
          },
          fail: function (err) {
            safeLog(logger, 'rec_join_send_fail', { errMsg: err.errMsg });
            handleFailure('rec_join_fail');
          }
        });
      });

      socketTask.onMessage(function (msg) {
        if (!msg || msg.data == null) return;
        try {
          var payload = JSON.parse(msg.data);
          if (!payload || typeof payload !== 'object') return;

          if (payload.type === 'REC_JOINED') {
            safeLog(logger, 'rec_joined_ack', { peerRole: payload.role });
          } else if (payload.type === 'REC_TRIGGER') {
            // 触发事件回调
            if (typeof cb.onTrigger === 'function') {
              cb.onTrigger({
                triggerId: payload.triggerId,
                relay_t: payload.relay_t || Date.now()
              });
            }
          } else if (payload.type === 'REC_PEER_LEFT') {
            safeLog(logger, 'peer_left', {});
          } else if (payload.type === 'REC_ROOM_FULL') {
            safeLog(logger, 'room_full', {});
            if (typeof cb.onError === 'function') {
              cb.onError(new Error('room_full'));
            }
          }
        } catch (eParse) {
          console.warn('[RecSyncWS] message parse fail', eParse);
        }
      });

      socketTask.onError(function (err) {
        safeLog(logger, 'socket_error', { errMsg: err.errMsg });
        if (typeof cb.onError === 'function') {
          cb.onError(err);
        }
      });

      socketTask.onClose(function (res) {
        connecting = false;
        clearTimers();
        safeLog(logger, 'socket_close', { code: res.code, reason: res.reason, manual: manualClose });
        socketTask = null;
        openedAt = 0;

        if (typeof cb.onClose === 'function') {
          cb.onClose();
        }

        if (!manualClose) {
          scheduleReconnect();
        }
      });

    }).catch(function (err) {
      connecting = false;
      clearTimers();
      safeLog(logger, 'token_fetch_fail', { errMsg: err.message || err });
      if (typeof cb.onError === 'function') {
        cb.onError(err);
      }
      scheduleReconnect();
    });
  }

  function disconnect(manual) {
    manualClose = !!manual;
    connecting = false;
    clearTimers();
    reconnectAttempt = 0;
    heartbeatSeq = 0;
    if (socketTask) {
      try { socketTask.close({}); } catch (e) {}
      socketTask = null;
    }
    openedAt = 0;
    safeLog(logger, 'disconnect', { manual: manualClose });
  }

  function sendTrigger() {
    if (!socketTask || manualClose) {
      throw new Error('Socket not connected');
    }
    var triggerId = generateUUID();
    var packet = JSON.stringify({
      type: 'REC_TRIGGER',
      triggerId: triggerId
    });

    socketTask.send({
      data: packet,
      success: function () {
        safeLog(logger, 'trigger_sent', { triggerId: triggerId });
      },
      fail: function (err) {
        safeLog(logger, 'trigger_send_fail', { triggerId: triggerId, errMsg: err.errMsg });
      }
    });

    return triggerId;
  }

  function isConnected() {
    return !!socketTask && openedAt > 0 && !connecting && !manualClose;
  }

  function getRoomId() {
    return roomId;
  }

  function destroy() {
    disconnect(true);
  }

  return {
    connect: connect,
    disconnect: disconnect,
    sendTrigger: sendTrigger,
    isConnected: isConnected,
    getRoomId: getRoomId,
    destroy: destroy
  };
}

module.exports = {
  createRecSyncWsClient: createRecSyncWsClient
};
