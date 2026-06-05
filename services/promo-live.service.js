/**
 * @fileoverview Live 页商业推广载入（主包专用，仅 load_promo_ads，避免引用分包）。
 */

const { post, get } = require('../utils/request.js');
const {
  parseAppApiResponse,
  normalizeAppApiError
} = require('../utils/app-api-response.js');

/** @type {Record<string, string>} */
const PROMO_LIVE_ERROR_MESSAGES = {
  PROMO_NOT_APPROVED: '推广尚未通过审批',
  FORBIDDEN: '无权限载入推广'
};

/**
 * 直播页跨 ID 载入商业推广 Logo（promo_match_id 为母比赛 ID）。
 * @param {number|string} promoMatchId
 * @returns {Promise<Record<string, unknown>>}
 */
function loadPromoAds(promoMatchId) {
  return post('/api/app/match/load_promo_ads', { promo_match_id: promoMatchId })
    .then(parseAppApiResponse)
    .catch(function (err) {
      throw normalizeAppApiError(err, PROMO_LIVE_ERROR_MESSAGES);
    });
}

/**
 * 检查当前用户是否有已通过审批的推广（供「我的」页入口显隐）。
 * @returns {Promise<boolean>}
 */
function checkHasMyPromos() {
  return get('/api/app/promo/my')
    .then(parseAppApiResponse)
    .then(function (body) {
      const list = Array.isArray(body.promotions) ? body.promotions : [];
      return list.length > 0;
    })
    .catch(function () {
      return false;
    });
}

/**
 * 检查指定母比赛是否已开放推广广场（promo_enabled）。
 * @param {number|string} targetMatchId
 * @returns {Promise<boolean>}
 */
function checkPromoSquareAvailable(targetMatchId) {
  const id = String(targetMatchId || '').trim();
  if (!id) {
    return Promise.resolve(false);
  }
  return get('/api/app/promo/square', { target_match_id: id })
    .then(parseAppApiResponse)
    .then(function (body) {
      return body.promo_enabled === true;
    })
    .catch(function () {
      return false;
    });
}

module.exports = {
  loadPromoAds,
  checkHasMyPromos,
  checkPromoSquareAvailable
};
