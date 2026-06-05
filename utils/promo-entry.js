/**
 * @fileoverview 推广广场入口参数解析（分享 query / 小程序码 scene）。
 */

/** 推广广场分包页面路径（应用内 navigate 用） */
const PROMO_SQUARE_PAGE_PATH = '/packagePromo/pages/promo-square/promo-square';

/**
 * 小程序码推荐落地页（主包，须在微信对应版本中存在）。
 * 服务端默认 `pages/index/index`；含本页的体验版可设 WXACODE_LANDING_PAGE 指向此路径。
 */
const PROMO_WXACODE_LANDING_PAGE = 'pages/promo-landing/promo-landing';

/**
 * 从页面 onLoad options 或小程序码 scene 解析母比赛 ID。
 * @param {Record<string, string | undefined> | null | undefined} options
 * @returns {string}
 */
function resolvePromoTargetMatchId(options) {
  const opts = options || {};
  const direct =
    opts.target_match_id != null ? String(opts.target_match_id).trim() : '';
  if (direct) return direct;

  const sceneRaw = opts.scene != null ? String(opts.scene) : '';
  if (!sceneRaw) return '';

  let scene = sceneRaw;
  try {
    scene = decodeURIComponent(sceneRaw);
  } catch (e) {
    scene = sceneRaw;
  }

  const matchParam = scene.match(/(?:^|[?&])m=(\d+)/);
  if (matchParam && matchParam[1]) return matchParam[1];

  if (/^\d+$/.test(scene)) return scene;
  return '';
}

/**
 * 构建推广广场分包页 URL。
 * @param {string} matchId
 * @returns {string}
 */
function buildPromoSquarePageUrl(matchId) {
  const id = String(matchId || '').trim();
  if (!id) return PROMO_SQUARE_PAGE_PATH;
  return PROMO_SQUARE_PAGE_PATH + '?target_match_id=' + encodeURIComponent(id);
}

module.exports = {
  PROMO_SQUARE_PAGE_PATH,
  PROMO_WXACODE_LANDING_PAGE,
  resolvePromoTargetMatchId,
  buildPromoSquarePageUrl
};
