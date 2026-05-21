const HIGHLIGHT_LOCK_TIMEOUT = 3000;
const HIGHLIGHT_LOCK_TIMEOUT_MAX_MS = 11000;
const MIN_RECOVER_INTERVAL = 15000;
const RECORDER_SAFE_RESTART_DELAY_MIN_MS = 120;
const RECORDER_SAFE_RESTART_DELAY_MAX_MS = 180;

const RECORDER_STATE = {
  IDLE: 'idle',
  FLUSHING: 'flushing',
  READY: 'ready',
  STARTING: 'starting',
  RECORDING: 'recording',
  STOPPING: 'stopping',
  RECOVERING: 'recovering'
};

function isHostIos() {
  try {
    return String(wx.getSystemInfoSync().platform || '').toLowerCase() === 'ios';
  } catch (e) {
    return false;
  }
}

class RecorderCore {
  constructor(page) {
    this.page = page;
    this.state = RECORDER_STATE.IDLE;
    this.isRecovering = false;
    this.lastRecoverAt = 0;
    this.recoverFailCount = 0;
    this.pendingHighlight = null;
    this.recordSessionId = 0;
    this.lastStopAt = 0;
    this._recentFlushLagMs = 1800;
    this._ownerDepth = 0;
    this._highlightTimeoutTimer = null;
  }

  _log(eventName, detail) {
    if (!this.page || typeof this.page.appendHealthLog !== 'function') return;
    this.page.appendHealthLog(eventName, detail || {});
  }

  _mirrorPendingHighlight(pending) {
    this.pendingHighlight = pending || null;
    this.page.pendingHighlight = this.pendingHighlight;
  }

  syncSession(sessionId) {
    this.recordSessionId = Number(sessionId || 0);
  }

  isOwnerActive() {
    return this._ownerDepth > 0;
  }

  withOwner(source, action, fn) {
    this._ownerDepth += 1;
    this._log('recorder_owner_request', {
      triggerSource: source || 'unknown',
      action: action || '',
      stateBefore: this.state,
      stateAfter: this.state
    });
    try {
      return typeof fn === 'function' ? fn() : undefined;
    } finally {
      this._ownerDepth = Math.max(0, this._ownerDepth - 1);
    }
  }

  setState(nextState, source) {
    const next = nextState || RECORDER_STATE.IDLE;
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    this.isRecovering = next === RECORDER_STATE.RECOVERING;
    this._log('recorder_state_change', {
      triggerSource: source || 'unknown',
      stateBefore: prev,
      stateAfter: next
    });
  }

  enterDegradedMode(source) {
    if (this.page.data.recorderDegradedMode) return;
    this.page.setData({ recorderDegradedMode: true });
    this._log('recover_enter_degraded_mode', {
      triggerSource: source || 'unknown',
      stateBefore: this.state,
      stateAfter: this.state
    });
  }

  leaveDegradedMode() {
    if (!this.page.data.recorderDegradedMode) return;
    this.page.setData({ recorderDegradedMode: false });
  }

