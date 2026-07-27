/**
 * @fileoverview 独立滚动收音：wx.getRecorderManager，墙钟分段，导出前可 flush 当前段。
 */

/** 默认单段时长（ms），与视频 chunk 对齐便于同步。 */
var DEFAULT_SEGMENT_MS = 50000;

/** 环形容量（段数）。 */
var DEFAULT_MAX_SEGMENTS = 4;

/**
 * @param {string} filePath
 * @returns {Promise<void>}
 */
function unlinkQuiet(filePath) {
  return new Promise(function (resolve) {
    if (!filePath) {
      resolve();
      return;
    }
    try {
      wx.getFileSystemManager().unlink({
        filePath: filePath,
        complete: function () {
          resolve();
        }
      });
    } catch (e) {
      resolve();
    }
  });
}

/**
 * 创建滚动收音器。
 *
 * @param {Object} [options]
 * @returns {Object}
 */
function createRollingAudioRecorder(options) {
  var opts = options || {};
  var segmentMs = opts.segmentMs || DEFAULT_SEGMENT_MS;
  var maxSegments = opts.maxSegments || DEFAULT_MAX_SEGMENTS;
  var format = opts.format || 'mp3';
  var sampleRate = opts.sampleRate || 44100;
  var onSegmentReady = opts.onSegmentReady;
  var onError = opts.onError;

  var recorder = wx.getRecorderManager();
  var segments = [];
  var active = false;
  var starting = false;
  var currentStartTime = 0;
  var stopResolve = null;
  var flushResolve = null;
  var flushPromise = null;
  var flushTimer = null;

  function getLastSegment() {
    return segments.length ? segments[segments.length - 1] : null;
  }

  function clearFlushTimer() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  function resolveFlush(seg, fallbackToLast) {
    var cb = flushResolve;
    flushResolve = null;
    flushPromise = null;
    clearFlushTimer();
    if (cb) {
      try {
        cb(fallbackToLast && !seg ? getLastSegment() : seg);
      } catch (eCb) {}
    }
  }

  /**
   * @param {Object} seg
   * @returns {void}
   */
  function pushSegment(seg) {
    segments.push(seg);
    while (segments.length > maxSegments) {
      var removed = segments.shift();
      if (removed && removed.path) {
        unlinkQuiet(removed.path);
      }
    }
    if (typeof onSegmentReady === 'function') {
      onSegmentReady(seg);
    }
  }

  recorder.onStop(function (res) {
    var path = (res && res.tempFilePath) || '';
    var endTime = Date.now();
    var durationMs = Math.max(0, Math.floor(Number(res && res.duration) || 0));
    if (!durationMs && currentStartTime > 0) {
      durationMs = endTime - currentStartTime;
    }
    if (path) {
      pushSegment({
        path: path,
        startTime: currentStartTime,
        endTime: endTime,
        durationMs: durationMs
      });
    }
    starting = false;

    if (flushResolve) {
      resolveFlush(getLastSegment(), true);
    }

    if (active) {
      startSegmentInternal();
    } else if (stopResolve) {
      stopResolve();
      stopResolve = null;
    }
  });

  recorder.onError(function (err) {
    starting = false;
    if (typeof onError === 'function') {
      onError(err || {});
    }
    if (flushResolve) {
      resolveFlush(null, false);
    }
    if (!active && stopResolve) {
      stopResolve();
      stopResolve = null;
    }
  });

  /**
   * @returns {void}
   */
  function startSegmentInternal() {
    if (!active || starting) return;
    starting = true;
    currentStartTime = Date.now();
    try {
      recorder.start({
        duration: segmentMs,
        format: format,
        sampleRate: sampleRate,
        numberOfChannels: 1,
        encodeBitRate: 128000
      });
    } catch (e) {
      starting = false;
      if (typeof onError === 'function') {
        onError({ errMsg: String(e && e.message || e) });
      }
    }
  }

  /**
   * @returns {void}
   */
  function start() {
    if (active) return;
    active = true;
    startSegmentInternal();
  }

  /**
   * @returns {Promise<void>}
   */
  function stop() {
    if (!active) return Promise.resolve();
    active = false;
    return new Promise(function (resolve) {
      stopResolve = resolve;
      try {
        recorder.stop();
      } catch (e) {
        resolve();
        stopResolve = null;
      }
      setTimeout(function () {
        if (stopResolve) {
          stopResolve();
          stopResolve = null;
        }
      }, 4000);
    });
  }

  /**
   * 导出前 flush：将当前正在录的音频段落盘，便于 resolveTrimPlan 取到文件。
   *
   * @returns {Promise<Object|null>}
   */
  function flushActiveSegmentForExport() {
    if (flushPromise) {
      return flushPromise;
    }
    if (!active && !starting) {
      return Promise.resolve(getLastSegment());
    }

    flushPromise = new Promise(function (resolve) {
      flushResolve = resolve;
    });
    flushTimer = setTimeout(function () {
      if (flushResolve) {
        resolveFlush(getLastSegment(), true);
      }
    }, 5000);
    try {
      recorder.stop();
    } catch (e) {
      resolveFlush(getLastSegment(), true);
    }
    return flushPromise || Promise.resolve(getLastSegment());
  }

  /**
   * @returns {boolean}
   */
  function isActive() {
    return active;
  }

  /**
   * @returns {Array<Object>}
   */
  function getSegments() {
    return segments.slice();
  }

  /**
   * 按墙钟窗口解析音频裁切计划。
   *
   * @param {number} windowStartMs
   * @param {number} windowEndMs
   * @returns {{ path: string, trimStartMs: number, trimEndMs: number }|null}
   */
  function resolveTrimPlan(windowStartMs, windowEndMs) {
    var start = Math.floor(Number(windowStartMs) || 0);
    var end = Math.floor(Number(windowEndMs) || 0);
    if (end <= start + 400) return null;

    var best = null;
    var i;
    for (i = segments.length - 1; i >= 0; i--) {
      var seg = segments[i];
      if (!seg || !seg.path) continue;
      if (seg.endTime > start && seg.startTime < end) {
        best = seg;
        break;
      }
    }
    if (!best) return null;

    var wallDur = best.durationMs || Math.max(0, best.endTime - best.startTime);
    var trimStart = Math.max(0, start - best.startTime);
    var trimEnd = Math.min(wallDur, end - best.startTime);
    if (trimEnd <= trimStart + 400) {
      trimEnd = Math.min(wallDur, trimStart + (end - start));
    }
    if (trimEnd <= trimStart + 400) return null;

    return {
      path: best.path,
      trimStartMs: trimStart,
      trimEndMs: trimEnd
    };
  }

  return {
    start: start,
    stop: stop,
    flushActiveSegmentForExport: flushActiveSegmentForExport,
    isActive: isActive,
    getSegments: getSegments,
    resolveTrimPlan: resolveTrimPlan
  };
}

module.exports = {
  createRollingAudioRecorder: createRollingAudioRecorder,
  DEFAULT_SEGMENT_MS: DEFAULT_SEGMENT_MS
};
