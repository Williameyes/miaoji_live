/**
 * 视录分离管线：camera 纯预览 + onCameraFrame 抽帧 + 乒乓 MediaRecorder。
 * 前台 <camera> 永不调用 startRecord/stopRecord。
 */

const frameSourceMod = require('../render/frame-source.js');
const { PingPongRecorder } = require('./ping-pong-recorder.js');

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
  let lastFrameAt = 0;
  let frameInterval = frameIntervalMs(15);
  let feeding = false;
  /** 最近一次帧/轨道活动，供 segment watchdog 识别乒乓假死。 */
  let lastPipelineHeartbeatAt = 0;
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
  /**
   * 每次 start() 自增；stop() 时归 0；start() 时分配给当前 pingPong 实例。
   * 切换场次时 pipeline.stop() 触发 pingPong 内部的强制收尾，
   * 由旧 pingPong 闭包发出的 onSegmentReady 必须能识别为"过期"并丢弃，
   * 否则上一场次的 chunk 会回写到刚被 reset 清空的 page.rollingSegments，
   * 污染 segmentCounter、_lastSuccessfulChunkAt 等状态，并误触 _tryGenerateHighlight。
   */
  let activeSessionId = 0;

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
    if (!pipelineWarmedUp) {
      warmupFrameCount += 1;
      if (warmupFrameCount === 1) {
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
      const needFrames = currentWarmupMinFrames || PREVIEW_RECORD_WARMUP_MIN_FRAMES;
      if (warmupFrameCount >= needFrames) {
        pipelineWarmedUp = true;
        log('preview_record_warmup_ready', {
          frameCount: warmupFrameCount,
          needFrames,
          elapsedMs: pipelineStartAt > 0 ? now - pipelineStartAt : 0
        });
        const waiters = warmupWaiters.splice(0, warmupWaiters.length);
        waiters.forEach((fn) => {
          try { fn(); } catch (eWait) { /* ignore */ }
        });
      }
    }
    if (!active || !pingPong) return;
    if (now - lastFrameAt < frameInterval) return;
    lastFrameAt = now;
    if (now - lastPipelineHeartbeatAt >= 5000) {
      touchPipelineHeartbeat('frame_feed');
    }
    if (feeding) {
      if (feedingSince > 0 && now - feedingSince > 1200) {
        log('preview_record_feeding_force_reset', {
          stuckMs: now - feedingSince
        });
        feeding = false;
        feedingSince = 0;
      } else {
        return;
      }
    }
    feeding = true;
    feedingSince = now;
    pingPong.feedFrame(frame).finally(() => {
      feeding = false;
      feedingSince = 0;
    });
  }

  /**
   * 真正写回 page 状态的 segment 处理；调用方负责保证 segment 来自当前会话。
   * @param {Object} segment
   */
  function applySegmentToPage(segment) {
    if (!page) return;
    const now = Date.now();
    page.lastSegmentAt = now;
    page._lastSuccessfulChunkAt = now;
    touchPipelineHeartbeat('segment_ready');
    page.rollingSegments = page.rollingSegments || [];
    page.rollingSegments.push(Object.assign({}, segment));
    while (page.rollingSegments.length > (page.rollingBufferMax || 8)) {
      page.rollingSegments.shift();
    }
    page.segmentBuffer = page.rollingSegments;
    page.segmentCounter = (page.segmentCounter || 0) + 1;
    page.setData({ isRecording: true });
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

  /**
   * @param {Object} opts
   * @returns {Promise<void>}
   */
  function start(opts) {
    const options = opts || {};
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
    const fps = options.fps || 15;
    frameInterval = frameIntervalMs(fps);
    /**
     * 给本次 pingPong 实例分配独立 sessionId；绑定到 boundOnSegmentReady 闭包内，
     * stop() 后再有同一实例的迟到 segment 时，sessionId 已不匹配，自动丢弃。
     */
    activeSessionId += 1;
    const instanceSessionId = activeSessionId;
    /**
     * @param {Object} segment
     */
    const boundOnSegmentReady = (segment) => {
      if (!active || instanceSessionId !== activeSessionId) {
        log('preview_record_stale_segment_dropped', {
          path: segment && segment.path ? segment.path : '',
          trackId: segment && segment.trackId ? segment.trackId : '',
          instanceSessionId,
          activeSessionId,
          active,
          startTime: segment && segment.startTime ? segment.startTime : 0,
          endTime: segment && segment.endTime ? segment.endTime : 0,
          sizeBytes: segment && segment.sizeBytes ? segment.sizeBytes : 0
        });
        return;
      }
      applySegmentToPage(segment);
    };
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
      rollingDir,
      ensureRollingDir,
      chunkDurationMs: options.chunkDurationMs || 180000,
      staggerMs: options.staggerMs || 8000,
      highlightFlushMinIntervalMs: options.highlightFlushMinIntervalMs || 10000,
      fps,
      stopToStartGapMs: options.stopToStartGapMs || 400,
      recycleIntervalMs: options.recycleIntervalMs || 25 * 60 * 1000,
      maxFiles: options.maxFiles || 2,
      canvasWidth: options.canvasWidth || 854,
      canvasHeight: options.canvasHeight || 480
    });
    pipelineWarmedUp = false;
    warmupFrameCount = 0;
    pipelineStartAt = Date.now();
    warmupWaiters = [];
    feeding = false;
    feedingSince = 0;
    const requireFirstFrame = options.requireFirstFrame !== false;
    const firstFrameTimeoutMs = Number(options.firstFrameTimeoutMs) || PREVIEW_RECORD_FIRST_FRAME_TIMEOUT_MS;
    currentWarmupMinFrames = Math.max(
      PREVIEW_RECORD_WARMUP_MIN_FRAMES,
      Number(options.warmupMinFrames) || PREVIEW_RECORD_WARMUP_MIN_FRAMES
    );
    return pingPong.init().then(() => {
      frameSource = frameSourceMod.createNativeFrameSource({
        cameraContext,
        onFrame,
        minIntervalMs: 0
      });
      return frameSource.start();
    }).then(() => {
      if (!requireFirstFrame) {
        pipelineWarmedUp = true;
        return Promise.resolve();
      }
      return waitForWarmupFrames(firstFrameTimeoutMs, currentWarmupMinFrames);
    }).then(() => {
      active = true;
      return pingPong.start();
    }).then(() => {
      touchPipelineHeartbeat('pipeline_start');
      if (page) {
        page.lastRecordStartAt = Date.now();
        page.setData({ isRecording: true });
      }
      log('preview_record_pipeline_start', {
        fps,
        sessionId: instanceSessionId,
        requireFirstFrame,
        warmupMinFrames: currentWarmupMinFrames
      });
    }).catch((err) => {
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
      pipelineStartAt = 0;
      warmupWaiters = [];
      feeding = false;
      feedingSince = 0;
      active = false;
      throw err;
    });
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
    pipelineWarmedUp = false;
    warmupFrameCount = 0;
    pipelineStartAt = 0;
    warmupWaiters = [];
    feeding = false;
    feedingSince = 0;
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
    if (!pp) return Promise.resolve();
    return pp.stop().then(() => {
      log('preview_record_pipeline_stop', {});
    });
  }

  /**
   * @returns {void}
   */
  function destroy() {
    stop().finally(() => {
      if (pingPong) {
        pingPong.destroy();
        pingPong = null;
      }
    });
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
   * 外部触发双轨健康巡检（如高光失败时）。
   * @returns {void}
   */
  function ensureDualTrackHealth() {
    if (pingPong && typeof pingPong._ensureDualTrackHealth === 'function') {
      pingPong._ensureDualTrackHealth();
    }
  }

  return {
    isSupported,
    start,
    stop,
    destroy,
    resolveHighlightSeek,
    flushAndResolveHighlightSeek,
    getSegments,
    isActive,
    pinPaths,
    unpinPaths,
    releaseSegmentPaths,
    getLastHeartbeatAt,
    getRecordingTrackCount,
    ensureDualTrackHealth
  };
}

module.exports = {
  createPreviewRecordPipeline
};
