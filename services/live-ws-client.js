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

/**
 * @type {number} 应用层心跳基准间隔。
 *
 * 历史教训（2026-05 现场日志）：心跳 25s 时 iOS 端 100% 每 25.0 秒被服务端 1006 强关，
 * `since_open_ms ≈ 25151 / 25089 / 25141`，`last_recv_ago_ms ≈ 25067 / 25012`。
 * 推断：服务端 / 网关 read idle ≈ 25s，且自定义 `{type:'PING'}` 不被识别为业务流量刷 idle。
 *
 * 新策略：基准 12s + 抖动（_getNextHeartbeatDelay），且心跳改成 BROADCAST_HEARTBEAT 业务包，
 * 让网关把它当成正常业务包识别。
 */
const WS_HEARTBEAT_INTERVAL_MS = 12000;
/** @type {number} 心跳随机抖动幅度（毫秒），避免心跳与服务端 idle 边界形成稳定共振。 */
const WS_HEARTBEAT_JITTER_MS = 1500;
/** @type {number} 紧急心跳（连续短命连接时启用），更激进地刷 idle。 */
const WS_HEARTBEAT_EMERGENCY_MS = 7000;
/** @type {number} open 后多久内被关算作短命；累计达阈值触发紧急心跳模式。 */
const WS_SHORTLIVED_OPEN_MS = 30000;
/** @type {number} 触发紧急心跳所需的连续短命次数。 */
const WS_SHORTLIVED_TRIGGER_COUNT = 3;

