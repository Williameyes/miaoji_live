/**
 * @fileoverview 热度监测 / 推广监测列表共用逻辑（纯前端过滤，无需改后端）。
 */

const { fetchMatchList, fetchMatchDetail } = require('../services/radar-api.js');
const { formatStartTimeDisplay } = require('./radar-datetime.js');
const { formatCompactCount, parseUserCount } = require('./radar-chart.js');

/** 列表轮询间隔（毫秒） */
const LIST_POLL_MS = 20000;

/** 热度监测仅展示 monitoring 状态 */
const HEAT_MONITOR_STATUS = 'monitoring';

/** @type {Record<string, string>} */
const STATUS_LABELS = {
  waiting_radar: '等待雷达',
  monitoring: '监测中',
  ended: '已结束',
  interrupted: '已中断'
};

/**
 * 是否为带广告/推广配置的场次（以详情字段为准）。
 * @param {import('./radar-model.js').RadarMatchView | null | undefined} detail
 * @returns {boolean}
 */
function isCommercialMatch(detail) {
  if (!detail) return false;
  return (
    Boolean(detail.promoEnabled) ||
    (detail.totalPool || 0) > 0 ||
    (detail.minViewers || 0) > 0 ||
    (detail.adsCount || 0) > 0
  );
}

/**
 * @param {import('./radar-model.js').RadarMatchView} detail
 * @param {Object} [extras]
 * @returns {Record<string, unknown>}
 */
function mapMonitorRow(detail, extras) {
  const extra = extras || {};
  return {
    id: detail.id,
    teamA: detail.teamA,
    teamB: detail.teamB,
    startTimeText: formatStartTimeDisplay(detail.startTime),
    tournamentName: detail.tournamentName || '—',
    statusLabel: STATUS_LABELS[detail.matchStatus] || detail.matchStatus || '—',
    currentOnline: detail.currentOnline
      ? formatCompactCount(parseUserCount(detail.currentOnline))
      : '—',
    promoTitle: detail.promoTitle || '',
    promoEnabled: Boolean(detail.promoEnabled),
    hasPool: (detail.totalPool || 0) > 0,
    pendingCount: typeof extra.pendingCount === 'number' ? extra.pendingCount : 0
  };
}

/**
 * 拉取并归类场次详情。
 * @param {'heat' | 'promo'} mode
 * @returns {Promise<Record<string, unknown>[]>}
 */
function fetchMonitorRows(mode) {
  const listQuery =
    mode === 'heat' ? { status: HEAT_MONITOR_STATUS } : {};
  return fetchMatchList(listQuery).then(function (list) {
    if (!list.length) return [];
    return Promise.all(
      list.map(function (item) {
        return fetchMatchDetail(item.id)
          .then(function (detail) {
            if (!detail) return null;
            if (mode === 'heat') {
              if (detail.matchStatus !== HEAT_MONITOR_STATUS) return null;
              if (isCommercialMatch(detail)) return null;
              return mapMonitorRow(detail);
            }
            if (detail.matchStatus === 'ended') return null;
            if (!isCommercialMatch(detail)) return null;
            return mapMonitorRow(detail);
          })
          .catch(function () {
            return null;
          });
      })
    ).then(function (rows) {
      return rows.filter(function (row) {
        return row != null;
      });
    });
  });
}

module.exports = {
  LIST_POLL_MS,
  HEAT_MONITOR_STATUS,
  STATUS_LABELS,
  isCommercialMatch,
  mapMonitorRow,
  fetchMonitorRows
};
