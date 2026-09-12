const { ensureMatchManageAccess, ensureRadarLabAccess, isRadarWhitelistUser } = require('../../../../utils/radar-access.js');
const { fetchTournamentList, oamUpsert } = require('../../../../services/radar-api.js');
const { getRadarListScope } = require('../../../../utils/radar-list-scope.js');

/**
 * 解析 CSV 格式的球队初始基准积分文本
 */
function parseTeamInitialsCsvText(text) {
  if (!text || typeof text !== 'string') return {};
  const clean = text.replace(/```csv/gi, '').replace(/```/g, '').trim();
  const lines = clean.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length < 2) return {};

  function splitLine(lineStr) {
    const s = lineStr.replace(/，/g, ',').replace(/\t/g, ',');
    return s.split(',').map(item => item.trim());
  }

  const headers = splitLine(lines[0]).map(h => h.toLowerCase());
  
  let colStage = headers.findIndex(h => h.includes('阶段') || h.includes('分组') || h.includes('stage'));
  let colTeam = headers.findIndex(h => h.includes('球队') || h.includes('队伍') || h.includes('team'));
  let colPts = headers.findIndex(h => h.includes('积分') || h.includes('points') || h.includes('pts'));
  let colPlayed = headers.findIndex(h => h.includes('已赛') || h.includes('场次') || h.includes('played'));
  let colWon = headers.findIndex(h => h.includes('胜') && !h.includes('净') && !h.includes('失'));
  let colDraw = headers.findIndex(h => h.includes('平'));
  let colLost = headers.findIndex(h => h.includes('负') && !h.includes('净') && !h.includes('失'));
  let colNet = headers.findIndex(h => h.includes('净胜'));

  if (colTeam < 0) colTeam = 1;
  if (colPts < 0) colPts = 2;

  const parseNum = (val) => {
    if (val === undefined || val === null || val === '') return 0;
    const cleanVal = String(val).trim().replace(/−/g, '-');
    const num = Number(cleanVal);
    return isNaN(num) ? 0 : num;
  };

  const result = {};
  const stageCounters = {};

  for (let i = 1; i < lines.length; i += 1) {
    const parts = splitLine(lines[i]);
    if (parts.length <= colTeam) continue;

    const stageId = (colStage >= 0 && parts[colStage]) ? parts[colStage] : 'stage_default';
    const teamName = parts[colTeam];
    if (!teamName || teamName.startsWith('```')) continue;

    if (!result[stageId]) result[stageId] = {};
    if (!stageCounters[stageId]) stageCounters[stageId] = 0;

    stageCounters[stageId] += 1;

    result[stageId][teamName] = {
      points: colPts >= 0 ? parseNum(parts[colPts]) : 0,
      played: colPlayed >= 0 ? parseNum(parts[colPlayed]) : 0,
      won: colWon >= 0 ? parseNum(parts[colWon]) : 0,
      draw: colDraw >= 0 ? parseNum(parts[colDraw]) : 0,
      lost: colLost >= 0 ? parseNum(parts[colLost]) : 0,
      net_score: colNet >= 0 ? parseNum(parts[colNet]) : 0,
      initial_rank: stageCounters[stageId]
    };
  }

  return result;
}

