/**
 * 双离屏 Canvas + 双 MediaRecorder 乒乓缓冲调度器。
 * 保险：stop/start 错开、禁止双 stop、定期 destroy/recreate session。
 */

const fsReady = require('./fs-ready.js');

const TRACK_IDS = ['A', 'B'];

/**
 * @param {*} v
 * @returns {boolean}
 */
function isPromiseLike(v) {
  return v && typeof v.then === 'function';
}

/**
 * @param {Object} recorder
 * @returns {Promise<void>}
 */
function startRecorder(recorder) {
  return new Promise((resolve, reject) => {
    if (!recorder || typeof recorder.start !== 'function') {
      reject(new Error('recorder.start missing'));
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      if (typeof recorder.on === 'function') {
        recorder.on('start', finish);
      }
    } catch (eOn) { }
    try {
      const ret = recorder.start();
      if (isPromiseLike(ret)) {
        ret.then(finish).catch(reject);
        return;
      }
    } catch (eStart) {
      reject(eStart);
      return;
    }
    setTimeout(finish, 120);
  });
}

/**
 * @param {Object} recorder
 * @returns {Promise<{ tempFilePath?: string }>}
 */
function stopRecorder(recorder) {
  return new Promise((resolve, reject) => {
    if (!recorder || typeof recorder.stop !== 'function') {
      reject(new Error('recorder.stop missing'));
      return;
    }
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      resolve(res || {});
    };
    try {
      if (typeof recorder.on === 'function') {
        recorder.on('stop', finish);
      }
    } catch (eOn) { }
    try {
      const ret = recorder.stop();
      if (isPromiseLike(ret)) {
        ret.then(finish).catch(reject);
        return;
      }
    } catch (eStop) {
      reject(eStop);
      return;
    }
    setTimeout(() => finish({}), 15000);
  });
}

/**
 * @param {Object} recorder
 * @returns {Promise<void>}
 */
function requestFrameRecorder(recorder) {
  if (!recorder || typeof recorder.requestFrame !== 'function') {
    return Promise.resolve();
  }
  const ret = recorder.requestFrame();
  if (isPromiseLike(ret)) return ret;
  return new Promise((resolve) => {
    try {
      recorder.requestFrame(() => resolve());
    } catch (e) {
      resolve();
    }
  });
}

/**
 * @param {string} rollingDir
 * @param {string} trackId
 * @param {number} seq
 * @returns {string}
 */
function buildDestPath(rollingDir, trackId, seq) {
  return `${rollingDir}/pp_${trackId}_${seq}_${Date.now()}.mp4`;
}

class PingPongRecorder {
  /**
   * @param {Object} opts
   * @param {function(string, Object=): void} [opts.onLog]
   * @param {function(Object): void} [opts.onSegmentReady]
   * @param {string} opts.rollingDir
   * @param {function(): Promise<string>} [opts.ensureRollingDir]
   * @param {number} [opts.chunkDurationMs]
   * @param {number} [opts.staggerMs]
   * @param {number} [opts.fps]
   * @param {number} [opts.stopToStartGapMs]
   * @param {number} [opts.recycleIntervalMs]
   * @param {number} [opts.maxFiles]
   * @param {number} [opts.canvasWidth]
   * @param {number} [opts.canvasHeight]
   */
  constructor(opts) {
    const options = opts || {};
    this.onLog = typeof options.onLog === 'function' ? options.onLog : () => { };
    this.onSegmentReady = typeof options.onSegmentReady === 'function' ? options.onSegmentReady : () => { };
    this.rollingDir = options.rollingDir || '';
    this.ensureRollingDir = typeof options.ensureRollingDir === 'function'
      ? options.ensureRollingDir
      : () => Promise.resolve(this.rollingDir);
    this.chunkDurationMs = options.chunkDurationMs || 16000;
    this.staggerMs = options.staggerMs || 8000;
    this.stopToStartGapMs = options.stopToStartGapMs || 400;
    this.recycleIntervalMs = options.recycleIntervalMs || 20 * 60 * 1000;
    this.maxFiles = options.maxFiles || 4;
    this.fps = Math.max(5, Math.min(24, options.fps || 12));
    this.canvasWidth = options.canvasWidth || 640;
    this.canvasHeight = options.canvasHeight || 360;

    /** @type {Record<string, Object>} */
    this.tracks = {};
    /** @type {Array<{ path: string, startTime: number, endTime: number, trackId: string }>} */
    this.segments = [];
    /** @type {string[]} */
    this.rollingFiles = [];
    this.active = false;
    this.sessionId = 0;
    this._timers = [];
    this._seq = 0;
    this._pinnedPaths = new Set();
    this._stopInFlight = false;
    this._startInFlight = false;
  }

