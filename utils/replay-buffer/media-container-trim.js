const fsReady = require('./fs-ready.js');

/**
 * 利用 wx.createMediaContainer 从长滚动母片中无重编码裁剪高光片段。
 */

/** @type {Promise<void>} MediaContainer 全局串行锁，避免与录制并发触发 601。 */
let mediaContainerLock = Promise.resolve();

/**
 * 串行执行 MediaContainer 操作。
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function withMediaContainerLock(fn) {
  const run = mediaContainerLock.then(() => fn());
  mediaContainerLock = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * @returns {boolean}
 */
function isMediaContainerSupported() {
  return typeof wx !== 'undefined' && typeof wx.createMediaContainer === 'function';
}

/**
 * @param {Array<{ kind?: string }>} tracks
 * @returns {{ video: Object|null, audio: Object|null }}
 */
function pickAvTracks(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  let video = null;
  let audio = null;
  list.forEach((t) => {
    if (!t) return;
    const kind = String(t.kind || '').toLowerCase();
    if (kind === 'video' && !video) video = t;
    if (kind === 'audio' && !audio) audio = t;
  });
  if (!video && list.length > 0) {
    video = list.find((t) => String(t.kind || '').toLowerCase() !== 'audio') || list[0];
  }
  if (!audio && list.length > 1) {
    audio = list.find((t) => String(t.kind || '').toLowerCase() === 'audio') || null;
  }
  return { video, audio };
}

/**
 * 将 API 返回的 duration 规范为毫秒。
 * @param {number} raw
 * @returns {number}
 */
function normalizeDurationToMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  /** 小于 2h 且带小数或绝对值较小时，多为秒。 */
  if (n < 7200 && (n < 1200 || !Number.isInteger(n))) {
    return Math.floor(n * 1000);
  }
  return Math.floor(n);
}

/**
 * @param {string} filePath
 * @returns {Promise<number>}
 */
function getFileSizeBytes(filePath) {
  const path = typeof filePath === 'string' ? filePath : '';
  if (!path || typeof wx === 'undefined' || typeof wx.getFileSystemManager !== 'function') {
    return Promise.resolve(0);
  }
  return new Promise((resolve) => {
    try {
      wx.getFileSystemManager().getFileInfo({
        filePath: path,
        success: (res) => resolve(res && res.size ? res.size : 0),
        fail: () => resolve(0)
      });
    } catch (e) {
      resolve(0);
    }
  });
}

/**
 * @param {string} sourcePath
 * @returns {Promise<number>}
 */
function probeVideoDurationViaGetVideoInfo(sourcePath) {
  const src = typeof sourcePath === 'string' ? sourcePath : '';
  if (!src || typeof wx === 'undefined' || typeof wx.getVideoInfo !== 'function') {
    return Promise.resolve(0);
  }
  return new Promise((resolve) => {
    wx.getVideoInfo({
      src,
      success: (res) => {
        resolve(normalizeDurationToMs(res && res.duration));
      },
      fail: () => resolve(0)
    });
  });
}

/**
 * 探测本地 mp4 实际时长（毫秒）。
 * @param {string} sourcePath
 * @returns {Promise<{ durationMs: number, source: string }>}
 */
