const { STORAGE_USER_INFO_KEY, getToken, get } = require('./utils/request.js');
const {
  persistPendingReferrerFromQuery,
  consumeVipExtensionCelebrationIfNeeded
} = require('./utils/referral.js');
const { persistPromoSquareMatchIdFromQuery } = require('./utils/promo-square-cache.js');
const {
  evaluateEnhanceRenderWhitelist,
  evaluateVkSupportCached
} = require('./utils/render/device-capability.js');

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
      const q = /** @type {Record<string, string | undefined>} */ (options.query);
      persistPendingReferrerFromQuery(q);
      persistPromoSquareMatchIdFromQuery(q);
    }

    // 延迟初始化次要任务，避免阻塞首屏渲染
    const initSubTasks = () => {
      // 初始化文件系统
      try {
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
      } catch (eFs) {}

      /**
       * 冷启动机型能力评估：决定是否默认开启增强渲染
       */
      try {
        const decision = evaluateEnhanceRenderWhitelist();
        if (this.globalData.enhanceRenderForceOff === true) {
          this.globalData.enableEnhanceRender = false;
          this.globalData.enhanceWhitelistReason = 'force_off:' + decision.reason;
        } else {
          this.globalData.enableEnhanceRender = !!decision.enabled;
          this.globalData.enhanceInitialMode = decision.initialMode || 'standard';
          this.globalData.enhanceWhitelistReason = decision.reason;
        }
        this.globalData.enhanceDeviceTag = decision.deviceTag;
      } catch (eEval) {
        this.globalData.enableEnhanceRender = false;
        this.globalData.enhanceWhitelistReason = 'eval_exception';
      }

      /**
       * 独立 VK 模式支持判定（带 Storage 缓存）
       */
      try {
        const vk = evaluateVkSupportCached();
        this.globalData.vkModeSupported = !!vk.supported;
        this.globalData.vkModeReason = vk.reason;
      } catch (eVk) {
        this.globalData.vkModeSupported = false;
        this.globalData.vkModeReason = 'eval_exception';
      }
    };

    if (typeof wx.nextTick === 'function') {
      wx.nextTick(initSubTasks);
    } else {
      setTimeout(initSubTasks, 200);
    }

    /**
     * 发热 / 内存告警桥接
     */
    if (typeof wx.onMemoryWarning === 'function') {
      wx.onMemoryWarning((res) => {
        try {
          const pages = getCurrentPages();
          const top = pages && pages.length ? pages[pages.length - 1] : null;
          if (top && top._renderPipeline && typeof top._renderPipeline.hintThermalPressure === 'function') {
            const severity = (res && typeof res.level === 'number' && res.level >= 15) ? 'severe' : 'warn';
            top._renderPipeline.hintThermalPressure(severity);
          }
        } catch (e) {}
      });
    }
  },

  /**
   * 从后台回到前台：再次合并邀请参数；已登录时拉取权益状态，检测邀请续期并提示。
   * @param {WechatMiniprogram.App.LaunchShowOption} options
   * @returns {void}
   */
  onShow: function (options) {
    if (options && options.query) {
      const q = /** @type {Record<string, string | undefined>} */ (options.query);
      persistPendingReferrerFromQuery(q);
      persistPromoSquareMatchIdFromQuery(q);
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
            title: '好友已激活，7天权益已到账',
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
    /** 首页遍历 USER_DATA_PATH 估算的本机视频占用，供直播页提示（非微信官方精确值） */
    fileStorageEstimate: null,
    /** 当前登录用户信息（与本地 userInfo 缓存同步；未登录为 null） */
    userInfo: null,
    matchConfig: {
      matchName: '',
      matchNameColor: '#E64340',
      teamA: { name: '队 A', bgColor: '#E64340', textColor: '#FFFFFF', score: 0 },
      teamB: { name: '队 B', bgColor: '#10AEFF', textColor: '#FFFFFF', score: 0 },
      period: 0 // 0-6: 热身, 一, 二, 三, 四, 加时, 完赛
    },
    periods: ['热身', '第一节', '第二节', '第三节', '第四节', '加时', '完赛'],
    /**
     * 增强渲染（WebGL 锐化）灰度开关。冷启动时由 `evaluateEnhanceRenderWhitelist` 覆盖。
     * 线上遇到个别机型异常可用 `enhanceRenderForceOff=true` 紧急熔断。
     */
    enableEnhanceRender: false,
    /**
     * 初始目标档位：'lite' | 'standard' | 'strong'；自动升档上限不会超过此值。
     * 冷启动时由 whitelist 决定（iPhone 12+ 默认 standard；Android 中端 lite；旗舰 standard）。
     */
    enhanceInitialMode: 'standard',
    /**
     * 白名单判定原因（诊断日志用，如 'ios_iphone_14_pass' / 'android_bench_low'）。
     */
    enhanceWhitelistReason: '',
    /**
     * 机型标签（诊断日志用，形如 'iPhone 14 Pro / iOS 17.4 / bench=-1'）。
     */
    enhanceDeviceTag: '',
    /**
     * 紧急熔断：为 true 时忽略白名单，强制关闭增强渲染。线上故障时发布即可。
     */
    enhanceRenderForceOff: false,
    /**
     * 是否支持 VK 独立管线模式（VKSession v2）。由 `evaluateVkSupportCached` 冷启动填入。
     * 支持 ＝ 工具条展示"VK 模式"按钮；进入 VK 模式会停掉 rolling（精彩回放暂停）。
     */
    vkModeSupported: false,
    /** VK 支持判定原因码，诊断日志用。 */
    vkModeReason: ''
  }
})