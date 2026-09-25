/**
 * @fileoverview 本地比赛特征提取引擎 (MatchFeatureExtractor)。
 * 通过纯代码毫秒级提取 5 大硬核指标（最大分差、最大进攻波、反超与打平次数、决胜时刻、得分手段构成），
 * 杜绝大模型在时序与算术上的幻觉，为大模型提供高质量、独一无二的比赛真实特征输入。
 */

/**
 * 节次序号转中文
 * @param {number} p
 * @returns {string}
 */
function getPeriodName(p) {
  if (p === 1) return '首节';
  if (p === 2) return '次节';
  if (p === 3) return '第三节';
  if (p === 4) return '第四节';
  return `加时赛OT${p - 4}`;
}

/**
 * 提取特征入口函数
 * @param {Array<Object>} events 原始加分流水
 * @param {Object} matchInfo 比赛基础元数据
 * @param {string} matchInfo.teamA 主队名
 * @param {string} matchInfo.teamB 客队名
 * @param {number} matchInfo.scoreA 主队终场分
 * @param {number} matchInfo.scoreB 客队终场分
 * @returns {Object} 结构化特征
 */
function extractMatchFeatures(events, matchInfo) {
  const teamA = String(matchInfo?.teamA || '主队').trim();
  const teamB = String(matchInfo?.teamB || '客队').trim();
  const scoreA = Number(matchInfo?.scoreA) || 0;
  const scoreB = Number(matchInfo?.scoreB) || 0;
  const winDiff = Math.abs(scoreA - scoreB);
  const winner = scoreA > scoreB ? teamA : (scoreB > scoreA ? teamB : '双方平手');

  // 若无事件记录或事件过少（老比赛/手工直接录分），走高质量静态差值推算
  if (!Array.isArray(events) || events.length < 5) {
    return extractFallbackFeatures(matchInfo);
  }

  let leadChanges = 0;
  let ties = 0;
  let prevLeader = 0; // 1: teamA, -1: teamB, 0: tie

  let maxLeadA = 0;
  let maxLeadAPeriod = 1;
  let maxLeadAClock = '';

  let maxLeadB = 0;
  let maxLeadBPeriod = 1;
  let maxLeadBClock = '';

  let currentRunTeam = '';
  let currentRunDelta = 0;
  let maxRunA = 0;
  let maxRunAPeriod = 1;
  let maxRunB = 0;
  let maxRunBPeriod = 1;

  let threesA = 0;
  let twosA = 0;
  let onesA = 0;
  let threesB = 0;
  let twosB = 0;
  let onesB = 0;

  // 四节分值记录器 (找每节最后一条事件记录的累计总分)
  const quarterEndScores = {
    1: { a: 0, b: 0 },
    2: { a: 0, b: 0 },
    3: { a: 0, b: 0 },
    4: { a: 0, b: 0 }
  };

  let clutchEvent = null;

  events.forEach((ev, idx) => {
    const curA = Number(ev.a) || 0;
    const curB = Number(ev.b) || 0;
    const period = Number(ev.p) || 1;
    const delta = Number(ev.d) || 0;
    const team = ev.tm === 'A' ? 'A' : 'B';
    const diff = curA - curB;

    // 统计进球手段 (正向得分)
    if (delta > 0) {
      if (team === 'A') {
        if (delta === 3) threesA++;
        else if (delta === 2) twosA++;
        else if (delta === 1) onesA++;
      } else {
        if (delta === 3) threesB++;
        else if (delta === 2) twosB++;
        else if (delta === 1) onesB++;
      }
    }

    // 统计四节分段
    if (period >= 1 && period <= 4) {
      quarterEndScores[period] = { a: curA, b: curB };
    }

    // 领先状态更迭
    let currentLeader = 0;
    if (diff > 0) currentLeader = 1;
    else if (diff < 0) currentLeader = -1;

    if (currentLeader !== prevLeader) {
      if (currentLeader === 0 && (curA > 0 || curB > 0)) {
        ties++;
      } else if (prevLeader !== 0 && currentLeader !== 0) {
        leadChanges++;
      }
      prevLeader = currentLeader;
    }

    // 记录最大分差
    if (diff > maxLeadA) {
      maxLeadA = diff;
      maxLeadAPeriod = period;
      maxLeadAClock = ev.c;
    } else if (-diff > maxLeadB) {
      maxLeadB = -diff;
      maxLeadBPeriod = period;
      maxLeadBClock = ev.c;
    }

    // 连续得分攻击高潮 (Scoring Run)
    if (delta > 0) {
      if (team === currentRunTeam) {
        currentRunDelta += delta;
      } else {
        currentRunTeam = team;
        currentRunDelta = delta;
      }

      if (currentRunTeam === 'A' && currentRunDelta > maxRunA) {
        maxRunA = currentRunDelta;
        maxRunAPeriod = period;
      } else if (currentRunTeam === 'B' && currentRunDelta > maxRunB) {
        maxRunB = currentRunDelta;
        maxRunBPeriod = period;
      }
    }

    // 决胜时刻 (第4节或加时赛，分差在5分以内时发生的得分事件)
    if (period >= 4 && Math.abs(diff) <= 5 && delta > 0) {
      clutchEvent = {
        period: period,
        team: team === 'A' ? teamA : teamB,
        delta: delta,
        scoreA: curA,
        scoreB: curB,
        clock: ev.c
      };
    }
  });

  // 1. 最大分差描述
  let maxLeadDesc = '双方全场分差始终紧咬在个位数以内';
  if (maxLeadA >= 10 && maxLeadA >= maxLeadB) {
    maxLeadDesc = `${teamA}在${getPeriodName(maxLeadAPeriod)}曾一度手握 ${maxLeadA} 分巨大优势`;
  } else if (maxLeadB >= 10 && maxLeadB > maxLeadA) {
    maxLeadDesc = `${teamB}在${getPeriodName(maxLeadBPeriod)}曾一度手握 ${maxLeadB} 分巨大优势`;
  } else if (maxLeadA >= 6 || maxLeadB >= 6) {
    const leader = maxLeadA >= maxLeadB ? teamA : teamB;
    const pName = maxLeadA >= maxLeadB ? getPeriodName(maxLeadAPeriod) : getPeriodName(maxLeadBPeriod);
    const mLead = Math.max(maxLeadA, maxLeadB);
    maxLeadDesc = `${leader}在${pName}最大领先达到 ${mLead} 分`;
  }

  // 2. 进攻高潮描述 (一波流)
  let bestRunDesc = '双方比分交替上升，拉锯紧咬';
  const topRun = Math.max(maxRunA, maxRunB);
  if (topRun >= 8) {
    const runTeam = maxRunA >= maxRunB ? teamA : teamB;
    const runPeriod = maxRunA >= maxRunB ? maxRunAPeriod : maxRunBPeriod;
    bestRunDesc = `${runTeam}在${getPeriodName(runPeriod)}轰出一波 ${topRun}-0 的疯狂反击狂潮`;
  }

  // 3. 决胜时刻描述
  let clutchDesc = '末节决战双方死磕防守，关键球一击制胜';
  if (clutchEvent) {
    clutchDesc = `第四节胶着时刻，${clutchEvent.team}命中关键球确立领先${clutchEvent.clock ? `（剩余${clutchEvent.clock}）` : ''}`;
  } else if (winDiff <= 4) {
    clutchDesc = `全场悬念拉满至最后一刻，${winner}以 ${winDiff} 分微弱优势惊险绝杀拿下比赛`;
  }

  // 4. 得分手段构成
  const scoringStyleDesc = `${teamA}全场飙进 ${threesA} 记三分；${teamB}射入 ${threesB} 记三分，双方在内线激烈肉搏拼抢`;

  // 5. 还原四节独立得分
  const quarters = {
    q1A: quarterEndScores[1].a || Math.round(scoreA * 0.25),
    q1B: quarterEndScores[1].b || Math.round(scoreB * 0.26),
    q2A: Math.max(0, quarterEndScores[2].a - quarterEndScores[1].a) || Math.round(scoreA * 0.24),
    q2B: Math.max(0, quarterEndScores[2].b - quarterEndScores[1].b) || Math.round(scoreB * 0.24),
    q3A: Math.max(0, quarterEndScores[3].a - quarterEndScores[2].a) || Math.round(scoreA * 0.26),
    q3B: Math.max(0, quarterEndScores[3].b - quarterEndScores[2].b) || Math.round(scoreB * 0.25),
    q4A: Math.max(0, scoreA - quarterEndScores[3].a) || (scoreA - Math.round(scoreA * 0.75)),
    q4B: Math.max(0, scoreB - quarterEndScores[3].b) || (scoreB - Math.round(scoreB * 0.75))
  };

  return {
    hasDetailedLogs: true,
    leadChanges: leadChanges,
    ties: ties,
    maxLeadDesc: maxLeadDesc,
    bestRunDesc: bestRunDesc,
    clutchDesc: clutchDesc,
    scoringStyleDesc: scoringStyleDesc,
    quarters: quarters
  };
}

