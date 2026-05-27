/**
 * @fileoverview 记分报表页：查看摘要、导出 Excel。
 */

const { exportScoreEventsToXlsx } = require('../../utils/score-excel-export.js');

/** @const {string} 比赛列表 Storage 主键 */
const STORAGE_KEY_MATCHES = 'MIAOXIE_MATCHES';

Page({
  data: {
    matchId: '',
    matchTitle: '',
    scoreInfo: '',
    loading: false
  },

  /**
   * @param {Record<string, string|undefined>} options
   * @returns {void}
   */
  onLoad: function (options) {
    const matchId = options && options.matchId ? decodeURIComponent(options.matchId) : '';
    this.setData({ matchId: matchId });
    this._loadMatchSummary(matchId);
  },

  /**
   * 从 Storage 加载比赛摘要展示。
   * @param {string} matchId
   * @returns {void}
   */
  _loadMatchSummary: function (matchId) {
    if (!matchId) return;
    const raw = wx.getStorageSync(STORAGE_KEY_MATCHES);
    if (!Array.isArray(raw)) return;
    const match = raw.find(function (m) {
      return m && String(m.id) === String(matchId);
    });
    if (!match) return;
    const teamA = match.teamA && typeof match.teamA === 'object' ? match.teamA : {};
    const teamB = match.teamB && typeof match.teamB === 'object' ? match.teamB : {};
    this.setData({
      matchTitle: match.matchName || `${teamA.name || 'A'} VS ${teamB.name || 'B'}`,
      scoreInfo: `${teamA.score != null ? teamA.score : 0} : ${teamB.score != null ? teamB.score : 0}`
    });
  },

  /**
   * 导出当前比赛记分 Excel。
   * @returns {void}
   */
  onExportExcel: function () {
    const self = this;
    const matchId = this.data.matchId;
    if (!matchId) {
      wx.showToast({ title: '缺少比赛 ID', icon: 'none' });
      return;
    }
    self.setData({ loading: true });
    exportScoreEventsToXlsx({ matchId: matchId })
      .then(function () {
        wx.showToast({ title: '导出成功', icon: 'success' });
      })
      .catch(function (err) {
        wx.showToast({
          title: (err && err.message) || '导出失败',
          icon: 'none'
        });
      })
      .finally(function () {
        self.setData({ loading: false });
      });
  }
});
