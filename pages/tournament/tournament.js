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

let _cachedThemeMap = null;

function getThemeMap() {
  if (_cachedThemeMap !== null) {
    return _cachedThemeMap;
  }
  try {
    _cachedThemeMap = wx.getStorageSync(STORAGE_KEY) || {};
  } catch (e) {
    _cachedThemeMap = {};
  }
  return _cachedThemeMap;
}

function getOrAssignCardTheme(tournamentId, usedThemes) {
  if (!tournamentId) return CARD_THEME_PALETTE[0];
  const themeMap = getThemeMap();

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

/**
 * 安全解析日期字符串为时间戳 (毫秒)
 * @param {string} dateStr YYYY-MM-DD 或 YYYY/MM/DD
 * @param {boolean} [isEndOfDay=false] 是否解析为当天 23:59:59.999
 * @returns {number}
 */
function parseDateToMs(dateStr, isEndOfDay) {
  if (!dateStr || typeof dateStr !== 'string') return 0;
  const s = dateStr.trim().replace(/-/g, '/');
  if (!s) return 0;
  if (isEndOfDay && s.indexOf(':') === -1) {
    const d = new Date(s + ' 23:59:59');
    const ms = d.getTime();
    if (!isNaN(ms)) return ms;
  }
  const d = new Date(s);
  const ms = d.getTime();
  return isNaN(ms) ? 0 : ms;
}

/**
 * 赛事资讯列表排序规则：
 * 1. 状态优先级：进行中 (1) -> 未开始 (2) -> 已完赛 (3)
 * 2. 同状态内部排序：
 *    - 进行中：最近开赛的在前面（开赛时间降序），时间相同按 ID 降序
 *    - 未开始：即将开赛的在前面（开赛时间升序），时间相同按 ID 降序
 *    - 已完赛：最近完赛的在前面（完赛时间降序），时间相同按 ID 降序
 */
function compareTournamentsByStatus(a, b) {
  // 1. 状态优先级
  if (a.statusPriority !== b.statusPriority) {
    return a.statusPriority - b.statusPriority;
  }

  // 2. 同为「进行中」：最近开赛的在前面（开赛时间降序）
  if (a.statusPriority === 1) {
    if (b.startDateMs !== a.startDateMs) {
      return b.startDateMs - a.startDateMs;
    }
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  }

  // 3. 同为「未开始」：开赛时间由近及远升序（即将开赛的排在前面）
  if (a.statusPriority === 2) {
    if (a.startDateMs && b.startDateMs && a.startDateMs !== b.startDateMs) {
      return a.startDateMs - b.startDateMs;
    }
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  }

  // 4. 同为「已完赛」：完赛时间由近及远降序（最近完赛的排在前面）
  if (a.statusPriority === 3) {
    if (b.endDateMs !== a.endDateMs) {
      return b.endDateMs - a.endDateMs;
    }
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  }

  return (Number(b.id) || 0) - (Number(a.id) || 0);
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
      const sys = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : (wx.getSystemInfoSync ? wx.getSystemInfoSync() : {});
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
          const startDateMs = parseDateToMs(item.startDate, false);
          const endDateMs = parseDateToMs(item.endDate, true);
          let statusText = '进行中';
          let statusClass = 'status-active';
          let statusPriority = 1; // 1: 进行中, 2: 未开始, 3: 已完赛

          if (endDateMs > 0 && now > endDateMs) {
            statusText = '已完赛';
            statusClass = 'status-ended';
            statusPriority = 3;
          } else if (startDateMs > 0 && now < startDateMs) {
            statusText = '未开始';
            statusClass = 'status-pending';
            statusPriority = 2;
          } else {
            statusText = '进行中';
            statusClass = 'status-active';
            statusPriority = 1;
          }

          const isSoccer = item.sportType === 'soccer';
          const sportType = item.sportType || (isSoccer ? 'soccer' : 'basketball');
          const themeClass = getOrAssignCardTheme(item.id, usedThemes);

          return {
            id: item.id,
            name: item.name,
            dateRange: item.startDate && item.endDate ? item.startDate + ' ~ ' + item.endDate : '进行中',
            startDateMs: startDateMs,
            endDateMs: endDateMs,
            statusPriority: statusPriority,
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

        // 核心排序：进行中 -> 未开始 -> 已完赛
        formatted.sort(compareTournamentsByStatus);

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
