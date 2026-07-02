/**
 * @fileoverview 原生滚动录制模块入口，对外提供集成后的 NativeRollingRecorder API。
 */

const { createSegmentRing } = require('./segment-ring.js');
const { createDualTrackRecorder } = require('./dual-track-recorder.js');
const { exportLast8s } = require('./clip-exporter.js');

function createNativeRollingRecorder(cameraCtx, options) {
  var opts = options || {};
  var segmentMs = opts.segmentMs || 25000;
  
  // 环状缓存，最大保存 2 个分段
  var ring = createSegmentRing(2);
  var pendingExports = [];
  var lastRotateTime = 0;
  var throttleRotateTimer = null;

  function clearThrottleTimer() {
    if (throttleRotateTimer) {
      clearTimeout(throttleRotateTimer);
      throttleRotateTimer = null;
    }
  }

  var recorder = createDualTrackRecorder(cameraCtx, {
    segmentMs: segmentMs,
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
              exportLast8s(ring.getSegments(), pendingItem.triggerTime)
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

      // 最低限流间隔为 3000ms，防止高频连续点击冲击微信底层 Camera API 导致 stop error
      if (timeSinceLast >= 3000) {
        lastRotateTime = now;
        console.log('[NativeRollingRecorder] Rotating track on export trigger');
        recorder.rotate();
      } else {
        var delay = 3000 - timeSinceLast;
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

  return {
    start: start,
    stop: stop,
    triggerExport: triggerExport,
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
