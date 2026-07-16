/**
 * @fileoverview 「我的」页：getUserProfile + wx.login 对接 /api/auth/login；昵称 PUT /api/user/update（头像上传待后端）。
 */

const app = getApp();

const { API_PATH_USER_UPDATE } = require('../../config/api.js');

const {
  post,
  put,
  get,
  clearAuthStorage,
  STORAGE_TOKEN_KEY,
  STORAGE_USER_INFO_KEY,
  getToken
} = require('../../utils/request.js');

/** 与首页、Live 一致的全局分享卡片（5:4 PNG） */
const SHARE_IMAGE_URL = '/assets/images/global_share_card-1-288.png';

const {
  readPendingReferrer,
  clearPendingReferrer,
  writeVipExpireSnapshotMs,
  pickExpireAtFromUser,
  parseExpireAtToMs
} = require('../../utils/referral.js');

const { checkSyncLabWhitelist } = require('../../utils/sync-lab-whitelist.js');
const { checkHasMyPromos } = require('../../services/promo-live.service.js');

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
 * 已登录用户头像展示：无 URL 或仍为微信默认灰头像 CDN 时使用蓝色占位图。
 * @param {string} avatarUrl
 * @param {string} loggedInPlaceholderDataUri
 * @param {number} cacheBustMs
 * @returns {string}
 */
