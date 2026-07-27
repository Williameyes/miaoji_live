/**
 * @fileoverview 双轨交替录制器，通过顺序切换 A/B 轨道，以保证单设备相机录像段 of 无缝流转。
 */

function createDualTrackRecorder(cameraCtx, options) {
  var opts = options || {};
  var segmentMs = opts.segmentMs || 60000; // 默认 60 秒切分（由 Profile 动态指定：1080p 60秒，720p 120秒）
  var recordQuality = opts.recordQuality || 'medium';
  var stopToStartDelayMs = typeof opts.stopToStartDelayMs === 'number' ? opts.stopToStartDelayMs : 580;
  var onSegmentComplete = opts.onSegmentComplete;
  var onTrackActive = opts.onTrackActive;
  var onError = opts.onError;

  var activeTrack = null; // 'A' | 'B' | null
  var recording = false;
  var rotateTimer = null;
  var startDelayTimer = null;
  var currentSegment = null;
  var transitioning = false; // 状态转换锁，防止并发 rotate 导致硬件指令冲突

  function clearRotateTimer() {
    if (rotateTimer) {
      clearTimeout(rotateTimer);
      rotateTimer = null;
    }
  }

  function clearStartDelayTimer() {
    if (startDelayTimer) {
      clearTimeout(startDelayTimer);
      startDelayTimer = null;
    }
  }

  function scheduleStartTrack(trackId) {
    clearStartDelayTimer();
    if (!recording) {
      transitioning = false;
      return;
    }
    startDelayTimer = setTimeout(function () {
      startDelayTimer = null;
      if (recording) {
        startTrack(trackId);
      } else {
        transitioning = false;
      }
    }, Math.max(0, stopToStartDelayMs));
  }

  function startTrack(trackId) {
    if (!recording) {
      transitioning = false;
      return;
    }
    activeTrack = trackId;
    var startTime = Date.now();

    currentSegment = {
      trackId: trackId,
      start: startTime,
      stop: 0,
      path: ''
    };

    if (typeof onTrackActive === 'function') {
      onTrackActive(trackId);
    }

    var timeoutSec = Math.max(5, Math.ceil(segmentMs / 1000));
    cameraCtx.startRecord({
      quality: recordQuality,
      timeout: timeoutSec,
      timeoutCallback: function () {
        console.log('[DualTrack] Segment timeout callback, rotate');
        rotate(true);
      },
      success: function () {
        console.log('[DualTrack] Track started:', trackId);
        transitioning = false; // 启动成功，释放转换锁
      },
      fail: function (err) {
        var errDetail = (err && (err.errMsg || err.message)) ? (err.errMsg || err.message) : JSON.stringify(err || {});
        console.error('[DualTrack] Failed to start record for track:', trackId, errDetail);
        transitioning = false; // 失败也必须释放锁，防止卡死
        if (typeof onError === 'function') {
          onError(new Error('startRecord_failed: ' + errDetail));
        }
      }
    });

    // 安卓微信 API 兜底：1500ms 后强制解锁，防止安卓原生回调丢失导致状态锁死
    setTimeout(function () {
      if (transitioning) {
        console.log('[DualTrack] Safety unlock transitioning state');
        transitioning = false;
      }
    }, 1500);

    // 设定定时器自动切换轨道
    clearRotateTimer();
    rotateTimer = setTimeout(function () {
      rotate(false);
    }, segmentMs);
  }

  function stopTrack(trackId, nextTrackId, doneCb) {
    if (!currentSegment || currentSegment.trackId !== trackId) {
      transitioning = false;
      if (typeof doneCb === 'function') {
        doneCb();
      }
      return;
    }

    var segToComplete = currentSegment;
    segToComplete.stop = Date.now();

    // 安卓微信 API 兜底：3000ms 后强制解锁，防止 stopRecord 原生回调丢失导致状态挂死
    setTimeout(function () {
      if (transitioning) {
        console.log('[DualTrack] Safety unlock transitioning state from stopTrack');
        transitioning = false;
      }
    }, 3000);

    // 微信不支持多个录像流重叠。必须先停止，在其回调成功/失败后再开启下一轨道。
    cameraCtx.stopRecord({
      success: function (res) {
        segToComplete.path = res.tempVideoPath || res.tempFilePath || '';
        console.log('[DualTrack] Track stopped successfully:', trackId, 'Path:', segToComplete.path);
        if (!segToComplete.path) {
          console.warn('[DualTrack] stopRecord returned empty path for track:', trackId);
        }

        if (typeof onSegmentComplete === 'function') {
          onSegmentComplete(segToComplete);
        }

        if (typeof doneCb === 'function') {
          try { doneCb(null, segToComplete); } catch (e) {}
        }

        // stop→start 冷却，减轻 Android（尤其小米）Native 句柄未释放时的重试风暴与发热
        if (recording && nextTrackId) {
          scheduleStartTrack(nextTrackId);
        } else {
          transitioning = false;
        }
      },
      fail: function (err) {
        var errDetail = (err && (err.errMsg || err.message)) ? (err.errMsg || err.message) : JSON.stringify(err || {});
        console.error('[DualTrack] Failed to stop record for track:', trackId, errDetail);
        segToComplete.path = '';
        if (typeof onError === 'function') {
          onError(new Error('stopRecord_failed: ' + errDetail));
        }

        if (typeof doneCb === 'function') {
          try { doneCb(err); } catch (e) {}
        }

        if (recording && nextTrackId) {
          scheduleStartTrack(nextTrackId);
        } else {
          transitioning = false;
        }
      }
    });
  }

  function rotate(isTimeout) {
    if (!recording) return;
    if (transitioning) {
      console.log('[DualTrack] Rotate skipped: transition in progress. Rescheduling in 2000ms');
      clearRotateTimer();
      rotateTimer = setTimeout(function () {
        if (recording) {
          rotate(isTimeout);
        }
      }, 2000);
      return;
    }

    // 硬件保护：微信底层开始录像后硬件编码器需要至少 5000ms 初始化与写头时间。
    // 若起录不足 5000ms 即调用 stopRecord，Android (小米/华为等) 会引发 Native MediaRecorder 阻塞 30 秒卡死。
    var elapsed = Date.now() - (currentSegment ? currentSegment.start : 0);
    var minRecordMs = 5000;
    if (elapsed < minRecordMs) {
      var delay = minRecordMs - elapsed;
      console.log('[DualTrack] Segment recording too short (' + elapsed + 'ms). Deferring rotate by ' + delay + 'ms');
      
      setTimeout(function () {
        if (recording) {
          rotate(isTimeout);
        }
      }, delay);
      return;
    }

    clearRotateTimer();

    var prevTrack = activeTrack;
    var nextTrack = prevTrack === 'A' ? 'B' : 'A';

    console.log('[DualTrack] Rotating tracks:', prevTrack, '->', nextTrack, 'Timeout:', !!isTimeout);
    transitioning = true; // 加锁
    stopTrack(prevTrack, nextTrack);
  }

  function start() {
    if (recording) return;
    recording = true;
    transitioning = false;
    startTrack('A');
  }

  function stop() {
    if (!recording) return Promise.resolve();
    recording = false;
    clearRotateTimer();
    clearStartDelayTimer();
    if (activeTrack) {
      var targetTrack = activeTrack;
      activeTrack = null;
      return new Promise(function (resolve) {
        stopTrack(targetTrack, null, function () {
          resolve();
        });
      });
    }
    return Promise.resolve();
  }

  function forceRotate() {
    if (!recording) return;
    rotate(false);
  }

  function isActive() {
    return recording;
  }

  function getActiveTrack() {
    return activeTrack;
  }

  function getCurrentSegment() {
    return currentSegment;
  }

  return {
    start: start,
    stop: stop,
    rotate: forceRotate,
    isActive: isActive,
    getActiveTrack: getActiveTrack,
    getCurrentSegment: getCurrentSegment
  };
}

module.exports = {
  createDualTrackRecorder: createDualTrackRecorder
};
