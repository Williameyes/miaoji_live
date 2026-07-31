/**
 * @fileoverview 临时分段环状缓冲区，记录分段元信息并自动清理过期物理临时文件。
 */

function createSegmentRing(maxSegments) {
  var segments = [];
  var limit = maxSegments || 1; // 仅保留 1 个最新分段，旧段落盘即擦除，极简低内存占用

  function safeUnlink(filePath, reason) {
    if (!filePath || typeof filePath !== 'string') return;
    try {
      var fs = wx.getFileSystemManager();
      fs.unlink({
        filePath: filePath,
        success: function () {
          console.log('[SegmentRing][ROLLING_FILE] Successfully deleted segment (' + (reason || 'recycled') + '):', filePath);
        },
        fail: function (err) {
          // 若因原生层尚未完全关闭文件句柄导致首次 unlink 失败，1000ms 后兜底重试
          setTimeout(function () {
            try {
              fs.unlink({
                filePath: filePath,
                success: function () {
                  console.log('[SegmentRing][ROLLING_FILE] Retry deleted segment (' + (reason || 'recycled') + '):', filePath);
                },
                fail: function (eFail) {
                  console.warn('[SegmentRing][ROLLING_FILE] Unlink retry failed for:', filePath, eFail);
                }
              });
            } catch (e) {}
          }, 1000);
        }
      });
    } catch (e) {}
  }

  /**
   * 写入新分段
   * @param {{ path: string, start: number, stop: number, trackId: 'A'|'B' }} seg
   */
  function push(seg) {
    segments.push(seg);
    if (segments.length > limit) {
      var removed = segments.shift();
      if (removed && removed.path) {
        safeUnlink(removed.path, 'buffer_overflow_recycled');
      }
    }
  }

  /**
   * 清空环并物理删除所有临时文件
   */
  function clear() {
    while (segments.length > 0) {
      var seg = segments.shift();
      if (seg && seg.path) {
        safeUnlink(seg.path, 'recorder_stopped_clear');
      }
    }
  }

  function getSegments() {
    return segments;
  }

  /**
   * 从环中移除指定路径（不删除物理文件，由调用方负责 unlink）。
   *
   * @param {string} path
   * @returns {boolean} 是否移除成功
   */
  function removeByPath(path) {
    if (!path) return false;
    var before = segments.length;
    segments = segments.filter(function (seg) {
      return !(seg && seg.path === path);
    });
    return segments.length < before;
  }

  return {
    push: push,
    clear: clear,
    getSegments: getSegments,
    removeByPath: removeByPath
  };
}

module.exports = {
  createSegmentRing: createSegmentRing
};
