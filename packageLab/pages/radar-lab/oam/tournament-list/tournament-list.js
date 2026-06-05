/**
 * @fileoverview 雷达 OAM 赛事列表主页（数据来自服务端列表接口）。
 */

const { ensureRadarLabAccess } = require('../../../../utils/radar-access.js');
const { fetchTournamentList } = require('../../../../services/radar-api.js');
const { getRadarListScope } = require('../../../../utils/radar-list-scope.js');

Page({
  data: {
    tournamentRows: [],
    loading: false,
    adminViewAll: false
  },

  /**
   * @returns {void}
   */
  onLoad: function () {
    if (!ensureRadarLabAccess({ redirectBack: true })) return;
  },

  /**
   * @returns {void}
   */
  onShow: function () {
    this._reloadList();
  },

  /**
   * 下拉刷新。
   * @returns {void}
   */
  onPullDownRefresh: function () {
    const self = this;
    this._reloadList(true).finally(function () {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * @param {boolean} [silent]
   * @returns {Promise<void>}
   */
  _reloadList: function (silent) {
    const self = this;
    if (!silent) {
      this.setData({ loading: true });
    }
    return fetchTournamentList({ scope: getRadarListScope() })
      .then(function (list) {
        const listScope = getRadarListScope();
        const rows = list.map(function (t) {
          const dateRange =
            t.startDate && t.endDate ? t.startDate + ' ~ ' + t.endDate : '—';
          return {
            id: t.id,
            name: t.name,
            dateRange: dateRange,
            influenceScore:
              t.influenceScore != null && t.influenceScore > 0
                ? String(t.influenceScore)
                : '—',
            scheduledCount: t.totalScheduledMatches || 0,
            monitoredCount: t.totalMonitoredMatches || 0,
            canManage: t.canManage !== false
          };
        });
        self.setData({
          tournamentRows: rows,
          loading: false,
          adminViewAll: listScope === 'all'
        });
      })
      .catch(function (err) {
        self.setData({ loading: false });
        if (!silent) {
          wx.showToast({ title: err.message || '加载失败', icon: 'none' });
        }
      });
  },

  /**
   * 新建赛事。
   * @returns {void}
   */
  onNewTournament: function () {
    if (!ensureRadarLabAccess()) return;
    wx.navigateTo({
      url: '/packageLab/pages/radar-lab/oam/tournament-edit/tournament-edit?mode=new'
    });
  },

  /**
   * 编辑赛事。
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onEditTournament: function (e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const row = this.data.tournamentRows.find(function (r) {
      return String(r.id) === String(id);
    });
    if (row && row.canManage === false) {
      wx.showToast({ title: '无权操作该赛事', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url:
        '/packageLab/pages/radar-lab/oam/tournament-edit/tournament-edit?id=' +
        encodeURIComponent(id)
    });
  }
});
