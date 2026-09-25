/**
 * @fileoverview 比赛AI战报后端接口交互层 (对接 miaoxie-server)
 */
const { get, post } = require('../utils/request.js');
const { parseAppApiResponse } = require('../utils/app-api-response.js');

/**
 * 查询指定场次已保存在服务器数据库中的战报
 * @param {number|string} matchId
 * @returns {Promise<{ exists: boolean, report: any }>}
 */
function fetchBackendMatchReport(matchId) {
  if (!matchId) {
    return Promise.resolve({ exists: false, report: null });
  }
  return get(`/api/app/match/report/detail?match_id=${encodeURIComponent(matchId)}`)
    .then((res) => {
      const parsed = parseAppApiResponse(res);
      if (parsed.ok && parsed.data) {
        return parsed.data;
      }
      return { exists: false, report: null };
    })
    .catch((err) => {
      console.warn('[MatchReportApi] fetchBackendMatchReport error:', err);
      return { exists: false, report: null };
    });
}

/**
 * 请求后端调用硅基流动大模型生成战报并落库存储
 * @param {Object} payload
 * @param {number|string} payload.matchId
 * @param {number|string} [payload.tournamentId]
 * @param {boolean} [payload.forceRegenerate]
 * @param {string} [payload.userNote]
 * @param {string} [payload.modelName]
 * @param {Object} [payload.statsOverride]
 * @returns {Promise<{ ok: boolean, data?: any, error?: string }>}
 */
function generateBackendMatchReport(payload) {
  const reqBody = {
    match_id: Number(payload.matchId),
    tournament_id: payload.tournamentId ? Number(payload.tournamentId) : undefined,
    force_regenerate: Boolean(payload.forceRegenerate),
    user_note: payload.userNote || undefined,
    model_name: payload.modelName || 'Qwen/Qwen2.5-7B-Instruct',
    stats_override: payload.statsOverride || undefined
  };

  return post('/api/app/match/report/generate', reqBody)
    .then((res) => {
      const parsed = parseAppApiResponse(res);
      if (parsed.ok && parsed.data && parsed.data.report) {
        return { ok: true, data: parsed.data.report, isCached: parsed.data.is_cached };
      }
      return { ok: false, error: parsed.message || '生成战报失败' };
    })
    .catch((err) => {
      console.warn('[MatchReportApi] generateBackendMatchReport error:', err);
      return { ok: false, error: err?.message || '网络请求失败' };
    });
}

/**
 * 删除指定场次的战报
 * @param {number|string} matchId
 */
function deleteBackendMatchReport(matchId) {
  return post('/api/app/match/report/delete', { match_id: Number(matchId) })
    .then((res) => {
      const parsed = parseAppApiResponse(res);
      return parsed.ok;
    })
    .catch(() => false);
}

module.exports = {
  fetchBackendMatchReport,
  generateBackendMatchReport,
  deleteBackendMatchReport
};
