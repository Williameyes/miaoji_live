/**
 * @fileoverview 赛事新建/编辑（服务端拉取与保存）。
 */

const { ensureRadarLabAccess } = require('../../../../utils/radar-access.js');
const { oamUpsert, fetchTournamentList } = require('../../../../services/radar-api.js');
const { timestampToDateStr } = require('../../../../utils/radar-datetime.js');

Page({
  data: {
    tournaments: [],
    pickerIndex: 0,
    isCreatingNew: true,
    tournamentId: '',
    tournamentName: '',
    startDate: '',
    endDate: '',
    sportTypes: [
      { key: 'basketball', label: '篮球 (胜2/负1)' },
      { key: 'soccer', label: '足球 (胜3/平1/负0)' },
      { key: 'custom', label: '自定义规则' }
    ],
    sportTypeIndex: 0,
    formats: [
      { key: 'LEAGUE', label: '联赛制 (循环赛)' },
      { key: 'CUP', label: '赛会制 (分组+淘汰赛)' }
    ],
    formatIndex: 0,
    submitting: false,
    loading: true
  },

  /**
   * @param {Record<string, string>} query
   * @returns {void}
   */
  onLoad: function (query) {
    if (!ensureRadarLabAccess({ redirectBack: true })) return;
    const editId = query && query.id ? String(query.id) : '';
    const forceNew = query && query.mode === 'new';
    const self = this;
    fetchTournamentList()
      .then(function (tournaments) {
        if (forceNew) {
          self._loadForm(tournaments, '', true);
          self.setData({ loading: false });
          return;
        }
        let isNew = !editId && !tournaments.length;
        let loadId = editId;
        if (!editId && tournaments.length) {
          loadId = tournaments[0].id;
          isNew = false;
        }
        self._loadForm(tournaments, loadId, isNew);
        self.setData({ loading: false });
      })
      .catch(function (err) {
        self.setData({ loading: false });
        wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      });
  },

  /**
   * @param {Array} tournaments
   * @param {string} tournamentId
   * @param {boolean} isNew
   * @returns {void}
   */
  _loadForm: function (tournaments, tournamentId, isNew) {
    const now = timestampToDateStr(Date.now());
    let pickerIndex = 0;
    let name = '';
    let startDate = now;
    let endDate = now;
    let sportTypeIndex = 0;
    let formatIndex = 0;
    if (!isNew && tournamentId) {
      pickerIndex = tournaments.findIndex(function (t) {
        return String(t.id) === tournamentId;
      });
      if (pickerIndex < 0) pickerIndex = 0;
      const item = tournaments[pickerIndex];
      if (item) {
        name = item.name;
        startDate = item.startDate || now;
        endDate = item.endDate || now;
        tournamentId = String(item.id);
        if (item.sportType === 'soccer') sportTypeIndex = 1;
        else if (item.sportType === 'custom') sportTypeIndex = 2;
        if (item.format === 'CUP') formatIndex = 1;
      }
    }
    this.setData({
      tournaments: tournaments,
      pickerIndex: pickerIndex,
      isCreatingNew: isNew,
      tournamentId: tournamentId,
      tournamentName: name,
      startDate: startDate,
      endDate: endDate,
      sportTypeIndex: sportTypeIndex,
      formatIndex: formatIndex
    });
  },

  /**
   * @param {WechatMiniprogram.PickerChange} e
   * @returns {void}
   */
  onTournamentPick: function (e) {
    const idx = Number(e.detail.value);
    const list = this.data.tournaments;
    const item = list[idx];
    if (!item) return;
    this._loadForm(list, String(item.id), false);
  },

  /**
   * @returns {void}
   */
  onCreateNew: function () {
    const now = timestampToDateStr(Date.now());
    this.setData({
      isCreatingNew: true,
      tournamentId: '',
      tournamentName: '',
      startDate: now,
      endDate: now,
      sportTypeIndex: 0,
      formatIndex: 0
    });
  },

  /**
   * @param {WechatMiniprogram.Input} e
   * @returns {void}
   */
  onNameInput: function (e) {
    this.setData({ tournamentName: e.detail.value });
  },

  /**
   * @param {WechatMiniprogram.PickerChange} e
   * @returns {void}
   */
  onStartDateChange: function (e) {
    this.setData({ startDate: e.detail.value });
  },

  /**
   * @param {WechatMiniprogram.PickerChange} e
   * @returns {void}
   */
  onEndDateChange: function (e) {
    this.setData({ endDate: e.detail.value });
  },

  onSportTypeChange: function (e) {
    this.setData({ sportTypeIndex: Number(e.detail.value) });
  },

  onFormatChange: function (e) {
    this.setData({ formatIndex: Number(e.detail.value) });
  },

  /**
   * @returns {void}
   */
  onSave: function () {
    const self = this;
    if (!ensureRadarLabAccess()) return;
    const d = this.data;
    if (!d.tournamentName.trim() || !d.startDate || !d.endDate) {
      wx.showToast({ title: '请填写完整信息', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    const selectedSport = d.sportTypes[d.sportTypeIndex] ? d.sportTypes[d.sportTypeIndex].key : 'basketball';
    const selectedFormat = d.formats[d.formatIndex] ? d.formats[d.formatIndex].key : 'LEAGUE';
    const payload = {
      action: 'upsert_tournament',
      data: {
        tournament_name: d.tournamentName.trim(),
        start_date: d.startDate,
        end_date: d.endDate,
        sport_type: selectedSport,
        format: selectedFormat
      }
    };
    if (d.tournamentId && !d.isCreatingNew) {
      payload.data.tournament_id = d.tournamentId;
    }
    oamUpsert(payload)
      .then(function () {
        wx.showToast({ title: '赛事已保存', icon: 'success' });
        setTimeout(function () {
          wx.navigateBack();
        }, 400);
      })
      .catch(function (err) {
        wx.showToast({ title: err.message || '保存失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ submitting: false });
      });
  }
});
