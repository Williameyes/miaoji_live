/**
 * @fileoverview 采集端 (Peripheral / GATT Server + VisionKit OCR)
 *
 * Phase 3 v2：
 *   - OCR pump 节流 + 单 ROI 轮询，严禁 30 帧暴力采集
 *   - ROI 拖动/缩放拆分：mode 'move' | 'resize-se'
 *   - wx.requestAnimationFrame 节流 touchmove（局部 setData，path 语法）
 *   - OCR 锚点局部更新（只写 rawText，不覆盖坐标）
 *   - 登录 + 白名单双重门控（isLogin && isInWhitelist）
 *   - VKSession 错误过滤（saaa/node js 底层错误不弹 Toast）
 *   - BLE 校验升级为 CRC-8/SMBUS（ble-protocol.js v2）
 *
 * 长时运行（数小时直播）：
 *   - 定时温和重建 VK 会话；手动 OCR 失败堆积时延迟温和重建
 *   - onHide 停相机帧泵、onShow 恢复，减轻后台无效回调
 *   - BLE notify 失败指数退避 + 定时补发，避免半连接写风暴
 *   - OCR 解析后仅按 frameKey 去重；仅 3 个 ROI（主/客分、时间），24 秒与节次改人工，减轻 CPU 与跳秒
 *   - 时间 ROI 优先调度 + 短窗「时钟回跳」暂缓整帧 notify（阈值偏保守，减少对顺计时干扰）
 *   - 现场实体记分牌由技术台改分为主；大单帧比分跳变用 streak 确认，截断式误读(111→11)要求更多连续一致帧
 *   - 比分待确认时仍推送「上一已确认比分 + 新时间」，避免时间因整帧暂缓而累积跳秒
 *
 * ROI 选区数据结构（归一化坐标，相对于相机预览区）：
 *   { x: 0-1, y: 0-1, w: 0-1, h: 0-1, label: string, rawText: string, pctStyle: string }
 */

var BLE = require('../../../utils/ble-protocol.js');
var REQ = require('../../../utils/request.js');

var STORAGE_KEY_ROIS = 'sync_lab_rois_v1';
/** 当前 OCR 队列 ROI 数量：主队分、客队分、时间（已移除 24 秒 ROI）。 */
var OCR_ROI_COUNT = 3;
var OCR_MIN_INTERVAL_BASE_MS = 160;
var OCR_MIN_INTERVAL_MS = 160;
var OCR_PUMP_INTERVAL_MS = 120;
/** 单 ROI runOCR 默认超时（比分引擎使用） */
var OCR_RUN_TIMEOUT_MS = 720;
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
 * ocrSec - lostSec）抵消，BLE 推送的依然是当前真实时钟。
 */
var OCR_TIME_RUN_TIMEOUT_MS = 1500;
/**
 * 任何 OCR 超时后强制等待 350ms 再提交下一次 runOCR：
 * 给 SDK 内部清队列的时间窗口，避免立刻补刀让队列雪崩。
 */
var OCR_TIMEOUT_SETTLE_MS = 350;
var OCR_MAX_VARIANTS_PER_RUN = 3;
var OCR_SCORE_TICK_INTERVAL = 8;
var OCR_TIME_PREDICT_MAX_STALE_MS = 5000;
/** 预测补秒定时器基准 / 最后一分钟激进值 */
var OCR_CLOCK_PREDICT_TICK_BASE_MS = 250;
var OCR_CLOCK_PREDICT_TICK_FINAL_MS = 100;
/** 当前生效的预测补秒间隔（运行时根据 final-minute 模式动态切换） */
var OCR_CLOCK_PREDICT_TICK_MS = OCR_CLOCK_PREDICT_TICK_BASE_MS;
var OCR_CLOCK_PREDICT_ACTIVE_MS = 4500;
var OCR_CLOCK_CATCHUP_MAX_DROP_SEC = 20;
var OCR_CLOCK_CATCHUP_FAST_INTERVAL_MS = 520;
var OCR_CLOCK_NORMAL_INTERVAL_MS = 900;
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
var OCR_TIME_REFRESH_MS = 160;
/** 比分 ROI 刷新间隔（放宽，把更多 OCR 槽让给时钟；比分另有确认门禁）。 */
var OCR_SCORE_REFRESH_MS = 1200;
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
/** 长时运行：约 50 分钟温和重建 VK 会话，降低 session 僵死与内存爬升风险 */
var OCR_SESSION_REBUILD_MS = 50 * 60 * 1000;
var OCR_SESSION_ROTATE_MS = 18 * 60 * 1000;
/** 健康检查间隔（重建判定、后台恢复） */
var OCR_HEALTH_INTERVAL_MS = 60 * 1000;
/** 连续 runOCR 超时/异常达到该次数后触发温和重建（滑动窗口内） */
var OCR_MANUAL_FAIL_THRESHOLD = 8;
var OCR_MANUAL_FAIL_WINDOW_MS = 90 * 1000;
/** BLE notify 失败后最大退避（毫秒），避免半连接时写特征风暴 */
var BLE_NOTIFY_BACKOFF_MAX_MS = 8000;
var BLE_NOTIFY_BACKOFF_BASE_MS = 220;
var ROI_MIN_SIZE = 0.05; // 归一化最小宽/高，防止缩至 0

var DEFAULT_ROIS = [
  { x: 0.05, y: 0.15, w: 0.25, h: 0.20, label: '主队分', rawText: '' },
  { x: 0.70, y: 0.15, w: 0.25, h: 0.20, label: '客队分', rawText: '' },
  { x: 0.30, y: 0.35, w: 0.40, h: 0.18, label: '时间', rawText: '' }
];

/** @type {WechatMiniprogram.BLEPeripheralServer | null} */
var _server = null;
var _connectedDeviceId = '';
var _cameraContext = null;
var _cameraFrameListener = null;
var _ocrVkCanvas = null;
var _ocrVkGl = null;

/** @type {any} VKSession 实例 */
var _vkSession = null;
var _lastHandleTs = 0;   // OCR 锚点兜底门控时间戳
var _pendingOcrFrame = null;
var _lastCommittedFrameKey = '';
var _bleStarting = false;
var _ocrBootTimer = 0;
var _ocrCameraRemountTimer = 0;
var _ocrSessionToken = 0;
var _ocrAnchorWatchdogTimer = 0;
var _ocrAnchorEventCount = 0;
var _ocrNativeTextEventCount = 0;
var _ocrAnchorLogSeq = 0;
var _ocrPumpTimer = 0;
var _ocrPumpFrameCount = 0;
var _ocrPumpLastTickTs = 0;
var _ocrRunBusy = false;
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
/** 预测时钟：OCR 短时掉帧时根据墙钟平滑补秒，减轻恢复后跳秒。 */
var _predictedClock = null;
var _predictedClockWallTs = 0;
/** 最近一次成功 BLE 提交的墙钟时间戳（供单帧时钟回跳检测）。 */
var _lastNotifyWallAt = 0;
/** 待下一帧复核的帧快照（时间疑似 OCR 跳变时暂缓 _notify）。 */
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
var _clockMode = 'unknown'; // 'unknown' | 'running' | 'paused'
var _lastOcrClockSec = -1;
var _lastOcrClockWallTs = 0;
var _sameOcrClockSince = 0;
var _clockPauseCandidateUntil = 0;
var _clockResumeCandidateSec = -1;
var _clockResumeCandidateSince = 0;
/** JUMP 候选：异常跳跃需连续 OCR_CLOCK_JUMP_HOLD_MS 维持同值才确认 */
var _clockJumpCandidateSec = -1;
var _clockJumpCandidateSince = 0;
/** 双频双泵节流阀（墙钟时间戳） */
var _lastTimePumpTs = 0;
var _lastScorePumpTs = 0;
/** 比分泵 round-robin 游标（0=主队分, 1=客队分） */
var _scorePumpCursor = 0;
/** 是否进入最后一分钟极限调度模式（minutes===0 && seconds<=60） */
var _isFinalMinuteMode = false;
/** 是否因小程序 onHide 暂停了相机帧泵（onShow 恢复） */
var _ocrPausedForBackground = false;
/** BLE notify 退避截止时刻 */
var _bleNotifyBackoffUntil = 0;
/** BLE notify 失败次数（用于指数退避） */
var _bleNotifyFailStreak = 0;
/** 退避结束后补发一次的定时器 */
var _bleNotifyRetryTimer = 0;

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
  return roiIdx === 2 ? 2 : 1;
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

