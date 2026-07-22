/**
 * @fileoverview 原生滚动录制模块入口，对外提供集成后的 NativeRollingRecorder API。
 */

const { createSegmentRing } = require('./segment-ring.js');
const { createDualTrackRecorder } = require('./dual-track-recorder.js');
const { exportLast8s } = require('./clip-exporter.js');

function createNativeRollingRecorder(cameraCtx, options) {
  var opts = options || {};
  var segmentMs = opts.segmentMs || 60000; // 默认 60 秒切分（按 720p/1080p Profile 动态传入）
  var skipMediaContainerTrim = !!opts.skipMediaContainerTrim;
  
  // 单分段环形缓冲区，仅保存 1 个最新分段（单段 ~60MB，总占用仅 60MB 极低风险）
  var ring = createSegmentRing(1);
  var pendingExports = [];
  var lastRotateTime = 0;
  var throttleRotateTimer = null;

  function clearThrottleTimer() {
    if (throttleRotateTimer) {
      clearTimeout(throttleRotateTimer);
      throttleRotateTimer = null;
    }
  }

  function resolveExportPath(segments, triggerTime) {
    if (skipMediaContainerTrim) {
      return exportLast8s(segments, triggerTime, { skipTrim: true });
    }
    return exportLast8s(segments, triggerTime);
  }

  var recorder = createDualTrackRecorder(cameraCtx, {
    segmentMs: segmentMs,
    recordQuality: opts.recordQuality || 'medium',
    stopToStartDelayMs: opts.stopToStartDelayMs,
    onTrackActive: opts.onTrackActive,
    onError: opts.onError,
    onSegmentComplete: function (seg) {
      // 1. 存入环形缓冲区
      ring.push(seg);

      // 2. 检查是否有排队等待该分段落盘的导出任务
      if (pendingExports.length > 0) {
        var remaining = [];
        for (var i = 0; i < pendingExports.length; i++) {
          var item = pendingExports[i];
          // 如果触发时间戳早于当前刚落盘分段的结束时间，即可在该分段或历史分段中完成裁剪
          if (item.triggerTime <= seg.stop + 1000) {
            (function (pendingItem) {
              resolveExportPath(ring.getSegments(), pendingItem.triggerTime)
                .then(function (path) {
                  pendingItem.resolve(path);
                })
                .catch(function (err) {
                  pendingItem.reject(err);
                });
            })(item);
          } else {
            remaining.push(item);
          }
        }
        pendingExports = remaining;
      }

      if (typeof opts.onSegmentComplete === 'function') {
        opts.onSegmentComplete(seg);
      }
    }
  });

  function start() {
    ring.clear();
    pendingExports = [];
    lastRotateTime = 0;
    clearThrottleTimer();
    recorder.start();
  }

  function stop() {
    clearThrottleTimer();
    recorder.stop();
    // 释放所有等待中的导出 Promise
    for (var i = 0; i < pendingExports.length; i++) {
      pendingExports[i].reject(new Error('recorder_stopped'));
    }
    pendingExports = [];
    ring.clear();
  }

  /**
   * 触发高光截取（异步流程，带硬件保护防振荡）
   * @returns {Promise<string>}
   */
  function triggerExport() {
    if (!recorder.isActive()) {
      return Promise.reject(new Error('recorder_not_active'));
    }

    var triggerTime = Date.now();
    return new Promise(function (resolve, reject) {
      pendingExports.push({
        triggerTime: triggerTime,
        resolve: resolve,
        reject: reject
      });

      var now = Date.now();
      var timeSinceLast = now - lastRotateTime;

      // 最低限流间隔为 4000ms，防止高频连续点击冲击微信底层 Camera API 导致 stop error
      var minThrottleMs = 4000;
      if (timeSinceLast >= minThrottleMs) {
        lastRotateTime = now;
        console.log('[NativeRollingRecorder] Rotating track on export trigger');
        recorder.rotate();
      } else {
        var delay = minThrottleMs - timeSinceLast;
        console.log('[NativeRollingRecorder] Trigger throttled. Scheduling deferred rotate in', delay, 'ms');
        
        if (!throttleRotateTimer) {
          throttleRotateTimer = setTimeout(function () {
            throttleRotateTimer = null;
            if (recorder.isActive() && pendingExports.length > 0) {
              lastRotateTime = Date.now();
              console.log('[NativeRollingRecorder] Executing deferred rotate from queue');
              recorder.rotate();
            }
          }, delay);
        }
      }
    });
  }

  /**
   * 相册保存成功后释放环内分段引用（物理文件由页面 unlink）。
   *
   * @param {string} path
   * @returns {void}
   */
  function releaseSegmentPath(path) {
    if (ring && typeof ring.removeByPath === 'function') {
      ring.removeByPath(path);
    }
  }

  /**
   * 收集当前应保留的 rolling 媒体路径，供沙盒孤儿清理使用。
   *
   * @returns {string[]}
   */
  function getActiveMediaPaths() {
    var paths = [];
    var segs = ring.getSegments();
    for (var i = 0; i < segs.length; i++) {
      if (segs[i] && segs[i].path) {
        paths.push(segs[i].path);
      }
    }
    var cur = recorder.getCurrentSegment();
    if (cur && cur.path) {
      paths.push(cur.path);
    }
    return paths;
  }

  return {
    start: start,
    stop: stop,
    triggerExport: triggerExport,
    releaseSegmentPath: releaseSegmentPath,
    getActiveMediaPaths: getActiveMediaPaths,
    isActive: function () {
      return recorder.isActive();
    },
    getActiveTrack: function () {
      return recorder.getActiveTrack();
    },
    getCurrentSegment: function () {
      return recorder.getCurrentSegment();
    },
    getSegments: function () {
      return ring.getSegments();
    }
  };
}

module.exports = {
  createNativeRollingRecorder: createNativeRollingRecorder
};
