/**
 * @fileoverview 从已有的录制分段中裁切导出 8s 带声视频片段。
 */

const { trimVideoSegment } = require('../../../utils/replay-buffer/media-container-trim.js');

/**
 * 裁切导出过去 8 秒高光
 * @param {Array<{ path: string, start: number, stop: number }>} segments
 * @param {number} triggerTime 触发时间戳
 * @param {{ skipTrim?: boolean }} [options]
 * @returns {Promise<string>} 裁切后的 mp4 临时路径
 */
function exportLast8s(segments, triggerTime, options) {
  var opts = options || {};
  var targetStart = triggerTime - 8000;
  var targetEnd = triggerTime;

  var matchSeg = null;
  // 逆序查找，优先匹配最新的分段
  for (var i = segments.length - 1; i >= 0; i--) {
    var seg = segments[i];
    if (seg.path && seg.start <= targetStart && seg.stop >= targetEnd) {
      matchSeg = seg;
      break;
    }
  }

  // 兜底策略：若无完美覆盖的分段（例如刚刚启动录制），选择有重合的最新分段进行截取
  if (!matchSeg) {
    for (var i = segments.length - 1; i >= 0; i--) {
      var s = segments[i];
      if (s.path && s.stop > targetStart) {
        matchSeg = s;
        break;
      }
    }
  }

  // 二次兜底：实在找不到，就取最新的那个分段
  if (!matchSeg && segments.length > 0) {
    matchSeg = segments[segments.length - 1];
  }

  if (!matchSeg || !matchSeg.path) {
    return Promise.reject(new Error('no_available_segment'));
  }

  var fileDurationMs = matchSeg.stop - matchSeg.start;
  var trimStart = Math.max(0, targetStart - matchSeg.start);
  var trimEnd = Math.max(500, targetEnd - matchSeg.start);

  if (trimEnd > fileDurationMs) {
    trimEnd = fileDurationMs;
    trimStart = Math.max(0, trimEnd - 8000);
  }

  // 确保裁切区间至少有 500ms
  if (trimEnd <= trimStart + 400) {
    return Promise.reject(new Error('trim_duration_too_short'));
  }

  console.log('[ClipExporter] Export segment:', matchSeg.path, 'trimStart:', trimStart, 'trimEnd:', trimEnd, 'duration:', fileDurationMs);

  if (opts.skipTrim) {
    return Promise.resolve(matchSeg.path);
  }

  return trimVideoSegment(matchSeg.path, trimStart, trimEnd, {
    sourceDurationMs: fileDurationMs
  }).then(function (result) {
    if (result && result.path) {
      return result.path;
    }
    throw new Error('trim_output_path_empty');
  });
}

module.exports = {
  exportLast8s: exportLast8s
};
