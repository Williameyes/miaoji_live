/**
 * @fileoverview C端赛事详情与排行榜页面 (包含赛程与所有者比分修改)
 */
const { fetchTournamentDetail, oamUpsert } = require('../../../services/tournament-api.js');
const {
  checkIsLoggedIn,
  isTournamentPinned,
  toggleTournamentPin
} = require('../../../utils/tournament-pin.js');
const { post, STORAGE_USER_INFO_KEY } = require('../../../utils/request.js');

/**
 * 判断指定阶段名称是否属于淘汰赛 / 决胜排位赛（无循环赛积分属性）
 */
function isKnockoutStage(stageName) {
  if (!stageName || typeof stageName !== 'string') return false;
  const name = stageName.trim();
  const pattern = /(四分之一|半决赛|决赛|淘汰|排位|名次|8强|4强|1\/4|3[、\-\_]4|5[、\-\_]8|5[、\-\_]6|KNOCKOUT|ELIMINATION|FINALS)/i;
  return pattern.test(name);
}

/**
 * 判断阶段在赛程列表中是否已解锁展示（级联推进显示）
 */
function isStageUnlockedForSchedule(stageName, matches) {
  if (!stageName) return false;
  // 小组赛默认解锁
  if (!isKnockoutStage(stageName)) return true;

  const stageMatches = (matches || []).filter(function (m) {
    return m.stage_id === stageName;
  });
  if (!stageMatches.length) return false;

  for (let i = 0; i < stageMatches.length; i += 1) {
    const m = stageMatches[i];
    if (m.hasValidScores || m.is_finished) return true;
    const tA = m.team_a || '';
    const tB = m.team_b || '';
    const isPlaceholderA = /^\d+胜|^\d+负|待定|TBD/i.test(tA);
    const isPlaceholderB = /^\d+胜|^\d+负|待定|TBD/i.test(tB);
    if (!isPlaceholderA && !isPlaceholderB && tA && tB) {
      return true; // 确定队伍对阵的淘汰赛解锁
    }
  }

  return false;
}

/**
 * 根据 activeTab (schedule 或 standings) 动态生成展示的 stageList 胶囊列表
 */
function resolveStageListForTab(activeTab, formattedMatches, rawStages) {
  const matches = formattedMatches || [];
  const stageSet = new Set();
  matches.forEach(function (m) {
    if (m.stage_id && m.stage_id !== 'stage_default') {
      stageSet.add(m.stage_id);
    }
  });

  const allStages = Array.from(stageSet);

  if (activeTab === 'standings') {
    // 🏆 积分排行榜 Tab：彻底过滤淘汰赛阶段，只保留小组赛
    const groupStages = allStages.filter(function (name) {
      return !isKnockoutStage(name);
    });

    const result = [];
    if (groupStages.length > 0) {
      result.push({ id: 'all', name: '全部小组' });
      groupStages.forEach(function (s) {
        result.push({ id: s, name: s, type: 'GROUP' });
      });
    } else {
      result.push({ id: 'all', name: '全组排行榜', type: 'GROUP' });
    }
    return result;
  } else {
    // 📅 赛程 Tab：级联推进，仅解锁已产生对阵或完赛的阶段
    const unlocked = allStages.filter(function (name) {
      return isStageUnlockedForSchedule(name, matches);
    });

    const result = [];
    if (unlocked.length > 0) {
      result.push({ id: 'all', name: '全部已解锁赛程' });
      unlocked.forEach(function (s) {
        result.push({ id: s, name: s, type: 'STAGE' });
      });
    } else {
      result.push({ id: 'all', name: '全阶段赛程', type: 'STAGE' });
    }
    return result;
  }
}

/**
 * 智能解析队伍占位词（如 “39胜”、“40负”），若前置场次已完赛则自动算出胜者/负者队伍名
 */
