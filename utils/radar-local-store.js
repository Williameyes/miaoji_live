/**
 * @fileoverview 雷达 OAM 本地资产缓存（服务端无列表接口时用于小程序端展示与跳转）。
 */

const STORAGE_KEY = 'radar_lab_assets_v1';

/**
 * @typedef {Object} RadarLocalTournament
 * @property {string} id
 * @property {string} name
 * @property {string} startDate
 * @property {string} endDate
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} RadarLocalMatch
 * @property {string} id
 * @property {string} tournamentId
 * @property {string} teamA
 * @property {string} teamB
 * @property {string} startTime
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} RadarLocalAnchor
 * @property {string} secUserId
 * @property {string} anchorName
 * @property {string} liveUrl
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} RadarLocalAssets
 * @property {RadarLocalTournament[]} tournaments
 * @property {RadarLocalMatch[]} matches
 * @property {RadarLocalAnchor[]} anchors
 */

/**
 * 读取本地资产快照。
 * @returns {RadarLocalAssets}
 */
function readAssets() {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY);
    if (raw && typeof raw === 'object') {
      const o = /** @type {Record<string, unknown>} */ (raw);
      return {
        tournaments: Array.isArray(o.tournaments) ? o.tournaments : [],
        matches: Array.isArray(o.matches) ? o.matches : [],
        anchors: Array.isArray(o.anchors) ? o.anchors : []
      };
    }
  } catch (e) {
    // 忽略读取异常
  }
  return { tournaments: [], matches: [], anchors: [] };
}

/**
 * 写入本地资产快照。
 * @param {RadarLocalAssets} assets
 * @returns {void}
 */
function writeAssets(assets) {
  wx.setStorageSync(STORAGE_KEY, assets);
}

/**
 * Upsert 赛事到本地列表。
 * @param {RadarLocalTournament} item
 * @returns {RadarLocalAssets}
 */
function upsertTournament(item) {
  const assets = readAssets();
  const idx = assets.tournaments.findIndex(function (t) {
    return String(t.id) === String(item.id);
  });
  if (idx >= 0) {
    assets.tournaments[idx] = item;
  } else {
    assets.tournaments.unshift(item);
  }
  writeAssets(assets);
  return assets;
}

/**
 * Upsert 场次到本地列表。
 * @param {RadarLocalMatch} item
 * @returns {RadarLocalAssets}
 */
function upsertMatch(item) {
  const assets = readAssets();
  const idx = assets.matches.findIndex(function (m) {
    return String(m.id) === String(item.id);
  });
  if (idx >= 0) {
    assets.matches[idx] = item;
  } else {
    assets.matches.unshift(item);
  }
  writeAssets(assets);
  return assets;
}

/**
 * Upsert 主播到本地列表。
 * @param {RadarLocalAnchor} item
 * @returns {RadarLocalAssets}
 */
function upsertAnchor(item) {
  const assets = readAssets();
  const idx = assets.anchors.findIndex(function (a) {
    return String(a.secUserId) === String(item.secUserId);
  });
  if (idx >= 0) {
    assets.anchors[idx] = item;
  } else {
    assets.anchors.unshift(item);
  }
  writeAssets(assets);
  return assets;
}

/**
 * 批量写入场次（Excel 导入后）。
 * @param {RadarLocalMatch[]} list
 * @returns {RadarLocalAssets}
 */
function appendMatches(list) {
  const assets = readAssets();
  list.forEach(function (item) {
    const idx = assets.matches.findIndex(function (m) {
      return String(m.id) === String(item.id);
    });
    if (idx >= 0) {
      assets.matches[idx] = item;
    } else {
      assets.matches.unshift(item);
    }
  });
  writeAssets(assets);
  return assets;
}

/**
 * 按赛事 ID 筛选场次。
 * @param {string} tournamentId
 * @returns {RadarLocalMatch[]}
 */
function listMatchesByTournament(tournamentId) {
  const assets = readAssets();
  return assets.matches.filter(function (m) {
    return String(m.tournamentId) === String(tournamentId);
  });
}

/**
 * 查找单个场次。
 * @param {string} matchId
 * @returns {RadarLocalMatch | null}
 */
function findMatch(matchId) {
  const assets = readAssets();
  const found = assets.matches.find(function (m) {
    return String(m.id) === String(matchId);
  });
  return found || null;
}

/**
 * 查找单个赛事。
 * @param {string} tournamentId
 * @returns {RadarLocalTournament | null}
 */
function findTournament(tournamentId) {
  const assets = readAssets();
  const found = assets.tournaments.find(function (t) {
    return String(t.id) === String(tournamentId);
  });
  return found || null;
}

/**
 * 列出全部或按赛事筛选的场次（按比赛时间倒序）。
 * @param {string} [tournamentId] - 空或 `all` 表示全部
 * @returns {RadarLocalMatch[]}
 */
function listAllMatchesSorted(tournamentId) {
  const assets = readAssets();
  let list = assets.matches.slice();
  const tid = tournamentId ? String(tournamentId) : '';
  if (tid && tid !== 'all') {
    list = list.filter(function (m) {
      return String(m.tournamentId) === tid;
    });
  }
  list.sort(function (a, b) {
    const ta = Date.parse(String(a.startTime).replace(' ', 'T')) || a.updatedAt || 0;
    const tb = Date.parse(String(b.startTime).replace(' ', 'T')) || b.updatedAt || 0;
    return tb - ta;
  });
  return list;
}

module.exports = {
  readAssets,
  writeAssets,
  upsertTournament,
  upsertMatch,
  upsertAnchor,
  appendMatches,
  listMatchesByTournament,
  listAllMatchesSorted,
  findMatch,
  findTournament
};