function probeVideoDurationMs(sourcePath) {
  const src = typeof sourcePath === 'string' ? sourcePath : '';
  if (!src) return Promise.resolve({ durationMs: 0, source: 'empty' });
  return getFileSizeBytes(src).then((srcSizeBytes) => probeVideoDurationViaGetVideoInfo(src).then((viaInfo) => {
    if (viaInfo > 500 && !fsReady.isSuspiciousDurationProbe(srcSizeBytes, viaInfo)) {
      return { durationMs: viaInfo, source: 'getVideoInfo' };
    }
    if (viaInfo > 500 && fsReady.isSuspiciousDurationProbe(srcSizeBytes, viaInfo)) {
      /** Android 空壳 mp4 常见 getVideoInfo 虚报时长，改走 MediaContainer 或判失败。 */
    }
    if (!isMediaContainerSupported()) {
      return viaInfo > 500 && !fsReady.isSuspiciousDurationProbe(srcSizeBytes, viaInfo)
        ? { durationMs: viaInfo, source: 'getVideoInfo' }
        : { durationMs: 0, source: viaInfo > 500 ? 'suspicious_getVideoInfo' : 'unsupported' };
    }
    return withMediaContainerLock(() => withTrimTimeout(new Promise((resolve) => {
      const container = wx.createMediaContainer();
      let finished = false;
      const done = (ms) => {
        if (finished) return;
        finished = true;
        try {
          if (container && typeof container.destroy === 'function') {
            container.destroy();
          }
        } catch (eDestroy) { }
        const durationMs = Math.max(0, Math.floor(Number(ms) || 0));
        if (durationMs > 500) {
          if (fsReady.isSuspiciousDurationProbe(srcSizeBytes, durationMs)) {
            resolve({ durationMs: 0, source: 'suspicious_mediaContainer' });
            return;
          }
          resolve({ durationMs, source: 'mediaContainer' });
          return;
        }
        resolve({ durationMs: 0, source: 'probe_failed' });
      };
      try {
        container.extractDataSource({
          source: src,
          success: (res) => {
            const picked = pickAvTracks(res && res.tracks);
            const video = picked.video;
            let durationMs = 0;
            if (video && typeof video.duration === 'number' && video.duration > 0) {
              durationMs = normalizeDurationToMs(video.duration);
            }
            if (durationMs > 500 && fsReady.isSuspiciousDurationProbe(srcSizeBytes, durationMs)) {
              done(0);
              return;
            }
            done(durationMs);
          },
          fail: () => done(0)
        });
      } catch (e) {
        done(0);
      }
    }), 'probe_duration'));
  }));
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isTrimTimeoutError(err) {
  const text = String(err && (err.message || err.errMsg) || err || '');
  return text.indexOf('trim_timeout:') >= 0;
}

/**
 * Android 超时熔断后不再重试 trim（由上层转全量拷贝）。
 * @param {unknown} err
 * @returns {boolean}
 */
function shouldAbortTrimRetry(err) {
  return isTrimHostAndroid() && isTrimTimeoutError(err);
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isMediaTrack601(err) {
  const text = String(err && (err.errMsg || err.message) || err || '');
  return text.indexOf('601') >= 0
    || text.indexOf('track not found') >= 0
    || text.indexOf('track not set') >= 0
    || text.indexOf('trackinfo not found') >= 0
    || text.indexOf('EditorExport') >= 0;
}

/**
 * @param {number} delayMs
 * @returns {Promise<void>}
 */
function delayMs(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs || 0)));
}

/** 720p 高光裁剪产物码率上限（kbps），用于估算合法体积。 */
const TRIM_OUTPUT_BITRATE_KBPS_720P = 5200;

/** Android MediaContainer 与 MediaRecorder 并发时 export 可能永不回调。 */
const TRIM_EXPORT_TIMEOUT_MS_ANDROID = 14000;

/** iOS 裁剪 export 超时（毫秒）。 */
const TRIM_EXPORT_TIMEOUT_MS_IOS = 22000;

/**
 * 当前宿主裁剪 export 超时（毫秒）。
 * @returns {number}
 */
function trimExportTimeoutMs() {
  return isTrimHostAndroid() ? TRIM_EXPORT_TIMEOUT_MS_ANDROID : TRIM_EXPORT_TIMEOUT_MS_IOS;
}

/**
 * 为 MediaContainer 操作增加超时，避免全局串行锁被永久占用。
 * @template T
 * @param {Promise<T>} promise
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTrimTimeout(promise, label) {
  const ms = trimExportTimeoutMs();
  return Promise.race([
    promise,
    delayMs(ms).then(() => Promise.reject(new Error(`trim_timeout:${label}:${ms}`)))
  ]);
}

/**
 * @returns {string}
 */
