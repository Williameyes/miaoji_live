/**
 * @fileoverview 赛事与场次通用 API 请求封装（置于主包，供全平台与分包跨包调用）
 */
const { get, post } = require('../utils/request.js');
const { parseAppApiResponse, normalizeAppApiError } = require('../utils/app-api-response.js');

function parseTournamentItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw;
  const id = o.tournament_id || o.tournamentId || o.id;
  if (id == null || id === '') return null;
  const rawFormat = o.format || o.tournament_format || o.tournamentFormat;
  const rawSportType = o.sport_type || o.sportType;
  return {
    id: String(id),
    name: String(o.tournament_name || o.tournamentName || o.name || ''),
    startDate: String(o.start_date || o.startDate || ''),
    endDate: String(o.end_date || o.endDate || ''),
    influenceScore: Number(o.influence_score ?? o.influenceScore ?? 0) || 0,
    scheduledCount: Number(o.total_scheduled_matches ?? o.totalScheduledMatches ?? 0) || 0,
    monitoredCount: Number(o.total_monitored_matches ?? o.totalMonitoredMatches ?? 0) || 0,
    canManage: o.can_manage !== false && o.canManage !== false,
    sportType: String(rawSportType || 'basketball'),
    format: String(rawFormat || 'LEAGUE')
  };
}

function parseTournamentDetail(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const base = parseTournamentItem(raw) || {};
  const result = Object.assign({}, raw, base);
  if (base.format) result.format = base.format;
  if (base.sportType) {
    result.sport_type = base.sportType;
    result.sportType = base.sportType;
  }
  if (base.id) {
    result.tournament_id = base.id;
    result.id = base.id;
  }
  if (base.name) {
    result.tournament_name = base.name;
    result.name = base.name;
  }
  if (base.startDate) {
    result.start_date = base.startDate;
    result.startDate = base.startDate;
  }
  if (base.endDate) {
    result.end_date = base.endDate;
    result.endDate = base.endDate;
  }
  if (base.canManage !== undefined) {
    result.can_manage = base.canManage;
    result.canManage = base.canManage;
  }
  return result;
}

function parseTournamentList(body) {
  let list = [];
  if (Array.isArray(body)) {
    list = body;
  } else if (body && Array.isArray(body.tournaments)) {
    list = body.tournaments;
  } else if (body && body.data && Array.isArray(body.data.tournaments)) {
    list = body.data.tournaments;
  }
  const result = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = parseTournamentItem(list[i]);
    if (item) result.push(item);
  }
  return result;
}

/**
 * 拉取赛事列表 (支持 scope: 'mine' | 'all' | 'public')
 * @param {Object} [query]
 * @returns {Promise<Array>}
 */
function fetchTournamentList(query) {
  const q = query || {};
  const params = {
    scope: q.scope || 'mine'
  };
  return get('/api/app/tournament/list', params)
    .then(parseAppApiResponse)
    .then(parseTournamentList);
}

/**
 * 拉取 C 端赛事详情、赛程与排行榜
 * @param {number|string} tournamentId
 * @returns {Promise<Record<string, unknown>>}
 */
function fetchTournamentDetail(tournamentId) {
  return get('/api/app/tournament/detail', { tournament_id: tournamentId })
    .then(parseAppApiResponse)
    .then(parseTournamentDetail)
    .catch(function (err) {
      throw normalizeAppApiError(err);
    });
}

/**
 * OAM 维护 upsert (赛事/场次保存与更新)
 * @param {Record<string, unknown>} payload
 * @returns {Promise<Record<string, unknown>>}
 */
function oamUpsert(payload) {
  return post('/api/app/oam/upsert', payload)
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizeAppApiError(err);
    });
}

module.exports = {
  parseTournamentList,
  fetchTournamentList,
  fetchTournamentDetail,
  oamUpsert
};
