/**
 * @fileoverview 雷达 OAM 日期/时间格式化（对齐记分页 picker 逻辑）。
 */

/**
 * 毫秒时间戳 → YYYY-MM-DD。
 * @param {number} ts
 * @returns {string}
 */
function timestampToDateStr(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

/**
 * 毫秒时间戳 → HH:mm。
 * @param {number} ts
 * @returns {string}
 */
function timestampToTimeStr(ts) {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return h + ':' + mi;
}

/**
 * 日期 + 时间 → 接口要求的 `YYYY-MM-DD HH:mm:ss`。
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} timeStr HH:mm
 * @returns {string}
 */
function combineDateTimeToStartTime(dateStr, timeStr) {
  const dp = (dateStr || '').split('-');
  const tp = (timeStr || '00:00').split(':');
  const y = parseInt(dp[0], 10) || 1970;
  const mo = parseInt(dp[1], 10) || 1;
  const d = parseInt(dp[2], 10) || 1;
  const h = parseInt(tp[0], 10) || 0;
  const mi = parseInt(tp[1], 10) || 0;
  const pad = function (n) {
    return n < 10 ? '0' + n : String(n);
  };
  return (
    y +
    '-' +
    pad(mo) +
    '-' +
    pad(d) +
    ' ' +
    pad(h) +
    ':' +
    pad(mi) +
    ':00'
  );
}

/**
 * 解析接口 start_time 为 picker 用的日期、时间。
 * @param {string} startTime
 * @returns {{ dateStr: string, timeStr: string }}
 */
function parseStartTimeToParts(startTime) {
  const raw = (startTime || '').trim();
  if (!raw) {
    const now = Date.now();
    return {
      dateStr: timestampToDateStr(now),
      timeStr: timestampToTimeStr(now)
    };
  }
  const parts = raw.split(' ');
  const dateStr = parts[0] || timestampToDateStr(Date.now());
  const timePart = parts[1] || '19:00:00';
  const tp = timePart.split(':');
  const timeStr = (tp[0] || '19') + ':' + (tp[1] || '00');
  return { dateStr: dateStr, timeStr: timeStr };
}

/**
 * 格式化展示用时间文案。
 * @param {string} startTime
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