function getTrimHostPlatform() {
  if (typeof wx === 'undefined' || typeof wx.getSystemInfoSync !== 'function') {
    return '';
  }
  try {
    return String(wx.getSystemInfoSync().platform || '').toLowerCase();
  } catch (e) {
    return '';
  }
}

/**
 * @returns {boolean}
 */
function isTrimHostAndroid() {
  return getTrimHostPlatform() === 'android';
}

/**
 * 按目标时长与码率估算裁剪产物合理体积上限（MediaContainer 重封装可能略大于按比例折算值）。
 * @param {number} durationMs
 * @param {number} [videoBitsPerSecondKbps]
 * @returns {number}
 */
function estimateMaxTrimOutputBytesForDuration(durationMs, videoBitsPerSecondKbps) {
  const durSec = Math.max(0.5, (Number(durationMs) || 0) / 1000);
  const kbps = Math.max(1800, Math.floor(Number(videoBitsPerSecondKbps) || TRIM_OUTPUT_BITRATE_KBPS_720P));
  /** kbps→bytes/s，再留 35% 余量应对 iOS remux 膨胀。 */
  return Math.ceil(durSec * kbps * 1000 / 8 * 1.35);
}

/**
 * 按母片/期望时长比例估算裁剪产物允许的最大体积（防假裁剪，且不误伤 iOS 短 flush 段）。
 * 720p 下 MediaContainer 输出常大于母片比例折算值，须与 {@link estimateMaxTrimOutputBytesForDuration} 取较大值。
 * @param {number} sourceSizeBytes
 * @param {number} expectedDurationMs
 * @param {number} [sourceDurationMs]
 * @returns {number}
 */
function computeMaxAllowedTrimOutputBytes(sourceSizeBytes, expectedDurationMs, sourceDurationMs) {
  const srcSize = Math.max(0, Math.floor(Number(sourceSizeBytes) || 0));
  const expected = Math.max(500, Math.floor(Number(expectedDurationMs) || 0));
  const srcDur = Math.max(expected, Math.floor(Number(sourceDurationMs) || 0));
  if (!srcSize) return estimateMaxTrimOutputBytesForDuration(expected);
  const durationRatio = Math.min(1, expected / srcDur);
  /** 长母片裁短窗仍用 42% 下限；短母片按 durationRatio + 12% 放宽。 */
  const sizeRatio = Math.min(0.96, Math.max(0.42, durationRatio + 0.12));
  const ratioCap = Math.max(256 * 1024, Math.floor(srcSize * sizeRatio));
  const bitrateCap = estimateMaxTrimOutputBytesForDuration(expected);
  /** 裁切窗口接近全段时 remux 可能略大于母片。 */
  const nearFullClip = durationRatio >= 0.72;
  const srcBloatCap = Math.ceil(srcSize * (nearFullClip ? 1.5 : 1.12));
  return Math.max(ratioCap, bitrateCap, srcBloatCap);
}

/**
 * 校验裁剪产物：拒绝「日志成功但实际仍是整段母片」的假裁剪。
 * @param {string} outputPath
 * @param {number} expectedDurationMs
 * @param {number} sourceSizeBytes
 * @param {number} [sourceDurationMs]
 * @returns {Promise<{ durationMs: number, sizeBytes: number }>}
 */
