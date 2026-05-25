const { STORAGE_USER_INFO_KEY, getToken, get } = require('./utils/request.js');
const { installWsTokenRequestInterceptor } = require('./utils/ws-token-request.js');
const {
  persistPendingReferrerFromQuery,
  consumeVipExtensionCelebrationIfNeeded
} = require('./utils/referral.js');
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
    installWsTokenRequestInterceptor();
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

    /**
     * 冷启动机型能力评估：按白名单（iPhone 12+ / Android benchmark>=25 且 OS>=10）决定
     * 是否默认开启增强渲染。结果写入 globalData，供 live 页 _maybeBootEnhanceRender 读取。
     * 线上紧急熔断走 globalData.enhanceRenderForceOff（发布即可关停，无需改判定逻辑）。
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
      // 评估异常 → 保守关闭，保持原链路
      this.globalData.enableEnhanceRender = false;
      this.globalData.enhanceWhitelistReason = 'eval_exception';
    }

    /**
     * 独立 VK 模式支持判定（带 Storage 缓存）：比常规增强白名单更严格，
     * 仅高端机开放，且结果写入 Storage 7 天，避免每次冷启动重复 getSystemInfoSync。
     */
    try {
      const vk = evaluateVkSupportCached();
      this.globalData.vkModeSupported = !!vk.supported;
      this.globalData.vkModeReason = vk.reason;
    } catch (eVk) {
      this.globalData.vkModeSupported = false;
      this.globalData.vkModeReason = 'eval_exception';
    }

    /**
     * 发热 / 内存告警桥接：转发给顶层页面的增强渲染管线，用于提前降级
     * 避免等到系统温度告警再崩。未启用增强渲染时此处无副作用。
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
        } catch (e) {
          // 不阻塞其它监听者
        }
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