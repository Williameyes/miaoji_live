/**
 * @fileoverview 赛事战报推文生成与持久化存储服务。
 * 结合硅基流动平台 (SiliconFlow) 大模型 (DeepSeek-V3 / Qwen2.5) 与分节比分、胜负差、高光切片，
 * 生成符合微信公众号排版规范的精美富文本与纯文本战报，并持久化到服务端 MySQL 数据库与本地缓存。
 */

const { fetchBackendMatchReport, generateBackendMatchReport } = require('../services/match-report-api.js');
const { getScoreEvents } = require('./score-events-storage.js');
const { extractMatchFeatures } = require('./match-feature-extractor.js');

const STORAGE_KEY_REPORTS = 'MIAOXIE_MATCH_REPORTS';
const STORAGE_KEY_MATCHES = 'MIAOXIE_MATCHES';
const STORAGE_KEY_CLIPS = 'MIAOXIE_CLIPS';

/**
 * 读取已保存的战报映射表（本地一级缓存）。
 * @returns {Record<string, unknown>}
 */
function getCachedReportsMap() {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY_REPORTS);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return raw;
    }
  } catch (e) {}
  return {};
}

/**
 * 获取指定场次的已存战报（本地缓存）。
 * @param {string|number} matchId
 * @returns {Record<string, unknown>|null}
 */
function getCachedReportByMatchId(matchId) {
  if (!matchId) return null;
  const map = getCachedReportsMap();
  return map[String(matchId)] || null;
}

/**
 * 缓存指定场次的战报到本地。
 * @param {string|number} matchId
 * @param {Record<string, unknown>} report
 */
function saveReportToCache(matchId, report) {
  if (!matchId || !report) return;
  const map = getCachedReportsMap();
  map[String(matchId)] = Object.assign({}, report, {
    updatedAt: Date.now()
  });
  try {
    wx.setStorageSync(STORAGE_KEY_REPORTS, map);
  } catch (e) {}
}

/**
 * 优先从本地缓存、次从服务端数据库拉取已持久化的战报
 * @param {string|number} matchId
 * @returns {Promise<Record<string, unknown>|null>}
 */
function fetchSavedMatchReport(matchId) {
  if (!matchId) return Promise.resolve(null);

  // 1. 本地缓存命中
  const localCached = getCachedReportByMatchId(matchId);
  if (localCached) {
    return Promise.resolve(localCached);
  }

  // 2. 从服务端数据库查询
  return fetchBackendMatchReport(matchId)
    .then((res) => {
      if (res && res.exists && res.report) {
        const report = normalizeDbReport(res.report);
        saveReportToCache(matchId, report);
        return report;
      }
      return null;
    })
    .catch(() => null);
}

/**
 * 将服务端 match_reports 记录字段标准化为前端组件格式
 * @param {Object} raw
 * @returns {Object}
 */
function normalizeDbReport(raw) {
  if (!raw) return null;
  const subTitles = Array.isArray(raw.sub_titles)
    ? raw.sub_titles
    : (typeof raw.sub_titles === 'string' ? JSON.parse(raw.sub_titles || '[]') : []);

  const alternativeTitles = [raw.title];
  subTitles.forEach((t) => {
    if (t && !alternativeTitles.includes(t)) alternativeTitles.push(t);
  });

  let stats = null;
  if (raw.structured_stats) {
    if (typeof raw.structured_stats === 'string') {
      try { stats = JSON.parse(raw.structured_stats); } catch (e) { stats = {}; }
    } else {
      stats = raw.structured_stats;
    }
  }

  const douyinScript = raw.douyin_script || stats?.douyin_script || '';
  const wechatReport = raw.wechat_report || stats?.wechat_report || raw.content_markdown || '';

  return {
    matchId: raw.match_id,
    title: raw.title,
    alternativeTitles: alternativeTitles,
    summary: raw.summary || '',
    mvpTake: raw.mvp_take || '',
    turningPoint: raw.turning_point || '',
    quarterCommentary: raw.quarter_commentary || null,
    douyinScript: douyinScript,
    wechatReport: wechatReport,
    contentHtml: raw.content_html || '',
    contentPlainText: wechatReport || raw.content_markdown || '',
    userNote: raw.user_note || '',
    modelName: raw.model_name || 'Qwen/Qwen2.5-7B-Instruct',
    structuredStats: stats,
    createdAt: raw.created_at,
    isAiGenerated: true,
    isPersistent: true
  };
}

