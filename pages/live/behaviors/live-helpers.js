/**
 * 大表剩余秒格式化为 MM:SS。
 * @param {number} totalSec
 * @returns {string}
 */
function formatWxsMainText(totalSec) {
  var sec = Math.max(0, Math.floor(Number(totalSec) || 0));
  var m = Math.floor(sec / 60);
  var s = sec % 60;
  var ms = m < 10 ? '0' + m : '' + m;
  var ss = s < 10 ? '0' + s : '' + s;
  return ms + ':' + ss;
}

/** 足球下半场起始累计秒数（45:00） */
var FOOTBALL_HALF2_START_SEC = 45 * 60;
/** 足球加时赛起始累计秒数（90:00） */
var FOOTBALL_EXTRA_START_SEC = 90 * 60;

/** @const {object} 足球计时/补时默认状态 */
var DEFAULT_FOOTBALL_STATE = {
  clockPaused: true,
  clockWallMs: 0,
  extraMinutesHalf1: 0,
  extraMinutesHalf2: 0,
  extraMinutesExtra: 0,
  /** 2=三段场次模型（上/下/加时赛），用于与旧四段模型区分 */
  periodModel: 2
};

/**
 * 规范化足球计时状态。
 * @param {unknown} raw
 * @returns {{ clockPaused: boolean, clockWallMs: number, extraMinutesHalf1: number, extraMinutesHalf2: number, extraMinutesExtra: number }}
 */
function normalizeFootballState(raw) {
  var fs = raw && typeof raw === 'object' ? raw : {};
  var wallMs = Math.max(0, Math.floor(Number(fs.clockWallMs) || 0));
  var paused;
  if (fs.clockPaused === true) {
    paused = true;
  } else if (fs.clockPaused === false) {
    paused = false;
  } else {
    paused = wallMs <= 0;
  }
  return {
    clockPaused: paused,
    clockWallMs: wallMs,
    extraMinutesHalf1: Math.max(0, Math.floor(Number(fs.extraMinutesHalf1) || 0)),
    extraMinutesHalf2: Math.max(0, Math.floor(Number(fs.extraMinutesHalf2) || 0)),
    extraMinutesExtra: Math.max(0, Math.floor(Number(fs.extraMinutesExtra) || 0)),
    periodModel: Number(fs.periodModel) === 2 ? 2 : 0
  };
}

/**
 * 将旧版四段节次一次性迁移为 1=上 / 2=下 / 3=加时赛（仅 periodModel≠2 时调用）。
 * @param {number} period
 * @param {object} [mc] matchConfig，用于结合 elapsed 判断
 * @returns {number}
 */
function migrateLegacyFootballPeriod(period, mc) {
  var p = Math.floor(Number(period) || 1);
  var fs = normalizeFootballState(mc && mc.footballState);
  var elapsed = Math.max(0, Math.floor(Number(mc && mc.footballElapsedSec) || 0));
  if (p === 2) {
    if (fs.extraMinutesHalf1 > 0) return 1;
    if (elapsed >= FOOTBALL_HALF2_START_SEC) return 2;
    return 1;
  }
  if (p === 3 || p === 4) return 2;
  if (p >= 5) return 3;
  return Math.min(3, Math.max(1, p));
}

/**
 * 足球节次展示文案（场次名与补时分开展示）。
 * @param {number} period
 * @param {object} [footballState]
 * @returns {{ base: string, stoppage: string }}
 */
function getFootballHalfLabelParts(period, footballState) {
  var fs = normalizeFootballState(footballState);
  var p = Math.min(5, Math.max(1, Math.floor(Number(period) || 1)));
  var base = '上半场';
  var extra = 0;
  if (p === 1) {
    base = '上半场';
    extra = fs.extraMinutesHalf1;
  } else if (p === 2) {
    base = '下半场';
    extra = fs.extraMinutesHalf2;
  } else if (p === 3) {
    base = '加时赛';
    extra = fs.extraMinutesExtra;
  } else if (p === 4) {
    base = '热身';
    extra = 0;
  } else if (p === 5) {
    base = '中场休息';
    extra = 0;
  }
  return {
    base: base,
    stoppage: extra > 0 ? '+' + extra : ''
  };
}

/**
 * 足球节次完整文案（兼容旧引用）。
 * @param {number} period
 * @param {object} [footballState]
 * @returns {string}
 */
function getFootballHalfLabel(period, footballState) {
  var parts = getFootballHalfLabelParts(period, footballState);
  return parts.base + parts.stoppage;
}

/** @const {string} 篮球运动类型标识 */
var SPORT_BASKETBALL = 'basketball';
/** @const {string} 足球运动类型标识 */
var SPORT_FOOTBALL = 'football';
/** @const {string} 羽毛球运动类型标识 */
var SPORT_BADMINTON = 'badminton';

/**
 * 规范化运动类型字符串。
 * @param {unknown} raw
 * @returns {'basketball'|'football'|'badminton'}
 */
