/**
 * @fileoverview 封装 wx.request：统一 BaseURL、Bearer Token、401/鉴权失败处理。
 */

const { API_BASE_URL: BASE_URL } = require('../config/api.js');

/** 本地存储：登录令牌 */
const STORAGE_TOKEN_KEY = 'token';

/** 本地存储：用户信息（与 app.globalData.userInfo 同步） */
const STORAGE_USER_INFO_KEY = 'userInfo';

/** 401 后回退的首页（不依赖尚未注册的「我的」页） */
const UNAUTH_FALLBACK_URL = '/pages/index/index';

/**
 * 读取本地 token。
 * @returns {string}
 */
function getToken() {
  const t = wx.getStorageSync(STORAGE_TOKEN_KEY);
  return typeof t === 'string' ? t : '';
}

/**
 * 判断响应体是否表示 Token 失效（按常见后端约定，可按实际接口微调）。
 * @param {unknown} data - wx.request success 中的 res.data
 * @returns {boolean}
 */
function isTokenInvalidPayload(data) {
  if (data == null || typeof data !== 'object') return false;
  const d = /** @type {Record<string, unknown>} */ (data);
  if (d.code === 401 || d.statusCode === 401) return true;
  return false;
}

/**
 * 清空鉴权相关缓存，并同步 globalData。
 * @returns {void}
 */
function clearAuthStorage() {
  try {
    wx.removeStorageSync(STORAGE_TOKEN_KEY);
  } catch (e) {
    wx.setStorageSync(STORAGE_TOKEN_KEY, '');
  }
  try {
    wx.removeStorageSync(STORAGE_USER_INFO_KEY);
  } catch (e) {
    wx.setStorageSync(STORAGE_USER_INFO_KEY, null);
  }
  try {
    const app = getApp();
    if (app && app.globalData) {
      app.globalData.userInfo = null;
    }
  } catch (e) {
    // getApp 在极少数时机可能不可用，忽略
  }
}

/**
 * Token 失效时的统一引导：清缓存、提示、回首页（可改为跳转「我的」）。
 * @returns {void}
 */
function handleUnauthorized() {
  clearAuthStorage();
  wx.showToast({ title: '登录已失效，请重新登录', icon: 'none', duration: 2000 });
  setTimeout(() => {
    wx.reLaunch({ url: UNAUTH_FALLBACK_URL });
  }, 400);
}

/**
 * 封装后的请求（Promise）。
 * @param {Object} options - 与 wx.request 一致，url 可为相对路径（自动拼 BASE_URL）
 * @param {string} options.url
 * @param {string} [options.method]
 * @param {Record<string, unknown>} [options.data]
 * @param {Record<string, string>} [options.header]
 * @param {boolean} [options.skipAuth] - 为 true 时不带 Authorization（如登录接口），且不触发全局登出
 * @returns {Promise<unknown>}
 */
