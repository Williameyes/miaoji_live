const mediaContainerTrim = require('./media-container-trim.js');
const mp4Concat = require('./mp4-concat.js');
const { appendMergeExportDiag } = require('../merge-export-diag.js');

/** 合并导出允许的最大片段数 */
const MERGE_MAX_CLIPS = 10;

/** 合并导出允许的最大总时长（毫秒，约 3 分钟） */
const MERGE_MAX_TOTAL_MS = 180000;

/**
 * 记录诊断并继续抛出错误。
 * @param {string} stage
 * @param {unknown} err
 * @param {Record<string, unknown>} [extra]
 * @returns {never}
 */
function rejectWithDiag(stage, err, extra) {
  const msg = String(err && (err.message || err.errMsg) || err || 'unknown');
  appendMergeExportDiag('merge_fail', {
    stage,
    error: msg.slice(0, 240),
    ...(extra || {})
  });
  const wrapped = new Error(msg);
  wrapped.stage = stage;
  throw wrapped;
}

/**
 * 通过 MediaContainer 全量导出（video-only）统一编码，合并前必须执行。
 * @param {string} sourcePath
 * @param {number} [clipIndex]
 * @returns {Promise<string>}
 */
function normalizeClipViaMediaContainer(sourcePath, clipIndex) {
  const src = typeof sourcePath === 'string' ? sourcePath : '';
  if (!src) return Promise.reject(new Error('normalize_source_missing'));

  if (!mediaContainerTrim || typeof mediaContainerTrim.isMediaContainerSupported !== 'function'
    || !mediaContainerTrim.isMediaContainerSupported()) {
    return Promise.reject(new Error('merge_media_container_unsupported'));
  }

  return mp4Concat.inspectMp4File(src).then((before) => {
    appendMergeExportDiag('normalize_before', {
      clipIndex: clipIndex != null ? clipIndex : -1,
      pathTail: src.slice(-48),
      ...(before || {})
    });
    return mediaContainerTrim.probeVideoDurationMs(src).then((probe) => {
      const dur = probe && probe.durationMs ? probe.durationMs : 0;
      if (dur <= 500) {
        return rejectWithDiag('normalize', new Error('normalize_duration_invalid'), {
          clipIndex,
          probe: probe || {}
        });
      }
      if (typeof mediaContainerTrim.trimVideoSegment !== 'function') {
        return Promise.reject(new Error('normalize_trim_unavailable'));
      }
      return mediaContainerTrim.trimVideoSegment(src, 0, dur, { maxAttempts: 3 })
        .then((result) => {
          const out = result && result.path ? result.path : '';
          if (!out) return rejectWithDiag('normalize', new Error('normalize_export_empty'), { clipIndex });
          return mp4Concat.inspectMp4File(out).then((after) => {
            appendMergeExportDiag('normalize_after', {
              clipIndex: clipIndex != null ? clipIndex : -1,
              pathTail: out.slice(-48),
              ...(after || {})
            });
            return out;
          });
        });
    });
  });
}

/**
 * 将单个高光条目准备为可拼接路径（先取 segment，再 MediaContainer 归一化）。
 * @param {Record<string, unknown>} clip
 * @param {number} clipIndex
 * @returns {Promise<string>}
 */
function prepareOneClipMergePath(clip, clipIndex) {
  const segs = clip && Array.isArray(clip.segments)
    ? clip.segments.filter((p) => typeof p === 'string' && p)
    : [];
  if (!segs.length) return Promise.reject(new Error('clip_segment_missing'));

  const segPath = segs[0];
  return normalizeClipViaMediaContainer(segPath, clipIndex);
}

/**
 * 按顺序准备多个高光的路径列表（全部经 MediaContainer 归一化）。
 * @param {Record<string, unknown>[]} clips
 * @param {(done: number, total: number) => void} [onProgress]
 * @returns {Promise<string[]>}
 */
