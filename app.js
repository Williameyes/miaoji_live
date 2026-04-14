const { STORAGE_USER_INFO_KEY, getToken, get } = require('./utils/request.js');
const {
  persistPendingReferrerFromQuery,
  consumeVipExtensionCelebrationIfNeeded
} = require('./utils/referral.js');

App({
  /**
   * 小程序冷启动：恢复用户缓存、捕获分享带来的邀请人参数。
   * @param {WechatMiniprogram.App.LaunchShowOption} options
   * @returns {void}
   */
  onLaunch: function (options) {
    try {
      const cached = wx.getStorageSync(STORAGE_USER_INFO_KEY);
      if (cached && typeof cached === 'object') {
        this.globalData.userInfo = cached;
      }
    } catch (e) {
      // 忽略缓存读取异常
    }

    if (options && options.query) {
      persistPendingReferrerFromQuery(/** @type {Record<string, string | undefined>} */ (options.query));
    }

    // 初始化文件系统
    const fs = wx.getFileSystemManager();
    const highlightDir = `${wx.env.USER_DATA_PATH}/highlights`;
    
    fs.access({
      path: highlightDir,
      fail: () => {
        fs.mkdir({
          dirPath: highlightDir,
          recursive: true,
          success: () => console.log('Highlight directory created'),
          fail: (err) => console.error('Failed to create highlight directory', err)
        });
      }
    });
  },

  /**
   * 从后台回到前台：再次合并邀请参数；已登录时拉取权益状态，检测邀请续期并提示。
   * @param {WechatMiniprogram.App.LaunchShowOption} options
   * @returns {void}
   */
  onShow: function (options) {
    if (options && options.query) {
      persistPendingReferrerFromQuery(/** @type {Record<string, string | undefined>} */ (options.query));
    }
    if (!getToken()) {
      return;
    }
    get('/api/auth/check-status', {}, {})
      .then((body) => {
        if (!body || typeof body !== 'object') {
          return;
        }
        const res = /** @type {Record<string, unknown>} */ (body);
        if (res.code !== 0 || !res.data || typeof res.data !== 'object') {
          return;
        }
        const d = /** @type {Record<string, unknown>} */ (res.data);
        const isVip = d.isVip === true;
        const expireAt = d.expireAt !== undefined ? d.expireAt : d.expire_at;
        const shouldCelebrate = consumeVipExtensionCelebrationIfNeeded(isVip, expireAt);
        if (shouldCelebrate) {
          wx.showToast({
            title: '好友已激活，5天权益已到账',
            icon: 'none',
            duration: 2800
          });
        }
      })
      .catch(() => {
        // 静默失败，不打断用户操作
      });
  },

  globalData: {
    /** 当前登录用户信息（与本地 userInfo 缓存同步；未登录为 null） */
    userInfo: null,
    matchConfig: {
      matchName: '',
      matchNameColor: '#E64340',
      teamA: { name: '队 A', bgColor: '#E64340', textColor: '#FFFFFF', score: 0 },
      teamB: { name: '队 B', bgColor: '#10AEFF', textColor: '#FFFFFF', score: 0 },
      period: 0 // 0-6: 热身, 一, 二, 三, 四, 加时, 完赛
    },
    periods: ['热身', '第一节', '第二节', '第三节', '第四节', '加时', '完赛']
  }
})