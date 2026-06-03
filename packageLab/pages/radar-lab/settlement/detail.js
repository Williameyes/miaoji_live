/**
 * @fileoverview 单场广告核销结算单。
 */

const { ensureRadarLabAccess } = require('../../../utils/radar-access.js');
const {
  fetchMatchDetail,
  getMatchSettlement
} = require('../../../services/radar-api.js');

/**
 * @param {number|string} value
 * @returns {string}
 */
function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '¥0.00';
  return '¥' + n.toFixed(2);
}

Page({
  data: {
    matchId: '',
    matchTitle: '',
    tournamentName: '',
    loading: true,
    settlementStatus: '',
    financialSettledAt: '',
    totalPoolText: '¥0.00',
    payoutTotalText: '¥0.00',
    rows: []
  },

  /**
   * @param {Record<string, string>} query
   * @returns {void}
   */
  onLoad: function (query) {
    if (!ensureRadarLabAccess({ redirectBack: true })) return;
    const matchId = query && query.match_id ? String(query.match_id) : '';
    if (!matchId) {
      wx.showToast({ title: '缺少场次信息', icon: 'none' });
      setTimeout(function () {
        wx.navigateBack();
      }, 600);
      return;
    }
    this.setData({ matchId: matchId });
    this._reload();
  },

  /**
   * @returns {void}
   */
  onPullDownRefresh: function () {
    const self = this;
    this._reload(true).finally(function () {
      wx.stopPullDownRefresh();
    });
  },

  /**
   * @param {boolean} [silent]
   * @returns {Promise<void>}
   */
  _reload: function (silent) {
    const self = this;
    if (!silent) {
      this.setData({ loading: true });
    }
    const matchId = this.data.matchId;
    return Promise.all([
      fetchMatchDetail(matchId).catch(function () {
        return null;
      }),
      getMatchSettlement(matchId)
    ])
      .then(function (result) {
        const detail = result[0];
        const settlement = result[1];
        const records = Array.isArray(settlement.records) ? settlement.records : [];
        let payoutTotal = 0;
        const rows = records.map(function (record, index) {
          const payout = Number(record.finalPayout) || 0;
          payoutTotal += payout;
          return {
            index: index + 1,
            secUserId: record.secUserId || '—',
            liveUrl: record.liveUrl || '',
            totalShares: record.totalShares || '0',
            finalPayoutText: formatMoney(record.finalPayout),
            evidenceZipUrl: record.evidenceZipUrl || '',
            settledAt: record.settledAt || ''
          };
        });
        self.setData({
          matchTitle: detail ? detail.teamA + ' vs ' + detail.teamB : '场次 #' + matchId,
          tournamentName: detail ? detail.tournamentName : '',
          settlementStatus: String(settlement.settlement_status || settlement.settlementStatus || ''),
          financialSettledAt: String(settlement.financial_settled_at || settlement.financialSettledAt || ''),
          totalPoolText: formatMoney(settlement.total_pool || settlement.totalPool || 0),
          payoutTotalText: formatMoney(payoutTotal),
          rows: rows,
          loading: false
        });
      })
      .catch(function (err) {
        self.setData({ loading: false });
        wx.showToast({ title: err.message || '加载失败', icon: 'none' });
      });
  },

  /**
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onDownloadEvidence: function (e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.showLoading({ title: '下载中…', mask: true });
    wx.downloadFile({
      url: url,
      success: function (res) {
        wx.hideLoading();
        if (res.statusCode < 200 || res.statusCode >= 300) {
          wx.showToast({ title: '下载失败', icon: 'none' });
          return;
        }
        wx.saveFile({
          tempFilePath: res.tempFilePath,
          success: function () {
            wx.showToast({ title: '已下载', icon: 'success' });
          },
          fail: function () {
            wx.setClipboardData({ data: url });
          }
        });
      },
      fail: function () {
        wx.hideLoading();
        wx.setClipboardData({ data: url });
      }
    });
  },

  /**
   * @param {WechatMiniprogram.BaseEvent} e
   * @returns {void}
   */
  onCopyEvidence: function (e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({ data: url });
  }
});
