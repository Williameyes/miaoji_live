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
  let frameInterval = frameIntervalMs(12);
  let feeding = false;

  /**
   * @param {string} eventName
   * @param {Object} [detail]
   */
  function log(eventName, detail) {
    if (page && typeof page.appendHealthLog === 'function') {
      page.appendHealthLog(eventName, detail || {});
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
    if (feeding) return;
    feeding = true;
    pingPong.feedFrame(frame).finally(() => {
      feeding = false;
    });
  }

  /**
   * @param {Object} segment
   */
  function onSegmentReady(segment) {
    if (!page) return;
    page.lastSegmentAt = Date.now();
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
    const fps = options.fps || 12;
    frameInterval = frameIntervalMs(fps);
    pingPong = new PingPongRecorder({
      onLog: log,
      onSegmentReady,
      rollingDir,
      ensureRollingDir,
      chunkDurationMs: options.chunkDurationMs || 16000,
      staggerMs: options.staggerMs || 8000,
      fps,
      stopToStartGapMs: options.stopToStartGapMs || 400,
      recycleIntervalMs: options.recycleIntervalMs || 20 * 60 * 1000,
      maxFiles: options.maxFiles || 4,
      canvasWidth: options.canvasWidth || 640,
      canvasHeight: options.canvasHeight || 360
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
      if (page) {
        page.lastSegmentAt = Date.now();
        page.lastRecordStartAt = Date.now();
        page.setData({ isRecording: true });
      }
      log('preview_record_pipeline_start', { fps });
    });
  }

  /**
   * @returns {Promise<void>}
   */
  function stop() {
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

  return {
    isSupported,
    start,
    stop,
    destroy,
    resolveHighlightSeek,
    getSegments,
    isActive,
    pinPaths,
    unpinPaths
  };
}

module.exports = {
  createPreviewRecordPipeline
};
