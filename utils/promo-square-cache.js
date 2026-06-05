/**
 * @fileoverview 推广广场母比赛 ID 缓存（扫码/分享进入时写入，供「我的」入口显隐）。
 */

/** 本地存储键：最近一次有效的推广广场母比赛 ID */
const STORAGE_PROMO_SQUARE_MATCH_ID = 'promoSquareMatchId';

/** 白名单调试默认母比赛 ID */
const PROMO_DEBUG_DEFAULT_MATCH_ID = '40';

/**
 * 从启动/分享 query 中解析并缓存 target_match_id。
 * @param {Record<string, string | undefined> | null | undefined} query
 * @returns {void}
 */
function persistPromoSquareMatchIdFromQuery(query) {
  if (!query || typeof query !== 'object') {
    return;
  }
  const raw = query.target_match_id;
  const id = typeof raw === 'string' ? raw.trim() : raw != null ? String(raw).trim() : '';
  if (id.length > 0) {
    try {
      wx.setStorageSync(STORAGE_PROMO_SQUARE_MATCH_ID, id);
    } catch (e) {
      // 忽略写入异常
    }
  }
}

/**
 * 读取缓存的母比赛 ID。
 * @returns {string}
 */
function readPromoSquareMatchId() {
  try {
    const v = wx.getStorageSync(STORAGE_PROMO_SQUARE_MATCH_ID);
    return typeof v === 'string' ? v.trim() : '';
  } catch (e) {
    return '';
  }
}

/**
 * 写入缓存的母比赛 ID（广场加载成功且开放推广时调用）。
 * @param {string} matchId
 * @returns {void}
 */
function writePromoSquareMatchId(matchId) {
  const id = typeof matchId === 'string' ? matchId.trim() : String(matchId || '').trim();
  if (id.length === 0) {
    return;
  }
  try {
    wx.setStorageSync(STORAGE_PROMO_SQUARE_MATCH_ID, id);
  } catch (e) {
    // 忽略写入异常
  }
}

module.exports = {
  STORAGE_PROMO_SQUARE_MATCH_ID,
  PROMO_DEBUG_DEFAULT_MATCH_ID,
  persistPromoSquareMatchIdFromQuery,
  readPromoSquareMatchId,
  writePromoSquareMatchId
};
