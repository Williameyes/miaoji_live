/**
 * @fileoverview 赛事直播雷达 `/api/app/*` 接口封装（响应格式 success: true）。
 */

const { post, get, request } = require('../../utils/request.js');
const {
  parseMatchList,
  parseTournamentList,
  parseMatchDetail
} = require('../utils/radar-model.js');

/**
 * @typedef {Object} RadarAppSuccessBody
 * @property {boolean} success
 * @property {string} [message]
 * @property {string} [error_code]
 * @property {unknown} [data]
 */

/**
 * 解析雷达业务接口响应，失败时抛出带 error_code 的 Error。
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function parseRadarAppResponse(body) {
  if (!body || typeof body !== 'object') {
    throw Object.assign(new Error('服务端响应无效'), { errorCode: 'INVALID_RESPONSE' });
  }
  const b = /** @type {RadarAppSuccessBody & Record<string, unknown>} */ (body);
  if (b.success === true) {
    return b;
  }
  const msg =
    (typeof b.message === 'string' && b.message.length > 0 ? b.message : '') ||
    (typeof b.error_code === 'string' ? b.error_code : '请求失败');
  const err = Object.assign(new Error(msg), {
    errorCode: typeof b.error_code === 'string' ? b.error_code : '',
    responseBody: b
  });
  throw err;
}

/**
 * OAM 维护 upsert。
 * @param {Record<string, unknown>} payload
 * @returns {Promise<Record<string, unknown>>}
 */
function oamUpsert(payload) {
  return post('/api/app/oam/upsert', payload).then(parseRadarAppResponse);
}

/**
 * 拉取赛事列表。
 * @returns {Promise<import('../utils/radar-model.js').RadarTournamentView[]>}
 */
function fetchTournamentList() {
  return get('/api/app/tournament/list')
    .then(parseRadarAppResponse)
    .then(parseTournamentList);
}

/**
 * 拉取场次列表。
 * @param {Object} [query]
 * @param {string} [query.tournamentId] - 赛事 ID，不传则全部
 * @param {string} [query.status] - 如 `monitoring,waiting_radar`
 * @returns {Promise<import('../utils/radar-model.js').RadarMatchView[]>}
 */
function fetchMatchList(query) {
  const q = query || {};
  const params = {};
  if (q.tournamentId && q.tournamentId !== 'all') {
    params.tournament_id = q.tournamentId;
  }
  if (q.status) {
    params.status = q.status;
  }
  return get('/api/app/match/list', params)
    .then(parseRadarAppResponse)
    .then(parseMatchList);
}

/**
 * 拉取单场详情。
 * @param {number|string} matchId
 * @returns {Promise<import('../utils/radar-model.js').RadarMatchView | null>}
 */
function fetchMatchDetail(matchId) {
  return get('/api/app/match/detail', { match_id: matchId })
    .then(parseRadarAppResponse)
    .then(parseMatchDetail);
}

/**
 * 挂载直播雷达任务。
 * @param {number|string} matchId
 * @param {string} rawText - 抖音口令或链接原文
 * @returns {Promise<Record<string, unknown>>}
 */
function addMatchTask(matchId, rawText) {
  return post('/api/app/match/add_task', {
    match_id: matchId,
    raw_text: rawText
  }).then(parseRadarAppResponse);
}

/**
 * 关闭场次全部监控任务。
 * @param {number|string} matchId
 * @returns {Promise<Record<string, unknown>>}
 */
function stopMatchMonitoring(matchId) {
  return request({
    url: '/api/app/match/stop_monitoring',
    method: 'POST',
    data: { match_id: matchId }
  })
    .then(parseRadarAppResponse)
    .catch(function (err) {
      if (err && err.statusCode === 409 && err.data && typeof err.data === 'object') {
        const b = /** @type {Record<string, unknown>} */ (err.data);
        if (b.error_code === 'MATCH_ALREADY_ENDED') {
          throw Object.assign(new Error(
            typeof b.message === 'string' ? b.message : '场次已结束'
          ), { errorCode: 'MATCH_ALREADY_ENDED', responseBody: b });
        }
      }
      throw err;
    });
}

/**
 * 拉取场次合并时序热度数据。
 * @param {number|string} matchId
 * @returns {Promise<Record<string, unknown>>}
 */
function fetchMatchStreamData(matchId) {
  return get('/api/app/match/stream_data', { match_id: matchId }).then(parseRadarAppResponse);
}

/**
 * 拉取赛事影响力战报。
 * @param {number|string} tournamentId
 * @returns {Promise<Record<string, unknown>>}
 */
function fetchTournamentInfluence(tournamentId) {
  return get('/api/app/tournament/influence', { tournament_id: tournamentId }).then(
    parseRadarAppResponse
  );
}

module.exports = {
  parseRadarAppResponse,
  oamUpsert,
  fetchTournamentList,
  fetchMatchList,
  fetchMatchDetail,
  addMatchTask,
  stopMatchMonitoring,
  fetchMatchStreamData,
  fetchTournamentInfluence
};
