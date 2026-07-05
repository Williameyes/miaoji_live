/**
 * @fileoverview 场次新建/编辑（服务端拉取与保存）。
 */

const { ensureRadarLabAccess, isForbiddenError, handleRadarForbidden } = require('../../../../utils/radar-access.js');
const {
  oamUpsert,
  fetchTournamentList,
  fetchMatchDetail
} = require('../../../../services/radar-api.js');
const {
  combineDateTimeToStartTime,
  parseStartTimeToParts,
  timestampToDateStr,
  timestampToTimeStr
} = require('../../../../utils/radar-datetime.js');

Page({
  data: {
    isEdit: false,
    matchId: '',
    tournaments: [],
    tournamentIndex: 0,
    tournamentId: '',
    teamA: '',
    teamB: '',
    startDate: '',
    startTime: '',
    totalPool: '',
    minViewers: '',
    submitting: false,
    loading: true
  },

  /**
   * 用户是否已手动改过开赛时间（防止异步加载回写覆盖拨盘选择）。
   * @type {boolean}
   */
  _startTimeTouched: false,

  /**
   * @param {Record<string, string>} query
   * @returns {void}
   */
  onLoad: function (query) {
    if (!ensureRadarLabAccess({ redirectBack: true })) return;
    this._startTimeTouched = false;
    const now = Date.now();
    // 同步写入默认开赛时间，避免表单空值；异步回写时若用户已拨盘则不再覆盖
    this.setData({
      startDate: timestampToDateStr(now),
      startTime: timestampToTimeStr(now)
    });
    const editId = query && query.id ? String(query.id) : '';
    const presetTournamentId = query && query.tournament_id ? String(query.tournament_id) : '';
    this._initPage(editId, presetTournamentId);
  },

  /**
   * @param {string} editId
   * @param {string} presetTournamentId
   * @returns {void}
   */
  _initPage: function (editId, presetTournamentId) {
    const self = this;
    fetchTournamentList()
      .then(function (tournaments) {
        let tournamentId = presetTournamentId;
        let teamA = '';
        let teamB = '';
        let startDate = self.data.startDate;
        let startTime = self.data.startTime;
        let totalPool = '';
        let minViewers = '';
        const loadDetail = editId
          ? fetchMatchDetail(editId).then(function (detail) {
              if (detail) {
                tournamentId = detail.tournamentId || tournamentId;
                teamA = detail.teamA;
                teamB = detail.teamB;
                // 编辑态以服务端为准；若用户已先拨盘则保留本地选择
                if (!self._startTimeTouched) {
                  const parts = parseStartTimeToParts(detail.startTime);
                  startDate = parts.dateStr;
                  startTime = parts.timeStr;
                }
                totalPool = detail.totalPool > 0 ? String(detail.totalPool) : '';
                minViewers = detail.minViewers > 0 ? String(detail.minViewers) : '';
              }
            })
          : Promise.resolve();
        return loadDetail.then(function () {
          let tournamentIndex = tournaments.findIndex(function (t) {
            return String(t.id) === String(tournamentId);
          });
          if (tournamentIndex < 0) tournamentIndex = 0;
          if (!tournamentId && tournaments[0]) {
            tournamentId = tournaments[0].id;
          }
          /** @type {Record<string, unknown>} */
          const patch = {
            isEdit: !!editId,
            matchId: editId,
            tournaments: tournaments,
            tournamentIndex: tournamentIndex,
            tournamentId: tournamentId,
            teamA: teamA,
            teamB: teamB,
            totalPool: totalPool,
            minViewers: minViewers,
            loading: false
          };
          // 新建：仅在用户未拨盘时保持 onLoad 默认值；编辑：写入详情时间
          if (!self._startTimeTouched) {
            patch.startDate = startDate;
            patch.startTime = startTime;
          }
          self.setData(patch);
        });
      })
      .catch(function (err) {
        self.setData({ loading: false });
        if (isForbiddenError(err)) {
          handleRadarForbidden();
          return;
        }
        wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      });
  },

  /**
   * @param {WechatMiniprogram.Input} e
   * @returns {void}
   */
  onTeamAInput: function (e) {
    this.setData({ teamA: e.detail.value });
  },

  /**
   * @param {WechatMiniprogram.Input} e
   * @returns {void}
   */
  onTeamBInput: function (e) {
    this.setData({ teamB: e.detail.value });
  },

  /**
   * @param {WechatMiniprogram.PickerChange} e
   * @returns {void}
   */
  onTournamentChange: function (e) {
    const idx = Number(e.detail.value);
    const item = this.data.tournaments[idx];
    if (!item) return;
    this.setData({
      tournamentIndex: idx,
      tournamentId: String(item.id)
    });
  },

  /**
   * @param {WechatMiniprogram.PickerChange} e
   * @returns {void}
   */
  onStartDateChange: function (e) {
    const value = e && e.detail ? String(e.detail.value || '') : '';
    if (!value) return;
    this._startTimeTouched = true;
    this.setData({ startDate: value });
  },

  /**
   * @param {WechatMiniprogram.PickerChange} e
   * @returns {void}
   */
  onStartTimeChange: function (e) {
    const value = e && e.detail ? String(e.detail.value || '') : '';
    if (!value) return;
    this._startTimeTouched = true;
    this.setData({ startTime: value });
  },

  /**
   * @param {WechatMiniprogram.Input} e
   * @returns {void}
   */
  onTotalPoolInput: function (e) {
    this.setData({ totalPool: e.detail.value });
  },

  /**
   * @param {WechatMiniprogram.Input} e
   * @returns {void}
   */
  onMinViewersInput: function (e) {
    this.setData({ minViewers: e.detail.value });
  },

  /**
   * @returns {{totalPool: number, minViewers: number} | null}
   */
  _readCommercialConfig: function () {
    const poolText = String(this.data.totalPool || '').trim();
    const minText = String(this.data.minViewers || '').trim();
    const totalPool = poolText ? Number(poolText) : 0;
    const minViewers = minText ? Number(minText) : 0;
    if (poolText && (!Number.isFinite(totalPool) || totalPool < 0)) {
      wx.showToast({ title: '奖池金额需为非负数字', icon: 'none' });
      return null;
    }
    if (minText && (!Number.isFinite(minViewers) || minViewers < 0 || Math.floor(minViewers) !== minViewers)) {
      wx.showToast({ title: '起征人数需为非负整数', icon: 'none' });
      return null;
    }
    return { totalPool: totalPool, minViewers: minViewers };
  },

  /**
   * @param {Record<string, unknown>} data
   * @returns {Record<string, unknown> | null}
   */
  _appendCommercialConfig: function (data) {
    const cfg = this._readCommercialConfig();
    if (!cfg) return null;
    if (String(this.data.totalPool || '').trim()) {
      data.total_pool = cfg.totalPool;
    }
    if (String(this.data.minViewers || '').trim()) {
      data.min_viewers = cfg.minViewers;
    }
    return data;
  },

  /**
   * 组装场次 upsert 的 data 字段。
   * @returns {Record<string, unknown> | null}
   */
  _buildMatchData: function () {
    const d = this.data;
    if (!d.tournamentId || !d.teamA.trim() || !d.teamB.trim()) {
      wx.showToast({ title: '请填写完整信息', icon: 'none' });
      return null;
    }
    if (!d.startDate || !d.startTime) {
      wx.showToast({ title: '请选择比赛时间', icon: 'none' });
      return null;
    }
    const startTimeStr = combineDateTimeToStartTime(d.startDate, d.startTime);
    const matchData = this._appendCommercialConfig({
      tournament_id: d.tournamentId,
      team_a: d.teamA.trim(),
      team_b: d.teamB.trim(),
      start_time: startTimeStr
    });
    if (!matchData) return null;
    if (d.matchId) {
      matchData.match_id = d.matchId;
    }
    return matchData;
  },

  /**
   * 提交场次 upsert。后端 insert/update 均已支持商业字段，不额外补 update。
   * @param {Record<string, unknown>} payload
   * @returns {Promise<Record<string, unknown>>}
   */
  _submitMatchUpsert: function (payload) {
    return oamUpsert(payload);
  },

  /**
   * @returns {void}
   */
  onSave: function () {
    const self = this;
    if (!ensureRadarLabAccess()) return;
    const matchData = this._buildMatchData();
    if (!matchData) return;
    this.setData({ submitting: true });
    this._submitMatchUpsert({
      action: 'upsert_match',
      data: matchData
    })
      .then(function () {
        wx.showToast({ title: '已保存', icon: 'success' });
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
  },

  /**
   * @returns {void}
   */
  onSaveAndMonitor: function () {
    const self = this;
    if (!ensureRadarLabAccess()) return;
    const matchData = this._buildMatchData();
    if (!matchData) return;
    this.setData({ submitting: true });
    this._submitMatchUpsert({
      action: 'upsert_match',
      data: matchData
    })
      .then(function (res) {
        const id = String(res.affected_id || self.data.matchId || '');
        wx.redirectTo({
          url: '/packageLab/pages/radar-lab/monitor/detail?match_id=' + encodeURIComponent(id)
        });
      })
      .catch(function (err) {
        wx.showToast({ title: err.message || '保存失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ submitting: false });
      });
  }
});