function prepareMergeClipPaths(clips, onProgress) {
  const list = Array.isArray(clips) ? clips.filter(Boolean) : [];
  const total = list.length;
  let done = 0;
  return list.reduce(
    (chain, clip, idx) => chain.then((acc) => prepareOneClipMergePath(clip, idx).then((path) => {
      done += 1;
      if (onProgress) onProgress(done, total);
      if (path) acc.push(path);
      return acc;
    })),
    Promise.resolve(/** @type {string[]} */ ([]))
  );
}

/**
 * 经 MediaContainer 重封装合并产物，生成 iOS/剪映可识别的完整时长 mp4。
 * @param {string} mergedPath
 * @param {number} expectedDurationMs
 * @returns {Promise<string>}
 */
function remuxMergedForPlayback(mergedPath, expectedDurationMs) {
  const endMs = Math.max(500, Math.floor(Number(expectedDurationMs) || 0));
  if (!mergedPath || endMs <= 500) return Promise.resolve(mergedPath);
  if (!mediaContainerTrim || typeof mediaContainerTrim.trimVideoSegment !== 'function') {
    return Promise.resolve(mergedPath);
  }
  return mediaContainerTrim.trimVideoSegment(mergedPath, 0, endMs, { maxAttempts: 3 })
    .then((result) => {
      const path = result && result.path ? result.path : mergedPath;
      appendMergeExportDiag('merge_remux', {
        expectedMs: endMs,
        outPathTail: path.slice(-48)
      });
      return path;
    })
    .catch((err) => {
      appendMergeExportDiag('merge_remux_skip', {
        error: String(err && (err.message || err.errMsg) || err || '').slice(0, 120)
      });
      return mergedPath;
    });
}

/**
 * 估算输入路径列表总时长（毫秒）。
 * @param {string[]} paths
 * @returns {Promise<number>}
 */
function sumProbeDurationMs(paths) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  return list.reduce(
    (chain, p) => chain.then((sum) => mediaContainerTrim.probeVideoDurationMs(p).then((probe) => {
      const d = probe && probe.durationMs ? probe.durationMs : 0;
      return sum + d;
    })),
    Promise.resolve(0)
  );
}
/**
 * 校验合并产物时长是否合理。
 * @param {string} outPath
 * @param {string[]} inputPaths
 * @returns {Promise<string>}
 */
function validateMergedOutput(outPath, inputPaths) {
  if (!mediaContainerTrim || typeof mediaContainerTrim.probeVideoDurationMs !== 'function') {
    return mp4Concat.inspectMp4File(outPath).then((inspect) => {
      if (inspect && inspect.ok && inspect.sampleCount > 0) return outPath;
      return rejectWithDiag('validate', new Error('merge_output_inspect_fail'), { inspect });
    });
  }
  let expectedMs = 0;
  let expectedSamples = 0;
  let chain = Promise.resolve({ ms: 0, samples: 0 });
  inputPaths.forEach((p) => {
    chain = chain.then((acc) => Promise.all([
      mediaContainerTrim.probeVideoDurationMs(p),
      mp4Concat.inspectMp4File(p)
    ]).then(([probe, inspect]) => ({
      ms: acc.ms + (probe && probe.durationMs ? probe.durationMs : 0),
      samples: acc.samples + (inspect && inspect.sampleCount ? inspect.sampleCount : 0)
    })));
  });
  return chain.then(({ ms, samples }) => {
    expectedMs = ms;
    expectedSamples = samples;
    return Promise.all([
      mediaContainerTrim.probeVideoDurationMs(outPath),
      mp4Concat.inspectMp4File(outPath)
    ]).then(([outProbe, outInspect]) => {
      const outMs = outProbe && outProbe.durationMs ? outProbe.durationMs : 0;
      const outSamples = outInspect && outInspect.sampleCount ? outInspect.sampleCount : 0;
      const sampleRatio = expectedSamples > 0 ? outSamples / expectedSamples : 0;
      const durationRatio = expectedMs > 0 ? outMs / expectedMs : 0;
      appendMergeExportDiag('merge_validate', {
        expectedMs,
        outMs,
        expectedSamples,
        outSamples,
        sampleRatio: Number(sampleRatio.toFixed(3)),
        durationRatio: Number(durationRatio.toFixed(3)),
        outPathTail: outPath.slice(-48),
        topLevel: outInspect && outInspect.topLevel ? outInspect.topLevel : ''
      });
      if (outSamples <= 0 && outMs <= 500) {
        return rejectWithDiag('validate', new Error('merge_output_duration_zero'), { expectedMs, outMs });
      }
      if (expectedMs > 800 && durationRatio >= 0.85 && sampleRatio >= 0.85) {
        return outPath;
      }
      if (expectedMs > 800 && outMs < expectedMs * 0.45) {
        return rejectWithDiag('validate', new Error('merge_output_too_short'), {
          expectedMs,
          outMs,
          expectedSamples,
          outSamples,
          durationRatio: Number(durationRatio.toFixed(3))
        });
      }
      return outPath;
    });
  });
}

