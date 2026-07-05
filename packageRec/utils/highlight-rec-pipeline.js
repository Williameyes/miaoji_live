/**
 * @fileoverview 高光素材机：视录分离视频 + 独立滚动收音 + 导出 mux。
 */

const { createPreviewRecordPipeline } = require('../../utils/replay-buffer/preview-record-pipeline.js');
const { createRollingAudioRecorder } = require('./rolling-audio-recorder.js');
const { exportAvHighlightClip } = require('./av-highlight-export.js');

/** 默认回溯窗口（ms）。 */
var DEFAULT_LEAD_MS = 8000;

/**
 * 跳过 mp4 文件头部黑场：MediaRecorder 起录时间早于首帧有效像素。
 * 跳过起点后须同步延长终点，保持完整 highlightLeadMs 窗长。
 *
 * @param {Record<string, unknown>|null} seekPlan
 * @param {number} skipMs
 * @returns {Record<string, unknown>|null}
 */
function adjustSeekPlanSkipBlackLeadIn(seekPlan, skipMs) {
  if (!seekPlan || !seekPlan.path) return seekPlan;
  var skip = Math.max(0, Math.floor(Number(skipMs) || 0));
  if (skip <= 0) return seekPlan;

  var plan = Object.assign({}, seekPlan);
  var leadMs = typeof plan.leadMs === 'number' && plan.leadMs > 0 ? plan.leadMs : DEFAULT_LEAD_MS;
  var wallDur = typeof plan.wallDurationMs === 'number' ? plan.wallDurationMs : 0;
  var winStart = typeof plan.windowStartInSegMs === 'number' ? plan.windowStartInSegMs : -1;
  var winEnd = typeof plan.windowEndInSegMs === 'number' ? plan.windowEndInSegMs : -1;

  /** 仅当裁剪窗起点落在段头黑场附近时才跳过，避免正常 8s 窗被无故缩短。 */
  var needsSkip = false;
  if (typeof plan.replayInitialTimeSec === 'number') {
    needsSkip = plan.replayInitialTimeSec * 1000 < skip + 250;
  } else if (winStart >= 0 && winEnd > winStart) {
    needsSkip = winStart < skip + 250;
  }
  if (!needsSkip) {
    if (wallDur > 0) {
      plan.segmentWallDurationMs = wallDur;
    }
    return plan;
  }

  if (winEnd > winStart + 500) {
    var nextStart = Math.min(winEnd - 500, winStart + skip);
    var skippedWallMs = nextStart - winStart;
    plan.windowStartInSegMs = nextStart;
    plan.windowEndInSegMs = Math.min(wallDur > 0 ? wallDur : winEnd + skippedWallMs, winEnd + skippedWallMs);
  }

  if (typeof plan.replayInitialTimeSec === 'number' && typeof plan.replayMediaStopAtSec === 'number') {
    var initBefore = plan.replayInitialTimeSec;
    var stopBefore = plan.replayMediaStopAtSec;
    var nextInit = Math.min(stopBefore - 0.5, initBefore + skip / 1000);
    var skippedSec = Math.max(0, nextInit - initBefore);
    plan.replayInitialTimeSec = Math.max(0, nextInit);
    var maxStopSec = wallDur > 0 ? wallDur / 1000 : stopBefore + leadMs / 1000;
    plan.replayMediaStopAtSec = Math.min(maxStopSec, stopBefore + skippedSec);
  } else if (wallDur > skip + 800) {
    plan.replayInitialTimeSec = skip / 1000;
    plan.replayMediaStopAtSec = Math.min(wallDur / 1000, (skip + leadMs) / 1000);
    plan.tailTrim = true;
    plan.seekMode = 'lead_in_skip';
  }

  if (wallDur > 0) {
    plan.segmentWallDurationMs = wallDur;
  }
  plan.fileLeadInSkipMs = skip;
  return plan;
}

/**
 * 为 Page 实例挂载 preview-record 所需的 rolling 目录与段列表适配。
 *
 * @param {Object} page
 * @param {string} rollingDir
 * @returns {void}
 */
function attachRollingPageAdapter(page, rollingDir) {
  page._highlightRecRollingDir = rollingDir;
  page.rollingSegments = page.rollingSegments || [];
  page.rollingBufferMax = page.rollingBufferMax || 4;
  page.segmentBuffer = page.rollingSegments;
  page._livePageVisible = true;

  if (typeof page.getRollingDir !== 'function') {
    page.getRollingDir = function () {
      return this._highlightRecRollingDir || '';
    };
  }
  if (typeof page.ensureRollingDir !== 'function') {
    page.ensureRollingDir = function () {
      var dir = this.getRollingDir();
      return new Promise(function (resolve, reject) {
        if (!dir) {
          reject(new Error('rolling_dir_missing'));
          return;
        }
        try {
          var fs = wx.getFileSystemManager();
          fs.access({
            path: dir,
            success: function () {
              resolve(dir);
            },
            fail: function () {
              fs.mkdir({
                dirPath: dir,
                recursive: true,
                success: function () {
                  resolve(dir);
                },
                fail: function (err) {
                  reject(err || new Error('mkdir_fail'));
                }
              });
            }
          });
        } catch (e) {
          reject(e);
        }
      });
    };
  }
}

/**
 * 创建素材机视录分离 + 收音管线。
 *
 * @param {Object} page 小程序 Page 实例
 * @param {Object} [profile] highlight-rec-profile 输出
 * @returns {{
 *   isSupported: function(): boolean,
 *   start: function(): Promise<void>,
 *   stop: function(): Promise<void>,
 *   destroy: function(): void,
 *   triggerExport: function(number): Promise<string>,
 *   isActive: function(): boolean,
 *   getVideoSegments: function(): Array<Object>,
 *   estimateBufferCoverageSec: function(): number
 * }}
 */
