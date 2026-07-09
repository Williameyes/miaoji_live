/**
 * 视录分离管线：camera 纯预览 + onCameraFrame 抽帧 + 乒乓 MediaRecorder。
 * 前台 <camera> 永不调用 startRecord/stopRecord。
 */

const frameSourceMod = require('../render/frame-source.js');
const { PingPongRecorder } = require('./ping-pong-recorder.js');

/** iOS 变焦过渡定格帧独立深拷贝缓存 */
let cachedHandoffFrame = null;

/** 录制目标画布宽（720p）。 */
const PREVIEW_RECORD_TARGET_CANVAS_W = 1280;
/** 录制目标画布高（720p）。 */
const PREVIEW_RECORD_TARGET_CANVAS_H = 720;
/** 预热测速至少帧数，不足则回退保守 fps。 */
const PREVIEW_RECORD_FPS_MEASURE_MIN_FRAMES = 8;
/** 测速窗口至少毫秒数。 */
const PREVIEW_RECORD_FPS_MEASURE_MIN_SPAN_MS = 320;
/** Android 1280×720 单轨 requestFrame 串行 p50 经验值（ms）。 */
const ANDROID_FEED_MS_BASE_720P = 78;

/**
 * @returns {boolean}
 */
function isAndroidPlatform() {
  try {
    return String(wx.getSystemInfoSync().platform || '').toLowerCase() === 'android';
  } catch (e) {
    return false;
  }
}

/**
 * Android 按 canvas 像素估算 requestFrame 可达 fps（探测失败时的保守回退）。
 * @param {number} canvasW
 * @param {number} canvasH
 * @returns {number}
 */
function estimateAndroidAchievableEncoderFps(canvasW, canvasH) {
  const pixels = Math.max(1, Math.floor(Number(canvasW) || 0) * Math.floor(Number(canvasH) || 0));
  const basePixels = PREVIEW_RECORD_TARGET_CANVAS_W * PREVIEW_RECORD_TARGET_CANVAS_H;
  const feedMs = ANDROID_FEED_MS_BASE_720P * Math.sqrt(pixels / basePixels);
  return Math.max(10, Math.min(24, Math.floor(1000 / (feedMs + 3))));
}

/**
 * @param {number} fps
 * @returns {number}
 */
function frameIntervalMs(fps) {
  const n = Number(fps);
  if (!Number.isFinite(n) || n <= 0) return 83;
  return Math.max(40, Math.floor(1000 / n));
}

/**
 * 根据预热阶段 onCameraFrame 送达间隔估算有效 fps，避免 MediaRecorder 声明帧率高于实际采帧导致快进。
 * @param {number} targetFpsCap 配置上限（如 24）
 * @param {number} firstFrameAt 首帧墙钟（ms）
 * @param {number} lastFrameAt 末帧墙钟（ms）
 * @param {number} frameCount 预热累计帧数
 * @returns {{ effectiveFps: number, measuredFps: number, fallback: boolean }}
 */
function computeAdaptiveRecordFps(targetFpsCap, firstFrameAt, lastFrameAt, frameCount) {
  const cap = Math.max(5, Math.min(24, Math.floor(Number(targetFpsCap) || 15)));
  const count = Math.max(0, Math.floor(Number(frameCount) || 0));
  const first = Math.floor(Number(firstFrameAt) || 0);
  const last = Math.floor(Number(lastFrameAt) || 0);
  const spanMs = last > first ? last - first : 0;
  if (count < PREVIEW_RECORD_FPS_MEASURE_MIN_FRAMES || spanMs < PREVIEW_RECORD_FPS_MEASURE_MIN_SPAN_MS) {
    /** 样本不足时用 15fps 保守值，避免声明过高导致快进。 */
    const safeFps = Math.min(cap, 15);
    return { effectiveFps: safeFps, measuredFps: 0, fallback: true };
  }
  const measured = ((count - 1) * 1000) / spanMs;
  const effectiveFps = Math.round(Math.max(5, Math.min(cap, measured)));
  return { effectiveFps, measuredFps: Math.round(measured * 10) / 10, fallback: false };
}

/**
 * 将相机帧尺寸对齐为 H.264 偶数像素。
 * forceTarget 为 true 时始终使用目标宽高（标准 16:9 / 9:16），相机帧经 cover 裁切后缩放。
 *
 * @param {number} frameW
 * @param {number} frameH
 * @param {number} targetW
 * @param {number} targetH
 * @param {boolean} [forceTarget]
 * @returns {{ width: number, height: number, upscaled: boolean }}
 */
function resolveEncoderCanvasSize(frameW, frameH, targetW, targetH, forceTarget) {
  const tw = Math.max(2, Math.floor(Number(targetW) || PREVIEW_RECORD_TARGET_CANVAS_W));
  const th = Math.max(2, Math.floor(Number(targetH) || PREVIEW_RECORD_TARGET_CANVAS_H));
  const evenW = tw - (tw % 2);
  const evenH = th - (th % 2);
  if (forceTarget) {
    let w = Math.max(2, Math.floor(Number(frameW) || evenW));
    let h = Math.max(2, Math.floor(Number(frameH) || evenH));
    w -= w % 2;
    h -= h % 2;
    const upscaled = h < evenH - 4 || w < evenW - 4;
    return { width: evenW, height: evenH, upscaled };
  }
  let w = Math.max(2, Math.floor(Number(frameW) || evenW));
  let h = Math.max(2, Math.floor(Number(frameH) || evenH));
  w -= w % 2;
  h -= h % 2;
  const upscaled = h < evenH - 4 || w < evenW - 4;
  if (upscaled) {
    return {
      width: evenW,
      height: evenH,
      upscaled: true
    };
  }
  return { width: w, height: h, upscaled: false };
}

