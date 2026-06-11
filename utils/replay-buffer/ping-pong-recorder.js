/**
 * 双离屏 Canvas + 双 MediaRecorder 乒乓缓冲调度器。
 * 保险：stop/start 错开、禁止双 stop、定期 destroy/recreate session。
 */

const fsReady = require('./fs-ready.js');
const { formatWxErr } = require('./wx-err.js');

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
 * 在 MediaRecorder requestFrame 回调内完成 canvas 绘制（官方语义）。
 * Android 若在 callback 外 draw，会录到 cleared/black buffer。
 * @param {Object} recorder
 * @param {function(): void} [onDraw] 须在 callback 内执行的绘制逻辑
 * @returns {Promise<void>}
 */
function requestFrameRecorder(recorder, onDraw) {
  if (!recorder || typeof recorder.requestFrame !== 'function') {
    if (typeof onDraw === 'function') {
      try { onDraw(); } catch (eDraw) { }
    }
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let finished = false;
    /**
     * @param {Error|unknown} [err]
     * @returns {void}
     */
    const finish = (err) => {
      if (finished) return;
      finished = true;
      if (err) reject(err);
      else resolve();
    };
    /**
     * @returns {void}
     */
    const drawInCallback = () => {
      if (typeof onDraw !== 'function') return;
      try {
        onDraw();
      } catch (eDraw) { }
    };
    try {
      const ret = recorder.requestFrame(() => {
        drawInCallback();
        finish();
      });
      if (isPromiseLike(ret)) {
        ret.then(() => {
          if (!finished) {
            drawInCallback();
            finish();
          }
        }).catch((err) => finish(err));
      }
    } catch (eReq) {
      finish(eReq);
    }
    /** requestFrame 偶发永不回调（尤其 camera remount 后），须超时释放以免 feed 永久锁死。 */
    setTimeout(() => finish(new Error('requestFrame timeout')), 800);
  });
}

/**
 * 按平台返回 MediaRecorder 视频码率（与 camera.startRecord 对齐，避免 Android 极低码率黑场）。
 * @returns {number}
 */
function resolveRecorderVideoBitsPerSecond() {
  if (typeof wx === 'undefined' || typeof wx.getSystemInfoSync !== 'function') {
    return 3000;
  }
  try {
    const platform = String(wx.getSystemInfoSync().platform || '').toLowerCase();
    if (platform === 'android') return 3600;
    if (platform === 'ios') return 3000;
  } catch (eSys) { }
  return 2800;
}

/**
 * Android 双 MediaRecorder 并发时 B 轨易产出空壳；单轨模式更稳定。
 * @returns {boolean}
 */