function request(options) {
  const {
    url,
    method = 'GET',
    data = {},
    header = {},
    skipAuth = false,
    ...rest
  } = options;

  if (!url) {
    return Promise.reject(new Error('request: url 不能为空'));
  }

  const fullUrl = url.indexOf('http') === 0 ? url : `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
  const token = getToken();
  const authHeader =
    !skipAuth && token ? { Authorization: `Bearer ${token}` } : {};

  const isLoginPost =
    String(method).toUpperCase() === 'POST' && String(url).indexOf('/api/auth/login') >= 0;
  if (isLoginPost && data && typeof data === 'object') {
    console.log('[request] POST /api/auth/login', 'fullUrl=', fullUrl);
    console.log('[request] login body:', JSON.stringify(data));
  }

  return new Promise((resolve, reject) => {
    wx.request({
      url: fullUrl,
      method,
      data,
      header: {
        'Content-Type': 'application/json',
        ...authHeader,
        ...header
      },
      ...rest,
      success: (res) => {
        const { statusCode, data: body } = res;

        const authFailed =
          statusCode === 401 || (statusCode === 200 && isTokenInvalidPayload(body));
        if (authFailed) {
          if (!skipAuth) {
            handleUnauthorized();
            reject(Object.assign(new Error('UNAUTHORIZED'), { statusCode, data: body }));
          } else {
            const d = body && typeof body === 'object' ? body : {};
            const msg =
              typeof d.message === 'string' && d.message.length > 0
                ? d.message
                : statusCode === 401
                  ? '登录失败'
                  : '请求失败';
            reject(Object.assign(new Error(msg), { statusCode, data: body }));
          }
          return;
        }

        if (statusCode >= 200 && statusCode < 300) {
          resolve(body);
          return;
        }

        reject(Object.assign(new Error(`HTTP_${statusCode}`), { statusCode, data: body }));
      },
      fail: (err) => {
        const raw = err && typeof err.errMsg === 'string' ? err.errMsg : '';
        let message = '网络异常';
        if (
          raw.indexOf('domain list') >= 0 ||
          raw.indexOf('合法域名') >= 0 ||
          raw.indexOf('not in domain') >= 0
        ) {
          message =
            '请求域名未通过校验：请使用 https 备案域名并在公众平台配置 request 合法域名（不可使用 IP/端口）';
        } else if (raw.indexOf('ssl') >= 0 || raw.indexOf('certificate') >= 0 || raw.indexOf('TLS') >= 0) {
          message = 'HTTPS 证书校验失败，请检查服务器证书链';
        } else if (raw.indexOf('timeout') >= 0 || raw.indexOf('超时') >= 0) {
          message = '请求超时，请稍后重试';
        } else if (raw.length > 0) {
          message = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
        }
        reject(Object.assign(new Error(message), { errMsg: raw, original: err }));
      }
    });
  });
}

/**
 * GET 请求快捷方法。
 * @param {string} url
 * @param {Record<string, unknown>} [data]
 * @param {Omit<Parameters<typeof request>[0], 'url'|'method'|'data'>} [extra]
 * @returns {Promise<unknown>}
 */
function get(url, data, extra) {
  return request({ url, method: 'GET', data: data || {}, ...(extra || {}) });
}

/**
 * POST 请求快捷方法。
 * @param {string} url
 * @param {Record<string, unknown>} [data]
 * @param {Omit<Parameters<typeof request>[0], 'url'|'method'|'data'>} [extra]
 * @returns {Promise<unknown>}
 */
function post(url, data, extra) {
  return request({ url, method: 'POST', data: data || {}, ...(extra || {}) });
}

/**
 * PUT JSON 请求。
 * @param {string} url
 * @param {Record<string, unknown>} [data]
 * @param {Omit<Parameters<typeof request>[0], 'url'|'method'|'data'>} [extra]
 * @returns {Promise<unknown>}
 */
function put(url, data, extra) {
  return request({ url, method: 'PUT', data: data || {}, ...(extra || {}) });
}

/**
 * 上传本地文件（携带 Bearer，与业务域名一致）。
 * @param {Object} opts
 * @param {string} opts.filePath - 本地临时路径
 * @param {string} opts.url - 相对路径，如 /api/upload
 * @param {string} [opts.name] - 表单字段名，默认 file
 * @param {Record<string, string>} [opts.formData]
 * @param {boolean} [opts.skipAuth]
 * @returns {Promise<unknown>} 解析后的 JSON
 */
function uploadFile(opts) {
  const {
    filePath,
    url,
    name = 'file',
    formData = {},
    skipAuth = false
  } = opts;

  if (!filePath || !url) {
    return Promise.reject(new Error('uploadFile: filePath/url 不能为空'));
  }

  const fullUrl = url.indexOf('http') === 0 ? url : `${BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
  const token = getToken();
  const authHeader =
    !skipAuth && token ? { Authorization: `Bearer ${token}` } : {};

  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: fullUrl,
      filePath,
      name,
      formData,
      header: {
        ...authHeader
      },
      success: (res) => {
        const statusCode = res.statusCode;
        let body;
        try {
          body =
            typeof res.data === 'string' && res.data.length > 0
              ? JSON.parse(res.data)
              : res.data;
        } catch (e) {
          reject(Object.assign(new Error('上传响应不是合法 JSON'), { statusCode, raw: res.data }));
          return;
        }

        const authFailed =
          statusCode === 401 ||
          (statusCode === 200 &&
            body &&
            typeof body === 'object' &&
            isTokenInvalidPayload(body));
        if (authFailed) {
          if (!skipAuth) {
            handleUnauthorized();
            reject(Object.assign(new Error('UNAUTHORIZED'), { statusCode, data: body }));
          } else {
            const d = body && typeof body === 'object' ? body : {};
            const msg =
              typeof d.message === 'string' && d.message.length > 0
                ? d.message
                : '上传失败';
            reject(Object.assign(new Error(msg), { statusCode, data: body }));
          }
          return;
        }

        if (statusCode >= 200 && statusCode < 300) {
          resolve(body);
          return;
        }

        reject(Object.assign(new Error(`HTTP_${statusCode}`), { statusCode, data: body }));
      },
      fail: (err) => {
        reject(err);
      }
    });
  });
}

module.exports = {
  BASE_URL,
  STORAGE_TOKEN_KEY,
  STORAGE_USER_INFO_KEY,
  getToken,
  clearAuthStorage,
  request,
  get,
  post,
  put,
  uploadFile
};
