/**
 * @fileoverview 固定模板与 AI 生成 Excel/CSV 解析：支持 阶段 | 队伍A | 队伍B | 比赛时间 | 比赛场地 | 主队比分 | 客队比分。
 */

const XLSX = require('./vendor/xlsx.mini.min.js');

/**
 * @typedef {Object} ParsedMatchRow
 * @property {string} team_a
 * @property {string} team_b
 * @property {string} start_time
 * @property {string} [stage_id]
 * @property {string} [venue]
 * @property {number} [score_a]
 * @property {number} [score_b]
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
 * @returns {{ headerRow: number, colA: number, colB: number, colTime: number, colStage: number, colVenue: number, colScoreA: number, colScoreB: number } | null}
 */
function locateTemplateColumns(rows) {
  const aliasesA = ['队伍a', '队伍A', '主队', 'team_a', 'teama'];
  const aliasesB = ['队伍b', '队伍B', '客队', 'team_b', 'teamb'];
  const aliasesT = ['比赛时间', '开赛时间', 'start_time', '时间'];
  const aliasesStage = ['阶段', '分组', 'stage_id', 'stageid', 'stage'];
  const aliasesVenue = ['比赛场地', '场地', '球场', '场馆', 'venue', 'location'];
  const aliasesScoreA = ['主队比分', '队伍a比分', 'score_a', 'scorea'];
  const aliasesScoreB = ['客队比分', '队伍b比分', 'score_b', 'scoreb'];

  for (let r = 0; r < Math.min(rows.length, 8); r += 1) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    let colA = -1;
    let colB = -1;
    let colTime = -1;
    let colStage = -1;
    let colVenue = -1;
    let colScoreA = -1;
    let colScoreB = -1;

    for (let c = 0; c < row.length; c += 1) {
      const h = normalizeHeader(row[c]).toLowerCase();
      if (aliasesA.some(a => h === a.toLowerCase())) colA = c;
      if (aliasesB.some(b => h === b.toLowerCase())) colB = c;
      if (aliasesT.some(t => h === t.toLowerCase())) colTime = c;
      if (aliasesStage.some(s => h === s.toLowerCase())) colStage = c;
      if (aliasesVenue.some(v => h === v.toLowerCase())) colVenue = c;
      if (aliasesScoreA.some(sa => h === sa.toLowerCase())) colScoreA = c;
      if (aliasesScoreB.some(sb => h === sb.toLowerCase())) colScoreB = c;
    }
    if (colA >= 0 && colB >= 0 && colTime >= 0) {
      return {
        headerRow: r,
        colA: colA,
        colB: colB,
        colTime: colTime,
        colStage: colStage,
        colVenue: colVenue,
        colScoreA: colScoreA,
        colScoreB: colScoreB
      };
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
 * 从解析后的 rows 和 loc 提取 Match 数据
 * @param {unknown[][]} rows
 * @param {ReturnType<typeof locateTemplateColumns>} loc
 * @returns {ParsedMatchRow[]}
 */
function extractMatchesFromRows(rows, loc) {
  if (!loc) throw new Error('未找到「队伍A / 队伍B / 比赛时间」表头');
  const result = [];
  for (let r = loc.headerRow + 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    const teamA = String(row[loc.colA] == null ? '' : row[loc.colA]).trim();
    const teamB = String(row[loc.colB] == null ? '' : row[loc.colB]).trim();
    const startTime = formatStartTime(row[loc.colTime]);
    if (!teamA && !teamB) continue;
    if (!teamA || !teamB || !startTime) {
      throw new Error('第 ' + (r + 1) + ' 行数据不完整（需包含队伍A、队伍B和比赛时间）');
    }

    const item = { team_a: teamA, team_b: teamB, start_time: startTime };

    if (loc.colStage >= 0 && row[loc.colStage] != null && String(row[loc.colStage]).trim()) {
      item.stage_id = String(row[loc.colStage]).trim();
    }
    if (loc.colVenue >= 0 && row[loc.colVenue] != null && String(row[loc.colVenue]).trim()) {
      item.venue = String(row[loc.colVenue]).trim();
    }
    if (loc.colScoreA >= 0 && row[loc.colScoreA] != null && String(row[loc.colScoreA]).trim() !== '') {
      const sA = Number(row[loc.colScoreA]);
      if (!isNaN(sA)) item.score_a = sA;
    }
    if (loc.colScoreB >= 0 && row[loc.colScoreB] != null && String(row[loc.colScoreB]).trim() !== '') {
      const sB = Number(row[loc.colScoreB]);
      if (!isNaN(sB)) item.score_b = sB;
    }

    result.push(item);
  }
  if (!result.length) {
    throw new Error('未解析到有效场次行');
  }
  return result;
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
  return extractMatchesFromRows(rows, loc);
}

/**
 * 直接解析大模型输出的文本/CSV 文本为场次行数组
 * @param {string} text
 * @returns {ParsedMatchRow[]}
 */
function parseMatchCsvText(text) {
  if (!text || !text.trim()) {
    throw new Error('内容为空');
  }
  // 清理 LLM markdown 代码块标识 ```csv ... ```
  let cleanText = text.replace(/```csv/gi, '').replace(/```/g, '').trim();
  const workbook = XLSX.read(cleanText, { type: 'string' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('文本无法识别为有效表格/CSV');
  }
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const loc = locateTemplateColumns(rows);
  return extractMatchesFromRows(rows, loc);
}

module.exports = {
  parseMatchExcelBuffer,
  parseMatchCsvText
};