function createHighlightRecPipeline(page, profile) {
  var perf = profile || highlightRecProfile.getHighlightRecProfile({});
  var rollingDir = (wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH : '') + '/highlight_rec_rolling';
  attachRollingPageAdapter(page, rollingDir);

  var previewPipeline = createPreviewRecordPipeline(page);
  var audioRecorder = createRollingAudioRecorder({
    segmentMs: perf.audioSegmentMs || 50000,
    maxSegments: perf.audioMaxSegments || 4,
    format: perf.audioFormat || 'mp3',
    onError: function (err) {
      console.warn('[HighlightRecPipeline] audio error:', err);
    }
  });

  var leadMs = perf.highlightLeadMs || DEFAULT_LEAD_MS;
  var bufferTargetMs = perf.bufferTargetMs || 90000;
  var contentLeadInSkipMs = perf.contentLeadInSkipMs || 0;
  var starting = false;

  /**
   * @returns {boolean}
   */
  function isSupported() {
    return previewPipeline.isSupported();
  }

  /**
   * @returns {Promise<void>}
   */
  function start() {
    if (starting || previewPipeline.isActive()) {
      return Promise.resolve();
    }
    if (!isSupported()) {
      return Promise.reject(new Error('preview_record_unsupported'));
    }
    if (!page.data || !page.data.cameraContext) {
      return Promise.reject(new Error('camera_context_missing'));
    }

    starting = true;
    page._livePageVisible = true;

    var chunkMs = perf.chunkDurationMs || 50000;
    var staggerMs = perf.staggerMs || 8000;

    return page.ensureRollingDir().then(function () {
      return previewPipeline.start({
        cameraContext: page.data.cameraContext,
        chunkDurationMs: chunkMs,
        staggerMs: staggerMs,
        highlightFlushMinIntervalMs: perf.highlightFlushMinIntervalMs || 3000,
        fps: perf.recordFps || 24,
        canvasWidth: perf.canvasWidth || 720,
        canvasHeight: perf.canvasHeight || 1280,
        videoBitsPerSecondKbps: perf.videoBitsPerSecondKbps || 4800,
        maxFiles: perf.rollingMaxFiles || 2,
        requireFirstFrame: true,
        deferEncoderInit: true,
        warmupMinFrames: perf.warmupMinFrames || 8,
        encoderLiveWarmupFrames: perf.encoderLiveWarmupFrames || 24
      });
    }).then(function () {
      audioRecorder.start();
      starting = false;
    }).catch(function (err) {
      starting = false;
      throw err;
    });
  }

  /**
   * @returns {Promise<void>}
   */
  function stop() {
    page._livePageVisible = false;
    var pStop = previewPipeline.isActive() ? previewPipeline.stop() : Promise.resolve();
    return pStop.then(function () {
      return audioRecorder.stop();
    });
  }

  /**
   * @returns {void}
   */
  function destroy() {
    page._livePageVisible = false;
    try {
      previewPipeline.destroy();
    } catch (e) {}
  }

  /**
   * @returns {boolean}
   */
  function isActive() {
    return previewPipeline.isActive();
  }

  /**
   * @returns {Array<Object>}
   */
  function getVideoSegments() {
    return previewPipeline.getSegments();
  }

  /**
   * 估算当前环内视频缓冲覆盖秒数。
   *
   * @returns {number}
   */
  function estimateBufferCoverageSec() {
    var segs = getVideoSegments();
    var total = 0;
    var i;
    for (i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (!s) continue;
      var wall = (s.endTime || 0) - (s.startTime || 0);
      if (wall > 0) total += Math.round(wall / 1000);
    }
    if (previewPipeline.isActive()) {
      var hb = previewPipeline.getLastHeartbeatAt();
      if (hb > 0) {
        total += Math.min(Math.ceil(bufferTargetMs / 1000), Math.round((Date.now() - hb) / 1000));
      }
    }
    return Math.min(Math.ceil(bufferTargetMs / 1000), total);
  }

  /**
   * 触发导出：flush 视频轨 + 裁切 + 与同时段音频 mux。
   *
   * @param {number} [triggerTime]
   * @returns {Promise<string>}
   */
  function triggerExport(triggerTime) {
    if (!previewPipeline.isActive()) {
      return Promise.reject(new Error('recorder_not_active'));
    }
    var clickTime = Math.floor(Number(triggerTime) || Date.now());
    var windowStart = clickTime - leadMs;
    var windowEnd = clickTime;

    return audioRecorder.flushActiveSegmentForExport().then(function () {
      return previewPipeline.flushAndResolveHighlightSeek(clickTime, leadMs);
    }).then(function (seekPlan) {
      if (!seekPlan || !seekPlan.path) {
        throw new Error('no_video_highlight_segment');
      }
      seekPlan = adjustSeekPlanSkipBlackLeadIn(seekPlan, contentLeadInSkipMs);
      var audioPlan = audioRecorder.resolveTrimPlan(windowStart, windowEnd);
      if (!audioPlan) {
        console.warn('[HighlightRecPipeline] audio plan missing for window', windowStart, windowEnd);
      }
      return exportAvHighlightClip(seekPlan.path, seekPlan, audioPlan);
    });
  }

  return {
    isSupported: isSupported,
    start: start,
    stop: stop,
    destroy: destroy,
    triggerExport: triggerExport,
    isActive: isActive,
    getVideoSegments: getVideoSegments,
    estimateBufferCoverageSec: estimateBufferCoverageSec
  };
}

module.exports = {
  createHighlightRecPipeline: createHighlightRecPipeline,
  attachRollingPageAdapter: attachRollingPageAdapter,
  DEFAULT_LEAD_MS: DEFAULT_LEAD_MS
};
