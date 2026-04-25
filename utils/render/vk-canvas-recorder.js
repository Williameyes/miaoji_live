/**
 * VK 模式 WebGL 画布录制：wx.createMediaRecorder（基础库 ≥2.11.0）。
 * 与官方约定一致：每帧先 requestFrame，再执行 WebGL 绘制（由 RenderPipeline 的 hook 保证顺序）。
 *
 * 性能：requestFrame 返回 Promise 时用微任务链接绘制，避免同步阻塞；FPS 持续低于阈值时可隔帧 requestFrame，
 * 减轻编码压力（微信侧未必支持中途改码率，此为折中）。
 */

/**
 * @param {*} v
 * @returns {boolean}
 */
function _isPromiseLike(v) {
  return v && typeof v.then === 'function';
}

/**
 * @param {Object} recorder
 * @returns {Promise<void>}
 */
function _startRecorder(recorder) {
  return new Promise(function(resolve, reject) {
    if (!recorder || typeof recorder.start !== 'function') {
      reject(new Error('recorder.start missing'));
      return;
    }
    var done = false;
    var finish = function() {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      if (typeof recorder.on === 'function') {
        recorder.on('start', finish);
      }
    } catch (eOn) {}
    try {
      var ret = recorder.start();
      if (_isPromiseLike(ret)) {
        ret.then(finish).catch(reject);
        return;
      }
    } catch (eStart) {
      reject(eStart);
      return;
    }
    setTimeout(finish, 100);
  });
}

/**
 * @param {Object} recorder
 * @returns {Promise<void>}
 */
function _requestFrameRecorder(recorder) {
  if (!recorder || typeof recorder.requestFrame !== 'function') {
    return Promise.resolve();
  }
  var ret = recorder.requestFrame();
  if (_isPromiseLike(ret)) return /** @type {Promise<void>} */ (ret);
  return new Promise(function(resolve) {
    try {
      recorder.requestFrame(function() { resolve(); });
    } catch (e) {
      resolve();
    }
  });
}

/**
 * @param {Object} recorder
 * @returns {Promise<{tempFilePath?: string}>}
 */
function _stopRecorder(recorder) {
  return new Promise(function(resolve, reject) {
    if (!recorder || typeof recorder.stop !== 'function') {
      reject(new Error('recorder.stop missing'));
      return;
    }
    var done = false;
    var finish = function(res) {
      if (done) return;
      done = true;
      resolve(res || {});
    };
    try {
      if (typeof recorder.on === 'function') {
        recorder.on('stop', finish);
      }
    } catch (eOn) {}
    try {
      var ret = recorder.stop();
      if (_isPromiseLike(ret)) {
        ret.then(finish).catch(reject);
        return;
      }
    } catch (eStop) {
      reject(eStop);
      return;
    }
    setTimeout(function() { finish({}); }, 400);
  });
}

/**
 * 创建 VK 画布录制控制器（单例用法：每段高光 new 一次或复用前先 destroy）。
 * @returns {{
 *   isApiSupported: function(): boolean,
 *   start: function(Object, Object): Promise<void>,
 *   beforeDraw: function(): Promise<void>,
 *   noteRenderFps: function(number): void,
 *   stop: function(): Promise<{tempFilePath?: string}>,
 *   destroy: function(): void
 * }}
 */
