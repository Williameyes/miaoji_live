/**
 * @fileoverview 雷达 OAM 日期/时间格式化（对齐记分页 picker 逻辑）。
 */

/**
 * 补零到两位。
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * 毫秒时间戳 → YYYY-MM-DD。
 * @param {number} ts
 * @returns {string}
 */
function timestampToDateStr(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  return y + '-' + m + '-' + day;
}

/**
 * 毫秒时间戳 → HH:mm。
 * @param {number} ts
 * @returns {string}
 */
function timestampToTimeStr(ts) {
  const d = new Date(ts);
  const h = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  return h + ':' + mi;
}

/**
 * 日期 + 时间 → 接口要求的 `YYYY-MM-DD HH:mm:ss`。
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} timeStr HH:mm 或 HH:mm:ss
 * @returns {string}
 */
function combineDateTimeToStartTime(dateStr, timeStr) {
  const dp = (dateStr || '').split('-');
  const tp = (timeStr || '00:00').split(':');
  const y = parseInt(dp[0], 10);
  const mo = parseInt(dp[1], 10);
  const d = parseInt(dp[2], 10);
  const h = parseInt(tp[0], 10);
  const mi = parseInt(tp[1], 10);
  const safeY = Number.isFinite(y) ? y : 1970;
  const safeMo = Number.isFinite(mo) && mo >= 1 ? mo : 1;
  const safeD = Number.isFinite(d) && d >= 1 ? d : 1;
  const safeH = Number.isFinite(h) ? h : 0;
  const safeMi = Number.isFinite(mi) ? mi : 0;
  return (
    safeY +
    '-' +
    pad2(safeMo) +
    '-' +
    pad2(safeD) +
    ' ' +
    pad2(safeH) +
    ':' +
    pad2(safeMi) +
    ':00'
  );
}

/**
 * 将任意接口时间字段规范为 picker 可用的日期、时间。
 * 支持：`YYYY-MM-DD HH:mm:ss`、ISO（含 T / Z）、毫秒时间戳。
 * @param {string | number} startTime
 * @returns {{ dateStr: string, timeStr: string }}
 */
function parseStartTimeToParts(startTime) {
  if (startTime == null || startTime === '') {
    const now = Date.now();
    return {
      dateStr: timestampToDateStr(now),
      timeStr: timestampToTimeStr(now)
    };
  }

  if (typeof startTime === 'number' && Number.isFinite(startTime)) {
    const ts = startTime < 1e12 ? startTime * 1000 : startTime;
    return {
      dateStr: timestampToDateStr(ts),
      timeStr: timestampToTimeStr(ts)
    };
  }

  const raw = String(startTime).trim();
  if (!raw) {
    const now = Date.now();
    return {
      dateStr: timestampToDateStr(now),
      timeStr: timestampToTimeStr(now)
    };
  }

  // 纯数字时间戳字符串
  if (/^\d{10,13}$/.test(raw)) {
    const num = Number(raw);
    const ts = raw.length <= 10 ? num * 1000 : num;
    return {
      dateStr: timestampToDateStr(ts),
      timeStr: timestampToTimeStr(ts)
    };
  }

  // ISO：2026-07-04T19:00:00.000Z / 2026-07-04T19:00:00+08:00
  if (raw.indexOf('T') >= 0) {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) {
      return {
        dateStr: timestampToDateStr(ms),
        timeStr: timestampToTimeStr(ms)
      };
    }
  }

  // 常规：YYYY-MM-DD HH:mm[:ss] 或 YYYY-MM-DD
  const normalized = raw.replace('T', ' ').replace(/Z$/i, '');
  const parts = normalized.split(/\s+/);
  const dateStr = parts[0] || timestampToDateStr(Date.now());
  const timePart = parts[1] || '00:00:00';
  const tp = timePart.split(':');
  const timeStr = pad2(parseInt(tp[0], 10) || 0) + ':' + pad2(parseInt(tp[1], 10) || 0);
  return { dateStr: dateStr.slice(0, 10), timeStr: timeStr };
}

/**
 * 格式化展示用时间文案。
 * @param {string | number} startTime
 * @returns {string}
 */
function formatStartTimeDisplay(startTime) {
  const p = parseStartTimeToParts(startTime);
  return p.dateStr + ' ' + p.timeStr;
}

module.exports = {
  timestampToDateStr,
  timestampToTimeStr,
  combineDateTimeToStartTime,
  parseStartTimeToParts,
  formatStartTimeDisplay
};
