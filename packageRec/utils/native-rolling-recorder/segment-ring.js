/**
 * @fileoverview 临时分段环状缓冲区，记录分段元信息并自动清理过期物理临时文件。
 */

function createSegmentRing(maxSegments) {
  var segments = [];
  var limit = maxSegments || 1; // 仅保留 1 个最新轻量分段（~60MB），旧段落盘即擦除，极简低内存占用

  /**
   * 写入新分段
   * @param {{ path: string, start: number, stop: number, trackId: 'A'|'B' }} seg
   */
  function push(seg) {
    segments.push(seg);
    if (segments.length > limit) {
      var removed = segments.shift();
      if (removed && removed.path) {
        try {
          var fs = wx.getFileSystemManager();
          fs.unlink({
            filePath: removed.path,
            success: function () {
              console.log('[SegmentRing] Deleted expired temp segment:', removed.path);
            },
            fail: function (err) {
              console.log('[SegmentRing] Temp segment release request passed:', removed.path, err.errMsg || err);
            }
          });
        } catch (e) {
          console.log('[SegmentRing] unlink pass:', e);
        }
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
        try {
          var fs = wx.getFileSystemManager();
          fs.unlink({
            filePath: seg.path,
            fail: function () {}
          });
        } catch (e) {}
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