  setPendingHighlight(meta) {
    meta = meta || {};
    const page = this.page;
    const now = Date.now();
    const clickTimeRaw =
      meta && typeof meta.clickTime === 'number' && isFinite(meta.clickTime)
        ? Number(meta.clickTime)
        : now;
    const clickTime = Math.min(now, Math.max(0, clickTimeRaw));
    const pending = page._highlightManager && typeof page._highlightManager.createRequest === 'function'
      ? page._highlightManager.createRequest(Object.assign({}, meta || {}, { clickTime: clickTime }))
      : {
        clickTime: clickTime,
        startTime: clickTime - (page.highlightLeadMs || 8000),
        endTime: clickTime + (page.highlightTailMs || 0),
        id: meta.id || String(now),
        createdAt: clickTime,
        matchName: meta.matchName || (page.data.matchConfig && page.data.matchConfig.matchName) || '未命名比赛',
        matchId: meta.matchId || page.resolveMatchIdForHighlightStorage(),
        cover: meta.cover || page.data.defaultCover
      };
    pending.id = pending.id || (meta.id || String(now));
    pending.createdAt = typeof pending.createdAt === 'number' ? pending.createdAt : clickTime;
    pending.matchName = meta.matchName || (page.data.matchConfig && page.data.matchConfig.matchName) || pending.matchName || '未命名比赛';
    pending.matchId = meta.matchId || page.resolveMatchIdForHighlightStorage() || pending.matchId;
    pending.cover = meta.cover || page.data.defaultCover || pending.cover;
    if (this._highlightTimeoutTimer) {
      clearTimeout(this._highlightTimeoutTimer);
      this._highlightTimeoutTimer = null;
    }
    this._mirrorPendingHighlight(pending);
    let timeoutMs = HIGHLIGHT_LOCK_TIMEOUT;
    const segmentDurationMs = Number(page.segmentDurationMs || 0);
    const recordStartAt = Number(page.lastRecordStartAt || 0);
    const flushLagBudgetMs = this._recentFlushLagMs || 1800;
    if (
      segmentDurationMs > 0
      && recordStartAt > 0
      && recordStartAt <= now
    ) {
      const requiredEndTime =
        typeof pending.endTime === 'number' && pending.endTime > pending.clickTime
          ? pending.endTime
          : pending.clickTime;
      const elapsedToEndMs = Math.max(0, requiredEndTime - recordStartAt);
      const segmentCycles = Math.max(1, Math.ceil(elapsedToEndMs / segmentDurationMs));
      const expectedFlushAt = recordStartAt + segmentCycles * segmentDurationMs;
      const waitBudgetMs = Math.max(0, expectedFlushAt - now) + flushLagBudgetMs + 500;
      timeoutMs = Math.max(
        HIGHLIGHT_LOCK_TIMEOUT,
        Math.min(HIGHLIGHT_LOCK_TIMEOUT_MAX_MS, waitBudgetMs)
      );
    }
    this._highlightTimeoutTimer = setTimeout(() => {
      this._highlightTimeoutTimer = null;
      if (!this.pendingHighlight || this.pendingHighlight.id !== pending.id) return;
      const clickCoveredByBufferedSegment = (Array.isArray(page.rollingSegments) ? page.rollingSegments : [])
        .some((seg) =>
          seg
          && typeof seg.startTime === 'number'
          && typeof seg.endTime === 'number'
          && seg.startTime <= pending.endTime
          && seg.endTime >= pending.endTime
        );
      if (clickCoveredByBufferedSegment) {
        this._log('highlight_timeout_promoted_to_generate', {
          triggerSource: 'highlight_timeout',
          stateBefore: this.state,
          stateAfter: this.state,
          clickTime: pending.clickTime,
          endTime: pending.endTime
        });
        this.clearPendingHighlight();
        page._generateHighlight(pending.startTime, pending.endTime, pending);
        return;
      }
      if (this.state === RECORDER_STATE.STOPPING || this.state === RECORDER_STATE.FLUSHING) {
        const extendMs = Math.max(1200, Math.min(2600, flushLagBudgetMs));
        this._log('highlight_timeout_extended_for_flush', {
          triggerSource: 'highlight_timeout',
          stateBefore: this.state,
          stateAfter: this.state,
          clickTime: pending.clickTime,
          extendMs: extendMs
        });
        this._highlightTimeoutTimer = setTimeout(() => {
          this._highlightTimeoutTimer = null;
          if (!this.pendingHighlight || this.pendingHighlight.id !== pending.id) return;
          this._log('highlight_soft_timeout_release', {
            triggerSource: 'highlight_timeout_after_extend',
            stateBefore: this.state,
            stateAfter: this.state,
            clickTime: pending.clickTime,
            timeoutMs: timeoutMs + extendMs
          });
          this.clearPendingHighlight();
          page.endHighlightSaving();
        }, extendMs);
        return;
      }
      this._log('highlight_soft_timeout_release', {
        triggerSource: 'highlight_timeout',
        stateBefore: this.state,
        stateAfter: this.state,
        clickTime: pending.clickTime,
        timeoutMs: timeoutMs
      });
      this.clearPendingHighlight();
      page.endHighlightSaving();
    }, timeoutMs);
    return pending;
  }

  clearPendingHighlight() {
    if (this._highlightTimeoutTimer) {
      clearTimeout(this._highlightTimeoutTimer);
      this._highlightTimeoutTimer = null;
    }
    this._mirrorPendingHighlight(null);
  }

  noteTimelineGap(source, gapMs) {
    this._log('timeline_gap_detected', {
      triggerSource: source || 'unknown',
      stateBefore: this.state,
      stateAfter: this.state,
      gapMs: gapMs || 0
    });
  }

  maybeGenerateHighlight() {
    const pending = this.pendingHighlight;
    if (!pending) return false;
    const segments = Array.isArray(this.page.rollingSegments) ? this.page.rollingSegments : [];
    const covered = segments.some((seg) =>
      seg
      && typeof seg.startTime === 'number'
      && typeof seg.endTime === 'number'
      && seg.startTime <= pending.endTime
      && seg.endTime >= pending.endTime
    );
    if (!covered) return false;
    this.clearPendingHighlight();
    this.page._generateHighlight(pending.startTime, pending.endTime, pending);
    return true;
  }

  canStart() {
    return this.state === RECORDER_STATE.READY;
  }

  markReady(source) {
    if (this.state === RECORDER_STATE.RECOVERING) return;
    this.setState(RECORDER_STATE.READY, source || 'ready');
  }

  markIdle(source) {
    if (this.state === RECORDER_STATE.RECOVERING) return;
    this.setState(RECORDER_STATE.IDLE, source || 'idle');
  }

  noteStopTimestamp() {
    this.lastStopAt = Date.now();
  }

