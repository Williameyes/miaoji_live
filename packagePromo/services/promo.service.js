/**
 * @fileoverview 商业化推广 `/api/app/*` 接口封装（分包 packagePromo）。
 */

const { post, get } = require('../../utils/request.js');
const {
  parseAppApiResponse,
  normalizeAppApiError
} = require('../../utils/app-api-response.js');

/** @type {Record<string, string>} */
const PROMO_ERROR_MESSAGES = {
  ANCHOR_NOT_BOUND_TO_USER: '请先绑定抖音主页',
  PROMO_ALREADY_APPLIED: '已申请过该场次推广',
  PROMO_NOT_ENABLED: '该比赛未开放推广',
  PROMO_NOT_APPROVED: '推广尚未通过审批',
  FORBIDDEN: '无权限执行此操作'
};

/**
 * 解析推广业务错误，补充友好文案。
 * @param {unknown} err
 * @returns {Error}
 */
function normalizePromoError(err) {
  return normalizeAppApiError(err, PROMO_ERROR_MESSAGES);
}

/**
 * 绑定抖音主页（粘贴分享口令全文）。
 * @param {string} shareText
 * @returns {Promise<Record<string, unknown>>}
 */
function bindProfile(shareText) {
  return post('/api/app/anchor/bind_profile', { share_text: shareText })
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizePromoError(err);
    });
}

/**
 * 查询当前用户抖音主页绑定状态。
 * @returns {Promise<Record<string, unknown>>}
 */
function getProfile() {
  return get('/api/app/anchor/profile')
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizePromoError(err);
    });
}

/**
 * 拉取推广广场详情。
 * @param {number|string} targetMatchId
 * @returns {Promise<Record<string, unknown>>}
 */
function getPromoSquare(targetMatchId) {
  return get('/api/app/promo/square', { target_match_id: targetMatchId })
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizePromoError(err);
    });
}

/**
 * 申请参与推广。
 * @param {number|string} targetMatchId
 * @returns {Promise<Record<string, unknown>>}
 */
function applyPromo(targetMatchId) {
  return post('/api/app/promo/apply', { target_match_id: targetMatchId })
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizePromoError(err);
    });
}

/**
 * 拉取当前用户已通过审批的推广列表。
 * @returns {Promise<Record<string, unknown>>}
 */
function listMyPromos() {
  return get('/api/app/promo/my')
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizePromoError(err);
    });
}

/**
 * 拉取待审批申请列表。
 * @param {number|string} targetMatchId
 * @returns {Promise<Record<string, unknown>>}
 */
function listPending(targetMatchId) {
  return get('/api/app/promo/pending', { target_match_id: targetMatchId })
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizePromoError(err);
    });
}

/**
 * 审批推广申请。
 * @param {Object} params
 * @param {number|string} params.applicationId
 * @param {boolean} params.approve
 * @param {string} [params.reviewNote]
 * @returns {Promise<Record<string, unknown>>}
 */
function reviewPromo(params) {
  const body = {
    application_id: params.applicationId,
    approve: params.approve === true
  };
  if (params.reviewNote && String(params.reviewNote).trim().length > 0) {
    body.review_note = String(params.reviewNote).trim();
  }
  return post('/api/app/promo/review', body)
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizePromoError(err);
    });
}

module.exports = {
  PROMO_ERROR_MESSAGES,
  bindProfile,
  getProfile,
  getPromoSquare,
  applyPromo,
  listMyPromos,
  listPending,
  reviewPromo
};