/**
 * 从本地 MIAOXIE_MATCHES 中查找匹配的场次配置（提取更详细的分节与高光数据）。
 * @param {string|number} matchId
 * @param {string} [teamA]
 * @param {string} [teamB]
 * @returns {Record<string, unknown>|null}
 */
function findLocalMatchDetails(matchId, teamA, teamB) {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY_MATCHES);
    if (!Array.isArray(raw)) return null;

    if (matchId) {
      const found = raw.find((m) => m && String(m.id) === String(matchId));
      if (found) return found;
    }

    if (teamA && teamB) {
      const tA = String(teamA).trim();
      const tB = String(teamB).trim();
      const found = raw.find((m) => {
        if (!m || !m.teamA || !m.teamB) return false;
        const nameA = String(m.teamA.name || '').trim();
        const nameB = String(m.teamB.name || '').trim();
        return (nameA === tA && nameB === tB) || (nameA === tB && nameB === tA);
      });
      if (found) return found;
    }
  } catch (e) {}
  return null;
}

/**
 * 获取该场次的高光切片列表。
 * @param {string|number} matchId
 * @returns {Array<{ id: string, title?: string, time?: string }>}
 */
function getMatchClips(matchId) {
  if (!matchId) return [];
  try {
    const map = wx.getStorageSync(STORAGE_KEY_CLIPS) || {};
    const list = map[String(matchId)] || [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

/**
 * 组装符合微信公众号内联样式的富文本 HTML
 */
function formatWechatHtmlFromAi(data) {
  const winner = data.scoreA > data.scoreB ? data.teamA : (data.scoreB > data.scoreA ? data.teamB : '平局');
  const winDiff = Math.abs(data.scoreA - data.scoreB);
  const quarters = data.quarters || { q1A: 0, q1B: 0, q2A: 0, q2B: 0, q3A: 0, q3B: 0, q4A: 0, q4B: 0 };
  const qc = data.quarterCommentary || {};

  return `<section style="font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', STHeiti, sans-serif; font-size: 15px; color: #2b2b2b; line-height: 1.8; max-width: 677px; margin: 0 auto; padding: 12px 10px; box-sizing: border-box;">
  <!-- 头部比赛大卡片 -->
  <section style="background: linear-gradient(135deg, #0d1b2a 0%, #1b263b 60%, #415a77 100%); border-radius: 12px; padding: 22px 16px; color: #ffffff; text-align: center; box-shadow: 0 8px 24px rgba(13,27,42,0.18); margin-bottom: 24px;">
    <p style="margin: 0 0 10px 0; font-size: 13px; letter-spacing: 1px; color: #e0e1dd; opacity: 0.85;">
      ${data.tournamentName || '高光记分篮球赛事'} · ${data.matchDate || '全场战报'}
    </p>
    <div style="display: flex; align-items: center; justify-content: space-around; margin: 16px 0;">
      <div style="flex: 1; text-align: center;">
        <h3 style="margin: 0; font-size: 18px; font-weight: 700; color: #ffffff;">${data.teamA}</h3>
      </div>
      <div style="padding: 0 14px; text-align: center;">
        <div style="font-size: 34px; font-weight: 900; letter-spacing: 2px; color: #ffb703; text-shadow: 0 2px 8px rgba(255,183,3,0.3);">
          ${data.scoreA} : ${data.scoreB}
        </div>
        <span style="display: inline-block; font-size: 11px; background: rgba(255,255,255,0.18); padding: 2px 8px; border-radius: 10px; margin-top: 4px; color: #f8f9fa;">FINAL</span>
      </div>
      <div style="flex: 1; text-align: center;">
        <h3 style="margin: 0; font-size: 18px; font-weight: 700; color: #ffffff;">${data.teamB}</h3>
      </div>
    </div>
    <div style="margin-top: 10px; font-size: 13px; color: #ffd166; font-weight: 500;">
      🏆 ${winner} 净胜 ${winDiff} 分斩获胜利
    </div>
  </section>

  <!-- 战报导语摘要 -->
  <section style="background: #f8f9fa; border-left: 4px solid #1d3557; padding: 14px 16px; border-radius: 4px; margin-bottom: 22px;">
    <p style="margin: 0; font-size: 14px; color: #495057; line-height: 1.75;">
      ${data.summary || '全场鏖战，双方奉献了一场极其胶着精彩的高水平对决。'}
    </p>
  </section>

  <!-- 分节比分表格 -->
  <section style="margin-bottom: 24px;">
    <h4 style="font-size: 15px; font-weight: 700; color: #1d3557; margin: 0 0 10px 0; display: flex; align-items: center;">
      <span style="display: inline-block; width: 4px; height: 16px; background: #e63946; margin-right: 8px; border-radius: 2px;"></span>
      各节比分详情
    </h4>
    <table style="width: 100%; border-collapse: collapse; text-align: center; font-size: 13px; background: #ffffff; border: 1px solid #e9ecef; border-radius: 8px; overflow: hidden;">
      <thead>
        <tr style="background: #f1f3f5; color: #495057; font-weight: 600;">
          <th style="padding: 8px 6px; border-bottom: 1px solid #dee2e6;">球队</th>
          <th style="padding: 8px 4px; border-bottom: 1px solid #dee2e6;">Q1</th>
          <th style="padding: 8px 4px; border-bottom: 1px solid #dee2e6;">Q2</th>
          <th style="padding: 8px 4px; border-bottom: 1px solid #dee2e6;">Q3</th>
          <th style="padding: 8px 4px; border-bottom: 1px solid #dee2e6;">Q4</th>
          <th style="padding: 8px 6px; border-bottom: 1px solid #dee2e6; color: #1d3557; font-weight: 700;">总分</th>
        </tr>
      </thead>
      <tbody>
        <tr style="border-bottom: 1px solid #f1f3f5;">
          <td style="padding: 9px 6px; font-weight: 600; color: #212529;">${data.teamA}</td>
          <td style="padding: 9px 4px;">${quarters.q1A ?? '-'}</td>
          <td style="padding: 9px 4px;">${quarters.q2A ?? '-'}</td>
          <td style="padding: 9px 4px;">${quarters.q3A ?? '-'}</td>
          <td style="padding: 9px 4px;">${quarters.q4A ?? '-'}</td>
          <td style="padding: 9px 6px; font-weight: 700; color: #e63946;">${data.scoreA}</td>
        </tr>
        <tr>
          <td style="padding: 9px 6px; font-weight: 600; color: #212529;">${data.teamB}</td>
          <td style="padding: 9px 4px;">${quarters.q1B ?? '-'}</td>
          <td style="padding: 9px 4px;">${quarters.q2B ?? '-'}</td>
          <td style="padding: 9px 4px;">${quarters.q3B ?? '-'}</td>
          <td style="padding: 9px 4px;">${quarters.q4B ?? '-'}</td>
          <td style="padding: 9px 6px; font-weight: 700; color: #1d3557;">${data.scoreB}</td>
        </tr>
      </tbody>
    </table>
  </section>

  <!-- 关键转折点分析 -->
  <section style="background: #fff8f0; border-radius: 8px; border: 1px solid #ffe8d6; padding: 14px 16px; margin-bottom: 22px;">
    <h4 style="margin: 0 0 8px 0; font-size: 15px; color: #d9480f; font-weight: 700;">
      ⚡ 胜负转折点
    </h4>
    <p style="margin: 0; font-size: 14px; color: #6d4b29; line-height: 1.7;">
      ${data.turningPoint || '关键时刻的攻防战术调整成为奠定全场胜局的分水岭。'}
    </p>
  </section>

  <!-- 全场 MVP 与战术点评 -->
  <section style="background: #f0f4f8; border-radius: 8px; border: 1px solid #d9e2ec; padding: 14px 16px; margin-bottom: 22px;">
    <h4 style="margin: 0 0 8px 0; font-size: 15px; color: #102a43; font-weight: 700;">
      🌟 关键先生与战术点评
    </h4>
    <p style="margin: 0; font-size: 14px; color: #334e68; line-height: 1.7;">
      ${data.mvpTake || '获胜方展现出极强的攻防团队凝聚力，关键球稳健命中拿下比赛。'}
    </p>
  </section>

  <!-- 比赛分节战况回顾 -->
  <section style="margin-bottom: 22px;">
    <h4 style="font-size: 15px; font-weight: 700; color: #1d3557; margin: 0 0 12px 0; display: flex; align-items: center;">
      <span style="display: inline-block; width: 4px; height: 16px; background: #e63946; margin-right: 8px; border-radius: 2px;"></span>
      四节战况深度复盘
    </h4>
    <div style="margin-bottom: 12px; background: #ffffff; padding: 12px 14px; border-radius: 6px; border: 1px solid #f1f3f5;">
      <div style="font-weight: 700; font-size: 14px; color: #1d3557; margin-bottom: 4px;">【首节战况】 (${data.teamA} ${quarters.q1A ?? '-'} : ${quarters.q1B ?? '-'} ${data.teamB})</div>
      <p style="margin: 0; font-size: 14px; color: #495057; line-height: 1.7;">${qc.q1 || '双方开局迅速进入状态，比分呈现交替上升。'}</p>
    </div>
    <div style="margin-bottom: 12px; background: #ffffff; padding: 12px 14px; border-radius: 6px; border: 1px solid #f1f3f5;">
      <div style="font-weight: 700; font-size: 14px; color: #1d3557; margin-bottom: 4px;">【次节拉锯】 (${data.teamA} ${quarters.q2A ?? '-'} : ${quarters.q2B ?? '-'} ${data.teamB})</div>
      <p style="margin: 0; font-size: 14px; color: #495057; line-height: 1.7;">${qc.q2 || '次节双方加强内线对抗，战况胶着激烈。'}</p>
    </div>
    <div style="margin-bottom: 12px; background: #ffffff; padding: 12px 14px; border-radius: 6px; border: 1px solid #f1f3f5;">
      <div style="font-weight: 700; font-size: 14px; color: #1d3557; margin-bottom: 4px;">【易边再战】 (${data.teamA} ${quarters.q3A ?? '-'} : ${quarters.q3B ?? '-'} ${data.teamB})</div>
      <p style="margin: 0; font-size: 14px; color: #495057; line-height: 1.7;">${qc.q3 || '下半场易边再战，外线投射逐步开火，攻防节奏明显加快。'}</p>
    </div>
    <div style="background: #ffffff; padding: 12px 14px; border-radius: 6px; border: 1px solid #f1f3f5;">
      <div style="font-weight: 700; font-size: 14px; color: #1d3557; margin-bottom: 4px;">【末节决胜】 (${data.teamA} ${quarters.q4A ?? '-'} : ${quarters.q4B ?? '-'} ${data.teamB})</div>
      <p style="margin: 0; font-size: 14px; color: #495057; line-height: 1.7;">${qc.q4 || '进入第四节决战，胜方凭借关键球防守与稳定罚球一锤定音锁定胜局。'}</p>
    </div>
  </section>
  ${data.userNote ? `
  <!-- 现场花絮 -->
  <section style="background: #f8f9fa; border-radius: 6px; padding: 10px 14px; font-size: 13px; color: #6c757d; margin-bottom: 20px;">
    📌 现场记分员手记：${data.userNote}
  </section>
  ` : ''}

  <!-- 底部落款 -->
  <section style="text-align: center; padding: 16px 0; border-top: 1px dashed #dee2e6; margin-top: 24px;">
    <p style="margin: 0; font-size: 12px; color: #adb5bd;">
      本战报由 高光记分 · AI 赛事大脑 (SiliconFlow) 智能生成
    </p>
  </section>
</section>`;
}

/**
 * 组装适合微信群聊与朋友圈传播的纯文本战报
 */
function formatPlainTextFromAi(data) {
  const winner = data.scoreA > data.scoreB ? data.teamA : (data.scoreB > data.scoreA ? data.teamB : '平手');
  const winDiff = Math.abs(data.scoreA - data.scoreB);
  const quarters = data.quarters || {};
  const qc = data.quarterCommentary || {};

  return `🏀【${data.tournamentName || '高光记分'}·战报】
${data.title}

【全场比分】
🏆 ${data.teamA} ${data.scoreA} : ${data.scoreB} ${data.teamB}（${winner} 净胜 ${winDiff} 分）
（四节比分：Q1 ${quarters.q1A ?? '-'}:${quarters.q1B ?? '-'} | Q2 ${quarters.q2A ?? '-'}:${quarters.q2B ?? '-'} | Q3 ${quarters.q3A ?? '-'}:${quarters.q3B ?? '-'} | Q4 ${quarters.q4A ?? '-'}:${quarters.q4B ?? '-'}）

【战况速评】
${data.summary}

【胜负转折点】
${data.turningPoint}

【MVP与关键点评】
${data.mvpTake}

【分节回顾】
- Q1: ${qc.q1 || '两队迅速进入状态，比分胶着。'}
- Q2: ${qc.q2 || '次节肉搏加剧，防守升级。'}
- Q3: ${qc.q3 || '外线投射复苏，攻防提速。'}
- Q4: ${qc.q4 || '末节决战，一锤定音锁死胜局。'}
${data.userNote ? `★ 赛场花絮：${data.userNote}\n` : ''}
📱 微信搜索「高光记分」小程序，查看赛事更多高清精彩高光与全场技术统计！`.trim();
}

/**
 * 核心调度：调用硅基流动大模型生成战报并落库
 * @param {Object} options
 * @param {string|number} options.matchId
 * @param {string|number} [options.tournamentId]
 * @param {string} options.teamA
 * @param {string} options.teamB
 * @param {number} options.scoreA
 * @param {number} options.scoreB
 * @param {string} [options.tournamentName]
 * @param {string} [options.stageName]
 * @param {string} [options.datePart]
 * @param {string} [options.venue]
 * @param {string} [options.userNote]
 * @param {boolean} [options.forceRegenerate]
 * @returns {Promise<Object>}
 */
function generateAiMatchReport(options) {
  const matchId = String(options.matchId || '');
  const forceRegenerate = Boolean(options.forceRegenerate);

  // 1. 若非强制重写，先检查本地缓存
  if (!forceRegenerate) {
    const cached = getCachedReportByMatchId(matchId);
    if (cached) {
      return Promise.resolve(cached);
    }
  }

  // 2. 尝试从本地流水及记分缓存中提取真实比赛特征
  const scoreA = Number(options.scoreA) || 0;
  const scoreB = Number(options.scoreB) || 0;
  const teamA = String(options.teamA || '主队').trim();
  const teamB = String(options.teamB || '客队').trim();

  const events = getScoreEvents(matchId);
  const matchFeatures = extractMatchFeatures(events, {
    teamA: teamA,
    teamB: teamB,
    scoreA: scoreA,
    scoreB: scoreB
  });

  const localMatch = findLocalMatchDetails(matchId, options.teamA, options.teamB);
  let quarters = matchFeatures.quarters || {
    q1A: Math.round(scoreA * 0.25),
    q1B: Math.round(scoreB * 0.26),
    q2A: Math.round(scoreA * 0.24),
    q2B: Math.round(scoreB * 0.24),
    q3A: Math.round(scoreA * 0.26),
    q3B: Math.round(scoreB * 0.25),
    q4A: scoreA - Math.round(scoreA * 0.75),
    q4B: scoreB - Math.round(scoreB * 0.75)
  };

  if (localMatch && Array.isArray(localMatch.quarters) && localMatch.quarters.length >= 4) {
    quarters = {
      q1A: Number(localMatch.quarters[0].scoreA) || quarters.q1A,
      q1B: Number(localMatch.quarters[0].scoreB) || quarters.q1B,
      q2A: Number(localMatch.quarters[1].scoreA) || quarters.q2A,
      q2B: Number(localMatch.quarters[1].scoreB) || quarters.q2B,
      q3A: Number(localMatch.quarters[2].scoreA) || quarters.q3A,
      q3B: Number(localMatch.quarters[2].scoreB) || quarters.q3B,
      q4A: Number(localMatch.quarters[3].scoreA) || quarters.q4A,
      q4B: Number(localMatch.quarters[3].scoreB) || quarters.q4B
    };
  }

  const payload = {
    matchId: Number(matchId),
    tournamentId: options.tournamentId ? Number(options.tournamentId) : undefined,
    forceRegenerate: forceRegenerate,
    userNote: options.userNote || '',
    statsOverride: {
      team_a: teamA,
      team_b: teamB,
      score_a: scoreA,
      score_b: scoreB,
      tournament_name: options.tournamentName || '',
      match_date: options.datePart || '',
      quarters: quarters,
      match_features: matchFeatures
    }
  };

  // 3. 请求后端服务端接口 (Node Koa -> SiliconFlow Qwen2.5-7B -> MySQL match_reports)
  return generateBackendMatchReport(payload)
    .then((backendRes) => {
      if (backendRes.ok && backendRes.data) {
        const report = normalizeDbReport(backendRes.data);
        saveReportToCache(matchId, report);
        return report;
      }
      throw new Error(backendRes.error || '后端接口返回异常');
    })
    .catch((err) => {
      console.warn('[MatchReportGenerator] 后端接口生成失败，切换到本地规则保底:', err?.message || err);
      // 本地规则保底引擎（绝不报错阻断用户）
      const fallback = generateMatchReport(options);
      return fallback;
    });
}

/**
 * 本地规则引擎生成兜底战报
 */
function generateMatchReport(options) {
  const matchId = String(options.matchId || '');
  const teamA = String(options.teamA || '主队').trim();
  const teamB = String(options.teamB || '客队').trim();
  const scoreA = Number(options.scoreA) || 0;
  const scoreB = Number(options.scoreB) || 0;
  const tournamentName = String(options.tournamentName || '2026年篮球公开赛').trim();
  const stageName = String(options.stageName || '常规赛').trim();
  const userNote = String(options.userNote || '').trim();

  const isAWin = scoreA > scoreB;
  const isDraw = scoreA === scoreB;
  const winner = isAWin ? teamA : isDraw ? '双方' : teamB;
  const loser = isAWin ? teamB : isDraw ? '握手言和' : teamA;
  const diff = Math.abs(scoreA - scoreB);

  const title1 = `【战报】${teamA} ${scoreA}-${scoreB} ${teamB}：鏖战四节，${winner}净胜${diff}分！`;
  const title2 = `攻防对决！${teamA}大战${teamB}，比分定格 ${scoreA}:${scoreB}`;
  const title3 = `【赛事速评】${winner} 力克强敌，终场 ${scoreA}:${scoreB} 收获胜利！`;

  const summary = `在刚刚结束的 ${tournamentName} (${stageName}) 焦点战中，${teamA} 与 ${teamB} 展开了四节激烈交锋。全场比分交替上升，最终 ${winner} 凭借关键时刻的稳健发挥，以 ${scoreA}:${scoreB} 斩获比赛胜利！`;

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

  const qc = {
    q1: `首节比赛两队迅速进入状态，比分为 ${quarters.q1A}:${quarters.q1B}。`,
    q2: `次节双方加强对抗，防守强度明显提升，比分为 ${quarters.q2A}:${quarters.q2B}。`,
    q3: `易边再战，外线手感复苏，攻防节奏明显加快。`,
    q4: `末节决战，${winner} 顶住攻防压力，稳扎稳打锁定胜局。`
  };

  const html = formatWechatHtmlFromAi({
    tournamentName: tournamentName,
    matchDate: options.datePart || '',
    teamA: teamA,
    teamB: teamB,
    scoreA: scoreA,
    scoreB: scoreB,
    quarters: quarters,
    title: title1,
    summary: summary,
    turningPoint: `决胜时刻的进攻节奏调整与防守强度升级成为奠定全场胜局的关键。`,
    mvpTake: `${winner} 全队展现出极强的攻防凝聚力，关键球稳稳打进奠定基调。`,
    quarterCommentary: qc,
    userNote: userNote
  });

  const plainText = formatPlainTextFromAi({
    tournamentName: tournamentName,
    teamA: teamA,
    teamB: teamB,
    scoreA: scoreA,
    scoreB: scoreB,
    quarters: quarters,
    title: title1,
    summary: summary,
    turningPoint: `决胜时刻的攻防战术调整成为奠定全场胜局的分水岭。`,
    mvpTake: `${winner} 全队展现出极强的攻防凝聚力。`,
    quarterCommentary: qc,
    userNote: userNote
  });

  const fallbackDouyin = `神仙打架！今天这场对决简直让人把速效救心丸握在手里！\n全场战罢，${teamA}与${teamB}鏖战四节，最终${winner}以 ${scoreA} 比 ${scoreB} 惊险胜出，净胜 ${diff} 分！\n双方从开局便陷入肉搏拉锯，下半场攻防节奏全面提速，外线频频飙射，战况白热化！决胜第四节最后时刻，胜方凭借关键球防守与稳健罚球一锤定音锁死胜局！\n拼到最后一秒的硬仗！你给两队的表现打几分？评论区聊聊！`;

  const fallbackWechat = `🏀【高光记分·全场战报】\n${teamA} ${scoreA} : ${scoreB} ${teamB}（${winner} 净胜 ${diff} 分收官）\n\n【战况速递】\n全场鏖战四节，双方展开激烈拉锯。获胜方在攻防转换与关键球处理上表现更为沉稳，终场前顶住反扑压力斩获胜利。\n\n【关键胜负手】\n决胜时刻的攻防战术调整与关键罚球成为奠定全场胜局的分水岭。\n（四节比分：Q1 ${quarters.q1A}:${quarters.q1B} | Q2 ${quarters.q2A}:${quarters.q2B} | Q3 ${quarters.q3A}:${quarters.q3B} | Q4 ${quarters.q4A}:${quarters.q4B}）\n\n—— 微信搜索「高光记分」小程序，查看赛事更多高清集锦与全场技术统计！`;

  const report = {
    matchId: matchId,
    title: title1,
    alternativeTitles: [title1, title2, title3],
    summary: summary,
    douyinScript: fallbackDouyin,
    wechatReport: fallbackWechat,
    contentHtml: html,
    contentPlainText: fallbackWechat,
    userNote: userNote,
    modelName: 'local-rules-engine',
    isAiGenerated: false,
    createdAt: new Date().toISOString()
  };

  saveReportToCache(matchId, report);
  return report;
}

module.exports = {
  getCachedReportByMatchId,
  saveReportToCache,
  fetchSavedMatchReport,
  generateAiMatchReport,
  generateMatchReport
};
