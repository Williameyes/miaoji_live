/**
 * @fileoverview C端赛事详情与排行榜页面 (包含赛程与所有者比分修改)
 */
const { fetchTournamentDetail, oamUpsert } = require('../../../services/tournament-api.js');

Page({
  data: {
    statusBarHeight: 20,
    tournamentId: '',
    detail: null,
    loading: true,
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
        
        self.setData({
          detail: detail,
          stageList: stages,
          selectedStageId: stageId,
          loading: false
        });

        self._filterStageData(stageId, formattedMatches, standings);
      })
      .catch(function (err) {
        self.setData({ loading: false });
        wx.showToast({ title: err.message || '加载详情失败', icon: 'none' });
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
