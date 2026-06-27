/**
 * @fileoverview 雷达 OAM 服务端响应字段归一化。
 */

/**
 * @typedef {Object} RadarMatchView
 * @property {string} id
 * @property {string} tournamentId
 * @property {string} tournamentName
 * @property {string} teamA
 * @property {string} teamB
 * @property {string} startTime
 * @property {string} matchStatus
 * @property {string} [currentOnline]
 * @property {string} [peakOnline]
 * @property {string} [totalViewersRecap]
 * @property {number} [totalPool]
 * @property {number} [minViewers]
 * @property {string} [settlementStatus]
 * @property {string} [financialSettledAt]
 * @property {number} [adsCount]
 * @property {number} [adsVersion]
 * @property {boolean} [promoEnabled]
 * @property {string} [promoTitle]
 * @property {boolean} [canManage] - scope=mine 时恒为 true；scope=all 时区分是否可操作
 * @property {string | null} [ownerOpenid] - 场次负责人 openid（详情接口）
 */

/**
 * @typedef {Object} RadarTournamentView
 * @property {string} id
 * @property {string} name
 * @property {string} startDate
 * @property {string} endDate
 * @property {number} [influenceScore]
 * @property {number} [totalScheduledMatches]
 * @property {number} [totalMonitoredMatches]
 * @property {boolean} [canManage] - scope=mine 时恒为 true；scope=all 时区分是否可操作
 */

/**
 * 从响应体中提取数组字段。
 * @param {Record<string, unknown>} body
 * @param {string[]} keys
 * @returns {unknown[]}
 */
function pickArray(body, keys) {
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    if (Array.isArray(body[k])) {
      return body[k];
    }
  }
  const data = body.data;
  if (data && typeof data === 'object') {
    const d = /** @type {Record<string, unknown>} */ (data);
    for (let j = 0; j < keys.length; j += 1) {
      const k2 = keys[j];
      if (Array.isArray(d[k2])) {
        return d[k2];
      }
    }
  }
  return [];
}

/**
 * 归一化单条场次。
 * @param {unknown} raw
 * @returns {RadarMatchView | null}
 */
function normalizeMatch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const id = o.match_id || o.matchId || o.id;
  if (id == null || id === '') return null;
  return {
    id: String(id),
    tournamentId: String(o.tournament_id || o.tournamentId || ''),
    tournamentName: String(o.tournament_name || o.tournamentName || ''),
    teamA: String(o.team_a || o.teamA || ''),
    teamB: String(o.team_b || o.teamB || ''),
    startTime: String(o.start_time || o.startTime || ''),
    matchStatus: String(o.match_status || o.status || ''),
    currentOnline:
      o.current_online_count != null ? String(o.current_online_count) : '',
    peakOnline: o.peak_user_count != null ? String(o.peak_user_count) : '',
    totalViewersRecap:
      o.total_viewers_recap != null ? String(o.total_viewers_recap) : '',
    totalPool: Number(o.total_pool ?? o.totalPool ?? 0) || 0,
    minViewers: Number(o.min_viewers ?? o.minViewers ?? 0) || 0,
    settlementStatus: String(o.settlement_status || o.settlementStatus || 'pending'),
    financialSettledAt: String(o.financial_settled_at || o.financialSettledAt || ''),
    adsCount:
      Number(o.ads_count ?? o.adsCount ?? 0) ||
      (Array.isArray(o.ads_list) ? o.ads_list.length : 0),
    adsVersion: Number(o.ads_version ?? o.adsVersion ?? 0) || 0,
    promoEnabled: Boolean(o.promo_enabled ?? o.promoEnabled),
    promoTitle: String(o.promo_title || o.promoTitle || ''),
    canManage: o.can_manage !== false && o.canManage !== false,
    ownerOpenid:
      o.owner_openid != null || o.ownerOpenid != null
        ? String(o.owner_openid || o.ownerOpenid || '')
        : null,
    boundAnchors: Array.isArray(o.bound_anchors || o.boundAnchors)
      ? (o.bound_anchors || o.boundAnchors).map(function(a) {
          return {
            secUserId: String(a.sec_user_id || a.secUserId || ''),
            anchorName: String(a.anchor_name || a.anchorName || ''),
            liveUrl: String(a.live_url || a.liveUrl || '')
          };
        })
      : []
  };
}

/**
 * 归一化单条赛事。
 * @param {unknown} raw
 * @returns {RadarTournamentView | null}
 */
function normalizeTournament(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const id = o.tournament_id || o.tournamentId || o.id;
  if (id == null || id === '') return null;
  return {
    id: String(id),
    name: String(o.tournament_name || o.tournamentName || o.name || ''),
    startDate: String(o.start_date || o.startDate || ''),
    endDate: String(o.end_date || o.endDate || ''),
    influenceScore: Number(o.influence_score ?? o.influenceScore ?? 0) || 0,
    totalScheduledMatches:
      Number(o.total_scheduled_matches ?? o.totalScheduledMatches ?? 0) || 0,
    totalMonitoredMatches:
      Number(o.total_monitored_matches ?? o.totalMonitoredMatches ?? 0) || 0,
    canManage: o.can_manage !== false && o.canManage !== false
  };
}

/**
 * 从列表接口响应解析场次数组。
 * @param {Record<string, unknown>} body
 * @returns {RadarMatchView[]}
 */
function parseMatchList(body) {
  const list = pickArray(body, ['matches', 'match_list', 'items']);
  const result = [];
  list.forEach(function (item) {
    const m = normalizeMatch(item);
    if (m) result.push(m);
  });
  return result;
}

/**
 * 从列表接口响应解析赛事数组。
 * @param {Record<string, unknown>} body
 * @returns {RadarTournamentView[]}
 */
function parseTournamentList(body) {
  const list = pickArray(body, ['tournaments', 'tournament_list', 'items']);
  const result = [];
  list.forEach(function (item) {
    const t = normalizeTournament(item);
    if (t) result.push(t);
  });
  return result;
}

/**
 * 从详情接口响应解析单场。
 * @param {Record<string, unknown>} body
 * @returns {RadarMatchView | null}
 */
function parseMatchDetail(body) {
  if (body.match && typeof body.match === 'object') {
    return normalizeMatch(body.match);
  }
  const data = body.data;
  if (data && typeof data === 'object') {
    const d = /** @type {Record<string, unknown>} */ (data);
    if (d.match && typeof d.match === 'object') {
      return normalizeMatch(d.match);
    }
  }
  return normalizeMatch(body);
}

module.exports = {
  pickArray,
  normalizeMatch,
  normalizeTournament,
  parseMatchList,
  parseTournamentList,
  parseMatchDetail
};
