const app = getApp();

const { get, getToken, post, STORAGE_USER_INFO_KEY } = require('../../utils/request.js');
const { API_PATH_CLIENT_DIAGNOSTIC_LOG } = require('../../config/api.js');
const { parseExpireAtToMs } = require('../../utils/referral.js');
const storageEst = require('../../utils/file-storage-estimate.js');
const clipsStorage = require('../../utils/miaoxie-clips-storage.js');
const renderPipelineMod = require('../../utils/render/render-pipeline.js');
const vkCanvasRecorderMod = require('../../utils/render/vk-canvas-recorder.js');
const eventBus = require('../../utils/eventBus.js');
const bleManager = require('../../services/bleManager.js');
const SHARE_IMAGE_URL = '/assets/images/global_share_card-1-288.png';

/** 回放缩放离散档位（捏合吸附 / 双击等共用，至 3x 后下一轮回到 1x） */
const REPLAY_ZOOM_LEVELS = [1, 1.5, 2, 2.5, 3];
/** 与档位比较的容差，避免浮点抖动 */
const REPLAY_ZOOM_LEVEL_EPS = 0.04;
/** 判定为同一点双击的最大间隔（ms） */
const REPLAY_DOUBLE_TAP_INTERVAL_MS = 340;
/** 两次点击允许的最大位移（px） */
const REPLAY_DOUBLE_TAP_SLOP_PX = 48;
/**
 * 全指抬起后仍用捏合焦点公式处理 bindscale 的时长（ms），避免末帧 scale 落在 touchend 之后导致回弹到 (0,0)。
 */
const REPLAY_PINCH_SCALE_TAIL_MS = 120;
/** 捏合松手后等待原生末帧 bindscale 再吸附（ms） */
const REPLAY_PINCH_SNAP_DEFER_MS = 56;
/** 捏合吸附 + 居中动画时长（ms），略长于双击动画减轻突兀感 */
const REPLAY_PINCH_SNAP_ANIM_MS = 420;
/** 相对捏合起始 scale 判定「张开 / 捏拢」意图的阈值 */
const REPLAY_PINCH_INTENT_DELTA = 0.07;
/** 捏合吸附：位移与 scale 均过小则跳过动画，避免微抖 */
const REPLAY_PINCH_SNAP_EPS_SCALE = 0.018;
const REPLAY_PINCH_SNAP_EPS_PX = 2.5;
/** 双击缩放动画时长（ms），缓动为 ease-out（立方） */
const REPLAY_ZOOM_ANIM_MS = 300;
/** 判定为拖拽的最小位移（px），超过则取消本次单击/双击识别 */
const REPLAY_TAP_MOVE_SLOP_PX = 15;
/** 边界夹紧时的浮点余量，减轻与原生 out-of-bounds 判定冲突 */
const REPLAY_PAN_CLAMP_EPS = 0.5;

/** 双指下滑唤醒曝光/对焦条：中点下移阈值（px），与捏合区分 */
const AE_TWO_FINGER_DOWN_PX = 52;
/** 双指间距变化超过此比例视为缩放手势，不触发下滑唤醒 */
const AE_PINCH_VS_SWIPE_DIST_RATIO = 0.06;
/** 直播态曝光控件无操作自动隐藏（ms） */
const AE_LIVE_AUTO_HIDE_MS = 3000;
/** 变焦结束后静默中心对焦防抖（ms），避免捏合过程中重复调 API */
const AE_POST_ZOOM_SILENT_FOCUS_MS = 300;
/** 录制中曝光条 setData 节流（ms），减轻与编码器同机竞争 */
const AE_EXPOSURE_SETDATA_THROTTLE_MS = 100;
/** 单击锁定对焦：最大位移判定为轻点（px） */
const AE_PRE_TAP_SLOP_PX = 20;
/** 对焦点方框边长（rpx），与 live.wxss 中 .ae-focus-bracket 一致 */
const AE_BRACKET_RPX = 56;
/** 对焦点方框上两次 tap 判为双击锁定的最大间隔（ms），略宽以适配部分机型的 tap 时序 */
const AE_BRACKET_DOUBLE_TAP_MS = 650;
/**
 * 仅对焦方框+下方提示的预估额外高度（rpx），靠底边夹紧时用。
 */
const AE_CLUSTER_EXTRA_BELOW_RPX = 40;
/** 卸原生 camera 后再起 VKSession 的等待（ms）；iOS 句柄释放更慢，过短易黑屏 / start 失败 */
const VK_BOOT_DELAY_MS_ANDROID = 760;
const VK_BOOT_DELAY_MS_IOS = 980;
/** 从 VK 切回原生：rebuild 回调后额外延迟再 mount camera（ms），给 GL/VK 释放留窗 */
const VK_POST_TEARDOWN_MOUNT_EXTRA_MS_IOS = 220;
/** 画质档位连点防抖（ms），覆盖 VK 与相机重建重叠窗口 */
const ENHANCE_SWITCH_GUARD_MS = 1000;
/**
 * 严重存储弹窗延迟（ms）：避免与横屏 setPageOrientation、权益通过后的 setData 同帧抢 wx.showModal，
 * 部分基础库在首帧/nextTick 调 showModal 会静默失败。
 */
const LIVE_STORAGE_SEVERE_MODAL_DELAY_MS = 560;
const HIGHLIGHT_LOCK_TIMEOUT = 3000;
const HIGHLIGHT_LOCK_TIMEOUT_MAX_MS = 11000;
const MIN_RECOVER_INTERVAL = 15000;
const RECORDER_SAFE_RESTART_DELAY_MIN_MS = 120;
const RECORDER_SAFE_RESTART_DELAY_MAX_MS = 180;
const RECORDER_STATE = {
  IDLE: 'idle',
  FLUSHING: 'flushing',
  READY: 'ready',
  STARTING: 'starting',
  RECORDING: 'recording',
  STOPPING: 'stopping',
  RECOVERING: 'recovering'
};

class RecorderCore {
  constructor(page) {
    this.page = page;
    this.state = RECORDER_STATE.IDLE;
    this.isRecovering = false;
    this.lastRecoverAt = 0;
    this.recoverFailCount = 0;
    this.pendingHighlight = null;
    this.recordSessionId = 0;
    this.lastStopAt = 0;
    this._recentFlushLagMs = 1800;
    this._ownerDepth = 0;
    this._highlightTimeoutTimer = null;
  }

  _log(eventName, detail) {
    if (!this.page || typeof this.page.appendHealthLog !== 'function') return;
    this.page.appendHealthLog(eventName, detail || {});
  }

  _mirrorPendingHighlight(pending) {
    this.pendingHighlight = pending || null;
    this.page.pendingHighlight = this.pendingHighlight;
  }

  syncSession(sessionId) {
    this.recordSessionId = Number(sessionId || 0);
  }

  isOwnerActive() {
    return this._ownerDepth > 0;
  }

  withOwner(source, action, fn) {
    this._ownerDepth += 1;
    this._log('recorder_owner_request', {
      triggerSource: source || 'unknown',
      action: action || '',
      stateBefore: this.state,
      stateAfter: this.state
    });
    try {
      return typeof fn === 'function' ? fn() : undefined;
    } finally {
      this._ownerDepth = Math.max(0, this._ownerDepth - 1);
    }
  }

  setState(nextState, source) {
    const next = nextState || RECORDER_STATE.IDLE;
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    this.isRecovering = next === RECORDER_STATE.RECOVERING;
    this._log('recorder_state_change', {
      triggerSource: source || 'unknown',
      stateBefore: prev,
      stateAfter: next
    });
  }

  enterDegradedMode(source) {
    if (this.page.data.recorderDegradedMode) return;
    this.page.setData({ recorderDegradedMode: true });
    this._log('recover_enter_degraded_mode', {
      triggerSource: source || 'unknown',
      stateBefore: this.state,
      stateAfter: this.state
    });
  }

  leaveDegradedMode() {
    if (!this.page.data.recorderDegradedMode) return;
    this.page.setData({ recorderDegradedMode: false });
  }

  setPendingHighlight(meta) {
    const page = this.page;
    const now = Date.now();
    const clickTimeRaw =
      meta && typeof meta.clickTime === 'number' && isFinite(meta.clickTime)
        ? Number(meta.clickTime)
        : now;
    const clickTime = Math.min(now, Math.max(0, clickTimeRaw));
    const pending = {
      clickTime: clickTime,
      startTime: clickTime - (page.highlightLeadMs || 8000),
      endTime: clickTime,
      id: meta.id || String(now),
      createdAt: clickTime,
      matchName: meta.matchName || (page.data.matchConfig && page.data.matchConfig.matchName) || '未命名比赛',
      matchId: meta.matchId || page.resolveMatchIdForHighlightStorage(),
      cover: meta.cover || page.data.defaultCover
    };
    if (this._highlightTimeoutTimer) {
      clearTimeout(this._highlightTimeoutTimer);
      this._highlightTimeoutTimer = null;
    }
    this._mirrorPendingHighlight(pending);
    /**
     * 稳定性优先：
     * - 3s 仅适合作为“最短锁释放时间”，不适合作为统一超时。
     * - 过去 8s 高光不再等待未来段，只需要等“包含 clickTime 的当前段”安全 stop+flush。
     * - 因此超时应覆盖“当前段剩余录制时长 + flush 裕量”，而不是固定 3s。
     * - 仍保留上限，避免真断流时永久占锁。
     */
    let timeoutMs = HIGHLIGHT_LOCK_TIMEOUT;
    const segmentDurationMs = Number(page.segmentDurationMs || 0);
    const recordStartAt = Number(page.lastRecordStartAt || 0);
    const flushLagBudgetMs = this._recentFlushLagMs || 1800;
    if (
      segmentDurationMs > 0
      && recordStartAt > 0
      && recordStartAt <= now
    ) {
      const elapsedMs = clickTime - recordStartAt;
      const remainMs = Math.max(0, segmentDurationMs - elapsedMs);
      const waitBudgetMs = remainMs + flushLagBudgetMs + 500;
      timeoutMs = Math.max(
        HIGHLIGHT_LOCK_TIMEOUT,
        Math.min(HIGHLIGHT_LOCK_TIMEOUT_MAX_MS, waitBudgetMs)
      );
    }
    this._highlightTimeoutTimer = setTimeout(() => {
      this._highlightTimeoutTimer = null;
      if (!this.pendingHighlight || this.pendingHighlight.id !== pending.id) return;
      const clickCoveredByBufferedSegment = (Array.isArray(page.rollingSegments) ? page.rollingSegments : [])
        .some((seg) =>
          seg
          && typeof seg.startTime === 'number'
          && typeof seg.endTime === 'number'
          && seg.startTime <= pending.clickTime
          && seg.endTime >= pending.clickTime
        );
      if (clickCoveredByBufferedSegment) {
        this._log('highlight_timeout_promoted_to_generate', {
          triggerSource: 'highlight_timeout',
          stateBefore: this.state,
          stateAfter: this.state,
          clickTime: pending.clickTime
        });
        this.clearPendingHighlight();
        page._generateHighlight(pending.startTime, pending.endTime, pending);
        return;
      }
      if (this.state === RECORDER_STATE.STOPPING || this.state === RECORDER_STATE.FLUSHING) {
        const extendMs = Math.max(1200, Math.min(2600, flushLagBudgetMs));
        this._log('highlight_timeout_extended_for_flush', {
          triggerSource: 'highlight_timeout',
          stateBefore: this.state,
          stateAfter: this.state,
          clickTime: pending.clickTime,
          extendMs: extendMs
        });
        this._highlightTimeoutTimer = setTimeout(() => {
          this._highlightTimeoutTimer = null;
          if (!this.pendingHighlight || this.pendingHighlight.id !== pending.id) return;
          this._log('highlight_soft_timeout_release', {
            triggerSource: 'highlight_timeout_after_extend',
            stateBefore: this.state,
            stateAfter: this.state,
            clickTime: pending.clickTime,
            timeoutMs: timeoutMs + extendMs
          });
          this.clearPendingHighlight();
          page.endHighlightSaving();
        }, extendMs);
        return;
      }
      this._log('highlight_soft_timeout_release', {
        triggerSource: 'highlight_timeout',
        stateBefore: this.state,
        stateAfter: this.state,
        clickTime: pending.clickTime,
        timeoutMs: timeoutMs
      });
      this.clearPendingHighlight();
      page.endHighlightSaving();
    }, timeoutMs);
    return pending;
  }

  clearPendingHighlight() {
    if (this._highlightTimeoutTimer) {
      clearTimeout(this._highlightTimeoutTimer);
      this._highlightTimeoutTimer = null;
    }
    this._mirrorPendingHighlight(null);
  }

  noteTimelineGap(source, gapMs) {
    this._log('timeline_gap_detected', {
      triggerSource: source || 'unknown',
      stateBefore: this.state,
      stateAfter: this.state,
      gapMs: gapMs || 0
    });
  }

  maybeGenerateHighlight() {
    const pending = this.pendingHighlight;
    if (!pending) return false;
    const segments = Array.isArray(this.page.rollingSegments) ? this.page.rollingSegments : [];
    const covered = segments.some((seg) =>
      seg
      && typeof seg.startTime === 'number'
      && typeof seg.endTime === 'number'
      && seg.startTime <= pending.clickTime
      && seg.endTime >= pending.clickTime
    );
    if (!covered) return false;
    this.clearPendingHighlight();
    this.page._generateHighlight(pending.startTime, pending.endTime, pending);
    return true;
  }

  canStart() {
    return this.state === RECORDER_STATE.READY;
  }

  markReady(source) {
    if (this.state === RECORDER_STATE.RECOVERING) return;
    this.setState(RECORDER_STATE.READY, source || 'ready');
  }

  markIdle(source) {
    if (this.state === RECORDER_STATE.RECOVERING) return;
    this.setState(RECORDER_STATE.IDLE, source || 'idle');
  }

  noteStopTimestamp() {
    this.lastStopAt = Date.now();
  }

  noteFlushLag(flushLagMs) {
    const lag = Number(flushLagMs || 0);
    if (!isFinite(lag) || lag <= 0) return;
    const clamped = Math.max(600, Math.min(3200, Math.round(lag)));
    this._recentFlushLagMs = Math.max(
      600,
      Math.min(3200, Math.round(this._recentFlushLagMs * 0.65 + clamped * 0.35))
    );
  }

  waitForFlushComplete(source, flushPromise, onReady) {
    this.setState(RECORDER_STATE.FLUSHING, source || 'flush_begin');
    const done = () => {
      this.markReady(source || 'flush_done');
      if (typeof onReady === 'function') onReady();
    };
    Promise.resolve(flushPromise)
      .catch(() => Promise.resolve())
      .then(() => {
        const poll = () => {
          if (this.page.rollingFsBusy || this.page._rollingPersistInFlight > 0) {
            setTimeout(poll, 50);
            return;
          }
          done();
        };
        poll();
      });
  }

  requestTryStartWhenReady(source) {
    return this.withOwner(source, 'tryStartWhenReady', () => {
      if (this.isRecovering) return;
      if (this.state !== RECORDER_STATE.READY) return;
      this.page._tryStartRollingWhenCameraReadyImpl();
    });
  }

  requestStartRolling(source) {
    return this.withOwner(source, 'startRolling', () => {
      if (this.isRecovering) return;
      if (!this.canStart()) return;
      this.page._startRollingRecordingImpl();
    });
  }

  requestStartSegment(source, sessionId, retryCount) {
    return this.withOwner(source, 'startSegment', () => {
      if (this.isRecovering) return;
      const now = Date.now();
      if (!this.canStart()) return;
      if (now - this.lastStopAt < this.getSafeRestartDelayMs()) return;
      this.setState(RECORDER_STATE.STARTING, source);
      this.page._startOneSegmentImpl(sessionId, retryCount);
    });
  }

  requestStopSegment(source, sessionId) {
    return this.withOwner(source, 'stopSegment', () => {
      if (this.isRecovering) return;
      this.setState(RECORDER_STATE.STOPPING, source);
      this.page._stopOneSegmentImpl(sessionId);
    });
  }

  requestStopRolling(source, onStopped) {
    return this.withOwner(source, 'stopRolling', () => {
      this.setState(RECORDER_STATE.STOPPING, source);
      this.page._stopRollingRecordingImpl(() => {
        this.markIdle(source);
        if (typeof onStopped === 'function') onStopped();
      });
    });
  }

  requestReplayPause(source, onPaused) {
    return this.withOwner(source, 'replayPause', () => {
      if (typeof onPaused === 'function') {
        if (wx.nextTick) wx.nextTick(onPaused);
        else setTimeout(onPaused, 0);
      }
    });
  }

  requestReplayResume(source) {
    return this.withOwner(source, 'replayResume', () => {});
  }

  requestRecover(source) {
    const now = Date.now();
    if (this.isRecovering || this.state === RECORDER_STATE.RECOVERING) {
      return false;
    }
    if (now - this.lastRecoverAt < MIN_RECOVER_INTERVAL) {
      this._log('recover_rejected_by_cooldown', {
        triggerSource: source || 'unknown',
        stateBefore: this.state,
        stateAfter: this.state,
        remainMs: MIN_RECOVER_INTERVAL - (now - this.lastRecoverAt)
      });
      return false;
    }
    this.lastRecoverAt = now;
    this.setState(RECORDER_STATE.RECOVERING, source);
    return this.withOwner(source, 'recover', () => this.page._hardRecoverLivePipelineImpl(source));
  }

  onRecoverSuccess(source) {
    this.recoverFailCount = 0;
    this.leaveDegradedMode();
    this.markReady(source || 'recover_success');
  }

  onRecoverFail(source) {
    this.recoverFailCount += 1;
    if (this.recoverFailCount >= 3) {
      this.enterDegradedMode(source);
    }
    this.markIdle(source || 'recover_fail');
  }

  onSegmentStartSuccess(source, sessionId) {
    this.syncSession(sessionId);
    this.setState(RECORDER_STATE.RECORDING, source || 'segment_start_ok');
  }

  onSegmentStartFail(source) {
    if (this.state === RECORDER_STATE.STARTING) {
      this.markReady(source || 'segment_start_fail');
    }
  }

  onSegmentStopSuccess(source, flushPromise, onReady) {
    this.noteStopTimestamp();
    this.waitForFlushComplete(source || 'segment_stop_ok', flushPromise, onReady);
  }

  getSafeRestartDelayMs() {
    const base = isLiveHostIos() ? 150 : 120;
    return Math.max(
      RECORDER_SAFE_RESTART_DELAY_MIN_MS,
      Math.min(RECORDER_SAFE_RESTART_DELAY_MAX_MS, base)
    );
  }
}

/**
 * 本地存储键：是否已展示「超频模式无机位切换」提示（仅首次）。
 */
const STORAGE_VK_VIEW_MODE_HINT = 'miaoji_live_vk_view_mode_hint_v1';

/**
 * 直播机位：广角 / 标准 / 特写；与回放 REPLAY_ZOOM_LEVELS 无耦合。
 * @readonly
 */
const CameraViewMode = {
  WIDE: 'wide',
  NORMAL: 'normal',
  CLOSE: 'close'
};

/** 特写机位默认目标变焦（受 {@link data.maxZoom} 夹持） */
const VIEW_MODE_CLOSE_ZOOM = 2;

/**
 * Android 超广探测：complete 早于 success 时若用 0ms 会误判失败，略延迟再试下一档。
 * @readonly
 */
const ANDROID_ULTRAWIDE_PROBE_COMPLETE_MS = 280;

/**
 * 将 zoom 值格式化为按钮文案（如 1x / 2x / 2.5x）。
 * @param {number} z
 * @returns {string}
 */
function formatCameraZoomLabel(z) {
  var n = Number(z);
  if (!isFinite(n) || n <= 0) n = 1;
  var rounded = Math.round(n * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 0.01) {
    return String(Math.round(rounded)) + 'x';
  }
  return String(rounded) + 'x';
}

/**
 * 是否 iOS 宿主（用于小程序 camera 与系统相机 zoom 刻度对齐）。
 * @returns {boolean}
 */
function isLiveHostIos() {
  try {
    return String(wx.getSystemInfoSync().platform || '').toLowerCase() === 'ios';
  } catch (e) {
    return false;
  }
}

/**
 * 根据设备 maxZoom 得到进入直播时的默认预览倍率（iOS 上 zoom=2 更接近系统相机「1×」主摄）。
 * @param {number} maxZoom
 * @returns {number}
 */
function getDefaultPreviewZoomForMax(maxZoom) {
  var mz = Number(maxZoom);
  if (!isFinite(mz)) mz = 10;
  if (isLiveHostIos() && mz >= 2) return 2;
  return 1;
}

/**
 * 在窗口内得到最大内接 16:9 矩形（px），与常见相机/编码 16:9 长宽比一致，避免全屏时视口与传感器比例严重错位。
 *
 * @param {number} winW
 * @param {number} winH
 * @returns {{ w: number, h: number }}
 */
function computeLiveStage16x9SizePx(winW, winH) {
  var ww = Math.max(1, winW);
  var wh = Math.max(1, winH);
  var ar = 16 / 9;
  if (ww / wh > ar) {
    var h1 = wh;
    var w1 = h1 * ar;
    return { w: w1, h: h1 };
  }
  var w0 = ww;
  var h0 = w0 / ar;
  return { w: w0, h: h0 };
}

/**
 * 16:9 内接矩形在窗口中的位置（px，左上为原点），与 liveStageInlineStyle 居中逻辑一致。
 *
 * @param {number} winW
 * @param {number} winH
 * @returns {{ w: number, h: number, left: number, top: number }}
 */
function computeLiveStage16x9RectPx(winW, winH) {
  var box = computeLiveStage16x9SizePx(winW, winH);
  var ww = Math.max(1, winW);
  var wh = Math.max(1, winH);
  var ar = 16 / 9;
  if (ww / wh > ar) {
    return { w: box.w, h: box.h, left: (ww - box.w) * 0.5, top: 0 };
  }
  return { w: box.w, h: box.h, left: 0, top: (wh - box.h) * 0.5 };
}

/**
 * 角标 ◎/REC 放在 16:9 外黑边：有左右条时收进条内；全宽+上下条时收进底带并收紧 bottom，避免与取景区重叠。
 *
 * @param {number} winW
 * @param {number} winH
 * @param {{ w: number, h: number, left: number, top: number}} rect
 * @param {{ sL: number, sR: number, sB: number}} safePx
 * @returns {{ leftCameraFab: string, recoverStack: string, replayRail: string }}
 */
function buildCornerFabStylesInLetterboxPx(winW, winH, rect, safePx) {
  var w = Math.max(1, winW);
  var h = Math.max(1, winH);
  var r = rect;
  var factor = 750 / w;
  var fabR = 40;
  var mR = 10;
  var gR = 8;
  var sLr = safePx.sL * factor;
  var sRr = safePx.sR * factor;
  var sBr = safePx.sB * factor;
  var barLeftR = r.left * factor;
  var videoRightR = (r.left + r.w) * factor;
  var Lmin = mR + sLr;
  var Lmax = barLeftR - fabR - gR;
  var Rmin = mR + sRr;
  var Rmax = 750 - fabR - videoRightR - gR;
  var bottomR;
  if (h - (r.top + r.h) < 1) {
    /** 取景区贴底，底边无条（典型：横屏左右黑条） */
    bottomR = mR + sBr;
  } else {
    var fabWpx = (fabR * w) / 750;
    var mpx = (mR * w) / 750;
    var capBpx = h - (r.top + r.h) - fabWpx - 2;
    var wantBpx = mpx + safePx.sB;
    var bpx = wantBpx <= capBpx ? wantBpx : Math.max(0, capBpx);
    bottomR = (bpx * 750) / w;
  }
  var fullW = r.left * factor < 0.1;
  var leftR;
  if (Lmax >= Lmin) {
    leftR = Lmin;
  } else if (fullW) {
    leftR = Lmin;
  } else {
    leftR = Math.max(0, Lmax);
  }
  var rightR;
  if (Rmax >= Rmin) {
    rightR = Rmin;
  } else if (fullW) {
    rightR = Rmin;
  } else {
    rightR = Math.max(0, Rmax);
  }
  return {
    leftCameraFab: 'left:' + leftR + 'rpx;bottom:' + bottomR + 'rpx;',
    recoverStack: 'right:' + rightR + 'rpx;bottom:' + bottomR + 'rpx;',
    /** 实时回看右侧工具列：与 REC 列同 right，垂直居中于视窗，不占用 16:9 画面内顶部空间 */
    replayRail: 'right:' + rightR + 'rpx;top:50%;transform:translateY(-50%);'
  };
}

Page({
  data: {
    matchConfig: {
      matchName: '',
      matchNameColor: '#E64340',
      teamA: { name: '队 A', bgColor: '#E64340', textColor: '#FFFFFF', score: 0 },
      teamB: { name: '队 B', bgColor: '#10AEFF', textColor: '#FFFFFF', score: 0 },
      period: 0
    },
    periods: app.globalData.periods,
    statusBarHeight: 0,
    cameraContext: null,
    cameraMounted: false,
    /** 强制 camera 组件重建的渲染序号（每次重建 +1）。 */
    cameraRenderNonce: 0,
    isRecovering: false,
    /** 硬恢复相机卸载间隙：静态遮罩（无 Toast、无循环 video），减轻黑屏与推流观感问题。 */
    showRecoveryVeil: false,
    recoveryVeilSrc: '',
    pipelineHealth: 'ok',
    opsControlText: 'PAUSE',
    opsControlActionable: false,
    opsControlAck: false,
    /** 恢复圆环进度 0–100，与 recoveryConicEndDeg 同步供 conic-gradient 使用 */
    recoveryProgress: 0,
    recoveryConicEndDeg: 0,
    /** 高光保存进度 0–360，仅在 isSavingHighlight 时叠于状态灯，低透明度 conic */
    highlightSaveConicEndDeg: 0,
    /** 是否正在保存高光（事务锁：覆盖 stopRecord→落盘→copy→入库 全链路） */
    isSavingHighlight: false,
    /** RecorderCore 熔断后的降级态：仅保留基础录制与基础高光。 */
    recorderDegradedMode: false,
    isRecording: false,
    longPressTimer: null,
    periodFlash: false,
    /** 缓存空间灯：与 file-storage-estimate 的 getClipStorageHealthHint.level 一致 */
    cacheStorageLampLevel: 'ok',
    /**
     * 与 cacheStorageLampLevel==='severe' 同步；为 true 时禁起新 rolling 段、禁保存高光，下灯可点按批量导出清空间。
     * @type {boolean}
     */
    storageSevereLock: false,
    /** 同 storageSevereLock，供 wxml 复用可点态 */
    cacheStorageLampActionable: false,
    /** 与顶部状态灯同系：OK / WT(warn) / EX(severe) */
    cacheStorageLampText: 'OK',
    /**
     * 左下角「相机/变焦」快捷：展开态；与抽屉互斥，避免与列表手势冲突。
     * @type {boolean}
     */
    cameraSettingsOpen: false,
    /**
     * 机位快捷项：广角 + 数字倍数；按机型能力动态生成（支持才显示广角）。
     * @type {Array<{ label: string, mode: string, zoom: number }>}
     */
    cameraViewModeStops: [
      { label: '广角', mode: CameraViewMode.WIDE, zoom: 0.5 },
      { label: '1x', mode: CameraViewMode.NORMAL, zoom: 1 },
      { label: '2x', mode: CameraViewMode.CLOSE, zoom: 2 }
    ],
    /** 当前选中的机位（与 pinch 变焦可短暂不同步，仅影响药丸高亮） */
    cameraViewMode: CameraViewMode.NORMAL,
    /**
     * 相机设置呼出条：fixed 定位在 16:9 取景区内左侧（由 _updateLiveStageLayout 写入）。
     * @type {string}
     */
    cameraSettingsPanelStyle: '',
    /**
     * ◎ 角标：16:9 外黑边内（与 recoverFabStackStyle 同时计算）。
     * @type {string}
     */
    leftCameraFabStyle: 'left:10rpx;bottom:10rpx;',
    /**
     * REC+存储灯角标：16:9 外黑边内，与左对称。
     * @type {string}
     */
    recoverFabStackStyle: 'right:10rpx;bottom:10rpx;',
    /** 回放模式右侧倍速/关闭/还原列（与 {@link buildCornerFabStylesInLetterboxPx} 同步） */
    replayRailStyle: 'right:10rpx;top:50%;transform:translateY(-50%);',
    /**
     * 轻提示（自绘半透明，替代 wx.showToast，避免与直播抢焦点）；opacity 0~0.7，短时长。
     * @type {string}
     */
    lightHintText: '',
    /** @type {number} */
    lightHintOpacity: 0,

    /** 抽屉模式: 0=隐藏 1=抽屉打开 */
    drawerMode: 0,
    /** 左侧比赛管理列表数据 */
    matchList: [],
    /** 场次总数（用于左侧抽屉顶部统计显示）。 */
    matchCount: 0,
    /** 颜色设置浮层：是否可见 */
    showColorModal: false,
    /** 颜色设置浮层：当前操作的比赛数据 */
    colorModalMatch: null,
    /** 颜色设置浮层：当前选中的队（teamA / teamB），共用色盘指向 */
    colorModalTeam: 'teamA',
    /** 颜色浮层：高光缓存行提示（含约 MB） */
    colorModalCacheRowHint: '',
    /** 颜色浮层：已执行下载清空，按钮置为「已清空」 */
    colorModalDownloadCleared: false,
    /** 快选颜色球色板（24 色：8 列 × 3 行，仅一个纯黑） */
    colorBalls: [
      '#DC2626', '#EA580C', '#F59E0B', '#EAB308', '#84CC16', '#16A34A', '#059669', '#0D9488',
      '#14B8A6', '#06B6D4', '#0EA5E9', '#3B82F6', '#6366F1', '#7C3AED', '#A855F7', '#C026D3',
      '#DB2777', '#E11D48', '#F43F5E', '#FFFFFF', '#E2E8F0', '#94A3B8', '#475569', '#000000'
    ],
    drawerHighlights: [],
    /** 当前场次高光片段总数（用于抽屉顶部统计显示）。 */
    highlightCount: 0,
    defaultCover: 'data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"160\" height=\"90\" viewBox=\"0 0 160 90\"><defs><linearGradient id=\"g\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0%\" stop-color=\"%2338475e\"/><stop offset=\"100%\" stop-color=\"%23202a3c\"/></linearGradient></defs><rect width=\"160\" height=\"90\" rx=\"12\" ry=\"12\" fill=\"url(%23g)\"/></svg>',

    showReplayMask: false,
    replayMaskText: 'REPLAY',
    /** 转场样式：replay 进入回放 / live 回到直播 */
    replayMaskKind: 'replay',
    /** 回放倍速（与直播区分观感） */
    replayPlaybackRate: 0.75,
    /** 回放视频是否需要旋转 90 度（竖屏素材在横屏页中的适配） */
    replayVideoNeedRotate: false,
    /** 回放视频旋转角度：仅在需要旋转时生效（90 或 -90） */
    replayVideoRotateDeg: 90,
    isReplaying: false,
    replaySrc: '',
    replayQueue: [],
    replayIndex: 0,
    /** 慢速播放（0.5x / 0.75x）时自动静音，避免变调恐怖感；默认倍速 0.75 故初始为 true */
    replayMuted: true,
    /** movable-view 当前缩放比例（1 = 原始大小），用于控制重置按钮显隐 */
    replayViewScale: 1,
    /** movable-view 水平偏移（px），重置时归零 */
    replayViewX: 0,
    /** movable-view 垂直偏移（px），重置时归零 */
    replayViewY: 0,
    /** 高光回放起播时间（秒），配合长切片逻辑偏移 */
    replayInitialTime: 0,
    /** 高光跨文件链式回放：是否启用 */
    replayHighlightChain: false,
    /** 链式回放路径列表（与 segments 顺序一致） */
    replayHighlightPaths: [],
    /** 链式回放当前索引 */
    replayHighlightIndex: 0,

    /**
     * 双 slot 无缝切换回放。slot-a/b 同时在 DOM，非活跃 slot 在后台预加载。
     * 切换时只改 z-index，避免 src 变更触发重新加载造成黑帧。
     */
    /** 活跃播放 slot：0 = slot-a，1 = slot-b */
    replayActiveSlot: 0,
    /** slot-a 视频路径 */
    replaySlotASrc: '',
    /** slot-a 起播秒数 */
    replaySlotAInitialTime: 0,
    /** slot-b 视频路径（预加载第二段） */
    replaySlotBSrc: '',
    /** slot-b 起播秒数 */
    replaySlotBInitialTime: 0,

    // 相机焦距相关
    zoom: 1,
    maxZoom: 10,
    minZoom: 1,
    distance: 0,
    lastZoom: 1,
    /** 左右球队色块宽度（px），按队名字符数估算，避免 flex:1 拉满半屏 */
    teamGroupWidthPxA: 0,
    teamGroupWidthPxB: 0,
    showGuide: false,
    /** 快速上手分步：0=操作说明，1=抖音直播 16:9 画幅引导（与 {@link dismissGuide} 复位一致） */
    guideSubStep: 0,

    /** 共用：对焦框 + 小太阳条是否显示 */
    aeControlsVisible: false,
    /** 对焦/曝光 UI 来源：开赛前 pre、直播中手势唤醒 live */
    aeContext: '',
    /** 小太阳在竖条上的 0–100%（自上向下：亮→暗 依 evNorm 映射） */
    aeSunTopPct: 50,
    /** 开赛前在点击点展示整簇；false 为几何中心整簇 */
    aeFocusIsTapPosition: true,
    /** 对焦+曝光簇左上角 rpx（仅 tap 模式用内联；与 {@link AE_BRACKET_RPX} 配套） */
    aeClusterLeftRpx: 0,
    aeClusterTopRpx: 0,
    /** 对焦点位成功后的短反馈（高亮/缩放动画的开关） */
    aeFocusLockFlash: false,
    /** 用户双击方框后锁定态（在相同归一化坐标上再调 setTargetFocus） */
    aeFocusUserLocked: false,
    /** 是否显示「双击方框锁焦」提示（出框后短时显示，锁焦后关闭） */
    aeShowDoubleTapHint: false,
    /**
     * 当前机型 cameraContext 是否支持硬件 EV 接口（setExposureCompensation / setEV / setExposureOffset 任一存在）。
     * 不支持时曝光滑条不展示，也不提供任何“软补光”兜底（软补光只改预览 overlay，不影响录制结果，
     * 反而误导用户，且录制过程中多一层半透明 view 合成对低端机型是负担）。
     */
    aeExposureHardwareSupported: false,

    /** 是否通过 GET /api/auth/check-status 且 isVip 为 true */
    liveStreamAllowed: false,
    /** 首次进入 Live 时尚未完成权益校验 */
    liveEntitlementChecking: true,
    /** 权益不足时的全屏引导层 */
    showVipGate: false,
    vipGateTitle: '',
    vipGateSubtext: '',
    vipGateMinor: '',
    vipGateRetryVisible: false,

    /**
     * 严重存储提示：原生 `wx.showModal` 在部分机型 `<camera>` 页不可靠，用页面级 fixed 遮罩；
     * 勿嵌 camera 内 cover-view（flex/宽度在 VK 重建后易错乱）。
     */
    showStoragePressureModal: false,
    storagePressureModalText: '',

    /**
     * 增强渲染：WebGL 锐化画布是否进入视图树。由 render-pipeline 根据模式驱动，
     * 关闭时回退为仅 <camera> 的原生预览。
     */
    enhanceCanvasVisible: false,
    /** 16:9 取景框内联样式（等比内接于窗口，黑边在容器外，见 live.wxss .live-stage） */
    liveStageInlineStyle: '',
    /**
     * 增强渲染当前档位：'off' | 'lite' | 'standard' | 'strong' | 'vk'；由 render-pipeline 写回。
     * 注意：'vk' 属于独立家族，此时 <camera> 已 unmount、rolling 已停；切出时须通过
     * `switchToNonVkMode` orchestrator 回到原生家族。
     */
    enhanceMode: 'off',
    /**
     * 机型是否通过增强渲染白名单（由 app.js 冷启动评估）；决定调试工具条是否展示。
     * 即使当前 mode==='off'，白名单机型仍可从工具条中手动切回 standard/strong。
     */
    enhanceWhitelisted: false,
    /**
     * 本机是否支持 VK 模式；由 app.js 冷启动用 `evaluateVkSupportCached` 判定。
     * 为 true 时工具条显示"VK 模式"按钮；进入 VK 需用户确认（精彩回放会暂停）。
     */
    enhanceVkSupported: false,
    /**
     * VK 模式切换过程中的占位态（stop rolling → unmount camera → VK start），
     * 用于置灰工具条与屏蔽其他手势；orchestrator 结束后复位。
     */
    enhanceVkTransitioning: false,
    /**
     * 抽屉打开时工具条展示的实时 FPS 文案（如 "28 fps"）；未启用时显示 "— fps"。
     */
    enhanceFpsText: '— fps',
    vkDebugPanelVisible: false,
    vkDebugAmount: 0.58,
    vkDebugAmountPct: 58,
    vkDebugTone: 0.95,
    vkDebugTonePct: 95,
    vkDebugMotion: 0.72,
    vkDebugMotionPct: 72,
    vkDebugFreezeAuto: false,
    isVkTimeshift: false,
    
    // --- 自动模式相关 ---
    isAutoMode: false,
    bleMinutes: 0,
    bleSeconds: 0,
    bleShotClock: 24
  },

  /**
   * 从全局与 Storage 同步当前场次记分配置（与 index、onShow 逻辑一致）。
   * @returns {void}
   */
  /**
   * 解析当前高光应写入的场次 ID（Storage / globalData / 当前 matchConfig.id）。
   * @returns {string} 空字符串表示无法安全落库，调用方应中止保存并提示用户。
   */
  resolveMatchIdForHighlightStorage: function () {
    let id = clipsStorage.normalizeMatchIdKey(wx.getStorageSync('currentMatchId'));
    if (!id) id = clipsStorage.normalizeMatchIdKey(app.globalData && app.globalData.currentMatchId);
    if (!id) {
      const mc = this.data.matchConfig;
      if (mc && mc.id != null) id = clipsStorage.normalizeMatchIdKey(mc.id);
    }
    return id || '';
  },

  syncMatchConfigFromPageSources: function () {
    const currentMatchId =
      wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    let sourceConfig = app.globalData.matchConfig || wx.getStorageSync('matchConfig');
    if (currentMatchId) {
      const matches = wx.getStorageSync('MIAOXIE_MATCHES');
      if (Array.isArray(matches)) {
        const found = matches.find((m) => m.id === currentMatchId);
        if (found) {
          sourceConfig = found;
        }
      }
    }
    const latestConfig = this.normalizeMatchConfig(sourceConfig);
    const wSide = this.computeTeamGroupWidthPx();
    this.setData({
      matchConfig: latestConfig,
      teamGroupWidthPxA: wSide,
      teamGroupWidthPxB: wSide
    });
    app.globalData.matchConfig = latestConfig;
    wx.setStorageSync('matchConfig', latestConfig);
  },

  /**
   * 将权益到期时间格式化为本地可读字符串。
   * @param {unknown} expireRaw
   * @returns {string}
   */
  formatExpireForDisplay: function (expireRaw) {
    const ms = parseExpireAtToMs(expireRaw);
    if (Number.isNaN(ms)) {
      return typeof expireRaw === 'string' || typeof expireRaw === 'number' ? String(expireRaw) : '';
    }
    const d = new Date(ms);
    const pad = (n) => `${n}`.padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
      d.getMinutes()
    )}`;
  },

  /**
   * 解析 check-status 响应，得到是否允许进入直播与拦截文案。
   * @param {unknown} body
   * @returns {{ allow: boolean, title: string, sub: string, minor: string, showRetry: boolean }}
   */
  buildVipGateStateFromCheckStatus: function (body) {
    const deny = (title, sub, minor, showRetry) => ({
      allow: false,
      title,
      sub,
      minor: minor || '',
      showRetry: !!showRetry
    });
    if (!body || typeof body !== 'object') {
      return deny('权益续杯', '校验失败，请稍后重试', '', true);
    }
    const res = /** @type {Record<string, unknown>} */ (body);
    if (res.code !== 0 || !res.data || typeof res.data !== 'object') {
      const msg = typeof res.message === 'string' && res.message.length > 0 ? res.message : '权益校验失败';
      return deny('权益续杯', msg, '', true);
    }
    const d = /** @type {Record<string, unknown>} */ (res.data);
    const isVip = d.isVip === true;
    const expireRaw = d.expireAt !== undefined && d.expireAt !== null ? d.expireAt : d.expire_at;
    if (isVip) {
      return { allow: true, title: '', sub: '', minor: '', showRetry: false };
    }
    const expMs = parseExpireAtToMs(expireRaw);
    if (expireRaw == null || expireRaw === '' || Number.isNaN(expMs)) {
      return deny('权益续杯', '尚未获得试用期', '完成登录或邀请好友成功登录可获得试用与续期', false);
    }
    const now = Date.now();
    if (expMs < now) {
      return deny('权益续杯', '权益已到期，邀请好友完成登录可续期 5 天', `到期时间：${this.formatExpireForDisplay(expireRaw)}`, false);
    }
    return deny(
      '权益续杯',
      '当前账号暂不可使用直播功能',
      `参考到期时间：${this.formatExpireForDisplay(expireRaw)}`,
      true
    );
  },

  /**
   * 调用服务端校验权益；拒绝时收起相机并展示引导层。
   * @param {function(): void} [onAllowed] 仅在 isVip 为 true 时调用
   * @returns {void}
   */
  refreshLiveEntitlementAndResume: function (onAllowed) {
    if (this._entitlementChecking) {
      if (typeof onAllowed === 'function') {
        this._entitlementOnAllowedQueue.push(onAllowed);
      }
      return;
    }
    this._entitlementChecking = true;
    const token = getToken();
    if (!token) {
      this.rollingActive = false;
      this.stopRollingRecording();
      this.setData({
        liveEntitlementChecking: false,
        liveStreamAllowed: false,
        cameraMounted: false,
        cameraContext: null,
        showVipGate: true,
        vipGateTitle: '需要登录',
        vipGateSubtext: '请先到「我的」完成微信登录，再使用直播记分与录像。',
        vipGateMinor: '',
        vipGateRetryVisible: false
      });
      this._entitlementOnAllowedQueue = [];
      this._entitlementChecking = false;
      return;
    }

    this.setData({ liveEntitlementChecking: true });

    get('/api/auth/check-status', {}, {})
      .then((body) => {
        const gate = this.buildVipGateStateFromCheckStatus(body);
        if (!gate.allow) {
          this.rollingActive = false;
          this.stopRollingRecording(() => {
            this.setData({
              liveEntitlementChecking: false,
              liveStreamAllowed: false,
              cameraMounted: false,
              cameraContext: null,
              showVipGate: true,
              vipGateTitle: gate.title,
              vipGateSubtext: gate.sub,
              vipGateMinor: gate.minor,
              vipGateRetryVisible: gate.showRetry
            });
          });
          this._entitlementOnAllowedQueue = [];
          this._entitlementChecking = false;
          return;
        }

        const cameraAlreadyHealthy =
          this.data.liveStreamAllowed
          && this.data.cameraMounted
          && !!this.data.cameraContext
          && this._cameraInitDone
          && !this.data.isRecovering;
        if (cameraAlreadyHealthy) {
          this.setData({
            liveEntitlementChecking: false,
            liveStreamAllowed: true,
            showVipGate: false,
            vipGateTitle: '',
            vipGateSubtext: '',
            vipGateMinor: '',
            vipGateRetryVisible: false
          }, () => {
            this._entitlementEverAllowedInSession = true;
            if (typeof onAllowed === 'function') onAllowed();
            const queued = this._entitlementOnAllowedQueue.splice(0, this._entitlementOnAllowedQueue.length);
            queued.forEach((fn) => {
              try { fn(); } catch (e) { }
            });
          });
          this._entitlementChecking = false;
          return;
        }

        this.rebuildCameraComponent((generation) => {
          this.remountCameraComponent({
            generation,
            extraData: {
              liveEntitlementChecking: false,
              liveStreamAllowed: true,
              showVipGate: false,
              vipGateTitle: '',
              vipGateSubtext: '',
              vipGateMinor: '',
              vipGateRetryVisible: false
            },
            onMounted: () => {
              this._entitlementEverAllowedInSession = true;
              if (typeof onAllowed === 'function') {
                onAllowed();
              }
              const queued = this._entitlementOnAllowedQueue.splice(0, this._entitlementOnAllowedQueue.length);
              queued.forEach((fn) => {
                try { fn(); } catch (e) { }
              });
            }
          });
        });
        this._entitlementChecking = false;
      })
      .catch(() => {
        if (this._entitlementEverAllowedInSession) {
          this.setData({ liveEntitlementChecking: false });
          if (typeof onAllowed === 'function') {
            try {
              onAllowed();
            } catch (eCb) { }
          }
          const queued = this._entitlementOnAllowedQueue.splice(0, this._entitlementOnAllowedQueue.length);
          queued.forEach((fn) => {
            try { fn(); } catch (e) { }
          });
          this._entitlementChecking = false;
          return;
        }
        this.rollingActive = false;
        this.stopRollingRecording(() => {
          this.setData({
            liveEntitlementChecking: false,
            liveStreamAllowed: false,
            cameraMounted: false,
            cameraContext: null,
            showVipGate: true,
            vipGateTitle: '网络异常',
            vipGateSubtext: '无法校验权益，请检查网络后重试。',
            vipGateMinor: '',
            vipGateRetryVisible: true
          });
        });
        this._entitlementOnAllowedQueue = [];
        this._entitlementChecking = false;
      });
  },

  /**
   * 权益门「重试」：重新请求 check-status。
   * @returns {void}
   */
  onVipGateRetryTap: function () {
    this.refreshLiveEntitlementAndResume(() => {
      this._liveCoreOnShowAfterEntitlement();
    });
  },

  /**
   * 权益门：跳转「我的」登录。
   * @returns {void}
   */
  onVipGateSwitchMine: function () {
    wx.switchTab({ url: '/pages/mine/mine' });
  },

  /**
   * 拦截权益层下意外滚动穿透。
   * @returns {void}
   */
  onVipGateCatchMove: function () { },

  /**
   * 恢复遮罩层吞掉触摸移动，避免穿透到记分手势。
   * @returns {void}
   */
  noopCatchMove: function () { },

  /**
   * 阻止卡片内点击冒泡到根（预留）。
   * @returns {void}
   */
  stopVipGateInnerBubble: function () { },

  /**
   * 标记为“仅允许长按重启”的故障态，禁止状态灯单击动作。
   * @param {string} reason
   * @returns {void}
   */
  markNeedManualRelaunch: function (reason) {
    if (this._needManualRelaunch) return;
    this._needManualRelaunch = true;
    this._manualRelaunchReason = String(reason || 'unknown');
    this.appendHealthLog('manual_relaunch_required', {
      reason: reason || 'unknown',
      diag: this.getLiveRollingDiagSnapshot({})
    });
    this.updatePipelineHealth();
  },

  /**
   * 解析高光条目的创建时间（兼容 createdAt 缺失/脏数据场景，避免误删最新片段）。
   * @param {Record<string, unknown>} item
   * @returns {number}
   */
  resolveHighlightCreatedAt: function (item) {
    if (!item || typeof item !== 'object') return 0;
    const rawCreatedAt = item.createdAt;
    if (typeof rawCreatedAt === 'number' && Number.isFinite(rawCreatedAt) && rawCreatedAt > 0) {
      return rawCreatedAt;
    }
    const rawId = item.id != null ? String(item.id) : '';
    const parsedFromId = Number(rawId);
    if (Number.isFinite(parsedFromId) && parsedFromId > 0) return parsedFromId;
    return 0;
  },

  /**
   * 配额熔断：在明确文件配额耗尽时暂停自动滚动录制，避免进入 hard recover 循环风暴。
   * @param {string} reason
   * @param {string} [errMsg]
   * @returns {void}
   */
  activateFileQuotaCircuitBreaker: function (reason, errMsg) {
    const now = Date.now();
    const holdMs = 45 * 1000;
    const until = this._fileQuotaCircuitUntil || 0;
    if (until > now) {
      this.appendHealthLog('file_quota_circuit_already_open', {
        reason: reason || 'unknown',
        remainMs: until - now
      });
      return;
    }
    this._fileQuotaCircuitUntil = now + holdMs;
    this.appendHealthLog('file_quota_circuit_open', {
      reason: reason || 'unknown',
      holdMs,
      errMsg: errMsg || ''
    });
    this.rollingActive = false;
    this.startRecordFailStreak = 0;
    this.segmentStartFailStormCycles = 0;
    this.lastRecordStartAt = 0;
    this.setData({ isRecording: false });
    this.markNeedManualRelaunch('file_quota_exhausted');
    try {
      wx.showToast({
        title: '存储已满，已暂停自动录制',
        icon: 'none',
        duration: 2400
      });
    } catch (eToast) { }
  },

  /**
   * onShow 中在权益通过后执行的相机与滚动分段恢复逻辑。
   * @returns {void}
   */
  _liveCoreOnShowAfterEntitlement: function () {
    /**
     * kickoff 级 severe：`{@link _liveSevereKickoffPruneDone}` 避免同一会话内重复做 rolling 急救；
     * `{@link _liveStorageEntryModalShown}` 仅控制 Modal，勿在每次 onShow 清零 Modal 门闩（否则反复打断）。
     * 注意：已保存高光不在 kickoff 路径自动按条删除（见 `freeRollingFileStorageAggressive`）。
     */
    /**
     * 权益通过后立刻用首页/他处已写入的 globalData 试弹一次严重水位框，勿等待 stopRecord 链路上的异步探测
     * （stopRecord 偶发迟回调会导致 kickoff 探测永远不跑）。
     */
    this.maybeToastFileStoragePressureFromGlobal();
    this.resetViewModeToNormal();
    this.rollingActive = true;
    this.rollingSessionId += 1;
    const sessionIdForRolling = this.rollingSessionId;
    this.lastSegmentAt = Date.now();
    this.lastRecordStartAt = 0;
    this.startRecordFailStreak = 0;
    this.startHealthMonitor();

    const hasReadGuide = wx.getStorageSync('hasReadGuide');
    if (!hasReadGuide) {
      const patch = { showGuide: true };
      if (!this.data.showGuide) {
        patch.guideSubStep = 0;
      }
      this.setData(patch);
    }

    wx.getSetting({
      success: (res) => {
        const hasRecord = !!res.authSetting['scope.record'];
        const albumScope = res.authSetting['scope.writePhotosAlbum'];
        if (!hasRecord) {
          wx.authorize({ scope: 'scope.record', fail: () => { } });
        }
        if (albumScope !== true && albumScope === undefined) {
          wx.authorize({ scope: 'scope.writePhotosAlbum', fail: () => { } });
        }
      }
    });

    wx.setKeepScreenOn({
      keepScreenOn: true,
      fail: () => {
        setTimeout(() => wx.setKeepScreenOn({ keepScreenOn: true }), 1000);
      }
    });

    if (wx.setPageOrientation) {
      wx.setPageOrientation({ orientation: 'landscape' });
    }

    const kickoffRolling = () => {
      if (!this.rollingActive || sessionIdForRolling !== this.rollingSessionId) {
        return;
      }
      if (this._rollingKickoffTimer) {
        clearTimeout(this._rollingKickoffTimer);
        this._rollingKickoffTimer = null;
      }
      if (this._cameraInitDone) {
        this.tryStartRollingWhenCameraReady();
        return;
      }
      this._rollingKickoffTimer = setTimeout(() => {
        this._rollingKickoffTimer = null;
        if (!this.rollingActive || sessionIdForRolling !== this.rollingSessionId) {
          return;
        }
        this.tryStartRollingWhenCameraReady();
      }, 1800);
    };
    this.stopRollingRecording(() => {
      this.ensureRollingDir()
        /**
         * 必须先于 clearStaleRollingFiles 探测：否则入场即清空 _rolling 缓冲，
         * 沙盒总占用被低估，severe 弹窗与水位逻辑可能永远不触发。
         */
        .then(() => this.probeLiveSandboxStorage('kickoff', true))
        .then(() => this.clearStaleRollingFiles())
        .finally(() => {
          kickoffRolling();
        });
    });
    if (this.data.drawerMode === 1) {
      this.refreshDrawerHighlights();
    }
    if (wx.nextTick) {
      wx.nextTick(() => this.updateTeamGroupWidth(true));
    } else {
      setTimeout(() => this.updateTeamGroupWidth(true), 0);
    }
    /**
     * 小程序进后台再回前台（如切换抖音开播）后，部分机型 camera 组件不触发 bindinitdone；
     * 超时仍未就绪则强制重建并绑定本页 CameraContext。
     */
    if (this._cameraShowInitWatchTimer) {
      clearTimeout(this._cameraShowInitWatchTimer);
      this._cameraShowInitWatchTimer = null;
    }
    const selfWatch = this;
    this._cameraShowInitWatchTimer = setTimeout(() => {
      selfWatch._cameraShowInitWatchTimer = null;
      if (!selfWatch._livePageVisible || !selfWatch.data.liveStreamAllowed) return;
      if (!selfWatch.data.cameraMounted || selfWatch.data.isRecovering) return;
      if (selfWatch._cameraInitDone) return;
      selfWatch.appendHealthLog('camera_init_watchdog_rebuild', {});
      selfWatch.armNativeEnhanceModeRestoreAfterCameraRebuild('camera_init_watchdog');
      selfWatch.rebuildCameraComponent((generation) => {
        if (!selfWatch._livePageVisible || !selfWatch.data.liveStreamAllowed) return;
        selfWatch.remountCameraComponent({
          generation
        });
      });
    }, 2600);
  },

  // 辅助变量
  lastSetZoomTime: 0,
  suppressScoreTap: false,
  /**
   * 滚动录制单段时长（毫秒）。8s 单段体积更小，在约 200MB 本机文件配额下可保留更多段/更多次高光；
   * 高光「体感窗口」仍由 {@link highlightPlaybackWindowMs} 控制（默认 8s）。
   */
  segmentDurationMs: 8000,
  /** 用户点击保存后，回放时希望覆盖的精彩窗口长度（毫秒），可与物理切片时长解耦 */
  highlightPlaybackWindowMs: 8000,
  /** 时间驱动高光窗口：严格保存点击前过去 8s，不再等待未来片段。 */
  highlightLeadMs: 8000,
  highlightTailMs: 0,
  /**
   * stopRecord 与下一段 startRecord 之间的冷却；过短易在部分机型引发句柄未释放。
   * 略缩短可减小墙钟「真空」与状态灯 PAUSE 体感，需与稳定性平衡。
   */
  recordCooldownAfterStopMs: 380,
  /** 高光点击后执行 stopRecord 的最小时长门槛（毫秒），避免刚起录即 stop 在部分机型失败 */
  minRecordMsBeforeHighlightStop: 1300,
  segmentStopTimer: null,
  rollingWatchdogTimer: null,
  segmentCounter: 0,
  pendingHighlight: null,
  /** 为 true 时 UI 锁需等待 finalize 与下一段 startRecord 成功两道闸门 */
  _highlightSaveAwaitingResume: false,
  _highlightPipelineDoneFinalize: false,
  _highlightPipelineDoneResume: false,
  /** 当前等待恢复录制的会话 id；避免清空 meta 后无法释放保存锁 */
  _highlightSaveSessionId: 0,
  _highlightResumeGuardTimer: null,
  _highlightSaveHardTimeoutTimer: null,
  _highlightDeferredStopTimer: null,
  /** {@link startHighlightSaveProgressAnim} 的轮询 id */
  _highlightSaveProgressTimer: null,
  /** 保存高光期间若用户点了回放，暂存条目，待 {@link endHighlightSaving} 后再真正进入回放 */
  _replayDeferredItem: null,
  _highlightRequestLock: false,
  /**
   * 画质档位切换防抖截止时间（ms 时间戳）；此前拦截工具条连点，减轻 VK 与 camera 互切黑屏。
   * @type {number}
   */
  _enhanceModeSwitchGuardUntil: 0,
  /** 原生画质：零帧自愈后应 setMode 的目标档位（off|lite|standard|strong） */
  _pendingEnhanceModeAfterRecover: null,
  /** 相机硬恢复/看门狗重建后应恢复的原生增强档位（off|lite|standard|strong）。 */
  _pendingEnhanceModeAfterCameraRebuild: null,
  /** {@link onEnhanceModePick} 安排的零帧检测定时器 */
  _enhanceZeroFrameRecoverTimer: null,
  /** MOD: 时间驱动 rolling 素材池，仅记录 temp 文件和墙钟区间，不复制到本地 rolling 目录。 */
  rollingSegments: [],
  /** 兼容旧清理/诊断代码的别名，核心高光逻辑只读 `rollingSegments`。 */
  segmentBuffer: [],
  rollingActive: false,
  rollingSessionId: 0,
  lastHighlightRequestAt: 0,
  lastHighlightSignature: '',
  lastSegmentAt: 0,
  lastRecordStartAt: 0,
  startRecordFailStreak: 0,
  /** rolling 热层最多保留 3 段，超过后只 shift 索引，不主动删除 temp 文件。 */
  rollingBufferMax: 3,
  /** 兼容旧看门狗字段；时间驱动 rolling 不再做热层落盘。 */
  rollingFsBusy: false,
  /**
   * 并行落盘会话数；与 {@link rollingFsBusy} 同步（>0 即 busy）。
   * 兼容旧诊断字段；时间驱动 rolling 下通常保持为 0。
   * @type {number}
   */
  _rollingPersistInFlight: 0,
  /**
   * 兼容旧调度字段；时间驱动 rolling 下不再由热层落盘写入。
   * @type {number}
   */
  _postUserLocalPersistCooldownMs: 0,
  /** 进入回放前 REPLAY 全屏转场总时长（需与 WXSS 中 replayBadgeMotion 时长一致） */
  replayIntroDurationMs: 520,
  /** 回到直播转场总时长（需与 WXSS 中 liveBadgeMotion 时长一致） */
  replayOutroDurationMs: 720,
  /** 连续高光未命中计数；用于触发自动硬恢复。 */
  highlightMissStreak: 0,
  /** 连续高光落盘失败计数；用于触发录制管线自恢复。 */
  highlightCopyFailStreak: 0,
  /** 连续 segment 持久化失败计数；超过阈值说明当前页实例已失稳。 */
  segmentPersistFailStreak: 0,
  /** 高光异步固化任务队列。 */
  highlightMaterializeQueue: [],
  /** 高光异步固化执行中标记。 */
  highlightMaterializeRunning: false,
  /** 存储水位级别：0/70/85/95。 */
  storageWatermarkLevel: 0,
  /** 高光实体最大保留条数（>=30 条实战需求；超出淘汰最旧项）。 */
  highlightsMaxCount: 100,
  /** 紧急清理时全局至少保留的高光条数，避免历史高光被连续误删。 */
  highlightsEmergencyMinKeepCount: 30,
  /** startRecord 连续失败风暴计数（每次达到 failStreak=5 记 1 次）。 */
  segmentStartFailStormCycles: 0,
  /** startOneSegment 单飞锁，防止并发 startRecord 导致状态错乱。 */
  _startOneSegmentInFlight: false,
  /** startOneSegment 的延迟重试 timer（同一时刻仅允许一个）。 */
  _segmentStartRetryTimer: null,
  /** 处理 `is recording` 冲突时的恢复锁，避免并发 stopRecord。 */
  _segmentStartRecoveringFromIsRecording: false,
  /** 处理 `operate fail` 时的受控恢复锁，避免并发 stop/start 与硬恢复。 */
  _segmentStartRecoveringFromOperateFail: false,
  /** 连续 rolling temp 丢失计数（用于触发软恢复熔断）。 */
  _rollingTempMissingStreak: 0,
  /** 连续出现“temp 终态丢失”计数，超过阈值触发硬恢复。 */
  _rollingTempTerminalFailStreak: 0,
  /** 最近一次 startRecord operate fail 的时间戳；与 temp 丢失联合判定 camera 真故障。 */
  _lastSegmentOperateFailAt: 0,

  onLoad: function () {
    this._recorderCore = new RecorderCore(this);
    /** 相机 bindinitdone 完成前禁止 startRecord，否则部分机型预览一直黑屏 */
    this._cameraInitDone = false;

    // 自动模式数据监听
    this._onBleDataUpdate = this._onBleDataUpdate.bind(this);
    eventBus.on('BLE_DATA_UPDATE', this._onBleDataUpdate);
    this._onBleConnectionUpdate = this._onBleConnectionUpdate.bind(this);
    eventBus.on('BLE_CONNECTION_UPDATE', this._onBleConnectionUpdate);

    /** 自动记分更新节流戳 */
    this._lastBleUpdateAt = 0;

    // 机型白名单：由 app.js 冷启动评估；live 页只读镜像一份到 data，驱动调试工具条可见性。
    this.setData({
      enhanceWhitelisted: !!(app.globalData && app.globalData.enableEnhanceRender),
      // VK 入口与增强白名单绑定：若因熔断或机型未过白名单导致 enableEnhanceRender=false，
      // 则 VK 入口一并隐藏（否则 VK 切出→standard 时 _maybeBootEnhanceRender 会 early return，
      // 导致相机重建后无锐化、_pendingEnhanceModeAfterVk 永不被消费）。
      enhanceVkSupported: !!(app.globalData
        && app.globalData.vkModeSupported
        && app.globalData.enableEnhanceRender)
    });
    
    // 检查蓝牙管理器当前状态，同步初始模式（可选，默认手动）
    if (bleManager.isConnected) {
      console.log('[Live] BLE is connected, ready for AutoMode');
    }

    this._rollingKickoffTimer = null;
    this._opsToolsTimer = null;
    this._opsAckTimer = null;
    this._healthTimer = null;
    this._liveFileStorageTimer = null;
    this._lastLiveStorageProbeAt = 0;
    this._lastLiveStorageProbeLevel = 'ok';
    /** 每次 onLoad 重置，确保 severe Modal 只在当次开播 kickoff 时弹一次 */
    this._liveStorageEntryModalShown = false;
    /** 当次进入 live 页是否已对 severe 档位执行过一次「删最旧高光 + 清 rolling」 */
    this._liveSevereKickoffPruneDone = false;
    /** 紧急释放中，上次执行高光实体删最旧的时间戳。 */
    this._lastEmergencyClipPruneAt = 0;
    /** onShow 后若相机 init 回调丢失，超时强制重建（见 _liveCoreOnShowAfterEntitlement）。 */
    this._cameraShowInitWatchTimer = null;
    /** {@link maybeNotifyLiveStoragePressure} 延迟 showModal 的句柄；hide/unload 时清除 */
    this._liveStorageSevereModalTimer = null;
    this.rollingFsBusy = false;
    this._rollingPersistInFlight = 0;
    this._postUserLocalPersistCooldownMs = 0;
    this._recoveryLock = false;
    this._hardRecoverAwaitingCamera = false;
    this._recoveryGuardTimer = null;
    this._recoverProgTimer = null;
    this._recoverProgressResetTimer = null;
    this._recoveryFailSafeTimer = null;
    /** 长按状态钮后通常会跟一次 tap，需吞掉避免误触保存/二次恢复 */
    this._recoveryFabLongPressConsumed = false;
    /** 自动恢复节流戳，避免 camera error/stop 连续抖动触发恢复风暴。 */
    this._lastAutoRecoveryAt = 0;
    /** 相机异常连续计数；用于更稳地判定硬恢复时机。 */
    this._cameraFaultStreak = 0;
    /** 健康日志内存缓冲与落盘节流定时器。 */
    this._healthLogs = [];
    this._healthLogFlushTimer = null;
    this._healthLogStorageKey = 'LIVE_HEALTH_LOGS_V1';
    /** 当前 live 页是否处于前台（onShow/onHide）；后台时不应触发相机硬恢复。 */
    this._livePageVisible = false;
    /** 远程诊断上报节流定时器 */
    this._remoteHealthLogTimer = null;
    /** 权益校验串行锁，避免 onLoad/onShow/重试并发导致重复挂载 camera。 */
    this._entitlementChecking = false;
    this._entitlementOnAllowedQueue = [];
    /** 进入 live 后首次权益通过即置 true；本次会话内 onShow 不再复检，避免直播中断网触发 teardown。 */
    this._entitlementEverAllowedInSession = false;
    /** severe 解除后的 rolling 恢复保护窗口（截止时间戳）；窗口内不应将短暂无段误判为 ERR。 */
    this._storageSevereRecoveryUntil = 0;
    /** 最近一次 manual relaunch 原因（用于按故障类型精准解锁）。 */
    this._manualRelaunchReason = '';
    /** 相机重建锁，避免短时多次重建触发 “can insert only one camera”。 */
    this._cameraRebuildLock = false;
    this._cameraRebuildQueue = [];
    /** 相机重建代次；每次 unmount + rebuild 递增，用于丢弃过期 remount 回调。 */
    this._cameraRebuildGeneration = 0;
    /** 相机 remount 进行中标记，避免同一代次重复 setData(cameraMounted=true)。 */
    this._cameraMountInFlight = false;
    this._cameraMountInFlightGeneration = 0;
    /** 最近一次硬恢复时间戳：防止短时连点/连错触发恢复风暴。 */
    this._lastHardRecoverAt = 0;
    /** temp 丢失风暴触发硬恢复的节流戳。 */
    this._lastTempMissingStormRecoverAt = 0;
    /** 硬恢复最小间隔（毫秒）。 */
    this._hardRecoverMinGapMs = 2200;
    /** insertCamera 冲突后的自动恢复冷静期截止时间。 */
    this._insertCameraRecoverCooldownUntil = 0;
    /** camera 组件重建额外延迟（毫秒），在 insertCamera 冲突后动态抬高。 */
    this._cameraRebuildExtraDelayMs = 0;
    /** insertCamera 冲突连续计数。 */
    this._insertCameraErrorStreak = 0;
    /** insertCamera 冲突后单次延迟重试定时器。 */
    this._insertCameraRetryTimer = null;
    /** insertCamera 冲突恢复进行中标记，避免并发恢复。 */
    this._insertConflictRecovering = false;
    this._startOneSegmentInFlight = false;
    this._segmentStartRetryTimer = null;
    this._segmentStartRecoveringFromIsRecording = false;
    this._segmentStartRecoveringFromOperateFail = false;
    this._rollingTempMissingStreak = 0;
    this._rollingTempTerminalFailStreak = 0;
    this._lastSegmentOperateFailAt = 0;
    this.segmentPersistFailStreak = 0;
    this.segmentStartFailStormCycles = 0;
    /** 当前是否进入“仅允许长按重启”故障态。 */
    this._needManualRelaunch = false;
    /** 状态灯长按重启计时器（比默认 longpress 更长）。 */
    this._relaunchPressTimer = null;
    /** 最近一次 camera 卸载时间戳（用于重挂前等待）。 */
    this._lastCameraUnmountAt = 0;
    /** 回放期间是否已主动暂停滚动录制。 */
    this._rollingPausedForReplay = false;
    /** 当前 rolling 段开始录制的墙钟时间（ms），用于高光逻辑起播偏移 */
    this._currentRollingSegmentRecordStartMs = 0;
    /** isRecovering UI 兜底定时器（与 camera init 超时分离） */
    this._recoverUiFailsafeTimer = null;
    /** 链式回放：待置顶 slot（0/1），等 timeupdate 出画后再 setData，减轻黑帧 */
    this._replayPendingActiveSlot = null;
    /** 链式回放：各 slot 是否已做过后台 prime，避免重复 */
    this._replayPrimedSlot0 = false;
    this._replayPrimedSlot1 = false;
    /** 链式回放：待置顶兜底定时器 */
    this._replayPendingFallbackTimer = null;
    /** 单段高光：媒体时间达到该值即结束回放（秒，含点击时刻）；双段时首段用 null */
    this._replayStopAtMediaSec = null;
    /** 双段高光：第二段文件从 0 播放到该媒体时间（秒）即结束 */
    this._replayChainPart2StopAt = null;
    /** 回放转场定时器：用于中断/反复回放时统一清理，避免定时任务堆积 */
    this._replayStartTimer = null;
    this._replayMaskHideTimer = null;
    this._replayOutroTimer = null;
    this._replayPrimeTimerA = null;
    this._replayPrimeTimerB = null;
    this._vkDebugHotkeyHandler = null;
    this.initHealthLogs();

    this.syncMatchConfigFromPageSources();

    // 1. 隐藏小程序左上角的返回/主页按钮（沉浸式第一步）
    if (wx.hideHomeButton) {
      wx.hideHomeButton();
    }

    // 2. 动态设置窗口背景色为纯黑
    wx.setBackgroundColor({
      backgroundColor: '#000000',
      backgroundColorTop: '#000000',
      backgroundColorBottom: '#000000',
    });

    // 3. 强制状态栏/导航栏为黑色
    wx.setNavigationBarColor({
      frontColor: '#ffffff',
      backgroundColor: '#000000',
      animation: { duration: 0 }
    });

    // 保持屏幕常亮
    wx.setKeepScreenOn({
      keepScreenOn: true,
      fail: () => {
        setTimeout(() => wx.setKeepScreenOn({ keepScreenOn: true }), 1000);
      }
    });

    // 强制横屏（需要 pageOrientation: "auto"）
    if (wx.setPageOrientation) {
      wx.setPageOrientation({ orientation: 'landscape' });
    }

    try {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ['shareAppMessage']
      });
    } catch (e) {
      // 低版本基础库忽略
    }

    this._windowResizeListener = function () {
      try {
        this._updateLiveStageLayout();
        this.updateTeamGroupWidth(true);
      } catch (eRz) { }
    }.bind(this);
    if (wx.onWindowResize) {
      try {
        wx.onWindowResize(this._windowResizeListener);
      } catch (eWz) { }
    }
    try {
      this._updateLiveStageLayout();
    } catch (eL0) { }

    // 直播核心拉起统一放在 onShow，避免 onLoad + onShow 并发触发 camera 重建。
  },

  onUnload: function () {
    this._cleanup(); // 现有的清理逻辑
    eventBus.off('BLE_DATA_UPDATE', this._onBleDataUpdate);
    eventBus.off('BLE_CONNECTION_UPDATE', this._onBleConnectionUpdate);
    wx.setKeepScreenOn({ keepScreenOn: false });
  },

  // ─── 蓝牙自动模式逻辑 ──────────────────────────────────

  _onBleConnectionUpdate: function (res) {
    if (!res.connected && this.data.isAutoMode) {
      console.warn('[Live] BLE disconnected in AutoMode, switching back to manual');
      this.setData({ isAutoMode: false }, () => {
        this.updateTeamGroupWidth(true);
      });
      wx.showToast({
        title: '采集端连接断开，已恢复手动模式',
        icon: 'none',
        duration: 2500
      });
    }
  },

  _onBleDataUpdate: function (data) {
    const now = Date.now();
    // 节流：如果是密集数据包，限制更新频率（约 10fps）以防 UI 卡死
    if (now - this._lastBleUpdateAt < 100) {
      return;
    }
    this._lastBleUpdateAt = now;

    try {
      if (!this.data.isAutoMode) {
        // 即使不在自动模式，也更新倒计时显示用的缓存值
        this.setData({
          bleMinutes: data.minutes,
          bleSeconds: data.seconds,
          bleShotClock: data.shotClock
        });
        return;
      }

      // 自动模式：全量同步
      const mc = this.data.matchConfig;
      let changed = false;

      if (mc.teamA.score !== data.homeScore) {
        mc.teamA.score = data.homeScore;
        changed = true;
      }
      if (mc.teamB.score !== data.awayScore) {
        mc.teamB.score = data.awayScore;
        changed = true;
      }
      if (mc.period !== data.period) {
        mc.period = data.period;
        changed = true;
      }

      const patch = {
        bleMinutes: data.minutes,
        bleSeconds: data.seconds,
        bleShotClock: data.shotClock
      };

      if (changed) {
        patch.matchConfig = mc;
        // 同步到全局
        app.globalData.matchConfig = mc;
        wx.setStorageSync('matchConfig', mc);
      }

      this.setData(patch);
    } catch (e) {
      console.error('[Live] _onBleDataUpdate error:', e);
    }
  },

  onPeriodLongPress: function () {
    const self = this;

    // 白名单检查：仅允许特定设备/用户使用实验功能
    if (!this.data.enhanceWhitelisted) {
      wx.showModal({
        title: '提示',
        content: '该功能需要设备支持，请联系客服！',
        showCancel: false
      });
      return;
    }

    const items = this.data.isAutoMode ? ['恢复手动记分'] : ['切换至自动记分（敬请期待）'];
    
    wx.showActionSheet({
      itemList: items,
      itemColor: this.data.isAutoMode ? '#FF4D4F' : '#4ADE80',
      success: (res) => {
        if (res.tapIndex === 0) {
          const nextMode = !self.data.isAutoMode;
          
          if (nextMode && !bleManager.isConnected) {
            wx.showModal({
              title: '提示',
              content: '蓝牙尚未连接，请先在同步实验室页面连接采集端。',
              showCancel: false
            });
            return;
          }

          self.setData({ isAutoMode: nextMode }, () => {
            self.updateTeamGroupWidth(true);
          });
          wx.showToast({
            title: nextMode ? '已切换至自动模式' : '已恢复手动模式',
            icon: 'none'
          });
        }
      }
    });
  },


  /**
   * 初始化直播健康日志缓冲。
   * 设备信息只采集一次存入 header，避免每条 log 都重复写相同字段浪费体积。
   * @returns {void}
   */
  initHealthLogs: function () {
    try {
      const raw = wx.getStorageSync(this._healthLogStorageKey);
      this._healthLogs = Array.isArray(raw) ? raw.slice(-120) : [];
    } catch (e) {
      this._healthLogs = [];
    }
    try {
      const sys = wx.getSystemInfoSync();
      this._healthLogDevice = {
        model: String(sys.model || ''),
        brand: String(sys.brand || ''),
        platform: String(sys.platform || ''),
        wxVersion: String(sys.version || ''),
        system: String(sys.system || ''),
        /** 小程序基础库版本，与接口文档 `device.libVersion` 对齐 */
        libVersion: String(sys.SDKVersion || '')
      };
    } catch (e) {
      this._healthLogDevice = {};
    }
    this.appendHealthLog('page_load', {});
  },

  /**
   * 追加一条健康日志（环形缓冲，控制体积）。
   * 每条仅存 timestamp + event + detail，设备信息统一由 header 承载。
   * @param {string} eventName 事件名
   * @param {Record<string, unknown>} [detail] 事件详情
   * @returns {void}
   */
  appendHealthLog: function (eventName, detail) {
    const item = {
      t: Date.now(),
      e: String(eventName || '?'),
      d: detail && typeof detail === 'object' ? detail : {}
    };
    this._healthLogs.push(item);
    if (this._healthLogs.length > 120) {
      this._healthLogs.splice(0, this._healthLogs.length - 120);
    }
    this.scheduleHealthLogFlush();
    const ev = item.e;
    if (
      ev === 'hard_recover_fail'
      || ev === 'hard_recover_start'
      || ev === 'manual_relaunch_required'
      || ev === 'segment_start_fail_storm_cycle'
      || ev === 'camera_insert_conflict'
      || ev === 'hard_recover_skip_page_hidden'
      || ev === 'camera_fault_recovery_skip_page_hidden'
      || ev === 'stop_record_fail'
      || ev === 'rolling_persist_temp_gone_presync'
      || ev === 'segment_persist_reject_temp_unstable'
      || ev === 'rolling_persist_phase7_temp_missing_abort'
      || ev === 'highlight_finalize_no_segments'
      || ev === 'highlight_abort_no_fresh_rolling'
      || ev === 'highlight_hard_timeout_unlock'
    ) {
      this.scheduleRemoteHealthLogUpload(ev);
    }
  },

  /**
   * 节流写入健康日志到 storage，避免频繁 IO 干扰直播。
   * @returns {void}
   */
  scheduleHealthLogFlush: function () {
    if (this._healthLogFlushTimer) return;
    this._healthLogFlushTimer = setTimeout(() => {
      this._healthLogFlushTimer = null;
      try {
        wx.setStorageSync(this._healthLogStorageKey, this._healthLogs.slice(-240));
      } catch (e) { }
    }, 1800);
  },

  /**
   * 收集 rolling / 相机管线瞬时状态，供健康日志与远程诊断上报。
   * @param {Record<string, unknown>} [extra] 与现场事件相关的附加字段
   * @returns {Record<string, unknown>}
   */
  getLiveRollingDiagSnapshot: function (extra) {
    let matchId = '';
    try {
      matchId = String(wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '');
    } catch (eMid) {
      matchId = '';
    }
    const base = {
      v: 1,
      matchId,
      pageVisible: !!this._livePageVisible,
      rollingActive: !!this.rollingActive,
      rollingSessionId: this.rollingSessionId,
      segmentCounter: this.segmentCounter,
      isRecording: !!this.data.isRecording,
      rollingFsBusy: !!this.rollingFsBusy,
      rollingPersistInFlight: this._rollingPersistInFlight || 0,
      cameraInitDone: !!this._cameraInitDone,
      isRecovering: !!this.data.isRecovering,
      recoveryLock: !!this._recoveryLock,
      enhanceMode: this.data.enhanceMode || 'off',
      enhanceCanvasVisible: !!this.data.enhanceCanvasVisible,
      enhanceVkTransitioning: !!this.data.enhanceVkTransitioning,
      pipelineHealth: this.data.pipelineHealth || '',
      startRecordFailStreak: this.startRecordFailStreak,
      segmentStartFailStormCycles: this.segmentStartFailStormCycles || 0,
      lastSegmentAgeMs:
        this.lastSegmentAt > 0 ? Date.now() - this.lastSegmentAt : -1,
      postUserLocalPersistCooldownMs: this._postUserLocalPersistCooldownMs || 0,
      hasPendingHighlight: !!this.pendingHighlight,
      isSavingHighlight: !!this.data.isSavingHighlight,
      storageWatermarkLevel: this.storageWatermarkLevel || 0,
      needManualRelaunch: !!this._needManualRelaunch
    };
    return Object.assign(base, extra || {});
  },

  /**
   * 将近期健康日志异步上报服务端；**不强制登录**，无 token 仍会上报（服务端不关联 openid）。
   * @param {string} reason 触发原因（事件名或汇总标签）
   * @returns {void}
   */
  scheduleRemoteHealthLogUpload: function (reason) {
    if (this._remoteHealthLogTimer) {
      this._remoteHealthLogPendingReason = reason || this._remoteHealthLogPendingReason;
      return;
    }
    this._remoteHealthLogPendingReason = reason || 'batch';
    this._remoteHealthLogTimer = setTimeout(() => {
      this._remoteHealthLogTimer = null;
      this.flushRemoteHealthLogsNow(this._remoteHealthLogPendingReason || 'batch');
      this._remoteHealthLogPendingReason = '';
    }, 14000);
  },

  /**
   * 构造诊断接口要求的自定义 Header，与 Body `device` 一并供服务端合并入 device_json。
   * @returns {Record<string, string>}
   */
  buildDiagnosticLogHeaders: function () {
    const dev = this._healthLogDevice || {};
    const model = typeof dev.model === 'string' ? dev.model : '';
    const system = typeof dev.system === 'string' ? dev.system : '';
    const wxVer = typeof dev.wxVersion === 'string' ? dev.wxVersion : '';
    let infoJson = '{}';
    try {
      infoJson = JSON.stringify(dev);
    } catch (eJson) {
      infoJson = '{}';
    }
    if (infoJson.length > 4090) {
      infoJson = `${infoJson.slice(0, 4090)}…`;
    }
    const clientDevice = [model, system].filter(Boolean).join(' / ').slice(0, 240);
    return {
      'X-Client-Device': clientDevice || 'unknown',
      'X-Device-Info': infoJson,
      'X-Wx-Client-Version': wxVer || ''
    };
  },

  /**
   * 立即执行一次远程健康日志上报（内部由 {@link scheduleRemoteHealthLogUpload} 节流调用）。
   * 使用 skipAuth：避免诊断接口返回 401 时触发全局登出；有 token 时仍手动携带 Bearer。
   * @param {string} reason
   * @returns {void}
   */
  flushRemoteHealthLogsNow: function (reason) {
    const logs = (this._healthLogs || []).slice(-80);
    if (logs.length === 0) return;
    const device =
      this._healthLogDevice && typeof this._healthLogDevice === 'object' ? this._healthLogDevice : {};
    const payload = {
      at: Date.now(),
      reason: String(reason || 'unspecified'),
      device,
      diag: this.getLiveRollingDiagSnapshot({}),
      logs
    };
    const token = getToken();
    const header = this.buildDiagnosticLogHeaders();
    if (token) {
      header.Authorization = `Bearer ${token}`;
    }
    post(API_PATH_CLIENT_DIAGNOSTIC_LOG, payload, { skipAuth: true, header })
      .then(() => { })
      .catch(() => { });
  },

  /**
   * 手动导出健康日志到剪贴板，便于现场复现后快速回传排查。
   * @returns {void}
   */
  onExportHealthLogs: function () {
    const logs = (this._healthLogs || []).slice(-100);
    const payload = {
      at: Date.now(),
      device: this._healthLogDevice || {},
      logs
    };
    const text = JSON.stringify(payload);
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showModal({
          title: '诊断日志已复制',
          content: '已复制最近健康日志。请把内容发给我用于定位现场问题。',
          showCancel: false
        });
      },
      fail: () => {
        wx.showToast({ title: '复制失败，请重试', icon: 'none' });
      }
    });
  },

  /**
   * 保存高光的事务开始：快速反馈 + UI 锁，防止重复点击引发 I/O 冲突。
   * @returns {void}
   */
  beginHighlightSaving: function () {
    if (this._highlightRequestLock) return;
    this._highlightRequestLock = true;
    if (this.data.isSavingHighlight) return;
    this.setData({ isSavingHighlight: true });
    if (this._highlightSaveHardTimeoutTimer) {
      clearTimeout(this._highlightSaveHardTimeoutTimer);
      this._highlightSaveHardTimeoutTimer = null;
    }
    let hardTimeoutMs = Math.max(18000, Math.floor(this.segmentDurationMs * 1.6));
    try {
      const si = wx.getSystemInfoSync();
      if (si && si.platform === 'android') {
        hardTimeoutMs = Math.max(
          hardTimeoutMs,
          56000,
          Math.floor(this.segmentDurationMs * 2.25) + 38000
        );
      }
    } catch (eHt) { }
    this._highlightSaveHardTimeoutTimer = setTimeout(() => {
      if (!this.data.isSavingHighlight) return;
      this.appendHealthLog('highlight_hard_timeout_unlock', {});
      this.clearHighlightSavePipelineState();
      this.endHighlightSaving();
      this.recoverRollingPipelineForHighlight();
    }, hardTimeoutMs);
  },

  /**
   * 保存高光的事务结束：关闭 loading + 释放锁。
   * @returns {void}
   */
  endHighlightSaving: function () {
    this._highlightRequestLock = false;
    if (this.data.isSavingHighlight) {
      this.setData({ isSavingHighlight: false });
    }
    this.stopHighlightSaveProgressAnim();
    if (this._highlightSaveHardTimeoutTimer) {
      clearTimeout(this._highlightSaveHardTimeoutTimer);
      this._highlightSaveHardTimeoutTimer = null;
    }
    const deferred = this._replayDeferredItem;
    this._replayDeferredItem = null;
    if (deferred && typeof deferred === 'object') {
      /**
       * 略延迟：避免与刚结束的 stopRecord/落盘同一帧抢相机；并与 pauseRollingForReplay 真正完成对齐。
       */
      setTimeout(() => {
        if (!this._livePageVisible) return;
        this.startReplay(deferred);
      }, 320);
    }
  },

  /**
   * 停止高光保存进度环（状态灯上的低透明度 conic）。
   * @returns {void}
   */
  stopHighlightSaveProgressAnim: function () {
    if (this._highlightSaveProgressTimer) {
      clearInterval(this._highlightSaveProgressTimer);
      this._highlightSaveProgressTimer = null;
    }
    if ((this.data.highlightSaveConicEndDeg || 0) > 0) {
      this.setData({ highlightSaveConicEndDeg: 0 });
    }
  },

  /**
   * 在状态灯上展示从点击到本段结束（或短落地）的保存进度，无 Toast、低打扰。
   *
   * @param {number} startWallMs 进度起点墙钟（通常为点击时刻）
   * @param {number} endWallMs 进度终点墙钟（自然分段场景为当前段理论结束）
   * @returns {void}
   */
  startHighlightSaveProgressAnim: function (startWallMs, endWallMs) {
    this.stopHighlightSaveProgressAnim();
    const start = typeof startWallMs === 'number' ? startWallMs : Date.now();
    const end = typeof endWallMs === 'number' ? endWallMs : start + 600;
    /** 与硬恢复同口径：总时长随「本段剩余墙钟」变动，进度与真实等待同步 */
    const total = Math.max(120, end - start);
    const tick = () => {
      if (!this.data.isSavingHighlight) {
        this.stopHighlightSaveProgressAnim();
        return;
      }
      const t = Date.now();
      const p = Math.max(0, Math.min(1, (t - start) / total));
      /** 参照硬恢复：爬升阶段最高约 88% 圆周，满环在落盘完成时一次拉满 */
      let deg;
      if (p >= 1) {
        deg = 360;
      } else {
        const pct = Math.min(88, Math.round(p * 100));
        deg = Math.round(pct * 3.6);
      }
      this.setData({ highlightSaveConicEndDeg: deg });
      if (p >= 1 && this._highlightSaveProgressTimer) {
        clearInterval(this._highlightSaveProgressTimer);
        this._highlightSaveProgressTimer = null;
      }
    };
    tick();
    this._highlightSaveProgressTimer = setInterval(tick, 100);
  },

  /**
   * 重置「截断保存」双闸门状态（出错、会话失效、页面离开时调用）。
   * @returns {void}
   */
  clearHighlightSavePipelineState: function () {
    this._highlightSaveAwaitingResume = false;
    this._highlightPipelineDoneFinalize = false;
    this._highlightPipelineDoneResume = false;
    this._highlightSaveSessionId = 0;
    if (this._highlightResumeUnlockFallbackTimer) {
      clearTimeout(this._highlightResumeUnlockFallbackTimer);
      this._highlightResumeUnlockFallbackTimer = null;
    }
    if (this._highlightResumeGuardTimer) {
      clearTimeout(this._highlightResumeGuardTimer);
      this._highlightResumeGuardTimer = null;
    }
    if (this._highlightDeferredStopTimer) {
      clearTimeout(this._highlightDeferredStopTimer);
      this._highlightDeferredStopTimer = null;
    }
  },

  /**
   * finalize 与下一段录制均完成时释放 {@link data.isSavingHighlight}。
   * @returns {void}
   */
  maybeReleaseHighlightSaveLock: function () {
    if (!this._highlightSaveAwaitingResume) return;
    if (this._highlightPipelineDoneFinalize && this._highlightPipelineDoneResume) {
      this.clearHighlightSavePipelineState();
      this.endHighlightSaving();
    }
  },

  /**
   * finalize 已完成但下一段 startRecord 迟迟未成功时，解锁保存锁并触发延迟回放，避免界面永久卡住。
   * @returns {void}
   */
  scheduleHighlightResumeUnlockFallback: function () {
    if (this._highlightResumeUnlockFallbackTimer) {
      clearTimeout(this._highlightResumeUnlockFallbackTimer);
      this._highlightResumeUnlockFallbackTimer = null;
    }
    if (!this._highlightSaveAwaitingResume || !this._highlightPipelineDoneFinalize) {
      return;
    }
    let fallbackMs = 4000;
    try {
      const si = wx.getSystemInfoSync();
      if (si && si.platform === 'android') {
        fallbackMs = 5600;
      }
    } catch (e) {
      fallbackMs = 4000;
    }
    this._highlightResumeUnlockFallbackTimer = setTimeout(() => {
      this._highlightResumeUnlockFallbackTimer = null;
      if (!this._highlightSaveAwaitingResume) return;
      if (!this._highlightPipelineDoneFinalize) return;
      this.appendHealthLog('highlight_resume_unlock_fallback', {});
      this._highlightPipelineDoneResume = true;
      this.maybeReleaseHighlightSaveLock();
    }, fallbackMs);
  },

  /**
   * stopRecord 未产出文件或失败时，取消本次等待中的时间高光并解锁 UI。
   * @param {number} sessionId 发起 stop 时的 rolling 会话 id
   * @param {string} reason 诊断用原因码
   * @returns {void}
   */
  abortHighlightAfterStopIfNeeded: function (sessionId, reason) {
    if (!this.pendingHighlight) return;
    this.appendHealthLog('highlight_time_pending_abort', { sessionId, reason });
    if (reason === 'segment_persist_fail' || reason === 'segment_persist_unstable') {
      this.segmentPersistFailStreak = (this.segmentPersistFailStreak || 0) + 1;
      if (this.segmentPersistFailStreak >= 4) {
        this.segmentPersistFailStreak = 0;
        this.markNeedManualRelaunch('segment_persist_fail_streak');
      }
    }
    this.clearHighlightSavePipelineState();
    if (this._recorderCore) {
      this._recorderCore.clearPendingHighlight();
    } else {
      this.pendingHighlight = null;
    }
    this.endHighlightSaving();
    /**
     * iOS 上 persist 失败后 rolling 易与相机争用进入 start_fail；中止高光后软恢复 rolling，
     * 避免仅解锁 UI 而录制链仍处于亚健康（参考 segment_persist_reject_temp_unstable 日志链）。
     */
    if (reason === 'segment_persist_unstable' || reason === 'segment_persist_fail') {
      let recoverDelayMs = 140;
      try {
        const siAb = wx.getSystemInfoSync();
        if (siAb && siAb.platform === 'ios') {
          recoverDelayMs = 420;
        }
      } catch (eAb) {
        recoverDelayMs = 140;
      }
      setTimeout(() => {
        this.recoverRollingPipelineForHighlight();
      }, recoverDelayMs);
    }
  },

  // 相机初始化完成回调
  onCameraInit: function (e) {
    if (this._cameraShowInitWatchTimer) {
      clearTimeout(this._cameraShowInitWatchTimer);
      this._cameraShowInitWatchTimer = null;
    }
    const maxZoom = e.detail.maxZoom || 5;
    var minZoomRaw = null;
    if (typeof e.detail.minZoom === 'number' && isFinite(e.detail.minZoom)) {
      minZoomRaw = e.detail.minZoom;
    } else if (e.detail.minZoom != null && e.detail.minZoom !== '') {
      var parsedMz = parseFloat(String(e.detail.minZoom));
      if (isFinite(parsedMz)) minZoomRaw = parsedMz;
    }
    const minZoom = minZoomRaw !== null ? minZoomRaw : 1;
    var previewZ = getDefaultPreviewZoomForMax(maxZoom);
    this.setData({
      maxZoom: maxZoom,
      minZoom: minZoom,
      zoom: previewZ,
      cameraViewMode: CameraViewMode.NORMAL
    });
    /**
     * VK 模式下尚无可用 cameraContext.setZoom；若仍调 updateZoom(1) 会被 vk 守卫拦截。
     * iOS 上小程序 camera 的 zoom=2 更接近系统相机「1×」主摄，默认从此起播避免一进来就是最广视角。
     */
    if (this.data.enhanceMode !== 'vk') {
      /**
       * Android：&lt;camera zoom="{{zoom}}"&gt; 与 context.setZoom 需与 data.zoom 一致，否则下一帧属性会覆盖 setZoom，
       * 小米等机型上表现为亚 1× 无效、广角与 1× 相同。iOS 保持同步调用。
       */
      if (isLiveHostIos()) {
        if (this.data.cameraContext && this.data.cameraContext.setZoom) {
          try {
            this.data.cameraContext.setZoom({ zoom: previewZ });
          } catch (ez) { }
        }
        this.maybeSchedulePostZoomSilentFocus();
        this.detectCameraCapabilities({
          minZoom: minZoomRaw,
          maxZoom: maxZoom
        });
      } else {
        var selfInit = this;
        var pzInit = previewZ;
        var capMz = minZoomRaw;
        var capMax = maxZoom;
        setTimeout(function () {
          selfInit.setData({ zoom: pzInit }, function () {
            if (selfInit.data.cameraContext && selfInit.data.cameraContext.setZoom) {
              try {
                selfInit.data.cameraContext.setZoom({ zoom: pzInit });
              } catch (ez2) { }
            }
            selfInit.maybeSchedulePostZoomSilentFocus();
            selfInit.detectCameraCapabilities({
              minZoom: capMz,
              maxZoom: capMax
            });
          });
        }, 0);
      }
    }
    if (this._rollingKickoffTimer) {
      clearTimeout(this._rollingKickoffTimer);
      this._rollingKickoffTimer = null;
    }
    this._cameraInitDone = true;
    /**
     * 硬件 EV 能力探测：只要 cameraContext 上存在任一官方/灰度接口即视为支持。
     * 不支持的机型直接隐藏曝光滑条——小程序 <camera> 是原生层渲染，JS 无法介入视频流像素，
     * 所谓“软补光”只能在预览层叠加半透明遮罩，既不会写入录制文件，又会误导用户，
     * 因此不给不支持的机型提供任何“软补光”兜底（参考本次需求说明）。
     */
    this.detectExposureHardwareSupport();
    /**
     * 相机上下文若被系统回收/重建，恢复上次用户设置，避免“重启后锁焦与曝光丢失”。
     * 注：AF/AE 是否真正生效仍取决于机型能力，但会尽最大可能重放参数。
     */
    if (this._lastFocusNorm && this.data.aeControlsVisible) {
      this.invokeSetTargetFocus(this._lastFocusNorm.nx, this._lastFocusNorm.ny);
    }
    if (typeof this._exposureNormPending === 'number' && this.data.aeExposureHardwareSupported) {
      this.applyExposureFromNorm(this._exposureNormPending);
    }
    if (this._hardRecoverAwaitingCamera) {
      this._hardRecoverAwaitingCamera = false;
      if (this._recoveryGuardTimer) {
        clearTimeout(this._recoveryGuardTimer);
        this._recoveryGuardTimer = null;
      }
      if (this._recoverUiFailsafeTimer) {
        clearTimeout(this._recoverUiFailsafeTimer);
        this._recoverUiFailsafeTimer = null;
      }
      if (this._recoveryFailSafeTimer) {
        clearTimeout(this._recoveryFailSafeTimer);
        this._recoveryFailSafeTimer = null;
      }
      this.stopRecoveryProgressAnim(true);
      this.setData({ isRecovering: false, showRecoveryVeil: false });
      this._recoveryLock = false;
      if (this._recorderCore) {
        this._recorderCore.onRecoverSuccess('camera_init');
      }
      if (this._manualRecoveryPendingAck) {
        this._manualRecoveryPendingAck = false;
        this.emitRecoverySuccessFeedback();
      }
      this.updatePipelineHealth();
    }
    this._cameraFaultStreak = 0;
    this._insertCameraErrorStreak = 0;
    this._cameraRebuildExtraDelayMs = 0;
    this._insertCameraRecoverCooldownUntil = 0;
    this._insertConflictRecovering = false;
    this.segmentStartFailStormCycles = 0;
    this._needManualRelaunch = false;
    if (this._insertCameraRetryTimer) {
      clearTimeout(this._insertCameraRetryTimer);
      this._insertCameraRetryTimer = null;
    }
    if (this._relaunchPressTimer) {
      clearTimeout(this._relaunchPressTimer);
      this._relaunchPressTimer = null;
    }
    this._insertConflictRecovering = false;
    this.appendHealthLog('camera_init', { maxZoom: maxZoom, minZoom: minZoom });
    if (this._recorderCore) {
      this._recorderCore.markReady('camera_init');
    }
    // 增强渲染（灰度）：仅在 app.globalData.enableEnhanceRender=true 时拉起；
    // 与 rolling startRecord 通过 onCameraFrame 共存，不占用相机独占权。
    this._maybeBootEnhanceRender();
    this.tryStartRollingWhenCameraReady();
  },

  /**
   * 按 app.globalData.enableEnhanceRender 决定是否拉起增强渲染管线。
   * 幂等：存在旧管线先销毁再重建（硬恢复后调用同样安全）。
   * @returns {void}
   */
  _maybeBootEnhanceRender: function () {
    var enabled = !!(app.globalData && app.globalData.enableEnhanceRender);
    if (!enabled) return;
    var initial = this._pendingEnhanceModeAfterBoot
      || this._pendingEnhanceModeAfterVk
      || this._pendingEnhanceModeAfterCameraRebuild
      || this._pendingEnhanceModeAfterRecover
      || 'off';
    if (initial === 'off') {
      this._pendingEnhanceModeAfterBoot = null;
      this._pendingEnhanceModeAfterVk = null;
      this._pendingEnhanceModeAfterCameraRebuild = null;
      this._pendingEnhanceModeAfterRecover = null;
      if (this.data.enhanceCanvasVisible || this.data.enhanceMode !== 'off') {
        this.setData({ enhanceCanvasVisible: false, enhanceMode: 'off' });
      }
      return;
    }
    if (!this.data.cameraContext) return;
    if (this._renderPipeline) {
      try { this._renderPipeline.destroy(); } catch (eDestroy) { }
      this._renderPipeline = null;
    }
    var cssW = 375;
    var cssH = 667;
    try {
      var si = wx.getSystemInfoSync();
      cssW = si.windowWidth || cssW;
      cssH = si.windowHeight || cssH;
    } catch (eInfo) { }
    var stageBox = computeLiveStage16x9SizePx(cssW, cssH);
    try {
      this._updateLiveStageLayout();
    } catch (eL2) { }
    var self = this;
    // 先挂 canvas 节点（wx:if），下一 tick 再 init，确保节点已进入渲染树。
    this.setData({ enhanceCanvasVisible: true }, function () {
      var pipeline = renderPipelineMod.createRenderPipeline();
      self._renderPipeline = pipeline;
      pipeline.init({
        page: self,
        cameraContext: self.data.cameraContext,
        canvasSelector: '#enhanceCanvas',
        cssW: stageBox.w,
        cssH: stageBox.h,
        // VK 分支保留接口但本轮不启用：保守优先，避免与 startRecord 冲突
        preferVk: false
      }).then(function () {
        if (self._renderPipeline !== pipeline) return;
        var initial = self._pendingEnhanceModeAfterBoot
          || self._pendingEnhanceModeAfterVk
          || self._pendingEnhanceModeAfterCameraRebuild
          || self._pendingEnhanceModeAfterRecover
          || 'off';
        self._pendingEnhanceModeAfterBoot = null;
        self._pendingEnhanceModeAfterCameraRebuild = null;
        pipeline.setMode(initial, { reason: 'user', force: true });
        if (initial !== 'off') {
          pipeline.start();
        }
        self.syncNativeEnhanceZoomCompensation(self.data.zoom || 1);
        self.appendHealthLog('enhance_render_boot', {
          mode: pipeline.getMode(),
          reason: (app.globalData && app.globalData.enhanceWhitelistReason) || '',
          device: (app.globalData && app.globalData.enhanceDeviceTag) || ''
        });
        // 若刚从 VK 切回，消费 pending 目标档位（可能是 'off' / 'standard' / 'strong'）
        if (typeof self._applyPendingEnhanceModeAfterVk === 'function') {
          self._applyPendingEnhanceModeAfterVk();
        }
        if (typeof self._applyPendingEnhanceModeAfterRecover === 'function') {
          self._applyPendingEnhanceModeAfterRecover();
        }
      }).catch(function (err) {
        self._pendingEnhanceModeAfterCameraRebuild = null;
        self._pendingEnhanceModeAfterRecover = null;
        self.appendHealthLog('enhance_render_boot_fail', {
          errMsg: (err && err.message) || String(err),
          reason: (app.globalData && app.globalData.enhanceWhitelistReason) || '',
          device: (app.globalData && app.globalData.enhanceDeviceTag) || ''
        });
        self.setData({ enhanceCanvasVisible: false, enhanceMode: 'off' });
        if (self._renderPipeline === pipeline) {
          try { pipeline.destroy(); } catch (eD) { }
          self._renderPipeline = null;
        }
      });
    });
  },

  /**
   * 销毁增强渲染管线并隐藏 canvas；幂等，未启用时无副作用。
   * 必须在 onHide / onUnload / rebuildCameraComponent 调用，避免旧 cameraContext 的
   * onCameraFrame listener / VKSession / GL 资源悬挂。
   * @returns {void}
   */
  _teardownEnhanceRender: function () {
    this._cleanupVkCanvasHighlightRecording('teardown_enhance');
    if (this._renderPipeline) {
      try { this._renderPipeline.destroy(); } catch (e) { }
      this._renderPipeline = null;
    }
    if (this.data.enhanceCanvasVisible || this.data.enhanceMode !== 'off') {
      this.setData({ enhanceCanvasVisible: false, enhanceMode: 'off' });
    }
  },

  /**
   * 在相机重建前记住当前原生增强档位；rebuild 完成后由 _maybeBootEnhanceRender 恢复。
   * VK 模式使用专门的切换编排，不走这里。
   * @param {string} reason
   * @returns {void}
   */
  armNativeEnhanceModeRestoreAfterCameraRebuild: function (reason) {
    var mode = this.data && this.data.enhanceMode ? String(this.data.enhanceMode) : 'off';
    if (mode === 'vk') return;
    this._pendingEnhanceModeAfterCameraRebuild = mode;
    if (mode !== 'off') {
      this.appendHealthLog('enhance_mode_restore_armed', {
        mode: mode,
        reason: reason || ''
      });
    }
  },

  /**
   * 将直播取景区设为窗口内接 16:9，并同步增强/VK 的 WebGL 画布 CSS 像素，避免全屏与相机比例不一致。
   * 边距为页底黑。
   * @returns {void}
   */
  _updateLiveStageLayout: function () {
    var sysW = 375;
    var sysH = 667;
    var sL = 0;
    var sR = 0;
    var sB = 0;
    try {
      var si = wx.getSystemInfoSync();
      sysW = si.windowWidth || sysW;
      sysH = si.windowHeight || sysH;
      if (si.safeArea) {
        sL = Math.max(0, si.safeArea.left || 0);
        sB = Math.max(0, sysH - (si.safeArea.top + (si.safeArea.height || 0)));
        sR = Math.max(0, sysW - (si.safeArea.left + (si.safeArea.width || 0)));
      }
    } catch (e) { }
    var box = computeLiveStage16x9SizePx(sysW, sysH);
    var style = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
      'width:' + box.w + 'px;height:' + box.h + 'px;';
    var r = computeLiveStage16x9RectPx(sysW, sysH);
    var factor = 750 / Math.max(1, sysW);
    /** 取景区左内缘 + 间距（rpx），呼出条仅在画幅内展示 */
    var panelInsetRpx = 12;
    var leftRpx = r.left * factor + panelInsetRpx;
    var topCenterRpx = (r.top + r.h * 0.5) * factor;
    var cameraSettingsPanelStyle = 'left:' + leftRpx + 'rpx;top:' + topCenterRpx +
      'rpx;transform:translateY(-50%);';
    var corner = buildCornerFabStylesInLetterboxPx(sysW, sysH, r, { sL: sL, sR: sR, sB: sB });
    this.setData({
      liveStageInlineStyle: style,
      cameraSettingsPanelStyle: cameraSettingsPanelStyle,
      leftCameraFabStyle: corner.leftCameraFab,
      recoverFabStackStyle: corner.recoverStack,
      replayRailStyle: corner.replayRail
    });
    if (this._renderPipeline && typeof this._renderPipeline.resizeToCssPixels === 'function') {
      try {
        this._renderPipeline.resizeToCssPixels(box.w, box.h);
      } catch (e1) { }
    }
  },

  /**
   * 启动 VK 独立管线（VKSession v2）。
   *
   * 前置条件（调用方保证）：
   *  - 已 stopRollingRecording 并等待其回调完成（否则 startRecord 与 VK 会抢相机）
   *  - cameraMounted 已置 false 且 setData 回调已经触发（原生 camera 层已卸）
   *
   * 失败处理：
   *  - VK init 抛错 → toast + 自动 orchestrate 切回 standard（重新 mount camera + 重启 rolling）
   *  - VK 运行中 onVkDegrade 触发（FPS<20 / stalled / no frame）→ 同上
   *
   * @returns {void}
   */
  _bootVkPipeline: function () {
    if (!this.data.enhanceVkSupported) return;
    var self = this;
    var cssW = 375;
    var cssH = 667;
    try {
      var si = wx.getSystemInfoSync();
      cssW = si.windowWidth || cssW;
      cssH = si.windowHeight || cssH;
    } catch (eInfo) { }
    var stageBoxVk = computeLiveStage16x9SizePx(cssW, cssH);
    try {
      this._updateLiveStageLayout();
    } catch (eL3) { }
    // 清理旧管线
    if (this._renderPipeline) {
      try { this._renderPipeline.destroy(); } catch (eD) { }
      this._renderPipeline = null;
    }
    this.setData({ enhanceCanvasVisible: true }, function () {
      var pipeline = renderPipelineMod.createRenderPipeline();
      self._renderPipeline = pipeline;
      pipeline.init({
        page: self,
        cameraContext: null,
        canvasSelector: '#enhanceCanvas',
        cssW: stageBoxVk.w,
        cssH: stageBoxVk.h,
        sourceKind: 'vk',
        onVkDegrade: function (info) {
          self._cleanupVkCanvasHighlightRecording('vk_degrade');
          // VK 家族自动降级：orchestrator 切回 standard；向用户 toast 说明
          self.appendHealthLog('vk_auto_degrade', info);
          var reason = info && info.reason;
          var errMsg = info && info.err;
          var title;
          if (reason === 'vk_fatal') {
            // 运行中帧源出事：走 human 文案分派
            title = self._vkErrorToHuman(errMsg || '');
          } else {
            // FPS / stalled 触发的软降级
            title = '超频画面不稳，已回到标准模式';
          }
          try { console.warn('[live][vk] auto-degrade', info); } catch (_) { }
          wx.showToast({
            title: title,
            icon: 'none',
            duration: 3000
          });
          self._orchestrateSwitchFromVk('standard');
          setTimeout(function () {
            try { self.updatePipelineHealth(); } catch (eH) { }
          }, 500);
        }
      }).then(function () {
        if (self._renderPipeline !== pipeline) return;
        pipeline.setMode('vk', { reason: 'user', force: true });
        pipeline.start();
        self._syncVkAdaptiveDebugConfigToPipeline();
        try {
          if (typeof pipeline.setVkZoom === 'function') {
            pipeline.setVkZoom(1);
          }
        } catch (eZ0) { }
        self.setData({
          enhanceVkTransitioning: false,
          zoom: 1,
          cameraViewMode: CameraViewMode.NORMAL
        });
        self._ensureVkTimeshiftRecorder({ keepSavingState: true });
        self._maybeToastVkViewModeOnce();
        self.appendHealthLog('vk_boot_ok', {
          device: (app.globalData && app.globalData.enhanceDeviceTag) || '',
          reason: (app.globalData && app.globalData.vkModeReason) || ''
        });
      }).catch(function (err) {
        var msg = (err && (err.message || err.errMsg)) || String(err);
        var code = (err && err.errCode) ? String(err.errCode) : '';
        self.appendHealthLog('vk_boot_fail', {
          errMsg: msg,
          errCode: code,
          device: (app.globalData && app.globalData.enhanceDeviceTag) || ''
        });
        try { console.error('[live][vk] boot failed', err); } catch (_) { }
        try { pipeline.destroy(); } catch (eD) { }
        if (self._renderPipeline === pipeline) self._renderPipeline = null;
        // 失败 → 自动切回 standard（重建 camera + 重启 rolling）
        self._orchestrateSwitchFromVk('standard');
        // 给用户看真实失败环节（create/start/frame），便于报告定位；不阻塞 orchestrator。
        var human = self._vkErrorToHuman(msg);
        wx.showToast({
          title: human,
          icon: 'none',
          duration: 3200
        });
      });
    });
  },

  /**
   * orchestrator：从原生家族（off/standard/strong）切入 VK。
   *
   * 流程：
   *   1. 二次确认（showModal）
   *   2. setData enhanceVkTransitioning=true
   *   3. 停 rolling（stopRollingRecording 回调）
   *   4. 销毁原有增强管线（原生 onCameraFrame listener）
   *   5. rebuildCameraComponent with cameraMounted=false（占用方式：借道 _cameraRebuildLock）
   *   6. 等待 camera unmount + 硬件释放（一般 400ms 冷却）
   *   7. _bootVkPipeline() 启 VKSession
   *
   * 任何一步失败：置 false、toast、自动回滚到 standard（包含重新启 rolling）。
   *
   * @returns {void}
   */
  _orchestrateSwitchToVk: function () {
    if (this.data.recorderDegradedMode) return;
    if (!this.data.enhanceVkSupported) return;
    if (this.data.enhanceMode === 'vk') return;
    if (this.data.enhanceVkTransitioning) return;
    var self = this;
    wx.showModal({
      title: '超频模式',
      content: '性能要求极高，建议iphone15以上或安卓旗舰机型使用，否则可能出现卡顿拖影等问题。确认进入？',
      confirmText: '进入超频',
      cancelText: '取消',
      confirmColor: '#E64340',
      success: function (res) {
        if (!res || !res.confirm) return;
        self._enhanceModeSwitchGuardUntil = Date.now() + ENHANCE_SWITCH_GUARD_MS;
        self.setData({ enhanceVkTransitioning: true });
        self.appendHealthLog('vk_switch_in_begin', {});
        // 先停 rolling；stopRollingRecording 是幂等的，完成后回调内继续。
        self.stopRollingRecording(function () {
          // 销毁原生增强管线
          self._teardownEnhanceRender();
          self._cameraRebuildGeneration = (self._cameraRebuildGeneration || 0) + 1;
          self._cameraMountInFlight = false;
          self._cameraMountInFlightGeneration = 0;
          // 卸 camera（利用 rebuildCameraComponent 的锁语义，但我们不重新 mount）
          self.setData({
            cameraMounted: false,
            cameraContext: null,
            isRecording: false
          }, function () {
            self._lastCameraUnmountAt = Date.now();
            // 留足时间让原生 camera 句柄释放，避免 VKSession.start 与硬件争用黑屏。
            var bootDelay = VK_BOOT_DELAY_MS_ANDROID;
            try {
              var siVk = wx.getSystemInfoSync();
              if (siVk && siVk.platform === 'ios') bootDelay = VK_BOOT_DELAY_MS_IOS;
            } catch (eVkD) { }
            setTimeout(function () {
              if (!self._livePageVisible) {
                // 中途切后台 → 直接取消
                self.setData({ enhanceVkTransitioning: false });
                return;
              }
              self._bootVkPipeline();
            }, bootDelay);
          });
        });
      }
    });
  },

  /**
   * orchestrator：从 VK 家族切回原生家族（off/standard/strong）。
   *
   * 流程：
   *   1. 立即销毁 VK pipeline（停 VKSession / 释放 GL）
   *   2. setData enhanceVkTransitioning=true
   *   3. rebuildCameraComponent → 重新 mount 原生 <camera>
   *   4. onCameraInit 里走原有 _maybeBootEnhanceRender + tryStartRollingWhenCameraReady
   *   5. 首次 camera 就绪后调 pipeline.setMode(targetMode)
   *
   * 稳定性策略：
   *  - 若 targetMode='off'，则仅走 camera 重建 + 重启 rolling，不启 WebGL 管线
   *  - 若 targetMode ∈ {standard, strong}，等 _maybeBootEnhanceRender 后由它自己 setMode
   *
   * @param {'off'|'standard'|'strong'} targetMode
   */
  _orchestrateSwitchFromVk: function (targetMode) {
    if (this.data.recorderDegradedMode && targetMode !== 'off') {
      targetMode = 'off';
    }
    if (this.data.enhanceMode !== 'vk' && !this.data.enhanceVkTransitioning) {
      // 已不在 VK 模式且没在切换中：仅做普通 setMode
      if (typeof this.setEnhanceMode === 'function') this.setEnhanceMode(targetMode);
      return;
    }
    var self = this;
    self._enhanceModeSwitchGuardUntil = Date.now() + ENHANCE_SWITCH_GUARD_MS;
    self.setData({ enhanceVkTransitioning: true });
    self.appendHealthLog('vk_switch_out_begin', { targetMode: targetMode });
    // 销毁 VK 管线
    self._teardownEnhanceRender();
    // 记下 VK 切出目标，供 onCameraInit 里 boot 后调用 setMode
    self._pendingEnhanceModeAfterVk = targetMode;
    // 重建 camera 组件（rebuildCameraComponent 里会调 _teardownEnhanceRender + mount=false）
    // 然后我们在其回调里 setData({cameraMounted:true}) 触发新组件渲染与 bindinitdone
    self.rebuildCameraComponent(function (generation) {
      var mountExtra = 0;
      try {
        var siMount = wx.getSystemInfoSync();
        if (siMount && siMount.platform === 'ios') mountExtra = VK_POST_TEARDOWN_MOUNT_EXTRA_MS_IOS;
      } catch (eM) { }
      setTimeout(function () {
        if (!self._livePageVisible) return;
        self.remountCameraComponent({
          generation,
          onMounted: function () {
            // camera 的 onCameraInit 会触发 tryStartRollingWhenCameraReady 与 _maybeBootEnhanceRender
            // 这里只负责把转场标志撤掉；真正的 setMode 在 _maybeBootEnhanceRender 完成后被 _applyPendingEnhanceModeAfterVk 消费
            self.setData({ enhanceVkTransitioning: false });
          }
        });
      }, mountExtra);
    });
  },

  /**
   * 在 _maybeBootEnhanceRender 成功后被调用，消费 _pendingEnhanceModeAfterVk 并 setMode。
   * 若目标是 'off'，直接销毁刚启动的增强管线并隐藏 canvas。
   * @returns {void}
   */
  _applyPendingEnhanceModeAfterVk: function () {
    var target = this._pendingEnhanceModeAfterVk;
    if (!target) return;
    this._pendingEnhanceModeAfterVk = null;
    if (target === 'off') {
      this._teardownEnhanceRender();
      return;
    }
    if (this._renderPipeline && typeof this._renderPipeline.setMode === 'function') {
      try { this._renderPipeline.setMode(target, { reason: 'user', force: true }); } catch (e) { }
    }
  },

  /**
   * 零帧自愈重建管线成功后，将档位设回用户所选（非 VK）。
   * @returns {void}
   */
  _applyPendingEnhanceModeAfterRecover: function () {
    var target = this._pendingEnhanceModeAfterRecover;
    if (!target) return;
    this._pendingEnhanceModeAfterRecover = null;
    if (target === 'off') {
      this._teardownEnhanceRender();
      return;
    }
    if (this._renderPipeline && typeof this._renderPipeline.setMode === 'function') {
      try { this._renderPipeline.setMode(target, { reason: 'user', force: true }); } catch (e) { }
    }
  },

  /**
   * 把 vk 管线内部抛出的 error message 翻译成一句面向用户的 toast 文案。
   * frame-source.js 里统一前缀为 [vk:create|start|frame]，这里按前缀分派。
   * @param {string} msg
   * @returns {string}
   */
  _vkErrorToHuman: function (msg) {
    if (!msg) return '超频模式启动失败，已回到标准模式';
    if (msg.indexOf('[vk:create]') !== -1) {
      return '超频初始化失败，本机暂不支持，已回到标准';
    }
    if (msg.indexOf('[vk:start]') !== -1) {
      // session.start 常见：相机未释放干净、权限、机型不在 VK v2 白名单
      return '超频启动被相机拒绝，已回到标准（请退出重进）';
    }
    if (msg.indexOf('getCameraBuffer') !== -1) {
      return '超频通道不兼容当前微信，已回到标准';
    }
    if (msg.indexOf('no_frame_streak') !== -1) {
      return '超频未拿到画面，已回到标准（相机占用中）';
    }
    if (msg.indexOf('[vk:frame]') !== -1) {
      return '超频画面处理异常，已回到标准';
    }
    return '超频模式启动失败，已回到标准';
  },

  /**
   * 动态切换档位（调试入口 / 未来设置页入口）。
   * 管线尚未拉起且非 'off' 时会尝试首次 boot；失败由 pipeline 内部回退到 off。
   * @param {'off'|'lite'|'standard'|'strong'} mode
   * @returns {void}
   */
  setEnhanceMode: function (mode) {
    if (this._cameraRebuildLock) {
      try {
        wx.showToast({ title: '相机重建中，请稍候', icon: 'none', duration: 1200 });
      } catch (eT) { }
      return;
    }
    /**
     * 「关闭」必须销毁整条增强管线：WXML 用 wx:if 控制 canvas，仅 stop 帧源会卸掉节点导致 GL 丢失，
     * 再点标准/高性能会黑屏且互切无效。
     */
    if (mode === 'off') {
      this._teardownEnhanceRender();
      this.resetViewModeToNormal();
      return;
    }
    if (!this._renderPipeline) {
      this._pendingEnhanceModeAfterBoot = mode;
      this._maybeBootEnhanceRender();
      this.resetViewModeToNormal();
      return;
    }
    this._renderPipeline.setMode(mode, { reason: 'user', force: true });
    if (mode !== 'off' && this._renderPipeline && typeof this._renderPipeline.start === 'function') {
      try { this._renderPipeline.start(); } catch (eS) { }
    }
    this.resetViewModeToNormal();
    this.syncNativeEnhanceZoomCompensation(1);
  },

  /**
   * 由 render-pipeline 在档位落到 off（含自动降级/异常）后下一 tick 调用；须比对实例，避免误杀用户新起的管线。
   *
   * @param {Object|null} pipeRef createRenderPipeline() 返回的同一引用
   * @returns {void}
   */
  _deferTeardownEnhanceForPipeline: function (pipeRef) {
    if (!this._livePageVisible) return;
    if (!pipeRef || this._renderPipeline !== pipeRef) return;
    this._teardownEnhanceRender();
  },

  /**
   * camera 非正常中断（如切后台/系统打断）后的恢复入口。
   * @param {WechatMiniprogram.CustomEvent} e
   * @returns {void}
   */
  onCameraStop: function (e) {
    const detail = (e && e.detail) || {};
    const reason = detail && detail.reason ? String(detail.reason) : '';
    this.appendHealthLog('camera_stop', { reason });
    this.triggerCameraFaultRecovery(`stop:${reason}`);
  },

  /**
   * camera 组件错误回调（权限变化、系统相机异常等）。
   * @param {WechatMiniprogram.CustomEvent} e
   * @returns {void}
   */
  onCameraError: function (e) {
    const detail = (e && e.detail) || {};
    const errMsg = detail && detail.errMsg ? String(detail.errMsg) : '';
    this.appendHealthLog('camera_error', { errMsg });
    const lower = errMsg.toLowerCase();
    const isInsertConflict =
      lower.indexOf('can insert only one camera') >= 0
      || lower.indexOf('insertcamera:fail') >= 0;
    if (isInsertConflict) {
      this._insertCameraErrorStreak = (this._insertCameraErrorStreak || 0) + 1;
      const now = Date.now();
      const currentExtra = this._cameraRebuildExtraDelayMs || 0;
      this._cameraRebuildExtraDelayMs = Math.min(2200, Math.max(900, currentExtra + 300));
      this._insertCameraRecoverCooldownUntil = now + 3500;
      this.appendHealthLog('camera_insert_conflict', {
        streak: this._insertCameraErrorStreak,
        rebuildDelayMs: this._cameraRebuildExtraDelayMs
      });
      if (this._insertCameraErrorStreak >= 3) {
        this.markNeedManualRelaunch('insert_conflict_streak');
      }
      if (this._insertCameraRetryTimer) {
        clearTimeout(this._insertCameraRetryTimer);
        this._insertCameraRetryTimer = null;
      }
      /**
       * 根因治理：首次 insert 冲突不立即硬恢复，先做轻量踢管线（不重建 camera 组件）；
       * 仅连续冲突时再升级硬恢复，避免“恢复风暴”反向放大故障。
       */
      if (this._insertCameraErrorStreak <= 1) {
        this.appendHealthLog('camera_insert_conflict_soft_kick', {});
        this.rollingActive = false;
        this.stopRollingRecording(() => {
          this.scheduleAfterStopRecord(() => {
            if (this.data.isRecovering || this._recoveryLock) return;
            this.rollingActive = true;
            this.rollingSessionId += 1;
            this.tryStartRollingWhenCameraReady();
          });
        });
        return;
      }
      if (this._insertConflictRecovering) return;
      this._insertConflictRecovering = true;
      const waitMs = 900 + Math.floor((this._cameraRebuildExtraDelayMs || 0) * 0.5);
      this._insertCameraRetryTimer = setTimeout(() => {
        this._insertCameraRetryTimer = null;
        this._insertConflictRecovering = false;
        if (this.data.isRecovering || this._recoveryLock) return;
        this.hardRecoverLivePipeline('auto:insert_camera_conflict');
      }, waitMs);
      return;
    }
    this.triggerCameraFaultRecovery(`error:${errMsg}`);
  },

  /**
   * 统一相机异常恢复触发器：带节流，避免短时连发导致反复黑屏。
   * @param {string} reason
   * @returns {void}
   */
  triggerCameraFaultRecovery: function (reason) {
    if (!this.data.liveStreamAllowed) return;
    if (!this._livePageVisible) {
      this.appendHealthLog('camera_fault_recovery_skip_page_hidden', {
        reason: reason || '',
        diag: this.getLiveRollingDiagSnapshot({})
      });
      return;
    }
    if (this.data.isRecovering || this._recoveryLock) return;
    if (this.pendingHighlight) return;
    /** 高光等待自然分段落盘期间避免硬恢复抢管线，降低 stop/start 风暴 */
    if (this.data.isSavingHighlight) return;
    if (Date.now() < (this._insertCameraRecoverCooldownUntil || 0)) return;
    const now = Date.now();
    const minAutoRecoverGapMs = 18000;
    this._cameraFaultStreak = (this._cameraFaultStreak || 0) + 1;
    const needRecover = this._cameraFaultStreak >= 2;
    if (!needRecover) {
      this.updatePipelineHealth();
      return;
    }
    if (now - (this._lastAutoRecoveryAt || 0) < minAutoRecoverGapMs) return;
    this.appendHealthLog('camera_auto_recover', {
      reason,
      faultStreak: this._cameraFaultStreak,
      pipelineHealth: this.data.pipelineHealth
    });
    this._lastAutoRecoveryAt = now;
    this.hardRecoverLivePipeline(`auto:${reason}`);
  },

  /**
   * 统一重新挂载 camera 组件，避免多个恢复/切模路径并发执行重复 mount。
   * @param {{
   *   generation?: number,
   *   extraData?: Record<string, any>,
   *   onMounted?: function(WechatMiniprogram.CameraContext): void
   * }} [opts]
   * @returns {boolean}
   */
  remountCameraComponent: function (opts, source) {
    if (this._recorderCore && !this._recorderCore.isOwnerActive()) {
      return this._recorderCore.withOwner(
        source || 'remountCameraComponent',
        'cameraRemount',
        () => this._remountCameraComponentImpl(opts)
      );
    }
    return this._remountCameraComponentImpl(opts);
  },

  _remountCameraComponentImpl: function (opts) {
    const options = opts || {};
    const generation =
      typeof options.generation === 'number'
        ? options.generation
        : (this._cameraRebuildGeneration || 0);
    if (generation !== (this._cameraRebuildGeneration || 0)) {
      this.appendHealthLog('camera_mount_skip_stale_generation', {
        requestGeneration: generation,
        activeGeneration: this._cameraRebuildGeneration || 0
      });
      return false;
    }
    if (this._cameraMountInFlight) {
      this.appendHealthLog('camera_mount_skip_inflight', {
        requestGeneration: generation,
        inflightGeneration: this._cameraMountInFlightGeneration || 0
      });
      return false;
    }
    this._cameraMountInFlight = true;
    this._cameraMountInFlightGeneration = generation;
    const finalize = () => {
      this._cameraMountInFlight = false;
      this._cameraMountInFlightGeneration = 0;
    };
    const nextPatch = Object.assign({}, options.extraData || {}, {
      cameraMounted: true
    });
    this.setData(nextPatch, () => {
      if (generation !== (this._cameraRebuildGeneration || 0)) {
        finalize();
        this.appendHealthLog('camera_mount_abandon_after_setdata', {
          requestGeneration: generation,
          activeGeneration: this._cameraRebuildGeneration || 0
        });
        return;
      }
      const bindCameraContext = () => {
        if (generation !== (this._cameraRebuildGeneration || 0)) {
          finalize();
          this.appendHealthLog('camera_mount_abandon_before_context', {
            requestGeneration: generation,
            activeGeneration: this._cameraRebuildGeneration || 0
          });
          return;
        }
        const nextCameraContext = wx.createCameraContext(this);
        this.setData({ cameraContext: nextCameraContext, isRecording: false }, () => {
          finalize();
          if (typeof options.onMounted === 'function') {
            try {
              options.onMounted(nextCameraContext);
            } catch (e) { }
          }
        });
      };
      if (wx.nextTick) wx.nextTick(bindCameraContext);
      else setTimeout(bindCameraContext, 0);
    });
    return true;
  },

  /**
   * 强制重建 camera 组件并释放旧上下文，避免会话切换后复用脏资源。
   * @param {function(): void} [onRebuilt]
   * @returns {void}
   */
  rebuildCameraComponent: function (onRebuilt, source) {
    if (this._recorderCore && !this._recorderCore.isOwnerActive()) {
      return this._recorderCore.withOwner(
        source || 'rebuildCameraComponent',
        'cameraRebuild',
        () => this._rebuildCameraComponentImpl(onRebuilt)
      );
    }
    return this._rebuildCameraComponentImpl(onRebuilt);
  },

  _rebuildCameraComponentImpl: function (onRebuilt) {
    if (this._cameraRebuildLock) {
      if (typeof onRebuilt === 'function') {
        this._cameraRebuildQueue.push(onRebuilt);
      }
      return;
    }
    this._cameraRebuildLock = true;
    const generation = (this._cameraRebuildGeneration || 0) + 1;
    this._cameraRebuildGeneration = generation;
    this._cameraMountInFlight = false;
    this._cameraMountInFlightGeneration = 0;
    this._cameraInitDone = false;
    // 重建 camera 必然产生新的 cameraContext；先销毁旧增强管线，避免 listener / GL 资源悬挂
    this._teardownEnhanceRender();
    this.setData({
      cameraMounted: false,
      cameraContext: null,
      isRecording: false,
      cameraRenderNonce: (this.data.cameraRenderNonce || 0) + 1
    }, () => {
      this._lastCameraUnmountAt = Date.now();
      const kick = () => {
        if (typeof onRebuilt === 'function') onRebuilt(generation);
        this._cameraRebuildLock = false;
        const queued = this._cameraRebuildQueue.splice(0, this._cameraRebuildQueue.length);
        if (queued.length > 0) {
          const next = queued.shift();
          if (typeof next === 'function') {
            this.rebuildCameraComponent(next);
          }
          queued.forEach((fn) => {
            if (typeof fn === 'function') this._cameraRebuildQueue.push(fn);
          });
        }
      };
      const baseMs =
        (this.recordCooldownAfterStopMs || 500) +
        this.getAdaptiveRecordCooldownExtraMs() +
        this.getIosParallelRollingStopExtraMs();
      const extraMs = this._cameraRebuildExtraDelayMs || 0;
      setTimeout(kick, baseMs + extraMs);
    });
  },

  /**
   * 长会话后附加 stop→start 冷却：Android 针对高压 I/O；iOS 略增句柄释放时间。
   * 非上述平台返回 0。
   * @returns {number}
   */
  getAdaptiveRecordCooldownExtraMs: function () {
    try {
      const si = wx.getSystemInfoSync();
      if (!si) return 0;
      const n = typeof this.segmentCounter === 'number' ? this.segmentCounter : 0;
      if (si.platform === 'android') {
        /** 长会话 + 频繁 user 目录落盘时略抬高上限，降低句柄竞态 */
        return Math.min(680, Math.floor(n / 12) * 38);
      }
      if (si.platform === 'ios') {
        /** 与 Android 同为并行落盘；具体加长见 {@link getIosParallelRollingStopExtraMs} */
        return Math.min(300, 72 + Math.floor(n / 10) * 22);
      }
    } catch (e) {
      return 0;
    }
    return 0;
  },

  /**
   * iOS 与 Android 均并行调度下一段时，额外拉长 stop→start，降低上一段 temp 被回收前未完成 save 的概率。
   * Android 返回 0。
   * @returns {number}
   */
  getIosParallelRollingStopExtraMs: function () {
    try {
      const si = wx.getSystemInfoSync();
      if (!si || si.platform !== 'ios') return 0;
    } catch (e) {
      return 0;
    }
    const n = typeof this.segmentCounter === 'number' ? this.segmentCounter : 0;
    return Math.min(920, 380 + Math.floor(n / 4) * 36);
  },

  /**
   * 连续收到 operateCamera is recording 时，在 scheduleAfterStopRecord 之后再追加的启动延迟。
   * 小米等 Android：第二次及以后若不再 stopRecord、仅靠短重试会永久与 Native 录制态脱节。
   * @returns {number}
   */
  getIsRecordingConflictExtraStartDelayMs: function () {
    const streak = typeof this.startRecordFailStreak === 'number' ? this.startRecordFailStreak : 0;
    if (streak < 2) return 0;
    try {
      const si = wx.getSystemInfoSync();
      if (si && si.platform === 'android') {
        /** 小米等机型在 Native 录制态回收偏慢，冲突时拉长退避避免“is recording”风暴。 */
        return Math.min(5200, 900 + streak * 240);
      }
      if (si && si.platform === 'ios') {
        return Math.min(1500, 70 + streak * 75);
      }
    } catch (e) {
      return Math.min(2200, 90 + streak * 100);
    }
    return Math.min(2200, 90 + streak * 100);
  },

  /**
   * stopRecord 完成后延迟再启动下一段录制，避免 Native 句柄未释放即 startRecord。
   * 时间驱动 rolling 不再做热层落盘；这里仍保留统一冷却入口。
   * iOS 另加 {@link getIosParallelRollingStopExtraMs}（与 Android 并行模型一致，仅时间不同）。
   * @param {function(): void} fn
   * @returns {void}
   */
  scheduleAfterStopRecord: function (fn) {
    const ms = this._recorderCore
      ? this._recorderCore.getSafeRestartDelayMs()
      : RECORDER_SAFE_RESTART_DELAY_MIN_MS;
    setTimeout(() => {
      const extra = typeof this._postUserLocalPersistCooldownMs === 'number'
        ? this._postUserLocalPersistCooldownMs
        : 0;
      const run = () => {
        if (typeof fn === 'function') {
          fn();
        }
      };
      if (extra > 0) {
        this._postUserLocalPersistCooldownMs = 0;
        setTimeout(run, extra);
        return;
      }
      run();
    }, ms);
  },

  /**
   * 强制 stop/re-align 路径也必须先回到 READY，再允许下一次 start。
   * @param {string} source
   * @param {function(): void} fn
   * @returns {void}
   */
  scheduleAfterForcedStopReady: function (source, fn) {
    if (this._recorderCore) {
      this._recorderCore.onSegmentStopSuccess(
        source || 'forced_stop_ready',
        Promise.resolve(),
        () => this.scheduleAfterStopRecord(fn)
      );
      return;
    }
    this.scheduleAfterStopRecord(fn);
  },

  /**
   * 清理 startOneSegment 延迟重试 timer，避免形成并发重试链。
   * @returns {void}
   */
  clearSegmentStartRetryTimer: function () {
    if (this._segmentStartRetryTimer) {
      clearTimeout(this._segmentStartRetryTimer);
      this._segmentStartRetryTimer = null;
    }
  },

  /**
   * 串行调度下一次 startOneSegment（会覆盖旧重试，确保只有一条链）。
   * @param {number} sessionId
   * @param {number} retryCount
   * @param {number} delayMs
   * @returns {void}
   */
  scheduleStartOneSegmentRetry: function (sessionId, retryCount, delayMs) {
    this.clearSegmentStartRetryTimer();
    this._segmentStartRetryTimer = setTimeout(() => {
      this._segmentStartRetryTimer = null;
      this.startOneSegment(sessionId, retryCount);
    }, Math.max(0, delayMs || 0));
  },

  /**
   * 在相机预览就绪后再启动滚动分段，避免首屏即 startRecord 导致预览黑屏。
   * 注意：不可因 isRecording 直接 return——会话切换后旧段 stopOneSegment 会早退且不置 false，
   * 会遗留「假 true」，此处若拦截则永远无法 startRollingRecording，高光永远无片段。
   * @returns {void}
   */
  tryStartRollingWhenCameraReady: function (source) {
    if (this._recorderCore) {
      return this._recorderCore.requestTryStartWhenReady(
        source || 'tryStartRollingWhenCameraReady'
      );
    }
    return this._tryStartRollingWhenCameraReadyImpl();
  },

  _tryStartRollingWhenCameraReadyImpl: function () {
    const now = Date.now();
    if (this._fileQuotaCircuitUntil && now < this._fileQuotaCircuitUntil) {
      this.appendHealthLog('rolling_start_blocked_by_file_quota_circuit', {
        remainMs: this._fileQuotaCircuitUntil - now
      });
      return;
    }
    if (!this.rollingActive || !this._cameraInitDone) return;
    if (!this.data.cameraContext) return;
    this._startRollingRecordingImpl();
  },

  updateZoom: function (zoomVal) {
    /** 超频（VK）模式使用渲染管线数字变焦；原生家族使用 camera.setZoom。 */
    var isVkMode = this.data.enhanceMode === 'vk';
    var minZ = 1;
    if (this._cameraCaps && typeof this._cameraCaps.minZoom === 'number' && this._cameraCaps.minZoom > 0) {
      minZ = this._cameraCaps.minZoom;
    } else if (this._cameraCaps && this._cameraCaps.hasUltraWide) {
      minZ = isLiveHostIos() ? 1 : 0.5;
    } else if (!isLiveHostIos() && (!this._cameraCaps || !this._cameraCaps.probed)) {
      /** Android 超广探测完成前勿将 minZ 锁为 1，否则 setZoom(0.6) 会被钳成 1×。 */
      minZ = 0.5;
    }
    if (isVkMode) minZ = 1;
    const actualZoom = Math.max(minZ, Math.min(this.data.maxZoom, zoomVal));

    // 只在数值发生实质变化时更新，减少 setData 频率
    if (Math.abs(this.data.zoom - actualZoom) < 0.01) return;

    var selfZ = this;
    /**
     * @returns {void}
     */
    var applyCtxZoomAndEnhance = function () {
      if (selfZ.data.cameraContext && selfZ.data.cameraContext.setZoom) {
        try {
          selfZ.data.cameraContext.setZoom({
            zoom: actualZoom
          });
        } catch (eCtx) { }
      }
      selfZ.syncNativeEnhanceZoomCompensation(actualZoom);
      selfZ.maybeSchedulePostZoomSilentFocus();
    };

    if (isVkMode) {
      this.setData({ zoom: actualZoom });
      if (this._renderPipeline && typeof this._renderPipeline.setVkZoom === 'function') {
        try {
          this._renderPipeline.setVkZoom(actualZoom);
        } catch (eZ) { }
      }
      return;
    }
    if (isLiveHostIos()) {
      this.setData({ zoom: actualZoom });
      applyCtxZoomAndEnhance();
    } else {
      this.setData({ zoom: actualZoom }, applyCtxZoomAndEnhance);
    }
  },

  /**
   * 将当前 zoom 同步为原生增强路径的补偿倍率（仅标准/高性能档生效）。
   * 根因：onCameraFrame 在部分设备/基础库上与 camera.setZoom 视角不同步，需在 WebGL 侧补偿。
   * @param {number} zoomVal
   * @returns {void}
   */
  syncNativeEnhanceZoomCompensation: function (zoomVal) {
    if (!this._renderPipeline || typeof this._renderPipeline.setNativeZoomCompensation !== 'function') return;
    var mode = this.data.enhanceMode;
    var caps = this._cameraCaps || {};
    if (mode !== 'standard' && mode !== 'strong') {
      try { this._renderPipeline.setNativeZoomCompensation(1); } catch (e0) { }
      return;
    }
    if (!caps.hasUltraWide) {
      try { this._renderPipeline.setNativeZoomCompensation(1); } catch (e1) { }
      return;
    }
    var base = 1;
    if (typeof caps.minZoom === 'number' && caps.minZoom > 0) {
      base = caps.minZoom;
    }
    var z = Number(zoomVal);
    if (!isFinite(z) || z <= 0) z = this.data.zoom || 1;
    var comp = z / Math.max(0.2, base);
    if (!isFinite(comp) || comp < 1) comp = 1;
    try { this._renderPipeline.setNativeZoomCompensation(comp); } catch (e2) { }
  },

  /**
   * 读取本机相机变焦能力并生成机位按钮。
   * - iOS：系统相机 0.5/1/2 与小程序 zoom 刻度常不一致；在 maxZoom≥2 时按 1（最广）/ 2（≈系统1×）/ 4（≈系统2×）对齐。
   * - Android：一律 setZoom 序列探测；init 的 minZoom 只作候选与全失败时的兜底（小米等常见 0.6）。
   * @param {{ minZoom?: number, maxZoom?: number }} [hint]
   * @returns {void}
   */
  detectCameraCapabilities: function (hint) {
    var maxZ = (hint && hint.maxZoom) || this.data.maxZoom || 10;
    var minRaw = hint && typeof hint.minZoom === 'number' && isFinite(hint.minZoom) ? hint.minZoom : null;
    if (minRaw === null && hint && hint.minZoom != null && hint.minZoom !== '') {
      var pr = parseFloat(String(hint.minZoom));
      if (isFinite(pr)) minRaw = pr;
    }
    var isIos = isLiveHostIos();

    if (!isIos) {
      this._probeAndroidUltraWideZoom(maxZ, minRaw);
      return;
    }
    if (minRaw !== null && minRaw < 0.999) {
      this._cameraCaps = {
        hasUltraWide: true,
        minZoom: minRaw,
        maxZoom: maxZ,
        probed: true
      };
      this.rebuildCameraViewModeStops();
      return;
    }
    if (isIos && maxZ >= 2) {
      this._cameraCaps = {
        hasUltraWide: true,
        minZoom: 1,
        maxZoom: maxZ,
        probed: true
      };
      this.rebuildCameraViewModeStops();
      return;
    }
    this._cameraCaps = {
      hasUltraWide: false,
      minZoom: 1,
      maxZoom: maxZ,
      probed: true
    };
    this.rebuildCameraViewModeStops();
  },

  /**
   * Android：用 setZoom 短序列探测真超广倍率（小米常见 0.6）；init 的 minZoom 仅作候选提示，不因「假 1」跳过探测。
   * 全部候选失败时，若 init 曾给出 0&lt;min&lt;1 则仍采信该值（部分机型回调不完整）。
   * 仅 Android 调用；iOS 不走此函数。
   * @param {number} maxZ
   * @param {number|null} [minRawHint] bindinitdone.minZoom，可能为 null
   * @returns {void}
   */
  _probeAndroidUltraWideZoom: function (maxZ, minRawHint) {
    var self = this;
    var ctx = this.data.cameraContext;
    if (!ctx || typeof ctx.setZoom !== 'function') {
      this._cameraCaps = { hasUltraWide: false, minZoom: 1, maxZoom: maxZ, probed: true };
      this.rebuildCameraViewModeStops();
      return;
    }
    var restoreZ = self.getDeviceDefaultPreviewZoom();
    /**
     * 探测结束后回到默认预览倍率（须先写 data.zoom，再 setZoom，与 &lt;camera zoom&gt; 绑定一致）。
     * @returns {void}
     */
    var restore = function () {
      if (!self.data.cameraContext || typeof self.data.cameraContext.setZoom !== 'function') return;
      self.setData({ zoom: restoreZ }, function () {
        try {
          self.data.cameraContext.setZoom({ zoom: restoreZ });
        } catch (er) { }
      });
    };
    var rawList = [0.6, 0.5, 0.55, 0.65, 2 / 3, 0.625];
    if (typeof minRawHint === 'number' && minRawHint > 0 && minRawHint < 1) {
      rawList.unshift(minRawHint);
    }
    var seen = {};
    var candidates = [];
    var ri;
    for (ri = 0; ri < rawList.length; ri++) {
      var rv = rawList[ri];
      if (!isFinite(rv) || rv <= 0 || rv >= 1) continue;
      var rk = String(Math.round(rv * 1000) / 1000);
      if (seen[rk]) continue;
      seen[rk] = true;
      candidates.push(rv);
    }
    if (candidates.length === 0) {
      candidates = [0.6, 0.5];
    }
    var ci = 0;
    /**
     * 当前候选失败则试下一档。
     * @returns {void}
     */
    var onCandidateFail = function () {
      ci++;
      if (ci >= candidates.length) {
        if (typeof minRawHint === 'number' && minRawHint > 0 && minRawHint < 0.999) {
          self._cameraCaps = {
            hasUltraWide: true,
            minZoom: minRawHint,
            maxZoom: maxZ,
            probed: true
          };
          self.rebuildCameraViewModeStops();
        } else {
          self._cameraCaps = { hasUltraWide: false, minZoom: 1, maxZoom: maxZ, probed: true };
          self.rebuildCameraViewModeStops();
        }
        restore();
        return;
      }
      tryCandidate(candidates[ci]);
    };
    /**
     * @param {number} z
     * @returns {void}
     */
    var tryCandidate = function (z) {
      var settled = false;
      try {
        self.setData({ zoom: z }, function () {
          try {
            ctx.setZoom({
              zoom: z,
              success: function () {
                if (settled) return;
                settled = true;
                self._cameraCaps = {
                  hasUltraWide: true,
                  minZoom: z,
                  maxZoom: maxZ,
                  probed: true
                };
                self.rebuildCameraViewModeStops();
                restore();
              },
              fail: function () {
                if (settled) return;
                settled = true;
                onCandidateFail();
              },
              complete: function () {
                setTimeout(function () {
                  if (settled) return;
                  settled = true;
                  onCandidateFail();
                }, ANDROID_ULTRAWIDE_PROBE_COMPLETE_MS);
              }
            });
          } catch (eInner) {
            if (!settled) {
              settled = true;
              onCandidateFail();
            }
          }
        });
      } catch (eTry) {
        onCandidateFail();
      }
    };
    tryCandidate(candidates[0]);
  },

  /**
   * 进入页面 / 复位机位时使用的默认预览 zoom（iOS max≥2 时为 2，接近系统「1×」主摄）。
   * @returns {number}
   */
  getDeviceDefaultPreviewZoom: function () {
    return getDefaultPreviewZoomForMax(this.data.maxZoom || 10);
  },

  /**
   * 根据当前能力生成机位按钮：支持超广则显示「广角」，其余使用数字倍数。
   * @returns {void}
   */
  rebuildCameraViewModeStops: function () {
    var caps = this._cameraCaps || {};
    var maxZ = this.data.maxZoom || caps.maxZoom || 10;
    var isIos = isLiveHostIos();
    var stops = [];
    if (caps.hasUltraWide) {
      var wideZ =
        typeof caps.minZoom === 'number' && caps.minZoom > 0 && caps.minZoom < 1 ? caps.minZoom : 1;
      stops.push({
        label: '广角',
        mode: CameraViewMode.WIDE,
        zoom: wideZ
      });
    }
    var normZ = isIos && maxZ >= 2 ? 2 : 1;
    stops.push({
      label: formatCameraZoomLabel(normZ),
      mode: CameraViewMode.NORMAL,
      zoom: normZ
    });
    if (maxZ > normZ + 0.05) {
      var closeZ = isIos && maxZ >= 4 ? 4 : Math.min(VIEW_MODE_CLOSE_ZOOM, maxZ);
      closeZ = Math.min(closeZ, maxZ);
      if (closeZ <= normZ) {
        closeZ = maxZ;
      }
      if (closeZ > normZ) {
        stops.push({
          label: formatCameraZoomLabel(closeZ),
          mode: CameraViewMode.CLOSE,
          zoom: closeZ
        });
      }
    }
    this.setData({ cameraViewModeStops: stops });
    this.syncNativeEnhanceZoomCompensation(this.data.zoom || 1);
  },

  /**
   * 将机位状态与预览恢复为「标准」1×；画质切换、相机重建、回前台时调用。
   * @param {{ skipCamera?: boolean }} [opts] skipCamera：仅更新 data，不调 setZoom（如相机即将卸载）。
   * @returns {void}
   */
  resetViewModeToNormal: function (opts) {
    var skip = opts && opts.skipCamera;
    var defZ = this.getDeviceDefaultPreviewZoom();
    var selfR = this;
    this.syncNativeEnhanceZoomCompensation(defZ);
    if (skip || this.data.enhanceMode === 'vk') {
      this.setData({
        cameraViewMode: CameraViewMode.NORMAL,
        zoom: defZ
      });
      return;
    }
    if (isLiveHostIos()) {
      this.setData({
        cameraViewMode: CameraViewMode.NORMAL,
        zoom: defZ
      });
      if (this.data.cameraContext && this.data.cameraContext.setZoom) {
        try {
          this.data.cameraContext.setZoom({ zoom: defZ });
        } catch (eZ) { }
      }
    } else {
      this.setData(
        {
          cameraViewMode: CameraViewMode.NORMAL,
          zoom: defZ
        },
        function () {
          if (selfR.data.cameraContext && selfR.data.cameraContext.setZoom) {
            try {
              selfR.data.cameraContext.setZoom({ zoom: defZ });
            } catch (eZ2) { }
          }
        }
      );
    }
  },

  /**
   * 按机位切换预览变焦：原生家族统一走 camera.setZoom（含标准/高性能 WebGL 覆盖层，禁止 shader 假广角）。
   * 超频（VK）模式不支持，入口应已隐藏 UI，本函数仍做守卫。
   * @param {'wide'|'normal'|'close'} mode
   * @returns {void}
   */
  applyViewMode: function (mode) {
    if (this.data.enhanceMode === 'vk') {
      try {
        wx.showToast({ title: '超频模式已隐藏机位按钮，可双指缩放', icon: 'none', duration: 2000 });
      } catch (eT) { }
      return;
    }
    if (this.data.drawerMode !== 0) return;
    if (!this.data.cameraMounted || !this.data.cameraContext || !this._cameraInitDone) return;
    var stop = null;
    var i;
    for (i = 0; i < this.data.cameraViewModeStops.length; i++) {
      if (this.data.cameraViewModeStops[i].mode === mode) {
        stop = this.data.cameraViewModeStops[i];
        break;
      }
    }
    if (!stop) {
      if (mode === CameraViewMode.WIDE) {
        try {
          wx.showToast({ title: '当前设备不支持广角', icon: 'none', duration: 2000 });
        } catch (eNoW) { }
      }
      return;
    }
    var caps = this._cameraCaps && this._cameraCaps.probed
      ? this._cameraCaps
      : { hasUltraWide: false, minZoom: 1, maxZoom: this.data.maxZoom || 10 };
    var maxZ = this.data.maxZoom || caps.maxZoom || 10;
    var target;
    if (mode === CameraViewMode.WIDE) {
      var stopWide = Number(stop.zoom);
      if (!isFinite(stopWide) || stopWide <= 0) stopWide = 0.6;
      var wideFloor = 0.01;
      if (caps.probed && caps.hasUltraWide && typeof caps.minZoom === 'number' && caps.minZoom > 0) {
        wideFloor = caps.minZoom;
      }
      target = Math.max(wideFloor, Math.min(maxZ, stopWide));
    } else {
      var minTarget = 1;
      target = Math.max(minTarget, Math.min(maxZ, Number(stop.zoom) || 1));
    }
    this.setData({ cameraViewMode: mode });
    this.updateZoom(target);
    if (this._renderPipeline && typeof this._renderPipeline.pauseAutoDegradeOnce === 'function') {
      try {
        this._renderPipeline.pauseAutoDegradeOnce();
      } catch (eP) { }
    }
  },

  /**
   * 首次进入超频（VK）成功后提示无机位切换（本地存储去重）。
   * @returns {void}
   */
  _maybeToastVkViewModeOnce: function () {
    try {
      if (wx.getStorageSync(STORAGE_VK_VIEW_MODE_HINT)) return;
      wx.setStorageSync(STORAGE_VK_VIEW_MODE_HINT, '1');
      wx.showToast({
        title: '超频模式已隐藏机位按钮，可双指缩放',
        icon: 'none',
        duration: 2800
      });
    } catch (e) { }
  },

  // 辅助变量
  lastZoomVal: 1.0,
  isPinching: false,
  /** 多指触控状态锁：双指缩放期间为 true，用于屏蔽空白区域长按事件，避免两者冲突 */
  isMultiTouch: false,
  touchPointsMap: {},
  pinchStartDistance: 0,
  pinchStartZoom: 1,

  // 双指缩放逻辑
  onTouchStart: function (e) {
    if (e.touches && e.touches.length >= 2) {
      this._everHadMultiTouch = true;
      this._aeTwoFinger = {
        startMidY: (e.touches[0].pageY + e.touches[1].pageY) / 2,
        startDist: this.getDistance(e.touches[0], e.touches[1]) || 1,
        maxDown: 0,
        zoomed: false
      };
      this.isPinching = true;
      this.isMultiTouch = true;
      this.pinchStartDistance = this.getDistance(e.touches[0], e.touches[1]);
      this.pinchStartZoom = this.data.zoom;
    } else if (e.touches && e.touches.length === 1) {
      this._everHadMultiTouch = false;
      this._preTapValid = true;
      this._tapStart = { x: e.touches[0].pageX, y: e.touches[0].pageY };
      /**
       * 旧逻辑：live 态下单指在画面任意处竖滑调 EV，但这会吃掉“点击画面移动对焦框”的 tap。
       * 现在 EV 仅由右侧小太阳滑条负责，画面 tap 始终用于移动对焦框，互不干扰。
       */
      this._aeLiveAdjustStartY = null;
      this._aeLiveAdjustStartNorm = 0.5;
    }
  },

  onTouchMove: function (e) {
    // EV 调节已收敛到右侧小太阳滑条，画面单指移动不再抢占 EV，避免与 tap 对焦冲突
    if (e.touches && e.touches.length === 1 && this._tapStart) {
      const t = e.touches[0];
      const dx = t.pageX - this._tapStart.x;
      const dy = t.pageY - this._tapStart.y;
      if (Math.abs(dx) > AE_PRE_TAP_SLOP_PX || Math.abs(dy) > AE_PRE_TAP_SLOP_PX) {
        this._preTapValid = false;
      }
    }
    if (e.touches && e.touches.length >= 2) {
      this.isMultiTouch = true;
      if (this._aeTwoFinger && e.touches.length >= 2) {
        const d0 = this.getDistance(e.touches[0], e.touches[1]);
        if (d0 > 0 && this._aeTwoFinger.startDist > 0) {
          if (
            Math.abs(d0 - this._aeTwoFinger.startDist) / this._aeTwoFinger.startDist
            > AE_PINCH_VS_SWIPE_DIST_RATIO
          ) {
            this._aeTwoFinger.zoomed = true;
          }
        }
        const midY = (e.touches[0].pageY + e.touches[1].pageY) / 2;
        const down = midY - this._aeTwoFinger.startMidY;
        if (down > this._aeTwoFinger.maxDown) {
          this._aeTwoFinger.maxDown = down;
        }
      }
    }
    if (!this.isPinching || !e.touches || e.touches.length < 2 || this.pinchStartDistance <= 0) {
      return;
    }
    const currentDistance = this.getDistance(e.touches[0], e.touches[1]);
    if (currentDistance <= 0) return;

    const ratio = currentDistance / this.pinchStartDistance;
    const newZoomVal = this.pinchStartZoom * ratio;
    this.updateZoom(newZoomVal);
  },

  onTouchEnd: function (e) {
    this.onScoreTouchEnd(); // 防止干扰记分长按
    if (e.touches && e.touches.length === 0) {
      if (this._aeTwoFinger) {
        this._aeTwoFinger = null;
      }
      if (
        !this._everHadMultiTouch
        && this._preTapValid
        && this._tapStart
        /** 仅当用户已主动呼出对焦/曝光（pre 或 live）时，单击预览区才移动对焦点，避免被动打扰。 */
        && this.data.aeControlsVisible
        && (this.data.aeContext === 'pre' || this.data.aeContext === 'live')
        && !this.data.aeFocusUserLocked
        && (e.changedTouches && e.changedTouches[0])
      ) {
        const t = e.changedTouches[0];
        const dx = t.pageX - this._tapStart.x;
        const dy = t.pageY - this._tapStart.y;
        if (Math.abs(dx) < AE_PRE_TAP_SLOP_PX && Math.abs(dy) < AE_PRE_TAP_SLOP_PX) {
          this.applyPreGameFocusAtPage(t.pageX, t.pageY);
        }
      }
      this._aeLiveAdjustStartY = null;
      this._aeLiveAdjustStartNorm = 0.5;
      this._tapStart = null;
      this._preTapValid = true;
    }
    if (!e.touches || e.touches.length === 0) {
      this.isPinching = false;
      this.pinchStartDistance = 0;
      // 延迟重置多指锁，避免 touchend 与 longpress 事件时序竞争
      setTimeout(() => {
        this.isMultiTouch = false;
      }, 200);
    } else if (!e.touches || e.touches.length < 2) {
      this.isPinching = false;
      this.pinchStartDistance = 0;
    } else if (this.isPinching) {
      // 仍然有两个或以上手指在屏幕上，重置缩放基准
      this.pinchStartDistance = this.getDistance(e.touches[0], e.touches[1]);
      this.pinchStartZoom = this.data.zoom;
    }
  },

  /**
   * 左下角与 REC 对称的「相机」快捷：展开/收拢变焦+对焦行。
   * @returns {void}
   */
  onCameraSettingsFabTap: function () {
    if (this.data.drawerMode !== 0) return;
    if (this.data.enhanceMode === 'vk') return;
    if (!this.data.cameraMounted || !this.data.liveStreamAllowed || this.data.isReplaying) return;
    try {
      this._updateLiveStageLayout();
    } catch (eU) { }
    this.setData({ cameraSettingsOpen: !this.data.cameraSettingsOpen });
  },

  /**
   * 机位药丸：广角 / 数字倍数；关闭侧栏以减轻挡视野。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onCameraViewModeTap: function (e) {
    if (this.data.drawerMode !== 0) return;
    var mode = e.currentTarget && e.currentTarget.dataset
      ? e.currentTarget.dataset.mode
      : '';
    if (!mode) return;
    this.applyViewMode(mode);
    this.setData({ cameraSettingsOpen: false });
  },

  /**
   * 「调焦/变焦」侧栏内「对焦」项：呼出对焦点与曝光条。
   * @returns {void}
   */
  onCameraFocusControlTap: function () {
    if (this.data.drawerMode !== 0) return;
    if (!this.data.cameraMounted || !this.data.cameraContext || !this._cameraInitDone) return;
    this.setData({ cameraSettingsOpen: false });
    this.wakeLiveAeControls();
  },

  getDistance: function (p1, p2) {
    const x = p2.pageX - p1.pageX;
    const y = p2.pageY - p1.pageY;
    return Math.sqrt(x * x + y * y);
  },

  /**
   * 将点击坐标归一化到 0–1，与 16:9 取景内接框（{@link computeLiveStage16x9RectPx}）对齐；
   * 全窗口映射会导致取景区外黑边上的点压在 0/1 边界，与 camera 全屏/裁切与 setTargetFocus 预期不一致。
   * @param {number} pageX
   * @param {number} pageY
   * @returns {{ nx: number, ny: number }}
   */
  pageXYToCameraNorm: function (pageX, pageY) {
    let w = 375;
    let h = 667;
    try {
      const si = wx.getSystemInfoSync();
      w = si.windowWidth || w;
      h = si.windowHeight || h;
    } catch (e) { }
    const r = computeLiveStage16x9RectPx(w, h);
    const nx0 = (pageX - r.left) / Math.max(1, r.w);
    const ny0 = (pageY - r.top) / Math.max(1, r.h);
    return {
      nx: Math.max(0, Math.min(1, nx0)),
      ny: Math.max(0, Math.min(1, ny0))
    };
  },

  /**
   * 在部分基础库/灰度中存在的对焦 API；官方文档常滞后。不存在时仅作 UI 提示，不抛错。
   * @param {number} nx 0–1
   * @param {number} ny 0–1
   * @returns {void}
   */
  invokeSetTargetFocus: function (nx, ny) {
    const ctx = this.data.cameraContext;
    if (!ctx) return;
    if (typeof ctx.setTargetFocus === 'function') {
      try {
        ctx.setTargetFocus({ x: nx, y: ny });
        return;
      } catch (e) { }
    }
  },

  /**
   * 探测当前相机上下文是否支持硬件 EV 调节。
   * 仅在 onCameraInit（或重建后）调用一次，探测结果写入 {@link data.aeExposureHardwareSupported}。
   * 判定口径：只要 cameraContext 暴露 setExposureCompensation / setEV / setExposureOffset 任一接口，即视为支持。
   * 注意：小程序内 <camera> 组件在部分机型（尤其低版本基础库的 Android）上不提供上述接口——
   * 此时完全不展示曝光滑条，避免“界面能动但实际不生效”的伪交互。
   * @returns {boolean}
   */
  detectExposureHardwareSupport: function () {
    const ctx = this.data.cameraContext;
    const supported = !!(
      ctx
      && (
        typeof ctx.setExposureCompensation === 'function'
        || typeof ctx.setEV === 'function'
        || typeof ctx.setExposureOffset === 'function'
      )
    );
    if (this.data.aeExposureHardwareSupported !== supported) {
      this.setData({ aeExposureHardwareSupported: supported });
    }
    return supported;
  },

  /**
   * 将「小太阳」归一化位映射为曝光补偿，仅走硬件 EV 接口。
   * 硬件不支持的机型不调用任何伪补偿逻辑——见 {@link detectExposureHardwareSupport} 设计说明。
   * 性能：录制中用 {@link _flushExposureNormToData} 节流，避免与编码同帧连打 setData。
   * @param {number} norm 0=偏暗, 0.5=中心, 1=偏亮
   * @returns {void}
   */
  applyExposureFromNorm: function (norm) {
    if (!this.data.aeExposureHardwareSupported) return;
    const n = Math.max(0, Math.min(1, norm));
    this._exposureNormPending = n;
    this._exposureValueEV = (n - 0.5) * 4;
    const ctx = this.data.cameraContext;
    if (!ctx) {
      this._flushExposureNormToData(true);
      return;
    }
    const ev = this._exposureValueEV;
    if (typeof ctx.setExposureCompensation === 'function') {
      try { ctx.setExposureCompensation({ value: ev }); } catch (e) { }
    } else if (typeof ctx.setEV === 'function') {
      try { ctx.setEV({ ev: ev }); } catch (e) { }
    } else if (typeof ctx.setExposureOffset === 'function') {
      try { ctx.setExposureOffset({ offset: ev }); } catch (e) { }
    }
    if (this.data.isRecording) {
      this._flushExposureNormToData(false);
    } else {
      this._flushExposureNormToData(true);
    }
  },

  /**
   * 将内部曝光 norm 写回小太阳位置；录制中可节流，交互结束可 force。
   * @param {boolean} force 是否跳过节流立即 setData
   * @returns {void}
   */
  _flushExposureNormToData: function (force) {
    const n = typeof this._exposureNormPending === 'number' ? this._exposureNormPending : 0.5;
    const now = Date.now();
    if (!force && this.data.isRecording) {
      if (now - (this._lastExposureSetDataAt || 0) < AE_EXPOSURE_SETDATA_THROTTLE_MS) {
        if (this._exposureSetDataTimer) clearTimeout(this._exposureSetDataTimer);
        this._exposureSetDataTimer = setTimeout(() => {
          this._exposureSetDataTimer = null;
          this._flushExposureNormToData(true);
        }, AE_EXPOSURE_SETDATA_THROTTLE_MS);
        return;
      }
    }
    this._lastExposureSetDataAt = now;
    this.setData({ aeSunTopPct: Math.round((1 - n) * 100) });
  },

  /**
   * 双指离开且变焦静止后，对几何中心执行一次不展示 UI 的对焦，缓解数码变焦后虚焦。
   * 通过 {@link updateZoom} 内防抖触发，避免捏合过程高频调用。
   * @returns {void}
   */
  silentRefocusGeometricCenter: function () {
    this.invokeSetTargetFocus(0.5, 0.5);
  },

  /**
   * 变焦量变化时重置静默对焦定时器；与缩放手势「争用」：仅响应 zoom 的实质变化，而非手指 xy。
   * @returns {void}
   */
  maybeSchedulePostZoomSilentFocus: function () {
    if (this._postZoomFocusTimer) {
      clearTimeout(this._postZoomFocusTimer);
      this._postZoomFocusTimer = null;
    }
    this._postZoomFocusTimer = setTimeout(() => {
      this._postZoomFocusTimer = null;
      // 捏合过程会导致短时帧时升高（UI setData 密集），统一先告知渲染管线暂停一次自动降级评估，
      // 再下发静默中心对焦；避免「变焦→误判掉帧→被拉到 lite」。
      if (this._renderPipeline && typeof this._renderPipeline.pauseAutoDegradeOnce === 'function') {
        this._renderPipeline.pauseAutoDegradeOnce();
      }
      this.silentRefocusGeometricCenter();
    }, AE_POST_ZOOM_SILENT_FOCUS_MS);
  },

  /**
   * 在预览区任意点击位置放置/移动对焦框：开赛前（pre）与直播态（含左下「相机 → 对焦」）共用。
   * live 态下每次点击都会续期 3s 自动隐藏计时器，且会把“中心模式簇”切换到“点击点模式簇”。
   * @param {number} pageX
   * @param {number} pageY
   * @returns {void}
   */
  applyPreGameFocusAtPage: function (pageX, pageY) {
    const { nx, ny } = this.pageXYToCameraNorm(pageX, pageY);
    this.invokeSetTargetFocus(nx, ny);
    let rpxFactor = 750 / 375;
    let rpxH = 1334;
    try {
      const si = wx.getSystemInfoSync();
      rpxFactor = 750 / (si.windowWidth || 375);
      rpxH = (si.windowHeight || 667) * rpxFactor;
    } catch (e) {
      rpxH = 1334;
    }
    const halfB = AE_BRACKET_RPX / 2;
    let rpxX = pageX * rpxFactor;
    let rpxY = pageY * rpxFactor;
    /** 方框中心与点击点一致；曝光条在屏幕右侧独立层，不占用本簇宽度。 */
    this._lastFocusNorm = { nx, ny };
    let clusterLeft = rpxX - halfB;
    let clusterTop = rpxY - halfB;
    const maxL = Math.max(0, 750 - AE_BRACKET_RPX);
    const maxT = Math.max(0, rpxH - AE_BRACKET_RPX - AE_CLUSTER_EXTRA_BELOW_RPX);
    clusterLeft = Math.max(0, Math.min(maxL, clusterLeft));
    clusterTop = Math.max(0, Math.min(maxT, clusterTop));
    if (this._aeFocusLockFlashTimer) {
      clearTimeout(this._aeFocusLockFlashTimer);
      this._aeFocusLockFlashTimer = null;
    }
    if (this._aeDoubleTapHintTimer) {
      clearTimeout(this._aeDoubleTapHintTimer);
      this._aeDoubleTapHintTimer = null;
    }
    try {
      wx.vibrateShort({ type: 'light' });
    } catch (eV) { }
    /** 直播长按呼出后继续保持 live 上下文，避免 3s 自动隐藏失效；开赛前首次 tap 切到 pre。 */
    const nextCtx = (this.data.aeContext === 'live') ? 'live' : 'pre';
    const patch = {
      aeControlsVisible: true,
      aeContext: nextCtx,
      aeFocusIsTapPosition: true,
      aeClusterLeftRpx: clusterLeft,
      aeClusterTopRpx: clusterTop,
      aeFocusLockFlash: true,
      aeFocusUserLocked: false,
      aeShowDoubleTapHint: true
    };
    /** 仅在支持硬件 EV 的机型上把滑块复位到 50%；不支持时该字段无视觉意义。 */
    if (this.data.aeExposureHardwareSupported) {
      patch.aeSunTopPct = 50;
    }
    this.setData(patch);
    if (this.data.aeExposureHardwareSupported) {
      this._exposureNormPending = 0.5;
      this.applyExposureFromNorm(0.5);
    }
    if (nextCtx === 'live') {
      this.scheduleAeLiveHide();
    }
    this._aeFocusLockFlashTimer = setTimeout(() => {
      this._aeFocusLockFlashTimer = null;
      this.setData({ aeFocusLockFlash: false });
    }, 520);
    this._aeDoubleTapHintTimer = setTimeout(() => {
      this._aeDoubleTapHintTimer = null;
      this.setData({ aeShowDoubleTapHint: false });
    }, 8000);
  },

  /**
   * 直播/录制中呼出对焦点+曝光条：对焦点先置于 16:9 取景区几何中心，曝光条（若支持）可拖调。
   * 可继续单指点击预览或拖动方框以移动对焦点，见 {@link applyPreGameFocusAtPage} 与方框 touch 系列。
   * 不强制复位既有 EV，避免打断用户之前的曝光选择。
   * @returns {void}
   */
  wakeLiveAeControls: function () {
    this.clearAeLiveHideTimer();
    this._lastFocusNorm = { nx: 0.5, ny: 0.5 };
    this.invokeSetTargetFocus(0.5, 0.5);
    if (this._aeDoubleTapHintTimer) {
      clearTimeout(this._aeDoubleTapHintTimer);
      this._aeDoubleTapHintTimer = null;
    }
    this.setData({
      aeControlsVisible: true,
      aeContext: 'live',
      aeFocusIsTapPosition: false,
      aeFocusLockFlash: true,
      aeFocusUserLocked: false,
      aeShowDoubleTapHint: true
    });
    this.scheduleAeLiveHide();
    if (this._aeFocusLockFlashTimer) {
      clearTimeout(this._aeFocusLockFlashTimer);
      this._aeFocusLockFlashTimer = null;
    }
    this._aeFocusLockFlashTimer = setTimeout(() => {
      this._aeFocusLockFlashTimer = null;
      this.setData({ aeFocusLockFlash: false });
    }, 420);
    this._aeDoubleTapHintTimer = setTimeout(() => {
      this._aeDoubleTapHintTimer = null;
      this.setData({ aeShowDoubleTapHint: false });
    }, 8000);
  },

  /**
   * 双击对焦框：在 {@link AE_BRACKET_DOUBLE_TAP_MS} 内连点两次方框则锁定；用 bindtap 且不使用 touchmove，避免与单击/连击判定冲突。
   * @returns {void}
   */
  onAeFocusBracketTap: function () {
    if (!this.data.aeControlsVisible) return;
    if (this.data.aeContext !== 'pre' && this.data.aeContext !== 'live') return;
    if (this.data.aeFocusUserLocked) {
      try {
        wx.showToast({ title: '对焦已锁定', icon: 'none', duration: 1000 });
      } catch (e) { }
      return;
    }
    const now = Date.now();
    if (now - (this._aeBracketLastTapAt || 0) < AE_BRACKET_DOUBLE_TAP_MS) {
      this._aeBracketLastTapAt = 0;
      const p = this._lastFocusNorm || { nx: 0.5, ny: 0.5 };
      this.invokeSetTargetFocus(p.nx, p.ny);
      if (this._aeDoubleTapHintTimer) {
        clearTimeout(this._aeDoubleTapHintTimer);
        this._aeDoubleTapHintTimer = null;
      }
      this.setData({ aeFocusUserLocked: true, aeShowDoubleTapHint: false });
      try {
        wx.vibrateShort({ type: 'medium' });
      } catch (e) { }
      try {
        wx.showToast({ title: '对焦已锁定', icon: 'success', duration: 1400 });
      } catch (eT) { }
    } else {
      this._aeBracketLastTapAt = now;
    }
  },

  /**
   * 无操作 3s 后隐藏 live 态控件（开赛前 pre 不自动关，由起录时收起）。
   * @returns {void}
   */
  scheduleAeLiveHide: function () {
    this.clearAeLiveHideTimer();
    this._aeLiveHideTimer = setTimeout(() => {
      this._aeLiveHideTimer = null;
      if (this.data.aeContext === 'live') {
        this.setData({ aeControlsVisible: false, aeContext: '' });
      }
    }, AE_LIVE_AUTO_HIDE_MS);
  },

  /**
   * @returns {void}
   */
  clearAeLiveHideTimer: function () {
    if (this._aeLiveHideTimer) {
      clearTimeout(this._aeLiveHideTimer);
      this._aeLiveHideTimer = null;
    }
  },

  /**
   * 开赛前/直播态在小太阳条上拖动调节曝光（catch 避免与底层缩放手势冲突）。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onAeSunTouchStart: function (e) {
    if (!this.data.aeExposureHardwareSupported) return;
    if (!this.data.aeControlsVisible) return;
    if (this.data.aeContext !== 'pre' && this.data.aeContext !== 'live') return;
    if (!e.touches || !e.touches[0]) return;
    this._aePreSunStartY = e.touches[0].pageY;
    this._aePreSunStartNorm = typeof this._exposureNormPending === 'number'
      ? this._exposureNormPending
      : 0.5;
  },

  /**
   * 滑条与全局手势层分离（catch），避免与缩放手势串扰；开赛前/直播态共用同一套数值。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onAeSunTouchMove: function (e) {
    if (!this.data.aeExposureHardwareSupported) return;
    if (!this.data.aeControlsVisible) return;
    if (this.data.aeContext !== 'pre' && this.data.aeContext !== 'live') return;
    if (!e.touches || !e.touches[0] || this._aePreSunStartY == null) return;
    let h = 667;
    try {
      h = wx.getSystemInfoSync().windowHeight || h;
    } catch (err) {
      h = 667;
    }
    const delta = (this._aePreSunStartY - e.touches[0].pageY) / h;
    let next = (this._aePreSunStartNorm || 0.5) + delta * 1.15;
    next = Math.max(0, Math.min(1, next));
    this.applyExposureFromNorm(next);
    if (this.data.aeContext === 'live') {
      this.clearAeLiveHideTimer();
      this.scheduleAeLiveHide();
    }
  },

  /**
   * @returns {void}
   */
  onAeSunTouchEnd: function () {
    this._aePreSunStartY = null;
    this._aePreSunStartNorm = 0.5;
    if (this.data.aeContext === 'live' && this.data.aeControlsVisible) {
      this.clearAeLiveHideTimer();
      this.scheduleAeLiveHide();
    }
  },

  hexToRgba: function (hex, opacity) {
    const color = (hex || '#000000').replace('#', '');
    const fullHex = color.length === 3
      ? color.split('').map((c) => c + c).join('')
      : color;
    const r = parseInt(fullHex.substr(0, 2), 16);
    const g = parseInt(fullHex.substr(2, 2), 16);
    const b = parseInt(fullHex.substr(4, 2), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  },

  getContrastColor: function (hexcolor) {
    if (!hexcolor) return '#000000';
    let color = hexcolor.replace('#', '');
    if (color.length === 3) {
      color = color.split('').map((c) => c + c).join('');
    }
    if (color.length !== 6) return '#000000';
    const r = parseInt(color.substr(0, 2), 16);
    const g = parseInt(color.substr(2, 2), 16);
    const b = parseInt(color.substr(4, 2), 16);
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return yiq >= 128 ? '#000000' : '#FFFFFF';
  },

  normalizeMatchConfig: function (config) {
    const base = config || this.data.matchConfig;
    const normalizedConfig = JSON.parse(JSON.stringify(base || {}));
    if (!normalizedConfig.matchNameColor) normalizedConfig.matchNameColor = '#E64340';

    ['teamA', 'teamB'].forEach((teamKey) => {
      const teamDefaults = teamKey === 'teamA'
        ? { name: '队 A', bgColor: '#E64340', textColor: '#FFFFFF', score: 0 }
        : { name: '队 B', bgColor: '#10AEFF', textColor: '#FFFFFF', score: 0 };
      const sourceTeam = normalizedConfig[teamKey] || {};
      const bgColor = sourceTeam.bgColor || sourceTeam.color || teamDefaults.bgColor;
      const textColor = this.getContrastColor(bgColor);
      normalizedConfig[teamKey] = {
        ...teamDefaults,
        ...sourceTeam,
        bgColor,
        rgbaBg: this.hexToRgba(bgColor, 0.8),
        textColor
      };
    });

    if (typeof normalizedConfig.period !== 'number') {
      normalizedConfig.period = 0;
    }
    return normalizedConfig;
  },

  onShow: function () {
    this._livePageVisible = true;
    this._bindVkDebugHotkey();
    try {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ['shareAppMessage']
      });
    } catch (e) {
      // 低版本基础库忽略
    }

    this.syncMatchConfigFromPageSources();
    try {
      const cid =
        wx.getStorageSync('currentMatchId') || (app.globalData && app.globalData.currentMatchId) || '';
      clipsStorage.mergeDefaultClipBucketIfTargetEmpty(String(cid || '').trim());
    } catch (eMerge) { }
    this.appendHealthLog('page_show', {});

    wx.setKeepScreenOn({
      keepScreenOn: true,
      fail: () => {
        setTimeout(() => wx.setKeepScreenOn({ keepScreenOn: true }), 1000);
      }
    });

    if (wx.setPageOrientation) {
      wx.setPageOrientation({ orientation: 'landscape' });
    }
    try {
      this._updateLiveStageLayout();
    } catch (eLs) { }
    try {
      const snap = storageEst.readFileStorageEstimateSnapshot();
      if (
        snap
        && typeof snap.clipBytes === 'number'
        && Number.isFinite(snap.clipBytes)
        && typeof snap.userDataBytes === 'number'
        && Number.isFinite(snap.userDataBytes)
      ) {
        this._syncCacheStorageLampData(
          storageEst.getClipStorageHealthHint(snap.clipBytes, snap.userDataBytes)
        );
      }
    } catch (eSnap) { }

    if (this._entitlementEverAllowedInSession) {
      this._liveCoreOnShowAfterEntitlement();
      return;
    }
    this.refreshLiveEntitlementAndResume(() => {
      this._liveCoreOnShowAfterEntitlement();
    });
  },

  /**
   * 权益通过后：若 globalData 中已有首页写入的 severe，则安排弹窗（与异步 kickoff 探测并行）。
   * 策略说明（历史踩坑）：
   * - 原 10 分钟过期 + 必须有 clipBytes，极易在用户稍晚进直播时整段跳过；
   * - 用字节再算一遍若已因删片段降到非 severe，会误拦截，与首页红色严重提示不一致；
   * - 故：以 `healthLevel === 'severe'` 为准，缺字节时用 clipMb/totalMb + 兜底文案；24h 内信任首页快照。
   *
   * @returns {void}
   */
  maybeToastFileStoragePressureFromGlobal: function () {
    try {
      if (this._liveStorageEntryModalShown) return;

      /**
       * @param {unknown} raw
       * @returns {Record<string, unknown>|null}
       */
      const asSevereEstimate = (raw) => {
        if (!raw || typeof raw !== 'object') return null;
        const hl = String(/** @type {{ healthLevel?: string }} */(raw).healthLevel || '')
          .trim()
          .toLowerCase();
        if (hl !== 'severe') return null;
        return /** @type {Record<string, unknown>} */ (raw);
      };

      let est = asSevereEstimate(app.globalData && app.globalData.fileStorageEstimate);
      if (!est) {
        const snap = storageEst.readFileStorageEstimateSnapshot();
        const cand = asSevereEstimate(snap);
        const sat = cand && typeof cand.at === 'number' ? cand.at : 0;
        if (cand && sat && Date.now() - sat <= 24 * 60 * 60 * 1000) {
          est = cand;
        }
      }
      if (!est) return;

      const at = typeof est.at === 'number' ? est.at : 0;
      if (at && Date.now() - at > 24 * 60 * 60 * 1000) return;

      const cm = typeof est.clipMb === 'number' && Number.isFinite(est.clipMb) ? est.clipMb : 0;
      const tm = typeof est.totalMb === 'number' && Number.isFinite(est.totalMb) ? est.totalMb : 0;
      let hintText = typeof est.hintText === 'string' ? est.hintText.trim() : '';

      const cb = /** @type {number|undefined} */ (est.clipBytes);
      const ub = /** @type {number|undefined} */ (est.userDataBytes);
      if (
        typeof cb === 'number'
        && typeof ub === 'number'
        && Number.isFinite(cb)
        && Number.isFinite(ub)
      ) {
        const recalc = storageEst.getClipStorageHealthHint(cb, ub);
        if (recalc.level === 'severe') {
          hintText = recalc.hintText;
        } else if (!hintText) {
          hintText =
            `高光片段约 ${recalc.clipMb} MB，本机小程序文件约 ${recalc.totalMb} MB（首页仍为严重水位）：` +
            '保存仍可能失败，请尽快「下载至相册并清空」或删除旧片段';
        }
      }
      if (!hintText) {
        hintText =
          `高光片段约 ${cm} MB，本机小程序文件约 ${tm} MB（空间严重紧张）：` +
          '保存极易失败，请尽快「下载至相册并清空」或删除旧片段';
      }

      this.maybeNotifyLiveStoragePressure(
        { clipMb: cm, totalMb: tm, level: 'severe', hintText },
        'kickoff'
      );
    } catch (eToast) { }
  },

  /**
   * 异步估算 USER_DATA_PATH 与高光片段体积，写入健康日志并可选提示用户。
   * @param {string} [trigger] kickoff | periodic 等
   * @param {boolean} [force] 为 true 时跳过短时间防抖（开播首次探测）
   * @returns {Promise<void>}
   */
  probeLiveSandboxStorage: function (trigger, force) {
    const t = typeof trigger === 'string' ? trigger : '';
    const now = Date.now();
    if (!force && this._lastLiveStorageProbeAt && now - this._lastLiveStorageProbeAt < 25000) {
      return Promise.resolve();
    }
    this._lastLiveStorageProbeAt = now;
    return Promise.all([
      storageEst.estimateClipSegmentsBytesFromStorage(),
      storageEst.estimateUserDataPathUsageBytes()
    ])
      .then(([clipBytes, userBytes]) => {
        const hint = storageEst.getClipStorageHealthHint(clipBytes, userBytes);
        this._syncCacheStorageLampData(hint);
        if (t === 'periodic' && !this.rollingActive) {
          return;
        }
        this.appendHealthLog('live_sandbox_storage_probe', {
          trigger: t,
          clipMb: hint.clipMb,
          totalMb: hint.totalMb,
          level: hint.level,
          rollingSessionId: this.rollingSessionId
        });
        try {
          if (app.globalData) {
            app.globalData.fileStorageEstimate = {
              clipBytes,
              userDataBytes: userBytes,
              clipMb: hint.clipMb,
              totalMb: hint.totalMb,
              healthLevel: hint.level,
              hintText: hint.hintText,
              at: Date.now()
            };
            storageEst.writeFileStorageEstimateSnapshot(app.globalData.fileStorageEstimate);
          }
        } catch (eG) { }
        this.maybeNotifyLiveStoragePressure(hint, t);
        this._lastLiveStorageProbeLevel = hint.level;
        if (hint.level === 'severe' && t === 'kickoff' && !this._liveSevereKickoffPruneDone) {
          this._liveSevereKickoffPruneDone = true;
          this.freeRollingFileStorageAggressive('live_storage_severe_kickoff');
        }
        if (hint.level === 'severe' && t === 'periodic' && this.rollingActive) {
          try {
            this.appendHealthLog('live_periodic_severe_lock_only', { noAutoClipPrune: true });
          } catch (eL) { }
        }
      })
      .catch((eProbe) => {
        try {
          this.appendHealthLog('live_sandbox_storage_probe_fail', {
            trigger: t,
            err: (eProbe && eProbe.message) || String(eProbe || '')
          });
        } catch (eLog) { }
      });
  },

  /**
   * 同步缓存角标灯与严重水位锁：severe 时 storageSevereLock，禁新分段/禁高光，仅此时下灯 EX 可点按批量导出。
   *
   * @param {{ level?: string, clipMb?: number, totalMb?: number, hintText?: string }} hint
   * @returns {void}
   */
  _syncCacheStorageLampData: function (hint) {
    if (!hint || typeof hint !== 'object') return;
    const raw = String(hint.level || 'ok')
      .trim()
      .toLowerCase();
    const lv = raw === 'warn' || raw === 'severe' || raw === 'ok' ? raw : 'ok';
    const wasSevere = !!this.data.storageSevereLock;
    const storageSevereLock = lv === 'severe';
    let txt = 'OK';
    if (lv === 'warn') txt = 'WT';
    if (lv === 'severe') txt = 'EX';
    if (
      lv === this.data.cacheStorageLampLevel
      && storageSevereLock === this.data.storageSevereLock
      && txt === this.data.cacheStorageLampText
    ) {
      return;
    }
    this.setData(
      {
        cacheStorageLampLevel: lv,
        storageSevereLock: storageSevereLock,
        cacheStorageLampActionable: storageSevereLock,
        cacheStorageLampText: txt
      },
      () => {
        if (wasSevere && !storageSevereLock) {
          this._onStorageSevereLockReleased();
        } else if (storageSevereLock) {
          this._storageSevereRecoveryUntil = 0;
        }
      }
    );
  },

  /**
   * severe 解除后：自动尝试恢复 rolling，并在短窗口内抑制 idle-ERR 误判。
   * @returns {void}
   */
  _onStorageSevereLockReleased: function () {
    const now = Date.now();
    const graceMs = Math.max(8000, Math.floor((this.segmentDurationMs || 16000) * 1.2));
    this._storageSevereRecoveryUntil = now + graceMs;
    this.lastSegmentAt = now;
    this.startRecordFailStreak = 0;
    this.segmentStartFailStormCycles = 0;
    if (this._needManualRelaunch && String(this._manualRelaunchReason || '').indexOf('file_quota') >= 0) {
      this._needManualRelaunch = false;
      this._manualRelaunchReason = '';
    }
    if (this._fileQuotaCircuitUntil && this._fileQuotaCircuitUntil > now) {
      this._fileQuotaCircuitUntil = 0;
    }
    try {
      this.appendHealthLog('storage_severe_released_resume_rolling', {
        graceMs,
        rollingActive: !!this.rollingActive,
        cameraReady: !!this._cameraInitDone
      });
    } catch (eLog) { }
    if (!this.rollingActive || !this._cameraInitDone || !this.data.cameraContext || this.data.isRecording) {
      this.updatePipelineHealth();
      return;
    }
    const sessionId = this.rollingSessionId;
    this.scheduleAfterStopRecord(() => {
      if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
      if (this.data.storageSevereLock) return;
      if (this.data.isRecording) return;
      this.startOneSegment(sessionId, 0);
    });
    this.updatePipelineHealth();
  },

  /**
   * 自绘轻提示：半透明、短时长、2 次 setData 以内，不调用 wx.showToast。
   * @param {string} message
   * @returns {void}
   */
  _showLightHint: function (message) {
    const t = String(message || '')
      .trim();
    if (!t) return;
    if (this._lightHintFadeTimer) {
      try {
        clearTimeout(this._lightHintFadeTimer);
      } catch (e) { }
      this._lightHintFadeTimer = null;
    }
    /** 与 wx.showToast 常见停留时长（约 2s）一致，避免旧版 260ms 一闪即消 */
    this.setData({ lightHintText: t, lightHintOpacity: 0.72 });
    const self = this;
    this._lightHintFadeTimer = setTimeout(function () {
      self.setData({ lightHintOpacity: 0 });
      self._lightHintFadeTimer = setTimeout(function () {
        self.setData({ lightHintText: '' });
        self._lightHintFadeTimer = null;
      }, 220);
    }, 2000);
  },

  /**
   * 选最旧 1 条、带本地路径且未标相册导出的片段。
   * 在 storageSevereLock 下 minKeep 按 0 计：否则会出现「条数=应急保留量 → 可删 0 条」却仍为 severe 的死锁。
   * @returns {{ matchId: string, item: Record<string, unknown> }|null}
   */
  _getOneOldestPrunableClipForCacheLamp: function () {
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) return null;
    const entries = [];
    Object.keys(clipsMap).forEach((matchId) => {
      const list = clipsMap[matchId];
      if (!Array.isArray(list)) return;
      list.forEach((it) => {
        if (!it || typeof it !== 'object') return;
        if (it.exportedToAlbum) return;
        const id = it.id != null ? String(it.id) : '';
        if (!id) return;
        const segs = Array.isArray(it.segments) ? it.segments.filter((p) => p && typeof p === 'string') : [];
        const ex = it.replaySegment && typeof it.replaySegment === 'string' ? [it.replaySegment] : [];
        const hasPaths = [...new Set([...segs, ...ex])].length > 0;
        if (!hasPaths) return;
        const createdAt = this.resolveHighlightCreatedAt(/** @type {Record<string, unknown>} */(it));
        entries.push({ matchId, id, createdAt });
      });
    });
    if (entries.length === 0) return null;
    const baseMin = Math.max(0, Number(this.highlightsEmergencyMinKeepCount || 0));
    const minKeep = this.data.storageSevereLock ? 0 : baseMin;
    const removableBudget = Math.max(0, entries.length - minKeep);
    if (removableBudget <= 0) return null;
    entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const first = entries[0];
    const list = clipsMap[first.matchId];
    if (!Array.isArray(list)) return null;
    const it = list.find((x) => x && String(x.id) === first.id);
    if (!it || typeof it !== 'object') return null;
    return { matchId: first.matchId, item: it };
  },

  /**
   * 将单条高光对应本地视频依次保存至相册、unlink，并同步删除索引行（EX 清理语义：从列表与统计中消失）。
   *
   * @param {string} matchId
   * @param {Record<string, unknown>} item
   * @param {(err: string|null) => void} onDone
   * @returns {void}
   */
  _exportOneClipToAlbumForCacheLamp: function (matchId, item, onDone) {
    const done = typeof onDone === 'function' ? onDone : function () { };
    const fs = wx.getFileSystemManager();
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) {
      done('map');
      return;
    }
    const segs = Array.isArray(item.segments) ? item.segments.filter((p) => p && typeof p === 'string') : [];
    const extra = item.replaySegment && typeof item.replaySegment === 'string' ? [item.replaySegment] : [];
    const paths = [...new Set([...segs, ...extra])];
    if (paths.length === 0) {
      done('paths');
      return;
    }
    const runPaths = (pi, failStreak) => {
      if (pi >= paths.length) {
        const list = clipsMap[matchId];
        if (Array.isArray(list)) {
          const id = item.id != null ? String(item.id) : '';
          const idx = list.findIndex((x) => x && String(x.id) === id);
          if (idx >= 0) {
            list.splice(idx, 1);
          }
          if (list.length <= 0) {
            delete clipsMap[matchId];
          }
        }
        if (clipsStorage.writeClipsMapSafe(clipsMap)) {
          try {
            if (typeof this.refreshDrawerHighlights === 'function') this.refreshDrawerHighlights();
          } catch (eR) { }
          try {
            if (typeof this.loadMatchList === 'function') this.loadMatchList();
          } catch (eM) { }
          try {
            this.appendHealthLog('cache_lamp_export_one', {
              matchId: String(matchId),
              id: String(item.id),
              saveFailCount: failStreak
            });
          } catch (eL) { }
          done(failStreak > 0 ? 'partial' : null);
        } else {
          done('write');
        }
        return;
      }
      const p = paths[pi];
      const nextPi = pi + 1;
      let failCount = failStreak;
      wx.saveVideoToPhotosAlbum({
        filePath: p,
        success: () => {
          try {
            fs.unlinkSync(p);
          } catch (eUn) { }
          runPaths(nextPi, failCount);
        },
        fail: () => {
          failCount += 1;
          runPaths(nextPi, failCount);
        }
      });
    };
    const start = () => runPaths(0, 0);
    wx.getSetting({
      success: (res) => {
        if (res.authSetting && res.authSetting['scope.writePhotosAlbum']) {
          start();
        } else {
          wx.authorize({
            scope: 'scope.writePhotosAlbum',
            success: start,
            fail: () => {
              try {
                wx.showModal({
                  title: '需要相册权限',
                  content: '导出后可释放本机空间',
                  showCancel: false
                });
              } catch (e) { }
              done('auth');
            }
          });
        }
      },
      fail: () => done('set')
    });
  },

  /**
   * 严重水位下点按：立即按序导出最旧可删的若干条到相册并 unlink 本地（不排队）；单次最多 3 条，降低与相机 I/O 冲突。
   * @returns {void}
   */
  onCacheStorageLampTap: function () {
    if (!this.data.storageSevereLock) return;
    if (this._cacheLampBatchRunning) {
      this._showLightHint('处理中');
      return;
    }
    if (this.data.isRecording || this.data.isSavingHighlight) {
      this._showLightHint('请稍候');
      return;
    }
    const batchMax = 3;
    this._cacheLampBatchRunning = true;
    const self = this;
    let doneCount = 0;
    try {
      this.appendHealthLog('cache_lamp_tap_batch', { max: batchMax });
    } catch (eL) { }
    const finishBatch = (hintKey) => {
      self._cacheLampBatchRunning = false;
      if (doneCount === 0) {
        self._showLightHint('无未导出的本地文件');
      } else {
        self._showLightHint('已导' + String(doneCount) + '条');
      }
      try {
        self.probeLiveSandboxStorage(hintKey || 'after_cache_lamp_batch', true);
      } catch (e) { }
    };
    const runNext = (left) => {
      if (left <= 0) {
        finishBatch('after_cache_lamp_batch');
        return;
      }
      const t = self._getOneOldestPrunableClipForCacheLamp();
      if (!t) {
        finishBatch('after_cache_lamp_batch');
        return;
      }
      self._exportOneClipToAlbumForCacheLamp(t.matchId, t.item, function (err) {
        if (err === 'auth') {
          self._cacheLampBatchRunning = false;
          self._showLightHint('需相册权限');
          if (doneCount > 0) {
            self.probeLiveSandboxStorage('after_cache_lamp_batch_partial', true);
          }
          return;
        }
        if (!err || err === 'partial') {
          doneCount += 1;
          runNext(left - 1);
          return;
        }
        self._cacheLampBatchRunning = false;
        if (doneCount > 0) {
          self._showLightHint('已导' + String(doneCount) + '条');
          self.probeLiveSandboxStorage('after_cache_lamp_batch_err', true);
        } else {
          self._showLightHint('未完成');
        }
      });
    };
    runNext(batchMax);
  },

  /**
   * 按档位提示存储压力。
   * - severe：kickoff 时用页面级自定义浮层（避免 `wx.showModal` 与 camera 内 cover-view 布局缺陷）；
   *   门闩 {@link _liveStorageEntryModalShown} 仅在 {@link onLoad} 置 false；periodic 不弹。
   * - warn：静默记录日志，不弹任何 Toast，避免打断直播。
   * @param {{ clipMb: number, totalMb: number, level: string, hintText: string }} hint
   * @param {string} [trigger] kickoff | periodic 等，由 probeLiveSandboxStorage 传入
   * @returns {void}
   */
  maybeNotifyLiveStoragePressure: function (hint, trigger) {
    if (!hint || hint.level === 'ok') {
      return;
    }
    if (hint.level === 'severe') {
      if (trigger !== 'kickoff') return;
      if (this._liveStorageEntryModalShown) return;
      this._liveStorageEntryModalShown = true;
      const self = this;
      let text = typeof hint.hintText === 'string' ? hint.hintText.trim() : '';
      if (!text) {
        text =
          '本机小程序存储占用过高，保存极易失败，请尽快「下载至相册并清空」或删除旧片段';
      }
      if (this._liveStorageSevereModalTimer) {
        clearTimeout(this._liveStorageSevereModalTimer);
        this._liveStorageSevereModalTimer = null;
      }
      const openStorageModal = () => {
        self._liveStorageSevereModalTimer = null;
        if (!self._livePageVisible) {
          self._liveStorageEntryModalShown = false;
          return;
        }
        try {
          self.appendHealthLog('live_storage_severe_modal_show', {
            trigger: trigger || ''
          });
        } catch (eLog) { }
        self.setData({
          showStoragePressureModal: true,
          storagePressureModalText: text
        });
      };
      this._liveStorageSevereModalTimer = setTimeout(openStorageModal, LIVE_STORAGE_SEVERE_MODAL_DELAY_MS);
    }
  },

  /**
   * 长直播期间周期性探测（全量 walk 较重，默认 8 分钟）。
   * @returns {void}
   */
  startLiveSandboxStorageWatch: function () {
    this.stopLiveSandboxStorageWatch();
    this._liveFileStorageTimer = setInterval(() => {
      if (!this.rollingActive) {
        return;
      }
      this.probeLiveSandboxStorage('periodic', false);
    }, 8 * 60 * 1000);
  },

  /**
   * @returns {void}
   */
  stopLiveSandboxStorageWatch: function () {
    if (this._liveFileStorageTimer) {
      clearInterval(this._liveFileStorageTimer);
      this._liveFileStorageTimer = null;
    }
  },

  /**
   * 分享给好友：路径携带当前用户 openid，供新用户登录时上报邀请关系。
   * @returns {WechatMiniprogram.Page.ICustomShareContent}
   */
  onShareAppMessage: function () {
    let raw = app.globalData.userInfo;
    if (!raw || typeof raw !== 'object') {
      try {
        const cached = wx.getStorageSync(STORAGE_USER_INFO_KEY);
        if (cached && typeof cached === 'object') {
          raw = cached;
        }
      } catch (e) {
        raw = null;
      }
    }
    let openid = '';
    if (raw && typeof raw === 'object') {
      const o = /** @type {Record<string, unknown>} */ (raw);
      const v = o.openid;
      openid = typeof v === 'string' ? v.trim() : '';
    }
    const path =
      openid.length > 0
        ? `/pages/index/index?referrerId=${encodeURIComponent(openid)}`
        : '/pages/index/index';
    return {
      title: '高光记分 — 邀你免费试用直播记分',
      path,
      imageUrl: SHARE_IMAGE_URL
    };
  },

  onReady: function () {
    try {
      this._updateLiveStageLayout();
    } catch (eL1) { }
    if (wx.nextTick) {
      wx.nextTick(() => this.updateTeamGroupWidth(true));
    } else {
      setTimeout(() => this.updateTeamGroupWidth(true), 0);
    }
  },

  /**
   * 与 WXS `limitTeamName`（最多 12 字）一致，用于非宽度逻辑时可读展示长度。
   *
   * @param {string} name 原始队名
   * @returns {number}
   */
  getDisplayTeamNameCharCount: function (name) {
    const s = String(name || '');
    return Math.min(Array.from(s).length, 12);
  },

  /**
   * 单侧球队区（队名+比分）固定宽度：按 12 个中文字符占位 + 左右边距估算，与队名实际长短无关。
   *
   * @returns {number} 宽度（px）
   */
  computeTeamGroupWidthPx: function () {
    const DISPLAY_CHAR_SLOTS = 12;
    const getShortEdge = () => {
      try {
        if (wx.getWindowInfo) {
          const w = wx.getWindowInfo();
          const ww = w.windowWidth || 375;
          const wh = w.windowHeight || ww;
          return Math.min(ww, wh);
        }
      } catch (e) { }
      const sys = wx.getSystemInfoSync();
      const ww = sys.windowWidth || 375;
      const wh = sys.windowHeight || ww;
      return Math.min(ww, wh);
    };
    /** 使用短边做基准，避免横竖屏时机差异导致记分条忽长忽短。 */
    const shortEdge = getShortEdge();
    const rpxToPx = shortEdge / 750;
    /** 队名区宽度 = 12 字槽位 + 分数固定槽位 + 二者间距 + 左右内边距。 */
    const NAME_CHAR_RPX = 20;
    const SCORE_SLOT_RPX = 40;
    const CONTENT_GAP_RPX = 8;
    const ROW_PADDING_RPX = 20;
    const MIN_RPX = 108;
    let needRpx =
      DISPLAY_CHAR_SLOTS * NAME_CHAR_RPX
      + SCORE_SLOT_RPX
      + CONTENT_GAP_RPX
      + ROW_PADDING_RPX;
    needRpx = Math.max(needRpx, MIN_RPX);
    let widthPx = needRpx * rpxToPx;
    const boardPx = shortEdge * 0.98;
    /** 需与 `.period-center-outer` 的最小宽度 + padding 保持一致。 */
    const centerRpx = this.data.isAutoMode ? 106 : 80;
    const maxSidePx = Math.max(72, (boardPx - centerRpx * rpxToPx) / 2 - 4);
    widthPx = Math.min(widthPx, maxSidePx);
    return Math.round(widthPx);
  },

  /**
   * 根据当前 `matchConfig` 刷新左右色块宽度（横竖屏切换时也会重算）。
   *
   * @param {boolean} [force] 为 true 时跳过「数值接近则跳过」优化，避免 onShow 只改 matchConfig 时宽度未刷新
   * @returns {void}
   */
  updateTeamGroupWidth: function (force) {
    const wSide = this.computeTeamGroupWidthPx();
    if (
      !force &&
      Math.abs(wSide - (this.data.teamGroupWidthPxA || 0)) < 0.5 &&
      Math.abs(wSide - (this.data.teamGroupWidthPxB || 0)) < 0.5
    ) {
      return;
    }
    this.setData({ teamGroupWidthPxA: wSide, teamGroupWidthPxB: wSide });
  },

  onUnload: function () {
    this._unbindVkDebugHotkey();
    if (this._windowResizeListener && wx.offWindowResize) {
      try {
        wx.offWindowResize(this._windowResizeListener);
      } catch (eRz) { }
      this._windowResizeListener = null;
    }
    this._replayDeferredItem = null;
    if (this._replayPauseWaitTimer) {
      clearTimeout(this._replayPauseWaitTimer);
      this._replayPauseWaitTimer = null;
    }
    this.stopHighlightSaveProgressAnim();
    this.rollingActive = false;
    this._rollingPausedForReplay = false;
    this.stopHealthMonitor();
    this.clearRecoveryFabAck();
    this.stopRecoveryProgressAnim(false);
    if (this._recoveryGuardTimer) {
      clearTimeout(this._recoveryGuardTimer);
      this._recoveryGuardTimer = null;
    }
    if (this._recoveryFailSafeTimer) {
      clearTimeout(this._recoveryFailSafeTimer);
      this._recoveryFailSafeTimer = null;
    }
    if (this._recoverUiFailsafeTimer) {
      clearTimeout(this._recoverUiFailsafeTimer);
      this._recoverUiFailsafeTimer = null;
    }
    if (this._insertCameraRetryTimer) {
      clearTimeout(this._insertCameraRetryTimer);
      this._insertCameraRetryTimer = null;
    }
    if (this._cameraShowInitWatchTimer) {
      clearTimeout(this._cameraShowInitWatchTimer);
      this._cameraShowInitWatchTimer = null;
    }
    if (this._relaunchPressTimer) {
      clearTimeout(this._relaunchPressTimer);
      this._relaunchPressTimer = null;
    }
    if (this._remoteHealthLogTimer) {
      clearTimeout(this._remoteHealthLogTimer);
      this._remoteHealthLogTimer = null;
    }
    this._insertConflictRecovering = false;
    this._needManualRelaunch = false;
    this._hardRecoverAwaitingCamera = false;
    this._cameraInitDone = false;
    if (this._rollingKickoffTimer) {
      clearTimeout(this._rollingKickoffTimer);
      this._rollingKickoffTimer = null;
    }
    if (this.pendingHighlight && this.pendingHighlight.timeout) {
      clearTimeout(this.pendingHighlight.timeout);
    }
    if (this._recorderCore) {
      this._recorderCore.clearPendingHighlight();
    } else {
      this.pendingHighlight = null;
    }
    this.clearHighlightSavePipelineState();
    this.rollingSegments = [];
    this.segmentBuffer = [];
    this.highlightMaterializeQueue = [];
    this.highlightMaterializeRunning = false;
    this.highlightMissStreak = 0;
    this.rollingFsBusy = false;
    this._rollingPersistInFlight = 0;
    this._postUserLocalPersistCooldownMs = 0;
    if (this.rollingWatchdogTimer) {
      clearInterval(this.rollingWatchdogTimer);
      this.rollingWatchdogTimer = null;
    }
    this.appendHealthLog('page_unload', {});
    if (this._postZoomFocusTimer) {
      clearTimeout(this._postZoomFocusTimer);
      this._postZoomFocusTimer = null;
    }
    if (this._exposureSetDataTimer) {
      clearTimeout(this._exposureSetDataTimer);
      this._exposureSetDataTimer = null;
    }
    this.clearAeLiveHideTimer();
    if (this._aeDoubleTapHintTimer) {
      clearTimeout(this._aeDoubleTapHintTimer);
      this._aeDoubleTapHintTimer = null;
    }
    if (this._aeFocusLockFlashTimer) {
      clearTimeout(this._aeFocusLockFlashTimer);
      this._aeFocusLockFlashTimer = null;
    }
    if (this._enhanceZeroFrameRecoverTimer) {
      clearTimeout(this._enhanceZeroFrameRecoverTimer);
      this._enhanceZeroFrameRecoverTimer = null;
    }
    if (this._liveStorageSevereModalTimer) {
      clearTimeout(this._liveStorageSevereModalTimer);
      this._liveStorageSevereModalTimer = null;
    }
    this._pendingEnhanceModeAfterRecover = null;
    this._pendingEnhanceModeAfterCameraRebuild = null;
    this._lastSegmentOperateFailAt = 0;
    this._teardownEnhanceRender();
    this.stopEnhanceFpsPolling();
    this.setData({
      cameraMounted: false,
      cameraContext: null,
      isRecording: false,
      showRecoveryVeil: false,
      showStoragePressureModal: false
    });
    this.stopRollingRecording(undefined, 'page_unload');
  },

  onHide: function () {
    this._unbindVkDebugHotkey();
    if (this._cameraShowInitWatchTimer) {
      clearTimeout(this._cameraShowInitWatchTimer);
      this._cameraShowInitWatchTimer = null;
    }
    if (this._liveStorageSevereModalTimer) {
      clearTimeout(this._liveStorageSevereModalTimer);
      this._liveStorageSevereModalTimer = null;
      /** 未真正弹出前离开页面，解锁以便下次 onShow 再排期 */
      this._liveStorageEntryModalShown = false;
    }
    if (this.data.showStoragePressureModal) {
      this.setData({ showStoragePressureModal: false });
    }
    this._livePageVisible = false;
    this._cacheLampBatchRunning = false;
    if (this._lightHintFadeTimer) {
      try {
        clearTimeout(this._lightHintFadeTimer);
      } catch (e) { }
      this._lightHintFadeTimer = null;
    }
    this.setData({ lightHintText: '', lightHintOpacity: 0 });
    /** 切后台不打断保存，但取消「保存完成后自动回放」，避免隐藏态误开全屏回放 */
    this._replayDeferredItem = null;
    if (this._highlightResumeUnlockFallbackTimer) {
      clearTimeout(this._highlightResumeUnlockFallbackTimer);
      this._highlightResumeUnlockFallbackTimer = null;
    }
    if (this._replayPauseWaitTimer) {
      clearTimeout(this._replayPauseWaitTimer);
      this._replayPauseWaitTimer = null;
    }
    this._rollingPausedForReplay = false;
    this.clearHighlightSavePipelineState();
    this.endHighlightSaving();
    this.stopHealthMonitor();
    this.clearRecoveryFabAck();
    this.stopRecoveryProgressAnim(false);
    if (this._recoveryGuardTimer) {
      clearTimeout(this._recoveryGuardTimer);
      this._recoveryGuardTimer = null;
    }
    if (this._recoveryFailSafeTimer) {
      clearTimeout(this._recoveryFailSafeTimer);
      this._recoveryFailSafeTimer = null;
    }
    if (this._recoverUiFailsafeTimer) {
      clearTimeout(this._recoverUiFailsafeTimer);
      this._recoverUiFailsafeTimer = null;
    }
    if (this._insertCameraRetryTimer) {
      clearTimeout(this._insertCameraRetryTimer);
      this._insertCameraRetryTimer = null;
    }
    if (this._relaunchPressTimer) {
      clearTimeout(this._relaunchPressTimer);
      this._relaunchPressTimer = null;
    }
    this._insertConflictRecovering = false;
    this.appendHealthLog('page_hide', {});
    if (this._enhanceZeroFrameRecoverTimer) {
      clearTimeout(this._enhanceZeroFrameRecoverTimer);
      this._enhanceZeroFrameRecoverTimer = null;
    }
    this._pendingEnhanceModeAfterRecover = null;
    this._pendingEnhanceModeAfterCameraRebuild = null;
    this._lastSegmentOperateFailAt = 0;
    this.stopEnhanceFpsPolling();
  },

  /**
   * 清除恢复按钮成功闪烁状态（页面隐藏/卸载时调用）。
   * @returns {void}
   */
  clearRecoveryFabAck: function () {
    if (this._opsAckTimer) {
      clearTimeout(this._opsAckTimer);
      this._opsAckTimer = null;
    }
    if (this.data.opsControlAck) {
      this.setData({ opsControlAck: false });
    }
  },

  /**
   * 触发恢复成功的隐式反馈：一次短震 + 恢复按钮外环轻微闪烁，不显示文字提示。
   * @returns {void}
   */
  emitRecoverySuccessFeedback: function () {
    this.vibrate('light');
    if (this._opsAckTimer) {
      clearTimeout(this._opsAckTimer);
      this._opsAckTimer = null;
    }
    this.setData({ opsControlAck: true });
    this._opsAckTimer = setTimeout(() => {
      this._opsAckTimer = null;
      this.setData({ opsControlAck: false });
    }, 820);
  },

  /**
   * 刷新管线健康状态（低干扰状态灯）。
   * 分段之间 stop→冷却→start 的短瞬间 isRecording 为 false，文案会呈 PAUSE，与墙钟「接缝」基本同量级。
   * @returns {void}
   */
  updatePipelineHealth: function () {
    let health = 'ok';
    let text = 'PAUSE';
    let actionable = false;
    /** VK 模式故意停 rolling / 无分段，不得判为采集中断 ERR。 */
    const vkOrVkTransition =
      this.data.enhanceMode === 'vk' || !!this.data.enhanceVkTransitioning;
    if (this._needManualRelaunch) {
      if (
        this.data.pipelineHealth !== 'warn'
        || this.data.opsControlText !== 'ERR'
        || this.data.opsControlActionable !== true
      ) {
        this.setData({
          pipelineHealth: 'warn',
          opsControlText: 'ERR',
          opsControlActionable: true
        });
      }
      return;
    }
    const now = Date.now();
    const pendingAgeMs = this.pendingHighlight
      ? (now - (this.pendingHighlight.clickTime || this.pendingHighlight.createdAt || now))
      : 0;
    const inStorageRecoveryWindow =
      !!(this._storageSevereRecoveryUntil && now < this._storageSevereRecoveryUntil);
    const idleTooLong =
      this.rollingActive
      && this._cameraInitDone
      && (now - (this.lastSegmentAt || 0) > this.segmentDurationMs * 3.5)
      && !this.data.isRecording
      && !this.rollingFsBusy
      && !inStorageRecoveryWindow
      && !this.data.storageSevereLock;
    const captureLikelyBlocked =
      this.highlightMissStreak > 0
      || this.startRecordFailStreak >= 3
      || (this.pendingHighlight && pendingAgeMs > this.segmentDurationMs * 2.2)
      || idleTooLong;
    if (this.data.isRecovering) {
      health = 'recovering';
      text = '...';
    } else if (vkOrVkTransition) {
      health = 'ok';
      text = '超频';
    } else if (captureLikelyBlocked) {
      health = 'warn';
      text = 'ERR';
      actionable = true;
    } else if (this.data.isRecording) {
      health = 'recording';
      text = 'REC';
    } else if (this.data.storageSevereLock) {
      /** 严重水位停分段：非 ERR，避免与采集中断混淆 */
      health = 'ok';
      text = 'STO';
    }
    if (
      health !== this.data.pipelineHealth
      || text !== this.data.opsControlText
      || actionable !== this.data.opsControlActionable
    ) {
      this.setData({
        pipelineHealth: health,
        opsControlText: text,
        opsControlActionable: actionable
      });
    }
  },

  /**
   * 启动健康状态监控定时器。
   * @returns {void}
   */
  startHealthMonitor: function () {
    this.stopHealthMonitor();
    this.updatePipelineHealth();
    this._healthTimer = setInterval(() => this.updatePipelineHealth(), 1200);
    this.startLiveSandboxStorageWatch();
  },

  /**
   * 停止健康状态监控定时器。
   * @returns {void}
   */
  stopHealthMonitor: function () {
    if (!this._healthTimer) return;
    clearInterval(this._healthTimer);
    this._healthTimer = null;
    this.stopLiveSandboxStorageWatch();
  },

  /**
   * 启动恢复进度圆环动画（在 isRecovering 期间爬升至约 88%，就绪后由 stopRecoveryProgressAnim(true) 拉满）。
   * @returns {void}
   */
  startRecoveryProgressAnim: function () {
    if (this._recoverProgTimer) {
      clearInterval(this._recoverProgTimer);
      this._recoverProgTimer = null;
    }
    if (this._recoverProgressResetTimer) {
      clearTimeout(this._recoverProgressResetTimer);
      this._recoverProgressResetTimer = null;
    }
    this.setData({ recoveryProgress: 0, recoveryConicEndDeg: 0 });
    this._recoverProgTimer = setInterval(() => {
      if (!this.data.isRecovering) {
        clearInterval(this._recoverProgTimer);
        this._recoverProgTimer = null;
        return;
      }
      const next = Math.min(88, this.data.recoveryProgress + 3);
      this.setData({
        recoveryProgress: next,
        recoveryConicEndDeg: next * 3.6
      });
      if (next >= 88) {
        clearInterval(this._recoverProgTimer);
        this._recoverProgTimer = null;
      }
    }, 110);
  },

  /**
   * 停止恢复进度动画；成功时短暂显示满环再归零。
   * @param {boolean} complete 是否视为恢复成功
   * @returns {void}
   */
  stopRecoveryProgressAnim: function (complete) {
    if (this._recoverProgTimer) {
      clearInterval(this._recoverProgTimer);
      this._recoverProgTimer = null;
    }
    if (this._recoverProgressResetTimer) {
      clearTimeout(this._recoverProgressResetTimer);
      this._recoverProgressResetTimer = null;
    }
    if (!complete) {
      this.setData({ recoveryProgress: 0, recoveryConicEndDeg: 0 });
      return;
    }
    this.setData({ recoveryProgress: 100, recoveryConicEndDeg: 360 });
    this._recoverProgressResetTimer = setTimeout(() => {
      this._recoverProgressResetTimer = null;
      if (!this.data.isRecovering) {
        this.setData({ recoveryProgress: 0, recoveryConicEndDeg: 0 });
      }
    }, 480);
  },

  /**
   * 恢复失败兜底：释放锁并回退 UI，避免状态钮永久不可点击。
   * @param {string} reason
   * @returns {void}
   */
  finalizeRecoveryAsFailed: function (reason) {
    if (this._recoverUiFailsafeTimer) {
      clearTimeout(this._recoverUiFailsafeTimer);
      this._recoverUiFailsafeTimer = null;
    }
    if (this._recoveryFailSafeTimer) {
      clearTimeout(this._recoveryFailSafeTimer);
      this._recoveryFailSafeTimer = null;
    }
    this._hardRecoverAwaitingCamera = false;
    this._manualRecoveryPendingAck = false;
    this.stopRecoveryProgressAnim(false);
    this.setData({ isRecovering: false, showRecoveryVeil: false });
    this._recoveryLock = false;
    if (this._recorderCore) {
      this._recorderCore.onRecoverFail(reason || 'unknown');
    }
    this.appendHealthLog('hard_recover_fail', {
      reason: reason || 'unknown',
      diag: this.getLiveRollingDiagSnapshot({})
    });
    if (
      reason === 'recovering_ui_5s_failsafe'
      && (this._insertCameraErrorStreak || 0) >= 2
    ) {
      this.markNeedManualRelaunch('recovering_failsafe_after_insert_conflict');
    }
    this.updatePipelineHealth();
  },

  /**
   * 页面内一键恢复：硬重建 camera 与 rolling 管线，避免必须退回微信。
   * @param {string} trigger 触发来源（manual/auto）
   * @returns {void}
   */
  hardRecoverLivePipeline: function (trigger) {
    if (this._recorderCore) {
      return this._recorderCore.requestRecover(trigger || 'manual');
    }
    return this._hardRecoverLivePipelineImpl(trigger);
  },

  _hardRecoverLivePipelineImpl: function (trigger) {
    if (this._recoveryLock) return;
    const source = trigger || 'manual';
    const now = Date.now();
    if (
      source.indexOf('auto:') === 0
      && this._fileQuotaCircuitUntil
      && now < this._fileQuotaCircuitUntil
    ) {
      this.appendHealthLog('hard_recover_blocked_by_file_quota_circuit', {
        trigger: source,
        remainMs: this._fileQuotaCircuitUntil - now
      });
      return;
    }
    if (!this._livePageVisible) {
      this.appendHealthLog('hard_recover_skip_page_hidden', {
        trigger: source,
        diag: this.getLiveRollingDiagSnapshot({})
      });
      return;
    }
    const cooldownUntil = this._insertCameraRecoverCooldownUntil || 0;
    const isAutoRecover = source.indexOf('auto:') === 0;
    if (isAutoRecover && now < cooldownUntil) {
      this.appendHealthLog('hard_recover_skip_insert_cooldown', {
        trigger: source,
        waitMs: cooldownUntil - now
      });
      if (!this._insertCameraRetryTimer) {
        const delay = Math.max(600, cooldownUntil - now + 120);
        this._insertCameraRetryTimer = setTimeout(() => {
          this._insertCameraRetryTimer = null;
          if (this.data.isRecovering || this._recoveryLock) return;
          this.hardRecoverLivePipeline('auto:insert_camera_conflict_retry');
        }, delay);
      }
      return;
    }
    if (now - (this._lastHardRecoverAt || 0) < (this._hardRecoverMinGapMs || 2200)) {
      this.appendHealthLog('hard_recover_skip_too_frequent', { trigger: trigger || 'manual' });
      return;
    }
    this._lastHardRecoverAt = now;
    this._recoveryLock = true;
    if (this._recoveryGuardTimer) {
      clearTimeout(this._recoveryGuardTimer);
      this._recoveryGuardTimer = null;
    }
    this.appendHealthLog('hard_recover_start', {
      trigger: source,
      diag: this.getLiveRollingDiagSnapshot({})
    });
    this._manualRecoveryPendingAck = typeof source === 'string' && source.indexOf('manual') === 0;
    this._hardRecoverAwaitingCamera = true;
    this._recoveryGuardTimer = setTimeout(() => {
      this._recoveryGuardTimer = null;
      if (!this._hardRecoverAwaitingCamera) return;
      this.appendHealthLog('hard_recover_timeout', { trigger: source });
      // 超时后二次强制重建一次，避免 iOS 在 stop 后偶发不再触发 initdone。
      this.rebuildCameraComponent((generation) => {
        this.remountCameraComponent({ generation });
      });
      if (this._recoveryFailSafeTimer) {
        clearTimeout(this._recoveryFailSafeTimer);
      }
      this._recoveryFailSafeTimer = setTimeout(() => {
        if (!this._hardRecoverAwaitingCamera) return;
        this.finalizeRecoveryAsFailed('timeout_after_retry_rebuild');
      }, 4500);
    }, 6000);
    this.rollingActive = false;
    this.rollingSessionId += 1;
    if (this._recorderCore) {
      this._recorderCore.clearPendingHighlight();
    } else {
      if (this.pendingHighlight && this.pendingHighlight.timeout) {
        clearTimeout(this.pendingHighlight.timeout);
      }
      this.pendingHighlight = null;
    }
    this.clearHighlightSavePipelineState();
    /** 避免 isSavingHighlight 仍为 true 时阻塞 FAB / 自动恢复，且与 Native is recording 假死叠加 */
    this.endHighlightSaving();
    this.rollingFsBusy = false;
    this._rollingPersistInFlight = 0;
    this.lastRecordStartAt = 0;
    this.startRecordFailStreak = 0;
    this.segmentPersistFailStreak = 0;
    this.segmentStartFailStormCycles = 0;
    this._rollingTempTerminalFailStreak = 0;
    this._lastSegmentOperateFailAt = 0;
    this.setData({
      isRecovering: true,
      showRecoveryVeil: true,
      recoveryVeilSrc: this.data.defaultCover
    });
    if (this._recoverUiFailsafeTimer) {
      clearTimeout(this._recoverUiFailsafeTimer);
      this._recoverUiFailsafeTimer = null;
    }
    let recoverUiFailsafeMs = 6000;
    try {
      const siFs = wx.getSystemInfoSync();
      if (siFs && siFs.platform === 'ios') {
        recoverUiFailsafeMs = 11000;
      }
    } catch (eFs) {
      recoverUiFailsafeMs = 6000;
    }
    this._recoverUiFailsafeTimer = setTimeout(() => {
      this._recoverUiFailsafeTimer = null;
      if (this.data.isRecovering) {
        this.finalizeRecoveryAsFailed('recovering_ui_5s_failsafe');
      }
    }, recoverUiFailsafeMs);
    this.startRecoveryProgressAnim();
    this.armNativeEnhanceModeRestoreAfterCameraRebuild('hard_recover');
    const allowCameraRebuild = !!(
      this._recorderCore && this._recorderCore.recoverFailCount >= 2
    );
    this.stopRollingRecording(() => {
      this.rollingSegments = [];
      this.segmentBuffer = [];
      this.lastSegmentAt = Date.now();
      if (!allowCameraRebuild) {
        this.appendHealthLog('hard_recover_recorder_restart_only', { trigger: source });
        this.rollingActive = true;
        this.rollingSessionId += 1;
        this.highlightMissStreak = 0;
        this._cameraFaultStreak = 0;
        this.tryStartRollingWhenCameraReady('recover_restart_only');
        if (this._recoveryGuardTimer) {
          clearTimeout(this._recoveryGuardTimer);
          this._recoveryGuardTimer = null;
        }
        if (this._recoverUiFailsafeTimer) {
          clearTimeout(this._recoverUiFailsafeTimer);
          this._recoverUiFailsafeTimer = null;
        }
        this._hardRecoverAwaitingCamera = false;
        this.stopRecoveryProgressAnim(true);
        this.setData({ isRecovering: false, showRecoveryVeil: false });
        this._recoveryLock = false;
        if (this._manualRecoveryPendingAck) {
          this._manualRecoveryPendingAck = false;
          this.emitRecoverySuccessFeedback();
        }
        if (this._recorderCore) {
          this._recorderCore.onRecoverSuccess('recorder_restart_only');
        }
        this.tryStartRollingWhenCameraReady('recover_restart_only');
        return;
      }
      this._cameraInitDone = false;
      this.rebuildCameraComponent((generation) => {
        this.remountCameraComponent({
          generation,
          onMounted: () => {
            this.rollingActive = true;
            this.rollingSessionId += 1;
            this.highlightMissStreak = 0;
            this._cameraFaultStreak = 0;
            this.appendHealthLog('hard_recover_rebuild_done', { trigger: source });
          }
        });
      });
    }, 'hard_recover');
  },

  /**
   * 右下角状态钮：REC 时保存高光；ERR 时单击触发页内硬恢复（不跳页、不挡预览）。
   * @returns {void}
   */
  onRecoveryFabTap: function () {
    this.appendHealthLog('recovery_fab_tap', {
      pipelineHealth: this.data.pipelineHealth,
      opsControlText: this.data.opsControlText,
      isRecording: !!this.data.isRecording,
      rollingActive: !!this.rollingActive,
      recorderState: this._recorderCore ? this._recorderCore.state : ''
    });
    if (this.data.isRecovering) {
      this.appendHealthLog('recovery_fab_tap_ignored', { reason: 'recovering' });
      return;
    }
    if (this.data.storageSevereLock) {
      this.appendHealthLog('recovery_fab_tap_ignored', { reason: 'storage_severe' });
      this._showLightHint('请先清理空间');
      return;
    }
    if (this.data.isSavingHighlight || this.pendingHighlight) {
      this.appendHealthLog('recovery_fab_tap_ignored', {
        reason: this.data.isSavingHighlight ? 'saving_highlight' : 'pending_highlight'
      });
      return;
    }
    if (this._recoveryFabLongPressConsumed) {
      this._recoveryFabLongPressConsumed = false;
      this.appendHealthLog('recovery_fab_tap_ignored', { reason: 'longpress_consumed' });
      return;
    }
    const canCaptureWhileRolling =
      !!this.rollingActive
      && !!this._cameraInitDone
      && !!this.data.cameraContext
      && !this.data.isRecovering
      && !this._recoveryLock;
    if (
      this.data.pipelineHealth === 'recording'
      || this.data.enhanceMode === 'vk'
      || canCaptureWhileRolling
    ) {
      this.requestHighlightCapture();
      return;
    }
    const isErr =
      this.data.pipelineHealth === 'warn'
      || this._needManualRelaunch
      || this.data.opsControlText === 'ERR';
    if (isErr) {
      this.vibrate('light');
      this.appendHealthLog('recovery_fab_tap_recover', {});
      this.hardRecoverLivePipeline('manual_tap');
      return;
    }
    this.appendHealthLog('recovery_fab_tap_ignored', { reason: 'not_recording_or_err' });
  },

  /**
   * 系统 longpress：ERR 态下触发页内硬恢复。
   * @returns {void}
   */
  onRecoveryFabLongPress: function () {
    if (this.data.isRecovering) return;
    this._recoveryFabLongPressConsumed = true;
    const isErr =
      this.data.pipelineHealth === 'warn'
      || this._needManualRelaunch
      || this.data.opsControlText === 'ERR';
    if (!isErr) return;
    this.vibrate('light');
    this.appendHealthLog('recovery_fab_longpress_recover', {});
    this.hardRecoverLivePipeline('manual_longpress');
  },

  /**
   * 状态灯按下：ERR 态长按约 1.8s 触发页内硬恢复（与单击互为补充）。
   * @returns {void}
   */
  onRecoveryFabTouchStart: function () {
    const isErr =
      this.data.pipelineHealth === 'warn'
      || this._needManualRelaunch
      || this.data.opsControlText === 'ERR';
    if (!isErr) return;
    if (this._relaunchPressTimer) {
      clearTimeout(this._relaunchPressTimer);
      this._relaunchPressTimer = null;
    }
    this._relaunchPressTimer = setTimeout(() => {
      this._relaunchPressTimer = null;
      this._recoveryFabLongPressConsumed = true;
      this.vibrate('light');
      this.appendHealthLog('recovery_fab_hold_recover', {});
      this._needManualRelaunch = false;
      this.hardRecoverLivePipeline('manual_hold_recover');
    }, 1800);
  },

  /**
   * 状态灯抬起/取消：清理长按重启计时器。
   * @returns {void}
   */
  onRecoveryFabTouchEnd: function () {
    if (this._relaunchPressTimer) {
      clearTimeout(this._relaunchPressTimer);
      this._relaunchPressTimer = null;
    }
  },

  // 节次切换
  onPeriodTap: function () {
    let { period } = this.data.matchConfig;
    period = (period + 1) % this.data.periods.length;
    this.setData({ 'matchConfig.period': period });
    this.vibrate('light');
  },

  // 核心记分逻辑
  onScoreTap: function (e) {
    const { team, type } = e.currentTarget.dataset;
    if (this.suppressScoreTap) {
      this.suppressScoreTap = false;
      return;
    }
    this.applyScoreChange(team, type);
    if (type === 'plus') {
      this.vibrate('medium');
    } else if (type === 'minus') {
      this.vibrate('light');
    }
    this.persistConfig();
  },

  applyScoreChange: function (team, type) {
    let score = this.data.matchConfig[team].score;
    if (type === 'plus') {
      score += 1;
    } else if (type === 'minus') {
      score = Math.max(0, score - 1);
    }
    this.setData({ [`matchConfig.${team}.score`]: score });
  },

  onBackTap: function () {
    this.closeAllDrawers();
    this.stopRollingRecording();
    wx.navigateBack();
  },

  // 长按连续记分
  onScoreLongPress: function (e) {
    const { team, type } = e.currentTarget.dataset;
    this.vibrate('heavy');
    this.suppressScoreTap = true;
    if (this.data.longPressTimer) {
      clearInterval(this.data.longPressTimer);
    }
    this.applyScoreChange(team, type);
    const timer = setInterval(() => {
      this.applyScoreChange(team, type);
    }, 120);

    this.setData({ longPressTimer: timer });
  },

  // 停止长按
  onScoreTouchEnd: function () {
    if (this.data.longPressTimer) {
      clearInterval(this.data.longPressTimer);
      this.setData({ longPressTimer: null });
      this.persistConfig();
    }
    setTimeout(() => {
      this.suppressScoreTap = false;
    }, 0);
  },

  // 震动反馈
  vibrate: function (type) {
    // 兼容性与稳定性修复：
    // 1. iOS 优先使用 type 参数以获得细腻的触觉反馈。
    // 2. Android 部分机型在传入 type 时可能失效或无响应，故直接调用无参版以确保触发。
    try {
      const sys = wx.getSystemInfoSync();
      if (sys.platform === 'ios') {
        wx.vibrateShort({ type: type || 'medium' });
      } else {
        wx.vibrateShort();
      }
    } catch (e) {
      // 兜底
      if (wx.vibrateShort) wx.vibrateShort();
    }
  },

  /**
   * 高光保存成功时的触觉反馈。异步落盘完成后 iOS 常不再算「用户手势」，故需配合长按瞬间的震动；
   * Android 优先长震，失败则短震组合。
   */
  vibrateHighlightSaved: function () {
    const fallback = () => {
      this.vibrate('heavy');
      setTimeout(() => this.vibrate('heavy'), 160);
      setTimeout(() => this.vibrate('medium'), 320);
    };
    if (wx.vibrateLong) {
      wx.vibrateLong({
        success: () => {
          setTimeout(() => this.vibrate('medium'), 80);
        },
        fail: fallback
      });
    } else {
      fallback();
    }
  },

  getHighlightDir: function () {
    return `${wx.env.USER_DATA_PATH}/highlights`;
  },

  /**
   * 滚动录制缓存目录（用于提高高光保存稳定性）。
   * 注意：这里存的是最近若干段“已落盘”的视频片段，避免 temp 文件被系统回收。
   * @returns {string}
   */
  getRollingDir: function () {
    return `${this.getHighlightDir()}/_rolling`;
  },

  ensureHighlightDir: function () {
    const fs = wx.getFileSystemManager();
    const dirPath = this.getHighlightDir();
    return new Promise((resolve) => {
      fs.access({
        path: dirPath,
        success: () => resolve(),
        fail: () => {
          fs.mkdir({
            dirPath,
            recursive: true,
            success: () => resolve(),
            fail: () => resolve()
          });
        }
      });
    });
  },

  /**
   * 确保滚动录制缓存目录存在。
   * @returns {Promise<void>}
   */
  ensureRollingDir: function () {
    const fs = wx.getFileSystemManager();
    const dirPath = this.getRollingDir();
    return new Promise((resolve) => {
      fs.access({
        path: dirPath,
        success: () => resolve(),
        fail: () => {
          fs.mkdir({
            dirPath,
            recursive: true,
            success: () => resolve(),
            fail: () => resolve()
          });
        }
      });
    });
  },

  /**
   * 清理 rolling 目录中的历史会话残留分段，避免长期运行后占满沙盒存储导致落盘失败。
   * 说明：仅删除 `_rolling` 目录下的临时分段，不影响已保存高光。
   * @returns {Promise<void>}
   */
  clearStaleRollingFiles: function () {
    const fs = wx.getFileSystemManager();
    const rollingDir = this.getRollingDir();
    return new Promise((resolve) => {
      fs.readdir({
        dirPath: rollingDir,
        success: (res) => {
          const files = Array.isArray(res && res.files) ? res.files : [];
          if (files.length === 0) {
            resolve();
            return;
          }
          let pending = files.length;
          files.forEach((name) => {
            const fullPath = `${rollingDir}/${name}`;
            fs.unlink({
              filePath: fullPath,
              complete: () => {
                pending -= 1;
                if (pending <= 0) resolve();
              }
            });
          });
        },
        fail: () => resolve()
      });
    });
  },

  buildVkTailHighlightPlan: function (ctx) {
    var now = Date.now();
    var recordStartWall = ctx._vkTimeshiftStartAt || now;
    var ENCODER_DELAY_MS = 200;
    var SAFE_TAIL_MS = 300;   // 防止尾部未封装
    var TARGET_DURATION = 10; // 调为 10 秒以确保快进后有足够的精彩画面

    // 当前可用视频时长（秒）
    var safeDuration = (now - recordStartWall - ENCODER_DELAY_MS) / 1000;
    if (!isFinite(safeDuration) || safeDuration <= 0) {
      safeDuration = 0;
    }

    // 再扣尾部 buffer
    safeDuration = Math.max(0, safeDuration - SAFE_TAIL_MS / 1000);

    // 增加点击延迟补偿
    var CLICK_DELAY_COMPENSATE = 0.3; // 秒
    var expectedEnd = safeDuration - CLICK_DELAY_COMPENSATE;
    if (expectedEnd < 0) expectedEnd = safeDuration;

    // 起点
    var startTime = expectedEnd - TARGET_DURATION;
    if (startTime < 0) startTime = 0;

    // 实际裁剪长度
    var duration = expectedEnd - startTime;

    // 最小保护（防止导出失败）
    if (duration <= 0) {
      duration = Math.min(2, safeDuration);
      startTime = Math.max(0, safeDuration - duration);
    }

    return {
      startTimeSec: startTime,
      durationSec: duration
    };
  },

  startRollingRecording: function (source) {
    if (this._recorderCore) {
      return this._recorderCore.requestStartRolling(source || 'startRollingRecording');
    }
    return this._startRollingRecordingImpl();
  },

  _startRollingRecordingImpl: function () {
    if (!this.data.cameraContext) return;
    /** 已在录时勿重复拉起，避免双 startRecord；假阳性 isRecording 由 onShow 的 stopRollingRecording 收口 */
    if (this.data.isRecording) return;
    const sessionId = this.rollingSessionId;
    Promise.resolve().then(() => {
      if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
      if (this.rollingWatchdogTimer) {
        clearInterval(this.rollingWatchdogTimer);
      }
      /**
       * 录制看门狗：如果录制意外断流（例如 startRecord 连续失败），自动拉起。
       */
      this.rollingWatchdogTimer = setInterval(() => {
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        /** copy 尚未完成时不能认为「空闲」，否则会在长直播、磁盘变慢时并行 startRecord */
        if (this.rollingFsBusy) return;
        const now = Date.now();
        const isStuckRecording = this.data.isRecording
          && this.lastRecordStartAt > 0
          && (now - this.lastRecordStartAt > this.segmentDurationMs * 2.8);
        if (isStuckRecording) {
          try {
            this.data.cameraContext.stopRecord({
              complete: () => {
                this.setData({ isRecording: false });
                this.lastRecordStartAt = 0;
                this.scheduleAfterForcedStopReady(
                  'watchdog_stop_complete',
                  () => this.startOneSegment(sessionId, 0, 'watchdog_restart')
                );
              }
            });
          } catch (e) {
            this.setData({ isRecording: false });
            this.lastRecordStartAt = 0;
            this.scheduleAfterForcedStopReady(
              'watchdog_stop_catch',
              () => this.startOneSegment(sessionId, 0, 'watchdog_restart')
            );
          }
          return;
        }
        if (this.data.isRecording) return;
        if (this.data.storageSevereLock) return;
        const streamIdleTooLong = now - this.lastSegmentAt > this.segmentDurationMs * 3;
        if (!streamIdleTooLong) return;
        this.startOneSegment(sessionId, 0);
      }, this.segmentDurationMs * 3);
      this.startOneSegment(sessionId, 0, 'rolling_kickoff');
    });
  },

  startOneSegment: function (sessionId, retryCount = 0, source) {
    if (this._recorderCore) {
      return this._recorderCore.requestStartSegment(
        source || 'startOneSegment',
        sessionId,
        retryCount
      );
    }
    return this._startOneSegmentImpl(sessionId, retryCount);
  },

  _startOneSegmentImpl: function (sessionId, retryCount = 0) {
    if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
    if (!this.data.cameraContext) return;
    if (this.data.storageSevereLock) {
      try {
        this.appendHealthLog('segment_start_skipped_storage_severe', { retryCount });
      } catch (eL) { }
      return;
    }
    if (this._needManualRelaunch) return;
    if (this._startOneSegmentInFlight) return;
    this._startOneSegmentInFlight = true;
    this.data.cameraContext.startRecord({
      timeout: Math.max(12, Math.ceil(this.segmentDurationMs / 1000) + 2),
      success: () => {
        this._startOneSegmentInFlight = false;
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        if (this._recorderCore) {
          this._recorderCore.onSegmentStartSuccess('segment_start_ok', sessionId);
        }
        this.clearSegmentStartRetryTimer();
        this._segmentStartRecoveringFromIsRecording = false;
        this._segmentStartRecoveringFromOperateFail = false;
        const hadFailBefore = this.startRecordFailStreak > 0;
        this.startRecordFailStreak = 0;
        this.segmentStartFailStormCycles = 0;
        this._currentRollingSegmentRecordStartMs = Date.now();
        this.lastRecordStartAt = Date.now();
        const nextRec = { isRecording: true };
        if (this.data.aeContext === 'pre' && this.data.aeControlsVisible) {
          nextRec.aeControlsVisible = false;
          nextRec.aeContext = '';
          nextRec.aeShowDoubleTapHint = false;
          nextRec.aeFocusUserLocked = false;
        }
        this.setData(nextRec);
        if (
          this._highlightSaveAwaitingResume
          && this._highlightSaveSessionId === sessionId
        ) {
          this._highlightPipelineDoneResume = true;
          this.maybeReleaseHighlightSaveLock();
        }
        if (hadFailBefore) {
          this.appendHealthLog('segment_start_ok_recovered', { retryCount });
        }
        if (retryCount > 0) {
          this.appendHealthLog('segment_start_ok_after_retry', { retryCount });
        }
        if (this.segmentStopTimer) clearTimeout(this.segmentStopTimer);
        this.segmentStopTimer = setTimeout(() => {
          this.stopOneSegment(sessionId);
        }, this.segmentDurationMs);
      },
      fail: (err) => {
        this._startOneSegmentInFlight = false;
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        if (this._recorderCore) {
          this._recorderCore.onSegmentStartFail('segment_start_fail');
        }
        this.startRecordFailStreak += 1;
        const errMsg = err && err.errMsg ? String(err.errMsg) : '';
        /** 全量 diag 仅在连续失败时附带，避免健康缓冲被长直播刷屏撑满 */
        const logDetail = {
          retryCount,
          failStreak: this.startRecordFailStreak,
          errMsg: errMsg || '(empty)'
        };
        if (this.startRecordFailStreak >= 2) {
          logDetail.diag = this.getLiveRollingDiagSnapshot({});
        }
        this.appendHealthLog('segment_start_fail', logDetail);
        const lowerErr = errMsg.toLowerCase();
        const isRecordingConflict = lowerErr.indexOf('is recording') >= 0;
        if (isRecordingConflict) {
          this.appendHealthLog('segment_start_realign_is_recording_conflict', {
            retryCount,
            failStreak: this.startRecordFailStreak
          });
          /**
           * 关键修复：is recording 冲突在部分安卓机（如小米）常由 Native 状态滞后引发，
           * 继续硬恢复会放大“重启风暴”。这里改为长冷却重试，不再直接硬恢复。
           */
          if (this.startRecordFailStreak >= 10) {
            this.clearSegmentStartRetryTimer();
            this._segmentStartRecoveringFromIsRecording = false;
            this.appendHealthLog('segment_start_is_recording_conflict_cooldown', {
              streak: this.startRecordFailStreak
            });
            this.startRecordFailStreak = 0;
            const retryLater = () => {
              this.scheduleStartOneSegmentRetry(sessionId, 0, 4600);
            };
            try {
              this.data.cameraContext.stopRecord({
                complete: retryLater,
                fail: retryLater
              });
            } catch (eStopRec) {
              retryLater();
            }
            return;
          }
          this._segmentStartRecoveringFromIsRecording = true;
          const restartAfterStop = () => {
            this.setData({ isRecording: false });
            this.lastRecordStartAt = 0;
            const extraAlign = this.getIsRecordingConflictExtraStartDelayMs();
            this.scheduleAfterForcedStopReady('is_recording_conflict_stop', () => {
              this._segmentStartRecoveringFromIsRecording = false;
              if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
              if (extraAlign > 0) {
                setTimeout(() => {
                  if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
                  this.startOneSegment(sessionId, 0, 'is_recording_conflict_retry');
                }, extraAlign);
              } else {
                this.startOneSegment(sessionId, 0, 'is_recording_conflict_retry');
              }
            });
          };
          try {
            this.data.cameraContext.stopRecord({
              complete: restartAfterStop,
              fail: restartAfterStop
            });
          } catch (eStopRec) {
            restartAfterStop();
          }
          return;
        }
        const isOperateFail = lowerErr.indexOf('operate fail') >= 0;
        if (isOperateFail) {
          this._lastSegmentOperateFailAt = Date.now();
          if (this._segmentStartRecoveringFromOperateFail) {
            this.scheduleStartOneSegmentRetry(sessionId, 0, 520);
            return;
          }
          this._segmentStartRecoveringFromOperateFail = true;
          this.appendHealthLog('segment_start_realign_operate_fail', {
            retryCount,
            failStreak: this.startRecordFailStreak
          });
          const restartAfterStop = () => {
            this.setData({ isRecording: false });
            this.lastRecordStartAt = 0;
            this.scheduleAfterForcedStopReady('operate_fail_stop', () => {
              this._segmentStartRecoveringFromOperateFail = false;
              if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
              if (this._needManualRelaunch) return;
              this.startOneSegment(sessionId, 0, 'operate_fail_retry');
            });
          };
          try {
            this.data.cameraContext.stopRecord({ complete: restartAfterStop });
          } catch (eStopRec) {
            restartAfterStop();
          }
          if (this.startRecordFailStreak >= 5) {
            this.appendHealthLog('segment_start_operate_fail_auto_recover', {
              retryCount,
              failStreak: this.startRecordFailStreak
            });
            this.triggerCameraFaultRecovery('start:operate_fail');
          }
          return;
        }
        // 关键修复：不能在少量失败后停止，否则 segmentCounter 会冻结，后续高光重复。
        const nextRetry = retryCount + 1;
        let platformSegPad = 0;
        let isIosFail = false;
        try {
          const si = wx.getSystemInfoSync();
          const n = typeof this.segmentCounter === 'number' ? this.segmentCounter : 0;
          if (si && si.platform === 'android') {
            platformSegPad = Math.min(380, Math.floor(n / 16) * 30);
          } else if (si && si.platform === 'ios') {
            isIosFail = true;
            /** iOS startRecord 失败后略拉长退避，避免与文件落盘叠峰 */
            platformSegPad = Math.min(380, Math.floor(n / 10) * 32);
          }
        } catch (ePad) {
          platformSegPad = 0;
        }
        const baseBackoff = isIosFail ? 300 : 220;
        const perStep = isIosFail ? 175 : 140;
        const delay = Math.min(2200, baseBackoff + nextRetry * perStep + platformSegPad);
        if (this.startRecordFailStreak >= 5) {
          this.segmentStartFailStormCycles = (this.segmentStartFailStormCycles || 0) + 1;
          this.appendHealthLog('segment_start_fail_storm_cycle', {
            cycles: this.segmentStartFailStormCycles,
            lastErrMsg: errMsg || '(empty)',
            diag: this.getLiveRollingDiagSnapshot({})
          });
          /** 易与回放恢复、磁盘抖动叠加误报，略提高阈值；真正死锁仍由 ERR + 手动恢复覆盖 */
          if (this.segmentStartFailStormCycles >= 4) {
            this.segmentStartFailStormCycles = 0;
            this.markNeedManualRelaunch('segment_start_fail_storm');
            this.startRecordFailStreak = 0;
            this.setData({ isRecording: false });
            this.lastRecordStartAt = 0;
            return;
          }
          this.startRecordFailStreak = 0;
          this.setData({ isRecording: false });
          this.lastRecordStartAt = 0;
          this.scheduleAfterForcedStopReady(
            'start_fail_storm_reset',
            () => this.startOneSegment(sessionId, 0, 'start_fail_storm_retry')
          );
          return;
        }
        this.scheduleStartOneSegmentRetry(sessionId, nextRetry, delay);
      }
    });
  },

  stopOneSegment: function (sessionId, source) {
    if (this._recorderCore) {
      return this._recorderCore.requestStopSegment(source || 'stopOneSegment', sessionId);
    }
    return this._stopOneSegmentImpl(sessionId);
  },

  _stopOneSegmentImpl: function (sessionId) {
    if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
    if (!this.data.cameraContext || !this.data.isRecording) return;
    this.data.cameraContext.stopRecord({
      success: (res) => {
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        this.setData({ isRecording: false });
        this.lastRecordStartAt = 0;
        const tempPath = res && res.tempVideoPath ? res.tempVideoPath : '';
        const recordStartWallMs = this._currentRollingSegmentRecordStartMs || 0;
        /** 在 copy 完成前就刷新心跳，避免仅依赖 finalize 时写盘慢导致看门狗误判空闲 */
        this.lastSegmentAt = Date.now();
        this.segmentCounter += 1;
        let persistPromise = Promise.resolve();
        const stopCompletedAt = Date.now();
        if (tempPath) {
          /**
           * Android：落盘与下一段并行（temp 相对稳定）。
           * iOS：**必须先完成本段 temp→稳定路径**，再 schedule 下一段 startRecord；否则下一段相机起来后，
           * 系统常提前回收上一段 temp，导致 copy/save 全失败、高光五连重试仍 segment_persist_reject_temp_unstable。
           */
          persistPromise = this.onSegmentRecorded(
            tempPath,
            this.segmentCounter,
            sessionId,
            recordStartWallMs
          );
        } else {
          this.abortHighlightAfterStopIfNeeded(sessionId, 'empty_temp_path');
        }
        const kickNextSegment = () => {
          if (this._recorderCore) {
            this._recorderCore.noteFlushLag(Date.now() - stopCompletedAt);
          }
          if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
          if (this.data.storageSevereLock) {
            try {
              this.appendHealthLog('next_segment_suppressed_storage_severe', {
                reason: tempPath ? 'storage_severe' : 'empty_temp'
              });
            } catch (eN) { }
            return;
          }
          this.scheduleAfterStopRecord(() => this.startOneSegment(sessionId, 0, 'segment_flush_ready'));
        };
        if (this._recorderCore) {
          this._recorderCore.onSegmentStopSuccess('segment_stop_ok', persistPromise, kickNextSegment);
        } else {
          Promise.resolve(persistPromise).finally(kickNextSegment);
        }
      },
      fail: (err) => {
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        const errMsg = err && err.errMsg ? String(err.errMsg) : '';
        this.appendHealthLog('stop_record_fail', {
          errMsg: errMsg || '(empty)',
          diag: this.getLiveRollingDiagSnapshot({})
        });
        this.setData({ isRecording: false });
        this.lastRecordStartAt = 0;
        this.abortHighlightAfterStopIfNeeded(sessionId, 'stop_record_fail');
        if (this.data.storageSevereLock) {
          try {
            this.appendHealthLog('next_segment_suppressed_storage_severe', { reason: 'stop_fail' });
          } catch (eF) { }
          return;
        }
        if (this._recorderCore) {
          this._recorderCore.onSegmentStopSuccess(
            'segment_stop_fail_fallback',
            Promise.resolve(),
            () => this.scheduleAfterStopRecord(() => this.startOneSegment(sessionId, 0, 'segment_stop_fail_ready'))
          );
          return;
        }
        this.scheduleAfterStopRecord(() => this.startOneSegment(sessionId));
      }
    });
  },

  /**
   * 停止滚动分段录制并清理定时器。
   * @param {function(): void} [onStopped] 在录制状态已释放后调用（无录制时下一 tick 调用）
   * @returns {void}
   */
  stopRollingRecording: function (onStopped, source) {
    if (this._recorderCore) {
      return this._recorderCore.requestStopRolling(
        source || 'stopRollingRecording',
        onStopped
      );
    }
    return this._stopRollingRecordingImpl(onStopped);
  },

  _stopRollingRecordingImpl: function (onStopped) {
    this.clearSegmentStartRetryTimer();
    this._startOneSegmentInFlight = false;
    this._segmentStartRecoveringFromIsRecording = false;
    this._segmentStartRecoveringFromOperateFail = false;
    if (this.rollingWatchdogTimer) {
      clearInterval(this.rollingWatchdogTimer);
      this.rollingWatchdogTimer = null;
    }
    if (this.segmentStopTimer) {
      clearTimeout(this.segmentStopTimer);
      this.segmentStopTimer = null;
    }
    let finishOnce = false;
    /**
     * 将 isRecording 置 false 后再执行 onStopped，避免 setData 未完成时 startRollingRecording
     * 仍读到 isRecording === true 而直接 return。
     */
    const finish = () => {
      if (finishOnce) return;
      finishOnce = true;
      this.lastRecordStartAt = 0;
      let stoppedRan = false;
      const runStopped = () => {
        if (stoppedRan || typeof onStopped !== 'function') return;
        stoppedRan = true;
        if (wx.nextTick) wx.nextTick(onStopped);
        else setTimeout(onStopped, 0);
      };
      if (this.data.isRecording) {
        this.setData({ isRecording: false }, runStopped);
        setTimeout(runStopped, 120);
      } else {
        runStopped();
      }
    };
    if (this.data.cameraContext && this.data.isRecording) {
      let stopFinished = false;
      const stopSafetyMs = 3200;
      const safetyTimer = setTimeout(() => {
        if (stopFinished) return;
        stopFinished = true;
        try {
          this.appendHealthLog('stop_record_kickoff_timeout', {});
        } catch (eLog) { }
        finish();
      }, stopSafetyMs);
      const finishFromStop = () => {
        if (stopFinished) return;
        stopFinished = true;
        clearTimeout(safetyTimer);
        finish();
      };
      try {
        this.data.cameraContext.stopRecord({
          success: finishFromStop,
          fail: finishFromStop
        });
      } catch (e) {
        clearTimeout(safetyTimer);
        finish();
      }
    } else {
      finish();
    }
  },

  /**
   * 将单段录制结果写入滚动缓存。
   * @param {string} tempPath 临时视频路径
   * @param {number} segNo 片段序号
   * @param {number} recordSessionId 本段录制开始时的 {@link rollingSessionId}，异步落盘完成时必须一致才入缓冲
   * @param {number} [recordStartWallMs] 本段 startRecord 成功时的墙钟时间（用于高光逻辑起播偏移）
   * @returns {Promise<void>}
   */
  onSegmentRecorded: function (tempPath, segNo, recordSessionId, recordStartWallMs) {
    // MOD: rolling buffer 只保留 temp 素材和墙钟时间，不再 copyFile/saveFile 到 _rolling。
    if (recordSessionId !== this.rollingSessionId) {
      return Promise.resolve();
    }
    const recordStart = typeof recordStartWallMs === 'number' && recordStartWallMs > 0
      ? recordStartWallMs
      : Date.now();
    const segment = {
      path: tempPath || '',
      startTime: recordStart,
      endTime: Date.now()
    };
    if (!segment.path) {
      this.abortHighlightAfterStopIfNeeded(recordSessionId, 'empty_temp_path');
      return Promise.resolve();
    }
    if (!Array.isArray(this.rollingSegments)) this.rollingSegments = [];
    const prev = this.rollingSegments.length
      ? this.rollingSegments[this.rollingSegments.length - 1]
      : null;
    if (prev && typeof prev.endTime === 'number' && segment.startTime > prev.endTime + 240) {
      if (this._recorderCore) {
        this._recorderCore.noteTimelineGap('segment_recorded', segment.startTime - prev.endTime);
      }
    }
    this.rollingSegments.push(segment);
    while (this.rollingSegments.length > (this.rollingBufferMax || 3)) {
      this.rollingSegments.shift();
    }
    // 兼容旧诊断/清理函数字段；高光判断不再读取 segNo。
    this.segmentBuffer = this.rollingSegments;
    this._rollingTempMissingStreak = 0;
    this._rollingTempTerminalFailStreak = 0;
    this.segmentPersistFailStreak = 0;
    this.appendHealthLog('rolling_segment_indexed_by_time', {
      segNo,
      startTime: segment.startTime,
      endTime: segment.endTime,
      durationMs: segment.endTime - segment.startTime,
      bufferSize: this.rollingSegments.length
    });
    this._tryGenerateHighlight();
    return Promise.resolve();
  },

  /**
   * 高光等待超时或长期无新段时，尝试结束异常分段并重新拉起滚动录制（外录/磁盘慢场景）。
   * copy 进行中时延后执行，避免与相机分段并发冲突。
   *
   * @param {function(): void} [onDone] 恢复尝试结束后的回调
   * @param {number} [busyRetries] 内部参数：等待 rollingFsBusy 解除的重试次数
   * @returns {void}
   */
  recoverRollingPipelineForHighlight: function (onDone, busyRetries) {
    const maxBusyWait = 40;
    const n = typeof busyRetries === 'number' ? busyRetries : 0;
    if (this.rollingFsBusy && n < maxBusyWait) {
      setTimeout(() => {
        this.recoverRollingPipelineForHighlight(onDone, n + 1);
      }, 200);
      return;
    }
    /**
     * 高光超时只做「软恢复」：重置失败计数并 tryStart。
     * 禁止此处调用 stopRollingRecording→stopRecord：预览正常时中断分段录制极易整屏黑屏。
     * 会话级假死仍由 onShow 的 stopRollingRecording 收口。
     */
    this.startRecordFailStreak = 0;
    const kick = () => {
      this.tryStartRollingWhenCameraReady();
      if (typeof onDone === 'function') onDone();
    };
    if (wx.nextTick) wx.nextTick(kick);
    else setTimeout(kick, 0);
  },

  /**
   * temp 文件在 stopRecord 后连续出现“终态丢失”时的处理。
   *
   * 默认仍以“观察 + 放行下一段”为主，避免把偶发 temp 抖动放大成恢复风暴。
   * 但若它与最近的 startRecord operate fail 成簇出现，说明已不只是单纯落盘慢，
   * 更可能是 native camera/record 会话退化，此时升级到受控 hard recover。
   *
   * 这样既保留了对偶发 temp 丢失的容忍，也能在真故障时尽快自愈，减少黑屏/空录持续时间。
   *
   * @param {number} streak 当前连续失败次数
   * @param {number} segNo 触发时片段号
   * @returns {void}
   */
  maybeHardRecoverForTempMissingStorm: function (streak, segNo) {
    const n = Number(streak || 0);
    if (n < 2) return;
    const now = Date.now();
    const operateFailAgoMs = this._lastSegmentOperateFailAt > 0
      ? now - this._lastSegmentOperateFailAt
      : -1;
    this.appendHealthLog('temp_missing_storm_observed', {
      streak: n,
      segNo,
      operateFailAgoMs: operateFailAgoMs
    });
    const recentOperateFail =
      this._lastSegmentOperateFailAt > 0 && operateFailAgoMs >= 0 && operateFailAgoMs <= 15000;
    if (
      recentOperateFail
      && this.data.enhanceMode !== 'vk'
      && now - (this._lastTempMissingStormRecoverAt || 0) >= 18000
      && this._livePageVisible
      && !this.data.isRecovering
      && !this._recoveryLock
    ) {
      this._lastTempMissingStormRecoverAt = now;
      this.appendHealthLog('temp_missing_storm_hard_recover', {
        streak: n,
        segNo,
        operateFailAgoMs: operateFailAgoMs
      });
      this.hardRecoverLivePipeline('auto:temp_missing_storm_operate_fail');
      return;
    }
    this._rollingTempTerminalFailStreak = 0;
  },

  /**
   * MOD: temp rolling 不再主动删除文件，引用锁保留为空实现以兼容固化流程。
   * @param {string[]} paths
   * @returns {void}
   */
  retainRollingSegmentsByPaths: function (paths) {
    return;
  },

  /**
   * MOD: temp rolling 不再主动删除文件，释放引用锁保留为空实现以兼容固化流程。
   * @param {string[]} paths
   * @returns {void}
   */
  releaseRollingSegmentsByPaths: function (paths) {
    return;
  },

  /**
   * 是否允许执行高光实体固化（degraded/recovering/故障态时暂停重 IO）。
   * @returns {boolean}
   */
  canMaterializeHighlightNow: function () {
    if (this.data.isRecovering || this._needManualRelaunch) return false;
    if (this.data.pipelineHealth === 'warn') return false;
    return true;
  },

  /**
   * 清理过量高光实体，避免温层无限增长与沙盒爆满。
   * @param {string} matchId
   * @returns {void}
   */
  pruneHighlightStorageForMatch: function (matchId) {
    const key = clipsStorage.normalizeMatchIdKey(matchId);
    if (!key) return;
    const fs = wx.getFileSystemManager();
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) return;
    const list = Array.isArray(clipsMap[key]) ? clipsMap[key] : [];
    const maxCount = this.highlightsMaxCount || 100;
    if (list.length <= maxCount) return;
    const sorted = list
      .slice()
      .sort(
        (a, b) =>
          this.resolveHighlightCreatedAt(/** @type {Record<string, unknown>} */(b))
          - this.resolveHighlightCreatedAt(/** @type {Record<string, unknown>} */(a))
      );
    const removed = sorted.slice(maxCount);
    clipsMap[key] = sorted.slice(0, maxCount);
    clipsStorage.writeClipsMapSafe(clipsMap);
    removed.forEach((it) => {
      const segs = it && Array.isArray(it.segments) ? it.segments : [];
      segs.forEach((p) => {
        if (!p) return;
        try { fs.unlinkSync(p); } catch (e) { }
      });
    });
  },

  /**
   * 统计高光索引总条数（跨场次）。
   * @returns {number}
   */
  getTotalHighlightClipCount: function () {
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) return 0;
    let total = 0;
    Object.keys(clipsMap).forEach((matchId) => {
      const list = clipsMap[matchId];
      if (!Array.isArray(list)) return;
      total += list.length;
    });
    return total;
  },

  /**
   * 按创建时间删除最旧的高光条目并 unlink 片段文件，缓解小程序「文件存储」上限（非 KV）。
   * @param {number} maxRemove 最多删除几条（跨场次全局最旧）
   * @param {string} [reason] 触发来源（诊断日志用）
   * @returns {number} 实际删除条数
   */
  pruneOldestHighlightClipsFromStorage: function (maxRemove, reason, opts) {
    const cap = typeof maxRemove === 'number' && maxRemove > 0 ? Math.min(maxRemove, 30) : 1;
    const why = typeof reason === 'string' ? reason : '';
    const options = opts && typeof opts === 'object' ? opts : {};
    const fs = wx.getFileSystemManager();
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) return 0;
    /** @type {{ matchId: string, id: string, createdAt: number }[]} */
    const entries = [];
    Object.keys(clipsMap).forEach((matchId) => {
      const list = clipsMap[matchId];
      if (!Array.isArray(list)) return;
      list.forEach((it) => {
        if (!it || typeof it !== 'object') return;
        const id = it.id != null ? String(it.id) : '';
        if (!id) return;
        const createdAt = this.resolveHighlightCreatedAt(/** @type {Record<string, unknown>} */(it));
        entries.push({ matchId, id, createdAt });
      });
    });
    if (entries.length === 0) {
      return 0;
    }
    const optMinKeep = Number(options.minKeepOverride);
    const minKeep = Number.isFinite(optMinKeep)
      ? Math.max(0, Math.floor(optMinKeep))
      : Math.max(0, Number(this.highlightsEmergencyMinKeepCount || 0));
    const removableBudget = Math.max(0, entries.length - minKeep);
    if (removableBudget <= 0) {
      this.appendHealthLog('live_prune_skipped_min_keep', {
        total: entries.length,
        minKeep,
        reason: why
      });
      return 0;
    }
    const targetRemove = Math.min(cap, removableBudget);
    entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    let removed = 0;
    for (let i = 0; i < entries.length && removed < targetRemove; i += 1) {
      const { matchId, id } = entries[i];
      const list = clipsMap[matchId];
      if (!Array.isArray(list)) continue;
      const idx = list.findIndex((x) => x && String(x.id) === id);
      if (idx < 0) continue;
      const item = list[idx];
      const toUnlink = new Set();
      (item.segments || []).forEach((p) => {
        if (p && typeof p === 'string') toUnlink.add(p);
      });
      if (item.replaySegment && typeof item.replaySegment === 'string') {
        toUnlink.add(item.replaySegment);
      }
      toUnlink.forEach((p) => {
        try {
          fs.unlinkSync(p);
        } catch (eUn) { }
      });
      list.splice(idx, 1);
      removed += 1;
    }
    if (removed > 0) {
      clipsStorage.writeClipsMapSafe(clipsMap);
      this.appendHealthLog('live_pruned_oldest_highlights', {
        removed,
        requested: cap,
        minKeep,
        totalBefore: entries.length,
        reason: why
      });
      try {
        if (typeof this.refreshDrawerHighlights === 'function') {
          this.refreshDrawerHighlights();
        }
      } catch (eR) { }
    }
    return removed;
  },

  /**
   * 移除「索引存在但视频文件已全部不可用」的高光（缺失或过小），优先于按时间删最旧。
   *
   * @param {string} [reason] 诊断日志
   * @returns {number} 删除条数
   */
  pruneHighlightClipsWithInvalidFiles: function (reason) {
    const why = typeof reason === 'string' ? reason : '';
    const fs = wx.getFileSystemManager();
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) return 0;
    /**
     * @param {string} p
     * @returns {boolean} true 表示不可播放
     */
    const isPathUnusable = (p) => {
      if (!p || typeof p !== 'string') return true;
      try {
        const st = fs.statSync(p);
        const sz = st && typeof st.size === 'number' ? st.size : 0;
        return sz < 64;
      } catch (eStat) {
        return true;
      }
    };
    /**
     * @param {Record<string, unknown>} it
     * @returns {boolean}
     */
    const itemIsDead = (it) => {
      if (!it || typeof it !== 'object') return false;
      /** @type {string[]} */
      const paths = [];
      const segs = it.segments;
      if (Array.isArray(segs)) {
        segs.forEach((seg) => {
          if (seg && typeof seg === 'string') paths.push(seg);
        });
      }
      const rp = it.replaySegment;
      if (rp && typeof rp === 'string') paths.push(rp);
      if (paths.length === 0) return true;
      return paths.every(isPathUnusable);
    };
    let removed = 0;
    Object.keys(clipsMap).forEach((matchId) => {
      const list = clipsMap[matchId];
      if (!Array.isArray(list)) return;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const it = list[i];
        if (!itemIsDead(it)) continue;
        const toUnlink = new Set();
        const segs2 = it.segments;
        if (Array.isArray(segs2)) {
          segs2.forEach((p) => {
            if (p && typeof p === 'string') toUnlink.add(p);
          });
        }
        if (it.replaySegment && typeof it.replaySegment === 'string') {
          toUnlink.add(it.replaySegment);
        }
        toUnlink.forEach((p) => {
          try {
            fs.unlinkSync(p);
          } catch (eUn) { }
        });
        list.splice(i, 1);
        removed += 1;
      }
    });
    if (removed > 0) {
      clipsStorage.writeClipsMapSafe(clipsMap);
      this.appendHealthLog('live_pruned_dead_highlights', { removed, reason: why });
      try {
        if (typeof this.refreshDrawerHighlights === 'function') {
          this.refreshDrawerHighlights();
        }
      } catch (eR) { }
    }
    return removed;
  },

  /**
   * 评估 Storage 水位并执行分级治理。
   * @returns {number}
   */
  evaluateStorageWatermark: function () {
    let ratio = 0;
    try {
      const info = wx.getStorageInfoSync();
      const current = Number(info && info.currentSize);
      const limit = Number(info && info.limitSize);
      if (Number.isFinite(current) && Number.isFinite(limit) && limit > 0) {
        ratio = current / limit;
      }
    } catch (e) { }
    let level = 0;
    if (ratio >= 0.95) level = 95;
    else if (ratio >= 0.85) level = 85;
    else if (ratio >= 0.7) level = 70;
    if (level !== this.storageWatermarkLevel) {
      this.storageWatermarkLevel = level;
      this.appendHealthLog('storage_watermark_change', { level, ratio: Number(ratio.toFixed(3)) });
    }
    // 95%：强制淘汰最旧高光实体，优先保直播
    if (level >= 95) {
      const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
      if (currentMatchId) this.pruneHighlightStorageForMatch(currentMatchId);
    }
    if (ratio >= 0.85) {
      try {
        const siPr = wx.getSystemInfoSync();
        if (siPr && siPr.platform === 'ios') {
          this.pruneIosSegmentBufferUserLocals(4);
        }
      } catch (ePr) { }
    }
    return level;
  },

  /**
   * MOD: rolling buffer 改为 temp 时间索引后，buffer 淘汰只 shift，不主动 unlink temp 文件。
   * @returns {void}
   */
  pruneIosSegmentBufferUserLocals: function () {
    return;
  },

  /**
   * 判断是否为小程序本地「文件存储」配额已满（与 KV storage 的 limitSize 不同）。
   * @param {string} errMsg 接口 fail 回调中的 errMsg
   * @returns {boolean}
   */
  isMiniProgramFileQuotaExceeded: function (errMsg) {
    if (!errMsg || typeof errMsg !== 'string') return false;
    const s = errMsg.toLowerCase();
    return (
      s.indexOf('storage limit') >= 0
      || s.indexOf('maximum size') >= 0
      || s.indexOf('file storage') >= 0
    );
  },

  /**
   * MOD: rolling buffer 改为 temp 时间索引后，buffer 淘汰只 shift，不主动 unlink temp 文件。
   * @returns {void}
   */
  trimRollingSegmentBufferForQuota: function () {
    return;
  },

  /**
   * 文件配额告警时尽量释放空间：淘汰 user-local 副本、rolling 热层最旧项、清理 _rolling 孤儿文件。
   * @param {string} [reason] 诊断用
   * @returns {void}
   */
  freeRollingFileStorageAggressive: function (reason) {
    const now = Date.now();
    const r = typeof reason === 'string' ? reason : '';
    const gapMs =
      r === 'persist_io_fail' || r === 'phase7_user_save_exhausted'
        ? 450
        : r === 'live_storage_severe_kickoff'
          ? 800
          : 2400;
    if (this._lastRollingAggressiveFreeAt && now - this._lastRollingAggressiveFreeAt < gapMs) {
      this.appendHealthLog('rolling_aggressive_free_throttled', {
        reason: r,
        sinceLastMs: now - this._lastRollingAggressiveFreeAt
      });
      return;
    }
    this._lastRollingAggressiveFreeAt = now;
    const fs = wx.getFileSystemManager();
    const rollingDir = this.getRollingDir();
    this.appendHealthLog('rolling_file_quota_emergency_free', { reason: r });
    this.pruneIosSegmentBufferUserLocals(2);
    this.trimRollingSegmentBufferForQuota(5);
    try {
      if (typeof fs.readdirSync === 'function') {
        let names = [];
        try {
          names = fs.readdirSync(rollingDir) || [];
        } catch (eRd0) {
          names = [];
        }
        const keep = new Set();
        (this.segmentBuffer || []).forEach((it) => {
          if (it && it.path) keep.add(it.path);
        });
        let n = 0;
        names.forEach((name) => {
          if (!name || String(name).indexOf('.mp4') < 0) return;
          const full = `${rollingDir}/${name}`;
          if (keep.has(full)) return;
          try {
            fs.unlinkSync(full);
            n += 1;
          } catch (eUn) { }
        });
        if (n > 0) {
          this.appendHealthLog('rolling_orphan_file_unlinked', { n });
        }
      }
    } catch (eR) { }
    let clipPrune = 0;
    if (r === 'persist_io_fail' || r === 'phase7_user_save_exhausted') {
      clipPrune = 4;
    }
    /**
     * 不在「入场 severe kickoff」自动删已保存高光：用户每次从首页进直播都会走 onLoad，
     * `_liveSevereKickoffPruneDone` 会重置，若此处 clipPrune=2 会反复每次少 2 条直到触及 minKeep。
     * 严重水位仅清理 rolling 临时层 + 孤儿文件；索引高光交给用户点「下载并清空」或 persist 真失败路径。
     */
    if (clipPrune > 0) {
      const deadRm = this.pruneHighlightClipsWithInvalidFiles(r + '_orphan_first');
      if (deadRm > 0) {
        this.appendHealthLog('rolling_clip_prune_dead_first', { removed: deadRm, reason: r });
      }
      const nowPr = Date.now();
      const emergencyPruneGapMs = 15 * 60 * 1000;
      if (
        this._lastEmergencyClipPruneAt
        && nowPr - this._lastEmergencyClipPruneAt < emergencyPruneGapMs
      ) {
        this.appendHealthLog('rolling_clip_prune_cooldown_skip', {
          reason: r,
          sinceLastMs: nowPr - this._lastEmergencyClipPruneAt
        });
        return;
      }
      const totalClips = this.getTotalHighlightClipCount();
      const minKeep = Math.max(0, Number(this.highlightsEmergencyMinKeepCount || 0));
      let minKeepForPrune = minKeep;
      if (totalClips <= minKeep) {
        const emergencyFloor = Math.max(4, Number(this.highlightsEmergencyHardFloor || 8));
        if (totalClips > emergencyFloor) {
          minKeepForPrune = emergencyFloor;
          this.appendHealthLog('rolling_clip_prune_break_min_keep', {
            reason: r,
            totalClips,
            minKeep,
            emergencyFloor
          });
        } else {
          this.appendHealthLog('rolling_clip_prune_min_keep_skip', {
            reason: r,
            totalClips,
            minKeep
          });
          this.activateFileQuotaCircuitBreaker('clip_prune_blocked_by_min_keep');
          return;
        }
      }
      this._lastEmergencyClipPruneAt = nowPr;
      const pr = this.pruneOldestHighlightClipsFromStorage(clipPrune, r, {
        minKeepOverride: minKeepForPrune
      });
      if (pr > 0) {
        this.appendHealthLog('rolling_clip_prune_with_quota_free', { pruned: pr, reason: r });
      }
    }
  },

  /**
   * 创建高光索引项（立即可回看，不依赖固化完成）。
   * @param {Record<string, unknown>} pending
   * @param {string[]} segments
   * @returns {Record<string, unknown>}
   */
  buildIndexedHighlightItem: function (pending, segments) {
    const replaySegment = segments[segments.length - 1] || segments[0] || '';
    const mc = this.data.matchConfig;
    const scoreA = mc && mc.teamA ? Number(mc.teamA.score || 0) : 0;
    const scoreB = mc && mc.teamB ? Number(mc.teamB.score || 0) : 0;
    const nameA = (mc && mc.teamA && mc.teamA.name) ? mc.teamA.name : 'A';
    const nameB = (mc && mc.teamB && mc.teamB.name) ? mc.teamB.name : 'B';
    const colorA = (mc && mc.teamA && mc.teamA.bgColor) ? mc.teamA.bgColor : '#E64340';
    const colorB = (mc && mc.teamB && mc.teamB.bgColor) ? mc.teamB.bgColor : '#10AEFF';
    return {
      id: pending.id,
      matchName: pending.matchName,
      matchId: pending.matchId,
      createdAt: pending.createdAt,
      timeText: this.formatTime(pending.createdAt),
      cover: pending.cover || this.data.defaultCover,
      segments: segments.slice(),
      replaySegment,
      replayInitialTimeSec: Number(pending.replayInitialTimeSec || 0),
      replayUseChain: !!pending.replayUseChain && segments.length >= 2,
      replayMediaStopAtSec:
        typeof pending.replayMediaStopAtSec === 'number' ? pending.replayMediaStopAtSec : null,
      replayChainPart2StopAtSec:
        typeof pending.replayChainPart2StopAtSec === 'number'
          ? pending.replayChainPart2StopAtSec
          : null,
      status: 'indexed',
      scoreA,
      scoreB,
      nameB,
      colorA,
      colorB,
      isVkTimeshift: !!pending.isVkTimeshift
    };
  },

  /**
   * 入队一个高光固化任务并触发后台执行。
   * @param {Record<string, unknown>} task
   * @returns {void}
   */
  enqueueHighlightMaterializeTask: function (task) {
    this.highlightMaterializeQueue.push(task);
    this.processHighlightMaterializeQueue();
  },

  /**
   * 后台串行执行高光固化队列（带降级暂停与退避）。
   * @returns {void}
   */
  processHighlightMaterializeQueue: function () {
    if (this.highlightMaterializeRunning) return;
    if (!this.highlightMaterializeQueue.length) return;
    const watermark = this.evaluateStorageWatermark();
    if (!this.canMaterializeHighlightNow() || watermark >= 85) {
      setTimeout(() => this.processHighlightMaterializeQueue(), 1200);
      return;
    }
    const task = this.highlightMaterializeQueue.shift();
    if (!task) return;
    this.highlightMaterializeRunning = true;
    this.materializeHighlightTask(task)
      .catch(() => Promise.resolve())
      .finally(() => {
        this.highlightMaterializeRunning = false;
        let gap = 0;
        if (this.data.isRecording) gap = Math.max(gap, 650);
        if (this.data.isRecording && (this.segmentCounter || 0) > 32) {
          gap = Math.max(gap, 840);
        }
        if (!this.data.drawerMode) gap = Math.max(gap, 320);
        setTimeout(() => this.processHighlightMaterializeQueue(), gap);
      });
  },

  /**
   * 执行单个高光固化任务：拷贝到高光目录并更新索引状态。
   * @param {Record<string, unknown>} task
   * @returns {Promise<void>}
   */
  materializeHighlightTask: function (task) {
    const segments = Array.isArray(task.segments) ? task.segments.filter(Boolean) : [];
    if (!segments.length || !task.id) {
      return Promise.resolve();
    }
    const coverTempPath = typeof task.coverTempPath === 'string' ? task.coverTempPath : '';
    const fs = wx.getFileSystemManager();
    const dir = this.getHighlightDir();
    /**
     * 真机稳定性优先：
     * - `wxfile://tmp_*` 视频在部分真机上 `fs.rename` 会直接 permission denied。
     * - 对临时录制文件优先使用 `saveFile(tempFilePath -> USER_DATA_PATH)`；
     * - 仅当源不是 temp 文件时才退回 `copyFile`。
     * @param {string} fromPath
     * @param {string} toPath
     * @param {(savedPath: string) => void} resolve
     * @returns {void}
     */
    const persistTempLikeFile = (fromPath, toPath, resolve) => {
      const src = typeof fromPath === 'string' ? fromPath : '';
      const dst = typeof toPath === 'string' ? toPath : '';
      if (!src || !dst) {
        resolve('');
        return;
      }
      const isTempLike =
        src.indexOf('wxfile://tmp_') === 0
        || src.indexOf(`${wx.env.USER_DATA_PATH}/tmp_`) === 0
        || src.indexOf('/tmp_') >= 0;
      const useCopyFallback = () => {
        if (!fs.copyFile) {
          resolve('');
          return;
        }
        fs.copyFile({
          srcPath: src,
          destPath: dst,
          success: () => resolve(dst),
          fail: () => resolve('')
        });
      };
      if (isTempLike) {
        fs.saveFile({
          tempFilePath: src,
          filePath: dst,
          success: (r) => resolve((r && r.savedFilePath) ? r.savedFilePath : dst),
          fail: useCopyFallback
        });
        return;
      }
      useCopyFallback();
    };
    const copyOne = (srcPath, idx) => new Promise((resolve) => {
      const filePath = `${dir}/${task.id}_${idx}.mp4`;

      const doMove = () => {
        const movePhysical = (fromPath) => {
          const cleanupOriginal = () => {
            if (fromPath !== srcPath) {
              try { fs.unlink({ filePath: srcPath }); } catch (e) { }
            }
          };
          const handleFail = () => {
            if (fromPath !== srcPath) {
              try { fs.unlink({ filePath: fromPath }); } catch (e) { }
            }
            resolve('');
          };

          persistTempLikeFile(fromPath, filePath, (savedPath) => {
            if (!savedPath) {
              handleFail();
              return;
            }
            cleanupOriginal();
            resolve(savedPath);
          });
        };

        if (task.isVkTimeshift) {
          // 不再尝试 MediaContainer 裁切，直接保存原文件以保障极度稳定性
          movePhysical(srcPath);
        } else {
          movePhysical(srcPath);
        }
      };

      const checkSrc = () => {
        fs.getFileInfo({
          filePath: srcPath,
          success: (resSrc) => {
            if (resSrc && resSrc.size > 1024) {
              doMove();
            } else {
              resolve(''); // Size too small, trigger retry
            }
          },
          fail: () => resolve('') // Not found, trigger retry
        });
      };

      fs.getFileInfo({
        filePath: filePath,
        success: (resDest) => {
          if (resDest && resDest.size > 1024) {
            resolve(filePath); // Already moved successfully in a previous attempt
          } else {
            checkSrc();
          }
        },
        fail: checkSrc
      });
    });
    return this.ensureHighlightDir()
      .then(() => Promise.all(segments.map((p, i) => copyOne(p, i))))
      .then((saved) => {
        const savedPaths = saved.filter(Boolean);
        const matchId = clipsStorage.normalizeMatchIdKey(task.matchId);
        if (!matchId) return;
        const clipsMap = clipsStorage.readClipsMapSafe();
        if (!clipsMap) {
          this.appendHealthLog('highlight_materialize_clips_read_fail', { id: task.id });
          return;
        }
        const list = Array.isArray(clipsMap[matchId]) ? clipsMap[matchId] : [];
        const idx = list.findIndex((it) => it && String(it.id) === String(task.id));
        /**
         * VK 等场景封面为临时 jpg，与视频一并拷入高光目录，避免 temp 回收后首页缩略图失效。
         * @param {string} coverDest
         * @returns {void}
         */
        const applyClipUpdate = (coverDest) => {
          if (idx < 0) return;
          if (savedPaths.length === segments.length) {
            const replaySegment = savedPaths[savedPaths.length - 1] || savedPaths[0] || '';
            list[idx].segments = savedPaths;
            list[idx].replaySegment = replaySegment;
            list[idx].status = 'materialized';
            if (coverDest) {
              list[idx].cover = coverDest;
            }
          } else {
            list[idx].status = 'failed';
          }
          clipsMap[matchId] = list;
          if (!clipsStorage.writeClipsMapSafe(clipsMap)) {
            this.appendHealthLog('highlight_materialize_clips_write_fail', { id: task.id });
          }
        };
        if (savedPaths.length === segments.length && coverTempPath) {
          const coverDest = `${dir}/${task.id}_cover.jpg`;
          persistTempLikeFile(coverTempPath, coverDest, (savedPath) => {
            applyClipUpdate(savedPath || '');
          });
        } else {
          applyClipUpdate('');
        }
        if (savedPaths.length !== segments.length) {
          const retryCount = Number(task.retryCount || 0);
          if (retryCount < 3) {
            const next = { ...task, retryCount: retryCount + 1 };
            const delays = [300, 800, 1500, 3000];
            const delay = delays[next.retryCount] || 3000;
            setTimeout(() => {
              this.highlightMaterializeQueue.unshift(next);
              this.processHighlightMaterializeQueue();
            }, delay);
            return;
          }
        }
        this.releaseRollingSegmentsByPaths(segments);
      })
      .catch(() => {
        const retryCount = Number(task.retryCount || 0);
        if (retryCount < 3) {
          const next = { ...task, retryCount: retryCount + 1 };
          const delays = [300, 800, 1500, 3000];
          const delay = delays[next.retryCount] || 3000;
          setTimeout(() => {
            this.highlightMaterializeQueue.unshift(next);
            this.processHighlightMaterializeQueue();
          }, delay);
        } else {
          this.releaseRollingSegmentsByPaths(segments);
        }
        return Promise.resolve();
      });
  },

  /**
   * 停止 VK 画布 MediaRecorder 并解除管线 hook（页面切换 / 管线销毁 / 降级时调用）。
   * @param {string} [reason]
   * @returns {void}
   */
  _cleanupVkCanvasHighlightRecording: function (reason) {
    if (this._vkHighlightFpsTimer) {
      clearInterval(this._vkHighlightFpsTimer);
      this._vkHighlightFpsTimer = null;
    }
    if (this._vkTimeshiftRotateTimer) {
      clearTimeout(this._vkTimeshiftRotateTimer);
      this._vkTimeshiftRotateTimer = null;
    }
    if (this._vkHighlightStopTimer) {
      clearTimeout(this._vkHighlightStopTimer);
      this._vkHighlightStopTimer = null;
    }
    if (this._renderPipeline && typeof this._renderPipeline.setVkRecordingHook === 'function') {
      try {
        this._renderPipeline.setVkRecordingHook(null);
      } catch (eH) { }
    }
    var rec = this._vkCanvasRecorder;
    this._vkCanvasRecorder = null;
    this._vkTimeshiftStartAt = 0;
    if (rec && typeof rec.destroy === 'function') {
      try {
        rec.destroy();
      } catch (eD) { }
    }
    if (reason) {
      try {
        this.appendHealthLog('vk_canvas_highlight_cleanup', { reason: reason });
      } catch (eL) { }
    }
  },

  /**
   * VK 模式时移缓冲：持续录制已锐化画布，点击高光时立即 stop 取过去窗口。
   * @param {{ keepSavingState?: boolean }} [opts]
   * @returns {void}
   */
  _ensureVkTimeshiftRecorder: function (opts) {
    var keepSavingState = !!(opts && opts.keepSavingState);
    var self = this;
    if (this._vkCanvasRecorder) return;
    var recorder = vkCanvasRecorderMod.createVkCanvasRecorder();
    if (!recorder.isApiSupported()) {
      if (!keepSavingState) this.endHighlightSaving();
      return;
    }
    var pipeline = this._renderPipeline;
    if (!pipeline || typeof pipeline.getCanvasNode !== 'function') {
      if (!keepSavingState) this.endHighlightSaving();
      return;
    }
    var canvasNode = pipeline.getCanvasNode();
    if (!canvasNode || !canvasNode.width || !canvasNode.height) {
      if (!keepSavingState) this.endHighlightSaving();
      return;
    }
    this._cleanupVkCanvasHighlightRecording('vk_timeshift_restart');
    this._vkCanvasRecorder = recorder;
    this._vkTimeshiftStartAt = Date.now();
    var longEdge = Math.max(Number(canvasNode.width) || 0, Number(canvasNode.height) || 0);
    var videoBitsPerSecond = 2200;
    if (longEdge >= 1600) {
      videoBitsPerSecond = 4200;
    } else if (longEdge >= 1200) {
      videoBitsPerSecond = 3200;
    } else if (longEdge >= 900) {
      videoBitsPerSecond = 2600;
    }
    var rotateAfterMs = 85000;
    var durationSec = 100;
    recorder
      .start(canvasNode, {
        durationSec: durationSec,
        fps: 24,
        videoBitsPerSecond: videoBitsPerSecond
      })
      .then(function () {
        if (self._vkCanvasRecorder !== recorder) {
          try { recorder.destroy(); } catch (e0) { }
          return;
        }
        pipeline.setVkRecordingHook(function () {
          return recorder.beforeDraw();
        });
        self._vkHighlightFpsTimer = setInterval(function () {
          var snap = pipeline.snapshot();
          if (snap && recorder) {
            recorder.noteRenderFps(snap.avgFps);
          }
        }, 1000);
        self._vkTimeshiftRotateTimer = setTimeout(function () {
          self._vkTimeshiftRotateTimer = null;
          if (!self._livePageVisible || self.data.enhanceMode !== 'vk') return;
          self._cleanupVkCanvasHighlightRecording('vk_timeshift_rotate');
          self._ensureVkTimeshiftRecorder({ keepSavingState: true });
        }, rotateAfterMs);
      })
      .catch(function () {
        self._cleanupVkCanvasHighlightRecording('vk_timeshift_start_fail');
        if (!keepSavingState) self.endHighlightSaving();
      });
  },

  /**
   * VK 模式：点击时立即截取当前时移缓冲，保存最近窗口（默认约 8s）。
   * @param {{id:string,now:number,createdAt:number,matchName:string,matchId:string,cover:string}} meta
   * @returns {void}
   */
  _requestVkCanvasHighlightCapture: function (meta) {
    if (!this._vkCanvasRecorder) {
      this._ensureVkTimeshiftRecorder({ keepSavingState: true });
      setTimeout(() => {
        if (!this.data.isSavingHighlight) return;
        if (!this._vkCanvasRecorder) {
          this.endHighlightSaving();
          return;
        }
        this._requestVkCanvasHighlightCapture(meta);
      }, 160);
      return;
    }
    var recorder = this._vkCanvasRecorder;
    this._finalizeVkCanvasHighlightMeta(meta, recorder, {
      clickWallMs: meta && typeof meta.now === 'number' ? meta.now : Date.now(),
      keepTimeshiftAfterFinalize: true
    });
  },

  /**
   * VK 画布录制结束：stop MediaRecorder → temp 路径走既有 finalizeHighlight。
   * @param {{id:string,createdAt:number,matchName:string,matchId:string,cover:string}} meta
   * @param {{stop:function():Promise,destroy:function():void}} recorder
   * @param {{clickWallMs?:number,keepTimeshiftAfterFinalize?:boolean}} [opts]
   * @returns {void}
   */
  _finalizeVkCanvasHighlightMeta: function (meta, recorder, opts) {
    var self = this;
    var clickWallMs = opts && typeof opts.clickWallMs === 'number' ? opts.clickWallMs : Date.now();
    var keepTimeshiftAfterFinalize = !!(opts && opts.keepTimeshiftAfterFinalize);
    var elapsedMs = Math.max(0, clickWallMs - (this._vkTimeshiftStartAt || clickWallMs));
    if (this._vkHighlightStopTimer) {
      clearTimeout(this._vkHighlightStopTimer);
      this._vkHighlightStopTimer = null;
    }
    if (this._vkHighlightFpsTimer) {
      clearInterval(this._vkHighlightFpsTimer);
      this._vkHighlightFpsTimer = null;
    }
    if (this._renderPipeline && typeof this._renderPipeline.setVkRecordingHook === 'function') {
      try {
        this._renderPipeline.setVkRecordingHook(null);
      } catch (eH) { }
    }
    this._vkCanvasRecorder = null;
    this._vkTimeshiftStartAt = 0;
    var r = recorder;
    if (!r || typeof r.stop !== 'function') {
      this.endHighlightSaving();
      if (keepTimeshiftAfterFinalize && this.data.enhanceMode === 'vk' && this._livePageVisible) {
        this._ensureVkTimeshiftRecorder({ keepSavingState: true });
      }
      return;
    }
    /**
     * stop 前再截一帧作封面：录制末帧画面已稳定；依赖 VK WebGL preserveDrawingBuffer，否则仍为黑图。
     * @returns {void}
     */
    var vkStopOnce = false;
    var runStopAndFinalize = function () {
      if (vkStopOnce) return;
      vkStopOnce = true;
      r.stop()
        .then(function (res) {
          var path = res && res.tempFilePath ? String(res.tempFilePath) : '';
          try {
            if (r.destroy) r.destroy();
          } catch (e2) { }
          if (!path) {
            wx.showToast({ title: '高光导出失败', icon: 'none' });
            self.endHighlightSaving();
            return;
          }
          var plan = self.buildVkTailHighlightPlan(self);

          if (!isFinite(plan.startTimeSec) || !isFinite(plan.durationSec)) {
            console.warn('[VK] invalid highlight plan, fallback');
            plan.startTimeSec = 0;
            plan.durationSec = 5;
          }

          self.finalizeHighlight({
            id: meta.id,
            createdAt: meta.createdAt,
            matchName: meta.matchName,
            matchId: meta.matchId,
            cover: meta.cover || self.data.defaultCover,
            finalizing: false,
            preSegments: [path],
            postSegments: [],
            replayInitialTimeSec: plan.startTimeSec,
            replayUseChain: false,
            replayMediaStopAtSec: plan.startTimeSec + plan.durationSec,
            replayChainPart2StopAtSec: null,
            isVkTimeshift: true
          });

          if (keepTimeshiftAfterFinalize && self.data.enhanceMode === 'vk' && self._livePageVisible) {
            self._ensureVkTimeshiftRecorder({ keepSavingState: true });
          }
        })
        .catch(function (err) {
          try {
            if (r.destroy) r.destroy();
          } catch (e3) { }
          wx.showToast({ title: '高光导出失败', icon: 'none' });
          self.appendHealthLog('vk_canvas_highlight_stop_fail', {
            err: (err && err.message) || String(err)
          });
          self.endHighlightSaving();
          if (keepTimeshiftAfterFinalize && self.data.enhanceMode === 'vk' && self._livePageVisible) {
            self._ensureVkTimeshiftRecorder({ keepSavingState: true });
          }
        });
    };
    var pipeFin = self._renderPipeline;
    var nodeFin =
      pipeFin && typeof pipeFin.getCanvasNode === 'function' ? pipeFin.getCanvasNode() : null;
    if (nodeFin && typeof wx.canvasToTempFilePath === 'function') {
      var dwF = nodeFin.width;
      var dhF = nodeFin.height;
      if (dwF > 480 || dhF > 480) {
        var sF = 480 / Math.max(dwF, dhF);
        dwF = Math.max(160, Math.round(dwF * sF));
        dhF = Math.max(90, Math.round(dhF * sF));
      }
      try {
        // 延迟 32ms (约 1 帧) 确保 WebGL 缓冲内容已刷新，减少黑图概率
        setTimeout(function () {
          wx.canvasToTempFilePath(
            {
              canvas: nodeFin,
              destWidth: dwF,
              destHeight: dhF,
              fileType: 'jpg',
              quality: 0.88,
              success: function (res) {
                if (res && res.tempFilePath) {
                  meta.cover = res.tempFilePath;
                }
              },
              fail: function () {
                runStopAndFinalize();
              },
              complete: function () {
                runStopAndFinalize();
              }
            },
            self
          );
        }, 32);
      } catch (eTf) {
        runStopAndFinalize();
      }
    } else {
      runStopAndFinalize();
    }
  },

  /**
   * 单文件画布高光回放计划（整段播放）。
   * @param {string} tempPath
   * @param {number} [elapsedSec]
   * @returns {{
   *   preSegments: string[],
   *   replayInitialTimeSec: number,
   *   replayUseChain: boolean,
   *   replayMediaStopAtSec: null,
   *   replayChainPart2StopAtSec: null
   * }}
   */
  buildVkCanvasHighlightPlan: function (tempPath, elapsedSec) {
    var elapsed = typeof elapsedSec === 'number' && isFinite(elapsedSec)
      ? Math.max(0, elapsedSec)
      : 0;
    var winSec = (this.highlightPlaybackWindowMs || 8000) / 1000;
    var startSec = Math.max(0, elapsed - winSec);
    var stopSec = elapsed > 0.05 ? elapsed : null;
    return {
      preSegments: [tempPath],
      replayInitialTimeSec: startSec,
      replayUseChain: false,
      replayMediaStopAtSec: stopSec,
      replayChainPart2StopAtSec: null
    };
  },

  /**
   * MOD: 点击高光只记录时间窗口和索引元数据，不 stopRecord、不复制文件。
   * @param {Record<string, unknown>} [meta]
   * @returns {void}
   */
  onHighlightClick: function (meta) {
    const m = meta && typeof meta === 'object' ? meta : {};
    if (this._recorderCore) {
      return this._recorderCore.setPendingHighlight(m);
    }
    const now = Date.now();
    this.pendingHighlight = {
      clickTime: now,
      startTime: now - (this.highlightLeadMs || 8000),
      endTime: now,
      id: m.id || String(now),
      createdAt: now,
      matchName: m.matchName || (this.data.matchConfig && this.data.matchConfig.matchName) || '未命名比赛',
      matchId: m.matchId || this.resolveMatchIdForHighlightStorage(),
      cover: m.cover || this.data.defaultCover
    };
  },

  /**
   * MOD: 安全时机调度高光生成。
   * 过去 8s 模式下，只要“包含 clickTime 的当前段”已经 stop+flush 完成并入 rolling buffer，
   * 就可以生成高光；不再等待未来片段。
   * @returns {void}
   */
  _tryGenerateHighlight: function () {
    if (this._recorderCore) {
      return this._recorderCore.maybeGenerateHighlight();
    }
    if (!this.pendingHighlight) return;
    const pending = this.pendingHighlight;
    const { startTime, endTime } = pending;
    const covered = (this.rollingSegments || []).some((seg) =>
      seg && seg.startTime <= endTime && seg.endTime >= endTime
    );
    if (!covered) return;
    this._generateHighlight(startTime, endTime, pending);
    this.pendingHighlight = null;
  },

  /**
   * MOD: 按时间区间匹配素材段，并计算未来精确裁剪所需 offset。
   * @param {number} startTime
   * @param {number} endTime
   * @param {Record<string, unknown>} [pending]
   * @returns {void}
   */
  _generateHighlight: function (startTime, endTime, pending) {
    const segments = (this.rollingSegments || []).filter((seg) =>
      seg && seg.path && seg.endTime > startTime && seg.startTime < endTime
    );
    const parts = segments.map((seg) => {
      const clipStart = Math.max(startTime, seg.startTime);
      const clipEnd = Math.min(endTime, seg.endTime);
      return {
        path: seg.path,
        offsetStart: clipStart - seg.startTime,
        offsetEnd: clipEnd - seg.startTime
      };
    });
    this._composeClip(parts, pending);
  },

  /**
   * MOD: 第一阶段稳定策略：不做精确裁剪，直接按时间命中的源文件组成回放链。
   * @param {{path:string,offsetStart:number,offsetEnd:number}[]} parts
   * @param {Record<string, unknown>} [pending]
   * @returns {void}
   */
  _composeClip: function (parts, pending) {
    const paths = (Array.isArray(parts) ? parts : []).map((p) => p && p.path).filter(Boolean);
    this._saveHighlight(paths, pending, parts);
  },

  /**
   * MOD: 保存高光索引；只有这里进入高光持久化队列。
   * @param {string[]} paths
   * @param {Record<string, unknown>} [pending]
   * @param {{path:string,offsetStart:number,offsetEnd:number}[]} [parts]
   * @returns {void}
   */
  _saveHighlight: function (paths, pending, parts) {
    const p = pending || this.pendingHighlight || {};
    if (!Array.isArray(paths) || paths.length === 0) {
      this.appendHealthLog('highlight_finalize_no_segments', {});
      this.pendingHighlight = null;
      this.endHighlightSaving();
      return;
    }
    const firstPart = Array.isArray(parts) && parts.length ? parts[0] : null;
    const lastPart = Array.isArray(parts) && parts.length ? parts[parts.length - 1] : null;
    const replayInitialTimeSec = firstPart ? Math.max(0, firstPart.offsetStart / 1000) : 0;
    const replayMediaStopAtSec = paths.length === 1 && lastPart
      ? Math.max(0.08, lastPart.offsetEnd / 1000)
      : null;
    const replayChainPart2StopAtSec = paths.length >= 2 && lastPart
      ? Math.max(0.08, lastPart.offsetEnd / 1000)
      : null;
    this.finalizeHighlight({
      id: p.id || String(Date.now()),
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : (p.clickTime || Date.now()),
      matchName: p.matchName || '未命名比赛',
      matchId: p.matchId || this.resolveMatchIdForHighlightStorage(),
      cover: p.cover || this.data.defaultCover,
      finalizing: false,
      preSegments: paths,
      postSegments: [],
      replayInitialTimeSec,
      replayUseChain: paths.length >= 2,
      replayMediaStopAtSec,
      replayChainPart2StopAtSec
    });
  },

  /**
   * 保存高光：由右下角状态钮在管线为「录制中」（界面显示 REC）时单击触发。
   * MOD: 点击时只记录时间点，不打断 rolling，也不等待/选择 segment index。
   */
  requestHighlightCapture: function () {
    if (this._highlightRequestLock || this.data.isSavingHighlight || this.pendingHighlight) {
      this.appendHealthLog('highlight_request_ignored', {
        reason: this._highlightRequestLock
          ? 'request_lock'
          : this.data.isSavingHighlight
            ? 'saving_highlight'
            : 'pending_highlight'
      });
      return;
    }
    if (this.data.storageSevereLock) {
      this._showLightHint('请先清理空间');
      try {
        this.appendHealthLog('highlight_skip_storage_severe', {});
      } catch (e) { }
      return;
    }
    const vkHighlight = this.data.enhanceMode === 'vk';
    if (this.data.isRecovering || this._recoveryLock || (!vkHighlight && !this._cameraInitDone)) {
      this.appendHealthLog('highlight_skip_camera_not_ready', { vk: vkHighlight });
      return;
    }
    if (this.data.drawerMode > 0) {
      wx.showToast({ title: '请先关闭抽屉再保存高光', icon: 'none' });
      return;
    }
    if (this.data.isReplaying) {
      wx.showToast({ title: '回放中无法保存高光', icon: 'none' });
      return;
    }

    const currentMatchId = this.resolveMatchIdForHighlightStorage();
    if (!currentMatchId) {
      this.appendHealthLog('highlight_abort_no_match_id', {});
      wx.showToast({
        title: '无法识别比赛场次，请返回首页从赛程卡片进入',
        icon: 'none',
        duration: 2800
      });
      return;
    }

    const now = Date.now();
    const anchorClickTime =
      this.data.isRecording
        ? now
        : Math.max(0, Number(this.lastSegmentAt || now));
    const matchName = this.data.matchConfig.matchName || '未命名比赛';
    const id = String(now);
    if (vkHighlight) {
      this.beginHighlightSaving();
      this.vibrate('heavy');
      this.lastHighlightRequestAt = now;
      this._requestVkCanvasHighlightCapture({
        id: id,
        now: now,
        createdAt: now,
        matchName: matchName,
        matchId: currentMatchId,
        cover: this.data.defaultCover
      });
      return;
    }

    this.beginHighlightSaving();
    this.appendHealthLog('highlight_request', {
      anchorClickTime,
      now,
      isRecording: !!this.data.isRecording,
      recorderState: this._recorderCore ? this._recorderCore.state : '',
      rollingActive: !!this.rollingActive
    });
    this.onHighlightClick({
      id,
      matchName,
      matchId: currentMatchId,
      cover: this.data.defaultCover,
      clickTime: anchorClickTime
    });
    this.tryStartRollingWhenCameraReady('highlight_request');
    this.vibrate('heavy');
    this.lastHighlightRequestAt = this.pendingHighlight.clickTime;
    const recordStartAt = Number(this.lastRecordStartAt || 0);
    const expectedFlushAt =
      recordStartAt > 0
        ? Math.max(
          this.pendingHighlight.clickTime + 120,
          recordStartAt + (this.segmentDurationMs || 8000)
        )
        : this.pendingHighlight.clickTime + HIGHLIGHT_LOCK_TIMEOUT;
    this.startHighlightSaveProgressAnim(
      this.pendingHighlight.clickTime,
      expectedFlushAt
    );
    this.appendHealthLog('highlight_click_time_marked', {
      clickTime: this.pendingHighlight.clickTime,
      startTime: this.pendingHighlight.startTime,
      endTime: this.pendingHighlight.endTime
    });
    this._tryGenerateHighlight();
  },

  finalizeHighlight: function (pending) {
    if (!pending || pending.finalizing) return;
    pending.finalizing = true;
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }
    const segments = [...pending.preSegments, ...pending.postSegments].filter(Boolean);
    if (segments.length > 0 && this._highlightResumeGuardTimer) {
      clearTimeout(this._highlightResumeGuardTimer);
      this._highlightResumeGuardTimer = null;
    }
    if (segments.length === 0) {
      this.appendHealthLog('highlight_finalize_no_segments', {});
      if (this._highlightSaveAwaitingResume) {
        this._highlightPipelineDoneFinalize = true;
        this.maybeReleaseHighlightSaveLock();
        if (this._highlightSaveAwaitingResume) {
          this.scheduleHighlightResumeUnlockFallback();
        }
      } else {
        this.endHighlightSaving();
      }
      return;
    }
    let matchId = clipsStorage.normalizeMatchIdKey(pending.matchId);
    if (!matchId) matchId = this.resolveMatchIdForHighlightStorage();
    if (!matchId) {
      pending.finalizing = false;
      this.appendHealthLog('highlight_finalize_missing_match_id', {});
      wx.showToast({ title: '无法识别场次，高光未保存', icon: 'none' });
      if (this._highlightSaveAwaitingResume) {
        this._highlightPipelineDoneFinalize = true;
        this.maybeReleaseHighlightSaveLock();
        if (this._highlightSaveAwaitingResume) {
          this.scheduleHighlightResumeUnlockFallback();
        }
      } else {
        this.endHighlightSaving();
      }
      return;
    }
    const item = this.buildIndexedHighlightItem(pending, segments);
    item.matchId = matchId;
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) {
      pending.finalizing = false;
      this.appendHealthLog('highlight_clips_corrupt_read', {});
      wx.showToast({ title: '高光索引读取失败，请稍后再试', icon: 'none' });
      if (this._highlightSaveAwaitingResume) {
        this._highlightPipelineDoneFinalize = true;
        this.maybeReleaseHighlightSaveLock();
        if (this._highlightSaveAwaitingResume) {
          this.scheduleHighlightResumeUnlockFallback();
        }
      } else {
        this.endHighlightSaving();
      }
      return;
    }
    if (!clipsMap[matchId]) clipsMap[matchId] = [];
    clipsMap[matchId].unshift(item);
    if (!clipsStorage.writeClipsMapSafe(clipsMap)) {
      pending.finalizing = false;
      this.appendHealthLog('highlight_clips_write_fail', {});
      wx.showToast({ title: '存储空间不足，高光未保存', icon: 'none' });
      if (this._highlightSaveAwaitingResume) {
        this._highlightPipelineDoneFinalize = true;
        this.maybeReleaseHighlightSaveLock();
        if (this._highlightSaveAwaitingResume) {
          this.scheduleHighlightResumeUnlockFallback();
        }
      } else {
        this.endHighlightSaving();
      }
      return;
    }
    this.pruneHighlightStorageForMatch(matchId);
    this._enforceHighlightStorageLimit();
    const list = this.getHighlightList();
    list.unshift(item);
    wx.setStorageSync('highlight_list', list);
    this.retainRollingSegmentsByPaths(segments);
    const dcFin = this.data.defaultCover;
    const coverRaw = typeof pending.cover === 'string' ? pending.cover : dcFin;
    const coverTempPath =
      coverRaw !== dcFin && coverRaw.indexOf('data:') !== 0 ? coverRaw : '';
    this.enqueueHighlightMaterializeTask({
      id: pending.id,
      matchId,
      segments: segments.slice(),
      coverTempPath: coverTempPath,
      retryCount: 0
    });
    this.highlightMissStreak = 0;
    this.vibrateHighlightSaved();
    this.flashPeriod();
    if (this.data.drawerMode === 1) {
      this.refreshDrawerHighlights();
    }
    if (this._highlightSaveAwaitingResume) {
      this._highlightPipelineDoneFinalize = true;
      this.maybeReleaseHighlightSaveLock();
      if (this._highlightSaveAwaitingResume) {
        this.scheduleHighlightResumeUnlockFallback();
      }
    } else {
      this.endHighlightSaving();
    }
  },

  formatTime: function (ts) {
    const d = new Date(ts);
    const pad = (n) => `${n}`.padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  },

  getHighlightList: function (matchId) {
    if (matchId) {
      const clipsMap = clipsStorage.readClipsMapSafe();
      if (!clipsMap) return [];
      const key = clipsStorage.normalizeMatchIdKey(matchId);
      return Array.isArray(clipsMap[key]) ? clipsMap[key] : [];
    }
    const raw = wx.getStorageSync('highlight_list');
    return Array.isArray(raw) ? raw : [];
  },

  onBackgroundLongPress: function () {
    if (this.isMultiTouch) return;
    this.openDrawerMode1();
  },

  _syncVkAdaptiveDebugConfigToPipeline: function () {
    var patch = {
      enable: true,
      overrideAmount: this.data.vkDebugAmount,
      overrideTone: this.data.vkDebugTone,
      overrideMotion: this.data.vkDebugMotion,
      freezeAuto: !!this.data.vkDebugFreezeAuto
    };
    try {
      renderPipelineMod.debugConfig.enable = patch.enable;
      renderPipelineMod.debugConfig.overrideAmount = patch.overrideAmount;
      renderPipelineMod.debugConfig.overrideTone = patch.overrideTone;
      renderPipelineMod.debugConfig.overrideMotion = patch.overrideMotion;
      renderPipelineMod.debugConfig.freezeAuto = patch.freezeAuto;
    } catch (e0) { }
    if (this._renderPipeline && typeof this._renderPipeline.setVkAdaptiveDebugConfig === 'function') {
      try {
        this._renderPipeline.setVkAdaptiveDebugConfig(patch);
      } catch (e1) { }
    }
  },

  _toggleVkDebugPanel: function () {
    var nextVisible = !this.data.vkDebugPanelVisible;
    this.setData({ vkDebugPanelVisible: nextVisible });
    if (nextVisible) {
      this._syncVkAdaptiveDebugConfigToPipeline();
    }
  },

  _bindVkDebugHotkey: function () {
    if (this._vkDebugHotkeyHandler) return;
    if (typeof document === 'undefined' || !document || !document.addEventListener) return;
    var self = this;
    this._vkDebugHotkeyHandler = function (evt) {
      if (!evt) return;
      var key = String(evt.key || '').toLowerCase();
      if (!(evt.ctrlKey || evt.metaKey) || key !== 'd') return;
      if (evt.preventDefault) evt.preventDefault();
      self._toggleVkDebugPanel();
    };
    document.addEventListener('keydown', this._vkDebugHotkeyHandler, true);
  },

  _unbindVkDebugHotkey: function () {
    if (!this._vkDebugHotkeyHandler) return;
    if (typeof document !== 'undefined' && document && document.removeEventListener) {
      try {
        document.removeEventListener('keydown', this._vkDebugHotkeyHandler, true);
      } catch (e) { }
    }
    this._vkDebugHotkeyHandler = null;
  },

  onVkDebugToolbarLongPress: function () {
    this._toggleVkDebugPanel();
  },

  onVkDebugAmountChanging: function (e) {
    var v = Number(e && e.detail ? e.detail.value : 58);
    if (!isFinite(v)) v = 58;
    var amount = Math.max(35, Math.min(70, v)) / 100;
    this.setData({ vkDebugAmount: amount, vkDebugAmountPct: Math.round(amount * 100) });
    this._syncVkAdaptiveDebugConfigToPipeline();
  },

  onVkDebugToneChanging: function (e) {
    var v = Number(e && e.detail ? e.detail.value : 95);
    if (!isFinite(v)) v = 95;
    var tone = Math.max(50, Math.min(120, v)) / 100;
    this.setData({ vkDebugTone: tone, vkDebugTonePct: Math.round(tone * 100) });
    this._syncVkAdaptiveDebugConfigToPipeline();
  },

  onVkDebugMotionChanging: function (e) {
    var v = Number(e && e.detail ? e.detail.value : 72);
    if (!isFinite(v)) v = 72;
    var motion = Math.max(20, Math.min(100, v)) / 100;
    this.setData({ vkDebugMotion: motion, vkDebugMotionPct: Math.round(motion * 100) });
    this._syncVkAdaptiveDebugConfigToPipeline();
  },

  onVkDebugFreezeAutoChange: function (e) {
    var checked = !!(e && e.detail ? e.detail.value : false);
    this.setData({ vkDebugFreezeAuto: checked });
    this._syncVkAdaptiveDebugConfigToPipeline();
  },

  /**
   * 调试工具条点击切档：
   *  - 机型未通过白名单直接忽略（不应出现，但防御）。
   *  - 用户显式切档走 force，穿透 render-pipeline 的 MIN_SWITCH_GAP_MS 防抖。
   *  - 切档后记录健康日志，便于真机对比时回溯。
   * @param {WechatMiniprogram.TouchEvent} e data-mode: off|standard|strong
   */
  onEnhanceModePick: function (e) {
    if (!this.data.enhanceWhitelisted) return;
    if (this.data.recorderDegradedMode) {
      wx.showToast({ title: '当前为稳定优先模式', icon: 'none', duration: 1600 });
      return;
    }
    if (this.data.enhanceVkTransitioning) return;
    if (Date.now() < (this._enhanceModeSwitchGuardUntil || 0)) {
      try {
        wx.showToast({ title: '相机切换中，请稍候', icon: 'none', duration: 1200 });
      } catch (eG) { }
      return;
    }
    var mode = e && e.currentTarget && e.currentTarget.dataset
      ? e.currentTarget.dataset.mode
      : null;
    /** 界面展示「超频」时 data-mode 仍须为 vk；若误写为中文，映射回内部档位 */
    if (mode === '超频') mode = 'vk';
    var allowed = ['off', 'lite', 'standard', 'strong', 'vk'];
    if (allowed.indexOf(mode) < 0) return;

    // 进入 / 离开 VK 走专用 orchestrator（涉及 rolling 停起 + camera 重建）
    if (mode === 'vk') {
      if (!this.data.enhanceVkSupported) {
        wx.showToast({ title: '本机不支持超频模式', icon: 'none', duration: 2000 });
        return;
      }
      if (this.data.enhanceMode === 'vk') return;
      this.appendHealthLog('enhance_mode_manual_pick', { mode: 'vk', orchestrator: 'in' });
      this._orchestrateSwitchToVk();
      try { wx.vibrateShort({ type: 'light' }); } catch (eV1) { }
      return;
    }
    if (this.data.enhanceMode === 'vk') {
      this.appendHealthLog('enhance_mode_manual_pick', { mode: mode, orchestrator: 'out' });
      this._orchestrateSwitchFromVk(mode);
    } else if (typeof this.setEnhanceMode === 'function') {
      this.appendHealthLog('enhance_mode_manual_pick', { mode: mode, fromDrawer: true });
      this.setEnhanceMode(mode);
      /**
       * 多次互切后偶现「canvas 盖在画面上但 framesRendered=0」：关闭可用（不盖 canvas），其它档黑屏。
       * 延迟检测后 teardown + 重建并恢复所选档位（仅原生家族）。
       */
      if (mode !== 'off') {
        var self = this;
        var picked = mode;
        if (this._enhanceZeroFrameRecoverTimer) {
          clearTimeout(this._enhanceZeroFrameRecoverTimer);
          this._enhanceZeroFrameRecoverTimer = null;
        }
        this._enhanceZeroFrameRecoverTimer = setTimeout(function () {
          self._enhanceZeroFrameRecoverTimer = null;
          if (self.data.enhanceMode === 'vk') return;
          if (self.data.enhanceMode !== picked) return;
          if (!self._renderPipeline || !self.data.cameraMounted || !self.data.cameraContext) return;
          var d = typeof self._renderPipeline.diagnostics === 'function'
            ? self._renderPipeline.diagnostics()
            : null;
          if (!d || d.framesRendered > 0) return;
          self.appendHealthLog('enhance_native_zero_frames_recover', { mode: picked, diag: d });
          self._pendingEnhanceModeAfterRecover = picked;
          self._teardownEnhanceRender();
          if (wx.nextTick) {
            wx.nextTick(function () {
              if (!self.data.cameraContext) return;
              self._maybeBootEnhanceRender();
            });
          } else {
            setTimeout(function () {
              if (!self.data.cameraContext) return;
              self._maybeBootEnhanceRender();
            }, 0);
          }
        }, 2400);
      }
    }
    try { wx.vibrateShort({ type: 'light' }); } catch (eV) { }
  },

  /** 工具条自身吞事件，避免点胶囊内部时触发遮罩 closeAllDrawers。 */
  stopEnhanceToolbarBubble: function () { },

  /**
   * 启动 1s 轮询把 render-pipeline 的 FPS 拉到 data.enhanceFpsText；
   * 仅在抽屉打开期间运行，避免长驻开销。未启用增强渲染时显示 "— fps"。
   * @returns {void}
   */
  startEnhanceFpsPolling: function () {
    if (!this.data.enhanceWhitelisted) return;
    if (this._enhanceFpsPollTimer) return;
    var self = this;
    var poll = function () {
      if (!self._livePageVisible || self.data.drawerMode !== 1) {
        self.stopEnhanceFpsPolling();
        return;
      }
      var text = '— fps';
      try {
        var pipeline = self._renderPipeline;
        if (pipeline) {
          var diag = typeof pipeline.diagnostics === 'function' ? pipeline.diagnostics() : null;
          var snap = typeof pipeline.snapshot === 'function' ? pipeline.snapshot() : null;
          var curMode = diag ? diag.mode : (self.data.enhanceMode || 'off');
          if (curMode === 'off') {
            text = '已关闭';
          } else if (!diag || diag.framesRendered === 0) {
            text = '⚠ 无帧';
          } else if (diag.sinceLastFrameMs > 1200) {
            text = '⚠ 停滞 ' + Math.round(diag.sinceLastFrameMs / 100) / 10 + 's';
          } else if (snap && typeof snap.avgFps === 'number' && isFinite(snap.avgFps)) {
            text = Math.round(snap.avgFps) + ' fps · ' + diag.framesRendered + '帧';
          } else {
            text = diag.framesRendered + '帧 · 采样中';
          }
        }
      } catch (eSnap) { }
      if (text !== self.data.enhanceFpsText) {
        self.setData({ enhanceFpsText: text });
      }
    };
    poll();
    this._enhanceFpsPollTimer = setInterval(poll, 1000);
  },

  /** @returns {void} */
  stopEnhanceFpsPolling: function () {
    if (this._enhanceFpsPollTimer) {
      clearInterval(this._enhanceFpsPollTimer);
      this._enhanceFpsPollTimer = null;
    }
  },

  /**
   * 快速上手第一步结束，进入抖音直播画幅（16:9）说明。
   * @returns {void}
   */
  onGuideToDyFrame: function () {
    this.setData({ guideSubStep: 1 });
  },

  /**
   * 关闭引导并写入已读；两步均视为完成。
   * @returns {void}
   */
  dismissGuide: function () {
    this.setData({ showGuide: false, guideSubStep: 0 });
    wx.setStorageSync('hasReadGuide', true);
  },

  /**
   * 打开抽屉（mode 1）：左侧比赛列表 + 右侧高光缩略图
   */
  openDrawerMode1: function () {
    this.refreshDrawerHighlights();
    this.loadMatchList();
    this.setData({ drawerMode: 1, cameraSettingsOpen: false });
    // 仅白名单机型内部拉起 FPS 轮询；内部已二次判定，调用幂等
    this.startEnhanceFpsPolling();
  },

  /**
   * 关闭所有抽屉，回到 mode 0
   */
  closeAllDrawers: function () {
    if (this.data.drawerMode !== 0) {
      this.setData({ drawerMode: 0 });
    }
    this.stopEnhanceFpsPolling();
  },

  /** 向后兼容：内部调用 closeDrawer 的地方统一走 closeAllDrawers */
  closeDrawer: function () {
    this.closeAllDrawers();
  },

  stopDrawerBubbling: function () { return; },
  stopLeftDrawerBubbling: function () { return; },

  onDrawerBackdropMove: function (e) {
    const touch = (e.touches && e.touches[0]) ? e.touches[0] : null;
    if (!touch) return;
    const sys = wx.getSystemInfoSync();
    const w = sys.windowWidth || 375;
    if (touch.pageX < 16 || touch.pageX > w - 16) {
      this.closeAllDrawers();
    }
  },

  /**
   * 从 MIAOXIE_MATCHES 加载完整比赛列表，标记当前场次
   */
  loadMatchList: function () {
    const currentMatchId =
      wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    const matches = Array.isArray(raw) ? raw : [];
    const matchList = matches.map((m) => ({ ...m, isCurrent: m.id === currentMatchId }));
    this.setData({ matchList, matchCount: matchList.length });
  },

  /**
   * 点击比赛卡片：关闭抽屉，弹出颜色设置浮层
   * @param {WechatMiniprogram.TouchEvent} e data-id
   */
  openColorModal: function (e) {
    const { id } = e.currentTarget.dataset;
    const match = this.data.matchList.find((m) => m.id === id);
    if (!match) return;
    const cloned = JSON.parse(JSON.stringify(match));
    ['teamA', 'teamB'].forEach((t) => {
      if (cloned[t] && typeof cloned[t].bgColor === 'string') {
        cloned[t].bgColor = cloned[t].bgColor.toUpperCase();
      }
    });
    this.setData({
      drawerMode: 0,
      showColorModal: true,
      colorModalMatch: cloned,
      colorModalTeam: 'teamA',
      colorModalCacheRowHint: '正在估算空间…',
      colorModalDownloadCleared: false
    });
    try {
      const { estimateClipSegmentsBytesFromStorage } = require('../../utils/file-storage-estimate.js');
      estimateClipSegmentsBytesFromStorage().then((bytes) => {
        if (!this.data.showColorModal) return;
        const mb = Math.max(0, Math.round((bytes / (1024 * 1024)) * 10) / 10);
        const empty = mb < 0.05;
        // 缓存为 0 时将 hint 置空，WXML 的 wx:if 会隐藏整个 Footer 行，用户无需操作
        this.setData({
          colorModalCacheRowHint: empty ? '' : `当前已保存高光约 ${mb} MB，建议开播前下载至相册以腾出空间。`,
          colorModalDownloadCleared: empty
        });
      });
    } catch (eEst) { }
  },

  /**
   * 关闭颜色设置浮层
   */
  closeColorModal: function () {
    this.setData({
      showColorModal: false,
      colorModalMatch: null,
      colorModalCacheRowHint: '',
      colorModalDownloadCleared: false
    });
  },

  /**
   * 将全部高光本地视频保存到系统相册并 unlink，索引保留为「已导出」（小程序内无法直连相册路径回放）。
   * @returns {void}
   */
  onDownloadHighlightsToAlbumAndClearCache: function () {
    const fs = wx.getFileSystemManager();
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) {
      wx.showToast({ title: '高光索引读取失败', icon: 'none' });
      return;
    }
    /** @type {{ matchId: string, item: Record<string, unknown>, paths: string[] }[]} */
    const tasks = [];
    Object.keys(clipsMap).forEach((matchId) => {
      const list = clipsMap[matchId];
      if (!Array.isArray(list)) return;
      list.forEach((it) => {
        if (!it || typeof it !== 'object' || it.exportedToAlbum) return;
        const segs = Array.isArray(it.segments) ? it.segments.filter((p) => p && typeof p === 'string') : [];
        const extra = it.replaySegment && typeof it.replaySegment === 'string' ? [it.replaySegment] : [];
        const merged = [...new Set([...segs, ...extra])];
        if (merged.length === 0) return;
        tasks.push({ matchId, item: it, paths: merged });
      });
    });
    if (tasks.length === 0) {
      try {
        const {
          estimateClipSegmentsBytesFromStorage,
          estimateUserDataPathUsageBytes,
          getClipStorageHealthHint
        } = require('../../utils/file-storage-estimate.js');
        Promise.all([estimateClipSegmentsBytesFromStorage(), estimateUserDataPathUsageBytes()]).then(([b, userB]) => {
          const mb = Math.max(0, Math.round((b / (1024 * 1024)) * 10) / 10);
          const empty = mb < 0.05;
          let hint = null;
          try {
            hint = getClipStorageHealthHint(b, userB);
            this._syncCacheStorageLampData(hint);
          } catch (eHint) { }
          this.setData({
            colorModalCacheRowHint:
              empty
                ? '本地高光视频保存约 0 MB，暂无可导出的本地文件。'
                : `本地高光视频保存约 ${mb} MB，暂无可导出的本地文件。`,
            colorModalDownloadCleared: empty || !!(hint && hint.level !== 'severe')
          });
        });
      } catch (eZ) { }
      wx.showToast({ title: '无待导出本地文件', icon: 'none' });
      return;
    }
    const runChain = (taskIdx) => {
      if (taskIdx >= tasks.length) {
        if (!clipsStorage.writeClipsMapSafe(clipsMap)) {
          wx.showToast({ title: '索引更新失败', icon: 'none' });
        }
        this.segmentBuffer = [];
        this.clearStaleRollingFiles().then(() => {
          this.refreshDrawerHighlights();
          this.loadMatchList();
          wx.showToast({ title: '已保存至相册并清理空间', icon: 'success' });
          try {
            const {
              estimateClipSegmentsBytesFromStorage,
              estimateUserDataPathUsageBytes,
              getClipStorageHealthHint
            } = require('../../utils/file-storage-estimate.js');
            Promise.all([estimateUserDataPathUsageBytes(), estimateClipSegmentsBytesFromStorage()]).then(
              ([userB, clipB]) => {
                const mb = Math.max(0, Math.round((clipB / (1024 * 1024)) * 10) / 10);
                let levelNow = 'severe';
                try {
                  const h = getClipStorageHealthHint(clipB, userB);
                  levelNow = String(h.level || '').toLowerCase();
                  this._syncCacheStorageLampData(h);
                  app.globalData.fileStorageEstimate = {
                    clipBytes: clipB,
                    userDataBytes: userB,
                    clipMb: h.clipMb,
                    totalMb: h.totalMb,
                    healthLevel: h.level,
                    hintText: h.hintText,
                    at: Date.now()
                  };
                  storageEst.writeFileStorageEstimateSnapshot(app.globalData.fileStorageEstimate);
                } catch (eG) { }
                if (this.data.showColorModal) {
                  const emptied = mb < 0.05;
                  this.setData({
                    colorModalCacheRowHint: `本地高光视频保存约 ${mb} MB，已导出至系统相册。`,
                    colorModalDownloadCleared: emptied || levelNow !== 'severe'
                  });
                }
              }
            );
          } catch (eUpd) { }
        });
        return;
      }
      const { matchId, item, paths } = tasks[taskIdx];
      let pi = 0;
      const step = () => {
        if (pi >= paths.length) {
          const list = clipsMap[matchId];
          const idx = Array.isArray(list)
            ? list.findIndex((x) => x && String(x.id) === String(item.id))
            : -1;
          if (idx >= 0) {
            list[idx].segments = [];
            list[idx].replaySegment = '';
            list[idx].exportedToAlbum = true;
            list[idx].exportedToAlbumAt = Date.now();
          }
          runChain(taskIdx + 1);
          return;
        }
        const p = paths[pi];
        pi += 1;
        wx.saveVideoToPhotosAlbum({
          filePath: p,
          success: () => {
            try {
              fs.unlinkSync(p);
            } catch (eUn) { }
            step();
          },
          fail: () => {
            step();
          }
        });
      };
      step();
    };
    const start = () => runChain(0);
    wx.getSetting({
      success: (res) => {
        if (res.authSetting['scope.writePhotosAlbum']) {
          start();
        } else {
          wx.authorize({
            scope: 'scope.writePhotosAlbum',
            success: start,
            fail: () => {
              wx.showModal({
                title: '需要相册权限',
                content: '请在设置中允许保存到相册',
                showCancel: false
              });
            }
          });
        }
      }
    });
  },

  /** 阻止颜色浮层内部点击冒泡到遮罩关闭 */
  stopColorModalBubbling: function () { return; },

  /**
   * 严重存储自定义浮层：用户点「知道了」关闭。
   * @returns {void}
   */
  onStoragePressureModalDismiss: function () {
    this.setData({ showStoragePressureModal: false });
  },

  /**
   * 严重存储自定义浮层：跳转与 `wx.showModal` 确认一致，执行下载并清空。
   * @returns {void}
   */
  onStoragePressureModalConfirm: function () {
    this.setData({ showStoragePressureModal: false });
    this.onDownloadHighlightsToAlbumAndClearCache();
  },

  /**
   * 浮层中选中队伍名，切换共用色盘指向
   * @param {WechatMiniprogram.TouchEvent} e data-team
   */
  onSelectModalTeam: function (e) {
    const { team } = e.currentTarget.dataset;
    if (team === 'teamA' || team === 'teamB') {
      this.setData({ colorModalTeam: team });
    }
  },

  /**
   * 从颜色浮层切换场次：更新 currentMatchId 并关闭浮层
   */
  onSwitchMatchFromModal: function () {
    const modal = this.data.colorModalMatch;
    if (!modal || !modal.id) return;

    // 如果已经是当前场次，点击应关闭浮层
    if (modal.isCurrent) {
      this.closeColorModal();
      return;
    }

    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    if (!Array.isArray(raw)) return;
    const idx = raw.findIndex((m) => m.id === modal.id);
    if (idx < 0) return;
    const found = raw[idx];
    if (!found.teamA || !found.teamA.name || !found.teamB || !found.teamB.name) {
      wx.showToast({ title: '该比赛队名不完整', icon: 'none' });
      return;
    }
    /** 将浮层内最新颜色写回 Storage，再切换场次 */
    raw[idx].teamA = { ...found.teamA, ...modal.teamA };
    raw[idx].teamB = { ...found.teamB, ...modal.teamB };
    wx.setStorageSync('MIAOXIE_MATCHES', raw);
    const merged = raw[idx];
    wx.setStorageSync('currentMatchId', modal.id);
    app.globalData.currentMatchId = modal.id;
    const normalizedConfig = this.normalizeMatchConfig(merged);
    app.globalData.matchConfig = normalizedConfig;
    wx.setStorageSync('matchConfig', normalizedConfig);
    this.setData({ matchConfig: normalizedConfig });
    this.updateTeamGroupWidth(true);
    this.closeColorModal();
    this.loadMatchList();
    this.refreshDrawerHighlights(); // 切换后立即刷新高光列表
    this.vibrate('medium');
    wx.showToast({ title: '已切换', icon: 'success', duration: 800 });
  },

  /**
   * 修改某场比赛的队服颜色球（点击色球直接生效）
   * @param {WechatMiniprogram.TouchEvent} e data-match-id / data-team / data-color
   */
  onChangeTeamColor: function (e) {
    const { color } = e.currentTarget.dataset;
    const modal = this.data.colorModalMatch;
    if (!modal) return;
    const matchId = modal.id;
    const team = this.data.colorModalTeam;

    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    if (!Array.isArray(raw)) return;
    const idx = raw.findIndex((m) => m.id === matchId);
    if (idx < 0) return;

    const colorUpper = (color || '').toUpperCase();
    const textColor = this.getContrastColor(colorUpper);
    raw[idx][team] = {
      ...raw[idx][team],
      bgColor: colorUpper,
      textColor: textColor
    };
    wx.setStorageSync('MIAOXIE_MATCHES', raw);

    const currentMatchId =
      wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    if (matchId === currentMatchId) {
      const updated = this.normalizeMatchConfig(raw[idx]);
      this.setData({ matchConfig: updated });
      this.updateTeamGroupWidth(true);
      app.globalData.matchConfig = updated;
      wx.setStorageSync('matchConfig', updated);
    }

    const updatedModal = JSON.parse(JSON.stringify(modal));
    updatedModal[team] = {
      ...updatedModal[team],
      bgColor: colorUpper,
      textColor: textColor
    };
    this.setData({ colorModalMatch: updatedModal });

    this.loadMatchList();
  },

  /**
   * 切换到指定场次，加载数据并关闭抽屉
   * @param {WechatMiniprogram.TouchEvent} e data-id
   */
  onSwitchMatch: function (e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    if (!Array.isArray(raw)) return;
    const match = raw.find((m) => m.id === id);
    if (!match) return;

    if (!match.teamA.name || !match.teamB.name) {
      wx.showToast({ title: '该比赛队名不完整', icon: 'none' });
      return;
    }

    wx.setStorageSync('currentMatchId', id);
    app.globalData.currentMatchId = id;
    const normalizedConfig = this.normalizeMatchConfig(match);
    app.globalData.matchConfig = normalizedConfig;
    wx.setStorageSync('matchConfig', normalizedConfig);
    this.setData({ matchConfig: normalizedConfig });
    this.updateTeamGroupWidth(true);
    this.closeAllDrawers();
    this.refreshDrawerHighlights(); // 切换后立即刷新高光列表
    this.vibrate('medium');
    wx.showToast({ title: '已切换', icon: 'success', duration: 800 });
  },

  refreshDrawerHighlights: function () {
    const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    const fullList = (this.getHighlightList(currentMatchId) || []).filter(
      (it) => it && !it.exportedToAlbum
    );
    const total = fullList.length;
    const list = fullList.slice(0, 50);
    const dc = this.data.defaultCover;
    const drawerHighlights = list.map((it, idx) => {
      const rawCover = it && it.cover ? it.cover : '';
      const hasRealCover = !!(rawCover && rawCover !== dc);
      const thumbSrc = hasRealCover ? rawCover : '';
      return {
        id: it.id,
        cover: rawCover || dc,
        thumbSrc,
        hasRealCover,
        replayInitialTimeSec: typeof it.replayInitialTimeSec === 'number' ? it.replayInitialTimeSec : 0,
        needsCover: (!rawCover || rawCover === dc),
        timeText: it.timeText || '',
        scoreA: typeof it.scoreA === 'number' ? it.scoreA : 0,
        scoreB: typeof it.scoreB === 'number' ? it.scoreB : 0,
        nameA: it.nameA || 'A',
        nameB: it.nameB || 'B',
        colorA: it.colorA || '#E64340',
        colorB: it.colorB || '#10AEFF',
        clipIndex: total - idx
      };
    });
    this.setData({ drawerHighlights, highlightCount: total });
  },

  onDrawerImageError: function (e) {
    const { id } = e.currentTarget.dataset;
    const dc = this.data.defaultCover;
    const updated = (this.data.drawerHighlights || []).map((it) => {
      if (it.id === id) {
        return { ...it, cover: dc, thumbSrc: dc };
      }
      return it;
    });
    this.setData({ drawerHighlights: updated });
  },

  onDrawerSelect: function (e) {
    const { id } = e.currentTarget.dataset;
    const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    const list = this.getHighlightList(currentMatchId);
    const item = list.find((x) => x && String(x.id) === String(id));
    if (!item) return;
    if (item.savedToAlbum) {
      wx.showToast({ title: '已为您节省空间并转存至手机相册，请前往相册观看', icon: 'none', duration: 3000 });
      return;
    }
    this.closeAllDrawers();
    this.startReplay(item);
  },

  /**
   * 长按删除高光
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onDeleteHighlight: function (e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除高光',
      content: '确定要永久删除这段高光视频吗？',
      confirmColor: '#E64340',
      success: (res) => {
        if (res.confirm) {
          this.doDeleteHighlight(id);
        }
      }
    });
  },

  /** 真正执行删除逻辑（双端一致） */
  doDeleteHighlight: function (id) {
    const fs = wx.getFileSystemManager();

    // 1. 处理 MIAOXIE_CLIPS
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) {
      wx.showToast({ title: '高光索引读取失败', icon: 'none' });
      return;
    }
    let foundInClips = false;
    for (const matchId in clipsMap) {
      const bucket = clipsMap[matchId];
      if (!Array.isArray(bucket)) continue;
      const idx = bucket.findIndex((x) => x && String(x.id) === String(id));
      if (idx >= 0) {
        const item = bucket[idx];
        const toUnlink = new Set();
        (item.segments || []).forEach((p) => {
          if (p && typeof p === 'string') toUnlink.add(p);
        });
        if (item.replaySegment && typeof item.replaySegment === 'string') {
          toUnlink.add(item.replaySegment);
        }
        toUnlink.forEach((p) => {
          try {
            fs.unlinkSync(p);
          } catch (e) { }
        });
        bucket.splice(idx, 1);
        foundInClips = true;
        break;
      }
    }
    if (foundInClips) {
      clipsStorage.writeClipsMapSafe(clipsMap);
    }

    // 2. 处理 legacy highlight_list
    const legacyList = wx.getStorageSync('highlight_list') || [];
    const legacyIdx = legacyList.findIndex(x => x.id === id);
    if (legacyIdx >= 0) {
      const item = legacyList[legacyIdx];
      (item.segments || []).forEach(p => { try { fs.unlinkSync(p); } catch (e) { } });
      legacyList.splice(legacyIdx, 1);
      wx.setStorageSync('highlight_list', legacyList);
    }

    wx.showToast({ title: '已删除', icon: 'success' });
    this.refreshDrawerHighlights();
  },

  /**
   * 自动将高光保存至相册并删除微信本地缓存（仅针对 VK 模式）
   * @param {object} item 高光对象
   */
  _saveHighlightToAlbumAndClean: function (item, silent) {
    if (!item || !item.isVkTimeshift || item.savedToAlbum) return;
    const src = (item.preSegments && item.preSegments[0]) || item.replaySegment;
    if (!src) return;
    wx.saveVideoToPhotosAlbum({
      filePath: src,
      success: () => {
        const fs = wx.getFileSystemManager();
        try { fs.unlinkSync(src); } catch (e) { }

        const clipsMap = clipsStorage.readClipsMapSafe();
        if (clipsMap && clipsMap[item.matchId]) {
          const bucket = clipsMap[item.matchId];
          const target = bucket.find(c => String(c.id) === String(item.id));
          if (target) {
            target.savedToAlbum = true;
            target.preSegments = [];
            clipsStorage.writeClipsMapSafe(clipsMap);
          }
        }
        if (Array.isArray(this.data.highlights)) {
          const updatedHighlights = this.data.highlights.map(h => {
            if (String(h.id) === String(item.id)) {
              return { ...h, savedToAlbum: true, preSegments: [] };
            }
            return h;
          });
          this.setData({ highlights: updatedHighlights });
        }
        this.refreshDrawerHighlights();
        if (!silent) {
          // 看多次后自动触发的不弹 toast，避免打扰
        }
      },
      fail: (err) => {
        // 如果用户拒绝授权等，暂不做处理，留待下次播放后再试
      }
    });
  },

  /**
   * 存储超限保护：扫描当前所有已落盘且未转存的 VK 高光，若大于等于 8 个，自动将最老的一个转存相册并清理微信缓存
   */
  _enforceHighlightStorageLimit: function () {
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) return;
    let pendingClips = [];
    for (let mId in clipsMap) {
      if (Array.isArray(clipsMap[mId])) {
        clipsMap[mId].forEach(clip => {
          if (clip.isVkTimeshift && !clip.savedToAlbum) {
            pendingClips.push(clip);
          }
        });
      }
    }
    if (pendingClips.length >= 8) {
      // 找出时间戳最早的（数字越小越早）
      pendingClips.sort((a, b) => a.id - b.id);
      const oldest = pendingClips[0];
      if (oldest) {
        this._saveHighlightToAlbumAndClean(oldest, true);
      }
    }
  },

  /**
   * 进入回放前暂停滚动录制，降低 camera 与 video 并行造成的失败/闪退概率。
   * rollingFsBusy 时必须等待后再继续，禁止调用方在未停录时启动回放（此前会直接导致卡死或微信崩溃）。
   * @param {function(): void} [onPaused] 录制已停止、可安全起播时回调
   * @returns {void}
   */
  pauseRollingForReplay: function (onPaused) {
    this._rollingPausedForReplay = false;
    this.appendHealthLog('replay_pause_ui_only', {
      recorderState: this._recorderCore ? this._recorderCore.state : ''
    });
    if (this._recorderCore) {
      this._recorderCore.requestReplayPause('replay', onPaused);
      return;
    }
    if (typeof onPaused === 'function') {
      if (wx.nextTick) wx.nextTick(onPaused);
      else setTimeout(onPaused, 0);
    }
  },

  /**
   * 退出回放后恢复滚动录制；仅在相机可用且非恢复流程中重启。
   * @returns {void}
   */
  resumeRollingAfterReplay: function () {
    this._rollingPausedForReplay = false;
    this.appendHealthLog('replay_resume_ui_only', {
      recorderState: this._recorderCore ? this._recorderCore.state : ''
    });
    if (this._recorderCore) {
      this._recorderCore.requestReplayResume('replay');
    }
  },

  /**
   * 启动回放，采用双 slot 预加载方案消除链式切换时的黑帧。
   * - slot-a 播放第一段（或单段）；slot-b 同步预加载第二段（如有）。
   * - 切换时只改 replayActiveSlot，两个 video 组件始终在 DOM 中，不触发重新加载。
   * @param {object} item 高光条目
   */
  startReplay: function (item) {
    if (this.data.isSavingHighlight) {
      this._replayDeferredItem = item;
      this.appendHealthLog('replay_deferred_until_highlight_done', {
        id: item && item.id ? String(item.id) : ''
      });
      wx.showToast({ title: '正在保存高光，完成后自动播放', icon: 'none' });
      return;
    }
    this._replayPendingActiveSlot = null;
    if (this._replayStartTimer) {
      clearTimeout(this._replayStartTimer);
      this._replayStartTimer = null;
    }
    if (this._replayMaskHideTimer) {
      clearTimeout(this._replayMaskHideTimer);
      this._replayMaskHideTimer = null;
    }
    if (this._replayOutroTimer) {
      clearTimeout(this._replayOutroTimer);
      this._replayOutroTimer = null;
    }
    if (this._replayPendingFallbackTimer) {
      clearTimeout(this._replayPendingFallbackTimer);
      this._replayPendingFallbackTimer = null;
    }
    if (this._replayPrimeTimerA) {
      clearTimeout(this._replayPrimeTimerA);
      this._replayPrimeTimerA = null;
    }
    if (this._replayPrimeTimerB) {
      clearTimeout(this._replayPrimeTimerB);
      this._replayPrimeTimerB = null;
    }
    this._replayPrimedSlot0 = false;
    this._replayPrimedSlot1 = false;
    if (item && item.exportedToAlbum) {
      wx.showToast({
        title: '已导出至系统相册，小程序无法直连播放，请到相册查看',
        icon: 'none',
        duration: 3200
      });
      return;
    }
    const target =
      (item && item.replaySegment)
      || ((item && Array.isArray(item.segments) && item.segments[item.segments.length - 1])
        ? item.segments[item.segments.length - 1]
        : '');
    if (!target) return;
    this.pauseRollingForReplay(() => {
      this.startReplayContinue(item);
    });
  },

  /**
   * 在 {@link pauseRollingForReplay} 真正停录后再绑定 video、起播（必须与相机互斥）。
   * @param {object} item 高光条目
   * @returns {void}
   */
  startReplayContinue: function (item) {
    if (!item || typeof item !== 'object') return;
    this._replayActiveItem = item;

    // 递增观看次数并入库
    item.viewCount = (item.viewCount || 0) + 1;
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (clipsMap && clipsMap[item.matchId]) {
      const bucket = clipsMap[item.matchId];
      const target = bucket.find(c => String(c.id) === String(item.id));
      if (target) {
        target.viewCount = item.viewCount;
        clipsStorage.writeClipsMapSafe(clipsMap);
      }
    }
    if (Array.isArray(this.data.highlights)) {
      const updatedHighlights = this.data.highlights.map(h => {
        if (String(h.id) === String(item.id)) return { ...h, viewCount: item.viewCount };
        return h;
      });
      this.setData({ highlights: updatedHighlights });
    }
    const useChain = !!(item.replayUseChain && item.segments && item.segments.length >= 2);
    const paths = useChain ? item.segments.slice() : [];
    const target =
      (item.replaySegment)
      || ((Array.isArray(item.segments) && item.segments[item.segments.length - 1])
        ? item.segments[item.segments.length - 1]
        : '');
    if (!target) return;

    const fs = wx.getFileSystemManager();
    const toCheck = useChain ? paths : [target];
    for (let i = 0; i < toCheck.length; i += 1) {
      try {
        fs.accessSync(toCheck[i]);
      } catch (e) {
        wx.showModal({
          title: '文件已移除',
          content: '该视频文件已不存在，系统将自动清理无效记录。',
          showCancel: false,
          success: () => {
            this.doDeleteHighlight(item.id);
          }
        });
        return;
      }
    }

    if (wx.setPageOrientation) {
      wx.setPageOrientation({ orientation: 'landscape' });
    }

    /** 缩短全黑 REPLAY 叠层，首帧略早露出（与 replayIntroDurationMs 可再对齐 WXSS） */
    const introMs = 520;
    const peakMs = 140;
    let initialSec = typeof item.replayInitialTimeSec === 'number' ? item.replayInitialTimeSec : 0;

    // VK 模式特殊处理：废弃底层的 initial-time 属性（会因无关键帧导致黑屏报错）
    // 改为从 0 开始播，由业务层在 loadedmetadata/bindplay 中强行 seek 过去，并辅以 UI 遮罩
    // Fix: 不再依赖 initialSec > 0 判断；VK 高光始终需要跳到末尾 8s，
    // 即使 startTimeSec=0（短片段），loadedmetadata 拿到 duration 后会用 duration-8 计算，
    // 得到 0 也是正确退化行为（从头播就是高光起点）。
    this._vkDelayedSeekTarget = null;
    this._vkSeekDone = false;
    let showFastForwardMask = false;
    const isVk = !!item.isVkTimeshift;
    this._isVkTimeshift = isVk; // 使用私有变量规避 setData 异步延迟风险
    this._vkSeekConfirmed = false; // 重置系统级校验锁
    this._vkSeekTarget = 0;
    this._replayStopAtMediaSec = 0;

    if (isVk) {
      this._vkDelayedSeekTarget = 'pending';
      showFastForwardMask = false; // 直接显示快进过程，去掉遮罩
      initialSec = 0;
    }

    /** 第一段路径与第二段路径（链式时预加载，单段为空） */
    const firstPath = useChain ? paths[0] : target;
    const secondPath = useChain && paths.length >= 2 ? paths[1] : '';

    const segLenSec = this.segmentDurationMs / 1000;
    const winSec = (this.highlightPlaybackWindowMs || 8000) / 1000;

    if (typeof item.replayMediaStopAtSec === 'number') {
      // VK 模式跳过 8s 截断限制，允许播放到实际终点
      this._replayStopAtMediaSec = isVk
        ? item.replayMediaStopAtSec
        : Math.min(segLenSec, item.replayMediaStopAtSec);
    } else {
      // VK 模式初始化时不写死 stopAt，等待 loadedmetadata 拿到真实时长后再定
      this._replayStopAtMediaSec = isVk
        ? 0
        : Math.min(segLenSec, initialSec + winSec);
    }
    if (typeof item.replayChainPart2StopAtSec === 'number') {
      this._replayChainPart2StopAt = isVk
        ? item.replayChainPart2StopAtSec
        : Math.min(segLenSec, item.replayChainPart2StopAtSec);
    } else {
      this._replayChainPart2StopAt = null;
    }

    this._cancelReplayZoomAnim();
    this._replayDoubleTapLast = null;
    this._replayMultiTouchActive = false;
    this._replayHadMultiTouchThisGesture = false;
    this._replayPinchFormulaUntil = 0;
    this._replayPinchSnapSession = false;
    this._replayPinchBaselineScale = 1;
    this._clearReplayPinchSnapTimer();
    this._resetReplayTransformCache();

    this.setData({
      showReplayMask: true,
      replayMaskText: 'REPLAY',
      replayMaskKind: 'replay',
      replayFastForwarding: showFastForwardMask, // 追加快进遮罩状态
      isVkTimeshift: isVk, // 记录当前是否为 VK 模式，用于后续逻辑隔离
      replayQueue: [],
      replayIndex: 0,
      replaySrc: '',
      replayVideoNeedRotate: false,
      replayVideoRotateDeg: 90,
      replayMuted: true,
      replayViewScale: 1,
      replayViewX: 0,
      replayViewY: 0,
      replayInitialTime: 0,
      replayHighlightChain: false,
      replayHighlightPaths: paths,
      replayHighlightIndex: 0,
      replayActiveSlot: 0,
      replaySlotASrc: '',
      replaySlotAInitialTime: 0,
      replaySlotBSrc: '',
      replaySlotBInitialTime: 0
    });

    this._replayStartTimer = setTimeout(() => {
      this._replayStartTimer = null;
      this.setData({
        isReplaying: true,
        replayHighlightChain: useChain,
        replayHighlightPaths: paths,
        replayHighlightIndex: 0,
        replayActiveSlot: 0,
        replaySlotASrc: firstPath,
        replaySlotAInitialTime: initialSec,
        replaySlotBSrc: secondPath,
        replaySlotBInitialTime: 0
      }, () => {
        wx.nextTick(() => {
          try {
            const ctx = wx.createVideoContext('replayVideoA', this);
            if (ctx && ctx.play) ctx.play();
          } catch (e) { }
        });
      });
    }, peakMs);

    this._replayMaskHideTimer = setTimeout(() => {
      this._replayMaskHideTimer = null;
      this.setData({ showReplayMask: false });
    }, introMs);
  },

  /**
   * 获取当前活跃 slot 对应的 VideoContext id。
   * @returns {string} 'replayVideoA' | 'replayVideoB'
   */
  _activeReplayVideoId: function () {
    return this.data.replayActiveSlot === 1 ? 'replayVideoB' : 'replayVideoA';
  },

  /**
   * 结束回放并播放回到直播的转场（正常播完或用户点击中断）。
   * @param {boolean} stopPlayer 是否立即停止 video（点击中断时为 true）
   */
  finishReplayToLive: function (stopPlayer) {
    if (this._replayActiveItem) {
      if ((this._replayActiveItem.viewCount || 0) >= 2) {
        this._saveHighlightToAlbumAndClean(this._replayActiveItem, true);
      }
      this._replayActiveItem = null;
    }
    this._replayStopAtMediaSec = null;
    this._replayChainPart2StopAt = null;
    this._replayPendingActiveSlot = null;
    if (this._replayStartTimer) {
      clearTimeout(this._replayStartTimer);
      this._replayStartTimer = null;
    }
    if (this._replayMaskHideTimer) {
      clearTimeout(this._replayMaskHideTimer);
      this._replayMaskHideTimer = null;
    }
    if (this._replayOutroTimer) {
      clearTimeout(this._replayOutroTimer);
      this._replayOutroTimer = null;
    }
    if (this._replayPendingFallbackTimer) {
      clearTimeout(this._replayPendingFallbackTimer);
      this._replayPendingFallbackTimer = null;
    }
    if (this._replayPrimeTimerA) {
      clearTimeout(this._replayPrimeTimerA);
      this._replayPrimeTimerA = null;
    }
    if (this._replayPrimeTimerB) {
      clearTimeout(this._replayPrimeTimerB);
      this._replayPrimeTimerB = null;
    }
    if (this._vkFastForwardMaskTimer) {
      clearTimeout(this._vkFastForwardMaskTimer);
      this._vkFastForwardMaskTimer = null;
    }
    this._vkDelayedSeekTarget = 0;
    this.setData({ replayFastForwarding: false });
    this._replayPrimedSlot0 = false;
    this._replayPrimedSlot1 = false;
    this._cancelReplayZoomAnim();
    this._replayDoubleTapLast = null;
    this._replayMultiTouchActive = false;
    this._replayHadMultiTouchThisGesture = false;
    this._replayPinchFormulaUntil = 0;
    this._replayPinchSnapSession = false;
    this._replayPinchBaselineScale = 1;
    this._clearReplayPinchSnapTimer();
    this._resetReplayTransformCache();
    if (stopPlayer) {
      try {
        ['replayVideoA', 'replayVideoB'].forEach((vid) => {
          const ctx = wx.createVideoContext(vid, this);
          if (ctx && ctx.stop) ctx.stop();
        });
      } catch (e) { }
    }
    const outroMs = this.data.replayOutroDurationMs || 720;
    this.setData({
      isReplaying: false,
      replaySrc: '',
      replayQueue: [],
      replayIndex: 0,
      replayMuted: false,
      replayViewScale: 1,
      replayViewX: 0,
      replayViewY: 0,
      replayInitialTime: 0,
      replayHighlightChain: false,
      replayHighlightPaths: [],
      replayHighlightIndex: 0,
      replayActiveSlot: 0,
      replaySlotASrc: '',
      replaySlotAInitialTime: 0,
      replaySlotBSrc: '',
      replaySlotBInitialTime: 0,
      showReplayMask: true,
      replayMaskText: 'LIVE',
      replayMaskKind: 'live'
    });
    this._replayOutroTimer = setTimeout(() => {
      this._replayOutroTimer = null;
      this.setData({ showReplayMask: false, replayMaskText: 'REPLAY', replayMaskKind: 'replay' });
      this.resumeRollingAfterReplay();
    }, outroMs);
  },

  /**
   * 活跃 slot 播放结束：链式时切换到预加载好的另一 slot，无需重新加载。
   * 仅在活跃 slot 的 bindended 中调用（通过 data-slot 区分）。
   * @param {number} slotIdx 触发事件的 slot（0=A, 1=B）
   */
  onReplaySlotEnded: function (slotIdx) {
    if (slotIdx !== this.data.replayActiveSlot) return;
    // 双保险：VK 模式下视频自然结束（ended）也必须触发回到直播，弥补 timeupdate 可能的不及时
    if (this._isVkTimeshift || !this.data.replayHighlightChain) {
      this.finishReplayToLive(false);
      return;
    }
    const paths = this.data.replayHighlightPaths || [];
    const currentIdx = this.data.replayHighlightIndex || 0;
    const nextIdx = currentIdx + 1;
    if (nextIdx >= paths.length) {
      this.setData({ replayHighlightChain: false });
      this.finishReplayToLive(false);
      return;
    }
    /** 切换 slot：另一个 slot 已在 src 写入阶段完成预加载，直接翻到最前 */
    const nextSlot = slotIdx === 0 ? 1 : 0;
    const nextNextPath = paths[nextIdx + 1] || '';
    const updates = { replayHighlightIndex: nextIdx };
    /** 仅在有下一段时才改「旧槽」src，避免与切层同一帧把 src 置空导致闪一下 */
    if (nextNextPath) {
      if (slotIdx === 0) {
        updates.replaySlotASrc = nextNextPath;
        updates.replaySlotAInitialTime = 0;
      } else {
        updates.replaySlotBSrc = nextNextPath;
        updates.replaySlotBInitialTime = 0;
      }
      this._replayPrimedSlot0 = false;
      this._replayPrimedSlot1 = false;
    }
    this._replayPendingActiveSlot = nextSlot;
    if (this._replayPendingFallbackTimer) {
      clearTimeout(this._replayPendingFallbackTimer);
      this._replayPendingFallbackTimer = null;
    }
    this.setData(updates, () => {
      const nextId = nextSlot === 0 ? 'replayVideoA' : 'replayVideoB';
      wx.nextTick(() => {
        try {
          const ctx = wx.createVideoContext(nextId, this);
          const rate = this.data.replayPlaybackRate || 0.75;
          if (ctx && ctx.seek) ctx.seek(0);
          if (ctx && ctx.play) ctx.play();
          if (ctx && ctx.playbackRate) ctx.playbackRate(rate);
        } catch (e) { }
      });
      this._replayPendingFallbackTimer = setTimeout(() => {
        if (this._replayPendingActiveSlot !== nextSlot) return;
        this._replayPendingActiveSlot = null;
        this._replayPendingFallbackTimer = null;
        this.setData({ replayActiveSlot: nextSlot });
        try {
          const oldId = slotIdx === 0 ? 'replayVideoA' : 'replayVideoB';
          const oldCtx = wx.createVideoContext(oldId, this);
          if (oldCtx && oldCtx.pause) oldCtx.pause();
        } catch (e2) { }
      }, 420);
    });
  },

  /**
   * 链式回放：在后台 slot 上做一次轻量 play→pause→seek(0)，促使解码器先出首帧，切换时少黑场。
   * @param {number} slotIdx 0=A, 1=B
   * @returns {void}
   */
  _maybePrimeHiddenChainSlot: function (slotIdx) {
    if (!this.data.isReplaying || !this.data.replayHighlightChain) return;
    const active = this.data.replayActiveSlot;
    const src = slotIdx === 0 ? this.data.replaySlotASrc : this.data.replaySlotBSrc;
    if (!src || active === slotIdx) return;
    if (slotIdx === 0 && this._replayPrimedSlot0) return;
    if (slotIdx === 1 && this._replayPrimedSlot1) return;
    if (slotIdx === 0) this._replayPrimedSlot0 = true;
    else this._replayPrimedSlot1 = true;
    const id = slotIdx === 0 ? 'replayVideoA' : 'replayVideoB';
    wx.nextTick(() => {
      try {
        const ctx = wx.createVideoContext(id, this);
        if (ctx && ctx.play) ctx.play();
        const key = slotIdx === 0 ? '_replayPrimeTimerA' : '_replayPrimeTimerB';
        if (this[key]) {
          clearTimeout(this[key]);
          this[key] = null;
        }
        this[key] = setTimeout(() => {
          this[key] = null;
          try {
            const c2 = wx.createVideoContext(id, this);
            if (c2 && c2.pause) c2.pause();
            if (c2 && c2.seek) c2.seek(0);
          } catch (e2) { }
        }, 120);
      } catch (e) { }
    });
  },

  /**
   * 待置顶 slot 已推进到可显示时间后，再切换 z-index 并暂停旧槽，避免与解码空窗重叠。
   * @param {number} slotIdx 触发 timeupdate 的 slot
   * @param {WechatMiniprogram.CustomEvent} e
   * @returns {void}
   */
  _onReplaySlotTimeUpdate: function (slotIdx, e) {
    if (this._replayPendingActiveSlot !== slotIdx) return;
    const t = e && e.detail && typeof e.detail.currentTime === 'number' ? e.detail.currentTime : 0;

    // 如果物理长度太短或算算无需跳转，在此立刻解开遮罩
    if (this._vkDelayedSeekTarget === 0 && this.data.replayFastForwarding) {
      this._vkDelayedSeekTarget = null;
      if (this._vkFastForwardMaskTimer) clearTimeout(this._vkFastForwardMaskTimer);
      this.setData({ replayFastForwarding: false });
    }

    // 监听快进进度，一旦越过目标线，立即解除遮罩
    if (this.data.replayFastForwarding && typeof this._vkDelayedSeekTarget === 'number' && this._vkDelayedSeekTarget >= 0) {
      // 只要到达目标起跳点附近，立即释放 UI，无需等待固定时长
      if (t >= this._vkDelayedSeekTarget - 0.2) {
        if (this._vkFastForwardMaskTimer) clearTimeout(this._vkFastForwardMaskTimer);
        if (this._vkSeekFallbackTimer) clearTimeout(this._vkSeekFallbackTimer);
        this.setData({ replayFastForwarding: false });
        this._vkDelayedSeekTarget = null;
        this._vkSeekConfirmed = true;
      }
    }

    if (t < 0.05) return;
    this._replayPendingActiveSlot = null;
    if (this._replayPendingFallbackTimer) {
      clearTimeout(this._replayPendingFallbackTimer);
      this._replayPendingFallbackTimer = null;
    }
    const oldSlot = slotIdx === 0 ? 1 : 0;
    this.setData({ replayActiveSlot: slotIdx }, () => {
      try {
        const oldId = oldSlot === 0 ? 'replayVideoA' : 'replayVideoB';
        const oldCtx = wx.createVideoContext(oldId, this);
        if (oldCtx && oldCtx.pause) oldCtx.pause();
      } catch (err) { }
      try {
        const ctx = wx.createVideoContext(slotIdx === 0 ? 'replayVideoA' : 'replayVideoB', this);
        const rate = this.data.replayPlaybackRate || 0.75;
        if (ctx && ctx.playbackRate) ctx.playbackRate(rate);
      } catch (err2) { }
    });
  },

  /**
   * slot-a timeupdate：用于链式切换后待置顶确认。
   * @param {WechatMiniprogram.CustomEvent} e
   */
  onReplayVideoATimeUpdate: function (e) {
    this._onReplaySlotTimeUpdate(0, e);
    this._enforceReplayHighlightWindow(0, e);
  },

  /**
   * slot-b timeupdate：用于链式切换后待置顶确认。
   * @param {WechatMiniprogram.CustomEvent} e
   */
  onReplayVideoBTimeUpdate: function (e) {
    this._onReplaySlotTimeUpdate(1, e);
    this._enforceReplayHighlightWindow(1, e);
  },

  /**
   * 将高光回放限制在「点击时刻前约 8s」对应的媒体时间窗内，避免播完整段 mp4。
   * 旧索引无新字段时退化为 initial + 8s。
   *
   * @param {number} slotIdx 0=A / 1=B
   * @param {WechatMiniprogram.CustomEvent} e
   * @returns {void}
   */
  _enforceReplayHighlightWindow: function (slotIdx, e) {
    if (!this.data.isReplaying) return;
    if (this.data.replayActiveSlot !== slotIdx) return;
    if (this._replayPendingActiveSlot !== null && this._replayPendingActiveSlot !== undefined) {
      return;
    }
    const t = e && e.detail && typeof e.detail.currentTime === 'number' ? e.detail.currentTime : 0;
    const chain = this.data.replayHighlightChain;
    const idx = this.data.replayHighlightIndex || 0;
    if (chain && idx === 1) {
      const lim = this._replayChainPart2StopAt;
      if (typeof lim === 'number' && lim > 0.04 && t >= lim - 0.12) {
        this.finishReplayToLive(false);
      }
      return;
    }
    if (!chain) {
      // VK 模式防护：使用私有变量判断，绕过异步 data 延迟
      if (this._isVkTimeshift) {
        // ✅ 系统级保险：判定是否越过起跳线（允许 0.3s 误差）
        if (!this._vkSeekConfirmed) {
          if (t >= this._vkSeekTarget - 0.3) {
            this._vkSeekConfirmed = true;
          } else {
            return; // ❗未越过目标点前，禁止进入结束逻辑
          }
        }
        // ✅ 提前 250ms 结束（iOS 适配极限优化），给解码与 UI 切换预留更充裕 buffer，确保完全无缝
        if (typeof this._replayStopAtMediaSec === 'number' && this._replayStopAtMediaSec > 0 && t >= this._replayStopAtMediaSec - 0.25) {
          this.finishReplayToLive(false);
        }
        return;
      }

      const lim = this._replayStopAtMediaSec;
      if (typeof lim === 'number' && lim > 0.04 && t >= lim - 0.12) {
        this.finishReplayToLive(false);
      }
    }
  },

  /**
   * slot-a 的 bindended 回调。
   */
  onReplayVideoAEnded: function () {
    this.onReplaySlotEnded(0);
  },

  /**
   * slot-b 的 bindended 回调。
   */
  onReplayVideoBEnded: function () {
    this.onReplaySlotEnded(1);
  },

  /**
   * 兼容旧 WXML bindended="onReplayEnded"（单 video 模式下仍可调用）。
   */
  onReplayEnded: function () {
    this.onReplaySlotEnded(this.data.replayActiveSlot);
  },

  /**
   * 回放中点击屏幕：中断播放并进入直播转场。
   */
  onReplayInterruptTap: function () {
    if (!this.data.isReplaying) return;
    this.finishReplayToLive(true);
  },

  /**
   * 仅对活跃 slot 生效：设置回放倍速。
   * @param {number} slotIdx 触发事件的 slot（0=A, 1=B）
   */
  _applyPlaybackRateToSlot: function (slotIdx) {
    const active = this.data.replayActiveSlot;
    const pending = this._replayPendingActiveSlot;
    if (slotIdx !== active && slotIdx !== pending) return;
    const rate = this.data.replayPlaybackRate || 0.75;
    try {
      const id = slotIdx === 0 ? 'replayVideoA' : 'replayVideoB';
      const ctx = wx.createVideoContext(id, this);
      if (ctx && ctx.playbackRate) ctx.playbackRate(rate);
    } catch (e) { }
  },

  /**
   * VK 快进 seek 兜底：在 bindplay 触发时补发一次 seek。
   * loadedmetadata 阶段在 iOS 上 seek 可能被忽略（视频尚未进入 playing/paused 状态），
   * 此处在播放真正启动后再 seek 一次确保命中。
   * 遵循工程规则：seek 仅做 1~2 次，绝不循环。
   * @param {number} slotIdx 触发 bindplay 的 slot
   */
  _maybeVkSeekOnPlay: function (slotIdx) {
    if (this._vkSeekDone) return;
    if (
      typeof this._vkDelayedSeekTarget === 'number' &&
      this._vkDelayedSeekTarget > 0 &&
      this.data.replayFastForwarding
    ) {
      this._vkSeekDone = true;
      const id = slotIdx === 0 ? 'replayVideoA' : 'replayVideoB';
      try {
        const ctx = wx.createVideoContext(id, this);
        if (ctx && ctx.seek) {
          ctx.seek(this._vkDelayedSeekTarget);
        }
      } catch (e) { }
    }
  },

  /**
   * slot-a bindplay 回调：设置倍速 + VK seek 兜底。
   */
  onReplayVideoAPlay: function () {
    this._applyPlaybackRateToSlot(0);
    this._maybeVkSeekOnPlay(0);
  },

  /**
   * slot-b bindplay 回调：设置倍速 + VK seek 兜底。
   */
  onReplayVideoBPlay: function () {
    this._applyPlaybackRateToSlot(1);
    this._maybeVkSeekOnPlay(1);
  },

  /**
   * 兼容旧 WXML bindplay="onReplayVideoPlay"。
   */
  onReplayVideoPlay: function () {
    this._applyPlaybackRateToSlot(this.data.replayActiveSlot);
    this._maybeVkSeekOnPlay(this.data.replayActiveSlot);
  },

  /**
   * 对 loadedmetadata 处理：VK seek + 旋转检测。
   * Fix: VK seek 分支移到 slot guard 之前——seek 不应受 replayActiveSlot 的状态限制，
   * 因为 slot 赋值（setData）与 video 事件触发存在异步竞态，可能导致 guard 误杀 seek。
   * @param {WechatMiniprogram.CustomEvent} e
   * @param {number} slotIdx 触发事件的 slot（0=A, 1=B）
   */
  _handleReplayLoadedMeta: function (e, slotIdx) {
    const detail = (e && e.detail) || {};

    // VK seek：不受 slot guard 限制，仅检查 _vkDelayedSeekTarget 状态。
    // loadedmetadata 阶段拿到 duration 后立即计算目标，发出第一次 seek。
    // 第二次 seek 在 bindplay 回调中由 _maybeVkSeekOnPlay 兜底（iOS seek 延迟生效）。
    if (this._vkDelayedSeekTarget === 'pending' && detail.duration) {
      const dur = Number(detail.duration);
      // 工程防护：校验 duration 有效性，防止 0/NaN 导致秒切或计算错误
      if (dur > 0.5 && isFinite(dur)) {
        // 跳转到倒数 10 秒处
        const target = Math.max(0, dur - 10);
        this._vkSeekTarget = target;
        this._vkSeekConfirmed = false;
        this._vkDelayedSeekTarget = target;
        this._vkSeekDone = false; // 让 bindplay 还能再 seek 一次

        // 核心修正：同步更新停止点为视频实际终点，确保 seek 后能完整播放到尾部
        this._replayStopAtMediaSec = dur;
        this.setData({
          replaySlotAInitialTime: target
        });
        try {
          const id = slotIdx === 0 ? 'replayVideoA' : 'replayVideoB';
          const ctx = wx.createVideoContext(id, this);
          if (ctx && ctx.seek) {
            ctx.seek(target);
            // ✅ 系统级超时兜底：防止某些极低性能机型不触发 bindseeked/timeupdate 导致死锁
            if (this._vkSeekFallbackTimer) clearTimeout(this._vkSeekFallbackTimer);
            this._vkSeekFallbackTimer = setTimeout(() => {
              this._vkSeekFallbackTimer = null;
              if (this._isVkTimeshift && !this._vkSeekConfirmed) {
                this._vkSeekConfirmed = true;
                this.setData({ replayFastForwarding: false });
              }
            }, 600);

            // 2.5 秒后强行解除遮罩防卡死（极端安全网）
            if (this._vkFastForwardMaskTimer) clearTimeout(this._vkFastForwardMaskTimer);
            this._vkFastForwardMaskTimer = setTimeout(() => {
              this._vkFastForwardMaskTimer = null;
              this.setData({ replayFastForwarding: false });
            }, 2500);
          }
        } catch (seekErr) { }
      } else {
        // duration 为 0（极短录制），退化为从头播，直接解除遮罩
        this._vkDelayedSeekTarget = 0;
        this._vkSeekDone = true;
        if (this._vkFastForwardMaskTimer) clearTimeout(this._vkFastForwardMaskTimer);
        this.setData({ replayFastForwarding: false });
      }
    }

    // 旋转检测与倍速：仍需 slot guard，避免非活跃 slot 的尺寸信息覆盖活跃 slot
    if (slotIdx !== this.data.replayActiveSlot) return;
    const width = Number(detail.width || 0);
    const height = Number(detail.height || 0);
    const needRotate = width > 0 && height > 0 && height > width;
    const rotateDeg = needRotate ? this.getReplayRotateDegForDevice() : 90;
    this.setData({ replayVideoNeedRotate: needRotate, replayVideoRotateDeg: rotateDeg });
    this._applyPlaybackRateToSlot(slotIdx);
  },

  onReplayVideoASeeked: function () {
    this._onReplaySlotSeeked(0);
  },
  onReplayVideoBSeeked: function () {
    this._onReplaySlotSeeked(1);
  },
  _onReplaySlotSeeked: function (slotIdx) {
    if (slotIdx !== this.data.replayActiveSlot) return;
    if (this._isVkTimeshift && this.data.replayFastForwarding) {
      // ✅ 物理级命中信号：一旦 seek 完成，立即打断“定位中”动画，开始播放
      if (this._vkFastForwardMaskTimer) clearTimeout(this._vkFastForwardMaskTimer);
      if (this._vkSeekFallbackTimer) clearTimeout(this._vkSeekFallbackTimer);
      this._vkSeekConfirmed = true;
      this.setData({ replayFastForwarding: false });
      this._vkDelayedSeekTarget = null;
    }
  },

  /**
   * slot-a bindloadedmetadata 回调。
   * @param {WechatMiniprogram.CustomEvent} e
   */
  onReplayVideoALoadedMeta: function (e) {
    this._maybePrimeHiddenChainSlot(0);
    this._handleReplayLoadedMeta(e, 0);
  },

  /**
   * slot-b bindloadedmetadata 回调。
   * @param {WechatMiniprogram.CustomEvent} e
   */
  onReplayVideoBLoadedMeta: function (e) {
    this._maybePrimeHiddenChainSlot(1);
    this._handleReplayLoadedMeta(e, 1);
  },

  /**
   * 兼容旧 WXML bindloadedmetadata="onReplayVideoLoadedMeta"。
   * @param {WechatMiniprogram.CustomEvent} e
   */
  onReplayVideoLoadedMeta: function (e) {
    this._handleReplayLoadedMeta(e, this.data.replayActiveSlot);
  },

  /**
   * 根据设备品牌选择回放旋转方向。
   * 仅对小米系设备做反向旋转修正，避免影响 iPhone 与其他安卓机型。
   * @returns {number} 90 或 -90
   */
  getReplayRotateDegForDevice: function () {
    try {
      const sys = wx.getSystemInfoSync();
      const brand = String((sys && sys.brand) || '').toLowerCase();
      const model = String((sys && sys.model) || '').toLowerCase();
      const isXiaomi =
        brand.indexOf('xiaomi') >= 0
        || brand.indexOf('redmi') >= 0
        || model.indexOf('xiaomi') >= 0
        || model.indexOf('redmi') >= 0;
      return isXiaomi ? -90 : 90;
    } catch (err) {
      return 90;
    }
  },

  /**
   * 切换回放倍速，立即通过 VideoContext 生效。
   * 慢速（0.5x / 0.75x）时自动静音，避免音频降频产生的变调恐怖感；
   * 恢复 1.0x 时自动解除静音。
   * @param {WechatMiniprogram.TouchEvent} e data-rate: 0.5 | 0.75 | 1.0
   */
  onReplaySpeedChange: function (e) {
    const rate = parseFloat(e.currentTarget.dataset.rate);
    if (!rate || isNaN(rate)) return;
    const muted = rate < 1.0;
    this.setData({ replayPlaybackRate: rate, replayMuted: muted });
    this._applyPlaybackRateToSlot(this.data.replayActiveSlot);
  },

  /**
   * 专用退出键：中断回放并进入直播转场。
   * @returns {void}
   */
  onReplayClose: function () {
    if (!this.data.isReplaying) return;
    this.finishReplayToLive(true);
  },

  /**
   * 一键重置 movable-view 的缩放与位置至初始状态（scale=1，x=0，y=0）。
   * @returns {void}
   */
  onReplayResetView: function () {
    this._cancelReplayZoomAnim();
    this._clearReplayPinchSnapTimer();
    this._replayDoubleTapLast = null;
    this._replayMultiTouchActive = false;
    this._replayHadMultiTouchThisGesture = false;
    this._replayPinchFormulaUntil = 0;
    this._replayPinchSnapSession = false;
    this._replayPinchBaselineScale = 1;
    this._resetReplayTransformCache();
    this.setData({ replayViewScale: 1, replayViewX: 0, replayViewY: 0 });
  },

  /**
   * 拖动 movable-view 时同步 x/y；双指过程中不同步，避免与 bindscale 的 x/y 打架。
   * @param {WechatMiniprogram.CustomEvent} e detail.x / detail.y / detail.source
   * @returns {void}
   */
  onReplayViewChange: function (e) {
    if (this._replayZoomAnimating) return;
    const d = (e && e.detail) || {};
    if (typeof d.x !== 'number' || typeof d.y !== 'number') return;
    if (isNaN(d.x) || isNaN(d.y)) return;
    if (d.source === 'touch') {
      // 单指拖动回调到达时，强制解除多指锁，避免「捏合后无法拖动」。
      this._replayMultiTouchActive = false;
    }
    this._touchReplayMergeCache({ x: d.x, y: d.y });
    this.setData({ replayViewX: d.x, replayViewY: d.y });
  },

  /**
   * 双指缩放回调：scale 与 x/y 在同一次 setData 提交；
   * 若 detail 自带 x/y 则直接采用，否则用「双指中点 + 焦点公式」推导避免视觉中心偏移。
   * 公式：x_new = x_old - (scale_new/scale_old - 1) * (focalX - x_old)（y 同理）。
   * @param {WechatMiniprogram.CustomEvent} e detail.scale / detail.x / detail.y
   * @returns {void}
   */
  onReplayViewScale: function (e) {
    if (this._replayZoomAnimating) return;
    const d = (e && e.detail) || {};
    const scaleNew = typeof d.scale === 'number' && !isNaN(d.scale) ? d.scale : 1;
    const prevScale = this.data.replayViewScale || 1;
    if (Math.abs(scaleNew - prevScale) > 0.02) {
      this._replayHadMultiTouchThisGesture = true;
      this._replayMultiTouchActive = true;
    }
    const base = this._replayTransformCache || {
      x: this.data.replayViewX || 0,
      y: this.data.replayViewY || 0,
      scale: this.data.replayViewScale || 1
    };
    const scaleOld = Math.max(0.001, base.scale);
    const vp = this._getReplayViewportPx();
    const w = vp.w;
    const h = vp.h;

    const hasNativeXY =
      typeof d.x === 'number' &&
      !isNaN(d.x) &&
      typeof d.y === 'number' &&
      !isNaN(d.y);

    const now = Date.now();
    const usePinchFocal =
      this._replayMultiTouchActive ||
      (typeof this._replayPinchFormulaUntil === 'number' && now < this._replayPinchFormulaUntil);

    let xNew;
    let yNew;

    if (hasNativeXY) {
      // 优先使用原生返回的 x/y，避免与内核手势解算冲突导致回弹。
      xNew = d.x;
      yNew = d.y;
    } else if (usePinchFocal) {
      const fx =
        typeof this._replayPinchFocalX === 'number' && !isNaN(this._replayPinchFocalX)
          ? this._replayPinchFocalX
          : w * 0.5;
      const fy =
        typeof this._replayPinchFocalY === 'number' && !isNaN(this._replayPinchFocalY)
          ? this._replayPinchFocalY
          : h * 0.5;
      const ratio = scaleNew / scaleOld;
      xNew = base.x - (ratio - 1) * (fx - base.x);
      yNew = base.y - (ratio - 1) * (fy - base.y);
    } else {
      const fx = w * 0.5;
      const fy = h * 0.5;
      const ratio = scaleNew / scaleOld;
      xNew = base.x - (ratio - 1) * (fx - base.x);
      yNew = base.y - (ratio - 1) * (fy - base.y);
    }

    const cl = this._clampReplayPan(xNew, yNew, scaleNew, w, h);
    this._touchReplayMergeCache({ x: cl.x, y: cl.y, scale: scaleNew });
    this.setData({
      replayViewScale: scaleNew,
      replayViewX: cl.x,
      replayViewY: cl.y
    });
  },

  /**
   * 捕获阶段 touchstart：双指落下时记录捏合起始 scale，并更新双指中点（供 bindscale 焦点公式与松手居中）。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onReplayPinchCaptureStart: function (e) {
    if (!this.data.isReplaying || this._replayZoomAnimating) return;
    const touches = (e && e.touches) || [];
    if (touches.length < 2) return;
    this._replayUpdatePinchFocal(touches);
    if (!this._replayPinchSnapSession) {
      this._replayPinchSnapSession = true;
      const t = this._replayTransformCache || {
        scale: this.data.replayViewScale || 1
      };
      this._replayPinchBaselineScale =
        typeof t.scale === 'number' && !isNaN(t.scale) ? t.scale : 1;
    }
  },

  /**
   * 捕获阶段 touchmove：持续更新双指中点。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onReplayPinchCaptureMove: function (e) {
    if (!this.data.isReplaying || this._replayZoomAnimating) return;
    const touches = (e && e.touches) || [];
    if (touches.length >= 2) {
      this._replayUpdatePinchFocal(touches);
    }
  },

  /**
   * movable-view 上 touchend：维护捏合尾窗；若本轮为双指捏合，延迟吸附档位并将捏合中心平滑移到屏幕中心。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onReplayMovableTouchEnd: function (e) {
    if (!this.data.isReplaying) return;
    const touches = (e && e.touches) || [];
    this._replayMultiTouchActive = touches.length >= 2;
    if (touches.length === 0 && this._replayHadMultiTouchThisGesture) {
      this._replayHadMultiTouchThisGesture = false;
      this._replayPinchFormulaUntil = Date.now() + REPLAY_PINCH_SCALE_TAIL_MS;
    }
    if (touches.length === 0 && this._replayPinchSnapSession) {
      this._replayPinchSnapSession = false;
      const self = this;
      this._clearReplayPinchSnapTimer();
      this._replayPinchSnapTimer = setTimeout(() => {
        self._replayPinchSnapTimer = null;
        self._finishReplayPinchSnap();
      }, REPLAY_PINCH_SNAP_DEFER_MS);
    }
  },

  /**
   * movable-view touchcancel：取消待执行的捏合吸附。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onReplayMovableTouchCancel: function (e) {
    this._replayPinchSnapSession = false;
    this._clearReplayPinchSnapTimer();
    this.onReplayMovableTouchEnd(e);
  },

  /**
   * 取消正在进行的双击缩放动画帧。
   * @returns {void}
   */
  _cancelReplayZoomAnim: function () {
    if (this._replayZoomRafId != null) {
      try {
        wx.cancelAnimationFrame(this._replayZoomRafId);
      } catch (err) { }
      this._replayZoomRafId = null;
    }
    this._replayZoomAnimating = false;
  },

  /**
   * 清除捏合松手后延迟执行的 setTimeout，避免退出回放后仍改 scale。
   * @returns {void}
   */
  _clearReplayPinchSnapTimer: function () {
    if (this._replayPinchSnapTimer != null) {
      clearTimeout(this._replayPinchSnapTimer);
      this._replayPinchSnapTimer = null;
    }
  },

  /**
   * 将回放层变换缓存重置为 1x 且左上角对齐。
   * @returns {void}
   */
  _resetReplayTransformCache: function () {
    this._replayTransformCache = { x: 0, y: 0, scale: 1 };
  },

  /**
   * 合并最近一次 movable-view 的 x/y/scale 到内存缓存（优先于 data，避免节流延迟）。
   * @param {{ x?: number, y?: number, scale?: number }} patch
   * @returns {{ x: number, y: number, scale: number }}
   */
  _touchReplayMergeCache: function (patch) {
    const base = this._replayTransformCache || {
      x: this.data.replayViewX || 0,
      y: this.data.replayViewY || 0,
      scale: this.data.replayViewScale || 1
    };
    this._replayTransformCache = {
      x: typeof patch.x === 'number' ? patch.x : base.x,
      y: typeof patch.y === 'number' ? patch.y : base.y,
      scale: typeof patch.scale === 'number' ? patch.scale : base.scale
    };
    return this._replayTransformCache;
  },

  /**
   * 用双指中点更新捏合焦点（client 坐标，与 x/y 同属视口系）。
   * @param {Array<WechatMiniprogram.Touch>} touches touches.length >= 2
   * @returns {void}
   */
  _replayUpdatePinchFocal: function (touches) {
    if (!touches || touches.length < 2) return;
    const a = touches[0];
    const b = touches[1];
    const vp = this._getReplayViewportPx();
    const offL = typeof vp.left === 'number' ? vp.left : 0;
    const offT = typeof vp.top === 'number' ? vp.top : 0;
    this._replayPinchFocalX = (a.clientX + b.clientX) * 0.5 - offL;
    this._replayPinchFocalY = (a.clientY + b.clientY) * 0.5 - offT;
  },

  /**
   * 读取回放 movable-area 与 live-stage 一致的 16:9 内接框（px）及在窗口内偏移，供平移钳位与捏合焦点换算。
   * @returns {{ w: number, h: number, left: number, top: number }}
   */
  _getReplayViewportPx: function () {
    var winW = 375;
    var winH = 667;
    try {
      if (typeof wx.getWindowInfo === 'function') {
        const wi = wx.getWindowInfo();
        winW = wi.windowWidth || winW;
        winH = wi.windowHeight || winH;
      } else {
        const s = wx.getSystemInfoSync();
        winW = s.windowWidth || winW;
        winH = s.windowHeight || winH;
      }
    } catch (err) { }
    var r = computeLiveStage16x9RectPx(winW, winH);
    return { w: r.w, h: r.h, left: r.left, top: r.top };
  },

  /**
   * cubic ease-out，t∈[0,1]。
   * @param {number} t
   * @returns {number}
   */
  _easeOutCubic: function (t) {
    const u = 1 - t;
    return 1 - u * u * u;
  },

  /**
   * 根据当前缩放比例得到双击后的下一档比例（1→1.5→…→3→1）。
   * @param {number} s 当前 scale
   * @returns {number}
   */
  _nextReplayDiscreteScale: function (s) {
    for (let i = 0; i < REPLAY_ZOOM_LEVELS.length; i += 1) {
      if (s < REPLAY_ZOOM_LEVELS[i] - REPLAY_ZOOM_LEVEL_EPS) {
        return REPLAY_ZOOM_LEVELS[i];
      }
    }
    return 1;
  },

  /**
   * 取与 s 最接近的离散缩放档位。
   * @param {number} s
   * @returns {number}
   */
  _replayNearestDiscreteLevel: function (s) {
    let best = REPLAY_ZOOM_LEVELS[0];
    let bestD = Infinity;
    for (let i = 0; i < REPLAY_ZOOM_LEVELS.length; i += 1) {
      const lv = REPLAY_ZOOM_LEVELS[i];
      const d = Math.abs(s - lv);
      if (d < bestD) {
        bestD = d;
        best = lv;
      }
    }
    return best;
  },

  /**
   * 取与 s 最接近档位在 REPLAY_ZOOM_LEVELS 中的下标。
   * @param {number} s
   * @returns {number}
   */
  _replayDiscreteLevelIndex: function (s) {
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < REPLAY_ZOOM_LEVELS.length; i += 1) {
      const d = Math.abs(s - REPLAY_ZOOM_LEVELS[i]);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    return bestI;
  },

  /**
   * 根据捏合起始 scale 与松手时 scale 判定目标档位：明显张开升一档，明显捏拢降一档，否则对齐最近档。
   * 最大档再张开时回到 1x（与双击循环一致）。
   * @param {number} baseline 双指刚落下时的 scale
   * @param {number} endScale 松手时（末帧）scale
   * @returns {number}
   */
  _replayPickPinchSnapScale: function (baseline, endScale) {
    const b = typeof baseline === 'number' && !isNaN(baseline) ? baseline : 1;
    const e = typeof endScale === 'number' && !isNaN(endScale) ? endScale : 1;
    const i0 = this._replayDiscreteLevelIndex(b);
    const last = REPLAY_ZOOM_LEVELS.length - 1;
    if (e > b + REPLAY_PINCH_INTENT_DELTA) {
      if (i0 >= last) return 1;
      return REPLAY_ZOOM_LEVELS[i0 + 1];
    }
    if (e < b - REPLAY_PINCH_INTENT_DELTA) {
      if (i0 <= 0) return 1;
      return REPLAY_ZOOM_LEVELS[i0 - 1];
    }
    return this._replayNearestDiscreteLevel(e);
  },

  /**
   * 捏合手势完全结束后：吸附档位并将双指中心点对应的内容移到屏幕中心（带缓动）。
   * @returns {void}
   */
  _finishReplayPinchSnap: function () {
    if (!this.data.isReplaying || this._replayZoomAnimating) return;
    const base = this._replayTransformCache || {
      x: this.data.replayViewX || 0,
      y: this.data.replayViewY || 0,
      scale: this.data.replayViewScale || 1
    };
    const baseline =
      typeof this._replayPinchBaselineScale === 'number' && !isNaN(this._replayPinchBaselineScale)
        ? this._replayPinchBaselineScale
        : 1;
    const s0 = base.scale;
    const x0 = base.x;
    const y0 = base.y;
    const vp = this._getReplayViewportPx();
    const w = vp.w;
    const h = vp.h;
    const sTarget = this._replayPickPinchSnapScale(baseline, s0);
    const fx =
      typeof this._replayPinchFocalX === 'number' && !isNaN(this._replayPinchFocalX)
        ? this._replayPinchFocalX
        : w * 0.5;
    const fy =
      typeof this._replayPinchFocalY === 'number' && !isNaN(this._replayPinchFocalY)
        ? this._replayPinchFocalY
        : h * 0.5;
    let x1;
    let y1;
    if (sTarget <= 1 + REPLAY_ZOOM_LEVEL_EPS) {
      x1 = 0;
      y1 = 0;
    } else {
      const sm = Math.max(0.001, s0);
      const ux = (fx - x0) / sm;
      const uy = (fy - y0) / sm;
      x1 = w * 0.5 - ux * sTarget;
      y1 = h * 0.5 - uy * sTarget;
      const cl = this._clampReplayPan(x1, y1, sTarget, w, h);
      x1 = cl.x;
      y1 = cl.y;
    }
    const skip =
      Math.abs(sTarget - s0) < REPLAY_PINCH_SNAP_EPS_SCALE &&
      Math.abs(x1 - x0) < REPLAY_PINCH_SNAP_EPS_PX &&
      Math.abs(y1 - y0) < REPLAY_PINCH_SNAP_EPS_PX;
    if (skip) return;
    this._runReplayPanZoomAnim(x0, y0, s0, x1, y1, sTarget, w, h, REPLAY_PINCH_SNAP_ANIM_MS);
  },

  /**
   * 将平移限制在 out-of-bounds=false 时的合法范围内：x∈[W(1-S),0]，y∈[H(1-S),0]。
   * S>1 时向内收缩少量像素，减轻与原生边界判定的竞态导致的回弹。
   * @param {number} x
   * @param {number} y
   * @param {number} scale
   * @param {number} w
   * @param {number} h
   * @returns {{ x: number, y: number }}
   */
  _clampReplayPan: function (x, y, scale, w, h) {
    const s = !scale || scale <= 0 || !Number.isFinite(scale) ? 1 : scale;
    const ww = Math.max(0, w);
    const hh = Math.max(0, h);
    let minX = ww * (1 - s);
    let minY = hh * (1 - s);
    let maxX = 0;
    let maxY = 0;
    if (s > 1 + 1e-6) {
      minX += REPLAY_PAN_CLAMP_EPS;
      minY += REPLAY_PAN_CLAMP_EPS;
      maxX -= REPLAY_PAN_CLAMP_EPS;
      maxY -= REPLAY_PAN_CLAMP_EPS;
    }
    let nx = Number.isFinite(x) ? x : 0;
    let ny = Number.isFinite(y) ? y : 0;
    if (nx > maxX) nx = maxX;
    if (nx < minX) nx = minX;
    if (ny > maxY) ny = maxY;
    if (ny < minY) ny = minY;
    return { x: nx, y: ny };
  },

  /**
   * 以屏幕坐标 (fx,fy) 为锚点执行双击缩放（含 300ms ease-out 动画）。
   * @param {number} fx
   * @param {number} fy
   * @returns {void}
   */
  _replayApplyDoubleTapZoom: function (fx, fy) {
    const t = this._replayTransformCache || {
      x: this.data.replayViewX || 0,
      y: this.data.replayViewY || 0,
      scale: this.data.replayViewScale || 1
    };
    const s0 = t.scale;
    if (s0 < 0.05) return;
    const s1 = this._nextReplayDiscreteScale(s0);
    const x0 = t.x;
    const y0 = t.y;
    const vp = this._getReplayViewportPx();
    const w = vp.w;
    const h = vp.h;
    this._runReplayZoomAnim(s0, x0, y0, s1, fx, fy, w, h);
  },

  /**
   * 使用 requestAnimationFrame 在 REPLAY_ZOOM_ANIM_MS 内插值 scale 与 x/y，保持锚点稳定。
   * @param {number} s0
   * @param {number} x0
   * @param {number} y0
   * @param {number} s1
   * @param {number} fx 锚点 x（视口 px）
   * @param {number} fy 锚点 y（视口 px）
   * @param {number} w
   * @param {number} h
   * @returns {void}
   */
  _runReplayZoomAnim: function (s0, x0, y0, s1, fx, fy, w, h) {
    this._cancelReplayZoomAnim();
    this._replayZoomAnimating = true;
    const tStart = Date.now();
    const tick = () => {
      const elapsed = Date.now() - tStart;
      const p = REPLAY_ZOOM_ANIM_MS <= 0 ? 1 : Math.min(1, elapsed / REPLAY_ZOOM_ANIM_MS);
      const e = this._easeOutCubic(p);
      const s = s0 + (s1 - s0) * e;
      const x = x0 - (s / s0 - 1) * (fx - x0);
      const y = y0 - (s / s0 - 1) * (fy - y0);
      const cl = this._clampReplayPan(x, y, s, w, h);
      this._replayTransformCache = { x: cl.x, y: cl.y, scale: s };
      if (p >= 1) {
        this._replayZoomRafId = null;
        this._replayZoomAnimating = false;
        const fin = this._clampReplayPan(
          x0 - (s1 / s0 - 1) * (fx - x0),
          y0 - (s1 / s0 - 1) * (fy - y0),
          s1,
          w,
          h
        );
        this._replayTransformCache = { x: fin.x, y: fin.y, scale: s1 };
        this.setData({
          replayViewScale: s1,
          replayViewX: fin.x,
          replayViewY: fin.y
        });
        return;
      }
      this.setData({
        replayViewScale: s,
        replayViewX: cl.x,
        replayViewY: cl.y
      });
      this._replayZoomRafId = wx.requestAnimationFrame(tick);
    };
    this._replayZoomRafId = wx.requestAnimationFrame(tick);
  },

  /**
   * 同步插值 x/y/scale（ease-out），用于捏合松手后的档位吸附 + 居中，避免突变闪屏。
   * @param {number} x0
   * @param {number} y0
   * @param {number} s0
   * @param {number} x1
   * @param {number} y1
   * @param {number} s1
   * @param {number} w
   * @param {number} h
   * @param {number} durationMs
   * @returns {void}
   */
  _runReplayPanZoomAnim: function (x0, y0, s0, x1, y1, s1, w, h, durationMs) {
    this._cancelReplayZoomAnim();
    this._replayZoomAnimating = true;
    const dur =
      typeof durationMs === 'number' && durationMs > 0 ? durationMs : REPLAY_PINCH_SNAP_ANIM_MS;
    const tStart = Date.now();
    const tick = () => {
      const elapsed = Date.now() - tStart;
      const p = dur <= 0 ? 1 : Math.min(1, elapsed / dur);
      const e = this._easeOutCubic(p);
      const s = s0 + (s1 - s0) * e;
      const x = x0 + (x1 - x0) * e;
      const y = y0 + (y1 - y0) * e;
      const cl = this._clampReplayPan(x, y, s, w, h);
      this._replayTransformCache = { x: cl.x, y: cl.y, scale: s };
      if (p >= 1) {
        this._replayZoomRafId = null;
        this._replayZoomAnimating = false;
        const fin = this._clampReplayPan(x1, y1, s1, w, h);
        this._replayTransformCache = { x: fin.x, y: fin.y, scale: s1 };
        this.setData({
          replayViewScale: s1,
          replayViewX: fin.x,
          replayViewY: fin.y
        });
        return;
      }
      this.setData({
        replayViewScale: s,
        replayViewX: cl.x,
        replayViewY: cl.y
      });
      this._replayZoomRafId = wx.requestAnimationFrame(tick);
    };
    this._replayZoomRafId = wx.requestAnimationFrame(tick);
  },

  flashPeriod: function () {
    this.setData({ periodFlash: true });
    setTimeout(() => this.setData({ periodFlash: false }), 160);
  },

  persistConfig: function () {
    const normalizedConfig = this.normalizeMatchConfig(this.data.matchConfig);
    this.setData({ matchConfig: normalizedConfig });
    wx.setStorageSync('matchConfig', normalizedConfig);
    app.globalData.matchConfig = normalizedConfig;

    // 将最新比分/节次实时回写到 MIAOXIE_MATCHES，保持首页数据同步
    const currentMatchId =
      wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    if (currentMatchId) {
      const matches = wx.getStorageSync('MIAOXIE_MATCHES');
      if (Array.isArray(matches)) {
        const idx = matches.findIndex((m) => m.id === currentMatchId);
        if (idx >= 0) {
          matches[idx] = {
            ...matches[idx],
            teamA: { ...matches[idx].teamA, score: normalizedConfig.teamA.score },
            teamB: { ...matches[idx].teamB, score: normalizedConfig.teamB.score },
            period: normalizedConfig.period
          };
          wx.setStorageSync('MIAOXIE_MATCHES', matches);
        }
      }
    }
  }
})
