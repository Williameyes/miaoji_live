function finiteNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

class HighlightManager {
  constructor(opts) {
    const options = opts || {};
    this.beforeMs = finiteNumber(options.beforeMs, 8000);
    this.afterMs = finiteNumber(options.afterMs, 0);
  }

  createRequest(meta) {
    const m = meta || {};
    const now = Date.now();
    const clickTime = finiteNumber(m.clickTime, now);
    const beforeMs = finiteNumber(m.beforeMs, this.beforeMs);
    const afterMs = finiteNumber(m.afterMs, this.afterMs);
    return {
      clickTime,
      startTime: clickTime - beforeMs,
      endTime: clickTime + afterMs,
      freezeAfterMs: afterMs,
      id: m.id || String(now),
      createdAt: finiteNumber(m.createdAt, clickTime),
      matchName: m.matchName || '未命名比赛',
      matchId: m.matchId || '',
      cover: m.cover || ''
    };
  }

  buildManifest(request, chunks, parts) {
    const req = request || {};
    const list = Array.isArray(chunks) ? chunks : [];
    const partList = Array.isArray(parts) ? parts : [];
    return {
      version: 2,
      type: 'chunk-chain',
      startTime: req.startTime,
      endTime: req.endTime,
      clickTime: req.clickTime,
      chunks: list.map((chunk, idx) => {
        const part = partList[idx] || {};
        const durationMs = finiteNumber(chunk.durationMs, Math.max(0, chunk.endTime - chunk.startTime));
        const playStartMs = finiteNumber(part.offsetStart, Math.max(0, finiteNumber(req.startTime, chunk.startTime) - chunk.startTime));
        const playEndMs = finiteNumber(part.offsetEnd, Math.max(playStartMs, finiteNumber(req.endTime, chunk.endTime) - chunk.startTime));
        const boundedStartMs = durationMs > 0 ? Math.min(durationMs, Math.max(0, playStartMs)) : Math.max(0, playStartMs);
        const boundedEndMs = durationMs > 0
          ? Math.min(durationMs, Math.max(boundedStartMs, playEndMs))
          : Math.max(boundedStartMs, playEndMs);
        return {
          id: chunk.id || '',
          path: chunk.path || '',
          startTime: chunk.startTime,
          endTime: chunk.endTime,
          durationMs: chunk.durationMs,
          sizeBytes: chunk.sizeBytes || 0,
          playStartMs: boundedStartMs,
          playEndMs: boundedEndMs
        };
      })
    };
  }
}

module.exports = {
  HighlightManager
};
