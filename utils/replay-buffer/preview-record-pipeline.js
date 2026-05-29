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
   * @param {{ data: ArrayBuffer, width: number, height: number }} frame
   * @returns {void}
   */
  function onFrame(frame) {
    if (!active || !pingPong) return;
    const now = Date.now();
    if (now - lastFrameAt < frameInterval) return;
    lastFrameAt = now;
    if (now - lastPipelineHeartbeatAt >= 5000) {
      touchPipelineHeartbeat('frame_feed');
    }
    if (feeding) return;
    feeding = true;
    pingPong.feedFrame(frame).finally(() => {
      feeding = false;
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
    return pingPong.init().then(() => {
      frameSource = frameSourceMod.createNativeFrameSource({
        cameraContext,
        onFrame,
        minIntervalMs: 0
      });
      return frameSource.start();
    }).then(() => pingPong.start()).then(() => {
      active = true;
      touchPipelineHeartbeat('pipeline_start');
      if (page) {
        page.lastRecordStartAt = Date.now();
        page.setData({ isRecording: true });
      }
      log('preview_record_pipeline_start', { fps, sessionId: instanceSessionId });
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
   * 获取最新的相机帧
   * @returns {{ data: ArrayBuffer, width: number, height: number }|null}
   */
  function getLastCameraFrame() {
    return pingPong ? pingPong.getLastCameraFrame() : null;
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
    getLastCameraFrame,
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
