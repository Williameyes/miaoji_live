/**
 * @fileoverview 赛事影响力 2D 卡通风战报海报离屏 Canvas 绘制。
 */

/**
 * @typedef {Object} InfluencePosterData
 * @property {string} tournamentName
 * @property {number|string} totalViewersRecap
 * @property {number|string} peakUserCount
 * @property {number|string} influenceScore
 * @property {number|string} [durationSeconds]
 * @property {string} [subtitle]
 */

/**
 * 绘制圆角矩形路径。
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r
 * @returns {void}
 */
function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * 绘制卡通篮球背景与装饰。
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w
 * @param {number} h
 * @returns {void}
 */
function drawCartoonBackground(ctx, w, h) {
  const grd = ctx.createLinearGradient(0, 0, w, h);
  grd.addColorStop(0, '#1e3a8a');
  grd.addColorStop(0.45, '#2563eb');
  grd.addColorStop(1, '#f97316');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, w, h);

  ctx.globalAlpha = 0.15;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 6; i += 1) {
    ctx.beginPath();
    ctx.arc(40 + i * 90, 80 + (i % 3) * 120, 36 + i * 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.fillStyle = '#fb923c';
  ctx.beginPath();
  ctx.arc(w * 0.82, h * 0.18, 56, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#7c2d12';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(w * 0.82 - 20, h * 0.18);
  ctx.lineTo(w * 0.82 + 20, h * 0.18);
  ctx.moveTo(w * 0.82, h * 0.18 - 20);
  ctx.lineTo(w * 0.82, h * 0.18 + 20);
  ctx.stroke();

  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  roundRect(ctx, 24, 24, w - 48, h - 48, 28);
  ctx.fill();
}

/**
 * 绘制战报海报。
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 * @param {InfluencePosterData} data
 * @returns {void}
 */
function drawInfluencePoster(ctx, width, height, data) {
  drawCartoonBackground(ctx, width, height);

  ctx.fillStyle = '#fef3c7';
  ctx.font = 'bold 22px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('🏀 网络影响力战报', width / 2, 72);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 28px sans-serif';
  const title = data.tournamentName || '精彩赛事';
  ctx.fillText(title.length > 14 ? title.slice(0, 14) + '…' : title, width / 2, 118);

  if (data.subtitle) {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = '14px sans-serif';
    ctx.fillText(data.subtitle, width / 2, 148);
  }

  const cardY = 180;
  const cardH = 280;
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  roundRect(ctx, 36, cardY, width - 72, cardH, 20);
  ctx.fill();

  const metrics = [
    { label: '全网总围观', value: String(data.totalViewersRecap || '—') },
    { label: '热度峰值在线', value: String(data.peakUserCount || '—') },
    { label: '影响力得分', value: String(data.influenceScore || '—') }
  ];

  metrics.forEach(function (m, idx) {
    const y = cardY + 56 + idx * 78;
    ctx.fillStyle = '#64748b';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(m.label, 64, y);
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 26px sans-serif';
    ctx.fillText(m.value, 64, y + 34);
  });

  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('高光记分 · 直播雷达护航', width / 2, height - 48);
  ctx.fillText('长按识别小程序码 · 围观更多精彩', width / 2, height - 28);
}

module.exports = {
  drawInfluencePoster
};
