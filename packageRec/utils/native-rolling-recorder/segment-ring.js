/**
 * @fileoverview 临时分段环状缓冲区，记录分段元信息并自动清理过期物理临时文件。
 */

function createSegmentRing(maxSegments) {
  var segments = [];
  var limit = maxSegments || 1; // 仅保留 1 个最新分段，旧分段落盘即物理擦除，维持单文件低容量占用

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

  return {
    push: push,
    clear: clear,
    getSegments: getSegments
  };
}

module.exports = {
  createSegmentRing: createSegmentRing
};
