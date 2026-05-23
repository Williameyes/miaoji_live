/**
 * 高清渲染管线编排器：FrameSource → Renderer → PerfMonitor，并实现「可动态降级」能力。
 *
 * 模式（两大家族）：
 *   —— 原生家族（共用 <camera> 组件 + onCameraFrame；与 startRecord 并行可用）：
 *     'off'      — 关闭增强：停止 FrameSource，隐藏 canvas，完全回退原生 <camera>。
 *     'lite'     — 轻量 USM Shader
 *     'standard' — 标准 USM Shader
 *     'strong'   — 强锐化 + 边缘补强 + 对比度（运动员高速运动场景）
 *   —— VK 独立家族（VKSession v2 独占相机；与 startRecord 不能共存）：
 *     'vk'       — USM + 边缘补强 + Gamma + 饱和度；CFR 30fps 锁；由页面显式切入，
 *                   切入前必须 stopRolling + unmount <camera>。
 *
 * 自动降级（仅针对原生家族 lite/standard/strong，'vk' 不参与升降级链路）：
 *   FPS >= 28      → 保留；稳定 UPGRADE_STABLE_MS 后可尝试升档（但不超过 requested）
 *   24 <= FPS < 28 → Shader 降一档（strong→standard→lite）
 *   20 <= FPS < 24 → 强制 lite
 *   FPS < 20       → off（完全回退 camera）
 *   渲染 tick 停滞 2 秒 → 立即 off
 * VK 家族降级（独立）：FPS < 20 或 stalled → 调 onVkDegrade 回调（页面据此切回 standard）；
 *                      管线内部不做 VK→native 切换，因为它涉及相机重建，必须由页面 orchestrate。
 *
 * 防抖：MIN_SWITCH_GAP_MS = 3500ms；发热提示 30 秒内禁止升档。
 *
 * 对外 API：init / setMode / start / stop / destroy / hintThermalPressure / pauseAutoDegradeOnce / snapshot / diagnostics
 */

var perfMod = require('./perf-monitor.js');
var rendererMod = require('./webgl-sharpen-renderer.js');
var frameMod = require('./frame-source.js');
/** 中心块统计用的边长（像素），与 motion 的 CPU 成本线性相关。 */
var MOTION_LUMA_PATCH = 8;
/** VK：帧间 wall clock 间隔 (ms) 归一为 raw motion 的分母；约 30fps 单帧 33ms → raw≈0.33。 */
var VK_MOTION_BENCH_MS = 100;
/** motion EMA 系数：new 权重 0.2，与历史 0.8 融合。 */
var MOTION_SMOOTH_ALPHA = 0.2;

/**
 * VK 稳定模式：固定 shader 参数，禁用自适应曲线 / 帧间 motion / 热缩 uniform（仅 VK 帧路径）。
 * 原生家族 off/lite/standard/strong 不受此开关影响。
 */
var VK_STABLE_MODE = true;

/** @type {{ tone: number, amount: number, motion: number }} */
var VK_STABLE_PROFILE = {
  tone: 0.88,
  amount: 0.52,
  motion: 0.70
};

// [VK Adaptive Curve]
var debugConfig = {
  enable: false,
  overrideAmount: null,
  overrideTone: null,
  overrideMotion: null,
  freezeAuto: false
};