Page({
  data: {
    tournamentRows: [],
    loading: false,
    adminViewAll: false,

    // 基准分 AI 批量导入 Modal 状态
    showInitialsModal: false,
    targetTournamentId: '',
    targetTournamentName: '',
    pastedCsvText: '',
    submittingInitials: false,
    isWhitelist: false
  },

  /**
   * @returns {void}
   */
  onLoad: function () {
    if (!ensureMatchManageAccess({ redirectBack: true })) return;
  },

  /**
   * @returns {void}
   */
  onShow: function () {
    this.setData({
      isWhitelist: isRadarWhitelistUser()
    });
    this._reloadList();
  },

  /**
   * 下拉刷新。
   * @returns {void}
   */
  onPullDownRefresh: function () {
    const self = this;
    this._reloadList(true).finally(function () {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * @param {boolean} [silent]
   * @returns {Promise<void>}
   */
  _reloadList: function (silent) {
    const self = this;
    if (!silent) {
      this.setData({ loading: true });
    }
    return fetchTournamentList({ scope: getRadarListScope() })
      .then(function (list) {
        const listScope = getRadarListScope();
        const rows = list.map(function (t) {
          const dateRange =
            t.startDate && t.endDate ? t.startDate + ' ~ ' + t.endDate : '—';
          return {
            id: t.id,
            name: t.name,
            dateRange: dateRange,
            influenceScore:
              t.influenceScore != null && t.influenceScore > 0
                ? String(t.influenceScore)
                : '—',
            scheduledCount: t.totalScheduledMatches || 0,
            monitoredCount: t.totalMonitoredMatches || 0,
            isPublic: t.isPublic !== false,
            canManage: t.canManage !== false
          };
        });
        self.setData({
          tournamentRows: rows,
          loading: false,
          adminViewAll: listScope === 'all'
        });
      })
      .catch(function (err) {
        self.setData({ loading: false });
        if (!silent) {
          wx.showToast({ title: err.message || '加载失败', icon: 'none' });
        }
      });
  },

  /**
   * 新建赛事。
   * @returns {void}
   */
  onNewTournament: function () {
    if (!ensureMatchManageAccess()) return;
    wx.navigateTo({
      url: '/packageLab/pages/radar-lab/oam/tournament-edit/tournament-edit?mode=new'
    });
  },

  /**
   * 查看赛事详情看板（预览模式）。
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onViewTournamentDetail: function (e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const row = this.data.tournamentRows.find(function (r) {
      return String(r.id) === String(id);
    });
    if (row && row.canManage === false) {
      wx.showToast({ title: '无权操作该赛事', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url:
        '/packageLab/pages/radar-lab/oam/tournament-detail/tournament-detail?id=' +
        encodeURIComponent(id)
    });
  },

  /**
   * 编辑赛事。
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onEditTournament: function (e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const row = this.data.tournamentRows.find(function (r) {
      return String(r.id) === String(id);
    });
    if (row && row.canManage === false) {
      wx.showToast({ title: '无权操作该赛事', icon: 'none' });
      return;
    }
    wx.navigateTo({
      url:
        '/packageLab/pages/radar-lab/oam/tournament-edit/tournament-edit?id=' +
        encodeURIComponent(id)
    });
  },

  // ----------------------------------------------------
  // 基准积分 AI 批量导入 Modal 逻辑
  // ----------------------------------------------------
  onOpenInitialsModal: function (e) {
    if (!this.data.isWhitelist) {
      wx.showToast({ title: '该功能仅对白名单用户开放', icon: 'none' });
      return;
    }
    const id = e.currentTarget.dataset.id;
    const name = e.currentTarget.dataset.name;
    if (!id) return;

    this.setData({
      showInitialsModal: true,
      targetTournamentId: id,
      targetTournamentName: name || '赛事',
      pastedCsvText: ''
    });
  },

  onCloseInitialsModal: function () {
    this.setData({
      showInitialsModal: false,
      targetTournamentId: '',
      targetTournamentName: '',
      pastedCsvText: ''
    });
  },

  onCsvTextInput: function (e) {
    this.setData({ pastedCsvText: e.detail.value });
  },

  onCopyAiPrompt: function () {
    if (!this.data.isWhitelist) {
      wx.showToast({ title: '该功能仅对白名单用户开放', icon: 'none' });
      return;
    }
    const promptText = `请你作为赛事基准积分格式化助手。以下是我收集到的积分榜历史战绩数据（可能为图片文本、公众号表格或聊天记录）：

请将所有球队的初始基准数据整理成符合以下标准的 CSV 格式，并用 \`\`\`csv 代码块包裹输出。请勿包含其他解释性文字。

CSV 表头格式（第一行为表头）：
阶段,球队,初始积分,初始已赛,初始胜,初始平,初始负,初始净胜分

字段说明：
- 阶段: 所在分组，如 "男子A组"、"女子B组" 或 "常规赛"（若无可填 "常规赛"）
- 球队: 球队名称（必填，如 "切学乡"）
- 初始积分: 中途接入小程序前已获得的总积分（必填，如 15）
- 初始已赛: 中途接入前已打场次（如 5）
- 初始胜: 中途接入前胜场数（如 4）
- 初始平: 中途接入前平局数（如 0）
- 初始负: 中途接入前负场数（如 1）
- 初始净胜分: 中途接入前净胜分（如 32 或 -5）

原始战绩数据如下：
`;
    wx.setClipboardData({
      data: promptText,
      success: function () {
        wx.showModal({
          title: '提示词已复制！',
          content: '请将提示词粘贴发送给任意大模型（如 DeepSeek / Kimi / 豆包），并在文末附上您的积分榜截图文字或公告。\n\n大模型输出 CSV 后，复制并粘贴回小程序本框，点击「一键保存基准积分」即可！',
          showCancel: false,
          confirmText: '我知道了',
          confirmColor: '#2563eb'
        });
      }
    });
  },

  onSaveInitialsFromCsv: function () {
    const self = this;
    const text = String(this.data.pastedCsvText || '').trim();
    if (!text) {
      wx.showToast({ title: '请先粘贴 AI 生成的 CSV 文本', icon: 'none' });
      return;
    }

    const parsedInitials = parseTeamInitialsCsvText(text);
    const keys = Object.keys(parsedInitials);
    if (!keys.length) {
      wx.showToast({ title: '无法解析有效 CSV 数据，请检查格式', icon: 'none' });
      return;
    }

    this.setData({ submittingInitials: true });
    const payload = {
      action: 'upsert_team_initials',
      data: {
        tournament_id: self.data.targetTournamentId,
        team_initials: parsedInitials
      }
    };

    oamUpsert(payload)
      .then(function () {
        wx.showToast({ title: '批量导入基准积分成功！', icon: 'success' });
        self.onCloseInitialsModal();
        self._reloadList(true);
      })
      .catch(function (err) {
        wx.showToast({ title: err.message || '保存失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ submittingInitials: false });
      });
  }
});
