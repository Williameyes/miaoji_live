/**
 * @fileoverview 固定模板 Excel/CSV 解析：队伍A | 队伍B | 比赛时间。
 */

const XLSX = require('./vendor/xlsx.mini.min.js');

/**
 * @typedef {Object} ParsedMatchRow
 * @property {string} team_a
 * @property {string} team_b
 * @property {string} start_time
 */

/**
 * 规范化表头单元格。
 * @param {unknown} cell
 * @returns {string}
 */
function normalizeHeader(cell) {
  return String(cell == null ? '' : cell)
    .replace(/\s+/g, '')
    .trim();
}

/**
 * 从二维数组中定位表头行与列索引。
 * @param {unknown[][]} rows
 * @returns {{ headerRow: number, colA: number, colB: number, colTime: number } | null}
 */
function locateTemplateColumns(rows) {
  const aliasesA = ['队伍a', '队伍A', '主队', 'team_a', 'teama'];
  const aliasesB = ['队伍b', '队伍B', '客队', 'team_b', 'teamb'];
  const aliasesT = ['比赛时间', '开赛时间', 'start_time', '时间'];

  for (let r = 0; r < Math.min(rows.length, 8); r += 1) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    let colA = -1;
    let colB = -1;
    let colTime = -1;
    for (let c = 0; c < row.length; c += 1) {
      const h = normalizeHeader(row[c]).toLowerCase();
      if (aliasesA.some(function (a) {
        return h === a.toLowerCase();
      })) {
        colA = c;
      }
      if (aliasesB.some(function (b) {
        return h === b.toLowerCase();
      })) {
        colB = c;
      }
      if (aliasesT.some(function (t) {
        return h === t.toLowerCase();
      })) {
        colTime = c;
      }
    }
    if (colA >= 0 && colB >= 0 && colTime >= 0) {
      return { headerRow: r, colA: colA, colB: colB, colTime: colTime };
    }
  }
  return null;
}

/**
 * Excel 序列号或字符串转为 `YYYY-MM-DD HH:mm:ss`。
 * @param {unknown} raw
 * @returns {string}
 */
function formatStartTime(raw) {
  if (raw == null || raw === '') return '';
  if (typeof raw === 'number' && XLSX && XLSX.SSF && typeof XLSX.SSF.format === 'function') {
    const d = XLSX.SSF.parse_date_code(raw);
    if (d) {
      const pad = function (n) {
        return n < 10 ? '0' + n : String(n);
      };
      return (
        d.y +
        '-' +
        pad(d.m) +
        '-' +
        pad(d.d) +
        ' ' +
        pad(d.H) +
        ':' +
        pad(d.M) +
        ':' +
        pad(d.S)
      );
    }
  }
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.length >= 19 ? s.slice(0, 19) : s + ':00'.slice(0, 19 - s.length);
  }
  return s;
}

/**
 * 解析 ArrayBuffer 为场次行数组。
 * @param {ArrayBuffer} buffer
 * @param {string} [fileName]
 * @returns {ParsedMatchRow[]}
 */
function parseMatchExcelBuffer(buffer, fileName) {
  const name = (fileName || '').toLowerCase();
  let workbook;
  if (name.endsWith('.csv')) {
    const text = String.fromCharCode.apply(null, new Uint8Array(buffer));
    workbook = XLSX.read(text, { type: 'string' });
  } else {
    workbook = XLSX.read(buffer, { type: 'array' });
  }
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('表格为空');
  }
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const loc = locateTemplateColumns(rows);
  if (!loc) {
    throw new Error('未找到「队伍A / 队伍B / 比赛时间」表头');
  }
  const result = [];
  for (let r = loc.headerRow + 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    const teamA = String(row[loc.colA] == null ? '' : row[loc.colA]).trim();
    const teamB = String(row[loc.colB] == null ? '' : row[loc.colB]).trim();
    const startTime = formatStartTime(row[loc.colTime]);
    if (!teamA && !teamB) continue;
    if (!teamA || !teamB || !startTime) {
      throw new Error('第 ' + (r + 1) + ' 行数据不完整');
    }
    result.push({ team_a: teamA, team_b: teamB, start_time: startTime });
  }
  if (!result.length) {
    throw new Error('未解析到有效场次行');
  }
  return result;
}

module.exports = {
  parseMatchExcelBuffer
};