function validateTrimOutput(outputPath, expectedDurationMs, sourceSizeBytes, sourceDurationMs) {
  const expected = Math.max(500, Math.floor(Number(expectedDurationMs) || 0));
  const srcSize = Math.max(0, Math.floor(Number(sourceSizeBytes) || 0));
  const srcDur = Math.max(expected, Math.floor(Number(sourceDurationMs) || 0));
  return Promise.all([
    probeVideoDurationMs(outputPath),
    getFileSizeBytes(outputPath)
  ]).then(([probe, sizeBytes]) => {
    const durationMs = probe && probe.durationMs ? probe.durationMs : 0;
    const maxAllowedDurationMs = expected + 2500;
    const maxAllowedSizeBytes = computeMaxAllowedTrimOutputBytes(srcSize, expected, srcDur);
    const trimPlatform = getTrimHostPlatform();
    const minAllowedSizeBytes = Math.max(
      4096,
      fsReady.estimateMinTrimOutputBytes(Math.min(expected, 12000), { platform: trimPlatform })
    );
    if (durationMs > maxAllowedDurationMs) {
      return Promise.reject(new Error(`trim_output_too_long:${durationMs}/${expected}`));
    }
    /** 时长已落在高光窗内时，以码率上限为准，避免 720p remux 误拒。 */
    const durationInHighlightWindow = durationMs >= Math.floor(expected * 0.45)
      && durationMs <= maxAllowedDurationMs;
    const effectiveMaxSizeBytes = durationInHighlightWindow
      ? Math.max(maxAllowedSizeBytes, estimateMaxTrimOutputBytesForDuration(durationMs))
      : maxAllowedSizeBytes;
    /** 假裁剪：体积接近母片且时长接近母片总长。 */
    const suspectFullMotherCopy = srcDur > expected + 2000
      && durationMs > expected + 3500
      && srcSize > 0
      && sizeBytes >= Math.floor(srcSize * 0.88);
    if (suspectFullMotherCopy) {
      return Promise.reject(new Error(`trim_output_suspect_full:${sizeBytes}/${srcSize}:${durationMs}/${srcDur}`));
    }
    if (sizeBytes < 4096) {
      return Promise.reject(new Error(`trim_output_too_small:${sizeBytes}/${expected}`));
    }
    if (durationMs < Math.floor(expected * 0.45)) {
      return Promise.reject(new Error(`trim_output_too_short:${durationMs}/${expected}`));
    }
    return { durationMs, sizeBytes };
  });
}

/**
 * 单次 MediaContainer 裁剪（仅视频轨，iOS 上音频 slice 易触发 601）。
 * 官方顺序：同一容器 extract → addTrack → slice → export。
 * @param {string} sourcePath
 * @param {number} startMs
 * @param {number} endMs
 * @returns {Promise<string>}
 */
function trimVideoSegmentOnce(sourcePath, startMs, endMs, skipAudio) {
  const src = typeof sourcePath === 'string' ? sourcePath : '';
  const start = Math.max(0, Math.floor(Number(startMs) || 0));
  const end = Math.max(start + 500, Math.floor(Number(endMs) || 0));
  if (!src) {
    return Promise.reject(new Error('trim source missing'));
  }
  if (!isMediaContainerSupported()) {
    return Promise.reject(new Error('MediaContainer unsupported'));
  }
  return withMediaContainerLock(() => withTrimTimeout(new Promise((resolve, reject) => {
    const container = wx.createMediaContainer();
    let finished = false;
    /**
     * @param {Error|unknown} [err]
     * @param {string} [path]
     * @returns {void}
     */
    const done = (err, path) => {
      if (finished) return;
      finished = true;
      try {
        if (container && typeof container.destroy === 'function') {
          container.destroy();
        }
      } catch (eDestroy) { }
      if (err) reject(err);
      else resolve(path || '');
    };
    try {
      container.extractDataSource({
        source: src,
        success: (res) => {
          const picked = pickAvTracks(res && res.tracks);
          if (!picked.video) {
            done(new Error('trim video track missing'));
            return;
          }
          let trackDurationMs = 0;
          if (typeof picked.video.duration === 'number' && picked.video.duration > 0) {
            trackDurationMs = normalizeDurationToMs(picked.video.duration);
          }
          const safeEnd = trackDurationMs > 500 ? Math.min(end, trackDurationMs) : end;
          const safeStart = Math.max(0, Math.min(start, safeEnd - 500));
          if (safeEnd <= safeStart + 400) {
            done(new Error('trim_range_invalid'));
            return;
          }
          if (typeof picked.video.slice !== 'function') {
            done(new Error('trim video slice unsupported'));
            return;
          }
          if (typeof container.addTrack !== 'function') {
            done(new Error('trim addTrack unsupported'));
            return;
          }
          try {
            container.addTrack(picked.video);
            picked.video.slice(safeStart, safeEnd);
            if (!skipAudio && picked.audio) {
              console.log('[MediaContainerTrim] Adding audio track to trim');
              container.addTrack(picked.audio);
              picked.audio.slice(safeStart, safeEnd);
            }
          } catch (eTrack) {
            done(eTrack);
            return;
          }
          container.export({
            success: (exportRes) => {
              const out = exportRes && exportRes.tempFilePath ? exportRes.tempFilePath : '';
              if (!out) {
                done(new Error('trim export empty'));
                return;
              }
              done(null, out);
            },
            fail: (exportErr) => {
              done(exportErr || new Error('trim export fail'));
            }
          });
        },
        fail: (extractErr) => {
          done(extractErr || new Error('trim extract fail'));
        }
      });
    } catch (e) {
      done(e);
    }
  }), 'trim_segment'));
}

