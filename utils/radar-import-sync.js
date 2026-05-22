/**
 * @fileoverview 从 batch_import 响应或逐条 upsert 结果，同步场次到本地缓存。
 */

const { oamUpsert } = require('../services/radar-api.js');
const { upsertMatch } = require('./radar-local-store.js');

/**
 * @typedef {Object} ImportRow
 * @property {string} team_a
 * @property {string} team_b
 * @property {string} start_time
 */

/**
 * 从 batch 响应中提取可落库的场次。
 * @param {Record<string, unknown>} batchRes
 * @param {string} tournamentId
 * @param {ImportRow[]} rows
 * @returns {Array<{ id: string, tournamentId: string, teamA: string, teamB: string, startTime: string }>}
 */
function extractMatchesFromBatchResponse(batchRes, tournamentId, rows) {
  const res = batchRes || {};
  const now = Date.now();
  const result = [];

  /** @param {Record<string, unknown>} m */
  function pushFromObj(m) {
    const id = m.match_id || m.matchId || m.id || m.affected_id;
    if (!id) return;
    result.push({
      id: String(id),
      tournamentId: String(m.tournament_id || m.tournamentId || tournamentId),
      teamA: String(m.team_a || m.teamA || ''),
      teamB: String(m.team_b || m.teamB || ''),
      startTime: String(m.start_time || m.startTime || ''),
      updatedAt: now
    });
  }

  const candidates = [
    res.imported_matches,
    res.matches,
    res.data && typeof res.data === 'object'
      ? /** @type {Record<string, unknown>} */ (res.data).imported_matches ||
        /** @type {Record<string, unknown>} */ (res.data).matches
      : null
  ];
  for (let i = 0; i < candidates.length; i += 1) {
    const arr = candidates[i];
    if (Array.isArray(arr) && arr.length) {
      arr.forEach(function (item) {
        if (item && typeof item === 'object') {
          pushFromObj(/** @type {Record<string, unknown>} */ (item));
        }
      });
      if (result.length) return result;
    }
  }

  const ids = res.affected_ids || (res.data && typeof res.data === 'object'
    ? /** @type {Record<string, unknown>} */ (res.data).affected_ids
    : null);
  if (Array.isArray(ids) && ids.length === rows.length) {
    rows.forEach(function (row, idx) {
      result.push({
        id: String(ids[idx]),
        tournamentId: String(tournamentId),
        teamA: row.team_a,
        teamB: row.team_b,
        startTime: row.start_time,
        updatedAt: now
      });
    });
  }
  return result;
}

/**
 * 逐条 upsert_match 以拿到 affected_id 并写入本地（batch 响应无 ID 时的兜底）。
 * @param {string} tournamentId
 * @param {ImportRow[]} rows
 * @returns {Promise<number>}
 */
function upsertRowsToLocalSequentially(tournamentId, rows) {
  let chain = Promise.resolve(0);
  rows.forEach(function (row) {
    chain = chain.then(function (count) {
      return oamUpsert({
        action: 'upsert_match',
        data: {
          tournament_id: tournamentId,
          team_a: row.team_a,
          team_b: row.team_b,
          start_time: row.start_time
        }
      }).then(function (res) {
        const id = String(res.affected_id || '');
        if (id) {
          upsertMatch({
            id: id,
            tournamentId: String(tournamentId),
            teamA: row.team_a,
            teamB: row.team_b,
            startTime: row.start_time,
            updatedAt: Date.now()
          });
          return count + 1;
        }
        return count;
      });
    });
  });
  return chain;
}

/**
 * 批量导入成功后同步本地场次列表。
 * @param {string} tournamentId
 * @param {ImportRow[]} rows
 * @param {Record<string, unknown>} batchRes
 * @returns {Promise<number>} 写入本地的条数
 */
function syncImportedMatchesToLocal(tournamentId, rows, batchRes) {
  const parsed = extractMatchesFromBatchResponse(batchRes, tournamentId, rows);
  if (parsed.length) {
    parsed.forEach(function (item) {
      upsertMatch(item);
    });
    return Promise.resolve(parsed.length);
  }
  return upsertRowsToLocalSequentially(tournamentId, rows);
}

module.exports = {
  extractMatchesFromBatchResponse,
  syncImportedMatchesToLocal
};