function getPredictedClock() {
  if (!_predictedClock) return null;
  if (!_predictedClockWallTs) return cloneClock(_predictedClock);
  var age = Date.now() - _predictedClockWallTs;
  if (_clockMode === 'paused') return cloneClock(_predictedClock);
  if (_clockMode !== 'running') {
    if (age > OCR_TIME_PREDICT_MAX_STALE_MS) return null;
    return cloneClock(_predictedClock);
  }
  var baseSec = clockToTotalSec(_predictedClock);
  var maxAge = Math.max(OCR_TIME_PREDICT_MAX_STALE_MS, (baseSec + 2) * 1000);
  if (age > maxAge) return null;
  return subtractClock(_predictedClock, Math.floor(age / 1000));
}

function updatePredictedClock(clock) {
  _predictedClock = cloneClock(clock);
  _predictedClockWallTs = Date.now();
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

function filterClockByMode(clock) {
  if (!clock) return null;
  if (_clockMode === 'paused' && _predictedClock) {
    var nextSec = clockToTotalSec(clock);
    var predSec = clockToTotalSec(_predictedClock);
    if (nextSec !== predSec && !isLikelyClockReset(predSec, nextSec, clock)) return null;
  }
  return clock;
}

// ─────────────────────────────────────────────────────────────────────────────

Page({
  data: {
    statusBarHeight: 0,
    /** 登录 + 白名单双重门控 */
    isLogin: false,
    isInWhitelist: false,
    // BLE 状态
    bleState: 'idle',
    bleStateText: '未开启',
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
    ocrTransitioning: false
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
  },

  onCameraError: function (e) {
    console.error('[Collector] camera error', e.detail);
    wx.showToast({ title: '相机启动失败', icon: 'none' });
  },

  onUnload: function () {
    this._stopOcr(true);
    this._stopAll();
    wx.setKeepScreenOn({ keepScreenOn: false });
  },

  /**
   * 小程序进入后台：停止相机帧监听，减少无意义回调与半停相机导致的堆积。
   * 不销毁 VK，回到前台后由 onShow 恢复泵（手动 OCR 模式）。
   */
  onHide: function () {
    if (!this.data.ocrEnabled) return;
    _ocrPausedForBackground = true;
    this._cancelOcrFramePump();
    console.log('[Collector][OCR] paused frame pump (onHide)');
  },

  /**
   * 回到前台：若 OCR 仍开启且此前因后台暂停了帧泵，在手动模式下重新挂载监听。
   */
  onShow: function () {
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
    this._notify({
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
    if (this.data.ocrTransitioning) return;
    if (this.data.ocrEnabled || _vkSession || _ocrBootTimer) {
      this._stopOcr(false);
      return;
    }
    this._startOcr();
  },

  onToggleDebug: function () {
    this.setData({ debugMode: !this.data.debugMode });
  },

  _startOcr: function () {
    var token = ++_ocrSessionToken;
    this._clearOcrBootTimers();
    this._stopOcrSession();
    // 每次启动 OCR 前，彻底清空遗留脏数据，实现完全重新采集（不影响蓝牙连接、不覆盖人工维护的 period / shotClock）。
    this._wipeOcrDirtyState();
    this._prepareCameraForOcrBoot(token, 'start');
  },

  /**
   * 彻底清理 OCR 的残留状态，模拟页面重新加载。
   * 解决原地重启 OCR（或接收远程重启指令）时，因残留旧比分触发大比分下降防抖（isLargeScoreDrop），
   * 导致比分卡死、必须完全退出页面重进才能恢复的问题。
   * 严格约束：不触碰任何 BLE 相关逻辑、不重置 period / shotClock 这两个人工维护字段。
   * @returns {void}
   */
  _wipeOcrDirtyState: function () {
    console.log('[Collector][OCR] Wiping dirty state for fresh start');

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

    this.setData({
      homeScore: 0,
      awayScore: 0,
      minutes: 10,
      seconds: 0,
      rois: rois
    });

    if (typeof bumpManualScoreEditGate === 'function') {
      bumpManualScoreEditGate();
    }

    this._notify();
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
    var bootDelay = _getVkBootDelayMs();
    this._clearOcrBootTimers();
    console.log('[Collector][OCR] prepare camera for boot token=%s reason=%s bootDelay=%s', token, reason || '', bootDelay);
    this.setData({ ocrTransitioning: true, cameraMounted: true }, function () {
      self._notify();
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
    _lastHandleTs = 0;
    _pendingOcrFrame = null;
    _lastCommittedFrameKey = '';
    _lastCommittedFrame = null;
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
    _ocrLastTimeSuccessTs = Date.now();
    _timeJumpHoldFrame = null;
    _scoreJumpHold = null;
    _manualScoreEditAt = 0;
    _lastNotifyWallAt = 0;
    _lastTimePumpTs = 0;
    _lastScorePumpTs = 0;
    _scorePumpCursor = 0;
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
          self._stopOcrSession();
          self._restoreCameraPreview(function () {
            self.setData({ ocrEnabled: false, ocrTransitioning: false }, function () {
              self._notify();
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
        self._stopOcrSession();
        self._restoreCameraPreview(function () {
          self.setData({ ocrEnabled: false, ocrTransitioning: false }, function () {
            self._notify();
          });
        });
        if (!isSdkInternal) {
          wx.showToast({ title: 'OCR 启动失败', icon: 'none' });
        }
        console.error('[Collector] VKSession start fail', err);
        return;
      }
      self.setData({ ocrEnabled: true, ocrTransitioning: false }, function () {
        self._notify();
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

    // 防卫 1：引擎未处于忙碌状态。这说明这是上一轮超时后，SDK 慢半拍送回来的迟到事件，坚决丢弃，防止张冠李戴。
    if (!_ocrRunState || !_ocrRunBusy) {
      if (this.data.debugMode) {
        console.log('[Collector][OCR] drop delayed anchor event (engine not busy)');
      }
      return;
    }

    // 防卫 2：极速折返拦截。微信 OCR 最快也要 150ms 以上。如果本次请求发出去不足 80ms 就收到了回调，
    // 物理上不可能这么快，这百分之百是上一轮极度迟到的幽灵事件，坚决丢弃！
    if (Date.now() - _ocrRunStartedAt < 80) {
      if (this.data.debugMode) {
        console.warn('[Collector][OCR] drop impossible fast event. age=' + (Date.now() - _ocrRunStartedAt));
      }
      return;
    }

    // 清理本次真实的超时定时器
    if (_ocrRunTimeout) {
      clearTimeout(_ocrRunTimeout);
      _ocrRunTimeout = 0;
    }

    var roiIdx = _ocrRunState.currentIdx;
    var text = collectAnchorTexts(list).join(' ').trim();
    if (this.data.debugMode) {
      console.log('[Collector][OCR] roi result idx=%s label=%s text=%s anchors=%s sample=%o', roiIdx, this.data.rois[roiIdx] && this.data.rois[roiIdx].label, text, list.length, list.length ? summarizeAnchorForLog(list[0]) : null);
    }
    _ocrStats.success += 1;
    _ocrConsecutiveTimeout = 0;
    OCR_MIN_INTERVAL_MS = OCR_MIN_INTERVAL_BASE_MS;
    if (this._shouldRetryCurrentVariant(roiIdx, text)) {
      this._advanceCurrentVariantOrQueue('invalid-text');
      return;
    }
    _ocrRoiTextSeq[roiIdx] = (_ocrRoiTextSeq[roiIdx] || 0) + 1;
    if (roiIdx === 2) {
      var captureTs = (_ocrRunState && _ocrRunState.captureTs) || Date.now();
      this._recordOcrClockSample(parseTime(text), captureTs);
    }
    _ocrRunState.updatedRoiIdx = roiIdx;
    _ocrRunState.rawTexts[roiIdx] = text;
    this._applyPartialOcrPreview(_ocrRunState.rawTexts, roiIdx);
    _ocrRunState.queuePos += 1;
    this._runNextRoiOcr();
  },

  /**
   * OCR 时间样本入口（带流水线延迟补偿与非对称信任状态机）。
   *
   * 状态机三态：
   *   - PAUSE：连续 OCR_CLOCK_PAUSE_HOLD_MS 读到同一秒，认定停表，强制对齐预测时钟。
   *   - RESUME：从 paused 切到 running 时（drop 在 1~2 秒内）立即推送 BLE，无需等待。
   *   - JUMP：上跳或下跳 > OCR_CLOCK_JUMP_DROP_THRESHOLD 秒，需连续 OCR_CLOCK_JUMP_HOLD_MS
   *           维持同值才视为人工改表，确认后强制覆盖并立即推送 BLE。
   *
   * 流水线补偿：
   *   - 由于摄像帧 → runOCR → updateAnchors 之间存在 ms 级延迟，
   *     用 captureTs 推算 lostSec，得到「绝对真实秒」realWorldSec = ocrSec - lostSec。
   *
   * @param {{ minutes: number, seconds: number } | null} parsedTime parseTime 输出
   * @param {number} frameCaptureTs 调用 runOCR 之前的墙钟戳
   * @returns {void}
   */
  _recordOcrClockSample: function (parsedTime, frameCaptureTs) {
    if (!parsedTime) return;
    var now = Date.now();
    _ocrLastTimeSuccessTs = now;

    // === 1) 流水线延迟补偿：把 OCR 读到的秒数倒推到「现在的真实秒」 ===
    var processDelayMs = frameCaptureTs ? Math.max(0, now - frameCaptureTs) : 0;
    var lostSec = Math.floor(processDelayMs / 1000);
    var ocrSec = clockToTotalSec(parsedTime);
    var realWorldSec = Math.max(0, ocrSec - lostSec);
    var realClock = clockFromTotalSec(realWorldSec);

    var prevOcrSec = _lastOcrClockSec;
    var prevOcrWallTs = _lastOcrClockWallTs || now;

    if (!_predictedClock || prevOcrSec < 0) {
      _lastOcrClockSec = realWorldSec;
      _lastOcrClockWallTs = now;
      updatePredictedClock(realClock);
      _lastClockPredictEmitSec = realWorldSec;
      _sameOcrClockSince = now;
      _clockMode = 'unknown';
      _clockJumpCandidateSec = -1;
      _clockJumpCandidateSince = 0;
      this._maybeApplyFinalMinuteMode(realClock);
      return;
    }

    var delta = realWorldSec - prevOcrSec;
    var dropSec = -delta;

    // === 2) 大跨度跳变 / 回表确认（JUMP）===
    if (isLikelyClockReset(prevOcrSec, ocrSec, parsedTime)) {
      var resetClock = cloneClock(parsedTime) || realClock;
      var resetSec = clockToTotalSec(resetClock);
      if (this.data.debugMode) {
        console.log('[Collector][OCR] CLOCK RESET accepted prev=%s now=%s', prevOcrSec, resetSec);
      }
      _clockMode = 'paused';
      _lastOcrClockSec = resetSec;
      _lastOcrClockWallTs = now;
      _sameOcrClockSince = now;
      _clockPauseCandidateUntil = 0;
      _clockResumeCandidateSec = -1;
      _clockResumeCandidateSince = 0;
      _clockJumpCandidateSec = -1;
      _clockJumpCandidateSince = 0;
      updatePredictedClock(resetClock);
      _lastClockPredictEmitSec = resetSec;
      this._clearClockPredictTimer();
      this._maybeApplyFinalMinuteMode(resetClock);
      this._emitTimeOnlyIfChanged(resetClock, now, true);
      return;
    }

    if (delta > 0 || dropSec > OCR_CLOCK_JUMP_DROP_THRESHOLD) {
      if (_clockJumpCandidateSec === realWorldSec) {
        if (now - _clockJumpCandidateSince >= OCR_CLOCK_JUMP_HOLD_MS) {
          if (this.data.debugMode) {
            console.log('[Collector][OCR] CLOCK JUMP confirmed prev=%s now=%s drop=%s', prevOcrSec, realWorldSec, dropSec);
          }
          // 技术台人工改表后（如回表到 5:00），比赛通常即将继续或处于随时开球的死球状态。
          // 设为 running 让预测时钟立刻接管并平滑输出，避免 OCR 慢半拍时停摆。
          _clockMode = 'running';
          _lastOcrClockSec = realWorldSec;
          _lastOcrClockWallTs = now;
          _sameOcrClockSince = now;
          _clockPauseCandidateUntil = 0;
          _clockResumeCandidateSec = -1;
          _clockResumeCandidateSince = 0;
          _clockJumpCandidateSec = -1;
          _clockJumpCandidateSince = 0;
          updatePredictedClock(realClock);
          _lastClockPredictEmitSec = realWorldSec;
          this._clearClockPredictTimer();
          this._maybeApplyFinalMinuteMode(realClock);
          this._emitTimeOnlyIfChanged(realClock, now, true);
        }
      } else {
        _clockJumpCandidateSec = realWorldSec;
        _clockJumpCandidateSince = now;
        if (this.data.debugMode) {
          console.log('[Collector][OCR] CLOCK JUMP candidate prev=%s next=%s drop=%s', prevOcrSec, realWorldSec, dropSec);
        }
      }
      return;
    }

    // 走出 JUMP 候选窗口后清空
    _clockJumpCandidateSec = -1;
    _clockJumpCandidateSince = 0;

    // === 3) 停表强校准（PAUSE）===
    if (delta === 0) {
      _lastOcrClockSec = realWorldSec;
      _lastOcrClockWallTs = now;
      _clockResumeCandidateSec = -1;
      _clockResumeCandidateSince = 0;
      if (!_sameOcrClockSince) _sameOcrClockSince = prevOcrWallTs;
      _clockPauseCandidateUntil = now + OCR_CLOCK_PAUSE_HOLD_MS;
      if (now - _sameOcrClockSince >= OCR_CLOCK_PAUSE_HOLD_MS) {
        if (_clockMode !== 'paused' && this.data.debugMode) {
          console.log('[Collector][OCR] CLOCK PAUSE confirmed at sec=%s', realWorldSec);
        }
        _clockMode = 'paused';
        updatePredictedClock(realClock);
        _lastClockPredictEmitSec = realWorldSec;
        this._clearClockPredictTimer();
        this._maybeApplyFinalMinuteMode(realClock);
      }
      return;
    }

    // === 4) 秒启恢复（RESUME）/ 正常下降 ===
    var wasPaused = (_clockMode === 'paused');
    _lastOcrClockSec = realWorldSec;
    _lastOcrClockWallTs = now;
    _sameOcrClockSince = now;
    _clockPauseCandidateUntil = 0;
    _clockResumeCandidateSec = -1;
    _clockResumeCandidateSince = 0;
    _clockMode = 'running';
    updatePredictedClock(realClock);
    _lastClockPredictEmitSec = realWorldSec;
    _clockPredictUntil = Math.max(_clockPredictUntil || 0, getClockRunUntil(now, realWorldSec));
    this._ensureClockPredictTimer();
    this._maybeApplyFinalMinuteMode(realClock);

    // 从 paused 立即恢复，无任何等待，直接推送 BLE
    if (wasPaused && dropSec >= 1 && dropSec <= OCR_CLOCK_RESUME_DROP_MAX) {
      if (this.data.debugMode) {
        console.log('[Collector][OCR] CLOCK RESUME prev=%s now=%s drop=%s (force-emit)', prevOcrSec, realWorldSec, dropSec);
      }
      this._emitTimeOnlyIfChanged(realClock, now, true);
    }
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
    if (!_clockPredictUntil || now > _clockPredictUntil) {
      this._clearClockPredictTimer();
      return;
    }
    if (_clockMode !== 'running') {
      this._clearClockPredictTimer();
      return;
    }
    if (_clockPauseCandidateUntil && now < _clockPauseCandidateUntil) return;
    var predicted = getPredictedClock();
    if (!predicted) return;
    var committedSec = ocrFrameClockSec(_lastCommittedFrame);
    if (committedSec <= 0) {
      this._clearClockPredictTimer();
      return;
    }
    var predictedSec = clockToTotalSec(predicted);
    if (predictedSec >= committedSec) return;
    var lag = committedSec - predictedSec;
    var minEmitMs = lag > 2 ? OCR_CLOCK_CATCHUP_FAST_INTERVAL_MS : OCR_CLOCK_NORMAL_INTERVAL_MS;
    if (_lastClockPredictEmitWallTs && now - _lastClockPredictEmitWallTs < minEmitMs) return;
    var emitSec = Math.max(predictedSec, committedSec - 1);
    if (emitSec === _lastClockPredictEmitSec) return;
    this._emitTimeOnlyIfChanged(clockFromTotalSec(emitSec), now);
  },

  /**
   * 双频双泵：
   *   - 时间泵（高频 TIME_PUMP_INTERVAL）：仅取时间 ROI，最新帧入引擎，历史帧丢弃。
   *   - 比分泵（低频 SCORE_PUMP_INTERVAL）：主/客 ROI 轮询，让出运行通道给时间泵。
   *
   * 单条 VK runOCR 通道由 _ocrRunBusy 互斥；时间泵优先，比分泵在空闲且未到时间泵周期时执行。
   * 每次入泵时打包 captureTs（Date.now()），交给时间引擎做后续流水线延迟补偿。
   * @param {any} session
   * @param {number} token
   * @returns {void}
   */
  _startOcrFramePump: function (session, token) {
    var self = this;
    this._cancelOcrFramePump();
    _ocrPumpFrameCount = 0;
    _ocrPumpLastTickTs = 0;
    _lastTimePumpTs = 0;
    _lastScorePumpTs = 0;
    if (!_cameraContext || typeof _cameraContext.onCameraFrame !== 'function') {
      console.error('[Collector][OCR] onCameraFrame unavailable');
      return;
    }
    console.log('[Collector][OCR] dual-pump start time=%s score=%s', TIME_PUMP_INTERVAL, SCORE_PUMP_INTERVAL);
    try {
      _cameraFrameListener = _cameraContext.onCameraFrame(function (frame) {
        if (_vkSession !== session || token !== _ocrSessionToken) return;
        _ocrPumpFrameCount += 1;
        var frameW = frame && frame.width ? frame.width : 0;
        var frameH = frame && frame.height ? frame.height : 0;
        if (_ocrPumpFrameCount <= 3 || _ocrPumpFrameCount % 300 === 0) {
          console.log('[Collector][OCR] pump seq=%s frame=%s size=%sx%s', _ocrPumpFrameCount, !!(frame && frame.data), frameW, frameH);
        }
        if (!frame || !frame.data || frameW <= 0 || frameH <= 0) return;
        // 永远只处理最新帧：busy 时直接丢弃当前帧，不排队不积压。
        if (_ocrRunBusy) return;
        var captureTs = Date.now();
        // SDK 节流闸：上一次 OCR 超时后给 SDK OCR_TIMEOUT_SETTLE_MS 缓冲；
        // 否则连续超时会让 SDK 内部队列雪崩。
        if (captureTs < _ocrTimeoutSettleUntil) return;

        // 比分泵优先于时间泵：
        // 时间泵节奏 ~120ms 远小于单次 OCR 耗时（~150-250ms），若把时间泵放在前面，
        // 引擎刚空出又被它抢走，比分泵会被无限饿死（home/away 的 rawText 永远空，
        // 进而 _parseAndMaybeNotify 因 parseScore===null 始终 early-return，
        // 整局比赛比分卡在 0、BLE 也不会推送）。
        // 比分泵间隔较长（800ms），让它到点先抢一槽，时间泵在间隙里仍能跑 3~4 次。
        if (captureTs - _lastScorePumpTs >= SCORE_PUMP_INTERVAL) {
          _lastScorePumpTs = captureTs;
          _ocrPumpLastTickTs = captureTs;
          self._runScoreOcrEngine(session, token, frame.data, frameW, frameH, captureTs);
          return;
        }

        // 时间泵：在比分泵未到点的间隙抢占运行通道
        if (captureTs - _lastTimePumpTs >= TIME_PUMP_INTERVAL) {
          _lastTimePumpTs = captureTs;
          _ocrPumpLastTickTs = captureTs;
          self._runTimeOcrEngine(session, token, frame.data, frameW, frameH, captureTs);
        }
      });
      _cameraFrameListener.start();
    } catch (eStart) {
      console.error('[Collector][OCR] onCameraFrame start fail', eStart);
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
   * 与 _onClockPredictTick 预测时钟共同保证：BLE 推送的总是当前真实时间，而不是
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
    _ocrRunLastTs = now;
    _ocrRunBusy = true;
    _ocrBusySince = now;
    _ocrRunStartedAt = now;
    _ocrRunState = {
      type: 'time',
      session: session,
      token: token,
      frameWidth: frameW,
      frameHeight: frameH,
      rgba: new Uint8Array(rgbaBuffer),
      rawTexts: this.data.rois.map(function (roi) { return roi.rawText || ''; }),
      queue: [2],
      queuePos: 0,
      currentIdx: -1,
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
    if (!rgbaBuffer || !rgbaBuffer.byteLength) return;
    if (typeof session.runOCR !== 'function') {
      console.error('[Collector][OCR] session.runOCR unavailable');
      return;
    }
    var idx = (_scorePumpCursor % 2 === 0) ? 0 : 1;
    _scorePumpCursor += 1;
    var now = Date.now();
    _ocrRunLastTs = now;
    _ocrRunBusy = true;
    _ocrBusySince = now;
    _ocrRunStartedAt = now;
    _ocrRunState = {
      type: 'score',
      session: session,
      token: token,
      frameWidth: frameW,
      frameHeight: frameH,
      rgba: new Uint8Array(rgbaBuffer),
      rawTexts: this.data.rois.map(function (roi) { return roi.rawText || ''; }),
      queue: [idx],
      queuePos: 0,
      currentIdx: -1,
      captureTs: captureTs
    };
    if (this.data.debugMode) {
      console.log('[Collector][OCR] score engine start idx=%s frame=%sx%s', idx, frameW, frameH);
    }
    this._runNextRoiOcr();
  },

  _runNextRoiOcr: function () {
    var state = _ocrRunState;
    if (!state || !_ocrRunBusy) return;
    if (state.token !== _ocrSessionToken || _vkSession !== state.session) {
      this._finishManualOcrRun(true);
      return;
    }
    if (state.queuePos >= state.queue.length) {
      this._finishManualOcrRun(false);
      return;
    }

    state.currentIdx = state.queue[state.queuePos];
    state.currentVariants = cropRgbaCandidatesByRoi(
      state.rgba,
      state.frameWidth,
      state.frameHeight,
      this.data.rois[state.currentIdx]
    );
    state.currentVariantPos = 0;
    if (!state.currentVariants || !state.currentVariants.length) {
      console.warn('[Collector][OCR] crop empty idx=%s roi=%o', state.currentIdx, this.data.rois[state.currentIdx]);
      state.queuePos += 1;
      this._runNextRoiOcr();
      return;
    }
    this._runCurrentVariant();
  },

  _runCurrentVariant: function () {
    var self = this;
    var state = _ocrRunState;
    if (!state || !_ocrRunBusy) return;
    var roi = this.data.rois[state.currentIdx];
    var crop = state.currentVariants[state.currentVariantPos];
    if (!crop) {
      console.warn('[Collector][OCR] crop empty idx=%s roi=%o', state.currentIdx, roi);
      this._advanceCurrentVariantOrQueue('empty');
      return;
    }

    if (this.data.debugMode) {
      console.log('[Collector][OCR] runOCR idx=%s label=%s variant=%s/%s crop=%sx%s type=%s', state.currentIdx, roi.label, state.currentVariantPos + 1, state.currentVariants.length, crop.width, crop.height, state.type || 'legacy');
    }
    _ocrLastRoiRunTs[state.currentIdx] = Date.now();
    _ocrBusySince = _ocrLastRoiRunTs[state.currentIdx];
    // 超时窗口 = SDK 真实处理时间上界（time=1500ms, score=720ms）。
    // 设得过短会让 OCR 在 SDK 尚未返回时就被强行放弃 + 释放 busy，
    // 紧接着下一帧又提交新 runOCR，SDK 内部队列被堆积，单次耗时进一步恶化，
    // 形成"全部超时 + pending overflow + 状态机收不到样本"的雪崩。
    var timeoutMs = (state.type === 'time') ? OCR_TIME_RUN_TIMEOUT_MS : OCR_RUN_TIMEOUT_MS;
    _ocrRunTimeout = setTimeout(function () {
      console.warn('[Collector][OCR] runOCR timeout idx=%s label=%s crop=%sx%s type=%s', state.currentIdx, roi.label, crop.width, crop.height, state.type || 'legacy');
      _ocrRunTimeout = 0;
      if (!_ocrRunState) return;
      _ocrConsecutiveTimeout += 1;
      _ocrStats.timeout += 1;
      // 任何超时都让 SDK 喘息 OCR_TIMEOUT_SETTLE_MS，避免连发把 SDK 内部队列打爆。
      _ocrTimeoutSettleUntil = Date.now() + OCR_TIMEOUT_SETTLE_MS;
      if (state.type === 'time') {
        // 时间引擎：放弃整轮（不重试 variant），但通过 settle 窗口避免立刻补刀。
        self._recordManualOcrFailure('timeout-time');
        self._finishManualOcrRun(true);
        return;
      }
      _ocrRoiBackoffUntil[state.currentIdx] = Date.now() + 1500;
      if (_ocrConsecutiveTimeout >= 3) {
        OCR_MIN_INTERVAL_MS = 260;
      }
      self._applyPartialOcrPreview(_ocrRunState.rawTexts, -1);
      self._advanceCurrentVariantOrQueue('timeout');
    }, timeoutMs);

    try {
      state.session.runOCR({
        frameBuffer: crop.buffer,
        width: crop.width,
        height: crop.height
      });
    } catch (eRun) {
      if (_ocrRunTimeout) {
        clearTimeout(_ocrRunTimeout);
        _ocrRunTimeout = 0;
      }
      _ocrTimeoutSettleUntil = Date.now() + OCR_TIMEOUT_SETTLE_MS;
      _ocrRoiBackoffUntil[state.currentIdx] = Date.now() + 1500;
      console.error('[Collector][OCR] runOCR fail idx=%s label=%s err=%o', state.currentIdx, roi.label, eRun);
      this._advanceCurrentVariantOrQueue('fail');
    }
  },

  _advanceCurrentVariantOrQueue: function (reason) {
    var state = _ocrRunState;
    if (!state) return;
    if (reason === 'timeout' || reason === 'fail') {
      this._recordManualOcrFailure(reason);
    }
    if (state.currentVariants &&
      state.currentVariantPos + 1 < state.currentVariants.length &&
      state.currentVariantPos + 1 < getOcrMaxVariantsForRoi(state.currentIdx)) {
      state.currentVariantPos += 1;
      if (this.data.debugMode) {
        console.log('[Collector][OCR] retry variant idx=%s label=%s reason=%s next=%s/%s', state.currentIdx, this.data.rois[state.currentIdx] && this.data.rois[state.currentIdx].label, reason, state.currentVariantPos + 1, state.currentVariants.length);
      }
      this._runCurrentVariant();
      return;
    }
    state.queuePos += 1;
    this._runNextRoiOcr();
  },

  _shouldRetryCurrentVariant: function (roiIdx, text) {
    var state = _ocrRunState;
    if (!state || !state.currentVariants || state.currentVariants.length <= 1) return false;
    if (roiIdx === 0 || roiIdx === 1) {
      return parseScore(text) === null;
    }
    if (roiIdx === 2) {
      return parseTime(text) === null;
    }
    return false;
  },

  _finishManualOcrRun: function (aborted) {
    if (_ocrRunTimeout) {
      clearTimeout(_ocrRunTimeout);
      _ocrRunTimeout = 0;
    }
    var state = _ocrRunState;
    _ocrRunBusy = false;
    _ocrBusySince = 0;
    _ocrRunState = null;
    if (!aborted) _ocrTimeoutSettleUntil = 0;
    if (!state || aborted) return;
    _ocrManualFailTimestamps = [];
    var cost = Date.now() - (_ocrRunStartedAt || Date.now());
    _ocrStats.avgCost = _ocrStats.avgCost
      ? Math.round(_ocrStats.avgCost * 0.8 + cost * 0.2)
      : cost;
    if (this.data.debugMode) {
      console.log('[Collector][OCR] manual run done roiTexts=%o cost=%s', state.rawTexts, cost);
    }
    this._applyOcrRoiTexts(state.rawTexts, typeof state.updatedRoiIdx === 'number' ? state.updatedRoiIdx : -1);
  },

  _stopOcr: function (skipRemount) {
    var self = this;
    var token = ++_ocrSessionToken;
    var releaseAndFinalize = function () {
      if (token !== _ocrSessionToken) return;
      if (_ocrBootTimer) {
        clearTimeout(_ocrBootTimer);
        _ocrBootTimer = 0;
      }
      self._stopOcrSession();
      if (skipRemount) {
        self.setData({ ocrEnabled: false, ocrTransitioning: false }, function () {
          self._notify();
        });
        return;
      }
      self._remountCameraAfterOcrStop(function () {
        if (token !== _ocrSessionToken) return;
        self.setData({ ocrEnabled: false, ocrTransitioning: false }, function () {
          self._notify();
        });
      });
    };

    if (skipRemount) {
      releaseAndFinalize();
      return;
    }

    this.setData({ ocrEnabled: false, ocrTransitioning: true }, function () {
      self._notify();
      setTimeout(releaseAndFinalize, 0);
    });
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
    _ocrRunLastTs = 0;
    _ocrRunStartedAt = 0;
    _ocrTimeoutSettleUntil = 0;
    _ocrQueueCursor = 0;
    _ocrTick = 0;
    _ocrManualMode = false;
    _ocrLastRoiRunTs = [0, 0, 0];
    _ocrRoiBackoffUntil = [0, 0, 0];
    _ocrRoiTextSeq = [0, 0, 0];
    _ocrLastTimeSuccessTs = Date.now();
    if (!preserveClock) {
      _predictedClock = null;
      _predictedClockWallTs = 0;
      _clockMode = 'unknown';
      _lastOcrClockSec = -1;
      _lastOcrClockWallTs = 0;
      _sameOcrClockSince = 0;
      _clockPauseCandidateUntil = 0;
      _clockResumeCandidateSec = -1;
      _clockResumeCandidateSince = 0;
      _clockJumpCandidateSec = -1;
      _clockJumpCandidateSince = 0;
      this._clearClockPredictTimer();
      _lastNotifyWallAt = 0;
      _lastCommittedFrame = null;
    }
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
      console.warn('[Collector][OCR] manual fail threshold reached reason=%s count=%s', reason, _ocrManualFailTimestamps.length);
      _ocrManualFailTimestamps = [];
      var self = this;
      setTimeout(function () {
        self._softRestartOcrSession('manual-fail');
      }, 0);
    }
  },

  /**
   * 温和重建 VK OCR 会话：不关闭 BLE，不打断用户「OCR 已开」状态，仅 stop/destroy 后重新 boot。
   * @param {string} reason 日志用原因
   */
  _softRestartOcrSession: function (reason) {
    if (!this.data.ocrEnabled || this.data.ocrTransitioning) return;
    console.warn('[Collector][OCR] soft VK session rebuild reason=%s', reason || '');
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
    this._cancelOcrFramePump();
    if (_ocrRunTimeout) {
      clearTimeout(_ocrRunTimeout);
      _ocrRunTimeout = 0;
    }
    _ocrRunBusy = false;
    _ocrBusySince = 0;
    _ocrRunState = null;
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
    var next = {};
    var changed = false;
    var homeScore = parseScore(rois[0].rawText);
    var awayScore = parseScore(rois[1].rawText);
    var timeInfo = updatedRoiIdx === 2 ? filterClockByMode(parseTime(rois[2].rawText)) : null;
    if (!timeInfo) timeInfo = getPredictedClock();
    if (timeInfo && _lastCommittedFrame) {
      var prevT = ocrFrameClockSec(_lastCommittedFrame);
      var previewT = clockToTotalSec(timeInfo);
      if (previewT < prevT - 1 && prevT - previewT <= OCR_CLOCK_CATCHUP_MAX_DROP_SEC) {
        timeInfo = clockFromTotalSec(prevT - 1);
      }
    }

    if (homeScore !== null && homeScore !== this.data.homeScore && shouldPreviewScore(0, homeScore)) {
      next.homeScore = homeScore;
      changed = true;
    }
    if (awayScore !== null && awayScore !== this.data.awayScore && shouldPreviewScore(1, awayScore)) {
      next.awayScore = awayScore;
      changed = true;
    }
    if (timeInfo) {
      if (timeInfo.minutes !== this.data.minutes) {
        next.minutes = timeInfo.minutes;
        changed = true;
      }
      if (timeInfo.seconds !== this.data.seconds) {
        next.seconds = timeInfo.seconds;
        changed = true;
      }
    }

    if (!changed) return;
    var previewKey = [
      typeof next.homeScore === 'number' ? next.homeScore : this.data.homeScore,
      typeof next.awayScore === 'number' ? next.awayScore : this.data.awayScore,
      typeof next.minutes === 'number' ? next.minutes : this.data.minutes,
      typeof next.seconds === 'number' ? next.seconds : this.data.seconds
    ].join('|');
    if (previewKey === _lastPreviewFrameKey) return;
    _lastPreviewFrameKey = previewKey;
    if (this.data.debugMode) {
      console.log('[Collector][OCR] preview update=%o', next);
    }
    this.setData(next);
  },

  /**
   * 推送「上一已确认比分 + 新时间」到 BLE 与 data，避免比分待确认时时间停更。
   *
   * 默认（force=false）：仅允许时间下降 ≤1 秒；下降 >1 秒走平滑（每次只前进 1 秒）。
   * 强制（force=true）：状态机在 RESUME / JUMP 确认后调用，跳过所有平滑保护，
   *                    即时把 realWorldSec 推上蓝牙以消除积压。
   *
   * @param {{ minutes: number, seconds: number } | null} timeInfo
   * @param {number} wallMs
   * @param {boolean} [force] 是否绕过平滑保护强制 emit
   * @returns {void}
   */
  _emitTimeOnlyIfChanged: function (timeInfo, wallMs, force) {
    if (!timeInfo || !_lastCommittedFrame) return;
    var prevT = ocrFrameClockSec(_lastCommittedFrame);
    var newT = (Number(timeInfo.minutes) || 0) * 60 + (Number(timeInfo.seconds) || 0);
    if (newT === prevT) return;
    if (!force) {
      if (newT > prevT) return;
      var drop = prevT - newT;
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
    var snap = {
      homeScore: _lastCommittedFrame.homeScore,
      awayScore: _lastCommittedFrame.awayScore,
      period: this.data.period,
      minutes: timeInfo.minutes,
      seconds: timeInfo.seconds,
      shotClock: this.data.shotClock
    };
    this.setData({
      minutes: snap.minutes,
      seconds: snap.seconds,
      homeScore: snap.homeScore,
      awayScore: snap.awayScore,
      period: snap.period,
      shotClock: snap.shotClock
    });
    _lastNotifyWallAt = wallMs;
    _lastClockPredictEmitWallTs = wallMs;
    _lastClockPredictEmitSec = newT;
    // 与 _parseAndMaybeNotify 路径共享去重 key，避免 force-emit 后下一帧的 commit 又触发同样负载。
    _lastCommittedFrameKey = buildFrameKey(snap);
    this._notify(snap);
    this._maybeApplyFinalMinuteMode(timeInfo);
  },

  _smoothFrameClockForCommit: function (frame, wallMs, hasTimeInfo) {
    if (!_lastCommittedFrame || !hasTimeInfo) return frame;
    var prevT = ocrFrameClockSec(_lastCommittedFrame);
    var nextT = ocrFrameClockSec(frame);
    if (nextT >= prevT) return frame;
    var drop = prevT - nextT;
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
   * 解析 ROI 文字 → 比赛状态；节次与 24 秒仅人工，OCR 不解析。
   * 对「短墙钟间隔内比赛时钟异常回跳」暂缓整帧 notify，待下一帧复核。
   */
  _parseAndMaybeNotify: function (rois, updatedRoiIdx) {
    var homeScore = parseScore(rois[0].rawText);
    var awayScore = parseScore(rois[1].rawText);
    var ocrTimeInfo = updatedRoiIdx === 2
      ? filterClockByMode(parseTime(rois[2] && rois[2].rawText ? rois[2].rawText : ''))
      : null;
    var timeInfo = ocrTimeInfo;
    // _ocrLastTimeSuccessTs 只在时间 ROI 真实产出时更新，避免旧 rawText 被反复当成新时钟样本。
    if (!timeInfo) timeInfo = getPredictedClock();

    if (homeScore === null || awayScore === null) {
      if (this.data.debugMode) {
        console.log('[Collector][OCR] parse skip home=%s away=%s raw=%o', homeScore, awayScore, rois.map(function (r) { return r.rawText; }));
      }
      return;
    }

    var wallPre = Date.now();
    var bypassScoreJumpHold =
      wallPre - (_manualScoreEditAt || 0) < OCR_SCORE_JUMP_MANUAL_GUARD_MS;
    if (bypassScoreJumpHold) {
      _scoreJumpHold = null;
    } else if (_lastCommittedFrame) {
      var dMax = maxScoreDeltaVsCommitted(_lastCommittedFrame, homeScore, awayScore);
      if (dMax >= OCR_SCORE_JUMP_CONFIRM_THRESHOLD) {
        if (isLargeScoreDrop(_lastCommittedFrame, homeScore, awayScore)) {
          _scoreJumpHold = {
            homeScore: homeScore,
            awayScore: awayScore,
            streak: 0,
            since: wallPre,
            blockedDrop: true,
            homeSeq: _ocrRoiTextSeq[0] || 0,
            awaySeq: _ocrRoiTextSeq[1] || 0
          };
          if (this.data.debugMode) {
            console.log('[Collector][OCR] score drop blocked prev=%o h=%s a=%s seq=%o', _lastCommittedFrame, homeScore, awayScore, _ocrRoiTextSeq);
          }
          this._emitTimeOnlyIfChanged(timeInfo, wallPre);
          return;
        }
        var truncH = isLikelyTruncateGlitch(_lastCommittedFrame.homeScore, homeScore);
        var truncA = isLikelyTruncateGlitch(_lastCommittedFrame.awayScore, awayScore);
        var needStreak = (truncH || truncA) ? OCR_SCORE_JUMP_STREAK_TRUNC : OCR_SCORE_JUMP_STREAK_NORMAL;
        var changedHome = Math.abs(homeScore - _lastCommittedFrame.homeScore) >= OCR_SCORE_JUMP_CONFIRM_THRESHOLD;
        var changedAway = Math.abs(awayScore - _lastCommittedFrame.awayScore) >= OCR_SCORE_JUMP_CONFIRM_THRESHOLD;
        var homeSeq = _ocrRoiTextSeq[0] || 0;
        var awaySeq = _ocrRoiTextSeq[1] || 0;

        if (
          Math.abs(homeScore - _lastCommittedFrame.homeScore) <= OCR_SCORE_JUMP_REVERT_EPSILON &&
          Math.abs(awayScore - _lastCommittedFrame.awayScore) <= OCR_SCORE_JUMP_REVERT_EPSILON
        ) {
          _scoreJumpHold = null;
        } else if (
          _scoreJumpHold &&
          _scoreJumpHold.homeScore === homeScore &&
          _scoreJumpHold.awayScore === awayScore
        ) {
          var hasFreshScoreRead = false;
          if (changedHome && _scoreJumpHold.homeSeq !== homeSeq) {
            _scoreJumpHold.homeSeq = homeSeq;
            hasFreshScoreRead = true;
          }
          if (changedAway && _scoreJumpHold.awaySeq !== awaySeq) {
            _scoreJumpHold.awaySeq = awaySeq;
            hasFreshScoreRead = true;
          }
          if (hasFreshScoreRead) {
            _scoreJumpHold.streak = (_scoreJumpHold.streak || 1) + 1;
          }
        } else {
          _scoreJumpHold = {
            homeScore: homeScore,
            awayScore: awayScore,
            streak: 1,
            since: wallPre,
            homeSeq: homeSeq,
            awaySeq: awaySeq
          };
        }

        if (_scoreJumpHold && (_scoreJumpHold.streak || 1) < needStreak) {
          if (this.data.debugMode) {
            console.log(
              '[Collector][OCR] score jump hold dMax=%s need=%s streak=%s h=%s a=%s trunc=%s/%s',
              dMax,
              needStreak,
              _scoreJumpHold.streak,
              homeScore,
              awayScore,
              truncH,
              truncA
            );
          }
          this._emitTimeOnlyIfChanged(timeInfo, wallPre);
          return;
        }
        _scoreJumpHold = null;
      } else {
        _scoreJumpHold = null;
      }
    } else {
      _scoreJumpHold = null;
    }

    var hasFrameClock = !!ocrTimeInfo;
    var period = this.data.period;
    var shotClock = this.data.shotClock;
    var frame = {
      homeScore: homeScore,
      awayScore: awayScore,
      period: period,
      minutes: timeInfo ? timeInfo.minutes : this.data.minutes,
      seconds: timeInfo ? timeInfo.seconds : this.data.seconds,
      shotClock: shotClock
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
    if (this.data.debugMode) {
      console.log('[Collector][OCR] parsed frame=%o key=%s', frame, frameKey);
    }
    if (frameKey === _lastCommittedFrameKey) {
      _pendingOcrFrame = null;
      return;
    }
    if (this.data.debugMode) {
      console.log('[Collector][OCR] immediate commit=%o prev=%o', frame, _lastCommittedFrame);
    }
    this.setData({
      homeScore: frame.homeScore,
      awayScore: frame.awayScore,
      period: frame.period,
      minutes: frame.minutes,
      seconds: frame.seconds,
      shotClock: frame.shotClock
    });
    _pendingOcrFrame = null;
    _lastCommittedFrameKey = frameKey;
    _lastRejectedStableFrameKey = '';
    _lastRejectedStableFrameCount = 0;
    _lastNotifyWallAt = wall;
    _lastClockPredictEmitWallTs = wall;
    _lastClockPredictEmitSec = ocrFrameClockSec(frame);
    this._notify(frame);
    this._maybeApplyFinalMinuteMode({ minutes: frame.minutes, seconds: frame.seconds });
  },

  // ─── BLE：启动 / 停止 ────────────────────────────────

  onStartTap: function () {
    if (_bleStarting || this.data.bleState !== 'idle') return;
    var self = this;
    _bleStarting = true;
    this.setData({ bleStateText: '初始化蓝牙…' });
    this._stopAll(function () {
      wx.openBluetoothAdapter({
        mode: 'peripheral',
        success: function () { self._createServer(); },
        fail: function (err) {
          _bleStarting = false;
          self.setData({ bleState: 'idle', bleStateText: '蓝牙初始化失败' });
          wx.showToast({ title: '蓝牙初始化失败', icon: 'none' });
          console.error('[Collector] openBluetoothAdapter fail', err);
        }
      });
    }, true);
  },

  _createServer: function () {
    var self = this;
    var code = BLE.generateMatchCode();
    this.setData({ matchCode: code });
    wx.createBLEPeripheralServer({
      success: function (res) {
        _server = res.server;
        self._addServiceAndAdvertise(BLE.DEVICE_NAME_PREFIX + code);
      },
      fail: function (err) {
        _bleStarting = false;
        self.setData({ bleState: 'idle', bleStateText: '创建GATT服务失败' });
        wx.showToast({ title: '创建GATT服务失败', icon: 'none' });
        console.error('[Collector] createBLEPeripheralServer fail', err);
      }
    });
  },

  _addServiceAndAdvertise: function (deviceName) {
    var self = this;
    if (!_server) return;
    _server.addService({
      service: {
        uuid: BLE.SERVICE_UUID,
        characteristics: [{
          uuid: BLE.CHAR_SCORE_UUID,
          properties: { read: true, notify: true, indicate: true, write: true, writeNoResponse: true },
          permission: {
            read: true, readEncrypted: false,
            write: true, writeEncrypted: false,
            readable: true, readEncryptionRequired: false,
            writeable: true, writeEncryptionRequired: false
          },
          descriptors: [{
            uuid: BLE.CCCD_UUID,
            permission: { read: true, write: true }
          }],
          value: new ArrayBuffer(BLE.PACKET_LENGTH)
        }]
      },
      success: function () {
        self._bindServerEvents();
        self._startAdv(deviceName);
      },
      fail: function (err) {
        _bleStarting = false;
        self.setData({ bleState: 'idle', bleStateText: '注册特征值失败' });
        wx.showToast({ title: '注册特征值失败，请重试', icon: 'none' });
        console.error('[Collector] addService fail', err);
      }
    });
  },

  _buildBlePacketValue: function (snapshot) {
    var d = snapshot || _lastCommittedFrame || this.data;
    return BLE.encodePacket({
      homeScore: d.homeScore,
      awayScore: d.awayScore,
      period: d.period,
      minutes: d.minutes,
      seconds: d.seconds,
      shotClock: d.shotClock,
      ocrEnabled: !!this.data.ocrEnabled,
      ocrTransitioning: !!this.data.ocrTransitioning
    });
  },

  _safeServerWriteCharacteristicValue: function (options, label) {
    if (!_server) return;
    try {
      var ret = _server.writeCharacteristicValue(options);
      if (ret && typeof ret.catch === 'function') {
        ret.catch(function (err) {
          if (typeof options.fail !== 'function') {
            console.warn('[Collector] peripheral write rejected label=%s err=%o', label || '', err);
          }
        });
      }
    } catch (err) {
      if (typeof options.fail === 'function') {
        options.fail(err);
      } else {
        console.warn('[Collector] peripheral write throw label=%s err=%o', label || '', err);
      }
    }
  },

  _bindServerEvents: function () {
    var self = this;
    if (!_server) return;
    try { wx.offBLEPeripheralConnectionStateChanged(); } catch (e) { }

    wx.onBLEPeripheralConnectionStateChanged(function (res) {
      if (res.connected) {
        _connectedDeviceId = res.deviceId || '';
        _bleNotifyFailStreak = 0;
        _bleNotifyBackoffUntil = 0;
        if (_bleNotifyRetryTimer) {
          clearTimeout(_bleNotifyRetryTimer);
          _bleNotifyRetryTimer = 0;
        }
        self.setData({ bleState: 'connected', bleStateText: '已连接 ✓' });
        wx.vibrateShort({ type: 'medium' });
        console.log('[Collector] Central connected:', _connectedDeviceId);
      } else {
        _connectedDeviceId = '';
        if (_bleNotifyRetryTimer) {
          clearTimeout(_bleNotifyRetryTimer);
          _bleNotifyRetryTimer = 0;
        }
        _bleNotifyFailStreak = 0;
        _bleNotifyBackoffUntil = 0;
        self.setData({ bleState: 'advertising', bleStateText: '广播中，等待连接…' });
        console.log('[Collector] Central disconnected');
      }
    });

    _server.onCharacteristicReadRequest(function (res) {
      if (!_server) return;
      var d = _lastCommittedFrame || self.data;
      self._safeServerWriteCharacteristicValue({
        serviceId: BLE.SERVICE_UUID,
        characteristicId: BLE.CHAR_SCORE_UUID,
        value: self._buildBlePacketValue(d),
        needNotify: false,
        callbackId: res && res.callbackId,
        callbackType: 'read'
      }, 'read');
    });

    if (typeof _server.onCharacteristicWriteRequest === 'function') {
      _server.onCharacteristicWriteRequest(function (res) {
        var cmd = -1;
        var validCommand = false;
        try {
          var charId = String((res && res.characteristicId) || '').toLowerCase();
          var isScoreChar = !charId || charId === String(BLE.CHAR_SCORE_UUID).toLowerCase();
          var value = res && res.value;
          var view = value ? new Uint8Array(value) : null;
          if (isScoreChar && view && view.length >= 1) {
            cmd = view[0] & 0xFF;
            validCommand = cmd === 0x00 || cmd === 0x01;
            if (!validCommand) {
              console.warn('[Collector][BLE] unknown remote command:', cmd);
            }
          }
        } catch (eWrite) {
          console.error('[Collector][BLE] write request handling fail', eWrite);
        }
        try {
          if (_server) {
            self._safeServerWriteCharacteristicValue({
              serviceId: BLE.SERVICE_UUID,
              characteristicId: BLE.CHAR_SCORE_UUID,
              value: self._buildBlePacketValue(),
              needNotify: false,
              callbackId: res && res.callbackId,
              callbackType: 'write'
            }, 'write-ack');
          }
        } catch (eAck) {
          console.warn('[Collector][BLE] write ack fail', eAck);
        }
        if (!validCommand) {
          return;
        }
        if (cmd === 0x00) {
          console.log('[Collector][BLE] remote OCR stop');
          self._stopOcr(false);
        } else if (cmd === 0x01) {
          console.log('[Collector][BLE] remote OCR start');
          if (!self.data.ocrEnabled && !self.data.ocrTransitioning && !_vkSession && !_ocrBootTimer) {
            self._startOcr();
          } else {
            self._notify();
          }
        }
      });
    }
  },

  _startAdv: function (deviceName) {
    var self = this;
    if (!_server) return;
    _server.startAdvertising({
      advertiseRequest: {
        connectable: true,
        deviceName: deviceName,
        serviceUuids: [BLE.SERVICE_UUID]
      },
      success: function () {
        _bleStarting = false;
        self.setData({ bleState: 'advertising', bleStateText: '广播中，等待连接…' });
      },
      fail: function (err) {
        _bleStarting = false;
        self.setData({ bleState: 'idle', bleStateText: '广播启动失败' });
        wx.showToast({ title: '广播启动失败', icon: 'none' });
        console.error('[Collector] startAdvertising fail', err);
      }
    });
  },

  onStopTap: function () {
    this._stopOcr(false);
    this._stopAll();
    this.setData({ bleState: 'idle', bleStateText: '未开启', matchCode: '' });
  },

  _stopAll: function () {
    var doneCalled = false;
    var finish = arguments[0];
    var keepStarting = !!arguments[1];
    var finalize = function () {
      if (doneCalled) return;
      doneCalled = true;
      if (typeof finish === 'function') finish();
    };

    try { wx.offBLEPeripheralConnectionStateChanged(); } catch (e) { }
    if (_bleNotifyRetryTimer) {
      clearTimeout(_bleNotifyRetryTimer);
      _bleNotifyRetryTimer = 0;
    }
    _bleNotifyFailStreak = 0;
    _bleNotifyBackoffUntil = 0;
    if (_server) {
      try { _server.stopAdvertising(); } catch (e) { }
      try { _server.close(); } catch (e) { }
      _server = null;
    }
    _connectedDeviceId = '';
    if (!keepStarting) _bleStarting = false;
    try {
      wx.closeBluetoothAdapter({
        complete: function () { finalize(); }
      });
    } catch (e) {
      finalize();
    }
  },

  // ─── 模拟加分（OCR 关闭时可用）─────────────────────

  onHomeScorePlus: function () {
    bumpManualScoreEditGate();
    var nh = this.data.homeScore + 1;
    this.setData({ homeScore: nh });
    this._notify({
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
    this._notify({
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
    this._notify({
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
    this._notify({
      homeScore: 0,
      awayScore: 0,
      period: 1,
      minutes: 10,
      seconds: 0,
      shotClock: 24
    });
  },

  // ─── BLE 推送 notify ─────────────────────────────────

  /**
   * 在退避窗口结束后补发：使用 `_lastCommittedFrame` 编码，与 `_notify` 写入的快照一致。
   * @returns {void}
   */
  _flushBleNotifyIfReady: function () {
    var self = this;
    if (!_server || !_connectedDeviceId) return;
    var now = Date.now();
    if (now < _bleNotifyBackoffUntil) {
      if (!_bleNotifyRetryTimer) {
        var waitMs = Math.max(50, _bleNotifyBackoffUntil - now);
        _bleNotifyRetryTimer = setTimeout(function () {
          _bleNotifyRetryTimer = 0;
          self._flushBleNotifyIfReady();
        }, waitMs);
      }
      return;
    }
    var d = _lastCommittedFrame;
    if (!d) return;
    this._safeServerWriteCharacteristicValue({
      serviceId: BLE.SERVICE_UUID,
      characteristicId: BLE.CHAR_SCORE_UUID,
      value: this._buildBlePacketValue(d),
      needNotify: true,
      success: function () {
        _bleNotifyFailStreak = 0;
        _bleNotifyBackoffUntil = 0;
        console.log('[Collector] notify ok', d.homeScore, d.awayScore, d.minutes, d.seconds, d.shotClock);
      },
      fail: function (err) {
        if (isBlePeripheralNotInitError(err)) {
          if (_bleNotifyRetryTimer) {
            clearTimeout(_bleNotifyRetryTimer);
            _bleNotifyRetryTimer = 0;
          }
          _connectedDeviceId = '';
          _bleNotifyFailStreak = 0;
          _bleNotifyBackoffUntil = 0;
          self.setData({ bleState: 'advertising', bleStateText: '连接失效，等待重连…' });
          console.warn('[Collector] notify channel not init, stop retrying until reconnect err=%o', err);
          return;
        }
        _bleNotifyFailStreak = Math.min(_bleNotifyFailStreak + 1, 12);
        var pow = Math.min(Math.max(_bleNotifyFailStreak - 1, 0), 8);
        var backoff = Math.min(
          BLE_NOTIFY_BACKOFF_MAX_MS,
          Math.round(BLE_NOTIFY_BACKOFF_BASE_MS * Math.pow(2, pow))
        );
        _bleNotifyBackoffUntil = Date.now() + backoff;
        console.warn('[Collector] notify fail — backoff %sms streak=%s err=%o', backoff, _bleNotifyFailStreak, err);
        if (!_bleNotifyRetryTimer) {
          _bleNotifyRetryTimer = setTimeout(function () {
            _bleNotifyRetryTimer = 0;
            self._flushBleNotifyIfReady();
          }, backoff);
        }
      }
    }, 'notify');
  },

  /**
   * 同步「已提交」状态并尝试 BLE notify。
   * @param {{ homeScore?: number, awayScore?: number, period?: number, minutes?: number, seconds?: number, shotClock?: number } | void} snapshot 若传入则写入 `_lastCommittedFrame` 并用于后续 encode；否则用当前 `this.data`（仅适合未与 setData 交叉的调用）。
   * @returns {void}
   */
  _notify: function (snapshot) {
    if (snapshot && typeof snapshot === 'object') {
      _lastCommittedFrame = {
        homeScore: Number(snapshot.homeScore) || 0,
        awayScore: Number(snapshot.awayScore) || 0,
        period: Number(snapshot.period) || 1,
        minutes: Number(snapshot.minutes) || 0,
        seconds: Number(snapshot.seconds) || 0,
        shotClock: Number(snapshot.shotClock) || 0,
        ocrEnabled: !!this.data.ocrEnabled,
        ocrTransitioning: !!this.data.ocrTransitioning
      };
    } else {
      _lastCommittedFrame = {
        homeScore: this.data.homeScore,
        awayScore: this.data.awayScore,
        period: this.data.period,
        minutes: this.data.minutes,
        seconds: this.data.seconds,
        shotClock: this.data.shotClock,
        ocrEnabled: !!this.data.ocrEnabled,
        ocrTransitioning: !!this.data.ocrTransitioning
      };
    }
    if (!_server || !_connectedDeviceId) return;
    this._flushBleNotifyIfReady();
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

/** 从字符串中提取合法比分数字（0-999）。 */
function parseScore(raw) {
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
    if (!isNaN(n) && n >= 0 && n <= 999) {
      parsed.push({
        value: n,
        digits: filtered[i].digits,
        start: filtered[i].start
      });
    }
  }
  if (!parsed.length) return null;

  parsed.sort(function (a, b) {
    if (a.digits.length !== b.digits.length) return b.digits.length - a.digits.length;
    return b.start - a.start;
  });

  return parsed[0].value;
}

/**
 * 解析记分牌时间文本。
 *
 * 增强点（针对 7 段数码管 OCR + 最后一分钟 SS.m 显示）：
 *   1. 先转大写并按 7 段数码管混淆矩阵硬替换：O/D/U/Q→0, S→5, Z→2, I/L/|→1, B→8, A→4。
 *   2. 优先匹配常规 MM:SS（秒必须两位），保证 10:00 / 09:58 等正常时段稳定。
 *   3. 匹配失败时，降级匹配最后一分钟的 SS.m（如 59.8、12.3）：
 *      - 第一段数字 < 60 即视为剩余秒数，分钟补 0，毫秒丢弃；
 *      - 解决最后 1 分钟显示由 MM:SS 切换为 SS.m 后断崖式识别失败的问题。
 *
 * @param {string} raw OCR 原始文本
 * @returns {{ minutes: number, seconds: number } | null} 解析失败返回 null
 */
function parseTime(raw) {
  if (!raw) return null;
  var text = String(raw)
    .toUpperCase()
    .replace(/[ODUQ]/g, '0')
    .replace(/S/g, '5')
    .replace(/Z/g, '2')
    .replace(/[IL|]/g, '1')
    .replace(/B/g, '8')
    .replace(/A/g, '4');

  var mmss = text.match(/(\d{1,2})\s*[:：]\s*(\d{2})(?!.*\d\s*[:：]\s*\d{2})/);
  if (mmss) {
    var m = parseInt(mmss[1], 10);
    var s = parseInt(mmss[2], 10);
    if (!isNaN(m) && !isNaN(s) && m >= 0 && m <= 10 && s >= 0 && s <= 59) {
      if (m === 10 && s !== 0) return null;
      return { minutes: m, seconds: s };
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

function isBlePeripheralNotInitError(err) {
  if (!err) return false;
  var msg = String(err.errMsg || err.message || '').toLowerCase();
  return Number(err.errCode || err.errno || 0) === 10000 && msg.indexOf('not init') !== -1;
}

/**
 * 在较短墙钟间隔内，比赛时钟相对上一提交「多跳了」若干秒则视为可疑 OCR，暂缓 notify。
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
  var plausible = Math.floor(wallDtMs / 280) + 4;
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
