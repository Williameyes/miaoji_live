/**
 * 轻量级性能监控器：按「真实渲染帧」而非定时器采样，捕捉 FPS 与单帧 CPU 耗时。
 *
 * 设计要点（与 docs/live-stability-redesign 保持「稳定性 > 帧率 > 画质」一致）：
 *  - 由渲染管线在每次 draw 完成后调用 tick(frameMs)；统计天然对齐真实帧率。
 *  - 每秒汇总一次 { fps, avgFrameMs, maxFrameMs } 成为一个样本。
 *  - 滑动窗口保留最近 WINDOW_SIZE 个样本；上游以窗口均值/连续秒数为口径做降级判定，
 *    避免 GC / 网络抖动 / 系统打断导致的瞬时误降级。
 *  - 不额外创建定时器；零副作用。
 */

var WINDOW_SIZE = 5;

/**
 * @typedef {Object} PerfSample
 * @property {number} fps          窗口内瞬时 FPS
 * @property {number} avgFrameMs   窗口内平均帧耗时
 * @property {number} maxFrameMs   窗口内最大帧耗时
 * @property {number} t            样本结束墙钟（ms）
 */

/**
 * 创建一个性能监控实例。
 * @returns {{
 *   tick: (frameMs:number) => void,
 *   snapshot: () => ({avgFps:number,minFps:number,avgFrameMs:number,maxFrameMs:number,samples:number,lastTickAt:number}|null),
 *   isSustainedBelow: (fpsThreshold:number, consecutiveSec:number) => boolean,
 *   isStalled: (secs:number) => boolean,
 *   reset: () => void
 * }}
 */
function createPerformanceMonitor() {
  /** @type {PerfSample[]} */
  var windowSec = [];
  var secStart = 0;
  var secFrames = 0;
  var secSumMs = 0;
  var secMaxMs = 0;
  var lastTickAt = 0;

  /** 清空全部统计，用于模式切换后重新计算窗口。 */
  function reset() {
    windowSec = [];
    secStart = 0;
    secFrames = 0;
    secSumMs = 0;
    secMaxMs = 0;
    lastTickAt = 0;
  }

  /**
   * 每次渲染完成后调用。frameMs 为本帧 uploadFrame + draw 的 CPU 墙钟耗时。
   * @param {number} frameMs
   */
  function tick(frameMs) {
    var now = Date.now();
    if (!secStart) secStart = now;
    secFrames += 1;
    secSumMs += frameMs;
    if (frameMs > secMaxMs) secMaxMs = frameMs;
    lastTickAt = now;
    if (now - secStart >= 1000) {
      windowSec.push({
        fps: secFrames * 1000 / (now - secStart),
        avgFrameMs: secSumMs / Math.max(1, secFrames),
        maxFrameMs: secMaxMs,
        t: now
      });
      if (windowSec.length > WINDOW_SIZE) windowSec.shift();
      secStart = now;
      secFrames = 0;
      secSumMs = 0;
      secMaxMs = 0;
    }
  }

  /**
   * 取滑动窗口快照；无足够数据返回 null。
   * @returns {{avgFps:number,minFps:number,avgFrameMs:number,maxFrameMs:number,samples:number,lastTickAt:number}|null}
   */
  function snapshot() {
    if (windowSec.length === 0) return null;
    var total = 0;
    var min = Infinity;
    var sumMs = 0;
    var maxMs = 0;
    for (var i = 0; i < windowSec.length; i++) {
      var s = windowSec[i];
      total += s.fps;
      if (s.fps < min) min = s.fps;
      sumMs += s.avgFrameMs;
      if (s.maxFrameMs > maxMs) maxMs = s.maxFrameMs;
    }
    return {
      avgFps: total / windowSec.length,
      minFps: min,
      avgFrameMs: sumMs / windowSec.length,
      maxFrameMs: maxMs,
      samples: windowSec.length,
      lastTickAt: lastTickAt
    };
  }

  /**
   * 连续 N 秒 FPS 均低于阈值（用于「持续掉帧」判定，抑制瞬时抖动误触发降级）。
   * @param {number} fpsThreshold
   * @param {number} consecutiveSec
   * @returns {boolean}
   */
  function isSustainedBelow(fpsThreshold, consecutiveSec) {
    if (windowSec.length < consecutiveSec) return false;
    for (var i = windowSec.length - consecutiveSec; i < windowSec.length; i++) {
      if (windowSec[i].fps >= fpsThreshold) return false;
    }
    return true;
  }

  /**
   * 「卡死」判定：最近 secs 秒没有任何 tick —— 可能是主线程被阻塞或回调被系统挂起。
   * @param {number} secs
   * @returns {boolean}
   */
  function isStalled(secs) {
    if (!lastTickAt) return false;
    return (Date.now() - lastTickAt) > secs * 1000;
  }

  return {
    tick: tick,
    snapshot: snapshot,
    isSustainedBelow: isSustainedBelow,
    isStalled: isStalled,
    reset: reset
  };
}

module.exports = { createPerformanceMonitor: createPerformanceMonitor };