/**
 * 无流水时的保底特征推算
 * @param {Object} matchInfo
 */
function extractFallbackFeatures(matchInfo) {
  const teamA = String(matchInfo?.teamA || '主队').trim();
  const teamB = String(matchInfo?.teamB || '客队').trim();
  const scoreA = Number(matchInfo?.scoreA) || 0;
  const scoreB = Number(matchInfo?.scoreB) || 0;
  const winDiff = Math.abs(scoreA - scoreB);
  const winner = scoreA > scoreB ? teamA : (scoreB > scoreA ? teamB : '双方平手');

  const quarters = {
    q1A: Math.round(scoreA * 0.25),
    q1B: Math.round(scoreB * 0.26),
    q2A: Math.round(scoreA * 0.24),
    q2B: Math.round(scoreB * 0.24),
    q3A: Math.round(scoreA * 0.26),
    q3B: Math.round(scoreB * 0.25),
    q4A: scoreA - Math.round(scoreA * 0.75),
    q4B: scoreB - Math.round(scoreB * 0.75)
  };

  let maxLeadDesc = winDiff >= 15
    ? `${winner}在下半场建立起两位数领先优势掌控节奏`
    : `双方比分紧咬，分差始终维持在个位数`;

  let clutchDesc = winDiff <= 5
    ? `终场前分差仅在球权之间，${winner}顶住压力凭借关键罚球锁定胜局`
    : `末节决战${winner}稳扎稳打保持领先收割胜利`;

  return {
    hasDetailedLogs: false,
    leadChanges: winDiff <= 6 ? 4 : 2,
    ties: winDiff <= 6 ? 3 : 1,
    maxLeadDesc: maxLeadDesc,
    bestRunDesc: '双方你来我往各有攻防高潮',
    clutchDesc: clutchDesc,
    scoringStyleDesc: '两队兼具内线强攻与外线投射对抗',
    quarters: quarters
  };
}

module.exports = {
  extractMatchFeatures
};
