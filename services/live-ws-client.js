/**
 * @fileoverview 直播端 WebSocket 客户端：HTTP 换 Token → WSS 长连接，指数退避重连。
 *
 * 链路保活机制（v2 增补）：
 *   1. 应用层心跳：连接成功后每 {@link WS_HEARTBEAT_INTERVAL_MS} 毫秒发一次 PING，
 *      解决移动 NAT 老化与 Nginx idle timeout 静默断链问题；服务端识别与否均不影响。
 *   2. 下行新鲜度看门狗：每 {@link WS_WATCHDOG_INTERVAL_MS} 毫秒检查 lastRecvAt；
 *      超过 {@link WS_RECV_STALE_MS} 仍无任何下行（含心跳回波）→ 主动重连。
 *   3. send fail 回调：底层写失败立即触发 signalTransientFailure。
 *   4. wx.onNetworkStatusChange：网络类型切换 / 断网恢复触发主动重连。
 *   5. logger 注入：所有关键事件（连接 / 断开 / 心跳 / 看门狗）回调到上层 appendHealthLog。
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

/** @type {number} 应用层心跳发送间隔；25s < 移动 NAT 60-90s 老化窗口 / Nginx 默认 60s。 */
const WS_HEARTBEAT_INTERVAL_MS = 25000;

/** @type {number} 看门狗检查间隔。 */
const WS_WATCHDOG_INTERVAL_MS = 10000;

/**
 * @type {number} 视为「下行链路可疑」的阈值；超过即强制 close + reconnect。
 *
 * 设计权衡：篮球比赛节间休息常 90-120 秒无业务包；
 * - 当前服务端不主动 PONG，所以 lastRecvAt 在静默期会持续推进。
 * - 阈值设为 90 秒：宁可在长暂停后多 reconnect 一次（reconnect 后服务端会下发 lastSnapshot），
 *   也不容忍真正的「假死」拖到 5+ 分钟用户感知到。
 * - reconnect 用户感知极小（< 2s 内重新拿快照渲染）。
 */
const WS_RECV_STALE_MS = 90000;

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
 * 安全调用 logger 回调，吞掉一切异常避免影响主链路。
 * @param {((event: string, detail?: object) => void) | undefined} logger
 * @param {string} event 事件名（不含前缀；上层会自动加 `ws_` 前缀）
 * @param {object} [detail] 附加字段
 * @returns {void}
 */
function safeLog(logger, event, detail) {
  if (typeof logger !== 'function') return;
  try {
    logger(event, detail || {});
  } catch (e) {
    /* 日志异常绝不能影响业务 */
  }
}

