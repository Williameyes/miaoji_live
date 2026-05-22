/**
 * @fileoverview 雷达监控 Canvas 2D 时序曲线绘制。
 */

/**
 * @typedef {Object} TimelinePoint
 * @property {number} timestamp
 * @property {number} userCount
 */

/**
 * 将接口 user_count 字符串解析为数值（如 1.2w → 12000）。
 * @param {string|number} raw
 * @returns {number}
 */
function parseUserCount(raw) {
  if (typeof raw === 'number' && !Number.isNaN(raw)) return raw;
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return 0;
  const m = s.match(/^([\d.]+)\s*([wk万]?)$/);
  if (!m) {
    const n = parseFloat(s.replace(/,/g, ''));
    return Number.isNaN(n) ? 0 : n;
  }
  const num = parseFloat(m[1]);
  const unit = m[2];
  if (unit === 'w' || unit === '万') return Math.round(num * 10000);
  if (unit === 'k') return Math.round(num * 1000);
  return Number.isNaN(num) ? 0 : num;
}

/**
 * 规范化 timeline_data。
 * @param {unknown[]} list
 * @returns {TimelinePoint[]}
 */
function normalizeTimeline(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(function (item) {
      if (!item || typeof item !== 'object') return null;
      const o = /** @type {Record<string, unknown>} */ (item);
      const ts = Number(o.timestamp);
      const uc = parseUserCount(
        typeof o.user_count === 'string' || typeof o.user_count === 'number'
          ? o.user_count
          : o.userCount
      );
      if (!Number.isFinite(ts)) return null;
      return { timestamp: ts, userCount: uc };
    })
    .filter(Boolean);
}

/**
 * 绘制热度折线图。
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {TimelinePoint[]} points
 * @param {Object} [opts]
 * @param {string} [opts.lineColor]
 * @param {string} [opts.fillColor]
 * @returns {void}
 */
function drawTimelineChart(ctx, width, height, points, opts) {
  const options = opts || {};
  const lineColor = options.lineColor || '#2563eb';
  const fillColor = options.fillColor || 'rgba(37, 99, 235, 0.12)';
  const padL = 44;
  const padR = 16;
  const padT = 20;
  const padB = 36;
  const plotW = Math.max(1, width - padL - padR);
  const plotH = Math.max(1, height - padT - padB);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  if (!points.length) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('暂无监控数据', width / 2, height / 2);
    return;
  }

  const xs = points.map(function (p) {
    return p.timestamp;
  });
  const ys = points.map(function (p) {
    return p.userCount;
  });
  const minX = Math.min.apply(null, xs);
  const maxX = Math.max.apply(null, xs);
  const maxY = Math.max.apply(null, ys.concat([1]));
  const minY = 0;

  const xScale = function (ts) {
    if (maxX === minX) return padL + plotW / 2;
    return padL + ((ts - minX) / (maxX - minX)) * plotW;
  };
  const yScale = function (v) {
    return padT + plotH - ((v - minY) / (maxY - minY || 1)) * plotH;
  };

  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padT + (plotH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
  }

  ctx.beginPath();
  points.forEach(function (p, idx) {
    const x = xScale(p.timestamp);
    const y = yScale(p.userCount);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(xScale(points[points.length - 1].timestamp), padT + plotH);
  ctx.lineTo(xScale(points[0].timestamp), padT + plotH);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  ctx.beginPath();
  points.forEach(function (p, idx) {
    const x = xScale(p.timestamp);
    const y = yScale(p.userCount);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  const last = points[points.length - 1];
  ctx.fillStyle = lineColor;
  ctx.beginPath();
  ctx.arc(xScale(last.timestamp), yScale(last.userCount), 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#64748b';
  ctx.font = '11px sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('0', 8, padT + plotH);
  ctx.fillText(formatCompactCount(maxY), 8, padT + 8);
}

/**
 * 紧凑数字格式。
 * @param {number} n
 * @returns {string}
 */
function formatCompactCount(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + '万';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(Math.round(n));
}

module.exports = {
  parseUserCount,
  normalizeTimeline,
  drawTimelineChart,
  formatCompactCount
};
