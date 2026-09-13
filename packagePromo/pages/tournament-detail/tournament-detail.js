/**
 * @fileoverview C端赛事详情与排行榜页面 (包含赛程与所有者比分修改)
 */
const {
  fetchTournamentDetail,
  oamUpsert,
  acceptTournamentInvite
} = require('../../../services/tournament-api.js');
const {
  checkIsLoggedIn,
  isTournamentPinned,
  toggleTournamentPin
} = require('../../../utils/tournament-pin.js');
const { post, STORAGE_TOKEN_KEY, STORAGE_USER_INFO_KEY, setToken } = require('../../../utils/request.js');
const { checkSyncLabWhitelist } = require('../../../utils/sync-lab-whitelist.js');

/** @const {Array<string[]>} 时分多列选择器取值范围（分钟步长为5，无循环） */
const TIME_PICKER_RANGE = [
  ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14', '15', '16', '17', '18', '19', '20', '21', '22', '23'],
  ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55']
];

/**
 * 根据 "HH:mm" 字符串计算在 TIME_PICKER_RANGE 中的索引值
 * @param {string} timeStr
 * @returns {number[]}
 */
function getTimePickerIndices(timeStr) {
  const [hStr, mStr] = (timeStr || '00:00').split(':');
  const h = parseInt(hStr, 10) || 0;
  const m = parseInt(mStr, 10) || 0;
  const roundedM = Math.round(m / 5) * 5;
  const targetM = roundedM >= 60 ? 55 : roundedM;
  const hourIndex = Math.min(Math.max(0, h), 23);
  const minuteIndex = Math.min(Math.max(0, Math.floor(targetM / 5)), 11);
  return [hourIndex, minuteIndex];
}

/**
  * Canvas 2D 辅助绘制圆角矩形
  */
function drawRoundedRect(ctx, x, y, width, height, radius, fillStyle) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
  if (fillStyle) {
    ctx.fillStyle = fillStyle;
    ctx.fill();
  }
}

/**
  * Canvas 2D 辅助文本自动截断加省略号
  */