/**
 * 从本地 mp4 裁剪 [startMs, endMs) 区间（毫秒），带 601 重试与输出校验。
 * @param {string} sourcePath
 * @param {number} startMs
 * @param {number} endMs
 * @param {{ sourceSizeBytes?: number, sourceDurationMs?: number, maxAttempts?: number }} [options]
 * @returns {Promise<{ path: string, trimStartMs: number, trimEndMs: number, outputDurationMs: number, outputSizeBytes: number, videoOnly: boolean }>}
 */
function trimVideoSegment(sourcePath, startMs, endMs, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const start = Math.max(0, Math.floor(Number(startMs) || 0));
  const end = Math.max(start + 500, Math.floor(Number(endMs) || 0));
  const expectedDurationMs = end - start;
  const sourceSizeBytes = Math.max(0, Math.floor(Number(opts.sourceSizeBytes) || 0));
  const sourceDurationMs = Math.max(0, Math.floor(Number(opts.sourceDurationMs) || 0));
  const maxAttempts = Math.max(1, Math.floor(Number(opts.maxAttempts) || 3));

  /**
   * @param {number} attempt
   * @param {boolean} skipAudio
   * @returns {Promise<{ path: string, trimStartMs: number, trimEndMs: number, outputDurationMs: number, outputSizeBytes: number, videoOnly: boolean }>}
   */
  const runAttempt = (attempt, skipAudio) => {
    const prep = attempt > 0 ? delayMs(280 * attempt) : Promise.resolve();
    return prep.then(() => trimVideoSegmentOnce(sourcePath, start, end, skipAudio))
      .then((outPath) => {
        const sizePromise = sourceSizeBytes > 0
          ? Promise.resolve(sourceSizeBytes)
          : getFileSizeBytes(sourcePath);
        return sizePromise.then((srcSize) => validateTrimOutput(
          outPath,
          expectedDurationMs,
          srcSize,
          sourceDurationMs
        ).then((validated) => ({
            path: outPath,
            trimStartMs: start,
            trimEndMs: end,
            outputDurationMs: validated.durationMs,
            outputSizeBytes: validated.sizeBytes,
            videoOnly: !!skipAudio
          })));
      })
      .catch((err) => {
        if (shouldAbortTrimRetry(err)) {
          return Promise.reject(err);
        }
        if (attempt + 1 < maxAttempts) {
          console.warn(`[MediaContainerTrim] Trim attempt ${attempt} failed:`, err.message || err, '. Retrying with skipAudio=true');
          return delayMs(520 + 380 * attempt).then(() => runAttempt(attempt + 1, true));
        }
        return Promise.reject(err);
      });
  };

  return runAttempt(0, false); // 第一次尝试默认包含音频
}

