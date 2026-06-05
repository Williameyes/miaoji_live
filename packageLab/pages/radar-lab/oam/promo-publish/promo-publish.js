/**
 * @fileoverview 中介推广发布：检查奖池/起征/Logo，发布广场并生成小程序码。
 */

const { getToken } = require('../../../../../utils/request.js');
const { ensureRadarLabAccess, isForbiddenError, handleRadarForbidden } = require('../../../../utils/radar-access.js');
const {
  fetchPromoPublishStatus,
  publishPromo,
  unpublishPromo,
  fetchPromoWxacode,
  fetchPromoPendingApplications,
  setMatchAds
} = require('../../../../services/radar-api.js');

/** Logo 原图上传上限（字节） */
const LOGO_MAX_UPLOAD_SIZE = 200 * 1024;

/**
 * @param {number | null | undefined} amount
 * @returns {string}
 */
function formatMoney(amount) {
  if (!amount || amount <= 0) return '未配置';
  const fixed = Number(amount).toFixed(2);
  return '¥' + fixed.replace(/\.00$/, '');
}

Page({
  data: {
    matchId: '',
    matchTitle: '',
    tournamentName: '',
    totalPoolText: '未配置',
    minViewersText: '未配置',
    adsCountText: '0 个',
    promoTitle: '',
    promoEnabled: false,
    ready: false,
    checks: {
      poolOk: false,
      minViewersOk: false,
      adsOk: false,
      titleOk: false
    },
    adsPreview: [],
    logoBrandName: '',
    uploadingLogo: false,
    submitting: false,
    loading: true,
    wxacodePath: '',
    pendingCount: 0
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
    this._loadStatus();
  },

  /**
   * @returns {void}
   */
  onShow: function () {
    if (this.data.matchId) {
      this._loadStatus(true);
      this._refreshPendingCount();
    }
  },

  /**
   * 确保已登录（发布/生成码需鉴权）。
   * @returns {boolean}
   */
  _ensureLoggedIn: function () {
    if (getToken()) return true;
    wx.showModal({
      title: '需要登录',
      content: '发布推广与生成小程序码需要先登录，请前往「我的」页登录后再试。',
      showCancel: false,
      confirmText: '知道了'
    });
    return false;
  },

  /**
   * @param {boolean} [silent]
   * @returns {void}
   */
  _loadStatus: function (silent) {
    const self = this;
    if (!silent) {
      this.setData({ loading: true });
    }
    fetchPromoPublishStatus(this.data.matchId, this.data.promoTitle)
      .then(function (status) {
        self._applyStatus(status);
      })
      .catch(function (err) {
        if (isForbiddenError(err)) {
          handleRadarForbidden();
          return;
        }
        if (!silent) {
          wx.showToast({ title: err.message || '加载失败', icon: 'none' });
        }
        self.setData({ loading: false });
      });
  },

  /**
   * @param {Record<string, unknown>} status
   * @returns {void}
   */
  _applyStatus: function (status) {
    const checksRaw =
      status.checks && typeof status.checks === 'object'
        ? /** @type {Record<string, boolean>} */ (status.checks)
        : {};
    const adsPreviewRaw = Array.isArray(status.ads_preview) ? status.ads_preview : [];
    const adsPreview = adsPreviewRaw.map(function (item) {
      const row =
        item && typeof item === 'object' ? /** @type {Record<string, unknown>} */ (item) : {};
      return {
        imageUrl: String(row.image_url || row.imageUrl || ''),
        brandName: String(row.brand_name || row.brandName || '')
      };
    });

    this.setData({
      matchTitle: String(status.team_a || '') + ' vs ' + String(status.team_b || ''),
      tournamentName: String(status.tournament_name || ''),
      totalPoolText: formatMoney(
        status.total_pool != null ? Number(status.total_pool) : null
      ),
      minViewersText:
        Number(status.min_viewers || 0) > 0
          ? String(status.min_viewers) + ' 人'
          : '未配置',
      adsCountText:
        Number(status.ads_count || 0) > 0
          ? String(status.ads_count) + ' 个'
          : '0 个',
      promoTitle:
        this.data.promoTitle || String(status.promo_title || ''),
      promoEnabled: Boolean(status.promo_enabled),
      ready: Boolean(status.ready),
      checks: {
        poolOk: Boolean(checksRaw.pool_ok),
        minViewersOk: Boolean(checksRaw.min_viewers_ok),
        adsOk: Boolean(checksRaw.ads_ok),
        titleOk: Boolean(checksRaw.title_ok)
      },
      adsPreview: adsPreview,
      loading: false
    });
    if (Boolean(status.promo_enabled) && getToken()) {
      this._refreshPendingCount();
    }
  },

  /**
   * @param {WechatMiniprogram.Input} e
   * @returns {void}
   */
  onPromoTitleInput: function (e) {
    const value = e.detail && e.detail.value !== undefined ? String(e.detail.value) : '';
    this.setData({ promoTitle: value });
  },

  /**
   * 标题失焦后刷新检查项。
   * @returns {void}
   */
  onPromoTitleBlur: function () {
    this._loadStatus(true);
  },

  /**
   * @param {WechatMiniprogram.Input} e
   * @returns {void}
   */
  onLogoBrandInput: function (e) {
    this.setData({
      logoBrandName: e.detail && e.detail.value !== undefined ? String(e.detail.value) : ''
    });
  },

  /**
   * @returns {void}
   */
  onChooseLogo: function () {
    const self = this;
    const handleFile = function (file) {
      if (!file || !file.tempFilePath) return;
      if (file.size && file.size > LOGO_MAX_UPLOAD_SIZE) {
        wx.showToast({ title: 'Logo 请控制在 200KB 以内', icon: 'none' });
        return;
      }
      self._uploadLogo(file.tempFilePath);
    };
    if (wx.chooseMedia) {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
        success: function (res) {
          handleFile(res.tempFiles && res.tempFiles[0]);
        }
      });
      return;
    }
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: function (res) {
        handleFile({
          tempFilePath: res.tempFilePaths && res.tempFilePaths[0],
          size: res.tempFiles && res.tempFiles[0] ? res.tempFiles[0].size : 0
        });
      }
    });
  },

  /**
   * @param {string} filePath
   * @returns {void}
   */
  _uploadLogo: function (filePath) {
    const self = this;
    this.setData({ uploadingLogo: true });
    wx.showLoading({ title: '上传中…', mask: true });
    setMatchAds({
      matchId: this.data.matchId,
      brandName: String(this.data.logoBrandName || '').trim(),
      filePath: filePath
    })
      .then(function () {
        wx.hideLoading();
        wx.showToast({ title: 'Logo 已上传', icon: 'success' });
        self.setData({ logoBrandName: '' });
        self._loadStatus(true);
      })
      .catch(function (err) {
        wx.hideLoading();
        wx.showToast({ title: err.message || '上传失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ uploadingLogo: false });
      });
  },

  /**
   * @returns {void}
   */
  onPublish: function () {
    if (!this._ensureLoggedIn()) return;
    const self = this;
    const title = (this.data.promoTitle || '').trim();
    if (!title) {
      wx.showToast({ title: '请填写推广标题', icon: 'none' });
      return;
    }
    if (!this.data.ready) {
      wx.showToast({ title: '请先完成发布前检查项', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '发布中…', mask: true });
    publishPromo(this.data.matchId, title)
      .then(function (res) {
        wx.hideLoading();
        wx.showModal({
          title: '发布成功',
          content:
            '主播需扫描小程序码进入「推广广场」申请；你可在控制台「推广监测」查看本场，并生成小程序码。',
          showCancel: false,
          confirmText: '知道了'
        });
        self.setData({ promoEnabled: true });
        self._loadStatus(true);
        self._refreshPendingCount();
      })
      .catch(function (err) {
        wx.hideLoading();
        wx.showToast({ title: err.message || '发布失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ submitting: false });
      });
  },

  /**
   * 刷新待审批数量（已发布且已登录时）。
   * @returns {void}
   */
  _refreshPendingCount: function () {
    const self = this;
    if (!this.data.promoEnabled || !getToken()) {
      this.setData({ pendingCount: 0 });
      return;
    }
    fetchPromoPendingApplications(this.data.matchId)
      .then(function (body) {
        const list = Array.isArray(body.applications) ? body.applications : [];
        self.setData({ pendingCount: list.length });
      })
      .catch(function () {
        self.setData({ pendingCount: 0 });
      });
  },

  /**
   * 跳转推广审批页（自动带上当前场次 ID）。
   * @returns {void}
   */
  onOpenReview: function () {
    if (!this._ensureLoggedIn()) return;
    const matchId = this.data.matchId;
    if (!matchId) return;
    wx.navigateTo({
      url:
        '/packagePromo/pages/promo-review/promo-review?target_match_id=' +
        encodeURIComponent(matchId)
    });
  },

  /**
   * @returns {void}
   */
  onUnpublish: function () {
    if (!this._ensureLoggedIn()) return;
    const self = this;
    wx.showModal({
      title: '关闭推广广场',
      content: '关闭后主播将无法扫码进入申请，是否继续？',
      success: function (res) {
        if (!res.confirm) return;
        self.setData({ submitting: true });
        unpublishPromo(self.data.matchId)
          .then(function () {
            wx.showToast({ title: '已关闭推广', icon: 'success' });
            self.setData({ promoEnabled: false, wxacodePath: '' });
            self._loadStatus(true);
          })
          .catch(function (err) {
            wx.showToast({ title: err.message || '操作失败', icon: 'none' });
          })
          .finally(function () {
            self.setData({ submitting: false });
          });
      }
    });
  },

  /**
   * @returns {void}
   */
  onGenerateWxacode: function () {
    if (!this._ensureLoggedIn()) return;
    if (!this.data.promoEnabled) {
      wx.showToast({ title: '请先发布推广广场', icon: 'none' });
      return;
    }
    const self = this;
    this.setData({ submitting: true });
    wx.showLoading({ title: '生成中…', mask: true });
    fetchPromoWxacode(this.data.matchId)
      .then(function (res) {
        wx.hideLoading();
        const base64 = String(res.image_base64 || '');
        if (!base64) {
          wx.showToast({ title: '未返回小程序码', icon: 'none' });
          return;
        }
        const filePath =
          wx.env.USER_DATA_PATH + '/promo-wxacode-' + self.data.matchId + '.png';
        wx.getFileSystemManager().writeFile({
          filePath: filePath,
          data: base64,
          encoding: 'base64',
          success: function () {
            self.setData({ wxacodePath: filePath });
            wx.showToast({ title: '小程序码已生成', icon: 'success' });
          },
          fail: function () {
            wx.showToast({ title: '保存图片失败', icon: 'none' });
          }
        });
      })
      .catch(function (err) {
        wx.hideLoading();
        wx.showToast({ title: err.message || '生成失败', icon: 'none' });
      })
      .finally(function () {
        self.setData({ submitting: false });
      });
  },

  /**
   * 保存小程序码到相册。
   * @returns {void}
   */
  onSaveWxacode: function () {
    const filePath = this.data.wxacodePath;
    if (!filePath) return;
    wx.saveImageToPhotosAlbum({
      filePath: filePath,
      success: function () {
        wx.showToast({ title: '已保存到相册', icon: 'success' });
      },
      fail: function () {
        wx.showModal({
          title: '保存失败',
          content: '请长按小程序码图片手动保存，或在设置中开启相册权限。',
          showCancel: false
        });
      }
    });
  }
});