  /**
   * @param {string} eventName
   * @param {Object} [detail]
   * @returns {void}
   */
  _log(eventName, detail) {
    this.onLog(eventName, detail || {});
  }

  /**
   * @returns {boolean}
   */
  static isApiSupported() {
    return typeof wx !== 'undefined'
      && typeof wx.createMediaRecorder === 'function'
      && typeof wx.createOffscreenCanvas === 'function';
  }

  /**
   * @param {import('../render/camera-blit-renderer.js')} blitFactory
   * @returns {Promise<void>}
   */
  init(blitFactory) {
    const blitMod = blitFactory || require('../render/camera-blit-renderer.js');
    const createBlit = blitMod.createCameraBlitRenderer;
    const tasks = TRACK_IDS.map((trackId) => this._createTrack(trackId, createBlit));
    return Promise.all(tasks).then(() => {
      this._log('ping_pong_init_ok', { tracks: TRACK_IDS.length });
    });
  }

  /**
   * @param {string} trackId
   * @param {function(): Object} createBlit
   * @returns {Promise<void>}
   */
  _createTrack(trackId, createBlit) {
    const canvas = wx.createOffscreenCanvas({
      type: 'webgl',
      width: this.canvasWidth,
      height: this.canvasHeight
    });
    const blit = createBlit();
    return blit.init({ canvasNode: canvas }).then(() => {
      this.tracks[trackId] = {
        id: trackId,
        canvas,
        blit,
        recorder: null,
        recording: false,
        recordStartWallMs: 0,
        createdAt: Date.now(),
        stopTimer: null,
        restartTimer: null,
        recycleTimer: null
      };
    });
  }

  /**
   * @param {string} trackId
   * @returns {Promise<void>}
   */
  _ensureRecorder(trackId) {
    const track = this.tracks[trackId];
    if (!track) return Promise.reject(new Error('track missing'));
    if (track.recorder) return Promise.resolve();
    if (!PingPongRecorder.isApiSupported()) {
      return Promise.reject(new Error('createMediaRecorder unsupported'));
    }
    const durationSec = Math.max(5, Math.ceil(this.chunkDurationMs / 1000) + 4);
    track.recorder = wx.createMediaRecorder(track.canvas, {
      duration: Math.min(7200, durationSec),
      fps: this.fps,
      videoBitsPerSecond: 1200,
      gop: Math.max(6, Math.floor(this.fps)),
      width: this.canvasWidth,
      height: this.canvasHeight
    });
    track.createdAt = Date.now();
    this._armRecycleTimer(trackId);
    return Promise.resolve();
  }

  /**
   * @param {string} trackId
   * @returns {void}
   */
  _armRecycleTimer(trackId) {
    const track = this.tracks[trackId];
    if (!track) return;
    if (track.recycleTimer) clearTimeout(track.recycleTimer);
    track.recycleTimer = setTimeout(() => {
      if (!this.active) return;
      this._recycleTrackSession(trackId, 'interval').catch(() => { });
    }, this.recycleIntervalMs);
  }

