const fsReady = require('./fs-ready.js');

function normalizeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

class ChunkManager {
  constructor(opts) {
    const options = opts || {};
    this.windowMs = normalizeNumber(options.windowMs, 45000);
    this.minBytes = normalizeNumber(options.minBytes, fsReady.DEFAULT_MIN_BYTES);
    this.deleteOldFiles = !!options.deleteOldFiles;
    this.logger = typeof options.logger === 'function' ? options.logger : null;
    this.chunks = [];
    this.seq = 0;
  }

  _log(eventName, detail) {
    if (!this.logger) return;
    try {
      this.logger(eventName, detail || {});
    } catch (e) {}
  }

  _makeId(meta) {
    if (meta && meta.id) return String(meta.id);
    this.seq += 1;
    return `chunk_${Date.now()}_${this.seq}`;
  }

  addChunk(meta) {
    const raw = meta || {};
    const path = typeof raw.path === 'string' ? raw.path : '';
    const startTime = normalizeNumber(raw.startTime, 0);
    const endTime = normalizeNumber(raw.endTime, 0);
    if (!path || startTime <= 0 || endTime <= startTime) {
      this._log('replay_buffer_chunk_reject', {
        reason: 'invalid_meta',
        path,
        startTime,
        endTime
      });
      return Promise.resolve(null);
    }
    const waitMs =
      typeof raw.fileReadyWaitMs === 'number' && raw.fileReadyWaitMs > 0
        ? raw.fileReadyWaitMs
        : 0;
    const readyPromise = waitMs > 0
      ? fsReady.waitForFileReady(path, {
        minBytes: this.minBytes,
        maxWaitMs: waitMs,
        pollMs: 80
      })
      : fsReady.checkFileReady(path, { minBytes: this.minBytes });
    return readyPromise.then((readyInfo) => {
      if (!readyInfo.ready) {
        this._log('replay_buffer_chunk_reject', {
          reason: readyInfo.reason,
          path,
          size: readyInfo.size || 0,
          startTime,
          endTime
        });
        /** 拒绝入缓冲时也 prune，避免长时间无有效段时旧 chunk 占满时间轴 */
        this.prune(endTime);
        return null;
      }
      const chunk = {
        id: this._makeId(raw),
        path,
        startTime,
        endTime,
        durationMs: endTime - startTime,
        sizeBytes: readyInfo.size || 0,
        sessionId: normalizeNumber(raw.sessionId, 0),
        segNo: normalizeNumber(raw.segNo, 0),
        source: raw.source || 'camera',
        ready: true,
        refCount: 0,
        createdAt: Date.now()
      };
      this.chunks.push(chunk);
      this.chunks.sort((a, b) => a.startTime - b.startTime);
      this.prune(endTime);
      this._log('replay_buffer_chunk_ready', {
        id: chunk.id,
        segNo: chunk.segNo,
        startTime: chunk.startTime,
        endTime: chunk.endTime,
        durationMs: chunk.durationMs,
        sizeBytes: chunk.sizeBytes,
        count: this.chunks.length
      });
      return chunk;
    });
  }

  getChunks() {
    return this.chunks.slice();
  }

  snapshotWindow(startTime, endTime) {
    const start = normalizeNumber(startTime, 0);
    const end = normalizeNumber(endTime, 0);
    if (start <= 0 || end <= start) return [];
    return this.chunks
      .filter((chunk) => chunk.ready && chunk.path && chunk.endTime > start && chunk.startTime < end)
      .map((chunk) => Object.assign({}, chunk));
  }

  retainByPaths(paths) {
    const set = makePathSet(paths);
    if (!set) return;
    this.chunks.forEach((chunk) => {
      if (set[chunk.path]) chunk.refCount += 1;
    });
  }

  releaseByPaths(paths) {
    const set = makePathSet(paths);
    if (!set) return;
    this.chunks.forEach((chunk) => {
      if (set[chunk.path]) chunk.refCount = Math.max(0, chunk.refCount - 1);
    });
    const latestEnd = this.chunks.length ? this.chunks[this.chunks.length - 1].endTime : Date.now();
    this.prune(latestEnd);
  }

  prune(nowMs) {
    const now = normalizeNumber(nowMs, Date.now());
    const cutoff = now - this.windowMs;
    const kept = [];
    const removed = [];
    this.chunks.forEach((chunk) => {
      if (chunk.endTime < cutoff && chunk.refCount <= 0) {
        removed.push(chunk);
      } else {
        kept.push(chunk);
      }
    });
    this.chunks = kept;
    if (removed.length) {
      this._log('replay_buffer_chunks_pruned', {
        removed: removed.length,
        cutoff,
        count: this.chunks.length
      });
    }
  }

  clear() {
    this.chunks = [];
  }
}

function makePathSet(paths) {
  if (!Array.isArray(paths) || !paths.length) return null;
  const out = {};
  paths.forEach((p) => {
    if (p && typeof p === 'string') out[p] = true;
  });
  return out;
}

module.exports = {
  ChunkManager
};
