/**
 * @fileoverview 高光素材导出：纯音频裁切 + 视录分离视频与独立音轨 mux（仅 packageRec 使用）。
 */

const mediaContainerTrim = require('../../utils/replay-buffer/media-container-trim.js');

/** @type {Promise<void>} */
var muxLock = Promise.resolve();

/**
 * @template T
 * @param {function(): Promise<T>} fn
 * @returns {Promise<T>}
 */
function withMuxLock(fn) {
  var run = muxLock.then(function () {
    return fn();
  });
  muxLock = run.then(function () {
    return undefined;
  }, function () {
    return undefined;
  });
  return run;
}

/**
 * @param {Array<{ kind?: string }>} tracks
 * @param {string} preferKind video|audio
 * @returns {Object|null}
 */
function pickTrack(tracks, preferKind) {
  var list = Array.isArray(tracks) ? tracks : [];
  var i;
  for (i = 0; i < list.length; i++) {
    var t = list[i];
    if (!t) continue;
    if (String(t.kind || '').toLowerCase() === preferKind) return t;
  }
  if (preferKind === 'audio') {
    for (i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].kind || '').toLowerCase() !== 'video') return list[i];
    }
  }
  return list[0] || null;
}

/**
 * 裁切纯音频文件（mp3/aac 等，无视频轨）。
 *
 * @param {string} sourcePath
 * @param {number} startMs
 * @param {number} endMs
 * @returns {Promise<string>}
 */
function trimAudioOnlySegment(sourcePath, startMs, endMs) {
  var src = typeof sourcePath === 'string' ? sourcePath : '';
  var start = Math.max(0, Math.floor(Number(startMs) || 0));
  var end = Math.max(start + 500, Math.floor(Number(endMs) || 0));
  if (!src || !mediaContainerTrim.isMediaContainerSupported()) {
    return Promise.reject(new Error('audio_trim_unsupported'));
  }

  return withMuxLock(function () {
    return new Promise(function (resolve, reject) {
      var container = wx.createMediaContainer();
      var finished = false;

      /**
       * @param {Error|unknown} [err]
       * @param {string} [path]
       * @returns {void}
       */
      function done(err, path) {
        if (finished) return;
        finished = true;
        try {
          if (container && typeof container.destroy === 'function') {
            container.destroy();
          }
        } catch (eDestroy) {}
        if (err) reject(err);
        else resolve(path || '');
      }

      try {
        container.extractDataSource({
          source: src,
          success: function (res) {
            var track = pickTrack(res && res.tracks, 'audio');
            if (!track || typeof track.slice !== 'function') {
              done(new Error('audio_track_missing'));
              return;
            }
            var dur = Number(track.duration) || 0;
            var durMs = dur > 0 && dur < 7200 ? Math.floor(dur * 1000) : dur;
            var safeEnd = durMs > 500 ? Math.min(end, durMs) : end;
            var safeStart = Math.max(0, Math.min(start, safeEnd - 500));
            try {
              container.addTrack(track);
              track.slice(safeStart, safeEnd);
            } catch (eSlice) {
              done(eSlice);
              return;
            }
            container.export({
              success: function (exportRes) {
                var out = exportRes && exportRes.tempFilePath ? exportRes.tempFilePath : '';
                if (!out) {
                  done(new Error('audio_trim_export_empty'));
                  return;
                }
                done(null, out);
              },
              fail: function (exportErr) {
                done(exportErr || new Error('audio_trim_export_fail'));
              }
            });
          },
          fail: function (extractErr) {
            done(extractErr || new Error('audio_extract_fail'));
          }
        });
      } catch (eOuter) {
        done(eOuter);
      }
    });
  });
}

/**
 * 将已裁切好的视频与音频合成为一条 mp4。
 *
 * @param {string} videoPath
 * @param {string} audioPath
 * @returns {Promise<string>}
 */