  /**
   * @param {string} trackId
   * @param {string} reason
   * @returns {Promise<void>}
   */
  _recycleTrackSession(trackId, reason) {
    const track = this.tracks[trackId];
    if (!track) return Promise.resolve();
    const wasRecording = track.recording;
    return this._stopTrack(trackId, 'recycle')
      .catch(() => { })
      .then(() => {
        this._destroyRecorder(track);
        if (wasRecording && this.active) {
          return this._delay(this.stopToStartGapMs).then(() => this._startTrack(trackId, 'recycle_restart'));
        }
        return undefined;
      })
      .then(() => {
        this._log('ping_pong_track_recycled', { trackId, reason });
      });
  }

  /**
   * @param {Object} track
   * @returns {void}
   */
  _destroyRecorder(track) {
    if (!track || !track.recorder) return;
    try {
      if (track.recorder.destroy) track.recorder.destroy();
    } catch (e) { }
    track.recorder = null;
  }

  /**
   * @returns {number}
   */
  _countRecordingTracks() {
    return TRACK_IDS.filter((id) => {
      const t = this.tracks[id];
      return t && t.recording;
    }).length;
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  _delay(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  /**
   * @param {string} trackId
   * @param {string} source
   * @returns {Promise<void>}
   */
  _startTrack(trackId, source) {
    const track = this.tracks[trackId];
    if (!track || track.recording || !this.active) return Promise.resolve();
    if (this._startInFlight) return Promise.resolve();
    this._startInFlight = true;
    return this._ensureRecorder(trackId)
      .then(() => startRecorder(track.recorder))
      .then(() => {
        track.recording = true;
        track.recordStartWallMs = Date.now();
        if (track.stopTimer) clearTimeout(track.stopTimer);
        track.stopTimer = setTimeout(() => {
          this._rotateTrack(trackId, 'chunk_duration').catch(() => { });
        }, this.chunkDurationMs);
        this._log('ping_pong_track_start', { trackId, source });
      })
      .catch((err) => {
        this._log('ping_pong_track_start_fail', { trackId, source, err: String(err && err.message || err) });
      })
      .finally(() => {
        this._startInFlight = false;
      });
  }

  /**
   * @param {string} trackId
   * @param {string} source
   * @returns {Promise<void>}
   */
  _rotateTrack(trackId, source) {
    return this._stopTrack(trackId, source)
      .then(() => this._delay(this.stopToStartGapMs))
      .then(() => {
        if (!this.active) return;
        return this._startTrack(trackId, `${source}_restart`);
      });
  }

  /**
   * @param {string} trackId
   * @param {string} source
   * @returns {Promise<void>}
   */
  _stopTrack(trackId, source) {
    const track = this.tracks[trackId];
    if (!track || !track.recording) return Promise.resolve();
    /** 保险 2：禁止双 stop */
    if (this._countRecordingTracks() <= 1 && source !== 'shutdown' && source !== 'recycle') {
      this._log('ping_pong_stop_blocked_last_track', { trackId, source });
      if (track.stopTimer) clearTimeout(track.stopTimer);
      track.stopTimer = setTimeout(() => {
        this._rotateTrack(trackId, 'deferred_rotate').catch(() => { });
      }, this.staggerMs);
      return Promise.resolve();
    }
    if (this._stopInFlight) return Promise.resolve();
    this._stopInFlight = true;
    const recordStart = track.recordStartWallMs || Date.now();
    const recordEnd = Date.now();
    track.recording = false;
    if (track.stopTimer) {
      clearTimeout(track.stopTimer);
      track.stopTimer = null;
    }
    const recorder = track.recorder;
    return stopRecorder(recorder)
      .then((res) => this._persistTemp(trackId, res && res.tempFilePath, recordStart, recordEnd))
      .catch((err) => {
        this._log('ping_pong_track_stop_fail', { trackId, source, err: String(err && err.message || err) });
      })
      .finally(() => {
        this._stopInFlight = false;
      });
  }

  /**
   * @param {string} trackId
   * @param {string} tempPath
   * @param {number} startTime
   * @param {number} endTime
   * @returns {Promise<void>}
   */
  _persistTemp(trackId, tempPath, startTime, endTime) {
    if (!tempPath) return Promise.resolve();
    this._seq += 1;
    const seq = this._seq;
    return this.ensureRollingDir().then((dir) => {
      const rollingDir = dir || this.rollingDir;
      const destPath = buildDestPath(rollingDir, trackId, seq);
      const fs = wx.getFileSystemManager();
      return fsReady.waitForFileReady(tempPath, {
        minBytes: fsReady.DEFAULT_MIN_BYTES || 1024,
        maxWaitMs: 3200,
        pollMs: 100
      }).then((readyInfo) => {
        if (!readyInfo || !readyInfo.ready) {
          this._log('ping_pong_persist_not_ready', { trackId, reason: readyInfo && readyInfo.reason });
          return;
        }
        return new Promise((resolve) => {
          const done = (finalPath) => {
            if (!finalPath) {
              resolve();
              return;
            }
            const segment = {
              path: finalPath,
              startTime,
              endTime,
              trackId,
              sessionId: this.sessionId,
              ready: true
            };
            this.segments.push(segment);
            this.rollingFiles.push(finalPath);
            this._pruneRollingFiles();
            this.onSegmentReady(segment);
            this._log('ping_pong_segment_ready', {
              trackId,
              path: finalPath,
              startTime,
              endTime,
              sizeBytes: readyInfo.size || 0
            });
            resolve();
          };
          if (fs.saveFile) {
            fs.saveFile({
              tempFilePath: tempPath,
              filePath: destPath,
              success: (res) => done((res && res.savedFilePath) || destPath),
              fail: () => {
                if (!fs.copyFile) {
                  done('');
                  return;
                }
                fs.copyFile({
                  srcPath: tempPath,
                  destPath,
                  success: () => done(destPath),
                  fail: () => done('')
                });
              }
            });
            return;
          }
          if (fs.copyFile) {
            fs.copyFile({
              srcPath: tempPath,
              destPath,
              success: () => done(destPath),
              fail: () => done('')
            });
            return;
          }
          done('');
        });
      });
    });
  }

  /**
   * @returns {void}
   */
  _pruneRollingFiles() {
    while (this.rollingFiles.length > this.maxFiles) {
      const old = this.rollingFiles.shift();
      if (!old || this._pinnedPaths.has(old)) {
        this.rollingFiles.unshift(old);
        break;
      }
      this.segments = this.segments.filter((seg) => seg.path !== old);
      try {
        wx.getFileSystemManager().unlinkSync(old);
      } catch (e) { }
      this._log('ping_pong_file_pruned', { path: old });
    }
  }

  /**
   * @param {string[]} paths
   * @returns {void}
   */
  pinPaths(paths) {
    (paths || []).forEach((p) => {
      if (p) this._pinnedPaths.add(p);
    });
  }

  /**
   * @param {string[]} paths
   * @returns {void}
   */
  unpinPaths(paths) {
    (paths || []).forEach((p) => {
      if (p) this._pinnedPaths.delete(p);
    });
  }

  /**
   * @returns {Promise<void>}
   */
  start() {
    if (this.active) return Promise.resolve();
    if (!PingPongRecorder.isApiSupported()) {
      return Promise.reject(new Error('ping-pong API unsupported'));
    }
    this.active = true;
    this.sessionId += 1;
    this._log('ping_pong_start', { sessionId: this.sessionId });
    return this._startTrack('A', 'kickoff').then(() => {
      const t = setTimeout(() => {
        if (!this.active) return;
        this._startTrack('B', 'stagger').catch(() => { });
      }, this.staggerMs);
      this._timers.push(t);
    });
  }

  /**
   * @returns {Promise<void>}
   */
  stop() {
    this.active = false;
    this._timers.forEach((t) => clearTimeout(t));
    this._timers = [];
    TRACK_IDS.forEach((id) => {
      const track = this.tracks[id];
      if (!track) return;
      if (track.stopTimer) clearTimeout(track.stopTimer);
      if (track.restartTimer) clearTimeout(track.restartTimer);
      if (track.recycleTimer) clearTimeout(track.recycleTimer);
    });
    const stops = TRACK_IDS.map((id) => this._stopTrack(id, 'shutdown').catch(() => { }));
    return Promise.all(stops).then(() => {
      TRACK_IDS.forEach((id) => {
        const track = this.tracks[id];
        if (track) this._destroyRecorder(track);
      });
      this._log('ping_pong_stop', { sessionId: this.sessionId });
    });
  }

  /**
   * 将相机帧绘制到所有正在录制的轨道。
   * @param {{ data: ArrayBuffer, width: number, height: number }} frame
   * @returns {Promise<void>}
   */
  feedFrame(frame) {
    if (!this.active || !frame) return Promise.resolve();
    const tasks = TRACK_IDS.map((trackId) => {
      const track = this.tracks[trackId];
      if (!track || !track.recording || !track.recorder || !track.blit) return Promise.resolve();
      return requestFrameRecorder(track.recorder)
        .then(() => {
          track.blit.drawRgba(frame);
        })
        .catch(() => { });
    });
    return Promise.all(tasks).then(() => { });
  }

  /**
   * 获取当前活跃录制轨（含正在录但未落盘的虚拟段）。
   * @returns {Array<{ path?: string, startTime: number, endTime: number, trackId: string, live?: boolean }>}
   */
  snapshotSegments() {
    const now = Date.now();
    const live = TRACK_IDS.map((trackId) => {
      const track = this.tracks[trackId];
      if (!track || !track.recording || !track.recordStartWallMs) return null;
      return {
        startTime: track.recordStartWallMs,
        endTime: now,
        trackId,
        live: true
      };
    }).filter(Boolean);
    return this.segments.slice().concat(live);
  }

  /**
   * 按点击时间解析单文件高光（乒乓重叠模型）。
   * @param {number} clickTime
   * @param {number} leadMs
   * @returns {{ path: string, replayInitialTimeSec: number, replayMediaStopAtSec: number }|null}
   */
  resolveHighlightSeek(clickTime, leadMs) {
    const lead = typeof leadMs === 'number' && leadMs > 0 ? leadMs : 8000;
    const windowStart = clickTime - lead;
    const windowEnd = clickTime;
    const candidates = this.segments
      .filter((seg) => seg && seg.path && seg.endTime > windowStart && seg.startTime <= windowEnd)
      .sort((a, b) => b.startTime - a.startTime);
    let target = null;
    for (let i = 0; i < candidates.length; i += 1) {
      const seg = candidates[i];
      const activeMs = windowEnd - seg.startTime;
      if (activeMs >= lead) {
        target = seg;
        break;
      }
    }
    if (!target && candidates.length) {
      target = candidates[0];
    }
    if (!target || !target.path) return null;
    const offsetMs = Math.max(0, windowStart - target.startTime);
    const stopMs = Math.min(target.endTime - target.startTime, windowEnd - target.startTime);
    return {
      path: target.path,
      replayInitialTimeSec: offsetMs / 1000,
      replayMediaStopAtSec: Math.max(0.08, stopMs / 1000)
    };
  }

  /**
   * @returns {void}
   */
  destroy() {
    this.stop().finally(() => {
      TRACK_IDS.forEach((trackId) => {
        const track = this.tracks[trackId];
        if (!track) return;
        if (track.blit && track.blit.destroy) track.blit.destroy();
        this._destroyRecorder(track);
      });
      this.tracks = {};
      this.segments = [];
      this.rollingFiles = [];
    });
  }
}

module.exports = {
  PingPongRecorder
};
