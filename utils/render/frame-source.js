/**
 * 帧源抽象：隐藏「onCameraFrame」与「VKSession v2」差异，向上游 RenderPipeline 暴露同一接口。
 *
 * 两种后端：
 *  - native    ：cameraContext.onCameraFrame
 *                兼容面最广；帧率受系统调度影响；不与 startRecord 抢占相机。
 *                * 本工程「关闭/标准/高性能」三档共用此路径。
 *  - vksession ：wx.createVKSession({ version: 'v2', track: { threeDof: true }, gl: WebGL })
 *                * 优先 threeDof：不依赖平面 AR 初始化，避免 plane 未就绪时 getVKFrame 长期为 null。
 *                * gl 与 <canvas type="webgl"> 同一上下文，便于 getCameraTexture(gl,'yuv')。
 *                * getVKFrame(w,h) 的 w/h 须与画布后备像素一致；支持每帧 getBufferDims 刷新 + 宽高对调回退。
 *                * iOS 上 frame.getCameraBuffer() 多为空：主路径为 { vkFrame } + getCameraTexture(gl,'yuv')；
 *                  若部分 Android 仍能拿到 buffer，则走 RGBA 快路径以减少一次 YUV pass。
 *                * VKSession 会深度接管相机，与 <camera>.startRecord 强冲突；
 *                  上层必须先 stopRollingRecording 并 unmount <camera> 再启用本源。
 *
 * 共同接口：{ kind, start(): Promise<void>, stop(): void, setMinInterval(ms): void, isRunning(): boolean }
 */

/**
 * @callback FrameHandler
 * @param {{data: ArrayBuffer, width: number, height: number}} frame
 */

/**
 * 基于 cameraContext.onCameraFrame 的帧源。
 * @param {Object} opts
 * @param {Object} opts.cameraContext    wx.createCameraContext() 返回值
 * @param {FrameHandler} opts.onFrame
 * @param {number} [opts.minIntervalMs]  两帧最小间隔（ms）；默认 0 不节流，降级时上调到 40-60
 */
function createNativeFrameSource(opts) {
  var listener = null;
  var running = false;
  var minIntervalMs = opts.minIntervalMs || 0;
  var lastAt = 0;

  /** 运行中动态调整节流间隔；上游 pipeline 降级时使用。 */
  function setMinInterval(ms) { minIntervalMs = ms || 0; }

  function handle(frame) {
    if (!running) return;
    var now = Date.now();
    if (minIntervalMs && now - lastAt < minIntervalMs) return;
    lastAt = now;
    try { opts.onFrame(frame); } catch (e) {}
  }

  /**
   * 启动帧回调。
   * @returns {Promise<void>}
   */
  function start() {
    if (running || !opts.cameraContext) return Promise.resolve();
    if (typeof opts.cameraContext.onCameraFrame !== 'function') {
      return Promise.reject(new Error('onCameraFrame unavailable'));
    }
    running = true;
    try {
      listener = opts.cameraContext.onCameraFrame(handle);
      listener.start();
    } catch (e) {
      running = false;
      return Promise.reject(e);
    }
    return Promise.resolve();
  }

  function stop() {
    running = false;
    if (listener) {
      try { listener.stop(); } catch (e) {}
      listener = null;
    }
  }

  return {
    kind: 'native',
    start: start,
    stop: stop,
    setMinInterval: setMinInterval,
    isRunning: function() { return running; }
  };
}

/**
 * 基于 wx.createVKSession(v2) 的帧源。
 *
 * 工作流：
 *   wx.createVKSession({ version:'v2', track:{ threeDof:true }, gl })
 *     → session.start(cb)
 *     → session.requestAnimationFrame(onFrame)
 *     → 每帧 session.getVKFrame(w,h)（w/h 来自 getBufferDims 或初始 opts，可对调尝试）
 *     → 优先尝试 getCameraBuffer()（Android 等）；否则 onFrame({ vkFrame }) 走 YUV 纹理路径（iOS）
 *
 * CFR 锁定：
 *   优先 session.requestAnimationFrame；次选 session.canvas.requestAnimationFrame；最后 setTimeout 软锁。
 *
 * 鲁棒性：
 *   - 连续 NO_FRAME_FATAL 帧无有效帧 → onFatal；上游切回 standard。
 *   - session.start(err) 失败：reject 并带 [vk:start] 前缀 message。
 *   - stop() 幂等。
 *
 * @param {Object} opts
 * @param {FrameHandler} opts.onFrame
 * @param {WebGLRenderingContext|null} [opts.gl] 与 enhanceCanvas 同一上下文；强烈建议传入
 * @param {number} [opts.targetFps]     目标 CFR；默认 30
 * @param {number} [opts.bufferWidth]   getVKFrame 初始宽
 * @param {number} [opts.bufferHeight]  getVKFrame 初始高
 * @param {function():{width:number,height:number}} [opts.getBufferDims] 每帧刷新 w/h（与 canvas 后备一致）
 * @param {Function} [opts.onFatal]     运行中致命错时回调；上游据此回退
 */
