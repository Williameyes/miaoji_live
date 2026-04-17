const app = getApp();

const { get, getToken, STORAGE_USER_INFO_KEY } = require('../../utils/request.js');
const { parseExpireAtToMs } = require('../../utils/referral.js');
const SHARE_IMAGE_URL = '/assets/images/global_share_card-1-288.png';

Page({
  data: {
    matchConfig: {
      matchName: '',
      matchNameColor: '#E64340',
      teamA: { name: '队 A', bgColor: '#E64340', textColor: '#FFFFFF', score: 0 },
      teamB: { name: '队 B', bgColor: '#10AEFF', textColor: '#FFFFFF', score: 0 },
      period: 0
    },
    periods: app.globalData.periods,
    statusBarHeight: 0,
    cameraContext: null,
    cameraMounted: false,
    /** 强制 camera 组件重建的渲染序号（每次重建 +1）。 */
    cameraRenderNonce: 0,
    isRecovering: false,
    /** 硬恢复相机卸载间隙：静态遮罩（无 Toast、无循环 video），减轻黑屏与推流观感问题。 */
    showRecoveryVeil: false,
    recoveryVeilSrc: '',
    pipelineHealth: 'ok',
    opsControlText: 'PAUSE',
    opsControlActionable: false,
    opsControlAck: false,
    /** 恢复圆环进度 0–100，与 recoveryConicEndDeg 同步供 conic-gradient 使用 */
    recoveryProgress: 0,
    recoveryConicEndDeg: 0,
    /** 是否正在保存高光（事务锁：覆盖 stopRecord→落盘→copy→入库 全链路） */
    isSavingHighlight: false,
    isRecording: false,
    longPressTimer: null,
    periodFlash: false,

    /** 抽屉模式: 0=隐藏 1=抽屉打开 */
    drawerMode: 0,
    /** 左侧比赛管理列表数据 */
    matchList: [],
    /** 场次总数（用于左侧抽屉顶部统计显示）。 */
    matchCount: 0,
    /** 颜色设置浮层：是否可见 */
    showColorModal: false,
    /** 颜色设置浮层：当前操作的比赛数据 */
    colorModalMatch: null,
    /** 颜色设置浮层：当前选中的队（teamA / teamB），共用色盘指向 */
    colorModalTeam: 'teamA',
    /** 快选颜色球色板（24 色：8 列 × 3 行，仅一个纯黑） */
    colorBalls: [
      '#DC2626', '#EA580C', '#F59E0B', '#EAB308', '#84CC16', '#16A34A', '#059669', '#0D9488',
      '#14B8A6', '#06B6D4', '#0EA5E9', '#3B82F6', '#6366F1', '#7C3AED', '#A855F7', '#C026D3',
      '#DB2777', '#E11D48', '#F43F5E', '#FFFFFF', '#E2E8F0', '#94A3B8', '#475569', '#000000'
    ],
    drawerHighlights: [],
    /** 当前场次高光片段总数（用于抽屉顶部统计显示）。 */
    highlightCount: 0,
    defaultCover: 'data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"160\" height=\"90\" viewBox=\"0 0 160 90\"><defs><linearGradient id=\"g\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0%\" stop-color=\"%2338475e\"/><stop offset=\"100%\" stop-color=\"%23202a3c\"/></linearGradient></defs><rect width=\"160\" height=\"90\" rx=\"12\" ry=\"12\" fill=\"url(%23g)\"/></svg>',

    showReplayMask: false,
    replayMaskText: 'REPLAY',
    /** 转场样式：replay 进入回放 / live 回到直播 */
    replayMaskKind: 'replay',
    /** 回放倍速（与直播区分观感） */
    replayPlaybackRate: 0.75,
    /** 回放视频是否需要旋转 90 度（竖屏素材在横屏页中的适配） */
    replayVideoNeedRotate: false,
    /** 回放视频旋转角度：仅在需要旋转时生效（90 或 -90） */
    replayVideoRotateDeg: 90,
    isReplaying: false,
    replaySrc: '',
    replayQueue: [],
    replayIndex: 0,
    /** 慢速播放（0.5x / 0.75x）时自动静音，避免变调恐怖感；默认倍速 0.75 故初始为 true */
    replayMuted: true,
    /** movable-view 当前缩放比例（1 = 原始大小），用于控制重置按钮显隐 */
    replayViewScale: 1,
    /** movable-view 水平偏移（px），重置时归零 */
    replayViewX: 0,
    /** movable-view 垂直偏移（px），重置时归零 */
    replayViewY: 0,
    /** 高光回放起播时间（秒），配合长切片逻辑偏移 */
    replayInitialTime: 0,
    /** 高光跨文件链式回放：是否启用 */
    replayHighlightChain: false,
    /** 链式回放路径列表（与 segments 顺序一致） */
    replayHighlightPaths: [],
    /** 链式回放当前索引 */
    replayHighlightIndex: 0,

    /**
     * 双 slot 无缝切换回放。slot-a/b 同时在 DOM，非活跃 slot 在后台预加载。
     * 切换时只改 z-index，避免 src 变更触发重新加载造成黑帧。
     */
    /** 活跃播放 slot：0 = slot-a，1 = slot-b */
    replayActiveSlot: 0,
    /** slot-a 视频路径 */
    replaySlotASrc: '',
    /** slot-a 起播秒数 */
    replaySlotAInitialTime: 0,
    /** slot-b 视频路径（预加载第二段） */
    replaySlotBSrc: '',
    /** slot-b 起播秒数 */
    replaySlotBInitialTime: 0,

    // 相机焦距相关
    zoom: 1,
    maxZoom: 10,
    distance: 0,
    lastZoom: 1,
    /** 左右球队色块宽度（px），按队名字符数估算，避免 flex:1 拉满半屏 */
    teamGroupWidthPxA: 0,
    teamGroupWidthPxB: 0,
    showGuide: false,

    /** 是否通过 GET /api/auth/check-status 且 isVip 为 true */
    liveStreamAllowed: false,
    /** 首次进入 Live 时尚未完成权益校验 */
    liveEntitlementChecking: true,
    /** 权益不足时的全屏引导层 */
    showVipGate: false,
    vipGateTitle: '',
    vipGateSubtext: '',
    vipGateMinor: '',
    vipGateRetryVisible: false
  },

  /**
   * 从全局与 Storage 同步当前场次记分配置（与 index、onShow 逻辑一致）。
   * @returns {void}
   */
  syncMatchConfigFromPageSources: function() {
    const currentMatchId =
      wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    let sourceConfig = app.globalData.matchConfig || wx.getStorageSync('matchConfig');
    if (currentMatchId) {
      const matches = wx.getStorageSync('MIAOXIE_MATCHES');
      if (Array.isArray(matches)) {
        const found = matches.find((m) => m.id === currentMatchId);
        if (found) {
          sourceConfig = found;
        }
      }
    }
    const latestConfig = this.normalizeMatchConfig(sourceConfig);
    const wSide = this.computeTeamGroupWidthPx();
    this.setData({
      matchConfig: latestConfig,
      teamGroupWidthPxA: wSide,
      teamGroupWidthPxB: wSide
    });
    app.globalData.matchConfig = latestConfig;
    wx.setStorageSync('matchConfig', latestConfig);
  },

  /**
   * 将权益到期时间格式化为本地可读字符串。
   * @param {unknown} expireRaw
   * @returns {string}
   */
  formatExpireForDisplay: function(expireRaw) {
    const ms = parseExpireAtToMs(expireRaw);
    if (Number.isNaN(ms)) {
      return typeof expireRaw === 'string' || typeof expireRaw === 'number' ? String(expireRaw) : '';
    }
    const d = new Date(ms);
    const pad = (n) => `${n}`.padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
      d.getMinutes()
    )}`;
  },

  /**
   * 解析 check-status 响应，得到是否允许进入直播与拦截文案。
   * @param {unknown} body
   * @returns {{ allow: boolean, title: string, sub: string, minor: string, showRetry: boolean }}
   */
  buildVipGateStateFromCheckStatus: function(body) {
    const deny = (title, sub, minor, showRetry) => ({
      allow: false,
      title,
      sub,
      minor: minor || '',
      showRetry: !!showRetry
    });
    if (!body || typeof body !== 'object') {
      return deny('权益续杯', '校验失败，请稍后重试', '', true);
    }
    const res = /** @type {Record<string, unknown>} */ (body);
    if (res.code !== 0 || !res.data || typeof res.data !== 'object') {
      const msg = typeof res.message === 'string' && res.message.length > 0 ? res.message : '权益校验失败';
      return deny('权益续杯', msg, '', true);
    }
    const d = /** @type {Record<string, unknown>} */ (res.data);
    const isVip = d.isVip === true;
    const expireRaw = d.expireAt !== undefined && d.expireAt !== null ? d.expireAt : d.expire_at;
    if (isVip) {
      return { allow: true, title: '', sub: '', minor: '', showRetry: false };
    }
    const expMs = parseExpireAtToMs(expireRaw);
    if (expireRaw == null || expireRaw === '' || Number.isNaN(expMs)) {
      return deny('权益续杯', '尚未获得试用期', '完成登录或邀请好友成功登录可获得试用与续期', false);
    }
    const now = Date.now();
    if (expMs < now) {
      return deny('权益续杯', '权益已到期，邀请好友完成登录可续期 5 天', `到期时间：${this.formatExpireForDisplay(expireRaw)}`, false);
    }
    return deny(
      '权益续杯',
      '当前账号暂不可使用直播功能',
      `参考到期时间：${this.formatExpireForDisplay(expireRaw)}`,
      true
    );
  },

  /**
   * 调用服务端校验权益；拒绝时收起相机并展示引导层。
   * @param {function(): void} [onAllowed] 仅在 isVip 为 true 时调用
   * @returns {void}
   */
  refreshLiveEntitlementAndResume: function(onAllowed) {
    if (this._entitlementChecking) {
      if (typeof onAllowed === 'function') {
        this._entitlementOnAllowedQueue.push(onAllowed);
      }
      return;
    }
    this._entitlementChecking = true;
    const token = getToken();
    if (!token) {
      this.rollingActive = false;
      this.stopRollingRecording();
      this.setData({
        liveEntitlementChecking: false,
        liveStreamAllowed: false,
        cameraMounted: false,
        cameraContext: null,
        showVipGate: true,
        vipGateTitle: '需要登录',
        vipGateSubtext: '请先到「我的」完成微信登录，再使用直播记分与录像。',
        vipGateMinor: '',
        vipGateRetryVisible: false
      });
      this._entitlementOnAllowedQueue = [];
      this._entitlementChecking = false;
      return;
    }

    this.setData({ liveEntitlementChecking: true });

    get('/api/auth/check-status', {}, {})
      .then((body) => {
        const gate = this.buildVipGateStateFromCheckStatus(body);
        if (!gate.allow) {
          this.rollingActive = false;
          this.stopRollingRecording(() => {
            this.setData({
              liveEntitlementChecking: false,
              liveStreamAllowed: false,
              cameraMounted: false,
              cameraContext: null,
              showVipGate: true,
              vipGateTitle: gate.title,
              vipGateSubtext: gate.sub,
              vipGateMinor: gate.minor,
              vipGateRetryVisible: gate.showRetry
            });
          });
          this._entitlementOnAllowedQueue = [];
          this._entitlementChecking = false;
          return;
        }

        const cameraAlreadyHealthy =
          this.data.liveStreamAllowed
          && this.data.cameraMounted
          && !!this.data.cameraContext
          && this._cameraInitDone
          && !this.data.isRecovering;
        if (cameraAlreadyHealthy) {
          this.setData({
            liveEntitlementChecking: false,
            liveStreamAllowed: true,
            showVipGate: false,
            vipGateTitle: '',
            vipGateSubtext: '',
            vipGateMinor: '',
            vipGateRetryVisible: false
          }, () => {
            if (typeof onAllowed === 'function') onAllowed();
            const queued = this._entitlementOnAllowedQueue.splice(0, this._entitlementOnAllowedQueue.length);
            queued.forEach((fn) => {
              try { fn(); } catch (e) {}
            });
          });
          this._entitlementChecking = false;
          return;
        }

        this.rebuildCameraComponent(() => {
          const nextCtx = wx.createCameraContext();
          this.setData(
            {
              liveEntitlementChecking: false,
              liveStreamAllowed: true,
              cameraMounted: true,
              cameraContext: nextCtx,
              showVipGate: false,
              vipGateTitle: '',
              vipGateSubtext: '',
              vipGateMinor: '',
              vipGateRetryVisible: false
            },
            () => {
              if (typeof onAllowed === 'function') {
                onAllowed();
              }
              const queued = this._entitlementOnAllowedQueue.splice(0, this._entitlementOnAllowedQueue.length);
              queued.forEach((fn) => {
                try { fn(); } catch (e) {}
              });
            }
          );
        });
        this._entitlementChecking = false;
      })
      .catch(() => {
        this.rollingActive = false;
        this.stopRollingRecording(() => {
          this.setData({
            liveEntitlementChecking: false,
            liveStreamAllowed: false,
            cameraMounted: false,
            cameraContext: null,
            showVipGate: true,
            vipGateTitle: '网络异常',
            vipGateSubtext: '无法校验权益，请检查网络后重试。',
            vipGateMinor: '',
            vipGateRetryVisible: true
          });
        });
        this._entitlementOnAllowedQueue = [];
        this._entitlementChecking = false;
      });
  },

  /**
   * 权益门「重试」：重新请求 check-status。
   * @returns {void}
   */
  onVipGateRetryTap: function() {
    this.refreshLiveEntitlementAndResume(() => {
      this._liveCoreOnShowAfterEntitlement();
    });
  },

  /**
   * 权益门：跳转「我的」登录。
   * @returns {void}
   */
  onVipGateSwitchMine: function() {
    wx.switchTab({ url: '/pages/mine/mine' });
  },

  /**
   * 拦截权益层下意外滚动穿透。
   * @returns {void}
   */
  onVipGateCatchMove: function() {},

  /**
   * 恢复遮罩层吞掉触摸移动，避免穿透到记分手势。
   * @returns {void}
   */
  noopCatchMove: function() {},

  /**
   * 阻止卡片内点击冒泡到根（预留）。
   * @returns {void}
   */
  stopVipGateInnerBubble: function() {},

  /**
   * 标记为“仅允许长按重启”的故障态，禁止状态灯单击动作。
   * @param {string} reason
   * @returns {void}
   */
  markNeedManualRelaunch: function(reason) {
    if (this._needManualRelaunch) return;
    this._needManualRelaunch = true;
    this.appendHealthLog('manual_relaunch_required', { reason: reason || 'unknown' });
    this.updatePipelineHealth();
  },

  /**
   * onShow 中在权益通过后执行的相机与滚动分段恢复逻辑。
   * @returns {void}
   */
  _liveCoreOnShowAfterEntitlement: function() {
    this.rollingActive = true;
    this.rollingSessionId += 1;
    const sessionIdForRolling = this.rollingSessionId;
    this.lastSegmentAt = Date.now();
    this.lastRecordStartAt = 0;
    this.startRecordFailStreak = 0;
    this.startHealthMonitor();

    const hasReadGuide = wx.getStorageSync('hasReadGuide');
    if (!hasReadGuide) {
      this.setData({ showGuide: true });
    }

    wx.getSetting({
      success: (res) => {
        const hasRecord = !!res.authSetting['scope.record'];
        const albumScope = res.authSetting['scope.writePhotosAlbum'];
        if (!hasRecord) {
          wx.authorize({ scope: 'scope.record', fail: () => {} });
        }
        if (albumScope !== true && albumScope === undefined) {
          wx.authorize({ scope: 'scope.writePhotosAlbum', fail: () => {} });
        }
      }
    });

    wx.setKeepScreenOn({
      keepScreenOn: true,
      fail: () => {
        setTimeout(() => wx.setKeepScreenOn({ keepScreenOn: true }), 1000);
      }
    });

    if (wx.setPageOrientation) {
      wx.setPageOrientation({ orientation: 'landscape' });
    }

    const kickoffRolling = () => {
      if (!this.rollingActive || sessionIdForRolling !== this.rollingSessionId) {
        return;
      }
      if (this._rollingKickoffTimer) {
        clearTimeout(this._rollingKickoffTimer);
        this._rollingKickoffTimer = null;
      }
      if (this._cameraInitDone) {
        this.tryStartRollingWhenCameraReady();
        return;
      }
      this._rollingKickoffTimer = setTimeout(() => {
        this._rollingKickoffTimer = null;
        if (!this.rollingActive || sessionIdForRolling !== this.rollingSessionId) {
          return;
        }
        this.tryStartRollingWhenCameraReady();
      }, 1800);
    };
    this.stopRollingRecording(() => {
      this.ensureRollingDir()
        .then(() => this.clearStaleRollingFiles())
        .finally(() => kickoffRolling());
    });
    if (this.data.drawerMode === 1) {
      this.refreshDrawerHighlights();
    }
    if (wx.nextTick) {
      wx.nextTick(() => this.updateTeamGroupWidth(true));
    } else {
      setTimeout(() => this.updateTeamGroupWidth(true), 0);
    }
  },

  // 辅助变量
  lastSetZoomTime: 0,
  suppressScoreTap: false,
  /**
   * 滚动录制单段时长（毫秒）。16s 在稳定性与响应速度之间做平衡。
   * 高光「体感窗口」仍由 {@link highlightPlaybackWindowMs} 控制（默认 8s 起播逻辑）。
   */
  segmentDurationMs: 16000,
  /** 用户点击保存后，回放时希望覆盖的精彩窗口长度（毫秒），可与物理切片时长解耦 */
  highlightPlaybackWindowMs: 8000,
  /** stopRecord 完成后再启动下一段 startRecord / 相机重启前的冷却（毫秒），硬件隔离硬约束 */
  recordCooldownAfterStopMs: 500,
  /** 高光点击后执行 stopRecord 的最小时长门槛（毫秒），避免刚起录即 stop 在部分机型失败 */
  minRecordMsBeforeHighlightStop: 1300,
  segmentStopTimer: null,
  rollingWatchdogTimer: null,
  segmentCounter: 0,
  pendingHighlight: null,
  /**
   * 用户点击「保存高光」且将立即 stopRecord 时写入：落盘完成后按 expectedSegNo 与 {@link onSegmentRecorded} 对齐。
   * @type {{
   *   expectedSegNo: number,
   *   recordSessionId: number,
   *   id: string,
   *   createdAt: number,
   *   startSegNo: number,
   *   matchName: string,
   *   matchId: string,
   *   cover: string,
   *   clickWallMs: number
   * } | null}
   */
  _highlightAfterStopMeta: null,
  /** 为 true 时 UI 锁需等待 finalize 与下一段 startRecord 成功两道闸门 */
  _highlightSaveAwaitingResume: false,
  _highlightPipelineDoneFinalize: false,
  _highlightPipelineDoneResume: false,
  /** 当前等待恢复录制的会话 id；避免清空 meta 后无法释放保存锁 */
  _highlightSaveSessionId: 0,
  _highlightResumeGuardTimer: null,
  _highlightSaveHardTimeoutTimer: null,
  _highlightDeferredStopTimer: null,
  _highlightRequestLock: false,
  segmentBuffer: [],
  rollingActive: false,
  rollingSessionId: 0,
  lastHighlightRequestAt: 0,
  lastHighlightSignature: '',
  /** 已落盘为高光的上一条滚动片段序号；避免多次长按反复拷贝同一段 rolling 文件 */
  lastHighlightConsumedSegNo: 0,
  lastSegmentAt: 0,
  lastRecordStartAt: 0,
  startRecordFailStreak: 0,
  /** rolling 缓冲最多保留的段数；长切片下单段更大，略减段数以控制磁盘水位 */
  rollingBufferMax: 8,
  /** 正在将分段写入本地 rolling（copyFile 等），此时禁止看门狗误启新段，避免长直播后写盘变慢导致管线错乱 */
  rollingFsBusy: false,
  /** 进入回放前 REPLAY 全屏转场总时长（需与 WXSS 中 replayBadgeMotion 时长一致） */
  replayIntroDurationMs: 1000,
  /** 回到直播转场总时长（需与 WXSS 中 liveBadgeMotion 时长一致） */
  replayOutroDurationMs: 720,
  /** 连续高光未命中计数；用于触发自动硬恢复。 */
  highlightMissStreak: 0,
  /** 连续高光落盘失败计数；用于触发录制管线自恢复。 */
  highlightCopyFailStreak: 0,
  /** 连续 segment 持久化失败计数；超过阈值说明当前页实例已失稳。 */
  segmentPersistFailStreak: 0,
  /** 高光异步固化任务队列。 */
  highlightMaterializeQueue: [],
  /** 高光异步固化执行中标记。 */
  highlightMaterializeRunning: false,
  /** 存储水位级别：0/70/85/95。 */
  storageWatermarkLevel: 0,
  /** 高光实体最大保留条数（>=30 条实战需求；超出淘汰最旧项）。 */
  highlightsMaxCount: 100,
  /** startRecord 连续失败风暴计数（每次达到 failStreak=5 记 1 次）。 */
  segmentStartFailStormCycles: 0,

  onLoad: function() {
    /** 相机 bindinitdone 完成前禁止 startRecord，否则部分机型预览一直黑屏 */
    this._cameraInitDone = false;
    this._rollingKickoffTimer = null;
    this._opsToolsTimer = null;
    this._opsAckTimer = null;
    this._healthTimer = null;
    this.rollingFsBusy = false;
    this._recoveryLock = false;
    this._hardRecoverAwaitingCamera = false;
    this._recoveryGuardTimer = null;
    this._recoverProgTimer = null;
    this._recoverProgressResetTimer = null;
    this._recoveryFailSafeTimer = null;
    /** 长按状态钮后通常会跟一次 tap，需吞掉避免误触保存/二次恢复 */
    this._recoveryFabLongPressConsumed = false;
    /** 自动恢复节流戳，避免 camera error/stop 连续抖动触发恢复风暴。 */
    this._lastAutoRecoveryAt = 0;
    /** 相机异常连续计数；用于更稳地判定硬恢复时机。 */
    this._cameraFaultStreak = 0;
    /** 健康日志内存缓冲与落盘节流定时器。 */
    this._healthLogs = [];
    this._healthLogFlushTimer = null;
    this._healthLogStorageKey = 'LIVE_HEALTH_LOGS_V1';
    /** 权益校验串行锁，避免 onLoad/onShow/重试并发导致重复挂载 camera。 */
    this._entitlementChecking = false;
    this._entitlementOnAllowedQueue = [];
    /** 相机重建锁，避免短时多次重建触发 “can insert only one camera”。 */
    this._cameraRebuildLock = false;
    this._cameraRebuildQueue = [];
    /** 最近一次硬恢复时间戳：防止短时连点/连错触发恢复风暴。 */
    this._lastHardRecoverAt = 0;
    /** 硬恢复最小间隔（毫秒）。 */
    this._hardRecoverMinGapMs = 2200;
    /** insertCamera 冲突后的自动恢复冷静期截止时间。 */
    this._insertCameraRecoverCooldownUntil = 0;
    /** camera 组件重建额外延迟（毫秒），在 insertCamera 冲突后动态抬高。 */
    this._cameraRebuildExtraDelayMs = 0;
    /** insertCamera 冲突连续计数。 */
    this._insertCameraErrorStreak = 0;
    /** insertCamera 冲突后单次延迟重试定时器。 */
    this._insertCameraRetryTimer = null;
    /** insertCamera 冲突恢复进行中标记，避免并发恢复。 */
    this._insertConflictRecovering = false;
    this.segmentPersistFailStreak = 0;
    this.segmentStartFailStormCycles = 0;
    /** 当前是否进入“仅允许长按重启”故障态。 */
    this._needManualRelaunch = false;
    /** 状态灯长按重启计时器（比默认 longpress 更长）。 */
    this._relaunchPressTimer = null;
    /** 最近一次 camera 卸载时间戳（用于重挂前等待）。 */
    this._lastCameraUnmountAt = 0;
    /** 回放期间是否已主动暂停滚动录制。 */
    this._rollingPausedForReplay = false;
    /** 当前 rolling 段开始录制的墙钟时间（ms），用于高光逻辑起播偏移 */
    this._currentRollingSegmentRecordStartMs = 0;
    /** isRecovering UI 兜底定时器（与 camera init 超时分离） */
    this._recoverUiFailsafeTimer = null;
    /** 链式回放：待置顶 slot（0/1），等 timeupdate 出画后再 setData，减轻黑帧 */
    this._replayPendingActiveSlot = null;
    /** 链式回放：各 slot 是否已做过后台 prime，避免重复 */
    this._replayPrimedSlot0 = false;
    this._replayPrimedSlot1 = false;
    /** 链式回放：待置顶兜底定时器 */
    this._replayPendingFallbackTimer = null;
    /** 回放转场定时器：用于中断/反复回放时统一清理，避免定时任务堆积 */
    this._replayStartTimer = null;
    this._replayMaskHideTimer = null;
    this._replayOutroTimer = null;
    this._replayPrimeTimerA = null;
    this._replayPrimeTimerB = null;
    this.initHealthLogs();

    this.syncMatchConfigFromPageSources();
    
    // 1. 隐藏小程序左上角的返回/主页按钮（沉浸式第一步）
    if (wx.hideHomeButton) {
      wx.hideHomeButton();
    }
    
    // 2. 动态设置窗口背景色为纯黑
    wx.setBackgroundColor({
      backgroundColor: '#000000',
      backgroundColorTop: '#000000',
      backgroundColorBottom: '#000000',
    });
    
    // 3. 强制状态栏/导航栏为黑色
    wx.setNavigationBarColor({
      frontColor: '#ffffff',
      backgroundColor: '#000000',
      animation: { duration: 0 }
    });
    
    // 保持屏幕常亮
    wx.setKeepScreenOn({ 
      keepScreenOn: true,
      fail: () => {
        setTimeout(() => wx.setKeepScreenOn({ keepScreenOn: true }), 1000);
      }
    });

    // 强制横屏（需要 pageOrientation: "auto"）
    if (wx.setPageOrientation) {
      wx.setPageOrientation({ orientation: 'landscape' });
    }

    try {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ['shareAppMessage']
      });
    } catch (e) {
      // 低版本基础库忽略
    }

    // 直播核心拉起统一放在 onShow，避免 onLoad + onShow 并发触发 camera 重建。
  },

  /**
   * 初始化直播健康日志缓冲。
   * 设备信息只采集一次存入 header，避免每条 log 都重复写相同字段浪费体积。
   * @returns {void}
   */
  initHealthLogs: function() {
    try {
      const raw = wx.getStorageSync(this._healthLogStorageKey);
      this._healthLogs = Array.isArray(raw) ? raw.slice(-120) : [];
    } catch (e) {
      this._healthLogs = [];
    }
    try {
      const sys = wx.getSystemInfoSync();
      this._healthLogDevice = {
        model: String(sys.model || ''),
        brand: String(sys.brand || ''),
        platform: String(sys.platform || ''),
        wxVersion: String(sys.version || ''),
        system: String(sys.system || '')
      };
    } catch (e) {
      this._healthLogDevice = {};
    }
    this.appendHealthLog('page_load', {});
  },

  /**
   * 追加一条健康日志（环形缓冲，控制体积）。
   * 每条仅存 timestamp + event + detail，设备信息统一由 header 承载。
   * @param {string} eventName 事件名
   * @param {Record<string, unknown>} [detail] 事件详情
   * @returns {void}
   */
  appendHealthLog: function(eventName, detail) {
    const item = {
      t: Date.now(),
      e: String(eventName || '?'),
      d: detail && typeof detail === 'object' ? detail : {}
    };
    this._healthLogs.push(item);
    if (this._healthLogs.length > 120) {
      this._healthLogs.splice(0, this._healthLogs.length - 120);
    }
    this.scheduleHealthLogFlush();
  },

  /**
   * 节流写入健康日志到 storage，避免频繁 IO 干扰直播。
   * @returns {void}
   */
  scheduleHealthLogFlush: function() {
    if (this._healthLogFlushTimer) return;
    this._healthLogFlushTimer = setTimeout(() => {
      this._healthLogFlushTimer = null;
      try {
        wx.setStorageSync(this._healthLogStorageKey, this._healthLogs.slice(-240));
      } catch (e) {}
    }, 1800);
  },

  /**
   * 手动导出健康日志到剪贴板，便于现场复现后快速回传排查。
   * @returns {void}
   */
  onExportHealthLogs: function() {
    const logs = (this._healthLogs || []).slice(-100);
    const payload = {
      at: Date.now(),
      device: this._healthLogDevice || {},
      logs
    };
    const text = JSON.stringify(payload);
    wx.setClipboardData({
      data: text,
      success: () => {
        wx.showModal({
          title: '诊断日志已复制',
          content: '已复制最近健康日志。请把内容发给我用于定位现场问题。',
          showCancel: false
        });
      },
      fail: () => {
        wx.showToast({ title: '复制失败，请重试', icon: 'none' });
      }
    });
  },

  /**
   * 保存高光的事务开始：快速反馈 + UI 锁，防止重复点击引发 I/O 冲突。
   * @returns {void}
   */
  beginHighlightSaving: function() {
    if (this._highlightRequestLock) return;
    this._highlightRequestLock = true;
    if (this.data.isSavingHighlight) return;
    this.setData({ isSavingHighlight: true });
    if (this._highlightSaveHardTimeoutTimer) {
      clearTimeout(this._highlightSaveHardTimeoutTimer);
      this._highlightSaveHardTimeoutTimer = null;
    }
    const hardTimeoutMs = Math.max(18000, Math.floor(this.segmentDurationMs * 1.6));
    this._highlightSaveHardTimeoutTimer = setTimeout(() => {
      if (!this.data.isSavingHighlight) return;
      this.appendHealthLog('highlight_hard_timeout_unlock', {});
      this.clearHighlightSavePipelineState();
      this.endHighlightSaving();
      this.recoverRollingPipelineForHighlight();
    }, hardTimeoutMs);
  },

  /**
   * 保存高光的事务结束：关闭 loading + 释放锁。
   * @returns {void}
   */
  endHighlightSaving: function() {
    this._highlightRequestLock = false;
    if (this.data.isSavingHighlight) {
      this.setData({ isSavingHighlight: false });
    }
    if (this._highlightSaveHardTimeoutTimer) {
      clearTimeout(this._highlightSaveHardTimeoutTimer);
      this._highlightSaveHardTimeoutTimer = null;
    }
  },

  /**
   * 重置「截断保存」双闸门状态（出错、会话失效、页面离开时调用）。
   * @returns {void}
   */
  clearHighlightSavePipelineState: function() {
    this._highlightSaveAwaitingResume = false;
    this._highlightPipelineDoneFinalize = false;
    this._highlightPipelineDoneResume = false;
    this._highlightSaveSessionId = 0;
    if (this._highlightResumeGuardTimer) {
      clearTimeout(this._highlightResumeGuardTimer);
      this._highlightResumeGuardTimer = null;
    }
    if (this._highlightDeferredStopTimer) {
      clearTimeout(this._highlightDeferredStopTimer);
      this._highlightDeferredStopTimer = null;
    }
    this._highlightAfterStopMeta = null;
  },

  /**
   * finalize 与下一段录制均完成时释放 {@link data.isSavingHighlight}。
   * @returns {void}
   */
  maybeReleaseHighlightSaveLock: function() {
    if (!this._highlightSaveAwaitingResume) return;
    if (this._highlightPipelineDoneFinalize && this._highlightPipelineDoneResume) {
      this.clearHighlightSavePipelineState();
      this.endHighlightSaving();
    }
  },

  /**
   * stopRecord 未产出文件或失败时，取消本次高光截断并解锁 UI。
   * @param {number} sessionId 发起 stop 时的 rolling 会话 id
   * @param {string} reason 诊断用原因码
   * @returns {void}
   */
  abortHighlightAfterStopIfNeeded: function(sessionId, reason) {
    const hm = this._highlightAfterStopMeta;
    if (!hm || hm.recordSessionId !== sessionId) return;
    this.appendHealthLog('highlight_after_stop_abort', { reason });
    if (reason === 'stop_record_fail' || reason === 'empty_temp_path') {
      const fallback = this.pickLatestRollingEntry();
      if (fallback && fallback.path) {
        this.finalizeHighlight({
          id: hm.id,
          createdAt: hm.createdAt,
          startSegNo: hm.startSegNo,
          matchName: hm.matchName,
          matchId: hm.matchId,
          cover: hm.cover,
          finalizing: false,
          sourceSegNo: fallback.segNo,
          preSegments: [fallback.path],
          postSegments: [],
          replayInitialTimeSec: 0,
          replayUseChain: false
        });
        this._highlightAfterStopMeta = null;
        return;
      }
    }
    if (reason === 'segment_persist_fail') {
      this.segmentPersistFailStreak = (this.segmentPersistFailStreak || 0) + 1;
      if (this.segmentPersistFailStreak >= 3) {
        this.segmentPersistFailStreak = 0;
        this.markNeedManualRelaunch('segment_persist_fail_streak');
      }
    }
    this.clearHighlightSavePipelineState();
    this.endHighlightSaving();
  },

  // 相机初始化完成回调
  onCameraInit: function(e) {
    const maxZoom = e.detail.maxZoom || 5;
    this.setData({ maxZoom: maxZoom });
    this.updateZoom(1.0);
    if (this._rollingKickoffTimer) {
      clearTimeout(this._rollingKickoffTimer);
      this._rollingKickoffTimer = null;
    }
    this._cameraInitDone = true;
    if (this._hardRecoverAwaitingCamera) {
      this._hardRecoverAwaitingCamera = false;
      if (this._recoveryGuardTimer) {
        clearTimeout(this._recoveryGuardTimer);
        this._recoveryGuardTimer = null;
      }
      if (this._recoverUiFailsafeTimer) {
        clearTimeout(this._recoverUiFailsafeTimer);
        this._recoverUiFailsafeTimer = null;
      }
      if (this._recoveryFailSafeTimer) {
        clearTimeout(this._recoveryFailSafeTimer);
        this._recoveryFailSafeTimer = null;
      }
      this.stopRecoveryProgressAnim(true);
      this.setData({ isRecovering: false, showRecoveryVeil: false });
      this._recoveryLock = false;
      if (this._manualRecoveryPendingAck) {
        this._manualRecoveryPendingAck = false;
        this.emitRecoverySuccessFeedback();
      }
      this.updatePipelineHealth();
    }
    this._cameraFaultStreak = 0;
    this._insertCameraErrorStreak = 0;
    this._cameraRebuildExtraDelayMs = 0;
    this._insertCameraRecoverCooldownUntil = 0;
    this._insertConflictRecovering = false;
    this.segmentStartFailStormCycles = 0;
    this._needManualRelaunch = false;
    if (this._insertCameraRetryTimer) {
      clearTimeout(this._insertCameraRetryTimer);
      this._insertCameraRetryTimer = null;
    }
    if (this._relaunchPressTimer) {
      clearTimeout(this._relaunchPressTimer);
      this._relaunchPressTimer = null;
    }
    this._insertConflictRecovering = false;
    this.appendHealthLog('camera_init', { maxZoom: maxZoom });
    this.tryStartRollingWhenCameraReady();
  },

  /**
   * camera 非正常中断（如切后台/系统打断）后的恢复入口。
   * @param {WechatMiniprogram.CustomEvent} e
   * @returns {void}
   */
  onCameraStop: function(e) {
    const detail = (e && e.detail) || {};
    const reason = detail && detail.reason ? String(detail.reason) : '';
    this.appendHealthLog('camera_stop', { reason });
    this.triggerCameraFaultRecovery(`stop:${reason}`);
  },

  /**
   * camera 组件错误回调（权限变化、系统相机异常等）。
   * @param {WechatMiniprogram.CustomEvent} e
   * @returns {void}
   */
  onCameraError: function(e) {
    const detail = (e && e.detail) || {};
    const errMsg = detail && detail.errMsg ? String(detail.errMsg) : '';
    this.appendHealthLog('camera_error', { errMsg });
    const lower = errMsg.toLowerCase();
    const isInsertConflict =
      lower.indexOf('can insert only one camera') >= 0
      || lower.indexOf('insertcamera:fail') >= 0;
    if (isInsertConflict) {
      this._insertCameraErrorStreak = (this._insertCameraErrorStreak || 0) + 1;
      const now = Date.now();
      const currentExtra = this._cameraRebuildExtraDelayMs || 0;
      this._cameraRebuildExtraDelayMs = Math.min(2200, Math.max(900, currentExtra + 300));
      this._insertCameraRecoverCooldownUntil = now + 3500;
      this.appendHealthLog('camera_insert_conflict', {
        streak: this._insertCameraErrorStreak,
        rebuildDelayMs: this._cameraRebuildExtraDelayMs
      });
      if (this._insertCameraErrorStreak >= 3) {
        this.markNeedManualRelaunch('insert_conflict_streak');
      }
      if (this._insertCameraRetryTimer) {
        clearTimeout(this._insertCameraRetryTimer);
        this._insertCameraRetryTimer = null;
      }
      /**
       * 根因治理：首次 insert 冲突不立即硬恢复，先做轻量踢管线（不重建 camera 组件）；
       * 仅连续冲突时再升级硬恢复，避免“恢复风暴”反向放大故障。
       */
      if (this._insertCameraErrorStreak <= 1) {
        this.appendHealthLog('camera_insert_conflict_soft_kick', {});
        this.rollingActive = false;
        this.stopRollingRecording(() => {
          this.scheduleAfterStopRecord(() => {
            if (this.data.isRecovering || this._recoveryLock) return;
            this.rollingActive = true;
            this.rollingSessionId += 1;
            this.tryStartRollingWhenCameraReady();
          });
        });
        return;
      }
      if (this._insertConflictRecovering) return;
      this._insertConflictRecovering = true;
      const waitMs = 900 + Math.floor((this._cameraRebuildExtraDelayMs || 0) * 0.5);
      this._insertCameraRetryTimer = setTimeout(() => {
        this._insertCameraRetryTimer = null;
        this._insertConflictRecovering = false;
        if (this.data.isRecovering || this._recoveryLock) return;
        this.hardRecoverLivePipeline('auto:insert_camera_conflict');
      }, waitMs);
      return;
    }
    this.triggerCameraFaultRecovery(`error:${errMsg}`);
  },

  /**
   * 统一相机异常恢复触发器：带节流，避免短时连发导致反复黑屏。
   * @param {string} reason
   * @returns {void}
   */
  triggerCameraFaultRecovery: function(reason) {
    if (!this.data.liveStreamAllowed) return;
    if (this.data.isRecovering || this._recoveryLock) return;
    if (this.pendingHighlight) return;
    if (Date.now() < (this._insertCameraRecoverCooldownUntil || 0)) return;
    const now = Date.now();
    const minAutoRecoverGapMs = 18000;
    this._cameraFaultStreak = (this._cameraFaultStreak || 0) + 1;
    const needRecover = this._cameraFaultStreak >= 2;
    if (!needRecover) {
      this.updatePipelineHealth();
      return;
    }
    if (now - (this._lastAutoRecoveryAt || 0) < minAutoRecoverGapMs) return;
    this.appendHealthLog('camera_auto_recover', {
      reason,
      faultStreak: this._cameraFaultStreak,
      pipelineHealth: this.data.pipelineHealth
    });
    this._lastAutoRecoveryAt = now;
    this.hardRecoverLivePipeline(`auto:${reason}`);
  },

  /**
   * 强制重建 camera 组件并释放旧上下文，避免会话切换后复用脏资源。
   * @param {function(): void} [onRebuilt]
   * @returns {void}
   */
  rebuildCameraComponent: function(onRebuilt) {
    if (this._cameraRebuildLock) {
      if (typeof onRebuilt === 'function') {
        this._cameraRebuildQueue.push(onRebuilt);
      }
      return;
    }
    this._cameraRebuildLock = true;
    this._cameraInitDone = false;
    this.setData({
      cameraMounted: false,
      cameraContext: null,
      isRecording: false,
      cameraRenderNonce: (this.data.cameraRenderNonce || 0) + 1
    }, () => {
      this._lastCameraUnmountAt = Date.now();
      const kick = () => {
        if (typeof onRebuilt === 'function') onRebuilt();
        this._cameraRebuildLock = false;
        const queued = this._cameraRebuildQueue.splice(0, this._cameraRebuildQueue.length);
        if (queued.length > 0) {
          const next = queued.shift();
          if (typeof next === 'function') {
            this.rebuildCameraComponent(next);
          }
          queued.forEach((fn) => {
            if (typeof fn === 'function') this._cameraRebuildQueue.push(fn);
          });
        }
      };
      const baseMs = this.recordCooldownAfterStopMs || 500;
      const extraMs = this._cameraRebuildExtraDelayMs || 0;
      setTimeout(kick, baseMs + extraMs);
    });
  },

  /**
   * stopRecord 完成后延迟再启动下一段录制，避免 Native 句柄未释放即 startRecord。
   * @param {function(): void} fn
   * @returns {void}
   */
  scheduleAfterStopRecord: function(fn) {
    const ms = this.recordCooldownAfterStopMs || 500;
    setTimeout(() => {
      if (typeof fn === 'function') fn();
    }, ms);
  },

  /**
   * 取 rolling 缓冲中与 segNo 紧邻的前一段（用于 8s 窗口跨文件）。
   * @param {number} segNo 当前段序号
   * @returns {{ path: string, segNo: number, recordStartMs?: number } | null}
   */
  pickPrevRollingEntry: function(segNo) {
    const want = (typeof segNo === 'number' ? segNo : 0) - 1;
    if (want < 1) return null;
    const buf = this.segmentBuffer || [];
    for (let i = 0; i < buf.length; i += 1) {
      const it = buf[i];
      if (it && it.segNo === want && it.path) return it;
    }
    return null;
  },

  /**
   * 根据点击时刻与段元数据，计算高光复制列表与首段起播秒数（逻辑 8s 窗口）。
   * @param {{ path: string, segNo: number, recordStartMs?: number }} freshEntry 当前用于保存的 rolling 段
   * @param {number} clickWallMs 用户点击墙钟时间
   * @param {{ path: string, segNo: number, recordStartMs?: number } | null} prevEntry 前一段（可空）
   * @returns {{ preSegments: string[], replayInitialTimeSec: number, replayUseChain: boolean }}
   */
  buildHighlightPlaybackPlan: function(freshEntry, clickWallMs, prevEntry) {
    const segLenSec = this.segmentDurationMs / 1000;
    const windowSec = (this.highlightPlaybackWindowMs || 8000) / 1000;
    const rs =
      typeof freshEntry.recordStartMs === 'number' && freshEntry.recordStartMs > 0
        ? freshEntry.recordStartMs
        : clickWallMs;
    const offsetSec = Math.max(0, Math.min(segLenSec, (clickWallMs - rs) / 1000));
    const initialSingle = Math.max(0, offsetSec - windowSec);
    if (offsetSec < windowSec && prevEntry && prevEntry.path) {
      const needFromPrev = windowSec - offsetSec;
      const prevInitial = Math.max(0, segLenSec - needFromPrev);
      return {
        preSegments: [prevEntry.path, freshEntry.path],
        replayInitialTimeSec: prevInitial,
        replayUseChain: true
      };
    }
    return {
      preSegments: [freshEntry.path],
      replayInitialTimeSec: initialSingle,
      replayUseChain: false
    };
  },

  /**
   * 在相机预览就绪后再启动滚动分段，避免首屏即 startRecord 导致预览黑屏。
   * 注意：不可因 isRecording 直接 return——会话切换后旧段 stopOneSegment 会早退且不置 false，
   * 会遗留「假 true」，此处若拦截则永远无法 startRollingRecording，高光永远无片段。
   * @returns {void}
   */
  tryStartRollingWhenCameraReady: function() {
    if (!this.rollingActive || !this._cameraInitDone) return;
    if (!this.data.cameraContext) return;
    this.startRollingRecording();
  },

  updateZoom: function(zoomVal) {
    const actualZoom = Math.max(1, Math.min(this.data.maxZoom, zoomVal));
    
    // 只在数值发生实质变化时更新，减少 setData 频率
    if (Math.abs(this.data.zoom - actualZoom) < 0.01) return;

    this.setData({
      zoom: actualZoom
    });
    if (this.data.cameraContext && this.data.cameraContext.setZoom) {
      this.data.cameraContext.setZoom({
        zoom: actualZoom
      });
    }
  },



  // 辅助变量
  lastZoomVal: 1.0,
  isPinching: false,
  /** 多指触控状态锁：双指缩放期间为 true，用于屏蔽空白区域长按事件，避免两者冲突 */
  isMultiTouch: false,
  touchPointsMap: {},
  pinchStartDistance: 0,
  pinchStartZoom: 1,

  // 双指缩放逻辑
  onTouchStart: function(e) {
    if (e.touches && e.touches.length >= 2) {
      this.isPinching = true;
      this.isMultiTouch = true;
      this.pinchStartDistance = this.getDistance(e.touches[0], e.touches[1]);
      this.pinchStartZoom = this.data.zoom;
    }
  },

  onTouchMove: function(e) {
    if (e.touches && e.touches.length >= 2) {
      this.isMultiTouch = true;
    }
    if (!this.isPinching || !e.touches || e.touches.length < 2 || this.pinchStartDistance <= 0) {
      return;
    }
    const currentDistance = this.getDistance(e.touches[0], e.touches[1]);
    if (currentDistance <= 0) return;
    
    const ratio = currentDistance / this.pinchStartDistance;
    const newZoomVal = this.pinchStartZoom * ratio;
    this.updateZoom(newZoomVal);
  },

  onTouchEnd: function(e) {
    this.onScoreTouchEnd(); // 防止干扰记分长按
    if (!e.touches || e.touches.length === 0) {
      this.isPinching = false;
      this.pinchStartDistance = 0;
      // 延迟重置多指锁，避免 touchend 与 longpress 事件时序竞争
      setTimeout(() => {
        this.isMultiTouch = false;
      }, 200);
    } else if (!e.touches || e.touches.length < 2) {
      this.isPinching = false;
      this.pinchStartDistance = 0;
    } else if (this.isPinching) {
      // 仍然有两个或以上手指在屏幕上，重置缩放基准
      this.pinchStartDistance = this.getDistance(e.touches[0], e.touches[1]);
      this.pinchStartZoom = this.data.zoom;
    }
  },

  getDistance: function(p1, p2) {
    const x = p2.pageX - p1.pageX;
    const y = p2.pageY - p1.pageY;
    return Math.sqrt(x * x + y * y);
  },

  hexToRgba: function(hex, opacity) {
    const color = (hex || '#000000').replace('#', '');
    const fullHex = color.length === 3
      ? color.split('').map((c) => c + c).join('')
      : color;
    const r = parseInt(fullHex.substr(0, 2), 16);
    const g = parseInt(fullHex.substr(2, 2), 16);
    const b = parseInt(fullHex.substr(4, 2), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  },

  getContrastColor: function(hexcolor) {
    if (!hexcolor) return '#000000';
    let color = hexcolor.replace('#', '');
    if (color.length === 3) {
      color = color.split('').map((c) => c + c).join('');
    }
    if (color.length !== 6) return '#000000';
    const r = parseInt(color.substr(0, 2), 16);
    const g = parseInt(color.substr(2, 2), 16);
    const b = parseInt(color.substr(4, 2), 16);
    const yiq = ((r * 299) + (g * 587) + (b * 114)) / 1000;
    return yiq >= 128 ? '#000000' : '#FFFFFF';
  },

  normalizeMatchConfig: function(config) {
    const base = config || this.data.matchConfig;
    const normalizedConfig = JSON.parse(JSON.stringify(base || {}));
    if (!normalizedConfig.matchNameColor) normalizedConfig.matchNameColor = '#E64340';

    ['teamA', 'teamB'].forEach((teamKey) => {
      const teamDefaults = teamKey === 'teamA'
        ? { name: '队 A', bgColor: '#E64340', textColor: '#FFFFFF', score: 0 }
        : { name: '队 B', bgColor: '#10AEFF', textColor: '#FFFFFF', score: 0 };
      const sourceTeam = normalizedConfig[teamKey] || {};
      const bgColor = sourceTeam.bgColor || sourceTeam.color || teamDefaults.bgColor;
      const textColor = this.getContrastColor(bgColor);
      normalizedConfig[teamKey] = {
        ...teamDefaults,
        ...sourceTeam,
        bgColor,
        rgbaBg: this.hexToRgba(bgColor, 0.8),
        textColor
      };
    });

    if (typeof normalizedConfig.period !== 'number') {
      normalizedConfig.period = 0;
    }
    return normalizedConfig;
  },

  onShow: function() {
    try {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ['shareAppMessage']
      });
    } catch (e) {
      // 低版本基础库忽略
    }

    this.syncMatchConfigFromPageSources();
    this.appendHealthLog('page_show', {});

    wx.setKeepScreenOn({
      keepScreenOn: true,
      fail: () => {
        setTimeout(() => wx.setKeepScreenOn({ keepScreenOn: true }), 1000);
      }
    });

    if (wx.setPageOrientation) {
      wx.setPageOrientation({ orientation: 'landscape' });
    }

    this.refreshLiveEntitlementAndResume(() => {
      this._liveCoreOnShowAfterEntitlement();
    });
  },

  /**
   * 分享给好友：路径携带当前用户 openid，供新用户登录时上报邀请关系。
   * @returns {WechatMiniprogram.Page.ICustomShareContent}
   */
  onShareAppMessage: function() {
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

  onReady: function() {
    if (wx.nextTick) {
      wx.nextTick(() => this.updateTeamGroupWidth(true));
    } else {
      setTimeout(() => this.updateTeamGroupWidth(true), 0);
    }
  },

  /**
   * 与 WXS `limitTeamName`（最多 12 字）一致，用于非宽度逻辑时可读展示长度。
   *
   * @param {string} name 原始队名
   * @returns {number}
   */
  getDisplayTeamNameCharCount: function(name) {
    const s = String(name || '');
    return Math.min(Array.from(s).length, 12);
  },

  /**
   * 单侧球队区（队名+比分）固定宽度：按 12 个中文字符占位 + 左右边距估算，与队名实际长短无关。
   *
   * @returns {number} 宽度（px）
   */
  computeTeamGroupWidthPx: function() {
    const DISPLAY_CHAR_SLOTS = 12;
    const getShortEdge = () => {
      try {
        if (wx.getWindowInfo) {
          const w = wx.getWindowInfo();
          const ww = w.windowWidth || 375;
          const wh = w.windowHeight || ww;
          return Math.min(ww, wh);
        }
      } catch (e) {}
      const sys = wx.getSystemInfoSync();
      const ww = sys.windowWidth || 375;
      const wh = sys.windowHeight || ww;
      return Math.min(ww, wh);
    };
    /** 使用短边做基准，避免横竖屏时机差异导致记分条忽长忽短。 */
    const shortEdge = getShortEdge();
    const rpxToPx = shortEdge / 750;
    /** 队名区宽度 = 12 字槽位 + 分数固定槽位 + 二者间距 + 左右内边距。 */
    const NAME_CHAR_RPX = 20;
    const SCORE_SLOT_RPX = 40;
    const CONTENT_GAP_RPX = 8;
    const ROW_PADDING_RPX = 20;
    const MIN_RPX = 108;
    let needRpx =
      DISPLAY_CHAR_SLOTS * NAME_CHAR_RPX
      + SCORE_SLOT_RPX
      + CONTENT_GAP_RPX
      + ROW_PADDING_RPX;
    needRpx = Math.max(needRpx, MIN_RPX);
    let widthPx = needRpx * rpxToPx;
    const boardPx = shortEdge * 0.98;
    /** 需与 `.period-center-outer` 的最小宽度 + padding 保持一致。 */
    const centerRpx = 80;
    const maxSidePx = Math.max(72, (boardPx - centerRpx * rpxToPx) / 2 - 4);
    widthPx = Math.min(widthPx, maxSidePx);
    return Math.round(widthPx);
  },

  /**
   * 根据当前 `matchConfig` 刷新左右色块宽度（横竖屏切换时也会重算）。
   *
   * @param {boolean} [force] 为 true 时跳过「数值接近则跳过」优化，避免 onShow 只改 matchConfig 时宽度未刷新
   * @returns {void}
   */
  updateTeamGroupWidth: function(force) {
    const wSide = this.computeTeamGroupWidthPx();
    if (
      !force &&
      Math.abs(wSide - (this.data.teamGroupWidthPxA || 0)) < 0.5 &&
      Math.abs(wSide - (this.data.teamGroupWidthPxB || 0)) < 0.5
    ) {
      return;
    }
    this.setData({ teamGroupWidthPxA: wSide, teamGroupWidthPxB: wSide });
  },

  onUnload: function() {
    this.rollingActive = false;
    this._rollingPausedForReplay = false;
    this.stopHealthMonitor();
    this.clearRecoveryFabAck();
    this.stopRecoveryProgressAnim(false);
    if (this._recoveryGuardTimer) {
      clearTimeout(this._recoveryGuardTimer);
      this._recoveryGuardTimer = null;
    }
    if (this._recoveryFailSafeTimer) {
      clearTimeout(this._recoveryFailSafeTimer);
      this._recoveryFailSafeTimer = null;
    }
    if (this._recoverUiFailsafeTimer) {
      clearTimeout(this._recoverUiFailsafeTimer);
      this._recoverUiFailsafeTimer = null;
    }
    if (this._insertCameraRetryTimer) {
      clearTimeout(this._insertCameraRetryTimer);
      this._insertCameraRetryTimer = null;
    }
    if (this._relaunchPressTimer) {
      clearTimeout(this._relaunchPressTimer);
      this._relaunchPressTimer = null;
    }
    this._insertConflictRecovering = false;
    this._needManualRelaunch = false;
    this._hardRecoverAwaitingCamera = false;
    this._cameraInitDone = false;
    if (this._rollingKickoffTimer) {
      clearTimeout(this._rollingKickoffTimer);
      this._rollingKickoffTimer = null;
    }
    if (this.pendingHighlight && this.pendingHighlight.timeout) {
      clearTimeout(this.pendingHighlight.timeout);
    }
    this.pendingHighlight = null;
    this.clearHighlightSavePipelineState();
    this.segmentBuffer = [];
    this.highlightMaterializeQueue = [];
    this.highlightMaterializeRunning = false;
    this.highlightMissStreak = 0;
    this.lastHighlightConsumedSegNo = 0;
    this.rollingFsBusy = false;
    if (this.rollingWatchdogTimer) {
      clearInterval(this.rollingWatchdogTimer);
      this.rollingWatchdogTimer = null;
    }
    this.appendHealthLog('page_unload', {});
    this.setData({
      cameraMounted: false,
      cameraContext: null,
      isRecording: false,
      showRecoveryVeil: false
    });
    this.stopRollingRecording();
  },

  onHide: function() {
    this.rollingActive = false;
    this._rollingPausedForReplay = false;
    this.clearHighlightSavePipelineState();
    this.endHighlightSaving();
    this.stopHealthMonitor();
    this.clearRecoveryFabAck();
    this.stopRecoveryProgressAnim(false);
    if (this._recoveryGuardTimer) {
      clearTimeout(this._recoveryGuardTimer);
      this._recoveryGuardTimer = null;
    }
    if (this._recoveryFailSafeTimer) {
      clearTimeout(this._recoveryFailSafeTimer);
      this._recoveryFailSafeTimer = null;
    }
    if (this._recoverUiFailsafeTimer) {
      clearTimeout(this._recoverUiFailsafeTimer);
      this._recoverUiFailsafeTimer = null;
    }
    if (this._insertCameraRetryTimer) {
      clearTimeout(this._insertCameraRetryTimer);
      this._insertCameraRetryTimer = null;
    }
    if (this._relaunchPressTimer) {
      clearTimeout(this._relaunchPressTimer);
      this._relaunchPressTimer = null;
    }
    this._insertConflictRecovering = false;
    this._needManualRelaunch = false;
    this._hardRecoverAwaitingCamera = false;
    this._recoveryLock = false;
    this._manualRecoveryPendingAck = false;
    this.highlightMaterializeQueue = [];
    this.highlightMaterializeRunning = false;
    if (this.data.isRecovering) {
      this.setData({ isRecovering: false, showRecoveryVeil: false });
    }
    this.appendHealthLog('page_hide', {});
    this._cameraInitDone = false;
    this.setData({ cameraMounted: false, cameraContext: null, isRecording: false });
    this.stopRollingRecording();
  },

  /**
   * 清除恢复按钮成功闪烁状态（页面隐藏/卸载时调用）。
   * @returns {void}
   */
  clearRecoveryFabAck: function() {
    if (this._opsAckTimer) {
      clearTimeout(this._opsAckTimer);
      this._opsAckTimer = null;
    }
    if (this.data.opsControlAck) {
      this.setData({ opsControlAck: false });
    }
  },

  /**
   * 触发恢复成功的隐式反馈：一次短震 + 恢复按钮外环轻微闪烁，不显示文字提示。
   * @returns {void}
   */
  emitRecoverySuccessFeedback: function() {
    this.vibrate('light');
    if (this._opsAckTimer) {
      clearTimeout(this._opsAckTimer);
      this._opsAckTimer = null;
    }
    this.setData({ opsControlAck: true });
    this._opsAckTimer = setTimeout(() => {
      this._opsAckTimer = null;
      this.setData({ opsControlAck: false });
    }, 820);
  },

  /**
   * 刷新管线健康状态（低干扰状态灯）。
   * @returns {void}
   */
  updatePipelineHealth: function() {
    let health = 'ok';
    let text = 'PAUSE';
    let actionable = false;
    if (this._needManualRelaunch) {
      if (
        this.data.pipelineHealth !== 'warn'
        || this.data.opsControlText !== 'ERR'
        || this.data.opsControlActionable !== true
      ) {
        this.setData({
          pipelineHealth: 'warn',
          opsControlText: 'ERR',
          opsControlActionable: true
        });
      }
      return;
    }
    const now = Date.now();
    const pendingAgeMs = this.pendingHighlight
      ? (now - (this.pendingHighlight.createdAt || now))
      : 0;
    const idleTooLong =
      this.rollingActive
      && this._cameraInitDone
      && (now - (this.lastSegmentAt || 0) > this.segmentDurationMs * 3.5)
      && !this.data.isRecording
      && !this.rollingFsBusy;
    const captureLikelyBlocked =
      this.highlightMissStreak > 0
      || this.startRecordFailStreak >= 3
      || (this.pendingHighlight && pendingAgeMs > this.segmentDurationMs * 2.2)
      || idleTooLong;
    if (this.data.isRecovering) {
      health = 'recovering';
      text = '...';
    } else if (captureLikelyBlocked) {
      health = 'warn';
      text = 'ERR';
      actionable = true;
    } else if (this.data.isRecording) {
      health = 'recording';
      text = 'REC';
    }
    if (
      health !== this.data.pipelineHealth
      || text !== this.data.opsControlText
      || actionable !== this.data.opsControlActionable
    ) {
      this.setData({
        pipelineHealth: health,
        opsControlText: text,
        opsControlActionable: actionable
      });
    }
  },

  /**
   * 启动健康状态监控定时器。
   * @returns {void}
   */
  startHealthMonitor: function() {
    this.stopHealthMonitor();
    this.updatePipelineHealth();
    this._healthTimer = setInterval(() => this.updatePipelineHealth(), 1200);
  },

  /**
   * 停止健康状态监控定时器。
   * @returns {void}
   */
  stopHealthMonitor: function() {
    if (!this._healthTimer) return;
    clearInterval(this._healthTimer);
    this._healthTimer = null;
  },

  /**
   * 启动恢复进度圆环动画（在 isRecovering 期间爬升至约 88%，就绪后由 stopRecoveryProgressAnim(true) 拉满）。
   * @returns {void}
   */
  startRecoveryProgressAnim: function() {
    if (this._recoverProgTimer) {
      clearInterval(this._recoverProgTimer);
      this._recoverProgTimer = null;
    }
    if (this._recoverProgressResetTimer) {
      clearTimeout(this._recoverProgressResetTimer);
      this._recoverProgressResetTimer = null;
    }
    this.setData({ recoveryProgress: 0, recoveryConicEndDeg: 0 });
    this._recoverProgTimer = setInterval(() => {
      if (!this.data.isRecovering) {
        clearInterval(this._recoverProgTimer);
        this._recoverProgTimer = null;
        return;
      }
      const next = Math.min(88, this.data.recoveryProgress + 3);
      this.setData({
        recoveryProgress: next,
        recoveryConicEndDeg: next * 3.6
      });
      if (next >= 88) {
        clearInterval(this._recoverProgTimer);
        this._recoverProgTimer = null;
      }
    }, 110);
  },

  /**
   * 停止恢复进度动画；成功时短暂显示满环再归零。
   * @param {boolean} complete 是否视为恢复成功
   * @returns {void}
   */
  stopRecoveryProgressAnim: function(complete) {
    if (this._recoverProgTimer) {
      clearInterval(this._recoverProgTimer);
      this._recoverProgTimer = null;
    }
    if (this._recoverProgressResetTimer) {
      clearTimeout(this._recoverProgressResetTimer);
      this._recoverProgressResetTimer = null;
    }
    if (!complete) {
      this.setData({ recoveryProgress: 0, recoveryConicEndDeg: 0 });
      return;
    }
    this.setData({ recoveryProgress: 100, recoveryConicEndDeg: 360 });
    this._recoverProgressResetTimer = setTimeout(() => {
      this._recoverProgressResetTimer = null;
      if (!this.data.isRecovering) {
        this.setData({ recoveryProgress: 0, recoveryConicEndDeg: 0 });
      }
    }, 480);
  },

  /**
   * 恢复失败兜底：释放锁并回退 UI，避免状态钮永久不可点击。
   * @param {string} reason
   * @returns {void}
   */
  finalizeRecoveryAsFailed: function(reason) {
    if (this._recoverUiFailsafeTimer) {
      clearTimeout(this._recoverUiFailsafeTimer);
      this._recoverUiFailsafeTimer = null;
    }
    if (this._recoveryFailSafeTimer) {
      clearTimeout(this._recoveryFailSafeTimer);
      this._recoveryFailSafeTimer = null;
    }
    this._hardRecoverAwaitingCamera = false;
    this._manualRecoveryPendingAck = false;
    this.stopRecoveryProgressAnim(false);
    this.setData({ isRecovering: false, showRecoveryVeil: false });
    this._recoveryLock = false;
    this.appendHealthLog('hard_recover_fail', { reason: reason || 'unknown' });
    if (
      reason === 'recovering_ui_5s_failsafe'
      && (this._insertCameraErrorStreak || 0) >= 2
    ) {
      this.markNeedManualRelaunch('recovering_failsafe_after_insert_conflict');
    }
    this.updatePipelineHealth();
  },

  /**
   * 页面内一键恢复：硬重建 camera 与 rolling 管线，避免必须退回微信。
   * @param {string} trigger 触发来源（manual/auto）
   * @returns {void}
   */
  hardRecoverLivePipeline: function(trigger) {
    if (this._recoveryLock) return;
    const now = Date.now();
    const cooldownUntil = this._insertCameraRecoverCooldownUntil || 0;
    const source = trigger || 'manual';
    const isAutoRecover = source.indexOf('auto:') === 0;
    if (isAutoRecover && now < cooldownUntil) {
      this.appendHealthLog('hard_recover_skip_insert_cooldown', {
        trigger: source,
        waitMs: cooldownUntil - now
      });
      if (!this._insertCameraRetryTimer) {
        const delay = Math.max(600, cooldownUntil - now + 120);
        this._insertCameraRetryTimer = setTimeout(() => {
          this._insertCameraRetryTimer = null;
          if (this.data.isRecovering || this._recoveryLock) return;
          this.hardRecoverLivePipeline('auto:insert_camera_conflict_retry');
        }, delay);
      }
      return;
    }
    if (now - (this._lastHardRecoverAt || 0) < (this._hardRecoverMinGapMs || 2200)) {
      this.appendHealthLog('hard_recover_skip_too_frequent', { trigger: trigger || 'manual' });
      return;
    }
    this._lastHardRecoverAt = now;
    this._recoveryLock = true;
    if (this._recoveryGuardTimer) {
      clearTimeout(this._recoveryGuardTimer);
      this._recoveryGuardTimer = null;
    }
    this.appendHealthLog('hard_recover_start', { trigger: source });
    this._manualRecoveryPendingAck = typeof source === 'string' && source.indexOf('manual') === 0;
    this._hardRecoverAwaitingCamera = true;
    this._recoveryGuardTimer = setTimeout(() => {
      this._recoveryGuardTimer = null;
      if (!this._hardRecoverAwaitingCamera) return;
      this.appendHealthLog('hard_recover_timeout', { trigger: source });
      // 超时后二次强制重建一次，避免 iOS 在 stop 后偶发不再触发 initdone。
      this.rebuildCameraComponent(() => {
        this.setData({ cameraMounted: true }, () => {
          const bindCameraContext = () => {
            const nextCameraContext = wx.createCameraContext();
            this.setData({ cameraContext: nextCameraContext, isRecording: false });
          };
          if (wx.nextTick) wx.nextTick(bindCameraContext);
          else setTimeout(bindCameraContext, 0);
        });
      });
      if (this._recoveryFailSafeTimer) {
        clearTimeout(this._recoveryFailSafeTimer);
      }
      this._recoveryFailSafeTimer = setTimeout(() => {
        if (!this._hardRecoverAwaitingCamera) return;
        this.finalizeRecoveryAsFailed('timeout_after_retry_rebuild');
      }, 4500);
    }, 6000);
    this.rollingActive = false;
    this.rollingSessionId += 1;
    if (this.pendingHighlight && this.pendingHighlight.timeout) {
      clearTimeout(this.pendingHighlight.timeout);
    }
    this.pendingHighlight = null;
    this.clearHighlightSavePipelineState();
    this.rollingFsBusy = false;
    this.lastRecordStartAt = 0;
    this.startRecordFailStreak = 0;
    this.setData({
      isRecovering: true,
      showRecoveryVeil: true,
      recoveryVeilSrc: this.data.defaultCover
    });
    if (this._recoverUiFailsafeTimer) {
      clearTimeout(this._recoverUiFailsafeTimer);
      this._recoverUiFailsafeTimer = null;
    }
    this._recoverUiFailsafeTimer = setTimeout(() => {
      this._recoverUiFailsafeTimer = null;
      if (this.data.isRecovering) {
        this.finalizeRecoveryAsFailed('recovering_ui_5s_failsafe');
      }
    }, 5000);
    this.startRecoveryProgressAnim();
    this.stopRollingRecording(() => {
      this.rebuildCameraComponent(() => {
        this._cameraInitDone = false;
        this.segmentBuffer = [];
        this.lastSegmentAt = Date.now();
        this.setData({ cameraMounted: true }, () => {
          const bindCameraContext = () => {
            const nextCameraContext = wx.createCameraContext();
            this.setData({ cameraContext: nextCameraContext, isRecording: false }, () => {
              this.rollingActive = true;
              this.rollingSessionId += 1;
              this.highlightMissStreak = 0;
              this._cameraFaultStreak = 0;
              this.appendHealthLog('hard_recover_rebuild_done', { trigger: source });
            });
          };
          if (wx.nextTick) wx.nextTick(bindCameraContext);
          else setTimeout(bindCameraContext, 0);
        });
      });
    });
  },

  /**
   * 右下角状态钮：REC 时保存高光；ERR 时单击触发页内硬恢复（不跳页、不挡预览）。
   * @returns {void}
   */
  onRecoveryFabTap: function() {
    if (this.data.isRecovering) return;
    if (this.data.isSavingHighlight || this.pendingHighlight) {
      return;
    }
    if (this._recoveryFabLongPressConsumed) {
      this._recoveryFabLongPressConsumed = false;
      return;
    }
    if (this.data.pipelineHealth === 'recording') {
      this.requestHighlightCapture();
      return;
    }
    const isErr =
      this.data.pipelineHealth === 'warn'
      || this._needManualRelaunch
      || this.data.opsControlText === 'ERR';
    if (isErr) {
      this.vibrate('light');
      this.appendHealthLog('recovery_fab_tap_recover', {});
      this.hardRecoverLivePipeline('manual_tap');
    }
  },

  /**
   * 系统 longpress：ERR 态下触发页内硬恢复。
   * @returns {void}
   */
  onRecoveryFabLongPress: function() {
    if (this.data.isRecovering) return;
    this._recoveryFabLongPressConsumed = true;
    const isErr =
      this.data.pipelineHealth === 'warn'
      || this._needManualRelaunch
      || this.data.opsControlText === 'ERR';
    if (!isErr) return;
    this.vibrate('light');
    this.appendHealthLog('recovery_fab_longpress_recover', {});
    this.hardRecoverLivePipeline('manual_longpress');
  },

  /**
   * 状态灯按下：ERR 态长按约 1.8s 触发页内硬恢复（与单击互为补充）。
   * @returns {void}
   */
  onRecoveryFabTouchStart: function() {
    const isErr =
      this.data.pipelineHealth === 'warn'
      || this._needManualRelaunch
      || this.data.opsControlText === 'ERR';
    if (!isErr) return;
    if (this._relaunchPressTimer) {
      clearTimeout(this._relaunchPressTimer);
      this._relaunchPressTimer = null;
    }
    this._relaunchPressTimer = setTimeout(() => {
      this._relaunchPressTimer = null;
      this._recoveryFabLongPressConsumed = true;
      this.vibrate('light');
      this.appendHealthLog('recovery_fab_hold_recover', {});
      this._needManualRelaunch = false;
      this.hardRecoverLivePipeline('manual_hold_recover');
    }, 1800);
  },

  /**
   * 状态灯抬起/取消：清理长按重启计时器。
   * @returns {void}
   */
  onRecoveryFabTouchEnd: function() {
    if (this._relaunchPressTimer) {
      clearTimeout(this._relaunchPressTimer);
      this._relaunchPressTimer = null;
    }
  },

  // 节次切换
  onPeriodTap: function() {
    let { period } = this.data.matchConfig;
    period = (period + 1) % this.data.periods.length;
    this.setData({ 'matchConfig.period': period });
    this.vibrate('light');
  },

  // 核心记分逻辑
  onScoreTap: function(e) {
    const { team, type } = e.currentTarget.dataset;
    if (this.suppressScoreTap) {
      this.suppressScoreTap = false;
      return;
    }
    this.applyScoreChange(team, type);
    if (type === 'plus') {
      this.vibrate('medium');
    } else if (type === 'minus') {
      this.vibrate('light');
    }
    this.persistConfig();
  },

  applyScoreChange: function(team, type) {
    let score = this.data.matchConfig[team].score;
    if (type === 'plus') {
      score += 1;
    } else if (type === 'minus') {
      score = Math.max(0, score - 1);
    }
    this.setData({ [`matchConfig.${team}.score`]: score });
  },

  onBackTap: function() {
    this.closeAllDrawers();
    this.stopRollingRecording();
    wx.navigateBack();
  },

  // 长按连续记分
  onScoreLongPress: function(e) {
    const { team, type } = e.currentTarget.dataset;
    this.vibrate('heavy');
    this.suppressScoreTap = true;
    if (this.data.longPressTimer) {
      clearInterval(this.data.longPressTimer);
    }
    this.applyScoreChange(team, type);
    const timer = setInterval(() => {
      this.applyScoreChange(team, type);
    }, 120);

    this.setData({ longPressTimer: timer });
  },

  // 停止长按
  onScoreTouchEnd: function() {
    if (this.data.longPressTimer) {
      clearInterval(this.data.longPressTimer);
      this.setData({ longPressTimer: null });
      this.persistConfig();
    }
    setTimeout(() => {
      this.suppressScoreTap = false;
    }, 0);
  },

  // 震动反馈
  vibrate: function(type) {
    // 兼容性与稳定性修复：
    // 1. iOS 优先使用 type 参数以获得细腻的触觉反馈。
    // 2. Android 部分机型在传入 type 时可能失效或无响应，故直接调用无参版以确保触发。
    try {
      const sys = wx.getSystemInfoSync();
      if (sys.platform === 'ios') {
        wx.vibrateShort({ type: type || 'medium' });
      } else {
        wx.vibrateShort();
      }
    } catch (e) {
      // 兜底
      if (wx.vibrateShort) wx.vibrateShort();
    }
  },

  /**
   * 高光保存成功时的触觉反馈。异步落盘完成后 iOS 常不再算「用户手势」，故需配合长按瞬间的震动；
   * Android 优先长震，失败则短震组合。
   */
  vibrateHighlightSaved: function() {
    const fallback = () => {
      this.vibrate('heavy');
      setTimeout(() => this.vibrate('heavy'), 160);
      setTimeout(() => this.vibrate('medium'), 320);
    };
    if (wx.vibrateLong) {
      wx.vibrateLong({
        success: () => {
          setTimeout(() => this.vibrate('medium'), 80);
        },
        fail: fallback
      });
    } else {
      fallback();
    }
  },

  getHighlightDir: function() {
    return `${wx.env.USER_DATA_PATH}/highlights`;
  },

  /**
   * 滚动录制缓存目录（用于提高高光保存稳定性）。
   * 注意：这里存的是最近若干段“已落盘”的视频片段，避免 temp 文件被系统回收。
   * @returns {string}
   */
  getRollingDir: function() {
    return `${this.getHighlightDir()}/_rolling`;
  },

  ensureHighlightDir: function() {
    const fs = wx.getFileSystemManager();
    const dirPath = this.getHighlightDir();
    return new Promise((resolve) => {
      fs.access({
        path: dirPath,
        success: () => resolve(),
        fail: () => {
          fs.mkdir({
            dirPath,
            recursive: true,
            success: () => resolve(),
            fail: () => resolve()
          });
        }
      });
    });
  },

  /**
   * 确保滚动录制缓存目录存在。
   * @returns {Promise<void>}
   */
  ensureRollingDir: function() {
    const fs = wx.getFileSystemManager();
    const dirPath = this.getRollingDir();
    return new Promise((resolve) => {
      fs.access({
        path: dirPath,
        success: () => resolve(),
        fail: () => {
          fs.mkdir({
            dirPath,
            recursive: true,
            success: () => resolve(),
            fail: () => resolve()
          });
        }
      });
    });
  },

  /**
   * 清理 rolling 目录中的历史会话残留分段，避免长期运行后占满沙盒存储导致落盘失败。
   * 说明：仅删除 `_rolling` 目录下的临时分段，不影响已保存高光。
   * @returns {Promise<void>}
   */
  clearStaleRollingFiles: function() {
    const fs = wx.getFileSystemManager();
    const rollingDir = this.getRollingDir();
    return new Promise((resolve) => {
      fs.readdir({
        dirPath: rollingDir,
        success: (res) => {
          const files = Array.isArray(res && res.files) ? res.files : [];
          if (files.length === 0) {
            resolve();
            return;
          }
          let pending = files.length;
          files.forEach((name) => {
            const fullPath = `${rollingDir}/${name}`;
            fs.unlink({
              filePath: fullPath,
              complete: () => {
                pending -= 1;
                if (pending <= 0) resolve();
              }
            });
          });
        },
        fail: () => resolve()
      });
    });
  },

  startRollingRecording: function() {
    if (!this.data.cameraContext) return;
    /** 已在录时勿重复拉起，避免双 startRecord；假阳性 isRecording 由 onShow 的 stopRollingRecording 收口 */
    if (this.data.isRecording) return;
    const sessionId = this.rollingSessionId;
    Promise.all([this.ensureHighlightDir(), this.ensureRollingDir()]).then(() => {
      if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
      if (this.rollingWatchdogTimer) {
        clearInterval(this.rollingWatchdogTimer);
      }
      /**
       * 录制看门狗：如果录制意外断流（例如 startRecord 连续失败），自动拉起。
       */
      this.rollingWatchdogTimer = setInterval(() => {
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        /** copy 尚未完成时不能认为「空闲」，否则会在长直播、磁盘变慢时并行 startRecord */
        if (this.rollingFsBusy) return;
        const now = Date.now();
        const isStuckRecording = this.data.isRecording
          && this.lastRecordStartAt > 0
          && (now - this.lastRecordStartAt > this.segmentDurationMs * 2.8);
        if (isStuckRecording) {
          try {
            this.data.cameraContext.stopRecord({
              complete: () => {
                this.setData({ isRecording: false });
                this.lastRecordStartAt = 0;
                this.scheduleAfterStopRecord(() => this.startOneSegment(sessionId, 0));
              }
            });
          } catch (e) {
            this.setData({ isRecording: false });
            this.lastRecordStartAt = 0;
            this.scheduleAfterStopRecord(() => this.startOneSegment(sessionId, 0));
          }
          return;
        }
        if (this.data.isRecording) return;
        const streamIdleTooLong = now - this.lastSegmentAt > this.segmentDurationMs * 3;
        if (!streamIdleTooLong) return;
        this.startOneSegment(sessionId, 0);
      }, this.segmentDurationMs * 3);
      this.startOneSegment(sessionId);
    });
  },

  startOneSegment: function(sessionId, retryCount = 0) {
    if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
    if (!this.data.cameraContext) return;
    this.data.cameraContext.startRecord({
      timeout: Math.max(12, Math.ceil(this.segmentDurationMs / 1000) + 2),
      success: () => {
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        const hadFailBefore = this.startRecordFailStreak > 0;
        this.startRecordFailStreak = 0;
        this.segmentStartFailStormCycles = 0;
        this._currentRollingSegmentRecordStartMs = Date.now();
        this.lastRecordStartAt = Date.now();
        this.setData({ isRecording: true });
        if (
          this._highlightSaveAwaitingResume
          && this._highlightSaveSessionId === sessionId
        ) {
          this._highlightPipelineDoneResume = true;
          this.maybeReleaseHighlightSaveLock();
        }
        if (hadFailBefore) {
          this.appendHealthLog('segment_start_ok_recovered', { retryCount });
        }
        if (retryCount > 0) {
          this.appendHealthLog('segment_start_ok_after_retry', { retryCount });
        }
        if (this.segmentStopTimer) clearTimeout(this.segmentStopTimer);
        this.segmentStopTimer = setTimeout(() => {
          this.stopOneSegment(sessionId);
        }, this.segmentDurationMs);
      },
      fail: () => {
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        this.startRecordFailStreak += 1;
        this.appendHealthLog('segment_start_fail', {
          retryCount,
          failStreak: this.startRecordFailStreak
        });
        // 关键修复：不能在少量失败后停止，否则 segmentCounter 会冻结，后续高光重复。
        const nextRetry = retryCount + 1;
        const delay = Math.min(1500, 220 + nextRetry * 140);
        if (this.startRecordFailStreak >= 5) {
          this.segmentStartFailStormCycles = (this.segmentStartFailStormCycles || 0) + 1;
          this.appendHealthLog('segment_start_fail_storm_cycle', {
            cycles: this.segmentStartFailStormCycles
          });
          if (this.segmentStartFailStormCycles >= 3) {
            this.segmentStartFailStormCycles = 0;
            this.markNeedManualRelaunch('segment_start_fail_storm');
            this.startRecordFailStreak = 0;
            this.setData({ isRecording: false });
            this.lastRecordStartAt = 0;
            return;
          }
          this.startRecordFailStreak = 0;
          this.setData({ isRecording: false });
          this.lastRecordStartAt = 0;
          this.scheduleAfterStopRecord(() => this.startOneSegment(sessionId, 0));
          return;
        }
        setTimeout(() => this.startOneSegment(sessionId, nextRetry), delay);
      }
    });
  },

  stopOneSegment: function(sessionId) {
    if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
    if (!this.data.cameraContext || !this.data.isRecording) return;
    this.data.cameraContext.stopRecord({
      success: (res) => {
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        this.setData({ isRecording: false });
        this.lastRecordStartAt = 0;
        const tempPath = res && res.tempVideoPath ? res.tempVideoPath : '';
        const recordStartWallMs = this._currentRollingSegmentRecordStartMs || 0;
        /** 在 copy 完成前就刷新心跳，避免仅依赖 finalize 时写盘慢导致看门狗误判空闲 */
        this.lastSegmentAt = Date.now();
        this.segmentCounter += 1;
        if (tempPath) {
          // 关键时序修复：
          // 先固定当前片段，再开始下一段录制，避免 tempPath 被后续录制复用/覆盖。
          // 传入 recordSessionId：copy 异步完成时若已 onShow/恢复导致 rollingSessionId 变化，则不得写入缓冲，否则会指向错文件、保存必败。
          this.onSegmentRecorded(tempPath, this.segmentCounter, sessionId, recordStartWallMs).finally(() => {
            this.scheduleAfterStopRecord(() => this.startOneSegment(sessionId));
          });
          return;
        }
        this.abortHighlightAfterStopIfNeeded(sessionId, 'empty_temp_path');
        this.scheduleAfterStopRecord(() => this.startOneSegment(sessionId));
      },
      fail: () => {
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        this.setData({ isRecording: false });
        this.lastRecordStartAt = 0;
        this.abortHighlightAfterStopIfNeeded(sessionId, 'stop_record_fail');
        this.scheduleAfterStopRecord(() => this.startOneSegment(sessionId));
      }
    });
  },

  /**
   * 停止滚动分段录制并清理定时器。
   * @param {function(): void} [onStopped] 在录制状态已释放后调用（无录制时下一 tick 调用）
   * @returns {void}
   */
  stopRollingRecording: function(onStopped) {
    if (this.rollingWatchdogTimer) {
      clearInterval(this.rollingWatchdogTimer);
      this.rollingWatchdogTimer = null;
    }
    if (this.segmentStopTimer) {
      clearTimeout(this.segmentStopTimer);
      this.segmentStopTimer = null;
    }
    let finishOnce = false;
    /**
     * 将 isRecording 置 false 后再执行 onStopped，避免 setData 未完成时 startRollingRecording
     * 仍读到 isRecording === true 而直接 return。
     */
    const finish = () => {
      if (finishOnce) return;
      finishOnce = true;
      this.lastRecordStartAt = 0;
      let stoppedRan = false;
      const runStopped = () => {
        if (stoppedRan || typeof onStopped !== 'function') return;
        stoppedRan = true;
        if (wx.nextTick) wx.nextTick(onStopped);
        else setTimeout(onStopped, 0);
      };
      if (this.data.isRecording) {
        this.setData({ isRecording: false }, runStopped);
        setTimeout(runStopped, 120);
      } else {
        runStopped();
      }
    };
    if (this.data.cameraContext && this.data.isRecording) {
      try {
        this.data.cameraContext.stopRecord({
          success: finish,
          fail: finish
        });
      } catch (e) {
        finish();
      }
    } else {
      finish();
    }
  },

  /**
   * 将单段录制结果写入滚动缓存。
   * @param {string} tempPath 临时视频路径
   * @param {number} segNo 片段序号
   * @param {number} recordSessionId 本段录制开始时的 {@link rollingSessionId}，异步落盘完成时必须一致才入缓冲
   * @param {number} [recordStartWallMs] 本段 startRecord 成功时的墙钟时间（用于高光逻辑起播偏移）
   * @returns {Promise<void>}
   */
  onSegmentRecorded: function(tempPath, segNo, recordSessionId, recordStartWallMs) {
    // 关键修复：把每个 segment 立刻保存到本地 rolling 目录，避免 tempVideoPath 后续失效。
    this.rollingFsBusy = true;
    return this.ensureRollingDir().then(() => new Promise((resolve) => {
      const fs = wx.getFileSystemManager();
      const rollingDir = this.getRollingDir();
      const rollingPath = `${rollingDir}/seg_${segNo}.mp4`;
      const sessionOk = () => recordSessionId === this.rollingSessionId;
      /**
       * 将临时文件读入内存再写入 rolling（部分机型 copyFile/saveFile 失败时仍可用）。
       * @param {function(string): void} onDone 落盘后的物理路径
       * @returns {void}
       */
      const tryTempToRollingReadWrite = (onDone) => {
        fs.readFile({
          filePath: tempPath,
          success: (readRes) => {
            const raw = readRes && readRes.data;
            if (!raw) {
              onDone('');
              return;
            }
            fs.writeFile({
              filePath: rollingPath,
              data: raw,
              success: () => onDone(rollingPath),
              fail: () => onDone('')
            });
          },
          fail: () => onDone('')
        });
      };
      const finalizeSegment = (savedPath) => {
        if (!sessionOk()) {
          resolve();
          return;
        }
        if (savedPath) {
          this.segmentBuffer.push({
            path: savedPath,
            segNo,
            recordStartMs: typeof recordStartWallMs === 'number' ? recordStartWallMs : 0,
            refCount: 0
          });
        }
        if (
          this._highlightAfterStopMeta
          && this._highlightAfterStopMeta.recordSessionId === recordSessionId
          && this._highlightAfterStopMeta.expectedSegNo === segNo
        ) {
          const currentSegPath = savedPath || tempPath || '';
          if (!savedPath && tempPath) {
            this.appendHealthLog('segment_persist_use_temp_fallback', {});
          }
          if (!currentSegPath) {
            this.abortHighlightAfterStopIfNeeded(recordSessionId, 'segment_persist_fail');
            resolve();
            return;
          }
          const hm = this._highlightAfterStopMeta;
          const segLenSec = this.segmentDurationMs / 1000;
          const windowSec = (this.highlightPlaybackWindowMs || 8000) / 1000;
          const clickWallMs =
            typeof hm.clickWallMs === 'number' && hm.clickWallMs > 0
              ? hm.clickWallMs
              : Date.now();
          const curLenSec = Math.max(
            0,
            Math.min(segLenSec, (clickWallMs - (recordStartWallMs || clickWallMs)) / 1000)
          );
          const prevEntry = this.pickPrevRollingEntry(segNo);
          const needDual = curLenSec < windowSec && prevEntry && prevEntry.path;
          const replayInitialTimeSec = needDual
            ? Math.max(0, segLenSec - (windowSec - curLenSec))
            : Math.max(0, curLenSec - windowSec);
          this.finalizeHighlight({
            id: hm.id,
            createdAt: hm.createdAt,
            startSegNo: hm.startSegNo,
            matchName: hm.matchName,
            matchId: hm.matchId,
            cover: hm.cover,
            finalizing: false,
            sourceSegNo: segNo,
            preSegments: needDual ? [prevEntry.path, currentSegPath] : [currentSegPath],
            postSegments: [],
            replayInitialTimeSec,
            replayUseChain: !!needDual
          });
          this.segmentPersistFailStreak = 0;
          this._highlightAfterStopMeta = null;
          resolve();
          return;
        }
        if (!savedPath) {
          resolve();
          return;
        }
        const maxBuf = this.rollingBufferMax || 10;
        if (this.segmentBuffer.length > maxBuf) {
          const excess = this.segmentBuffer.length - maxBuf;
          const removed = [];
          const kept = [];
          for (let i = 0; i < this.segmentBuffer.length; i += 1) {
            const it = this.segmentBuffer[i];
            if (removed.length < excess && Number(it && it.refCount || 0) <= 0) {
              removed.push(it);
            } else {
              kept.push(it);
            }
          }
          this.segmentBuffer = kept;
          // 清理被淘汰的 rolling 文件（不影响已保存为高光的副本）
          removed.forEach((it) => {
            if (!it || !it.path) return;
            if (it.path.indexOf(this.getRollingDir()) !== 0) return;
            try { fs.unlinkSync(it.path); } catch (e) {}
          });
        }

        // 缓冲尚空时用户已触发保存：等「尚未保存过」的片段落盘。
        // 仅用 segNo > minSegNoExclusive：若再要求 segNo >= startSegNo，在 copy 乱序或
        // segmentCounter 已前进时，会先来的较小 seg 被永久跳过，大序号若未落盘则一直超时。
        if (this.pendingHighlight && !this.pendingHighlight.finalizing && this.pendingHighlight.waitNext) {
          const minEx =
            typeof this.pendingHighlight.minSegNoExclusive === 'number'
              ? this.pendingHighlight.minSegNoExclusive
              : 0;
          if (segNo > minEx) {
            const waitPending = this.pendingHighlight;
            this.pendingHighlight = null;
            if (waitPending.timeout) {
              clearTimeout(waitPending.timeout);
              waitPending.timeout = null;
            }
            const entryMeta = {
              path: savedPath,
              segNo,
              recordStartMs: typeof recordStartWallMs === 'number' ? recordStartWallMs : 0
            };
            const prevWait = this.pickPrevRollingEntry(segNo);
            const planWait = this.buildHighlightPlaybackPlan(entryMeta, waitPending.createdAt, prevWait);
            this.finalizeHighlight({
              id: waitPending.id,
              createdAt: waitPending.createdAt,
              startSegNo: waitPending.startSegNo,
              matchName: waitPending.matchName,
              matchId: waitPending.matchId,
              cover: waitPending.cover,
              finalizing: false,
              sourceSegNo: segNo,
              preSegments: planWait.preSegments,
              postSegments: [],
              replayInitialTimeSec: planWait.replayInitialTimeSec,
              replayUseChain: planWait.replayUseChain
            });
          }
        }
        resolve();
      };

      // 优先 copyFile，避免 saveFile 配额/持久化限制导致缓冲不更新而反复引用旧片段。
      if (fs.copyFile) {
        fs.copyFile({
          srcPath: tempPath,
          destPath: rollingPath,
          success: () => finalizeSegment(rollingPath),
          fail: () => {
            fs.saveFile({
              tempFilePath: tempPath,
              filePath: rollingPath,
              success: (r) => finalizeSegment((r && r.savedFilePath) ? r.savedFilePath : rollingPath),
              fail: () => {
                tryTempToRollingReadWrite((rwPath) => {
                  if (rwPath) finalizeSegment(rwPath);
                  else finalizeSegment('');
                });
              }
            });
          }
        });
        return;
      }
      fs.saveFile({
        tempFilePath: tempPath,
        filePath: rollingPath,
        success: (r) => finalizeSegment((r && r.savedFilePath) ? r.savedFilePath : rollingPath),
        fail: () => {
          tryTempToRollingReadWrite((rwPath) => {
            if (rwPath) finalizeSegment(rwPath);
            else finalizeSegment('');
          });
        }
      });
    }))
      .catch(() => Promise.resolve())
      .finally(() => {
        this.rollingFsBusy = false;
      });
  },

  /**
   * 高光等待超时或长期无新段时，尝试结束异常分段并重新拉起滚动录制（外录/磁盘慢场景）。
   * copy 进行中时延后执行，避免与相机分段并发冲突。
   *
   * @param {function(): void} [onDone] 恢复尝试结束后的回调
   * @param {number} [busyRetries] 内部参数：等待 rollingFsBusy 解除的重试次数
   * @returns {void}
   */
  recoverRollingPipelineForHighlight: function(onDone, busyRetries) {
    const maxBusyWait = 40;
    const n = typeof busyRetries === 'number' ? busyRetries : 0;
    if (this.rollingFsBusy && n < maxBusyWait) {
      setTimeout(() => {
        this.recoverRollingPipelineForHighlight(onDone, n + 1);
      }, 200);
      return;
    }
    /**
     * 高光超时只做「软恢复」：重置失败计数并 tryStart。
     * 禁止此处调用 stopRollingRecording→stopRecord：预览正常时中断分段录制极易整屏黑屏。
     * 会话级假死仍由 onShow 的 stopRollingRecording 收口。
     */
    this.startRecordFailStreak = 0;
    const kick = () => {
      this.tryStartRollingWhenCameraReady();
      if (typeof onDone === 'function') onDone();
    };
    if (wx.nextTick) wx.nextTick(kick);
    else setTimeout(kick, 0);
  },

  /**
   * 在滚动缓冲中选取 segNo 最大且严格大于 consumed 的条目。
   * copyFile 完成顺序可能与录制顺序不一致，不能仅用数组最后一项作为「最新段」。
   *
   * @param {number} consumed 已保存为高光的最大 segNo
   * @returns {{ path: string, segNo: number } | null}
   */
  pickBestRollingEntryAfterConsumed: function(consumed) {
    const minExclusive = typeof consumed === 'number' ? consumed : 0;
    let best = null;
    const buf = this.segmentBuffer || [];
    for (let i = 0; i < buf.length; i += 1) {
      const it = buf[i];
      if (!it || !it.path || typeof it.segNo !== 'number') continue;
      if (it.segNo <= minExclusive) continue;
      if (!best || it.segNo > best.segNo) best = it;
    }
    return best;
  },

  /**
   * 将指定 rolling 片段加入引用锁，防止异步固化期间被热层淘汰。
   * @param {string[]} paths
   * @returns {void}
   */
  retainRollingSegmentsByPaths: function(paths) {
    if (!Array.isArray(paths) || paths.length === 0) return;
    const rollingDir = this.getRollingDir();
    const buf = this.segmentBuffer || [];
    paths.forEach((p) => {
      if (!p || p.indexOf(rollingDir) !== 0) return;
      for (let i = 0; i < buf.length; i += 1) {
        const it = buf[i];
        if (!it || it.path !== p) continue;
        it.refCount = Math.max(0, Number(it.refCount || 0)) + 1;
        break;
      }
    });
  },

  /**
   * 释放 rolling 片段引用锁。
   * @param {string[]} paths
   * @returns {void}
   */
  releaseRollingSegmentsByPaths: function(paths) {
    if (!Array.isArray(paths) || paths.length === 0) return;
    const buf = this.segmentBuffer || [];
    paths.forEach((p) => {
      if (!p) return;
      for (let i = 0; i < buf.length; i += 1) {
        const it = buf[i];
        if (!it || it.path !== p) continue;
        it.refCount = Math.max(0, Number(it.refCount || 0) - 1);
        break;
      }
    });
  },

  /**
   * 是否允许执行高光实体固化（degraded/recovering/故障态时暂停重 IO）。
   * @returns {boolean}
   */
  canMaterializeHighlightNow: function() {
    if (this.data.isRecovering || this._needManualRelaunch) return false;
    if (this.data.pipelineHealth === 'warn') return false;
    return true;
  },

  /**
   * 清理过量高光实体，避免温层无限增长与沙盒爆满。
   * @param {string} matchId
   * @returns {void}
   */
  pruneHighlightStorageForMatch: function(matchId) {
    if (!matchId) return;
    const fs = wx.getFileSystemManager();
    const clipsMap = wx.getStorageSync('MIAOXIE_CLIPS') || {};
    const list = Array.isArray(clipsMap[matchId]) ? clipsMap[matchId] : [];
    const maxCount = this.highlightsMaxCount || 100;
    if (list.length <= maxCount) return;
    const removed = list.splice(maxCount);
    clipsMap[matchId] = list;
    wx.setStorageSync('MIAOXIE_CLIPS', clipsMap);
    removed.forEach((it) => {
      const segs = it && Array.isArray(it.segments) ? it.segments : [];
      segs.forEach((p) => {
        if (!p) return;
        try { fs.unlinkSync(p); } catch (e) {}
      });
    });
  },

  /**
   * 评估 Storage 水位并执行分级治理。
   * @returns {number}
   */
  evaluateStorageWatermark: function() {
    let ratio = 0;
    try {
      const info = wx.getStorageInfoSync();
      const current = Number(info && info.currentSize);
      const limit = Number(info && info.limitSize);
      if (Number.isFinite(current) && Number.isFinite(limit) && limit > 0) {
        ratio = current / limit;
      }
    } catch (e) {}
    let level = 0;
    if (ratio >= 0.95) level = 95;
    else if (ratio >= 0.85) level = 85;
    else if (ratio >= 0.7) level = 70;
    if (level !== this.storageWatermarkLevel) {
      this.storageWatermarkLevel = level;
      this.appendHealthLog('storage_watermark_change', { level, ratio: Number(ratio.toFixed(3)) });
    }
    // 95%：强制淘汰最旧高光实体，优先保直播
    if (level >= 95) {
      const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
      if (currentMatchId) this.pruneHighlightStorageForMatch(currentMatchId);
    }
    return level;
  },

  /**
   * 创建高光索引项（立即可回看，不依赖固化完成）。
   * @param {Record<string, unknown>} pending
   * @param {string[]} segments
   * @returns {Record<string, unknown>}
   */
  buildIndexedHighlightItem: function(pending, segments) {
    const replaySegment = segments[segments.length - 1] || segments[0] || '';
    const mc = this.data.matchConfig;
    const scoreA = mc && mc.teamA ? Number(mc.teamA.score || 0) : 0;
    const scoreB = mc && mc.teamB ? Number(mc.teamB.score || 0) : 0;
    const nameA = (mc && mc.teamA && mc.teamA.name) ? mc.teamA.name : 'A';
    const nameB = (mc && mc.teamB && mc.teamB.name) ? mc.teamB.name : 'B';
    const colorA = (mc && mc.teamA && mc.teamA.bgColor) ? mc.teamA.bgColor : '#E64340';
    const colorB = (mc && mc.teamB && mc.teamB.bgColor) ? mc.teamB.bgColor : '#10AEFF';
    return {
      id: pending.id,
      matchName: pending.matchName,
      matchId: pending.matchId,
      createdAt: pending.createdAt,
      timeText: this.formatTime(pending.createdAt),
      cover: pending.cover || this.data.defaultCover,
      segments: segments.slice(),
      replaySegment,
      replayInitialTimeSec: Number(pending.replayInitialTimeSec || 0),
      replayUseChain: !!pending.replayUseChain && segments.length >= 2,
      status: 'indexed',
      scoreA,
      scoreB,
      nameA,
      nameB,
      colorA,
      colorB
    };
  },

  /**
   * 入队一个高光固化任务并触发后台执行。
   * @param {Record<string, unknown>} task
   * @returns {void}
   */
  enqueueHighlightMaterializeTask: function(task) {
    this.highlightMaterializeQueue.push(task);
    this.processHighlightMaterializeQueue();
  },

  /**
   * 后台串行执行高光固化队列（带降级暂停与退避）。
   * @returns {void}
   */
  processHighlightMaterializeQueue: function() {
    if (this.highlightMaterializeRunning) return;
    if (!this.highlightMaterializeQueue.length) return;
    const watermark = this.evaluateStorageWatermark();
    if (!this.canMaterializeHighlightNow() || watermark >= 85) {
      setTimeout(() => this.processHighlightMaterializeQueue(), 1200);
      return;
    }
    const task = this.highlightMaterializeQueue.shift();
    if (!task) return;
    this.highlightMaterializeRunning = true;
    this.materializeHighlightTask(task)
      .catch(() => Promise.resolve())
      .finally(() => {
        this.highlightMaterializeRunning = false;
        let gap = 0;
        if (this.data.isRecording) gap = Math.max(gap, 650);
        if (!this.data.drawerMode) gap = Math.max(gap, 320);
        setTimeout(() => this.processHighlightMaterializeQueue(), gap);
      });
  },

  /**
   * 执行单个高光固化任务：拷贝到高光目录并更新索引状态。
   * @param {Record<string, unknown>} task
   * @returns {Promise<void>}
   */
  materializeHighlightTask: function(task) {
    const segments = Array.isArray(task.segments) ? task.segments.filter(Boolean) : [];
    if (!segments.length || !task.id) {
      return Promise.resolve();
    }
    const fs = wx.getFileSystemManager();
    const dir = this.getHighlightDir();
    const copyOne = (srcPath, idx) => new Promise((resolve) => {
      const filePath = `${dir}/${task.id}_${idx}.mp4`;
      if (fs.copyFile) {
        fs.copyFile({
          srcPath,
          destPath: filePath,
          success: () => resolve(filePath),
          fail: () => resolve('')
        });
        return;
      }
      fs.saveFile({
        tempFilePath: srcPath,
        filePath,
        success: (r) => resolve((r && r.savedFilePath) ? r.savedFilePath : filePath),
        fail: () => resolve('')
      });
    });
    return this.ensureHighlightDir()
      .then(() => Promise.all(segments.map((p, i) => copyOne(p, i))))
      .then((saved) => {
        const savedPaths = saved.filter(Boolean);
        const matchId = task.matchId || 'default';
        const clipsMap = wx.getStorageSync('MIAOXIE_CLIPS') || {};
        const list = Array.isArray(clipsMap[matchId]) ? clipsMap[matchId] : [];
        const idx = list.findIndex((it) => it && it.id === task.id);
        if (idx >= 0) {
          if (savedPaths.length > 0) {
            const replaySegment = savedPaths[savedPaths.length - 1] || savedPaths[0] || '';
            list[idx].segments = savedPaths;
            list[idx].replaySegment = replaySegment;
            list[idx].status = 'materialized';
          } else {
            list[idx].status = 'failed';
          }
          clipsMap[matchId] = list;
          wx.setStorageSync('MIAOXIE_CLIPS', clipsMap);
        }
        if (!savedPaths.length) {
          const retryCount = Number(task.retryCount || 0);
          if (retryCount < 3) {
            const next = { ...task, retryCount: retryCount + 1 };
            const delays = [300, 800, 1500, 3000];
            const delay = delays[next.retryCount] || 3000;
            setTimeout(() => {
              this.highlightMaterializeQueue.unshift(next);
              this.processHighlightMaterializeQueue();
            }, delay);
            return;
          }
        }
        this.releaseRollingSegmentsByPaths(segments);
      })
      .catch(() => {
        const retryCount = Number(task.retryCount || 0);
        if (retryCount < 3) {
          const next = { ...task, retryCount: retryCount + 1 };
          const delays = [300, 800, 1500, 3000];
          const delay = delays[next.retryCount] || 3000;
          setTimeout(() => {
            this.highlightMaterializeQueue.unshift(next);
            this.processHighlightMaterializeQueue();
          }, delay);
        } else {
          this.releaseRollingSegmentsByPaths(segments);
        }
        return Promise.resolve();
      });
  },

  /**
   * 取 rolling 缓冲中 segNo 最大的条目（忽略 consumed）。
   * iOS 保护模式下用于避免“必须新段”导致回退 stop 当前段。
   * @returns {{ path: string, segNo: number, recordStartMs?: number } | null}
   */
  pickLatestRollingEntry: function() {
    let best = null;
    const buf = this.segmentBuffer || [];
    for (let i = 0; i < buf.length; i += 1) {
      const it = buf[i];
      if (!it || !it.path || typeof it.segNo !== 'number') continue;
      if (!best || it.segNo > best.segNo) best = it;
    }
    return best;
  },

  /**
   * 保存高光：由右下角状态钮在管线为「录制中」（界面显示 REC）时单击触发。
   * 物理上复制最近完成的 rolling 段（时长约 {@link segmentDurationMs}），逻辑回放窗口见 {@link highlightPlaybackWindowMs}。
   * 不额外拍照封面，避免与录制并行增加相机压力与闪屏。
   */
  requestHighlightCapture: function() {
    if (this._highlightRequestLock || this.data.isSavingHighlight) {
      return;
    }
    if (this.data.isRecovering || this._recoveryLock || !this._cameraInitDone) {
      this.appendHealthLog('highlight_skip_camera_not_ready', {});
      return;
    }
    if (this.data.drawerMode > 0) {
      wx.showToast({ title: '请先关闭抽屉再保存高光', icon: 'none' });
      return;
    }
    if (this.data.isReplaying) {
      wx.showToast({ title: '回放中无法保存高光', icon: 'none' });
      return;
    }
    const now = Date.now();
    if (this.pendingHighlight) {
      return;
    }

    this.beginHighlightSaving();

    /** 再次尝试拉起滚动分段（补救 init 与 onShow 竞态；与 tryStart 内聚，不重复判断 isRecording 误杀） */
    this.tryStartRollingWhenCameraReady();

    /** 判定成功，立即触发震动反馈（不再显示视觉标记，避免被录屏） */
    this.vibrate('heavy');

    this.lastHighlightRequestAt = now;
    const matchName = this.data.matchConfig.matchName || '未命名比赛';
    const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    const id = `${now}`;
    const startSegNo = this.segmentCounter;
    const consumed = this.lastHighlightConsumedSegNo || 0;
    const freshEntry = this.pickBestRollingEntryAfterConsumed(consumed);

    if (this.data.isRecording) {
      const sessionId = this.rollingSessionId;
      const minStopMs = Math.max(this.minRecordMsBeforeHighlightStop || 1300, 1800);
      const recStartMs = this._currentRollingSegmentRecordStartMs || 0;
      const elapsedMs = recStartMs > 0 ? (now - recStartMs) : 0;
      this._highlightSaveAwaitingResume = true;
      this._highlightPipelineDoneFinalize = false;
      this._highlightPipelineDoneResume = false;
      this._highlightSaveSessionId = sessionId;
      this._highlightAfterStopMeta = {
        expectedSegNo: this.segmentCounter + 1,
        recordSessionId: sessionId,
        id,
        createdAt: now,
        startSegNo,
        matchName,
        matchId: currentMatchId,
        cover: this.data.defaultCover,
        clickWallMs: now
      };
      const resumeGuardMs = Math.max(12000, Math.floor(this.segmentDurationMs * 1.3));
      this._highlightResumeGuardTimer = setTimeout(() => {
        if (!this._highlightSaveAwaitingResume) return;
        this.appendHealthLog('highlight_resume_guard_timeout', {});
        this.clearHighlightSavePipelineState();
        this.endHighlightSaving();
        this.recoverRollingPipelineForHighlight();
      }, resumeGuardMs);
      try {
        if (this.segmentStopTimer) {
          clearTimeout(this.segmentStopTimer);
          this.segmentStopTimer = null;
        }
        if (this._highlightDeferredStopTimer) {
          clearTimeout(this._highlightDeferredStopTimer);
          this._highlightDeferredStopTimer = null;
        }
        this.appendHealthLog('highlight_stop_on_click', { segNo: this.segmentCounter + 1 });
        if (elapsedMs > 0 && elapsedMs < minStopMs) {
          const waitMs = Math.max(0, minStopMs - elapsedMs);
          this.appendHealthLog('highlight_stop_deferred', { waitMs, elapsedMs });
          this._highlightDeferredStopTimer = setTimeout(() => {
            this._highlightDeferredStopTimer = null;
            if (!this._highlightSaveAwaitingResume) return;
            this.stopOneSegment(sessionId);
          }, waitMs);
        } else {
          this.stopOneSegment(sessionId);
        }
        return;
      } catch (e) {
        this.abortHighlightAfterStopIfNeeded(sessionId, 'stop_throw');
        return;
      }
    }

    if (freshEntry && freshEntry.path) {
      this.finalizeHighlight({
        id,
        createdAt: now,
        startSegNo,
        matchName,
        matchId: currentMatchId,
        cover: this.data.defaultCover,
        finalizing: false,
        sourceSegNo: freshEntry.segNo,
        preSegments: [freshEntry.path],
        postSegments: [],
        replayInitialTimeSec: 0,
        replayUseChain: false
      });
      return;
    }
    this.endHighlightSaving();
    this.appendHealthLog('highlight_skip_not_recording_no_fresh', {});
  },

  finalizeHighlight: function(pending) {
    if (!pending || pending.finalizing) return;
    pending.finalizing = true;
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }
    const segments = [...pending.preSegments, ...pending.postSegments].filter(Boolean);
    if (segments.length === 0) {
      this.appendHealthLog('highlight_finalize_no_segments', {});
      if (this._highlightSaveAwaitingResume) {
        this._highlightPipelineDoneFinalize = true;
        this.maybeReleaseHighlightSaveLock();
      } else {
        this.endHighlightSaving();
      }
      return;
    }
    const matchId = pending.matchId || 'default';
    const item = this.buildIndexedHighlightItem(pending, segments);
    const clipsMap = wx.getStorageSync('MIAOXIE_CLIPS') || {};
    if (!clipsMap[matchId]) clipsMap[matchId] = [];
    clipsMap[matchId].unshift(item);
    wx.setStorageSync('MIAOXIE_CLIPS', clipsMap);
    this.pruneHighlightStorageForMatch(matchId);
    const list = this.getHighlightList();
    list.unshift(item);
    wx.setStorageSync('highlight_list', list);
    this.retainRollingSegmentsByPaths(segments);
    this.enqueueHighlightMaterializeTask({
      id: pending.id,
      matchId,
      segments: segments.slice(),
      retryCount: 0
    });
    this.highlightMissStreak = 0;
    if (typeof pending.sourceSegNo === 'number' && pending.sourceSegNo > 0) {
      this.lastHighlightConsumedSegNo = Math.max(
        this.lastHighlightConsumedSegNo || 0,
        pending.sourceSegNo
      );
    }
    this.vibrateHighlightSaved();
    this.flashPeriod();
    if (this.data.drawerMode === 1) {
      this.refreshDrawerHighlights();
    }
    if (this._highlightSaveAwaitingResume) {
      this._highlightPipelineDoneFinalize = true;
      this.maybeReleaseHighlightSaveLock();
    } else {
      this.endHighlightSaving();
    }
  },

  formatTime: function(ts) {
    const d = new Date(ts);
    const pad = (n) => `${n}`.padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  },

  getHighlightList: function(matchId) {
    if (matchId) {
      const clipsMap = wx.getStorageSync('MIAOXIE_CLIPS') || {};
      return Array.isArray(clipsMap[matchId]) ? clipsMap[matchId] : [];
    }
    const raw = wx.getStorageSync('highlight_list');
    return Array.isArray(raw) ? raw : [];
  },

  onBackgroundLongPress: function() {
    if (this.isMultiTouch) return;
    this.openDrawerMode1();
  },

  dismissGuide: function() {
    this.setData({ showGuide: false });
    wx.setStorageSync('hasReadGuide', true);
  },

  /**
   * 打开抽屉（mode 1）：左侧比赛列表 + 右侧高光缩略图
   */
  openDrawerMode1: function() {
    this.refreshDrawerHighlights();
    this.loadMatchList();
    this.setData({ drawerMode: 1 });
  },

  /**
   * 关闭所有抽屉，回到 mode 0
   */
  closeAllDrawers: function() {
    if (this.data.drawerMode !== 0) {
      this.setData({ drawerMode: 0 });
    }
  },

  /** 向后兼容：内部调用 closeDrawer 的地方统一走 closeAllDrawers */
  closeDrawer: function() {
    this.closeAllDrawers();
  },

  stopDrawerBubbling: function() { return; },
  stopLeftDrawerBubbling: function() { return; },

  onDrawerBackdropMove: function(e) {
    const touch = (e.touches && e.touches[0]) ? e.touches[0] : null;
    if (!touch) return;
    const sys = wx.getSystemInfoSync();
    const w = sys.windowWidth || 375;
    if (touch.pageX < 16 || touch.pageX > w - 16) {
      this.closeAllDrawers();
    }
  },

  /**
   * 从 MIAOXIE_MATCHES 加载完整比赛列表，标记当前场次
   */
  loadMatchList: function() {
    const currentMatchId =
      wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    const matches = Array.isArray(raw) ? raw : [];
    const matchList = matches.map((m) => ({ ...m, isCurrent: m.id === currentMatchId }));
    this.setData({ matchList, matchCount: matchList.length });
  },

  /**
   * 点击比赛卡片：关闭抽屉，弹出颜色设置浮层
   * @param {WechatMiniprogram.TouchEvent} e data-id
   */
  openColorModal: function(e) {
    const { id } = e.currentTarget.dataset;
    const match = this.data.matchList.find((m) => m.id === id);
    if (!match) return;
    const cloned = JSON.parse(JSON.stringify(match));
    ['teamA', 'teamB'].forEach((t) => {
      if (cloned[t] && typeof cloned[t].bgColor === 'string') {
        cloned[t].bgColor = cloned[t].bgColor.toUpperCase();
      }
    });
    this.setData({
      drawerMode: 0,
      showColorModal: true,
      colorModalMatch: cloned,
      colorModalTeam: 'teamA'
    });
  },

  /**
   * 关闭颜色设置浮层
   */
  closeColorModal: function() {
    this.setData({ showColorModal: false, colorModalMatch: null });
  },

  /** 阻止颜色浮层内部点击冒泡到遮罩关闭 */
  stopColorModalBubbling: function() { return; },

  /**
   * 浮层中选中队伍名，切换共用色盘指向
   * @param {WechatMiniprogram.TouchEvent} e data-team
   */
  onSelectModalTeam: function(e) {
    const { team } = e.currentTarget.dataset;
    if (team === 'teamA' || team === 'teamB') {
      this.setData({ colorModalTeam: team });
    }
  },

  /**
   * 从颜色浮层切换场次：更新 currentMatchId 并关闭浮层
   */
  onSwitchMatchFromModal: function() {
    const modal = this.data.colorModalMatch;
    if (!modal || !modal.id) return;
    
    // 如果已经是当前场次，点击应关闭浮层
    if (modal.isCurrent) {
      this.closeColorModal();
      return;
    }

    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    if (!Array.isArray(raw)) return;
    const idx = raw.findIndex((m) => m.id === modal.id);
    if (idx < 0) return;
    const found = raw[idx];
    if (!found.teamA || !found.teamA.name || !found.teamB || !found.teamB.name) {
      wx.showToast({ title: '该比赛队名不完整', icon: 'none' });
      return;
    }
    /** 将浮层内最新颜色写回 Storage，再切换场次 */
    raw[idx].teamA = { ...found.teamA, ...modal.teamA };
    raw[idx].teamB = { ...found.teamB, ...modal.teamB };
    wx.setStorageSync('MIAOXIE_MATCHES', raw);
    const merged = raw[idx];
    wx.setStorageSync('currentMatchId', modal.id);
    app.globalData.currentMatchId = modal.id;
    const normalizedConfig = this.normalizeMatchConfig(merged);
    app.globalData.matchConfig = normalizedConfig;
    wx.setStorageSync('matchConfig', normalizedConfig);
    this.setData({ matchConfig: normalizedConfig });
    this.updateTeamGroupWidth(true);
    this.closeColorModal();
    this.loadMatchList();
    this.refreshDrawerHighlights(); // 切换后立即刷新高光列表
    this.vibrate('medium');
    wx.showToast({ title: '已切换', icon: 'success', duration: 800 });
  },

  /**
   * 修改某场比赛的队服颜色球（点击色球直接生效）
   * @param {WechatMiniprogram.TouchEvent} e data-match-id / data-team / data-color
   */
  onChangeTeamColor: function(e) {
    const { color } = e.currentTarget.dataset;
    const modal = this.data.colorModalMatch;
    if (!modal) return;
    const matchId = modal.id;
    const team = this.data.colorModalTeam;

    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    if (!Array.isArray(raw)) return;
    const idx = raw.findIndex((m) => m.id === matchId);
    if (idx < 0) return;

    const colorUpper = (color || '').toUpperCase();
    const textColor = this.getContrastColor(colorUpper);
    raw[idx][team] = {
      ...raw[idx][team],
      bgColor: colorUpper,
      textColor: textColor
    };
    wx.setStorageSync('MIAOXIE_MATCHES', raw);

    const currentMatchId =
      wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    if (matchId === currentMatchId) {
      const updated = this.normalizeMatchConfig(raw[idx]);
      this.setData({ matchConfig: updated });
      this.updateTeamGroupWidth(true);
      app.globalData.matchConfig = updated;
      wx.setStorageSync('matchConfig', updated);
    }

    const updatedModal = JSON.parse(JSON.stringify(modal));
    updatedModal[team] = {
      ...updatedModal[team],
      bgColor: colorUpper,
      textColor: textColor
    };
    this.setData({ colorModalMatch: updatedModal });

    this.loadMatchList();
  },

  /**
   * 切换到指定场次，加载数据并关闭抽屉
   * @param {WechatMiniprogram.TouchEvent} e data-id
   */
  onSwitchMatch: function(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    if (!Array.isArray(raw)) return;
    const match = raw.find((m) => m.id === id);
    if (!match) return;

    if (!match.teamA.name || !match.teamB.name) {
      wx.showToast({ title: '该比赛队名不完整', icon: 'none' });
      return;
    }

    wx.setStorageSync('currentMatchId', id);
    app.globalData.currentMatchId = id;
    const normalizedConfig = this.normalizeMatchConfig(match);
    app.globalData.matchConfig = normalizedConfig;
    wx.setStorageSync('matchConfig', normalizedConfig);
    this.setData({ matchConfig: normalizedConfig });
    this.updateTeamGroupWidth(true);
    this.closeAllDrawers();
    this.refreshDrawerHighlights(); // 切换后立即刷新高光列表
    this.vibrate('medium');
    wx.showToast({ title: '已切换', icon: 'success', duration: 800 });
  },

  refreshDrawerHighlights: function() {
    const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    const fullList = this.getHighlightList(currentMatchId);
    const total = fullList.length;
    const list = fullList.slice(0, 50);
    const dc = this.data.defaultCover;
    const drawerHighlights = list.map((it, idx) => {
      const rawCover = it && it.cover ? it.cover : '';
      const hasRealCover = !!(rawCover && rawCover !== dc);
      const thumbSrc = hasRealCover ? rawCover : '';
      return {
        id: it.id,
        cover: rawCover || dc,
        thumbSrc,
        hasRealCover,
        replayInitialTimeSec: typeof it.replayInitialTimeSec === 'number' ? it.replayInitialTimeSec : 0,
        needsCover: (!rawCover || rawCover === dc),
        timeText: it.timeText || '',
        scoreA: typeof it.scoreA === 'number' ? it.scoreA : 0,
        scoreB: typeof it.scoreB === 'number' ? it.scoreB : 0,
        nameA: it.nameA || 'A',
        nameB: it.nameB || 'B',
        colorA: it.colorA || '#E64340',
        colorB: it.colorB || '#10AEFF',
        clipIndex: total - idx
      };
    });
    this.setData({ drawerHighlights, highlightCount: total });
  },

  onDrawerImageError: function(e) {
    const { id } = e.currentTarget.dataset;
    const dc = this.data.defaultCover;
    const updated = (this.data.drawerHighlights || []).map((it) => {
      if (it.id === id) {
        return { ...it, cover: dc, thumbSrc: dc };
      }
      return it;
    });
    this.setData({ drawerHighlights: updated });
  },

  onDrawerSelect: function(e) {
    const { id } = e.currentTarget.dataset;
    const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    const list = this.getHighlightList(currentMatchId);
    const item = list.find((x) => x.id === id);
    if (!item) return;
    this.closeAllDrawers();
    this.startReplay(item);
  },

  /**
   * 长按删除高光
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onDeleteHighlight: function(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除高光',
      content: '确定要永久删除这段高光视频吗？',
      confirmColor: '#E64340',
      success: (res) => {
        if (res.confirm) {
          this.doDeleteHighlight(id);
        }
      }
    });
  },

  /** 真正执行删除逻辑（双端一致） */
  doDeleteHighlight: function(id) {
    const fs = wx.getFileSystemManager();
    
    // 1. 处理 MIAOXIE_CLIPS
    const clipsMap = wx.getStorageSync('MIAOXIE_CLIPS') || {};
    let foundInClips = false;
    for (const matchId in clipsMap) {
      const idx = clipsMap[matchId].findIndex(x => x.id === id);
      if (idx >= 0) {
        const item = clipsMap[matchId][idx];
        (item.segments || []).forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
        clipsMap[matchId].splice(idx, 1);
        foundInClips = true;
        break;
      }
    }
    if (foundInClips) {
      wx.setStorageSync('MIAOXIE_CLIPS', clipsMap);
    }

    // 2. 处理 legacy highlight_list
    const legacyList = wx.getStorageSync('highlight_list') || [];
    const legacyIdx = legacyList.findIndex(x => x.id === id);
    if (legacyIdx >= 0) {
      const item = legacyList[legacyIdx];
      (item.segments || []).forEach(p => { try { fs.unlinkSync(p); } catch (e) {} });
      legacyList.splice(legacyIdx, 1);
      wx.setStorageSync('highlight_list', legacyList);
    }

    wx.showToast({ title: '已删除', icon: 'success' });
    this.refreshDrawerHighlights();
  },

  /**
   * 进入回放前暂停滚动录制，降低 iOS 下 camera 与 video 并行造成的录制失败概率。
   * @returns {void}
   */
  pauseRollingForReplay: function() {
    if (this._rollingPausedForReplay) return;
    if (this.data.isSavingHighlight) {
      this.appendHealthLog('replay_pause_cancel_highlight_saving', {});
      this.clearHighlightSavePipelineState();
      this.endHighlightSaving();
    }
    this._rollingPausedForReplay = true;
    this.appendHealthLog('replay_pause_rolling', {});
    this.rollingActive = false;
    this.rollingSessionId += 1;
    this.stopRollingRecording(() => {
      this.setData({ isRecording: false });
    });
  },

  /**
   * 退出回放后恢复滚动录制；仅在相机可用且非恢复流程中重启。
   * @returns {void}
   */
  resumeRollingAfterReplay: function() {
    if (!this._rollingPausedForReplay) return;
    this._rollingPausedForReplay = false;
    if (!this.data.liveStreamAllowed || this.data.isRecovering || this._recoveryLock) return;
    if (!this.data.cameraMounted || !this.data.cameraContext || !this._cameraInitDone) {
      if (Date.now() < (this._insertCameraRecoverCooldownUntil || 0)) {
        this.appendHealthLog('replay_resume_wait_insert_cooldown', {});
        return;
      }
      this.appendHealthLog('replay_resume_need_recover', {});
      this.hardRecoverLivePipeline('auto:resume_after_replay');
      return;
    }
    this.appendHealthLog('replay_resume_rolling', {});
    this.rollingActive = true;
    this.rollingSessionId += 1;
    this.startRecordFailStreak = 0;
    this.tryStartRollingWhenCameraReady();
  },

  /**
   * 启动回放，采用双 slot 预加载方案消除链式切换时的黑帧。
   * - slot-a 播放第一段（或单段）；slot-b 同步预加载第二段（如有）。
   * - 切换时只改 replayActiveSlot，两个 video 组件始终在 DOM 中，不触发重新加载。
   * @param {object} item 高光条目
   */
  startReplay: function(item) {
    this._replayPendingActiveSlot = null;
    if (this._replayStartTimer) {
      clearTimeout(this._replayStartTimer);
      this._replayStartTimer = null;
    }
    if (this._replayMaskHideTimer) {
      clearTimeout(this._replayMaskHideTimer);
      this._replayMaskHideTimer = null;
    }
    if (this._replayOutroTimer) {
      clearTimeout(this._replayOutroTimer);
      this._replayOutroTimer = null;
    }
    if (this._replayPendingFallbackTimer) {
      clearTimeout(this._replayPendingFallbackTimer);
      this._replayPendingFallbackTimer = null;
    }
    if (this._replayPrimeTimerA) {
      clearTimeout(this._replayPrimeTimerA);
      this._replayPrimeTimerA = null;
    }
    if (this._replayPrimeTimerB) {
      clearTimeout(this._replayPrimeTimerB);
      this._replayPrimeTimerB = null;
    }
    this._replayPrimedSlot0 = false;
    this._replayPrimedSlot1 = false;
    const useChain = !!(item && item.replayUseChain && item.segments && item.segments.length >= 2);
    const paths = useChain ? item.segments.slice() : [];
    const target =
      (item && item.replaySegment)
      || ((item && Array.isArray(item.segments) && item.segments[item.segments.length - 1])
        ? item.segments[item.segments.length - 1]
        : '');
    if (!target) return;
    this.pauseRollingForReplay();

    const fs = wx.getFileSystemManager();
    const toCheck = useChain ? paths : [target];
    for (let i = 0; i < toCheck.length; i += 1) {
      try {
        fs.accessSync(toCheck[i]);
      } catch (e) {
        wx.showModal({
          title: '文件已移除',
          content: '该视频文件已不存在，系统将自动清理无效记录。',
          showCancel: false,
          success: () => {
            this.doDeleteHighlight(item.id);
          }
        });
        return;
      }
    }

    if (wx.setPageOrientation) {
      wx.setPageOrientation({ orientation: 'landscape' });
    }

    const introMs = 1000;
    const peakMs = 350;
    const initialSec = typeof item.replayInitialTimeSec === 'number' ? item.replayInitialTimeSec : 0;

    /** 第一段路径与第二段路径（链式时预加载，单段为空） */
    const firstPath = useChain ? paths[0] : target;
    const secondPath = useChain && paths.length >= 2 ? paths[1] : '';

    this.setData({
      showReplayMask: true,
      replayMaskText: 'REPLAY',
      replayMaskKind: 'replay',
      replayQueue: [],
      replayIndex: 0,
      replaySrc: '',
      replayVideoNeedRotate: false,
      replayVideoRotateDeg: 90,
      replayMuted: true,
      replayViewScale: 1,
      replayViewX: 0,
      replayViewY: 0,
      replayInitialTime: 0,
      replayHighlightChain: false,
      replayHighlightPaths: paths,
      replayHighlightIndex: 0,
      replayActiveSlot: 0,
      replaySlotASrc: '',
      replaySlotAInitialTime: 0,
      replaySlotBSrc: '',
      replaySlotBInitialTime: 0
    });

    this._replayStartTimer = setTimeout(() => {
      this._replayStartTimer = null;
      this.setData({
        isReplaying: true,
        replayHighlightChain: useChain,
        replayHighlightPaths: paths,
        replayHighlightIndex: 0,
        replayActiveSlot: 0,
        replaySlotASrc: firstPath,
        replaySlotAInitialTime: initialSec,
        replaySlotBSrc: secondPath,
        replaySlotBInitialTime: 0
      }, () => {
        wx.nextTick(() => {
          try {
            const ctx = wx.createVideoContext('replayVideoA', this);
            if (ctx && ctx.play) ctx.play();
          } catch (e) {}
        });
      });
    }, peakMs);

    this._replayMaskHideTimer = setTimeout(() => {
      this._replayMaskHideTimer = null;
      this.setData({ showReplayMask: false });
    }, introMs);
  },

  /**
   * 获取当前活跃 slot 对应的 VideoContext id。
   * @returns {string} 'replayVideoA' | 'replayVideoB'
   */
  _activeReplayVideoId: function() {
    return this.data.replayActiveSlot === 1 ? 'replayVideoB' : 'replayVideoA';
  },

  /**
   * 结束回放并播放回到直播的转场（正常播完或用户点击中断）。
   * @param {boolean} stopPlayer 是否立即停止 video（点击中断时为 true）
   */
  finishReplayToLive: function(stopPlayer) {
    this._replayPendingActiveSlot = null;
    if (this._replayStartTimer) {
      clearTimeout(this._replayStartTimer);
      this._replayStartTimer = null;
    }
    if (this._replayMaskHideTimer) {
      clearTimeout(this._replayMaskHideTimer);
      this._replayMaskHideTimer = null;
    }
    if (this._replayOutroTimer) {
      clearTimeout(this._replayOutroTimer);
      this._replayOutroTimer = null;
    }
    if (this._replayPendingFallbackTimer) {
      clearTimeout(this._replayPendingFallbackTimer);
      this._replayPendingFallbackTimer = null;
    }
    if (this._replayPrimeTimerA) {
      clearTimeout(this._replayPrimeTimerA);
      this._replayPrimeTimerA = null;
    }
    if (this._replayPrimeTimerB) {
      clearTimeout(this._replayPrimeTimerB);
      this._replayPrimeTimerB = null;
    }
    this._replayPrimedSlot0 = false;
    this._replayPrimedSlot1 = false;
    if (stopPlayer) {
      try {
        ['replayVideoA', 'replayVideoB'].forEach((vid) => {
          const ctx = wx.createVideoContext(vid, this);
          if (ctx && ctx.stop) ctx.stop();
        });
      } catch (e) {}
    }
    const outroMs = this.data.replayOutroDurationMs || 720;
    this.setData({
      isReplaying: false,
      replaySrc: '',
      replayQueue: [],
      replayIndex: 0,
      replayMuted: false,
      replayViewScale: 1,
      replayViewX: 0,
      replayViewY: 0,
      replayInitialTime: 0,
      replayHighlightChain: false,
      replayHighlightPaths: [],
      replayHighlightIndex: 0,
      replayActiveSlot: 0,
      replaySlotASrc: '',
      replaySlotAInitialTime: 0,
      replaySlotBSrc: '',
      replaySlotBInitialTime: 0,
      showReplayMask: true,
      replayMaskText: 'LIVE',
      replayMaskKind: 'live'
    });
    this._replayOutroTimer = setTimeout(() => {
      this._replayOutroTimer = null;
      this.setData({ showReplayMask: false, replayMaskText: 'REPLAY', replayMaskKind: 'replay' });
      this.resumeRollingAfterReplay();
    }, outroMs);
  },

  /**
   * 活跃 slot 播放结束：链式时切换到预加载好的另一 slot，无需重新加载。
   * 仅在活跃 slot 的 bindended 中调用（通过 data-slot 区分）。
   * @param {number} slotIdx 触发事件的 slot（0=A, 1=B）
   */
  onReplaySlotEnded: function(slotIdx) {
    if (slotIdx !== this.data.replayActiveSlot) return;
    if (!this.data.replayHighlightChain) {
      this.finishReplayToLive(false);
      return;
    }
    const paths = this.data.replayHighlightPaths || [];
    const currentIdx = this.data.replayHighlightIndex || 0;
    const nextIdx = currentIdx + 1;
    if (nextIdx >= paths.length) {
      this.setData({ replayHighlightChain: false });
      this.finishReplayToLive(false);
      return;
    }
    /** 切换 slot：另一个 slot 已在 src 写入阶段完成预加载，直接翻到最前 */
    const nextSlot = slotIdx === 0 ? 1 : 0;
    const nextNextPath = paths[nextIdx + 1] || '';
    const updates = { replayHighlightIndex: nextIdx };
    /** 仅在有下一段时才改「旧槽」src，避免与切层同一帧把 src 置空导致闪一下 */
    if (nextNextPath) {
      if (slotIdx === 0) {
        updates.replaySlotASrc = nextNextPath;
        updates.replaySlotAInitialTime = 0;
      } else {
        updates.replaySlotBSrc = nextNextPath;
        updates.replaySlotBInitialTime = 0;
      }
      this._replayPrimedSlot0 = false;
      this._replayPrimedSlot1 = false;
    }
    this._replayPendingActiveSlot = nextSlot;
    if (this._replayPendingFallbackTimer) {
      clearTimeout(this._replayPendingFallbackTimer);
      this._replayPendingFallbackTimer = null;
    }
    this.setData(updates, () => {
      const nextId = nextSlot === 0 ? 'replayVideoA' : 'replayVideoB';
      wx.nextTick(() => {
        try {
          const ctx = wx.createVideoContext(nextId, this);
          const rate = this.data.replayPlaybackRate || 0.75;
          if (ctx && ctx.seek) ctx.seek(0);
          if (ctx && ctx.play) ctx.play();
          if (ctx && ctx.playbackRate) ctx.playbackRate(rate);
        } catch (e) {}
      });
      this._replayPendingFallbackTimer = setTimeout(() => {
        if (this._replayPendingActiveSlot !== nextSlot) return;
        this._replayPendingActiveSlot = null;
        this._replayPendingFallbackTimer = null;
        this.setData({ replayActiveSlot: nextSlot });
        try {
          const oldId = slotIdx === 0 ? 'replayVideoA' : 'replayVideoB';
          const oldCtx = wx.createVideoContext(oldId, this);
          if (oldCtx && oldCtx.pause) oldCtx.pause();
        } catch (e2) {}
      }, 420);
    });
  },

  /**
   * 链式回放：在后台 slot 上做一次轻量 play→pause→seek(0)，促使解码器先出首帧，切换时少黑场。
   * @param {number} slotIdx 0=A, 1=B
   * @returns {void}
   */
  _maybePrimeHiddenChainSlot: function(slotIdx) {
    if (!this.data.isReplaying || !this.data.replayHighlightChain) return;
    const active = this.data.replayActiveSlot;
    const src = slotIdx === 0 ? this.data.replaySlotASrc : this.data.replaySlotBSrc;
    if (!src || active === slotIdx) return;
    if (slotIdx === 0 && this._replayPrimedSlot0) return;
    if (slotIdx === 1 && this._replayPrimedSlot1) return;
    if (slotIdx === 0) this._replayPrimedSlot0 = true;
    else this._replayPrimedSlot1 = true;
    const id = slotIdx === 0 ? 'replayVideoA' : 'replayVideoB';
    wx.nextTick(() => {
      try {
        const ctx = wx.createVideoContext(id, this);
        if (ctx && ctx.play) ctx.play();
        const key = slotIdx === 0 ? '_replayPrimeTimerA' : '_replayPrimeTimerB';
        if (this[key]) {
          clearTimeout(this[key]);
          this[key] = null;
        }
        this[key] = setTimeout(() => {
          this[key] = null;
          try {
            const c2 = wx.createVideoContext(id, this);
            if (c2 && c2.pause) c2.pause();
            if (c2 && c2.seek) c2.seek(0);
          } catch (e2) {}
        }, 120);
      } catch (e) {}
    });
  },

  /**
   * 待置顶 slot 已推进到可显示时间后，再切换 z-index 并暂停旧槽，避免与解码空窗重叠。
   * @param {number} slotIdx 触发 timeupdate 的 slot
   * @param {WechatMiniprogram.CustomEvent} e
   * @returns {void}
   */
  _onReplaySlotTimeUpdate: function(slotIdx, e) {
    if (this._replayPendingActiveSlot !== slotIdx) return;
    const t = e && e.detail && typeof e.detail.currentTime === 'number' ? e.detail.currentTime : 0;
    if (t < 0.05) return;
    this._replayPendingActiveSlot = null;
    if (this._replayPendingFallbackTimer) {
      clearTimeout(this._replayPendingFallbackTimer);
      this._replayPendingFallbackTimer = null;
    }
    const oldSlot = slotIdx === 0 ? 1 : 0;
    this.setData({ replayActiveSlot: slotIdx }, () => {
      try {
        const oldId = oldSlot === 0 ? 'replayVideoA' : 'replayVideoB';
        const oldCtx = wx.createVideoContext(oldId, this);
        if (oldCtx && oldCtx.pause) oldCtx.pause();
      } catch (err) {}
      try {
        const ctx = wx.createVideoContext(slotIdx === 0 ? 'replayVideoA' : 'replayVideoB', this);
        const rate = this.data.replayPlaybackRate || 0.75;
        if (ctx && ctx.playbackRate) ctx.playbackRate(rate);
      } catch (err2) {}
    });
  },

  /**
   * slot-a timeupdate：用于链式切换后待置顶确认。
   * @param {WechatMiniprogram.CustomEvent} e
   */
  onReplayVideoATimeUpdate: function(e) {
    this._onReplaySlotTimeUpdate(0, e);
  },

  /**
   * slot-b timeupdate：用于链式切换后待置顶确认。
   * @param {WechatMiniprogram.CustomEvent} e
   */
  onReplayVideoBTimeUpdate: function(e) {
    this._onReplaySlotTimeUpdate(1, e);
  },

  /**
   * slot-a 的 bindended 回调。
   */
  onReplayVideoAEnded: function() {
    this.onReplaySlotEnded(0);
  },

  /**
   * slot-b 的 bindended 回调。
   */
  onReplayVideoBEnded: function() {
    this.onReplaySlotEnded(1);
  },

  /**
   * 兼容旧 WXML bindended="onReplayEnded"（单 video 模式下仍可调用）。
   */
  onReplayEnded: function() {
    this.onReplaySlotEnded(this.data.replayActiveSlot);
  },

  /**
   * 回放中点击屏幕：中断播放并进入直播转场。
   */
  onReplayInterruptTap: function() {
    if (!this.data.isReplaying) return;
    this.finishReplayToLive(true);
  },

  /**
   * 仅对活跃 slot 生效：设置回放倍速。
   * @param {number} slotIdx 触发事件的 slot（0=A, 1=B）
   */
  _applyPlaybackRateToSlot: function(slotIdx) {
    const active = this.data.replayActiveSlot;
    const pending = this._replayPendingActiveSlot;
    if (slotIdx !== active && slotIdx !== pending) return;
    const rate = this.data.replayPlaybackRate || 0.75;
    try {
      const id = slotIdx === 0 ? 'replayVideoA' : 'replayVideoB';
      const ctx = wx.createVideoContext(id, this);
      if (ctx && ctx.playbackRate) ctx.playbackRate(rate);
    } catch (e) {}
  },

  /**
   * slot-a bindplay 回调：设置倍速。
   */
  onReplayVideoAPlay: function() {
    this._applyPlaybackRateToSlot(0);
  },

  /**
   * slot-b bindplay 回调：设置倍速。
   */
  onReplayVideoBPlay: function() {
    this._applyPlaybackRateToSlot(1);
  },

  /**
   * 兼容旧 WXML bindplay="onReplayVideoPlay"。
   */
  onReplayVideoPlay: function() {
    this._applyPlaybackRateToSlot(this.data.replayActiveSlot);
  },

  /**
   * 仅对活跃 slot 的 loadedmetadata 处理旋转检测。
   * @param {WechatMiniprogram.CustomEvent} e
   * @param {number} slotIdx 触发事件的 slot（0=A, 1=B）
   */
  _handleReplayLoadedMeta: function(e, slotIdx) {
    if (slotIdx !== this.data.replayActiveSlot) return;
    const detail = (e && e.detail) || {};
    const width = Number(detail.width || 0);
    const height = Number(detail.height || 0);
    const needRotate = width > 0 && height > 0 && height > width;
    const rotateDeg = needRotate ? this.getReplayRotateDegForDevice() : 90;
    this.setData({ replayVideoNeedRotate: needRotate, replayVideoRotateDeg: rotateDeg });
    this._applyPlaybackRateToSlot(slotIdx);
  },

  /**
   * slot-a bindloadedmetadata 回调。
   * @param {WechatMiniprogram.CustomEvent} e
   */
  onReplayVideoALoadedMeta: function(e) {
    this._maybePrimeHiddenChainSlot(0);
    this._handleReplayLoadedMeta(e, 0);
  },

  /**
   * slot-b bindloadedmetadata 回调。
   * @param {WechatMiniprogram.CustomEvent} e
   */
  onReplayVideoBLoadedMeta: function(e) {
    this._maybePrimeHiddenChainSlot(1);
    this._handleReplayLoadedMeta(e, 1);
  },

  /**
   * 兼容旧 WXML bindloadedmetadata="onReplayVideoLoadedMeta"。
   * @param {WechatMiniprogram.CustomEvent} e
   */
  onReplayVideoLoadedMeta: function(e) {
    this._handleReplayLoadedMeta(e, this.data.replayActiveSlot);
  },

  /**
   * 根据设备品牌选择回放旋转方向。
   * 仅对小米系设备做反向旋转修正，避免影响 iPhone 与其他安卓机型。
   * @returns {number} 90 或 -90
   */
  getReplayRotateDegForDevice: function() {
    try {
      const sys = wx.getSystemInfoSync();
      const brand = String((sys && sys.brand) || '').toLowerCase();
      const model = String((sys && sys.model) || '').toLowerCase();
      const isXiaomi =
        brand.indexOf('xiaomi') >= 0
        || brand.indexOf('redmi') >= 0
        || model.indexOf('xiaomi') >= 0
        || model.indexOf('redmi') >= 0;
      return isXiaomi ? -90 : 90;
    } catch (err) {
      return 90;
    }
  },

  /**
   * 切换回放倍速，立即通过 VideoContext 生效。
   * 慢速（0.5x / 0.75x）时自动静音，避免音频降频产生的变调恐怖感；
   * 恢复 1.0x 时自动解除静音。
   * @param {WechatMiniprogram.TouchEvent} e data-rate: 0.5 | 0.75 | 1.0
   */
  onReplaySpeedChange: function(e) {
    const rate = parseFloat(e.currentTarget.dataset.rate);
    if (!rate || isNaN(rate)) return;
    const muted = rate < 1.0;
    this.setData({ replayPlaybackRate: rate, replayMuted: muted });
    this._applyPlaybackRateToSlot(this.data.replayActiveSlot);
  },

  /**
   * 专用退出键：中断回放并进入直播转场。
   * @returns {void}
   */
  onReplayClose: function() {
    if (!this.data.isReplaying) return;
    this.finishReplayToLive(true);
  },

  /**
   * 一键重置 movable-view 的缩放与位置至初始状态（scale=1，x=0，y=0）。
   * @returns {void}
   */
  onReplayResetView: function() {
    this.setData({ replayViewScale: 1, replayViewX: 0, replayViewY: 0 });
  },

  /**
   * 监听 movable-view 缩放变化，同步 replayViewScale 以控制重置按钮显隐。
   * @param {WechatMiniprogram.CustomEvent} e detail.scale 当前缩放比例
   * @returns {void}
   */
  onReplayViewScale: function(e) {
    const scale = (e && e.detail && typeof e.detail.scale === 'number') ? e.detail.scale : 1;
    this.setData({ replayViewScale: scale });
  },

  flashPeriod: function() {
    this.setData({ periodFlash: true });
    setTimeout(() => this.setData({ periodFlash: false }), 160);
  },

  persistConfig: function() {
    const normalizedConfig = this.normalizeMatchConfig(this.data.matchConfig);
    this.setData({ matchConfig: normalizedConfig });
    wx.setStorageSync('matchConfig', normalizedConfig);
    app.globalData.matchConfig = normalizedConfig;

    // 将最新比分/节次实时回写到 MIAOXIE_MATCHES，保持首页数据同步
    const currentMatchId =
      wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    if (currentMatchId) {
      const matches = wx.getStorageSync('MIAOXIE_MATCHES');
      if (Array.isArray(matches)) {
        const idx = matches.findIndex((m) => m.id === currentMatchId);
        if (idx >= 0) {
          matches[idx] = {
            ...matches[idx],
            teamA: { ...matches[idx].teamA, score: normalizedConfig.teamA.score },
            teamB: { ...matches[idx].teamB, score: normalizedConfig.teamB.score },
            period: normalizedConfig.period
          };
          wx.setStorageSync('MIAOXIE_MATCHES', matches);
        }
      }
    }
  }
})
