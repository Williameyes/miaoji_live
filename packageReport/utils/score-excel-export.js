/**
 * @fileoverview 记分事件流水导出 Excel（V2 事件驱动重构占位，Phase 2 实现业务逻辑）。
 */

const XLSX = require('./vendor/xlsx.mini.min.js');

/** @const {string} 比赛列表 Storage 主键 */
const STORAGE_KEY_MATCHES = 'MIAOXIE_MATCHES';

/**
 * @typedef {Object} ExportScoreOptions
 * @property {string} matchId 比赛 ID
 */

/**
 * 根据 matchId 查找比赛配置。
 * @param {string} matchId
 * @returns {Record<string, unknown>|null}
 */
function findMatchById(matchId) {
  const raw = wx.getStorageSync(STORAGE_KEY_MATCHES);
  if (!Array.isArray(raw)) return null;
  return raw.find(function (m) {
    return m && String(m.id) === String(matchId);
  }) || null;
}

/**
 * 将当前比赛记分摘要导出为 xlsx 并写入用户目录（Phase 2 可扩展为完整事件流水）。
 * @param {ExportScoreOptions} options
 * @returns {Promise<string>} 导出文件路径
 */
function exportScoreEventsToXlsx(options) {
  const matchId = options && options.matchId ? String(options.matchId).trim() : '';
  if (!matchId) {
    return Promise.reject(new Error('缺少比赛 ID'));
  }
  const match = findMatchById(matchId);
  if (!match) {
    return Promise.reject(new Error('未找到比赛数据'));
  }
  const teamA = match.teamA && typeof match.teamA === 'object' ? match.teamA : {};
  const teamB = match.teamB && typeof match.teamB === 'object' ? match.teamB : {};
  const rows = [
    ['赛名', '主队', '客队', '主队得分', '客队得分', '节次'],
    [
      match.matchName || '',
      teamA.name || '',
      teamB.name || '',
      teamA.score != null ? teamA.score : 0,
      teamB.score != null ? teamB.score : 0,
      match.period != null ? match.period : 0
    ]
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, '记分摘要');
  const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const filePath = `${wx.env.USER_DATA_PATH}/score-report-${matchId}-${Date.now()}.xlsx`;
  return new Promise(function (resolve, reject) {
    wx.getFileSystemManager().writeFile({
      filePath: filePath,
      data: buffer,
      success: function () {
        wx.openDocument({
          filePath: filePath,
          fileType: 'xlsx',
          showMenu: true,
          success: function () {
            resolve(filePath);
          },
          fail: function () {
            resolve(filePath);
          }
        });
      },
      fail: function (err) {
        reject(new Error((err && err.errMsg) || '写入文件失败'));
      }
    });
  });
}

module.exports = {
  exportScoreEventsToXlsx
};