function createVkCanvasRecorder() {
  var recorder = null;
  var active = false;
  var frameSeq = 0;
  /** @type {{ lowFpsStreak: number, skipEveryOther: boolean, videoBitsPerSecond: number }} */
  var adapt = { lowFpsStreak: 0, skipEveryOther: false, videoBitsPerSecond: 2200 };

  /**
   * @returns {boolean}
   */
  function isApiSupported() {
    return typeof wx !== 'undefined' && typeof wx.createMediaRecorder === 'function';
  }

  /**
   * @param {Object} canvasNode SelectorQuery 取到的 type=webgl 的 node
   * @param {Object} opts
   * @param {number} [opts.durationSec] 最大时长（秒），5–7200
   * @param {number} [opts.fps] 默认 24
   * @param {number} [opts.videoBitsPerSecond] 默认 2200（兼顾高光可读性与编码稳定性）
   * @returns {Promise<void>}
   */
  function start(canvasNode, opts) {
    opts = opts || {};
    destroy();
    if (!isApiSupported()) {
      return Promise.reject(new Error('createMediaRecorder unsupported'));
    }
    if (!canvasNode || !canvasNode.width || !canvasNode.height) {
      return Promise.reject(new Error('invalid canvas node'));
    }
    var duration = opts.durationSec != null ? Number(opts.durationSec) : 60;
    duration = Math.max(5, Math.min(7200, duration));
    var fps = opts.fps != null ? Number(opts.fps) : 24;
    fps = Math.max(12, Math.min(60, fps));
    var bps = opts.videoBitsPerSecond != null ? Number(opts.videoBitsPerSecond) : 2200;
    bps = Math.max(1200, Math.min(5200, bps));
    adapt.videoBitsPerSecond = bps;
    adapt.lowFpsStreak = 0;
    adapt.skipEveryOther = false;
    frameSeq = 0;
    recorder = wx.createMediaRecorder(canvasNode, {
      duration: duration,
      fps: fps,
      videoBitsPerSecond: bps,
      gop: Math.max(6, Math.floor(fps)),
      width: canvasNode.width,
      height: canvasNode.height
    });
    return _startRecorder(recorder).then(function() {
      active = true;
    });
  }

  /**
   * 渲染前调用：与官方示例「先 requestFrame 再 draw」对齐。
   * @returns {Promise<void>}
   */
  function beforeDraw() {
    if (!active || !recorder) return Promise.resolve();
    frameSeq += 1;
    if (adapt.skipEveryOther && frameSeq % 2 === 0) {
      return Promise.resolve();
    }
    return _requestFrameRecorder(recorder).catch(function() {});
  }

  /**
   * 由页面每秒传入渲染 FPS（如 PerfMonitor.avgFps）；连续低于阈值则隔帧 requestFrame。
   * @param {number} avgFps
   * @returns {void}
   */
  function noteRenderFps(avgFps) {
    if (!active) return;
    var f = Number(avgFps);
    if (!isFinite(f)) return;
    if (f < 24) {
      adapt.lowFpsStreak += 1;
    } else {
      adapt.lowFpsStreak = 0;
    }
    if (adapt.lowFpsStreak >= 2 && !adapt.skipEveryOther) {
      adapt.skipEveryOther = true;
      try {
        console.warn('[vk-canvas-recorder] FPS<' + 24 + ', enable skip-every-other requestFrame');
      } catch (e) {}
    }
  }

  /**
   * @returns {Promise<{tempFilePath?: string}>}
   */
  function stop() {
    active = false;
    if (!recorder) return Promise.resolve({});
    var r = recorder;
    recorder = null;
    return _stopRecorder(r)
      .then(function(res) {
        try {
          if (r.destroy) r.destroy();
        } catch (e) {}
        return res || {};
      })
      .catch(function(err) {
        try {
          if (r.destroy) r.destroy();
        } catch (e2) {}
        throw err;
      });
  }

  /**
   * @returns {void}
   */
  function destroy() {
    active = false;
    if (recorder) {
      try {
        if (recorder.stop) recorder.stop();
      } catch (e) {}
      try {
        if (recorder.destroy) recorder.destroy();
      } catch (e2) {}
      recorder = null;
    }
  }

  return {
    isApiSupported: isApiSupported,
    start: start,
    beforeDraw: beforeDraw,
    noteRenderFps: noteRenderFps,
    stop: stop,
    destroy: destroy
  };
}

module.exports = { createVkCanvasRecorder: createVkCanvasRecorder };