/**
 * 裁剪母片末尾 tailMs 毫秒。
 * @param {string} sourcePath
 * @param {number} tailMs
 * @param {number} [fallbackDurationMs] 探测失败时用墙钟 segment 时长估算
 * @param {{ sourceSizeBytes?: number }} [options]
 * @returns {Promise<{ path: string, trimStartMs: number, trimEndMs: number, durationMs: number, durationSource: string, outputSizeBytes: number }>}
 */
function trimVideoTail(sourcePath, tailMs, fallbackDurationMs, options) {
  const tail = Math.max(500, Math.floor(Number(tailMs) || 8000));
  const fallback = Math.max(0, Math.floor(Number(fallbackDurationMs) || 0));
  const opts = options && typeof options === 'object' ? options : {};
  return probeVideoDurationMs(sourcePath).then((probe) => {
    let dur = probe && probe.durationMs > 500 ? probe.durationMs : 0;
    let durationSource = probe && probe.source ? probe.source : 'unknown';
    if (!dur && fallback > 500) {
      dur = fallback;
      durationSource = 'wall_fallback';
    }
    if (!dur) {
      return Promise.reject(new Error('tail_trim_duration_unknown'));
    }
    const start = Math.max(0, dur - tail);
    return trimVideoSegment(sourcePath, start, dur, {
      sourceSizeBytes: opts.sourceSizeBytes,
      sourceDurationMs: dur,
      maxAttempts: opts.maxAttempts
    }).then((result) => {
      if (!result || !result.path) {
        return Promise.reject(new Error('tail_trim_export_empty'));
      }
      return {
        path: result.path,
        trimStartMs: result.trimStartMs,
        trimEndMs: result.trimEndMs,
        durationMs: dur,
        durationSource,
        outputDurationMs: result.outputDurationMs,
        outputSizeBytes: result.outputSizeBytes
      };
    });
  });
}

/**
 * 将 segment 内墙钟点击窗映射到文件时间轴。
 * iOS MediaRecorder 常见「墙钟比文件长 ~14s」= 起录延迟，非全程线性压缩；
 * 因此用 encodeStartOffset（wallDur - fileDur）做平移，而非从 0 线性缩放。
 * @param {number} windowStartInSegMs
 * @param {number} windowEndInSegMs
 * @param {number} wallDurationMs
 * @param {number} fileDurationMs
 * @returns {{ trimStartMs: number, trimEndMs: number, mapRatio: number, encodeStartOffsetMs: number }}
 */
function mapWallWindowToFileMs(windowStartInSegMs, windowEndInSegMs, wallDurationMs, fileDurationMs) {
  const wallDur = Math.max(1, Math.floor(Number(wallDurationMs) || 0));
  const fileDur = Math.max(500, Math.floor(Number(fileDurationMs) || 0));
  const winStart = Math.max(0, Math.floor(Number(windowStartInSegMs) || 0));
  const winEnd = Math.max(winStart + 500, Math.floor(Number(windowEndInSegMs) || 0));
  const encodeStartOffsetMs = Math.max(0, wallDur - fileDur);
  const mapRatio = fileDur / wallDur;
  let trimStartMs = winStart - encodeStartOffsetMs;
  let trimEndMs = winEnd - encodeStartOffsetMs;
  if (trimStartMs < 0) {
    const encodedWallSpan = Math.max(500, wallDur - encodeStartOffsetMs);
    const wallWinLen = Math.max(500, winEnd - winStart);
    trimStartMs = 0;
    trimEndMs = Math.min(fileDur, Math.max(500, Math.floor(wallWinLen * (fileDur / encodedWallSpan))));
  }
  trimEndMs = Math.min(fileDur, Math.max(trimStartMs + 500, trimEndMs));
  trimStartMs = Math.max(0, Math.min(trimStartMs, trimEndMs - 500));
  return { trimStartMs, trimEndMs, mapRatio, encodeStartOffsetMs };
}

/** 8s 720p 高光正常体积上限（字节），超出视为未裁剪母片。 */
const EXPORT_TRIM_SIZE_THRESHOLD_BYTES = Math.floor(5 * 1024 * 1024);

