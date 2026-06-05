/**
 * @fileoverview 推广广场：扫码/分享带 target_match_id 进入，展示推广详情并申请参与。
 */

const { getToken } = require('../../../utils/request.js');
const { checkSyncLabWhitelist } = require('../../../utils/sync-lab-whitelist.js');
const {
  PROMO_DEBUG_DEFAULT_MATCH_ID,
  writePromoSquareMatchId
} = require('../../../utils/promo-square-cache.js');
const { getProfile, getPromoSquare, applyPromo } = require('../../services/promo.service.js');

Page({
  data: {
    loading: false,
    targetMatchId: '',
    promoTitle: '',
    teamA: '',
    teamB: '',
    totalPool: 0,
    minViewers: 0,
    promoEnabled: false,
    ads: [],
    errorText: '',
    applying: false,
    /** 白名单调试：恒显输入区 */
    isWhitelistDebug: false,
    /** 非白名单：仅在有开放推广内容时为 true */
    hasPromoContent: false,
    debugMatchIdInput: PROMO_DEBUG_DEFAULT_MATCH_ID
  },

  /**
   * 页面加载：读取 target_match_id；白名单无参时默认加载调试 ID。
   * @param {Object} options
   * @returns {void}
   */
  onLoad: function (options) {
    const isWhitelistDebug = checkSyncLabWhitelist();
    const rawId =
      options && options.target_match_id ? String(options.target_match_id).trim() : '';
    const initialId = rawId || (isWhitelistDebug ? PROMO_DEBUG_DEFAULT_MATCH_ID : '');
    this.setData({
      isWhitelistDebug: isWhitelistDebug,
      debugMatchIdInput: initialId || PROMO_DEBUG_DEFAULT_MATCH_ID,
      targetMatchId: initialId
    });
    if (initialId) {
      this.loadSquare(initialId);
      return;
    }
    this.setData({
      loading: false,
      hasPromoContent: false,
      errorText: '请通过推广链接或二维码进入'
    });
  },

  /**
   * 白名单调试：输入母比赛 ID。
   * @param {Object} e
   * @returns {void}
   */
  onDebugMatchIdInput: function (e) {
    this.setData({
      debugMatchIdInput:
        e.detail && e.detail.value !== undefined ? String(e.detail.value).trim() : ''
    });
  },

  /**
   * 白名单调试：手动查询广场。
   * @returns {void}
   */
  onDebugSearchTap: function () {
    const id = (this.data.debugMatchIdInput || '').trim();
    if (!id) {
      wx.showToast({ title: '请输入母比赛 ID', icon: 'none' });
      return;
    }
    this.loadSquare(id);
  },

  /**
   * 拉取推广广场详情。
   * @param {string} matchId
   * @returns {void}
   */
  loadSquare: function (matchId) {
    const self = this;
    const isWhitelistDebug = self.data.isWhitelistDebug;
    self.setData({ loading: true, errorText: '', hasPromoContent: false });
    getPromoSquare(matchId)
      .then(function (body) {
        const ads = Array.isArray(body.ads) ? body.ads : [];
        const promoEnabled = body.promo_enabled === true;
        const hasContent = promoEnabled;
        if (promoEnabled) {
          writePromoSquareMatchId(matchId);
        }
        self.setData({
          loading: false,
          targetMatchId: String(matchId),
          debugMatchIdInput: String(matchId),
          promoTitle: String(body.promo_title || '推广活动'),
          teamA: String(body.team_a || 'A队'),
          teamB: String(body.team_b || 'B队'),
          totalPool: Number(body.total_pool) || 0,
          minViewers: Number(body.min_viewers) || 0,
          promoEnabled: promoEnabled,
          ads: ads,
          hasPromoContent: isWhitelistDebug || hasContent,
          errorText: hasContent || isWhitelistDebug ? '' : '该比赛未开放推广'
        });
      })
      .catch(function (err) {
        const code = err && err.errorCode ? err.errorCode : '';
        let msg = err && err.message ? err.message : '加载失败';
        if (code === 'PROMO_NOT_ENABLED') {
          msg = '该比赛未开放推广';
        }
        self.setData({
          loading: false,
          hasPromoContent: false,
          errorText: isWhitelistDebug ? msg : msg
        });
      });
  },

  /**
   * 校验抖音主页绑定状态；未 resolved 时弹窗引导。
   * @returns {Promise<boolean>}
   */
  ensureAnchorBound: function () {
    if (!getToken()) {
      wx.showModal({
        title: '需要登录',
        content: '请先登录后再申请推广',
        confirmText: '去登录',
        success: function (res) {
          if (res.confirm) {
            wx.switchTab({ url: '/pages/mine/mine' });
          }
        }
      });
      return Promise.resolve(false);
    }
    return getProfile()
      .then(function (body) {
        const profile =
          body.profile && typeof body.profile === 'object' ? body.profile : null;
        if (!profile) {
          wx.showModal({
            title: '尚未绑定抖音主页',
            content: '申请推广前需先绑定抖音主页，是否前往绑定？',
            confirmText: '去绑定',
            success: function (res) {
              if (res.confirm) {
                wx.navigateTo({ url: '/packagePromo/pages/promo-bind/promo-bind' });
              }
            }
          });
          return false;
        }
        if (profile.bind_status === 'pending_radar') {
          wx.showModal({
            title: '雷达解析中',
            content: '抖音主页正在解析，请稍后在绑定页查看状态',
            showCancel: false
          });
          return false;
        }
        if (profile.bind_status !== 'resolved') {
          wx.showModal({
            title: '尚未绑定抖音主页',
            content: '请先完成抖音主页绑定',
            confirmText: '去绑定',
            success: function (res) {
              if (res.confirm) {
                wx.navigateTo({ url: '/packagePromo/pages/promo-bind/promo-bind' });
              }
            }
          });
          return false;
        }
        return true;
      })
      .catch(function (err) {
        const msg = err && err.message ? err.message : '校验绑定状态失败';
        wx.showToast({ title: msg, icon: 'none' });
        return false;
      });
  },

  /**
   * 点击「申请推广」。
   * @returns {void}
   */
  onApplyTap: function () {
    const self = this;
    if (self.data.applying || !self.data.promoEnabled) {
      if (!self.data.promoEnabled) {
        wx.showToast({ title: '该比赛未开放推广', icon: 'none' });
      }
      return;
    }
    const matchId = self.data.targetMatchId;
    if (!matchId) return;

    self.ensureAnchorBound().then(function (ok) {
      if (!ok) return;
      self.setData({ applying: true });
      applyPromo(matchId)
        .then(function (body) {
          self.setData({ applying: false });
          const msg = typeof body.message === 'string' ? body.message : '申请已提交';
          wx.showModal({
            title: '申请成功',
            content: msg + '，请等待中介审批',
            showCancel: false
          });
        })
        .catch(function (err) {
          self.setData({ applying: false });
          const msg = err && err.message ? err.message : '申请失败';
          wx.showToast({ title: msg, icon: 'none' });
        });
    });
  },

  /**
   * 分享卡片携带 target_match_id。
   * @returns {WechatMiniprogram.Page.ICustomShareContent}
   */
  onShareAppMessage: function () {
    const id = this.data.targetMatchId;
    return {
      title: this.data.promoTitle || '赛事推广广场',
      path:
        id.length > 0
          ? '/packagePromo/pages/promo-square/promo-square?target_match_id=' + encodeURIComponent(id)
          : '/packagePromo/pages/promo-square/promo-square'
    };
  }
});
