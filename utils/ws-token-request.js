/**
 * @fileoverview WebSocket 一次性 Token 获取（严格对齐 docs/client-integration.md §2.2）。
 *
 * POST /api/get_token?roomId=xxxxxx
 * - 原生 wx.request，不经任何包装/拦截器
 * - Header 仅 Content-Type
 * - 不传 data（body 为空，文档：「无需传 JSON」）
 */

const { API_BASE_URL } = require('../config/api.js');

/** @type {string} */
const WS_TOKEN_PATH = '/api/get_token';
/** @type {number} */
const WS_TOKEN_TIMEOUT_MS = 10000;

/**
 * HTTP POST 换取 WebSocket 一次性 Token。
 * @param {string} roomId 6 位房间号
 * @returns {Promise<string>}
 */
function fetchWsToken(roomId) {
  var safeRoomId = String(roomId || '').replace(/\D/g, '').slice(0, 6);
  if (safeRoomId.length !== 6) {
    return Promise.reject(new Error('invalid roomId'));
  }
  var url = API_BASE_URL + WS_TOKEN_PATH + '?roomId=' + safeRoomId;

  return new Promise(function (resolve, reject) {
    wx.request({
      url: url,
      method: 'POST',
      timeout: WS_TOKEN_TIMEOUT_MS,
      header: {
        'Content-Type': 'application/json'
      },
      dataType: 'json',
      success: function (res) {
        if (!res || res.statusCode !== 200) {
          var errMsg = 'get_token HTTP_' + (res && res.statusCode ? res.statusCode : 'unknown');
          if (typeof res.data === 'string' && res.data.indexOf('<html') >= 0) {
            errMsg = 'get_token 网关未转发（Nginx 403，请确认 /api/get_token 已 proxy_pass 到 Node）';
          } else if (res && res.data && typeof res.data === 'object' && res.data.error) {
            errMsg = String(res.data.error);
          }
          reject(new Error(errMsg));
          return;
        }
        var body = res.data;
        if (!body || typeof body !== 'object' || !body.token) {
          reject(new Error('token missing'));
          return;
        }
        resolve(String(body.token));
      },
      fail: function (err) {
        reject(err || new Error('get_token fail'));
      }
    });
  });
}

module.exports = {
  fetchWsToken: fetchWsToken,
  WS_TOKEN_TIMEOUT_MS: WS_TOKEN_TIMEOUT_MS
};
