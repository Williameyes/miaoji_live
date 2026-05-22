/**
 * @fileoverview 雷达 OAM 场次列表主页（数据来自服务端列表接口）。
 */

const { ensureRadarLabAccess } = require('../../../utils/radar-access.js');
const {
  oamUpsert,
  fetchTournamentList,
  fetchMatchList
} = require('../../../services/radar-api.js');
const { formatStartTimeDisplay } = require('../../../utils/radar-datetime.js');
const { parseMatchExcelBuffer } = require('../../../utils/radar-excel-parser.js');

Page({
  data: {
    filterOptions: [{ id: 'all', name: '全部赛事' }],
    filterIndex: 0,
    selectedTournamentId: 'all',
    matchRows: [],
    submitting: false,
    loading: false
  },

  /**
   * @returns {void}
   */
  onLoad: function () {
    if (!ensureRadarLabAccess({ redirectBack: true })) return;
  },

  /**
   * @returns {void}
   */
  onShow: function () {
    this._reloadList();
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
    const selectedId = this.data.selectedTournamentId;
    return fetchTournamentList()
      .then(function (tournaments) {
        const filterOptions = [{ id: 'all', name: '全部赛事' }].concat(
          tournaments.map(function (t) {
            return { id: t.id, name: t.name };
          })
        );
        let filterIndex = filterOptions.findIndex(function (o) {
          return o.id === selectedId;
        });
        if (filterIndex < 0) filterIndex = 0;
        const tournamentId = filterOptions[filterIndex].id;
        return fetchMatchList({
          tournamentId: tournamentId === 'all' ? '' : tournamentId
        }).then(function (matches) {
          const matchRows = matches.map(function (m) {
            return {
              id: m.id,
              teamA: m.teamA,
              teamB: m.teamB,
              startTimeText: formatStartTimeDisplay(m.startTime),
              tournamentName: m.tournamentName || '—'
            };
          });
          self.setData({
            filterOptions: filterOptions,
            filterIndex: filterIndex,
            selectedTournamentId: tournamentId,
            matchRows: matchRows,
            loading: false
          });
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
   * @param {WechatMiniprogram.PickerChange} e
   * @returns {void}
   */
  onFilterChange: function (e) {
    const idx = Number(e.detail.value);
    const opt = this.data.filterOptions[idx];
    if (!opt) return;
    this.setData({ filterIndex: idx, selectedTournamentId: opt.id });
    this._reloadList();
  },

  /**
   * @returns {void}
   */
  onPlusTap: function () {
    const self = this;
    wx.showActionSheet({
      itemList: ['新增场次', 'Excel 批量导入'],
      success: function (res) {
        if (res.tapIndex === 0) self.onNewMatch();
        else if (res.tapIndex === 1) self.onBatchImport();
      }
    });
  },

  /**
   * @returns {string | null}
   */
  _resolveImportTournamentId: function () {
    if (this.data.selectedTournamentId !== 'all') {
      return this.data.selectedTournamentId;
    }
    return null;
  },

  /**
   * @returns {string}
   */
  _currentFilterTournamentName: function () {
    const opt = this.data.filterOptions[this.data.filterIndex];
    return opt ? opt.name : '';
  },

  /**
   * @returns {void}
   */
  onNewMatch: function () {
    if (!ensureRadarLabAccess()) return;
    const options = this.data.filterOptions.filter(function (o) {
      return o.id !== 'all';
    });
    if (!options.length) {
      wx.showModal({
        title: '请先创建赛事',
        content: '场次需要归属到一个赛事，是否现在去创建？',
        confirmText: '去创建',
        success: function (res) {
          if (res.confirm) {
            wx.navigateTo({
              url: '/pages/radar-lab/oam/tournament-list/tournament-list'
            });
          }
        }
      });
      return;
    }
    const tid =
      this.data.selectedTournamentId !== 'all'
        ? this.data.selectedTournamentId
        : options[0].id;
    wx.navigateTo({
      url:
        '/pages/radar-lab/oam/match-edit/match-edit?tournament_id=' +
        encodeURIComponent(tid)
    });
  },

  /**
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onEditMatch: function (e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: '/pages/radar-lab/oam/match-edit/match-edit?id=' + encodeURIComponent(id)
    });
  },

  /**
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onOpenMonitor: function (e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({
      url: '/pages/radar-lab/monitor/detail?match_id=' + encodeURIComponent(id)
    });
  },

  /**
   * @returns {void}
   */
  onBatchImport: function () {
    if (!ensureRadarLabAccess()) return;
    const tournamentId = this._resolveImportTournamentId();
    if (!tournamentId) {
      wx.showModal({
        title: '请选择导入赛事',
        content: '请先在左侧筛选器选择要导入到的具体赛事（不可选「全部赛事」），再执行批量导入。',
        showCancel: false,
        confirmText: '知道了'
      });
      return;
    }
    this._chooseExcelAndImport(tournamentId);
  },

  /**
   * @param {string} tournamentId
   * @returns {void}
   */
  _chooseExcelAndImport: function (tournamentId) {
    const self = this;
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['xlsx', 'xls', 'csv'],
      success: function (res) {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file || !file.path) return;
        wx.getFileSystemManager().readFile({
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
    const tourName = this._currentFilterTournamentName();
    wx.showModal({
      title: '确认导入',
      content: '将 ' + rows.length + ' 条场次导入到「' + tourName + '」，是否继续？',
      success: function (modalRes) {
        if (!modalRes.confirm) return;
        self.setData({ submitting: true });
        wx.showLoading({ title: '导入中…', mask: true });
        oamUpsert({
          action: 'batch_import_matches',
          tournament_id: tournamentId,
          matches_list: rows
        })
          .then(function () {
            wx.hideLoading();
            wx.showToast({ title: '已导入 ' + rows.length + ' 场', icon: 'success' });
            const nextFilterIndex = self.data.filterOptions.findIndex(function (o) {
              return o.id === tournamentId;
            });
            self.setData({
              filterIndex: nextFilterIndex >= 0 ? nextFilterIndex : 0,
              selectedTournamentId: tournamentId
            });
            return self._reloadList(true);
          })
          .catch(function (err) {
            wx.hideLoading();
            wx.showToast({ title: err.message || '导入失败', icon: 'none' });
          })
          .finally(function () {
            self.setData({ submitting: false });
          });
      }
    });
  }
});