function normalizeSportType(raw) {
  var s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === SPORT_FOOTBALL || s === SPORT_BADMINTON) return s;
  return SPORT_BASKETBALL;
}

/** @const {object} 羽毛球默认状态机 */
var DEFAULT_BADMINTON_STATE = {
  servingTeam: 'A',
  servingZone: 'right',
  ruleType: 'single',
  maxSets: 3,
  pointsPerSet: 21,
  isScoreEnabled: true
};

/**
 * 判定羽毛球当前局是否结束。
 * @param {number} scoreA A 方小分
 * @param {number} scoreB B 方小分
 * @param {number} pointsPerSet 单局目标分（11 或 21）
 * @returns {'A'|'B'|null} 获胜方，未结束则 null
 */
function checkBadmintonSetWin(scoreA, scoreB, pointsPerSet) {
  var a = Math.max(0, Math.floor(Number(scoreA) || 0));
  var b = Math.max(0, Math.floor(Number(scoreB) || 0));
  var target = Math.max(1, Math.floor(Number(pointsPerSet) || 21));
  var cap = 30;
  if (a >= cap || b >= cap) {
    if (a > b) return 'A';
    if (b > a) return 'B';
    return null;
  }
  if (a >= target && a - b >= 2) return 'A';
  if (b >= target && b - a >= 2) return 'B';
  return null;
}

/**
 * 构建羽毛球历史局分展示列表。
 * @param {object} mc matchConfig
 * @returns {Array<{ label: string, scoreA: number, scoreB: number }>}
 */
function buildBadmintonSetHistoryDisplay(mc) {
  if (!mc || normalizeSportType(mc.sportType) !== SPORT_BADMINTON) return [];
  var subA = mc.teamA && Array.isArray(mc.teamA.subScores) ? mc.teamA.subScores : [];
  var subB = mc.teamB && Array.isArray(mc.teamB.subScores) ? mc.teamB.subScores : [];
  var len = Math.max(subA.length, subB.length);
  var rows = [];
  var labels = ['一', '二', '三', '四', '五'];
  for (var i = 0; i < len; i++) {
    rows.push({
      label: '第' + (labels[i] || String(i + 1)) + '局',
      scoreA: typeof subA[i] === 'number' ? subA[i] : 0,
      scoreB: typeof subB[i] === 'number' ? subB[i] : 0
    });
  }
  return rows;
}

/**
 * 根据时钟束与墙钟计算大表 / 24 秒当前显示值。
 * @param {object | null} bundle
 * @param {string} [sportType] 运动类型
 * @returns {{ mainText: string, shotSec: number, shotWarn: boolean }}
 */
function computeClockDisplayFromBundle(bundle, sportType) {
  if (!bundle || typeof bundle !== 'object') {
    return { mainText: '00:00', shotSec: 24, shotWarn: false };
  }
  var sport = normalizeSportType(sportType);
  if (sport === SPORT_BADMINTON) {
    return { mainText: '', shotSec: 0, shotWarn: false };
  }
  var nowMs = Date.now();
  var mainBase = Math.max(0, Math.floor(Number(bundle.mainBaseSec) || 0));
  var shotBase = Math.max(0, Math.floor(Number(bundle.shotBaseSec) || 24));
  var mainAnchor = Number(bundle.mainAnchorMs) || nowMs;
  var shotAnchor = Number(bundle.shotAnchorMs) || nowMs;
  var running = !!bundle.mainRunning;
  var elapsedSec = running ? Math.floor((nowMs - mainAnchor) / 1000) : 0;
  var mainSec = mainBase;
  var shotSec = shotBase;
  if (running) {
    if (sport === SPORT_FOOTBALL) {
      mainSec = mainBase + elapsedSec;
    } else {
      mainSec = Math.max(0, mainBase - elapsedSec);
      shotSec = Math.max(0, shotBase - Math.floor((nowMs - shotAnchor) / 1000));
    }
  }
  return {
    mainText: formatWxsMainText(mainSec),
    shotSec: sport === SPORT_FOOTBALL ? 0 : shotSec,
    shotWarn: sport !== SPORT_FOOTBALL && shotSec > 0 && shotSec <= 5
  };
}

module.exports = {
  formatWxsMainText,
  FOOTBALL_HALF2_START_SEC,
  FOOTBALL_EXTRA_START_SEC,
  DEFAULT_FOOTBALL_STATE,
  normalizeFootballState,
  migrateLegacyFootballPeriod,
  getFootballHalfLabelParts,
  getFootballHalfLabel,
  SPORT_BASKETBALL,
  SPORT_FOOTBALL,
  SPORT_BADMINTON,
  normalizeSportType,
  DEFAULT_BADMINTON_STATE,
  checkBadmintonSetWin,
  buildBadmintonSetHistoryDisplay,
  computeClockDisplayFromBundle
};