function resolveTeamPlaceholderName(rawTeamName, allMatches) {
  if (!rawTeamName || typeof rawTeamName !== 'string') return '';
  const str = rawTeamName.trim();

  const matchIndexPattern = /^(\d+)(胜|负)$/;
  const mRes = str.match(matchIndexPattern);
  if (mRes && Array.isArray(allMatches) && allMatches.length > 0) {
    const targetSeqNum = Number(mRes[1]);
    const type = mRes[2];

    // 优先通过显式持久化的 match_seq (场次序号，如第 39 场) 精确匹配
    let targetMatch = allMatches.find(function (item) {
      return Number(item.match_seq) === targetSeqNum;
    });

    // 兜底降级：若未显式指定，按列表索引比对
    if (!targetMatch) {
      if (allMatches[targetSeqNum - 1]) {
        targetMatch = allMatches[targetSeqNum - 1];
      } else {
        targetMatch = allMatches.find(function (item, idx) {
          return (idx + 1) === targetSeqNum;
        });
      }
    }

    if (targetMatch && targetMatch.hasValidScores) {
      const sA = Number(targetMatch.score_a);
      const sB = Number(targetMatch.score_b);
      if (sA > sB) {
        return type === '胜' ? targetMatch.team_a : targetMatch.team_b;
      } else if (sB > sA) {
        return type === '胜' ? targetMatch.team_b : targetMatch.team_a;
      }
    }
  }

/**
 * 尝试将组别排名代号（如 A1, B2, 男子A1, 女子B2, 男子A组第1名）或场序胜负（39胜）自动转换为实际队伍名称
 */
function resolveTeamCodeToActualName(teamCode, standingsMap, allMatches) {
  if (!teamCode || typeof teamCode !== 'string') return teamCode || '';
  const code = teamCode.trim();

  // 1. 先尝试解析 “39胜” / “39负”
  const seqRes = resolveTeamPlaceholderName(code, allMatches);
  if (seqRes && seqRes !== code && seqRes !== '') {
    return seqRes;
  }

  // 2. 解析小组排名代号：如 A1, B2, C1, C2, 男子A1, 女子B2, 男子A组1, 男子A组第1名
  const rankPattern = /^(?:(男子|女子)\s*)?([A-Z])(?:组)?\s*(?:第)?(\d+)(?:名)?$/i;
  const match = code.match(rankPattern);

  if (match && standingsMap) {
    const genderPrefix = match[1] || '';
    const groupLetter = match[2].toUpperCase();
    const rankNum = Number(match[3]);

    const possibleKeys = Object.keys(standingsMap).filter(function (k) {
      if (genderPrefix && !k.includes(genderPrefix)) return false;
      return k.toUpperCase().includes(groupLetter);
    });

    for (let i = 0; i < possibleKeys.length; i += 1) {
      const key = possibleKeys[i];
      const list = standingsMap[key] || [];

      // 检查该小组是否已全完赛
      const groupMatches = (allMatches || []).filter(function (m) {
        return m.stage_id === key;
      });
      const isGroupFinished = groupMatches.length > 0 && groupMatches.every(function (m) {
        return m.hasValidScores || m.is_finished;
      });

      const teamItem = list.find(function (item) {
        return Number(item.rank) === rankNum;
      });

      if (teamItem && teamItem.team_name && isGroupFinished) {
        return teamItem.team_name;
      }
    }
  }

  return code;
}

Page({
  data: {
    statusBarHeight: 20,
    tournamentId: '',
    detail: null,
    loading: true,
    isPinned: false,
    activeTab: 'schedule', // schedule | standings
    selectedStageId: 'all',
    stageList: [],
    allTeamList: [],
    formattedMatches: [],
    currentMatches: [],
    currentStandings: [],
    currentGroupedStandings: [], // 分组排行榜多表格堆叠数据
    
    // 比分修改 Modal
    showScoreModal: false,
    editingMatch: null,
    editTeamA: '',
    editTeamB: '',
    scoreA: '',
    scoreB: '',
    submittingScore: false
  },

  onLoad: function (query) {
    try {
      const sys = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
      this.setData({ statusBarHeight: sys.statusBarHeight || 20 });
    } catch (e) {
      // fallback
    }

    const id = query && query.id ? String(query.id) : '';
    if (id) {
      this.setData({ tournamentId: id });
      this.loadDetail(id);
    }
  },

  onPullDownRefresh: function () {
    if (this.data.tournamentId) {
      this.loadDetail(this.data.tournamentId).finally(function () {
        wx.stopPullDownRefresh();
      });
    } else {
      wx.stopPullDownRefresh();
    }
  },

  loadDetail: function (id) {
    const self = this;
    this.setData({ loading: true });
    return fetchTournamentDetail(id)
      .then(function (detail) {
        const rawMatches = detail.matches || [];
        const formattedMatches = rawMatches.map(function (m) {
          const rawTime = String(m.start_time || '').trim();
          let datePart = '';
          let timePart = '';
          const timeMatch = rawTime.match(/(\d{2}-\d{2})\s+(\d{2}:\d{2})/);
          if (timeMatch) {
            datePart = timeMatch[1];
            timePart = timeMatch[2];
          } else {
            const parts = rawTime.split(/[\sT]+/);
            datePart = parts[0] ? parts[0].replace(/^\d{4}-/, '') : '';
            timePart = parts[1] ? parts[1].slice(0, 5) : '';
          }

          const hasScoreA = m.score_a !== null && m.score_a !== undefined && m.score_a !== 'null' && m.score_a !== '';
          const hasScoreB = m.score_b !== null && m.score_b !== undefined && m.score_b !== 'null' && m.score_b !== '';
          const hasValidScores = hasScoreA && hasScoreB;

          return Object.assign({}, m, {
            datePart: datePart || '—',
            timePart: timePart || '—',
            team_a: String(m.team_a || '主队').replace(/null/g, ''),
            team_b: String(m.team_b || '客队').replace(/null/g, ''),
            score_a: hasScoreA ? Number(m.score_a) : 0,
            score_b: hasScoreB ? Number(m.score_b) : 0,
            hasValidScores: hasValidScores
          });
        });

        const rawStages = detail.stages || [];
        const standings = detail.standings || {};
        const pinned = isTournamentPinned(id);

        // 为赛程添加 display_team_a 与 display_team_b 属性（自动推算完赛的小组排名与胜者代号）
        const resolvedMatches = formattedMatches.map(function (m) {
          const dispA = resolveTeamCodeToActualName(m.team_a, standings, formattedMatches);
          const dispB = resolveTeamCodeToActualName(m.team_b, standings, formattedMatches);
          return Object.assign({}, m, {
            display_team_a: dispA,
            display_team_b: dispB
          });
        });
        
        const teamSet = new Set();
        resolvedMatches.forEach(function (m) {
          if (m.team_a && !/^\d+胜|^\d+负|待定|TBD/i.test(m.team_a)) {
            teamSet.add(m.team_a);
          }
          if (m.team_b && !/^\d+胜|^\d+负|待定|TBD/i.test(m.team_b)) {
            teamSet.add(m.team_b);
          }
          if (m.display_team_a && !/^\d+胜|^\d+负|待定|TBD/i.test(m.display_team_a)) {
            teamSet.add(m.display_team_a);
          }
          if (m.display_team_b && !/^\d+胜|^\d+负|待定|TBD/i.test(m.display_team_b)) {
            teamSet.add(m.display_team_b);
          }
        });
        const allTeamList = Array.from(teamSet);

        const activeTab = self.data.activeTab || 'schedule';
        const stages = resolveStageListForTab(activeTab, resolvedMatches, rawStages);
        const stageId = 'all';

        self.setData({
          detail: detail,
          stageList: stages,
          allTeamList: allTeamList,
          selectedStageId: stageId,
          formattedMatches: resolvedMatches,
          isPinned: pinned,
          loading: false
        });

        self._filterStageData(stageId, resolvedMatches, standings);
      })
      .catch(function (err) {
        self.setData({ loading: false });
        wx.showToast({ title: err.message || '加载详情失败', icon: 'none' });
      });
  },

  /**
   * 点击置顶 / 取消置顶
   */
  onTogglePin: function () {
    const id = this.data.tournamentId;
    if (!id) return;

    const isLoggedIn = checkIsLoggedIn();
    if (!isLoggedIn) {
      const self = this;
      wx.showModal({
        title: '登录后使用置顶',
        content: '置顶功能需要授权登录，登录后该赛事将自动置顶并展示在赛事大厅最上方。',
        confirmText: '立即登录',
        cancelText: '暂不登录',
        confirmColor: '#2563eb',
        success: function (res) {
          if (res.confirm) {
            self._performQuickLoginAndPin(id);
          }
        }
      });
      return;
    }

    this._doPinToggle(id);
  },

  _doPinToggle: function (id) {
    const isNowPinned = toggleTournamentPin(id);
    this.setData({ isPinned: isNowPinned });
    if (isNowPinned) {
      wx.showToast({ title: '已置顶，在赛事大厅最上方展示', icon: 'none', duration: 2000 });
    } else {
      wx.showToast({ title: '已取消置顶', icon: 'none' });
    }
  },

  _performQuickLoginAndPin: function (id) {
    const self = this;
    wx.showLoading({ title: '授权登录中…', mask: true });
    wx.getUserProfile({
      desc: '用于保存您的赛事置顶偏好',
      success: function (profileRes) {
        wx.login({
          success: function (loginRes) {
            if (loginRes.code) {
              const loginPayload = {
                code: loginRes.code,
                encryptedData: profileRes.encryptedData,
                iv: profileRes.iv,
                rawData: profileRes.rawData,
                signature: profileRes.signature,
                nickName: profileRes.userInfo ? profileRes.userInfo.nickName : '',
                avatarUrl: profileRes.userInfo ? profileRes.userInfo.avatarUrl : ''
              };
              post('/api/auth/login', loginPayload, { skipAuth: true })
                .then(function (res) {
                  wx.hideLoading();
                  if (res && res.data) {
                    const gd = getApp().globalData;
                    gd.userInfo = res.data;
                    wx.setStorageSync(STORAGE_USER_INFO_KEY, res.data);
                    if (res.data.token) {
                      wx.setStorageSync('token', res.data.token);
                    }
                  }
                  wx.showToast({ title: '登录成功', icon: 'success' });
                  self._doPinToggle(id);
                })
                .catch(function () {
                  wx.hideLoading();
                  const dummyUser = { openid: 'local_user_' + Date.now(), nickName: profileRes.userInfo.nickName };
                  if (getApp()) getApp().globalData.userInfo = dummyUser;
                  wx.setStorageSync(STORAGE_USER_INFO_KEY, dummyUser);
                  wx.showToast({ title: '已登录并完成置顶', icon: 'success' });
                  self._doPinToggle(id);
                });
            } else {
              wx.hideLoading();
              wx.showToast({ title: '获取 code 失败', icon: 'none' });
            }
          },
          fail: function () {
            wx.hideLoading();
            wx.showToast({ title: '微信登录失败', icon: 'none' });
          }
        });
      },
      fail: function () {
        wx.hideLoading();
        wx.showToast({ title: '已取消授权', icon: 'none' });
      }
    });
  },

  _filterStageData: function (stageId, matchesList, standingsMap) {
    const matches = matchesList || (this.data.formattedMatches || (this.data.detail ? this.data.detail.matches : []));
    const standings = standingsMap || (this.data.detail ? this.data.detail.standings : {});
    const activeTab = this.data.activeTab || 'schedule';

    let filteredMatches = matches;
    if (activeTab === 'schedule') {
      if (stageId && stageId !== 'all') {
        filteredMatches = matches.filter(function (m) {
          return (m.stage_id || 'stage_default') === stageId;
        });
      } else {
        // 赛程视图全选时，仅展示已解锁的比赛
        filteredMatches = matches.filter(function (m) {
          return isStageUnlockedForSchedule(m.stage_id, matches);
        });
      }
    } else {
      if (stageId && stageId !== 'all') {
        filteredMatches = matches.filter(function (m) {
          return (m.stage_id || 'stage_default') === stageId;
        });
      }
    }

    let filteredStandings = [];
    let currentGroupedStandings = [];

    if (stageId && stageId !== 'all') {
      if (standings[stageId]) {
        filteredStandings = standings[stageId];
        currentGroupedStandings = [{
          stage_id: stageId,
          stage_name: stageId,
          list: standings[stageId]
        }];
      }
    } else {
      // 积分榜视图“全部”：全量平铺堆叠展示所有非淘汰赛小组的积分表
      const validGroupKeys = Object.keys(standings).filter(function (k) {
        return !isKnockoutStage(k);
      });
      if (validGroupKeys.length > 0) {
        validGroupKeys.forEach(function (k) {
          if (Array.isArray(standings[k]) && standings[k].length > 0) {
            currentGroupedStandings.push({
              stage_id: k,
              stage_name: k,
              list: standings[k]
            });
          }
        });
        filteredStandings = standings[validGroupKeys[0]] || [];
      } else {
        const allKeys = Object.keys(standings);
        allKeys.forEach(function (k) {
          if (Array.isArray(standings[k]) && standings[k].length > 0) {
            currentGroupedStandings.push({
              stage_id: k,
              stage_name: k,
              list: standings[k]
            });
          }
        });
        if (allKeys.length > 0) {
          filteredStandings = standings[allKeys[0]] || [];
        }
      }
    }

    this.setData({
      currentMatches: filteredMatches,
      currentStandings: filteredStandings,
      currentGroupedStandings: currentGroupedStandings
    });
  },

  /**
   * 长按比赛行触发编辑比分 Modal
   */
  onMatchLongPress: function (e) {
    const match = e.currentTarget.dataset.match;
    if (!match) return;

    if (this.data.detail && this.data.detail.can_manage) {
      if (wx.vibrateShort) {
        wx.vibrateShort({ type: 'medium' });
      }
      this.onEditMatchScore(e);
    } else {
      wx.showToast({ title: '长按修改比分仅管理者可用', icon: 'none' });
    }
  },

  onGoBack: function () {
    const pages = getCurrentPages();
    if (pages && pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({ url: '/pages/tournament/tournament' });
    }
  },

  onTabSwitch: function (e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.activeTab) return;

    const stages = resolveStageListForTab(
      tab,
      this.data.formattedMatches,
      this.data.detail ? this.data.detail.stages : []
    );
    const defaultStageId = 'all';

    this.setData({
      activeTab: tab,
      stageList: stages,
      selectedStageId: defaultStageId
    });

    this._filterStageData(defaultStageId);
  },

  onStageSwitch: function (e) {
    const stageId = e.currentTarget.dataset.stage;
    this.setData({ selectedStageId: stageId });
    this._filterStageData(stageId);
  },

  // 展开修改对阵与比分 Modal (所有者权限)
  onEditMatchScore: function (e) {
    const match = e.currentTarget.dataset.match;
    if (!match) return;

    const standings = (this.data.detail ? this.data.detail.standings : {}) || {};
    const allMatches = this.data.formattedMatches || [];
    const resolvedA = resolveTeamCodeToActualName(match.team_a, standings, allMatches);
    const resolvedB = resolveTeamCodeToActualName(match.team_b, standings, allMatches);

    const isPlaceholderA = /^\d+(胜|负)$|^[A-Z]\d+$/i.test(match.team_a);
    const isPlaceholderB = /^\d+(胜|负)$|^[A-Z]\d+$/i.test(match.team_b);

    this.setData({
      showScoreModal: true,
      editingMatch: match,
      editTeamA: resolvedA || (match.team_a && !/^\d+胜|^\d+负/.test(match.team_a) ? match.team_a : ''),
      editTeamB: resolvedB || (match.team_b && !/^\d+胜|^\d+负/.test(match.team_b) ? match.team_b : ''),
      scoreA: match.score_a !== null && match.score_a !== undefined && match.hasValidScores ? String(match.score_a) : '',
      scoreB: match.score_b !== null && match.score_b !== undefined && match.hasValidScores ? String(match.score_b) : ''
    });
  },

  onQuickSelectTeam: function (e) {
    const team = e.currentTarget.dataset.team;
    const target = e.currentTarget.dataset.target;
    if (!team || !target) return;

    if (target === 'teamA') {
      this.setData({ editTeamA: team });
    } else if (target === 'teamB') {
      this.setData({ editTeamB: team });
    }
  },

  onCloseScoreModal: function () {
    this.setData({
      showScoreModal: false,
      editingMatch: null,
      editTeamA: '',
      editTeamB: '',
      scoreA: '',
      scoreB: ''
    });
  },

  onEditTeamAInput: function (e) {
    this.setData({ editTeamA: e.detail.value });
  },

  onEditTeamBInput: function (e) {
    this.setData({ editTeamB: e.detail.value });
  },

  onScoreAInput: function (e) {
    this.setData({ scoreA: e.detail.value });
  },

  onScoreBInput: function (e) {
    this.setData({ scoreB: e.detail.value });
  },

  onSaveScore: function () {
    const self = this;
    const m = this.data.editingMatch;
    if (!m) return;

    const tA = String(this.data.editTeamA || '').trim();
    const tB = String(this.data.editTeamB || '').trim();

    if (!tA || !tB) {
      wx.showToast({ title: '主队与客队名称不能为空', icon: 'none' });
      return;
    }

    const sA = String(this.data.scoreA || '').trim();
    const sB = String(this.data.scoreB || '').trim();

    let scoreA = null;
    let scoreB = null;
    let isFinished = 0;

    if (sA !== '' && sB !== '') {
      if (isNaN(Number(sA)) || isNaN(Number(sB))) {
        wx.showToast({ title: '请输入有效的数字比分', icon: 'none' });
        return;
      }
      scoreA = Number(sA);
      scoreB = Number(sB);
      isFinished = 1;
    }

    this.setData({ submittingScore: true });
    const payload = {
      action: 'upsert_match',
      data: {
        match_id: m.match_id,
        tournament_id: self.data.tournamentId,
        team_a: tA,
        team_b: tB,
        start_time: m.start_time,
        stage_id: m.stage_id || 'stage_default',
        venue: m.venue || '',
        score_a: scoreA,
        score_b: scoreB,
        is_finished: isFinished
      }
    };

    oamUpsert(payload)
      .then(function () {
        wx.showToast({ title: '对阵与比分更新成功', icon: 'success' });
        self.onCloseScoreModal();
        self.loadDetail(self.data.tournamentId);
      })
      .catch(function (err) {
        wx.showToast({ title: err.message || '保存失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ submittingScore: false });
      });
  }
});