function pickLoggedInAvatarDisplaySrc(avatarUrl, loggedInPlaceholderDataUri, cacheBustMs) {
  const av = typeof avatarUrl === 'string' ? avatarUrl.trim() : '';
  if (av.length > 0 && !isLikelyDefaultWechatAvatarUrl(av)) {
    return `${av}?v=${cacheBustMs}`;
  }
  return loggedInPlaceholderDataUri;
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
    /** 当前用户是否在实验功能白名单内（仅白名单用户可见 sync-lab 入口） */
    isInWhitelist: false,
    /** 昵称是否为占位，需引导完善资料 */
    needCompleteProfile: false,
    avatarUrl: '',
    displayNick: '点击登录',
    avatarCacheKey: 0,
    displayAvatarSrc: '',
    vipStatusText: '尚未登录',
    vipStatusExpired: false,
    vipStatusRenewHintVisible: false,
    /** 去续期自定义弹窗 */
    showRenewModal: false,
    defaultAvatar:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">' +
          '<circle cx="60" cy="60" r="60" fill="#E2E8F0"/>' +
          '<circle cx="60" cy="46" r="18" fill="#94A3B8"/>' +
          '<path d="M30 102c4-18 18-28 30-28s26 10 30 28" fill="#94A3B8"/>' +
        '</svg>'
      ),
    /** 已登录且无有效自定义头像时的蓝色占位（与微信主色协调） */
    loggedInPlaceholderAvatar:
      'data:image/svg+xml;utf8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">' +
          '<circle cx="60" cy="60" r="60" fill="#3B82F6"/>' +
          '<circle cx="60" cy="46" r="18" fill="#EFF6FF"/>' +
          '<path d="M30 102c4-18 18-28 30-28s26 10 30 28" fill="#EFF6FF"/>' +
        '</svg>'
      ),
    /** 是否有已通过审批的推广（有才显示「我的推广」入口） */
    hasPromoData: false,
    /** 使用反馈自定义弹窗 */
    showFeedbackModal: false
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
    try {
      wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage'] });
    } catch (e) {
      // 低版本基础库忽略
    }
    this.syncUserState();
    this.refreshVipStatusFromServer();
    this.refreshPromoEntryVisibility();
  },

  /**
   * 刷新「我的推广」入口：有数据才展示。
   * @returns {void}
   */
  refreshPromoEntryVisibility: function () {
    if (!getToken()) {
      this.setData({ hasPromoData: false });
      return;
    }
    checkHasMyPromos()
      .then((hasData) => {
        this.setData({ hasPromoData: hasData === true });
      })
      .catch(() => {
        this.setData({ hasPromoData: false });
      });
  },

  /**
   * 跳转分包：抖音主页绑定。
   * @returns {void}
   */
  onPromoBindTap: function () {
    if (!getToken()) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/packagePromo/pages/promo-bind/promo-bind' });
  },

  /**
   * 跳转分包：我的推广。
   * @returns {void}
   */
  onPromoMyTap: function () {
    if (!getToken()) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/packagePromo/pages/promo-my/promo-my' });
  },

  /**
   * 「我的」页分享：与首页、Live 使用同一分享图，路径携带 referrerId。
   * @returns {WechatMiniprogram.Page.ICustomShareContent}
   */
  onShareAppMessage: function () {
    let raw = app.globalData.userInfo;
    if (!raw || typeof raw !== 'object') {
      try {
        const cached = wx.getStorageSync(STORAGE_USER_INFO_KEY);
        if (cached && typeof cached === 'object') {
          raw = cached;
        }
      } catch (e) {
        raw = null;
      }
    }
    let openid = '';
    if (raw && typeof raw === 'object') {
      const o = /** @type {Record<string, unknown>} */ (raw);
      const v = o.openid;
      openid = typeof v === 'string' ? v.trim() : '';
    }
    const path =
      openid.length > 0
        ? `/pages/index/index?referrerId=${encodeURIComponent(openid)}`
        : '/pages/index/index';
    return {
      title: '高光记分 — 邀你免费试用直播记分',
      path,
      imageUrl: SHARE_IMAGE_URL
    };
  },

  /**
   * 将输入时间格式化为 YYYY-MM-DD。
   * @param {unknown} expireAt
   * @returns {string}
   */
  formatExpireDate10: function (expireAt) {
    if (typeof expireAt === 'string' && expireAt.length >= 10) {
      return expireAt.slice(0, 10);
    }
    const ms = parseExpireAtToMs(expireAt);
    if (Number.isNaN(ms)) {
      return '';
    }
    const d = new Date(ms);
    const pad = (n) => `${n}`.padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  },

  /**
   * 将会员状态写入页面文案与引导展示。
   * @param {boolean} isVip
   * @param {unknown} expireAt
   * @returns {void}
   */
  applyVipStatusToView: function (isVip, expireAt) {
    if (isVip) {
      const d = this.formatExpireDate10(expireAt);
      this.setData({
        vipStatusText: d ? `试用权益：${d} 到期` : '试用权益：有效期内',
        vipStatusExpired: false,
        vipStatusRenewHintVisible: true
      });
      return;
    }

    const ms = parseExpireAtToMs(expireAt);
    const hasExpire = !Number.isNaN(ms);
    const isExpired = hasExpire && ms < Date.now();
    this.setData({
      vipStatusText: hasExpire && isExpired ? '当前试用已过期' : '尚未获得试用权益',
      vipStatusExpired: true,
      vipStatusRenewHintVisible: true
    });
  },

  /**
   * 每次进入「我的」页刷新会员状态，确保文案与后端一致。
   * @returns {void}
   */
  refreshVipStatusFromServer: function () {
    if (!getToken()) {
      this.setData({
        vipStatusText: '尚未登录',
        vipStatusExpired: false,
        vipStatusRenewHintVisible: false
      });
      return;
    }

    get('/api/auth/check-status', {}, {})
      .then((body) => {
        if (!body || typeof body !== 'object') {
          this.setData({
            vipStatusText: '权益状态获取失败',
            vipStatusExpired: false,
            vipStatusRenewHintVisible: false
          });
          return;
        }
        const res = /** @type {Record<string, unknown>} */ (body);
        if (res.code !== 0 || !res.data || typeof res.data !== 'object') {
          this.setData({
            vipStatusText: '权益状态获取失败',
            vipStatusExpired: false,
            vipStatusRenewHintVisible: false
          });
          return;
        }
        const d = /** @type {Record<string, unknown>} */ (res.data);
        const isVip = d.isVip === true;
        const expireAt = d.expireAt !== undefined ? d.expireAt : d.expire_at;
        this.applyVipStatusToView(isVip, expireAt);
        writeVipExpireSnapshotMs(expireAt);
      })
      .catch(() => {
        this.setData({
          vipStatusText: '权益状态获取失败',
          vipStatusExpired: false,
          vipStatusRenewHintVisible: false
        });
      });
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
    const displayAvatarSrc = hasToken
      ? pickLoggedInAvatarDisplaySrc(av, this.data.loggedInPlaceholderAvatar, ts)
      : this.data.defaultAvatar;
    const inWhitelist = hasToken && checkSyncLabWhitelist();
    this.setData({
      userInfo: /** @type {MineUserInfo} */ (info),
      loggedIn: hasToken,
      isInWhitelist: inWhitelist,
      needCompleteProfile,
      displayNick: n.nickName || PLACEHOLDER_NICK,
      avatarUrl: av,
      avatarCacheKey: ts,
      displayAvatarSrc
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
    const loggedInPh = this.data.loggedInPlaceholderAvatar;
    let displayAvatarSrc = defaultAvatar;
    if (loggedIn) {
      displayAvatarSrc = pickLoggedInAvatarDisplaySrc(avatarUrl, loggedInPh, avatarCacheKey || Date.now());
    }

    if (!loggedIn) {
      displayNick = '点击登录';
      userInfo = null;
      needCompleteProfile = false;
    }

    const inWhitelist = loggedIn && checkSyncLabWhitelist();
    this.setData({
      userInfo,
      loggedIn,
      isInWhitelist: inWhitelist,
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

            const pendingRef = readPendingReferrer();
            if (pendingRef.length > 0) {
              /** 后端兼容 referrerId / referrer_id */
              loginPayload.referrerId = pendingRef;
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

                clearPendingReferrer();

                // 若后端 userInfo 没有返回 avatarUrl，以 getUserProfile 的 URL 补全本地展示
                // （不影响后端存储，避免覆盖用户已自定义的头像）
                const profileAvatarUrl =
                  profileRes.userInfo && typeof profileRes.userInfo.avatarUrl === 'string'
                    ? profileRes.userInfo.avatarUrl
                    : '';
                const mergedRaw = /** @type {Record<string, unknown>} */ ({ ...userInfoRaw });
                if (
                  profileAvatarUrl.length > 0 &&
                  !mergedRaw.avatarUrl &&
                  !mergedRaw.avatar_url
                ) {
                  mergedRaw.avatarUrl = profileAvatarUrl;
                }

                writeVipExpireSnapshotMs(pickExpireAtFromUser(mergedRaw));

                this.applyUserInfoToView(mergedRaw);
                // 登录成功后立即刷新权益状态，确保 vipStatusText 不再停留在"尚未登录"
                this.refreshVipStatusFromServer();
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

  /**
   * 跳转使用帮助页。
   * @returns {void}
   */
  onHelpTap: function () {
    wx.navigateTo({ url: '/pages/help/help' });
  },

  /**
   * 实验功能「自动同步」入口：仅白名单用户可进入采集端。
   * 非白名单用户收到模糊提示，不暴露功能细节。
   * @returns {void}
   */
  onSyncLabTap: function () {
    if (!this.data.loggedIn) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    if (!checkSyncLabWhitelist()) {
      wx.showToast({ title: '暂无使用权限', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/packageLab/pages/sync-lab/collector/collector' });
  },

  /**
   * 实验功能「高光素材机」入口：仅白名单用户可进入。
   * @returns {void}
   */
  onHighlightRecTap: function () {
    if (!this.data.loggedIn) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    if (!checkSyncLabWhitelist()) {
      wx.showToast({ title: '暂无使用权限', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/packageRec/pages/highlight-rec/highlight-rec' });
  },

  /**
   * 实验功能「投篮训练」入口：仅白名单用户可进入。
   * @returns {void}
   */
  onShootingTrainingTap: function () {
    if (!this.data.loggedIn) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    if (!checkSyncLabWhitelist()) {
      wx.showToast({ title: '暂无使用权限', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/packageRec/pages/shooting-training/shooting-training' });
  },

  /**
   * 实验功能「直播雷达」入口：仅白名单用户可进入（与自动同步一致）。
   * @returns {void}
   */
  onRadarLabTap: function () {
    if (!this.data.loggedIn) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    if (!checkSyncLabWhitelist()) {
      wx.showToast({ title: '暂无使用权限', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/packageLab/pages/radar-lab/index/index' });
  },

  /**
   * 实验功能「雷达多模态挂载」入口：仅白名单用户可进入。
   * @returns {void}
   */
  onRadarLabMountTap: function () {
    if (!this.data.loggedIn) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    if (!checkSyncLabWhitelist()) {
      wx.showToast({ title: '暂无使用权限', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/packageLab/pages/radar-lab/mount/index' });
  },

  onRadarLabWarmupTap: function () {
    if (!this.data.loggedIn) {
      wx.showToast({ title: '请先登录', icon: 'none' });
      return;
    }
    if (!checkSyncLabWhitelist()) {
      wx.showToast({ title: '暂无使用权限', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/packageLab/pages/radar-lab/warmup/index' });
  },

  onAboutTap: function () {
    wx.showModal({
      title: '关于我们',
      content: '高光记分：比赛记分与高光管理，为业余与校园赛事提供轻量记录体验。',
      showCancel: false,
      confirmText: '知道了'
    });
  },

  onFeedbackTap: function () {
    this.setData({ showFeedbackModal: true });
  },

  /**
   * 关闭使用反馈弹窗。
   * @returns {void}
   */
  closeFeedbackModal: function () {
    this.setData({ showFeedbackModal: false });
  },

  /**
   * 阻止弹窗内部点击事件冒泡到遮罩。
   * @returns {void}
   */
  stopFeedbackModalBubble: function () {},

  /**
   * 拦截弹窗区域的滑动穿透。
   * @returns {void}
   */
  onFeedbackModalCatchMove: function () {},

  /**
   * 会员不足时的续期引导：展示自定义弹窗。
   * @returns {void}
   */
  onVipRenewTap: function () {
    this.setData({ showRenewModal: true });
    try {
      wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage'] });
    } catch (e) {
      // 低版本基础库忽略
    }
  },

  /**
   * 关闭续期引导弹窗。
   * @returns {void}
   */
  closeRenewModal: function () {
    this.setData({ showRenewModal: false });
  },

  /**
   * 阻止弹窗内部点击事件冒泡到遮罩。
   * @returns {void}
   */
  stopRenewModalBubble: function () {},

  /**
   * 拦截弹窗区域的滑动穿透。
   * @returns {void}
   */
  onRenewModalCatchMove: function () {},

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