/** @type {number} 看门狗检查间隔。 */
const WS_WATCHDOG_INTERVAL_MS = 10000;
/** @type {number} 握手超时（socket 阶段）：connectSocket 后无 onOpen → 主动 close 重连。 */
const WS_HANDSHAKE_SOCKET_TIMEOUT_MS = 15000;
/** @type {number} 握手超时（token 阶段）：fetchWsToken 长时间没回。 */
const WS_HANDSHAKE_TOKEN_TIMEOUT_MS = 10000;
/** @type {number} 网络切换防抖：真切换后等多久才 reconnect，避免 wifi↔4g 抖动期 token 失败。 */
const WS_NETWORK_CHANGE_DEBOUNCE_MS = 1500;
/** @type {number} 网络切换后若刚收到下行，说明链路仍新鲜，不主动断开。 */
const WS_NETWORK_CHANGE_FRESH_RECV_MS = 15000;
/** @type {number} 网络切换后若刚成功上行，优先保留链路，交给心跳/看门狗继续体检。 */
const WS_NETWORK_CHANGE_FRESH_SEND_MS = 15000;
/** @type {number} 刚 open 的 socket 给一个宽限期，避免 iOS 网络类型回调把新连接立刻关掉。 */
const WS_NETWORK_CHANGE_OPEN_GRACE_MS = 8000;
/** @type {number} open 后稳定多久才清零 reconnectAttempt，避免短命连接掩盖退避。 */
const WS_ATTEMPT_CLEAR_AFTER_MS = 8000;
/** @type {number} token 失败时的最小退避。 */
const WS_TOKEN_FAIL_MIN_DELAY_MS = 5000;

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
  /** @type {number | null} 心跳 setTimeout 句柄（每次心跳后重新 schedule，自带抖动） */
  let heartbeatTimer = null;
  /** @type {number | null} */
  let watchdogTimer = null;
  /** @type {number | null} 握手超时句柄 */
  let handshakeTimer = null;
  /** @type {number | null} open 稳定后清零 reconnectAttempt 的延迟句柄 */
  let attemptClearTimer = null;
  /** @type {number | null} 网络切换防抖句柄 */
  let networkChangeTimer = null;
  /** 当前 socket onOpen 时间戳，用于诊断 since_open_ms */
  let openedAt = 0;
  /** 最近一次成功 send 的时间戳（含心跳与业务） */
  let lastSendAt = 0;
  /** 最近一次收到任意下行（含业务广播）的时间戳 */
  let lastRecvAt = 0;
  /** 网络类型变化监听器，destroy 时摘除 */
  let networkChangeHandler = null;
  /** 上一次记录到的 networkType，用于过滤同类型「假切换」 */
  let lastNetworkType = '';
  /** 短命连接累计计数（onOpen 后 30s 内被关的次数）；达阈值进入紧急心跳模式 */
  let shortLivedStreak = 0;
  /** 紧急心跳模式是否启用（每 7s + 抖动 一次心跳） */
  let heartbeatEmergency = false;
  /** 心跳独立序列号（不挤业务包 seq） */
  let heartbeatSeq = 0;
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
   * 清除心跳定时器（已改为 setTimeout 自递归，对应 clearTimeout）。
   * @returns {void}
   */
  function clearHeartbeatTimer() {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  /** 清除握手超时定时器（onOpen / 异常路径都要清）。 */
  function clearHandshakeTimer() {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
  }

  /** 清除 attemptClearTimer（onClose / disconnect 时调用）。 */
  function clearAttemptClearTimer() {
    if (attemptClearTimer) {
      clearTimeout(attemptClearTimer);
      attemptClearTimer = null;
    }
  }

  /** 清除网络变化防抖定时器。 */
  function clearNetworkChangeTimer() {
    if (networkChangeTimer) {
      clearTimeout(networkChangeTimer);
      networkChangeTimer = null;
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
   * 计算下一次心跳间隔：基准 + 随机抖动；紧急模式下使用更短间隔。
   * @returns {number} 毫秒
   */
  function getNextHeartbeatDelay() {
    const base = heartbeatEmergency ? WS_HEARTBEAT_EMERGENCY_MS : WS_HEARTBEAT_INTERVAL_MS;
    const jitter = Math.floor((Math.random() * 2 - 1) * WS_HEARTBEAT_JITTER_MS);
    return Math.max(3000, base + jitter);
  }

  /**
   * 构造一条「业务化心跳包」。
   *
   * 现场实测：自定义 `{type:'PING'}` 在某些网关/服务端不被识别为有效业务流量、不刷新 idle，
   * 导致连续 1006 关闭（iOS 直播端 25s 整点必断）。让心跳长得跟业务包同 schema（type=
   * `BROADCAST_HEARTBEAT` + 标准元数据），即使服务端只透传也不会被中间链路拦截。
   * 心跳序列号独立计数，不挤业务 seq。
   *
   * @returns {string} JSON 字符串
   */
  function buildHeartbeatPacket() {
    heartbeatSeq += 1;
    return JSON.stringify({
      type: 'BROADCAST_HEARTBEAT',
      hb_seq: heartbeatSeq,
      sys_t: Date.now(),
      match_id: 'M_' + (roomId || ''),
      /** 兼容字段：服务端如果有旧的 PING 处理，仍可走原逻辑 */
      ping: 1
    });
  }

  /**
   * 启动心跳：setTimeout 自递归，基准 12s + 抖动；连续短命时进入紧急模式 7s。
   *
   * 与旧版区别：
   *   - 不再用 setInterval(25000)：固定 25s 心跳会与服务端 25s idle timeout 形成稳定共振，
   *     导致每 25s 准时 1006（详见 WS_HEARTBEAT_INTERVAL_MS 注释）；
   *   - 心跳包 type 改为 BROADCAST_HEARTBEAT，长得跟业务包一样，刷 idle 概率更高。
   *
   * @returns {void}
   */
  function startHeartbeat() {
    clearHeartbeatTimer();
    const scheduleNext = function () {
      const delay = getNextHeartbeatDelay();
      heartbeatTimer = setTimeout(function () {
        heartbeatTimer = null;
        sendHeartbeatOnce(scheduleNext);
      }, delay);
    };
    /* 第一次提前一些发，让连接尽快出现在「心跳已就绪」状态：4~6s */
    heartbeatTimer = setTimeout(function () {
      heartbeatTimer = null;
      sendHeartbeatOnce(scheduleNext);
    }, 4000 + Math.floor(Math.random() * 2000));
  }

  /**
   * 单次心跳：发送、记账、失败兜底。
   * @param {() => void} scheduleNext 下一次心跳的调度器
   * @returns {void}
   */
  function sendHeartbeatOnce(scheduleNext) {
    if (!socketTask || manualClose) return;
    const pkt = buildHeartbeatPacket();
    try {
      socketTask.send({
        data: pkt,
        success: function () {
          lastSendAt = Date.now();
          if (typeof scheduleNext === 'function') scheduleNext();
        },
        fail: function (err) {
          /* 心跳失败是关键告警事件，必打日志 */
          safeLog(logger, 'heartbeat_send_fail', {
            msg: err && err.errMsg ? String(err.errMsg).slice(0, 120) : 'fail',
            since_open_ms: openedAt ? Date.now() - openedAt : -1,
            emergency: heartbeatEmergency
          });
          handleSendFailure('heartbeat_fail');
        }
      });
      /* 心跳成功路径不打日志，避免淹没 _healthLogs 环形缓冲 */
    } catch (eHb) {
      safeLog(logger, 'heartbeat_throw', {
        msg: eHb && eHb.message ? String(eHb.message).slice(0, 120) : 'throw'
      });
      handleSendFailure('heartbeat_throw');
    }
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
   * send 失败 / 看门狗触发的统一处理：close 当前 socket 并立即调度重连。
   *
   * 不依赖 onClose（Android wx 8.0.70 实测 onClose 可延迟 51~187 秒），
   * 立即同步 close + schedule reconnect；onClose 真到来时 reconnectTimer 已占位会自动去重。
   *
   * @param {string} reason 触发原因
   * @returns {void}
   */
  function handleSendFailure(reason) {
    if (manualClose || !roomId) return;
    safeLog(logger, 'transient_failure', { reason: String(reason || 'unknown') });
    clearHeartbeatTimer();
    clearWatchdogTimer();
    clearHandshakeTimer();
    clearAttemptClearTimer();
    connecting = false;
    if (socketTask) {
      try { socketTask.close({}); } catch (eClose) { /* ignore */ }
      socketTask = null;
    }
    scheduleReconnect();
  }

  /**
   * 调度指数退避重连。
   * @param {{ minDelayMs?: number }} [opts] 可指定最小延迟（如 token_fail 时给一个更宽松下限）
   * @returns {void}
   */
  function scheduleReconnect(opts) {
    if (manualClose || !roomId || reconnectTimer) return;
    reconnectAttempt += 1;
    let delay = getWsReconnectDelayMs(reconnectAttempt);
    if (opts && typeof opts.minDelayMs === 'number') {
      delay = Math.max(delay, opts.minDelayMs);
    }
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
    clearHandshakeTimer();
    clearAttemptClearTimer();
    connecting = false;
    if (socketTask) {
      try { socketTask.close({}); } catch (eClose) { /* ignore */ }
      socketTask = null;
    }
    scheduleReconnect();
  }

  /**
   * 网络类型变化回调。
   *
   * 防抖策略（修复 wifi↔4g 快速来回切的反复断连）：
   *   - 同类型「假切换」（如 wifi→wifi）直接跳过，不打断当前会话；
   *   - 真切换走 WS_NETWORK_CHANGE_DEBOUNCE_MS 防抖：让网络栈稳定后再 close + reconnect；
   *   - 期间如果再次切换，复位防抖窗口，避免一边切一边重连请求 token 失败。
   *
   * @param {{ isConnected: boolean, networkType: string }} res
   * @returns {void}
   */
  function onNetworkChange(res) {
    if (manualClose || !roomId) return;
    const nextType = res && res.networkType ? String(res.networkType) : '';
    const isConnected = !!(res && res.isConnected);
    const sameType = !!nextType && nextType === lastNetworkType;
    safeLog(logger, 'network_change', {
      net_type: nextType,
      prev: lastNetworkType,
      is_connected: isConnected,
      debounced: !sameType && isConnected
    });
    lastNetworkType = nextType;
    /* 同类型「假切换」：底层 IP 多半未变，不打断当前 socket */
    if (sameType) return;
    if (!isConnected) return;
    /* 真切换：进入防抖窗口；窗口内再来一次切换会自动 reset */
    clearNetworkChangeTimer();
    networkChangeTimer = setTimeout(function () {
      networkChangeTimer = null;
      if (manualClose || !roomId) return;
      const now = Date.now();
      const recvAge = lastRecvAt ? now - lastRecvAt : -1;
      const sendAge = lastSendAt ? now - lastSendAt : -1;
      const openAge = openedAt ? now - openedAt : -1;
      const linkFresh =
        (recvAge >= 0 && recvAge <= WS_NETWORK_CHANGE_FRESH_RECV_MS) ||
        (sendAge >= 0 && sendAge <= WS_NETWORK_CHANGE_FRESH_SEND_MS) ||
        (openAge >= 0 && openAge <= WS_NETWORK_CHANGE_OPEN_GRACE_MS);

      if (socketTask && linkFresh) {
        safeLog(logger, 'network_change_skip_fresh', {
          net_type: nextType,
          recv_age_ms: recvAge,
          send_age_ms: sendAge,
          open_age_ms: openAge
        });
        return;
      }

      if (socketTask) {
        safeLog(logger, 'network_change_probe', {
          net_type: nextType,
          recv_age_ms: recvAge,
          send_age_ms: sendAge,
          open_age_ms: openAge
        });
        sendHeartbeatOnce(function () {
          safeLog(logger, 'network_change_probe_ok', { net_type: nextType });
        });
        return;
      }

      handleSendFailure('network_change');
    }, WS_NETWORK_CHANGE_DEBOUNCE_MS);
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
      try {
        if (typeof wx.getNetworkType === 'function') {
          wx.getNetworkType({
            success: function (r) {
              lastNetworkType = r && r.networkType ? String(r.networkType) : '';
            }
          });
        }
      } catch (eGet) { /* ignore */ }
    } catch (eNet) {
      networkChangeHandler = null;
    }
  }

  /**
   * 卸载网络变化监听器（destroy 时调用）。
   * @returns {void}
   */
  function uninstallNetworkListener() {
    clearNetworkChangeTimer();
    if (!networkChangeHandler) return;
    try {
      if (typeof wx !== 'undefined' && typeof wx.offNetworkStatusChange === 'function') {
        wx.offNetworkStatusChange(networkChangeHandler);
      }
    } catch (eNet) { /* ignore */ }
    networkChangeHandler = null;
  }

  /**
   * 握手超时看门狗。
   *
   * 阶段隔离：'token' 阶段（fetchWsToken）= 10s；'socket' 阶段（等 onOpen）= 15s。
   *
   * 防误杀：fire 时再次校验 `openedAt > 0` —— 若 onOpen 已到（旧版踩过坑：
   * 14ms 之差把好连接关掉），直接 bail。
   *
   * @param {'token'|'socket'} stage 阶段标记
   * @returns {void}
   */
  function armHandshakeWatchdog(stage) {
    clearHandshakeTimer();
    const timeout = stage === 'socket' ? WS_HANDSHAKE_SOCKET_TIMEOUT_MS : WS_HANDSHAKE_TOKEN_TIMEOUT_MS;
    handshakeTimer = setTimeout(function () {
      handshakeTimer = null;
      if (manualClose) return;
      if (openedAt > 0) {
        safeLog(logger, 'handshake_timeout_skip_open', {
          stage: String(stage || ''),
          since_open_ms: Date.now() - openedAt
        });
        return;
      }
      safeLog(logger, 'handshake_timeout', {
        stage: String(stage || ''),
        has_socket: !!socketTask,
        attempt: reconnectAttempt,
        timeout_ms: timeout
      });
      connecting = false;
      if (socketTask) {
        try { socketTask.close({}); } catch (eClose) { /* ignore */ }
        socketTask = null;
      }
      if (!manualClose && roomId && !reconnectTimer) {
        scheduleReconnect();
      }
    }, timeout);
  }

  /**
   * 建立 WebSocket 长连接（先取 Token 再 connectSocket）。
   *
   * 修复重点（与采集端策略一致）：
   *   1) 整段加握手超时：token 阶段 10s、socket 阶段 15s；
   *   2) onOpen 不再立即清零 reconnectAttempt，改为「稳定 8s」后才清零，避免短命
   *      连接（如服务端 25s idle 强关）掩盖退避计数；
   *   3) 短命连接计数 → 累计达阈值进入紧急心跳模式（7s）；
   *   4) token_fail 走 max(指数退避, WS_TOKEN_FAIL_MIN_DELAY_MS) 的更宽松退避。
   *
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
    armHandshakeWatchdog('token');

    fetchWsToken(roomId).then(function (token) {
      safeLog(logger, 'token_ok', {});
      if (manualClose) {
        connecting = false;
        clearHandshakeTimer();
        return;
      }
      emitPhase('handshake');
      armHandshakeWatchdog('socket');
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
            clearHandshakeTimer();
            safeLog(logger, 'connect_socket_fail', {
              msg: err && err.errMsg ? String(err.errMsg).slice(0, 120) : 'fail'
            });
            emitPhase('error', 'connectSocket fail');
            if (typeof cb.onError === 'function') cb.onError(err || {});
            if (!manualClose && roomId) scheduleReconnect();
          }
        });
      } catch (errConnect) {
        connecting = false;
        clearHandshakeTimer();
        emitPhase('error', 'connectSocket throw');
        safeLog(logger, 'connect_socket_throw', {
          msg: errConnect && errConnect.message ? String(errConnect.message).slice(0, 120) : 'throw'
        });
        if (!manualClose && roomId) scheduleReconnect();
        return;
      }

      socketTask.onOpen(function () {
        connecting = false;
        clearHandshakeTimer();
        clearReconnectTimer();
        openedAt = Date.now();
        lastRecvAt = 0;
        lastSendAt = 0;
        safeLog(logger, 'open', {
          room: roomId,
          emergency_heartbeat: heartbeatEmergency,
          shortlived_streak: shortLivedStreak
        });
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
        /* 稳定 WS_ATTEMPT_CLEAR_AFTER_MS 后才视为真活，再清零退避；
           这样 25s 被服务端 1006 关闭这类短命场景也能正确推进退避 */
        clearAttemptClearTimer();
        attemptClearTimer = setTimeout(function () {
          attemptClearTimer = null;
          reconnectAttempt = 0;
          shortLivedStreak = 0;
          if (heartbeatEmergency) {
            heartbeatEmergency = false;
            safeLog(logger, 'heartbeat_emergency_off', {});
          }
        }, WS_ATTEMPT_CLEAR_AFTER_MS);
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
        clearHandshakeTimer();
        const sinceOpen = openedAt ? Date.now() - openedAt : -1;
        const code = res && typeof res.code === 'number' ? res.code : -1;
        /* 短命连接统计：onOpen 后 30s 内被关掉的连接累计；连续达阈值 → 紧急心跳 */
        const wasOpen = openedAt > 0;
        if (wasOpen && sinceOpen >= 0 && sinceOpen < WS_SHORTLIVED_OPEN_MS && !manualClose) {
          shortLivedStreak = (shortLivedStreak || 0) + 1;
          if (!heartbeatEmergency && shortLivedStreak >= WS_SHORTLIVED_TRIGGER_COUNT) {
            heartbeatEmergency = true;
            safeLog(logger, 'heartbeat_emergency_on', {
              streak: shortLivedStreak,
              last_since_open_ms: sinceOpen,
              code: code
            });
          }
        }
        clearAttemptClearTimer();
        safeLog(logger, 'close', {
          code: code,
          reason: res && res.reason ? String(res.reason).slice(0, 120) : '',
          since_open_ms: sinceOpen,
          last_send_ago_ms: lastSendAt ? Date.now() - lastSendAt : -1,
          last_recv_ago_ms: lastRecvAt ? Date.now() - lastRecvAt : -1,
          manual: manualClose,
          shortlived_streak: shortLivedStreak,
          emergency_heartbeat: heartbeatEmergency
        });
        socketTask = null;
        openedAt = 0;
        if (typeof cb.onClose === 'function') cb.onClose();
        if (manualClose) {
          emitPhase('idle');
          return;
        }
        scheduleReconnect();
      });
    }).catch(function (err) {
      connecting = false;
      clearHandshakeTimer();
      emitPhase('error', 'token fail');
      safeLog(logger, 'token_fail', {
        msg: err && err.message ? String(err.message).slice(0, 120) : 'fail'
      });
      if (typeof cb.onError === 'function') cb.onError(err || {});
      if (!manualClose && roomId) {
        scheduleReconnect({ minDelayMs: WS_TOKEN_FAIL_MIN_DELAY_MS });
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
    clearHandshakeTimer();
    clearAttemptClearTimer();
    clearNetworkChangeTimer();
    reconnectAttempt = 0;
    shortLivedStreak = 0;
    heartbeatEmergency = false;
    heartbeatSeq = 0;
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
      last_recv_ago_ms: lastRecvAt ? now - lastRecvAt : -1,
      hb_emergency: heartbeatEmergency,
      hb_base_ms: WS_HEARTBEAT_INTERVAL_MS,
      hb_emergency_ms: WS_HEARTBEAT_EMERGENCY_MS,
      shortlived_streak: shortLivedStreak,
      last_net_type: lastNetworkType
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
  WS_HEARTBEAT_EMERGENCY_MS: WS_HEARTBEAT_EMERGENCY_MS,
  WS_HEARTBEAT_JITTER_MS: WS_HEARTBEAT_JITTER_MS,
  WS_NETWORK_CHANGE_DEBOUNCE_MS: WS_NETWORK_CHANGE_DEBOUNCE_MS,
  WS_NETWORK_CHANGE_FRESH_RECV_MS: WS_NETWORK_CHANGE_FRESH_RECV_MS,
  WS_NETWORK_CHANGE_FRESH_SEND_MS: WS_NETWORK_CHANGE_FRESH_SEND_MS,
  WS_NETWORK_CHANGE_OPEN_GRACE_MS: WS_NETWORK_CHANGE_OPEN_GRACE_MS,
  WS_HANDSHAKE_SOCKET_TIMEOUT_MS: WS_HANDSHAKE_SOCKET_TIMEOUT_MS,
  WS_HANDSHAKE_TOKEN_TIMEOUT_MS: WS_HANDSHAKE_TOKEN_TIMEOUT_MS,
  WS_RECV_STALE_MS: WS_RECV_STALE_MS
};
