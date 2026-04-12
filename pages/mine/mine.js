/**
 * @fileoverview 「我的」页：getUserProfile + wx.login 对接 /api/auth/login；昵称 PUT /api/user/update（头像上传待后端）。
 */

const app = getApp();

const { API_PATH_USER_UPDATE } = require('../../config/api.js');

const {
  post,
  put,
  clearAuthStorage,
  STORAGE_TOKEN_KEY,
  STORAGE_USER_INFO_KEY,
  getToken
} = require('../../utils/request.js');

/** 后端占位昵称，需引导用户完善 */
const PLACEHOLDER_NICK = '微信用户';

/**
 * 判断是否为微信侧常见默认头像（小尺寸 132 等），避免登录时把明文 URL 传给服务端覆盖用户已上传的 COS 头像。
 * @param {string} url
 * @returns {boolean}
 */
function isLikelyDefaultWechatAvatarUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    return true;
  }
  const u = url.toLowerCase();
  if (u.indexOf('thirdwx.qlogo.cn') < 0 && u.indexOf('wx.qlogo.cn') < 0) {
    return false;
  }
  const path = u.split('?')[0];
  return /\/132(\/|$)/.test(path) || /\/0(\/|$)/.test(path);
}

/**
 * @typedef {Object} MineUserInfo
 * @property {number} [id]
 * @property {string} [openid]
 * @property {string} [nickName]
 * @property {string} [avatarUrl]
 * @property {boolean} [isAdmin]
 */

/**
 * @param {Record<string, unknown>} raw - 原始 userInfo
 * @returns {MineUserInfo | null}
 */
function normalizeUserInfo(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const o = /** @type {Record<string, unknown>} */ (raw);
  const nick =
    (typeof o.nickName === 'string' && o.nickName.trim()) ||
    (typeof o.nickname === 'string' && o.nickname.trim()) ||
    (typeof o.name === 'string' && o.name.trim()) ||
    '';
  const avatar =
    (typeof o.avatarUrl === 'string' && o.avatarUrl) ||
    (typeof o.avatar_url === 'string' && o.avatar_url) ||
    (typeof o.headimgurl === 'string' && o.headimgurl) ||
    '';
  return /** @type {MineUserInfo} */ ({
    ...o,
    nickName: nick,
    avatarUrl: avatar
  });
}

/**
 * 是否为占位或未设置昵称，需引导点头像/填昵称。
 * @param {MineUserInfo | Record<string, unknown> | null} info
 * @returns {boolean}
 */
function shouldShowProfileHint(info) {
  if (!info || typeof info !== 'object') {
    return false;
  }
  const nick =
    typeof info.nickName === 'string' ? info.nickName.trim() : '';
  return nick === '' || nick === PLACEHOLDER_NICK;
}

/**
 * 组装 POST /api/auth/login 的 JSON：五项加密字段必填；明文 nickName/avatarUrl 仅在为「非占位」时附带，
 * 避免服务端用「微信用户」/默认头像 URL 覆盖库中已通过 PUT 修改的资料。
 * @param {string} code - wx.login 返回的临时登录凭证
 * @param {Object} profile - wx.getUserProfile 成功回调参数
 * @returns {Record<string, string>}
 */
function buildLoginPostPayload(code, profile) {
  if (!profile || typeof profile !== 'object') {
    return {
      code,
      rawData: '',
      signature: '',
      encryptedData: '',
      iv: ''
    };
  }
  const p = /** @type {Record<string, unknown>} */ (profile);
  const rawData = typeof p.rawData === 'string' ? p.rawData : '';
  const signature = typeof p.signature === 'string' ? p.signature : '';
  const encryptedData = typeof p.encryptedData === 'string' ? p.encryptedData : '';
  const iv = typeof p.iv === 'string' ? p.iv : '';
  const ui =
    p.userInfo && typeof p.userInfo === 'object'
      ? /** @type {Record<string, unknown>} */ (p.userInfo)
      : {};
  const nickName = typeof ui.nickName === 'string' ? ui.nickName.trim() : '';
  const avatarUrl = typeof ui.avatarUrl === 'string' ? ui.avatarUrl.trim() : '';

  const payload = /** @type {Record<string, string>} */ ({
    code,
    rawData,
    signature,
    encryptedData,
    iv
  });
  if (nickName.length > 0 && nickName !== PLACEHOLDER_NICK) {
    payload.nickName = nickName;
  }
  if (avatarUrl.length > 0 && !isLikelyDefaultWechatAvatarUrl(avatarUrl)) {
    payload.avatarUrl = avatarUrl;
  }
  return payload;
}

/**
 * 校验登录五项加密字段是否均为非空（服务端 `if (!data[field])` 会拒绝空串）。
 * @param {Record<string, string>} body
 * @returns {string | null} 缺省时返回缺失字段名，否则 null
 */
function findMissingLoginCryptoField(body) {
  const keys = ['code', 'rawData', 'signature', 'encryptedData', 'iv'];
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    const v = body[k];
    if (typeof v !== 'string' || v.length === 0) {
      return k;
    }
  }
  return null;
}

