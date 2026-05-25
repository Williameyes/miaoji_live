/**
 * @fileoverview WebSocket 一次性 Token 获取（纯净 GET，绕过全局 JSON 拦截器）。
 *
 * Nginx 会拦截带 Body 语义 Header 的 GET（如 content-type: application/json、自定义 roomId 头）。
 * roomId 仅允许出现在 URL Query 中。
 */

const { API_BASE_URL } = require('../config/api.js');

/** @type {string} */
const WS_TOKEN_PATH = '/api/get_token';

/**
 * 判断是否为 get_token 请求 URL。
 * @param {string} url
 * @returns {boolean}
 */
function isWsTokenUrl(url) {
  return String(url || '').indexOf('/api/get_token') >= 0;
}

/**
 * 发送前强制「洗白」get_token 请求，删除全局拦截器注入的违禁 Header 与 data。
 * @param {WechatMiniprogram.RequestOption} args wx.request 参数
 * @returns {WechatMiniprogram.RequestOption}
 */
function sanitizeWsTokenRequestArgs(args) {
  if (!args || !isWsTokenUrl(args.url)) {
    return args;
  }
  args.method = 'GET';
  delete args.data;

  var header = args.header && typeof args.header === 'object' ? args.header : {};
  delete header['Content-Type'];
  delete header['content-type'];
  delete header['Content-type'];
  delete header['roomId'];
  delete header['roomid'];
  delete header['RoomId'];
  delete header['charset'];
  delete header['Charset'];
  args.header = header;
  return args;
}

/**
 * 注册全局 request 拦截器（app 冷启动时调用一次）。
 * @returns {void}
 */
function installWsTokenRequestInterceptor() {
  if (typeof wx === 'undefined' || typeof wx.addInterceptor !== 'function') {
    return;
  }
  if (installWsTokenRequestInterceptor._installed) {
    return;
  }
  installWsTokenRequestInterceptor._installed = true;
  wx.addInterceptor('request', {
    invoke: function (args) {
      sanitizeWsTokenRequestArgs(args);
    }
  });
}

installWsTokenRequestInterceptor._installed = false;

/**
 * HTTP GET 换取 WebSocket 一次性 Token。
 * @param {string} roomId 6 位房间号
 * @returns {Promise<string>}
 */
function fetchWsToken(roomId) {
  var safeRoomId = encodeURIComponent(String(roomId || '').replace(/\D/g, '').slice(0, 6));
  var url = API_BASE_URL + WS_TOKEN_PATH + '?roomId=' + safeRoomId;

  return new Promise(function (resolve, reject) {
    var reqArgs = sanitizeWsTokenRequestArgs({
      url: url,
      method: 'GET',
      header: {},
      dataType: 'json',
      success: function (res) {
        if (!res || res.statusCode === 403) {
          reject(new Error('get_token forbidden'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('get_token HTTP_' + res.statusCode));
          return;
        }
        var body = res.data;
        var token = '';
        if (body && typeof body === 'object') {
          token = body.token || (body.data && body.data.token) || '';
        }
        if (!token && typeof body === 'string') {
          token = body;
        }
        if (token) {
          resolve(String(token));
        } else {
          reject(new Error('token missing'));
        }
      },
      fail: function (err) {
        reject(err || new Error('get_token fail'));
      }
    });
    wx.request(reqArgs);
  });
}

module.exports = {
  fetchWsToken: fetchWsToken,
  installWsTokenRequestInterceptor: installWsTokenRequestInterceptor,
  sanitizeWsTokenRequestArgs: sanitizeWsTokenRequestArgs,
  isWsTokenUrl: isWsTokenUrl
};

installWsTokenRequestInterceptor();
