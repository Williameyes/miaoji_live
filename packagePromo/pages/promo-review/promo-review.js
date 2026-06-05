/**
 * @fileoverview 推广审批：场次负责人查看待审批列表并操作（须从本人场次列表进入）。
 */

const { getToken } = require('../../../utils/request.js');
const { listPending, reviewPromo } = require('../../services/promo.service.js');

Page({
  data: {
    targetMatchId: '',
    loading: false,
    applications: [],
    errorText: '',
    reviewingId: '',
    fromListEntry: false
  },

  /**
   * 页面加载：须带 target_match_id 参数（从场次列表/监控页进入）。
   * @param {Object} options
   * @returns {void}
   */
  onLoad: function (options) {
    const rawId = options && options.target_match_id ? String(options.target_match_id).trim() : '';
    this.setData({
      targetMatchId: rawId,
      fromListEntry: rawId.length > 0
    });
    if (rawId) {
      this.loadPending(rawId);
    }
  },

  /**
   * 从发布页返回时刷新待审批列表。
   * @returns {void}
   */
  onShow: function () {
    const matchId = (this.data.targetMatchId || '').trim();
    if (matchId && getToken()) {
      this.loadPending(matchId);
    }
  },

  /**
   * 拉取待审批申请。
   * @param {string} matchId
   * @returns {void}
   */
  loadPending: function (matchId) {
    const self = this;
    if (!getToken()) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    self.setData({ loading: true, errorText: '', applications: [] });
    listPending(matchId)
      .then(function (body) {
        const raw = Array.isArray(body.applications) ? body.applications : [];
        const applications = raw.map(function (item) {
          const a = item && typeof item === 'object' ? item : {};
          return {
            applicationId: a.application_id,
            openid: String(a.openid || ''),
            secUserId: String(a.sec_user_id || ''),
            anchorName: String(a.anchor_name || '未知主播'),
            douyinProfileUrl: String(a.douyin_profile_url || ''),
            createdAt: String(a.created_at || '')
          };
        });
        self.setData({ loading: false, applications: applications });
      })
      .catch(function (err) {
        const code = err && err.errorCode ? err.errorCode : '';
        let msg = err && err.message ? err.message : '加载失败';
        if (code === 'FORBIDDEN' || err.statusCode === 403) {
          msg = '无权查看该场次';
        }
        self.setData({ loading: false, errorText: msg, applications: [] });
      });
  },

  /**
   * 审批通过。
   * @param {Object} e
   * @returns {void}
   */
  onApproveTap: function (e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    this.submitReview(id, true);
  },

  /**
   * 审批拒绝。
   * @param {Object} e
   * @returns {void}
   */
  onRejectTap: function (e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const self = this;
    wx.showModal({
      title: '拒绝申请',
      editable: true,
      placeholderText: '可选备注',
      success: function (res) {
        if (res.confirm) {
          const note = res.content || '';
          self.submitReview(id, false, note);
        }
      }
    });
  },

  /**
   * 提交审批结果。
   * @param {number|string} applicationId
   * @param {boolean} approve
   * @param {string} [reviewNote]
   * @returns {void}
   */
  submitReview: function (applicationId, approve, reviewNote) {
    const self = this;
    const key = String(applicationId);
    self.setData({ reviewingId: key });
    reviewPromo({
      applicationId: applicationId,
      approve: approve,
      reviewNote: reviewNote || ''
    })
      .then(function (body) {
        self.setData({ reviewingId: '' });
        const status = typeof body.status === 'string' ? body.status : '';
        wx.showToast({
          title: approve ? '已通过' : '已拒绝',
          icon: 'success'
        });
        if (status === 'approved' && body.task_enqueued) {
          wx.showToast({ title: '已自动探测一次', icon: 'none', duration: 2000 });
        }
        const matchId = self.data.targetMatchId;
        if (matchId) {
          self.loadPending(matchId);
        }
      })
      .catch(function (err) {
        self.setData({ reviewingId: '' });
        const msg = err && err.message ? err.message : '操作失败';
        wx.showToast({ title: msg, icon: 'none' });
      });
  },

  /**
   * 复制 sec_user_id。
   * @param {Object} e
   * @returns {void}
   */
  onCopySecUserIdTap: function (e) {
    const val = e.currentTarget.dataset.val;
    if (!val) return;
    wx.setClipboardData({ data: String(val) });
  }
});