/**
 * 从 PUT /api/user/update 成功响应中取出用户对象。
 * @param {unknown} body
 * @returns {Record<string, unknown> | null}
 */
function pickUserFromUpdateResponse(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const b = /** @type {Record<string, unknown>} */ (body);
  if (b.code !== undefined && b.code !== 0) {
    return null;
  }
  const d = b.data;
  if (!d || typeof d !== 'object') {
    return null;
  }
  return /** @type {Record<string, unknown>} */ (d);
}

Page({
  data: {
    statusBarHeight: 0,
    userInfo: /** @type {MineUserInfo | null} */ (null),
    loggedIn: false,
    /** 昵称是否为占位，需引导完善资料 */
    needCompleteProfile: false,
    avatarUrl: '',
    displayNick: '点击登录',
    avatarCacheKey: 0,
    displayAvatarSrc: '',
    defaultAvatar:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">' +
          '<circle cx="60" cy="60" r="60" fill="#E2E8F0"/>' +
          '<circle cx="60" cy="46" r="18" fill="#94A3B8"/>' +
          '<path d="M30 102c4-18 18-28 30-28s26 10 30 28" fill="#94A3B8"/>' +
        '</svg>'
      )
  },

  onLoad: function () {
    const sys = wx.getSystemInfoSync();
    this.setData({ statusBarHeight: sys.statusBarHeight || 0 });
    this.syncUserState();
  },

  onShow: function () {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 });
    }
    this.syncUserState();
  },

  /**
   * 将用户信息写入 globalData、Storage 与界面。
   * @param {Record<string, unknown> | MineUserInfo} info
   * @returns {void}
   */
  applyUserInfoToView: function (info) {
    const n = normalizeUserInfo(/** @type {Record<string, unknown>} */ (info));
    if (!n) {
      return;
    }
    app.globalData.userInfo = /** @type {MineUserInfo} */ (info);
    try {
      wx.setStorageSync(STORAGE_USER_INFO_KEY, info);
    } catch (e) {}
    const ts = Date.now();
    const av = n.avatarUrl || '';
    const hasToken = !!getToken();
    const needCompleteProfile = hasToken && shouldShowProfileHint(/** @type {MineUserInfo} */ (info));
    this.setData({
      userInfo: /** @type {MineUserInfo} */ (info),
      loggedIn: hasToken,
      needCompleteProfile,
      displayNick: n.nickName || PLACEHOLDER_NICK,
      avatarUrl: av,
      avatarCacheKey: ts,
      displayAvatarSrc: av ? `${av}?v=${ts}` : this.data.defaultAvatar
    });
  },

  /**
   * 从本地 token + 缓存恢复界面。
   * @returns {void}
   */
  syncUserState: function () {
    const token = getToken();
    let rawInfo = app.globalData.userInfo;
    if (!rawInfo || typeof rawInfo !== 'object') {
      try {
        const raw = wx.getStorageSync(STORAGE_USER_INFO_KEY);
        if (raw && typeof raw === 'object') {
          rawInfo = raw;
        }
      } catch (e) {
        rawInfo = null;
      }
    }

    const info = rawInfo ? normalizeUserInfo(/** @type {Record<string, unknown>} */ (rawInfo)) : null;
    if (info && token) {
      app.globalData.userInfo = info;
      try {
        wx.setStorageSync(STORAGE_USER_INFO_KEY, info);
      } catch (e) {}
    }

    const loggedIn = !!token;
    let displayNick = '点击登录';
    let avatarUrl = '';
    let avatarCacheKey = this.data.avatarCacheKey || 0;
    let userInfo = /** @type {MineUserInfo | null} */ (null);
    let needCompleteProfile = false;

    if (loggedIn && info) {
      userInfo = info;
      displayNick = info.nickName || PLACEHOLDER_NICK;
      avatarUrl = info.avatarUrl || '';
      needCompleteProfile = shouldShowProfileHint(info);
    }

    const defaultAvatar = this.data.defaultAvatar;
    let displayAvatarSrc = defaultAvatar;
    if (loggedIn && avatarUrl) {
      displayAvatarSrc = `${avatarUrl}${avatarCacheKey ? `?v=${avatarCacheKey}` : ''}`;
    } else if (loggedIn && !avatarUrl) {
      displayAvatarSrc = defaultAvatar;
    }

    if (!loggedIn) {
      displayNick = '点击登录';
      userInfo = null;
      needCompleteProfile = false;
    }

    this.setData({
      userInfo,
      loggedIn,
      needCompleteProfile,
      displayNick,
      avatarUrl,
      avatarCacheKey,
      displayAvatarSrc
    });
  },

  /**
   * 登录：先 wx.getUserProfile（保留手势），再 wx.login 取 code，五项 + nickName/avatarUrl POST /api/auth/login。
   * @returns {void}
   */
  handleLogin: function () {
    if (this.data.loggedIn) {
      return;
    }

    wx.showLoading({ title: '登录中', mask: true });
    wx.getUserProfile({
      desc: '用于登录并展示你的昵称与头像',
      success: (profileRes) => {
        wx.login({
          success: (loginRes) => {
            const code = loginRes.code;
            if (!code) {
              wx.hideLoading();
              wx.showToast({ title: '获取登录凭证失败', icon: 'none' });
              return;
            }

            const loginPayload = buildLoginPostPayload(code, profileRes);
            const missing = findMissingLoginCryptoField(loginPayload);
            if (missing) {
              wx.hideLoading();
              wx.showToast({
                title: `授权数据不完整(${missing})，请重试`,
                icon: 'none'
              });
              return;
            }

            post('/api/auth/login', loginPayload, { skipAuth: true })
              .then((body) => {
                wx.hideLoading();
                console.log('[mine/login] 登录接口完整响应:', JSON.stringify(body));

                const res = /** @type {Record<string, unknown>} */ (body);
                if (res.code !== 0 || !res.data || typeof res.data !== 'object') {
                  const msg =
                    typeof res.message === 'string' ? res.message : '登录失败';
                  wx.showToast({ title: msg, icon: 'none' });
                  return;
                }

                const data = /** @type {Record<string, unknown>} */ (res.data);
                const token = data.token;
                const userInfoRaw = data.userInfo;

                if (typeof token !== 'string' || !token) {
                  wx.showToast({ title: '未返回有效 token', icon: 'none' });
                  return;
                }
                if (!userInfoRaw || typeof userInfoRaw !== 'object') {
                  wx.showToast({ title: '未返回用户信息', icon: 'none' });
                  return;
                }

                wx.setStorageSync(STORAGE_TOKEN_KEY, token);

                const normalized = normalizeUserInfo(
                  /** @type {Record<string, unknown>} */ (userInfoRaw)
                );
                if (!normalized) {
                  wx.showToast({ title: '用户信息格式异常', icon: 'none' });
                  return;
                }

                this.applyUserInfoToView(/** @type {Record<string, unknown>} */ (userInfoRaw));
                wx.showToast({ title: '登录成功', icon: 'success' });
              })
              .catch((err) => {
                wx.hideLoading();
                const msg =
                  err && typeof err === 'object' && 'message' in err
                    ? String(/** @type {Error} */ (err).message)
                    : '网络异常';
                if (msg === 'UNAUTHORIZED') {
                  return;
                }
                wx.showToast({ title: msg.length > 20 ? '登录失败' : msg, icon: 'none' });
              });
          },
          fail: () => {
            wx.hideLoading();
            wx.showToast({ title: '获取登录凭证失败', icon: 'none' });
          }
        });
      },
      fail: () => {
        wx.hideLoading();
        wx.showToast({
          title: '需要授权昵称与头像后才能登录',
          icon: 'none'
        });
      }
    });
  },

  handleLogout: function () {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      confirmColor: '#E64340',
      success: (res) => {
        if (!res.confirm) {
          return;
        }
        clearAuthStorage();
        this.syncUserState();
        wx.showToast({ title: '已退出', icon: 'success' });
      }
    });
  },

  onAboutTap: function () {
    wx.showModal({
      title: '关于秒记',
      content: '秒记篮场助手：篮球比赛计分与高光管理，为业余与校园赛事提供轻量记录体验。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  onFeedbackTap: function () {
    wx.showModal({
      title: '使用反馈',
      content: '如有建议或问题，可在后续版本通过客服或邮箱反馈，感谢支持。',
      showCancel: false,
      confirmText: '好的'
    });
  },

  /**
   * 昵称失焦 → PUT /api/user/update；支持清空（传 ""）；昵称 ≤64 字。
   * @param {Object} e
   * @returns {void}
   */
  onNicknameConfirm: function (e) {
    const raw = e.detail && e.detail.value !== undefined && e.detail.value !== null
      ? String(e.detail.value)
      : '';
    const v = raw.trim();
    if (!getToken()) {
      return;
    }
    if (v.length > 64) {
      wx.showToast({ title: '昵称最长 64 字', icon: 'none' });
      return;
    }

    wx.showLoading({ title: '保存中', mask: true });
    put(API_PATH_USER_UPDATE, { nickName: v }, {})
      .then((body) => {
        wx.hideLoading();
        const res = /** @type {Record<string, unknown>} */ (body);
        if (res.code !== undefined && res.code !== 0) {
          const msg = typeof res.message === 'string' ? res.message : '保存失败';
          wx.showToast({ title: msg, icon: 'none' });
          return;
        }
        const updated = pickUserFromUpdateResponse(body);
        if (updated) {
          this.applyUserInfoToView(updated);
        } else {
          const prev =
            app.globalData.userInfo && typeof app.globalData.userInfo === 'object'
              ? app.globalData.userInfo
              : {};
          const next = /** @type {MineUserInfo} */ ({
            ...prev,
            nickName: v || ''
          });
          this.applyUserInfoToView(/** @type {Record<string, unknown>} */ (next));
        }
      })
      .catch((err) => {
        wx.hideLoading();
        const msg =
          err && typeof err === 'object' && 'message' in err
            ? String(/** @type {Error} */ (err).message)
            : '保存失败';
        wx.showToast({ title: msg.length > 20 ? '保存失败' : msg, icon: 'none' });
      });
  }
});
