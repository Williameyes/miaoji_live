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

Page({
  data: {
    statusBarHeight: 20,
    tournamentId: '',
    detail: null,
    loading: true,
    isPinned: false,
    activeTab: 'schedule', // schedule | standings
    selectedStageId: 'stage_default',
    stageList: [],
    currentMatches: [],
    currentStandings: [],
    
    // 比分修改 Modal
    showScoreModal: false,
    editingMatch: null,
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
        let stages = detail.stages || [];
        if (!stages.length) {
          stages = [{ id: 'stage_default', name: '常规赛/循环赛', type: 'GROUP' }];
        }

        const rawMatches = detail.matches || [];
        const formattedMatches = rawMatches.map(function (m) {
          let timeText = m.start_time || '';
          if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}/.test(timeText)) {
            timeText = timeText.slice(5, 16);
          }
          const hasScoreA = m.score_a !== null && m.score_a !== undefined && m.score_a !== 'null' && m.score_a !== '';
          const hasScoreB = m.score_b !== null && m.score_b !== undefined && m.score_b !== 'null' && m.score_b !== '';
          const hasValidScores = hasScoreA && hasScoreB;

          return Object.assign({}, m, {
            displayTime: timeText,
            team_a: String(m.team_a || '主队').replace(/null/g, ''),
            team_b: String(m.team_b || '客队').replace(/null/g, ''),
            score_a: hasScoreA ? Number(m.score_a) : 0,
            score_b: hasScoreB ? Number(m.score_b) : 0,
            hasValidScores: hasValidScores
          });
        });

        const standings = detail.standings || {};

        const stageId = self.data.selectedStageId || stages[0].id;
        const pinned = isTournamentPinned(id);
        
        self.setData({
          detail: detail,
          stageList: stages,
          selectedStageId: stageId,
          isPinned: pinned,
          loading: false
        });

        self._filterStageData(stageId, formattedMatches, standings);
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
    const matches = matchesList || (this.data.detail ? this.data.detail.matches : []);
    const standings = standingsMap || (this.data.detail ? this.data.detail.standings : {});

    let filteredMatches = matches;
    if (stageId && stageId !== 'all') {
      filteredMatches = matches.filter(function (m) {
        return (m.stage_id || 'stage_default') === stageId;
      });
    }

    const filteredStandings = standings[stageId] || standings['stage_default'] || [];

    this.setData({
      currentMatches: filteredMatches,
      currentStandings: filteredStandings
    });
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
    this.setData({ activeTab: tab });
  },

  onStageSwitch: function (e) {
    const stageId = e.currentTarget.dataset.stage;
    this.setData({ selectedStageId: stageId });
    this._filterStageData(stageId);
  },

  // 展开修改比分 Modal (所有者权限)
  onEditMatchScore: function (e) {
    const match = e.currentTarget.dataset.match;
    if (!match) return;
    this.setData({
      showScoreModal: true,
      editingMatch: match,
      scoreA: match.score_a !== null && match.score_a !== undefined ? String(match.score_a) : '',
      scoreB: match.score_b !== null && match.score_b !== undefined ? String(match.score_b) : ''
    });
  },

  onCloseScoreModal: function () {
    this.setData({
      showScoreModal: false,
      editingMatch: null,
      scoreA: '',
      scoreB: ''
    });
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

    const sA = String(this.data.scoreA || '').trim();
    const sB = String(this.data.scoreB || '').trim();

    if (sA === '' || sB === '' || isNaN(Number(sA)) || isNaN(Number(sB))) {
      wx.showToast({ title: '请输入有效的数字比分', icon: 'none' });
      return;
    }

    this.setData({ submittingScore: true });
    const payload = {
      action: 'upsert_match',
      data: {
        match_id: m.match_id,
        tournament_id: self.data.tournamentId,
        team_a: m.team_a,
        team_b: m.team_b,
        start_time: m.start_time,
        stage_id: m.stage_id || 'stage_default',
        venue: m.venue || '',
        score_a: Number(sA),
        score_b: Number(sB),
        is_finished: 1
      }
    };

    oamUpsert(payload)
      .then(function () {
        wx.showToast({ title: '比分更新成功', icon: 'success' });
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