function muxVideoWithAudio(videoPath, audioPath) {
  var vPath = typeof videoPath === 'string' ? videoPath : '';
  var aPath = typeof audioPath === 'string' ? audioPath : '';
  if (!vPath) {
    return Promise.reject(new Error('mux_video_missing'));
  }
  if (!aPath) {
    return Promise.resolve(vPath);
  }
  if (!mediaContainerTrim.isMediaContainerSupported()) {
    return Promise.resolve(vPath);
  }

  return withMuxLock(function () {
    return new Promise(function (resolve, reject) {
      var container = wx.createMediaContainer();
      var finished = false;

      /**
       * @param {Error|unknown} [err]
       * @param {string} [path]
       * @returns {void}
       */
      function done(err, path) {
        if (finished) return;
        finished = true;
        try {
          if (container && typeof container.destroy === 'function') {
            container.destroy();
          }
        } catch (eDestroy) {}
        if (err) reject(err);
        else resolve(path || vPath);
      }

      try {
        container.extractDataSource({
          source: vPath,
          success: function (resV) {
            var videoTrack = pickTrack(resV && resV.tracks, 'video');
            if (!videoTrack) {
              done(new Error('mux_video_track_missing'));
              return;
            }
            container.extractDataSource({
              source: aPath,
              success: function (resA) {
                var audioTrack = pickTrack(resA && resA.tracks, 'audio');
                if (!audioTrack) {
                  done(new Error('mux_audio_track_missing'));
                  return;
                }
                try {
                  container.addTrack(videoTrack);
                  container.addTrack(audioTrack);
                } catch (eAdd) {
                  done(eAdd);
                  return;
                }
                container.export({
                  success: function (exportRes) {
                    var out = exportRes && exportRes.tempFilePath ? exportRes.tempFilePath : '';
                    if (!out) {
                      done(new Error('mux_export_empty'));
                      return;
                    }
                    done(null, out);
                  },
                  fail: function (exportErr) {
                    done(exportErr || new Error('mux_export_fail'));
                  }
                });
              },
              fail: function (extractErrA) {
                done(extractErrA || new Error('mux_audio_extract_fail'));
              }
            });
          },
          fail: function (extractErrV) {
            done(extractErrV || new Error('mux_video_extract_fail'));
          }
        });
      } catch (eOuter) {
        done(eOuter);
      }
    });
  });
}

/**
 * 导出带声高光片段。
 *
 * @param {string} videoSourcePath
 * @param {Record<string, unknown>} seekPlan
 * @param {{ path: string, trimStartMs: number, trimEndMs: number }|null} audioPlan
 * @returns {Promise<string>}
 */
function exportAvHighlightClip(videoSourcePath, seekPlan, audioPlan) {
  var src = typeof videoSourcePath === 'string' ? videoSourcePath : '';
  if (!src) {
    return Promise.reject(new Error('video_source_missing'));
  }

  var meta = seekPlan && typeof seekPlan === 'object' ? Object.assign({}, seekPlan) : {};
  if (typeof meta.wallDurationMs === 'number' && !meta.segmentWallDurationMs) {
    meta.segmentWallDurationMs = meta.wallDurationMs;
  }

  return mediaContainerTrim.trimClipForExport(src, meta).then(function (trimmedVideo) {
    if (!audioPlan || !audioPlan.path) {
      console.warn('[AvHighlightExport] No audio plan, export video-only');
      return trimmedVideo;
    }
    return trimAudioOnlySegment(audioPlan.path, audioPlan.trimStartMs, audioPlan.trimEndMs)
      .then(function (trimmedAudio) {
        return muxVideoWithAudio(trimmedVideo, trimmedAudio);
      })
      .catch(function (err) {
        console.error('[AvHighlightExport] Audio mux failed:', err);
        return Promise.reject(new Error('audio_mux_failed:' + (err && err.message ? err.message : 'unknown')));
      });
  });
}

module.exports = {
  trimAudioOnlySegment: trimAudioOnlySegment,
  muxVideoWithAudio: muxVideoWithAudio,
  exportAvHighlightClip: exportAvHighlightClip
};
