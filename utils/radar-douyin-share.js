/**
 * @fileoverview 抖音分享口令/链接客户端预处理（提取 URL，供后端解析补全主播信息）。
 */

/**
 * 从分享文本中提取抖音短链或 live 链接。
 * @param {string} rawText
 * @returns {string}
 */
function extractDouyinUrl(rawText) {
  const text = (rawText || '').trim();
  if (!text) return '';
  const patterns = [
    /https?:\/\/v\.douyin\.com\/[A-Za-z0-9/_-]+/i,
    /https?:\/\/(?:www\.)?douyin\.com\/[^\s]+/i,
    /https?:\/\/(?:live\.)?douyin\.com\/[^\s]+/i
  ];
  for (let i = 0; i < patterns.length; i += 1) {
    const m = text.match(patterns[i]);
    if (m && m[0]) {
      return m[0].replace(/[，。；、]+$/, '');
    }
  }
  return '';
}

/**
 * 从后端 parse 响应或 add_task 响应中归一化主播字段。
 * @param {Record<string, unknown>} body
 * @returns {{ secUserId: string, anchorName: string, liveUrl: string }}
 */
function normalizeParsedAnchor(body) {
  if (!body || typeof body !== 'object') {
    return { secUserId: '', anchorName: '', liveUrl: '' };
  }
  const data =
    body.data && typeof body.data === 'object'
      ? /** @type {Record<string, unknown>} */ (body.data)
      : body;
  const d = /** @type {Record<string, unknown>} */ (data);
  const parsed =
    d.parsed && typeof d.parsed === 'object'
      ? /** @type {Record<string, unknown>} */ (d.parsed)
      : d;
  const p = /** @type {Record<string, unknown>} */ (parsed);
  return {
    secUserId: String(
      p.sec_user_id || p.secUserId || p.sec_uid || ''
    ).trim(),
    anchorName: String(
      p.anchor_name || p.anchorName || p.nickname || p.nick_name || ''
    ).trim(),
    liveUrl: String(
      p.live_url || p.liveUrl || p.url || ''
    ).trim()
  };
}

module.exports = {
  extractDouyinUrl,
  normalizeParsedAnchor
};