/**
 * 判断导出相册前是否需补裁剪。
 * @param {Record<string, unknown>} clip
 * @param {number} fileSizeBytes
 * @returns {boolean}
 */
function clipNeedsExportTrim(clip, fileSizeBytes) {
  if (!clip || clip.trimVerified === true) return false;
  if (!(fileSizeBytes > EXPORT_TRIM_SIZE_THRESHOLD_BYTES)) return false;
  const winStart = typeof clip.windowStartInSegMs === 'number' ? clip.windowStartInSegMs : -1;
  const winEnd = typeof clip.windowEndInSegMs === 'number' ? clip.windowEndInSegMs : -1;
  const wallDur = typeof clip.segmentWallDurationMs === 'number' ? clip.segmentWallDurationMs : 0;
  return winStart >= 0 && winEnd > winStart + 400 && wallDur > 500;
}

/**
 * 导出相册前补裁剪：优先墙钟映射，失败则裁尾窗。
 * @param {string} sourcePath
 * @param {Record<string, unknown>} clip
 * @returns {Promise<string>}
 */
function trimClipForExport(sourcePath, clip) {
  const src = typeof sourcePath === 'string' ? sourcePath : '';
  const meta = clip && typeof clip === 'object' ? clip : {};
  if (!src || !isMediaContainerSupported()) {
    return Promise.resolve(src);
  }
  const tailLeadMs = typeof meta.replayTailTrim === 'boolean' && !meta.replayTailTrim
    ? 0
    : 8000;
  const leadMs = tailLeadMs > 0
    ? tailLeadMs
    : (typeof meta.replayMediaStopAtSec === 'number' && typeof meta.replayInitialTimeSec === 'number'
      ? Math.max(500, Math.floor((meta.replayMediaStopAtSec - meta.replayInitialTimeSec) * 1000))
      : 8000);
  const wallDur = typeof meta.segmentWallDurationMs === 'number' ? meta.segmentWallDurationMs : 0;
  const winStart = typeof meta.windowStartInSegMs === 'number' ? meta.windowStartInSegMs : -1;
  const winEnd = typeof meta.windowEndInSegMs === 'number' ? meta.windowEndInSegMs : -1;
  return getFileSizeBytes(src).then((srcSizeBytes) => {
    if (!clipNeedsExportTrim(meta, srcSizeBytes)) return src;
    return probeVideoDurationMs(src).then((probe) => {
      const probedDurationMs = probe && probe.durationMs ? probe.durationMs : 0;
      if (winStart >= 0 && winEnd > winStart + 400 && wallDur > 500 && probedDurationMs > 500) {
        const mapped = mapWallWindowToFileMs(winStart, winEnd, wallDur, probedDurationMs);
        return trimVideoSegment(src, mapped.trimStartMs, mapped.trimEndMs, {
          sourceSizeBytes: srcSizeBytes,
          sourceDurationMs: probedDurationMs,
          maxAttempts: 3
        })
          .then((result) => (result && result.path ? result.path : src))
          .catch(() => trimVideoTail(src, leadMs, wallDur || probedDurationMs, {
            sourceSizeBytes: srcSizeBytes,
            maxAttempts: 2
          }).then((tail) => (tail && tail.path ? tail.path : src)).catch(() => src));
      }
      return trimVideoTail(src, leadMs, wallDur || probedDurationMs, {
        sourceSizeBytes: srcSizeBytes,
        maxAttempts: 2
      }).then((tail) => (tail && tail.path ? tail.path : src)).catch(() => src);
    });
  });
}

module.exports = {
  isMediaContainerSupported,
  probeVideoDurationMs,
  mapWallWindowToFileMs,
  estimateMaxTrimOutputBytesForDuration,
  trimVideoTail,
  trimVideoSegment,
  clipNeedsExportTrim,
  trimClipForExport,
  isTrimTimeoutError,
  shouldAbortTrimRetry
};