/**
 * 将多个高光片段合并为单个 mp4 文件。
 * @param {Record<string, unknown>[]} clips 按播放顺序排列
 * @param {string} destPath 输出路径（含文件名）
 * @param {{ onProgress?: (stage: string, done: number, total: number) => void }} [options]
 * @returns {Promise<string>} 合并后的本地路径
 */
function mergeClipsToSingleFile(clips, destPath, options) {
  const list = Array.isArray(clips) ? clips.filter(Boolean) : [];
  const opts = options && typeof options === 'object' ? options : {};
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;

  if (list.length < 2) return Promise.reject(new Error('merge_need_at_least_two'));
  if (list.length > MERGE_MAX_CLIPS) return Promise.reject(new Error('merge_too_many_clips'));

  const totalMs = list.reduce((sum, c) => {
    const dur = typeof c.wallDurationMs === 'number' ? c.wallDurationMs
      : (typeof c.replayDurationMs === 'number' ? c.replayDurationMs : 8000);
    return sum + Math.max(0, dur);
  }, 0);
  if (totalMs > MERGE_MAX_TOTAL_MS) return Promise.reject(new Error('merge_duration_exceeded'));

  appendMergeExportDiag('merge_start', {
    clipCount: list.length,
    clipIds: list.map((c) => String(c.id || '')).slice(0, 12),
    destTail: destPath.slice(-56)
  });

  return prepareMergeClipPaths(list, (done, total) => {
    if (onProgress) onProgress('prepare', done, total);
  }).then((paths) => {
    if (paths.length < 2) {
      return rejectWithDiag('prepare', new Error('merge_valid_paths_insufficient'), {
        preparedCount: paths.length
      });
    }
    appendMergeExportDiag('merge_concat_start', {
      pathCount: paths.length,
      pathsTail: paths.map((p) => p.slice(-32))
    });
    if (onProgress) onProgress('concat', 0, 1);
    return sumProbeDurationMs(paths).then((expectedMs) => mp4Concat.concatMp4Files(paths, destPath)
      .then((rawPath) => mediaContainerTrim.probeVideoDurationMs(rawPath).then((probe) => {
        const probeMs = probe && probe.durationMs ? probe.durationMs : 0;
        if (expectedMs > 800 && probeMs >= expectedMs * 0.85) {
          return remuxMergedForPlayback(rawPath, expectedMs);
        }
        appendMergeExportDiag('merge_remux_skip', {
          reason: 'probe_short',
          probeMs,
          expectedMs
        });
        return rawPath;
      }))
      .then((outPath) => validateMergedOutput(outPath, paths))
      .then((outPath) => {
        if (onProgress) onProgress('concat', 1, 1);
        appendMergeExportDiag('merge_success', { outPathTail: outPath.slice(-56) });
        return outPath;
      }));
  }).catch((err) => {
    if (err && err.stage) return Promise.reject(err);
    return rejectWithDiag('unknown', err, {});
  });
}

module.exports = {
  MERGE_MAX_CLIPS,
  mergeClipsToSingleFile
};
