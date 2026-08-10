/**
 * @fileoverview 纯本地存储的赛事置顶管理工具（无需后端数据库）
 */
const { STORAGE_USER_INFO_KEY, getToken } = require('./request.js');

const PINNED_TOURNAMENTS_KEY = 'pinned_tournaments_list';

/**
 * 检查当前用户是否已登录
 * @returns {boolean}
 */
function checkIsLoggedIn() {
  try {
    const token = getToken();
    if (token) return true;
    const app = getApp && getApp();
    if (app && app.globalData && app.globalData.userInfo) {
      return true;
    }
    const cachedUser = wx.getStorageSync(STORAGE_USER_INFO_KEY);
    if (cachedUser && typeof cachedUser === 'object' && Object.keys(cachedUser).length > 0) {
      return true;
    }
  } catch (e) {
    // ignore
  }
  return false;
}

/**
 * 获取本地已置顶的赛事 ID 列表 (数组)
 * @returns {string[]}
 */
function getPinnedTournamentIds() {
  try {
    const list = wx.getStorageSync(PINNED_TOURNAMENTS_KEY);
    if (Array.isArray(list)) {
      return list.map(String);
    }
  } catch (e) {
    // ignore
  }
  return [];
}

/**
 * 判断指定赛事 ID 是否被置顶
 * @param {string|number} tournamentId
 * @returns {boolean}
 */
function isTournamentPinned(tournamentId) {
  if (!tournamentId) return false;
  const list = getPinnedTournamentIds();
  return list.indexOf(String(tournamentId)) >= 0;
}

/**
 * 切换赛事置顶状态（添加或移除）
 * @param {string|number} tournamentId
 * @returns {boolean} 返回最新的置顶状态（true为已置顶，false为已取消）
 */
function toggleTournamentPin(tournamentId) {
  if (!tournamentId) return false;
  const tid = String(tournamentId);
  let list = getPinnedTournamentIds();
  const index = list.indexOf(tid);
  let isPinned = false;

  if (index >= 0) {
    // 已置顶 -> 取消置顶
    list.splice(index, 1);
    isPinned = false;
  } else {
    // 未置顶 -> 移到最前面置顶
    list.unshift(tid);
    isPinned = true;
  }

  try {
    wx.setStorageSync(PINNED_TOURNAMENTS_KEY, list);
  } catch (e) {
    // ignore
  }

  return isPinned;
}

/**
 * 结合置顶状态，将赛事列表重排（置顶的赛事排在列表最上方）
 * @template T
 * @param {T[]} list
 * @returns {T[]}
 */
function sortTournamentsWithPins(list) {
  if (!Array.isArray(list) || !list.length) return [];
  const pinnedIds = getPinnedTournamentIds();
  if (!pinnedIds.length) return list;

  const pinnedItems = [];
  const normalItems = [];

  list.forEach(function (item) {
    const id = String(item.id || item.tournament_id || '');
    if (id && pinnedIds.indexOf(id) >= 0) {
      pinnedItems.push(Object.assign({}, item, { isPinned: true }));
    } else {
      normalItems.push(Object.assign({}, item, { isPinned: false }));
    }
  });

  // 按置顶顺序排列置顶项
  pinnedItems.sort(function (a, b) {
    const idA = String(a.id || a.tournament_id || '');
    const idB = String(b.id || b.tournament_id || '');
    return pinnedIds.indexOf(idA) - pinnedIds.indexOf(idB);
  });

  return pinnedItems.concat(normalItems);
}

module.exports = {
  checkIsLoggedIn,
  getPinnedTournamentIds,
  isTournamentPinned,
  toggleTournamentPin,
  sortTournamentsWithPins
};