/**
 * 创建视录分离管线。
 * @param {Object} page Live 页实例
 * @returns {{
 *   isSupported: function(): boolean,
 *   start: function(Object): Promise<void>,
 *   stop: function(): Promise<void>,
 *   destroy: function(): void,
 *   resolveHighlightSeek: function(number, number): Object|null,
 *   getSegments: function(): Array<Object>,
 *   isActive: function(): boolean
 * }}
 */
function createPreviewRecordPipeline(page) {
  let frameSource = null;
  let pingPong = null;
  let active = false;
  let handoffFrameHook = null;
  let lastFrameAt = 0;
  let frameInterval = frameIntervalMs(15);
  let feeding = false;
  /** MediaRecorder 声明 CFR（如 24）；与相机实测帧率解耦。 */
  let encoderFps = 24;
  /** CFR 泵：最新相机帧，供定频 feedFrame（不足目标 fps 时重复上一帧）。 */
  let latestFeedFrame = null;
  /** CFR 定频喂帧 timer。 */
  let cfrPumpTimer = null;
  /** CFR 墙钟锚点（ms），用于与 feed 耗时解耦。 */
  let cfrAnchorMs = 0;
  /** CFR 已调度 tick 序号（从 1 递增）。 */
  let cfrTickSeq = 0;
  /** feed 忙时错过的墙钟 tick 数，完成后以重复帧补回。 */
  let cfrMissedTicks = 0;
  /** 最近一次帧/轨道活动，供 segment watchdog 识别乒乓假死。 */
  let lastPipelineHeartbeatAt = 0;
  /** 相机送帧时间戳样本（供录制质量看门狗估算 fps）。 */
  let feedFrameTimestamps = [];
  /** feed 统计窗口（ms）。 */
  const FEED_STATS_WINDOW_MS = 5000;
  /** feed 统计最大样本数。 */
  const FEED_STATS_MAX_SAMPLES = 40;
  /** 当前 start() 是否已完成预热（收到足够帧）。 */
  let pipelineWarmedUp = false;
  /** 预热阶段累计帧数。 */
  let warmupFrameCount = 0;
  /** feedFrame 进行中起始时间，用于检测 requestFrame 挂死。 */
  let feedingSince = 0;
  /** 等待首帧回调默认超时（ms）。 */
  const PREVIEW_RECORD_FIRST_FRAME_TIMEOUT_MS = 3500;
  /** 预热最少帧数（remount 后相机首帧可能是静止缓存）。 */
  const PREVIEW_RECORD_WARMUP_MIN_FRAMES = 5;
  /** 本次 start 要求的预热最少帧数（可由 page 在 remount 后抬高）。 */
  let currentWarmupMinFrames = PREVIEW_RECORD_WARMUP_MIN_FRAMES;
  /** 本次 pipeline start 墙钟起点，供首帧 lag 诊断。 */
  let pipelineStartAt = 0;
  /** @type {Array<function(): void>} */
  let warmupWaiters = [];
  /** 相机预热阶段采样到的帧尺寸，供延后初始化离屏 canvas。 */
  let lastWarmupFrameW = 0;
  let lastWarmupFrameH = 0;
  /** 预热测速：首帧与末帧墙钟（ms）。 */
  let warmupFirstFrameAt = 0;
  let warmupLastFrameAt = 0;
  /**
   * 每次 start() 自增；stop() 时归 0；start() 时分配给当前 pingPong 实例。
   * 切换场次时 pipeline.stop() 触发 pingPong 内部的强制收尾，
   * 由旧 pingPong 闭包发出的 onSegmentReady 必须能识别为"过期"并丢弃，
   * 否则上一场次的 chunk 会回写到刚被 reset 清空的 page.rollingSegments，
   * 污染 segmentCounter、_lastSuccessfulChunkAt 等状态，并误触 _tryGenerateHighlight。
   */
  let activeSessionId = 0;

  /**
   * 记录相机送帧时间戳，供 getCameraFeedStats 估算有效 fps。
   * @param {number} now
   * @returns {void}
   */
  function recordFeedFrameTimestamp(now) {
    feedFrameTimestamps.push(now);
    if (feedFrameTimestamps.length > FEED_STATS_MAX_SAMPLES) {
      feedFrameTimestamps.shift();
    }
  }

  /**
   * 获取近期相机送帧统计（滑动窗口）。
   * @returns {{ fps: number, frameCount: number, windowMs: number }}
   */
  function getCameraFeedStats() {
    const now = Date.now();
    const cutoff = now - FEED_STATS_WINDOW_MS;
    const inWindow = feedFrameTimestamps.filter((ts) => ts >= cutoff);
    let fps = 0;
    if (inWindow.length >= 2) {
      const spanSec = Math.max(0.001, (inWindow[inWindow.length - 1] - inWindow[0]) / 1000);
      fps = Math.round(((inWindow.length - 1) / spanSec) * 10) / 10;
    }
    return {
      fps,
      frameCount: inWindow.length,
      windowMs: FEED_STATS_WINDOW_MS
    };
  }

  /**
   * 清空送帧统计样本。
   * @returns {void}
   */
  function resetFeedFrameStats() {
    feedFrameTimestamps = [];
  }

  /**
   * 停止 CFR 定频喂帧泵。
   * @returns {void}
   */
  function stopCfrPump() {
    if (cfrPumpTimer) {
      clearTimeout(cfrPumpTimer);
      cfrPumpTimer = null;
    }
    cfrAnchorMs = 0;
    cfrTickSeq = 0;
    cfrMissedTicks = 0;
  }

  /**
   * 将 latestFeedFrame 送入编码器（单飞，避免 requestFrame 并发）。
   * @returns {Promise<void>}
   */
  function feedLatestFrameToEncoder() {
    if (!active || !pingPong || !latestFeedFrame) {
      return Promise.resolve();
    }
    if (feeding) {
      cfrMissedTicks += 1;
      return Promise.resolve();
    }
    const now = Date.now();
    if (now - lastPipelineHeartbeatAt >= 5000) {
      touchPipelineHeartbeat('frame_feed');
    }
    feeding = true;
    feedingSince = now;
    lastFrameAt = now;
    return pingPong.feedFrame(latestFeedFrame).finally(() => {
      feeding = false;
      feedingSince = 0;
      /** 补回 feed 阻塞期间错过的墙钟 tick（重复上一帧，保证 1.0x）。 */
      const catchup = Math.min(4, cfrMissedTicks);
      cfrMissedTicks -= catchup;
      if (catchup <= 0 || !active || !pingPong || !latestFeedFrame) {
        return undefined;
      }
      let left = catchup;
      const chainCatchup = () => {
        if (left <= 0 || !active || !pingPong || !latestFeedFrame) {
          return Promise.resolve();
        }
        if (feeding) {
          cfrMissedTicks += left;
          return Promise.resolve();
        }
        left -= 1;
        feeding = true;
        feedingSince = Date.now();
        return pingPong.feedFrame(latestFeedFrame).finally(() => {
          feeding = false;
          feedingSince = 0;
          return chainCatchup();
        });
      };
      return chainCatchup();
    });
  }

  /**
   * 按 encoderFps 墙钟定频喂帧；调度与 feed 完成解耦，相机帧不足时重复上一帧。
   * @returns {void}
   */
  function scheduleCfrPumpTick() {
    if (!active || !pingPong) return;
    const intervalMs = frameIntervalMs(encoderFps);
    if (!cfrAnchorMs) {
      cfrAnchorMs = Date.now();
      cfrTickSeq = 0;
    }
    cfrTickSeq += 1;
    const targetAt = cfrAnchorMs + (cfrTickSeq - 1) * intervalMs;
    let delay = targetAt - Date.now();
    /** 落后超过 1s 则重置锚点，避免长时间暂停后突发补帧。 */
    if (delay < -1000) {
      cfrAnchorMs = Date.now();
      cfrTickSeq = 1;
      cfrMissedTicks = 0;
      delay = 0;
    }
    cfrPumpTimer = setTimeout(() => {
      cfrPumpTimer = null;
      if (feedingSince > 0 && Date.now() - feedingSince > 1200) {
        log('preview_record_feeding_force_reset', {
          stuckMs: Date.now() - feedingSince
        });
        feeding = false;
        feedingSince = 0;
      }
      feedLatestFrameToEncoder();
      scheduleCfrPumpTick();
    }, Math.max(0, delay));
  }

  /**
   * @param {number} fps
   * @returns {void}
   */
  function startCfrPump(fps) {
    stopCfrPump();
    encoderFps = Math.max(5, Math.min(24, Math.floor(Number(fps) || 15)));
    frameInterval = frameIntervalMs(encoderFps);
    scheduleCfrPumpTick();
  }

  /**
   * 读取当前 CFR 喂帧帧率（MediaRecorder 声明 fps 不变，仅调节喂帧频率）。
   * @returns {number}
   */
  function getCfrPumpFps() {
    return encoderFps;
  }

  /**
   * 动态调整 CFR 喂帧帧率；回放降载时降至 15fps，退出后恢复。
   * @param {number} fps
   * @returns {number} 调整前的帧率
   */
  function setCfrPumpFps(fps) {
    const prev = encoderFps;
    const next = Math.max(5, Math.min(24, Math.floor(Number(fps) || 15)));
    if (active) {
      startCfrPump(next);
    } else {
      encoderFps = next;
      frameInterval = frameIntervalMs(encoderFps);
    }
    return prev;
  }

  /** @type {number} 回放暂停 CFR 前保存的帧率。 */
  let cfrFeedPausedSavedFps = 0;

  /**
   * 回放期间降低 CFR 喂帧（重复上一帧），不得完全 stop：MediaRecorder 仍 recording 时停喂会在 mp4 时间轴留下空洞。
   * @param {number} [throttleFps] 目标 fps，默认 10
   * @returns {number} 降帧前的 CFR 帧率
   */
  function pauseCfrFeed(throttleFps) {
    const prev = encoderFps;
    cfrFeedPausedSavedFps = prev;
    const cap = Math.max(5, Math.min(24, Math.floor(Number(throttleFps) || 10)));
    const next = Math.max(5, Math.min(prev > 0 ? prev : 24, cap));
    if (active) {
      startCfrPump(next);
    } else {
      encoderFps = next;
      frameInterval = frameIntervalMs(encoderFps);
    }
    return prev;
  }

  /**
   * 退出回放后恢复 CFR 喂帧。
   * @param {number} [fps]
   * @returns {void}
   */
  function resumeCfrFeed(fps) {
    const next = Math.max(
      5,
      Math.min(24, Math.floor(Number(fps) || cfrFeedPausedSavedFps || encoderFps || 15))
    );
    cfrFeedPausedSavedFps = 0;
    if (active) {
      startCfrPump(next);
    } else {
      encoderFps = next;
      frameInterval = frameIntervalMs(encoderFps);
    }
  }

  /**
   * 动态调整 ping-pong 新建编码器档位与 CFR 喂帧。
   * @param {{ fps?: number, videoBitsPerSecondKbps?: number, cfrPumpFps?: number }} profile
   * @returns {void}
   */
  function setRecordingProfile(profile) {
    if (!profile || typeof profile !== 'object') return;
    if (pingPong && typeof pingPong.setRecordingProfile === 'function') {
      pingPong.setRecordingProfile(profile);
    }
    if (Number.isFinite(Number(profile.cfrPumpFps)) && active) {
      setCfrPumpFps(Number(profile.cfrPumpFps));
    } else if (Number.isFinite(Number(profile.fps)) && active) {
      setCfrPumpFps(Number(profile.fps));
    }
  }

  /**
   * 点击时刻可用于高光前导的最大毫秒数。
   * @param {number} clickTime
   * @param {number} [requestedLeadMs]
   * @returns {number}
   */
  function getMaxAvailableHighlightLeadMs(clickTime, requestedLeadMs) {
    if (!pingPong || typeof pingPong.getMaxAvailableHighlightLeadMs !== 'function') return 0;
    return pingPong.getMaxAvailableHighlightLeadMs(clickTime, requestedLeadMs);
  }

  /**
   * 更新 CFR 帧缓存（iOS 使用深拷贝后的 handoff 帧，避免 buffer 被覆写）。
   * @param {{ data: ArrayBuffer, width: number, height: number }} frame
   * @returns {void}
   */
  function updateLatestFeedFrame(frame) {
    if (!frame || !frame.data || !frame.width || !frame.height) return;
    let isIos = false;
    try {
      isIos = wx.getSystemInfoSync().platform === 'ios';
    } catch (e) {}
    if (isIos && cachedHandoffFrame) {
      latestFeedFrame = cachedHandoffFrame;
      return;
    }
    latestFeedFrame = frame;
  }

  /**
   * @param {string} eventName
   * @param {Object} [detail]
   */
  function touchPipelineHeartbeat(reason) {
    const now = Date.now();
    lastPipelineHeartbeatAt = now;
    if (page) {
      page._previewRecordLastHeartbeatAt = now;
      page.lastSegmentAt = now;
    }
  }
  function log(eventName, detail) {
    if (page && typeof page.appendHealthLog === 'function') {
      page.appendHealthLog(eventName, detail || {});
    }
    if (
      (eventName === 'ping_pong_persist_save_fail' || eventName === 'ping_pong_persist_not_ready')
      && page
      && typeof page.freeRollingFileStorageAggressive === 'function'
    ) {
      page.freeRollingFileStorageAggressive('persist_io_fail');
    }
  }

  /**
   * 等待 onCameraFrame 连续输出足够帧后再启动 MediaRecorder。
   * @param {number} maxMs
   * @param {number} [minFrames]
   * @returns {Promise<void>}
   */
  function waitForWarmupFrames(maxMs, minFrames) {
    if (pipelineWarmedUp) return Promise.resolve();
    const limitMs = Math.max(1200, Number(maxMs) || PREVIEW_RECORD_FIRST_FRAME_TIMEOUT_MS);
    const needFrames = Math.max(1, Number(minFrames) || PREVIEW_RECORD_WARMUP_MIN_FRAMES);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        warmupWaiters = warmupWaiters.filter((fn) => fn !== onWarmupReady);
        if (warmupFrameCount >= needFrames) {
          pipelineWarmedUp = true;
          log('preview_record_warmup_ready', {
            frameCount: warmupFrameCount,
            needFrames,
            elapsedMs: pipelineStartAt > 0 ? Date.now() - pipelineStartAt : 0,
            via: 'timeout_frame_count'
          });
          resolve();
          return;
        }
        log('preview_record_warmup_timeout', { maxMs: limitMs, frameCount: warmupFrameCount, needFrames });
        reject(new Error('first frame timeout'));
      }, limitMs);
      const onWarmupReady = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        warmupWaiters = warmupWaiters.filter((fn) => fn !== onWarmupReady);
        resolve();
      };
      if (warmupFrameCount >= needFrames) {
        onWarmupReady();
        return;
      }
      warmupWaiters.push(onWarmupReady);
    });
  }

  /**
   * @param {{ data: ArrayBuffer, width: number, height: number }} frame
   * @returns {void}
   */
  function onFrame(frame) {
    const now = Date.now();
    if (frame && frame.width > 0 && frame.height > 0 && frame.data) {
      lastWarmupFrameW = frame.width;
      lastWarmupFrameH = frame.height;

      // iOS 环境下对像素数据进行深拷贝
      let isIos = false;
      try {
        isIos = wx.getSystemInfoSync().platform === 'ios';
      } catch (e) {}
      if (isIos) {
        try {
          const buf = new ArrayBuffer(frame.data.byteLength);
          new Uint8Array(buf).set(new Uint8Array(frame.data));
          cachedHandoffFrame = {
            width: frame.width,
            height: frame.height,
            data: buf
          };
        } catch (eCopy) {
          // ignore
        }
      }
    }

    if (handoffFrameHook) {
      try {
        let isIos = false;
        try {
          isIos = wx.getSystemInfoSync().platform === 'ios';
        } catch (e) {}
        if (isIos && cachedHandoffFrame) {
          handoffFrameHook(cachedHandoffFrame, now);
        } else {
          handoffFrameHook(frame, now);
        }
      } catch (eHook) {
        /* ignore */
      }
    }

    if (pingPong) {
      pingPong._lastCameraFrame = frame;
    }
    if (!pipelineWarmedUp) {
      warmupFrameCount += 1;
      if (warmupFrameCount === 1) {
        warmupFirstFrameAt = now;
        const lagMs = pipelineStartAt > 0 ? now - pipelineStartAt : 0;
        log('preview_record_first_frame', {
          lagMs,
          width: frame && frame.width ? frame.width : 0,
          height: frame && frame.height ? frame.height : 0
        });
        if (page) {
          page._previewRecordFirstFrameAt = now;
        }
      }
      warmupLastFrameAt = now;
      const needFrames = currentWarmupMinFrames || PREVIEW_RECORD_WARMUP_MIN_FRAMES;
      if (warmupFrameCount >= needFrames) {
        pipelineWarmedUp = true;
        log('preview_record_warmup_ready', {
          frameCount: warmupFrameCount,
          needFrames,
          elapsedMs: pipelineStartAt > 0 ? now - pipelineStartAt : 0,
          warmupSpanMs: warmupFirstFrameAt > 0 ? now - warmupFirstFrameAt : 0
        });
        const waiters = warmupWaiters.splice(0, warmupWaiters.length);
        waiters.forEach((fn) => {
          try { fn(); } catch (eWait) { /* ignore */ }
        });
      }
    }
    if (!active || !pingPong) return;
    recordFeedFrameTimestamp(now);
    updateLatestFeedFrame(frame);
  }

  /**
   * 真正写回 page 状态的 segment 处理；调用方负责保证 segment 来自当前会话。
   * @param {Object} segment
   */
  function applySegmentToPage(segment) {
    if (!page) return;
    const wallMs = Math.max(0, (segment.endTime || 0) - (segment.startTime || 0));
    const sizeBytes = segment.sizeBytes || 0;
    const isHealthy = typeof page._isRollingSegmentQualityHealthy === 'function'
      ? page._isRollingSegmentQualityHealthy(sizeBytes, wallMs)
      : sizeBytes > 50 * 1024;

    const recoverPending = !!(page._liveReturnedFromBackground || page._liveNeedsForegroundRecordingRecover);
    const pageVisible = !!(page && page._livePageVisible);
    if (typeof page._handleDegradedRollingSegment === 'function') {
      if (
        recoverPending
        && pageVisible
        && wallMs >= 8000
        && !isHealthy
      ) {
        page._handleDegradedRollingSegment(segment);
        return;
      }
    }
    if (
      pageVisible
      && wallMs >= 30000
      && typeof page._handleThermalRollingSegment === 'function'
    ) {
      page._handleThermalRollingSegment(segment);
    }
    const now = Date.now();
    page.lastSegmentAt = now;
    page._lastSuccessfulChunkAt = now;
    touchPipelineHeartbeat('segment_ready');
    page.rollingSegments = page.rollingSegments || [];
    page.rollingSegments.push(Object.assign({}, segment, {
      pipelineEpoch: page._rollingPipelineEpoch || 0
    }));
    while (page.rollingSegments.length > (page.rollingBufferMax || 8)) {
      page.rollingSegments.shift();
    }
    page.segmentBuffer = page.rollingSegments;
    page.segmentCounter = (page.segmentCounter || 0) + 1;
    page.setData({ isRecording: true });
    if (page._awaitingFirstSuccessChunkAfterRemount && isHealthy && pageVisible) {
      page._awaitingFirstSuccessChunkAfterRemount = false;
      if (page._awaitingChunkTimeout) {
        clearTimeout(page._awaitingChunkTimeout);
        page._awaitingChunkTimeout = null;
      }
      if (typeof page.appendHealthLog === 'function') {
        page.appendHealthLog('awaiting_first_chunk_cleared_by_segment', {
          sizeBytes,
          wallDurationMs: wallMs
        });
      }
    }
    // 仅在前台新管线落盘健康段后解除恢复锁；page_hide 期间旧管线 shutdown 段不得提前清标志。
    if (recoverPending && isHealthy && pageVisible) {
      page._previewRecordEncoderVerified = true;
      page._encoderVerifyRestartAttempts = 0;
      page._liveReturnedFromBackground = false;
      page._liveNeedsForegroundRecordingRecover = false;
      page._highlightHollowFlushStreak = 0;
      page._encodeStallGraceUntil = 0;
      page._hardRecoverHadTimeoutRebuild = false;
      page._lastSuccessfulChunkAt = now;
      if (typeof page.appendHealthLog === 'function') {
        page.appendHealthLog('preview_record_quality_restored', {
          trackId: segment.trackId || '',
          sizeBytes,
          wallDurationMs: wallMs,
          bytesPerSec: wallMs > 0 ? Math.round(sizeBytes / Math.max(1, wallMs / 1000)) : 0
        });
      }
    }
    if (typeof page._tryGenerateHighlight === 'function') {
      page._tryGenerateHighlight();
    }
    if (typeof page.updatePipelineHealth === 'function') {
      page.updatePipelineHealth();
    }
  }

  /**
   * @returns {boolean}
   */
  function isSupported() {
    return PingPongRecorder.isApiSupported();
  }

  /** @type {Promise<void>|null} 串行化 stop→start，避免旧 PingPong 未 destroy 时新建实例。 */
  let stopInFlight = null;

  /**
   * @param {Object} opts
   * @returns {Promise<void>}
   */
  function start(opts) {
    const options = opts || {};
    const runStart = () => {
      if (active) return Promise.resolve();
      if (!isSupported()) {
        return Promise.reject(new Error('preview-record unsupported'));
      }
      const cameraContext = options.cameraContext || (page && page.data && page.data.cameraContext);
      if (!cameraContext) {
        return Promise.reject(new Error('cameraContext missing'));
      }
      const rollingDir = typeof page.getRollingDir === 'function' ? page.getRollingDir() : '';
      const ensureRollingDir = typeof page.ensureRollingDir === 'function'
        ? () => page.ensureRollingDir()
        : () => Promise.resolve(rollingDir);
      const targetFpsCap = Math.max(5, Math.min(24, Number(options.fps) || 15));
      /**
       * 给本次 pingPong 实例分配独立 sessionId；绑定到 boundOnSegmentReady 闭包内，
       * stop() 后再有同一实例的迟到 segment 时，sessionId 已不匹配，自动丢弃。
       */
      activeSessionId += 1;
      const instanceSessionId = activeSessionId;
      resetFeedFrameStats();
      const pipelineEpoch = page
        ? (page._rollingPipelineEpoch = (page._rollingPipelineEpoch || 0) + 1)
        : 0;
      /**
       * @param {Object} segment
       */
      const boundOnSegmentReady = (segment) => {
        const epochStale = !!(page && page._rollingPipelineEpoch !== pipelineEpoch);
        const sessionStale = instanceSessionId !== activeSessionId;
        if (epochStale || sessionStale) {
          log('preview_record_stale_segment_dropped', {
            path: segment && segment.path ? segment.path : '',
            trackId: segment && segment.trackId ? segment.trackId : '',
            instanceSessionId,
            activeSessionId,
            pipelineEpoch,
            pageEpoch: page ? page._rollingPipelineEpoch : 0,
            active,
            startTime: segment && segment.startTime ? segment.startTime : 0,
            endTime: segment && segment.endTime ? segment.endTime : 0,
            sizeBytes: segment && segment.sizeBytes ? segment.sizeBytes : 0
          });
          return;
        }
        if (page && !page._livePageVisible) {
          log('preview_record_segment_skip_hidden', {
            trackId: segment && segment.trackId ? segment.trackId : '',
            sizeBytes: segment && segment.sizeBytes ? segment.sizeBytes : 0,
            pathTail: segment && segment.path ? String(segment.path).slice(-48) : ''
          });
          return;
        }
        applySegmentToPage(segment);
      };
      pipelineWarmedUp = false;
      warmupFrameCount = 0;
      lastWarmupFrameW = 0;
      lastWarmupFrameH = 0;
      warmupFirstFrameAt = 0;
      warmupLastFrameAt = 0;
      pipelineStartAt = Date.now();
      warmupWaiters = [];
      feeding = false;
      feedingSince = 0;
      const targetCanvasW = Number(options.canvasWidth) || PREVIEW_RECORD_TARGET_CANVAS_W;
      const targetCanvasH = Number(options.canvasHeight) || PREVIEW_RECORD_TARGET_CANVAS_H;
      let capturedCanvasW = targetCanvasW;
      let capturedCanvasH = targetCanvasH;
      const requireFirstFrame = options.requireFirstFrame !== false;
      const firstFrameTimeoutMs = Number(options.firstFrameTimeoutMs) || PREVIEW_RECORD_FIRST_FRAME_TIMEOUT_MS;
      const deferEncoderInit = !!options.deferEncoderInit;
      const forceTargetCanvasSize = !!options.forceTargetCanvasSize;
      currentWarmupMinFrames = Math.max(
        PREVIEW_RECORD_WARMUP_MIN_FRAMES,
        Number(options.warmupMinFrames) || PREVIEW_RECORD_WARMUP_MIN_FRAMES
      );
      /**
       * 创建乒乓实例（可在相机预热后按真实帧尺寸初始化离屏 canvas）。
       * @returns {void}
       */
      const mountPingPong = () => {
        pingPong = new PingPongRecorder({
          onLog: log,
          onSegmentReady: boundOnSegmentReady,
          onTrackActivity: () => touchPipelineHeartbeat('track_start'),
          onStoragePressure: (reason) => {
            if (page && typeof page.freeRollingFileStorageAggressive === 'function') {
              page.freeRollingFileStorageAggressive(reason || 'persist_io_fail');
            }
            return Promise.resolve();
          },
          onFatal: (err) => {
            log('preview_record_webgl_fatal', { err: err ? err.message : '' });
            if (page && typeof page.onWebGLContextFatal === 'function') {
              page.onWebGLContextFatal();
            }
          },
          rollingDir,
          ensureRollingDir,
          chunkDurationMs: options.chunkDurationMs || 180000,
          staggerMs: options.staggerMs || 8000,
          highlightFlushMinIntervalMs: options.highlightFlushMinIntervalMs || 10000,
          fps: encoderFps,
          stopToStartGapMs: options.stopToStartGapMs || 400,
          recycleIntervalMs: options.recycleIntervalMs || 25 * 60 * 1000,
          maxFiles: options.maxFiles || 2,
          canvasWidth: capturedCanvasW,
          canvasHeight: capturedCanvasH,
          videoBitsPerSecondKbps: Number(options.videoBitsPerSecondKbps) || 0,
          encoderLiveWarmupFrames: Number(options.encoderLiveWarmupFrames) || 0,
          probeChunkDurationMs: Math.max(0, Number(options.probeChunkDurationMs) || 0)
        });
      };
      const startFrameSource = () => {
        frameSource = frameSourceMod.createNativeFrameSource({
          cameraContext,
          onFrame,
          minIntervalMs: 0
        });
        return frameSource.start();
      };
      const afterWarmup = () => {
        if (!requireFirstFrame) {
          pipelineWarmedUp = true;
          return Promise.resolve();
        }
        return waitForWarmupFrames(firstFrameTimeoutMs, currentWarmupMinFrames);
      };
      const bootEncoder = () => {
        const adaptive = computeAdaptiveRecordFps(
          targetFpsCap,
          warmupFirstFrameAt,
          warmupLastFrameAt,
          warmupFrameCount
        );
        /** 编码器 CFR：iOS 用目标 fps；Android 在 canvas 尺寸确定后再保守估计，启动前再实测校准。 */
        encoderFps = targetFpsCap;
        if (deferEncoderInit && lastWarmupFrameW > 0 && lastWarmupFrameH > 0) {
          const sized = resolveEncoderCanvasSize(
            lastWarmupFrameW,
            lastWarmupFrameH,
            targetCanvasW,
            targetCanvasH,
            forceTargetCanvasSize
          );
          capturedCanvasW = sized.width;
          capturedCanvasH = sized.height;
          log('preview_record_encoder_canvas_sized', {
            sourceWidth: lastWarmupFrameW,
            sourceHeight: lastWarmupFrameH,
            width: capturedCanvasW,
            height: capturedCanvasH,
            upscaled: sized.upscaled,
            forceTarget: forceTargetCanvasSize,
            targetWidth: targetCanvasW,
            targetHeight: targetCanvasH
          });
        } else {
          capturedCanvasW = targetCanvasW - (targetCanvasW % 2);
          capturedCanvasH = targetCanvasH - (targetCanvasH % 2);
        }
        if (isAndroidPlatform()) {
          encoderFps = Math.min(
            targetFpsCap,
            estimateAndroidAchievableEncoderFps(capturedCanvasW, capturedCanvasH)
          );
        }
        frameInterval = frameIntervalMs(encoderFps);
        log('preview_record_adaptive_fps', {
          targetFpsCap,
          encoderFps,
          measuredCameraFps: adaptive.measuredFps,
          cfrFrameDuplication: adaptive.measuredFps > 0 && adaptive.measuredFps < targetFpsCap - 0.5,
          fallback: adaptive.fallback,
          androidFeedEstimate: isAndroidPlatform(),
          warmupFrameCount,
          warmupSpanMs: warmupLastFrameAt > warmupFirstFrameAt
            ? warmupLastFrameAt - warmupFirstFrameAt
            : 0
        });
        mountPingPong();
        return pingPong.init();
      };
      /**
       * Android：启动录制前实测 requestFrame 吞吐，使 MediaRecorder fps 与可达编码率一致。
       * @returns {Promise<void>}
       */
      const calibrateAndroidEncoderFpsIfNeeded = () => {
        if (!isAndroidPlatform() || !pingPong) {
          return Promise.resolve();
        }
        const probeFrame = latestFeedFrame;
        if (!probeFrame) {
          return Promise.resolve();
        }
        return pingPong.probeRequestFrameThroughput(probeFrame, 6).then((result) => {
          const p50 = Number(result && result.p50Ms) || 0;
          const suggested = Number(result && result.suggestedFps) || encoderFps;
          if (p50 >= 20 && suggested > 0 && suggested < encoderFps) {
            encoderFps = suggested;
            pingPong.fps = suggested;
            frameInterval = frameIntervalMs(encoderFps);
          } else if (p50 >= 20 && suggested > encoderFps && suggested <= targetFpsCap) {
            encoderFps = suggested;
            pingPong.fps = suggested;
            frameInterval = frameIntervalMs(encoderFps);
          }
          log('preview_record_android_feed_probe', {
            p50Ms: p50,
            encoderFps,
            targetFpsCap,
            canvasWidth: capturedCanvasW,
            canvasHeight: capturedCanvasH
          });
        });
      };
      const activatePipeline = () => {
        active = true;
        return pingPong.start();
      };
      const finishPipelineStart = () => {
        touchPipelineHeartbeat('pipeline_start');
        startCfrPump(encoderFps);
        if (page) {
          page.lastRecordStartAt = Date.now();
          page.setData({ isRecording: true });
        }
        log('preview_record_pipeline_start', {
          targetFpsCap,
          encoderFps,
          sessionId: instanceSessionId,
          requireFirstFrame,
          warmupMinFrames: currentWarmupMinFrames,
          deferEncoderInit,
          canvasWidth: capturedCanvasW,
          canvasHeight: capturedCanvasH,
          sourceFrameWidth: lastWarmupFrameW,
          sourceFrameHeight: lastWarmupFrameH
        });
      };
      const handleStartError = (err) => {
        stopCfrPump();
        latestFeedFrame = null;
        if (frameSource) {
          frameSource.stop();
          frameSource = null;
        }
        if (pingPong) {
          pingPong.destroy();
          pingPong = null;
        }
        pipelineWarmedUp = false;
        warmupFrameCount = 0;
        warmupFirstFrameAt = 0;
        warmupLastFrameAt = 0;
        pipelineStartAt = 0;
        warmupWaiters = [];
        feeding = false;
        feedingSince = 0;
        active = false;
        throw err;
      };
      const bootChain = deferEncoderInit
        ? startFrameSource().then(afterWarmup).then(bootEncoder)
        : bootEncoder().then(startFrameSource).then(afterWarmup);
      return bootChain
        .then(() => calibrateAndroidEncoderFpsIfNeeded())
        .then(activatePipeline)
        .then(finishPipelineStart)
        .catch(handleStartError);
    };
    if (stopInFlight) {
      return stopInFlight.then(() => runStart());
    }
    return runStart();
  }

  /**
   * @returns {Promise<void>}
   */
  function stop() {
    /**
     * 先 active=false：pp.stop() 内部会让正在录的轨走 _stopTrack('shutdown') → finalize → onSegmentReady，
     * 这些迟到 segment 通过 boundOnSegmentReady 的 active/sessionId 校验被丢弃，
     * 不再污染新场次的 page.rollingSegments / segmentCounter / _lastSuccessfulChunkAt。
     */
    active = false;
    stopCfrPump();
    resetFeedFrameStats();
    latestFeedFrame = null;
    pipelineWarmedUp = false;
    warmupFrameCount = 0;
    warmupFirstFrameAt = 0;
    warmupLastFrameAt = 0;
    pipelineStartAt = 0;
    warmupWaiters = [];
    feeding = false;
    feedingSince = 0;
    handoffFrameHook = null;
    cachedHandoffFrame = null;
    if (frameSource) {
      frameSource.stop();
      frameSource = null;
    }
    const pp = pingPong;
    pingPong = null;
    if (page) {
      page.setData({ isRecording: false });
      page.lastRecordStartAt = 0;
    }
    if (!pp) {
      stopInFlight = Promise.resolve();
      return stopInFlight;
    }
    stopInFlight = pp.destroy().then(() => {
      log('preview_record_pipeline_stop', { destroyed: true });
    }).catch((err) => {
      log('preview_record_pipeline_stop_fail', {
        err: String(err && err.message || err).slice(0, 120)
      });
    });
    return stopInFlight;
  }

  /**
   * @returns {Promise<void>}
   */
  function destroy() {
    return stop();
  }

  /**
   * @param {number} clickTime
   * @param {number} leadMs
   * @returns {{ path: string, replayInitialTimeSec: number, replayMediaStopAtSec: number }|null}
   */
  function resolveHighlightSeek(clickTime, leadMs) {
    if (!pingPong) return null;
    return pingPong.resolveHighlightSeek(clickTime, leadMs);
  }

  /**
   * @param {number} clickTime
   * @param {number} leadMs
   * @returns {Promise<{ path: string, replayInitialTimeSec: number, replayMediaStopAtSec: number }|null>}
   */
  function flushAndResolveHighlightSeek(clickTime, leadMs) {
    if (!pingPong || typeof pingPong.flushAndResolveHighlightSeek !== 'function') {
      return Promise.resolve(resolveHighlightSeek(clickTime, leadMs));
    }
    return pingPong.flushAndResolveHighlightSeek(clickTime, leadMs);
  }

  /**
   * @returns {Array<Object>}
   */
  function getSegments() {
    if (!pingPong) return [];
    return pingPong.snapshotSegments();
  }

  /**
   * 当前应保留在磁盘上的 rolling 路径（热层 + pin），供沙盒 GC keepSet。
   * @returns {string[]}
   */
  function getActiveDiskPaths() {
    if (!pingPong || typeof pingPong.getActiveDiskPaths !== 'function') return [];
    return pingPong.getActiveDiskPaths();
  }

  /**
   * @returns {boolean}
   */
  function isActive() {
    return active;
  }

  /**
   * @param {string[]} paths
   */
  function pinPaths(paths) {
    if (pingPong) pingPong.pinPaths(paths);
  }

  /**
   * @param {string[]} paths
   */
  function unpinPaths(paths) {
    if (pingPong) pingPong.unpinPaths(paths);
  }

  /**
   * @param {string[]} paths
   */
  function releaseSegmentPaths(paths) {
    if (pingPong && typeof pingPong.releaseSegmentPaths === 'function') {
      pingPong.releaseSegmentPaths(paths);
    }
  }

  /**
   * @returns {number}
   */
  function getLastHeartbeatAt() {
    return lastPipelineHeartbeatAt;
  }

  /**
   * @returns {number}
   */
  function getRecordingTrackCount() {
    if (!pingPong || typeof pingPong.getRecordingTrackCount !== 'function') return 0;
    return pingPong.getRecordingTrackCount();
  }

  /**
   * @returns {boolean}
   */
  function isEncoderWarmupComplete() {
    if (!pingPong || typeof pingPong.isEncoderWarmupComplete !== 'function') return true;
    return pingPong.isEncoderWarmupComplete();
  }

  /**
   * 外部触发双轨健康巡检（如高光失败时）。
   * @returns {void}
   */
  function ensureDualTrackHealth() {
    if (pingPong && typeof pingPong._ensureDualTrackHealth === 'function') {
      pingPong._ensureDualTrackHealth();
    }
  }

  /**
   * 是否存在僵尸录制轨。
   * @returns {boolean}
   */
  function hasZombieTracks() {
    if (!pingPong || typeof pingPong.hasZombieTracks !== 'function') return false;
    return pingPong.hasZombieTracks();
  }

  /**
   * 回收僵尸录制轨。
   * @param {string} [source]
   * @returns {void}
   */
  function recoverZombieTracks(source) {
    if (pingPong && typeof pingPong.recoverZombieTracks === 'function') {
      pingPong.recoverZombieTracks(source);
    }
  }

  /**
   * remount 探针超时后强制轮换 A 轨，尽快落盘以验证编码器。
   * @param {string} [trackId]
   * @returns {void}
   */
  function forceProbeRotate(trackId) {
    if (!pingPong || !active) return;
    const tid = trackId || 'A';
    if (typeof pingPong._rotateTrack === 'function') {
      pingPong._rotateTrack(tid, 'encoding_probe').catch(() => { });
    }
  }

  function getLastCameraFrame() {
    let isIos = false;
    try {
      isIos = wx.getSystemInfoSync().platform === 'ios';
    } catch (e) {}
    if (!isIos) return null;
    return cachedHandoffFrame;
  }

  function clearLastCameraFrame() {
    cachedHandoffFrame = null;
  }

  function setHandoffFrameHook(fn) {
    handoffFrameHook = typeof fn === 'function' ? fn : null;
  }

  function clearHandoffFrameHook() {
    handoffFrameHook = null;
  }

  return {
    isSupported,
    start,
    stop,
    destroy,
    resolveHighlightSeek,
    flushAndResolveHighlightSeek,
    getSegments,
    getActiveDiskPaths,
    isActive,
    pinPaths,
    unpinPaths,
    releaseSegmentPaths,
    getLastHeartbeatAt,
    getRecordingTrackCount,
    isEncoderWarmupComplete,
    ensureDualTrackHealth,
    hasZombieTracks,
    recoverZombieTracks,
    forceProbeRotate,
    getLastCameraFrame,
    clearLastCameraFrame,
    setHandoffFrameHook,
    clearHandoffFrameHook,
    getCfrPumpFps,
    setCfrPumpFps,
    pauseCfrFeed,
    resumeCfrFeed,
    setRecordingProfile,
    getCameraFeedStats,
    getMaxAvailableHighlightLeadMs
  };
}

module.exports = {
  createPreviewRecordPipeline
};