function truncateText(ctx, text, maxWidth) {
  if (!text) return '';
  let str = String(text);
  if (ctx.measureText(str).width <= maxWidth) return str;
  while (str.length > 0 && ctx.measureText(str + '…').width > maxWidth) {
    str = str.slice(0, -1);
  }
  return str + '…';
}

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
    // 📅 赛程 Tab：全量展示所有赛程阶段（不隐藏未开打阶段，避免用户误解）
    const result = [];
    if (allStages.length > 0) {
      result.push({ id: 'all', name: '全部赛程' });
      allStages.forEach(function (s) {
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

  if (/^\d+(胜|负)$/.test(str)) {
    return '';
  }

  return str;
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
    
    // 表头排序状态
    sortField: '', // '' | 'group' | 'teams' | 'score' | 'time' | 'venue'
    sortOrder: 'default', // 'default' | 'asc' | 'desc'
    
    // 比分/比赛信息修改 Modal
    showScoreModal: false,
    editingMatch: null,
    editTeamA: '',
    editTeamB: '',
    editVenue: '',
    editStartDate: '',
    editStartTime: '',
    scoreA: '',
    scoreB: '',
    submittingScore: false,

    // 赛程行复制到直播记分
    showCopyModal: false,
    timePickerRange: TIME_PICKER_RANGE,
    timePickerValue: [0, 0],
    copyDraft: {
      sportType: 'basketball',
      matchName: '',
      teamAName: '',
      teamBName: '',
      startDate: '',
      startTime: ''
    }
  },

  onLoad: function (query) {
    try {
      let statusBarHeight = 20;
      if (typeof wx.getWindowInfo === 'function') {
        statusBarHeight = wx.getWindowInfo().statusBarHeight || 20;
      } else if (typeof wx.getSystemInfoSync === 'function') {
        statusBarHeight = wx.getSystemInfoSync().statusBarHeight || 20;
      }
      this.setData({ statusBarHeight });
    } catch (e) {}

    // 开启微信原生发送给好友与分享到朋友圈 (shareTimeline)
    if (wx.showShareMenu) {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ['shareAppMessage', 'shareTimeline']
      });
    }

    const id = query && (query.id || query.tournament_id) ? String(query.id || query.tournament_id) : '';
    let inviteCode = query && (query.invite_code || query.inviteCode || query.code) ? String(query.invite_code || query.inviteCode || query.code).trim() : '';
    if (!inviteCode && query && query.scene) {
      try {
        const sceneStr = decodeURIComponent(query.scene);
        const match = sceneStr.match(/(?:invite_code|code)=([^&]+)/);
        if (match) inviteCode = match[1];
      } catch (e) {}
    }
    const initialTab = (query && query.tab === 'standings') ? 'standings' : 'schedule';
    const initialStage = query && query.stage ? query.stage : 'all';

    console.log('[tournament-detail onLoad] 接收到路由参数 query=', query, 'id=', id, 'inviteCode=', inviteCode);

    if (id) {
      this.setData({
        tournamentId: id,
        activeTab: initialTab,
        selectedStageId: initialStage
      });
      const self = this;
      this.loadDetail(id)
        .then(function () {
          if (inviteCode) {
            self._handleInviteCode(id, inviteCode);
          }
        })
        .catch(function (err) {
          console.error('[loadDetail error]', err);
          if (inviteCode) {
            self._handleInviteCode(id, inviteCode);
          }
        });
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
        const now = Date.now();
        const formattedMatches = rawMatches.map(function (m) {
          const rawTime = String(m.start_time || '').trim();
          let datePart = '';
          let timePart = '';
          let matchTs = 0;

          if (rawTime) {
            const normTime = rawTime.replace(/-/g, '/').replace('T', ' ');
            const ts = Date.parse(normTime);
            if (!isNaN(ts)) {
              matchTs = ts;
            }
          }

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
          const isPendingScore = !hasValidScores && matchTs > 0 && now >= matchTs;

          return Object.assign({}, m, {
            datePart: datePart || '—',
            timePart: timePart || '—',
            team_a: String(m.team_a || '主队').replace(/null/g, ''),
            team_b: String(m.team_b || '客队').replace(/null/g, ''),
            score_a: hasScoreA ? Number(m.score_a) : 0,
            score_b: hasScoreB ? Number(m.score_b) : 0,
            hasValidScores: hasValidScores,
            isPendingScore: isPendingScore
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
        let stageId = self.data.selectedStageId || 'all';
        const exists = stages.some(function (s) { return s.id === stageId; });
        if (!exists) stageId = 'all';

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
        console.error('[loadDetail error]', err);
        self.setData({
          loading: false,
          loadError: err.message || '加载详情失败，请重试'
        });
        wx.showToast({ title: err.message || '加载详情失败', icon: 'none' });
      });
  },

  onRetryDetail: function () {
    if (this.data.tournamentId) {
      this.loadDetail(this.data.tournamentId);
    }
  },

  /**
   * 处理受邀成为赛事副管理员逻辑
   */
  _handleInviteCode: function (tournamentId, inviteCode) {
    const self = this;
    const tourName = (this.data.detail && (this.data.detail.tournament_name || this.data.detail.name)) || '本赛事';

    const doAccept = function () {
      wx.showModal({
        title: '赛事副管理员邀请',
        content: '诚邀您成为【' + tourName + '】的副管理员，可协助录入比赛比分、修改开赛时间与场地。是否接受邀请？',
        confirmText: '接受邀请',
        cancelText: '暂不接受',
        confirmColor: '#2563eb',
        success: function (res) {
          if (res.confirm) {
            wx.showLoading({ title: '正在加入…' });
            let userInfo = {};
            try {
              const cached = wx.getStorageSync(STORAGE_USER_INFO_KEY);
              if (cached) {
                userInfo = {
                  nickname: cached.nickname || cached.nickName || '',
                  avatar_url: cached.avatar_url || cached.avatarUrl || ''
                };
              }
            } catch (e) {}

            acceptTournamentInvite(tournamentId, inviteCode, userInfo)
              .then(function (result) {
                wx.hideLoading();
                if (result && result.is_owner) {
                  wx.showModal({
                    title: '您是该赛事的创建人',
                    content:
                      '您是【' +
                      tourName +
                      '】的创建人本尊，已拥有最高管理与改分权限，无需作为副管理员重复加入。\n\n请将该邀请卡片分享给其他需要协助改分的微信好友或裁判员进行测试。',
                    showCancel: false,
                    confirmText: '我知道了',
                    confirmColor: '#2563eb'
                  });
                  return;
                }

                wx.showModal({
                  title: '🎉 加入成功',
                  content:
                    '您已成功成为【' +
                    tourName +
                    '】的副管理员！\n\n现在您可在下方赛程列表中长按任意比赛卡片，直接修改开赛时间、场地或录入完赛比分。',
                  showCancel: false,
                  confirmText: '我知道了',
                  confirmColor: '#2563eb',
                  success: function () {
                    self.loadDetail(tournamentId);
                  }
                });
              })
              .catch(function (err) {
                wx.hideLoading();
                wx.showModal({
                  title: '接受邀请失败',
                  content: err.message || '邀请码可能已失效或已被使用，请联系赛事创建人重新发起邀请。',
                  showCancel: false
                });
              });
          }
        }
      });
    };

    // 检查登录状态：若未登录则先引导快速授权登录
    const isLoggedIn = checkIsLoggedIn();
    if (!isLoggedIn) {
      wx.showModal({
        title: '需要微信授权',
        content: '加入【' + tourName + '】副管理员需要先完成微信登录以绑定身份，是否立即登录？',
        confirmText: '立即登录',
        confirmColor: '#2563eb',
        success: function (r) {
          if (r.confirm) {
            self._performQuickLogin('用于验证副管理员微信身份', function () {
              doAccept();
            });
          }
        }
      });
    } else {
      doAccept();
    }
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

  _performQuickLogin: function (descText, onSuccess) {
    wx.showLoading({ title: '授权登录中…', mask: true });
    wx.getUserProfile({
      desc: descText || '用于授权登录及保存您的偏好',
      success: function (profileRes) {
        wx.login({
          success: function (loginRes) {
            if (!loginRes.code) {
              wx.hideLoading();
              wx.showToast({ title: '获取登录凭证失败', icon: 'none' });
              return;
            }

            const rawData = profileRes.rawData || '';
            const signature = profileRes.signature || '';
            const encryptedData = profileRes.encryptedData || '';
            const iv = profileRes.iv || '';
            const ui = profileRes.userInfo || {};
            const nickName = (ui.nickName || '').trim();
            const avatarUrl = (ui.avatarUrl || '').trim();

            const loginPayload = {
              code: loginRes.code,
              rawData: rawData,
              signature: signature,
              encryptedData: encryptedData,
              iv: iv
            };
            if (nickName && nickName !== '微信用户') {
              loginPayload.nickName = nickName;
            }
            if (avatarUrl) {
              loginPayload.avatarUrl = avatarUrl;
            }

            post('/api/auth/login', loginPayload, { skipAuth: true })
              .then(function (body) {
                wx.hideLoading();
                const res = body || {};
                const data = res.data;

                if (res.code === 0 && data && typeof data === 'object') {
                  const token = data.token;
                  const userInfoRaw = data.userInfo;

                  if (token) {
                    setToken(token);
                  }

                  if (userInfoRaw && typeof userInfoRaw === 'object') {
                    const mergedUser = Object.assign({}, userInfoRaw);
                    if (ui.avatarUrl && !mergedUser.avatarUrl && !mergedUser.avatar_url) {
                      mergedUser.avatarUrl = ui.avatarUrl;
                    }

                    const app = getApp();
                    if (app) {
                      app.globalData.userInfo = mergedUser;
                    }
                    wx.setStorageSync(STORAGE_USER_INFO_KEY, mergedUser);
                    const validNick = (mergedUser.nickName || nickName || '').trim();
                    if (validNick && validNick !== '微信用户' && validNick !== 'WeChat User') {
                      try {
                        wx.setStorageSync('MIAOXIE_BROADCASTER_NICKNAME', validNick);
                      } catch (e) {}
                    }

                    // 管理员与实验功能白名单检查 (对轨 mine.js)
                    const inWhitelist = checkSyncLabWhitelist();
                    console.log('[QuickLogin] 登录成功, OpenID:', mergedUser.openid, 'isAdmin:', !!mergedUser.isAdmin, 'inWhitelist:', inWhitelist);
                  }

                  wx.showToast({ title: '登录成功', icon: 'success' });
                  if (typeof onSuccess === 'function') {
                    onSuccess();
                  }
                } else {
                  const msg = res.message || '登录失败';
                  wx.showToast({ title: msg, icon: 'none' });
                }
              })
              .catch(function (err) {
                wx.hideLoading();
                const msg = (err && err.message) || '网络连接失败';
                wx.showToast({ title: msg.length > 20 ? '登录失败' : msg, icon: 'none' });
              });
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

  _performQuickLoginAndPin: function (id) {
    const self = this;
    this._performQuickLogin('用于保存您的赛事置顶偏好', function () {
      self._doPinToggle(id);
    });
  },

  /**
   * 根据 sortField 与 sortOrder 对赛程数据列表进行排序
   */
  _sortMatches: function (list, field, order) {
    if (!Array.isArray(list) || list.length === 0) return [];
    if (!field || order === 'default') {
      return list;
    }

    const matchesCopy = list.slice();

    matchesCopy.sort(function (a, b) {
      if (field === 'time') {
        const timeA = String(a.start_time || (a.datePart + ' ' + a.timePart) || '').trim();
        const timeB = String(b.start_time || (b.datePart + ' ' + b.timePart) || '').trim();
        const res = timeA.localeCompare(timeB);
        return order === 'asc' ? res : -res;
      } else if (field === 'group') {
        const seqA = Number(a.match_seq || 0);
        const seqB = Number(b.match_seq || 0);
        if (seqA > 0 && seqB > 0 && seqA !== seqB) {
          return order === 'asc' ? seqA - seqB : seqB - seqA;
        }
        const stageA = String(a.stage_id || '');
        const stageB = String(b.stage_id || '');
        const res = stageA.localeCompare(stageB, 'zh-Hans-CN');
        return order === 'asc' ? res : -res;
      } else if (field === 'teams') {
        const nameA = String(a.display_team_a || a.team_a || '');
        const nameB = String(b.display_team_a || b.team_a || '');
        const res = nameA.localeCompare(nameB, 'zh-Hans-CN');
        return order === 'asc' ? res : -res;
      } else if (field === 'score') {
        const validA = a.hasValidScores ? 1 : 0;
        const validB = b.hasValidScores ? 1 : 0;
        if (validA !== validB) {
          return order === 'asc' ? validA - validB : validB - validA;
        }
        const scoreSumA = Number(a.score_a || 0) + Number(a.score_b || 0);
        const scoreSumB = Number(b.score_a || 0) + Number(b.score_b || 0);
        return order === 'asc' ? scoreSumA - scoreSumB : scoreSumB - scoreSumA;
      } else if (field === 'venue') {
        const venueA = String(a.venue || '');
        const venueB = String(b.venue || '');
        const res = venueA.localeCompare(venueB, 'zh-Hans-CN');
        return order === 'asc' ? res : -res;
      }
      return 0;
    });

    return matchesCopy;
  },

  /**
   * 表头列点击切换排序 (三态: 默认 -> 升序 ▲ -> 降序 ▼ -> 默认)
   */
  onSortColumn: function (e) {
    const field = e.currentTarget.dataset.field;
    if (!field) return;

    let sortField = this.data.sortField;
    let sortOrder = this.data.sortOrder;

    if (sortField !== field) {
      sortField = field;
      sortOrder = 'asc';
    } else {
      if (sortOrder === 'asc') {
        sortOrder = 'desc';
      } else if (sortOrder === 'desc') {
        sortField = '';
        sortOrder = 'default';
      } else {
        sortOrder = 'asc';
      }
    }

    this.setData({
      sortField: sortField,
      sortOrder: sortOrder
    });

    this._filterStageData(this.data.selectedStageId);
  },

  _filterStageData: function (stageId, matchesList, standingsMap) {
    const matches = matchesList || (this.data.formattedMatches || (this.data.detail ? this.data.detail.matches : []));
    const standings = standingsMap || (this.data.detail ? this.data.detail.standings : {});
    const activeTab = this.data.activeTab || 'schedule';

    let filteredMatches = matches;
    if (stageId && stageId !== 'all') {
      filteredMatches = matches.filter(function (m) {
        return (m.stage_id || 'stage_default') === stageId;
      });
    }

    const sortedMatches = this._sortMatches(filteredMatches, this.data.sortField, this.data.sortOrder);

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
      currentMatches: sortedMatches,
      currentStandings: filteredStandings,
      currentGroupedStandings: currentGroupedStandings
    });
  },

  /**
   * 赛程行点击事件：触发「复制比赛到直播记分」对话框
   */
  onMatchRowTap: function (e) {
    if (this._isLongPressing) {
      this._isLongPressing = false;
      return;
    }
    this.onOpenCopyMatchModal(e);
  },

  /**
   * 打开「复制比赛到直播记分」弹窗
   */
  onOpenCopyMatchModal: function (e) {
    const match = e.currentTarget.dataset.match;
    if (!match) return;

    const detail = this.data.detail || {};
    const rawSport = detail.sport_type || detail.sportType;
    const sportType = rawSport === 'soccer' ? 'football' : (rawSport === 'badminton' ? 'badminton' : 'basketball');

    const tournamentName = (detail.tournament_name || detail.name || '').trim();
    const stageId = (match.stage_id && match.stage_id !== 'stage_default') ? match.stage_id.trim() : '';
    const matchSeq = match.match_seq ? `#${match.match_seq} ` : '';
    const matchName = `${tournamentName} ${stageId}`.trim() || `${matchSeq}高光比赛`;

    const teamAName = String(match.display_team_a || match.team_a || '主队').trim();
    const teamBName = String(match.display_team_b || match.team_b || '客队').trim();

    let startDate = '';
    let startTime = '';
    if (match.start_time) {
      const parts = String(match.start_time).trim().split(/[\sT]+/);
      startDate = parts[0] || '';
      startTime = parts[1] ? parts[1].slice(0, 5) : '';
    }
    if (!startDate) {
      const d = new Date();
      const yr = d.getFullYear();
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      const da = String(d.getDate()).padStart(2, '0');
      startDate = `${yr}-${mo}-${da}`;
    }
    if (!startTime) {
      startTime = '19:00';
    }

    const timePickerValue = getTimePickerIndices(startTime);
    const hour = TIME_PICKER_RANGE[0][timePickerValue[0]];
    const minute = TIME_PICKER_RANGE[1][timePickerValue[1]];
    startTime = `${hour}:${minute}`;

    this.setData({
      showCopyModal: true,
      timePickerValue: timePickerValue,
      copyDraft: {
        sportType: sportType,
        matchName: matchName,
        teamAName: teamAName,
        teamBName: teamBName,
        startDate: startDate,
        startTime: startTime
      }
    });
  },

  onCloseCopyModal: function () {
    this.setData({ showCopyModal: false });
  },

  onStopPropagation: function () {
    // 阻止点击浮层面板事件冒泡至遮罩层
  },

  onCopySportChange: function (e) {
    const sport = e.currentTarget.dataset.sport;
    if (sport) {
      this.setData({ 'copyDraft.sportType': sport });
    }
  },

  onCopyStartDateChange: function (e) {
    this.setData({ 'copyDraft.startDate': e.detail.value });
  },

  onCopyTimePickerChange: function (e) {
    const val = e.detail.value || [0, 0];
    const hour = this.data.timePickerRange[0][val[0]] || '00';
    const minute = this.data.timePickerRange[1][val[1]] || '00';
    const timeStr = `${hour}:${minute}`;
    this.setData({
      timePickerValue: val,
      'copyDraft.startTime': timeStr
    });
  },

  onCopyMatchNameInput: function (e) {
    this.setData({ 'copyDraft.matchName': e.detail.value });
  },

  onCopyTeamANameInput: function (e) {
    this.setData({ 'copyDraft.teamAName': e.detail.value });
  },

  onCopyTeamBNameInput: function (e) {
    this.setData({ 'copyDraft.teamBName': e.detail.value });
  },

  /**
   * 确认复制比赛并写入本地直播记分存储
   */
  onConfirmCopyMatch: function () {
    const d = this.data.copyDraft;
    if (!d) return;

    const matchName = String(d.matchName || '').trim();
    const teamAName = String(d.teamAName || '').trim();
    const teamBName = String(d.teamBName || '').trim();

    if (!matchName) {
      wx.showToast({ title: '请填写比赛名称', icon: 'none' });
      return;
    }
    if (!teamAName) {
      wx.showToast({ title: '请填写主队名称', icon: 'none' });
      return;
    }
    if (!teamBName) {
      wx.showToast({ title: '请填写客队名称', icon: 'none' });
      return;
    }

    const startDateStr = d.startDate || '2026-01-01';
    const startTimeStr = d.startTime || '19:00';
    const startAt = Date.parse(`${startDateStr.replace(/-/g, '/')} ${startTimeStr}:00`) || Date.now();

    const sportType = d.sportType || 'basketball';
    const ts = Date.now();

    const newMatch = {
      id: String(ts),
      sportType: sportType,
      matchName: matchName,
      matchNameColor: '#FFFFFF',
      startAt: startAt,
      createdAt: ts,
      teamA: {
        name: teamAName,
        bgColor: '#E64340',
        textColor: '#FFFFFF',
        score: 0,
        currentSetScore: 0,
        subScores: []
      },
      teamB: {
        name: teamBName,
        bgColor: '#10AEFF',
        textColor: '#FFFFFF',
        score: 0,
        currentSetScore: 0,
        subScores: []
      },
      period: 0,
      isFinished: false,
      sportConfig: {
        periodMinutes: sportType === 'football' ? 45 : 10,
        periodCount: sportType === 'football' ? 2 : 4,
        foulLimit: 5,
        timeoutCount: 2,
        enable24Sec: false,
        enableExtraPeriod: true,
        extraPeriodMinutes: 5,
        extraTimeoutCount: 1
      },
      footballElapsedSec: 0,
      footballState: {
        clockPaused: true,
        clockWallMs: 0,
        extraMinutesHalf1: 0,
        extraMinutesHalf2: 0,
        extraMinutesExtra: 0,
        periodModel: 2
      },
      badmintonState: {
        servingTeam: 'A',
        servingZone: 'right',
        ruleType: 'single',
        maxSets: 3,
        pointsPerSet: 21,
        isScoreEnabled: true
      }
    };

    try {
      const existing = wx.getStorageSync('MIAOXIE_MATCHES') || [];
      const list = Array.isArray(existing) ? existing : [];
      list.unshift(newMatch);
      wx.setStorageSync('MIAOXIE_MATCHES', list);

      this.setData({
        showCopyModal: false
      });

      wx.showModal({
        title: '比赛创建成功',
        content: '已成功复制该比赛到直播记分，是否立即前往开始记分？',
        confirmText: '前往记分',
        cancelText: '继续浏览',
        confirmColor: '#2563EB',
        success: function (res) {
          if (res.confirm) {
            wx.switchTab({ url: '/pages/index/index' });
          }
        }
      });
    } catch (err) {
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  },

  /**
   * 长按比赛行触发编辑比分 Modal
   */
  onMatchLongPress: function (e) {
    const self = this;
    this._isLongPressing = true;
    setTimeout(function () {
      self._isLongPressing = false;
    }, 400);

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

    const rawTime = String(match.start_time || '').trim();
    let startDate = '';
    let startTime = '';
    if (rawTime) {
      const parts = rawTime.split(/[\sT]+/);
      if (parts[0]) {
        startDate = parts[0];
      }
      if (parts[1]) {
        startTime = parts[1].slice(0, 5);
      }
    }

    if (!startDate || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      startDate = y + '-' + m + '-' + d;
    }

    if (!startTime || !/^\d{2}:\d{2}$/.test(startTime)) {
      startTime = '00:00';
    }

    this.setData({
      showScoreModal: true,
      editingMatch: match,
      editTeamA: resolvedA || (match.team_a && !/^\d+胜|^\d+负/.test(match.team_a) ? match.team_a : ''),
      editTeamB: resolvedB || (match.team_b && !/^\d+胜|^\d+负/.test(match.team_b) ? match.team_b : ''),
      editVenue: match.venue || '',
      editStartDate: startDate,
      editStartTime: startTime,
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
      editVenue: '',
      editStartDate: '',
      editStartTime: '',
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

  onEditVenueInput: function (e) {
    this.setData({ editVenue: e.detail.value });
  },

  onEditDateChange: function (e) {
    this.setData({ editStartDate: e.detail.value });
  },

  onEditTimeChange: function (e) {
    this.setData({ editStartTime: e.detail.value });
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

    const venue = String(this.data.editVenue || '').trim();
    let startTimeStr = m.start_time || '';
    if (this.data.editStartDate && this.data.editStartTime) {
      startTimeStr = this.data.editStartDate + ' ' + this.data.editStartTime + ':00';
    }

    this.setData({ submittingScore: true });
    const payload = {
      action: 'upsert_match',
      data: {
        match_id: m.match_id,
        tournament_id: self.data.tournamentId,
        team_a: tA,
        team_b: tB,
        start_time: startTimeStr,
        stage_id: m.stage_id || 'stage_default',
        venue: venue,
        score_a: scoreA,
        score_b: scoreB,
        is_finished: isFinished
      }
    };

    oamUpsert(payload)
      .then(function () {
        wx.showToast({ title: '比赛信息更新成功', icon: 'success' });
        self.onCloseScoreModal();
        self.loadDetail(self.data.tournamentId);
      })
      .catch(function (err) {
        wx.showToast({ title: err.message || '保存失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ submittingScore: false });
      });
  },

  // ─────────────────────────────────────
  // 微信原生分享转发支持
  // ─────────────────────────────────────
  onShareAppMessage: function () {
    const detail = this.data.detail || {};
    const name = detail.tournament_name || '赛事详情';
    const activeTab = this.data.activeTab;
    const stageItem = (this.data.stageList || []).find(function (s) { return s.id === this.data.selectedStageId; }, this);
    const stageName = stageItem ? stageItem.name : '全部数据';
    const tabName = activeTab === 'schedule' ? '赛程表' : '积分排行榜';

    return {
      title: `【${name}】${stageName} · ${tabName}`,
      path: `/packagePromo/pages/tournament-detail/tournament-detail?id=${encodeURIComponent(this.data.tournamentId)}&tab=${activeTab}&stage=${encodeURIComponent(this.data.selectedStageId)}`,
      imageUrl: this.data.posterImgUrl || ''
    };
  },

  onShareTimeline: function () {
    const detail = this.data.detail || {};
    const name = detail.tournament_name || '赛事详情';
    const activeTab = this.data.activeTab;
    const stageItem = (this.data.stageList || []).find(function (s) { return s.id === this.data.selectedStageId; }, this);
    const stageName = stageItem ? stageItem.name : '全部数据';
    const tabName = activeTab === 'schedule' ? '赛程表' : '积分排行榜';

    return {
      title: `【${name}】${stageName} · ${tabName}`,
      query: `id=${encodeURIComponent(this.data.tournamentId)}&tab=${activeTab}&stage=${encodeURIComponent(this.data.selectedStageId)}`,
      imageUrl: this.data.posterImgUrl || ''
    };
  },

  // ─────────────────────────────────────
  // Canvas 2D 离屏精美海报生成逻辑 (带登录拦截检查)
  // ─────────────────────────────────────
  onGeneratePoster: function () {
    const isLoggedIn = checkIsLoggedIn();
    if (!isLoggedIn) {
      const self = this;
      wx.showModal({
        title: '登录后使用分享转发',
        content: '分享转发功能需要授权登录，登录后即可生成精美海报与分享赛况。',
        confirmText: '立即登录',
        cancelText: '暂不登录',
        confirmColor: '#2563eb',
        success: function (res) {
          if (res.confirm) {
            self._performQuickLoginAndPoster();
          }
        }
      });
      return;
    }

    this._doGeneratePoster();
  },

  _performQuickLoginAndPoster: function () {
    const self = this;
    this._performQuickLogin('用于生成与分享您的赛事战报', function () {
      self._doGeneratePoster();
    });
  },

  _doGeneratePoster: function () {
    const self = this;
    const activeTab = this.data.activeTab;
    const stageId = this.data.selectedStageId;
    const stageItem = (this.data.stageList || []).find(function (s) { return s.id === stageId; });
    const stageName = stageItem ? stageItem.name : '全部数据';

    this.setData({ selectedStageName: stageName });
    wx.showLoading({ title: '正在绘制精美海报…', mask: true });

    const canvasWidth = 720;
    let contentHeight = 0;

    if (activeTab === 'schedule') {
      const matches = this.data.currentMatches || [];
      const matchCount = Math.max(1, matches.length);
      contentHeight = 220 + 50 + 50 + (matchCount * 54) + 120;
    } else {
      const groups = this.data.currentGroupedStandings || [];
      let totalRows = 0;
      groups.forEach(function (g) {
        totalRows += (g.list ? g.list.length : 0);
      });
      const groupCount = Math.max(1, groups.length);
      contentHeight = 220 + 50 + (groupCount * 46) + (groupCount * 40) + (totalRows * 50) + 120;
    }

    const canvasHeight = Math.max(760, contentHeight);

    this.setData({
      posterCanvasWidth: canvasWidth,
      posterCanvasHeight: canvasHeight
    });

    setTimeout(function () {
      self._drawCanvas2DPoster(canvasWidth, canvasHeight);
    }, 120);
  },

  _drawCanvas2DPoster: function (width, height) {
    const self = this;
    const query = wx.createSelectorQuery().in(this);
    query.select('#posterCanvas')
      .fields({ node: true, size: true })
      .exec(function (res) {
        if (!res || !res[0] || !res[0].node) {
          wx.hideLoading();
          wx.showToast({ title: '创建 Canvas 失败', icon: 'none' });
          return;
        }

        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');

        const sys = wx.getSystemInfoSync ? wx.getSystemInfoSync() : {};
        const dpr = sys.pixelRatio || 2;

        canvas.width = width * dpr;
        canvas.height = height * dpr;
        ctx.scale(dpr, dpr);

        // 1. 全局背景：高质感轻柔倾斜渐变
        const bgGrad = ctx.createLinearGradient(0, 0, width, height);
        bgGrad.addColorStop(0, '#EEF6FF');
        bgGrad.addColorStop(0.5, '#E8F8F2');
        bgGrad.addColorStop(1, '#EFF6FF');
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, width, height);

        // 2. Header 顶部 Card：极简大气风格（只保留赛事名和视图徽章）
        const headerH = 150;
        const margin = 28;
        const headerW = width - margin * 2;

        ctx.save();
        ctx.shadowColor = 'rgba(37, 99, 235, 0.28)';
        ctx.shadowBlur = 24;
        ctx.shadowOffsetY = 10;

        const headerGrad = ctx.createLinearGradient(margin, 28, margin + headerW, 28 + headerH);
        headerGrad.addColorStop(0, '#1E40AF');
        headerGrad.addColorStop(0.5, '#2563EB');
        headerGrad.addColorStop(1, '#3B82F6');

        drawRoundedRect(ctx, margin, 28, headerW, headerH, 24, headerGrad);
        ctx.restore();

        // 装饰光晕点阵
        ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
        for (let i = 0; i < 5; i++) {
          ctx.beginPath();
          ctx.arc(margin + headerW - 50 + (i * 10), 28 + 26, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }

        // Header 视图徽章（胶囊标）
        const detail = self.data.detail || {};
        const tournamentName = detail.tournament_name || '赛事详情';
        const activeTab = self.data.activeTab;
        const stageName = self.data.selectedStageName || '全部数据';

        const badgeText = (activeTab === 'schedule' ? '📅 赛程表' : '🏆 积分排行榜') + ' · ' + stageName;
        ctx.font = 'bold 22px -apple-system, sans-serif';
        const badgeW = ctx.measureText(badgeText).width + 28;
        drawRoundedRect(ctx, margin + 24, 48, badgeW, 36, 12, 'rgba(255, 255, 255, 0.22)');
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(badgeText, margin + 38, 73);

        // Header 赛事名称 (加大加粗)
        ctx.font = 'bold 32px -apple-system, sans-serif';
        ctx.fillStyle = '#FFFFFF';
        const truncTitle = truncateText(ctx, tournamentName, headerW - 48);
        ctx.fillText(truncTitle, margin + 24, 130);

        // 3. 辅助 Meta 栏（项目 Icon、赛制、日期范围）：在 Header 下方以浅色清晰展现
        let curY = 28 + headerH + 24;
        ctx.font = '500 20px -apple-system, sans-serif';
        ctx.fillStyle = '#64748B';
        const sportLabel = detail.sport_type === 'soccer' ? '⚽ 足球' : '🏀 篮球';
        const formatLabel = detail.format === 'CUP' ? '赛会制' : '联赛制';
        const dateRange = (detail.start_date && detail.end_date) ? `📅 ${detail.start_date} ~ ${detail.end_date}` : '';
        const metaText = `${sportLabel}  |  ${formatLabel}  ${dateRange ? ' |  ' + dateRange : ''}`;
        ctx.fillText(metaText, margin + 6, curY);

        curY += 24;

        // 4. 绘制主体表格内容
        if (activeTab === 'schedule') {
          curY = self._drawScheduleTableOnCanvas(ctx, margin, curY, headerW);
        } else {
          curY = self._drawStandingsTableOnCanvas(ctx, margin, curY, headerW);
        }

        // 5. Footer 落款水印
        curY += 20;
        ctx.strokeStyle = '#CBD5E1';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(margin, curY);
        ctx.lineTo(margin + headerW, curY);
        ctx.stroke();

        curY += 34;
        ctx.font = 'bold 22px -apple-system, sans-serif';
        ctx.fillStyle = '#0F172A';
        ctx.fillText('高光记分 MATCH CENTER', margin + 6, curY);

        ctx.font = '500 18px -apple-system, sans-serif';
        ctx.fillStyle = '#94A3B8';
        ctx.fillText('长按或保存图片扫码查看实时赛况', margin + 6, curY + 26);

        // 6. 导出图片并展开 Modal 预览
        setTimeout(function () {
          wx.canvasToTempFilePath({
            canvas: canvas,
            destWidth: width * dpr,
            destHeight: height * dpr,
            fileType: 'png',
            quality: 1,
            success: function (r) {
              wx.hideLoading();
              self.setData({
                posterImgUrl: r.tempFilePath,
                showPosterModal: true
              });
            },
            fail: function (err) {
              wx.hideLoading();
              wx.showToast({ title: '导出图片失败', icon: 'none' });
            }
          }, self);
        }, 120);
      });
  },

  _drawScheduleTableOnCanvas: function (ctx, x, startY, width) {
    const matches = this.data.currentMatches || [];
    let curY = startY;

    if (!matches.length) {
      ctx.font = 'bold 22px -apple-system, sans-serif';
      ctx.fillStyle = '#94A3B8';
      ctx.fillText('暂无赛程安排', x + 16, curY + 40);
      return curY + 80;
    }

    const rowH = 50;
    const tableHeaderH = 42;
    const totalH = tableHeaderH + matches.length * rowH;

    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.05)';
    ctx.shadowBlur = 16;
    ctx.shadowOffsetY = 4;
    drawRoundedRect(ctx, x, curY, width, totalH, 20, '#FFFFFF');
    ctx.restore();

    // 表头
    drawRoundedRect(ctx, x, curY, width, tableHeaderH, 20, '#F1F5F9');
    ctx.font = 'bold 19px -apple-system, sans-serif';
    ctx.fillStyle = '#64748B';

    const colGroupX = x + 16;
    const colTeamsX = x + 100;
    const colScoreX = x + width - 250;
    const colTimeX = x + width - 145;
    const colVenueX = x + width - 65;

    ctx.fillText('组别', colGroupX, curY + 27);
    ctx.fillText('比赛队 (对阵)', colTeamsX, curY + 27);
    ctx.fillText('比分/状态', colScoreX, curY + 27);
    ctx.fillText('时间', colTimeX, curY + 27);
    ctx.fillText('场地', colVenueX, curY + 27);

    curY += tableHeaderH;

    for (let i = 0; i < matches.length; i++) {
      const m = matches[i];
      const rowY = curY;

      if (i % 2 === 1) {
        ctx.fillStyle = '#F8FAFC';
        ctx.fillRect(x + 2, rowY, width - 4, rowH);
      }

      if (i < matches.length - 1) {
        ctx.strokeStyle = '#F1F5F9';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x + 12, rowY + rowH);
        ctx.lineTo(x + width - 12, rowY + rowH);
        ctx.stroke();
      }

      // 组别
      ctx.font = 'bold 17px -apple-system, sans-serif';
      ctx.fillStyle = '#2563EB';
      const gTag = (m.stage_id && m.stage_id !== 'stage_default') ? m.stage_id : '常规赛';
      ctx.fillText(truncateText(ctx, gTag, 70), colGroupX, rowY + 31);

      // 对阵
      const teamA = m.display_team_a || m.team_a || '主队';
      const teamB = m.display_team_b || m.team_b || '客队';
      const winA = m.hasValidScores && m.score_a > m.score_b;
      const winB = m.hasValidScores && m.score_b > m.score_a;

      ctx.font = winA ? 'bold 19px -apple-system, sans-serif' : '500 19px -apple-system, sans-serif';
      ctx.fillStyle = winA ? '#059669' : '#0F172A';
      const truncA = truncateText(ctx, teamA, 105);
      ctx.fillText(truncA, colTeamsX, rowY + 31);

      const wA = ctx.measureText(truncA).width;
      ctx.font = '400 17px -apple-system, sans-serif';
      ctx.fillStyle = '#94A3B8';
      ctx.fillText(' vs ', colTeamsX + wA, rowY + 31);
      const wVs = ctx.measureText(' vs ').width;

      ctx.font = winB ? 'bold 19px -apple-system, sans-serif' : '500 19px -apple-system, sans-serif';
      ctx.fillStyle = winB ? '#059669' : '#0F172A';
      const truncB = truncateText(ctx, teamB, 105);
      ctx.fillText(truncB, colTeamsX + wA + wVs, rowY + 31);

      // 比分 / 待录入 / 未开始
      if (m.hasValidScores) {
        ctx.font = 'bold 20px -apple-system, sans-serif';
        ctx.fillStyle = '#0F172A';
        ctx.fillText(`${m.score_a} : ${m.score_b}`, colScoreX, rowY + 31);
      } else if (m.isPendingScore) {
        ctx.font = 'bold 17px -apple-system, sans-serif';
        ctx.fillStyle = '#D97706';
        ctx.fillText('待录入', colScoreX, rowY + 31);
      } else {
        ctx.font = '600 17px -apple-system, sans-serif';
        ctx.fillStyle = '#94A3B8';
        ctx.fillText('未开始', colScoreX, rowY + 31);
      }

      // 时间
      ctx.font = '500 17px -apple-system, sans-serif';
      ctx.fillStyle = '#64748B';
      const timeStr = `${m.datePart || ''} ${m.timePart || ''}`.trim() || '—';
      ctx.fillText(truncateText(ctx, timeStr, 75), colTimeX, rowY + 31);

      // 场地
      ctx.font = '500 17px -apple-system, sans-serif';
      ctx.fillStyle = '#64748B';
      ctx.fillText(truncateText(ctx, m.venue || '—', 60), colVenueX, rowY + 31);

      curY += rowH;
    }

    return curY;
  },

  _drawStandingsTableOnCanvas: function (ctx, x, startY, width) {
    const groups = this.data.currentGroupedStandings || [];
    let curY = startY;

    if (!groups.length) {
      ctx.font = 'bold 22px -apple-system, sans-serif';
      ctx.fillStyle = '#94A3B8';
      ctx.fillText('暂无排行榜数据', x + 16, curY + 40);
      return curY + 80;
    }

    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const g = groups[gIdx];
      const list = g.list || [];
      const rowH = 46;
      const titleH = 38;
      const headerH = 38;
      const totalH = titleH + headerH + list.length * rowH;

      ctx.save();
      ctx.shadowColor = 'rgba(15, 23, 42, 0.05)';
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 4;
      drawRoundedRect(ctx, x, curY, width, totalH, 20, '#FFFFFF');
      ctx.restore();

      // 小组卡片头
      drawRoundedRect(ctx, x, curY, width, titleH, 20, '#EFF6FF');
      ctx.font = 'bold 20px -apple-system, sans-serif';
      ctx.fillStyle = '#1D4ED8';
      const gTitle = `🏆 ${g.stage_name === 'all' ? '全组' : g.stage_name} 积分榜`;
      ctx.fillText(gTitle, x + 18, curY + 25);

      curY += titleH;

      // 表头
      ctx.fillStyle = '#F8FAFC';
      ctx.fillRect(x + 2, curY, width - 4, headerH);
      ctx.font = 'bold 19px -apple-system, sans-serif';
      ctx.fillStyle = '#64748B';

      const colRankX = x + 18;
      const colTeamX = x + 85;
      const colPlayedX = x + width - 260;
      const colWdlX = x + width - 185;
      const colNetX = x + width - 100;
      const colPtsX = x + width - 45;

      ctx.fillText('排名', colRankX, curY + 25);
      ctx.fillText('球队', colTeamX, curY + 25);
      ctx.fillText('已赛', colPlayedX, curY + 25);
      ctx.fillText('胜/平/负', colWdlX, curY + 25);
      ctx.fillText('净胜', colNetX, curY + 25);
      ctx.fillText('积分', colPtsX, curY + 25);

      curY += headerH;

      for (let rIdx = 0; rIdx < list.length; rIdx++) {
        const item = list[rIdx];
        const rowY = curY;

        if (rIdx % 2 === 1) {
          ctx.fillStyle = '#F8FAFC';
          ctx.fillRect(x + 2, rowY, width - 4, rowH);
        }

        if (rIdx < list.length - 1) {
          ctx.strokeStyle = '#F1F5F9';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + 12, rowY + rowH);
          ctx.lineTo(x + width - 12, rowY + rowH);
          ctx.stroke();
        }

        // 排名 Badge
        const rank = item.rank || (rIdx + 1);
        if (rank === 1) {
          ctx.font = 'bold 19px -apple-system, sans-serif';
          ctx.fillStyle = '#D97706';
          ctx.fillText('🥇 1', colRankX - 4, rowY + 28);
        } else if (rank === 2) {
          ctx.font = 'bold 19px -apple-system, sans-serif';
          ctx.fillStyle = '#64748B';
          ctx.fillText('🥈 2', colRankX - 4, rowY + 28);
        } else if (rank === 3) {
          ctx.font = 'bold 19px -apple-system, sans-serif';
          ctx.fillStyle = '#B45309';
          ctx.fillText('🥉 3', colRankX - 4, rowY + 28);
        } else {
          ctx.font = '600 19px -apple-system, sans-serif';
          ctx.fillStyle = '#64748B';
          ctx.fillText(String(rank), colRankX + 4, rowY + 28);
        }

        // 球队
        ctx.font = 'bold 19px -apple-system, sans-serif';
        ctx.fillStyle = '#0F172A';
        ctx.fillText(truncateText(ctx, item.team_name || '', 160), colTeamX, rowY + 28);

        // 已赛
        ctx.font = '500 19px -apple-system, sans-serif';
        ctx.fillStyle = '#475569';
        ctx.fillText(String(item.played || 0), colPlayedX + 4, rowY + 28);

        // 胜/平/负
        const wdlStr = `${item.won || 0}/${item.draw || 0}/${item.lost || 0}`;
        ctx.fillText(wdlStr, colWdlX, rowY + 28);

        // 净胜分
        const net = Number(item.net_score || 0);
        const netStr = net > 0 ? `+${net}` : String(net);
        ctx.fillStyle = net > 0 ? '#059669' : (net < 0 ? '#DC2626' : '#475569');
        ctx.fillText(netStr, colNetX, rowY + 28);

        // 积分
        ctx.font = 'bold 22px -apple-system, sans-serif';
        ctx.fillStyle = '#2563EB';
        ctx.fillText(String(item.points || 0), colPtsX, rowY + 28);

        curY += rowH;
      }

      curY += 20;
    }

    return curY;
  },

  onClosePosterModal: function () {
    this.setData({ showPosterModal: false });
  },

  onSavePosterToAlbum: function () {
    const self = this;
    if (!this.data.posterImgUrl) {
      wx.showToast({ title: '海报图片未就绪', icon: 'none' });
      return;
    }

    wx.saveImageToPhotosAlbum({
      filePath: self.data.posterImgUrl,
      success: function () {
        wx.showToast({ title: '已保存至手机相册', icon: 'success' });
      },
      fail: function (err) {
        if (err.errMsg && err.errMsg.includes('auth deny')) {
          wx.showModal({
            title: '授权提示',
            content: '需要保存图片到相册的权限，请在设置中开启',
            confirmText: '去开启',
            success: function (res) {
              if (res.confirm) {
                wx.openSetting();
              }
            }
          });
        } else {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      }
    });
  },

  /**
   * 调起微信原生分享/相册保存发朋友圈接口 (wx.showShareImageMenu)
   */
  onShareToTimelineDirect: function () {
    const filePath = this.data.posterImgUrl;
    if (!filePath) {
      wx.showToast({ title: '海报图片未就绪', icon: 'none' });
      return;
    }

    if (wx.showShareImageMenu) {
      wx.showShareImageMenu({
        path: filePath,
        success: function () {
          wx.showToast({ title: '已打开分享', icon: 'success' });
        },
        fail: function (err) {
          if (err && err.errMsg && err.errMsg.indexOf('cancel') >= 0) return;
          wx.saveImageToPhotosAlbum({
            filePath: filePath,
            success: function () {
              wx.showToast({ title: '海报已存入相册，可直接发布朋友圈', icon: 'none', duration: 2500 });
            }
          });
        }
      });
    } else {
      wx.saveImageToPhotosAlbum({
        filePath: filePath,
        success: function () {
          wx.showToast({ title: '海报已存入相册，可直接发布朋友圈', icon: 'none', duration: 2500 });
        }
      });
    }
  }
});