function createVkFrameSource(opts) {
  var session = null;
  var running = false;
  var loopStopToken = 0;
  var targetInterval = Math.max(16, Math.floor(1000 / (opts.targetFps || 30)));
  var bufW = Math.max(2, opts.bufferWidth || 1280);
  var bufH = Math.max(2, opts.bufferHeight || 720);
  /** 实际传给 getVKFrame 的宽高；可与 buf 对调一次以适配传感器/横竖屏。 */
  var frameBufW = bufW;
  var frameBufH = bufH;
  var triedDimSwap = false;
  var consecutiveNoFrame = 0;
  /** 约 6s@30fps：给 threeDof/首帧 留足余量。 */
  var NO_FRAME_FATAL = 180;

  function _safeDestroySession() {
    if (!session) return;
    try { session.stop && session.stop(); } catch (e) {}
    try { session.destroy && session.destroy(); } catch (e2) {}
    session = null;
  }

  function stop() {
    running = false;
    loopStopToken++;
    _safeDestroySession();
    consecutiveNoFrame = 0;
  }

  /**
   * 将 start/运行阶段的 err 规范化成 Error；保留 errCode / errMsg 字段供日志定位。
   * @param {*} raw
   * @param {string} stage
   * @returns {Error}
   */
  function _normalizeError(raw, stage) {
    if (raw instanceof Error) {
      raw.message = '[vk:' + stage + '] ' + raw.message;
      return raw;
    }
    var msg = '';
    var code = '';
    if (raw && typeof raw === 'object') {
      msg = raw.errMsg || raw.message || '';
      code = raw.errCode != null ? String(raw.errCode) : '';
    } else {
      msg = String(raw);
    }
    if (!msg) msg = 'unknown';
    var wrapped = new Error('[vk:' + stage + '] ' + (code ? '(' + code + ') ' : '') + msg);
    wrapped.errCode = code;
    wrapped.errMsg = msg;
    return wrapped;
  }

  /**
   * @returns {Promise<void>}
   */
  function start() {
    if (running) return Promise.resolve();
    if (typeof wx.createVKSession !== 'function') {
      return Promise.reject(new Error('[vk:create] VKSession API not found'));
    }
    try {
      var sessionOpts = {
        version: 'v2',
        track: { threeDof: true }
      };
      if (opts.gl) sessionOpts.gl = opts.gl;
      try {
        session = wx.createVKSession(sessionOpts);
      } catch (eThree) {
        try { console.warn('[vk][create] threeDof failed, fallback plane', eThree); } catch (_) {}
        var fb = { version: 'v2', track: { plane: { mode: 1 } } };
        if (opts.gl) fb.gl = opts.gl;
        session = wx.createVKSession(fb);
      }
    } catch (eCreate) {
      try { console.error('[vk][create] createVKSession threw', eCreate); } catch (_) {}
      return Promise.reject(_normalizeError(eCreate, 'create'));
    }
    if (!session || typeof session.start !== 'function') {
      _safeDestroySession();
      return Promise.reject(new Error('[vk:create] session.start missing'));
    }
    return new Promise(function(resolve, reject) {
      var localToken = ++loopStopToken;
      var started = false;
      var resolveStart = function() {
        if (started) return;
        started = true;
        running = true;
        resolve();
      };

      /**
       * 渲染循环调度：
       *   1. session.requestAnimationFrame（v2 官方签名，首选）
       *   2. session.canvas.requestAnimationFrame（少数基础库上仅此可用）
       *   3. setTimeout(~33ms) 软锁
       */
      var lastTickAt = 0;
      function scheduleNext() {
        if (!running || localToken !== loopStopToken) return;
        if (session && typeof session.requestAnimationFrame === 'function') {
          try { session.requestAnimationFrame(loop); return; } catch (eRaf1) {}
        }
        if (session && session.canvas && typeof session.canvas.requestAnimationFrame === 'function') {
          try { session.canvas.requestAnimationFrame.call(session.canvas, loop); return; } catch (eRaf2) {}
        }
        setTimeout(loop, targetInterval);
      }

      function _escalateFatal(err) {
        var e = _normalizeError(err, 'frame');
        try { console.error('[vk][fatal]', e.message); } catch (_) {}
        if (typeof opts.onFatal === 'function') {
          try { opts.onFatal(e); } catch (eCb) {}
        }
        stop();
      }

      function loop() {
        if (!running || localToken !== loopStopToken) return;
        var now = Date.now();
        if (lastTickAt && (now - lastTickAt) < targetInterval * 0.85) {
          scheduleNext();
          return;
        }
        lastTickAt = now;
        try {
          if (typeof opts.getBufferDims === 'function') {
            try {
              var dim = opts.getBufferDims();
              if (dim && dim.width >= 2 && dim.height >= 2) {
                if (dim.width !== bufW || dim.height !== bufH) {
                  bufW = dim.width;
                  bufH = dim.height;
                  frameBufW = bufW;
                  frameBufH = bufH;
                  triedDimSwap = false;
                  consecutiveNoFrame = 0;
                }
              }
            } catch (eDim) {}
          }
          var frame = (typeof session.getVKFrame === 'function')
            ? session.getVKFrame(frameBufW, frameBufH)
            : null;
          if (!frame) {
            consecutiveNoFrame++;
            if (!triedDimSwap && consecutiveNoFrame >= 48) {
              var tmp = frameBufW;
              frameBufW = frameBufH;
              frameBufH = tmp;
              triedDimSwap = true;
              consecutiveNoFrame = 0;
              try { console.warn('[vk] getVKFrame dim swap ->', frameBufW, frameBufH); } catch (_) {}
            }
          } else {
            var delivered = false;
            var framePromise = null;
            if (typeof frame.getCameraBuffer === 'function') {
              var buf = null;
              try { buf = frame.getCameraBuffer(); }
              catch (eBuf1) {
                try { buf = frame.getCameraBuffer(frameBufW, frameBufH); }
                catch (eBuf2) { buf = null; }
              }
              if (buf) {
                consecutiveNoFrame = 0;
                try {
                  framePromise = opts.onFrame({
                    data: buf,
                    width: frame.width || frameBufW,
                    height: frame.height || frameBufH
                  });
                } catch (eOf) { framePromise = null; }
                delivered = true;
              }
            }
            if (!delivered) {
              consecutiveNoFrame = 0;
              try { framePromise = opts.onFrame({ vkFrame: frame }); }
              catch (eOf2) { framePromise = null; }
            }
            if (framePromise && typeof framePromise.then === 'function') {
              framePromise
                .then(function() { loopTail(); })
                .catch(function() { loopTail(); });
              return;
            }
          }
        } catch (eFrame) {
          consecutiveNoFrame++;
        }
        loopTail();
      }

      function loopTail() {
        if (!running || localToken !== loopStopToken) return;
        if (consecutiveNoFrame >= NO_FRAME_FATAL) {
          _escalateFatal(new Error('no_frame_streak:' + consecutiveNoFrame));
          return;
        }
        scheduleNext();
      }

      try {
        session.start(function(err) {
          if (err) {
            try { console.error('[vk][start] session.start err', err); } catch (_) {}
            _safeDestroySession();
            reject(_normalizeError(err, 'start'));
            return;
          }
          try { console.info('[vk][start] session ready, entering frame loop'); } catch (_) {}
          resolveStart();
          scheduleNext();
        });
      } catch (eStart) {
        try { console.error('[vk][start] session.start threw', eStart); } catch (_) {}
        _safeDestroySession();
        reject(_normalizeError(eStart, 'start'));
      }
    });
  }

  return {
    kind: 'vksession',
    start: start,
    stop: stop,
    setMinInterval: function() {},
    isRunning: function() { return running; }
  };
}

module.exports = {
  createNativeFrameSource: createNativeFrameSource,
  createVkFrameSource: createVkFrameSource
};