// [VK Adaptive Curve]
function clamp01(v) {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// [VK Adaptive Curve]
function clampRange(v, min, max) {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

// [VK Adaptive Curve]
function lerpScalar(a, b, t) {
  return a + (b - a) * t;
}

// [VK Adaptive Curve]
function smoothstep01(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  var t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * 对 RGBA 相机帧取中心块平均亮度 [0,1]（同 shader 中 luma 权重），供轻量 motion 估计。
 * @param {ArrayBuffer} data
 * @param {number} w
 * @param {number} h
 * @returns {number|null}
 */
function estimateCenterAvgLumaFromRgba(data, w, h) {
  if (!data || w < 1 || h < 1) return null;
  var u8 = new Uint8Array(data);
  var stride = w * 4;
  var pw = Math.min(MOTION_LUMA_PATCH, w);
  var ph = Math.min(MOTION_LUMA_PATCH, h);
  var x0 = Math.floor((w - pw) / 2);
  var y0 = Math.floor((h - ph) / 2);
  if (x0 < 0) x0 = 0;
  if (y0 < 0) y0 = 0;
  var sum = 0;
  var n = 0;
  for (var j = 0; j < ph; j++) {
    var row = (y0 + j) * stride;
    for (var i = 0; i < pw; i++) {
      var o = row + (x0 + i) * 4;
      var r = u8[o] / 255;
      var g = u8[o + 1] / 255;
      var b = u8[o + 2] / 255;
      sum += 0.299 * r + 0.587 * g + 0.114 * b;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

/** 原生家族档位由低到高的索引顺序；升降档以此为序。'vk' 不在此数组内。 */
var ORDER = ['off', 'lite', 'standard', 'strong'];
/** 任意两次切换的最小间隔，抑制抖动。 */
var MIN_SWITCH_GAP_MS = 3500;
/** 升档前需要「稳定通过阈值」的最小持续时长。 */
var UPGRADE_STABLE_MS = 10000;
/** 发热提示后禁止升档的窗口。 */
var THERMAL_UPGRADE_BLOCK_MS = 30000;
/** VK 家族诊断：连续 N 秒 FPS < 20 或 stalled 则 escalate 给页面。 */
var VK_DEGRADE_FPS_THRESHOLD = 20;
var VK_DEGRADE_SUSTAIN_SEC = 3;

/**
 * @param {string} mode
 * @returns {number}
 */
function levelIndex(mode) { return ORDER.indexOf(mode); }

/**
 * 创建一个渲染管线。使用：
 *   var pipeline = createRenderPipeline();
 *   pipeline.init({ page: this, cameraContext: ctx, canvasSelector: '#enhanceCanvas', cssW, cssH });
 *   pipeline.setMode('standard');
 *   pipeline.start();
 *   // ... 页面 onHide / onUnload：
 *   pipeline.destroy();
 */
function createRenderPipeline() {
  /** @type {{init:Function,setMode:Function}&Object|null} */
  var api = null;
  var renderer = null;
  var monitor = null;
  var source = null;
  var page = null;
  var selector = '';

  /** 实际当前档位；由 setMode 更新。 */
  var mode = 'off';
  /** 用户/上层请求的目标档位；升档不会超过该值。 */
  var requested = 'off';
  /** 当前帧源家族；init 固定，不可中途切换。页面切换家族必须先 destroy 再 init。 */
  var _sourceKind = 'native';

  var lastSwitchAt = 0;
  var modeChangedAt = 0;
  var autoDegradeTimer = 0;
  var inTransition = false;
  var thermalDowngradeUntil = 0;
  /** 累计已成功渲染（texSubImage2D + draw）的帧数；工具条/诊断用。 */
  var framesRendered = 0;
  /** 最近一次帧到达时间戳（ms），用于"无帧超时"告警。 */
  var lastFrameAt = 0;
  /** VK 家族降级回调；init(opts.onVkDegrade) 传入。 */
  var _onVkDegrade = null;
  /** VK 降级判定计数：FPS<20 连续几秒（用于 sustainec）。 */
  var _vkLowFpsStreakSec = 0;
  /** VK 降级仅触发一次，避免重复 escalate。 */
  var _vkDegradeFired = false;
  /**
   * VK 画布录制：每帧绘制前调用，须返回 Promise（内为 recorder.requestFrame）。
   * @type {null|function(): (void|Promise<void>)}
   */
  var _vkBeforeDraw = null;
  /**
   * 上一帧中心平均 luma；仅原生 onCameraFrame 有 RGBA 缓冲时递推。VK/无 data 时清空。
   * @type {number|null}
   */
  var _motionPrevLuma = null;
  /**
   * 指数平滑后的 motion，传入 Shader，减轻 raw 跳变与「呼吸感」。
   * @type {number|null}
   */
  var _motionSmoothed = null;
  /**
   * VK 仅：上一帧 onFrame 的 wall 时间 (ms)，用于帧间间隔估计弱 motion。
   * @type {number|null}
   */
  var _vkLastFrameWallTime = null;
  // [VK Adaptive Curve]
  var _vkAdaptiveCurveState = {
    avgLuminance: 0.5,
    loadIndex: 0.0,
    nightFactor: 0.0,
    currentAmount: 0.65,
    currentTone: 0.75,
    currentMotion: 1.0,
    targetAmount: 0.65,
    targetTone: 0.75,
    targetMotion: 1.0
  };

  function _now() { return Date.now(); }

  /**
   * 清空与 motion 相关的可恢复状态；与 off/destroy 对齐。
   * @returns {void}
   */
  function _resetMotionState() {
    _motionPrevLuma = null;
    _motionSmoothed = null;
    _vkLastFrameWallTime = null;
  }

  // [VK Adaptive Curve]
  function _resetVkAdaptiveCurveState() {
    _vkAdaptiveCurveState.avgLuminance = 0.5;
    _vkAdaptiveCurveState.loadIndex = 0.0;
    _vkAdaptiveCurveState.nightFactor = 0.0;
    _vkAdaptiveCurveState.currentAmount = 0.65;
    _vkAdaptiveCurveState.currentTone = 0.75;
    _vkAdaptiveCurveState.currentMotion = 1.0;
    _vkAdaptiveCurveState.targetAmount = 0.65;
    _vkAdaptiveCurveState.targetTone = 0.75;
    _vkAdaptiveCurveState.targetMotion = 1.0;
    try {
      if (renderer && typeof renderer.setVkAdaptiveCurveState === 'function') {
        renderer.setVkAdaptiveCurveState({
          amount: _vkAdaptiveCurveState.currentAmount,
          tone: _vkAdaptiveCurveState.currentTone,
          motion: _vkAdaptiveCurveState.currentMotion
        });
      }
    } catch (e) {}
  }

  // [VK Adaptive Curve]
  function _updateVkAdaptiveCurve(totalCost, cycleDelta) {
    if (VK_STABLE_MODE) return;
    if (mode !== 'vk' || !renderer || typeof renderer.setVkAdaptiveCurveState !== 'function') return;
    var snap = monitor ? monitor.snapshot() : null;
    var fps = snap && snap.avgFps ? snap.avgFps : 30;
    var stats = typeof renderer.getVkSceneStats === 'function' ? renderer.getVkSceneStats() : null;
    var avgLuminance = stats && typeof stats.avgLuminance === 'number' ? stats.avgLuminance : _vkAdaptiveCurveState.avgLuminance;
    _vkAdaptiveCurveState.avgLuminance = avgLuminance;
    if (!debugConfig.freezeAuto) {
      var fpsPenalty = clamp01((30 - fps) / 30) * 0.3;
      var cyclePenalty = clamp01((cycleDelta - 40) / 20) * 0.2;
      var loadIndex = clamp01((totalCost / 33.3) * 0.6 + fpsPenalty + cyclePenalty);
      var nightFactor = 1.0 - smoothstep01(0.2, 0.5, avgLuminance);
      var targetAmount = 0.65 - loadIndex * 0.25;
      targetAmount *= (1.0 - nightFactor * 0.3);
      targetAmount = clampRange(targetAmount, 0.35, 0.7);
      var toneStrength = 0.6 + (1 - loadIndex) * 0.25;
      toneStrength += nightFactor * 0.2;
      toneStrength = clampRange(toneStrength, 0.5, 1.05);
      var motionStrength = 1.0 - loadIndex * 0.8;
      motionStrength = clampRange(motionStrength, 0.2, 1.0);
      _vkAdaptiveCurveState.loadIndex = loadIndex;
      _vkAdaptiveCurveState.nightFactor = nightFactor;
      _vkAdaptiveCurveState.targetAmount = targetAmount;
      _vkAdaptiveCurveState.targetTone = toneStrength;
      _vkAdaptiveCurveState.targetMotion = motionStrength;
    }
    if (debugConfig.enable) {
      if (debugConfig.overrideAmount != null) {
        _vkAdaptiveCurveState.targetAmount = clampRange(Number(debugConfig.overrideAmount) || 0, 0.35, 0.7);
      }
      if (debugConfig.overrideTone != null) {
        _vkAdaptiveCurveState.targetTone = clampRange(Number(debugConfig.overrideTone) || 0, 0.5, 1.2);
      }
      if (debugConfig.overrideMotion != null) {
        _vkAdaptiveCurveState.targetMotion = clampRange(Number(debugConfig.overrideMotion) || 0, 0.2, 1.0);
      }
    }
    _vkAdaptiveCurveState.currentAmount = lerpScalar(_vkAdaptiveCurveState.currentAmount, _vkAdaptiveCurveState.targetAmount, 0.05);
    _vkAdaptiveCurveState.currentTone = lerpScalar(_vkAdaptiveCurveState.currentTone, _vkAdaptiveCurveState.targetTone, 0.05);
    _vkAdaptiveCurveState.currentMotion = lerpScalar(_vkAdaptiveCurveState.currentMotion, _vkAdaptiveCurveState.targetMotion, 0.05);
    try {
      renderer.setVkAdaptiveCurveState({
        amount: _vkAdaptiveCurveState.currentAmount,
        tone: _vkAdaptiveCurveState.currentTone,
        motion: _vkAdaptiveCurveState.currentMotion
      });
      renderer.setMotionLevel((_motionSmoothed == null ? 0 : _motionSmoothed) * _vkAdaptiveCurveState.currentMotion);
    } catch (e) {}
  }

  /**
   * 对 raw motion 做 EMA 后写入 renderer uMotion。原生：中心 luma 差；VK：帧间间隔 / 分母，首帧 0.3。
   * @param {*} frame
   * @returns {void}
   */
  function applyMotionUniformForFrame(frame) {
    var applySmoothed = function(raw) {
      if (_motionSmoothed == null) {
        _motionSmoothed = raw;
      } else {
        _motionSmoothed = _motionSmoothed * (1.0 - MOTION_SMOOTH_ALPHA) + raw * MOTION_SMOOTH_ALPHA;
      }
      try {
        if (renderer && typeof renderer.setMotionLevel === 'function') {
          renderer.setMotionLevel(_motionSmoothed);
        }
      } catch (e) {}
    };

    if (frame && frame.vkFrame) {
      if (VK_STABLE_MODE) return;
      var t = _now();
      var rawVk;
      if (_vkLastFrameWallTime == null) {
        _vkLastFrameWallTime = t;
        rawVk = 0.3;
      } else {
        var interval = t - _vkLastFrameWallTime;
        _vkLastFrameWallTime = t;
        rawVk = Math.min(1, interval / VK_MOTION_BENCH_MS);
      }
      applySmoothed(rawVk);
      return;
    }
    if (frame && frame.data && frame.width && frame.height) {
      var curr = estimateCenterAvgLumaFromRgba(frame.data, frame.width, frame.height);
      if (curr === null) {
        _resetMotionState();
        try {
          if (renderer && typeof renderer.setMotionLevel === 'function') {
            renderer.setMotionLevel(0);
          }
        } catch (e0) {}
        return;
      }
      var rawNative = 0;
      if (_motionPrevLuma !== null) {
        rawNative = Math.min(1, Math.abs(curr - _motionPrevLuma));
      }
      _motionPrevLuma = curr;
      applySmoothed(rawNative);
      return;
    }
    _resetMotionState();
    try {
      if (renderer && typeof renderer.setMotionLevel === 'function') {
        renderer.setMotionLevel(0);
      }
    } catch (e1) {}
  }

  /**
   * VK 稳定模式：一次性写入固定 motion uniform，不做帧间递推。
   * @returns {void}
   */
  function _applyVkStableUniforms() {
    if (!VK_STABLE_MODE || mode !== 'vk' || !renderer) return;
    try {
      if (typeof renderer.setMotionLevel === 'function') {
        renderer.setMotionLevel(VK_STABLE_PROFILE.motion);
      }
    } catch (e) {}
  }

  /**
   * 初始化（异步）。成功后 mode 仍为 'off'，需再调用 setMode('standard'|'vk') 启动。
   *
   * 参数差异：
   *  - 原生家族：必须传 cameraContext；source 为 onCameraFrame 直连。
   *  - VK 家族：cameraContext 可传 null；source 为 VKSession v2；
   *             页面切入 VK 前必须已 stopRolling + unmount <camera>。
   *
   * @param {Object} opts
   * @param {Object} opts.page            Page 实例
   * @param {Object|null} opts.cameraContext  wx.createCameraContext() 返回值；VK 模式下传 null
   * @param {string} opts.canvasSelector  '#enhanceCanvas'
   * @param {number} opts.cssW            画布 CSS 宽
   * @param {number} opts.cssH            画布 CSS 高
   * @param {'native'|'vk'} [opts.sourceKind] 'native'（默认）或 'vk'
   * @param {Function} [opts.onVkDegrade] VK 家族自动降级回调；参数 {reason,fps}
   * @returns {Promise<void>}
   */
  function init(opts) {
    page = opts.page;
    selector = opts.canvasSelector;
    renderer = rendererMod.createWebglSharpenRenderer();
    monitor = perfMod.createPerformanceMonitor();
    var sourceKind = opts.sourceKind === 'vk' ? 'vk' : 'native';
    _sourceKind = sourceKind;
    // [VK Adaptive Curve]
    _resetVkAdaptiveCurveState();
    // init 阶段先以 'standard' 档位建 program；真正切到 VK 时 setShaderLevel('vk')
    // VK：必须 preserveDrawingBuffer，否则高光封面 canvasToTempFilePath 恒为黑图
    return renderer.init({
      component: page,
      selector: selector,
      level: 'standard',
      preserveDrawingBuffer: sourceKind === 'vk'
    }).then(function() {
      renderer.resizeCanvas(opts.cssW, opts.cssH);
      var isDrawingLock = false;
      var skipNextFrame = false;
      var overloadCount = 0;
      var expectedNextTick = 0;
      var lastFrameStartT = 0;
      /**
       * @param {*} frame
       * @returns {void|Promise<void>}
       */
      function onFrame(frame) {
        var now = _now();
        
        // 1. 绝对时间轴同步 (Proactive Clock Sync)
        if (expectedNextTick === 0) expectedNextTick = now;
        // 允许 5ms 的 OS 调度误差，过早到达的帧会被主动丢弃以稳住 30fps 绝对节奏
        if (now < expectedNextTick - 5) {
          return;
        }
        
        if (skipNextFrame) {
          skipNextFrame = false;
          // 时间对齐器：跳过该旧帧的同时推进时钟，强行拉平时间轴
          expectedNextTick += 33.3;
          return;
        }
        if (isDrawingLock) {
          return;
        }
        isDrawingLock = true;
        var startT = now;
        var cycleDelta = lastFrameStartT > 0 ? (startT - lastFrameStartT) : 0;
        lastFrameStartT = startT;
        
        // 推进下一帧的期望时间
        expectedNextTick += 33.3;
        // 维持严密的节奏锁：如果落后太多，通过倍数补齐来追赶，而不是抛弃原有的绝对时间轴基准，防止节奏断裂
        while (expectedNextTick <= now) {
          expectedNextTick += 33.3;
        }

        applyMotionUniformForFrame(frame);
        function doDraw() {
          var ms = frame && frame.vkFrame
            ? renderer.drawVkCameraFrame(frame.vkFrame)
            : renderer.drawFrame(frame);
          monitor.tick(ms);
          framesRendered++;
          lastFrameAt = _now();
          isDrawingLock = false;
          
          var totalCost = _now() - startT;
          // [VK Adaptive Curve]
          if (_sourceKind === 'vk' && frame && frame.vkFrame) {
            _updateVkAdaptiveCurve(totalCost, cycleDelta);
          }
          // 2. 双重背压检测：区分“系统线程调度抖动”与“真实的渲染/编码积压”
          // 如果 cycleDelta 大但 totalCost 小，说明只是 JS 被抢占，并没有造成管线背压
          if (totalCost > 38 || (cycleDelta > 45 && totalCost > 15)) {
            overloadCount++;
          } else {
            overloadCount = 0;
          }
          if (overloadCount >= 2) {
            skipNextFrame = true;
            overloadCount = 0;
          }
        }
        if (_sourceKind === 'vk' && typeof _vkBeforeDraw === 'function') {
          try {
            var ret = _vkBeforeDraw();
            if (ret && typeof ret.then === 'function') {
              return ret.then(doDraw).catch(function(err) {
                if (err === 'SKIP_RENDER_FOR_THERMAL') {
                  isDrawingLock = false;
                } else {
                  doDraw();
                }
              });
            }
          } catch (eHook) {
            isDrawingLock = false;
          }
        }
        doDraw();
      }
      if (sourceKind === 'vk') {
        var bk = renderer.getBackingSize();
        source = frameMod.createVkFrameSource({
          gl: renderer.getGl(),
          bufferWidth: bk.width,
          bufferHeight: bk.height,
          getBufferDims: function() {
            return renderer.getBackingSize();
          },
          onFrame: onFrame,
          targetFps: 30,
          onFatal: function(err) {
            // VK 帧源致命错：escalate 给页面，由页面 orchestrate 切回 standard
            if (typeof opts.onVkDegrade === 'function') {
              try { opts.onVkDegrade({ reason: 'vk_fatal', err: err && err.message }); } catch (eCb) {}
            }
          }
        });
        // 记下 VK 降级回调，供 tickAutoDegrade 判 FPS < 20 时用
        _onVkDegrade = opts.onVkDegrade || null;
      } else {
        source = frameMod.createNativeFrameSource({
          cameraContext: opts.cameraContext,
          onFrame: onFrame
        });
      }
    });
  }

  /**
   * 切换模式。保证不并发切换；切换失败自动回退到 'off' 避免黑屏。
   *
   * 家族约束（硬校验，不可逾越）：
   *  - _sourceKind='native' 时仅接受 'off'|'lite'|'standard'|'strong'
   *  - _sourceKind='vk'     时仅接受 'off'|'vk'（'off' 仍允许，用于临时停止 VK 帧流）
   *  不匹配则直接返回并记 appendHealthLog-like（通过 page.appendHealthLog，如果有）。
   *
   * @param {'off'|'lite'|'standard'|'strong'|'vk'} nextMode
   * @param {{reason?:string, force?:boolean}} [opts]
   */
  function setMode(nextMode, opts) {
    opts = opts || {};
    // 家族校验
    if (_sourceKind === 'native' && nextMode === 'vk') return;
    if (_sourceKind === 'vk' && nextMode !== 'off' && nextMode !== 'vk') return;

    // requested 只跟随显式用户/首次调用；自动降级时不覆盖 requested，保留原始目标便于后续自动升档。
    if (!opts.reason || opts.reason === 'user') {
      requested = nextMode;
    }
    /** 异步 start 未回调时 inTransition 会永久卡住，后续切档全部静默失败 → 黑屏；超时强制解锁 */
    if (inTransition && _now() - lastSwitchAt > 10000) {
      inTransition = false;
    }
    if (inTransition) return;
    if (!opts.force && _now() - lastSwitchAt < MIN_SWITCH_GAP_MS) return;
    if (nextMode === mode) return;
    inTransition = true;
    lastSwitchAt = _now();
    modeChangedAt = lastSwitchAt;

    var toOff = (nextMode === 'off');
    var fromOff = (mode === 'off');

    /**
     * 统一收尾：成功时同步 UI 数据；失败时强制 off 并隐藏 canvas。
     * @param {Error|null} err
     */
    var finalize = function(err) {
      inTransition = false;
      if (err) {
        mode = 'off';
        _resetMotionState();
        // [VK Adaptive Curve]
        _resetVkAdaptiveCurveState();
        if (source && source.isRunning && source.isRunning()) {
          try { source.stop(); } catch (e) {}
        }
        if (page && page.setData) {
          page.setData({ enhanceCanvasVisible: false, enhanceMode: 'off' });
        }
        if (page && typeof page._deferTeardownEnhanceForPipeline === 'function') {
          var pipeRefErr = api;
          setTimeout(function() {
            try {
              page._deferTeardownEnhanceForPipeline(pipeRefErr);
            } catch (eTd) {}
          }, 0);
        }
        return;
      }
      mode = nextMode;
      if (toOff) {
        _resetMotionState();
        // [VK Adaptive Curve]
        _resetVkAdaptiveCurveState();
      }
      // 切入/离开 vk 时重置降级触发状态
      if (mode !== 'vk') {
        _vkLowFpsStreakSec = 0;
        _vkDegradeFired = false;
      }
      if (page && page.setData) {
        page.setData({ enhanceCanvasVisible: !toOff, enhanceMode: mode });
      }
      if (mode === 'vk' && VK_STABLE_MODE) {
        _applyVkStableUniforms();
      }
      /**
       * WXML 用 wx:if 挂载 canvas；档位 off 时若仅 stop 帧源而不销毁管线，节点被卸掉后 GL 上下文失效，
       * 再切 standard/strong 会永久黑屏。由页面下一 tick 走 _teardownEnhanceRender 完整释放。
       */
      if (toOff && page && typeof page._deferTeardownEnhanceForPipeline === 'function') {
        var pipeRefOff = api;
        setTimeout(function() {
          try {
            page._deferTeardownEnhanceForPipeline(pipeRefOff);
          } catch (eTd) {}
        }, 0);
      }
    };

    try {
      if (toOff) {
        if (source && source.isRunning()) source.stop();
        if (monitor) monitor.reset();
        finalize(null);
        return;
      }
      if (fromOff) {
        _resetMotionState();
        // [VK Adaptive Curve]
        _resetVkAdaptiveCurveState();
        renderer.setShaderLevel(nextMode);
        var sp = source.start();
        if (!sp || typeof sp.then !== 'function') {
          finalize(new Error('source.start not Promise'));
          return;
        }
        var timeoutMs = 12000;
        var timeoutP = new Promise(function(_, reject) {
          setTimeout(function() {
            reject(new Error('source.start timeout'));
          }, timeoutMs);
        });
        Promise.race([sp, timeoutP]).then(function() {
          finalize(null);
        }).catch(function(e) {
          finalize(e);
        });
        return;
      }
      renderer.setShaderLevel(nextMode);
      // [VK Adaptive Curve]
      _resetVkAdaptiveCurveState();
      if (monitor) monitor.reset();
      finalize(null);
    } catch (e) {
      finalize(e);
    }
  }

  /**
   * 基于 FPS 窗口自动降级 / 升档。
   * 由 start() 启动的 1s 定时器驱动；也可外部显式调用。
   *
   * VK 家族的降级路径与原生不同：管线内部不能直接把 'vk' 切成 'standard'（涉及相机重建），
   * 此时仅调 _onVkDegrade 通知页面；页面 orchestrate 完整 VK→native 切换。
   */
  function tickAutoDegrade() {
    if (!monitor || mode === 'off' || inTransition) return;
    var now = _now();

    // ---- VK 家族降级判定 ----
    if (mode === 'vk') {
      var snapVk = monitor.snapshot();
      var stalled = monitor.isStalled(2);
      
      if (snapVk && snapVk.samples >= 3 && renderer && typeof renderer.setThermalLevel === 'function') {
        if (!VK_STABLE_MODE) {
          if (snapVk.avgFps < 25) {
            renderer.setThermalLevel(2); // 重度发热：大幅砍细节并关闭运动增强
          } else if (snapVk.avgFps < 28) {
            renderer.setThermalLevel(1); // 轻度发热：轻微减弱锐化
          } else {
            renderer.setThermalLevel(0); // 满血恢复
          }
        }
      }

      var lowFps = snapVk && snapVk.samples >= 3 && snapVk.avgFps < VK_DEGRADE_FPS_THRESHOLD;
      if (lowFps) {
        _vkLowFpsStreakSec++;
      } else {
        _vkLowFpsStreakSec = 0;
      }
      if (!_vkDegradeFired && (stalled || _vkLowFpsStreakSec >= VK_DEGRADE_SUSTAIN_SEC)) {
        _vkDegradeFired = true;
        var payload = {
          reason: stalled ? 'vk_stalled' : 'vk_low_fps',
          fps: snapVk ? snapVk.avgFps : 0
        };
        if (typeof _onVkDegrade === 'function') {
          try { _onVkDegrade(payload); } catch (eCb) {}
        }
      }
      return;
    }

    // ---- 原生家族升降级（ORDER 索引驱动）----
    if (monitor.isStalled(2)) {
      setMode('off', { reason: 'stalled', force: true });
      return;
    }
    var snap = monitor.snapshot();
    if (!snap || snap.samples < 3) return;

    var fps = snap.avgFps;
    var idx = levelIndex(mode);

    if (fps < 20) { setMode('off',  { reason: 'fps<20' }); return; }
    if (fps < 24) { setMode('lite', { reason: 'fps<24' }); return; }
    if (fps < 28 && idx > 1) {
      setMode(ORDER[idx - 1], { reason: 'fps<28' });
      return;
    }

    var targetIdx = levelIndex(requested);
    if (targetIdx > idx
        && now - modeChangedAt > UPGRADE_STABLE_MS
        && snap.minFps >= 30
        && now > thermalDowngradeUntil) {
      setMode(ORDER[idx + 1], { reason: 'upgrade' });
    }
  }

  /**
   * 外部发热/内存告警钩子：立即降到 'standard'（若在 strong），severe 级直接 lite。
   * 并在 THERMAL_UPGRADE_BLOCK_MS 内禁止升档，避免来回抖动。
   * @param {'warn'|'severe'} [severity]
   */
  function hintThermalPressure(severity) {
    thermalDowngradeUntil = _now() + THERMAL_UPGRADE_BLOCK_MS;
    if (severity === 'severe' && mode !== 'off') {
      setMode('lite', { reason: 'thermal_severe', force: true });
    } else if (mode === 'strong') {
      setMode('standard', { reason: 'thermal', force: true });
    }
  }

  /** 启动自动降级的 1 秒定时器。应在 init 成功 + setMode(非 off) 之后调用。 */
  function start() {
    if (autoDegradeTimer) return;
    autoDegradeTimer = setInterval(tickAutoDegrade, 1000);
  }

  /** 停止自动降级与帧源；保留 GL 资源（destroy 才释放）。 */
  function stop() {
    if (autoDegradeTimer) { clearInterval(autoDegradeTimer); autoDegradeTimer = 0; }
    if (source && source.isRunning && source.isRunning()) {
      try { source.stop(); } catch (e) {}
    }
  }

  /** 全量销毁：停定时器 / 停帧源 / 释放 GL 资源。onHide / onUnload / rebuildCameraComponent 调用。 */
  function destroy() {
    stop();
    inTransition = false;
    try { if (renderer) renderer.destroy(); } catch (e) {}
    renderer = null;
    source = null;
    monitor = null;
    page = null;
    mode = 'off';
    _sourceKind = 'native';
    _onVkDegrade = null;
    _vkLowFpsStreakSec = 0;
    _vkDegradeFired = false;
    _vkBeforeDraw = null;
    _resetMotionState();
    // [VK Adaptive Curve]
    _resetVkAdaptiveCurveState();
    framesRendered = 0;
    lastFrameAt = 0;
  }

  /**
   * VK 数字变焦（WebGL 中心裁切，≥1×），供页面双指缩放。
   * @param {number} z
   * @returns {void}
   */
  function setVkZoom(z) {
    if (renderer && typeof renderer.setVkZoom === 'function') {
      try { renderer.setVkZoom(z); } catch (e) {}
    }
  }

  /**
   * 原生增强路径变焦补偿（仅 onCameraFrame + WebGL 路径使用）。
   * @param {number} z
   * @returns {void}
   */
  function setNativeZoomCompensation(z) {
    if (renderer && typeof renderer.setNativeZoomCompensation === 'function') {
      try { renderer.setNativeZoomCompensation(z); } catch (e) {}
    }
  }

  /**
   * 与页面 16:9 取景框（CSS px）同步后备缓冲，避免全屏与画布尺寸不一导致锐化/比例错位。
   *
   * @param {number} cssW
   * @param {number} cssH
   * @returns {void}
   */
  function resizeToCssPixels(cssW, cssH) {
    if (!renderer || typeof renderer.resizeCanvas !== 'function') return;
    try {
      var w = Math.max(1, Math.floor(Number(cssW)));
      var h = Math.max(1, Math.floor(Number(cssH)));
      renderer.resizeCanvas(w, h);
    } catch (e) {}
  }

  /**
   * 取 WebGL canvas node（MediaRecorder 用）。
   * @returns {Object|null}
   */
  function getCanvasNode() {
    return renderer && typeof renderer.getCanvasNode === 'function'
      ? renderer.getCanvasNode()
      : null;
  }

  /**
   * 注册 VK 录制 hook：每帧绘制前调用；返回 Promise 时帧循环会等待后再 scheduleNext。
   * @param {null|function(): (void|Promise<void>)} fn
   * @returns {void}
   */
  function setVkRecordingHook(fn) {
    _vkBeforeDraw = typeof fn === 'function' ? fn : null;
  }

  /**
   * 缩放 / 切焦等短暂打断画面的操作后调用：重置窗口 + 切换冷却，避免对焦/变焦瞬间被误降级。
   */
  function pauseAutoDegradeOnce() {
    lastSwitchAt = _now();
    modeChangedAt = _now();
    if (monitor) monitor.reset();
  }

  // [VK Adaptive Curve]
  function getVkAdaptiveDebugConfig() {
    return debugConfig;
  }

  // [VK Adaptive Curve]
  function setVkAdaptiveDebugConfig(patch) {
    if (VK_STABLE_MODE) return;
    if (!patch) return;
    if (Object.prototype.hasOwnProperty.call(patch, 'enable')) debugConfig.enable = !!patch.enable;
    if (Object.prototype.hasOwnProperty.call(patch, 'overrideAmount')) debugConfig.overrideAmount = patch.overrideAmount;
    if (Object.prototype.hasOwnProperty.call(patch, 'overrideTone')) debugConfig.overrideTone = patch.overrideTone;
    if (Object.prototype.hasOwnProperty.call(patch, 'overrideMotion')) debugConfig.overrideMotion = patch.overrideMotion;
    if (Object.prototype.hasOwnProperty.call(patch, 'freezeAuto')) debugConfig.freezeAuto = !!patch.freezeAuto;
  }

  function sampleVkEnvironmentFrameStats(options) {
    if (VK_STABLE_MODE) return null;
    if (mode !== 'vk' || !renderer || typeof renderer.sampleVkEnvironmentFrameStats !== 'function') return null;
    return renderer.sampleVkEnvironmentFrameStats(options || null);
  }

  api = {
    init: init,
    setMode: setMode,
    getMode: function() { return mode; },
    start: start,
    stop: stop,
    destroy: destroy,
    setVkZoom: setVkZoom,
    setNativeZoomCompensation: setNativeZoomCompensation,
    resizeToCssPixels: resizeToCssPixels,
    getCanvasNode: getCanvasNode,
    setVkRecordingHook: setVkRecordingHook,
    hintThermalPressure: hintThermalPressure,
    pauseAutoDegradeOnce: pauseAutoDegradeOnce,
    getVkAdaptiveDebugConfig: getVkAdaptiveDebugConfig,
    setVkAdaptiveDebugConfig: setVkAdaptiveDebugConfig,
    sampleVkEnvironmentFrameStats: sampleVkEnvironmentFrameStats,
    applyVkStableProfile: _applyVkStableUniforms,
    isVkStableMode: function() { return VK_STABLE_MODE; },
    snapshot: function() { return monitor ? monitor.snapshot() : null; },
    /**
     * 诊断快照：工具条用；不依赖 perf 窗口，首帧也能读到。
     * @returns {{mode:string, framesRendered:number, sinceLastFrameMs:number}}
     */
    diagnostics: function() {
      return {
        mode: mode,
        framesRendered: framesRendered,
        sinceLastFrameMs: lastFrameAt ? (_now() - lastFrameAt) : -1,
        vkAdaptiveCurve: {
          avgLuminance: _vkAdaptiveCurveState.avgLuminance,
          loadIndex: _vkAdaptiveCurveState.loadIndex,
          nightFactor: _vkAdaptiveCurveState.nightFactor,
          currentAmount: _vkAdaptiveCurveState.currentAmount,
          currentTone: _vkAdaptiveCurveState.currentTone,
          currentMotion: _vkAdaptiveCurveState.currentMotion,
          targetAmount: _vkAdaptiveCurveState.targetAmount,
          targetTone: _vkAdaptiveCurveState.targetTone,
          targetMotion: _vkAdaptiveCurveState.targetMotion
        }
      };
    }
  };
  return api;
}

module.exports = {
  createRenderPipeline: createRenderPipeline,
  debugConfig: debugConfig,
  VK_STABLE_MODE: VK_STABLE_MODE,
  VK_STABLE_PROFILE: VK_STABLE_PROFILE
};
