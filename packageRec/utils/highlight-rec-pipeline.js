const highlightRecProfile = require('./highlight-rec-profile.js');
const { createPreviewRecordPipeline } = require('../../utils/replay-buffer/preview-record-pipeline.js');
const { createRollingAudioRecorder } = require('./rolling-audio-recorder.js');
const { exportAvHighlightClip } = require('./av-highlight-export.js');
const { createNativeRollingRecorder } = require('./native-rolling-recorder/index.js');

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
 * 原生相机滚动录制管线包装。
 *
 * @param {Object} page
 * @param {Object} perf
 * @returns {Object}
 */
function createNativeHighlightPipeline(page, perf) {
  var nativeRecorder = null;

  function getCameraContext() {
    return (page && (page._cameraCtx || (page.data && page.data.cameraContext))) || null;
  }

  function isSupported() {
    return typeof wx !== 'undefined' && typeof wx.createCameraContext === 'function';
  }

  function start() {
    var ctx = getCameraContext();
    if (!ctx) {
      return Promise.reject(new Error('camera_context_missing'));
    }
    if (nativeRecorder && nativeRecorder.isActive()) {
      return Promise.resolve();
    }
    if (!nativeRecorder) {
      // 动态读取 Profile 切分时长：1080p 选 60 秒 (~60MB)，720p 选 120 秒 (~60MB)，双分段共计 ~120MB 绝对低于 200MB 配额
      var nativeSegmentMs = perf.nativeSegmentMs || (perf.use1080p ? 60000 : 120000);
      nativeRecorder = createNativeRollingRecorder(ctx, {
        segmentMs: nativeSegmentMs,
        recordQuality: perf.use1080p ? 'high' : 'medium',
        skipMediaContainerTrim: !!perf.skipMediaContainerTrim,
        onError: function (err) {
          console.warn('[NativeHighlightPipeline] recorder error:', err);
        }
      });
    }
    nativeRecorder.start();
    return Promise.resolve();
  }

  function stop() {
    if (nativeRecorder) {
      try {
        nativeRecorder.stop();
      } catch (e) {}
    }
    return Promise.resolve();
  }

  function destroy() {
    stop();
    nativeRecorder = null;
  }

  function isActive() {
    return !!(nativeRecorder && nativeRecorder.isActive());
  }

  function getVideoSegments() {
    return nativeRecorder ? nativeRecorder.getSegments() : [];
  }

  function estimateBufferCoverageSec() {
    if (!nativeRecorder) return 0;
    var segs = nativeRecorder.getSegments();
    var total = 0;
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s && s.start && s.stop) {
        var wall = s.stop - s.start;
        if (wall > 0) total += Math.round(wall / 1000);
      }
    }
    if (nativeRecorder.isActive()) {
      var cur = nativeRecorder.getCurrentSegment();
      if (cur && cur.start) {
        total += Math.round((Date.now() - cur.start) / 1000);
      }
    }
    return Math.min(90, total);
  }

  function triggerExport(triggerTime) {
    if (!nativeRecorder || !nativeRecorder.isActive()) {
      return Promise.reject(new Error('recorder_not_active'));
    }
    return nativeRecorder.triggerExport();
  }

  function releaseExportedPath(path) {
    if (nativeRecorder && typeof nativeRecorder.releaseSegmentPath === 'function') {
      nativeRecorder.releaseSegmentPath(path);
    }
  }

  function getActiveMediaPaths() {
    if (nativeRecorder && typeof nativeRecorder.getActiveMediaPaths === 'function') {
      return nativeRecorder.getActiveMediaPaths();
    }
    return [];
  }

  return {
    recMode: highlightRecProfile.REC_MODE_NATIVE,
    isSupported: isSupported,
    start: start,
    stop: stop,
    destroy: destroy,
    triggerExport: triggerExport,
    releaseExportedPath: releaseExportedPath,
    getActiveMediaPaths: getActiveMediaPaths,
    isActive: isActive,
    getVideoSegments: getVideoSegments,
    estimateBufferCoverageSec: estimateBufferCoverageSec
  };
}

/**
 * 视录分离管线（Preview Record + Rolling Audio）。
 *
 * @param {Object} page
 * @param {Object} perf
 * @returns {Object}
 */
function createPreviewHighlightPipeline(page, perf) {
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

  function isSupported() {
    return previewPipeline.isSupported();
  }

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
        forceTargetCanvasSize: true,
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

  function stop() {
    page._livePageVisible = false;
    var pStop = previewPipeline.isActive() ? previewPipeline.stop() : Promise.resolve();
    return pStop.then(function () {
      return audioRecorder.stop();
    });
  }

  function destroy() {
    page._livePageVisible = false;
    try {
      previewPipeline.destroy();
    } catch (e) {}
  }

  function isActive() {
    return previewPipeline.isActive();
  }

  function getVideoSegments() {
    return previewPipeline.getSegments();
  }

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

  function releaseExportedPath(path) {
    if (previewPipeline && typeof previewPipeline.releaseSegmentPaths === 'function' && path) {
      previewPipeline.releaseSegmentPaths([path]);
    }
  }

  function getActiveMediaPaths() {
    var paths = [];
    var segs = getVideoSegments();
    for (var i = 0; i < segs.length; i++) {
      if (segs[i] && segs[i].path) {
        paths.push(segs[i].path);
      }
    }
    var audioSegs = typeof audioRecorder.getSegments === 'function'
      ? audioRecorder.getSegments()
      : [];
    for (var j = 0; j < audioSegs.length; j++) {
      if (audioSegs[j] && audioSegs[j].path) {
        paths.push(audioSegs[j].path);
      }
    }
    return paths;
  }

  return {
    recMode: highlightRecProfile.REC_MODE_PREVIEW_RECORD,
    isSupported: isSupported,
    start: start,
    stop: stop,
    destroy: destroy,
    triggerExport: triggerExport,
    releaseExportedPath: releaseExportedPath,
    getActiveMediaPaths: getActiveMediaPaths,
    isActive: isActive,
    getVideoSegments: getVideoSegments,
    estimateBufferCoverageSec: estimateBufferCoverageSec
  };
}

/**
 * 创建素材机录制管线（根据 profile.recMode 分发原生模式与视录分离模式）。
 *
 * @param {Object} page 小程序 Page 实例
 * @param {Object} [profile] highlight-rec-profile 输出
 * @returns {{
 *   recMode: string,
 *   isSupported: function(): boolean,
 *   start: function(): Promise<void>,
 *   stop: function(): Promise<void>,
 *   destroy: function(): void,
 *   triggerExport: function(number=): Promise<string>,
 *   isActive: function(): boolean,
 *   getVideoSegments: function(): Array<Object>,
 *   estimateBufferCoverageSec: function(): number
 * }}
 */
function createHighlightRecPipeline(page, profile) {
  var perf = profile || highlightRecProfile.getHighlightRecProfile({});
  if (perf.recMode === highlightRecProfile.REC_MODE_NATIVE) {
    return createNativeHighlightPipeline(page, perf);
  }
  return createPreviewHighlightPipeline(page, perf);
}

module.exports = {
  createHighlightRecPipeline: createHighlightRecPipeline,
  attachRollingPageAdapter: attachRollingPageAdapter,
  DEFAULT_LEAD_MS: DEFAULT_LEAD_MS
};
