/**
 * @fileoverview 赛事资讯大厅页面（风格与主页保持一致）
 */
const { fetchTournamentList } = require('../../services/tournament-api.js');

Page({
  data: {
    statusBarHeight: 20,
    tournamentList: [],
    loading: true,
    filterTab: 'all' // all | active | ended
  },

  onLoad: function () {
    try {
      const sys = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
      this.setData({ statusBarHeight: sys.statusBarHeight || 20 });
    } catch (e) {
      // fallback
    }
    this.loadTournaments();
  },

  onShow: function () {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        selected: 1
      });
    }
  },

  onPullDownRefresh: function () {
    this.loadTournaments().finally(function () {
      wx.stopPullDownRefresh();
    });
  },

  onFilterTabChange: function (e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ filterTab: tab });
  },

  loadTournaments: function () {
    const self = this;
    this.setData({ loading: true });
    return fetchTournamentList({ scope: 'public' })
      .then(function (list) {
        const formatted = list.map(function (item) {
          const now = Date.now();
          const startDateMs = item.startDate ? new Date(item.startDate).getTime() : 0;
          const endDateMs = item.endDate ? new Date(item.endDate).getTime() + 86400000 : 0;
          let statusText = '进行中';
          let statusClass = 'status-active';

          if (endDateMs > 0 && now > endDateMs) {
            statusText = '已完赛';
            statusClass = 'status-ended';
          } else if (startDateMs > 0 && now < startDateMs) {
            statusText = '未开始';
            statusClass = 'status-pending';
          }

          const isSoccer = item.sportType === 'soccer';

          return {
            id: item.id,
            name: item.name,
            dateRange: item.startDate && item.endDate ? item.startDate + ' ~ ' + item.endDate : '进行中',
            scheduledCount: item.scheduledCount || 0,
            statusText: statusText,
            statusClass: statusClass,
            isEnded: statusText === '已完赛',
            sportLabel: isSoccer ? '足球' : '篮球',
            sportIcon: isSoccer ? '⚽' : '🏀',
            formatLabel: item.format === 'CUP' ? '赛会制' : '联赛制'
          };
        });
        self.setData({
          tournamentList: formatted,
          loading: false
        });
      })
      .catch(function (err) {
        self.setData({ loading: false });
        wx.showToast({ title: err.message || '数据加载失败', icon: 'none' });
      });
  },

  onTournamentTap: function (e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: '/packagePromo/pages/tournament-detail/tournament-detail?id=' + encodeURIComponent(id)
    });
  }
});
