/**
 * @fileoverview 抖音主页绑定（实验功能分包页）。
 */

const { getToken } = require('../../../utils/request.js');
const { bindProfile, getProfile } = require('../../services/promo.service.js');

/** 雷达解析轮询间隔（ms） */
const PROFILE_POLL_INTERVAL_MS = 4000;

Page({
  data: {
    bindShareText: '',
    bindSubmitting: false,
    anchorBindStatusText: '尚未绑定抖音',
    anchorName: '',
    anchorBindStatus: '',
    anchorPolling: false
  },

  /** @type {number | null} */
  _profilePollTimer: null,

  /**
   * 页面加载。
   * @returns {void}
   */
  onLoad: function () {},

  /**
   * 页面显示：刷新绑定状态。
   * @returns {void}
   */
  onShow: function () {
    if (!getToken()) {
      this.stopProfilePolling();
      this.setData({
        anchorBindStatus: '',
        anchorBindStatusText: '请先登录',
        anchorName: '',
        anchorPolling: false
      });
      return;
    }
    this.refreshAnchorProfile();
  },

  /**
   * 页面卸载。
   * @returns {void}
   */
  onUnload: function () {
    this.stopProfilePolling();
  },

  /**
   * 停止轮询。
   * @returns {void}
   */
  stopProfilePolling: function () {
    if (this._profilePollTimer != null) {
      clearInterval(this._profilePollTimer);
      this._profilePollTimer = null;
    }
    if (this.data.anchorPolling) {
      this.setData({ anchorPolling: false });
    }
  },

  /**
   * 启动 pending_radar 轮询。
   * @returns {void}
   */
  startProfilePolling: function () {
    const self = this;
    if (self._profilePollTimer != null) {
      return;
    }
    self.setData({ anchorPolling: true });
    self._profilePollTimer = setInterval(function () {
      self.refreshAnchorProfile(true);
    }, PROFILE_POLL_INTERVAL_MS);
  },

  /**
   * 写入绑定状态到界面。
   * @param {Record<string, unknown> | null} profile
   * @returns {void}
   */
  applyAnchorProfileToView: function (profile) {
    if (!profile) {
      this.setData({
        anchorBindStatus: '',
        anchorBindStatusText: '尚未绑定抖音主页',
        anchorName: ''
      });
      return;
    }
    const status = typeof profile.bind_status === 'string' ? profile.bind_status : '';
    let statusText = '尚未绑定抖音';
    if (status === 'pending_radar') {
      statusText = '资料解析中，请稍候…';
    } else if (status === 'resolved') {
      statusText = '已绑定，后续可使用高级功能';
    } else if (status === 'failed') {
      statusText = '绑定失败，请重新提交';
    }
    const name =
      typeof profile.anchor_name === 'string' && profile.anchor_name.length > 0
        ? profile.anchor_name
        : '';
    this.setData({
      anchorBindStatus: status,
      anchorBindStatusText: statusText,
      anchorName: name
    });
    if (status === 'pending_radar') {
      this.startProfilePolling();
    } else {
      this.stopProfilePolling();
    }
  },

  /**
   * 拉取绑定状态。
   * @param {boolean} [silent]
   * @returns {void}
   */
  refreshAnchorProfile: function (silent) {
    const self = this;
    if (!getToken()) return;
    getProfile()
      .then(function (body) {
        const profile =
          body.profile && typeof body.profile === 'object' ? body.profile : null;
        self.applyAnchorProfileToView(
          profile ? /** @type {Record<string, unknown>} */ (profile) : null
        );
      })
      .catch(function (err) {
        if (!silent) {
          const msg = err && err.message ? err.message : '获取绑定状态失败';
          wx.showToast({ title: msg, icon: 'none' });
        }
      });
  },

  /**
   * 分享口令输入。
   * @param {Object} e
   * @returns {void}
   */
  onBindShareTextInput: function (e) {
    this.setData({
      bindShareText: e.detail && e.detail.value !== undefined ? String(e.detail.value) : ''
    });
  },

  /**
   * 提交绑定。
   * @returns {void}
   */
  onBindProfileTap: function () {
    const self = this;
    if (!getToken()) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    const text = (self.data.bindShareText || '').trim();
    if (text.length < 10) {
      wx.showToast({ title: '请粘贴抖音分享完整文本', icon: 'none' });
      return;
    }
    self.setData({ bindSubmitting: true });
    bindProfile(text)
      .then(function (body) {
        self.setData({ bindSubmitting: false });
        const status = typeof body.bind_status === 'string' ? body.bind_status : '';
        if (status === 'resolved') {
          wx.showToast({ title: '绑定成功', icon: 'success' });
        } else if (status === 'pending_radar') {
          wx.showToast({ title: '资料解析中，请稍候', icon: 'none' });
        } else {
          const msg = typeof body.message === 'string' ? body.message : '已提交';
          wx.showToast({ title: msg, icon: 'none' });
        }
        self.refreshAnchorProfile(true);
      })
      .catch(function (err) {
        self.setData({ bindSubmitting: false });
        const msg = err && err.message ? err.message : '绑定失败';
        wx.showToast({ title: msg, icon: 'none' });
      });
  }
});
