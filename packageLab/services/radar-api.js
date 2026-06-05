/**
 * @fileoverview 赛事直播雷达 `/api/app/*` 接口封装（响应格式 success: true）。
 */

const { post, get, request, uploadFile } = require('../../utils/request.js');
const {
  parseAppApiResponse,
  normalizeAppApiError
} = require('../../utils/app-api-response.js');
const {
  parseMatchList,
  parseTournamentList,
  parseMatchDetail
} = require('../utils/radar-model.js');

/** @type {Record<string, string>} */
const RADAR_ERROR_MESSAGES = {
  MATCH_NOT_ENDED: '全场尚未结束，暂不能清算',
  POOL_NOT_CONFIGURED: '请先配置广告奖池金额',
  GLOBAL_SHARES_ZERO: '暂无推广分数据，请确认雷达已上报',
  SETTLEMENT_ALREADY_DONE: '本场已清算',
  ADS_LIMIT_EXCEEDED: '广告物料已达上限（10 个）',
  LOGO_FILE_TOO_LARGE: 'Logo 压缩后仍过大，请更换一张更简洁的图片',
  MATCH_ALREADY_ENDED: '场次已结束',
  MATCH_NOT_FOUND: '场次不存在'
};

/** @type {typeof parseAppApiResponse} */
const parseRadarAppResponse = parseAppApiResponse;

/**
 * 将非 2xx 的雷达业务错误也归一成带 errorCode/message 的 Error。
 * @param {unknown} err
 * @returns {Error}
 */
function normalizeRadarAppError(err) {
  return normalizeAppApiError(err, RADAR_ERROR_MESSAGES);
}

/**
 * OAM 维护 upsert。
 * @param {Record<string, unknown>} payload
 * @returns {Promise<Record<string, unknown>>}
 */
function oamUpsert(payload) {
  return post('/api/app/oam/upsert', payload)
    .then(parseRadarAppResponse)
    .catch(function (err) {
      throw normalizeRadarAppError(err);
    });
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
 * 上传 / 更新场次广告 Logo。
 * @param {Object} params
 * @param {number|string} params.matchId
 * @param {string} params.filePath
 * @param {string} [params.brandName]
 * @returns {Promise<Record<string, unknown>>}
 */
function setMatchAds(params) {
  const formData = {
    match_id: String(params.matchId)
  };
  if (params.brandName) {
    formData.brand_name = String(params.brandName);
  }
  return uploadFile({
    url: '/api/app/match/set_ads',
    filePath: params.filePath,
    name: 'logo_file',
    formData: formData
  })
    .then(parseRadarAppResponse)
    .catch(function (err) {
      throw normalizeRadarAppError(err);
    });
}

/**
 * 一键财务清算。
 * @param {number|string} matchId
 * @returns {Promise<Record<string, unknown>>}
 */
function settleMatch(matchId) {
  return post('/api/app/match/settle', { match_id: matchId })
    .then(parseRadarAppResponse)
    .catch(function (err) {
      throw normalizeRadarAppError(err);
    });
}

/**
 * @typedef {Object} SettlementRecord
 * @property {string} secUserId
 * @property {string} liveUrl
 * @property {string} totalShares
 * @property {string} finalPayout
 * @property {string} evidenceZipUrl
 * @property {string} settledAt
 */

/**
 * 拉取结算单。
 * @param {number|string} matchId
 * @returns {Promise<Record<string, unknown>>}
 */
function getMatchSettlement(matchId) {
  return get('/api/app/match/settlement', { match_id: matchId })
    .then(parseRadarAppResponse)
    .then(function (body) {
      const rawRecords = Array.isArray(body.records) ? body.records : [];
      const records = rawRecords.map(function (item) {
        const r = item && typeof item === 'object'
          ? /** @type {Record<string, unknown>} */ (item)
          : {};
        return {
          secUserId: String(r.sec_user_id || r.secUserId || ''),
          liveUrl: String(r.live_url || r.liveUrl || ''),
          totalShares: String(r.total_shares || r.totalShares || '0'),
          finalPayout: String(r.final_payout || r.finalPayout || '0'),
          evidenceZipUrl: String(r.evidence_zip_url || r.evidenceZipUrl || ''),
          settledAt: String(r.settled_at || r.settledAt || '')
        };
      });
      return Object.assign({}, body, { records: records });
    })
    .catch(function (err) {
      throw normalizeRadarAppError(err);
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
  normalizeRadarAppError,
  oamUpsert,
  fetchTournamentList,
  fetchMatchList,
  fetchMatchDetail,
  addMatchTask,
  stopMatchMonitoring,
  fetchMatchStreamData,
  fetchTournamentInfluence,
  setMatchAds,
  settleMatch,
  getMatchSettlement
};