  noteFlushLag(flushLagMs) {
    const lag = Number(flushLagMs || 0);
    if (!isFinite(lag) || lag <= 0) return;
    const clamped = Math.max(600, Math.min(3200, Math.round(lag)));
    this._recentFlushLagMs = Math.max(
      600,
      Math.min(3200, Math.round(this._recentFlushLagMs * 0.65 + clamped * 0.35))
    );
  }

  waitForFlushComplete(source, flushPromise, onReady) {
    this.setState(RECORDER_STATE.FLUSHING, source || 'flush_begin');
    const done = () => {
      this.markReady(source || 'flush_done');
      if (typeof onReady === 'function') onReady();
    };
    Promise.resolve(flushPromise)
      .catch(() => Promise.resolve())
      .then(() => {
        const poll = () => {
          if (this.page.rollingFsBusy || this.page._rollingPersistInFlight > 0) {
            setTimeout(poll, 50);
            return;
          }
          done();
        };
        poll();
      });
  }

  requestTryStartWhenReady(source) {
    return this.withOwner(source, 'tryStartWhenReady', () => {
      if (this.isRecovering) return;
      if (this.state !== RECORDER_STATE.READY) return;
      this.page._tryStartRollingWhenCameraReadyImpl();
    });
  }

  requestStartRolling(source) {
    return this.withOwner(source, 'startRolling', () => {
      if (this.isRecovering) return;
      if (!this.canStart()) return;
      this.page._startRollingRecordingImpl();
    });
  }

  requestStartSegment(source, sessionId, retryCount) {
    return this.withOwner(source, 'startSegment', () => {
      if (this.isRecovering) return;
      const now = Date.now();
      if (!this.canStart()) return;
      if (now - this.lastStopAt < this.getSafeRestartDelayMs()) return;
      this.setState(RECORDER_STATE.STARTING, source);
      this.page._startOneSegmentImpl(sessionId, retryCount);
    });
  }

  requestStopSegment(source, sessionId) {
    return this.withOwner(source, 'stopSegment', () => {
      if (this.isRecovering) return;
      this.setState(RECORDER_STATE.STOPPING, source);
      this.page._stopOneSegmentImpl(sessionId);
    });
  }

  requestStopRolling(source, onStopped) {
    return this.withOwner(source, 'stopRolling', () => {
      this.setState(RECORDER_STATE.STOPPING, source);
      this.page._stopRollingRecordingImpl(() => {
        this.markIdle(source);
        if (typeof onStopped === 'function') onStopped();
      });
    });
  }

  requestReplayPause(source, onPaused) {
    return this.withOwner(source, 'replayPause', () => {
      if (typeof onPaused === 'function') {
        if (wx.nextTick) wx.nextTick(onPaused);
        else setTimeout(onPaused, 0);
      }
    });
  }

  requestReplayResume(source) {
    return this.withOwner(source, 'replayResume', () => {});
  }

  requestRecover(source) {
    const now = Date.now();
    if (this.isRecovering || this.state === RECORDER_STATE.RECOVERING) {
      return false;
    }
    if (now - this.lastRecoverAt < MIN_RECOVER_INTERVAL) {
      this._log('recover_rejected_by_cooldown', {
        triggerSource: source || 'unknown',
        stateBefore: this.state,
        stateAfter: this.state,
        remainMs: MIN_RECOVER_INTERVAL - (now - this.lastRecoverAt)
      });
      return false;
    }
    this.lastRecoverAt = now;
    this.setState(RECORDER_STATE.RECOVERING, source);
    return this.withOwner(source, 'recover', () => this.page._hardRecoverLivePipelineImpl(source));
  }

  onRecoverSuccess(source) {
    this.recoverFailCount = 0;
    this.leaveDegradedMode();
    this.markReady(source || 'recover_success');
  }

  onRecoverFail(source) {
    this.recoverFailCount += 1;
    if (this.recoverFailCount >= 3) {
      this.enterDegradedMode(source);
    }
    this.markIdle(source || 'recover_fail');
  }

  onSegmentStartSuccess(source, sessionId) {
    this.syncSession(sessionId);
    this.setState(RECORDER_STATE.RECORDING, source || 'segment_start_ok');
  }

  onSegmentStartFail(source) {
    if (this.state === RECORDER_STATE.STARTING) {
      this.markReady(source || 'segment_start_fail');
    }
  }

  onSegmentStopSuccess(source, flushPromise, onReady) {
    this.noteStopTimestamp();
    this.waitForFlushComplete(source || 'segment_stop_ok', flushPromise, onReady);
  }

  getSafeRestartDelayMs() {
    const base = isHostIos() ? 150 : 120;
    return Math.max(
      RECORDER_SAFE_RESTART_DELAY_MIN_MS,
      Math.min(RECORDER_SAFE_RESTART_DELAY_MAX_MS, base)
    );
  }
}

module.exports = {
  RECORDER_STATE,
  RecorderCore
};