/**
 * 创建直播端 WebSocket 客户端实例。
 * @param {{
 *   onOpen?: () => void,
 *   onMessage?: (data: string) => void,
 *   onClose?: () => void,
 *   onError?: (err: object) => void,
 *   onPhase?: (phase: string, detail?: string) => void,
 *   logger?: (event: string, detail?: object) => void
 * }} handlers 生命周期回调（logger 可选；用于把关键事件抛回上层 appendHealthLog）
 * @returns {{
 *   connect: (roomId: string) => void,
 *   disconnect: (manual?: boolean) => void,
 *   signalTransientFailure: () => void,
 *   isConnected: () => boolean,
 *   getRoomId: () => string,
 *   getDiagnosticSnapshot: () => object,
 *   destroy: () => void
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
  /** @type {number | null} */
  let heartbeatTimer = null;
  /** @type {number | null} */
  let watchdogTimer = null;
  /** 当前 socket onOpen 时间戳，用于诊断 since_open_ms */
  let openedAt = 0;
  /** 最近一次成功 send 的时间戳（含心跳与业务） */
  let lastSendAt = 0;
  /** 最近一次收到任意下行（含业务广播）的时间戳 */
  let lastRecvAt = 0;
  /** 网络类型变化监听器，destroy 时摘除 */
  let networkChangeHandler = null;
  const cb = handlers || {};
  const logger = typeof cb.logger === 'function' ? cb.logger : undefined;

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
   * 清除心跳定时器。
   * @returns {void}
   */
  function clearHeartbeatTimer() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  /**
   * 清除看门狗定时器。
   * @returns {void}
   */
  function clearWatchdogTimer() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  /**
   * 启动心跳定时器（onOpen 后调用）。
   * 服务端识别 PING 与否均不影响，本端仅负责制造上行流量保活 NAT/网关。
   * @returns {void}
   */
  function startHeartbeat() {
    clearHeartbeatTimer();
    heartbeatTimer = setInterval(function () {
      if (!socketTask || manualClose) return;
      const pkt = JSON.stringify({ type: 'PING', ts: Date.now() });
      try {
        socketTask.send({
          data: pkt,
          success: function () {
            lastSendAt = Date.now();
          },
          fail: function (err) {
            /* 心跳失败是关键告警事件，必打日志 */
            safeLog(logger, 'heartbeat_send_fail', {
              msg: err && err.errMsg ? String(err.errMsg).slice(0, 120) : 'fail',
              since_open_ms: openedAt ? Date.now() - openedAt : -1
            });
            handleSendFailure('heartbeat_fail');
          }
        });
        /* 心跳成功路径不打日志，避免淹没 _healthLogs 环形缓冲（144 条/小时） */
      } catch (eHb) {
        safeLog(logger, 'heartbeat_throw', {
          msg: eHb && eHb.message ? String(eHb.message).slice(0, 120) : 'throw'
        });
        handleSendFailure('heartbeat_throw');
      }
    }, WS_HEARTBEAT_INTERVAL_MS);
  }

  /**
   * 启动看门狗定时器（onOpen 后调用）。
   *
   * 设计要点：
   * - 仅当 **曾经收到过下行**（lastRecvAt > 0）才启用 90s 阈值；这是「假死链路」的核心特征。
   * - 从未收到下行（空房间等待采集端入场）的场景使用 4× 阈值，避免空房反复 reconnect 风暴。
   * - 心跳 send 已经由 startHeartbeat 负责检测写失败；本看门狗专门兜底「能写但读不到任何东西」。
   *
   * @returns {void}
   */
  function startWatchdog() {
    clearWatchdogTimer();
    watchdogTimer = setInterval(function () {
      if (!socketTask || manualClose) return;
      const now = Date.now();
      const hasReceived = lastRecvAt > 0;
      const recvAge = hasReceived ? now - lastRecvAt : (openedAt ? now - openedAt : 0);
      const threshold = hasReceived ? WS_RECV_STALE_MS : WS_RECV_STALE_MS * 4;
      if (recvAge > threshold) {
        safeLog(logger, 'recv_stale_kick', {
          recv_age_ms: recvAge,
          last_send_ago_ms: lastSendAt > 0 ? now - lastSendAt : -1,
          since_open_ms: openedAt ? now - openedAt : -1,
          threshold_ms: threshold,
          ever_received: hasReceived
        });
        handleSendFailure('recv_stale');
      }
    }, WS_WATCHDOG_INTERVAL_MS);
  }

  /**
   * send 失败 / 看门狗触发的统一处理：close 当前 socket 并退避重连。
   * @param {string} reason 触发原因
   * @returns {void}
   */
  function handleSendFailure(reason) {
    if (manualClose || !roomId) return;
    safeLog(logger, 'transient_failure', { reason: String(reason || 'unknown') });
    clearHeartbeatTimer();
    clearWatchdogTimer();
    connecting = false;
    if (socketTask) {
      try { socketTask.close({}); } catch (eClose) { /* ignore */ }
      socketTask = null;
    }
    scheduleReconnect();
  }

  /**
   * 调度指数退避重连。
   * @returns {void}
   */
  function scheduleReconnect() {
    if (manualClose || !roomId || reconnectTimer) return;
    reconnectAttempt += 1;
    const delay = getWsReconnectDelayMs(reconnectAttempt);
    safeLog(logger, 'reconnect_schedule', { attempt: reconnectAttempt, delay_ms: delay });
    emitPhase('reconnecting', String(delay));
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (manualClose || !roomId) return;
      connect(roomId);
    }, delay);
  }

  /**
   * 瞬时不可用（房间未就绪 / 采集端离线等）：关闭当前 Socket 并保留 roomId 退避重连。
   * @returns {void}
   */
  function signalTransientFailure() {
    if (manualClose || !roomId) return;
    safeLog(logger, 'signal_transient', {});
    clearHeartbeatTimer();
    clearWatchdogTimer();
    connecting = false;
    if (socketTask) {
      try { socketTask.close({}); } catch (eClose) { /* ignore */ }
      socketTask = null;
    }
    scheduleReconnect();
  }

  /**
   * 网络类型变化回调：从无网→有网、或网络类型切换都立即触发一次 reconnect 自检。
   * @param {{ isConnected: boolean, networkType: string }} res
   * @returns {void}
   */
  function onNetworkChange(res) {
    if (manualClose || !roomId) return;
    safeLog(logger, 'network_change', {
      net_type: res && res.networkType ? String(res.networkType) : '',
      is_connected: !!(res && res.isConnected)
    });
    if (res && res.isConnected) {
      handleSendFailure('network_change');
    }
  }

  /**
   * 安装网络变化监听器（在 createLiveWsClient 调用时一次性安装）。
   * @returns {void}
   */
  function installNetworkListener() {
    if (networkChangeHandler) return;
    if (typeof wx === 'undefined' || typeof wx.onNetworkStatusChange !== 'function') return;
    networkChangeHandler = onNetworkChange;
    try {
      wx.onNetworkStatusChange(networkChangeHandler);
    } catch (eNet) {
      networkChangeHandler = null;
    }
  }

  /**
   * 卸载网络变化监听器（destroy 时调用）。
   * @returns {void}
   */
  function uninstallNetworkListener() {
    if (!networkChangeHandler) return;
    try {
      if (typeof wx !== 'undefined' && typeof wx.offNetworkStatusChange === 'function') {
        wx.offNetworkStatusChange(networkChangeHandler);
      }
    } catch (eNet) { /* ignore */ }
    networkChangeHandler = null;
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
      safeLog(logger, 'connect_invalid_room', {});
      return;
    }
    roomId = safeRoomId;
    connecting = true;
    manualClose = false;
    emitPhase('token');
    safeLog(logger, 'connect_request', { room: safeRoomId, attempt: reconnectAttempt });

    fetchWsToken(roomId).then(function (token) {
      safeLog(logger, 'token_ok', {});
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
        socketTask = wx.connectSocket({
          url: wsUrl,
          fail: function (err) {
            connecting = false;
            safeLog(logger, 'connect_socket_fail', {
              msg: err && err.errMsg ? String(err.errMsg).slice(0, 120) : 'fail'
            });
            emitPhase('error', 'connectSocket fail');
            if (typeof cb.onError === 'function') cb.onError(err || {});
          }
        });
      } catch (errConnect) {
        connecting = false;
        emitPhase('error', 'connectSocket throw');
        safeLog(logger, 'connect_socket_throw', {
          msg: errConnect && errConnect.message ? String(errConnect.message).slice(0, 120) : 'throw'
        });
        return;
      }

      socketTask.onOpen(function () {
        connecting = false;
        reconnectAttempt = 0;
        clearReconnectTimer();
        openedAt = Date.now();
        lastRecvAt = 0;
        lastSendAt = 0;
        safeLog(logger, 'open', { room: roomId });
        try {
          socketTask.send({
            data: JSON.stringify({ type: 'BROADCAST_JOIN' }),
            success: function () { lastSendAt = Date.now(); },
            fail: function (err) {
              safeLog(logger, 'broadcast_join_fail', {
                msg: err && err.errMsg ? String(err.errMsg).slice(0, 120) : 'fail'
              });
              handleSendFailure('broadcast_join_fail');
            }
          });
        } catch (eJoin) {
          safeLog(logger, 'broadcast_join_throw', {
            msg: eJoin && eJoin.message ? String(eJoin.message).slice(0, 120) : 'throw'
          });
        }
        startHeartbeat();
        startWatchdog();
        emitPhase('connected');
        if (typeof cb.onOpen === 'function') cb.onOpen();
      });

      socketTask.onMessage(function (msg) {
        if (!msg || msg.data == null) return;
        lastRecvAt = Date.now();
        if (typeof cb.onMessage === 'function') {
          cb.onMessage(String(msg.data));
        }
      });

      socketTask.onError(function (err) {
        safeLog(logger, 'error', {
          msg: err && err.errMsg ? String(err.errMsg).slice(0, 120) : 'unknown',
          since_open_ms: openedAt ? Date.now() - openedAt : -1
        });
        if (typeof cb.onError === 'function') cb.onError(err || {});
      });

      socketTask.onClose(function (res) {
        connecting = false;
        clearHeartbeatTimer();
        clearWatchdogTimer();
        const code = res && typeof res.code === 'number' ? res.code : -1;
        safeLog(logger, 'close', {
          code: code,
          reason: res && res.reason ? String(res.reason).slice(0, 120) : '',
          since_open_ms: openedAt ? Date.now() - openedAt : -1,
          last_send_ago_ms: lastSendAt ? Date.now() - lastSendAt : -1,
          last_recv_ago_ms: lastRecvAt ? Date.now() - lastRecvAt : -1,
          manual: manualClose
        });
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
      safeLog(logger, 'token_fail', {
        msg: err && err.message ? String(err.message).slice(0, 120) : 'fail'
      });
      if (typeof cb.onError === 'function') cb.onError(err || {});
      if (!manualClose && roomId) {
        scheduleReconnect();
      }
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
    clearHeartbeatTimer();
    clearWatchdogTimer();
    reconnectAttempt = 0;
    if (socketTask) {
      try { socketTask.close({}); } catch (e) { /* ignore */ }
      socketTask = null;
    }
    if (manual) {
      safeLog(logger, 'disconnect_manual', {});
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

  /**
   * 暴露内部状态快照，供 appendHealthLog 等诊断使用（不可写）。
   * @returns {object}
   */
  function getDiagnosticSnapshot() {
    const now = Date.now();
    return {
      hasSocket: !!socketTask,
      connecting: connecting,
      manualClose: manualClose,
      reconnectAttempt: reconnectAttempt,
      since_open_ms: openedAt ? now - openedAt : -1,
      last_send_ago_ms: lastSendAt ? now - lastSendAt : -1,
      last_recv_ago_ms: lastRecvAt ? now - lastRecvAt : -1
    };
  }

  /**
   * 销毁实例：卸载网络监听 + 全部定时器。页面 onUnload 调用。
   * @returns {void}
   */
  function destroy() {
    disconnect(true);
    uninstallNetworkListener();
  }

  installNetworkListener();

  return {
    connect: connect,
    disconnect: disconnect,
    signalTransientFailure: signalTransientFailure,
    isConnected: isConnected,
    getRoomId: getRoomId,
    getDiagnosticSnapshot: getDiagnosticSnapshot,
    destroy: destroy
  };
}

module.exports = {
  createLiveWsClient: createLiveWsClient,
  STORAGE_LAST_ROOM_ID: STORAGE_LAST_ROOM_ID,
  getWsReconnectDelayMs: getWsReconnectDelayMs,
  WS_HEARTBEAT_INTERVAL_MS: WS_HEARTBEAT_INTERVAL_MS,
  WS_RECV_STALE_MS: WS_RECV_STALE_MS
};
