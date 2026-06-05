/**
 * @fileoverview `/api/app/*` 业务接口响应解析（success: true，字段平铺根级）。
 * 主包与分包均可引用，避免主包同步 require 分包模块。
 */

/**
 * @typedef {Object} AppApiSuccessBody
 * @property {boolean} success
 * @property {string} [message]
 * @property {string} [error_code]
 */

/**
 * 解析 `/api/app/*` 业务接口响应，失败时抛出带 error_code 的 Error。
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function parseAppApiResponse(body) {
  if (!body || typeof body !== 'object') {
    throw Object.assign(new Error('服务端响应无效'), { errorCode: 'INVALID_RESPONSE' });
  }
  const b = /** @type {AppApiSuccessBody & Record<string, unknown>} */ (body);
  if (b.success === true) {
    return b;
  }
  const msg =
    (typeof b.message === 'string' && b.message.length > 0 ? b.message : '') ||
    (typeof b.error_code === 'string' ? b.error_code : '请求失败');
  const err = Object.assign(new Error(msg), {
    errorCode: typeof b.error_code === 'string' ? b.error_code : '',
    responseBody: b
  });
  throw err;
}

/**
 * 将非 2xx 的 `/api/app/*` 业务错误归一成带 errorCode/message 的 Error。
 * @param {unknown} err
 * @param {Record<string, string>} [errorMessages] - error_code 到友好文案的映射
 * @returns {Error}
 */
function normalizeAppApiError(err, errorMessages) {
  const data =
    err && typeof err === 'object'
      ? /** @type {{ data?: unknown, statusCode?: number }} */ (err).data
      : null;
  if (data && typeof data === 'object') {
    const b = /** @type {Record<string, unknown>} */ (data);
    const code = typeof b.error_code === 'string' ? b.error_code : '';
    const fallback = typeof b.message === 'string' && b.message ? b.message : '';
    const mapped = errorMessages && code ? errorMessages[code] : '';
    const msg = mapped || fallback || '请求失败';
    return Object.assign(new Error(msg), {
      errorCode: code,
      responseBody: b,
      statusCode: err && typeof err === 'object' ? err.statusCode : undefined
    });
  }
  return /** @type {Error} */ (err);
}

module.exports = {
  parseAppApiResponse,
  normalizeAppApiError
};
