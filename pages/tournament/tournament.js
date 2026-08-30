/**
 * @fileoverview 赛事资讯大厅页面（风格与主页保持一致）
 */
const { fetchTournamentList } = require('../../services/tournament-api.js');
const { sortTournamentsWithPins } = require('../../utils/tournament-pin.js');

const CARD_THEME_PALETTE = [
  'theme-royal-blue',
  'theme-sky-cyan',
  'theme-deep-blue',
  'theme-teal-mint'
];
const STORAGE_KEY = 'TN_CARD_THEME_MAP_V3';

function getOrAssignCardTheme(tournamentId, usedThemes) {
  if (!tournamentId) return CARD_THEME_PALETTE[0];
  let themeMap = {};
  try {
    themeMap = wx.getStorageSync(STORAGE_KEY) || {};
  } catch (e) {
    themeMap = {};
  }

  if (themeMap[tournamentId] && CARD_THEME_PALETTE.indexOf(themeMap[tournamentId]) !== -1) {
    if (usedThemes) usedThemes.push(themeMap[tournamentId]);
    return themeMap[tournamentId];
  }

  const lastUsed = usedThemes && usedThemes.length > 0 ? usedThemes[usedThemes.length - 1] : null;
  const candidates = CARD_THEME_PALETTE.filter(function (t) { return t !== lastUsed; });
  const randomIndex = Math.floor(Math.random() * candidates.length);
  const selectedTheme = candidates[randomIndex] || CARD_THEME_PALETTE[0];

  themeMap[tournamentId] = selectedTheme;
  if (usedThemes) usedThemes.push(selectedTheme);
  try {
    wx.setStorageSync(STORAGE_KEY, themeMap);
  } catch (e) {
    // ignore
  }
  return selectedTheme;
}

Page({
  data: {
    statusBarHeight: 20,
    rawFormattedList: [],
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

    if (wx.showShareMenu) {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ['shareAppMessage', 'shareTimeline']
      });
    }

    this.loadTournaments();
  },

  onShow: function () {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({
        selected: 1
      });
    }
    // 每次从详情页返回时，按最新本地置顶状态重新排序
    if (this.data.rawFormattedList && this.data.rawFormattedList.length) {
      const sorted = sortTournamentsWithPins(this.data.rawFormattedList);
      this.setData({ tournamentList: sorted });
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
        const usedThemes = [];
        const formatted = (list || []).map(function (item) {
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
          const sportType = item.sportType || (isSoccer ? 'soccer' : 'basketball');
          const themeClass = getOrAssignCardTheme(item.id, usedThemes);

          return {
            id: item.id,
            name: item.name,
            dateRange: item.startDate && item.endDate ? item.startDate + ' ~ ' + item.endDate : '进行中',
            scheduledCount: item.scheduledCount || 0,
            statusText: statusText,
            statusClass: statusClass,
            isEnded: statusText === '已完赛',
            sportType: sportType,
            themeClass: themeClass,
            coverUrl: item.coverUrl || item.cover || '',
            sportLabel: isSoccer ? '足球' : (sportType === 'badminton' ? '羽毛球' : '篮球'),
            sportIcon: isSoccer ? '⚽' : (sportType === 'badminton' ? '🏸' : '🏀'),
            formatLabel: item.format === 'CUP' ? '赛会制' : '联赛制'
          };
        });

        const sorted = sortTournamentsWithPins(formatted);
        self.setData({
          rawFormattedList: formatted,
          tournamentList: sorted,
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
  },

  onShareAppMessage: function () {
    return {
      title: '高光记分 · 赛事资讯与实时排行榜',
      path: '/pages/tournament/tournament'
    };
  },

  onShareTimeline: function () {
    return {
      title: '高光记分 · 赛事资讯与实时排行榜'
    };
  }
});
