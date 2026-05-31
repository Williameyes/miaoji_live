/**
 * @fileoverview 采集端 (WebSocket 云端同步 + VisionKit OCR)
 *
 * V5 架构（视觉感知层）：
 *   - 时间：轮询泵，单 VK 通道，busy 时仅保留最新帧（不排队历史时间）
 *   - 比分：Worker 主/客分 patch diff 事件驱动（不传整帧）
 *   - Worker 崩溃时自动 fallback 至 legacy 双泵模式
 *
 * ROI 选区数据结构（归一化坐标，相对于相机预览区）：
 *   { x: 0-1, y: 0-1, w: 0-1, h: 0-1, label: string, rawText: string, pctStyle: string }
 */

var API = require('../../../../config/api.js');
var REQ = require('../../../../utils/request.js');
var wsTokenReq = require('../../../../utils/ws-token-request.js');
var COLLECTOR_AUDIT = require('./audit.js');

/**
 * 审计专用：设置下一次 _commitLocalState 的 clock_source 上下文。
 * @param {string} source
 * @param {string} reason
 * @param {string} functionName
 * @returns {void}
 */
function setAuditClockSource(source, reason, functionName) {
  COLLECTOR_AUDIT.setClockSourceContext({
    source: source,
    reason: reason,
    functionName: functionName
  });
}

/**
 * 审计专用：clockMode 写入前记录 mode_change。
 * ✅ BUG-3/5 修复：仅在 mode 真正发生变化时写入审计，避免 96% 同值→同值噪声占满 ring buffer。
 * @param {string} nextMode
 * @param {string} reason
 * @param {string} functionName
 * @returns {void}
 */
function auditBeforeClockMode(nextMode, reason, functionName) {
  if (_clockMode === nextMode) return; // 同值→同值，跳过审计
  COLLECTOR_AUDIT.auditModeChange({
    prevMode: _clockMode,
    nextMode: nextMode,
    reason: reason,
    functionName: functionName
  });
}

/**
 * 审计专用：clockRunning 写入前记录 running_change。
 * ✅ BUG-3/5 修复：仅在 running 真正发生变化时写入审计。
 * @param {boolean} next
 * @param {string} reason
 * @param {string} functionName
 * @returns {void}
 */
function auditBeforeClockRunning(next, reason, functionName) {
  if (!!_procState.clockRunning === !!next) return; // 同值→同值，跳过审计
  COLLECTOR_AUDIT.auditRunningChange({
    prev: !!_procState.clockRunning,
    next: !!next,
    reason: reason,
    functionName: functionName
  });
}

/** WSS 网关根地址（由 HTTPS BaseURL 推导） */
var WS_BASE_URL = String(API.API_BASE_URL || '').replace(/^http/i, 'ws');
/** 获取一次性 Token 的 HTTP 路径 */
var WS_TOKEN_PATH = '/api/get_token';
/** WebSocket 握手路径 */
var WS_SOCKET_PATH = '/gaoguang-ws';
/** 假停表防御：同一秒持续超过该毫秒才发 STOP */
var OCR_FAKE_STOP_HOLD_MS = 1200;
/** 假停表：同一秒需连续 OCR 样本次数（防走表 OCR 慢读误触） */
var OCR_FAKE_STOP_STREAK = 3;
/** 篮球单节比赛时钟分钟 plausible 上限（含 CBA 12 分钟节） */
var OCR_GAME_CLOCK_MAX_MINUTES = 15;
/** 停表恢复后 OCR 落差超过该秒数则一次性 snap 校准（避免 capSync 逐秒追 20s） */
var OCR_PAUSE_RESUME_SNAP_MIN_SEC = 3;
/** 开表恢复：连续读到同一更低秒数才发 START（防停表 OCR 误读） */
var OCR_START_CONFIRM_STREAK = 2;
/** 遮挡判定：时间/主分/客分均无法识别超过该毫秒 */
var OCR_OCCLUSION_HOLD_MS = 2800;
/** 遮挡恢复期：三项成功读数的判定窗口（轮询+超时下需宽于 OCR_OCCLUSION_HOLD_MS） */
var OCR_OCCLUSION_FRESH_MS = 4500;
/** 遮挡期间比分泵间隔（降频，把时间槽让给时间 OCR 破冰） */
var SCORE_PUMP_INTERVAL_OCCLUSION_MS = 1000;
/** 连续比分 OCR 超时达到该次数后熔断比分泵，把时间槽让给时间 OCR */
var OCR_SCORE_TIMEOUT_STREAK_PAUSE = 2;
/** 比分泵熔断时长（毫秒） */
var OCR_SCORE_PUMP_PAUSE_MS = 6000;
/** 连续熔断达到该次数后，长时间静默比分泵以保住时间通道 */
var OCR_SCORE_CIRCUIT_MAX_TRIPS = 3;
/** 比分泵长时间静默（毫秒） */
var OCR_SCORE_PUMP_QUIESCE_MS = 12000;
/** SDK 连续超时进入降载模式的次数阈值 */
var OCR_SDK_DEGRADED_TIMEOUT_STREAK = 3;
/** SDK 降载模式持续时长（毫秒） */
var OCR_SDK_DEGRADED_DURATION_MS = 45000;
/** 降载时时间泵间隔（毫秒） */
var OCR_TIME_PUMP_DEGRADED_MS = 450;
/** 降载时 OCR 超时后的 settle（毫秒） */
var OCR_TIMEOUT_SETTLE_DEGRADED_MS = 650;
/** 软重启最小间隔（防止 timeout 触发重建风暴） */
var OCR_SOFT_RESTART_MIN_INTERVAL_MS = 120000;
/** 连续手动失败触发软重启的阈值（滑动窗口内） */
var OCR_MANUAL_FAIL_THRESHOLD = 18;
/** 超时日志节流（毫秒） */
var OCR_TIMEOUT_LOG_THROTTLE_MS = 10000;
/** 启用比分泵前需连续成功识别时间的次数 */
var OCR_TIME_BASELINE_STREAK = 3;
/** 超过该毫秒未成功识别时间 ROI，调度器优先时间泵 */
var OCR_TIME_STARVATION_MS = 1800;
/** 比分 bootstrap 连续误读 0 达此次数后放弃该侧（避免占满 OCR 通道） */
var OCR_SCORE_BOOTSTRAP_GIVE_UP_STREAK = 3;
// Removed OCR_PREDICT_SUSPEND_MS
/** 软 SYNC / 观察室单次允许校正的最大秒数（防止饥饿恢复后一次跳 6s+） */
var OCR_SOFT_SYNC_MAX_STEP_SEC = 2;
/** 节间复位：参考时钟低于该值且 OCR 读到 ≥8:00 时视为新节 10:00 */
var OCR_PERIOD_RESET_REF_MAX_SEC = 420;
/** 节间复位：OCR 读数至少为该秒数（8:00） */
var OCR_PERIOD_RESET_MIN_SEC = 480;
/** 参考时钟仍 >2min 时，拒绝 0:xx（防 24s 进攻时间被 SS.m 误当比赛时钟） */
var OCR_SHOT_CLOCK_MASK_REF_MIN_SEC = 120;
/** 分钟十位 3↔8、5↔9 误读：相对参考正向跳变秒数下限 */
var OCR_CLOCK_TENS_GLITCH_MIN_DELTA_SEC = 180;
/** 分钟十位误读：相对参考正向跳变秒数上限 */
var OCR_CLOCK_TENS_GLITCH_MAX_DELTA_SEC = 420;
/** 分钟十位误读：分钟差下限（如 5:23→9:23 差 4） */
var OCR_CLOCK_TENS_GLITCH_MINUTE_DIFF = 4;
/** 分钟十位误读：分钟差上限（如 3:38→8:38 差 5） */
var OCR_CLOCK_TENS_GLITCH_MAX_MINUTE_DIFF = 6;
/** 0:xx 误锚恢复：参考至少为该秒数（排除 ref=0 误放行 9:50 等） */
var OCR_CLOCK_SUBMINUTE_RECOVERY_MIN_REF_SEC = 10;
/** 遮挡恢复：连续多少次检测到三项均可读才退出遮挡 */
var OCR_OCCLUSION_RECOVER_STREAK = 2;
/** 遮挡状态评估最小间隔（毫秒） */
var OCR_OCCLUSION_EVAL_MS = 400;
/** 遮挡超时强制恢复：无时间 OCR 成功时仍用 hold 快照恢复走表（毫秒） */
var OCR_OCCLUSION_FORCE_CLEAR_MS = 4000;
/** SYNC 观察室：时间落差超过该秒数才进入观察 */
var OCR_SYNC_JUMP_THRESHOLD_SEC = 2;
/** SYNC 观察室：连续稳定帧数 */
var OCR_SYNC_CONFIRM_STREAK = 5;
/** 比分变化默认确认帧数（走表） */
var OCR_SCORE_CONFIRM_STREAK = 2;
/** 停表期间比分变化确认帧数（死球改分更急，略放宽） */
var OCR_SCORE_CONFIRM_STREAK_PAUSED = 2;
/** 走表时云端时间与 OCR 偏差超过该秒数则发软 SYNC 校准直播端 */
var OCR_SOFT_SYNC_DRIFT_SEC = 2;
/** 软 SYNC 防抖间隔 */
var OCR_SOFT_SYNC_DEBOUNCE_MS = 1500;
/** 预测补秒相对最近一次 OCR 时间最多允许领先的秒数 */
var OCR_CLOCK_PREDICT_MAX_LEAD_SEC = 1;
/** 高位频闪（截断误读）确认帧数 */
var OCR_SCORE_TRUNC_STREAK = 6;
/** WebSocket 断线重连退避序列（毫秒），上限 15 秒 */
var WS_RECONNECT_DELAYS_MS = [3000, 6000, 12000, 15000];
/**
 * 应用层心跳间隔基准（毫秒）。
 *
 * 历史教训（2026-05 现场日志）：
 *   - 心跳 25s 时，iOS 端 100% 在 open 后 25.0 秒整点被服务端以 1006 强关：
 *     `since_open_ms ≈ 25078 / 25088 / 25141`，且每次都在关闭前 70~130ms 有一次心跳
 *     send.success 回调；`last_recv_ago_ms: -1` 全程没有任何下行。
 *   - 推断：服务端 / 网关的 read idle ≈ 25s，心跳间隔与之撞车；且自定义 JSON
 *     `{type:'PING'}` 在某些代理下并不会被识别为"业务流量"来刷 idle。
 *
 * 现策略：基准 3s + 抖动。采集端心跳同时承担「刷新 lastSnapshot」职责，直播端中途接入
 * 时最多拿到几秒前的快照，而不是等下一次 START/STOP/SYNC 事件。
 * @type {number}
 */
var WS_HEARTBEAT_INTERVAL_MS = 3000;
/** 心跳间隔最大抖动（毫秒），避免多个心跳跟服务端时钟同步「叠在 idle 边界」上。 */
var WS_HEARTBEAT_JITTER_MS = 500;
/** 紧急模式心跳间隔（连续短命连接时启用），更激进地刷 idle。 */
var WS_HEARTBEAT_EMERGENCY_MS = 7000;
/** open 后多久内被关视为「短命连接」，连续 N 次触发紧急心跳模式。 */
var WS_SHORTLIVED_OPEN_MS = 30000;
/** 触发紧急心跳模式所需的连续短命次数。 */
var WS_SHORTLIVED_TRIGGER_COUNT = 3;
/** 看门狗检查间隔。 */
var WS_WATCHDOG_INTERVAL_MS = 10000;
/**
 * 心跳累计未成功发送的最大间隔；超过即视为底层链路死、强制 reconnect。
 * 采集端不依赖服务端下行（除错误码），所以采用「send 健康度」作为存活判据：
 * 12s 心跳 + 10s 看门狗，45s 内若没有任何成功 send（包括心跳）即认定假死。
 */
var WS_SEND_STALE_MS = 45000;
/**
 * 握手超时（socket 阶段）：connectSocket 后多久内必须收到 onOpen，否则强制重连。
 *
 * 历史教训 1：Android（Xiaomi M2102J2SC, wx 8.0.70）的某些 case 下 `wx.connectSocket`
 *   既不触发 fail 也不触发 open/close 任何回调，UI 永远停在「握手中…」。
 * 历史教训 2：同一 Android case，wx onOpen 与 setTimeout fire 几乎同帧进入事件循环，
 *   8s 这个阈值会"误杀"一个 14ms 后就正常 open 的连接（since_open_ms=3 后被 1000 关）。
 *   将 socket 阶段超时拉到 15s，并在 timer 触发时再二次校验 `_wsOpenedAt`。
 */
var WS_HANDSHAKE_SOCKET_TIMEOUT_MS = 15000;
/** 握手超时（token 阶段）：fetchWsToken 一直挂起的兜底，独立于 socket 阶段。 */
var WS_HANDSHAKE_TOKEN_TIMEOUT_MS = 10000;
/** 网络切换后延迟多久再发起重连（让网络栈稳定）。 */
var WS_NETWORK_CHANGE_DEBOUNCE_MS = 1500;
/** 网络切换后若刚收到下行，说明链路仍新鲜，不主动断开。 */
var WS_NETWORK_CHANGE_FRESH_RECV_MS = 15000;
/** 网络切换后若刚成功上行，优先保留链路，交给心跳/看门狗继续体检。 */
var WS_NETWORK_CHANGE_FRESH_SEND_MS = 15000;
/** 刚 open 的 socket 给一个宽限期，避免 iOS 网络类型回调把新连接立刻关掉。 */
var WS_NETWORK_CHANGE_OPEN_GRACE_MS = 8000;
/** open 成功后稳定多久才清零 reconnectAttempt（避免短命连接掩盖退避计数）。 */
var WS_ATTEMPT_CLEAR_AFTER_MS = 8000;
/** token_fail 时的最小退避（毫秒）。 */
var WS_TOKEN_FAIL_MIN_DELAY_MS = 5000;
/** OCR/VK 重启期间保护 WS 的最长窗口，避免 native 重载造成一次心跳误杀长连接。 */
var OCR_WS_RESTART_GUARD_MS = 12000;

/** 采集端健康日志 Storage Key */
var COLLECTOR_HEALTH_LOG_STORAGE_KEY = 'SYNC_LAB_COLLECTOR_HEALTH_LOGS_V1';
/** 内存环形缓冲上限 */
var COLLECTOR_HEALTH_LOG_MAX = 200;
/** 落盘节流（毫秒） */
var COLLECTOR_HEALTH_LOG_FLUSH_DELAY_MS = 1800;

var STORAGE_KEY_ROIS = 'sync_lab_rois_v1';
var STORAGE_KEY_OCR_PRESET = 'sync_lab_ocr_preset_v1';
/** 本场稳定房间号（除非用户点「新房间」） */
var STORAGE_KEY_WS_ROOM_ID = 'sync_lab_collector_room_id_v1';
/** 当前 OCR 队列 ROI 数量：主队分、客队分、时间（已移除 24 秒 ROI）。 */
var OCR_ROI_COUNT = 3;
var OCR_MIN_INTERVAL_BASE_MS = 160;
var OCR_MIN_INTERVAL_MS = 160;
var OCR_PUMP_INTERVAL_MS = 120;
/** 单 ROI runOCR 默认超时（比分引擎使用；Android VK 实测常 >720ms） */
var OCR_RUN_TIMEOUT_MS = 1100;
/**
 * 时间 OCR 引擎超时：1500ms。
 *
 * 历史教训：曾经按需求把这个值压到 250ms，结果在双泵高频提交下 SDK 实际跑不完，
 * 我们却已经"放弃 + 释放 busy"并立即提交下一次 runOCR；SDK 内部队列被堆积，
 * 实际单次耗时被进一步拉到 1000ms+，整个采集链路雪崩（所有 ROI 全部超时，
 * pending overflow，状态机收不到样本，暂停被误识别为继续倒计时）。
 *
 * 现在用 1500ms：让 SDK 有真实的处理时间，避免"未完成→重新提交→队列堆积→更慢"
 * 死循环；OCR 实际感知到的延迟由状态机内的 captureTs 流水线补偿（realWorldSec =
 * ocrSec - lostSec）抵消，本地 UI 仍展示当前真实时钟；云端仅在状态翻转时发包。
 */
var OCR_TIME_RUN_TIMEOUT_MS = 1500;
/**
 * 任何 OCR 超时后强制等待 350ms 再提交下一次 runOCR：
 * 给 SDK 内部清队列的时间窗口，避免立刻补刀让队列雪崩。
 */
var OCR_TIMEOUT_SETTLE_MS = 350;
var OCR_MAX_VARIANTS_PER_RUN = 3;
var OCR_SCORE_TICK_INTERVAL = 8;
// Phase 2: Removed OCR_TIME_PREDICT_MAX_STALE_MS
/** V5 视觉门禁：全局 OCR cooldown（毫秒） */
var OCR_V5_COOLDOWN_MS = 200;
/** V5 视觉门禁：单 ROI cooldown（毫秒） */
var OCR_V5_ROI_COOLDOWN_MS = 200;
/** V5 Worker 降帧：每 N 帧检测 1 次（30fps → 10fps） */
var OCR_V5_FRAME_SKIP = 3;
/** V5 Worker baseline 稳定帧数 */
var OCR_V5_BASELINE_STABLE_FRAMES = 5;
/** V5 走表时时间 OCR 心跳间隔（毫秒，保证 predictClock 有锚点） */
var OCR_V5_TIME_HEARTBEAT_MS = 900;
/** V5 停表时时间 OCR 心跳间隔（毫秒） */
var OCR_V5_TIME_HEARTBEAT_PAUSED_MS = 1200;
/** V5 待触发比分 ROI 优先于时间心跳的等待阈值（毫秒） */
var OCR_V5_SCORE_PRIORITY_MS = 400;
/** V5 比分 OCR 心跳：超过该毫秒未成功则主动补采样 */
var OCR_V5_SCORE_HEARTBEAT_MS = 2500;
/** V5 走表时时间 OCR 节拍（毫秒，<1s 保证每秒至少一次采样，避免跳秒） */
var OCR_V5_TIME_TICK_MS = 950;
/** V5 诊断摘要输出间隔（毫秒） */
var OCR_V5_DIAG_SUMMARY_MS = 30000;
/** 预测补秒定时器基准 / 最后一分钟激进值 */
var OCR_CLOCK_PREDICT_TICK_BASE_MS = 500;
var OCR_CLOCK_PREDICT_TICK_FINAL_MS = 100;
/** 当前生效的预测补秒间隔（运行时根据 final-minute 模式动态切换） */
var OCR_CLOCK_PREDICT_TICK_MS = OCR_CLOCK_PREDICT_TICK_BASE_MS;
var OCR_CLOCK_PREDICT_ACTIVE_MS = 4500;
var OCR_CLOCK_CATCHUP_MAX_DROP_SEC = 20;
var OCR_CLOCK_CATCHUP_FAST_INTERVAL_MS = 520;
var OCR_CLOCK_NORMAL_INTERVAL_MS = 1000;
/** 状态机：PAUSE 持续阈值（同一 realWorldSec 持续这么久即认定停表） */
var OCR_CLOCK_PAUSE_HOLD_MS = 800;
/** 状态机：JUMP 持续阈值（异常跳跃维持这么久即视为人工改表） */
var OCR_CLOCK_JUMP_HOLD_MS = 600;
/** 状态机：JUMP 判定的「向下跳变」阈值，超过该秒数视为大跨度跳变 */
var OCR_CLOCK_JUMP_DROP_THRESHOLD = 5;
/** 状态机：RESUME 判定允许的最大下降秒数（超过则不触发"秒启" force-emit） */
var OCR_CLOCK_RESUME_DROP_MAX = 2;
/** 兼容历史代码（已被新状态机取代但仍被部分路径读取） */
var OCR_CLOCK_PAUSE_CONFIRM_MS = OCR_CLOCK_PAUSE_HOLD_MS;
var OCR_CLOCK_RESUME_CONFIRM_MS = 700;
/** 双频双泵基准间隔：时间高频，比分低频，共享单条 VK 运行通道 */
var TIME_PUMP_INTERVAL_BASE_MS = 120;
var TIME_PUMP_INTERVAL_FINAL_MS = 80;
var SCORE_PUMP_INTERVAL_BASE_MS = 800;
/** 当前生效的双泵间隔（最后一分钟会动态压榨 TIME_PUMP_INTERVAL） */
var TIME_PUMP_INTERVAL = TIME_PUMP_INTERVAL_BASE_MS;
var SCORE_PUMP_INTERVAL = SCORE_PUMP_INTERVAL_BASE_MS;
/** 时间 ROI 刷新间隔（收紧以减轻跳秒观感）。 */
// Phase 4: Time OCR cycle calibration & drift soft sync
var TIME_OCR_RUNNING_INTERVAL_MS = 700;
var TIME_OCR_STOPPED_INTERVAL_MS = 500;
var TIME_OCR_RECOVERY_INTERVAL_MS = 300;
var CLOCK_DRIFT_SOFT_SYNC_MS = 1000;
var CLOCK_DRIFT_HARD_SYNC_MS = 3000;
var MAX_PREDICT_WITHOUT_CONFIRM_MS = 8000;

var OCR_TIME_REFRESH_MS = 160;
/** 比分 ROI 刷新间隔（放宽，把更多 OCR 槽让给时钟；比分另有确认门禁）。 */
var OCR_SCORE_REFRESH_MS = 800;
/**
 * 距上次时间 ROI 解析成功超过该毫秒时，在队列中优先时间 ROI。
 * @type {number}
 */
var OCR_TIME_PRIORITY_MS = 150;
/**
 * 任一侧相对上一提交比分变化 ≥ 该阈值时，需连续两帧解析出相同 (主,客) 分才接受，
 * 抑制 118→8、150→1 等丢位误读；常规单回合得分变化通常低于该值。
 * @type {number}
 */
var OCR_SCORE_JUMP_CONFIRM_THRESHOLD = 10;
/**
 * 大单帧跳变后若 OCR 读回与上一提交相差在该范围内，视为抖回上一稳定值，清除待确认。
 * @type {number}
 */
var OCR_SCORE_JUMP_REVERT_EPSILON = 4;
/**
 * 仅当用户在「本采集页」点按改分/重置时短旁路大单帧门禁（技术台改分走现场记分牌，不经过此处）。
 * @type {number}
 */
var OCR_SCORE_JUMP_MANUAL_GUARD_MS = 1500;
/** 一般大单帧跳变需连续多少帧解析出相同 (主,客) 分才接受（非截断类）。 */
var OCR_SCORE_JUMP_STREAK_NORMAL = 3;
/**
 * 疑似「高位截断」误读（如 111→11）时要求更多连续一致帧，减轻稳定误读过关。
 * @type {number}
 */
var OCR_SCORE_JUMP_STREAK_TRUNC = 5;
/** 单场 OCR 比分 plausible 上限（篮球含加时；超过则在 parse 层丢弃）。 */
var OCR_SCORE_MAX = 200;
var MIN_TIME_TRIGGER_INTERVAL_MS = 120;
var _lastTimeOcrTriggerTs = 0;
/** 长时运行：约 50 分钟温和重建 VK 会话，降低 session 僵死与内存爬升风险 */
var OCR_SESSION_REBUILD_MS = 50 * 60 * 1000;
var OCR_SESSION_ROTATE_MS = 18 * 60 * 1000;
/** 健康检查间隔（重建判定、后台恢复） */
var OCR_HEALTH_INTERVAL_MS = 60 * 1000;
var OCR_MANUAL_FAIL_WINDOW_MS = 90 * 1000;
var ROI_MIN_SIZE = 0.05; // 归一化最小宽/高，防止缩至 0

var DEFAULT_ROIS = [
  { x: 0.05, y: 0.15, w: 0.25, h: 0.20, label: '主队分', rawText: '' },
  { x: 0.70, y: 0.15, w: 0.25, h: 0.20, label: '客队分', rawText: '' },
  { x: 0.30, y: 0.35, w: 0.40, h: 0.18, label: '时间', rawText: '' }
];

/** @type {WechatMiniprogram.SocketTask | null} */
var _socketTask = null;
var _wsRoomId = '';
var _wsConnecting = false;
var _wsManualClose = false;
var _wsReconnectAttempt = 0;
var _wsReconnectTimer = 0;
/** 全局单调递增发包序列号（业务包与快照心跳共用，保证直播端可接收最新快照） */
var _globalSeq = 0;
/** 心跳独立序列号，仅作诊断字段；快照心跳仍会占用业务 seq */
var _wsHeartbeatSeq = 0;
/** 页面实例引用，供心跳/看门狗失败时主动触发 setData 与 _scheduleWsReconnect */
var _wsPageRef = null;
/** 心跳定时器句柄（setTimeout，每次心跳后重新 schedule，自带随机抖动） */
var _wsHeartbeatTimer = 0;
/** 看门狗定时器句柄 */
var _wsWatchdogTimer = 0;
/** 握手超时定时器：connectSocket 后启动；onOpen 时清除 */
var _wsHandshakeTimer = 0;
/** open 成功后用于清零 reconnectAttempt 的延迟定时器 */
var _wsAttemptClearTimer = 0;
/** 网络变化重连的防抖定时器 */
var _wsNetworkChangeTimer = 0;
/** OCR 重启期间暂缓 WS 主动断开/退避重连的保护窗口。 */
var _ocrWsRestartGuardUntil = 0;
var _ocrWsRestartGuardReason = '';
var _ocrWsReconnectPendingAfterRestart = false;
var _ocrWsImmediateReconnectUsed = false;
var _ocrForceSyncAfterPump = false;
var _ocrPreserveSnapshotOnBoot = false;
/** 当前 socket onOpen 时间戳（诊断用） */
var _wsOpenedAt = 0;
/** 最近一次 send.success 时间戳（含心跳与业务发包） */
var _wsLastSendOkAt = 0;
/** 最近一次收到下行（业务广播或错误消息）时间戳 */
var _wsLastRecvAt = 0;
/** wx.onNetworkStatusChange 已安装的回调，供 destroy 时摘除 */
var _wsNetworkChangeHandler = null;
/** 最近一次记录的网络类型，用于过滤同类型「假切换」 */
var _wsLastNetworkType = '';
/** 紧急心跳模式下连续短命连接的剩余触发计数；为 0 退出紧急模式 */
var _wsShortLivedStreak = 0;
/** 紧急心跳模式是否启用 */
var _wsHeartbeatEmergency = false;
/** 采集端健康日志环形缓冲 */
var _collectorHealthLogs = null;
/** 健康日志落盘节流定时器 */
var _collectorHealthLogFlushTimer = 0;
/** 设备信息一次性采集，用于日志 header */
var _collectorHealthLogDevice = null;
/** 是否已初始化健康日志（onLoad 兜底防重复） */
var _collectorHealthLogInitialized = false;
/**
 * processOcrFrame 状态机（5 大防抖阀门 + 已发布快照）
 * @type {{
 *   clockRunning: boolean,
 *   sameSecFirstSeen: number,
 *   lastOcrSec: number,
 *   syncObserve: { sec: number, streak: number } | null,
 *   scoreObserve: { h: number, a: number, streak: number, needStreak: number } | null,
 *   published: { t: number, a: number, b: number, p: number, shotClock: number, running: boolean, wallMs: number } | null,
 *   sameSecStreak: number,
 *   pauseConfirmed: boolean,
 *   startObserve: { sec: number, streak: number } | null
 * }}
 */
var _procState = {
  clockRunning: false,
  sameSecFirstSeen: 0,
  lastOcrSec: -1,
  syncObserve: null,
  scoreObserve: null,
  published: null,
  sameSecStreak: 0,
  pauseConfirmed: false,
  startObserve: null
};
var _cameraContext = null;
var _cameraFrameListener = null;
var _ocrVkCanvas = null;
var _ocrVkGl = null;

/** @type {any} VKSession 实例 */
var _vkSession = null;
var _lastHandleTs = 0;   // OCR 锚点兜底门控时间戳
var _pendingOcrFrame = null;
var _lastCommittedFrameKey = '';
var _ocrBootTimer = 0;
var _ocrCameraRemountTimer = 0;
var _ocrSessionToken = 0;
var _ocrSessionGeneration = 0;
var _ocrAnchorWatchdogTimer = 0;
var _ocrAnchorEventCount = 0;
var _ocrNativeTextEventCount = 0;
var _ocrAnchorLogSeq = 0;
var _ocrPumpTimer = 0;
var _ocrPumpFrameCount = 0;
var _ocrPumpLastTickTs = 0;
// Phase 5: 单 VK 通道 + 时间最新帧覆盖（不排队）
var _ocrVkBusy = false;
var _timeOcrBusy = false;
var _scoreOcrBusy = false;
/** 时间 OCR busy 时仅保留最新一帧，完成后再跑（永不排队历史帧） */
var _pendingTimeFrame = null;
/** 当前进行中的时间 OCR 对应的 captureTs（用于丢弃过期回调） */
var _activeTimeOcrCaptureTs = 0;
var _ocrRunBusy = false;
var _ocrTimeRunState = null;
var _ocrScoreRunState = null;
/**
 * 物理 runOCR 请求 FIFO（单路通道 + 无请求 ID 回调的可靠配对）。
 * 每项: { reqId, state, captureTs, abandoned, sentAt }。
 * 单路通道保证回调按发送顺序到达，因此回调到来即对应队首请求；
 * 超时的请求标记 abandoned 但保留在队列，待其迟到回调到达时被丢弃，杜绝错配。
 * @type {Array<{reqId:number,state:object,captureTs:number,abandoned:boolean,sentAt:number}>}
 */
var _ocrReqQueue = [];
/** runOCR 物理请求单调递增序号 */
var _ocrReqSeq = 0;
/** 迟到回调清理：abandoned 请求超过该毫秒视为 SDK 丢弃，发新请求时清出队列防止永久错位 */
var OCR_REQ_ABANDON_PURGE_MS = 3000;
var _ocrRunLastTs = 0;
var _ocrRunState = null;
var _ocrRunTimeout = 0;
var _ocrTimeoutSettleUntil = 0;
var _ocrBusySince = 0;
var _ocrRunStartedAt = 0;
var _ocrQueueCursor = 0;
var _ocrTick = 0;
var _ocrManualMode = false;
/** 最近一次时间 ROI 解析出合法 mm:ss 的墙钟时间戳（供时间优先调度）。 */
var _ocrLastTimeSuccessTs = 0;
/** 比分泵熔断截止墙钟（连续超时后暂停提交比分 runOCR） */
var _ocrScorePumpPauseUntil = 0;
/** 连续比分 OCR 超时计数（达到阈值触发熔断） */
var _ocrScoreTimeoutStreak = 0;
/** 连续熔断次数（用于加长暂停 / 长时间静默） */
var _ocrScoreCircuitTripCount = 0;
/** 比分泵长时间静默截止墙钟 */
var _ocrScorePumpQuiesceUntil = 0;
/** 时间 ROI 连续成功次数（达到 OCR_TIME_BASELINE_STREAK 后才开放比分泵） */
var _ocrTimeSuccessStreak = 0;
/** 是否已建立时间 OCR 基线（开放比分泵门槛） */
var _ocrTimeBaselineReady = false;
/** 比分泵是否已因反复熔断而彻底关闭（直至重新开关 OCR） */
var _ocrScorePumpDisabled = false;
/** SDK 降载模式截止墙钟 */
var _ocrSdkDegradedUntil = 0;
/** 上次软重启墙钟 */
var _ocrLastSoftRestartAt = 0;
/** 上次 OCR 启动原因（供 boot 分支判断） */
var _ocrLastBootReason = '';
/** 超时 warn 日志节流 */
var _ocrTimeoutWarnLastTs = { score: 0, time: 0 };
/** 最近一次主队分 ROI 成功识别墙钟戳 */
var _ocrLastHomeScoreSuccessTs = 0;
/** 最近一次客队分 ROI 成功识别墙钟戳 */
var _ocrLastAwayScoreSuccessTs = 0;
/** 是否处于遮挡静默期（不处理 OCR、保留上次正确快照） */
var _ocrOcclusionActive = false;
/** 遮挡开始墙钟戳 */
var _ocrOcclusionSince = 0;
/** 遮挡恢复特权期截止墙钟戳 */
var _ocrRecoveryModeUntil = 0;
/** 遮挡期间最近一次成功 OCR 的比赛时钟总秒数（用于遮挡解除 snap） */
var _ocrOcclusionBestClockSec = -1;
/** 进入遮挡时冻结在 UI 上的比赛时钟总秒数（遮挡期不变、不追赶） */
var _occlusionHoldClockSec = -1;
/** 遮挡期内连续两次相同 best 时钟（用于解除前稳定，避免 4:04/05/06 闪动即解除） */
var _ocrOcclusionBestStableSec = -1;
var _ocrOcclusionBestStableStreak = 0;
/** 遮挡恢复连续确认计数 */
var _ocrOcclusionRecoverStreak = 0;
/** 上次遮挡评估墙钟戳 */
var _ocrOcclusionEvalLastTs = 0;
/** 遮挡期内最近一次有效主队分（用于恢复后立即同步） */
var _ocrLastGoodHomeScore = -1;
/** 遮挡期内最近一次有效客队分（用于恢复后立即同步） */
var _ocrLastGoodAwayScore = -1;
/** 遮挡期内最近一次有效时间秒数（用于恢复后立即同步） */
var _ocrLastGoodClockSec = -1;
/** 预测时钟：OCR 短时掉帧时根据墙钟平滑补秒，减轻恢复后跳秒。 */
var _predictedClock = null;
var _predictedClockWallTs = 0;
/** 最近一次本地 UI 提交的墙钟时间戳（供单帧时钟回跳检测）。 */
var _lastNotifyWallAt = 0;
/** 待下一帧复核的帧快照（时间疑似 OCR 跳变时暂缓本地提交）。 */
var _timeJumpHoldFrame = null;
/** 大单帧比分跳变待确认：同分值 streak 达标后放行。 */
var _scoreJumpHold = null;
/** 最近一次本采集页内手动改分时间（技术台改分不经过；仅短旁路用）。 */
var _manualScoreEditAt = 0;
var _lastCommittedFrame = null;
var _lastRejectedStableFrameKey = '';
var _lastRejectedStableFrameCount = 0;
var _ocrLastRoiRunTs = [0, 0, 0];
var _ocrRoiBackoffUntil = [0, 0, 0];
var _ocrRoiTextSeq = [0, 0, 0];
/** VK 会话启动时间戳，用于定时温和重建 */
var _ocrSessionStartedAt = 0;
var _ocrSessionBootAt = 0;
/** 周期性 OCR 健康检查 */
var _ocrHealthTimer = 0;
/** 手动 OCR 在滑动窗口内的失败时间戳（timeout / run 抛错） */
var _ocrManualFailTimestamps = [];
var _ocrConsecutiveTimeout = 0;
var _ocrFrameBufferPool = null;
var _lastPreviewFrameKey = '';
var _ocrStats = {
  timeout: 0,
  rotate: 0,
  success: 0,
  avgCost: 0
};
var _clockPredictTimer = 0;
var _clockPredictUntil = 0;
var _lastClockPredictEmitWallTs = 0;
var _lastClockPredictEmitSec = -1;

// Phase 4/6: New state machine variables
var _timeOcrHistorySec = -1;
var _consecutiveDecreaseCount = 0;
var _consecutiveSameCount = 0;
var _driftSoftAdjustRate = 1.0;

// Phase 3: time ROI motion hint
var _timeMotionActive = false; 
var _timeMotionLastChangeTs = 0;

// Phase 1: 建立 ClockStateMachine
var CLOCK_STATE_UNKNOWN = 0; 
var CLOCK_STATE_STOPPED = 1; 
var CLOCK_STATE_RUNNING = 2; 

var _clockState = CLOCK_STATE_UNKNOWN; 
var _clockAnchorMs = 0; 
var _clockAnchorWallTs = 0; 

// Legacy variables for compatibility
var _clockMode = 'unknown'; // 'unknown' | 'running' | 'paused'
var _lastOcrClockSec = -1;
var _lastOcrClockWallTs = 0;
/** 饥饿复苏后 running 锚点墙钟（供预测器对齐） */
var _ocrClockRunAnchorWallTs = 0;
/** 饥饿复苏后 running 锚点 OCR 秒数 */
var _ocrClockRunAnchorOcrSec = -1;
var _sameOcrClockSince = 0;
var _clockPauseCandidateUntil = 0;
var _clockResumeCandidateSec = -1;
var _clockResumeCandidateSince = 0;
var _clockResumeCandidateStreak = 0;
/** JUMP 候选：异常跳跃需连续 OCR_CLOCK_JUMP_HOLD_MS 维持同值才确认 */
var _clockJumpCandidateSec = -1;
var _clockJumpCandidateSince = 0;
/** 双频双泵节流阀（墙钟时间戳） */
var _lastTimePumpTs = 0;
var _lastScorePumpTs = 0;
/** 比分泵 round-robin 游标（0=主队分, 1=客队分） */
var _scorePumpCursor = 0;
/** V5 OCR Filter Worker 实例 */
var _ocrFilterWorker = null;
/** V5 Worker 是否已就绪 */
var _ocrFilterWorkerReady = false;
/** V5 Worker 是否已 fallback 至 legacy 双泵 */
var _ocrFilterFallback = false;
/** V5 待处理的 Worker OCR 触发 */
var _ocrPendingTrigger = null;
/** V5 全局 OCR 触发 cooldown 截止墙钟 */
var _ocrV5GlobalCooldownUntil = 0;
/** V5 各 ROI OCR cooldown 截止墙钟 */
var _ocrV5RoiCooldownUntil = [0, 0, 0];
/** V5 当前帧泵模式：'v5' | 'legacy' | '' */
var _ocrFramePumpMode = '';
/** V5 Worker 传 patch 模式（仅 copy；小程序 Worker 不支持 transfer） */
var _ocrFilterPostMode = 'copy';
/** V5 诊断计数器 */
var _ocrV5Diag = null;
/** V5 比分 ROI 轮询游标（0=主队, 1=客队） */
var _ocrV5ScorePumpCursor = 0;
/** 进入遮挡前是否在走表（用于 holdSec===clockSec 时恢复走表） */
var _ocrOcclusionWasRunning = false;
/** 上次时间 OCR 刚结束后的短冷却，避免同帧抢 VK（毫秒） */
var OCR_V5_SCORE_COOLDOWN_AFTER_TIME_MS = 120;
/** 待触发比分排队超过该毫秒则强制跑一次（防止永久 pending） */
var OCR_V5_SCORE_PENDING_FORCE_MS = 700;
/** V5 主分 OCR 成功墙钟（仅真实 OCR，供 heartbeat 判定） */
var _ocrV5LastHomeOcrTs = 0;
var _ocrV5LastAwayOcrTs = 0;
var _ocrV5LastTimeOcrOkTs = Date.now();
/** 比分 bootstrap 连续拒收 0 的次数 [主, 客] */
var _ocrScoreBootstrapRejectStreak = [0, 0];
/**
 * 比分二次确认缓冲 [主, 客]：新值（不等于当前 good）必须连续命中
 * 按分差阶梯确认相同读数后才采纳，杜绝单帧误读直接落地/上屏。
 * @type {Array<{ value: number, streak: number }>}
 */
var _ocrScoreConfirmBuf = [
  { value: -1, streak: 0 },
  { value: -1, streak: 0 }
];
/** 小分差(+1~+4)采纳所需连续相同读数 */
var OCR_SCORE_ACCEPT_STREAK_SMALL = 1;
/** 中等分差采纳所需连续相同读数 */
var OCR_SCORE_ACCEPT_STREAK_MED = 2;
/** 大跳分采纳所需连续相同读数 */
var OCR_SCORE_ACCEPT_STREAK_LARGE = 3;
/** 最近一次软 SYNC 墙钟（防抖） */
var _lastSoftSyncWallTs = 0;
/** 是否进入最后一分钟极限调度模式（minutes===0 && seconds<=60） */
var _isFinalMinuteMode = false;
/** 是否因小程序 onHide 暂停了相机帧泵（onShow 恢复） */
var _ocrPausedForBackground = false;
/** 相机预览区实际 px 尺寸 */
var _previewW = 0;
var _previewH = 0;
var _cameraReadyAt = 0;

/**
 * 拖拽/缩放状态
 * mode: 'move'      → 拖动整体，修改 x/y
 *       'resize-se' → 拖动右下角柄，修改 w/h
 */
var _dragging = null;
// rAF pending 防抖（touchmove 去重）
var _rafPending = false;
var _rafTouchX = 0;
var _rafTouchY = 0;
var _lastRoiTickTs = 0;

/** 兼容性 requestAnimationFrame */
var _rAF = (function () {
  try {
    if (typeof wx !== 'undefined' && typeof wx.requestAnimationFrame === 'function') {
      return function (cb) { return wx.requestAnimationFrame(cb); };
    }
  } catch (e) { }
  return function (cb) { return setTimeout(cb, 16); };
})();

function _getVkBootDelayMs() {
  try {
    var sys = wx.getSystemInfoSync();
    if (sys && sys.platform === 'ios') return 980;
  } catch (e) { }
  return 760;
}

function _getCameraRemountDelayMs() {
  try {
    var sys = wx.getSystemInfoSync();
    if (sys && sys.platform === 'ios') return 220;
  } catch (e) { }
  return 120;
}

/**
 * 用户在本采集页手动改分后极短窗口内放宽大单帧门禁（技术台改分仅反映在现场记分牌，主流程不依赖此项）。
 * @returns {void}
 */
function bumpManualScoreEditGate() {
  _manualScoreEditAt = Date.now();
  _scoreJumpHold = null;
}

/**
 * 重置 V5 Worker 触发状态。
 * @returns {void}
 */
function resetOcrV5TriggerState() {
  _ocrPendingTrigger = null;
  _pendingTimeFrame = null;
  _ocrVkBusy = false;
  _ocrV5GlobalCooldownUntil = 0;
  _ocrV5RoiCooldownUntil = [0, 0, 0];
  _ocrV5ScorePumpCursor = 0;
  _ocrV5LastHomeOcrTs = 0;
  _ocrV5LastAwayOcrTs = 0;
  _ocrV5LastTimeOcrOkTs = Date.now();
  _ocrLastTimeSuccessTs = Date.now();
  _ocrScoreBootstrapRejectStreak = [0, 0];
}

/**
 * 时间 OCR 忙时写入最新帧（覆盖旧 pending，禁止排队）。
 * @param {ArrayBuffer} rgbaBuffer
 * @param {number} frameW
 * @param {number} frameH
 * @param {number} captureTs
 * @returns {void}
 */
function stashPendingTimeFrame(rgbaBuffer, frameW, frameH, captureTs) {
  if (!rgbaBuffer || !rgbaBuffer.byteLength) return;
  _pendingTimeFrame = {
    data: rgbaBuffer,
    width: frameW,
    height: frameH,
    captureTs: captureTs
  };
}

/**
 * bootstrap 阶段连续拒收 0 分：达上限则标记该侧 bootstrap 结束（不写入 0 分）。
 * @param {number} scoreIdx 0=主 1=客
 * @param {number} nowTs 墙钟
 * @returns {void}
 */
function noteScoreBootstrapReject(scoreIdx, nowTs) {
  if (scoreIdx !== 0 && scoreIdx !== 1) return;
  _ocrScoreBootstrapRejectStreak[scoreIdx] += 1;
  if (_ocrScoreBootstrapRejectStreak[scoreIdx] < OCR_SCORE_BOOTSTRAP_GIVE_UP_STREAK) return;
  if (scoreIdx === 0) {
    _ocrV5LastHomeOcrTs = nowTs;
  } else {
    _ocrV5LastAwayOcrTs = nowTs;
  }
  logOcrV5Diag('score_bootstrap_give_up', {
    scoreIdx: scoreIdx,
    streak: _ocrScoreBootstrapRejectStreak[scoreIdx]
  });
}

/**
 * 仅清空 V5 待触发队列（保留比分 heartbeat 时间戳，避免遮挡恢复后重复 bootstrap）。
 * @returns {void}
 */
function resetOcrV5PendingOnly() {
  _ocrPendingTrigger = null;
  _ocrV5GlobalCooldownUntil = 0;
  _ocrV5RoiCooldownUntil = [0, 0, 0];
}

/**
 * 待触发列表中是否含比分 ROI。
 * @param {number[]} roiList ROI 索引列表
 * @returns {boolean}
 */
function hasPendingScoreRois(roiList) {
  if (!roiList || !roiList.length) return false;
  for (var i = 0; i < roiList.length; i++) {
    if (roiList[i] === 0 || roiList[i] === 1) return true;
  }
  return false;
}

/**
 * 登记一次物理 runOCR 请求，返回其 reqId。
 * @param {object} state OCR run 状态
 * @param {number} captureTs 帧捕获墙钟
 * @returns {number} reqId
 */
function enqueueOcrReq(state, captureTs) {
  var reqId = ++_ocrReqSeq;
  var now = Date.now();
  // 发新请求前清理疑似被 SDK 丢弃的 abandoned 请求，避免队列永久错位
  while (
    _ocrReqQueue.length &&
    _ocrReqQueue[0].abandoned &&
    now - _ocrReqQueue[0].sentAt > OCR_REQ_ABANDON_PURGE_MS
  ) {
    _ocrReqQueue.shift();
  }
  _ocrReqQueue.push({
    reqId: reqId,
    state: state,
    captureTs: captureTs,
    abandoned: false,
    sentAt: now
  });
  if (state) state.reqId = reqId;
  COLLECTOR_AUDIT.auditOcrQueue({
    action: 'enqueue',
    reqId: reqId,
    queueLen: _ocrReqQueue.length,
    roiIdx: state && typeof state.roiIdx === 'number' ? state.roiIdx : null
  });
  return reqId;
}

/**
 * 将指定 reqId 的在途请求标记为作废（超时/失败），其迟到回调将被丢弃。
 * @param {number} reqId
 * @returns {void}
 */
function abandonOcrReq(reqId) {
  for (var i = 0; i < _ocrReqQueue.length; i++) {
    if (_ocrReqQueue[i].reqId === reqId) {
      _ocrReqQueue[i].abandoned = true;
      COLLECTOR_AUDIT.auditOcrQueue({
        action: 'abandon',
        reqId: reqId,
        queueLen: _ocrReqQueue.length
      });
      return;
    }
  }
}

/**
 * 待触发比分 ROI 的最长等待时间（毫秒）。
 * @param {number} nowMs 当前墙钟
 * @returns {number}
 */
/**
 * 是否处于遮挡/重启后的时钟一次性对齐窗口（禁止逐秒追赶）。
 * @param {number} nowMs
 * @returns {boolean}
 */
function isOcrRecoverySnapActive(nowMs) {
  return !!(_ocrRecoveryModeUntil && nowMs < _ocrRecoveryModeUntil);
}

function getPendingScoreAgeMs(nowMs) {
  if (!_ocrPendingTrigger || !_ocrPendingTrigger.roiFirstSeen) return 0;
  var fs = _ocrPendingTrigger.roiFirstSeen;
  var maxAge = 0;
  if (fs[0] && nowMs - fs[0] > maxAge) maxAge = nowMs - fs[0];
  if (fs[1] && nowMs - fs[1] > maxAge) maxAge = nowMs - fs[1];
  return maxAge;
}

function isTimeOcrDue(nowMs) {
  var sinceTimeOk = nowMs - (_ocrLastTimeSuccessTs || 0);
  
  var currentRunningInterval = TIME_OCR_RUNNING_INTERVAL_MS;
  var currentStoppedInterval = TIME_OCR_STOPPED_INTERVAL_MS;
  
  if (_clockState === CLOCK_STATE_RUNNING) {
    currentRunningInterval = _timeMotionActive ? 700 : 300;
  } else if (_clockState === CLOCK_STATE_STOPPED) {
    currentStoppedInterval = _timeMotionActive ? 300 : 500;
  }

  if (_clockState === CLOCK_STATE_RUNNING && sinceTimeOk >= currentRunningInterval) {
    return true;
  } else if (_clockState === CLOCK_STATE_STOPPED && sinceTimeOk >= currentStoppedInterval) {
    return true;
  } else if (_clockState === CLOCK_STATE_UNKNOWN && sinceTimeOk >= TIME_OCR_RECOVERY_INTERVAL_MS) {
    return true;
  }
  return false;
}

/**
 * 是否应让出 VK 通道给时间 OCR（仅饥饿/时间正在跑，不用 isTimeOcrDue 封死比分）。
 * @param {number} nowMs
 * @returns {boolean}
 */
function shouldDeferScoreOcr(nowMs) {
  if (_ocrOcclusionActive) return true;
  if (_ocrVkBusy) return true;
  if (getPendingScoreAgeMs(nowMs) >= OCR_V5_SCORE_PENDING_FORCE_MS) return false;
  if (_ocrRecoveryModeUntil && nowMs < _ocrRecoveryModeUntil) {
    return isTimeOcrStarved(nowMs);
  }
  if (isTimeOcrStarved(nowMs)) return true;
  var sinceTimeOk = nowMs - (_ocrLastTimeSuccessTs || 0);
  if (sinceTimeOk < OCR_V5_SCORE_COOLDOWN_AFTER_TIME_MS) return true;
  return false;
}

/**
 * V5 模式下是否允许执行比分 OCR（不受 legacy 比分泵熔断影响）。
 * @param {number} nowMs 当前墙钟
 * @returns {boolean}
 */
function isScoreOcrAllowedForV5(nowMs) {
  if (shouldDeferScoreOcr(nowMs)) return false;
  if (_clockState === CLOCK_STATE_UNKNOWN && !_ocrOcclusionActive) {
    if (!(_ocrRecoveryModeUntil && nowMs < _ocrRecoveryModeUntil)) return false;
  }
  if (!_ocrTimeBaselineReady) return false;
  if (isOcrSdkDegraded(nowMs)) return false;
  if (nowMs < (_ocrScorePumpQuiesceUntil || 0)) return false;
  return true;
}

/**
 * V5 Worker 异动触发时是否允许比分 OCR（不要求时间基线，仅防抖/熔断）。
 * @param {number} nowMs 当前墙钟
 * @returns {boolean}
 */
function isScoreOcrAllowedForWorker(nowMs) {
  if (shouldDeferScoreOcr(nowMs)) return false;
  if (_clockState === CLOCK_STATE_UNKNOWN && !_ocrOcclusionActive) {
    if (!(_ocrRecoveryModeUntil && nowMs < _ocrRecoveryModeUntil)) return false;
  }
  if (isOcrSdkDegraded(nowMs)) return false;
  if (nowMs < (_ocrScorePumpQuiesceUntil || 0)) return false;
  return true;
}

/**
 * 合并 Worker OCR 触发 ROI 列表。
 * @param {number[]} changedRois 变化的 ROI 索引
 * @returns {void}
 */
function mergeOcrV5Trigger(changedRois) {
  if (!changedRois || !changedRois.length) return;
  if (_ocrOcclusionActive) return;
  var now = Date.now();
  
  // Phase 3 Patch: time ROI diff as motion hint ONLY
  var hasTimeMotion = false;
  var filteredRois = [];
  for (var i = 0; i < changedRois.length; i++) {
    if (changedRois[i] === 2) {
      hasTimeMotion = true;
    } else if (changedRois[i] === 0 || changedRois[i] === 1) {
      filteredRois.push(changedRois[i]);
    }
  }

  if (hasTimeMotion) {
    _timeMotionActive = true;
    _timeMotionLastChangeTs = now;
  }

  if (filteredRois.length === 0) return;
  changedRois = filteredRois;
  mergeScorePendingRois(changedRois, 'worker', now);
}

/**
 * 合并比分待触发 ROI（仅 0/1，不与时间轮询混队）。
 * @param {number[]} roiIndices
 * @param {string} reason
 * @param {number} nowMs
 * @returns {void}
 */
function mergeScorePendingRois(roiIndices, reason, nowMs) {
  if (!roiIndices || !roiIndices.length) return;
  var scoreOnly = [];
  for (var k = 0; k < roiIndices.length; k++) {
    if (roiIndices[k] === 0 || roiIndices[k] === 1) scoreOnly.push(roiIndices[k]);
  }
  if (!scoreOnly.length) return;
  var now = nowMs || Date.now();
  var pendingReason = reason || 'worker';

  if (!_ocrPendingTrigger) {
    _ocrPendingTrigger = {
      changedRois: scoreOnly.slice(),
      reason: pendingReason,
      ts: now,
      roiFirstSeen: {}
    };
    for (var j = 0; j < scoreOnly.length; j++) {
      _ocrPendingTrigger.roiFirstSeen[scoreOnly[j]] = now;
    }
    return;
  }
  var merged = _ocrPendingTrigger.changedRois.slice();
  var fs = _ocrPendingTrigger.roiFirstSeen || {};
  for (var i = 0; i < scoreOnly.length; i++) {
    var r = scoreOnly[i];
    if (merged.indexOf(r) < 0) merged.push(r);
    if (!fs[r]) fs[r] = now;
  }
  _ocrPendingTrigger.changedRois = merged;
  _ocrPendingTrigger.roiFirstSeen = fs;
  _ocrPendingTrigger.reason = pendingReason;
  _ocrPendingTrigger.ts = now;
}

/**
 * 从待触发 ROI 中选取优先级最高的一个。
 * @param {number[]} changedRois 变化的 ROI 索引
 * @param {number} nowMs 当前墙钟
 * @returns {number} ROI 索引，-1 表示无
 */
/**
 * 从待触发比分 ROI 中选取一个（时间 ROI 由轮询泵单独处理，不进此队列）。
 * @param {number[]} changedRois 仅含 0/1
 * @param {number} nowMs
 * @param {string} triggerReason
 * @returns {number}
 */
function pickTriggeredScoreRoi(changedRois, nowMs, triggerReason) {
  if (!changedRois || !changedRois.length) return -1;
  var scoreRois = [];
  for (var si = 0; si < changedRois.length; si++) {
    if (changedRois[si] === 0 || changedRois[si] === 1) scoreRois.push(changedRois[si]);
  }
  if (!scoreRois.length) return -1;

  if (_ocrOcclusionActive) {
    return pickStalestOcrField(nowMs, scoreRois);
  }

  if (triggerReason === 'worker' || triggerReason === 'score_bootstrap' || triggerReason === 'score_heartbeat') {
    if (scoreRois.indexOf(0) >= 0 && scoreRois.indexOf(1) >= 0) {
      if (_ocrV5LastHomeOcrTs === 0 && _ocrV5LastAwayOcrTs === 0) {
        var bootPick = (_ocrV5ScorePumpCursor % 2 === 0) ? 0 : 1;
        _ocrV5ScorePumpCursor += 1;
        return bootPick;
      }
      if (_ocrV5LastHomeOcrTs === 0) return 0;
      if (_ocrV5LastAwayOcrTs === 0) return 1;
      var homeStale = nowMs - (_ocrV5LastHomeOcrTs || 0);
      var awayStale = nowMs - (_ocrV5LastAwayOcrTs || 0);
      if (awayStale >= homeStale && scoreRois.indexOf(1) >= 0) return 1;
      return 0;
    }
    if (scoreRois.indexOf(1) >= 0 && _ocrV5LastAwayOcrTs === 0) return 1;
    if (scoreRois.indexOf(0) >= 0 && _ocrV5LastHomeOcrTs === 0) return 0;
    if (scoreRois.indexOf(0) >= 0 && scoreRois.indexOf(1) >= 0) {
      var rrPick = (_ocrV5ScorePumpCursor % 2 === 0) ? 0 : 1;
      _ocrV5ScorePumpCursor += 1;
      return rrPick;
    }
    return scoreRois[0];
  }

  var scoreAge = getPendingScoreAgeMs(nowMs);
  if (scoreAge >= OCR_V5_SCORE_PRIORITY_MS) {
    if (scoreRois.indexOf(0) >= 0 && scoreRois.indexOf(1) >= 0) {
      var pickBoth = (_ocrV5ScorePumpCursor % 2 === 0) ? 0 : 1;
      _ocrV5ScorePumpCursor += 1;
      return pickBoth;
    }
    return scoreRois[0];
  }
  return scoreRois[0];
}

/**
 * 遮挡恢复时选取最久未成功 OCR 的字段。
 * @param {number} nowMs 当前墙钟
 * @param {number[]} [changedRois] 待触发 ROI
 * @returns {number}
 */
function pickStalestOcrField(nowMs, changedRois) {
  var candidates = [0, 1, 2];
  if (changedRois && changedRois.length) {
    candidates = changedRois.slice();
  }
  var bestIdx = candidates[0];
  var bestStale = -1;
  for (var i = 0; i < candidates.length; i++) {
    var idx = candidates[i];
    var lastTs = idx === 0
      ? (_ocrLastHomeScoreSuccessTs || 0)
      : (idx === 1 ? (_ocrLastAwayScoreSuccessTs || 0) : (_ocrLastTimeSuccessTs || 0));
    var stale = nowMs - lastTs;
    if (stale > bestStale) {
      bestStale = stale;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

/**
 * 检查 ROI 是否处于 V5 cooldown。
 * @param {number} roiIdx ROI 索引
 * @param {number} nowMs 当前墙钟
 * @returns {boolean}
 */
function isOcrV5RoiCooling(roiIdx, nowMs) {
  return nowMs < (_ocrV5RoiCooldownUntil[roiIdx] || 0);
}

/**
 * 标记 ROI 进入 V5 cooldown。
 * @param {number} roiIdx ROI 索引
 * @param {number} nowMs 当前墙钟
 * @returns {void}
 */
function markOcrV5RoiCooldown(roiIdx, nowMs) {
  _ocrV5RoiCooldownUntil[roiIdx] = nowMs + OCR_V5_ROI_COOLDOWN_MS;
  _ocrV5GlobalCooldownUntil = nowMs + OCR_V5_COOLDOWN_MS;
}

/**
 * 创建 V5 诊断计数器初始结构。
 * @returns {Object}
 */
function createEmptyOcrV5Diag() {
  return {
    mode: '',
    startedAt: 0,
    framesIn: 0,
    framesPosted: 0,
    framesSkippedEmpty: 0,
    framesSkippedBusy: 0,
    framesSkippedNotReady: 0,
    framesSkippedCopyThrottle: 0,
    postTransferOk: 0,
    postCopyOk: 0,
    postFail: 0,
    workerTriggers: 0,
    ocrTriggeredWorker: 0,
    ocrTriggeredStarve: 0,
    ocrTriggeredOcclusion: 0,
    ocrTriggeredHeartbeat: 0,
    ocrTriggeredScoreHeartbeat: 0,
    ocrTriggeredTimeTick: 0,
    ocrTriggeredScoreBootstrap: 0,
    ocrSkippedBusy: 0,
    ocrSkippedCooldown: 0,
    ocrSkippedSettle: 0,
    ocrSkippedScorePump: 0,
    ocrRunOk: 0,
    ocrRunTimeout: 0,
    baselineRequested: 0,
    baselineUpdated: 0,
    switchToCopy: 0,
    switchToLegacy: 0,
    lastSummaryTs: 0
  };
}

/**
 * 重置 V5 诊断计数器。
 * @param {string} [mode] 当前模式标签
 * @returns {void}
 */
function resetOcrV5Diag(mode) {
  _ocrV5Diag = createEmptyOcrV5Diag();
  _ocrV5Diag.mode = mode || '';
  _ocrV5Diag.startedAt = Date.now();
}

/**
 * 输出 V5 诊断单行日志（固定前缀，便于测试时 grep）。
 * @param {string} event 事件名
 * @param {Object} [detail] 详情
 * @returns {void}
 */
function logOcrV5Diag(event, detail) {
  try {
    console.log('[Collector][OCR-V5][diag] ' + event + ' ' + JSON.stringify(detail || {}));
  } catch (eLog) {
    console.log('[Collector][OCR-V5][diag]', event, detail || {});
  }
}

/**
 * 周期性输出 V5 诊断摘要到控制台与健康日志。
 * @returns {void}
 */
function maybeEmitOcrV5DiagSummary() {
  if (!_ocrV5Diag) return;
  var now = Date.now();
  if (now - _ocrV5Diag.lastSummaryTs < OCR_V5_DIAG_SUMMARY_MS) return;
  _ocrV5Diag.lastSummaryTs = now;
  var snap = {
    mode: _ocrV5Diag.mode,
    pumpMode: _ocrFramePumpMode,
    postMode: _ocrFilterPostMode,
    fallback: _ocrFilterFallback,
    workerReady: _ocrFilterWorkerReady,
    framesIn: _ocrV5Diag.framesIn,
    framesPosted: _ocrV5Diag.framesPosted,
    postTransferOk: _ocrV5Diag.postTransferOk,
    postCopyOk: _ocrV5Diag.postCopyOk,
    postFail: _ocrV5Diag.postFail,
    workerTriggers: _ocrV5Diag.workerTriggers,
    ocrTriggeredWorker: _ocrV5Diag.ocrTriggeredWorker,
    ocrTriggeredStarve: _ocrV5Diag.ocrTriggeredStarve,
    ocrTriggeredOcclusion: _ocrV5Diag.ocrTriggeredOcclusion,
    ocrTriggeredHeartbeat: _ocrV5Diag.ocrTriggeredHeartbeat,
    ocrTriggeredScoreHeartbeat: _ocrV5Diag.ocrTriggeredScoreHeartbeat,
    ocrTriggeredTimeTick: _ocrV5Diag.ocrTriggeredTimeTick,
    ocrTriggeredScoreBootstrap: _ocrV5Diag.ocrTriggeredScoreBootstrap,
    ocrSkippedBusy: _ocrV5Diag.ocrSkippedBusy,
    ocrSkippedCooldown: _ocrV5Diag.ocrSkippedCooldown,
    ocrSkippedSettle: _ocrV5Diag.ocrSkippedSettle,
    ocrSkippedScorePump: _ocrV5Diag.ocrSkippedScorePump,
    ocrRunOk: _ocrV5Diag.ocrRunOk,
    ocrRunTimeout: _ocrV5Diag.ocrRunTimeout,
    baselineRequested: _ocrV5Diag.baselineRequested,
    baselineUpdated: _ocrV5Diag.baselineUpdated,
    switchToCopy: _ocrV5Diag.switchToCopy,
    switchToLegacy: _ocrV5Diag.switchToLegacy,
    pendingTrigger: _ocrPendingTrigger ? _ocrPendingTrigger.changedRois.slice() : [],
    pendingScoreAgeMs: getPendingScoreAgeMs(now),
    starved: isTimeOcrStarved(now),
    occlusion: _ocrOcclusionActive,
    ocrBusy: _ocrRunBusy,
    msSinceTimeOcrOk: now - (_ocrLastTimeSuccessTs || 0),
    msSinceScoreOcrOk: now - Math.max(_ocrLastHomeScoreSuccessTs || 0, _ocrLastAwayScoreSuccessTs || 0),
    consecutiveTimeout: _ocrConsecutiveTimeout,
    clockMode: _clockMode,
    uptimeSec: Math.round((now - (_ocrV5Diag.startedAt || now)) / 1000)
  };
  logOcrV5Diag('summary', snap);
  appendCollectorHealthLog('ocr_v5_summary', snap);
  COLLECTOR_AUDIT.auditWorkerStats({
    mode: snap.mode,
    pumpMode: snap.pumpMode,
    workerReady: snap.workerReady,
    workerTriggers: snap.workerTriggers,
    ocrTriggeredWorker: snap.ocrTriggeredWorker,
    framesIn: snap.framesIn,
    framesPosted: snap.framesPosted,
    postFail: snap.postFail,
    fallback: snap.fallback,
    ocrBusy: snap.ocrBusy
  });
}

function ensureOcrFrameBuffer(size) {
  if (!_ocrFrameBufferPool || _ocrFrameBufferPool.length !== size) {
    _ocrFrameBufferPool = new Uint8Array(size);
  }
  return _ocrFrameBufferPool;
}

function buildOcrScheduleQueue() {
  _ocrTick += 1;
  var queue = [];
  queue.push(2);
  if (_ocrTick % OCR_SCORE_TICK_INTERVAL === 0) {
    queue.push(0);
    queue.push(1);
  }
  return queue;
}

function getOcrMaxVariantsForRoi(roiIdx) {
  if (roiIdx === 0 || roiIdx === 1) {
    if (_ocrOcclusionActive || _ocrConsecutiveTimeout >= 2) {
      return 1;
    }
    if (_ocrConsecutiveTimeout >= 1) {
      return 2;
    }
    return OCR_MAX_VARIANTS_PER_RUN;
  }
  return 2;
}

/**
 * 重置比分泵熔断状态。
 * @returns {void}
 */
function resetOcrScorePumpCircuit() {
  _ocrScorePumpPauseUntil = 0;
  _ocrScoreTimeoutStreak = 0;
  _ocrScoreCircuitTripCount = 0;
  _ocrScorePumpQuiesceUntil = 0;
}

/**
 * 允许重新开放比分泵（用户重新开关 OCR 时调用）。
 * @returns {void}
 */
function resetScorePumpDisabled() {
  _ocrScorePumpDisabled = false;
}

/**
 * SDK 是否处于降载模式（拉长间隔、关闭比分泵）。
 * @param {number} nowMs
 * @returns {boolean}
 */
function isOcrSdkDegraded(nowMs) {
  return nowMs < (_ocrSdkDegradedUntil || 0);
}

/**
 * 标记 SDK 降载窗口。
 * @returns {void}
 */
function markOcrSdkDegraded() {
  if (_ocrConsecutiveTimeout < OCR_SDK_DEGRADED_TIMEOUT_STREAK) return;
  _ocrSdkDegradedUntil = Date.now() + OCR_SDK_DEGRADED_DURATION_MS;
}

/**
 * 当前时间泵有效间隔。
 * @param {number} nowMs
 * @returns {number}
 */
function getEffectiveTimePumpInterval(nowMs) {
  if (isOcrSdkDegraded(nowMs) || isTimeOcrStarved(nowMs)) {
    return OCR_TIME_PUMP_DEGRADED_MS;
  }
  return TIME_PUMP_INTERVAL;
}

/**
 * 当前 OCR settle 窗口。
 * @param {number} nowMs
 * @returns {number}
 */
function getEffectiveOcrSettleMs(nowMs) {
  return isOcrSdkDegraded(nowMs) ? OCR_TIMEOUT_SETTLE_DEGRADED_MS : OCR_TIMEOUT_SETTLE_MS;
}

/**
 * 是否应打印 OCR 超时 warn（节流，避免 DevTools 卡死）。
 * @param {'score'|'time'} kind
 * @returns {boolean}
 */
function shouldLogOcrTimeoutWarn(kind) {
  var now = Date.now();
  var last = _ocrTimeoutWarnLastTs[kind] || 0;
  if (now - last < OCR_TIMEOUT_LOG_THROTTLE_MS) return false;
  _ocrTimeoutWarnLastTs[kind] = now;
  return true;
}

/**
 * 是否像「高位分被误读为 0」。
 * @param {number} scoreIdx
 * @param {number} nextScore
 * @returns {boolean}
 */
function isLikelyZeroScoreDrop(scoreIdx, nextScore) {
  if (nextScore !== 0) return false;
  var ref = getScoreParseRef(scoreIdx);
  return ref >= 8;
}

/**
 * 重置时间 OCR 基线（开放比分泵门槛）。
 * @returns {void}
 */
function resetOcrTimeBaseline() {
  _ocrTimeSuccessStreak = 0;
  _ocrTimeBaselineReady = false;
}

/**
 * 获取比赛时钟参考秒数（最近 OCR / 已发布 / 本地提交）。
 * @returns {number}
 */
function getClockRefSec() {
  if (_lastOcrClockSec >= 0) return _lastOcrClockSec;
  var pub = _procState.published;
  if (pub && typeof pub.t === 'number' && pub.t >= 0) return pub.t;
  if (_lastCommittedFrame) return ocrFrameClockSec(_lastCommittedFrame);
  return -1;
}

/**
 * 是否像节间复位到 10:00（大屏已回 10:00，参考仍在末节倒计时）。
 * @param {number} refSec
 * @param {number} ocrSec
 * @returns {boolean}
 */
function isLikelyPeriodClockReset(refSec, ocrSec) {
  if (ocrSec < OCR_PERIOD_RESET_MIN_SEC) return false;
  if (refSec < 0) return true;
  // ✅ 修复：refSec <= 10 时（包含 00:00 结束阶段）也允许节间复位
  if (refSec <= 10) return true;
  if (refSec < 60) return false;
  return refSec <= OCR_PERIOD_RESET_REF_MAX_SEC;
}

/**
 * 是否像把 24s 进攻时间/0:xx 误当成比赛时钟。
 * @param {number} refSec
 * @param {{ minutes: number, seconds: number }} clock
 * @returns {boolean}
 */
function isLikelyShotClockMisreadAsGame(refSec, clock) {
  if (refSec < OCR_SHOT_CLOCK_MASK_REF_MIN_SEC || !clock) return false;
  if (Number(clock.minutes) !== 0) return false;
  var ocrSec = clockToTotalSec(clock);
  return ocrSec >= 0 && ocrSec < 60 && !isLikelyPeriodClockReset(refSec, ocrSec);
}

/**
 * 比赛时钟倒计时不应相对参考向前走（除节间复位、0:xx 误锚恢复外）。
 * @param {number} refSec
 * @param {number} ocrSec
 * @param {{ minutes: number, seconds: number } | null} [clock]
 * @returns {boolean}
 */
function isSuspiciousGameClockForward(refSec, ocrSec, clock) {
  if (refSec < 0 || ocrSec < 0) return false;
  if (isLikelyPeriodClockReset(refSec, ocrSec)) return false;
  if (
    clock &&
    Number(clock.minutes) >= 1 &&
    refSec >= OCR_CLOCK_SUBMINUTE_RECOVERY_MIN_REF_SEC &&
    refSec < 60 &&
    ocrSec > refSec
  ) {
    return false;
  }
  return ocrSec > refSec;
}

/**
 * 修复 7 段数码管 S→5 误替换导致的分钟十位污染（如 9S:19 → 95:19）。
 * @param {number} minutes 解析出的分钟
 * @param {number} seconds 解析出的秒
 * @returns {{ minutes: number, seconds: number } | null}
 */
function repairSmearedGameClockMinutes(minutes, seconds) {
  var m = Number(minutes);
  var s = Number(seconds);
  if (isNaN(m) || isNaN(s) || s < 0 || s > 59) return null;
  if (m >= 10 && m <= 99 && m % 10 === 5) {
    var fixedM = Math.floor(m / 10);
    if (fixedM >= 0 && fixedM <= OCR_GAME_CLOCK_MAX_MINUTES) {
      return { minutes: fixedM, seconds: s };
    }
  }
  return null;
}

/**
 * 修复 7 段数码管分钟十位误读（3↔8、5↔9 等），秒位一致且相对参考正向跳 3–7 分钟。
 * @param {{ minutes: number, seconds: number }} clock OCR 解析结果
 * @param {number} refSec 参考秒数
 * @returns {{ minutes: number, seconds: number } | null}
 */
function repairMinutesTensDigitGlitch(clock, refSec) {
  if (!clock || refSec < 60) return null;
  var ocrSec = clockToTotalSec(clock);
  if (isLikelyPeriodClockReset(refSec, ocrSec)) return null;
  if (ocrSec <= refSec) return null;
  var delta = ocrSec - refSec;
  if (delta < OCR_CLOCK_TENS_GLITCH_MIN_DELTA_SEC || delta > OCR_CLOCK_TENS_GLITCH_MAX_DELTA_SEC) {
    return null;
  }
  var ref = clockFromTotalSec(refSec);
  if (Number(clock.seconds) !== Number(ref.seconds)) return null;
  var mDiff = Number(clock.minutes) - Number(ref.minutes);
  if (mDiff < OCR_CLOCK_TENS_GLITCH_MINUTE_DIFF || mDiff > OCR_CLOCK_TENS_GLITCH_MAX_MINUTE_DIFF) {
    return null;
  }
  return { minutes: ref.minutes, seconds: clock.seconds };
}

/**
 * 校验 OCR 时间样本是否可用于比赛时钟（过滤进攻时间误读与正向跳变）。
 * @param {{ minutes: number, seconds: number } | null} clock
 * @param {number} refSec
 * @returns {{ minutes: number, seconds: number } | null}
 */
function sanitizeGameClockParse(clock, refSec) {
  if (!clock) return null;
  if (clock.minutes > OCR_GAME_CLOCK_MAX_MINUTES) {
    var repaired = repairSmearedGameClockMinutes(clock.minutes, clock.seconds);
    if (repaired) {
      clock = repaired;
    } else if (refSec >= 0 && refSec <= OCR_GAME_CLOCK_MAX_MINUTES * 60 + 59) {
      return null;
    }
  }
  if (refSec >= 60) {
    var tensFixed = repairMinutesTensDigitGlitch(clock, refSec);
    if (tensFixed) {
      logOcrV5Diag('clock_tens_digit_repair', {
        refSec: refSec,
        fromSec: clockToTotalSec(clock),
        toSec: clockToTotalSec(tensFixed)
      });
      clock = tensFixed;
    }
  }
  var ocrSec = clockToTotalSec(clock);
  if (refSec < 0) return clock;
  if (isLikelyShotClockMisreadAsGame(refSec, clock)) return null;
  if (!_ocrOcclusionActive && isSuspiciousGameClockForward(refSec, ocrSec, clock)) return null;
  return clock;
}

/**
 * 解析 OCR 时间文本并校验；当参考锚误落在 0:xx 时允许恢复到真实 MM:SS。
 * @param {string} raw OCR 原始文本
 * @param {number} [refSec] 参考秒数，默认 getClockRefSec()
 * @returns {{ minutes: number, seconds: number } | null}
 */
function resolveGameClockParse(raw, refSec) {
  var parsed = parseTime(raw);
  if (!parsed) return null;
  var ref = typeof refSec === 'number' ? refSec : getClockRefSec();
  var sanitized = sanitizeGameClockParse(parsed, ref);
  if (!sanitized && ref >= 60) {
    var tensFixed = repairMinutesTensDigitGlitch(parsed, ref);
    if (tensFixed) {
      sanitized = sanitizeGameClockParse(tensFixed, ref);
    }
  }
  if (
    !sanitized &&
    parsed.minutes >= 1 &&
    ref >= OCR_CLOCK_SUBMINUTE_RECOVERY_MIN_REF_SEC &&
    ref < 60
  ) {
    var recovered = sanitizeGameClockParse(parsed, -1);
    if (recovered) {
      logOcrV5Diag('clock_subminute_recovery', {
        refSec: ref,
        ocrSec: clockToTotalSec(recovered),
        raw: String(raw || '').slice(0, 24)
      });
      sanitized = recovered;
    }
  }
  return sanitized;
}

/**
 * 记录时间 ROI 解析成功，累计基线 streak（须通过 sanitizeGameClockParse）。
 * @param {{ minutes: number, seconds: number }} clock
 * @returns {void}
 */
function noteOcrTimeSuccess(clock) {
  var refSec = getClockRefSec();
  if (!sanitizeGameClockParse(clock, refSec)) return;
  _ocrTimeSuccessStreak += 1;
  if (_ocrTimeSuccessStreak >= OCR_TIME_BASELINE_STREAK && !_ocrTimeBaselineReady) {
    _ocrTimeBaselineReady = true;
    console.log('[Collector][OCR] time baseline ready (%s), score pump enabled', OCR_TIME_BASELINE_STREAK);
    logOcrV5Diag('score_bootstrap_pending', {});
  }
}

/**
 * 软 SYNC 分步校正：倒计时仅允许向后校正；节间复位允许跳到 10:00。
 * @param {number} fromSec 已发布或参考秒数
 * @param {number} toSec OCR 读数秒数
 * @returns {number}
 */
function capSyncClockStep(fromSec, toSec) {
  if (fromSec < 0 || toSec < 0) return toSec;
  if (isLikelyPeriodClockReset(fromSec, toSec)) return toSec;
  var delta = toSec - fromSec;
  if (delta > 0) return fromSec;
  if (delta < -OCR_SOFT_SYNC_MAX_STEP_SEC) {
    return fromSec - OCR_SOFT_SYNC_MAX_STEP_SEC;
  }
  return toSec;
}

/**
 * 是否允许调度比分泵（基线已建立、未熔断、未静默）。
 * @param {number} nowMs
 * @returns {boolean}
 */
function isScorePumpAllowed(nowMs) {
  if (shouldDeferScoreOcr(nowMs)) return false;
  if (_clockState === CLOCK_STATE_UNKNOWN && !_ocrOcclusionActive) return false;
  if (_ocrRecoveryModeUntil && (nowMs < _ocrRecoveryModeUntil)) {
    return true;
  }
  if (isOcrSdkDegraded(nowMs)) return false;
  if (!_ocrTimeBaselineReady) return false;
  if (nowMs < (_ocrScorePumpQuiesceUntil || 0)) return false;
  if (isScorePumpCircuitOpen(nowMs)) return false;
  return true;
}

/**
 * 时间 OCR 是否处于饥饿（从未成功或过久未成功）。
 * @param {number} nowMs
 * @returns {boolean}
 */
function isTimeOcrStarved(nowMs) {
  if (!_ocrLastTimeSuccessTs) return true;
  return (nowMs - _ocrLastTimeSuccessTs) > OCR_TIME_STARVATION_MS;
}

/**
 * 比分泵是否处于全局熔断期。
 * @param {number} nowMs
 * @returns {boolean}
 */
function isScorePumpCircuitOpen(nowMs) {
  return nowMs < (_ocrScorePumpPauseUntil || 0);
}

/**
 * 记录比分 OCR 超时并视情况熔断比分泵。
 * @returns {void}
 */
function noteOcrScoreTimeout() {
  _ocrScoreTimeoutStreak += 1;
  if (_ocrScoreTimeoutStreak < OCR_SCORE_TIMEOUT_STREAK_PAUSE) return;
  _ocrScoreTimeoutStreak = 0;
  _ocrScoreCircuitTripCount += 1;
  var pauseMs = OCR_SCORE_PUMP_PAUSE_MS * Math.min(3, _ocrScoreCircuitTripCount);
  _ocrScorePumpPauseUntil = Date.now() + pauseMs;
  console.log(
    '[Collector][OCR] score pump circuit-open %sms trip=%s for time recovery',
    pauseMs,
    _ocrScoreCircuitTripCount
  );
  if (_ocrScoreCircuitTripCount >= OCR_SCORE_CIRCUIT_MAX_TRIPS) {
    _ocrScorePumpQuiesceUntil = Date.now() + OCR_SCORE_PUMP_QUIESCE_MS;
    console.log('[Collector][OCR] score pump quiesced %sms', OCR_SCORE_PUMP_QUIESCE_MS);
  }
  markOcrSdkDegraded();
}

/**
 * 比分 OCR 成功后仅清零连续超时计数（不撤销熔断/静默，避免反复占通道）。
 * @returns {void}
 */
function noteOcrScoreSuccess() {
  _ocrScoreTimeoutStreak = 0;
}

function cloneClock(clock) {
  if (!clock) return null;
  return {
    minutes: Number(clock.minutes) || 0,
    seconds: Number(clock.seconds) || 0
  };
}

function subtractClock(clock, elapsedSec) {
  if (!clock) return null;
  var total = (Number(clock.minutes) || 0) * 60 + (Number(clock.seconds) || 0) - (elapsedSec || 0);
  if (total < 0) total = 0;
  return {
    minutes: Math.floor(total / 60),
    seconds: total % 60
  };
}

/**
 * 将 _clockMode 同步到 _clockState（供时间泵间隔与 predict 门控使用）。
 * @returns {void}
 */
function syncClockStateFromMode() {
  if (_clockMode === 'running') {
    _clockState = CLOCK_STATE_RUNNING;
    COLLECTOR_AUDIT.auditClockState({
      clockMode: _clockMode,
      clockState: _clockState,
      clockRunning: _procState.clockRunning,
      pauseConfirmed: _procState.pauseConfirmed
    });
    return;
  }
  if (_clockMode === 'paused') {
    _clockState = CLOCK_STATE_STOPPED;
    COLLECTOR_AUDIT.auditClockState({
      clockMode: _clockMode,
      clockState: _clockState,
      clockRunning: _procState.clockRunning,
      pauseConfirmed: _procState.pauseConfirmed
    });
    return;
  }
  _clockState = CLOCK_STATE_UNKNOWN;
  COLLECTOR_AUDIT.auditClockState({
    clockMode: _clockMode,
    clockState: _clockState,
    clockRunning: _procState.clockRunning,
    pauseConfirmed: _procState.pauseConfirmed
  });
}

function getPredictedClock() {
  // 遮挡期：画面与云端均应保持进入遮挡时的冻结秒数，不随墙钟或误读 OCR 变化
  if (_ocrOcclusionActive && _occlusionHoldClockSec >= 0) {
    return clockFromTotalSec(_occlusionHoldClockSec);
  }
  syncClockStateFromMode();
  if (_clockState === CLOCK_STATE_UNKNOWN) return null;
  var now = Date.now();
  if (_clockState === CLOCK_STATE_STOPPED) {
    return clockFromTotalSec(Math.floor(_clockAnchorMs / 1000));
  }
  // CLOCK_STATE_RUNNING
  // Phase 5: predictClock 安全限制 (超过 MAX_PREDICT_WITHOUT_CONFIRM_MS 未确认则冻结 predict)
  var msSinceOcr = now - (_ocrLastTimeSuccessTs || 0);
  if (msSinceOcr > MAX_PREDICT_WITHOUT_CONFIRM_MS) {
    // 冻结在失联的那一刻
    var freezeDurationMs = msSinceOcr - MAX_PREDICT_WITHOUT_CONFIRM_MS;
    var maxAllowedAdvanceMs = (now - _clockAnchorWallTs - freezeDurationMs) * _driftSoftAdjustRate;
    if (maxAllowedAdvanceMs < 0) maxAllowedAdvanceMs = 0;
    var predictedMs = _clockAnchorMs - maxAllowedAdvanceMs;
    if (predictedMs < 0) predictedMs = 0;
    return clockFromTotalSec(Math.floor(predictedMs / 1000));
  }

  var predictedMs = _clockAnchorMs - (now - _clockAnchorWallTs) * _driftSoftAdjustRate;
  if (predictedMs < 0) predictedMs = 0;
  return clockFromTotalSec(Math.floor(predictedMs / 1000));
}

function updatePredictedClock(clock) {
  _predictedClock = cloneClock(clock);
  _predictedClockWallTs = Date.now();
  // Phase 1/2 sync
  _clockAnchorMs = clockToTotalSec(clock) * 1000;
  _clockAnchorWallTs = Date.now();
}

function clockToTotalSec(clock) {
  if (!clock) return 0;
  return (Number(clock.minutes) || 0) * 60 + (Number(clock.seconds) || 0);
}

function clockFromTotalSec(totalSec) {
  var total = Math.max(0, Number(totalSec) || 0);
  return {
    minutes: Math.floor(total / 60),
    seconds: total % 60
  };
}

/**
 * 根据最近一次已发布时钟包，推算云端/直播端此刻应显示的大表秒数。
 * START/SYNC 发出后直播端会本地走表，所以软校准不能拿静态 published.t 比较。
 * @param {number} [nowMs]
 * @returns {number} -1 表示尚无发布基线
 */
function getPublishedClockSecAt(nowMs) {
  var pub = _procState.published;
  if (!pub || typeof pub.t !== 'number') return -1;
  var sec = Math.max(0, Math.floor(Number(pub.t) || 0));
  if (!pub.running) return sec;
  var wall = Number(pub.wallMs) || 0;
  if (!wall) return sec;
  var now = nowMs || Date.now();
  var elapsed = Math.floor(Math.max(0, now - wall) / 1000);
  return Math.max(0, sec - elapsed);
}

/**
 * 采集端当前可发布快照：优先取 OCR 已提交/预测时间，而不是旧的云端 published。
 * 这用于心跳刷新服务端 lastSnapshot，保证直播端中途接入时拿到当前时间。
 * @param {WechatMiniprogram.Page.Instance<any, any> | null} page
 * @param {number} [nowMs]
 * @returns {{ t: number, a: number, b: number, p: number, shotClock: number, running: boolean } | null}
 */
function buildCurrentCollectorSnapshot(page, nowMs) {
  var now = nowMs || Date.now();
  var src = _lastCommittedFrame || null;
  var pageData = page && page.data ? page.data : null;
  var pub = _procState.published;
  var t = -1;
  var a = 0;
  var b = 0;
  var p = 1;
  var shotClock = 24;

  if (src) {
    t = ocrFrameClockSec(src);
    a = Math.max(0, Math.floor(Number(src.homeScore) || 0));
    b = Math.max(0, Math.floor(Number(src.awayScore) || 0));
    p = Math.max(1, Math.floor(Number(src.period) || 1));
    shotClock = Math.max(0, Math.floor(Number(src.shotClock) || 24));
  } else if (pageData) {
    t = clockToTotalSec({ minutes: pageData.minutes, seconds: pageData.seconds });
    a = Math.max(0, Math.floor(Number(pageData.homeScore) || 0));
    b = Math.max(0, Math.floor(Number(pageData.awayScore) || 0));
    p = Math.max(1, Math.floor(Number(pageData.period) || 1));
    shotClock = Math.max(0, Math.floor(Number(pageData.shotClock) || 24));
  } else if (pub) {
    t = getPublishedClockSecAt(now);
    a = Math.max(0, Math.floor(Number(pub.a) || 0));
    b = Math.max(0, Math.floor(Number(pub.b) || 0));
    p = Math.max(1, Math.floor(Number(pub.p) || 1));
    shotClock = Math.max(0, Math.floor(Number(pub.shotClock) || 24));
  }

  var modePaused = _clockMode === 'paused' || _ocrOcclusionActive;
  var running = !modePaused && (
    _clockMode === 'running' ||
    !!_procState.clockRunning ||
    !!(pub && pub.running)
  );
  if (running) {
    var predicted = getPredictedClock();
    if (predicted) {
      var predictedSec = clockToTotalSec(predicted);
      if (t < 0 || predictedSec <= t + 1) {
        t = predictedSec;
      }
    } else if (pub && pub.running) {
      t = getPublishedClockSecAt(now);
    }
  }

  if (t < 0) return null;
  return {
    t: Math.max(0, Math.floor(t)),
    a: a,
    b: b,
    p: p,
    shotClock: shotClock,
    running: !!(running && t > 0)
  };
}

function isLargeScoreDrop(prev, homeScore, awayScore) {
  if (!prev) return false;
  return (
    (Number(prev.homeScore) || 0) - homeScore >= OCR_SCORE_JUMP_CONFIRM_THRESHOLD ||
    (Number(prev.awayScore) || 0) - awayScore >= OCR_SCORE_JUMP_CONFIRM_THRESHOLD
  );
}

function shouldPreviewScore(scoreIdx, score) {
  if (!_lastCommittedFrame) return true;
  var prev = scoreIdx === 0
    ? Number(_lastCommittedFrame.homeScore) || 0
    : Number(_lastCommittedFrame.awayScore) || 0;
  return Math.abs(score - prev) < OCR_SCORE_JUMP_CONFIRM_THRESHOLD;
}

function getClockCatchupUntil(now, lagSec) {
  var lag = Math.max(1, Number(lagSec) || 1);
  return now + Math.max(OCR_CLOCK_PREDICT_ACTIVE_MS, (lag + 2) * 1000);
}

function getClockRunUntil(now, clockSec) {
  var sec = Math.max(1, Number(clockSec) || 1);
  return now + Math.max(OCR_CLOCK_PREDICT_ACTIVE_MS, (sec + 2) * 1000);
}

/**
 * 生成 6 位房间号（供直播端输入连入）。
 * @returns {string}
 */
function generateRoomId() {
  var n = Math.floor(Math.random() * 1000000);
  if (String(n).padStart) {
    return String(n).padStart(6, '0');
  }
  return ('000000' + n).slice(-6);
}

/**
 * 读取本地持久化的 6 位房间号。
 * @returns {string}
 */
function loadPersistedRoomId() {
  try {
    var id = String(wx.getStorageSync(STORAGE_KEY_WS_ROOM_ID) || '').replace(/\D/g, '').slice(0, 6);
    return id.length === 6 ? id : '';
  } catch (eLoad) {
    return '';
  }
}

/**
 * 持久化本场房间号（OCR 重启 / 采集中断线重连仍复用）。
 * @param {string} roomId 6 位房间号
 * @returns {void}
 */
function savePersistedRoomId(roomId) {
  var safe = String(roomId || '').replace(/\D/g, '').slice(0, 6);
  if (safe.length !== 6) return;
  try {
    wx.setStorageSync(STORAGE_KEY_WS_ROOM_ID, safe);
  } catch (eSave) { /* ignore */ }
}

/**
 * 清除持久化房间号（用户主动「新房间」时调用）。
 * @returns {void}
 */
function clearPersistedRoomId() {
  try {
    wx.removeStorageSync(STORAGE_KEY_WS_ROOM_ID);
  } catch (eClr) { /* ignore */ }
}

/**
 * 计算 WebSocket 断线重连等待毫秒（3→6→12，上限 15 秒）。
 * @param {number} attempt 已断开次数（从 1 起）
 * @returns {number}
 */
function getWsReconnectDelayMs(attempt) {
  var idx = Math.max(0, Math.min(attempt - 1, WS_RECONNECT_DELAYS_MS.length - 1));
  return WS_RECONNECT_DELAYS_MS[idx];
}

/**
 * START 发包确认帧数：真停表需双帧；OCR 已观测到走表（遮挡恢复）单帧即可。
 * @returns {number}
 */
function getOcrStartConfirmStreak() {
  return _clockMode === 'paused' ? OCR_START_CONFIRM_STREAK : 1;
}

/**
 * 重置遮挡检测状态（OCR 重启时调用）。
 * @returns {void}
 */
function resetOcrOcclusionState() {
  _ocrOcclusionActive = false;
  _ocrOcclusionSince = 0;
  _ocrOcclusionBestClockSec = -1;
  _occlusionHoldClockSec = -1;
  _ocrOcclusionBestStableSec = -1;
  _ocrOcclusionBestStableStreak = 0;
  _ocrOcclusionRecoverStreak = 0;
  _ocrOcclusionWasRunning = false;
  _ocrOcclusionEvalLastTs = 0;
  _ocrLastHomeScoreSuccessTs = 0;
  _ocrLastAwayScoreSuccessTs = 0;
  _ocrLastGoodHomeScore = -1;
  _ocrLastGoodAwayScore = -1;
  _ocrLastGoodClockSec = -1;
  _ocrScoreBootstrapRejectStreak = [0, 0];
  _ocrScoreConfirmBuf = [
    { value: -1, streak: 0 },
    { value: -1, streak: 0 }
  ];
}

/**
 * 遮挡解除时采用的时钟秒数：优先用遮挡期内已确认的 OCR 读数，否则用进入遮挡时冻结值。
 * 不做「遮挡时长墙钟外推」追赶——那会让恢复从旧值慢慢倒数，体验差且非产品需求。
 * @param {number} nowMs 当前墙钟（保留参数供后续扩展）
 * @returns {number}
 */
function computeOcclusionResumeClockSec(nowMs) {
  if (_occlusionHoldClockSec >= 0) {
    if (_ocrOcclusionBestStableStreak >= 2 && _ocrOcclusionBestClockSec >= 0) {
      return _ocrOcclusionBestClockSec;
    }
    return _occlusionHoldClockSec;
  }
  if (_ocrOcclusionBestClockSec >= 0) return _ocrOcclusionBestClockSec;
  if (_ocrLastGoodClockSec >= 0) return _ocrLastGoodClockSec;
  if (!_lastCommittedFrame) return -1;
  return ocrFrameClockSec(_lastCommittedFrame);
}

/**
 * 遮挡期是否满足解除条件。
 * 走表：时间 OCR 成功即可；否则超时后用 hold 快照强制恢复（避免 VK 死锁永不出遮挡）。
 * @param {number} nowMs
 * @returns {boolean}
 */
function canClearOcrOcclusion(nowMs) {
  if (!_ocrOcclusionActive) return false;
  var timeFresh = (nowMs - (_ocrLastTimeSuccessTs || 0)) <= OCR_OCCLUSION_FRESH_MS;
  if (timeFresh) {
    if (_ocrOcclusionWasRunning &&
      (_ocrLastGoodClockSec >= 0 || _ocrOcclusionBestClockSec >= 0)) {
      return _ocrOcclusionBestStableStreak >= 2;
    }
    return _ocrLastGoodHomeScore >= 0 && _ocrLastGoodAwayScore >= 0;
  }
  if (_lastCommittedFrame && _ocrOcclusionSince > 0 &&
    (nowMs - _ocrOcclusionSince) >= OCR_OCCLUSION_FORCE_CLEAR_MS) {
    return true;
  }
  return false;
}

/**
 * 是否应向 Worker 投递比分 patch（遮挡/时间饥饿时禁止，避免抢 VK）。
 * @param {number} nowMs
 * @returns {boolean}
 */
function shouldPostScorePatchesToWorker(nowMs) {
  if (_ocrOcclusionActive) return false;
  if (_ocrFilterFallback) return false;
  if (isTimeOcrStarved(nowMs)) return false;
  if (_ocrConsecutiveTimeout >= 2) return false;
  if (nowMs < (_ocrScorePumpQuiesceUntil || 0)) return false;
  return true;
}

function areAllOcrFieldsFresh(nowMs) {
  if (_ocrOcclusionActive) return canClearOcrOcclusion(nowMs);
  // 仅看时间区：比分常因单路通道争抢被饿死，不能据此判遮挡。
  return (nowMs - (_ocrLastTimeSuccessTs || 0)) <= OCR_OCCLUSION_HOLD_MS;
}

/**
 * 是否为真实遮挡信号：时间区（记分牌心跳）长时间无法识别。
 * 比分饥饿（单路通道争抢导致）不计入，避免「假遮挡」。
 * @param {number} nowMs
 * @returns {boolean}
 */
function areAllOcrFieldsStale(nowMs) {
  return (nowMs - (_ocrLastTimeSuccessTs || 0)) > OCR_OCCLUSION_HOLD_MS;
}

/**
 * 是否已建立可进入遮挡判定的 OCR 基线。
 * @returns {boolean}
 */
function hasOcrOcclusionBaseline() {
  return !!(
    _lastCommittedFrame &&
    _ocrLastTimeSuccessTs > 0 &&
    _ocrLastHomeScoreSuccessTs > 0 &&
    _ocrLastAwayScoreSuccessTs > 0
  );
}

/**
 * 重置 processOcrFrame 状态机（OCR 重启或房间重连时调用）。
 * @returns {void}
 */
function resetProcessOcrState() {
  auditBeforeClockRunning(false, 'reset', 'resetProcessOcrState');
  _procState.clockRunning = false;
  _procState.sameSecFirstSeen = 0;
  _procState.lastOcrSec = -1;
  _procState.syncObserve = null;
  _procState.scoreObserve = null;
  _procState.published = null;
  _procState.sameSecStreak = 0;
  _procState.pauseConfirmed = false;
  _procState.startObserve = null;
}

function filterClockByMode(clock) {
  if (!clock) return null;
  if (_clockMode === 'paused' && _predictedClock) {
    var nextSec = clockToTotalSec(clock);
    var predSec = clockToTotalSec(_predictedClock);
    if (nextSec !== predSec && !isLikelyClockReset(predSec, nextSec, clock)) return null;
  }
  return clock;
}

// ─── 健康日志（轻量版：内存环形缓冲 + 节流落盘 + 一键导出） ─────────────────────

/**
 * 一次性初始化采集端健康日志：恢复上次缓冲、采集设备信息。
 * @returns {void}
 */
function initCollectorHealthLogs() {
  if (_collectorHealthLogInitialized) return;
  _collectorHealthLogInitialized = true;
  try {
    var raw = wx.getStorageSync(COLLECTOR_HEALTH_LOG_STORAGE_KEY);
    _collectorHealthLogs = Array.isArray(raw) ? raw.slice(-COLLECTOR_HEALTH_LOG_MAX) : [];
  } catch (eLoad) {
    _collectorHealthLogs = [];
  }
  try {
    var sys = wx.getSystemInfoSync();
    _collectorHealthLogDevice = {
      model: String(sys.model || ''),
      brand: String(sys.brand || ''),
      platform: String(sys.platform || ''),
      wxVersion: String(sys.version || ''),
      system: String(sys.system || ''),
      libVersion: String(sys.SDKVersion || '')
    };
  } catch (eDev) {
    _collectorHealthLogDevice = {};
  }
  appendCollectorHealthLog('page_load', {});
}

/**
 * 节流落盘：1.8 秒批量写入 storage，避免频繁 IO 干扰 OCR。
 * @returns {void}
 */
function scheduleCollectorHealthLogFlush() {
  if (_collectorHealthLogFlushTimer) return;
  _collectorHealthLogFlushTimer = setTimeout(function () {
    _collectorHealthLogFlushTimer = 0;
    try {
      var snapshot = (_collectorHealthLogs || []).slice(-COLLECTOR_HEALTH_LOG_MAX);
      wx.setStorageSync(COLLECTOR_HEALTH_LOG_STORAGE_KEY, snapshot);
    } catch (eFlush) { /* ignore */ }
  }, COLLECTOR_HEALTH_LOG_FLUSH_DELAY_MS);
}

/**
 * 追加一条采集端健康日志，自动加 `ws_` 前缀（事件名）。
 * @param {string} event 事件名（无前缀）
 * @param {Record<string, unknown>} [detail] 附加字段
 * @returns {void}
 */
function appendCollectorHealthLog(event, detail) {
  if (!_collectorHealthLogInitialized) initCollectorHealthLogs();
  if (!_collectorHealthLogs) _collectorHealthLogs = [];
  var item = {
    t: Date.now(),
    e: String(event || '?'),
    d: detail && typeof detail === 'object' ? detail : {}
  };
  _collectorHealthLogs.push(item);
  if (_collectorHealthLogs.length > COLLECTOR_HEALTH_LOG_MAX) {
    _collectorHealthLogs.splice(0, _collectorHealthLogs.length - COLLECTOR_HEALTH_LOG_MAX);
  }
  scheduleCollectorHealthLogFlush();
}

/**
 * 返回内存中全部采集端审计日志快照。
 * @returns {ReturnType<typeof COLLECTOR_AUDIT.dumpCollectorAudit>}
 */
function dumpCollectorAudit() {
  return COLLECTOR_AUDIT.dumpCollectorAudit();
}

/**
 * 导出采集端审计日志 JSON 字符串。
 * @param {Record<string, unknown>} [extra] 附加顶层字段
 * @returns {string}
 */
function exportCollectorAudit(extra) {
  return COLLECTOR_AUDIT.exportCollectorAudit(extra);
}

/**
 * 导出比赛结束审计快照文件（collector-audit-final.json）。
 * @returns {ReturnType<typeof COLLECTOR_AUDIT.exportAuditSnapshot>}
 */
function exportAuditSnapshot() {
  return COLLECTOR_AUDIT.exportAuditSnapshot();
}

/**
 * 生成带时间戳的审计导出文件。
 * @returns {ReturnType<typeof COLLECTOR_AUDIT.exportAuditToFile>}
 */
function exportAuditToFile() {
  return COLLECTOR_AUDIT.exportAuditToFile();
}

/**
 * 采集端 WS 维度日志快捷封装：所有事件名自动加 `ws_` 前缀。
 * @param {string} event 事件名（无 ws_ 前缀）
 * @param {Record<string, unknown>} [detail]
 * @returns {void}
 */
function logCollectorWs(event, detail) {
  appendCollectorHealthLog('ws_' + event, detail || {});
}

/**
 * 构造采集端 WS 诊断快照（导出与日志通用）。
 * @returns {Record<string, unknown>}
 */
function getCollectorWsDiagnosticSnapshot() {
  var now = Date.now();
  return {
    hasSocket: !!_socketTask,
    connecting: !!_wsConnecting,
    manualClose: !!_wsManualClose,
    reconnectAttempt: _wsReconnectAttempt || 0,
    roomId: _wsRoomId || '',
    since_open_ms: _wsOpenedAt ? now - _wsOpenedAt : -1,
    last_send_ok_ago_ms: _wsLastSendOkAt ? now - _wsLastSendOkAt : -1,
    last_recv_ago_ms: _wsLastRecvAt ? now - _wsLastRecvAt : -1
  };
}

// ─── WS 心跳 / 看门狗 / 网络监听 ───────────────────────────────────────────────

function isOcrWsRestartGuardActive() {
  return _ocrWsRestartGuardUntil > Date.now();
}

function beginOcrWsRestartGuard(reason) {
  _ocrWsRestartGuardUntil = Date.now() + OCR_WS_RESTART_GUARD_MS;
  _ocrWsRestartGuardReason = String(reason || 'ocr-restart');
  _ocrWsReconnectPendingAfterRestart = false;
  _ocrWsImmediateReconnectUsed = false;
  _ocrForceSyncAfterPump = true;
  _ocrPreserveSnapshotOnBoot = true;
  logCollectorWs('ocr_ws_guard_on', {
    reason: _ocrWsRestartGuardReason,
    guard_ms: OCR_WS_RESTART_GUARD_MS
  });
}

function clearOcrWsRestartGuard(reason) {
  if (!_ocrWsRestartGuardUntil && !_ocrForceSyncAfterPump) return;
  logCollectorWs('ocr_ws_guard_off', {
    reason: String(reason || _ocrWsRestartGuardReason || ''),
    pending_reconnect: !!_ocrWsReconnectPendingAfterRestart,
    has_socket: !!_socketTask
  });
  _ocrWsRestartGuardUntil = 0;
  _ocrWsRestartGuardReason = '';
  _ocrForceSyncAfterPump = false;
  _ocrPreserveSnapshotOnBoot = false;
}

/**
 * 构造一条「快照型心跳包」。
 *
 * 不能发送无 act/seq 的自定义心跳：服务端会把采集端上行包写入 lastSnapshot，
 * 直播端重连后若拿到的是普通心跳，就会因缺少 act/t/seq 而保持 00:00。
 * 因此心跳直接携带一份合法 COLLECTOR_UPDATE 快照，既刷新网关 idle，也保持
 * 服务端 lastSnapshot 始终可被新直播端消费。
 * @returns {string} JSON 字符串
 */
function _buildHeartbeatPacket() {
  _wsHeartbeatSeq += 1;
  var now = Date.now();
  var page = _wsPageRef;
  var snap = buildCurrentCollectorSnapshot(page, now);

  if (snap) {
    _globalSeq += 1;
    var packet = {
      type: 'COLLECTOR_UPDATE',
      act: snap.running ? 'START' : 'STOP',
      t: snap.t,
      a: snap.a,
      b: snap.b,
      p: snap.p,
      seq: _globalSeq,
      sys_t: now,
      match_id: 'M_' + (_wsRoomId || (page && page.data ? page.data.matchCode : '') || ''),
      hb_seq: _wsHeartbeatSeq,
      heartbeat: 1
    };
    _procState.published = {
      t: packet.t,
      a: packet.a,
      b: packet.b,
      p: packet.p,
      shotClock: snap.shotClock,
      running: snap.running,
      wallMs: now
    };
    return JSON.stringify(packet);
  }

  return JSON.stringify({
    type: 'COLLECTOR_HEARTBEAT',
    hb_seq: _wsHeartbeatSeq,
    sys_t: now,
    match_id: 'M_' + (_wsRoomId || ''),
    ping: 1
  });
}

/**
 * 计算下一次心跳间隔：基准 + 随机抖动；紧急模式下使用更短间隔。
 * @returns {number} 毫秒
 */
function _getNextHeartbeatDelay() {
  var base = _wsHeartbeatEmergency ? WS_HEARTBEAT_EMERGENCY_MS : WS_HEARTBEAT_INTERVAL_MS;
  var jitter = Math.floor((Math.random() * 2 - 1) * WS_HEARTBEAT_JITTER_MS);
  return Math.max(3000, base + jitter);
}

/**
 * 启动应用层心跳。
 *
 * 与旧版区别：
 *   - 使用 setTimeout 自递归，每次心跳后按「基准 + ±抖动」重新调度，
 *     避免与服务端 idle 边界形成稳定共振（旧 setInterval(25000) 正好踩在
 *     服务端 25s read timeout 上，触发了批量 1006 关闭）；
 *   - 心跳包结构与业务包同 schema（type/match_id/seq/sys_t），
 *     方便网关/服务端按统一规则识别业务流量并刷 idle。
 * @returns {void}
 */
function startCollectorHeartbeat() {
  stopCollectorHeartbeat();
  var scheduleNext = function () {
    var delay = _getNextHeartbeatDelay();
    _wsHeartbeatTimer = setTimeout(function () {
      _wsHeartbeatTimer = 0;
      _sendHeartbeatOnce(scheduleNext);
    }, delay);
  };
  /* 第一次提前一些发，让连接快速暴露在「心跳已就绪」状态：4~6s */
  _wsHeartbeatTimer = setTimeout(function () {
    _wsHeartbeatTimer = 0;
    _sendHeartbeatOnce(scheduleNext);
  }, 4000 + Math.floor(Math.random() * 2000));
}

/**
 * 单次心跳：发送、记账、失败兜底。
 * @param {() => void} scheduleNext 下一次心跳的调度器（成功/失败后均调用）
 * @returns {void}
 */
function _sendHeartbeatOnce(scheduleNext) {
  if (!_socketTask || _wsManualClose) return;
  var pkt = _buildHeartbeatPacket();
  try {
    _socketTask.send({
      data: pkt,
      success: function () {
        _wsLastSendOkAt = Date.now();
        if (typeof scheduleNext === 'function') scheduleNext();
      },
      fail: function (err) {
        logCollectorWs('heartbeat_send_fail', {
          msg: err && err.errMsg ? String(err.errMsg).slice(0, 120) : 'fail',
          since_open_ms: _wsOpenedAt ? Date.now() - _wsOpenedAt : -1,
          emergency: !!_wsHeartbeatEmergency
        });
        _handleCollectorWsSendFailure('heartbeat_fail', _wsPageRef);
      }
    });
    /* 心跳成功路径不打日志，避免日志环形缓冲被刷爆 */
  } catch (eHb) {
    logCollectorWs('heartbeat_throw', {
      msg: eHb && eHb.message ? String(eHb.message).slice(0, 120) : 'throw'
    });
    _handleCollectorWsSendFailure('heartbeat_throw', _wsPageRef);
  }
}

/**
 * 停止心跳定时器。
 * @returns {void}
 */
function stopCollectorHeartbeat() {
  if (_wsHeartbeatTimer) {
    clearTimeout(_wsHeartbeatTimer);
    _wsHeartbeatTimer = 0;
  }
}

/**
 * 启动看门狗：每 10 秒检查「最近一次成功 send」距今多久；超 60 秒视为假死。
 * 服务端不主动下行（除错误消息），所以采集端用 send 健康度作为存活判据。
 * @returns {(self: WechatMiniprogram.Page.Instance<any, any>) => void} 由调用方传入页面实例触发重连
 */
function startCollectorWatchdog(getPageInstance) {
  stopCollectorWatchdog();
  _wsWatchdogTimer = setInterval(function () {
    if (!_socketTask || _wsManualClose) return;
    var now = Date.now();
    var sendAge = _wsLastSendOkAt > 0 ? now - _wsLastSendOkAt : (_wsOpenedAt ? now - _wsOpenedAt : 0);
    if (sendAge > WS_SEND_STALE_MS) {
      logCollectorWs('send_stale_kick', {
        send_age_ms: sendAge,
        last_recv_ago_ms: _wsLastRecvAt ? now - _wsLastRecvAt : -1,
        since_open_ms: _wsOpenedAt ? now - _wsOpenedAt : -1,
        threshold_ms: WS_SEND_STALE_MS
      });
      var page = typeof getPageInstance === 'function' ? getPageInstance() : null;
      _handleCollectorWsSendFailure('send_stale', page);
    }
  }, WS_WATCHDOG_INTERVAL_MS);
}

/**
 * 停止看门狗定时器。
 * @returns {void}
 */
function stopCollectorWatchdog() {
  if (_wsWatchdogTimer) {
    clearInterval(_wsWatchdogTimer);
    _wsWatchdogTimer = 0;
  }
}

/**
 * send 失败 / 看门狗触发的统一处理：close 当前 socket 并立即调度重连。
 *
 * 重要：不再等待 onClose 回调。
 *
 * 历史教训（2026-05 Android wx 8.0.70）：`socketTask.send` fail 后业务侧调用 close，
 * 但 `onClose` 回调实测延迟 51 秒甚至 187 秒才到达；期间整个采集端卡在 wsState=connected
 * 但实际死透。旧实现依赖 onClose 调度重连，所以这段时间用户感知就是「连接没了又没重连」。
 *
 * 现策略：
 *   1) 立即同步置 wsState=reconnecting；
 *   2) 立即同步调用 _scheduleWsReconnect（内部已用 _wsReconnectTimer 去重，安全）；
 *   3) 真的 onClose 到来时只补打日志，不会再触发一次 reconnect（_wsReconnectTimer 已占位）。
 *
 * @param {string} reason 触发原因
 * @param {WechatMiniprogram.Page.Instance<any, any>} [pageInstance] 兼容旧调用方式；可为空，
 *   兜底会用 `_wsPageRef`（在 onLoad 注入）
 * @returns {void}
 */
function _handleCollectorWsSendFailure(reason, pageInstance) {
  if (_wsManualClose || !_wsRoomId) return;
  if (isOcrWsRestartGuardActive()) {
    _ocrWsReconnectPendingAfterRestart = true;
    logCollectorWs('transient_failure_deferred', {
      reason: String(reason || 'unknown'),
      guard_reason: _ocrWsRestartGuardReason,
      guard_left_ms: Math.max(0, _ocrWsRestartGuardUntil - Date.now())
    });
    return;
  }
  logCollectorWs('transient_failure', { reason: String(reason || 'unknown') });
  stopCollectorHeartbeat();
  stopCollectorWatchdog();
  _wsConnecting = false;
  if (_socketTask) {
    try { _socketTask.close({}); } catch (eClose) { /* ignore */ }
    _socketTask = null;
  }
  /* 关键修复：onClose 在某些 Android 版本上会延迟数十秒到几分钟才回调。
     必须立即同步把 wsState 改成 reconnecting，并主动 schedule 一次。 */
  var page = pageInstance || _wsPageRef;
  if (!page || typeof page._scheduleWsReconnect !== 'function') return;
  try {
    if (page.data && page.data.wsState !== 'reconnecting') {
      page.setData({ wsState: 'reconnecting', wsStateText: '断线重连中…' });
    }
    page._scheduleWsReconnect();
  } catch (eR) { /* ignore */ }
}

/**
 * 安装网络变化监听：从无网→有网或网络类型切换时触发主动 reconnect 自检。
 *
 * 防抖策略（修复 wifi↔4g 快速来回切的反复断连）：
 *   - 同类型「假切换」（如 wifi→wifi）直接跳过，不打断当前会话；
 *   - 真切换走 1500ms 防抖：等网络栈稳定后再去 close + reconnect；
 *   - 期间如果再次切换，复位防抖窗口，避免一边切一边重连请求 token 失败。
 *
 * @param {() => WechatMiniprogram.Page.Instance<any, any>} getPageInstance
 * @returns {void}
 */
function installCollectorNetworkListener(getPageInstance) {
  if (_wsNetworkChangeHandler) return;
  if (typeof wx === 'undefined' || typeof wx.onNetworkStatusChange !== 'function') return;
  _wsNetworkChangeHandler = function (res) {
    if (_wsManualClose || !_wsRoomId) return;
    var nextType = res && res.networkType ? String(res.networkType) : '';
    var isConnected = !!(res && res.isConnected);
    var sameType = !!nextType && nextType === _wsLastNetworkType;
    logCollectorWs('network_change', {
      net_type: nextType,
      prev: _wsLastNetworkType,
      is_connected: isConnected,
      debounced: !sameType && isConnected
    });
    _wsLastNetworkType = nextType;
    /* 同类型「假切换」（wifi→wifi/4g→4g）：不打断当前 socket */
    if (sameType) return;
    if (!isConnected) return;
    /* 真切换：进入防抖窗口；窗口内再来一次切换会自动 reset */
    if (_wsNetworkChangeTimer) {
      clearTimeout(_wsNetworkChangeTimer);
      _wsNetworkChangeTimer = 0;
    }
    _wsNetworkChangeTimer = setTimeout(function () {
      _wsNetworkChangeTimer = 0;
      if (_wsManualClose || !_wsRoomId) return;
      var now = Date.now();
      var recvAge = _wsLastRecvAt ? now - _wsLastRecvAt : -1;
      var sendAge = _wsLastSendOkAt ? now - _wsLastSendOkAt : -1;
      var openAge = _wsOpenedAt ? now - _wsOpenedAt : -1;
      var linkFresh =
        (recvAge >= 0 && recvAge <= WS_NETWORK_CHANGE_FRESH_RECV_MS) ||
        (sendAge >= 0 && sendAge <= WS_NETWORK_CHANGE_FRESH_SEND_MS) ||
        (openAge >= 0 && openAge <= WS_NETWORK_CHANGE_OPEN_GRACE_MS);

      if (_socketTask && linkFresh) {
        logCollectorWs('network_change_skip_fresh', {
          net_type: nextType,
          recv_age_ms: recvAge,
          send_age_ms: sendAge,
          open_age_ms: openAge
        });
        return;
      }

      if (_socketTask) {
        logCollectorWs('network_change_probe', {
          net_type: nextType,
          recv_age_ms: recvAge,
          send_age_ms: sendAge,
          open_age_ms: openAge
        });
        _sendHeartbeatOnce(function () {
          logCollectorWs('network_change_probe_ok', { net_type: nextType });
        });
        return;
      }

      var page = typeof getPageInstance === 'function' ? getPageInstance() : null;
      _handleCollectorWsSendFailure('network_change', page);
    }, WS_NETWORK_CHANGE_DEBOUNCE_MS);
  };
  try {
    wx.onNetworkStatusChange(_wsNetworkChangeHandler);
    try {
      if (typeof wx.getNetworkType === 'function') {
        wx.getNetworkType({
          success: function (r) {
            _wsLastNetworkType = r && r.networkType ? String(r.networkType) : '';
          }
        });
      }
    } catch (eGet) { /* ignore */ }
  } catch (eNet) {
    _wsNetworkChangeHandler = null;
  }
}

/**
 * 卸载网络变化监听。
 * @returns {void}
 */
function uninstallCollectorNetworkListener() {
  if (_wsNetworkChangeTimer) {
    clearTimeout(_wsNetworkChangeTimer);
    _wsNetworkChangeTimer = 0;
  }
  if (!_wsNetworkChangeHandler) return;
  try {
    if (typeof wx !== 'undefined' && typeof wx.offNetworkStatusChange === 'function') {
      wx.offNetworkStatusChange(_wsNetworkChangeHandler);
    }
  } catch (eNet) { /* ignore */ }
  _wsNetworkChangeHandler = null;
}

// ─────────────────────────────────────────────────────────────────────────────

Page({
  data: {
    statusBarHeight: 0,
    /** 登录 + 白名单双重门控 */
    isLogin: false,
    isInWhitelist: false,
    // WebSocket 连接状态
    wsState: 'idle',
    wsStateText: '未连接',
    matchCode: '',
    // 比赛数据
    homeScore: 0,
    awayScore: 0,
    period: 1,
    minutes: 10,
    seconds: 0,
    shotClock: 24,
    // OCR
    ocrEnabled: false,
    debugMode: false,
    /** @type {Array<{x,y,w,h,label,rawText,pctStyle}>} */
    rois: DEFAULT_ROIS.map(function (r) { return Object.assign({}, r); }),
    cameraMounted: true,
    previewPxW: 0,
    previewPxH: 0,
    selectedRoiIdx: -1,
    debugText: '',
    ocrTransitioning: false,
    /** 相机画面缩放倍数，默认 1.0 */
    cameraZoom: 1,
    /** 缩放倍数展示文案（一位小数） */
    cameraZoomDisplay: '1.0',
    /** 用户满意并记忆的上次缩放倍数 */
    lastCameraZoom: 1,
    /** 记忆倍数展示文案（一位小数） */
    lastCameraZoomDisplay: '1.0',
    /** 当前可一键恢复记忆倍数（相机回弹 1.0x 且记忆值 > 1） */
    canRestoreLastZoom: false
  },

  // ─── 生命周期 ────────────────────────────────────────

  onLoad: function () {
    var sys = wx.getSystemInfoSync();
    var camW = sys.windowWidth || 667;
    var camH = sys.windowHeight || 375;
    _previewW = camW;
    _previewH = camH;
    this.setData({
      statusBarHeight: sys.statusBarHeight || 0,
      previewPxW: camW,
      previewPxH: camH
    });
    _cameraContext = wx.createCameraContext(this);
    _cameraReadyAt = Date.now();
    wx.setKeepScreenOn({ keepScreenOn: true });
    /* 健康日志与网络监听一次性安装；与原有 OCR/相机链路完全解耦 */
    initCollectorHealthLogs();
    /* 关键：把页面实例存到模块级 _wsPageRef，
       供心跳/看门狗失败时直接拿来 setData / _scheduleWsReconnect。
       不再依赖 onClose（Android 上 onClose 实测延迟 51~187 秒）。 */
    _wsPageRef = this;
    var self = this;
    installCollectorNetworkListener(function () { return self; });
    this._checkAccess();
    this._loadRois();
  },

  onReady: function () {
    var self = this;
    this._initOcrVkCanvas().catch(function (err) {
      console.error('[Collector][OCR] init hidden webgl fail', err);
    });
  },

  onCameraInit: function () {
    _cameraContext = wx.createCameraContext(this);
    _cameraReadyAt = Date.now();
    console.log('[Collector][OCR] camera init, context refreshed');
    // 相机重建后硬件倍数常回弹 1.0x，同步 UI 以点亮「恢复倍数」
    if (this.data.lastCameraZoom > 1.05 && this.data.cameraZoom > 1.05) {
      var self = this;
      this.setData({
        cameraZoom: 1,
        cameraZoomDisplay: '1.0'
      }, function () {
        self._syncZoomRestoreUi();
      });
    } else {
      this._syncZoomRestoreUi();
    }
  },

  onCameraError: function (e) {
    console.error('[Collector] camera error', e.detail);
    wx.showToast({ title: '相机启动失败', icon: 'none' });
  },

  /**
   * 根据当前倍数与记忆倍数，刷新「恢复倍数」按钮可用态。
   * @returns {void}
   */
  _syncZoomRestoreUi: function () {
    var cur = this.data.cameraZoom;
    var last = this.data.lastCameraZoom;
    var can = last > 1.05 && cur < 1.05;
    if (this.data.canRestoreLastZoom !== can) {
      this.setData({ canRestoreLastZoom: can });
    }
  },

  /**
   * 调用硬件 setZoom 对齐镜头倍数。
   * @param {number} zoom
   * @returns {void}
   */
  _applyHardwareCameraZoom: function (zoom) {
    var ctx = wx.createCameraContext();
    if (ctx && typeof ctx.setZoom === 'function') {
      ctx.setZoom({
        zoom: zoom,
        success: function () {
          console.log('[Collector][Camera] Hardware setZoom success: ' + zoom);
        },
        fail: function (err) {
          console.error('[Collector][Camera] Hardware setZoom fail', err);
        }
      });
    } else {
      console.warn('[Collector][Camera] setZoom API not supported on this WeChat version');
    }
  },

  /**
   * 处理相机缩放倍数改变（仅在滑块松手时触发，避免拖动中频繁变焦导致 OCR 震荡）
   * @param {WechatMiniprogram.SliderChange} e
   */
  onCameraZoomChange: function (e) {
    var val = Math.round(Number(e.detail.value) * 10) / 10;
    if (val < 1) val = 1;
    if (val > 4) val = 4;

    var self = this;
    this.setData({
      cameraZoom: val,
      cameraZoomDisplay: val.toFixed(1),
      lastCameraZoom: val,
      lastCameraZoomDisplay: val.toFixed(1)
    }, function () {
      self._syncZoomRestoreUi();
    });

    // 【修复】：对于挂载了 VKSession 的原生 camera 组件，
    // 纯 WXML 属性绑定往往无法动态生效，必须直接调用底层的 setZoom API 强行驱动硬件变焦。
    this._applyHardwareCameraZoom(val);
  },

  /**
   * 一键恢复上次满意的镜头倍数。
   * @returns {void}
   */
  onRestoreLastZoom: function () {
    if (!this.data.canRestoreLastZoom) return;
    var targetZoom = this.data.lastCameraZoom;
    var curZoom = this.data.cameraZoom;
    if (typeof targetZoom !== 'number' || targetZoom < 1) return;
    if (Math.abs(curZoom - targetZoom) < 0.05) return;

    this._zoomBlurGuardedUntil = Date.now() + 350;
    var self = this;
    this.setData({
      cameraZoom: targetZoom,
      cameraZoomDisplay: targetZoom.toFixed(1)
    }, function () {
      self._syncZoomRestoreUi();
    });
    this._applyHardwareCameraZoom(targetZoom);
  },

  onUnload: function () {
    this._stopOcr(true);
    this._disconnectWebSocket(true);
    uninstallCollectorNetworkListener();
    wx.setKeepScreenOn({ keepScreenOn: false });
    appendCollectorHealthLog('page_unload', {});
    _wsPageRef = null;
  },

  /**
   * 小程序进入后台：停止相机帧监听，减少无意义回调与半停相机导致的堆积。
   * 不销毁 VK，回到前台后由 onShow 恢复泵（手动 OCR 模式）。
   */
  onHide: function () {
    appendCollectorHealthLog('page_hide', { ws: getCollectorWsDiagnosticSnapshot() });
    if (!this.data.ocrEnabled) return;
    _ocrPausedForBackground = true;
    this._cancelOcrFramePump();
    console.log('[Collector][OCR] paused frame pump (onHide)');
  },

  /**
   * 回到前台：恢复 OCR 帧泵 + WS 健康自检（前台后链路常因 NAT/系统挂起而假死）。
   */
  onShow: function () {
    appendCollectorHealthLog('page_show', { ws: getCollectorWsDiagnosticSnapshot() });
    /* WS 健康自检：曾经连过 + 当前不在 connected 状态 → 立即调度一次重连 */
    if (_wsRoomId && !_wsManualClose && this.data.wsState !== 'connected' && this.data.wsState !== 'connecting') {
      logCollectorWs('app_show_resync', { ws_state: this.data.wsState || '' });
      this.setData({ wsState: 'reconnecting', wsStateText: '断线重连中…' });
      this._scheduleWsReconnect();
    }
    if (!_ocrPausedForBackground || !this.data.ocrEnabled) return;
    _ocrPausedForBackground = false;
    var session = _vkSession;
    if (!session || !_ocrManualMode) return;
    var token = _ocrSessionToken;
    console.log('[Collector][OCR] resume frame pump after foreground token=%s', token);
    this._startOcrFramePump(session, token);
  },

  // ─── 屏幕翻转与尺寸变化监听 ─────────────────────────
  /**
   * 跟随系统自动旋转：当用户在采集端旋转手机（横竖屏切换）时，
   * 微信会触发 onResize 并提供新的 windowWidth/windowHeight。
   * 这里同步更新底层物理预览尺寸缓存与 UI 层 setData，
   * 并在 OCR 运行中强制软重启 VK 会话以重建 WebGL 缓冲、避免画面畸变与 ROI 坐标错位。
   * @param {{size:{windowWidth:number,windowHeight:number}}} res 微信 onResize 回调参数
   * @returns {void}
   */
  onResize: function (res) {
    if (!res || !res.size) return;

    var newW = res.size.windowWidth;
    var newH = res.size.windowHeight;

    _previewW = newW;
    _previewH = newH;

    this.setData({
      previewPxW: newW,
      previewPxH: newH
    });

    console.log('[Collector] 屏幕尺寸变化/翻转，新尺寸: %sx%s', newW, newH);

    if (this.data.ocrEnabled && !this.data.ocrTransitioning) {
      this._softRestartOcrSession('screen-rotated');
      wx.showToast({ title: '屏幕翻转，引擎自适应中', icon: 'none' });
    }
  },

  // ─── 访问控制 ────────────────────────────────────────

  /**
   * 登录 + 白名单检查。
   * - isLogin:       globalData.userInfo 非 null 或 Storage 中存在 token
   * - isInWhitelist: sync_lab_whitelist 为空（开发阶段放行）或包含当前 openid
   */
  _checkAccess: function () {
    var app = getApp();
    var gd = (app && app.globalData) || {};
    var token = REQ.getToken ? REQ.getToken() : wx.getStorageSync('token');
    var isLogin = !!(token || (gd.userInfo && gd.userInfo.openid));

    var whitelist = wx.getStorageSync('sync_lab_whitelist') || [];
    var openid = (gd.userInfo && gd.userInfo.openid) || wx.getStorageSync('openid') || '';
    // 白名单为空 → 开发阶段默认放行；非空 → 必须命中
    var isInWhitelist = !whitelist.length || (!!openid && whitelist.indexOf(openid) !== -1);

    this.setData({ isLogin: isLogin, isInWhitelist: isInWhitelist });
    if (!isLogin || !isInWhitelist) {
      console.warn('[Collector] access denied — isLogin:', isLogin, 'isInWhitelist:', isInWhitelist);
    }
  },

  // ─── ROI 持久化 ──────────────────────────────────────

  _loadRois: function () {
    try {
      var saved = wx.getStorageSync(STORAGE_KEY_ROIS);
      if (saved && Array.isArray(saved) && saved.length) {
        var normalized = saved.slice(0);
        var migrated = false;
        if (normalized.length >= 4) {
          normalized = normalized.slice(0, 3);
          migrated = true;
        }
        if (normalized.length === 3) {
          this.setData({ rois: _withPctStyle(normalized) });
          if (migrated) {
            this._saveRois();
          }
          return;
        }
      }
    } catch (e) { }
    this.setData({ rois: _withPctStyle(DEFAULT_ROIS.map(function (r) { return Object.assign({}, r); })) });
  },

  _saveRois: function () {
    var raw = this.data.rois.map(function (r) {
      return { x: r.x, y: r.y, w: r.w, h: r.h, label: r.label, rawText: '' };
    });
    try { wx.setStorageSync(STORAGE_KEY_ROIS, raw); } catch (e) { }
    this._syncOcrFilterRois();
  },

  // ─── OCR 机位预设 ───────────────────────────────────

  onSavePreset: function () {
    var preset = {
      rois: this.data.rois.map(function (r) {
        return { x: r.x, y: r.y, w: r.w, h: r.h, label: r.label };
      }),
      cameraZoom: this.data.cameraZoom
    };
    wx.setStorageSync(STORAGE_KEY_OCR_PRESET, preset);
    wx.showToast({ title: '机位预设已保存', icon: 'success' });
  },

  onLoadPreset: function () {
    var preset = wx.getStorageSync(STORAGE_KEY_OCR_PRESET);
    if (!preset || !Array.isArray(preset.rois) || !preset.rois.length) {
      wx.showToast({ title: '未找到机位预设', icon: 'none' });
      return;
    }

    var rois = preset.rois.map(function (r) {
      return {
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        label: r.label,
        rawText: '',
        pctStyle: _computePctStyle(r.x, r.y, r.w, r.h)
      };
    });
    var targetZoom = Number(preset.cameraZoom || 1);
    if (!isFinite(targetZoom) || targetZoom < 1) targetZoom = 1;
    if (targetZoom > 4) targetZoom = 4;

    var shouldResumePump = !!this.data.ocrEnabled;
    if (shouldResumePump) {
      this._cancelOcrFramePump();
    }

    var self = this;
    this.setData({
      rois: rois,
      cameraZoom: targetZoom,
      cameraZoomDisplay: targetZoom.toFixed(1),
      lastCameraZoom: targetZoom,
      lastCameraZoomDisplay: targetZoom.toFixed(1)
    }, function () {
      self._syncZoomRestoreUi();
      self._saveRois();
      self._applyHardwareCameraZoom(targetZoom);
      if (shouldResumePump && _vkSession) {
        self._startOcrFramePump(_vkSession, _ocrSessionToken);
      }
      wx.showToast({ title: '预设已恢复', icon: 'success' });
    });
  },

  // ─── ROI 整体拖动 ────────────────────────────────────

  onRoiBodyTouchStart: function (e) {
    var idx = parseInt(e.currentTarget.dataset.idx, 10);
    var touch = e.touches[0];
    var roi = this.data.rois[idx];
    _dragging = {
      mode: 'move',
      index: idx,
      startX: touch.clientX,
      startY: touch.clientY,
      origX: roi.x,
      origY: roi.y,
      origW: roi.w,
      origH: roi.h
    };
    _rafPending = false;
    this.setData({ selectedRoiIdx: idx });
  },

  onRoiBodyTouchMove: function (e) {
    if (!_dragging || _dragging.mode !== 'move') return;
    if (!e.touches || !e.touches.length) return;
    _rafTouchX = e.touches[0].clientX;
    _rafTouchY = e.touches[0].clientY;
    if (_rafPending) return;
    _rafPending = true;
    var self = this;
    _rAF(function () {
      _rafPending = false;
      if (!_dragging || _dragging.mode !== 'move') return;
      var now = Date.now();
      if (now - _lastRoiTickTs < 16) return;
      _lastRoiTickTs = now;
      var idx = _dragging.index;
      var pw = _previewW || 375;
      var ph = _previewH || 667;
      var newX = Math.max(0, Math.min(1 - _dragging.origW,
        _dragging.origX + (_rafTouchX - _dragging.startX) / pw));
      var newY = Math.max(0, Math.min(1 - _dragging.origH,
        _dragging.origY + (_rafTouchY - _dragging.startY) / ph));
      if (isNaN(newX) || isNaN(newY)) return;
      var curr = self.data.rois[idx];
      if (curr && curr.x === newX && curr.y === newY) return;
      var update = {};
      update['rois[' + idx + '].x'] = newX;
      update['rois[' + idx + '].y'] = newY;
      update['rois[' + idx + '].pctStyle'] = _computePctStyle(newX, newY, _dragging.origW, _dragging.origH);
      self.setData(update);
    });
  },

  // ─── ROI 右下角缩放 ──────────────────────────────────

  onRoiResizeTouchStart: function (e) {
    var idx = parseInt(e.currentTarget.dataset.idx, 10);
    var touch = e.touches[0];
    var roi = this.data.rois[idx];
    _dragging = {
      mode: 'resize-se',
      index: idx,
      startX: touch.clientX,
      startY: touch.clientY,
      origX: roi.x,
      origY: roi.y,
      origW: roi.w,
      origH: roi.h
    };
    _rafPending = false;
    this.setData({ selectedRoiIdx: idx });
  },

  onRoiResizeTouchMove: function (e) {
    if (!_dragging || _dragging.mode !== 'resize-se') return;
    if (!e.touches || !e.touches.length) return;
    _rafTouchX = e.touches[0].clientX;
    _rafTouchY = e.touches[0].clientY;
    if (_rafPending) return;
    _rafPending = true;
    var self = this;
    _rAF(function () {
      _rafPending = false;
      if (!_dragging || _dragging.mode !== 'resize-se') return;
      var now = Date.now();
      if (now - _lastRoiTickTs < 16) return;
      _lastRoiTickTs = now;
      var idx = _dragging.index;
      var pw = _previewW || 375;
      var ph = _previewH || 667;
      var newW = Math.max(ROI_MIN_SIZE, Math.min(1 - _dragging.origX,
        _dragging.origW + (_rafTouchX - _dragging.startX) / pw));
      var newH = Math.max(ROI_MIN_SIZE, Math.min(1 - _dragging.origY,
        _dragging.origH + (_rafTouchY - _dragging.startY) / ph));
      if (isNaN(newW) || isNaN(newH)) return;
      var curr = self.data.rois[idx];
      if (curr && curr.w === newW && curr.h === newH) return;
      var update = {};
      update['rois[' + idx + '].w'] = newW;
      update['rois[' + idx + '].h'] = newH;
      update['rois[' + idx + '].pctStyle'] = _computePctStyle(_dragging.origX, _dragging.origY, newW, newH);
      self.setData(update);
    });
  },

  /** 拖动/缩放结束：统一清理并持久化 */
  onRoiTouchEnd: function () {
    _dragging = null;
    _rafPending = false;
    _lastRoiTickTs = 0;
    this._saveRois();
  },

  // ─── 节次快选 ────────────────────────────────────────

  onSetPeriod: function (e) {
    var p = parseInt(e.currentTarget.dataset.p, 10);
    if (!p || p < 1 || p > 8) return;
    this.setData({ period: p });
    this._emitWsPacket('PERIOD', {
      t: clockToTotalSec({ minutes: this.data.minutes, seconds: this.data.seconds }),
      a: this.data.homeScore,
      b: this.data.awayScore,
      p: p
    });
    setAuditClockSource('manual', 'period_select', 'onSetPeriod');
    this._commitLocalState({
      homeScore: this.data.homeScore,
      awayScore: this.data.awayScore,
      period: p,
      minutes: this.data.minutes,
      seconds: this.data.seconds,
      shotClock: this.data.shotClock
    });
  },

  // ─── OCR 开关 ────────────────────────────────────────

  onToggleOcr: function () {
    if (this.data.ocrTransitioning) {
      wx.showToast({ title: '引擎切换中...', icon: 'none', duration: 800 });
      return;
    }

    if (this.data.ocrEnabled || _vkSession || _ocrBootTimer) {
      this._stopOcr(false);
      return;
    }
    this._startOcr();
  },

  /**
   * 长按比分区切换调试模式（底部不再展示调试按钮）。
   * @returns {void}
   */
  onToggleDebug: function () {
    this.setData({ debugMode: !this.data.debugMode });
  },

  /**
   * 长按顶部状态条：导出采集端健康日志到剪贴板，供现场排障粘贴回传。
   * 体积控制：最多 60 条 + 设备 header + 当前 WS 快照；包含截断保护避免剪贴板写入超限。
   * @returns {void}
   */
  /**
   * 长按导出采集端审计日志到剪贴板（与健康日志独立）。
   * @returns {void}
   */
  onExportCollectorAudit: function () {
    var dump = dumpCollectorAudit();
    if (!dump.count) {
      wx.showToast({ title: '暂无审计日志', icon: 'none' });
      return;
    }
    var snapshot = exportAuditSnapshot();
    var summary = snapshot.summary || COLLECTOR_AUDIT.buildAuditSummary();
    var ndjsonPath = COLLECTOR_AUDIT.getAuditNdjsonPath();
    var text = exportCollectorAudit({
      ws: getCollectorWsDiagnosticSnapshot(),
      ndjsonPath: ndjsonPath,
      finalSnapshotPath: snapshot.path || '',
      summary: summary
    });
    var summaryLines = [];
    if (summary.eventCounts) {
      var evtKeys = Object.keys(summary.eventCounts);
      for (var si = 0; si < evtKeys.length && si < 10; si++) {
        summaryLines.push(evtKeys[si] + ': ' + summary.eventCounts[evtKeys[si]]);
      }
    }
    wx.setClipboardData({
      data: text,
      success: function () {
        var content = [
          'RingBuffer: ' + dump.count + ' 条',
          'NDJSON: ' + (ndjsonPath || '不可用'),
          '快照: ' + (snapshot.path || '未生成'),
          '统计: ' + (summaryLines.length ? summaryLines.join(', ') : '无')
        ].join('\n');
        wx.showModal({
          title: '审计日志已导出',
          content: content,
          showCancel: false,
          confirmText: '知道了'
        });
      },
      fail: function () {
        wx.showToast({ title: '剪贴板写入失败', icon: 'none' });
      }
    });
  },

  /**
   * 导出审计日志为本地文件，并尝试分享给好友或保存到手机。
   * @returns {void}
   */
  onExportCollectorAuditFile: function () {
    var dump = dumpCollectorAudit();
    if (!dump.count) {
      wx.showToast({ title: '暂无审计日志', icon: 'none' });
      return;
    }
    var fileResult = exportAuditToFile();
    if (!fileResult.ok || !fileResult.path) {
      wx.showToast({ title: '导出文件失败', icon: 'none' });
      return;
    }
    var sizeKb = Math.max(1, Math.round((fileResult.size || 0) / 1024));
    var summary = fileResult.summary || {};
    var summaryText = summary.total ? ('共 ' + summary.total + ' 条') : '';

    var showFileReadyModal = function (hint) {
      wx.showModal({
        title: '审计文件已生成',
        content: [
          fileResult.fileName,
          sizeKb + ' KB',
          summaryText,
          hint || '',
          fileResult.path
        ].filter(Boolean).join('\n'),
        showCancel: false,
        confirmText: '知道了'
      });
    };

    if (typeof wx.shareFileMessage === 'function') {
      wx.shareFileMessage({
        filePath: fileResult.path,
        fileName: fileResult.fileName,
        success: function () {
          wx.showToast({ title: '请选择好友发送', icon: 'none' });
        },
        fail: function () {
          if (typeof wx.saveFileToDisk === 'function') {
            wx.saveFileToDisk({
              filePath: fileResult.path,
              success: function () {
                wx.showToast({ title: '已保存到手机', icon: 'success' });
              },
              fail: function () {
                showFileReadyModal('可通过文件路径在调试器中取回');
              }
            });
            return;
          }
          showFileReadyModal('分享不可用，请通过调试器取回文件');
        }
      });
      return;
    }

    if (typeof wx.saveFileToDisk === 'function') {
      wx.saveFileToDisk({
        filePath: fileResult.path,
        success: function () {
          wx.showToast({ title: '已保存到手机', icon: 'success' });
        },
        fail: function () {
          showFileReadyModal('保存失败，请通过调试器取回文件');
        }
      });
      return;
    }

    showFileReadyModal('当前环境不支持分享，请通过调试器取回文件');
  },

  onExportCollectorLogs: function () {
    initCollectorHealthLogs();
    var compactDetail = function (detail) {
      if (!detail || typeof detail !== 'object') return detail;
      var out = {};
      var keys = Object.keys(detail).slice(0, 28);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var val = detail[key];
        if (typeof val === 'string' && val.length > 200) {
          val = val.slice(-200);
        }
        out[key] = val;
      }
      return out;
    };
    var logs = (_collectorHealthLogs || []).slice(-100).map(function (it) {
      return { t: it.t, e: it.e, d: compactDetail(it.d) };
    });
    var payload = {
      at: Date.now(),
      device: _collectorHealthLogDevice || {},
      ws: getCollectorWsDiagnosticSnapshot(),
      cfg: {
        hb_ms: WS_HEARTBEAT_INTERVAL_MS,
        hb_emerg_ms: WS_HEARTBEAT_EMERGENCY_MS,
        hb_jitter_ms: WS_HEARTBEAT_JITTER_MS,
        hb_emergency_on: !!_wsHeartbeatEmergency,
        shortlived_streak: _wsShortLivedStreak || 0,
        handshake_token_to_ms: WS_HANDSHAKE_TOKEN_TIMEOUT_MS,
        handshake_socket_to_ms: WS_HANDSHAKE_SOCKET_TIMEOUT_MS,
        send_stale_ms: WS_SEND_STALE_MS,
        netchange_debounce_ms: WS_NETWORK_CHANGE_DEBOUNCE_MS,
        last_net_type: _wsLastNetworkType || ''
      },
      logs: logs
    };
    var text = '';
    try {
      text = JSON.stringify(payload);
      if (text.length > 900000) {
        payload.logs = payload.logs.slice(-40);
        text = JSON.stringify(payload);
      }
    } catch (eJson) {
      wx.showToast({ title: '日志序列化失败', icon: 'none' });
      return;
    }
    if (!text || logs.length === 0) {
      wx.showToast({ title: '暂无健康日志', icon: 'none' });
      return;
    }
    wx.setClipboardData({
      data: text,
      success: function () {
        wx.showModal({
          title: '采集端日志已复制',
          content: '已复制 ' + logs.length + ' 条日志到剪贴板，可粘贴回传给开发同学排查。',
          showCancel: false,
          confirmText: '知道了'
        });
      },
      fail: function () {
        wx.showToast({ title: '剪贴板写入失败', icon: 'none' });
      }
    });
  },

  _startOcr: function () {
    var token = ++_ocrSessionToken;
    this._clearOcrBootTimers();
    this._stopOcrSession();
    // 每次启动 OCR 前，彻底清空遗留脏数据，实现完全重新采集（不影响 WebSocket、不覆盖人工维护的 period / shotClock）。
    this._wipeOcrDirtyState();
    this._prepareCameraForOcrBoot(token, 'start');
  },

  _flushPendingWsStartAfterOcr: function () {
    if (!this._pendingWsStartAfterOcr) return;
    if (this.data.ocrTransitioning) return;
    this._pendingWsStartAfterOcr = false;
    if (_wsConnecting || this.data.wsState !== 'idle') return;
    this._beginWsSyncNow();
  },

  /**
   * 清理 OCR 内部状态机，让重启后的 OCR 从空白基线开始识别。
   * 严格约束：
   *   - 不重置比分 / 时间 UI 数据（关 OCR 不应让直播端瞬间跳回 0:0/10:00；
   *     重启后 OCR 读到多少就上报多少，以现场记分牌为准）。
   *   - 不触碰 WebSocket 连接、不重置 period / shotClock。
   * @returns {void}
   */
  _wipeOcrDirtyState: function () {
    console.log('[Collector][OCR] Wiping OCR internal state (UI scores/time preserved)');

    _lastCommittedFrameKey = '';
    _lastPreviewFrameKey = '';
    _lastCommittedFrame = null;
    _scoreJumpHold = null;
    _timeJumpHoldFrame = null;
    _ocrLastRoiRunTs = [0, 0, 0];
    _ocrRoiTextSeq = [0, 0, 0];

    var rois = (this.data.rois || []).map(function (r) {
      return Object.assign({}, r, { rawText: '' });
    });

    this.setData({ rois: rois });

    resetProcessOcrState();

    resetOcrOcclusionState();

    resetOcrV5TriggerState();

    if (typeof bumpManualScoreEditGate === 'function') {
      bumpManualScoreEditGate();
    }
  },

  _clearOcrBootTimers: function () {
    if (_ocrBootTimer) {
      clearTimeout(_ocrBootTimer);
      _ocrBootTimer = 0;
    }
    if (_ocrCameraRemountTimer) {
      clearTimeout(_ocrCameraRemountTimer);
      _ocrCameraRemountTimer = 0;
    }
  },

  _prepareCameraForOcrBoot: function (token, reason) {
    var self = this;
    _ocrLastBootReason = reason || '';
    var bootDelay = _getVkBootDelayMs();
    this._clearOcrBootTimers();
    console.log('[Collector][OCR] prepare camera for boot token=%s reason=%s bootDelay=%s', token, reason || '', bootDelay);
    this.setData({ ocrTransitioning: true, cameraMounted: true }, function () {
      if (!_cameraContext) {
        _cameraContext = wx.createCameraContext(self);
        _cameraReadyAt = Date.now();
      }
      _ocrBootTimer = setTimeout(function () {
        _ocrBootTimer = 0;
        if (token !== _ocrSessionToken) return;
        var readyAge = _cameraReadyAt ? (Date.now() - _cameraReadyAt) : -1;
        console.log('[Collector][OCR] boot window open token=%s reason=%s cameraReadyAgeMs=%s cameraCtx=%s', token, reason || '', readyAge, !!_cameraContext);
        self._bootOcrSession(token);
      }, bootDelay);
    });
  },

  _bootOcrSession: function (token) {
    var self = this;
    if (token !== _ocrSessionToken) return;
    this._initOcrVkCanvas().then(function () {
      self._bootOcrSessionWithGl(token);
    }).catch(function (err) {
      console.warn('[Collector][OCR] hidden webgl unavailable, continue without gl', err);
      self._bootOcrSessionWithGl(token);
    });
  },

  _initOcrVkCanvas: function () {
    var self = this;
    if (_ocrVkCanvas && _ocrVkGl) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      self.createSelectorQuery()
        .select('#ocrVkCanvas')
        .node()
        .exec(function (res) {
          if (!res || !res[0] || !res[0].node) {
            reject(new Error('ocrVkCanvas node not found'));
            return;
          }
          var canvasNode = res[0].node;
          try {
            var gl = canvasNode.getContext('webgl', {
              antialias: false,
              depth: false,
              stencil: false,
              alpha: false,
              preserveDrawingBuffer: false
            });
            if (!gl) {
              reject(new Error('ocrVkCanvas webgl unavailable'));
              return;
            }
            var width = Math.max(2, Math.floor(_previewW || 851));
            var height = Math.max(2, Math.floor(_previewH || 393));
            canvasNode.width = width;
            canvasNode.height = height;
            try { gl.viewport(0, 0, width, height); } catch (eViewport) { }
            _ocrVkCanvas = canvasNode;
            _ocrVkGl = gl;
            console.log('[Collector][OCR] hidden webgl ready size=%sx%s', width, height);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
    });
  },

  _bootOcrSessionWithGl: function (token) {
    var self = this;
    if (token !== _ocrSessionToken) return;
    var shouldPreserveSnapshot = !!_ocrPreserveSnapshotOnBoot;
    _ocrPreserveSnapshotOnBoot = false;
    _lastHandleTs = 0;
    _pendingOcrFrame = null;
    _lastCommittedFrameKey = '';
    if (!shouldPreserveSnapshot) {
      _lastCommittedFrame = null;
    }
    _lastRejectedStableFrameKey = '';
    _lastRejectedStableFrameCount = 0;
    _ocrAnchorEventCount = 0;
    _ocrNativeTextEventCount = 0;
    _ocrAnchorLogSeq = 0;
    _ocrQueueCursor = 0;
    _ocrManualMode = false;
    _ocrLastRoiRunTs = [0, 0, 0];
    _ocrRoiBackoffUntil = [0, 0, 0];
    _ocrRoiTextSeq = [0, 0, 0];
    var softBoot = String(_ocrLastBootReason || '').indexOf('soft-restart') >= 0;
    if (softBoot) {
      _ocrScoreTimeoutStreak = 0;
      _ocrScorePumpQuiesceUntil = Date.now() + OCR_SCORE_PUMP_QUIESCE_MS;
      resetOcrTimeBaseline();
      resetOcrOcclusionState();
      _ocrManualFailTimestamps = [];
      _ocrSdkDegradedUntil = Date.now() + OCR_SDK_DEGRADED_DURATION_MS;
      if (_lastCommittedFrame) {
        var holdBootSec = ocrFrameClockSec(_lastCommittedFrame);
        var bootNow = Date.now();
        _ocrLastTimeSuccessTs = bootNow;
        _ocrV5LastTimeOcrOkTs = bootNow;
        if (holdBootSec >= 0) _ocrLastGoodClockSec = holdBootSec;
      } else {
        _ocrLastTimeSuccessTs = 0;
      }
      console.log('[Collector][OCR] soft boot: score quiesced, time-only degraded mode');
    } else {
      _ocrLastTimeSuccessTs = 0;
      resetOcrScorePumpCircuit();
      resetScorePumpDisabled();
      resetOcrTimeBaseline();
    }
    _timeJumpHoldFrame = null;
    _scoreJumpHold = null;
    _manualScoreEditAt = 0;
    _lastNotifyWallAt = 0;
    _lastTimePumpTs = 0;
    _lastScorePumpTs = 0;
    _scorePumpCursor = 0;
    _lastSoftSyncWallTs = 0;
    _clockJumpCandidateSec = -1;
    _clockJumpCandidateSince = 0;
    _isFinalMinuteMode = false;
    TIME_PUMP_INTERVAL = TIME_PUMP_INTERVAL_BASE_MS;
    SCORE_PUMP_INTERVAL = SCORE_PUMP_INTERVAL_BASE_MS;
    OCR_CLOCK_PREDICT_TICK_MS = OCR_CLOCK_PREDICT_TICK_BASE_MS;
    if (_ocrAnchorWatchdogTimer) {
      clearTimeout(_ocrAnchorWatchdogTimer);
      _ocrAnchorWatchdogTimer = 0;
    }
    var session = null;
    try {
      session = wx.createVKSession({ version: 'v1', track: { OCR: { mode: 2 } } });
    } catch (eCreate) {
      try {
        session = wx.createVKSession({ track: { OCR: { mode: 2 } } });
        console.warn('[Collector][OCR] createVKSession fallback without explicit version');
      } catch (eCreateFallback) {
        try {
          session = wx.createVKSession({ track: { OCR: { mode: 2 } }, gl: _ocrVkGl });
          console.warn('[Collector][OCR] createVKSession fallback with hidden gl');
        } catch (eCreateWithGl) {
          clearOcrWsRestartGuard('boot-create-fail');
          self._stopOcrSession();
          self._restoreCameraPreview(function () {
            self.setData({ ocrEnabled: false, ocrTransitioning: false }, function () {
              self._commitLocalState();
            });
          });
          console.error('[Collector] createVKSession fail', eCreateWithGl || eCreateFallback || eCreate);
          wx.showToast({ title: 'OCR 初始化失败', icon: 'none' });
          return;
        }
      }
    }
    _vkSession = session;
    console.log('[Collector][OCR] boot session token=%s delay=%s preview=%sx%s readyAt=%s rois=%o', token, _getVkBootDelayMs(), _previewW, _previewH, _cameraReadyAt || 0, this.data.rois);
    session.start(function (err) {
      if (token !== _ocrSessionToken) {
        try { session.stop(); } catch (eStale) { }
        try { session.destroy && session.destroy(); } catch (eDestroyStale) { }
        return;
      }
      if (err) {
        var msg = (err.errMsg || '').toLowerCase();
        // 过滤 SDK 内部底层报错（saaa_config / node js），不暴露给用户
        var isSdkInternal = msg.indexOf('node js') !== -1 || msg.indexOf('saaa') !== -1;
        clearOcrWsRestartGuard('boot-start-fail');
        self._stopOcrSession();
        self._restoreCameraPreview(function () {
          self.setData({ ocrEnabled: false, ocrTransitioning: false }, function () {
            self._commitLocalState();
            self._flushPendingWsStartAfterOcr();
          });
        });
        if (!isSdkInternal) {
          wx.showToast({ title: 'OCR 启动失败', icon: 'none' });
        }
        console.error('[Collector] VKSession start fail', err);
        return;
      }
      self.setData({ ocrEnabled: true, ocrTransitioning: false }, function () {
        self._commitLocalState();
        self._flushPendingWsStartAfterOcr();
      });
      _ocrSessionBootAt = Date.now();
      self._startOcrHealthTimer();
      console.log('[Collector] VKSession started (manual ROI OCR mode)');
      _ocrManualMode = true;
      self._startOcrFramePump(session, token);

      session.on('updateAnchors', function (a) {
        if (_vkSession !== session) return;
        if (_ocrManualMode) {
          self._onOcrRunResult(a);
        } else {
          self._handleOcrAnchors(Array.isArray(a) ? a : []);
        }
      });
    });
  },

  _onOcrRunResult: function (anchors) {
    _ocrAnchorEventCount += 1;
    var list = Array.isArray(anchors) ? anchors : [];
    if (this.data.debugMode && _ocrAnchorLogSeq < 12) {
      var sample = list.length ? summarizeAnchorForLog(list[0]) : null;
      console.log('[Collector][OCR] event=updateAnchors seq=%s count=%s sample=%o', _ocrAnchorEventCount, list.length, sample);
      _ocrAnchorLogSeq += 1;
    } else if (this.data.debugMode && _ocrAnchorEventCount % 60 === 0) {
      console.log('[Collector][OCR] event=updateAnchors seq=%s count=%s', _ocrAnchorEventCount, list.length);
    }

    // 单路通道按发送顺序回调：队首即本次回调对应的物理请求。
    var req = _ocrReqQueue.shift();
    if (!req) {
      // 无在途请求：多余/迟到的回调，丢弃且不动任何状态。
      return;
    }
    if (req.abandoned) {
      // 超时已放弃的请求迟到回来：仅丢弃，逻辑状态机早已推进。
      return;
    }
    var state = req.state;
    if (!state) return;

    if (state.generation != null && state.generation !== _ocrSessionGeneration) {
      console.warn(
        '[OCR] stale callback ignored gen=%s cur=%s type=%s',
        state.generation,
        _ocrSessionGeneration,
        state.type || ''
      );
      this._finishManualOcrRun(true, state);
      return;
    }

    if (state.type === 'time' && req.captureTs && req.captureTs !== _activeTimeOcrCaptureTs) {
      this._finishManualOcrRun(true, state);
      return;
    }

    // Check which lock to clear if this finishes
    var isTime = state.type === 'time';
    var isScore = state.type === 'score';

    // 清理本次真实的超时定时器
    if (state.timeoutId) {
      clearTimeout(state.timeoutId);
      state.timeoutId = 0;
    } else if (_ocrRunTimeout) {
      clearTimeout(_ocrRunTimeout);
      _ocrRunTimeout = 0;
    }

    var roiIdx = state.currentIdx;
    var text = collectAnchorTexts(list).join(' ').trim();
    if (this.data.debugMode) {
      console.log('[Collector][OCR] roi result idx=%s label=%s text=%s anchors=%s sample=%o', roiIdx, this.data.rois[roiIdx] && this.data.rois[roiIdx].label, text, list.length, list.length ? summarizeAnchorForLog(list[0]) : null);
    }
    _ocrStats.success += 1;
    _ocrConsecutiveTimeout = 0;
    _ocrSdkDegradedUntil = 0;
    OCR_MIN_INTERVAL_MS = OCR_MIN_INTERVAL_BASE_MS;
    if (_ocrV5Diag) _ocrV5Diag.ocrRunOk += 1;
    if (_ocrRunState && _ocrRunState.triggerMode === 'v5') {
      logOcrV5Diag('ocr_ok', {
        roiIdx: roiIdx,
        text: text,
        costMs: Date.now() - (_ocrRunStartedAt || Date.now())
      });
    }
    if (this._shouldRetryCurrentVariant(roiIdx, text)) {
      this._advanceCurrentVariantOrQueue('invalid-text', state);
      return;
    }
    _ocrRoiTextSeq[roiIdx] = (_ocrRoiTextSeq[roiIdx] || 0) + 1;
    var nowTs = Date.now();
    var parsedOkForBaseline = false;
    if (roiIdx === 0) {
      var parsedHomeScore = parseScore(text, 0);
      var isHomeScoreBootstrap = _ocrLastHomeScoreSuccessTs <= 0;
      if (
        parsedHomeScore !== null &&
        !isLikelyZeroScoreDrop(0, parsedHomeScore) &&
        !(isHomeScoreBootstrap && parsedHomeScore === 0)
      ) {
        if (confirmScoreSample(0, parsedHomeScore)) {
          _ocrScoreBootstrapRejectStreak[0] = 0;
          _ocrLastHomeScoreSuccessTs = nowTs;
          _ocrV5LastHomeOcrTs = nowTs;
          _ocrLastGoodHomeScore = parsedHomeScore;
          noteOcrScoreSuccess();
          if (Math.abs(parsedHomeScore - (_lastCommittedFrame ? _lastCommittedFrame.homeScore : 0)) >= OCR_SCORE_JUMP_CONFIRM_THRESHOLD) {
            // 大跳变：不信任当前读数，主动把 heartbeat ts 设为 0 触发快速复核
            _ocrV5LastHomeOcrTs = 0;
          }
          parsedOkForBaseline = true;
        } else {
          logOcrV5Diag('score_pending_confirm', { roiIdx: 0, value: parsedHomeScore });
        }
      } else if (isHomeScoreBootstrap && parsedHomeScore === 0) {
        noteScoreBootstrapReject(0, nowTs);
      }
    } else if (roiIdx === 1) {
      var parsedAwayScore = parseScore(text, 1);
      var isAwayScoreBootstrap = _ocrLastAwayScoreSuccessTs <= 0;
      if (
        parsedAwayScore !== null &&
        !isLikelyZeroScoreDrop(1, parsedAwayScore) &&
        !(isAwayScoreBootstrap && parsedAwayScore === 0)
      ) {
        if (confirmScoreSample(1, parsedAwayScore)) {
          _ocrScoreBootstrapRejectStreak[1] = 0;
          _ocrLastAwayScoreSuccessTs = nowTs;
          _ocrV5LastAwayOcrTs = nowTs;
          _ocrLastGoodAwayScore = parsedAwayScore;
          noteOcrScoreSuccess();
          if (Math.abs(parsedAwayScore - (_lastCommittedFrame ? _lastCommittedFrame.awayScore : 0)) >= OCR_SCORE_JUMP_CONFIRM_THRESHOLD) {
            // 大跳变：不信任当前读数，主动把 heartbeat ts 设为 0 触发快速复核
            _ocrV5LastAwayOcrTs = 0;
          }
          parsedOkForBaseline = true;
        } else {
          logOcrV5Diag('score_pending_confirm', { roiIdx: 1, value: parsedAwayScore });
        }
      } else if (isAwayScoreBootstrap && parsedAwayScore === 0) {
        noteScoreBootstrapReject(1, nowTs);
      }
    } else if (roiIdx === 2) {
      var refSec = getClockRefSec();
      var parsedTime = resolveGameClockParse(text, refSec);
      if (_ocrOcclusionActive && !parsedTime) {
        parsedTime = resolveGameClockParse(text, -1);
      }
      if (parsedTime) {
        var parsedClockSec = clockToTotalSec(parsedTime);
        var captureTs = (state && state.captureTs) || nowTs;
        if (_ocrOcclusionActive) {
          // 遮挡期：只有「与遮挡前快照连续」的样本才被接受为恢复候选并刷新时间新鲜度，
          // 误读样本一律忽略，避免污染恢复时钟、避免画面来回跳。
          var accepted = this._recordOcrClockSampleDuringOcclusion(parsedTime, captureTs);
          if (accepted) {
            _ocrV5LastTimeOcrOkTs = nowTs;
            noteOcrTimeSuccess(parsedTime);
            parsedOkForBaseline = true;
          }
        } else {
          _ocrLastTimeSuccessTs = nowTs;
          _ocrV5LastTimeOcrOkTs = nowTs;
          _ocrLastGoodClockSec = parsedClockSec;
          noteOcrTimeSuccess(parsedTime);
          parsedOkForBaseline = true;
          this._recordOcrClockSample(parsedTime, captureTs);
        }
        console.log(
          "[OCR][TIME] success",
          {
            roiIdx: roiIdx,
            costMs: Date.now() - (state.captureTs || nowTs),
            generation: state.generation,
            clockText: text,
            occluded: _ocrOcclusionActive ? 1 : 0
          }
        );
      }
    }
    if (parsedOkForBaseline && _ocrFramePumpMode === 'v5' && !_ocrFilterFallback) {
      this._requestOcrBaselineUpdate([roiIdx]);
    }
    
    // Safety check: ensure rawTexts array exists
    if (!state.rawTexts) {
      state.rawTexts = ['', '', ''];
    }
    state.updatedRoiIdx = roiIdx;
    if (roiIdx === 2 || parsedOkForBaseline) {
      state.rawTexts[roiIdx] = text;
    }
    if (!_ocrOcclusionActive) {
      this._applyPartialOcrPreview(state.rawTexts, roiIdx);
    }
    if (parsedOkForBaseline && (roiIdx === 0 || roiIdx === 1) && state.rawTexts) {
      var notifyRois = this.data.rois.map(function (roi, idx) {
        return Object.assign({}, roi, { rawText: state.rawTexts[idx] || '' });
      });
      this._parseAndMaybeNotify(notifyRois, roiIdx);
    }

    if (state.queue) {
      state.queuePos += 1;
    }
    this._maybeEvaluateOcrOcclusion(nowTs);
    if (_ocrOcclusionActive) {
      this._pinOcclusionHoldUi();
    }
    this._runNextRoiOcr(state);
  },

  /**
   * 遮挡期间时间 OCR 成功：只更新锚点与 best 时钟，供恢复判定；不走 processOcrFrame 发包。
   * @param {{ minutes: number, seconds: number }} parsedTime
   * @param {number} frameCaptureTs
   * @returns {void}
   */
  _recordOcrClockSampleDuringOcclusion: function (parsedTime, frameCaptureTs) {
    if (!parsedTime) return false;
    var refSec = getClockRefSec();
    parsedTime = sanitizeGameClockParse(parsedTime, refSec);
    if (!parsedTime) return false;
    var ocrSec = clockToTotalSec(parsedTime);
    var now = Date.now();

    // 遮挡期严禁触动预测时钟/UI：单帧时间（很可能是误读）一旦写入会让画面来回跳。
    // 仅在「与遮挡前的快照保持连续」时才接受为恢复候选，否则丢弃，待恢复时统一对齐。
    var refForOcclusion = _ocrOcclusionBestClockSec >= 0
      ? _ocrOcclusionBestClockSec
      : (_ocrLastGoodClockSec >= 0 ? _ocrLastGoodClockSec : -1);
    if (_occlusionHoldClockSec >= 0 && Math.abs(_occlusionHoldClockSec - ocrSec) > 1) {
      logOcrV5Diag('occlusion_time_sample_reject', {
        ocrSec: ocrSec,
        holdSec: _occlusionHoldClockSec
      });
      return false;
    }
    if (refForOcclusion >= 0) {
      var delta = refForOcclusion - ocrSec;
      var continuous = _ocrOcclusionWasRunning
        ? (delta >= -1 && delta <= 1)
        : (Math.abs(delta) <= OCR_CLOCK_CATCHUP_MAX_DROP_SEC);
      if (!continuous) {
        logOcrV5Diag('occlusion_time_sample_reject', { ocrSec: ocrSec, ref: refForOcclusion });
        return false;
      }
    }
    _ocrLastGoodClockSec = ocrSec;
    _ocrOcclusionBestClockSec = ocrSec;
    if (ocrSec === _ocrOcclusionBestStableSec) {
      _ocrOcclusionBestStableStreak += 1;
    } else {
      _ocrOcclusionBestStableSec = ocrSec;
      _ocrOcclusionBestStableStreak = 1;
    }
    if (_ocrOcclusionBestStableStreak >= 2) {
      _ocrLastTimeSuccessTs = now;
    }
    logOcrV5Diag('occlusion_time_sample', {
      ocrSec: ocrSec,
      captureLagMs: now - (frameCaptureTs || now)
    });
    return true;
  },

  /**
   * OCR 时间样本入口：流水线补偿、预测补秒、processOcrFrame 阀门。
   * @param {{ minutes: number, seconds: number }} parsedTime
   * @param {number} frameCaptureTs
   * @returns {void}
   */
  /**
   * 将比赛时钟一次性对齐到 OCR 读数并按走表推进（恢复/重启窗口专用，不追赶）。
   * @param {number} ocrSec OCR 读到的比赛时钟总秒数
   * @param {number} now 当前墙钟
   * @param {boolean} [isPeriodReset] 是否为节间复位（0:xx→10:00），自动进下一节
   * @returns {void}
   */
  _snapClockToOcr: function (ocrSec, now, isPeriodReset) {
    if (ocrSec < 0) return;
    var prevSec = _lastOcrClockSec;
    _lastOcrClockSec = ocrSec;
    _lastOcrClockWallTs = now;
    _ocrClockRunAnchorWallTs = now;
    _ocrClockRunAnchorOcrSec = ocrSec;
    updatePredictedClock(clockFromTotalSec(ocrSec));
    _clockAnchorMs = ocrSec * 1000;
    _clockAnchorWallTs = now;
    _driftSoftAdjustRate = 1.0;
    _lastClockPredictEmitSec = ocrSec;
    // ✅ BUG-4 修复：只在模式/状态真正需要变化时写入，避免 108 次 same→same snap 审计噪声。
    if (_clockMode !== 'running' || _procState.pauseConfirmed) {
      auditBeforeClockMode('running', isPeriodReset ? 'period_reset' : 'snap', '_snapClockToOcr');
      _clockMode = 'running';
      _procState.pauseConfirmed = false;
    }
    if (!_procState.clockRunning) {
      auditBeforeClockRunning(true, isPeriodReset ? 'period_reset' : 'snap', '_snapClockToOcr');
      _procState.clockRunning = true;
    }
    _procState.lastOcrSec = ocrSec;
    _procState.syncObserve = null;
    _clockPredictUntil = Math.max(_clockPredictUntil || 0, getClockRunUntil(now, ocrSec));
    syncClockStateFromMode();
    this._ensureClockPredictTimer();
    this._maybeApplyFinalMinuteMode(clockFromTotalSec(ocrSec));

    var homeScore = _lastCommittedFrame ? _lastCommittedFrame.homeScore : this.data.homeScore;
    var awayScore = _lastCommittedFrame ? _lastCommittedFrame.awayScore : this.data.awayScore;
    var period = this.data.period;
    if (isPeriodReset && period < 8) {
      period += 1;
      this.setData({ period: period });
      logOcrV5Diag('period_auto_advance', { period: period, ocrSec: ocrSec });
    }
    var clk = clockFromTotalSec(ocrSec);
    setAuditClockSource(
      isPeriodReset ? 'ocr' : (isOcrRecoverySnapActive(now) ? 'ocr_recovery' : 'ocr'),
      isPeriodReset ? 'period_reset' : 'snap',
      '_snapClockToOcr'
    );
    this._commitLocalState({
      homeScore: homeScore,
      awayScore: awayScore,
      period: period,
      minutes: clk.minutes,
      seconds: clk.seconds,
      shotClock: this.data.shotClock
    });
    _procState.lastOcrSec = ocrSec;
    _procState.syncObserve = null;
    _procState.sameSecStreak = 0;
    _procState.sameSecFirstSeen = now;
    if (isPeriodReset) {
      this._emitWsPacket('PERIOD', {
        t: ocrSec,
        a: homeScore,
        b: awayScore,
        p: period
      });
    }
    if (prevSec !== ocrSec || isPeriodReset) {
      this._emitWsPacket('SYNC', {
        t: ocrSec,
        a: homeScore,
        b: awayScore,
        p: period
      });
      this._emitWsPacket('START', {
        t: ocrSec,
        a: homeScore,
        b: awayScore,
        p: period
      });
      logOcrV5Diag('clock_snap_to_ocr', {
        ocrSec: ocrSec,
        prevSec: prevSec,
        periodReset: !!isPeriodReset
      });
    }
  },

  _recordOcrClockSample: function (parsedTime, frameCaptureTs) {
    if (!parsedTime || _ocrOcclusionActive) return;
    var refSec = getClockRefSec();
    var parsedRaw = parsedTime;
    parsedTime = sanitizeGameClockParse(parsedTime, refSec);
    if (
      !parsedTime &&
      parsedRaw &&
      parsedRaw.minutes >= 1 &&
      refSec >= OCR_CLOCK_SUBMINUTE_RECOVERY_MIN_REF_SEC &&
      refSec < 60
    ) {
      parsedTime = sanitizeGameClockParse(parsedRaw, -1);
      if (parsedTime) {
        logOcrV5Diag('clock_subminute_recovery_record', {
          refSec: refSec,
          ocrSec: clockToTotalSec(parsedTime)
        });
      }
    }
    if (!parsedTime) return;
    var now = Date.now();
    var ocrSec = clockToTotalSec(parsedTime);

    // 恢复/重启对齐窗口：每秒都有 OCR，直接信任本次读数并一次性对齐，不做逐秒追赶。
    // ✅ BUG-1 修复：恢复窗口内仍须经过 sanitizeGameClockParse 防护，拒绝正向跳变与大幅误读。
    // 历史教训：9:58 恢复期内 OCR 误读 4:30，因绕过防护直接 snap 导致 328s 向后跳变（云端直播全员看到）。
    if (isOcrRecoverySnapActive(now)) {
      var recoveryRefSec = _lastOcrClockSec >= 0 ? _lastOcrClockSec : getClockRefSec();
      var recoveryValidated = sanitizeGameClockParse(parsedTime, recoveryRefSec);
      if (!recoveryValidated) {
        // 恢复窗口内 OCR 读数不合法（如相对参考向前跳、进攻时钟误读）：降级为普通采样流程
        logOcrV5Diag('recovery_snap_rejected', {
          ocrSec: ocrSec,
          refSec: recoveryRefSec,
          reason: 'sanitize_fail'
        });
      } else {
        var recoveryOcrSec = clockToTotalSec(recoveryValidated);
        // 额外保护：恢复窗口内禁止超过 OCR_CLOCK_CATCHUP_MAX_DROP_SEC 的大向后跳变
        // （正向跳变已由 sanitizeGameClockParse 的 isSuspiciousGameClockForward 拒绝）
        if (recoveryRefSec >= 0 && recoveryRefSec - recoveryOcrSec > OCR_CLOCK_CATCHUP_MAX_DROP_SEC) {
          logOcrV5Diag('recovery_snap_rejected', {
            ocrSec: recoveryOcrSec,
            refSec: recoveryRefSec,
            reason: 'large_backward_jump'
          });
        } else {
          setAuditClockSource('ocr_recovery', 'recovery_window', '_recordOcrClockSample');
          this._snapClockToOcr(recoveryOcrSec, now);
          return;
        }
      }
    }

    var periodReset = isLikelyPeriodClockReset(refSec, ocrSec);
    if (periodReset) {
      console.log('[Collector][OCR] period clock reset detected ref=%s ocr=%s', refSec, ocrSec);
      _isFinalMinuteMode = false;
      TIME_PUMP_INTERVAL = TIME_PUMP_INTERVAL_BASE_MS;
      OCR_CLOCK_PREDICT_TICK_MS = OCR_CLOCK_PREDICT_TICK_BASE_MS;
      // ✅ 新增：节间复位时清空旧参考，允许直接跳到新节时间
      _lastOcrClockSec = -1;
      _procState.lastOcrSec = -1;
      _procState.syncObserve = null;
      setAuditClockSource('ocr', 'period_reset', '_recordOcrClockSample');
      this._snapClockToOcr(ocrSec, now, true);
      return;
    }
    var captureTs = Number(frameCaptureTs) || now;
    var pipelineDelaySec = Math.min(
      OCR_CLOCK_PREDICT_MAX_LEAD_SEC,
      Math.round(Math.max(0, now - captureTs) / 1000)
    );
    var compensatePipelineDelay =
      pipelineDelaySec > 0 &&
      (_clockMode === 'running' || (_lastOcrClockSec >= 0 && ocrSec < _lastOcrClockSec));
    var realWorldSec = Math.max(0, ocrSec - (compensatePipelineDelay ? pipelineDelaySec : 0));
    var resumeDropSec = _lastOcrClockSec >= 0 && realWorldSec > 0 && realWorldSec < _lastOcrClockSec
      ? (_lastOcrClockSec - realWorldSec)
      : 0;
    var pauseResumeSnap = _clockMode === 'paused' &&
      resumeDropSec >= OCR_PAUSE_RESUME_SNAP_MIN_SEC &&
      resumeDropSec <= OCR_CLOCK_CATCHUP_MAX_DROP_SEC;
    var shouldWakePausedClock = false;

    if (_clockMode === 'paused') {
      var hasResumeFlow = resumeDropSec > 0 && resumeDropSec <= OCR_CLOCK_CATCHUP_MAX_DROP_SEC;
      if (hasResumeFlow) {
        if (!_clockResumeCandidateSince || now - _clockResumeCandidateSince > OCR_CLOCK_RESUME_CONFIRM_MS * 2) {
          _clockResumeCandidateStreak = 1;
        } else {
          _clockResumeCandidateStreak += 1;
        }
        _clockResumeCandidateSec = realWorldSec;
        _clockResumeCandidateSince = now;
      } else if (
        _clockResumeCandidateStreak > 0 &&
        _clockResumeCandidateSince &&
        now - _clockResumeCandidateSince <= OCR_CLOCK_RESUME_CONFIRM_MS
      ) {
        _clockResumeCandidateStreak += 1;
      } else {
        _clockResumeCandidateSec = -1;
        _clockResumeCandidateSince = 0;
        _clockResumeCandidateStreak = 0;
      }
      shouldWakePausedClock = pauseResumeSnap ||
        _clockResumeCandidateStreak >= OCR_START_CONFIRM_STREAK;
    } else {
      _clockResumeCandidateSec = -1;
      _clockResumeCandidateSince = 0;
      _clockResumeCandidateStreak = 0;
    }

    if (pauseResumeSnap) {
      auditBeforeClockMode('running', 'resume_detect', '_recordOcrClockSample');
      _clockMode = 'running';
      _procState.pauseConfirmed = false;
      auditBeforeClockRunning(true, 'resume_detect', '_recordOcrClockSample');
      _procState.clockRunning = true;
      logOcrV5Diag('pause_resume_snap', {
        dropSec: resumeDropSec,
        ocrSec: realWorldSec,
        prevSec: _lastOcrClockSec
      });
    }

    if (_lastOcrClockSec >= 0 && realWorldSec > 0 && realWorldSec < _lastOcrClockSec) {
      var dropFromLast = _lastOcrClockSec - realWorldSec;
      if (
        dropFromLast >= 1 &&
        dropFromLast <= 3 &&
        !_procState.pauseConfirmed &&
        _clockMode !== 'paused'
        // ✅ BUG-3 修复：只在非 running 时才写 clockMode（auditBeforeClockMode 内部已去重，
        //    但赋值本身也应避免，以减少 resume_detect 在 processOcrFrame 的重复审计触发）。
      ) {
        if (_clockMode !== 'running') {
          auditBeforeClockMode('running', 'drop_recover', '_recordOcrClockSample');
          _clockMode = 'running';
        }
      }
    }

    if (now - (_ocrLastTimeSuccessTs || 0) > 2500) {
      var prevOcrClockSec = _lastOcrClockSec;
      _lastOcrClockSec = realWorldSec;
      if (
        (prevOcrClockSec < 0 || realWorldSec < prevOcrClockSec) &&
        !_procState.pauseConfirmed &&
        _clockMode !== 'paused' &&
        _clockMode !== 'running' // ✅ BUG-3 修复：已经是 running 则跳过
      ) {
        auditBeforeClockMode('running', 'starvation_recover', '_recordOcrClockSample');
        _clockMode = 'running';
      }
      _ocrClockRunAnchorWallTs = now;
      _ocrClockRunAnchorOcrSec = realWorldSec;
    }
    _ocrLastTimeSuccessTs = now;

    if (!periodReset && !pauseResumeSnap) {
      var capRefSec = _lastOcrClockSec >= 0 ? _lastOcrClockSec : getPublishedClockSecAt(now);
      if (capRefSec >= 0) {
        realWorldSec = capSyncClockStep(capRefSec, realWorldSec);
      }
    }

    var realClock = clockFromTotalSec(realWorldSec);
    _lastOcrClockSec = realWorldSec;
    _lastOcrClockWallTs = now;
    if (_clockMode !== 'paused' && !_ocrOcclusionActive) {
      updatePredictedClock(realClock);
      _clockAnchorMs = realWorldSec * 1000;
      _clockAnchorWallTs = now;
      _driftSoftAdjustRate = 1.0;
      _lastClockPredictEmitSec = realWorldSec;
      this._maybeApplyFinalMinuteMode(realClock);
    }

    if (_clockMode !== 'paused') {
      _clockPredictUntil = Math.max(_clockPredictUntil || 0, getClockRunUntil(now, realWorldSec));
      this._ensureClockPredictTimer();
    }

    syncClockStateFromMode();

    var homeScore = _lastCommittedFrame ? _lastCommittedFrame.homeScore : this.data.homeScore;
    var awayScore = _lastCommittedFrame ? _lastCommittedFrame.awayScore : this.data.awayScore;
    setAuditClockSource(
      pauseResumeSnap ? 'ocr' : 'ocr',
      pauseResumeSnap ? 'resume_snap' : 'sample',
      '_recordOcrClockSample'
    );
    this.processOcrFrame({
      homeScore: homeScore,
      awayScore: awayScore,
      minutes: realClock.minutes,
      seconds: realClock.seconds,
      timeValid: true,
      wallMs: now,
      resumeSnap: pauseResumeSnap
    });

    if (shouldWakePausedClock && !_procState.clockRunning) {
      console.log('[Collector][OCR] watchdog self-heal: valid clock flow recovered, force immediate sync');
      auditBeforeClockMode('running', 'watchdog_heal', '_recordOcrClockSample');
      _clockMode = 'running';
      _procState.pauseConfirmed = false;
      auditBeforeClockRunning(true, 'watchdog_heal', '_recordOcrClockSample');
      _procState.clockRunning = true;
      _clockResumeCandidateSec = -1;
      _clockResumeCandidateSince = 0;
      _clockResumeCandidateStreak = 0;
      syncClockStateFromMode();
      _clockPredictUntil = Math.max(_clockPredictUntil || 0, getClockRunUntil(now, realWorldSec));
      this._ensureClockPredictTimer();
      this._forcePushImmediateSync();
    }

    var publishedSecNow = getPublishedClockSecAt(now);
    if (
      _procState.clockRunning &&
      publishedSecNow >= 0 &&
      !_ocrOcclusionActive &&
      Math.abs(realWorldSec - publishedSecNow) >= OCR_SOFT_SYNC_DRIFT_SEC &&
      now - (_lastSoftSyncWallTs || 0) >= OCR_SOFT_SYNC_DEBOUNCE_MS
    ) {
      _lastSoftSyncWallTs = now;
      var softSyncT = capSyncClockStep(publishedSecNow, realWorldSec);
      this._emitWsPacket('SYNC', {
        t: softSyncT,
        a: homeScore,
        b: awayScore,
        p: this.data.period
      });
    }
  },

  /**
   * 评估遮挡：时间/主分/客分均长时间无法识别 → 停表、保留上次快照并通知直播端。
   * @param {number} [nowMs] 评估时刻墙钟
   * @returns {void}
   */
  _maybeEvaluateOcrOcclusion: function (nowMs) {
    if (!this.data.ocrEnabled) return;
    nowMs = nowMs || Date.now();
    if (_ocrOcclusionEvalLastTs && nowMs - _ocrOcclusionEvalLastTs < OCR_OCCLUSION_EVAL_MS) {
      return;
    }
    _ocrOcclusionEvalLastTs = nowMs;

    if (!_ocrOcclusionActive) {
      if (!hasOcrOcclusionBaseline()) return;
      if (areAllOcrFieldsFresh(nowMs)) return;
      if (!areAllOcrFieldsStale(nowMs)) return;
      this._enterOcrOcclusion(nowMs);
      return;
    }

    if (canClearOcrOcclusion(nowMs)) {
      _ocrOcclusionRecoverStreak += 1;
      var timeFresh = (nowMs - (_ocrLastTimeSuccessTs || 0)) <= OCR_OCCLUSION_FRESH_MS;
      var forceClear = !timeFresh && _ocrOcclusionSince > 0 &&
        (nowMs - _ocrOcclusionSince) >= OCR_OCCLUSION_FORCE_CLEAR_MS;
      var needStreak = forceClear ? 1 : (_ocrOcclusionWasRunning ? 2 : OCR_OCCLUSION_RECOVER_STREAK);
      if (_ocrOcclusionRecoverStreak >= needStreak) {
        _ocrOcclusionActive = false;
        _ocrOcclusionSince = 0;
        _ocrOcclusionRecoverStreak = 0;
        console.log('[Collector][OCR] occlusion cleared, resume processing force=%s', forceClear);
        logOcrV5Diag('occlusion_clear_eval', {
          streak: needStreak,
          force: forceClear,
          timeFresh: timeFresh
        });
        this._onOcrOcclusionCleared(nowMs, forceClear);
      }
    } else {
      _ocrOcclusionRecoverStreak = 0;
    }
    if (_ocrOcclusionActive) {
      this._pinOcclusionHoldUi();
    }
  },

  /**
   * 遮挡恢复：用遮挡期内缓存的最后一次可解析快照立即校准直播端，并在判断走表时补发 START。
   * @param {number} nowMs
   * @returns {void}
   */
  _onOcrOcclusionCleared: function (nowMs, forceClear) {
    console.log('[Collector][OCR] occlusion cleared, resume OCR pumps');
    _ocrScorePumpPauseUntil = 0;
    _ocrScorePumpQuiesceUntil = 0;
    _ocrScoreTimeoutStreak = 0;
    _ocrScoreCircuitTripCount = 0;
    _ocrSdkDegradedUntil = 0;
    _ocrTimeoutSettleUntil = 0;
    _ocrRunBusy = false;
    _ocrVkBusy = false;
    _timeOcrBusy = false;
    _scoreOcrBusy = false;
    _ocrTimeRunState = null;
    _ocrScoreRunState = null;
    _ocrReqQueue = [];
    _pendingTimeFrame = null;
    resetOcrV5PendingOnly();
    /** 恢复后数秒内禁止 predict/OCR 的「逐秒追赶」，只允许一次性对齐
     *  ✅ BUG-2 修复：由 8000ms 缩短至 3500ms。
     *  原因：8s 窗口内每一帧 OCR 都走 _snapClockToOcr，产生大量正/负向±1s 闪跳（audit 记录到
     *  每分钟 ~28 次 clock_oscillation）；3.5s 足够首帧对齐，后续帧回归正常采样路径。 */
    _ocrRecoveryModeUntil = nowMs + 3500;

    var homeScore = _ocrLastGoodHomeScore >= 0
      ? _ocrLastGoodHomeScore
      : (Number(this.data.homeScore) || 0);
    var awayScore = _ocrLastGoodAwayScore >= 0
      ? _ocrLastGoodAwayScore
      : (Number(this.data.awayScore) || 0);
    var holdSec = _lastCommittedFrame
      ? ocrFrameClockSec(_lastCommittedFrame)
      : clockToTotalSec({ minutes: this.data.minutes, seconds: this.data.seconds });
    var clockSec = computeOcclusionResumeClockSec(nowMs);
    if (clockSec < 0 &&
      _ocrLastGoodClockSec >= 0 &&
      holdSec >= 0 &&
      Math.abs(_ocrLastGoodClockSec - holdSec) <= 30) {
      clockSec = _ocrLastGoodClockSec;
    }
    if (clockSec < 0 && _lastCommittedFrame) {
      clockSec = ocrFrameClockSec(_lastCommittedFrame);
    }
    if (clockSec < 0) {
      logOcrV5Diag('occlusion_clear_skip', { reason: 'no_clock_ref' });
      return;
    }

    logOcrV5Diag('occlusion_cleared', {
      home: homeScore,
      away: awayScore,
      clockSec: clockSec,
      holdSec: holdSec,
      bestSec: _ocrOcclusionBestClockSec,
      force: !!forceClear
    });

    var looksRunning = _ocrOcclusionWasRunning;
    _lastOcrClockSec = clockSec;
    _lastOcrClockWallTs = nowMs;
    updatePredictedClock(clockFromTotalSec(clockSec));
    _clockAnchorMs = clockSec * 1000;
    _clockAnchorWallTs = nowMs;
    _driftSoftAdjustRate = 1.0;
    _lastClockPredictEmitSec = clockSec;
    _lastClockPredictEmitWallTs = nowMs;
    _procState.lastOcrSec = clockSec;
    _ocrLastTimeSuccessTs = nowMs;
    _ocrLastHomeScoreSuccessTs = nowMs;
    _ocrLastAwayScoreSuccessTs = nowMs;
    if (_ocrOcclusionWasRunning || looksRunning) {
      auditBeforeClockMode('running', 'occlusion_clear', '_onOcrOcclusionCleared');
      _clockMode = 'running';
      _procState.pauseConfirmed = false;
      auditBeforeClockRunning(true, 'occlusion_clear', '_onOcrOcclusionCleared');
      _procState.clockRunning = true;
      _clockPredictUntil = getClockRunUntil(nowMs, clockSec);
      this._ensureClockPredictTimer();
    } else {
      auditBeforeClockMode('paused', 'occlusion_clear', '_onOcrOcclusionCleared');
      _clockMode = 'paused';
      _procState.pauseConfirmed = true;
      this._clearClockPredictTimer();
    }
    syncClockStateFromMode();

    var snap = {
      homeScore: homeScore,
      awayScore: awayScore,
      period: this.data.period,
      minutes: Math.floor(clockSec / 60),
      seconds: clockSec % 60,
      shotClock: this.data.shotClock
    };
    _lastPreviewFrameKey = '';
    setAuditClockSource('ocr_recovery', 'occlusion_clear', '_onOcrOcclusionCleared');
    this._commitLocalState(snap);
    this._emitTimeOnlyIfChanged(clockFromTotalSec(clockSec), nowMs, true);
    logOcrV5Diag('occlusion_resume_direct', { clockSec: clockSec, holdSec: holdSec });
    this.processOcrFrame({
      homeScore: homeScore,
      awayScore: awayScore,
      minutes: snap.minutes,
      seconds: snap.seconds,
      timeValid: true,
      wallMs: nowMs,
      resumeSnap: false
    });
    this._emitWsPacket('SYNC', {
      t: clockSec,
      a: homeScore,
      b: awayScore,
      p: this.data.period
    });
    if (looksRunning) {
      this._emitWsPacket('START', {
        t: clockSec,
        a: homeScore,
        b: awayScore,
        p: this.data.period
      });
    }
    _ocrOcclusionWasRunning = false;
    _ocrOcclusionBestClockSec = -1;
    _ocrOcclusionBestStableSec = -1;
    _ocrOcclusionBestStableStreak = 0;
    _occlusionHoldClockSec = -1;
    resetOcrScorePumpCircuit();          // 清除比分泵熔断/quiesce
    _ocrSdkDegradedUntil = 0;           // 清除 SDK 降载
    _procState.lastOcrSec = -1;         // 允许第一帧 OCR 直接作为新基线
    _procState.syncObserve = null;
    resetOcrV5PendingOnly();
    this._syncOcrFilterRois(false);
  },

  /**
   * 进入遮挡静默：不发包改分/改时，保留上次正确 UI，并向云端 STOP。
   * @param {number} nowMs
   * @returns {void}
   */
  _enterOcrOcclusion: function (nowMs) {
    if (_ocrOcclusionActive) return;
    _ocrOcclusionActive = true;
    _ocrOcclusionSince = nowMs;
    _ocrOcclusionWasRunning = _procState.clockRunning || _clockMode === 'running';
    _ocrOcclusionBestClockSec = _ocrLastGoodClockSec >= 0
      ? _ocrLastGoodClockSec
      : (_lastOcrClockSec >= 0 ? _lastOcrClockSec : -1);
    _occlusionHoldClockSec = _lastCommittedFrame
      ? ocrFrameClockSec(_lastCommittedFrame)
      : clockToTotalSec({ minutes: this.data.minutes, seconds: this.data.seconds });
    if (_occlusionHoldClockSec < 0) _occlusionHoldClockSec = -1;
    _ocrOcclusionBestStableSec = -1;
    _ocrOcclusionBestStableStreak = 0;
    _ocrOcclusionRecoverStreak = 0;
    _procState.startObserve = null;
    _procState.syncObserve = null;
    resetOcrV5PendingOnly();
    this._clearClockPredictTimer();
    if (_occlusionHoldClockSec >= 0) {
      auditBeforeClockMode('paused', 'occlusion_enter', '_enterOcrOcclusion');
      _clockMode = 'paused';
      syncClockStateFromMode();
      updatePredictedClock(clockFromTotalSec(_occlusionHoldClockSec));
      _clockAnchorMs = _occlusionHoldClockSec * 1000;
      _clockAnchorWallTs = nowMs;
      _lastOcrClockSec = _occlusionHoldClockSec;
      _lastOcrClockWallTs = nowMs;
    }

    if (_lastCommittedFrame) {
      setAuditClockSource('occlusion', 'enter_hold', '_enterOcrOcclusion');
      this._commitLocalState({
        homeScore: _lastCommittedFrame.homeScore,
        awayScore: _lastCommittedFrame.awayScore,
        period: _lastCommittedFrame.period,
        minutes: _lastCommittedFrame.minutes,
        seconds: _lastCommittedFrame.seconds,
        shotClock: _lastCommittedFrame.shotClock
      });
    }

    if (_procState.clockRunning && _lastCommittedFrame) {
      this._emitWsPacket('STOP', {
        t: ocrFrameClockSec(_lastCommittedFrame),
        a: _lastCommittedFrame.homeScore,
        b: _lastCommittedFrame.awayScore,
        p: _lastCommittedFrame.period
      });
    }

    console.log(
      '[Collector][OCR] occlusion active hold t=%s a=%s b=%s',
      _lastCommittedFrame ? ocrFrameClockSec(_lastCommittedFrame) : 0,
      _lastCommittedFrame ? _lastCommittedFrame.homeScore : 0,
      _lastCommittedFrame ? _lastCommittedFrame.awayScore : 0
    );
    this._pinOcclusionHoldUi();
  },

  /**
   * 遮挡期将 UI 时间钉死在进入遮挡时的 hold 秒数（抵御任意 stray setData）。
   * @returns {void}
   */
  _pinOcclusionHoldUi: function () {
    if (!_ocrOcclusionActive || _occlusionHoldClockSec < 0) return;
    var clk = clockFromTotalSec(_occlusionHoldClockSec);
    if (this.data.minutes === clk.minutes && this.data.seconds === clk.seconds) return;
    COLLECTOR_AUDIT.auditClockSource({
      source: 'occlusion_hold',
      reason: 'pin_ui',
      functionName: '_pinOcclusionHoldUi',
      prev: {
        m: this.data.minutes,
        s: this.data.seconds,
        totalSec: clockToTotalSec({ minutes: this.data.minutes, seconds: this.data.seconds })
      },
      next: { m: clk.minutes, s: clk.seconds, totalSec: _occlusionHoldClockSec }
    });
    if (_lastCommittedFrame) {
      _lastCommittedFrame.minutes = clk.minutes;
      _lastCommittedFrame.seconds = clk.seconds;
      _lastCommittedFrameKey = buildFrameKey(_lastCommittedFrame);
    }
    this.setData({ minutes: clk.minutes, seconds: clk.seconds });
  },

  _ensureClockPredictTimer: function () {
    if (_clockPredictTimer) return;
    var self = this;
    _clockPredictTimer = setInterval(function () {
      self._onClockPredictTick();
    }, OCR_CLOCK_PREDICT_TICK_MS);
  },

  _clearClockPredictTimer: function () {
    if (_clockPredictTimer) {
      clearInterval(_clockPredictTimer);
      _clockPredictTimer = 0;
    }
    _clockPredictUntil = 0;
    _lastClockPredictEmitWallTs = 0;
    _lastClockPredictEmitSec = -1;
  },

  /**
   * 最后一分钟极限调度：minutes===0 && seconds<=60 时压榨 TIME_PUMP_INTERVAL=80、
   * OCR_CLOCK_PREDICT_TICK_MS=100，提升 SS.m 显示阶段的识别率与补秒颗粒度；
   * 离开最后一分钟立即恢复基准值并重启预测定时器。
   * @param {{ minutes: number, seconds: number } | null} clock 真实绝对时钟
   * @returns {void}
   */
  _maybeApplyFinalMinuteMode: function (clock) {
    if (!clock) return;
    var minutes = Number(clock.minutes) || 0;
    var seconds = Number(clock.seconds) || 0;
    var inFinal = (minutes === 0 && seconds <= 60);
    if (inFinal === _isFinalMinuteMode) return;
    _isFinalMinuteMode = inFinal;
    if (inFinal) {
      TIME_PUMP_INTERVAL = TIME_PUMP_INTERVAL_FINAL_MS;
      OCR_CLOCK_PREDICT_TICK_MS = OCR_CLOCK_PREDICT_TICK_FINAL_MS;
    } else {
      TIME_PUMP_INTERVAL = TIME_PUMP_INTERVAL_BASE_MS;
      OCR_CLOCK_PREDICT_TICK_MS = OCR_CLOCK_PREDICT_TICK_BASE_MS;
    }
    console.log('[Collector][OCR] final-minute mode=%s timePump=%s predictTick=%s', inFinal, TIME_PUMP_INTERVAL, OCR_CLOCK_PREDICT_TICK_MS);
    // 重启预测定时器以应用新的间隔（setInterval 创建时已固定原间隔）
    if (_clockPredictTimer) {
      clearInterval(_clockPredictTimer);
      _clockPredictTimer = 0;
      this._ensureClockPredictTimer();
    }
  },

  _onClockPredictTick: function () {
    if (!this.data.ocrEnabled || !_lastCommittedFrame) {
      this._clearClockPredictTimer();
      return;
    }
    var now = Date.now();

    syncClockStateFromMode();
    if (_clockMode !== 'running' && !_procState.clockRunning) {
      this._clearClockPredictTimer();
      return;
    }

    var predicted = getPredictedClock();
    if (!predicted) return;

    var committedSec = ocrFrameClockSec(_lastCommittedFrame);
    if (committedSec <= 0) return;
    var predictedSec = clockToTotalSec(predicted);
    if (isOcrRecoverySnapActive(now)) {
      if (predictedSec !== committedSec) {
        this._emitTimeOnlyIfChanged(predicted, now, true);
      }
      return;
    }
    if (predictedSec >= committedSec) return;
    var lag = committedSec - predictedSec;
    var minEmitMs = lag > 2 ? OCR_CLOCK_CATCHUP_FAST_INTERVAL_MS : OCR_CLOCK_NORMAL_INTERVAL_MS;
    if (_lastClockPredictEmitWallTs && now - _lastClockPredictEmitWallTs < minEmitMs) return;
    var emitSec = lag <= 2
      ? predictedSec
      : Math.max(predictedSec, committedSec - 1);
    if (_lastOcrClockSec >= 0) {
      var minAllowedSec = Math.max(0, _lastOcrClockSec - OCR_CLOCK_PREDICT_MAX_LEAD_SEC);
      if (emitSec < minAllowedSec) emitSec = minAllowedSec;
    }
    if (emitSec === _lastClockPredictEmitSec) return;
    this._emitTimeOnlyIfChanged(clockFromTotalSec(emitSec), now);
  },

  /**
   * 初始化 V5 OCR Filter Worker。
   * @returns {void}
   */
  _initOcrFilterWorker: function () {
    var self = this;
    if (_ocrFilterFallback || _ocrFilterWorker) return;
    if (typeof wx === 'undefined' || typeof wx.createWorker !== 'function') {
      _ocrFilterFallback = true;
      logOcrV5Diag('fallback_legacy', { reason: 'createWorker_unavailable' });
      console.warn('[Collector][OCR-V5] createWorker unavailable, fallback legacy');
      return;
    }
    try {
      _ocrFilterWorker = wx.createWorker('workers/ocr-filter.js');
    } catch (eCreate) {
      _ocrFilterFallback = true;
      logOcrV5Diag('fallback_legacy', { reason: 'worker_create_fail', err: String(eCreate) });
      console.warn('[Collector][OCR-V5] worker create fail, fallback legacy', eCreate);
      return;
    }
    _ocrFilterWorkerReady = false;
    _ocrFilterPostMode = 'transfer';
    _ocrFilterWorker.onMessage(function (msg) {
      self._handleOcrFilterMessage(msg);
    });
    _ocrFilterWorker.onProcessKilled(function () {
      console.warn('[Collector][OCR-V5] worker killed, fallback legacy');
      if (_ocrV5Diag) _ocrV5Diag.switchToLegacy += 1;
      logOcrV5Diag('fallback_legacy', { reason: 'worker_killed' });
      _ocrFilterWorker = null;
      _ocrFilterWorkerReady = false;
      _ocrFilterFallback = true;
      resetOcrV5TriggerState();
      if (_vkSession && _ocrManualMode && self.data.ocrEnabled) {
        self._cancelOcrFramePump();
        setTimeout(function () {
          if (_vkSession && _ocrManualMode && self.data.ocrEnabled) {
            self._startOcrFramePumpLegacy(_vkSession, _ocrSessionToken);
          }
        }, 0);
      }
    });
    this._syncOcrFilterRois(true);
  },

  /**
   * 销毁 V5 OCR Filter Worker。
   * @returns {void}
   */
  _destroyOcrFilterWorker: function () {
    resetOcrV5TriggerState();
    _ocrFilterWorkerReady = false;
    _ocrFilterPostMode = 'transfer';
    if (_ocrFilterWorker) {
      try { _ocrFilterWorker.terminate(); } catch (eTerm) { }
      _ocrFilterWorker = null;
    }
  },

  /**
   * 同步 ROI 配置到 Worker。
   * @param {boolean} [isInit] 是否为初始化
   * @returns {void}
   */
  _syncOcrFilterRois: function (isInit) {
    if (!_ocrFilterWorker || _ocrFilterFallback) return;
    var rois = (this.data.rois || []).map(function (r) {
      return { x: r.x, y: r.y, w: r.w, h: r.h };
    });
    try {
      _ocrFilterWorker.postMessage({
        type: isInit ? 'INIT' : 'UPDATE_ROIS',
        rois: rois
      });
    } catch (ePost) {
      console.warn('[Collector][OCR-V5] sync rois fail', ePost);
    }
  },

  /**
   * 处理 Worker 消息。
   * @param {{ type: string, changedRois?: number[], roiIndex?: number, seq?: number }} msg Worker 消息
   * @returns {void}
   */
  _handleOcrFilterMessage: function (msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'READY') {
      _ocrFilterWorkerReady = true;
      logOcrV5Diag('worker_ready', { roiCount: msg.roiCount, postMode: _ocrFilterPostMode });
      console.log('[Collector][OCR-V5] worker ready roiCount=%s postMode=%s', msg.roiCount, _ocrFilterPostMode);
      return;
    }
    if (msg.type === 'OCR_TRIGGER' && msg.changedRois && msg.changedRois.length) {
      if (_ocrV5Diag) _ocrV5Diag.workerTriggers += 1;
      mergeOcrV5Trigger(msg.changedRois);
      logOcrV5Diag('worker_trigger', { changedRois: msg.changedRois, seq: msg.seq });
      return;
    }
    if (msg.type === 'BASELINE_UPDATED') {
      if (_ocrV5Diag) _ocrV5Diag.baselineUpdated += 1;
      logOcrV5Diag('baseline_updated', { roiIndex: msg.roiIndex, seq: msg.seq });
    }
  },

  /**
   * OCR 失败后清除 Worker 对该 ROI 的 awaiting 状态（避免永久不再触发）。
   * @param {number[]} roiIndices ROI 索引列表
   * @returns {void}
   */
  _clearOcrFilterAwaitingBaseline: function (roiIndices) {
    if (!_ocrFilterWorker || _ocrFilterFallback || !roiIndices || !roiIndices.length) return;
    try {
      _ocrFilterWorker.postMessage({
        type: 'CLEAR_AWAITING',
        roiIndices: roiIndices
      });
    } catch (ePost) {
      logOcrV5Diag('clear_awaiting_fail', { err: String(ePost) });
    }
  },

  /**
   * OCR 成功后请求 Worker 更新 baseline（需连续稳定帧才替换）。
   * @param {number[]} roiIndices ROI 索引列表
   * @returns {void}
   */
  _requestOcrBaselineUpdate: function (roiIndices) {
    if (!_ocrFilterWorker || _ocrFilterFallback || !roiIndices || !roiIndices.length) return;
    if (_ocrV5Diag) _ocrV5Diag.baselineRequested += 1;
    logOcrV5Diag('baseline_request', { roiIndices: roiIndices });
    try {
      _ocrFilterWorker.postMessage({
        type: 'UPDATE_BASELINE',
        roiIndices: roiIndices
      });
    } catch (ePost) {
      logOcrV5Diag('baseline_request_fail', { err: String(ePost) });
      console.warn('[Collector][OCR-V5] baseline update fail', ePost);
    }
  },

  /**
   * V5 时间泵：轮询驱动，busy 时仅覆盖 pending 帧（不排队）。
   * @param {any} session VKSession
   * @param {number} token
   * @param {{ data: ArrayBuffer, width: number, height: number }} frame
   * @param {number} captureTs
   * @returns {boolean}
   */
  _maybeRunTimeOcrPoll: function (session, token, frame, captureTs) {
    maybeEmitOcrV5DiagSummary();
    if (token !== _ocrSessionToken || !frame || !frame.data) return false;
    var now = captureTs || Date.now();
    if (!_ocrOcclusionActive && now < _ocrTimeoutSettleUntil) {
      if (_ocrV5Diag) _ocrV5Diag.ocrSkippedSettle += 1;
      return false;
    }
    if (_timeMotionActive && (now - _timeMotionLastChangeTs > 1200)) {
      _timeMotionActive = false;
    }
    var timeDue = _ocrOcclusionActive
      ? (now - (_ocrLastTimeSuccessTs || 0)) >= TIME_OCR_RECOVERY_INTERVAL_MS
      : isTimeOcrDue(now);
    if (!timeDue) return false;
    if (now - _lastTimeOcrTriggerTs < MIN_TIME_TRIGGER_INTERVAL_MS) {
      if (_ocrVkBusy) stashPendingTimeFrame(frame.data, frame.width, frame.height, now);
      return false;
    }
    _lastTimeOcrTriggerTs = now;
    if (_ocrV5Diag) _ocrV5Diag.ocrTriggeredTimeTick += 1;
    logOcrV5Diag('ocr_trigger_time_poll', { msSinceTimeOcrOk: now - (_ocrLastTimeSuccessTs || 0) });
    this.runTimeOcr(session, token, frame.data, frame.width, frame.height, now);
    return true;
  },

  /**
   * V5 比分泵：Worker diff / heartbeat / bootstrap 事件驱动（与时间解耦）。
   * @param {any} session VKSession
   * @param {number} token
   * @param {{ data: ArrayBuffer, width: number, height: number }} frame
   * @param {number} captureTs
   * @returns {boolean}
   */
  _maybeRunScoreOcrV5: function (session, token, frame, captureTs) {
    if (token !== _ocrSessionToken || !frame || !frame.data) return false;
    if (_ocrOcclusionActive) return false;
    var now = captureTs || Date.now();
    if (now < _ocrTimeoutSettleUntil) return false;
    if (_ocrVkBusy || shouldDeferScoreOcr(now)) return false;

    var triggerRois = [];
    var triggerReason = '';
    if (_ocrPendingTrigger && _ocrPendingTrigger.changedRois && _ocrPendingTrigger.changedRois.length) {
      triggerRois = _ocrPendingTrigger.changedRois.slice();
      triggerReason = _ocrPendingTrigger.reason || 'pending';
    }
    if (_ocrFramePumpMode === 'v5' && _ocrTimeBaselineReady && !shouldDeferScoreOcr(now)) {
      if (_ocrV5LastHomeOcrTs === 0 && triggerRois.indexOf(0) < 0) triggerRois.push(0);
      if (_ocrV5LastAwayOcrTs === 0 && triggerRois.indexOf(1) < 0) triggerRois.push(1);
      if (_ocrV5LastHomeOcrTs === 0 || _ocrV5LastAwayOcrTs === 0) {
        triggerReason = 'score_bootstrap';
      } else {
        var homeScoreDue = now - (_ocrV5LastHomeOcrTs || 0) >= OCR_V5_SCORE_HEARTBEAT_MS;
        var awayScoreDue = now - (_ocrV5LastAwayOcrTs || 0) >= OCR_V5_SCORE_HEARTBEAT_MS;
        if (homeScoreDue && triggerRois.indexOf(0) < 0) triggerRois.push(0);
        if (awayScoreDue && triggerRois.indexOf(1) < 0) triggerRois.push(1);
        if (homeScoreDue || awayScoreDue) triggerReason = 'score_heartbeat';
      }
    }
    if (!triggerRois.length) return false;

    if (triggerReason === 'worker' && getPendingScoreAgeMs(now) < 180) {
      return false;
    }

    var bypassCooldown = _ocrOcclusionActive ||
      isTimeOcrStarved(now) ||
      triggerReason === 'score_heartbeat' ||
      triggerReason === 'score_bootstrap' ||
      triggerReason === 'worker' ||
      triggerReason === 'occlusion';
    if (now < _ocrV5GlobalCooldownUntil && !bypassCooldown) {
      if (_ocrV5Diag) _ocrV5Diag.ocrSkippedCooldown += 1;
      return false;
    }

    var roiIdx = pickTriggeredScoreRoi(triggerRois, now, triggerReason);
    if (roiIdx < 0) return false;

    var bypassRoiCooldown = bypassCooldown ||
      (triggerReason === 'score_heartbeat' ||
        triggerReason === 'score_bootstrap' ||
        triggerReason === 'worker' ||
        triggerReason === 'occlusion');
    if (isOcrV5RoiCooling(roiIdx, now) && !bypassRoiCooldown) {
      if (_ocrV5Diag) _ocrV5Diag.ocrSkippedCooldown += 1;
      return false;
    }

    var scoreAllowed = false;
    if (triggerReason === 'worker') {
      scoreAllowed = isScoreOcrAllowedForWorker(now);
    } else if (triggerReason === 'score_heartbeat' ||
      triggerReason === 'score_bootstrap' ||
      triggerReason === 'occlusion') {
      scoreAllowed = isScoreOcrAllowedForV5(now);
    } else {
      scoreAllowed = isScorePumpAllowed(now);
    }
    if (!scoreAllowed) {
      if (_ocrV5Diag) _ocrV5Diag.ocrSkippedScorePump += 1;
      return false;
    }

    triggerRois.splice(triggerRois.indexOf(roiIdx), 1);
    if (_ocrPendingTrigger && _ocrPendingTrigger.roiFirstSeen) {
      delete _ocrPendingTrigger.roiFirstSeen[roiIdx];
    }
    if (triggerRois.length) {
      var prevFirstSeen = (_ocrPendingTrigger && _ocrPendingTrigger.roiFirstSeen) || {};
      var saveReason = triggerReason;
      if (triggerReason === 'worker' ||
        (_ocrPendingTrigger && _ocrPendingTrigger.reason === 'worker')) {
        saveReason = 'worker';
      }
      _ocrPendingTrigger = {
        changedRois: triggerRois,
        reason: saveReason,
        ts: now,
        roiFirstSeen: prevFirstSeen
      };
    } else {
      _ocrPendingTrigger = null;
    }

    markOcrV5RoiCooldown(roiIdx, now);
    if (_ocrV5Diag) {
      if (triggerReason === 'worker') _ocrV5Diag.ocrTriggeredWorker += 1;
      else if (triggerReason === 'occlusion') _ocrV5Diag.ocrTriggeredOcclusion += 1;
      else if (triggerReason === 'score_heartbeat') _ocrV5Diag.ocrTriggeredScoreHeartbeat += 1;
      else if (triggerReason === 'score_bootstrap') _ocrV5Diag.ocrTriggeredScoreBootstrap += 1;
    }
    logOcrV5Diag('ocr_trigger_score', {
      roiIdx: roiIdx,
      reason: triggerReason,
      pendingRois: triggerRois
    });
    this.runScoreOcr(session, token, frame.data, frame.width, frame.height, now, roiIdx);
    return true;
  },

  /**
   * V5：对指定 ROI 执行精准 OCR（单 ROI、单并发）。
   * @param {any} session VKSession
   * @param {number} token 会话 token
   * @param {ArrayBuffer} rgbaBuffer 帧 buffer
   * @param {number} frameW 帧宽
   * @param {number} frameH 帧高
   * @param {number} captureTs 捕获墙钟
   * @param {number} roiIdx ROI 索引
   * @returns {void}
   */
  // Phase 5: runTimeOcr & runScoreOcr
  runTimeOcr: function (session, token, rgbaBuffer, frameW, frameH, captureTs) {
    if (token !== _ocrSessionToken) return;
    if (!rgbaBuffer || !rgbaBuffer.byteLength) return;
    if (_ocrVkBusy) {
      stashPendingTimeFrame(rgbaBuffer, frameW, frameH, captureTs);
      return;
    }

    var fullFrameRgba = new Uint8Array(rgbaBuffer);
    var timeVariants = cropRgbaCandidatesByRoi(
      fullFrameRgba, frameW, frameH, this.data.rois[2]
    );

    _ocrVkBusy = true;
    _ocrRunBusy = true;
    _timeOcrBusy = true;
    _activeTimeOcrCaptureTs = captureTs;
    _ocrTimeRunState = {
      type: 'time',
      triggerMode: 'v5',
      session: session,
      token: token,
      generation: _ocrSessionGeneration,
      currentIdx: 2,
      currentVariants: timeVariants,
      currentVariantPos: 0,
      captureTs: captureTs
    };

    this._runCurrentVariant(_ocrTimeRunState);
  },

  runScoreOcr: function (session, token, rgbaBuffer, frameW, frameH, captureTs, roiIdx) {
    if (token !== _ocrSessionToken) return;
    if (!rgbaBuffer || !rgbaBuffer.byteLength) return;
    var nowGuard = Date.now();
    if (_ocrVkBusy || shouldDeferScoreOcr(nowGuard)) {
      mergeScorePendingRois([roiIdx], 'worker', captureTs);
      return;
    }

    var fullFrameRgba = new Uint8Array(rgbaBuffer);
    var scoreVariants = cropRgbaCandidatesByRoi(
      fullFrameRgba, frameW, frameH, this.data.rois[roiIdx]
    );

    _ocrVkBusy = true;
    _ocrRunBusy = true;
    _scoreOcrBusy = true;
    _ocrScoreRunState = {
      type: 'score',
      triggerMode: 'v5',
      session: session,
      token: token,
      generation: _ocrSessionGeneration,
      currentIdx: roiIdx,
      currentVariants: scoreVariants,
      currentVariantPos: 0,
      captureTs: captureTs
    };

    this._runCurrentVariant(_ocrScoreRunState);
  },


  /**
   * 将主/客分 ROI 小图发给 Worker（禁止整帧；copy 模式也只拷贝 patch）。
   * @param {{ data: ArrayBuffer, width: number, height: number }} frame 相机帧
   * @param {number} seq 帧序号
   * @returns {void}
   */
  _postScorePatchesToOcrFilterWorker: function (frame, seq) {
    if (!_ocrFilterWorker || _ocrFilterFallback || !_ocrFilterWorkerReady) {
      if (_ocrV5Diag) _ocrV5Diag.framesSkippedNotReady += 1;
      return;
    }
    if (!frame || !frame.data || !frame.data.byteLength) {
      if (_ocrV5Diag) _ocrV5Diag.framesSkippedEmpty += 1;
      return;
    }
    if (!shouldPostScorePatchesToWorker(Date.now())) {
      if (_ocrV5Diag) _ocrV5Diag.framesSkippedNotReady += 1;
      return;
    }
    if (seq % OCR_V5_FRAME_SKIP !== 0) {
      if (_ocrV5Diag) _ocrV5Diag.framesSkippedCopyThrottle += 1;
      return;
    }

    var self = this;
    var rgba = new Uint8Array(frame.data);
    var patches = packScoreRoiPatchesForWorker(
      rgba, frame.width, frame.height, this.data.rois
    );
    if (!patches.length) {
      if (_ocrV5Diag) _ocrV5Diag.framesSkippedEmpty += 1;
      return;
    }

    var payload = { type: 'FRAME_PATCHES', patches: patches, seq: seq };

    try {
      for (var ci = 0; ci < patches.length; ci++) {
        var patch = patches[ci];
        var pool = ensureOcrFrameBuffer(patch.buffer.byteLength);
        pool.set(new Uint8Array(patch.buffer));
        patch.buffer = pool.buffer;
      }
      _ocrFilterWorker.postMessage(payload);
      if (_ocrV5Diag) {
        _ocrV5Diag.postCopyOk += 1;
        _ocrV5Diag.framesPosted += 1;
      }
    } catch (ePost) {
      var errMsg = (ePost && ePost.message) ? ePost.message : String(ePost);
      if (_ocrV5Diag) _ocrV5Diag.postFail += 1;
      logOcrV5Diag('post_fail_fatal', { err: errMsg, mode: _ocrFilterPostMode });
      console.warn('[Collector][OCR-V5] post patches fatal, fallback legacy', ePost);
      _ocrFilterFallback = true;
      if (_ocrV5Diag) _ocrV5Diag.switchToLegacy += 1;
      _ocrFilterWorkerReady = false;
      resetOcrV5TriggerState();
    }
  },

  /**
   * 启动 OCR 帧泵：优先 V5 Worker 驱动，失败则 fallback legacy 双泵。
   * @param {any} session VKSession
   * @param {number} token 会话 token
   * @returns {void}
   */
  _startOcrFramePump: function (session, token) {
    this._initOcrFilterWorker();
    if (!_ocrFilterFallback && _ocrFilterWorker) {
      this._startOcrFramePumpV5(session, token);
      return;
    }
    this._startOcrFramePumpLegacy(session, token);
  },

  /**
   * V5 帧泵：Transferable 传 Worker + 异动驱动精准 OCR。
   * @param {any} session VKSession
   * @param {number} token 会话 token
   * @returns {void}
   */
  _startOcrFramePumpV5: function (session, token) {
    var self = this;
    this._cancelOcrFramePump();
    _ocrPumpFrameCount = 0;
    _ocrPumpLastTickTs = 0;
    _ocrFramePumpMode = 'v5';
    _ocrFilterPostMode = 'copy';
    resetOcrV5TriggerState();
    resetOcrV5Diag('v5');
    var bootNow = Date.now();
    if (!_ocrLastHomeScoreSuccessTs) _ocrLastHomeScoreSuccessTs = bootNow;
    if (!_ocrLastAwayScoreSuccessTs) _ocrLastAwayScoreSuccessTs = bootNow;
    if (!_cameraContext || typeof _cameraContext.onCameraFrame !== 'function') {
      logOcrV5Diag('fallback_legacy', { reason: 'onCameraFrame_unavailable' });
      console.error('[Collector][OCR-V5] onCameraFrame unavailable, fallback legacy');
      _ocrFilterFallback = true;
      this._startOcrFramePumpLegacy(session, token);
      return;
    }
    logOcrV5Diag('pump_start', {
      worker: !!_ocrFilterWorker,
      workerReady: _ocrFilterWorkerReady,
      postMode: _ocrFilterPostMode
    });
    console.log('[Collector][OCR-V5] frame pump start worker=%s ready=%s postMode=%s',
      !!_ocrFilterWorker, _ocrFilterWorkerReady, _ocrFilterPostMode);
    try {
      _cameraFrameListener = _cameraContext.onCameraFrame(function (frame) {
        if (Date.now() < (self._zoomBlurGuardedUntil || 0)) return;
        if (_vkSession !== session || token !== _ocrSessionToken) return;
        _ocrPumpFrameCount += 1;
        if (_ocrV5Diag) _ocrV5Diag.framesIn += 1;
        var frameW = frame && frame.width ? frame.width : 0;
        var frameH = frame && frame.height ? frame.height : 0;
        if (_ocrPumpFrameCount <= 3 || _ocrPumpFrameCount % 300 === 0) {
          console.log('[Collector][OCR-V5] pump seq=%s byteLen=%s size=%sx%s busy=%s postMode=%s',
            _ocrPumpFrameCount,
            frame && frame.data ? frame.data.byteLength : 0,
            frameW,
            frameH,
            _ocrRunBusy,
            _ocrFilterPostMode
          );
        }
        if (!frame || !frame.data || frame.data.byteLength === 0 || frameW <= 0 || frameH <= 0) {
          if (_ocrV5Diag) _ocrV5Diag.framesSkippedEmpty += 1;
          return;
        }

        var captureTs = Date.now();
        self._maybeEvaluateOcrOcclusion(captureTs);

        self._maybeRunTimeOcrPoll(session, token, frame, captureTs);
        self._maybeRunScoreOcrV5(session, token, frame, captureTs);

        if (_ocrFilterFallback) {
          logOcrV5Diag('fallback_legacy_runtime', { seq: _ocrPumpFrameCount });
          setTimeout(function () {
            if (_vkSession === session && token === _ocrSessionToken) {
              self._startOcrFramePumpLegacy(session, token);
            }
          }, 0);
          return;
        }

        self._postScorePatchesToOcrFilterWorker(frame, _ocrPumpFrameCount);
      });
      _cameraFrameListener.start();
      setTimeout(function () {
        if (_ocrFramePumpMode === 'v5' && _ocrV5Diag) {
          _ocrV5Diag.lastSummaryTs = 0;
          maybeEmitOcrV5DiagSummary();
        }
      }, 15000);
      if (_ocrForceSyncAfterPump || _ocrWsReconnectPendingAfterRestart || isOcrWsRestartGuardActive()) {
        setTimeout(function () {
          self._onOcrFramePumpReadyAfterRestart();
        }, 0);
      }
    } catch (eStart) {
      console.error('[Collector][OCR-V5] onCameraFrame start fail, fallback legacy', eStart);
      _ocrFilterFallback = true;
      this._startOcrFramePumpLegacy(session, token);
    }
  },

  /**
   * Legacy 双频双泵（Worker 不可用时的 fallback）：
   *   - 时间泵（高频 TIME_PUMP_INTERVAL）：仅取时间 ROI，最新帧入引擎，历史帧丢弃。
   *   - 比分泵（低频 SCORE_PUMP_INTERVAL）：主/客 ROI 轮询，让出运行通道给时间泵。
   *
   * 单条 VK runOCR 通道由 _ocrRunBusy 互斥；时间泵优先，比分泵在空闲且未到时间泵周期时执行。
   * @param {any} session
   * @param {number} token
   * @returns {void}
   */
  _startOcrFramePumpLegacy: function (session, token) {
    var self = this;
    this._cancelOcrFramePump();
    _ocrPumpFrameCount = 0;
    _ocrPumpLastTickTs = 0;
    _lastTimePumpTs = 0;
    _lastScorePumpTs = 0;
    _ocrFramePumpMode = 'legacy';
    resetOcrV5Diag('legacy');
    logOcrV5Diag('pump_start_legacy', { timePump: TIME_PUMP_INTERVAL, scorePump: SCORE_PUMP_INTERVAL });
    if (!_cameraContext || typeof _cameraContext.onCameraFrame !== 'function') {
      console.error('[Collector][OCR] onCameraFrame unavailable');
      return;
    }
    console.log('[Collector][OCR] dual-pump start time=%s score=%s', TIME_PUMP_INTERVAL, SCORE_PUMP_INTERVAL);
    try {
      _cameraFrameListener = _cameraContext.onCameraFrame(function (frame) {
        if (Date.now() < (self._zoomBlurGuardedUntil || 0)) {
          return;
        }
        if (_vkSession !== session || token !== _ocrSessionToken) return;
        _ocrPumpFrameCount += 1;
        var frameW = frame && frame.width ? frame.width : 0;
        var frameH = frame && frame.height ? frame.height : 0;
        if (_ocrPumpFrameCount <= 3 || _ocrPumpFrameCount % 300 === 0) {
          console.log('[Collector][OCR] pump seq=%s frame=%s size=%sx%s', _ocrPumpFrameCount, !!(frame && frame.data), frameW, frameH);
        }
        if (!frame || !frame.data || frameW <= 0 || frameH <= 0) return;
        var captureTs = Date.now();
        self._maybeEvaluateOcrOcclusion(captureTs);
        // SDK 节流闸：上一次 OCR 超时后给 SDK OCR_TIMEOUT_SETTLE_MS 缓冲；
        // 否则连续超时会让 SDK 内部队列雪崩。
        if (captureTs < _ocrTimeoutSettleUntil) return;

        var timePumpGap = 0;
        if (_clockState === CLOCK_STATE_RUNNING) timePumpGap = TIME_OCR_RUNNING_INTERVAL_MS;
        else if (_clockState === CLOCK_STATE_STOPPED) timePumpGap = TIME_OCR_STOPPED_INTERVAL_MS;
        else timePumpGap = TIME_OCR_RECOVERY_INTERVAL_MS;

        if (_ocrVkBusy) {
          if (captureTs - _lastTimePumpTs >= timePumpGap) {
            stashPendingTimeFrame(frame.data, frameW, frameH, captureTs);
          }
          return;
        }

        if (_ocrOcclusionActive) {
          if (captureTs - _lastTimePumpTs >= timePumpGap) {
            _lastTimePumpTs = captureTs;
            _ocrPumpLastTickTs = captureTs;
            self.runTimeOcr(session, token, frame.data, frameW, frameH, captureTs);
          }
          return;
        }

        var nextScoreIdx = (_scorePumpCursor % 2 === 0) ? 0 : 1;
        var scorePumpAllowed = isScorePumpAllowed(captureTs);
        var scoreRoiBackoff = captureTs < (_ocrRoiBackoffUntil[nextScoreIdx] || 0);

        if (!scorePumpAllowed) {
          if (captureTs - _lastTimePumpTs >= timePumpGap) {
            _lastTimePumpTs = captureTs;
            _ocrPumpLastTickTs = captureTs;
            self.runTimeOcr(session, token, frame.data, frameW, frameH, captureTs);
          }
          return;
        }

        if (
          scorePumpAllowed &&
          captureTs - _lastScorePumpTs >= SCORE_PUMP_INTERVAL &&
          !scoreRoiBackoff
        ) {
          _lastScorePumpTs = captureTs;
          _ocrPumpLastTickTs = captureTs;
          self.runScoreOcr(session, token, frame.data, frameW, frameH, captureTs, nextScoreIdx);
          _scorePumpCursor += 1;
        }

        if (captureTs - _lastTimePumpTs >= timePumpGap) {
          _lastTimePumpTs = captureTs;
          _ocrPumpLastTickTs = captureTs;
          self.runTimeOcr(session, token, frame.data, frameW, frameH, captureTs);
        }
      });
      _cameraFrameListener.start();
      if (_ocrForceSyncAfterPump || _ocrWsReconnectPendingAfterRestart || isOcrWsRestartGuardActive()) {
        setTimeout(function () {
          self._onOcrFramePumpReadyAfterRestart();
        }, 0);
      }
    } catch (eStart) {
      console.error('[Collector][OCR] onCameraFrame start fail', eStart);
    }
  },

  _onOcrFramePumpReadyAfterRestart: function () {
    var guardReason = _ocrWsRestartGuardReason || 'ocr-restart';
    var shouldForceSync = !!(_ocrForceSyncAfterPump || isOcrWsRestartGuardActive());
    var self = this;

    if (_socketTask && this.data.wsState === 'connected') {
      startCollectorHeartbeat();
      startCollectorWatchdog(function () { return self; });
      if (shouldForceSync) {
        var pushed = this._forcePushImmediateSync();
        logCollectorWs('ocr_restart_force_sync', {
          reason: guardReason,
          pushed: pushed ? 1 : 0
        });
      }
      _ocrWsReconnectPendingAfterRestart = false;
      clearOcrWsRestartGuard('pump-ready');
      return;
    }

    clearOcrWsRestartGuard('pump-ready-missing-socket');

    if (!_wsManualClose && _wsRoomId && !_wsConnecting && !_socketTask && !_ocrWsImmediateReconnectUsed) {
      _ocrWsImmediateReconnectUsed = true;
      _ocrWsReconnectPendingAfterRestart = false;
      this.setData({ wsState: 'reconnecting', wsStateText: 'OCR 已恢复，立即重连…' });
      this._scheduleWsReconnect({
        immediateOnce: true,
        reason: 'ocr_restart_socket_missing'
      });
    }
  },

  _cancelOcrFramePump: function () {
    if (_cameraFrameListener) {
      try { _cameraFrameListener.stop(); } catch (eStop) { }
      _cameraFrameListener = null;
    }
    _ocrPumpFrameCount = 0;
    _ocrPumpLastTickTs = 0;
    _lastTimePumpTs = 0;
    _lastScorePumpTs = 0;
    _ocrFramePumpMode = '';
  },

  /**
   * 时间引擎：仅扫描时间 ROI（idx=2），单 variant，超时则放弃整轮（不重试 variant）。
   *
   * 注意超时窗口（OCR_TIME_RUN_TIMEOUT_MS = 1500ms）是 SDK 真实处理时间的上界，
   * 而不是"想要的延迟"。SDK 在双泵高频提交场景下单次往往要 500-1200ms；
   * 若设得更短就会被强行打断、释放 busy、立刻补刀提交下一次，导致 SDK 内部队列
   * 雪崩并把整条 OCR 链路拖死。
   *
   * 真实"低延迟"由状态机的 captureTs 流水线补偿（realWorldSec = ocrSec - lostSec）
   * 与 _onClockPredictTick 预测时钟共同保证：采集端本地 UI 展示当前真实时间，而不是
   * OCR 落地时已经过时的样本。
   * @param {any} session
   * @param {number} token
   * @param {ArrayBuffer} rgbaBuffer
   * @param {number} frameW
   * @param {number} frameH
   * @param {number} captureTs 帧捕获时墙钟，用于流水线补偿
   * @returns {void}
   */
  _runTimeOcrEngine: function (session, token, rgbaBuffer, frameW, frameH, captureTs) {
    if (token !== _ocrSessionToken) return;
    if (!rgbaBuffer || !rgbaBuffer.byteLength) return;
    if (typeof session.runOCR !== 'function') {
      console.error('[Collector][OCR] session.runOCR unavailable');
      return;
    }
    var now = Date.now();
    var fullFrameRgba = new Uint8Array(rgbaBuffer);
    var timeVariants = cropRgbaCandidatesByRoi(
      fullFrameRgba,
      frameW,
      frameH,
      this.data.rois[2]
    );
    _ocrRunLastTs = now;
    _ocrRunBusy = true;
    _ocrBusySince = now;
    _ocrRunStartedAt = now;
    _ocrRunState = {
      type: 'time',
      session: session,
      token: token,
      rawTexts: this.data.rois.map(function (roi) { return roi.rawText || ''; }),
      queue: [2],
      queuePos: 0,
      currentIdx: 2,
      currentVariants: timeVariants,
      currentVariantPos: 0,
      captureTs: captureTs
    };
    if (this.data.debugMode) {
      console.log('[Collector][OCR] time engine start frame=%sx%s captureTs=%s', frameW, frameH, captureTs);
    }
    this._runNextRoiOcr();
  },

  /**
   * 比分引擎：在主队分(idx=0)与客队分(idx=1)间 round-robin，单帧只跑一个 ROI。
   * 比分泵周期较低（800ms），把 VK runOCR 通道大部分时间留给时间引擎。
   * @param {any} session
   * @param {number} token
   * @param {ArrayBuffer} rgbaBuffer
   * @param {number} frameW
   * @param {number} frameH
   * @param {number} captureTs
   * @returns {void}
   */
  _runScoreOcrEngine: function (session, token, rgbaBuffer, frameW, frameH, captureTs) {
    if (token !== _ocrSessionToken) return;
    var nowGuard = Date.now();
    if (!isScorePumpAllowed(nowGuard) || isTimeOcrStarved(nowGuard)) {
      return;
    }
    if (!rgbaBuffer || !rgbaBuffer.byteLength) return;
    if (typeof session.runOCR !== 'function') {
      console.error('[Collector][OCR] session.runOCR unavailable');
      return;
    }
    var idx = (_scorePumpCursor % 2 === 0) ? 0 : 1;
    _scorePumpCursor += 1;
    var now = Date.now();
    var fullFrameRgba = new Uint8Array(rgbaBuffer);
    var scoreVariants = cropRgbaCandidatesByRoi(
      fullFrameRgba,
      frameW,
      frameH,
      this.data.rois[idx]
    );
    _ocrRunLastTs = now;
    _ocrRunBusy = true;
    _ocrBusySince = now;
    _ocrRunStartedAt = now;
    _ocrRunState = {
      type: 'score',
      session: session,
      token: token,
      rawTexts: this.data.rois.map(function (roi) { return roi.rawText || ''; }),
      queue: [idx],
      queuePos: 0,
      currentIdx: idx,
      currentVariants: scoreVariants,
      currentVariantPos: 0,
      captureTs: captureTs
    };
    if (this.data.debugMode) {
      console.log('[Collector][OCR] score engine start idx=%s frame=%sx%s', idx, frameW, frameH);
    }
    this._runNextRoiOcr();
  },

  _runNextRoiOcr: function (stateObj) {
    var state = stateObj || _ocrRunState;
    if (!state) return;
    var isLegacyBusy = !stateObj && !_ocrRunBusy;
    if (isLegacyBusy) return;
    
    if (state.token !== _ocrSessionToken || _vkSession !== state.session) {
      this._finishManualOcrRun(true, state);
      return;
    }
    if (!state.queue || state.queuePos >= state.queue.length) {
      this._finishManualOcrRun(false, state);
      return;
    }

    state.currentIdx = state.queue[state.queuePos];
    if (!state.currentVariants || !state.currentVariants.length) {
      console.warn('[Collector][OCR] crop empty idx=%s roi=%o', state.currentIdx, this.data.rois[state.currentIdx]);
      state.queuePos += 1;
      this._runNextRoiOcr(state);
      return;
    }
    this._runCurrentVariant(state);
  },

  _runCurrentVariant: function (stateObj) {
    var self = this;
    var state = stateObj || _ocrRunState;
    if (!state) return;
    
    var isLegacyBusy = !stateObj && !_ocrRunBusy;
    var isTimeBusy = state.type === 'time' && !_timeOcrBusy;
    var isScoreBusy = state.type === 'score' && !_scoreOcrBusy;
    if (!stateObj && !_ocrRunBusy) return; // For legacy logic safety
    
    var roi = this.data.rois[state.currentIdx];
    var crop = state.currentVariants[state.currentVariantPos];
    if (!crop) {
      console.warn('[Collector][OCR] crop empty idx=%s roi=%o', state.currentIdx, roi);
      this._advanceCurrentVariantOrQueue('empty', state);
      return;
    }

    if (this.data.debugMode) {
      console.log('[Collector][OCR] runOCR idx=%s label=%s variant=%s/%s crop=%sx%s type=%s', state.currentIdx, roi.label, state.currentVariantPos + 1, state.currentVariants.length, crop.width, crop.height, state.type || 'legacy');
    }
    _ocrLastRoiRunTs[state.currentIdx] = Date.now();
    _ocrBusySince = _ocrLastRoiRunTs[state.currentIdx];
    
    var timeoutMs = (state.type === 'time') ? OCR_TIME_RUN_TIMEOUT_MS : OCR_RUN_TIMEOUT_MS;
    if (state.type === 'score' && isTimeOcrStarved(Date.now())) {
      timeoutMs = 750;
    }

    // 登记物理请求并捕获 reqId：超时只作废本请求，迟到回调按 FIFO 丢弃，杜绝错配
    var reqId = enqueueOcrReq(state, state.captureTs);

    // We store the timeoutId on the state
    state.timeoutId = setTimeout(function () {
      var logKind = state.type === 'time' ? 'time' : 'score';
      if (shouldLogOcrTimeoutWarn(logKind)) {
        console.warn('[Collector][OCR] runOCR timeout idx=%s label=%s crop=%sx%s type=%s', state.currentIdx, roi.label, crop.width, crop.height, state.type || 'legacy');
      }
      state.timeoutId = 0;
      abandonOcrReq(reqId);
      
      _ocrConsecutiveTimeout += 1;
      _ocrStats.timeout += 1;
      if (_ocrV5Diag) _ocrV5Diag.ocrRunTimeout += 1;
      if (state && state.triggerMode === 'v5') {
        logOcrV5Diag('ocr_timeout', {
          roiIdx: state.currentIdx,
          type: state.type || '',
          crop: crop ? (crop.width + 'x' + crop.height) : ''
        });
      }
      if (state.type === 'time') {
        markOcrSdkDegraded();
        _ocrTimeoutSettleUntil = Date.now() + getEffectiveOcrSettleMs(Date.now());
        self._recordManualOcrFailure('timeout-time');
        if (state.triggerMode === 'v5') {
          self._clearOcrFilterAwaitingBaseline([state.currentIdx]);
        }
        self._finishManualOcrRun(true, state);
        return;
      }
      markOcrSdkDegraded();
      _ocrRoiBackoffUntil[state.currentIdx] = Date.now() + 2500;
      _ocrRoiBackoffUntil[state.currentIdx === 0 ? 1 : 0] = Date.now() + 1200;
      if (state.triggerMode === 'v5') {
        _ocrRoiBackoffUntil[state.currentIdx] = Date.now() + 1500;
        self._clearOcrFilterAwaitingBaseline([state.currentIdx]);
      } else {
        noteOcrScoreTimeout();
      }
      if (_ocrConsecutiveTimeout >= 3) {
        OCR_MIN_INTERVAL_MS = 260;
      }
      var rawTexts = state.rawTexts || (stateObj ? null : _ocrRunState.rawTexts);
      if (rawTexts) {
        self._applyPartialOcrPreview(rawTexts, -1);
      }
      self._advanceCurrentVariantOrQueue('timeout', state);
    }, timeoutMs);

    try {
      state.session.runOCR({
        frameBuffer: crop.buffer,
        width: crop.width,
        height: crop.height
      });
    } catch (eRun) {
      if (state.timeoutId) {
        clearTimeout(state.timeoutId);
        state.timeoutId = 0;
      }
      abandonOcrReq(reqId);
      markOcrSdkDegraded();
      if (state.type === 'time') {
        _ocrTimeoutSettleUntil = Date.now() + getEffectiveOcrSettleMs(Date.now());
      }
      _ocrRoiBackoffUntil[state.currentIdx] = Date.now() + 1500;
      console.error('[Collector][OCR] runOCR fail idx=%s label=%s err=%o', state.currentIdx, roi.label, eRun);
      this._advanceCurrentVariantOrQueue('fail', state);
    }
  },

  _advanceCurrentVariantOrQueue: function (reason, stateObj) {
    var state = stateObj || _ocrRunState;
    if (!state) return;
    if (reason === 'timeout' || reason === 'fail') {
      this._recordManualOcrFailure(reason);
      if (state.type === 'score') {
        if (state.queue) state.queuePos = state.queue.length;
        this._runNextRoiOcr(state);
        return;
      }
    }
    if (state.currentVariants &&
      state.currentVariantPos + 1 < state.currentVariants.length &&
      state.currentVariantPos + 1 < getOcrMaxVariantsForRoi(state.currentIdx)) {
      state.currentVariantPos += 1;
      if (this.data.debugMode) {
        console.log('[Collector][OCR] retry variant idx=%s label=%s reason=%s next=%s/%s', state.currentIdx, this.data.rois[state.currentIdx] && this.data.rois[state.currentIdx].label, reason, state.currentVariantPos + 1, state.currentVariants.length);
      }
      this._runCurrentVariant(state);
      return;
    }
    if (state.queue) state.queuePos += 1;
    this._runNextRoiOcr(state);
  },

  _shouldRetryCurrentVariant: function (roiIdx, text) {
    var state = _ocrRunState;
    if (!state || !state.currentVariants || state.currentVariants.length <= 1) return false;
    if (roiIdx === 0 || roiIdx === 1) {
      var val = parseScore(text, roiIdx);
      if (val === null) return true;
      var ref = getScoreParseRef(roiIdx);
      if (ref >= 0) {
        if (Math.abs(val - ref) >= OCR_SCORE_JUMP_CONFIRM_THRESHOLD) return true;
        if (isLikelyTruncateGlitch(ref, val)) return true;
      }
      return false;
    }
    if (roiIdx === 2) {
      return parseTime(text) === null;
    }
    return false;
  },

  _finishManualOcrRun: function (aborted, stateObj) {
    var state = stateObj || _ocrRunState;
    if (state && state.timeoutId) {
      clearTimeout(state.timeoutId);
      state.timeoutId = 0;
    } else if (_ocrRunTimeout) {
      clearTimeout(_ocrRunTimeout);
      _ocrRunTimeout = 0;
    }
    if (state) {
      if (state.type === 'time') {
        _timeOcrBusy = false;
        if (_ocrTimeRunState && _ocrTimeRunState.token === state.token) _ocrTimeRunState = null;
      } else if (state.type === 'score') {
        _scoreOcrBusy = false;
        if (_ocrScoreRunState && _ocrScoreRunState.token === state.token) _ocrScoreRunState = null;
      }
    }
    _ocrVkBusy = false;
    _ocrRunBusy = false;
    _ocrBusySince = 0;
    _ocrRunState = null;
    if (!aborted) _ocrTimeoutSettleUntil = 0;

    var vkSession = _vkSession;
    var vkToken = _ocrSessionToken;
    if (!aborted && state && vkSession && vkToken === state.token && _pendingTimeFrame) {
      var pendingFrame = _pendingTimeFrame;
      _pendingTimeFrame = null;
      this.runTimeOcr(
        vkSession,
        vkToken,
        pendingFrame.data,
        pendingFrame.width,
        pendingFrame.height,
        pendingFrame.captureTs
      );
      return;
    }
    if (!state || aborted) return;
    _ocrManualFailTimestamps = [];
    var cost = Date.now() - (_ocrRunStartedAt || Date.now());
    _ocrStats.avgCost = _ocrStats.avgCost
      ? Math.round(_ocrStats.avgCost * 0.8 + cost * 0.2)
      : cost;
    if (this.data.debugMode) {
      console.log('[Collector][OCR] manual run done roiTexts=%o cost=%s', state.rawTexts, cost);
    }
    
    // Safety check for state.rawTexts before applying
    var safeRawTexts = state.rawTexts || ['', '', ''];
    this._applyOcrRoiTexts(safeRawTexts, typeof state.updatedRoiIdx === 'number' ? state.updatedRoiIdx : -1);
  },

  /**
   * 停止 OCR：先落库 UI，短延迟后销毁 VK；`ocrTransitioning` 在会话销毁后立即结束。
   * @param {boolean} [skipRemount] 为 true 时立即停会话（如 `onUnload`），避免与 `_disconnectWebSocket` 竞态。
   * @returns {void}
   */
  _stopOcr: function (skipRemount) {
    var self = this;
    var token = ++_ocrSessionToken;

    this._cancelOcrFramePump();
    if (_ocrRunTimeout) {
      clearTimeout(_ocrRunTimeout);
      _ocrRunTimeout = 0;
    }
    _ocrRunBusy = false;
    _ocrRunState = null;

    if (skipRemount) {
      if (_ocrBootTimer) {
        clearTimeout(_ocrBootTimer);
        _ocrBootTimer = 0;
      }
      this._stopOcrSession();
      this.setData({ ocrEnabled: false, ocrTransitioning: false }, function () {
        self._commitLocalState();
      });
      return;
    }

    this.setData(
      {
        ocrEnabled: false,
        ocrTransitioning: true
      },
      function () {
        var notifySnap = {
          homeScore: self.data.homeScore,
          awayScore: self.data.awayScore,
          period: self.data.period,
          minutes: self.data.minutes,
          seconds: self.data.seconds,
          shotClock: self.data.shotClock,
          ocrEnabled: false,
          ocrTransitioning: true
        };

        var runHeavy = function () {
          if (token !== _ocrSessionToken) return;
          if (_ocrBootTimer) {
            clearTimeout(_ocrBootTimer);
            _ocrBootTimer = 0;
          }
          self._stopOcrSession();
          var finSnap = {
            homeScore: self.data.homeScore,
            awayScore: self.data.awayScore,
            period: self.data.period,
            minutes: self.data.minutes,
            seconds: self.data.seconds,
            shotClock: self.data.shotClock,
            ocrEnabled: false,
            ocrTransitioning: false
          };
          self.setData({ ocrTransitioning: false }, function () {
            self._commitLocalState(finSnap);
          });
          setTimeout(function () {
            if (token !== _ocrSessionToken) return;
            self._remountCameraAfterOcrStop(function () {});
          }, 0);
        };

        var afterUiNotifyThenHeavy = function () {
          self._commitLocalState(notifySnap);
          setTimeout(runHeavy, 400);
        };

        try {
          if (typeof wx !== 'undefined' && typeof wx.nextTick === 'function') {
            wx.nextTick(afterUiNotifyThenHeavy);
          } else {
            setTimeout(afterUiNotifyThenHeavy, 0);
          }
        } catch (eNt) {
          setTimeout(afterUiNotifyThenHeavy, 0);
        }
      }
    );
  },

  _remountCameraAfterOcrStop: function (done) {
    var self = this;
    var delay = _getCameraRemountDelayMs();
    console.log('[Collector][OCR] remount camera after stop delay=%s', delay);
    if (_ocrCameraRemountTimer) {
      clearTimeout(_ocrCameraRemountTimer);
      _ocrCameraRemountTimer = 0;
    }
    _cameraContext = null;
    _cameraReadyAt = 0;
    var mountCamera = function () {
      _ocrCameraRemountTimer = setTimeout(function () {
        _ocrCameraRemountTimer = 0;
        self.setData({ cameraMounted: true }, function () {
          _cameraContext = wx.createCameraContext(self);
          _cameraReadyAt = Date.now();
          if (typeof done === 'function') done();
        });
      }, delay);
    };
    if (!this.data.cameraMounted) {
      mountCamera();
      return;
    }
    this.setData({ cameraMounted: false }, mountCamera);
  },

  _stopOcrSession: function (preserveClock) {
    _ocrSessionGeneration++;
    _ocrV5LastTimeOcrOkTs = Date.now();
    _ocrLastTimeSuccessTs = Date.now();
    this._clearOcrBootTimers();
    this._clearOcrHealthTimer();
    if (_ocrAnchorWatchdogTimer) {
      clearTimeout(_ocrAnchorWatchdogTimer);
      _ocrAnchorWatchdogTimer = 0;
    }
    if (_ocrRunTimeout) {
      clearTimeout(_ocrRunTimeout);
      _ocrRunTimeout = 0;
    }
    _ocrAnchorEventCount = 0;
    _ocrNativeTextEventCount = 0;
    _ocrAnchorLogSeq = 0;
    _ocrRunBusy = false;
    _ocrBusySince = 0;
    _ocrRunState = null;
    _ocrReqQueue = [];
    _ocrTimeRunState = null;
    _ocrScoreRunState = null;
    _activeTimeOcrCaptureTs = 0;
    _ocrRunLastTs = 0;
    _ocrRunStartedAt = 0;
    _ocrTimeoutSettleUntil = 0;
    _ocrQueueCursor = 0;
    _ocrTick = 0;
    _ocrManualMode = false;
    _ocrLastRoiRunTs = [0, 0, 0];
    _ocrRoiBackoffUntil = [0, 0, 0];
    _ocrRoiTextSeq = [0, 0, 0];
    resetOcrScorePumpCircuit();
    resetScorePumpDisabled();
    resetOcrTimeBaseline();
    resetOcrOcclusionState();
    _ocrSdkDegradedUntil = 0;
    if (!preserveClock) {
      _ocrLastTimeSuccessTs = 0;
      _predictedClock = null;
      _predictedClockWallTs = 0;
      auditBeforeClockMode('unknown', 'ocr_session_reset', '_stopOcrSession');
      _clockMode = 'unknown';
      _lastOcrClockSec = -1;
      _lastOcrClockWallTs = 0;
      _sameOcrClockSince = 0;
      _clockPauseCandidateUntil = 0;
      _clockResumeCandidateSec = -1;
      _clockResumeCandidateSince = 0;
      _clockResumeCandidateStreak = 0;
      _clockJumpCandidateSec = -1;
      _clockJumpCandidateSince = 0;
      this._clearClockPredictTimer();
      _lastNotifyWallAt = 0;
      _lastCommittedFrame = null;
    } else if (_lastCommittedFrame) {
      var preserveNow = Date.now();
      _ocrLastTimeSuccessTs = preserveNow;
      _ocrV5LastTimeOcrOkTs = preserveNow;
      var preserveSec = ocrFrameClockSec(_lastCommittedFrame);
      if (preserveSec >= 0) _ocrLastGoodClockSec = preserveSec;
    }
    _clockResumeCandidateSec = -1;
    _clockResumeCandidateSince = 0;
    _clockResumeCandidateStreak = 0;
    _timeJumpHoldFrame = null;
    _scoreJumpHold = null;
    _manualScoreEditAt = 0;
    _lastTimePumpTs = 0;
    _lastScorePumpTs = 0;
    _scorePumpCursor = 0;
    _isFinalMinuteMode = false;
    TIME_PUMP_INTERVAL = TIME_PUMP_INTERVAL_BASE_MS;
    SCORE_PUMP_INTERVAL = SCORE_PUMP_INTERVAL_BASE_MS;
    OCR_CLOCK_PREDICT_TICK_MS = OCR_CLOCK_PREDICT_TICK_BASE_MS;
    this._destroyOcrFilterWorker();
    _ocrFilterFallback = false;
    this._cancelOcrFramePump();
    if (_vkSession) {
      var session = _vkSession;
      try {
        if (typeof session.off === 'function') {
          session.off('updateAnchors');
        }
      } catch (eOff) { }
      try { session.stop(); } catch (e) { }
      try { session.destroy && session.destroy(); } catch (eDestroy) { }
      _vkSession = null;
    }
    if (_ocrVkGl) {
      var gl = _ocrVkGl;
      try { gl.bindTexture(gl.TEXTURE_2D, null); } catch (eTexture) { }
      try { gl.bindBuffer(gl.ARRAY_BUFFER, null); } catch (eBuffer) { }
      try { gl.bindFramebuffer(gl.FRAMEBUFFER, null); } catch (eFramebuffer) { }
      try { gl.bindRenderbuffer && gl.bindRenderbuffer(gl.RENDERBUFFER, null); } catch (eRenderbuffer) { }
      try { gl.flush && gl.flush(); } catch (eFlush) { }
      _ocrVkGl = null;
      _ocrVkCanvas = null;
      console.log('[Collector][OCR] session stopped, WebGL resources unbound');
    }
    _lastHandleTs = 0;
    _pendingOcrFrame = null;
    _lastCommittedFrameKey = '';
    _lastPreviewFrameKey = '';
    _lastRejectedStableFrameKey = '';
    _lastRejectedStableFrameCount = 0;
    _ocrPausedForBackground = false;
    _ocrSessionStartedAt = 0;
    _ocrSessionBootAt = 0;
    _ocrManualFailTimestamps = [];
    _ocrConsecutiveTimeout = 0;
    _ocrFrameBufferPool = null;
    OCR_MIN_INTERVAL_MS = OCR_MIN_INTERVAL_BASE_MS;
    this._ocrRotatePending = false;
  },

  /**
   * 停止 OCR 健康检查定时器。
   */
  _clearOcrHealthTimer: function () {
    if (_ocrHealthTimer) {
      clearInterval(_ocrHealthTimer);
      _ocrHealthTimer = 0;
    }
  },

  /**
   * VK 启动成功后开始计时，周期性检查是否需要温和重建会话。
   */
  _startOcrHealthTimer: function () {
    var self = this;
    this._clearOcrHealthTimer();
    _ocrSessionStartedAt = Date.now();
    _ocrSessionBootAt = _ocrSessionStartedAt;
    _ocrHealthTimer = setInterval(function () {
      self._onOcrHealthTick();
    }, OCR_HEALTH_INTERVAL_MS);
  },

  /**
   * 健康检查：会话存活过久则温和重建，避免 VK 长时间僵死与内存爬升。
   */
  _onOcrHealthTick: function () {
    if (!_vkSession || !this.data.ocrEnabled || this.data.ocrTransitioning) return;
    var started = _ocrSessionStartedAt || 0;
    if (!started) return;
    if (_ocrRunBusy && _ocrBusySince && Date.now() - _ocrBusySince > 3000) {
      console.error('[Collector][OCR] deadlock detected busyMs=%s', Date.now() - _ocrBusySince);
      this._rotateOcrSession('deadlock');
      return;
    }
    if (_ocrSessionBootAt && Date.now() - _ocrSessionBootAt >= OCR_SESSION_ROTATE_MS) {
      console.warn('[Collector][OCR] rotate session uptime=%s', Date.now() - _ocrSessionBootAt);
      this._rotateOcrSession('scheduled-rotate');
      return;
    }
    if (Date.now() - started >= OCR_SESSION_REBUILD_MS) {
      this._softRestartOcrSession('uptime');
    }
  },

  /**
   * 记录手动 OCR 单次失败（超时/run 抛错），滑动窗口内过多则温和重建 VK。
   * @param {string} reason 失败原因标记
   */
  _recordManualOcrFailure: function (reason) {
    if (!_ocrManualMode) return;
    var now = Date.now();
    _ocrManualFailTimestamps.push(now);
    while (
      _ocrManualFailTimestamps.length &&
      (now - _ocrManualFailTimestamps[0]) > OCR_MANUAL_FAIL_WINDOW_MS
    ) {
      _ocrManualFailTimestamps.shift();
    }
    if (_ocrManualFailTimestamps.length >= OCR_MANUAL_FAIL_THRESHOLD) {
      var nowFail = Date.now();
      if (nowFail - (_ocrLastSoftRestartAt || 0) < OCR_SOFT_RESTART_MIN_INTERVAL_MS) {
        _ocrManualFailTimestamps = [];
        return;
      }
      console.warn('[Collector][OCR] manual fail threshold reached reason=%s count=%s', reason, _ocrManualFailTimestamps.length);
      _ocrManualFailTimestamps = [];
      var self = this;
      setTimeout(function () {
        self._softRestartOcrSession('manual-fail');
      }, 0);
    }
  },

  /**
   * 温和重建 VK OCR 会话：不关闭 WebSocket，不打断用户「OCR 已开」状态，仅 stop/destroy 后重新 boot。
   * @param {string} reason 日志用原因
   */
  _softRestartOcrSession: function (reason) {
    if (!this.data.ocrEnabled || this.data.ocrTransitioning) return;
    _ocrLastSoftRestartAt = Date.now();
    console.warn('[Collector][OCR] soft VK session rebuild reason=%s', reason || '');
    beginOcrWsRestartGuard('soft-restart:' + (reason || 'unknown'));
    var token = ++_ocrSessionToken;
    this._clearOcrHealthTimer();
    this._stopOcrSession(true);
    this._prepareCameraForOcrBoot(token, 'soft-restart:' + (reason || 'unknown'));
  },

  _rotateOcrSession: function (reason) {
    if (!this.data.ocrEnabled) return;
    if (this._ocrRotatePending) return;
    this._ocrRotatePending = true;
    _ocrStats.rotate += 1;
    console.warn('[Collector][OCR] rotate begin reason=%s', reason || '');
    beginOcrWsRestartGuard('rotate:' + (reason || 'unknown'));
    this._cancelOcrFramePump();
    if (_ocrRunTimeout) {
      clearTimeout(_ocrRunTimeout);
      _ocrRunTimeout = 0;
    }
    _ocrRunBusy = false;
    _ocrBusySince = 0;
    _ocrRunState = null;
    _ocrReqQueue = [];
    var self = this;
    var token = ++_ocrSessionToken;
    setTimeout(function () {
      self._stopOcrSession(true);
      setTimeout(function () {
        self._ocrRotatePending = false;
        self._prepareCameraForOcrBoot(token, 'rotate:' + (reason || 'unknown'));
      }, 300);
    }, 120);
  },

  _applyOcrRoiTexts: function (rawTexts, updatedRoiIdx) {
    if (!rawTexts) return;
    var rois = this.data.rois;
    var debugMode = this.data.debugMode;
    var changed = false;
    var update = {};
    for (var i = 0; i < rawTexts.length; i++) {
      if ((rois[i] && rois[i].rawText) !== rawTexts[i]) {
        update['rois[' + i + '].rawText'] = rawTexts[i];
        changed = true;
      }
    }
    if (debugMode) {
      var debugLines = [];
      for (var di = 0; di < rawTexts.length; di++) {
        debugLines.push((rois[di] && rois[di].label ? rois[di].label : ('ROI' + di)) + ': ' + rawTexts[di]);
      }
      var nextDebugText = debugLines.join('\n');
      if (nextDebugText !== this.data.debugText) {
        update.debugText = nextDebugText;
        changed = true;
      }
    }
    if (changed) this.setData(update);

    if (debugMode) {
      console.log('[Collector][OCR] roiTexts=%o', rawTexts);
    }
    var parsedRois = rois.map(function (roi, idx) {
      return Object.assign({}, roi, { rawText: rawTexts[idx] });
    });
    this._applyParsedPreview(parsedRois, updatedRoiIdx);
    this._parseAndMaybeNotify(parsedRois, updatedRoiIdx);
  },

  _applyPartialOcrPreview: function (rawTexts, updatedRoiIdx) {
    var rois = this.data.rois.map(function (roi, idx) {
      return Object.assign({}, roi, { rawText: rawTexts[idx] || '' });
    });
    this._applyParsedPreview(rois, updatedRoiIdx);
  },

  _restoreCameraPreview: function (done) {
    var self = this;
    if (this.data.cameraMounted) {
      if (typeof done === 'function') done();
      return;
    }
    this.setData({ cameraMounted: true }, function () {
      _cameraContext = wx.createCameraContext(self);
      _cameraReadyAt = Date.now();
      if (typeof done === 'function') done();
    });
  },

  // ─── OCR 锚点处理（兜底门控 + 局部 setData）────────

  /**
   * 兜底物理锁定：距上次处理不足 OCR_MIN_INTERVAL_MS 直接丢弃，不做任何计算。
   * setData 仅更新各 ROI 的 rawText，不触碰坐标/pctStyle。
   * debugText 仅在 debugMode 开启时写入。
   */
  _handleOcrAnchors: function (anchors) {
    _ocrAnchorEventCount += 1;
    var now = Date.now();
    if (now - _lastHandleTs < OCR_MIN_INTERVAL_MS) return;
    _lastHandleTs = now;

    if (!anchors || !anchors.length) {
      console.log('[Collector][OCR] gate pass but anchors empty');
    }

    var rois = this.data.rois;
    var rawTexts = rois.map(function () {
      return '';
    });
    var debugMode = this.data.debugMode;
    var debugLines = debugMode ? [] : null;
    var roiBounds = [];
    var changed = false;
    var update = {};

    for (var bi = 0; bi < rois.length; bi++) {
      roiBounds.push({
        left: rois[bi].x,
        top: rois[bi].y,
        right: rois[bi].x + rois[bi].w,
        bottom: rois[bi].y + rois[bi].h
      });
    }

    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      var text = typeof anchor.text === 'string' ? anchor.text.trim() : '';
      if (!text) {
        if (_ocrAnchorLogSeq < 20) {
          console.log('[Collector][OCR] anchor without text %o', summarizeAnchorForLog(anchor));
          _ocrAnchorLogSeq += 1;
        }
        continue;
      }
      var geo = extractAnchorCenter(anchor);
      if (!geo) {
        if (debugLines) debugLines.push(text + ' (no-geo)');
        if (_ocrAnchorLogSeq < 20) {
          console.log('[Collector][OCR] text with no geo text=%s sample=%o', text, summarizeAnchorForLog(anchor));
          _ocrAnchorLogSeq += 1;
        }
        continue;
      }
      var cx = geo.x;
      var cy = geo.y;
      var geoTag = geo.source || 'unknown';

      if (debugLines) debugLines.push(text + ' (' + cx.toFixed(2) + ',' + cy.toFixed(2) + ', ' + geoTag + ')');

      for (var r = 0; r < roiBounds.length; r++) {
        var roi = roiBounds[r];
        if (cx >= roi.left && cx <= roi.right && cy >= roi.top && cy <= roi.bottom) {
          rawTexts[r] = rawTexts[r] ? rawTexts[r] + ' ' + text : text;
        }
      }
    }

    for (var ri = 0; ri < rawTexts.length; ri++) {
      if (rawTexts[ri]) {
        _ocrNativeTextEventCount += 1;
      }
      if ((rois[ri] && rois[ri].rawText) !== rawTexts[ri]) {
        update['rois[' + ri + '].rawText'] = rawTexts[ri];
        changed = true;
      }
    }
    if (debugLines !== null) {
      if (!debugLines.length) debugLines.push('anchors: 0');
      var nextDebugText = debugLines.join('\n');
      if (nextDebugText !== this.data.debugText) {
        update.debugText = nextDebugText;
        changed = true;
      }
    }
    if (changed) this.setData(update);

    // 构造 rois 副本供解析（直接读当前 data.rois，rawText 已在 update 中）
    var parsedRois = rois.map(function (roi, idx) {
      return Object.assign({}, roi, { rawText: rawTexts[idx] });
    });
    if (debugMode) {
      console.log('[Collector][OCR] roiTexts=%o', rawTexts);
    }
    this._applyParsedPreview(parsedRois, -1);
    this._parseAndMaybeNotify(parsedRois, -1);
  },

  _applyParsedPreview: function (rois, updatedRoiIdx) {
    if (_ocrOcclusionActive) return;
    var next = {};
    var changed = false;
    var scorePairPreview = resolveOcrScorePair(rois);
    if (!scorePairPreview && (updatedRoiIdx === 0 || updatedRoiIdx === 1)) {
      var singlePreviewRaw = rois[updatedRoiIdx] && rois[updatedRoiIdx].rawText ? rois[updatedRoiIdx].rawText : '';
      var singlePreviewVal = parseScore(singlePreviewRaw, updatedRoiIdx);
      if (singlePreviewVal !== null) {
        scorePairPreview = {
          homeScore: updatedRoiIdx === 0 ? singlePreviewVal : (Number(this.data.homeScore) || 0),
          awayScore: updatedRoiIdx === 1 ? singlePreviewVal : (Number(this.data.awayScore) || 0)
        };
      }
    }
    var homeScore = scorePairPreview ? scorePairPreview.homeScore : null;
    var awayScore = scorePairPreview ? scorePairPreview.awayScore : null;

    if (homeScore !== null && homeScore !== this.data.homeScore && shouldPreviewScore(0, homeScore)) {
      next.homeScore = homeScore;
      changed = true;
    }
    if (awayScore !== null && awayScore !== this.data.awayScore && shouldPreviewScore(1, awayScore)) {
      next.awayScore = awayScore;
      changed = true;
    }

    if (!changed) return;
    var previewKey = [
      typeof next.homeScore === 'number' ? next.homeScore : this.data.homeScore,
      typeof next.awayScore === 'number' ? next.awayScore : this.data.awayScore
    ].join('|');
    if (previewKey === _lastPreviewFrameKey) return;
    _lastPreviewFrameKey = previewKey;
    if (this.data.debugMode) {
      console.log('[Collector][OCR] preview update=%o', next);
    }
    this.setData(next);
  },

  /**
   * 仅更新采集端本地 UI 时间展示（预测补秒），不向云端发包。
   * @param {{ minutes: number, seconds: number } | null} timeInfo
   * @param {number} wallMs
   * @param {boolean} [force] 是否绕过平滑保护强制刷新本地 UI
   * @returns {void}
   */
  _emitTimeOnlyIfChanged: function (timeInfo, wallMs, force) {
    if (!timeInfo || !_lastCommittedFrame) return;
    var prevT = ocrFrameClockSec(_lastCommittedFrame);
    var newT = (Number(timeInfo.minutes) || 0) * 60 + (Number(timeInfo.seconds) || 0);
    if (newT === prevT) return;
    if (!force && isOcrRecoverySnapActive(wallMs)) {
      force = true;
    }
    if (!force) {
      var isOcrAligned = (_lastOcrClockSec >= 0 && Math.abs(newT - _lastOcrClockSec) <= 2);
      var drop = prevT - newT;
      if (isOcrAligned && drop <= 1) {
        // 与 OCR 锚点一致时直接显示预测秒，不走 prevT-1 阶梯（避免闪一下）
      } else if (!isOcrAligned) {
        if (newT > prevT) return;
        if (drop > 1) {
          if (drop > OCR_CLOCK_CATCHUP_MAX_DROP_SEC) return;
          var minEmitMs = drop > 2 ? OCR_CLOCK_CATCHUP_FAST_INTERVAL_MS : OCR_CLOCK_NORMAL_INTERVAL_MS;
          if (_lastClockPredictEmitWallTs && wallMs - _lastClockPredictEmitWallTs < minEmitMs) return;
          newT = prevT - 1;
          timeInfo = clockFromTotalSec(newT);
          _clockPredictUntil = Math.max(_clockPredictUntil || 0, getClockCatchupUntil(wallMs, drop));
          this._ensureClockPredictTimer();
        }
      }
    }
    var snap = {
      homeScore: _lastCommittedFrame.homeScore,
      awayScore: _lastCommittedFrame.awayScore,
      period: this.data.period,
      minutes: timeInfo.minutes,
      seconds: timeInfo.seconds,
      shotClock: this.data.shotClock
    };
    _lastNotifyWallAt = wallMs;
    _lastClockPredictEmitWallTs = wallMs;
    _lastClockPredictEmitSec = newT;
    _lastCommittedFrameKey = buildFrameKey(snap);
    setAuditClockSource('predict', force ? 'predict_force' : 'predict_tick', '_emitTimeOnlyIfChanged');
    this._commitLocalState(snap);
    this._maybeApplyFinalMinuteMode(timeInfo);
  },

  _smoothFrameClockForCommit: function (frame, wallMs, hasTimeInfo) {
    if (!_lastCommittedFrame || !hasTimeInfo) return frame;
    if (isOcrRecoverySnapActive(wallMs)) return frame;
    var prevT = ocrFrameClockSec(_lastCommittedFrame);
    var nextT = ocrFrameClockSec(frame);
    if (nextT >= prevT) return frame;
    var drop = prevT - nextT;

    // 【修复 1：打破 10:00 拦截死锁】
    // 如果内部时间状态机(_lastOcrClockSec)已经确认并接纳了这个时间（误差2秒内），
    // 说明这是合法的初次对齐或大跨度跳变，强制放行，无视下方的 20 秒防抖拦截门禁！
    if (_lastOcrClockSec >= 0 && Math.abs(nextT - _lastOcrClockSec) <= 2) {
      return frame;
    }

    if (drop <= OCR_SOFT_SYNC_MAX_STEP_SEC) {
      return frame;
    }

    if (drop <= 1) return frame;
    if (drop > OCR_CLOCK_CATCHUP_MAX_DROP_SEC) {
      var glitchHoldClock = clockFromTotalSec(prevT);
      frame.minutes = glitchHoldClock.minutes;
      frame.seconds = glitchHoldClock.seconds;
      if (this.data.debugMode) {
        console.log('[Collector][OCR] clock drop ignored prev=%s next=%s drop=%s', prevT, nextT, drop);
      }
      return frame;
    }
    var minEmitMs = drop > 2 ? OCR_CLOCK_CATCHUP_FAST_INTERVAL_MS : OCR_CLOCK_NORMAL_INTERVAL_MS;
    if (_lastClockPredictEmitWallTs && wallMs - _lastClockPredictEmitWallTs < minEmitMs) {
      var holdClock = clockFromTotalSec(prevT);
      frame.minutes = holdClock.minutes;
      frame.seconds = holdClock.seconds;
      _clockPredictUntil = Math.max(_clockPredictUntil || 0, getClockCatchupUntil(wallMs, drop));
      this._ensureClockPredictTimer();
      return frame;
    }
    var smoothClock = clockFromTotalSec(prevT - 1);
    frame.minutes = smoothClock.minutes;
    frame.seconds = smoothClock.seconds;
    _clockPredictUntil = Math.max(_clockPredictUntil || 0, getClockCatchupUntil(wallMs, drop));
    this._ensureClockPredictTimer();
    if (this.data.debugMode) {
      console.log('[Collector][OCR] smooth clock drop prev=%s next=%s emit=%s', prevT, nextT, prevT - 1);
    }
    return frame;
  },

  /**
   * 解析 ROI 文字 → 比赛状态，交给 processOcrFrame 做 5 大阀门提纯。
   * @param {Array<{ rawText: string }>} rois ROI 列表
   * @param {number} updatedRoiIdx 本帧更新的 ROI 索引，-1 表示未知
   * @returns {void}
   */
  _parseAndMaybeNotify: function (rois, updatedRoiIdx) {
    if (_ocrOcclusionActive) return;

    var scorePair = resolveOcrScorePair(rois);
    if (!scorePair && (updatedRoiIdx === 0 || updatedRoiIdx === 1)) {
      var singleRaw = rois[updatedRoiIdx] && rois[updatedRoiIdx].rawText ? rois[updatedRoiIdx].rawText : '';
      var singleVal = parseScore(singleRaw, updatedRoiIdx);
      if (singleVal !== null) {
        scorePair = {
          homeScore: updatedRoiIdx === 0 ? singleVal : (Number(this.data.homeScore) || 0),
          awayScore: updatedRoiIdx === 1 ? singleVal : (Number(this.data.awayScore) || 0)
        };
      }
    }
    if (!scorePair && updatedRoiIdx === 2) {
      scorePair = {
        homeScore: _ocrLastGoodHomeScore >= 0 ? _ocrLastGoodHomeScore : (Number(this.data.homeScore) || 0),
        awayScore: _ocrLastGoodAwayScore >= 0 ? _ocrLastGoodAwayScore : (Number(this.data.awayScore) || 0)
      };
    }
    if (!scorePair) {
      if (this.data.debugMode) {
        console.log('[Collector][OCR] parse skip home/away raw=%o', rois.map(function (r) { return r.rawText; }));
      }
      return;
    }
    var homeScore = scorePair.homeScore;
    var awayScore = scorePair.awayScore;
    var ocrTimeInfo = updatedRoiIdx === 2
      ? filterClockByMode(
        resolveGameClockParse(
          rois[2] && rois[2].rawText ? rois[2].rawText : '',
          getClockRefSec()
        )
      )
      : null;

    var wallPre = Date.now();
    var bypassScoreJumpHold =
      wallPre - (_manualScoreEditAt || 0) < OCR_SCORE_JUMP_MANUAL_GUARD_MS;
    if (bypassScoreJumpHold) {
      _scoreJumpHold = null;
    }

    var timeInfo = ocrTimeInfo || getPredictedClock();
    var hasFrameClock = !!ocrTimeInfo;
    var frame = {
      homeScore: homeScore,
      awayScore: awayScore,
      period: this.data.period,
      minutes: timeInfo ? timeInfo.minutes : this.data.minutes,
      seconds: timeInfo ? timeInfo.seconds : this.data.seconds,
      shotClock: this.data.shotClock
    };

    var wall = Date.now();
    frame = this._smoothFrameClockForCommit(frame, wall, hasFrameClock);

    if (_timeJumpHoldFrame && _timeJumpHoldFrame._holdSince) {
      var holdAge = wall - _timeJumpHoldFrame._holdSince;
      if (holdAge > 900) {
        _timeJumpHoldFrame = null;
      } else {
        var hg = ocrFrameClockSec(_timeJumpHoldFrame);
        var ng = ocrFrameClockSec(frame);
        var pg = _lastCommittedFrame ? ocrFrameClockSec(_lastCommittedFrame) : ng;
        if (Math.abs(ng - hg) <= 1) {
          frame.minutes = _timeJumpHoldFrame.minutes;
          frame.seconds = _timeJumpHoldFrame.seconds;
          _timeJumpHoldFrame = null;
        } else if (_lastCommittedFrame && Math.abs(ng - pg) <= 2) {
          _timeJumpHoldFrame = null;
        } else {
          return;
        }
      }
    }

    if (_lastCommittedFrame && timeInfo && _lastNotifyWallAt) {
      var dt = wall - _lastNotifyWallAt;
      if (isSuspiciousGameClockSkip(_lastCommittedFrame, frame, dt)) {
        _timeJumpHoldFrame = {
          homeScore: frame.homeScore,
          awayScore: frame.awayScore,
          period: frame.period,
          minutes: frame.minutes,
          seconds: frame.seconds,
          shotClock: frame.shotClock,
          _holdSince: wall
        };
        return;
      }
    }

    var frameKey = buildFrameKey(frame);
    var pubBefore = _procState.published;
    var pendingScoreSync = scoresDifferFromPublished(
      pubBefore,
      frame.homeScore,
      frame.awayScore
    );
    if (frameKey === _lastCommittedFrameKey && !pendingScoreSync) {
      _pendingOcrFrame = null;
      return;
    }

    setAuditClockSource(
      hasFrameClock ? 'ocr' : 'predict',
      hasFrameClock ? 'parse_roi' : 'parse_predict',
      '_parseAndMaybeNotify'
    );
    this.processOcrFrame({
      homeScore: frame.homeScore,
      awayScore: frame.awayScore,
      minutes: frame.minutes,
      seconds: frame.seconds,
      timeValid: hasFrameClock,
      wallMs: wall,
      bypassScoreHold: bypassScoreJumpHold
    });

    _pendingOcrFrame = null;
    var pubAfter = _procState.published;
    if (
      !pubAfter ||
      (frame.homeScore === pubAfter.a && frame.awayScore === pubAfter.b)
    ) {
      _lastCommittedFrameKey = frameKey;
    }
    _lastRejectedStableFrameKey = '';
    _lastRejectedStableFrameCount = 0;
    _lastNotifyWallAt = wall;
    _lastClockPredictEmitWallTs = wall;
    _lastClockPredictEmitSec = ocrFrameClockSec(frame);
    this._maybeApplyFinalMinuteMode({ minutes: frame.minutes, seconds: frame.seconds });
  },

  // ─── WebSocket：连接 / 断线重连 ────────────────────────

  /**
   * 点击「开启采集」：复用本场房间号（无则生成并持久化）→ HTTP 换 Token → WSS。
   * @returns {void}
   */
  _beginWsSyncNow: function () {
    var roomId = loadPersistedRoomId();
    if (!roomId) {
      roomId = generateRoomId();
      savePersistedRoomId(roomId);
    }
    _wsRoomId = roomId;
    this.setData({ matchCode: roomId, wsStateText: '正在连接…' });
    this._connectWebSocket(roomId);
  },

  onStartTap: function () {
    if (_wsConnecting || this.data.wsState !== 'idle') return;
    if (this.data.ocrTransitioning) {
      this._pendingWsStartAfterOcr = true;
      this.setData({ wsStateText: '等待 OCR 启动…' });
      wx.showToast({ title: 'OCR 启动中，稍后自动同步', icon: 'none', duration: 1200 });
      return;
    }
    this._pendingWsStartAfterOcr = false;
    this._beginWsSyncNow();
  },

  /**
   * 主动结束当前房间并生成新房间号（需直播端改连新码）。
   * @returns {void}
   */
  onNewRoomTap: function () {
    var self = this;
    if (_wsConnecting) return;
    wx.showModal({
      title: '开启新房间',
      content: '将断开当前云端房间并生成新的 6 位房间码，直播端需输入新号码。确定继续？',
      confirmText: '新房间',
      cancelText: '取消',
      success: function (res) {
        if (!res.confirm) return;
        self._disconnectWebSocket(true);
        clearPersistedRoomId();
        var roomId = generateRoomId();
        savePersistedRoomId(roomId);
        _wsRoomId = roomId;
        /* 新房间 = 新一场比赛：清空采集端 UI 与 OCR 内部基线，
           连上云端后由 _maybeBootstrapSnapshot 自动用 0:0/10:00 建立新房间基线快照 */
        _lastCommittedFrame = null;
        bumpManualScoreEditGate();
        self.setData({
          matchCode: roomId,
          wsState: 'idle',
          wsStateText: '正在连接…',
          homeScore: 0,
          awayScore: 0,
          period: 1,
          minutes: 10,
          seconds: 0,
          shotClock: 24
        }, function () {
          self._connectWebSocket(roomId);
        });
      }
    });
  },

  /**
   * 点击「停止」：断开 WebSocket 并清空房间号。
   * @returns {void}
   */
  onStopTap: function () {
    this._pendingWsStartAfterOcr = false;
    this._stopOcr(false);
    this._disconnectWebSocket(true);
    var savedCode = loadPersistedRoomId();
    this.setData({
      wsState: 'idle',
      wsStateText: '未连接',
      matchCode: savedCode || ''
    });
  },

  /**
   * 从 HTTP 接口获取一次性 WebSocket Token。
   * @param {string} roomId 房间号
   * @returns {Promise<string>}
   */
  _fetchWsToken: function (roomId) {
    return wsTokenReq.fetchWsToken(roomId);
  },

  /**
   * 建立 WebSocket 长连接（先取 Token 再 connectSocket）。
   *
   * 修复重点：
   *   1) 整段加握手超时（WS_HANDSHAKE_TIMEOUT_MS）：Android 某些 wx 版本会出现
   *      `connectSocket` 既不 success 也不 fail 的死锁，UI 永远停在「握手中…」；
   *   2) `_wsReconnectAttempt` 不再在 onOpen 时立即清零，改为「稳定 N 秒」后才
   *      清零，避免「连上 25s 即被 1006 关闭」的短命连接掩盖退避计数；
   *   3) 短命连接计数（_wsShortLivedStreak）连续达阈值 → 进入紧急心跳模式（8s）。
   *   4) token_fail 走 max(指数退避, WS_TOKEN_FAIL_MIN_DELAY_MS) 的更宽松退避。
   *
   * @param {string} roomId 房间号
   * @returns {void}
   */
  _connectWebSocket: function (roomId) {
    var self = this;
    if (_wsConnecting) return;
    _wsConnecting = true;
    _wsManualClose = false;
    this.setData({ wsState: 'connecting', wsStateText: '获取 Token…' });

    logCollectorWs('connect_request', { room: String(roomId || ''), attempt: _wsReconnectAttempt });
    this._armHandshakeWatchdog('token');

    this._fetchWsToken(roomId).then(function (token) {
      logCollectorWs('token_ok', {});
      if (_wsManualClose) {
        _wsConnecting = false;
        self._disarmHandshakeWatchdog();
        return;
      }
      var wsUrl = WS_BASE_URL + WS_SOCKET_PATH +
        '?roomId=' + encodeURIComponent(roomId) +
        '&token=' + encodeURIComponent(token);
      self.setData({ wsStateText: '握手中…' });
      self._armHandshakeWatchdog('socket');
      try {
        if (_socketTask) {
          try { _socketTask.close({}); } catch (eClose) { }
          _socketTask = null;
        }
        _socketTask = wx.connectSocket({
          url: wsUrl,
          fail: function (err) {
            _wsConnecting = false;
            self._disarmHandshakeWatchdog();
            self.setData({ wsState: 'reconnecting', wsStateText: '连接失败，重连中…' });
            logCollectorWs('connect_socket_fail', {
              msg: err && err.errMsg ? String(err.errMsg).slice(0, 120) : 'fail'
            });
            if (!_wsManualClose && _wsRoomId) {
              self._scheduleWsReconnect();
            }
          }
        });
      } catch (errConnect) {
        _wsConnecting = false;
        self._disarmHandshakeWatchdog();
        self.setData({ wsState: 'reconnecting', wsStateText: '连接失败，重连中…' });
        logCollectorWs('connect_socket_throw', {
          msg: errConnect && errConnect.message ? String(errConnect.message).slice(0, 120) : 'throw'
        });
        if (!_wsManualClose && _wsRoomId) {
          self._scheduleWsReconnect();
        }
        return;
      }

      _socketTask.onOpen(function () {
        _wsConnecting = false;
        self._disarmHandshakeWatchdog();
        if (_wsReconnectTimer) {
          clearTimeout(_wsReconnectTimer);
          _wsReconnectTimer = 0;
        }
        _wsOpenedAt = Date.now();
        _wsLastSendOkAt = 0;
        _wsLastRecvAt = 0;
        logCollectorWs('open', {
          room: String(roomId || ''),
          emergency_heartbeat: !!_wsHeartbeatEmergency,
          shortlived_streak: _wsShortLivedStreak
        });
        self.setData({ wsState: 'connected', wsStateText: '云端已连接 ✓' });
        wx.vibrateShort({ type: 'medium' });
        /* 稳定 WS_ATTEMPT_CLEAR_AFTER_MS 后才认为连接「真活了」，再清零退避计数；
           这样 25s 被 1006 关闭这类短命场景也能正确推进退避 */
        if (_wsAttemptClearTimer) {
          clearTimeout(_wsAttemptClearTimer);
          _wsAttemptClearTimer = 0;
        }
        _wsAttemptClearTimer = setTimeout(function () {
          _wsAttemptClearTimer = 0;
          _wsReconnectAttempt = 0;
          _wsShortLivedStreak = 0;
          if (_wsHeartbeatEmergency) {
            _wsHeartbeatEmergency = false;
            logCollectorWs('heartbeat_emergency_off', {});
          }
        }, WS_ATTEMPT_CLEAR_AFTER_MS);
        startCollectorHeartbeat();
        startCollectorWatchdog(function () { return self; });
        self._maybeBootstrapSnapshot();
      });

      _socketTask.onMessage(function (msg) {
        if (!msg || !msg.data) return;
        _wsLastRecvAt = Date.now();
        try {
          var payload = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
          if (payload && payload.type === 'COLLECTOR_EXIST') {
            logCollectorWs('collector_exist', {});
            wx.showToast({ title: '房间已有采集端', icon: 'none' });
            self._disconnectWebSocket(true);
          }
        } catch (eParse) {
          /* 收到无法解析的下行（含未来可能的 PONG 等）：保持静默，仅刷新 lastRecvAt 即可 */
        }
      });

      _socketTask.onError(function (err) {
        logCollectorWs('error', {
          msg: err && err.errMsg ? String(err.errMsg).slice(0, 120) : 'unknown',
          since_open_ms: _wsOpenedAt ? Date.now() - _wsOpenedAt : -1
        });
      });

      _socketTask.onClose(function (res) {
        _wsConnecting = false;
        self._disarmHandshakeWatchdog();
        var sinceOpen = _wsOpenedAt ? Date.now() - _wsOpenedAt : -1;
        var code = res && typeof res.code === 'number' ? res.code : -1;
        /* 短命连接统计：onOpen 后 30s 内被关掉的连接累计 */
        var wasOpen = _wsOpenedAt > 0;
        if (wasOpen && sinceOpen >= 0 && sinceOpen < WS_SHORTLIVED_OPEN_MS && !_wsManualClose) {
          _wsShortLivedStreak = (_wsShortLivedStreak || 0) + 1;
          if (
            !_wsHeartbeatEmergency &&
            _wsShortLivedStreak >= WS_SHORTLIVED_TRIGGER_COUNT
          ) {
            _wsHeartbeatEmergency = true;
            logCollectorWs('heartbeat_emergency_on', {
              streak: _wsShortLivedStreak,
              last_since_open_ms: sinceOpen,
              code: code
            });
          }
        }
        if (_wsAttemptClearTimer) {
          clearTimeout(_wsAttemptClearTimer);
          _wsAttemptClearTimer = 0;
        }
        logCollectorWs('close', {
          code: code,
          reason: res && res.reason ? String(res.reason).slice(0, 120) : '',
          since_open_ms: sinceOpen,
          last_send_ok_ago_ms: _wsLastSendOkAt ? Date.now() - _wsLastSendOkAt : -1,
          last_recv_ago_ms: _wsLastRecvAt ? Date.now() - _wsLastRecvAt : -1,
          manual: !!_wsManualClose,
          shortlived_streak: _wsShortLivedStreak,
          emergency_heartbeat: !!_wsHeartbeatEmergency
        });
        stopCollectorHeartbeat();
        stopCollectorWatchdog();
        _socketTask = null;
        _wsOpenedAt = 0;
        if (_wsManualClose) {
          self.setData({ wsState: 'idle', wsStateText: '未连接' });
          return;
        }
        if (isOcrWsRestartGuardActive()) {
          _ocrWsReconnectPendingAfterRestart = true;
          self.setData({ wsState: 'reconnecting', wsStateText: 'OCR 重启中，稍后恢复连接…' });
          logCollectorWs('close_deferred_by_ocr_restart', {
            code: code,
            guard_reason: _ocrWsRestartGuardReason,
            guard_left_ms: Math.max(0, _ocrWsRestartGuardUntil - Date.now())
          });
          return;
        }
        self.setData({ wsState: 'reconnecting', wsStateText: '断线重连中…' });
        self._scheduleWsReconnect();
      });
    }).catch(function (err) {
      _wsConnecting = false;
      self._disarmHandshakeWatchdog();
      self.setData({ wsState: 'reconnecting', wsStateText: 'Token 失败，重连中…' });
      logCollectorWs('token_fail', {
        msg: err && err.message ? String(err.message).slice(0, 120) : 'fail'
      });
      if (!_wsManualClose && _wsRoomId) {
        self._scheduleWsReconnect({ minDelayMs: WS_TOKEN_FAIL_MIN_DELAY_MS });
      }
    });
  },

  /**
   * 握手超时看门狗。
   *
   * 阶段隔离：
   *   - 'token' 阶段（fetchWsToken 还没回）：超时 = WS_HANDSHAKE_TOKEN_TIMEOUT_MS（10s）；
   *   - 'socket' 阶段（已 token_ok、等 onOpen）：超时 = WS_HANDSHAKE_SOCKET_TIMEOUT_MS（15s）。
   *
   * 关键防误杀：fire 时再次校验
   *   1) `_wsOpenedAt > 0` —— 已经 onOpen 直接 bail（旧版踩过坑：14ms 之差把好连接关掉）；
   *   2) `_wsManualClose` —— 用户已经主动断开，bail；
   *   3) `_wsReconnectTimer` —— 已有重连在排程，bail，避免双调度。
   *
   * 解决 Android 某些 wx 版本 `connectSocket` 没有任何回调的死锁。
   *
   * @param {'token'|'socket'} stage 哪个阶段启动看门狗
   * @returns {void}
   */
  _armHandshakeWatchdog: function (stage) {
    var self = this;
    this._disarmHandshakeWatchdog();
    var timeout = stage === 'socket'
      ? WS_HANDSHAKE_SOCKET_TIMEOUT_MS
      : WS_HANDSHAKE_TOKEN_TIMEOUT_MS;
    _wsHandshakeTimer = setTimeout(function () {
      _wsHandshakeTimer = 0;
      if (_wsManualClose) return;
      /* 防止与 onOpen 同帧竞态：如果连接已经 open，直接 bail（不能误杀已建立的连接） */
      if (_wsOpenedAt > 0) {
        logCollectorWs('handshake_timeout_skip_open', {
          stage: String(stage || ''),
          since_open_ms: Date.now() - _wsOpenedAt
        });
        return;
      }
      logCollectorWs('handshake_timeout', {
        stage: String(stage || ''),
        has_socket: !!_socketTask,
        attempt: _wsReconnectAttempt,
        timeout_ms: timeout
      });
      var hadSocket = !!_socketTask;
      _wsConnecting = false;
      if (_socketTask) {
        try { _socketTask.close({}); } catch (eClose) { /* ignore */ }
        _socketTask = null;
      }
      if (!_wsManualClose && _wsRoomId && !_wsReconnectTimer) {
        self.setData({ wsState: 'reconnecting', wsStateText: '握手超时，重连中…' });
        self._scheduleWsReconnect();
      }
      /* 即便 hadSocket==true，我们也不依赖 onClose（Android 上它可能 60s+ 才到），
         直接立刻 schedule 重连；onClose 真到来时 `_wsReconnectTimer` 已占位，会自动去重。 */
    }, timeout);
  },

  /** 清除握手超时看门狗（onOpen / onClose / fail 时都要清）。 */
  _disarmHandshakeWatchdog: function () {
    if (_wsHandshakeTimer) {
      clearTimeout(_wsHandshakeTimer);
      _wsHandshakeTimer = 0;
    }
  },

  /**
   * 指数退避重连（3→6→12 秒，上限 15 秒）。
   * @param {{ minDelayMs?: number, immediateOnce?: boolean, reason?: string }} [opts] 可指定最小延迟（如 token_fail 时）
   * @returns {void}
   */
  _scheduleWsReconnect: function (opts) {
    var self = this;
    if (_wsManualClose || !_wsRoomId) return;
    if (_wsReconnectTimer) return;
    var immediateOnce = !!(opts && opts.immediateOnce);
    if (!immediateOnce) {
      _wsReconnectAttempt += 1;
    }
    var delay = immediateOnce ? 0 : getWsReconnectDelayMs(_wsReconnectAttempt);
    if (!immediateOnce && opts && typeof opts.minDelayMs === 'number') {
      delay = Math.max(delay, opts.minDelayMs);
    }
    console.log('[Collector][WS] reconnect in %sms attempt=%s reason=%s', delay, _wsReconnectAttempt, opts && opts.reason ? opts.reason : '');
    _wsReconnectTimer = setTimeout(function () {
      _wsReconnectTimer = 0;
      if (_wsManualClose || !_wsRoomId) return;
      self._connectWebSocket(_wsRoomId);
    }, delay);
  },

  /**
   * 断开 WebSocket；manual=true 时不触发自动重连。
   * @param {boolean} [manual] 是否为用户主动断开
   * @returns {void}
   */
  _disconnectWebSocket: function (manual) {
    _wsManualClose = !!manual;
    _wsConnecting = false;
    if (_wsReconnectTimer) {
      clearTimeout(_wsReconnectTimer);
      _wsReconnectTimer = 0;
    }
    if (_wsHandshakeTimer) {
      clearTimeout(_wsHandshakeTimer);
      _wsHandshakeTimer = 0;
    }
    if (_wsAttemptClearTimer) {
      clearTimeout(_wsAttemptClearTimer);
      _wsAttemptClearTimer = 0;
    }
    _wsReconnectAttempt = 0;
    _wsShortLivedStreak = 0;
    _wsHeartbeatEmergency = false;
    _wsHeartbeatSeq = 0;
    stopCollectorHeartbeat();
    stopCollectorWatchdog();
    if (_socketTask) {
      try { _socketTask.close({}); } catch (e) { }
      _socketTask = null;
    }
    if (manual) {
      clearOcrWsRestartGuard('ws-manual-disconnect');
      _ocrWsReconnectPendingAfterRestart = false;
      _ocrWsImmediateReconnectUsed = false;
      logCollectorWs('disconnect_manual', {});
      _wsRoomId = '';
      resetProcessOcrState();
    }
  },

  /**
   * 连接成功后若已有本地快照，补发一条 SYNC 建立基线。
   * @returns {void}
   */
  _maybeBootstrapSnapshot: function () {
    var snap = buildCurrentCollectorSnapshot(this, Date.now());
    if (!snap) return;
    this._emitWsPacket(snap.running ? 'START' : 'SYNC', {
      t: snap.t,
      a: snap.a,
      b: snap.b,
      p: snap.p
    });
  },

  /**
   * 立即向云端推送当前快照；用于 OCR/时钟看门狗恢复后主动唤醒直播端。
   * @returns {boolean} 是否找到可发送快照
   */
  _forcePushImmediateSync: function () {
    if (!_socketTask || this.data.wsState !== 'connected') return false;
    var snap = buildCurrentCollectorSnapshot(this, Date.now());
    if (!snap) return false;
    this._emitWsPacket(snap.running ? 'START' : 'SYNC', {
      t: snap.t,
      a: snap.a,
      b: snap.b,
      p: snap.p
    });
    return true;
  },

  /**
   * 向云端发送状态翻转包（携带 sys_t 与单调递增 seq）。
   * @param {'START'|'STOP'|'SYNC'|'SCORE'|'S_RESET'|'PERIOD'} act 动作语义
   * @param {{ t: number, a: number, b: number, p: number }} payload 业务字段
   * @returns {void}
   */
  _emitWsPacket: function (act, payload) {
    if (!_socketTask || this.data.wsState !== 'connected') return;
    _globalSeq += 1;
    var packetWallMs = Date.now();
    var packet = {
      type: 'COLLECTOR_UPDATE',
      act: act,
      t: Math.max(0, Math.floor(Number(payload.t) || 0)),
      a: Math.max(0, Math.floor(Number(payload.a) || 0)),
      b: Math.max(0, Math.floor(Number(payload.b) || 0)),
      p: Math.max(1, Math.floor(Number(payload.p) || 1)),
      seq: _globalSeq,
      sys_t: packetWallMs,
      match_id: 'M_' + (_wsRoomId || this.data.matchCode || '')
    };
    var self = this;
    try {
      _socketTask.send({
        data: JSON.stringify(packet),
        success: function () {
          _wsLastSendOkAt = Date.now();
        },
        fail: function (errSend) {
          logCollectorWs('send_fail', {
            act: String(act || ''),
            seq: packet.seq,
            msg: errSend && errSend.errMsg ? String(errSend.errMsg).slice(0, 120) : 'fail'
          });
          _handleCollectorWsSendFailure('send_fail', self);
        }
      });
      logCollectorWs('send_act', { act: String(act || ''), seq: packet.seq, t: packet.t });
    } catch (errSend) {
      logCollectorWs('send_throw', {
        act: String(act || ''),
        msg: errSend && errSend.message ? String(errSend.message).slice(0, 120) : 'throw'
      });
      _handleCollectorWsSendFailure('send_throw', self);
      return;
    }
    var prevPublished = _procState.published;
    var nextPublished = {
      t: packet.t,
      a: packet.a,
      b: packet.b,
      p: packet.p,
      shotClock: this.data.shotClock,
      running: act === 'START' || (act === 'SYNC' && _procState.clockRunning),
      wallMs: packetWallMs
    };
    if ((act === 'SCORE' || act === 'PERIOD') && prevPublished) {
      nextPublished.t = prevPublished.t;
      nextPublished.running = prevPublished.running;
      nextPublished.wallMs = prevPublished.wallMs || packetWallMs;
    }
    _procState.published = nextPublished;
    if (act === 'START') {
      auditBeforeClockRunning(true, 'ws_start', '_emitWsPacket');
      _procState.clockRunning = true;
      _procState.pauseConfirmed = false;
      _procState.sameSecStreak = 0;
      _procState.sameSecFirstSeen = 0;
      _procState.startObserve = null;
      auditBeforeClockMode('running', 'ws_start', '_emitWsPacket');
      _clockMode = 'running';
      syncClockStateFromMode();
      updatePredictedClock(clockFromTotalSec(packet.t));
      _clockAnchorMs = packet.t * 1000;
      _clockAnchorWallTs = packetWallMs;
      _lastOcrClockSec = packet.t;
      _lastClockPredictEmitSec = packet.t;
      _clockPredictUntil = getClockRunUntil(packetWallMs, packet.t);
      this._ensureClockPredictTimer();
    } else if (act === 'STOP') {
      auditBeforeClockRunning(false, 'ws_stop', '_emitWsPacket');
      _procState.clockRunning = false;
      _procState.pauseConfirmed = true;
      _procState.sameSecStreak = 0;
      auditBeforeClockMode('paused', 'ws_stop', '_emitWsPacket');
      _clockMode = 'paused';
      syncClockStateFromMode();
      this._clearClockPredictTimer();
    }
  },

  /**
   * 同步采集端本地 UI 快照（不向云端发包）。
   * @param {{
   *   homeScore?: number,
   *   awayScore?: number,
   *   period?: number,
   *   minutes?: number,
   *   seconds?: number,
   *   shotClock?: number
   * } | void} snapshot
   * @returns {void}
   */
  _commitLocalState: function (snapshot) {
    var auditPrevHome = this.data.homeScore;
    var auditPrevAway = this.data.awayScore;
    var auditPrevMin = this.data.minutes;
    var auditPrevSec = this.data.seconds;
    if (
      snapshot &&
      typeof snapshot === 'object' &&
      _ocrOcclusionActive &&
      _occlusionHoldClockSec >= 0
    ) {
      setAuditClockSource('occlusion_hold', 'commit_override', '_commitLocalState');
      var holdClk = clockFromTotalSec(_occlusionHoldClockSec);
      snapshot = Object.assign({}, snapshot, {
        minutes: holdClk.minutes,
        seconds: holdClk.seconds
      });
    }
    if (snapshot && typeof snapshot === 'object') {
      _lastCommittedFrame = {
        homeScore: Number(snapshot.homeScore) || 0,
        awayScore: Number(snapshot.awayScore) || 0,
        period: Number(snapshot.period) || 1,
        minutes: Number(snapshot.minutes) || 0,
        seconds: Number(snapshot.seconds) || 0,
        shotClock: Number(snapshot.shotClock) || 0
      };
    } else {
      _lastCommittedFrame = {
        homeScore: this.data.homeScore,
        awayScore: this.data.awayScore,
        period: this.data.period,
        minutes: this.data.minutes,
        seconds: this.data.seconds,
        shotClock: this.data.shotClock
      };
    }
    this.setData({
      homeScore: _lastCommittedFrame.homeScore,
      awayScore: _lastCommittedFrame.awayScore,
      period: _lastCommittedFrame.period,
      minutes: _lastCommittedFrame.minutes,
      seconds: _lastCommittedFrame.seconds,
      shotClock: _lastCommittedFrame.shotClock
    });
    if (
      _lastCommittedFrame.homeScore !== auditPrevHome ||
      _lastCommittedFrame.awayScore !== auditPrevAway
    ) {
      COLLECTOR_AUDIT.auditScoreChange({
        from: { h: auditPrevHome, a: auditPrevAway },
        to: { h: _lastCommittedFrame.homeScore, a: _lastCommittedFrame.awayScore }
      });
    }
    if (
      _lastCommittedFrame.minutes !== auditPrevMin ||
      _lastCommittedFrame.seconds !== auditPrevSec
    ) {
      var auditCtx = COLLECTOR_AUDIT.takeClockSourceContext();
      var auditPrevTotal = auditPrevMin * 60 + auditPrevSec;
      var auditNextTotal = clockToTotalSec(_lastCommittedFrame);
      COLLECTOR_AUDIT.auditClockSource({
        source: auditCtx.source || 'unknown',
        reason: auditCtx.reason || '',
        functionName: auditCtx.functionName || '_commitLocalState',
        prev: { m: auditPrevMin, s: auditPrevSec, totalSec: auditPrevTotal },
        next: {
          m: _lastCommittedFrame.minutes,
          s: _lastCommittedFrame.seconds,
          totalSec: auditNextTotal
        }
      });
      COLLECTOR_AUDIT.auditClockChange({
        from: { m: auditPrevMin, s: auditPrevSec },
        to: { m: _lastCommittedFrame.minutes, s: _lastCommittedFrame.seconds },
        totalSec: auditNextTotal
      });
    }
  },

  /**
   * 比分阀门：独立于走表/SYNC 观察室，有变化即尝试发 SCORE（或首次 SYNC 基线）。
   * @param {{ t: number, a: number, b: number, p: number }} payloadBase
   * @param {number} h 主队分
   * @param {number} a 客队分
   * @param {boolean} bypassScoreHold 是否旁路确认门禁
   * @returns {boolean} 是否已向云端发包
   */
  _applyScoreValve: function (payloadBase, h, a, bypassScoreHold) {
    var pub = _procState.published;

    if (bypassScoreHold) {
      if (!scoresDifferFromPublished(pub, h, a)) {
        _procState.scoreObserve = null;
        return false;
      }
      this._emitWsPacket(pub ? 'SCORE' : 'SYNC', payloadBase);
      _procState.scoreObserve = null;
      return true;
    }

    if (!pub) {
      this._emitWsPacket('SYNC', payloadBase);
      _procState.scoreObserve = null;
      return true;
    }

    if (!scoresDifferFromPublished(pub, h, a)) {
      _procState.scoreObserve = null;
      return false;
    }

    var needStreak = getScoreConfirmNeedStreak(pub, h, a);
    if (_procState.scoreObserve && _procState.scoreObserve.h === h && _procState.scoreObserve.a === a) {
      _procState.scoreObserve.streak += 1;
    } else {
      _procState.scoreObserve = { h: h, a: a, streak: 1, needStreak: needStreak };
    }
    if (_procState.scoreObserve.streak >= _procState.scoreObserve.needStreak) {
      this._emitWsPacket('SCORE', payloadBase);
      _procState.scoreObserve = null;
      return true;
    }
    return false;
  },

  /**
   * OCR 帧提纯核心：5 大防抖阀门，仅在状态翻转时向云端发包。
   *
   * 阀门 1 — 假停表防御：同一秒持续 >1200ms 才发 STOP。
   * 阀门 2 — SYNC 观察室：落差 >2 秒连续 5 帧稳定才 SYNC；timeValid=false 保持静默。
   * 阀门 3 — 高位频闪：截断误读门限从 3 帧拉高到 6 帧（见 _applyScoreValve，与时间解耦）。
   * 阀门 4 — 24 秒影子：不向 24 秒表发 START/STOP，仅 S_RESET（人工改分路径触发）。
   * 阀门 5 — 允许回退：比分/时间可倒退，稳定 N 帧即老实发包。
   *
   * @param {{
   *   homeScore: number,
   *   awayScore: number,
   *   minutes: number,
   *   seconds: number,
   *   timeValid: boolean,
   *   wallMs?: number,
   *   bypassScoreHold?: boolean,
   *   resumeSnap?: boolean
   * }} input OCR 提纯输入
   * @returns {void}
   */
  processOcrFrame: function (input) {
    if (!input || input.homeScore === null || input.awayScore === null) return;
    var now = input.wallMs || Date.now();
    var h = Number(input.homeScore) || 0;
    var a = Number(input.awayScore) || 0;
    var period = this.data.period;
    var shotClock = this.data.shotClock;
    var timeInfo = input.timeValid
      ? { minutes: Number(input.minutes) || 0, seconds: Number(input.seconds) || 0 }
      : null;
    var t = timeInfo
      ? clockToTotalSec(timeInfo)
      : (_procState.published
        ? getPublishedClockSecAt(now)
        : clockToTotalSec({ minutes: this.data.minutes, seconds: this.data.seconds }));
    var pub = _procState.published;
    var refT = _procState.lastOcrSec >= 0
      ? _procState.lastOcrSec
      : (pub ? pub.t : t);
    var payloadBase = { t: t, a: h, b: a, p: period };

    // 比分阀门优先：与时间 SYNC/START/STOP 解耦，避免观察室 return 或 frameKey 去重导致 SCORE 永不发出
    this._applyScoreValve(payloadBase, h, a, !!input.bypassScoreHold);

    // 阀门 2：遮挡 / 闪电调表 → SYNC 观察室（遇 null 保持静默）
    if (timeInfo && refT >= 0) {
      var jump = Math.abs(t - refT);
      if (jump > OCR_SYNC_JUMP_THRESHOLD_SEC) {
        COLLECTOR_AUDIT.auditOcrJump({
          jump: jump,
          from: refT,
          to: t,
          resumeSnap: !!input.resumeSnap,
          periodReset: isLikelyPeriodClockReset(refT, t)
        });
        if (input.resumeSnap || isLikelyPeriodClockReset(refT, t)) {
          var snapPeriod = period;
          if (isLikelyPeriodClockReset(refT, t) && snapPeriod < 8) {
            snapPeriod += 1;
            period = snapPeriod;
            this.setData({ period: snapPeriod });
            payloadBase.p = snapPeriod;
            this._emitWsPacket('PERIOD', payloadBase);
            logOcrV5Diag('period_auto_advance', { period: snapPeriod, ocrSec: t });
          }
          this._emitWsPacket('SYNC', payloadBase);
          this._emitWsPacket('START', payloadBase);
          _procState.syncObserve = null;
          _procState.sameSecStreak = 0;
          _procState.sameSecFirstSeen = 0;
          _procState.lastOcrSec = t;
          auditBeforeClockMode('running', 'jump_snap', 'processOcrFrame');
          _clockMode = 'running';
          _procState.pauseConfirmed = false;
          auditBeforeClockRunning(true, 'jump_snap', 'processOcrFrame');
          _procState.clockRunning = true;
          setAuditClockSource('sync', 'jump_snap', 'processOcrFrame');
          this._commitLocalState({
            homeScore: h,
            awayScore: a,
            period: snapPeriod,
            minutes: timeInfo.minutes,
            seconds: timeInfo.seconds,
            shotClock: shotClock
          });
          return;
        }
        if (_procState.syncObserve && _procState.syncObserve.sec === t) {
          _procState.syncObserve.streak += 1;
        } else {
          _procState.syncObserve = { sec: t, streak: 1 };
        }
        if (_procState.syncObserve.streak >= OCR_SYNC_CONFIRM_STREAK) {
          var syncPayload = Object.assign({}, payloadBase, {
            t: capSyncClockStep(refT, t)
          });
          this._emitWsPacket('SYNC', syncPayload);
          if (
            !_procState.clockRunning &&
            (_clockMode === 'running' || (_procState.pauseConfirmed && t < refT))
          ) {
            this._emitWsPacket('START', syncPayload);
          }
          _procState.syncObserve = null;
          _procState.sameSecFirstSeen = now;
          _procState.sameSecStreak = 1;
          _procState.lastOcrSec = t;
        }
        setAuditClockSource('sync', 'sync_observe', 'processOcrFrame');
        this._commitLocalState({
          homeScore: h,
          awayScore: a,
          period: period,
          minutes: timeInfo.minutes,
          seconds: timeInfo.seconds,
          shotClock: shotClock
        });
        return;
      }
      _procState.syncObserve = null;
    }

    // 阀门 1：假停表防御 + START 恢复（仅大表，不涉及 24 秒表）
    if (timeInfo) {
      if (t === _procState.lastOcrSec) {
        _procState.sameSecStreak = (_procState.sameSecStreak || 0) + 1;
        if (!_procState.sameSecFirstSeen) {
          _procState.sameSecFirstSeen = now;
        }
        var holdMs = now - _procState.sameSecFirstSeen;
        if (
          _procState.clockRunning &&
          _procState.sameSecStreak >= OCR_FAKE_STOP_STREAK &&
          holdMs >= OCR_FAKE_STOP_HOLD_MS
        ) {
          this._emitWsPacket('STOP', payloadBase);
        } else if (
          !_procState.clockRunning &&
          _procState.startObserve &&
          _procState.startObserve.sec === t
        ) {
          _procState.startObserve.streak += 1;
          if (_procState.startObserve.streak >= getOcrStartConfirmStreak()) {
            this._emitWsPacket('START', payloadBase);
            _procState.startObserve = null;
          }
        }
      } else {
        var prevSec = _procState.lastOcrSec;
        _procState.sameSecFirstSeen = now;
        _procState.sameSecStreak = 1;
        _procState.lastOcrSec = t;
        if (refT >= 0 && prevSec >= 0 && t < refT) {
          var dropSec = refT - t;
          if (dropSec >= 1 && dropSec <= 5 && !_procState.clockRunning) {
            var allowStart = _procState.pauseConfirmed ||
              _clockMode === 'paused' ||
              !pub ||
              !pub.running;
            if (allowStart) {
              if (_procState.startObserve && _procState.startObserve.sec === t) {
                _procState.startObserve.streak += 1;
              } else {
                _procState.startObserve = { sec: t, streak: 1 };
              }
              if (_procState.startObserve.streak >= getOcrStartConfirmStreak()) {
                this._emitWsPacket('START', payloadBase);
                _procState.startObserve = null;
              }
            }
          } else {
            _procState.startObserve = null;
            if (dropSec === 1 && _procState.clockRunning) {
              auditBeforeClockMode('running', 'resume_detect', 'processOcrFrame');
              _clockMode = 'running';
              _procState.pauseConfirmed = false;
            }
          }
        } else {
          _procState.startObserve = null;
        }
      }
    }

    if (timeInfo) {
      if (!COLLECTOR_AUDIT.hasClockSourceContext()) {
        setAuditClockSource('ocr', 'process_frame', 'processOcrFrame');
      }
      this._commitLocalState({
        homeScore: h,
        awayScore: a,
        period: period,
        minutes: timeInfo.minutes,
        seconds: timeInfo.seconds,
        shotClock: shotClock
      });
    } else {
      if (!COLLECTOR_AUDIT.hasClockSourceContext()) {
        setAuditClockSource('ocr', 'score_only', 'processOcrFrame');
      }
      this._commitLocalState({
        homeScore: h,
        awayScore: a,
        period: period,
        minutes: this.data.minutes,
        seconds: this.data.seconds,
        shotClock: shotClock
      });
    }
  },

  // ─── 模拟加分（OCR 关闭时可用）─────────────────────

  onHomeScorePlus: function () {
    bumpManualScoreEditGate();
    var nh = this.data.homeScore + 1;
    this.setData({ homeScore: nh });
    this._emitWsPacket('SCORE', {
      t: clockToTotalSec({ minutes: this.data.minutes, seconds: this.data.seconds }),
      a: nh,
      b: this.data.awayScore,
      p: this.data.period
    });
    setAuditClockSource('manual', 'score_plus', 'onHomeScorePlus');
    this._commitLocalState({
      homeScore: nh,
      awayScore: this.data.awayScore,
      period: this.data.period,
      minutes: this.data.minutes,
      seconds: this.data.seconds,
      shotClock: this.data.shotClock
    });
  },
  onAwayScorePlus: function () {
    bumpManualScoreEditGate();
    var na = this.data.awayScore + 1;
    this.setData({ awayScore: na });
    this._emitWsPacket('SCORE', {
      t: clockToTotalSec({ minutes: this.data.minutes, seconds: this.data.seconds }),
      a: this.data.homeScore,
      b: na,
      p: this.data.period
    });
    setAuditClockSource('manual', 'score_plus', 'onAwayScorePlus');
    this._commitLocalState({
      homeScore: this.data.homeScore,
      awayScore: na,
      period: this.data.period,
      minutes: this.data.minutes,
      seconds: this.data.seconds,
      shotClock: this.data.shotClock
    });
  },
  onPeriodPlus: function () {
    bumpManualScoreEditGate();
    var cur = this.data.period;
    var np = cur < 8 ? cur + 1 : cur;
    if (cur < 8) this.setData({ period: np });
    this._emitWsPacket('PERIOD', {
      t: clockToTotalSec({ minutes: this.data.minutes, seconds: this.data.seconds }),
      a: this.data.homeScore,
      b: this.data.awayScore,
      p: np
    });
    setAuditClockSource('manual', 'period_plus', 'onPeriodPlus');
    this._commitLocalState({
      homeScore: this.data.homeScore,
      awayScore: this.data.awayScore,
      period: np,
      minutes: this.data.minutes,
      seconds: this.data.seconds,
      shotClock: this.data.shotClock
    });
  },
  onReset: function () {
    bumpManualScoreEditGate();
    this.setData({ homeScore: 0, awayScore: 0, period: 1, minutes: 10, seconds: 0, shotClock: 24 });
    var t = clockToTotalSec({ minutes: 10, seconds: 0 });
    this._emitWsPacket('SYNC', { t: t, a: 0, b: 0, p: 1 });
    this._emitWsPacket('S_RESET', { t: t, a: 0, b: 0, p: 1 });
    setAuditClockSource('manual', 'reset', 'onReset');
    this._commitLocalState({
      homeScore: 0,
      awayScore: 0,
      period: 1,
      minutes: 10,
      seconds: 0,
      shotClock: 24
    });
  }
});

// ─── 纯函数工具 ──────────────────────────────────────────────────────────────

/**
 * 计算单个 ROI 的百分比定位字符串（供 WXML style 绑定）。
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @returns {string}
 */
function _computePctStyle(x, y, w, h) {
  return 'left:' + (x * 100).toFixed(1) + '%;' +
    'top:' + (y * 100).toFixed(1) + '%;' +
    'width:' + (w * 100).toFixed(1) + '%;' +
    'height:' + (h * 100).toFixed(1) + '%;';
}

/**
 * 为 ROI 数组每个元素补充 pctStyle 字段。
 * @param {Array} rois
 * @returns {Array}
 */
function _withPctStyle(rois) {
  return rois.map(function (r) {
    return Object.assign({}, r, { pctStyle: _computePctStyle(r.x, r.y, r.w, r.h) });
  });
}

/**
 * 比分 OCR 解析参考值：多候选时选最接近的一项（已发布 / 最近有效读数 / 本地提交）。
 * @param {number} scoreIdx 0=主队, 1=客队
 * @returns {number} 无参考时返回 -1
 */
/**
 * 比分二次确认：返回本次读数是否可被采纳为新的有效比分。
 * - 等于当前 good：直接采纳（仅刷新新鲜度），并清空确认缓冲。
 * - 不等于当前 good：按分差决定连续确认次数（小分 1 次、大跳 3 次）。
 * @param {number} scoreIdx 0=主队, 1=客队
 * @param {number} value 本次解析出的比分
 * @returns {boolean} 是否采纳
 */
function getScoreAcceptStreakNeeded(scoreIdx, value) {
  var good = scoreIdx === 0 ? _ocrLastGoodHomeScore : _ocrLastGoodAwayScore;
  if (good < 0) return OCR_SCORE_ACCEPT_STREAK_SMALL;
  var delta = Math.abs(value - good);
  if (delta <= 4) return OCR_SCORE_ACCEPT_STREAK_SMALL;
  if (delta < OCR_SCORE_JUMP_CONFIRM_THRESHOLD) return OCR_SCORE_ACCEPT_STREAK_MED;
  return OCR_SCORE_ACCEPT_STREAK_LARGE;
}

function confirmScoreSample(scoreIdx, value) {
  var good = scoreIdx === 0 ? _ocrLastGoodHomeScore : _ocrLastGoodAwayScore;
  var need = getScoreAcceptStreakNeeded(scoreIdx, value);
  if (good < 0 || value === good) {
    _ocrScoreConfirmBuf[scoreIdx] = { value: value, streak: 0 };
    return true;
  }
  var buf = _ocrScoreConfirmBuf[scoreIdx];
  if (buf && buf.value === value) {
    buf.streak += 1;
  } else {
    _ocrScoreConfirmBuf[scoreIdx] = { value: value, streak: 1 };
    buf = _ocrScoreConfirmBuf[scoreIdx];
  }
  if (buf.streak >= need) {
    _ocrScoreConfirmBuf[scoreIdx] = { value: value, streak: 0 };
    return true;
  }
  return false;
}

function getScoreParseRef(scoreIdx) {
  var pub = _procState.published;
  if (scoreIdx === 0) {
    if (_ocrLastGoodHomeScore >= 0) return _ocrLastGoodHomeScore;
    if (pub) return Number(pub.a) || 0;
    if (_lastCommittedFrame) return Number(_lastCommittedFrame.homeScore) || 0;
    return -1;
  }
  if (_ocrLastGoodAwayScore >= 0) return _ocrLastGoodAwayScore;
  if (pub) return Number(pub.b) || 0;
  if (_lastCommittedFrame) return Number(_lastCommittedFrame.awayScore) || 0;
  return -1;
}

/**
 * 从 OCR 文本提取合法比分（0–OCR_SCORE_MAX）。
 * 多数字候选时优先接近 scoreIdx 侧参考分，避免无脑选更长串（如 58 vs 558）。
 * @param {string} raw OCR 原始文本
 * @param {number} [scoreIdx] 0=主队, 1=客队；省略时不做邻近优选
 * @returns {number|null}
 */
function parseScore(raw, scoreIdx) {
  if (!raw) return null;
  var text = String(raw);
  var re = /\d{1,3}/g;
  var match = null;
  var candidates = [];
  while ((match = re.exec(text))) {
    var digits = match[0];
    var start = match.index;
    var end = start + digits.length;
    var nextChar = text.charAt(end);
    var prevChar = start > 0 ? text.charAt(start - 1) : '';
    var touchesTeamLabel = nextChar === '队' || prevChar === '队';
    candidates.push({
      digits: digits,
      touchesTeamLabel: touchesTeamLabel,
      start: start
    });
  }
  if (!candidates.length) return null;

  var filtered = candidates.filter(function (item) {
    return !item.touchesTeamLabel;
  });
  if (!filtered.length) return null;

  var parsed = [];
  for (var i = 0; i < filtered.length; i++) {
    var n = parseInt(filtered[i].digits, 10);
    if (!isNaN(n) && n >= 0 && n <= OCR_SCORE_MAX) {
      parsed.push({
        value: n,
        digits: filtered[i].digits,
        start: filtered[i].start
      });
    }
  }
  if (!parsed.length) return null;
  if (parsed.length === 1) return parsed[0].value;

  var ref = typeof scoreIdx === 'number' ? getScoreParseRef(scoreIdx) : -1;
  if (ref >= 0) {
    parsed.sort(function (a, b) {
      var da = Math.abs(a.value - ref);
      var db = Math.abs(b.value - ref);
      if (da !== db) return da - db;
      if (a.digits.length !== b.digits.length) return a.digits.length - b.digits.length;
      return b.start - a.start;
    });
  } else {
    parsed.sort(function (a, b) {
      if (a.digits.length !== b.digits.length) return a.digits.length - b.digits.length;
      return b.start - a.start;
    });
  }

  return parsed[0].value;
}

/**
 * 解析记分牌时间文本。
 *
 * 增强点（针对 7 段数码管 OCR + 最后一分钟 SS.m 显示）：
 *   1. 先转大写并按 7 段数码管混淆矩阵硬替换：O/D/U/Q→0, S→5, Z→2, I/L/|→1, B→8, A→4。
 *   2. 匹配常规 MM:SS（秒必须两位），保证 05:20 / 10:00 等正常时段稳定。
 *   3. 分钟 > 节上限时由 repairSmearedGameClockMinutes 修复（如 95:19→9:19，不误伤 05:20）。
 *   4. 仍无冒号时降级 SS.m（如 59.8、12.3）：
 *      - 第一段数字 < 60 即视为剩余秒数，分钟补 0，毫秒丢弃；
 *      - 解决最后 1 分钟显示由 MM:SS 切换为 SS.m 后断崖式识别失败的问题。
 *
 * @param {string} raw OCR 原始文本
 * @returns {{ minutes: number, seconds: number } | null} 解析失败返回 null
 */
function parseTime(raw) {
  if (!raw) return null;
  var text = String(raw).toUpperCase().trim()
    .replace(/[ODUQ]/g, '0')
    .replace(/S/g, '5')
    .replace(/Z/g, '2')
    .replace(/[IL|]/g, '1')
    .replace(/B/g, '8')
    .replace(/A/g, '4');

  var strictMmss = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})\b/);
  if (strictMmss) {
    var mStrict = parseInt(strictMmss[1], 10);
    var sStrict = parseInt(strictMmss[2], 10);
    if (!isNaN(mStrict) && !isNaN(sStrict) &&
      mStrict >= 0 && mStrict <= OCR_GAME_CLOCK_MAX_MINUTES &&
      sStrict >= 0 && sStrict <= 59) {
      return { minutes: mStrict, seconds: sStrict };
    }
  }

  var mmss = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})(?!.*\d\s*[:：]\s*\d{2})/);
  if (mmss) {
    var m = parseInt(mmss[1], 10);
    var s = parseInt(mmss[2], 10);
    if (!isNaN(m) && !isNaN(s) && s >= 0 && s <= 59) {
      if (m > OCR_GAME_CLOCK_MAX_MINUTES) {
        var fixed = repairSmearedGameClockMinutes(m, s);
        if (fixed) return fixed;
      }
      if (m >= 0 && m <= 99) {
        return { minutes: m, seconds: s };
      }
    }
  }

  // SS.m 降级：仅当文本中没有任何冒号（避免 MM:SS 读丢冒号变成 MM.SS 时把分钟错当秒），
  // 且毫秒位之后不再跟随数字（避免把 "9.58" 这类误读匹配成 "9.5" / 0:9）。
  // 例：59.8 / 5.3 / 0.7 命中；9.58 / 10.58 / 59.85 不命中（保留 null 让上层走预测时钟）。
  var hasColon = text.indexOf(':') !== -1 || text.indexOf('：') !== -1;
  if (!hasColon) {
    var ssDot = text.match(/(?:^|\D)(\d{1,2})\s*[.,．。]\s*(\d)(?!\d)/);
    if (ssDot) {
      var sec = parseInt(ssDot[1], 10);
      if (!isNaN(sec) && sec >= 0 && sec < 60) {
        return { minutes: 0, seconds: sec };
      }
    }
  }

  return null;
}

/**
 * 将帧中的分:秒转为便于比较的总秒数（仅用于同节内 OCR 跳变启发式）。
 * @param {{ minutes?: number, seconds?: number }} f
 * @returns {number}
 */
function ocrFrameClockSec(f) {
  return clockToTotalSec(f);
}

function isLikelyClockReset(prevSec, nextSec, clock) {
  if (nextSec <= prevSec) return false;
  var delta = nextSec - prevSec;
  if (delta >= 20) return true;
  return delta >= OCR_CLOCK_JUMP_DROP_THRESHOLD && clock && Number(clock.seconds) === 0;
}

/**
 * 在较短墙钟间隔内，比赛时钟相对上一提交「多跳了」若干秒则视为可疑 OCR，暂缓本地提交。
 * @param {{ minutes?: number, seconds?: number }} prev
 * @param {{ minutes?: number, seconds?: number }} next
 * @param {number} wallDtMs
 * @returns {boolean}
 */
function isSuspiciousGameClockSkip(prev, next, wallDtMs) {
  if (!prev || !next || wallDtMs >= 2000) return false;
  var prevT = ocrFrameClockSec(prev);
  var nextT = ocrFrameClockSec(next);
  if (nextT >= prevT) return false;
  var drop = prevT - nextT;
  var plausible = Math.floor(wallDtMs / 280) + 5;
  return drop > plausible && drop <= 45;
}

/**
 * 相对上一提交帧的主/客分单边最大变化量。
 * @param {{ homeScore?: number, awayScore?: number } | null} prev
 * @param {number} h
 * @param {number} a
 * @returns {number}
 */
function maxScoreDeltaVsCommitted(prev, h, a) {
  if (!prev) return 0;
  return Math.max(
    Math.abs(h - (Number(prev.homeScore) || 0)),
    Math.abs(a - (Number(prev.awayScore) || 0))
  );
}

/**
 * 解析主客比分；双泵轮询单帧只更新一侧 ROI 时，另一侧回退到最近一次有效读数。
 * @param {Array<{ rawText?: string }>} rois ROI 列表（至少含主/客两项）
 * @returns {{ homeScore: number, awayScore: number } | null}
 */
function resolveOcrScorePair(rois) {
  if (!rois || rois.length < 2) return null;
  var homeScore = parseScore(rois[0] && rois[0].rawText ? rois[0].rawText : '', 0);
  var awayScore = parseScore(rois[1] && rois[1].rawText ? rois[1].rawText : '', 1);
  if (homeScore === null && _ocrLastGoodHomeScore >= 0) {
    homeScore = _ocrLastGoodHomeScore;
  }
  if (awayScore === null && _ocrLastGoodAwayScore >= 0) {
    awayScore = _ocrLastGoodAwayScore;
  }
  if (homeScore === null || awayScore === null) return null;
  return { homeScore: homeScore, awayScore: awayScore };
}

/**
 * 云端已发布比分与 OCR 帧是否不一致。
 * @param {{ a: number, b: number } | null} pub
 * @param {number} h
 * @param {number} a
 * @returns {boolean}
 */
function scoresDifferFromPublished(pub, h, a) {
  if (!pub) return true;
  return h !== pub.a || a !== pub.b;
}

/**
 * 按变化幅度计算比分确认所需连续帧数（与走表/停表解耦，仅用于 SCORE 阀门）。
 * @param {{ a: number, b: number }} pub
 * @param {number} h
 * @param {number} a
 * @returns {number}
 */
function getScoreConfirmNeedStreak(pub, h, a) {
  if (isLikelyTruncateGlitch(pub.a, h) || isLikelyTruncateGlitch(pub.b, a)) {
    return OCR_SCORE_TRUNC_STREAK;
  }
  if (isLikelyDigitInflationGlitch(pub.a, h) || isLikelyDigitInflationGlitch(pub.b, a)) {
    return OCR_SCORE_TRUNC_STREAK;
  }
  var delta = maxScoreDeltaVsCommitted({ homeScore: pub.a, awayScore: pub.b }, h, a);
  if (delta >= OCR_SCORE_JUMP_CONFIRM_THRESHOLD) {
    if (isLargeScoreDrop({ homeScore: pub.a, awayScore: pub.b }, h, a)) {
      return (h === 0 && a === 0) ? 4 : OCR_SCORE_TRUNC_STREAK;
    }
    return OCR_SCORE_JUMP_STREAK_NORMAL;
  }
  if (delta > 0 && delta <= 3) {
    return OCR_SCORE_CONFIRM_STREAK_PAUSED;
  }
  if (!_procState.clockRunning || _clockMode === 'paused') {
    return OCR_SCORE_CONFIRM_STREAK_PAUSED;
  }
  return OCR_SCORE_CONFIRM_STREAK;
}

/**
 * 判断新比分是否相对上一提交更像「高位数字被 OCR 吃掉」(如 111→11)。
 * @param {number} prev
 * @param {number} next
 * @returns {boolean}
 */
function isLikelyTruncateGlitch(prev, next) {
  if (prev == null || next == null) return false;
  if (next >= prev) return false;
  if (prev < 22 || prev - next < 9) return false;
  var ps = String(prev);
  var ns = String(next);
  if (!ns.length) return false;
  return ps.indexOf(ns) === 0;
}

/**
 * 判断新比分是否相对上一提交更像 OCR 多插 digit（如 58→558、25→258）。
 * 与 isLikelyTruncateGlitch 对称：位数变多且子串命中；基线分≥10 以降低 9→19 误伤。
 * @param {number} prev
 * @param {number} next
 * @returns {boolean}
 */
function isLikelyDigitInflationGlitch(prev, next) {
  if (prev == null || next == null) return false;
  if (next <= prev) return false;
  if (prev < 10) return false;
  var ps = String(prev);
  var ns = String(next);
  if (ns.length <= ps.length) return false;
  return ns.indexOf(ps) >= 0;
}

/** 构造解析后比赛帧的去重 key（仅用于 OCR → setData 去重，非「N 帧一致」门禁）。 */
function buildFrameKey(frame) {
  return [
    frame.homeScore,
    frame.awayScore,
    frame.period,
    frame.minutes,
    frame.seconds,
    frame.shotClock
  ].join('|');
}

function collectAnchorTexts(anchors) {
  if (!anchors || !anchors.length) return [];
  var list = [];
  for (var i = 0; i < anchors.length; i++) {
    var t = anchors[i] && typeof anchors[i].text === 'string' ? anchors[i].text.trim() : '';
    if (t) list.push(t);
  }
  return list;
}

/**
 * 为主/客分 ROI 打包 Worker 用小图（禁止传整帧）。
 * @param {Uint8Array} rgba 全帧
 * @param {number} frameWidth
 * @param {number} frameHeight
 * @param {Array<{ x: number, y: number, w: number, h: number, label?: string }>} rois
 * @returns {Array<{ roiIndex: number, buffer: ArrayBuffer, width: number, height: number }>}
 */
function packScoreRoiPatchesForWorker(rgba, frameWidth, frameHeight, rois) {
  var patches = [];
  if (!rgba || !frameWidth || !frameHeight || !rois) return patches;
  for (var i = 0; i < 2; i++) {
    if (!rois[i]) continue;
    var rect = buildRoiCropRect(frameWidth, frameHeight, rois[i]);
    if (!rect) continue;
    var crop = cropRgbaRect(rgba, frameWidth, frameHeight, rect);
    if (!crop) continue;
    patches.push({
      roiIndex: i,
      buffer: crop.buffer,
      width: crop.width,
      height: crop.height
    });
  }
  return patches;
}

function cropRgbaCandidatesByRoi(rgba, frameWidth, frameHeight, roi) {
  var rect = buildRoiCropRect(frameWidth, frameHeight, roi);
  if (!rect) return [];
  if (roi.label === '主队分') {
    return buildCropVariants(rgba, frameWidth, frameHeight, [
      rect,
      expandRect(rect, frameWidth, frameHeight, { dx: -0.08, dy: -0.08, dw: 0.16, dh: 0.16 }),
      expandRect(rect, frameWidth, frameHeight, { dx: 0.08, dy: -0.04, dw: -0.08, dh: 0.08 })
    ]);
  }
  if (roi.label === '客队分') {
    return buildCropVariants(rgba, frameWidth, frameHeight, [
      rect,
      expandRect(rect, frameWidth, frameHeight, { dx: -0.08, dy: -0.08, dw: 0.16, dh: 0.16 }),
      expandRect(rect, frameWidth, frameHeight, { dx: 0.00, dy: -0.04, dw: -0.10, dh: 0.08 })
    ]);
  }
  if (roi.label === '时间') {
    return buildCropVariants(rgba, frameWidth, frameHeight, [
      rect,
      expandRect(rect, frameWidth, frameHeight, { dx: -0.06, dy: -0.12, dw: 0.12, dh: 0.24 }),
      expandRect(rect, frameWidth, frameHeight, { dx: 0.04, dy: -0.06, dw: -0.08, dh: 0.12 })
    ]);
  }
  return buildCropVariants(rgba, frameWidth, frameHeight, [rect]);
}

function buildCropVariants(rgba, frameWidth, frameHeight, rects) {
  var crops = [];
  for (var i = 0; i < rects.length; i++) {
    var crop = cropRgbaRect(rgba, frameWidth, frameHeight, rects[i]);
    if (crop) crops.push(crop);
  }
  return crops;
}

function buildRoiCropRect(frameWidth, frameHeight, roi) {
  if (!frameWidth || !frameHeight || !roi) return null;
  var x = Math.max(0, Math.floor(roi.x * frameWidth));
  var y = Math.max(0, Math.floor(roi.y * frameHeight));
  var w = Math.max(8, Math.floor(roi.w * frameWidth));
  var h = Math.max(8, Math.floor(roi.h * frameHeight));

  if (roi.label === '主队分') {
    x = Math.max(0, x - Math.floor(w * 0.04));
    w = Math.min(frameWidth - x, Math.floor(w * 1.04));
  } else if (roi.label === '客队分') {
    x = Math.max(0, x - Math.floor(w * 0.04));
    w = Math.min(frameWidth - x, Math.floor(w * 1.04));
  } else if (roi.label === '时间') {
    y = Math.max(0, y - Math.floor(h * 0.08));
    h = Math.min(frameHeight - y, Math.floor(h * 1.16));
  }

  var padX = Math.max(2, Math.floor(w * 0.05));
  var padY = Math.max(2, Math.floor(h * (roi.label === '时间' ? 0.06 : 0.10)));
  x = Math.max(0, x - padX);
  y = Math.max(0, y - padY);
  w = Math.min(frameWidth - x, w + padX * 2);
  h = Math.min(frameHeight - y, h + padY * 2);
  if (w <= 0 || h <= 0) return null;
  return { x: x, y: y, w: w, h: h };
}

function expandRect(rect, frameWidth, frameHeight, delta) {
  if (!rect) return null;
  var dx = Math.floor(rect.w * (delta.dx || 0));
  var dy = Math.floor(rect.h * (delta.dy || 0));
  var dw = Math.floor(rect.w * (delta.dw || 0));
  var dh = Math.floor(rect.h * (delta.dh || 0));
  var x = Math.max(0, rect.x + dx);
  var y = Math.max(0, rect.y + dy);
  var w = Math.min(frameWidth - x, Math.max(8, rect.w + dw));
  var h = Math.min(frameHeight - y, Math.max(8, rect.h + dh));
  if (w <= 0 || h <= 0) return null;
  return { x: x, y: y, w: w, h: h };
}

function cropRgbaRect(rgba, frameWidth, frameHeight, rect) {
  if (!rgba || !rect) return null;
  var x = rect.x;
  var y = rect.y;
  var w = rect.w;
  var h = rect.h;
  if (w <= 0 || h <= 0) return null;
  var out = new Uint8Array(w * h * 4);
  for (var row = 0; row < h; row++) {
    var srcStart = ((y + row) * frameWidth + x) * 4;
    var srcEnd = srcStart + w * 4;
    out.set(rgba.subarray(srcStart, srcEnd), row * w * 4);
  }
  return {
    buffer: out.buffer,
    width: w,
    height: h
  };
}

function summarizeAnchorForLog(anchor) {
  if (!anchor || typeof anchor !== 'object') return anchor;
  return {
    id: anchor.id,
    type: anchor.type,
    text: anchor.text,
    hasPoints: !!(anchor.points && anchor.points.length),
    pointsLen: anchor.points && anchor.points.length ? anchor.points.length : 0,
    hasBox: !!(anchor.box && anchor.box.length),
    boxLen: anchor.box && anchor.box.length ? anchor.box.length : 0,
    centerX: typeof anchor.centerX === 'number' ? anchor.centerX : null,
    centerY: typeof anchor.centerY === 'number' ? anchor.centerY : null,
    origin: anchor.origin || null,
    size: anchor.size || null,
    keys: Object.keys(anchor).slice(0, 12)
  };
}

function extractAnchorCenter(anchor) {
  if (!anchor || typeof anchor !== 'object') return null;

  var pts = anchor.points;
  if (pts && pts.length) {
    var px = 0;
    var py = 0;
    for (var i = 0; i < pts.length; i++) {
      px += Number(pts[i].x) || 0;
      py += Number(pts[i].y) || 0;
    }
    px = px / pts.length;
    py = py / pts.length;
    return normalizeAnchorPoint(px, py, 'points');
  }

  var box = anchor.box;
  if (box && box.length) {
    var bx = 0;
    var by = 0;
    for (var bi = 0; bi < box.length; bi++) {
      bx += Number(box[bi].x) || 0;
      by += Number(box[bi].y) || 0;
    }
    bx = bx / box.length;
    by = by / box.length;
    return normalizeAnchorPoint(bx, by, 'box');
  }

  if (typeof anchor.centerX !== 'undefined' && typeof anchor.centerY !== 'undefined') {
    return normalizeAnchorPoint(Number(anchor.centerX) || 0, Number(anchor.centerY) || 0, 'center');
  }

  var origin = anchor.origin;
  var size = anchor.size;
  if (origin && size) {
    return normalizeAnchorPoint(
      (Number(origin.x) || 0) + (Number(size.width) || 0) / 2,
      (Number(origin.y) || 0) + (Number(size.height) || 0) / 2,
      'origin+size'
    );
  }

  if (origin && typeof origin.x !== 'undefined' && typeof origin.y !== 'undefined') {
    return normalizeAnchorPoint(Number(origin.x) || 0, Number(origin.y) || 0, 'origin');
  }

  return null;
}

function normalizeAnchorPoint(x, y, source) {
  if (!isFinite(x) || !isFinite(y)) return null;
  var nx = x;
  var ny = y;
  if (nx > 1 || ny > 1) {
    nx = nx / (_previewW || 667);
    ny = ny / (_previewH || 375);
  }
  if (!isFinite(nx) || !isFinite(ny)) return null;
  return { x: nx, y: ny, source: source };
}

function buildOcrQueue(now, rois) {
  var isStrictRecovery = _ocrRecoveryModeUntil && (now < _ocrRecoveryModeUntil);
  if (isStrictRecovery) {
    var recoveryElapsed = _ocrRecoveryModeUntil - now;
    if (recoveryElapsed > 2500) { // 4000ms 降到 2500ms 之间，即前 1.5 秒
      console.log("[OCR Recovery] 爆裂模式：强驱时间 ROI 快速建锚");
      return [2];
    }
  }

  var n = OCR_ROI_COUNT;
  var due = [];
  var intervals = [OCR_SCORE_REFRESH_MS, OCR_SCORE_REFRESH_MS, OCR_TIME_REFRESH_MS];
  var i;
  for (i = 0; i < n; i++) {
    if ((_ocrRoiBackoffUntil[i] || 0) > now) continue;
    if (shouldRunRoi(now, i, intervals[i])) due.push(i);
  }

  var timeStarved =
    (now - (_ocrLastTimeSuccessTs || 0)) >= OCR_TIME_PRIORITY_MS &&
    ((_ocrRoiBackoffUntil[2] || 0) <= now);
  if (timeStarved && due.indexOf(2) === -1) {
    due.push(2);
  }

  if (!due.length) {
    for (var fi = 0; fi < n; fi++) {
      var fallbackIdx = (fi + _ocrQueueCursor) % n;
      if ((_ocrRoiBackoffUntil[fallbackIdx] || 0) <= now) {
        due.push(fallbackIdx);
        break;
      }
    }
  }

  var missing = [];
  if ((!rois[0] || !rois[0].rawText) && ((_ocrRoiBackoffUntil[0] || 0) <= now)) missing.push(0);
  if ((!rois[1] || !rois[1].rawText) && ((_ocrRoiBackoffUntil[1] || 0) <= now)) missing.push(1);
  if ((!rois[2] || !rois[2].rawText) && ((_ocrRoiBackoffUntil[2] || 0) <= now)) missing.push(2);
  for (var mi = 0; mi < missing.length; mi++) {
    if (due.indexOf(missing[mi]) === -1) due.push(missing[mi]);
  }

  due.sort(function (a, b) {
    if (timeStarved) {
      if (a === 2 && b !== 2) return -1;
      if (b === 2 && a !== 2) return 1;
    }
    var lastA = _ocrLastRoiRunTs[a] || 0;
    var lastB = _ocrLastRoiRunTs[b] || 0;
    if (lastA !== lastB) return lastA - lastB;
    return rotationDistance(a) - rotationDistance(b);
  });

  var picked = due[0];
  _ocrQueueCursor = (picked + 1) % n;
  return [picked];
}

function shouldRunRoi(now, idx, intervalMs) {
  return now - (_ocrLastRoiRunTs[idx] || 0) >= intervalMs;
}

function rotationDistance(idx) {
  return (idx - _ocrQueueCursor + OCR_ROI_COUNT) % OCR_ROI_COUNT;
}
