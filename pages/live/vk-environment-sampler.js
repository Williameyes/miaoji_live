const STATE_IDLE = 'IDLE';
const STATE_SAMPLING = 'SAMPLING';
const STATE_COMPLETED = 'COMPLETED';

const DEFAULT_INTERVAL_MS = 300;
const DEFAULT_MAX_FRAMES = 10;
const DEFAULT_SAMPLE_WIDTH = 160;
const DEFAULT_SAMPLE_HEIGHT = 90;

class VKEnvironmentSampler {
  constructor(options) {
    const opts = options || {};
    this.intervalMs = Math.max(250, Number(opts.intervalMs) || DEFAULT_INTERVAL_MS);
    this.maxFrames = Math.max(8, Math.min(12, Number(opts.maxFrames) || DEFAULT_MAX_FRAMES));
    this.sampleWidth = Math.max(64, Number(opts.sampleWidth) || DEFAULT_SAMPLE_WIDTH);
    this.sampleHeight = Math.max(36, Number(opts.sampleHeight) || DEFAULT_SAMPLE_HEIGHT);
    this.onStateChange = typeof opts.onStateChange === 'function' ? opts.onStateChange : null;
    this.onComplete = typeof opts.onComplete === 'function' ? opts.onComplete : null;
    this._getFrameStats = typeof opts.getFrameStats === 'function' ? opts.getFrameStats : null;
    this.state = STATE_IDLE;
    this.frameStats = [];
    this._timer = null;
    this._startedAt = 0;
    this._completedAt = 0;
    this._requestInFlight = false;
  }

  start() {
    if (!this._getFrameStats) return false;
    this.stop({ silent: true, keepCompletedState: false });
    this.state = STATE_SAMPLING;
    this.frameStats = [];
    this._startedAt = Date.now();
    this._completedAt = 0;
    this._emitState();
    this._collectTick();
    return true;
  }

  stop(options) {
    const opts = options || {};
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._requestInFlight = false;
    if (opts.keepCompletedState) {
      this.state = STATE_COMPLETED;
      this._completedAt = Date.now();
    } else {
      this.state = STATE_IDLE;
      if (!opts.preserveBuffer) this.frameStats = [];
      this._completedAt = 0;
    }
    if (!opts.silent) this._emitState();
  }

  destroy() {
    this.stop({ silent: true, keepCompletedState: false });
    this.frameStats = [];
  }

  getSnapshot() {
    return {
      state: this.state,
      progress: this.maxFrames > 0 ? Math.min(1, this.frameStats.length / this.maxFrames) : 0,
      collected: this.frameStats.length,
      target: this.maxFrames,
      startedAt: this._startedAt,
      completedAt: this._completedAt,
      frameStats: this.frameStats.slice()
    };
  }

  _emitState() {
    if (!this.onStateChange) return;
    this.onStateChange(this.getSnapshot());
  }

  _complete() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this.state = STATE_COMPLETED;
    this._completedAt = Date.now();
    this._emitState();
    if (this.onComplete) this.onComplete(this.getSnapshot());
  }

  _scheduleNext() {
    const self = this;
    this._timer = setTimeout(function () {
      self._collectTick();
    }, this.intervalMs);
  }

  _collectTick() {
    if (this.state !== STATE_SAMPLING || this._requestInFlight) return;
    this._requestInFlight = true;
    let stats = null;
    try {
      stats = this._getFrameStats({
        sampleWidth: this.sampleWidth,
        sampleHeight: this.sampleHeight
      });
    } catch (err) {
      stats = null;
    }
    this._requestInFlight = false;
    if (stats) {
      this.frameStats.push(Object.assign({ index: this.frameStats.length + 1, capturedAt: Date.now() }, stats));
      this._emitState();
    }
    if (this.frameStats.length >= this.maxFrames) {
      this._complete();
      return;
    }
    this._scheduleNext();
  }
}

module.exports = {
  VKEnvironmentSampler,
  VK_ENV_SAMPLE_STATE: {
    IDLE: STATE_IDLE,
    SAMPLING: STATE_SAMPLING,
    COMPLETED: STATE_COMPLETED
  }
};
