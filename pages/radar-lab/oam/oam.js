/**
 * @fileoverview 雷达 OAM 维护：赛事 / 场次 / 主播单条增改与 Excel 批量导入。
 */

const { ensureRadarLabAccess } = require('../../../utils/radar-access.js');
const { oamUpsert } = require('../../../services/radar-api.js');
const {
  readAssets,
  upsertTournament,
  upsertMatch,
  upsertAnchor,
  listMatchesByTournament
} = require('../../../utils/radar-local-store.js');
const { parseMatchExcelBuffer } = require('../../../utils/radar-excel-parser.js');

/** @type {Record<string, string>} */
const TAB_LABELS = {
  tournament: '赛事',
  match: '场次',
  anchor: '主播',
  batch: '批量'
};

Page({
  data: {
    activeTab: 'tournament',
    tabLabels: TAB_LABELS,
    tournaments: [],
    matches: [],
    selectedTournamentId: '',
    submitting: false,
    tournamentForm: {
      tournament_id: '',
      tournament_name: '',
      start_date: '',
      end_date: ''
    },
    matchForm: {
      match_id: '',
      tournament_id: '',
      team_a: '',
      team_b: '',
      start_time: ''
    },
    anchorForm: {
      sec_user_id: '',
      anchor_name: '',
      live_url: ''
    },
    batchTournamentId: ''
  },

  /**
   * 页面加载。
   * @returns {void}
   */
  onLoad: function () {
    if (!ensureRadarLabAccess({ redirectBack: true })) return;
    this._reloadLocal();
  },

  /**
   * 刷新本地资产列表。
   * @returns {void}
   */
  _reloadLocal: function () {
    const assets = readAssets();
    const selectedTournamentId =
      this.data.selectedTournamentId ||
      (assets.tournaments[0] ? String(assets.tournaments[0].id) : '');
    const matches = selectedTournamentId
      ? listMatchesByTournament(selectedTournamentId)
      : assets.matches;
    this.setData({
      tournaments: assets.tournaments,
      matches: matches,
      selectedTournamentId: selectedTournamentId,
      'matchForm.tournament_id': selectedTournamentId,
      batchTournamentId: selectedTournamentId
    });
  },

  /**
   * 切换 Tab。
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onTabTap: function (e) {
    const tab = e.currentTarget.dataset.tab;
    if (!tab) return;
    this.setData({ activeTab: tab });
  },

  /**
   * 选择当前赛事（筛选场次 / 批量导入）。
   * @param {WechatMiniprogram.PickerChange} e
   * @returns {void}
   */
  onTournamentPicker: function (e) {
    const idx = Number(e.detail.value);
    const list = this.data.tournaments;
    const item = list[idx];
    if (!item) return;
    const tid = String(item.id);
    this.setData({
      selectedTournamentId: tid,
      'matchForm.tournament_id': tid,
      batchTournamentId: tid,
      matches: listMatchesByTournament(tid)
    });
  },

  /**
   * 表单字段输入。
   * @param {WechatMiniprogram.Input} e
   * @returns {void}
   */
  onFormInput: function (e) {
    const form = e.currentTarget.dataset.form;
    const field = e.currentTarget.dataset.field;
    if (!form || !field) return;
    const key = form + 'Form.' + field;
    this.setData({ [key]: e.detail.value });
  },

  /**
   * 提交赛事 upsert。
   * @returns {void}
   */
  onSubmitTournament: function () {
    const self = this;
    if (!ensureRadarLabAccess()) return;
    const f = this.data.tournamentForm;
    if (!f.tournament_name || !f.start_date || !f.end_date) {
      wx.showToast({ title: '请填写完整赛事信息', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    const payload = {
      action: 'upsert_tournament',
      data: {
        tournament_name: f.tournament_name.trim(),
        start_date: f.start_date.trim(),
        end_date: f.end_date.trim()
      }
    };
    if (f.tournament_id) {
      payload.data.tournament_id = f.tournament_id;
    }
    oamUpsert(payload)
      .then(function (res) {
        const id = String(res.affected_id || f.tournament_id || '');
        upsertTournament({
          id: id,
          name: f.tournament_name.trim(),
          startDate: f.start_date.trim(),
          endDate: f.end_date.trim(),
          updatedAt: Date.now()
        });
        wx.showToast({ title: '赛事已同步', icon: 'success' });
        self.setData({
          tournamentForm: {
            tournament_id: id,
            tournament_name: f.tournament_name,
            start_date: f.start_date,
            end_date: f.end_date
          }
        });
        self._reloadLocal();
      })
      .catch(function (err) {
        wx.showToast({ title: err.message || '同步失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ submitting: false });
      });
  },

  /**
   * 提交场次 upsert。
   * @returns {void}
   */
  onSubmitMatch: function () {
    const self = this;
    if (!ensureRadarLabAccess()) return;
    const f = this.data.matchForm;
    if (!f.tournament_id || !f.team_a || !f.team_b || !f.start_time) {
      wx.showToast({ title: '请填写完整场次信息', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    const payload = {
      action: 'upsert_match',
      data: {
        tournament_id: f.tournament_id,
        team_a: f.team_a.trim(),
        team_b: f.team_b.trim(),
        start_time: f.start_time.trim()
      }
    };
    if (f.match_id) {
      payload.data.match_id = f.match_id;
    }
    oamUpsert(payload)
      .then(function (res) {
        const id = String(res.affected_id || f.match_id || '');
        upsertMatch({
          id: id,
          tournamentId: String(f.tournament_id),
          teamA: f.team_a.trim(),
          teamB: f.team_b.trim(),
          startTime: f.start_time.trim(),
          updatedAt: Date.now()
        });
        wx.showToast({ title: '场次已同步', icon: 'success' });
        self.setData({
          matchForm: {
            match_id: id,
            tournament_id: f.tournament_id,
            team_a: f.team_a,
            team_b: f.team_b,
            start_time: f.start_time
          }
        });
        self._reloadLocal();
      })
      .catch(function (err) {
        wx.showToast({ title: err.message || '同步失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ submitting: false });
      });
  },

  /**
   * 提交主播 upsert。
   * @returns {void}
   */
  onSubmitAnchor: function () {
    const self = this;
    if (!ensureRadarLabAccess()) return;
    const f = this.data.anchorForm;
    if (!f.sec_user_id || !f.anchor_name) {
      wx.showToast({ title: '请填写主播 ID 与名称', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    oamUpsert({
      action: 'upsert_anchor',
      data: {
        sec_user_id: f.sec_user_id.trim(),
        anchor_name: f.anchor_name.trim(),
        live_url: (f.live_url || '').trim()
      }
    })
      .then(function () {
        upsertAnchor({
          secUserId: f.sec_user_id.trim(),
          anchorName: f.anchor_name.trim(),
          liveUrl: (f.live_url || '').trim(),
          updatedAt: Date.now()
        });
        wx.showToast({ title: '主播已同步', icon: 'success' });
      })
      .catch(function (err) {
        wx.showToast({ title: err.message || '同步失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ submitting: false });
      });
  },

  /**
   * 从微信聊天记录选择 Excel 并批量导入场次。
   * @returns {void}
   */
  onChooseExcel: function () {
    const self = this;
    if (!ensureRadarLabAccess()) return;
    const tournamentId = this.data.batchTournamentId;
    if (!tournamentId) {
      wx.showToast({ title: '请先创建并选择赛事', icon: 'none' });
      return;
    }
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['xlsx', 'xls', 'csv'],
      success: function (res) {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file || !file.path) return;
        const fs = wx.getFileSystemManager();
        fs.readFile({
          filePath: file.path,
          success: function (readRes) {
            self._importExcelBuffer(readRes.data, file.name, tournamentId);
          },
          fail: function () {
            wx.showToast({ title: '读取文件失败', icon: 'none' });
          }
        });
      }
    });
  },

  /**
   * 解析 Excel 并提交 batch_import_matches。
   * @param {ArrayBuffer} buffer
   * @param {string} fileName
   * @param {string} tournamentId
   * @returns {void}
   */
  _importExcelBuffer: function (buffer, fileName, tournamentId) {
    const self = this;
    let rows;
    try {
      rows = parseMatchExcelBuffer(buffer, fileName);
    } catch (err) {
      wx.showToast({ title: err.message || '解析失败', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '确认导入',
      content: '将导入 ' + rows.length + ' 条场次，是否继续？',
      success: function (modalRes) {
        if (!modalRes.confirm) return;
        self.setData({ submitting: true });
        oamUpsert({
          action: 'batch_import_matches',
          tournament_id: tournamentId,
          matches_list: rows
        })
          .then(function () {
            wx.showToast({ title: '已导入 ' + rows.length + ' 场', icon: 'success' });
            self._reloadLocal();
          })
          .catch(function (err) {
            wx.showToast({ title: err.message || '导入失败', icon: 'none' });
          })
          .finally(function () {
            self.setData({ submitting: false });
          });
      }
    });
  },

  /**
   * 点击场次进入监控页。
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onOpenMonitor: function (e) {
    const matchId = e.currentTarget.dataset.id;
    if (!matchId) return;
    wx.navigateTo({
      url: '/pages/radar-lab/monitor/monitor?match_id=' + encodeURIComponent(matchId)
    });
  },

  /**
   * 编辑已有场次到表单。
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onEditMatch: function (e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.matches.find(function (m) {
      return String(m.id) === String(id);
    });
    if (!item) return;
    this.setData({
      activeTab: 'match',
      matchForm: {
        match_id: String(item.id),
        tournament_id: String(item.tournamentId),
        team_a: item.teamA,
        team_b: item.teamB,
        start_time: item.startTime
      }
    });
  }
});
