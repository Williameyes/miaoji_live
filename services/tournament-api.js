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
  let formatVal = String(rawFormat || 'LEAGUE').trim().toUpperCase();
  if (formatVal === '赛会制') formatVal = 'CUP';
  else if (formatVal === '联赛制') formatVal = 'LEAGUE';
  const rawSportType = o.sport_type || o.sportType;
  return {
    id: String(id),
    name: String(o.tournament_name || o.tournamentName || o.name || ''),
    startDate: String(o.start_date || o.startDate || ''),
    endDate: String(o.end_date || o.endDate || ''),
    influenceScore: Number(o.influence_score ?? o.influenceScore ?? 0) || 0,
    scheduledCount: Number(o.total_scheduled_matches ?? o.totalScheduledMatches ?? (Array.isArray(o.matches) ? o.matches.length : 0)) || 0,
    monitoredCount: Number(o.total_monitored_matches ?? o.totalMonitoredMatches ?? 0) || 0,
    isPublic: o.is_public !== false && o.isPublic !== false,
    canManage: o.can_manage !== false && o.canManage !== false,
    sportType: String(rawSportType || 'basketball'),
    format: formatVal,
    coverUrl: String(o.cover_url || o.coverUrl || o.cover || '')
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

/**
 * 赛事创建人生成管理员邀请码
 * @param {number|string} tournamentId
 * @returns {Promise<{tournament_id: number, invite_code: string, expire_at: string}>}
 */
function createTournamentInvite(tournamentId) {
  return post('/api/app/tournament/invite/create', { tournament_id: Number(tournamentId) })
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizeAppApiError(err);
    });
}

/**
 * 受邀人接受邀请成为管理员
 * @param {number|string} tournamentId
 * @param {string} inviteCode
 * @param {Object} [userInfo]
 * @returns {Promise<{success: boolean, tournament_id: number, role: string, is_owner?: boolean}>}
 */
function acceptTournamentInvite(tournamentId, inviteCode, userInfo) {
  const payload = Object.assign(
    {
      tournament_id: Number(tournamentId),
      invite_code: String(inviteCode || '').trim()
    },
    userInfo || {}
  );
  return post('/api/app/tournament/invite/accept', payload)
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizeAppApiError(err);
    });
}

/**
 * 获取赛事管理员列表
 * @param {number|string} tournamentId
 * @returns {Promise<{tournament_id: number, is_owner: boolean, collaborators: Array}>}
 */
function fetchTournamentCollaborators(tournamentId) {
  return get('/api/app/tournament/collaborators', { tournament_id: Number(tournamentId) })
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizeAppApiError(err);
    });
}

/**
 * 移除赛事管理员
 * @param {number|string} tournamentId
 * @param {string} openid
 * @returns {Promise<{success: boolean, tournament_id: number}>}
 */
function removeTournamentCollaborator(tournamentId, openid) {
  return post('/api/app/tournament/collaborator/remove', {
    tournament_id: Number(tournamentId),
    openid: String(openid || '').trim()
  })
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizeAppApiError(err);
    });
}

/**
 * 创建赛事移交口令（创建人发起移交）
 * @param {number|string} tournamentId
 * @returns {Promise<{tournament_id: number, tournament_name: string, transfer_code: string, expire_at: string, expires_in_seconds: number}>}
 */
function createTournamentTransfer(tournamentId) {
  return post('/api/app/tournament/transfer/create', { tournament_id: Number(tournamentId) })
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizeAppApiError(err);
    });
}

/**
 * 查询赛事移交口令摘要（接收方核对）
 * @param {string} transferCode
 * @returns {Promise<{valid: boolean, tournament_id: number, tournament_name: string, start_date: string, end_date: string, match_count: number, expire_at: string, created_by: string}>}
 */
function fetchTournamentTransferInfo(transferCode) {
  return get('/api/app/tournament/transfer/info', { transfer_code: String(transferCode || '').trim() })
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizeAppApiError(err);
    });
}

/**
 * 接收方通过口令认领赛事管理权
 * @param {string} transferCode
 * @returns {Promise<{success: boolean, tournament_id: number, tournament_name: string}>}
 */
function claimTournamentTransfer(transferCode) {
  return post('/api/app/tournament/transfer/claim', { transfer_code: String(transferCode || '').trim() })
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizeAppApiError(err);
    });
}

module.exports = {
  parseTournamentList,
  fetchTournamentList,
  fetchTournamentDetail,
  oamUpsert,
  createTournamentInvite,
  acceptTournamentInvite,
  fetchTournamentCollaborators,
  removeTournamentCollaborator,
  createTournamentTransfer,
  fetchTournamentTransferInfo,
  claimTournamentTransfer
};


