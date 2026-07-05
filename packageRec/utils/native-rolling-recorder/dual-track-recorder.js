/**
 * @fileoverview 双轨交替录制器，通过顺序切换 A/B 轨道，以保证单设备相机录像段 of 无缝流转。
 */

function createDualTrackRecorder(cameraCtx, options) {
  var opts = options || {};
  var segmentMs = opts.segmentMs || 25000;
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

    cameraCtx.startRecord({
      quality: recordQuality,
      timeoutCallback: function () {
        console.log('[DualTrack] Segment timeout callback, rotate');
        rotate(true);
      },
      success: function () {
        console.log('[DualTrack] Track started:', trackId);
        transitioning = false; // 启动成功，释放转换锁
      },
      fail: function (err) {
        console.error('[DualTrack] Failed to start record for track:', trackId, err);
        transitioning = false; // 失败也必须释放锁，防止卡死
        if (typeof onError === 'function') {
          onError(err);
        }
      }
    });

    // 设定定时器自动切换轨道
    clearRotateTimer();
    rotateTimer = setTimeout(function () {
      rotate(false);
    }, segmentMs);
  }

  function stopTrack(trackId, nextTrackId) {
    if (!currentSegment || currentSegment.trackId !== trackId) {
      transitioning = false;
      return;
    }

    var segToComplete = currentSegment;
    segToComplete.stop = Date.now();

    // 微信不支持多个录像流重叠。必须先停止，在其回调成功/失败后再开启下一轨道。
    cameraCtx.stopRecord({
      success: function (res) {
        segToComplete.path = res.tempVideoPath || res.tempFilePath || '';
        console.log('[DualTrack] Track stopped successfully:', trackId, 'Path:', segToComplete.path);
        
        if (typeof onSegmentComplete === 'function') {
          onSegmentComplete(segToComplete);
        }

        // stop→start 冷却，减轻 Android（尤其小米）Native 句柄未释放时的重试风暴与发热
        if (recording && nextTrackId) {
          scheduleStartTrack(nextTrackId);
        } else {
          transitioning = false;
        }
      },
      fail: function (err) {
        console.error('[DualTrack] Failed to stop record for track:', trackId, err);
        if (typeof onError === 'function') {
          onError(err);
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
      console.log('[DualTrack] Rotate skipped: transition in progress');
      return;
    }

    // 硬件保护：微信底层开始录像后需要一定的初始化准备时间。
    // 如果当前分段启动录制不足 2000ms，直接调用 stopRecord 会引发 operateCamera:fail:stop error。
    var elapsed = Date.now() - (currentSegment ? currentSegment.start : 0);
    if (elapsed < 2000) {
      var delay = 2000 - elapsed;
      console.log('[DualTrack] Segment recording too short (' + elapsed + 'ms). Deferring rotate by ' + delay + 'ms');
      
      setTimeout(function () {
        if (recording && !transitioning) {
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
    if (!recording) return;
    recording = false;
    clearRotateTimer();
    clearStartDelayTimer();
    if (activeTrack) {
      stopTrack(activeTrack, null);
    }
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
