/**
 * @fileoverview 直播雷达实验室入口：赛事 / 场次维护、监控、战报。
 */

const { ensureMatchManageAccess, isRadarWhitelistUser } = require('../../../utils/radar-access.js');
const {
  fetchTournamentTransferInfo,
  claimTournamentTransfer
} = require('../../../../services/tournament-api.js');

Page({
  data: {
    isWhitelist: false
  },

  /**
   * 页面加载：登录鉴权。
   * @returns {void}
   */
  onLoad: function () {
    if (!ensureMatchManageAccess({ redirectBack: true })) return;
  },

  /**
   * 页面展示：刷新白名单特权状态。
   * @returns {void}
   */
  onShow: function () {
    this.setData({
      isWhitelist: isRadarWhitelistUser()
    });
  },

  /**
   * 执行认领操作并跳转至赛事详情
   * @param {string} code
   * @param {number|string} tournamentId
   * @returns {void}
   */
  _executeDirectClaim: function (code, tournamentId) {
    wx.showLoading({ title: '正在接收…' });
    claimTournamentTransfer(code)
      .then(function () {
        wx.hideLoading();
        wx.showToast({ title: '接收成功！已成为管理员', icon: 'success' });
        setTimeout(function () {
          if (tournamentId) {
            wx.navigateTo({
              url: '/packageLab/pages/radar-lab/oam/tournament-detail/tournament-detail?id=' + tournamentId
            });
          }
        }, 1200);
      })
      .catch(function (err) {
        wx.hideLoading();
        wx.showToast({ title: err.message || '接收失败', icon: 'none' });
      });
  },

  /**
   * 跳转场次维护页。
   * @returns {void}
   */
  onGoOam: function () {
    if (!ensureMatchManageAccess()) return;
    wx.navigateTo({ url: '/packageLab/pages/radar-lab/oam/oam' });
  },

  /**
   * 跳转赛事维护页。
   * @returns {void}
   */
  onGoTournament: function () {
    if (!ensureMatchManageAccess()) return;
    wx.navigateTo({ url: '/packageLab/pages/radar-lab/oam/tournament-list/tournament-list' });
  },

  /**
   * 手动输入口令接收赛事
   * @returns {void}
   */
  onGoClaimTransfer: function () {
    if (!ensureMatchManageAccess()) return;
    const self = this;
    wx.showModal({
      title: '接收赛事管理权',
      editable: true,
      placeholderText: '请输入 6 位数字口令',
      confirmText: '核验口令',
      cancelText: '取消',
      success: function (res) {
        if (res.confirm) {
          const code = String(res.content || '').trim();
          if (!code || !/^\d{6}$/.test(code)) {
            wx.showToast({ title: '请输入 6 位数字口令', icon: 'none' });
            return;
          }
          wx.showLoading({ title: '核验口令中…' });
          fetchTournamentTransferInfo(code)
            .then(function (info) {
              wx.hideLoading();
              wx.showModal({
                title: '确认接收赛事',
                content:
                  '赛事名称：' + (info.tournament_name || '') + '\r\n' +
                  '包含场次：' + (info.match_count || 0) + ' 场\r\n\r\n' +
                  '确认直接接收该赛事的管理权吗？',
                confirmText: '确认接收',
                cancelText: '取消',
                confirmColor: '#2563eb',
                success: function (mRes) {
                  if (mRes.confirm) {
                    self._executeDirectClaim(code, info.tournament_id);
                  }
                }
              });
            })
            .catch(function (err) {
              wx.hideLoading();
              wx.showToast({ title: err.message || '核验口令失败', icon: 'none' });
            });
        }
      }
    });
  }
});