function preferAndroidSingleTrackRecorder() {
  if (typeof wx === 'undefined' || typeof wx.getSystemInfoSync !== 'function') {
    return false;
  }
  try {
    return String(wx.getSystemInfoSync().platform || '').toLowerCase() === 'android';
  } catch (eSys) {
    return false;
  }
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
   * @param {number} [opts.highlightFlushMinIntervalMs] 强制 flush 最小间隔，防连按引发 601
   * @param {function(string): Promise<void>} [opts.onStoragePressure] flush 落盘失败时释放配额
   */
  constructor(opts) {
    const options = opts || {};
    this.onLog = typeof options.onLog === 'function' ? options.onLog : () => { };
    this.onSegmentReady = typeof options.onSegmentReady === 'function' ? options.onSegmentReady : () => { };
    this.onTrackActivity = typeof options.onTrackActivity === 'function' ? options.onTrackActivity : () => { };
    this.onStoragePressure = typeof options.onStoragePressure === 'function'
      ? options.onStoragePressure
      : () => Promise.resolve();
    this.rollingDir = options.rollingDir || '';
    this.ensureRollingDir = typeof options.ensureRollingDir === 'function'
      ? options.ensureRollingDir
      : () => Promise.resolve(this.rollingDir);
    this.chunkDurationMs = options.chunkDurationMs || 180000;
    this.staggerMs = options.staggerMs || options.overlapMs || 8000;
    /** 双轨重叠时长（毫秒）：B 在 A 结束前 overlapMs 启动。 */
    this.overlapMs = options.overlapMs || this.staggerMs || 8000;
    this.stopToStartGapMs = options.stopToStartGapMs || 400;
    this.recycleIntervalMs = options.recycleIntervalMs || 25 * 60 * 1000;
    this.maxFiles = options.maxFiles || 2;
    this.fps = Math.max(5, Math.min(24, options.fps || 15));
    this.canvasWidth = options.canvasWidth || 854;
    this.canvasHeight = options.canvasHeight || 480;
    /** 高光强制 flush 最小间隔（毫秒），抑制 1 分钟内频繁启停管线。 */
    this.highlightFlushMinIntervalMs = Math.max(
      8000,
      options.highlightFlushMinIntervalMs || 10000
    );

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
    /** @type {Array<{ trackId: string, source: string, resolve: function(): void }>} */
    this._pendingStopQueue = [];
    this._stopInFlight = false;
    /** 仅单轨在录且无法 rotate 的起始时间，用于超时强制落盘。 */
    this._singleTrackStuckAt = 0;
    /** 双轨健康巡检句柄。 */
    this._dualTrackHealthTimer = null;
    /** 上次高光强制 flush 墙钟，用于频率限制。 */
    this._lastHighlightFlushAt = 0;
    /** 最近一帧相机 RGBA，stop 前须再绘制一次确保落盘段有画面。 */
    this._lastCameraFrame = null;
    /** Android 默认单轨，避免 B 轨空壳与双 WebGL 并发采帧失败。 */
    this._singleTrackMode = options.singleTrackMode != null
      ? !!options.singleTrackMode
      : preferAndroidSingleTrackRecorder();
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
    return blit.init({ canvasNode: canvas, preserveDrawingBuffer: true }).then(() => {
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
        recycleTimer: null,
        startInFlight: false,
        pendingStarts: []
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
    const chunkSec = Math.ceil(this.chunkDurationMs / 1000);
    const durationSec = Math.max(60, chunkSec * 2 + 12);
    track.recorder = wx.createMediaRecorder(track.canvas, {
      duration: Math.min(7200, durationSec),
      fps: this.fps,
      videoBitsPerSecond: resolveRecorderVideoBitsPerSecond(),
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
    /** B 轨错峰 recycle，避免 20min 时双轨同时 destroy 导致单轨死锁。 */
    const recycleDelayMs = this.recycleIntervalMs + (trackId === 'B' ? this.staggerMs : 0);
    track.recycleTimer = setTimeout(() => {
      if (!this.active) return;
      this._recycleTrackSession(trackId, 'interval').catch(() => { });
    }, recycleDelayMs);
  }

  /**
   * @param {string} trackId
   * @param {string} reason
   * @returns {Promise<void>}
   */
  _recycleTrackSession(trackId, reason) {
    const track = this.tracks[trackId];
    if (!track) return Promise.resolve();
    const peerId = trackId === 'A' ? 'B' : 'A';
    const wasRecording = track.recording;
    return this._kickIdleTrack(peerId, `recycle_peer_guard_${reason}`)
      .then(() => this._stopTrack(trackId, 'recycle'))
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
   * 若对端轨未在录，立即拉起，避免「仅剩单轨 → stop 被保险拦截 → 永不落盘」。
   * @param {string} peerTrackId
   * @param {string} source
   * @returns {Promise<void>}
   */
  _kickIdleTrack(peerTrackId, source) {
    const peer = this.tracks[peerTrackId];
    if (!peer || peer.recording || !this.active) return Promise.resolve();
    return this._startTrack(peerTrackId, source);
  }

  /**
   * 巡检双轨：任意一轨 idle 则补启；双轨皆 idle 则完整重启乒乓。
   * @returns {void}
   */
  _ensureDualTrackHealth() {
    if (!this.active) return;
    if (this._singleTrackMode) {
      const trackA = this.tracks.A;
      if (!trackA || !trackA.recording) {
        this._log('ping_pong_single_track_recovery', {});
        this._startTrack('A', 'single_track_recovery').catch(() => { });
      }
      this._singleTrackStuckAt = 0;
      return;
    }
    const recording = TRACK_IDS.filter((id) => {
      const t = this.tracks[id];
      return t && t.recording;
    });
    if (recording.length >= 2) {
      this._singleTrackStuckAt = 0;
      return;
    }
    if (recording.length === 0) {
      this._log('ping_pong_no_recording_tracks', {});
      this._startTrack('A', 'dual_track_recovery').then(() => {
        if (!this.active) return;
        const peerDelay = Math.max(0, this.chunkDurationMs - this.overlapMs);
        return this._delay(peerDelay).then(() => this._startTrack('B', 'dual_track_recovery_overlap'));
      }).catch(() => { });
      return;
    }
    const recordingId = recording[0];
    const recTrack = this.tracks[recordingId];
    const recAgeMs = Date.now() - (recTrack && recTrack.recordStartWallMs ? recTrack.recordStartWallMs : 0);
    /** 首段单轨窗口内属正常，勿反复 kick 引发 start/stop 风暴。 */
    if (recAgeMs < Math.max(0, this.chunkDurationMs - this.overlapMs - 2000)) {
      return;
    }
    const idleId = TRACK_IDS.find((id) => {
      const t = this.tracks[id];
      return t && !t.recording;
    });
    if (!idleId) return;
    this._log('ping_pong_restart_idle_track', { trackId: idleId, recordingTracks: 1, recAgeMs });
    this._startTrack(idleId, 'dual_track_health').catch(() => { });
  }

  /**
   * @returns {void}
   */
  _startDualTrackHealthWatch() {
    this._stopDualTrackHealthWatch();
    this._dualTrackHealthTimer = setInterval(() => {
      this._ensureDualTrackHealth();
    }, Math.max(6000, Math.floor(this.staggerMs)));
  }

  /**
   * @returns {void}
   */
  _stopDualTrackHealthWatch() {
    if (this._dualTrackHealthTimer) {
      clearInterval(this._dualTrackHealthTimer);
      this._dualTrackHealthTimer = null;
    }
  }

  /**
   * stop 落盘为空时重建 recorder，避免 20min recycle 后 zombie 会话只 rotate 不落盘。
   * @param {string} trackId
   * @returns {Promise<void>}
   */
  _recoverTrackAfterEmptyTemp(trackId) {
    const track = this.tracks[trackId];
    if (!track) return Promise.resolve();
    this._destroyRecorder(track);
    if (!this.active) return Promise.resolve();
    return this._delay(this.stopToStartGapMs).then(() => this._startTrack(trackId, 'empty_temp_restart'));
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
    if (track.startInFlight) {
      return new Promise((resolve) => {
        track.pendingStarts = track.pendingStarts || [];
        track.pendingStarts.push({ source, resolve });
      });
    }
    track.startInFlight = true;
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
        if (typeof this.onTrackActivity === 'function') {
          this.onTrackActivity({ trackId, source, at: Date.now() });
        }
      })
      .catch((err) => {
        this._log('ping_pong_track_start_fail', { trackId, source, err: formatWxErr(err) });
      })
      .finally(() => {
        track.startInFlight = false;
        const pending = track.pendingStarts || [];
        track.pendingStarts = [];
        if (pending.length > 0) {
          const next = pending.shift();
          this._startTrack(trackId, next.source).finally(() => {
            if (typeof next.resolve === 'function') next.resolve();
            pending.forEach((item) => {
              this._startTrack(trackId, item.source).finally(() => {
                if (typeof item.resolve === 'function') item.resolve();
              });
            });
          });
        }
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
   * 串行 drain stop 队列，避免并发 stop 被丢弃导致轨道卡死、永不落盘。
   * @returns {void}
   */
  _drainPendingStopQueue() {
    if (this._stopInFlight || !this._pendingStopQueue.length) return;
    const next = this._pendingStopQueue.shift();
    if (!next) return;
    this._stopTrackImpl(next.trackId, next.source)
      .finally(() => {
        if (typeof next.resolve === 'function') next.resolve();
        this._drainPendingStopQueue();
      });
  }

  /**
   * @param {string} trackId
   * @param {string} source
   * @returns {Promise<void>}
   */
  _stopTrack(trackId, source) {
    const track = this.tracks[trackId];
    if (!track || !track.recording) {
      if (source === 'highlight_flush') {
        this._log('ping_pong_highlight_flush_track_idle', {
          trackId,
          hasTrack: !!track,
          recording: !!(track && track.recording)
        });
      }
      return Promise.resolve();
    }
    const allowSingleTrackStop =
      source === 'shutdown'
      || source === 'recycle'
      || source === 'highlight_flush';
    if (this._countRecordingTracks() <= 1 && !allowSingleTrackStop) {
      const peerId = trackId === 'A' ? 'B' : 'A';
      return this._kickIdleTrack(peerId, `single_track_guard_${source}`)
        .then(() => this._delay(Math.min(600, this.stopToStartGapMs + 120)))
        .then(() => {
          if (this._countRecordingTracks() >= 2) {
            return this._stopTrack(trackId, source);
          }
          if (!this._singleTrackStuckAt) {
            this._singleTrackStuckAt = Date.now();
          }
          const stuckMs = Date.now() - this._singleTrackStuckAt;
          const forceStopAfterMs = this.chunkDurationMs >= 60000 ? 90000 : 10000;
          if (stuckMs >= forceStopAfterMs) {
            this._log('ping_pong_single_track_force_stop', { trackId, source, stuckMs });
            this._singleTrackStuckAt = 0;
            return this._enqueueStopImpl(trackId, source);
          }
          this._log('ping_pong_stop_blocked_last_track', { trackId, source, stuckMs });
          if (track.stopTimer) clearTimeout(track.stopTimer);
          track.stopTimer = setTimeout(() => {
            this._rotateTrack(trackId, 'deferred_rotate').catch(() => { });
          }, this.staggerMs);
          return undefined;
        });
    }
    this._singleTrackStuckAt = 0;
    return this._enqueueStopImpl(trackId, source);
  }

  /**
   * @param {string} trackId
   * @param {string} source
   * @returns {Promise<void>}
   */
  _enqueueStopImpl(trackId, source) {
    if (this._stopInFlight) {
      return new Promise((resolve) => {
        this._pendingStopQueue.push({ trackId, source, resolve });
      });
    }
    return this._stopTrackImpl(trackId, source).finally(() => {
      this._drainPendingStopQueue();
    });
  }

  /**
   * @param {string} trackId
   * @param {string} source
   * @returns {Promise<void>}
   */
  _stopTrackImpl(trackId, source) {
    const track = this.tracks[trackId];
    if (!track || !track.recording) return Promise.resolve();
    this._stopInFlight = true;
    const recordStart = track.recordStartWallMs || Date.now();
    const recordEnd = Date.now();
    track.recording = false;
    if (track.stopTimer) {
      clearTimeout(track.stopTimer);
      track.stopTimer = null;
    }
    const recorder = track.recorder;
    const lastFrame = this._lastCameraFrame;
    const skipRequestFrame = source === 'shutdown';
    const action = skipRequestFrame ? Promise.resolve() : requestFrameRecorder(recorder, () => {
      if (lastFrame && track.blit) {
        track.blit.drawRgba(lastFrame);
      }
    });
    return action
      .then(() => stopRecorder(recorder))
      .then((res) => this._persistTemp(
        trackId,
        res && res.tempFilePath,
        recordStart,
        recordEnd,
        source
      ))
      .catch((err) => {
        const errText = formatWxErr(err);
        this._log('ping_pong_track_stop_fail', { trackId, source, err: errText });
        this._destroyRecorder(track);
        track.recorder = null;
        if (this.active && source !== 'shutdown') {
          return this._delay(this.stopToStartGapMs).then(() => {
            return this._startTrack(trackId, `${source}_stop_fail_restart`);
          });
        }
        return undefined;
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
   * @param {string} [source]
   * @returns {Promise<void>}
   */
  _persistTemp(trackId, tempPath, startTime, endTime, source) {
    const persistSource = typeof source === 'string' ? source : '';
    const isHighlightFlush = persistSource === 'highlight_flush';
    if (!tempPath) {
      this._log('ping_pong_persist_empty_temp', {
        trackId,
        source: persistSource,
        durationMs: endTime - startTime
      });
      return this._recoverTrackAfterEmptyTemp(trackId);
    }
    if (isHighlightFlush) {
      this._freeRollingSpaceForHighlight();
    }
    this._seq += 1;
    const seq = this._seq;
    return this.ensureRollingDir().then((dir) => {
      const rollingDir = dir || this.rollingDir;
      const destPath = buildDestPath(rollingDir, trackId, seq);
      const fs = wx.getFileSystemManager();
      return fsReady.waitForFileReady(tempPath, {
        minBytes: fsReady.DEFAULT_MIN_BYTES || 1024,
        maxWaitMs: isHighlightFlush ? 8000 : 3200,
        pollMs: isHighlightFlush ? 120 : 100
      }).then((readyInfo) => {
        if (!readyInfo || !readyInfo.ready) {
          this._log('ping_pong_persist_not_ready', {
            trackId,
            source: persistSource,
            reason: readyInfo && readyInfo.reason,
            durationMs: endTime - startTime,
            maxWaitMs: isHighlightFlush ? 8000 : 3200
          });
          return;
        }
        const sizeBytes = readyInfo.size || 0;
        /**
         * @param {string} failStage
         * @returns {Promise<string>}
         */
        const attemptPersist = (failStage) => {
          return this._tryMoveTempToRolling(tempPath, destPath, fs)
            .then((moved) => {
              if (moved) return moved;
              return this._trySaveTempAuto(tempPath, fs);
            })
            .then((saved) => {
              if (saved) return saved;
              if (failStage) return '';
              return this.onStoragePressure('highlight_flush_persist').then(() => attemptPersist(true));
            });
        };
        return attemptPersist(false).then((finalPath) => {
          if (finalPath) {
            const wallDurationMs = Math.max(0, endTime - startTime);
            if (fsReady.isHollowSegment(sizeBytes, wallDurationMs)) {
              this._log('ping_pong_segment_rejected_hollow', {
                trackId,
                source: persistSource,
                sizeBytes,
                wallDurationMs,
                pathTail: String(finalPath).slice(-56)
              });
              if (finalPath !== tempPath) {
                try { fs.unlink({ filePath: finalPath }); } catch (eUn) { }
              }
              if (isHighlightFlush) {
                return;
              }
              return;
            }
            this._registerPersistedSegment(finalPath, startTime, endTime, trackId, sizeBytes, {
              pinPath: isHighlightFlush && finalPath === tempPath,
              tempDirect: finalPath === tempPath
            });
            if (finalPath === tempPath) {
              this._log('ping_pong_persist_temp_direct', {
                trackId,
                source: persistSource,
                sizeBytes
              });
            }
            return;
          }
          if (isHighlightFlush) {
            return this._tryUseTempAsSegmentPath(tempPath).then((tempDirect) => {
              if (!tempDirect) {
                this._log('ping_pong_persist_save_fail', {
                  trackId,
                  source: persistSource,
                  stage: 'all_save_failed',
                  destTail: destPath.slice(-48),
                  sizeBytes
                });
                return;
              }
              const wallDurationMs = Math.max(0, endTime - startTime);
              if (fsReady.isHollowSegment(sizeBytes, wallDurationMs)) {
                this._log('ping_pong_segment_rejected_hollow', {
                  trackId,
                  source: persistSource,
                  sizeBytes,
                  wallDurationMs,
                  pathTail: String(tempDirect).slice(-56),
                  fallback: 'after_save_fail'
                });
                return;
              }
              this._registerPersistedSegment(tempDirect, startTime, endTime, trackId, sizeBytes, {
                pinPath: true,
                tempDirect: true
              });
              this._log('ping_pong_persist_temp_direct', {
                trackId,
                source: persistSource,
                sizeBytes,
                fallback: 'after_save_fail'
              });
            });
          }
          this._log('ping_pong_persist_save_fail', {
            trackId,
            source: persistSource,
            stage: 'saveFile_copyFile',
            destTail: destPath.slice(-48),
            sizeBytes
          });
        });
      });
    });
  }

  /**
   * 高光 flush 前尽量释放 unpinned rolling 母片，避免 copyFile 配额失败。
   * @returns {number} 删除文件数
   */
  _freeRollingSpaceForHighlight() {
    let freed = 0;
    while (this.rollingFiles.length >= Math.max(1, this.maxFiles - 1)) {
      const old = this.rollingFiles.find((p) => p && !this._pinnedPaths.has(p));
      if (!old) break;
      this.rollingFiles = this.rollingFiles.filter((p) => p !== old);
      this.segments = this.segments.filter((seg) => seg.path !== old);
      try {
        wx.getFileSystemManager().unlinkSync(old);
      } catch (eUn) { }
      freed += 1;
      this._log('ping_pong_file_pruned', { path: old, reason: 'highlight_flush_prefetch' });
    }
    if (freed > 0) {
      this._log('ping_pong_highlight_flush_space_free', { freed, rollingCount: this.rollingFiles.length });
    }
    return freed;
  }

  /**
   * saveFile(filePath) + copyFile 尝试将 temp 写入 rolling 目录。
   * @param {string} tempPath
   * @param {string} destPath
   * @param {Object} fs
   * @returns {Promise<string>}
   */
  _tryMoveTempToRolling(tempPath, destPath, fs) {
    return new Promise((resolve) => {
      if (!fs || !tempPath || !destPath) {
        resolve('');
        return;
      }
      const finishCopy = () => {
        if (!fs.copyFile) {
          resolve('');
          return;
        }
        fs.copyFile({
          srcPath: tempPath,
          destPath,
          success: () => resolve(destPath),
          fail: () => resolve('')
        });
      };
      if (!fs.saveFile) {
        finishCopy();
        return;
      }
      fs.saveFile({
        tempFilePath: tempPath,
        filePath: destPath,
        success: (res) => resolve((res && res.savedFilePath) || destPath),
        fail: finishCopy
      });
    });
  }

  /**
   * saveFile 自动路径（不指定 filePath），部分机型 quota 紧张时仍可能成功。
   * @param {string} tempPath
   * @param {Object} fs
   * @returns {Promise<string>}
   */
  _trySaveTempAuto(tempPath, fs) {
    return new Promise((resolve) => {
      if (!fs || !tempPath || !fs.saveFile) {
        resolve('');
        return;
      }
      fs.saveFile({
        tempFilePath: tempPath,
        success: (res) => resolve(res && res.savedFilePath ? res.savedFilePath : ''),
        fail: () => resolve('')
      });
    });
  }

  /**
   * 落盘失败时直接引用 recorder temp（仅 highlight flush，并立即 pin）。
   * @param {string} tempPath
   * @returns {Promise<string>}
   */
  _tryUseTempAsSegmentPath(tempPath) {
    return fsReady.checkFileReady(tempPath, {
      minBytes: fsReady.DEFAULT_MIN_BYTES || 1024
    }).then((info) => {
      if (!info || !info.ready) return '';
      return tempPath;
    });
  }

  /**
   * @param {string} finalPath
   * @param {number} startTime
   * @param {number} endTime
   * @param {string} trackId
   * @param {number} sizeBytes
   * @param {{ pinPath?: boolean, tempDirect?: boolean }} [opts]
   * @returns {void}
   */
  _registerPersistedSegment(finalPath, startTime, endTime, trackId, sizeBytes, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const segment = {
      path: finalPath,
      startTime,
      endTime,
      trackId,
      sessionId: this.sessionId,
      sizeBytes: Math.max(0, Math.floor(Number(sizeBytes) || 0)),
      ready: true
    };
    this.segments.push(segment);
    if (this.rollingFiles.indexOf(finalPath) < 0) {
      this.rollingFiles.push(finalPath);
    }
    this._pruneRollingFiles();
    if (options.pinPath) {
      this._pinnedPaths.add(finalPath);
    }
    this.onSegmentReady(segment);
    this._log('ping_pong_segment_ready', {
      trackId,
      path: finalPath,
      startTime,
      endTime,
      sizeBytes: sizeBytes || 0,
      tempDirect: !!options.tempDirect
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
   * 从内存索引移除已删除的 rolling 路径。
   * @param {string[]} paths
   * @returns {void}
   */
  releaseSegmentPaths(paths) {
    (paths || []).forEach((p) => {
      if (!p) return;
      this._pinnedPaths.delete(p);
      this.segments = (this.segments || []).filter((seg) => seg && seg.path !== p);
      this.rollingFiles = (this.rollingFiles || []).filter((filePath) => filePath !== p);
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
    this._singleTrackStuckAt = 0;
    this._lastHighlightFlushAt = 0;
    this._log('ping_pong_start', {
      sessionId: this.sessionId,
      singleTrackMode: !!this._singleTrackMode
    });
    this._startDualTrackHealthWatch();
    return this._startTrack('A', 'kickoff').then(() => {
      if (this._singleTrackMode) return undefined;
      const peerDelay = Math.max(0, this.chunkDurationMs - this.overlapMs);
      const t = setTimeout(() => {
        if (!this.active) return;
        this._startTrack('B', 'overlap_kickoff').catch(() => { });
      }, peerDelay);
      this._timers.push(t);
      return undefined;
    });
  }

  /**
   * @returns {Promise<void>}
   */
  stop() {
    this.active = false;
    this._stopDualTrackHealthWatch();
    this._singleTrackStuckAt = 0;
    this._pendingStopQueue = [];
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
    this._lastCameraFrame = frame;
    const tasks = TRACK_IDS.map((trackId) => {
      const track = this.tracks[trackId];
      if (!track || !track.recording || !track.recorder || !track.blit) return Promise.resolve();
      return requestFrameRecorder(track.recorder, () => {
        track.blit.drawRgba(frame);
      }).catch(() => { });
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
   * 读取 segment 体积；优先用落盘时缓存的 sizeBytes，否则同步 stat。
   * @param {{ path?: string, startTime?: number, endTime?: number, sizeBytes?: number }} seg
   * @returns {number}
   */
  _getSegmentSizeBytes(seg) {
    if (!seg) return 0;
    if (typeof seg.sizeBytes === 'number' && seg.sizeBytes > 0) return seg.sizeBytes;
    const path = typeof seg.path === 'string' ? seg.path : '';
    if (!path || typeof wx === 'undefined' || typeof wx.getFileSystemManager !== 'function') return 0;
    try {
      const st = wx.getFileSystemManager().statSync(path);
      return st && typeof st.size === 'number' ? st.size : 0;
    } catch (eStat) {
      return 0;
    }
  }

  /**
   * @param {{ path?: string, startTime?: number, endTime?: number, sizeBytes?: number }} seg
   * @returns {boolean}
   */
  _isSegmentHollow(seg) {
    if (!seg) return true;
    const wallDurationMs = Math.max(0, (seg.endTime || 0) - (seg.startTime || 0));
    return fsReady.isHollowSegment(this._getSegmentSizeBytes(seg), wallDurationMs);
  }

  /**
   * 选取覆盖高光窗的最佳非空壳落盘段（体积优先，避免误选 B 轨空壳）。
   * @param {number} clickTime
   * @param {number} leadMs
   * @param {string} [excludeTrackId]
   * @returns {Object|null}
   */
  _pickBestHighlightSegment(clickTime, leadMs, excludeTrackId) {
    const lead = typeof leadMs === 'number' && leadMs > 0 ? leadMs : 8000;
    const windowStart = clickTime - lead;
    const windowEnd = clickTime;
    const exclude = typeof excludeTrackId === 'string' ? excludeTrackId : '';
    const candidates = (this.segments || [])
      .filter((seg) => seg
        && seg.path
        && (!exclude || seg.trackId !== exclude)
        && seg.startTime <= clickTime
        && seg.endTime >= clickTime
        && !this._isSegmentHollow(seg))
      .map((seg) => Object.assign({}, seg, {
        sizeBytes: this._getSegmentSizeBytes(seg)
      }))
      .sort((a, b) => {
        const aFull = a.startTime <= windowStart && a.endTime >= windowEnd ? 1 : 0;
        const bFull = b.startTime <= windowStart && b.endTime >= windowEnd ? 1 : 0;
        if (aFull !== bFull) return bFull - aFull;
        const aDur = a.endTime - a.startTime;
        const bDur = b.endTime - b.startTime;
        if (aDur !== bDur) return bDur - aDur;
        return (b.sizeBytes || 0) - (a.sizeBytes || 0);
      });
    return candidates[0] || null;
  }

  /**
   * 估算轨道近期落盘质量（均字节），用于 flush 时避开持续产出空壳的轨。
   * @param {string} trackId
   * @returns {number}
   */
  _estimateTrackSegmentQuality(trackId) {
    const recent = (this.segments || [])
      .filter((seg) => seg && seg.trackId === trackId)
      .slice(-3)
      .map((seg) => this._getSegmentSizeBytes(seg))
      .filter((size) => size > 0);
    if (!recent.length) return 0;
    return recent.reduce((sum, size) => sum + size, 0) / recent.length;
  }

  /**
   * 计算裁剪诊断指标（用于定位「偏早/偏晚」根因）。
   * @param {{ path?: string, startTime: number, endTime: number, trackId?: string }} seg
   * @param {number} clickTime
   * @param {number} leadMs
   * @param {Object} plan
   * @returns {Object}
   */
  _buildTrimDiagnostic(seg, clickTime, leadMs, plan) {
    const lead = typeof leadMs === 'number' && leadMs > 0 ? leadMs : 8000;
    const wallDurationMs = Math.max(0, (seg && seg.endTime ? seg.endTime : 0) - (seg && seg.startTime ? seg.startTime : 0));
    const clickInSegMs = Math.max(0, clickTime - (seg && seg.startTime ? seg.startTime : clickTime));
    const segEndLagMs = (seg && seg.endTime ? seg.endTime : clickTime) - clickTime;
    const windowStart = clickTime - lead;
    const windowStartInSegMs = Math.max(0, windowStart - (seg && seg.startTime ? seg.startTime : windowStart));
    const windowEndInSegMs = Math.min(wallDurationMs, clickTime - (seg && seg.startTime ? seg.startTime : clickTime));
    const trimStartMs = Math.max(0, Math.floor((plan && plan.replayInitialTimeSec ? plan.replayInitialTimeSec : 0) * 1000));
    const trimEndMs = Math.max(0, Math.floor((plan && plan.replayMediaStopAtSec ? plan.replayMediaStopAtSec : 0) * 1000));
    const playDurationMs = Math.max(0, trimEndMs - trimStartMs);
    /**
     * 正值：裁剪终点比点击时刻更早（观感偏「过去/早」）；
     * 负值：裁剪终点比点击更晚（观感偏「未来/晚」）。
     */
    const clickAnchorSkewMs = clickInSegMs - trimEndMs;
    /** 期望窗起点 vs 实际裁剪起点（文件内 ms）。 */
    const windowStartSkewMs = windowStartInSegMs - trimStartMs;
    return {
      clickTime,
      leadMs: lead,
      trackId: seg && seg.trackId ? seg.trackId : '',
      segStart: seg && seg.startTime ? seg.startTime : 0,
      segEnd: seg && seg.endTime ? seg.endTime : 0,
      wallDurationMs,
      clickInSegMs,
      segEndLagMs,
      windowStartInSegMs,
      windowEndInSegMs,
      trimStartMs,
      trimEndMs,
      playDurationMs,
      clickAnchorSkewMs,
      windowStartSkewMs,
      seekMode: plan && plan.seekMode ? plan.seekMode : '',
      tailTrim: !!(plan && plan.tailTrim)
    };
  }

  /**
   * @param {string} phase
   * @param {Object} seg
   * @param {number} clickTime
   * @param {number} leadMs
   * @param {Object} plan
   * @param {Object} [extra]
   * @returns {Object}
   */
  _emitTrimDiagnostic(phase, seg, clickTime, leadMs, plan, extra) {
    const diag = this._buildTrimDiagnostic(seg, clickTime, leadMs, plan);
    this._log('highlight_trim_diagnostic', Object.assign({
      phase: phase || 'seek',
      pathTail: seg && seg.path ? String(seg.path).slice(-72) : ''
    }, diag, extra || {}));
    return diag;
  }

  /**
   * 从已落盘 segment 构造 seek 计划（时间为文件内绝对秒数）。
   * @param {{ path: string, startTime: number, endTime: number }} seg
   * @param {number} windowStart
   * @param {number} windowEnd
   * @returns {{ path: string, replayInitialTimeSec: number, replayMediaStopAtSec: number }|null}
   */
  _buildSeekFromSegment(seg, windowStart, windowEnd) {
    if (!seg || !seg.path) return null;
    const durationMs = Math.max(0, seg.endTime - seg.startTime);
    const playStartMs = Math.max(0, windowStart - seg.startTime);
    const playEndMs = Math.min(durationMs, windowEnd - seg.startTime);
    if (playEndMs <= playStartMs + 500) return null;
    return {
      path: seg.path,
      replayInitialTimeSec: playStartMs / 1000,
      replayMediaStopAtSec: Math.max(0.08, playEndMs / 1000)
    };
  }

  /**
   * 构造 flush 高光 seek：按点击墙钟 8s 窗定位；materialize 时用 probe 时长做偏移映射。
   * @param {{ path: string, startTime: number, endTime: number }} seg
   * @param {number} clickTime
   * @param {number} leadMs
   * @returns {{ path: string, replayInitialTimeSec: number, replayMediaStopAtSec: number, tailTrim: boolean, leadMs: number, wallDurationMs: number, seekMode: string }|null}
   */
  _buildHighlightSeekPlan(seg, clickTime, leadMs) {
    if (!seg || !seg.path) return null;
    const lead = typeof leadMs === 'number' && leadMs > 0 ? leadMs : 8000;
    const wallDurationMs = Math.max(0, seg.endTime - seg.startTime);
    const windowStart = clickTime - lead;
    const windowEnd = clickTime;
    const windowStartInSegMs = Math.max(0, windowStart - seg.startTime);
    const windowEndInSegMs = Math.min(wallDurationMs, windowEnd - seg.startTime);

    const clickPlan = this._buildSeekFromSegment(seg, windowStart, windowEnd);
    if (clickPlan && windowEndInSegMs > windowStartInSegMs + 500) {
      return Object.assign({}, clickPlan, {
        tailTrim: true,
        seekMode: 'click_wall_mapped',
        leadMs: lead,
        wallDurationMs,
        windowStartInSegMs,
        windowEndInSegMs
      });
    }
    if (wallDurationMs >= 500) {
      return {
        path: seg.path,
        replayInitialTimeSec: 0,
        replayMediaStopAtSec: wallDurationMs / 1000,
        tailTrim: true,
        seekMode: 'click_wall_full',
        leadMs: Math.min(lead, wallDurationMs),
        wallDurationMs,
        windowStartInSegMs: 0,
        windowEndInSegMs: wallDurationMs
      };
    }
    return null;
  }

  /**
   * @deprecated 请使用 {@link _buildHighlightSeekPlan}
   * @param {{ path: string, startTime: number, endTime: number }} seg
   * @param {number} leadMs
   * @returns {Object|null}
   */
  _buildTailSeekFromSegment(seg, leadMs) {
    const wallDurationMs = Math.max(500, seg.endTime - seg.startTime);
    const clickTime = seg.endTime || Date.now();
    return this._buildHighlightSeekPlan(seg, clickTime, leadMs);
  }

  /**
   * 查找可强制 flush 的 live 轨。
   * 双轨重叠：优先能覆盖完整 8s 窗的主轨（开录更早、内容更长），避免误 flush 刚重启的短轨。
   * @param {number} clickTime
   * @param {number} leadMs
   * @returns {string|null}
   */
  _findLiveTrackForHighlightFlush(clickTime, leadMs) {
    const lead = typeof leadMs === 'number' && leadMs > 0 ? leadMs : 8000;
    const minPreferAgeMs = Math.max(3500, Math.floor(lead * 0.45));
    /** @type {Array<{ trackId: string, startTime: number, ageMs: number }>} */
    const candidates = [];
    TRACK_IDS.forEach((trackId) => {
      const track = this.tracks[trackId];
      if (!track || !track.recording || !track.recordStartWallMs) return;
      if (track.recordStartWallMs > clickTime) return;
      candidates.push({
        trackId,
        startTime: track.recordStartWallMs,
        ageMs: clickTime - track.recordStartWallMs
      });
    });
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0].trackId;

    const withFullWindow = candidates.filter((c) => c.ageMs >= lead);
    /** @type {{ trackId: string, startTime: number, ageMs: number }} */
    let picked;
    let pickReason = 'single_candidate';
    if (withFullWindow.length === 1) {
      picked = withFullWindow[0];
      pickReason = 'sole_full_window';
    } else if (withFullWindow.length > 1) {
      withFullWindow.sort((a, b) => {
        const qa = this._estimateTrackSegmentQuality(a.trackId);
        const qb = this._estimateTrackSegmentQuality(b.trackId);
        if (qa !== qb) return qb - qa;
        return a.startTime - b.startTime;
      });
      picked = withFullWindow[0];
      pickReason = 'overlap_primary_longest';
    } else {
      candidates.sort((a, b) => {
        const qa = this._estimateTrackSegmentQuality(a.trackId);
        const qb = this._estimateTrackSegmentQuality(b.trackId);
        if (qa !== qb) return qb - qa;
        return b.ageMs - a.ageMs;
      });
      picked = candidates[0];
      pickReason = 'longest_age_partial';
      if (picked.ageMs < minPreferAgeMs && candidates.length > 1) {
        const alt = candidates.find((c) => c.trackId !== picked.trackId && c.ageMs >= minPreferAgeMs);
        if (alt) {
          picked = alt;
          pickReason = 'avoid_too_short_track';
        }
      }
    }

    this._log('ping_pong_highlight_flush_overlap_pick', {
      clickTime,
      pickedTrackId: picked.trackId,
      pickedAgeMs: picked.ageMs,
      pickReason,
      leadMs: lead,
      candidateTracks: candidates.map((c) => ({
        trackId: c.trackId,
        ageMs: c.ageMs,
        hasFullWindow: c.ageMs >= lead
      }))
    });
    return picked.trackId;
  }

  /**
   * 轮询直至指定轨进入 recording 或超时（Gemini flush 前确保对端已接棒）。
   * @param {string} trackId
   * @param {number} maxWaitMs
   * @returns {Promise<void>}
   */
  _waitForTrackRecording(trackId, maxWaitMs) {
    const deadline = Date.now() + Math.max(200, maxWaitMs || 0);
    const poll = () => {
      const track = this.tracks[trackId];
      if (track && track.recording) return Promise.resolve();
      if (Date.now() >= deadline) return Promise.resolve();
      return this._delay(100).then(poll);
    };
    return poll();
  }

  /**
   * 高光 flush 后从 segments 中匹配刚落盘的轨段（宽容时间窗）。
   * @param {string} trackId
   * @param {number} flushStart
   * @param {number} flushEnd
   * @returns {Object|null}
   */
  _findFlushSegment(trackId, flushStart, flushEnd) {
    const slackBeforeMs = 3200;
    const slackAfterMs = 3200;
    return (this.segments || [])
      .filter((s) => s
        && s.path
        && s.trackId === trackId
        && s.endTime >= flushStart - slackBeforeMs
        && s.endTime <= flushEnd + slackAfterMs)
      .sort((a, b) => b.endTime - a.endTime)[0] || null;
  }

  /**
   * stop 完成后延迟重扫 segments，应对 iOS 落盘略滞后。
   * @param {string} trackId
   * @param {number} flushStart
   * @returns {Promise<{ seg: Object|null, flushStart: number, flushEnd: number }>}
   */
  _pickFlushSegmentAfterStop(trackId, flushStart) {
    const pick = () => {
      const flushEnd = Date.now();
      const seg = this._findFlushSegment(trackId, flushStart, flushEnd);
      return { seg, flushStart, flushEnd };
    };
    const first = pick();
    if (first.seg) return Promise.resolve(first);
    return this._delay(480).then(() => {
      const second = pick();
      if (second.seg) return second;
      return this._delay(900).then(pick);
    });
  }

  /**
   * 查找墙钟完全覆盖 [windowStart, windowEnd] 的 live 轨。
   * @param {number} windowStart
   * @param {number} windowEnd
   * @returns {string|null}
   */
  _findLiveCoveringTrackId(windowStart, windowEnd) {
    const now = Date.now();
    if (now < windowEnd) return null;
    for (let i = 0; i < TRACK_IDS.length; i += 1) {
      const trackId = TRACK_IDS[i];
      const track = this.tracks[trackId];
      if (!track || !track.recording || !track.recordStartWallMs) continue;
      if (track.recordStartWallMs <= windowStart) {
        return trackId;
      }
    }
    return null;
  }

  /**
   * P1: 获取最早可用的 track/segment 起始时间，用于 leadMs 动态限制。
   * @param {number} [beforeMs] 仅考虑 startTime <= beforeMs 的数据源，过滤掉
   *   由 flush 操作刚刚创建的极新轨道（startTime > clickTime）。
   * @returns {number} 0 表示无可用数据
   */
  _getOldestActiveTrackStartMs(beforeMs) {
    const cutoff = typeof beforeMs === 'number' && beforeMs > 0 ? beforeMs : Infinity;
    let oldest = 0;
    // 查落盘 segments —— 仅考虑 clickTime 之前已存在的
    (this.segments || []).forEach(seg => {
      if (seg && seg.startTime > 0 && seg.startTime <= cutoff) {
        if (!oldest || seg.startTime < oldest) oldest = seg.startTime;
      }
    });
    // 查 live tracks —— 过滤掉在 clickTime 之后才启动的极新轨道
    TRACK_IDS.forEach(trackId => {
      const track = this.tracks[trackId];
      if (track && track.recording && track.recordStartWallMs > 0 && track.recordStartWallMs <= cutoff) {
        if (!oldest || track.recordStartWallMs < oldest) oldest = track.recordStartWallMs;
      }
    });
    return oldest;
  }

  /**
   * 按点击时间解析单文件高光（须 wall-clock 完整覆盖 8s 窗）。
   * @param {number} clickTime
   * @param {number} leadMs
   * @returns {{ path: string, replayInitialTimeSec: number, replayMediaStopAtSec: number }|null}
   */
  resolveHighlightSeek(clickTime, leadMs) {
    let lead = typeof leadMs === 'number' && leadMs > 0 ? leadMs : 8000;
    // P1: 动态限制 leadMs，防止冷启动越界提取；传入 clickTime 过滤 flush 创建的极新轨道
    const oldestTrackStartMs = this._getOldestActiveTrackStartMs(clickTime);
    if (oldestTrackStartMs > 0) {
      const maxAvailableLead = Math.max(500, clickTime - oldestTrackStartMs);
      if (lead > maxAvailableLead) {
        this._log('highlight_lead_clamped', {
          requestedLead: lead,
          clampedLead: maxAvailableLead,
          clickTime,
          oldestTrackStart: oldestTrackStartMs
        });
        lead = maxAvailableLead;
      }
    }
    const windowStart = clickTime - lead;
    const windowEnd = clickTime;
    const best = this._pickBestHighlightSegment(clickTime, lead);
    if (best) {
      const plan = this._buildHighlightSeekPlan(best, clickTime, lead)
        || this._buildSeekFromSegment(best, windowStart, windowEnd);
      if (plan) {
        plan.trimDiagnostic = this._emitTrimDiagnostic(
          best.startTime <= windowStart && best.endTime >= windowEnd ? 'sync_full_cover' : 'sync_click_inside',
          best,
          clickTime,
          lead,
          Object.assign({}, plan, {
            seekMode: plan.seekMode || (best.startTime <= windowStart && best.endTime >= windowEnd
              ? 'sync_full_cover'
              : 'sync_click_inside'),
            tailTrim: !!plan.tailTrim
          })
        );
      }
      return plan;
    }
    return null;
  }

  /**
   * 若无落盘文件覆盖高光窗，则 flush 当前 live 轨再 seek（保证含点击时刻）。
   * @param {number} clickTime
   * @param {number} leadMs
   * @returns {Promise<{ path: string, replayInitialTimeSec: number, replayMediaStopAtSec: number }|null>}
   */
  flushAndResolveHighlightSeek(clickTime, leadMs) {
    const sync = this.resolveHighlightSeek(clickTime, leadMs);
    if (sync) return Promise.resolve(sync);
    if (!this.active) return Promise.resolve(null);

    const now = Date.now();
    const sinceLastMs = now - (this._lastHighlightFlushAt || 0);
    if (this._lastHighlightFlushAt && sinceLastMs < this.highlightFlushMinIntervalMs) {
      this._log('ping_pong_highlight_flush_rate_limited', {
        clickTime,
        sinceLastMs,
        minIntervalMs: this.highlightFlushMinIntervalMs
      });
      const err = new Error('highlight_flush_rate_limited');
      err.code = 'HIGHLIGHT_FLUSH_RATE_LIMITED';
      return Promise.reject(err);
    }

    let lead = typeof leadMs === 'number' && leadMs > 0 ? leadMs : 8000;
    // P1: 动态限制 leadMs，防止冷启动越界提取；传入 clickTime 过滤 flush 创建的极新轨道
    const oldestTrackStartMs = this._getOldestActiveTrackStartMs(clickTime);
    if (oldestTrackStartMs > 0) {
      const maxAvailableLead = Math.max(500, clickTime - oldestTrackStartMs);
      if (lead > maxAvailableLead) {
        this._log('highlight_lead_clamped_flush', {
          requestedLead: lead,
          clampedLead: maxAvailableLead,
          clickTime,
          oldestTrackStart: oldestTrackStartMs
        });
        lead = maxAvailableLead;
      }
    }
    const windowStart = clickTime - lead;
    const windowEnd = clickTime;
    const trackId = this._findLiveTrackForHighlightFlush(clickTime, lead);
    if (!trackId) {
      this._log('ping_pong_highlight_flush_no_track', { clickTime, windowStart });
      return Promise.resolve(null);
    }

    const peerId = trackId === 'A' ? 'B' : 'A';
    const peerAlreadyRecording = !!(this.tracks[peerId] && this.tracks[peerId].recording);
    this._lastHighlightFlushAt = now;
    this._log('ping_pong_highlight_flush_force', {
      clickTime,
      trackId,
      peerId,
      peerAlreadyRecording,
      recordingTracks: this._countRecordingTracks(),
      chunkDurationMs: this.chunkDurationMs
    });

    const peerReadyWaitMs = this.chunkDurationMs >= 60000
      ? 1500
      : Math.min(800, this.stopToStartGapMs + 200);

    const kickPeer = () => {
      if (peerAlreadyRecording) return Promise.resolve();
      return this._kickIdleTrack(peerId, 'highlight_flush_peer');
    };

    return kickPeer()
      .then(() => this._waitForTrackRecording(peerId, peerReadyWaitMs))
      .then(() => this._delay(this.stopToStartGapMs))
      .then(() => {
        if (this._countRecordingTracks() < 2) {
          this._log('ping_pong_highlight_flush_single_track', {
            trackId,
            recordingTracks: this._countRecordingTracks()
          });
        }
        this._freeRollingSpaceForHighlight();
        const flushStart = Date.now();
        return this._stopTrack(trackId, 'highlight_flush').then(() => {
          return this._pickFlushSegmentAfterStop(trackId, flushStart);
        }).then((picked) => {
          let seg = picked && picked.seg ? picked.seg : null;
          const flushStart = picked && picked.flushStart ? picked.flushStart : Date.now();
          const flushEnd = picked && picked.flushEnd ? picked.flushEnd : Date.now();
          if (seg && this._isSegmentHollow(seg)) {
            this._log('ping_pong_highlight_flush_hollow_segment', {
              trackId,
              clickTime,
              sizeBytes: this._getSegmentSizeBytes(seg),
              wallDurationMs: Math.max(0, seg.endTime - seg.startTime),
              pathTail: String(seg.path || '').slice(-56)
            });
            const alt = this._pickBestHighlightSegment(clickTime, lead, trackId);
            if (alt) {
              seg = alt;
              this._log('ping_pong_highlight_flush_hollow_fallback', {
                fromTrackId: trackId,
                altTrackId: alt.trackId || '',
                sizeBytes: this._getSegmentSizeBytes(alt)
              });
            } else {
              seg = null;
            }
          }
          if (!seg) {
            const alt = this._pickBestHighlightSegment(clickTime, lead, trackId);
            if (alt) {
              seg = alt;
              this._log('ping_pong_highlight_flush_no_segment_fallback', {
                trackId,
                altTrackId: alt.trackId || '',
                sizeBytes: this._getSegmentSizeBytes(alt)
              });
            }
          }
          if (!seg) {
            this._log('ping_pong_highlight_flush_no_segment', {
              trackId,
              flushStart,
              flushEnd,
              flushDurationMs: flushEnd - flushStart
            });
            return null;
          }
          const plan = this._buildHighlightSeekPlan(seg, clickTime, lead);
          if (plan) {
            plan.trimDiagnostic = this._emitTrimDiagnostic('flush_seek', seg, clickTime, lead, plan, {
              flushTrackId: trackId,
              flushStart,
              flushEnd
            });
            this._log('ping_pong_highlight_tail_seek', {
              trackId,
              path: plan.path,
              wallDurationMs: seg.endTime - seg.startTime,
              leadMs: lead,
              seekMode: plan.seekMode || '',
              estStartSec: plan.replayInitialTimeSec,
              estStopSec: plan.replayMediaStopAtSec,
              tailTrim: !!plan.tailTrim,
              clickAnchorSkewMs: plan.trimDiagnostic ? plan.trimDiagnostic.clickAnchorSkewMs : 0
            });
          }
          if (this.active) {
            return this._delay(this.stopToStartGapMs).then(() => {
              return this._startTrack(trackId, 'highlight_flush_restart').then(() => {
                this._kickIdleTrack(peerId, 'highlight_flush_peer_restart');
                return plan;
              });
            });
          }
          return plan;
        });
      });
  }

  /**
   * @returns {number}
   */
  getRecordingTrackCount() {
    return this._countRecordingTracks();
  }

  /**
   * @returns {Promise<void>}
   */
  destroy() {
    return this.stop().finally(() => {
      TRACK_IDS.forEach((trackId) => {
        const track = this.tracks[trackId];
        if (!track) return;
        if (track.blit && track.blit.destroy) track.blit.destroy();
        this._destroyRecorder(track);
        track.canvas = null;
        track.blit = null;
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
