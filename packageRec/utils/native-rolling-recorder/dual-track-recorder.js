/**
 * @fileoverview 双轨交替录制器，通过顺序切换 A/B 轨道，以保证单设备相机录像段的无缝流转。
 */

function createDualTrackRecorder(cameraCtx, options) {
  var opts = options || {};
  var segmentMs = opts.segmentMs || 25000;
  var onSegmentComplete = opts.onSegmentComplete;
  var onTrackActive = opts.onTrackActive;
  var onError = opts.onError;

  var activeTrack = null; // 'A' | 'B' | null
  var recording = false;
  var rotateTimer = null;
  var currentSegment = null;

  function clearRotateTimer() {
    if (rotateTimer) {
      clearTimeout(rotateTimer);
      rotateTimer = null;
    }
  }

  function startTrack(trackId) {
    if (!recording) return;
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
      timeoutCallback: function () {
        console.log('[DualTrack] Segment timeout callback, rotate');
        rotate(true);
      },
      success: function () {
        console.log('[DualTrack] Track started:', trackId);
      },
      fail: function (err) {
        console.error('[DualTrack] Failed to start record for track:', trackId, err);
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
    if (!currentSegment || currentSegment.trackId !== trackId) return;

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

        // 停止成功后，若仍处于录制态，且有下一轨道，则启动它
        if (recording && nextTrackId) {
          startTrack(nextTrackId);
        }
      },
      fail: function (err) {
        console.error('[DualTrack] Failed to stop record for track:', trackId, err);
        if (typeof onError === 'function') {
          onError(err);
        }

        // 即使停止失败，也尝试启动下一个轨道，防死锁
        if (recording && nextTrackId) {
          startTrack(nextTrackId);
        }
      }
    });
  }

  function rotate(isTimeout) {
    if (!recording) return;
    clearRotateTimer();

    var prevTrack = activeTrack;
    var nextTrack = prevTrack === 'A' ? 'B' : 'A';

    console.log('[DualTrack] Rotating tracks:', prevTrack, '->', nextTrack, 'Timeout:', !!isTimeout);
    stopTrack(prevTrack, nextTrack);
  }

  function start() {
    if (recording) return;
    recording = true;
    startTrack('A');
  }

  function stop() {
    if (!recording) return;
    recording = false;
    clearRotateTimer();
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
