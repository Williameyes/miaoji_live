const app = getApp();
const {
  get,
  getToken,
  post,
  STORAGE_USER_INFO_KEY
} = require('../../utils/request.js');
const {
  API_PATH_CLIENT_DIAGNOSTIC_LOG
} = require('../../config/api.js');
const {
  parseExpireAtToMs
} = require('../../utils/referral.js');
const storageEst = require('../../utils/file-storage-estimate.js');
const clipsStorage = require('../../utils/miaoxie-clips-storage.js');
const replayBufferMod = require('../../utils/replay-buffer/index.js');
const deviceRecordProfile = require('../../utils/device-record-profile.js');
/** 页面创建前锁定录制档位，避免 onLoad 再改 camera frame-size 导致 Android 黑屏。 */
const INITIAL_RECORD_PROFILE = deviceRecordProfile.getDeviceRecordProfile();
const LIVE_AUDIT = require('./audit.js');
const footballClockBehavior = require('./behaviors/footballClockBehavior.js');
const liveWsBehavior = require('./behaviors/liveWsBehavior.js');

/** 视录分离重构后保留空壳，避免遗留 VK/增强引用导致运行时错误。 */

const {
  checkSyncLabWhitelist
} = require('../../utils/sync-lab-whitelist.js');
const liveWsClientMod = require('../../services/live-ws-client.js');
const {
  loadPromoAds
} = require('../../services/promo-live.service.js');
const SHARE_IMAGE_URL = '/assets/images/global_share_card-1-288.png';
/**
 * @ai-live-index Live 页单文件分区速查（AI 开发必读）
 * ─────────────────────────────────────────────────────────
 * 本页约 1.3 万行，请勿通读。按用户症状在下表找到 @region，再 Grep 搜「@region XXX」跳到分区（行号为约数，以 Grep 为准）。
 * 用户只 @ 本文件时：先读本表 → Grep 定位分区 → 仅读该分区代码，勿通读全文件。
 *
 * | 症状/需求关键词 | 分区标记 | 约行号 | 说明 |
 * | 改超时/阈值/回放档位/足球计时常量 | @region LIVE_CONSTANTS | L~32 | 阈值常量、运动类型、布局纯函数 |
 * | 改 UI 默认值、data 字段、wxml 绑定初值 | @region LIVE_DATA | L~595 | Page data 初始状态 |
 * | 记分/syncMatchConfig/换场次/队名宽度 | @region LIVE_MATCH | L~938 | 场次配置、记分、节次 |
 * | 记分牌拖动/赛名浮层/角球布局 | @region LIVE_SCOREBOARD | L~1001 | 足球/羽毛球浮层记分牌与赛名条 |
 * | VIP 门/权益/liveStreamAllowed/黑屏门禁 | @region LIVE_ENTITLEMENT | L~1394 | VIP 权益、直播门禁、camera 准入 |
 * | audit/appendHealthLog/诊断上传 | @region LIVE_HEALTH | L~2058 | 健康日志、审计导出 |
 * | isSavingHighlight/保存锁/进度环 | @region LIVE_HIGHLIGHT_LOCK | L~2481 | 高光保存事务锁与进度动画 |
 * | 相机黑屏/横屏/布局/变焦/曝光/对焦/AE | @region LIVE_CAMERA | L~2705 | 相机、16:9 布局、曝光对焦、变焦机位 |
 * | 录制/REC 灯/segment/ping-pong/hardRecover | @region LIVE_RECORDING | L~5873 | 滚动录制、看门狗、硬恢复、乒乓缓冲 |
 * | 保存高光/trim/materialize/高光列表 | @region LIVE_HIGHLIGHT | L~8281 | 高光生成、裁剪、固化、存储淘汰 |
 * | 存储/severe/缓存灯/空间不足 | @region LIVE_STORAGE | L~4926 | 存储水位、缓存灯、空间弹窗 |
 * | 抽屉/推广/换场/颜色浮层 | @region LIVE_DRAWER | L~5424 | 抽屉、推广 Logo、场次切换 UI |
 * | 回放/倍速/replay 缩放/intro-outro | @region LIVE_REPLAY | L~11225 | 回放、双槽播放、捏合缩放 |
 * | 生命周期/横屏 setPageOrientation/进页初始化 | @region LIVE_LIFECYCLE | L~13487 | onLoad/onShow/onHide/onReady/onUnload、初始化 |
 *
 * 辅助文件（非 live.js）：behaviors/live-helpers.js、footballClockBehavior.js、liveWsBehavior.js
 */


/** @region LIVE_CONSTANTS — 阈值常量、运动类型、布局纯函数 */
/** 推广 Logo 初始展示高度占屏幕高度比例（约 1/10，减轻挡画面） */
const PROMO_AD_HEIGHT_RATIO = 0.1;
/** 推广 Logo 双指缩放下限 / 上限 */
const PROMO_AD_SCALE_MIN = 0.25;
const PROMO_AD_SCALE_MAX = 4;
/** 推广 Logo 贴边留白（px） */
const PROMO_AD_EDGE_MARGIN_PX = 8;
/** 推广 Logo 边缘吸附触发距离（px） */
const PROMO_AD_SNAP_THRESHOLD_PX = 28;
/** 拖拽停止后延迟吸附（ms），仅在松手时执行一次 setData */
const PROMO_AD_SNAP_DELAY_MS = 120;



/** 回放缩放离散档位（捏合吸附 / 双击等共用，至 3x 后下一轮回到 1x） */
const REPLAY_ZOOM_LEVELS = [1, 1.5, 2, 2.5, 3];
/** 与档位比较的容差，避免浮点抖动 */
const REPLAY_ZOOM_LEVEL_EPS = 0.04;
/** 判定为同一点双击的最大间隔（ms） */
const REPLAY_DOUBLE_TAP_INTERVAL_MS = 340;
/** 两次点击允许的最大位移（px） */
const REPLAY_DOUBLE_TAP_SLOP_PX = 48;
/**
 * 全指抬起后仍用捏合焦点公式处理 bindscale 的时长（ms），避免末帧 scale 落在 touchend 之后导致回弹到 (0,0)。
 */
const REPLAY_PINCH_SCALE_TAIL_MS = 120;
/** 捏合松手后等待原生末帧 bindscale 再吸附（ms） */
const REPLAY_PINCH_SNAP_DEFER_MS = 56;
/** 捏合吸附 + 居中动画时长（ms），略长于双击动画减轻突兀感 */
const REPLAY_PINCH_SNAP_ANIM_MS = 420;
/** 相对捏合起始 scale 判定「张开 / 捏拢」意图的阈值 */
const REPLAY_PINCH_INTENT_DELTA = 0.07;
/** 捏合吸附：位移与 scale 均过小则跳过动画，避免微抖 */
const REPLAY_PINCH_SNAP_EPS_SCALE = 0.018;
const REPLAY_PINCH_SNAP_EPS_PX = 2.5;
/** 双击缩放动画时长（ms），缓动为 ease-out（立方） */
const REPLAY_ZOOM_ANIM_MS = 300;
/** 判定为拖拽的最小位移（px），超过则取消本次单击/双击识别 */
const REPLAY_TAP_MOVE_SLOP_PX = 15;
/** 边界夹紧时的浮点余量，减轻与原生 out-of-bounds 判定冲突 */
const REPLAY_PAN_CLAMP_EPS = 0.5;
function resolveCurrentUserOpenId() {
  let openid = '';
  const globalUserInfo = app.globalData && app.globalData.userInfo;
  if (globalUserInfo && typeof globalUserInfo === 'object') {
    const maybeOpenid = globalUserInfo.openid;
    if (typeof maybeOpenid === 'string') {
      openid = maybeOpenid.trim();
    }
  }
  if (!openid) {
    try {
      const cached = wx.getStorageSync(STORAGE_USER_INFO_KEY);
      if (cached && typeof cached === 'object' && typeof cached.openid === 'string') {
        openid = cached.openid.trim();
      }
    } catch (e) {}
  }
  return openid;
}


/** 双指下滑唤醒曝光/对焦条：中点下移阈值（px），与捏合区分 */
const AE_TWO_FINGER_DOWN_PX = 52;
/** 双指间距变化超过此比例视为缩放手势，不触发下滑唤醒 */
const AE_PINCH_VS_SWIPE_DIST_RATIO = 0.06;
/** 直播态曝光控件无操作自动隐藏（ms） */
const AE_LIVE_AUTO_HIDE_MS = 3000;
/** 变焦结束后静默中心对焦防抖（ms），避免捏合过程中重复调 API */
const AE_POST_ZOOM_SILENT_FOCUS_MS = 300;
/** 录制中曝光条 setData 节流（ms），减轻与编码器同机竞争 */
const AE_EXPOSURE_SETDATA_THROTTLE_MS = 100;
/** 单击锁定对焦：最大位移判定为轻点（px） */
const AE_PRE_TAP_SLOP_PX = 20;
/** 对焦点方框边长（rpx），与 live.wxss 中 .ae-focus-bracket 一致 */
const AE_BRACKET_RPX = 56;
/** 对焦点方框上两次 tap 判为双击锁定的最大间隔（ms），略宽以适配部分机型的 tap 时序 */
const AE_BRACKET_DOUBLE_TAP_MS = 650;
/**
 * 仅对焦方框+下方提示的预估额外高度（rpx），靠底边夹紧时用。
 */
const AE_CLUSTER_EXTRA_BELOW_RPX = 40;
/** 卸原生 camera 后再起 VKSession 的等待（ms）；iOS 句柄释放更慢，过短易黑屏 / start 失败 */
const VK_BOOT_DELAY_MS_ANDROID = 760;
const VK_BOOT_DELAY_MS_IOS = 980;
/** 从 VK 切回原生：rebuild 回调后额外延迟再 mount camera（ms），给 GL/VK 释放留窗 */
const VK_POST_TEARDOWN_MOUNT_EXTRA_MS_IOS = 220;
/** 画质档位连点防抖（ms），覆盖 VK 与相机重建重叠窗口 */
const ENHANCE_SWITCH_GUARD_MS = 1000;
/**
 * 严重存储弹窗延迟（ms）：避免与横屏 setPageOrientation、权益通过后的 setData 同帧抢 wx.showModal，
 * 部分基础库在首帧/nextTick 调 showModal 会静默失败。
 */
const LIVE_STORAGE_SEVERE_MODAL_DELAY_MS = 560;
const HIGHLIGHT_LOCK_TIMEOUT = 3000;
const REPLAY_BUFFER_WINDOW_MS = 45000;
const REPLAY_BUFFER_MIN_READY_BYTES = 1024;
const SEGMENT_WATCHDOG_CHECK_INTERVAL_MS = 5000;
const SEGMENT_WATCHDOG_TIMEOUT_MIN_MS = 15000;
const SEGMENT_WATCHDOG_RECOVER_COOLDOWN_MS = 15000;
const SEGMENT_WATCHDOG_RESTART_DELAY_MS = 800;
/** 视录分离：onCameraFrame 长期无心跳则判定假录制并重启管线。 */
const PREVIEW_FRAME_FEED_STALL_MS = 18000;
/** 相机 remount 后启动 preview record 前的预热（iOS 需更长）。 */
const PREVIEW_RECORD_WARMUP_IOS_MS = 1800;
const PREVIEW_RECORD_WARMUP_ANDROID_MS = 1200;
/** 等待首帧回调的最长时限（ms）。 */
const PREVIEW_RECORD_FIRST_FRAME_TIMEOUT_MS = 3500;
/** Android 冷启动首帧超时（红米等机型 init 后 onCameraFrame 送达更慢）。 */
const PREVIEW_RECORD_FIRST_FRAME_TIMEOUT_ANDROID_MS = 8000;
/** Android 超广探测 / setZoom 结束后额外等待相机稳定（ms）。 */
const ANDROID_CAMERA_SETTLE_AFTER_PROBE_MS = 450;
/** Android 冷启动延后 AE/AF 锁定，避免首帧前锁死导致预览黑屏。 */
const ANDROID_LIVE_CAMERA_LOCK_DEFER_MS = 1600;
/** 正常起录时预热最少帧数（用于自适应 fps 测速，须 ≥ pipeline 内 FPS_MEASURE_MIN）。 */
const PREVIEW_RECORD_WARMUP_FRAMES_DEFAULT = 10;
/** 起录后允许保存高光的最早时刻（ms），避免刚重建相机的空壳段。 */
const PREVIEW_RECORD_MIN_MS_BEFORE_HIGHLIGHT = 3500;
/** 切后台回前台后起录到可保存高光的额外等待（ms）。 */
const PREVIEW_RECORD_MIN_MS_BEFORE_HIGHLIGHT_AFTER_PAGE_HIDE = 12000;
/** 入场 kickoff 后仍未起录时，自动重试 tryStartRolling 的延迟（ms）。 */
const ROLLING_KICKOFF_WATCHDOG_MS = 4500;
/** 场次切换后合并重启滚动的防抖延迟（ms）。 */
const MATCH_SWITCH_RESTART_DEFER_MS = 150;
/** 场次切换 stop 管线超时兜底（ms），避免 pipeline.stop 挂死导致永久 PAUSE。 */
const MATCH_SWITCH_PIPELINE_STOP_FAILSAFE_MS = 1400;
/** 场次切换重启后须攒满高光前导窗（ms），与 highlightLeadMs 对齐。 */
const MATCH_SWITCH_HIGHLIGHT_WARMUP_MS = 8000;
/** 切后台回前台后 preview record 预热帧数（首帧可能是静止缓存）。 */
const PREVIEW_RECORD_WARMUP_FRAMES_AFTER_PAGE_HIDE = 12;
/** remount 后首段探针时长（ms）：短段快速验证编码器是否产出健康 mp4。 */
const POST_RE_MOUNT_PROBE_CHUNK_MS = 10000;
/** remount 后空壳段触发的管线重启上限，超出则走 hard recover。 */
const ENCODER_VERIFY_RESTART_MAX = 3;
/** 硬恢复完成后禁止保存高光的隔离期（ms），覆盖乒乓双轨坏片轮换周期。 */
const HARD_RECOVER_HIGHLIGHT_QUARANTINE_MS = 90000;
/** hard_recover_timeout 二次重建后额外禁止保存高光（ms）。 */
const HARD_RECOVER_TIMEOUT_EXTRA_QUARANTINE_MS = 120000;
/** hard_recover_timeout 后 preview 预热最少帧数（iOS 二次重建后首帧易花屏）。 */
const PREVIEW_RECORD_WARMUP_FRAMES_AFTER_HARD_RECOVER_TIMEOUT = 18;

/** indexed 高光回放等待 materialize 的 UI 挂起上限（ms）；超时后 Toast 退出，后台继续固化。 */
const REPLAY_MATERIALIZE_WAIT_MS = 14000;
/** 回放进行中暂停 materialize 队列时的轮询间隔（ms）。 */
const REPLAY_MATERIALIZE_DEFER_POLL_MS = 800;
/** 回放期间保持 CFR 全速喂帧（不降 fps、不停喂），避免 mp4 时间轴空洞；回放与 decode 并行时略增 CPU。 */
const REPLAY_RECORDING_CFR_THROTTLE_ENABLED = false;
/** 可保存/回放的高光最短时长（ms），短于此拒绝 finalize。 */
const MIN_HIGHLIGHT_PLAYABLE_MS = 3000;
/** 连续低码率 rolling 段达到此次数后进入热节流模式。 */
const THERMAL_DEGRADED_SEGMENT_STREAK_ENTER = 2;
/** 热节流模式下连续健康段达到此次数后恢复正常档位。 */
const THERMAL_HEALTHY_SEGMENT_STREAK_EXIT = 3;
/** 热节流：CFR 喂帧与新建 MediaRecorder 目标 fps。 */
const THERMAL_RECORDING_CFR_FPS = 15;
const THERMAL_RECORDING_NOMINAL_FPS = 18;
/** 热节流：新建 MediaRecorder 视频码率（kbps）。 */
const THERMAL_RECORDING_KBPS = 2800;
/** 参与热节流判定的 rolling 段最短墙钟时长（ms），避免短探针段误触。 */
const THERMAL_SEGMENT_MIN_WALL_MS = 30000;
/** rolling 段合理最低码率（字节/秒），低于此视为静止/假活画面。 */
const MIN_ROLLING_SEGMENT_BYTES_PER_SEC = 80000;
/** 热节流判定阈值（字节/秒），低于正常 720p@3600 但高于严重假活。 */
const THERMAL_ROLLING_SEGMENT_BYTES_PER_SEC = 50000;
/** 切后台回前台后，编码停滞看门狗冷却（避免 180s 长 chunk 未落盘时反复 hard recover）。 */
const ENCODE_STALL_AFTER_PAGE_HIDE_MS = 60000;
const ENCODE_STALL_RECOVER_COOLDOWN_MS = 45000;
const RECORDER_SAFE_RESTART_DELAY_MIN_MS = 120;
/**
 * 本地存储键：是否已展示「超频模式无机位切换」提示（仅首次）。
 */

/** @deprecated 视录分离重构后不再使用 VK/增强管线，保留常量避免旧引用报错。 */

/** @type {{ tone: number, amount: number, motion: number }} */

/**
 * 直播机位：广角 / 标准 / 特写；与回放 REPLAY_ZOOM_LEVELS 无耦合。
 * @readonly
 */
const CameraViewMode = {
  WIDE: 'wide',
  NORMAL: 'normal',
  CLOSE: 'close'
};

/** 特写机位默认目标变焦（受 {@link data.maxZoom} 夹持） */
const VIEW_MODE_CLOSE_ZOOM = 2;
/** 快速变焦开关的 Storage key */
const QUICK_ZOOM_ENABLED_KEY = 'live_quick_zoom_enabled';
/** 快速变焦档位保存值的 Storage key */
const QUICK_ZOOM_STOPS_KEY = 'live_quick_zoom_stops';
/** 快速变焦长按保存所需时长（ms） */
const QUICK_ZOOM_LONG_PRESS_MS = 800;
/** 快捷变焦选中档双指微调区间下界/上界（左闭右开，避免档位重叠） */
const QUICK_ZOOM_PINCH_NEAR_MIN = 1;
const QUICK_ZOOM_PINCH_MID_MIN = 2;
const QUICK_ZOOM_PINCH_FAR_MIN = 4;
const QUICK_ZOOM_PINCH_NEAR_MAX = 2;
const QUICK_ZOOM_PINCH_MID_MAX = 4;
/** 快捷变焦固定默认倍数：远 / 中 / 近（关闭后重新开启时恢复） */
const QUICK_ZOOM_DEFAULT_ZOOMS = [4, 2, 1];
/** 内存保存后保护窗口（ms），避免 reload 覆盖刚写入的档位 */
const QUICK_ZOOM_SAVE_GUARD_MS = 3000;

/**
 * Android 超广探测：complete 早于 success 时若用 0ms 会误判失败，略延迟再试下一档。
 * @readonly
 */
const ANDROID_ULTRAWIDE_PROBE_COMPLETE_MS = 280;

/** 走表本地刷新间隔（逻辑层 tick，规避 WXS rAF 在 0 尺寸节点不续帧） */
const LIVE_WS_CLOCK_TICK_MS = 200;
/** START 时网络延迟补偿上限（过大易让直播端比现场表快 1～2 秒再被 SYNC 拉回） */
const LIVE_WS_START_LAG_COMP_MAX_MS = 500;

/**
 * 大表剩余秒格式化为 MM:SS。
 * @param {number} totalSec
 * @returns {string}
 */
function formatWxsMainText(totalSec) {
  var sec = Math.max(0, Math.floor(Number(totalSec) || 0));
  var m = Math.floor(sec / 60);
  var s = sec % 60;
  var ms = m < 10 ? '0' + m : '' + m;
  var ss = s < 10 ? '0' + s : '' + s;
  return ms + ':' + ss;
}

/** 足球下半场起始累计秒数（45:00） */
var FOOTBALL_HALF2_START_SEC = 45 * 60;
/** 足球加时赛起始累计秒数（90:00） */
var FOOTBALL_EXTRA_START_SEC = 90 * 60;

/** @const {object} 足球计时/补时默认状态 */
var DEFAULT_FOOTBALL_STATE = {
  clockPaused: true,
  clockWallMs: 0,
  extraMinutesHalf1: 0,
  extraMinutesHalf2: 0,
  extraMinutesExtra: 0,
  /** 2=三段场次模型（上/下/加时赛），用于与旧四段模型区分 */
  periodModel: 2
};

/**
 * 规范化足球计时状态。
 * @param {unknown} raw
 * @returns {{ clockPaused: boolean, clockWallMs: number, extraMinutesHalf1: number, extraMinutesHalf2: number, extraMinutesExtra: number }}
 */
function normalizeFootballState(raw) {
  var fs = raw && typeof raw === 'object' ? raw : {};
  var wallMs = Math.max(0, Math.floor(Number(fs.clockWallMs) || 0));
  var paused;
  if (fs.clockPaused === true) {
    paused = true;
  } else if (fs.clockPaused === false) {
    paused = false;
  } else {
    paused = wallMs <= 0;
  }
  return {
    clockPaused: paused,
    clockWallMs: wallMs,
    extraMinutesHalf1: Math.max(0, Math.floor(Number(fs.extraMinutesHalf1) || 0)),
    extraMinutesHalf2: Math.max(0, Math.floor(Number(fs.extraMinutesHalf2) || 0)),
    extraMinutesExtra: Math.max(0, Math.floor(Number(fs.extraMinutesExtra) || 0)),
    periodModel: Number(fs.periodModel) === 2 ? 2 : 0
  };
}

/**
 * 将旧版四段节次一次性迁移为 1=上 / 2=下 / 3=加时赛（仅 periodModel≠2 时调用）。
 * @param {number} period
 * @param {object} [mc] matchConfig，用于结合 elapsed 判断
 * @returns {number}
 */
function migrateLegacyFootballPeriod(period, mc) {
  var p = Math.floor(Number(period) || 1);
  var fs = normalizeFootballState(mc && mc.footballState);
  var elapsed = Math.max(0, Math.floor(Number(mc && mc.footballElapsedSec) || 0));
  if (p === 2) {
    if (fs.extraMinutesHalf1 > 0) return 1;
    if (elapsed >= FOOTBALL_HALF2_START_SEC) return 2;
    return 1;
  }
  if (p === 3 || p === 4) return 2;
  if (p >= 5) return 3;
  return Math.min(3, Math.max(1, p));
}

/**
 * 足球节次展示文案（场次名与补时分开展示）。
 * @param {number} period
 * @param {object} [footballState]
 * @returns {{ base: string, stoppage: string }}
 */
function getFootballHalfLabelParts(period, footballState) {
  var fs = normalizeFootballState(footballState);
  var p = Math.min(5, Math.max(1, Math.floor(Number(period) || 1)));
  var base = '上半场';
  var extra = 0;
  if (p === 1) {
    base = '上半场';
    extra = fs.extraMinutesHalf1;
  } else if (p === 2) {
    base = '下半场';
    extra = fs.extraMinutesHalf2;
  } else if (p === 3) {
    base = '加时赛';
    extra = fs.extraMinutesExtra;
  } else if (p === 4) {
    base = '热身';
    extra = 0;
  } else if (p === 5) {
    base = '中场休息';
    extra = 0;
  }
  return {
    base: base,
    stoppage: extra > 0 ? '+' + extra : ''
  };
}

/**
 * 足球节次完整文案（兼容旧引用）。
 * @param {number} period
 * @param {object} [footballState]
 * @returns {string}
 */
function getFootballHalfLabel(period, footballState) {
  var parts = getFootballHalfLabelParts(period, footballState);
  return parts.base + parts.stoppage;
}

/** @const {string} 篮球运动类型标识 */
var SPORT_BASKETBALL = 'basketball';
/** @const {string} 足球运动类型标识 */
var SPORT_FOOTBALL = 'football';
/** @const {string} 羽毛球运动类型标识 */
var SPORT_BADMINTON = 'badminton';

/**
 * 规范化运动类型字符串。
 * @param {unknown} raw
 * @returns {'basketball'|'football'|'badminton'}
 */
function normalizeSportType(raw) {
  var s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === SPORT_FOOTBALL || s === SPORT_BADMINTON) return s;
  return SPORT_BASKETBALL;
}

/** @const {object} 羽毛球默认状态机 */
var DEFAULT_BADMINTON_STATE = {
  servingTeam: 'A',
  servingZone: 'right',
  ruleType: 'single',
  maxSets: 3,
  pointsPerSet: 21,
  isScoreEnabled: true
};

/**
 * 判定羽毛球当前局是否结束。
 * @param {number} scoreA A 方小分
 * @param {number} scoreB B 方小分
 * @param {number} pointsPerSet 单局目标分（11 或 21）
 * @returns {'A'|'B'|null} 获胜方，未结束则 null
 */
function checkBadmintonSetWin(scoreA, scoreB, pointsPerSet) {
  var a = Math.max(0, Math.floor(Number(scoreA) || 0));
  var b = Math.max(0, Math.floor(Number(scoreB) || 0));
  var target = Math.max(1, Math.floor(Number(pointsPerSet) || 21));
  var cap = 30;
  if (a >= cap || b >= cap) {
    if (a > b) return 'A';
    if (b > a) return 'B';
    return null;
  }
  if (a >= target && a - b >= 2) return 'A';
  if (b >= target && b - a >= 2) return 'B';
  return null;
}

/**
 * 构建羽毛球历史局分展示列表。
 * @param {object} mc matchConfig
 * @returns {Array<{ label: string, scoreA: number, scoreB: number }>}
 */
function buildBadmintonSetHistoryDisplay(mc) {
  if (!mc || normalizeSportType(mc.sportType) !== SPORT_BADMINTON) return [];
  var subA = mc.teamA && Array.isArray(mc.teamA.subScores) ? mc.teamA.subScores : [];
  var subB = mc.teamB && Array.isArray(mc.teamB.subScores) ? mc.teamB.subScores : [];
  var len = Math.max(subA.length, subB.length);
  var rows = [];
  var labels = ['一', '二', '三', '四', '五'];
  for (var i = 0; i < len; i++) {
    rows.push({
      label: '第' + (labels[i] || String(i + 1)) + '局',
      scoreA: typeof subA[i] === 'number' ? subA[i] : 0,
      scoreB: typeof subB[i] === 'number' ? subB[i] : 0
    });
  }
  return rows;
}

/**
 * 根据时钟束与墙钟计算大表 / 24 秒当前显示值。
 * @param {object | null} bundle
 * @param {string} [sportType] 运动类型
 * @returns {{ mainText: string, shotSec: number, shotWarn: boolean }}
 */
function computeClockDisplayFromBundle(bundle, sportType) {
  if (!bundle || typeof bundle !== 'object') {
    return {
      mainText: '00:00',
      shotSec: 24,
      shotWarn: false
    };
  }
  var sport = normalizeSportType(sportType);
  if (sport === SPORT_BADMINTON) {
    return {
      mainText: '',
      shotSec: 0,
      shotWarn: false
    };
  }
  var nowMs = Date.now();
  var mainBase = Math.max(0, Math.floor(Number(bundle.mainBaseSec) || 0));
  var shotBase = Math.max(0, Math.floor(Number(bundle.shotBaseSec) || 24));
  var mainAnchor = Number(bundle.mainAnchorMs) || nowMs;
  var shotAnchor = Number(bundle.shotAnchorMs) || nowMs;
  var running = !!bundle.mainRunning;
  var elapsedSec = running ? Math.floor((nowMs - mainAnchor) / 1000) : 0;
  var mainSec = mainBase;
  var shotSec = shotBase;
  if (running) {
    if (sport === SPORT_FOOTBALL) {
      mainSec = mainBase + elapsedSec;
    } else {
      mainSec = Math.max(0, mainBase - elapsedSec);
      shotSec = Math.max(0, shotBase - Math.floor((nowMs - shotAnchor) / 1000));
    }
  }
  return {
    mainText: formatWxsMainText(mainSec),
    shotSec: sport === SPORT_FOOTBALL ? 0 : shotSec,
    shotWarn: sport !== SPORT_FOOTBALL && shotSec > 0 && shotSec <= 5
  };
}

/**
 * 将 zoom 值格式化为按钮文案（如 1x / 2x / 2.5x）。
 * @param {number} z
 * @returns {string}
 */
function formatCameraZoomLabel(z) {
  var n = Number(z);
  if (!isFinite(n) || n <= 0) n = 1;
  var rounded = Math.round(n * 10) / 10;
  if (Math.abs(rounded - Math.round(rounded)) < 0.01) {
    return String(Math.round(rounded)) + 'x';
  }
  return String(rounded) + 'x';
}

/**
 * 是否 iOS 宿主（用于小程序 camera 与系统相机 zoom 刻度对齐）。
 * @returns {boolean}
 */
function isLiveHostIos() {
  try {
    return String(wx.getSystemInfoSync().platform || '').toLowerCase() === 'ios';
  } catch (e) {
    return false;
  }
}

/**
 * 根据设备 maxZoom 得到进入直播时的默认预览倍率（iOS 上 zoom=2 更接近系统相机「1×」主摄）。
 * @param {number} maxZoom
 * @returns {number}
 */
function getDefaultPreviewZoomForMax(maxZoom) {
  var mz = Number(maxZoom);
  if (!isFinite(mz)) mz = 10;
  if (isLiveHostIos() && mz >= 2) return 2;
  return 1;
}

/**
 * 在窗口内得到最大内接 16:9 矩形（px），与常见相机/编码 16:9 长宽比一致，避免全屏时视口与传感器比例严重错位。
 *
 * @param {number} winW
 * @param {number} winH
 * @returns {{ w: number, h: number }}
 */
function computeLiveStage16x9SizePx(winW, winH) {
  var ww = Math.max(1, winW);
  var wh = Math.max(1, winH);
  var ar = 16 / 9;
  if (ww / wh > ar) {
    var h1 = wh;
    var w1 = h1 * ar;
    return {
      w: w1,
      h: h1
    };
  }
  var w0 = ww;
  var h0 = w0 / ar;
  return {
    w: w0,
    h: h0
  };
}

/**
 * 16:9 内接矩形在窗口中的位置（px，左上为原点），与 liveStageInlineStyle 居中逻辑一致。
 *
 * @param {number} winW
 * @param {number} winH
 * @returns {{ w: number, h: number, left: number, top: number }}
 */
function computeLiveStage16x9RectPx(winW, winH) {
  var box = computeLiveStage16x9SizePx(winW, winH);
  var ww = Math.max(1, winW);
  var wh = Math.max(1, winH);
  var ar = 16 / 9;
  if (ww / wh > ar) {
    return {
      w: box.w,
      h: box.h,
      left: (ww - box.w) * 0.5,
      top: 0
    };
  }
  return {
    w: box.w,
    h: box.h,
    left: 0,
    top: (wh - box.h) * 0.5
  };
}

/**
 * 角标 ◎/REC 放在 16:9 外黑边：有左右条时收进条内；全宽+上下条时收进底带并收紧 bottom，避免与取景区重叠。
 *
 * @param {number} winW
 * @param {number} winH
 * @param {{ w: number, h: number, left: number, top: number}} rect
 * @param {{ sL: number, sR: number, sB: number}} safePx
 * @returns {{ leftCameraFab: string, recoverStack: string, replayRail: string }}
 */
function buildCornerFabStylesInLetterboxPx(winW, winH, rect, safePx) {
  var w = Math.max(1, winW);
  var h = Math.max(1, winH);
  var r = rect;
  var factor = 750 / w;
  var fabR = 40;
  var mR = 10;
  var gR = 8;
  var sLr = safePx.sL * factor;
  var sRr = safePx.sR * factor;
  var sBr = safePx.sB * factor;
  var barLeftR = r.left * factor;
  var videoRightR = (r.left + r.w) * factor;
  var Lmin = mR + sLr;
  var Lmax = barLeftR - fabR - gR;
  var Rmin = mR + sRr;
  var Rmax = 750 - fabR - videoRightR - gR;
  var bottomR;
  if (h - (r.top + r.h) < 1) {
    /** 取景区贴底，底边无条（典型：横屏左右黑条） */
    bottomR = mR + sBr;
  } else {
    var fabWpx = fabR * w / 750;
    var mpx = mR * w / 750;
    var capBpx = h - (r.top + r.h) - fabWpx - 2;
    var wantBpx = mpx + safePx.sB;
    var bpx = wantBpx <= capBpx ? wantBpx : Math.max(0, capBpx);
    bottomR = bpx * 750 / w;
  }
  var fullW = r.left * factor < 0.1;
  var leftR;
  if (Lmax >= Lmin) {
    leftR = Lmin;
  } else if (fullW) {
    leftR = Lmin;
  } else {
    leftR = Math.max(0, Lmax);
  }
  var rightR;
  if (Rmax >= Rmin) {
    rightR = Rmin;
  } else if (fullW) {
    rightR = Rmin;
  } else {
    rightR = Math.max(0, Rmax);
  }
  return {
    leftCameraFab: 'left:' + leftR + 'rpx;bottom:' + bottomR + 'rpx;',
    recoverStack: 'right:' + rightR + 'rpx;bottom:' + bottomR + 'rpx;',
    /** 实时回看右侧工具列：与 REC 列同 right，垂直居中于视窗，不占用 16:9 画面内顶部空间 */
    replayRail: 'right:' + rightR + 'rpx;top:50%;transform:translateY(-50%);'
  };
}

/**
 * 计算篮球底部赛名+记分条锚点（rpx）：优先落在 16:9 下方黑边，横屏贴底时略向下贴边以减少遮挡球场。
 *
 * @param {number} winW 窗口宽 px
 * @param {number} winH 窗口高 px
 * @param {{ w: number, h: number, left: number, top: number }} rect 16:9 取景区
 * @param {{ sL: number, sR: number, sB: number }} safePx 安全区 px
 * @returns {{ bottomR: number, nudgeDownR: number }}
 */
function computeBottomScoreUiAnchorRpx(winW, winH, rect, safePx) {
  var w = Math.max(1, winW);
  var h = Math.max(1, winH);
  var r = rect;
  var factor = 750 / w;
  var sBr = Math.max(0, safePx.sB) * factor;
  var letterboxBelowPx = Math.max(0, h - (r.top + r.h));
  var bottomR;
  var nudgeDownR;

  if (letterboxBelowPx < 1) {
    bottomR = Math.max(6, sBr);
    nudgeDownR = 10;
  } else {
    var letterboxBelowRpx = letterboxBelowPx * factor;
    bottomR = letterboxBelowRpx * 0.25 + sBr;
    nudgeDownR = 0;
  }
  return {
    bottomR: bottomR,
    nudgeDownR: nudgeDownR
  };
}

/**
 * 篮球底部居中赛名+记分条内联样式。
 *
 * @param {number} winW
 * @param {number} winH
 * @param {{ w: number, h: number, left: number, top: number }} rect
 * @param {{ sL: number, sR: number, sB: number }} safePx
 * @returns {string}
 */
function buildBottomCenterBoardStyleInLetterboxPx(winW, winH, rect, safePx) {
  var anchor = computeBottomScoreUiAnchorRpx(winW, winH, rect, safePx);
  return (
    'left:50%;bottom:' + anchor.bottomR.toFixed(2) + 'rpx;' +
    'transform:translateX(-50%) translateY(' + anchor.nudgeDownR + 'rpx);'
  );
}

/**
 * 篮球 24 秒小钟内联样式：与底部记分条同底边锚点，水平贴 16:9 右内缘。
 *
 * @param {number} winW
 * @param {number} winH
 * @param {{ w: number, h: number, left: number, top: number }} rect
 * @param {{ sL: number, sR: number, sB: number }} safePx
 * @returns {string}
 */
function buildShotClockBoxStyleInLetterboxPx(winW, winH, rect, safePx) {
  var w = Math.max(1, winW);
  var factor = 750 / w;
  var anchor = computeBottomScoreUiAnchorRpx(winW, winH, rect, safePx);
  var gutterR = Math.max(10, (w - (rect.left + rect.w)) * factor + 12);
  return (
    'right:' + gutterR.toFixed(2) + 'rpx;bottom:' + anchor.bottomR.toFixed(2) + 'rpx;' +
    'transform:translateY(' + anchor.nudgeDownR + 'rpx);'
  );
}
/** @region LIVE_DATA — Page data 初始状态 */
Page({
  behaviors: [footballClockBehavior, liveWsBehavior],
  data: {
    /** 当前运动类型：basketball | football | badminton */
    sportType: SPORT_BASKETBALL,
    /** 是否展示大钟（羽毛球隐藏） */
    showMainClock: true,
    /** 是否展示 24 秒小钟（仅篮球自动模式） */
    showShotClock: false,
    /** 羽毛球历史局分展示行 */
    badmintonSetHistory: [],
    /** 足球/羽毛球是否使用右上角多行记分牌 */
    useCornerScoreboard: false,
    /** movable-view 是否已就绪（用于重挂载以应用 x/y） */
    proScoreboardMovableReady: false,
    /** movable-view 尺寸（px，须与组件 width/height 属性一致） */
    proScoreboardViewW: 120,
    proScoreboardViewH: 48,
    /** 记分牌在 16:9 取景区内的相对坐标（px） */
    proScoreboardX: 0,
    proScoreboardY: 8,
    /** 赛名浮层 movable-view 是否已就绪 */
    proMatchNameMovableReady: false,
    /** 赛名浮层 movable-view 尺寸（px） */
    proMatchNameViewW: 120,
    proMatchNameViewH: 18,
    /** 赛名条内容宽度（px，取景区宽 1/3） */
    proMatchNameBarW: 120,
    /** 赛名浮层在 16:9 取景区内的相对坐标（px） */
    proMatchNameX: 0,
    proMatchNameY: 0,
    matchConfig: {
      sportType: SPORT_BASKETBALL,
      matchName: '',
      matchNameColor: '#E64340',
      teamA: {
        name: '队 A',
        bgColor: '#E64340',
        textColor: '#FFFFFF',
        score: 0,
        currentSetScore: 0,
        subScores: []
      },
      teamB: {
        name: '队 B',
        bgColor: '#10AEFF',
        textColor: '#FFFFFF',
        score: 0,
        currentSetScore: 0,
        subScores: []
      },
      period: 0,
      badmintonState: JSON.parse(JSON.stringify(DEFAULT_BADMINTON_STATE)),
      sportConfig: {
        periodMinutes: 10,
        enable24Sec: false,
        halfMinutes: 45,
        ruleType: 'single',
        pointsPerSet: 21,
        maxSets: 3
      },
      /** 足球累计比赛时间（秒），持久化 */
      footballElapsedSec: 0,
      footballState: {
        ...DEFAULT_FOOTBALL_STATE
      }
    },
    periods: app.globalData.periods,
    statusBarHeight: 0,
    cameraContext: null,
    cameraMounted: false,
    /** 毁灭性重建控制阀：false 时 wx:if 令微信底层彻底销毁 <camera> 原生节点并释放硬件锁。 */
    isCameraRendered: true,
    /** 强制 camera 组件重建的渲染序号（每次重建 +1）。 */
    cameraRenderNonce: 0,
    /**
     * camera onCameraFrame 抽帧档位（初始化后不可变）：须保持 large，480p 降级只缩后台编码 canvas。
     * @type {'small'|'medium'|'large'}
     */
    recordFrameSize: 'large',
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
    /** 高光保存进度 0–360，仅在 isSavingHighlight 时叠于状态灯，低透明度 conic */
    highlightSaveConicEndDeg: 0,
    /** 是否正在保存高光（事务锁：覆盖 stopRecord→落盘→copy→入库 全链路） */
    isSavingHighlight: false,
    /** RecorderCore 熔断后的降级态：仅保留基础录制与基础高光。 */
    recorderDegradedMode: false,
    isRecording: false,
    recSyncEnabled: false,
    recSyncRoomId: '',
    recSyncConnected: false,
    recSyncPanelOpen: false,
    longPressTimer: null,
    periodFlash: false,
    /** 缓存空间灯：与 file-storage-estimate 的 getClipStorageHealthHint.level 一致 */
    cacheStorageLampLevel: 'ok',
    /**
     * 与 cacheStorageLampLevel==='severe' 同步；为 true 时禁起新 rolling 段、禁保存高光，下灯可点按批量导出清空间。
     * @type {boolean}
     */
    storageSevereLock: false,
    /** 同 storageSevereLock，供 wxml 复用可点态 */
    cacheStorageLampActionable: false,
    /** 与顶部状态灯同系：OK / WT(warn) / EX(severe) */
    cacheStorageLampText: 'OK',
    /** 长按比赛名生成审计文件后，展示「发送审计」按钮（须 tap 才能 wx.shareFileMessage） */
    auditExportShareVisible: false,
    /**
     * 左下角「相机/变焦」快捷：展开态；与抽屉互斥，避免与列表手势冲突。
     * @type {boolean}
     */
    cameraSettingsOpen: false,
    /**
     * 机位快捷项：广角 + 数字倍数；按机型能力动态生成（支持才显示广角）。
     * @type {Array<{ label: string, mode: string, zoom: number }>}
     */
    cameraViewModeStops: [{
      label: '广角',
      mode: CameraViewMode.WIDE,
      zoom: 0.5
    }, {
      label: '1x',
      mode: CameraViewMode.NORMAL,
      zoom: 1
    }, {
      label: '2x',
      mode: CameraViewMode.CLOSE,
      zoom: 2
    }],
    /** 当前选中的机位（与 pinch 变焦可短暂不同步，仅影响药丸高亮） */
    cameraViewMode: CameraViewMode.NORMAL,
    /** 镜头切换过渡：相机容器视觉缩放比例（CSS scale，1.0 为正常） */
    cameraLensSwitchScale: 1.0,
    /** 镜头切换过渡：scale CSS transition 时长（ms） */
    cameraLensSwitchScaleDuration: 200,
    /** 直播画幅模式：'full' (满屏) | '16x9' (横屏) */
    liveVideoAspectMode: 'full',
    /**
     * 相机设置呼出条：fixed 定位在 16:9 取景区内左侧（由 _updateLiveStageLayout 写入）。
     * @type {string}
     */
    cameraSettingsPanelStyle: '',
    /**
     * ◎ 角标：16:9 外黑边内（与 recoverFabStackStyle 同时计算）。
     * @type {string}
     */
    leftCameraFabStyle: 'left:10rpx;bottom:10rpx;',
    /**
     * REC+存储灯角标：16:9 外黑边内，与左对称。
     * @type {string}
     */
    recoverFabStackStyle: 'right:10rpx;bottom:10rpx;',
    /** 回放模式右侧倍速/关闭/还原列（与 {@link buildCornerFabStylesInLetterboxPx} 同步） */
    replayRailStyle: 'right:10rpx;top:50%;transform:translateY(-50%);',
    /**
     * 轻提示（自绘小字无底色，替代 wx.showToast，避免与直播抢焦点）；opacity 0~0.5，短时长。
     * @type {string}
     */
    lightHintText: '',
    /** @type {number} */
    lightHintOpacity: 0,
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
    /** 颜色浮层：高光缓存行提示（含约 MB） */
    colorModalCacheRowHint: '',
    /** 颜色浮层：已执行下载清空，按钮置为「已清空」 */
    colorModalDownloadCleared: false,
    /** 快选颜色球色板（24 色：8 列 × 3 行，仅一个纯黑） */
    colorBalls: ['#DC2626', '#EA580C', '#F59E0B', '#EAB308', '#84CC16', '#16A34A', '#059669', '#0D9488', '#14B8A6', '#06B6D4', '#0EA5E9', '#3B82F6', '#6366F1', '#7C3AED', '#A855F7', '#C026D3', '#DB2777', '#E11D48', '#F43F5E', '#FFFFFF', '#E2E8F0', '#94A3B8', '#475569', '#000000'],
    drawerHighlights: [],
    /** 当前场次高光片段总数（用于抽屉顶部统计显示）。 */
    highlightCount: 0,
    /**
     * 商业推广：母比赛 ID（promo_match_id，与本地计分场次 currentMatchId 无关）。
     * @type {string}
     */
    promoMatchId: '',
    /** 商业推广 Logo 列表（含拖拽坐标 x/y） */
    promoAds: [],
    /** 是否在取景框上展示推广 Logo */
    promoAdsVisible: false,
    /** 载入 Ads 紧凑面板（与自动记分房间号面板同款） */
    promoAdsPanelOpen: false,
    /** 直播画幅设置面板（抽屉工具栏「画幅」弹出） */
    aspectModePanelOpen: false,
    /** 弹窗内输入的母比赛 ID */
    promoLoadInput: '',
    /** 载入推广请求中 */
    promoLoadBusy: false,
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
    /** ReplayBuffer v2 每段回放计划：path + initialTimeSec + stopAtSec */
    replayHighlightPlan: [],
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
    minZoom: 1,
    distance: 0,
    lastZoom: 1,
    /** 左右球队色块宽度（px），按队名字符数估算，避免 flex:1 拉满半屏 */
    teamGroupWidthPxA: 0,
    teamGroupWidthPxB: 0,
    showGuide: false,
    /** 快速上手分步：0=操作说明，1=抖音直播 16:9 画幅引导（与 {@link dismissGuide} 复位一致） */
    guideSubStep: 0,
    /** 共用：对焦框 + 小太阳条是否显示 */
    aeControlsVisible: false,
    /** 对焦/曝光 UI 来源：开赛前 pre、直播中手势唤醒 live */
    aeContext: '',
    /** 小太阳在竖条上的 0–100%（自上向下：亮→暗 依 evNorm 映射） */
    aeSunTopPct: 50,
    /** 开赛前在点击点展示整簇；false 为几何中心整簇 */
    aeFocusIsTapPosition: true,
    /** 对焦+曝光簇左上角 rpx（仅 tap 模式用内联；与 {@link AE_BRACKET_RPX} 配套） */
    aeClusterLeftRpx: 0,
    aeClusterTopRpx: 0,
    /** 对焦点位成功后的短反馈（高亮/缩放动画的开关） */
    aeFocusLockFlash: false,
    /** 用户双击方框后锁定态（在相同归一化坐标上再调 setTargetFocus） */
    aeFocusUserLocked: false,
    /** 是否显示「双击方框锁焦」提示（出框后短时显示，锁焦后关闭） */
    aeShowDoubleTapHint: false,
    /**
     * 当前机型 cameraContext 是否支持硬件 EV 接口（setExposureCompensation / setEV / setExposureOffset 任一存在）。
     * 不支持时曝光滑条不展示，也不提供任何“软补光”兜底（软补光只改预览 overlay，不影响录制结果，
     * 反而误导用户，且录制过程中多一层半透明 view 合成对低端机型是负担）。
     */
    aeExposureHardwareSupported: false,
    /** 是否通过 GET /api/auth/check-status 且 isVip 为 true */
    liveStreamAllowed: false,
    /** 首次进入 Live 时尚未完成权益校验 */
    liveEntitlementChecking: true,
    /** 权益不足时的全屏引导层 */
    showVipGate: false,
    vipGateTitle: '',
    vipGateSubtext: '',
    vipGateMinor: '',
    vipGateRetryVisible: false,
    /**
     * 严重存储提示：原生 `wx.showModal` 在部分机型 `<camera>` 页不可靠，用页面级 fixed 遮罩；
     * 勿嵌 camera 内 cover-view（flex/宽度在 VK 重建后易错乱）。
     */
    showStoragePressureModal: false,
    storagePressureModalText: '',
    /**
     * 增强渲染：WebGL 锐化画布是否进入视图树。由 render-pipeline 根据模式驱动，
     * 关闭时回退为仅 <camera> 的原生预览。
     */
    enhanceCanvasVisible: false,
    /** 16:9 取景框内联样式（等比内接于窗口，黑边在容器外，见 live.wxss .live-stage） */
    liveStageInlineStyle: '',
    /** 篮球底部赛名+记分条位置（锚定 16:9 底边/下方黑边） */
    bottomCenterBoardStyle: '',
    /** 篮球 24 秒小钟位置（与记分条底边对齐） */
    shotClockBoxStyle: '',
    /**
     * 增强渲染当前档位：'off' | 'lite' | 'standard' | 'strong' | 'vk'；由 render-pipeline 写回。
     * 注意：'vk' 属于独立家族，此时 <camera> 已 unmount、rolling 已停；切出时须通过
     * `switchToNonVkMode` orchestrator 回到原生家族。
     */
    enhanceMode: 'off',
    /**
     * 机型是否通过增强渲染白名单（由 app.js 冷启动评估）；决定调试工具条是否展示。
     * 即使当前 mode==='off'，白名单机型仍可从工具条中手动切回 standard/strong。
     */
    enhanceWhitelisted: false,
    /**
     * 当前用户是否在画质增强内测白名单中。
     * 仅当用户命中白名单且机型能力通过时，长按空白区打开抽屉后才显示增强设置条。
     */
    enhanceBetaWhitelisted: false,
    /**
     * 当前用户是否在 sync-lab / 自动记分实验白名单（OpenID，与「我的」页 sync-lab 同源）。
     * 与 `enableEnhanceRender` / `enhanceWhitelisted` 解耦：非增强机型亦可使用节次长按自动记分。
     */
    autoSyncWhitelisted: false,
    /**
     * 抽屉打开时工具条展示的实时 FPS 文案（如 "28 fps"）；未启用时显示 "— fps"。
     */
    enhanceFpsText: '— fps',
    // --- 自动模式相关（V2 WebSocket 云端同步） ---
    isAutoMode: false,
    /** 采集端 sync_score=1 时自动跟分；false 时自动模式下仍可手动改分 */
    liveWsScoreSyncEnabled: false,
    /** 云端 WSS 已连接（角标） */
    liveWsConnected: false,
    /** 是否展开 Live 内云端连房面板 */
    liveWsPanelOpen: false,
    /** 6 位 roomId 输入 */
    liveWsRoomId: '',
    /** 正在取 Token / 握手中 */
    liveWsQuickBusy: false,
    /** 连房面板状态说明 */
    liveWsStatusText: '',
    // ─── 快速变焦 ───────────────────────────────────────────────
    /** 快捷变焦开关：是否在右侧显示三档倍数按钮 */
    quickZoomEnabled: false,
    /**
     * 三个快捷变焦档位（远/中/近，仅内部标识；界面只展示倍数）。
     * zoom: 保存倍数；displayZoom: 展示文案（如 4x）；isActive: 是否激活。
     */
    quickZoomStops: [{
      label: '远',
      zoom: 4,
      displayZoom: '4x',
      isActive: false
    }, {
      label: '中',
      zoom: 2,
      displayZoom: '2x',
      isActive: false
    }, {
      label: '近',
      zoom: 1,
      displayZoom: '1x',
      isActive: false
    }],
    /** 快捷变焦激活档位的临时 zoom（双指微调后与保存值不同时不为 null） */
    quickZoomTempZoom: null,
    /** 临时 zoom 的展示文案（与 quickZoomTempZoom 同步） */
    quickZoomTempDisplay: '',
    /** 长按保存圆环进度 0–360（conic-gradient） */
    quickZoomSaveConicDeg: 0,
    /** 长按保存圆环内联样式（避免 wxml 内联 CSS 插值触发 IDE 报错） */
    quickZoomSaveProgressStyle: '',
    /** 正在长按保存的档位 index，-1 表示无 */
    quickZoomSaveIdx: -1,
    /** 快捷变焦折叠菜单是否展开（默认收起，仅显示主按钮） */
    quickZoomMenuOpen: false,
    /** 主变焦按钮展示文案（当前激活档或按 zoom 推断） */
    quickZoomMainDisplay: '1x'
  },
  /**
   * 从全局与 Storage 同步当前场次记分配置（与 index、onShow 逻辑一致）。
   * @returns {void}
   */
  /**
   * 解析当前高光应写入的场次 ID（Storage / globalData / 当前 matchConfig.id）。
   * @returns {string} 空字符串表示无法安全落库，调用方应中止保存并提示用户。
   */
  /** @region LIVE_MATCH — 场次配置、记分、节次 */
resolveMatchIdForHighlightStorage: function () {
    let id = clipsStorage.normalizeMatchIdKey(wx.getStorageSync('currentMatchId'));
    if (!id) id = clipsStorage.normalizeMatchIdKey(app.globalData && app.globalData.currentMatchId);
    if (!id) {
      const mc = this.data.matchConfig;
      if (mc && mc.id != null) id = clipsStorage.normalizeMatchIdKey(mc.id);
    }
    return id || '';
  },
  syncMatchConfigFromPageSources: function () {
    const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    let sourceConfig = app.globalData.matchConfig || wx.getStorageSync('matchConfig');
    if (currentMatchId) {
      const matches = wx.getStorageSync('MIAOXIE_MATCHES');
      if (Array.isArray(matches)) {
        const found = matches.find(m => m.id === currentMatchId);
        if (found) {
          sourceConfig = found;
        }
      }
    }
    const latestConfig = this.normalizeMatchConfig(sourceConfig);
    const sportType = normalizeSportType(latestConfig.sportType || this._routeSportType);
    if (this._routeSportType) {
      this._routeSportType = null;
    }
    latestConfig.sportType = sportType;
    const wSide = this.computeTeamGroupWidthPx();
    const sportUi = this.buildSportUiPatch(latestConfig, sportType);
    const payload = {
      matchConfig: latestConfig,
      sportType: sportType,
      teamGroupWidthPxA: wSide,
      teamGroupWidthPxB: wSide,
      footballTimeText: formatWxsMainText(this._computeFootballElapsedFromStored(latestConfig)),
      ...sportUi
    };
    if (latestConfig.mode === 'manual' && this.data.autoSyncWhitelisted) {
      payload.isAutoMode = false;
    }
    const selfSyncMc = this;
    this.setData(payload, function () {
      if (latestConfig.mode === 'manual' && selfSyncMc.data.autoSyncWhitelisted) {
        selfSyncMc.updateTeamGroupWidth(true);
        selfSyncMc._liveWsTeardownForManualMode();
      }
      if (sportType === SPORT_FOOTBALL || sportType === SPORT_BADMINTON) {
        selfSyncMc._initProScoreboardMovableLayout();
      }
      selfSyncMc._updateLiveWsoTitle(latestConfig, sportType);
    });
    app.globalData.matchConfig = latestConfig;
    wx.setStorageSync('matchConfig', latestConfig);
    if (sportType === SPORT_FOOTBALL) {
      this._startFootballLocalClock();
    } else {
      this._stopFootballLocalClock();
    }
  },
  /**
   * WSO：直播页动态标题，包含赛名、队名、运动类型等搜索关键词。
   * 由于 live 页使用 custom 导航栏，标题对用户视觉不可见，但爬虫可索引。
   * @param {object} mc matchConfig
   * @param {string} sport 运动类型
   */
  _updateLiveWsoTitle: function (mc, sport) {
    try {
      var sportMap = { basketball: '篮球', football: '足球', badminton: '羽毛球' };
      var sportLabel = sportMap[sport] || '篮球';
      var matchName = (mc && mc.matchName) || '';
      var teamA = (mc && mc.teamA && mc.teamA.name) || '';
      var teamB = (mc && mc.teamB && mc.teamB.name) || '';
      var title = '比赛记分直播 - 高光记分';
      if (matchName && teamA && teamB) {
        title = matchName + ' ' + teamA + 'vs' + teamB + ' - ' + sportLabel + '比赛记分直播';
      } else if (teamA && teamB) {
        title = teamA + 'vs' + teamB + ' ' + sportLabel + '比赛记分 - 高光记分';
      } else if (matchName) {
        title = matchName + ' - ' + sportLabel + '比赛记分直播';
      }
      wx.setNavigationBarTitle({ title: title });
    } catch (e) {
      // WSO 标题设置失败不影响直播核心功能
    }
  },
  /**
   * 估算足球/羽毛球紧凑记分牌宽度（px）。
   * @param {number} areaW 窗口宽
   * @returns {number}
   */
  /** @region LIVE_SCOREBOARD — 足球/羽毛球浮层记分牌与赛名条 */
_estimateProScoreboardWidthPx: function (areaW) {
    var ww = Math.max(1, Number(areaW) || 375);
    var sport = normalizeSportType(this.data.sportType);
    if (sport === SPORT_BADMINTON) {
      var mc = this.data.matchConfig || {};
      var isScoreEnabled = mc.sportConfig ? mc.sportConfig.isScoreEnabled !== false : true;
      var nameA = mc.teamA && mc.teamA.name ? String(mc.teamA.name) : '';
      var nameB = mc.teamB && mc.teamB.name ? String(mc.teamB.name) : '';
      var maxNameLen = Math.max(
        Math.min(nameA.length, 8) || 1,
        Math.min(nameB.length, 8) || 1
      );
      var nameRpx = Math.min(145, Math.max(18, maxNameLen * 14 + 8));
      var totalRpx = isScoreEnabled ? nameRpx + 34 + 40 + 14 : nameRpx + 14;
      return Math.max(isScoreEnabled ? 72 : 52, Math.round(totalRpx * ww / 750));
    }
    return Math.max(72, Math.round(168 * ww / 750));
  },
  /**
   * 估算足球/羽毛球紧凑记分牌高度（px，不含独立赛名浮层）。
   * @param {number} areaW 窗口宽
   * @returns {number}
   */
  _estimateProScoreboardHeightPx: function (areaW) {
    var ww = Math.max(1, Number(areaW) || 375);
    var sport = normalizeSportType(this.data.sportType);
    if (sport === SPORT_BADMINTON) {
      return Math.max(36, Math.round(75 * ww / 750));
    }
    return Math.max(24, Math.round(40 * ww / 750));
  },
  /**
   * 赛名浮层内容条宽度（px）：取景区宽 1/3。
   * @param {number} stageW 取景区宽
   * @returns {number}
   */
  _estimateProMatchNameBarWidthPx: function (stageW) {
    var sw = Math.max(1, Number(stageW) || 375);
    return Math.max(72, Math.round(sw / 2));
  },
  /**
   * 赛名浮层高度（px），与队名行高一致。
   * @param {number} areaW 窗口宽
   * @returns {number}
   */
  _estimateProMatchNameBarHeightPx: function (areaW) {
    var ww = Math.max(1, Number(areaW) || 375);
    return Math.max(14, Math.round(27 * ww / 750));
  },
  /**
   * 赛名浮层默认位置：取景区底部居中，与底边留间距。
   * @param {number} stageW 取景区宽
   * @param {number} stageH 取景区高
   * @param {number} barW 赛名条宽
   * @param {number} barH 赛名条高
   * @returns {{ x: number, y: number }}
   */
  _computeProMatchNameDefaultInStage: function (stageW, stageH, barW, barH) {
    var sw = Math.max(1, Number(stageW) || 375);
    var sh = Math.max(1, Number(stageH) || 211);
    var bw = Math.max(1, Number(barW) || 96);
    var bh = Math.max(1, Number(barH) || 18);
    var insetX = Math.max(8, Math.round(sw * 0.012));
    var bottomGap = Math.max(8, Math.round(sh * 0.055));
    var x = Math.round((sw - bw) * 0.5);
    var y = Math.round(sh - bh - bottomGap);
    x = Math.max(insetX, Math.min(sw - bw - insetX, x));
    y = Math.max(8, Math.min(sh - bh - 8, y));
    return {
      x: x,
      y: y
    };
  },
  /**
   * 计算记分牌在 16:9 取景区内的默认右上角坐标（相对取景区左上角，横屏专用）。
   * @param {number} stageW 取景区宽
   * @param {number} stageH 取景区高
   * @param {number} boardW 记分牌宽
   * @param {number} boardH 记分牌高
   * @param {number} stageScreenLeft 取景区相对屏幕左偏移
   * @param {number} stageScreenTop 取景区相对屏幕上偏移
   * @returns {{ x: number, y: number }}
   */
  _computeProScoreboardTopRightInStage: function (stageW, stageH, boardW, boardH, stageScreenLeft, stageScreenTop) {
    var sw = Math.max(1, Number(stageW) || 375);
    var sh = Math.max(1, Number(stageH) || 211);
    var bx = Math.max(1, Number(boardW) || 96);
    var by = Math.max(1, Number(boardH) || 40);
    var insetX = Math.max(2, Math.round(sw * 0.004));
    var insetY = Math.max(3, Math.round(sh * 0.005));
    var gapToCapsule = 6;
    var x = sw - bx - insetX;
    var y = insetY;
    var sLeft = Number(stageScreenLeft) || 0;
    var sTop = Number(stageScreenTop) || 0;
    try {
      if (wx.getMenuButtonBoundingClientRect) {
        var menu = wx.getMenuButtonBoundingClientRect();
        if (menu && typeof menu.left === 'number' && typeof menu.top === 'number') {
          var menuH = typeof menu.height === 'number' ? menu.height : 32;
          var menuLeftInStage = menu.left - sLeft;
          var menuTopInStage = menu.top - sTop;
          var menuBottomInStage = menuTopInStage + menuH;
          if (menuLeftInStage > sw * 0.45 && menuTopInStage < sh * 0.35 && menuBottomInStage > 0) {
            x = Math.min(x, menuLeftInStage - bx - gapToCapsule);
          }
        }
      }
    } catch (eMenu) {}
    x = Math.max(insetX, Math.min(sw - bx - insetX, x));
    y = Math.max(insetY, Math.min(sh - by - insetY, y));
    return {
      x: Math.round(x),
      y: Math.round(y)
    };
  },
  /**
   * 写入 movable-view 位置；必要时先卸载再挂载，确保 x/y 生效。
   * @param {number} x
   * @param {number} y
   * @param {number} boardW
   * @param {number} boardH
   * @param {boolean} forceRemount
   * @returns {void}
   */
  _commitProScoreboardMovablePosition: function (x, y, boardW, boardH, forceRemount) {
    var self = this;
    var patch = {
      proScoreboardViewW: Math.max(1, Math.round(boardW)),
      proScoreboardViewH: Math.max(1, Math.round(boardH))
    };
    if (forceRemount) {
      patch.proScoreboardMovableReady = false;
      this.setData(patch, function () {
        self.setData({
          proScoreboardX: x,
          proScoreboardY: y,
          proScoreboardMovableReady: true
        });
      });
      return;
    }
    patch.proScoreboardX = x;
    patch.proScoreboardY = y;
    this.setData(patch);
  },
  /**
   * 按窗口尺寸同步记分牌默认右上角布局（坐标相对 16:9 取景区）。
   * @param {boolean} resetPosition
   * @returns {void}
   */
  _syncProScoreboardCornerLayout: function (resetPosition) {
    if (!this.data.useCornerScoreboard) return;
    if (!resetPosition && this._proScoreboardUserMoved) return;
    var sysW = 375;
    var sysH = 667;
    try {
      var si = wx.getSystemInfoSync();
      sysW = si.windowWidth || sysW;
      sysH = si.windowHeight || sysH;
    } catch (eSys) {}
    var stageSize = computeLiveStage16x9SizePx(sysW, sysH);
    var stageScreen = computeLiveStage16x9RectPx(sysW, sysH);
    var boardW = this._estimateProScoreboardWidthPx(sysW);
    var boardH = this._estimateProScoreboardHeightPx(sysW);
    var point = this._computeProScoreboardTopRightInStage(stageSize.w, stageSize.h, boardW, boardH, stageScreen.left, stageScreen.top);
    this._commitProScoreboardMovablePosition(point.x, point.y, boardW, boardH, true);
  },
  /**
   * 渲染完成后用真实节点尺寸校准默认右上角位置。
   * @param {boolean} resetPosition
   * @returns {void}
   */
  _refineProScoreboardLayoutFromDom: function (resetPosition) {
    if (!this.data.useCornerScoreboard) return;
    if (!resetPosition && this._proScoreboardUserMoved) return;
    var self = this;
    try {
      wx.createSelectorQuery().in(this).select('#liveStage').boundingClientRect().select('.pro-scoreboard-container').boundingClientRect().exec(function (res) {
        var stageRect = res && res[0];
        var boardRect = res && res[1];
        if (!stageRect || !stageRect.width) return;
        var sysW = 375;
        try {
          sysW = wx.getSystemInfoSync().windowWidth || sysW;
        } catch (eW) {}
        var boardW = boardRect && boardRect.width ? Math.ceil(boardRect.width) : self._estimateProScoreboardWidthPx(sysW);
        var boardH = boardRect && boardRect.height ? Math.ceil(boardRect.height) : self._estimateProScoreboardHeightPx(sysW);
        var point = self._computeProScoreboardTopRightInStage(stageRect.width, stageRect.height, boardW, boardH, stageRect.left, stageRect.top);
        self._commitProScoreboardMovablePosition(point.x, point.y, boardW, boardH, true);
      });
    } catch (eRect) {}
  },
  /**
   * 初始化足球/羽毛球可拖动记分牌（默认 16:9 取景区右上角）。
   * @returns {void}
   */
  _initProScoreboardMovableLayout: function () {
    this._proScoreboardMovableInited = true;
    this._proScoreboardUserMoved = false;
    this._proMatchNameMovableInited = false;
    this._proMatchNameUserMoved = false;
    try {
      this._updateLiveStageLayout();
    } catch (eLayout) {}
    var self = this;
    setTimeout(function () {
      self._syncProScoreboardCornerLayout(true);
    }, 50);
    setTimeout(function () {
      self._refineProScoreboardLayoutFromDom(true);
    }, 160);
    setTimeout(function () {
      self._refineProScoreboardLayoutFromDom(true);
    }, 420);
    if (normalizeSportType(this.data.sportType) === SPORT_BADMINTON) {
      setTimeout(function () {
        self._refineProScoreboardLayoutFromDom(true);
      }, 720);
    }
    this._initProMatchNameMovableLayout();
  },
  /**
   * 足球/羽毛球记分牌拖动位置变更（原生 movable-view，仅 touch 时写回）。
   * @param {WechatMiniprogram.MovableViewChange} e
   * @returns {void}
   */
  onProScoreboardPositionChange: function (e) {
    var detail = e.detail || {};
    if (detail.source === 'friction') return;
    if (typeof detail.x !== 'number' || typeof detail.y !== 'number') return;
    if (detail.x === this.data.proScoreboardX && detail.y === this.data.proScoreboardY) return;
    this._proScoreboardUserMoved = true;
    this.setData({
      proScoreboardX: detail.x,
      proScoreboardY: detail.y
    });
  },
  /**
   * 写入赛名浮层 movable-view 位置；必要时先卸载再挂载。
   * @param {number} x
   * @param {number} y
   * @param {number} barW
   * @param {number} barH
   * @param {boolean} forceRemount
   * @returns {void}
   */
  _commitProMatchNameMovablePosition: function (x, y, barW, barH, forceRemount) {
    var self = this;
    var patch = {
      proMatchNameBarW: Math.max(1, Math.round(barW)),
      proMatchNameViewW: Math.max(1, Math.round(barW)),
      proMatchNameViewH: Math.max(1, Math.round(barH))
    };
    if (forceRemount) {
      patch.proMatchNameMovableReady = false;
      this.setData(patch, function () {
        self.setData({
          proMatchNameX: x,
          proMatchNameY: y,
          proMatchNameMovableReady: true
        });
      });
      return;
    }
    patch.proMatchNameX = x;
    patch.proMatchNameY = y;
    this.setData(patch);
  },
  /**
   * 按窗口尺寸同步赛名浮层默认底部居中布局。
   * @param {boolean} resetPosition
   * @returns {void}
   */
  _syncProMatchNameLayout: function (resetPosition) {
    if (!this.data.useCornerScoreboard) return;
    if (!resetPosition && this._proMatchNameUserMoved) return;
    var sysW = 375;
    var sysH = 667;
    try {
      var si = wx.getSystemInfoSync();
      sysW = si.windowWidth || sysW;
      sysH = si.windowHeight || sysH;
    } catch (eSys) {}
    var stageSize = computeLiveStage16x9SizePx(sysW, sysH);
    var barW = this._estimateProMatchNameBarWidthPx(stageSize.w);
    var barH = this._estimateProMatchNameBarHeightPx(sysW);
    var point = this._computeProMatchNameDefaultInStage(stageSize.w, stageSize.h, barW, barH);
    this._commitProMatchNameMovablePosition(point.x, point.y, barW, barH, true);
  },
  /**
   * 渲染完成后用真实节点尺寸校准赛名浮层位置。
   * @param {boolean} resetPosition
   * @returns {void}
   */
  _refineProMatchNameLayoutFromDom: function (resetPosition) {
    if (!this.data.useCornerScoreboard) return;
    if (!resetPosition && this._proMatchNameUserMoved) return;
    var self = this;
    try {
      wx.createSelectorQuery().in(this).select('#liveStage').boundingClientRect().select('.pro-match-name-float').boundingClientRect().exec(function (res) {
        var stageRect = res && res[0];
        var barRect = res && res[1];
        if (!stageRect || !stageRect.width) return;
        var sysW = 375;
        try {
          sysW = wx.getSystemInfoSync().windowWidth || sysW;
        } catch (eW) {}
        var barW = barRect && barRect.width ? Math.ceil(barRect.width) : self._estimateProMatchNameBarWidthPx(stageRect.width);
        var barH = barRect && barRect.height ? Math.ceil(barRect.height) : self._estimateProMatchNameBarHeightPx(sysW);
        var point = self._computeProMatchNameDefaultInStage(stageRect.width, stageRect.height, barW, barH);
        self._commitProMatchNameMovablePosition(point.x, point.y, barW, barH, true);
      });
    } catch (eRect) {}
  },
  /**
   * 初始化足球/羽毛球可拖动赛名浮层。
   * @returns {void}
   */
  _initProMatchNameMovableLayout: function () {
    this._proMatchNameMovableInited = true;
    this._proMatchNameUserMoved = false;
    var self = this;
    setTimeout(function () {
      self._syncProMatchNameLayout(true);
    }, 60);
    setTimeout(function () {
      self._refineProMatchNameLayoutFromDom(true);
    }, 180);
    setTimeout(function () {
      self._refineProMatchNameLayoutFromDom(true);
    }, 440);
  },
  /**
   * 足球/羽毛球赛名浮层拖动位置变更。
   * @param {WechatMiniprogram.MovableViewChange} e
   * @returns {void}
   */
  onProMatchNamePositionChange: function (e) {
    var detail = e.detail || {};
    if (detail.source === 'friction') return;
    if (typeof detail.x !== 'number' || typeof detail.y !== 'number') return;
    if (detail.x === this.data.proMatchNameX && detail.y === this.data.proMatchNameY) return;
    this._proMatchNameUserMoved = true;
    this.setData({
      proMatchNameX: detail.x,
      proMatchNameY: detail.y
    });
  },
  /**
   * 切换当前活跃场次：同步 sportType、UI 与足球计时。
   * @param {object} match 目标场次
   * @returns {boolean} 是否切换成功
   */
  applyMatchSwitchConfig: function (match) {
    if (!match || !match.teamA || !match.teamB) return false;
    if (!match.teamA.name || !match.teamB.name) {
      wx.showToast({
        title: '该比赛队名不完整',
        icon: 'none'
      });
      return false;
    }
    this._stopFootballLocalClock();
    this._persistFootballClock();
    wx.setStorageSync('currentMatchId', match.id);
    app.globalData.currentMatchId = match.id;
    this._routeSportType = null;
    const normalizedConfig = this.normalizeMatchConfig(match);
    if (match.id != null) normalizedConfig.id = match.id;
    const sportType = normalizeSportType(normalizedConfig.sportType);
    normalizedConfig.sportType = sportType;
    app.globalData.matchConfig = normalizedConfig;
    wx.setStorageSync('matchConfig', normalizedConfig);
    const sportUi = this.buildSportUiPatch(normalizedConfig, sportType);
    const wSide = this.computeTeamGroupWidthPx();
    const selfSwitch = this;
    this.setData({
      matchConfig: normalizedConfig,
      sportType: sportType,
      teamGroupWidthPxA: wSide,
      teamGroupWidthPxB: wSide,
      footballTimeText: formatWxsMainText(this._computeFootballElapsedFromStored(normalizedConfig)),
      ...sportUi
    }, function () {
      selfSwitch.updateTeamGroupWidth(true);
      if (sportType === SPORT_FOOTBALL) {
        selfSwitch._startFootballLocalClock();
      }
      if (sportType === SPORT_FOOTBALL || sportType === SPORT_BADMINTON) {
        selfSwitch._initProScoreboardMovableLayout();
      }
    });
    return true;
  },

  /**
   * 将权益到期时间格式化为本地可读字符串。
   * @param {unknown} expireRaw
   * @returns {string}
   */
  formatExpireForDisplay: function (expireRaw) {
    const ms = parseExpireAtToMs(expireRaw);
    if (Number.isNaN(ms)) {
      return typeof expireRaw === 'string' || typeof expireRaw === 'number' ? String(expireRaw) : '';
    }
    const d = new Date(ms);
    const pad = n => `${n}`.padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },
  /**
   * 解析 check-status 响应，得到是否允许进入直播与拦截文案。
   * @param {unknown} body
   * @returns {{ allow: boolean, title: string, sub: string, minor: string, showRetry: boolean }}
   */
  /** @region LIVE_ENTITLEMENT — VIP 权益、直播门禁、camera 准入 */
buildVipGateStateFromCheckStatus: function (body) {
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
    const res = /** @type {Record<string, unknown>} */body;
    if (res.code !== 0 || !res.data || typeof res.data !== 'object') {
      const msg = typeof res.message === 'string' && res.message.length > 0 ? res.message : '权益校验失败';
      return deny('权益续杯', msg, '', true);
    }
    const d = /** @type {Record<string, unknown>} */res.data;
    const isVip = d.isVip === true;
    const expireRaw = d.expireAt !== undefined && d.expireAt !== null ? d.expireAt : d.expire_at;
    if (isVip) {
      return {
        allow: true,
        title: '',
        sub: '',
        minor: '',
        showRetry: false
      };
    }
    const expMs = parseExpireAtToMs(expireRaw);
    if (expireRaw == null || expireRaw === '' || Number.isNaN(expMs)) {
      return deny('权益续杯', '尚未获得试用期', '完成登录或邀请好友成功登录可获得试用与续期', false);
    }
    const now = Date.now();
    if (expMs < now) {
      return deny('权益续杯', '权益已到期，邀请好友完成登录可续期 7 天（邀请多位，可累加）', `到期时间：${this.formatExpireForDisplay(expireRaw)}`, false);
    }
    return deny('权益续杯', '当前账号暂不可使用直播功能', `参考到期时间：${this.formatExpireForDisplay(expireRaw)}`, true);
  },
  /**
   * 调用服务端校验权益；拒绝时收起相机并展示引导层。
   * @param {function(): void} [onAllowed] 仅在 isVip 为 true 时调用
   * @returns {void}
   */
  refreshLiveEntitlementAndResume: function (onAllowed) {
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
    this.setData({
      liveEntitlementChecking: true
    });
    get('/api/auth/check-status', {}, {}).then(body => {
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
      const cameraAlreadyHealthy = this.data.liveStreamAllowed && this.data.cameraMounted && !!this.data.cameraContext && this._cameraInitDone && !this.data.isRecovering;
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
          this._entitlementEverAllowedInSession = true;
          if (app.globalData) app.globalData.liveEntitlementPassed = true;
          this.armLiveCameraLock();
          if (typeof onAllowed === 'function') onAllowed();
          const queued = this._entitlementOnAllowedQueue.splice(0, this._entitlementOnAllowedQueue.length);
          queued.forEach(fn => {
            try {
              fn();
            } catch (e) {}
          });
        });
        this._entitlementChecking = false;
        return;
      }
      this.rebuildCameraComponent(generation => {
        this.remountCameraComponent({
          generation,
          extraData: {
            liveEntitlementChecking: false,
            liveStreamAllowed: true,
            showVipGate: false,
            vipGateTitle: '',
            vipGateSubtext: '',
            vipGateMinor: '',
            vipGateRetryVisible: false
          },
          onMounted: () => {
            this._entitlementEverAllowedInSession = true;
            if (app.globalData) app.globalData.liveEntitlementPassed = true;
            this.armLiveCameraLock();
            if (typeof onAllowed === 'function') {
              onAllowed();
            }
            const queued = this._entitlementOnAllowedQueue.splice(0, this._entitlementOnAllowedQueue.length);
            queued.forEach(fn => {
              try {
                fn();
              } catch (e) {}
            });
          }
        });
      });
      this._entitlementChecking = false;
    }).catch(() => {
      if (this._entitlementEverAllowedInSession) {
        this.setData({
          liveEntitlementChecking: false
        });
        if (typeof onAllowed === 'function') {
          try {
            onAllowed();
          } catch (eCb) {}
        }
        const queued = this._entitlementOnAllowedQueue.splice(0, this._entitlementOnAllowedQueue.length);
        queued.forEach(fn => {
          try {
            fn();
          } catch (e) {}
        });
        this._entitlementChecking = false;
        return;
      }
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
  onVipGateRetryTap: function () {
    this.refreshLiveEntitlementAndResume(() => {
      this._liveCoreOnShowAfterEntitlement();
    });
  },
  /**
   * 权益门：跳转「我的」登录。
   * @returns {void}
   */
  onVipGateSwitchMine: function () {
    wx.switchTab({
      url: '/pages/mine/mine'
    });
  },
  /**
   * 拦截权益层下意外滚动穿透。
   * @returns {void}
   */
  onVipGateCatchMove: function () {},
  /**
   * 恢复遮罩层吞掉触摸移动，避免穿透到记分手势。
   * @returns {void}
   */
  noopCatchMove: function () {},
  /**
   * 阻止卡片内点击冒泡到根（预留）。
   * @returns {void}
   */
  stopVipGateInnerBubble: function () {},
  /**
   * 标记为“仅允许长按重启”的故障态，禁止状态灯单击动作。
   * @param {string} reason
   * @returns {void}
   */
  markNeedManualRelaunch: function (reason) {
    if (this._needManualRelaunch) return;
    this._needManualRelaunch = true;
    this._manualRelaunchReason = String(reason || 'unknown');
    this.appendHealthLog('manual_relaunch_required', {
      reason: reason || 'unknown',
      diag: this.getLiveRollingDiagSnapshot({})
    });
    this.updatePipelineHealth();
  },
  /**
   * 解析高光条目的创建时间（兼容 createdAt 缺失/脏数据场景，避免误删最新片段）。
   * @param {Record<string, unknown>} item
   * @returns {number}
   */
  resolveHighlightCreatedAt: function (item) {
    if (!item || typeof item !== 'object') return 0;
    const rawCreatedAt = item.createdAt;
    if (typeof rawCreatedAt === 'number' && Number.isFinite(rawCreatedAt) && rawCreatedAt > 0) {
      return rawCreatedAt;
    }
    const rawId = item.id != null ? String(item.id) : '';
    const parsedFromId = Number(rawId);
    if (Number.isFinite(parsedFromId) && parsedFromId > 0) return parsedFromId;
    return 0;
  },
  /**
   * 配额熔断：在明确文件配额耗尽时暂停自动滚动录制，避免进入 hard recover 循环风暴。
   * @param {string} reason
   * @param {string} [errMsg]
   * @returns {void}
   */
  activateFileQuotaCircuitBreaker: function (reason, errMsg) {
    const now = Date.now();
    const holdMs = 45 * 1000;
    const until = this._fileQuotaCircuitUntil || 0;
    if (until > now) {
      this.appendHealthLog('file_quota_circuit_already_open', {
        reason: reason || 'unknown',
        remainMs: until - now
      });
      return;
    }
    this._fileQuotaCircuitUntil = now + holdMs;
    this.appendHealthLog('file_quota_circuit_open', {
      reason: reason || 'unknown',
      holdMs,
      errMsg: errMsg || ''
    });
    this.rollingActive = false;
    this.startRecordFailStreak = 0;
    this.segmentStartFailStormCycles = 0;
    this.lastRecordStartAt = 0;
    this.setData({
      isRecording: false
    });
    this.markNeedManualRelaunch('file_quota_exhausted');
    try {
      wx.showToast({
        title: '存储已满，已暂停自动录制',
        icon: 'none',
        duration: 2400
      });
    } catch (eToast) {}
  },
  /**
   * 权益已通过但页面重进时，确保 camera 已挂载（避免跳过 refresh 导致永久黑屏）。
   * @param {function(): void} [onReady]
   * @returns {void}
   */
  _ensureLiveCameraReady: function (onReady) {
    const done = typeof onReady === 'function' ? onReady : function () {};
    if (!this._entitlementEverAllowedInSession && !this.data.liveStreamAllowed) {
      this.refreshLiveEntitlementAndResume(done);
      return;
    }
    const patch = {
      liveStreamAllowed: true,
      liveEntitlementChecking: false,
      showVipGate: false,
      vipGateTitle: '',
      vipGateSubtext: '',
      vipGateMinor: '',
      vipGateRetryVisible: false
    };
    const cameraOk = this.data.cameraMounted && !!this.data.cameraContext;
    if (cameraOk) {
      this.setData(patch, done);
      return;
    }
    if (this._cameraMountInFlight || this._cameraRebuildLock) {
      this.setData(patch, () => {
        const waitMount = () => {
          if (!this._livePageVisible) return;
          if (this._cameraMountInFlight || this._cameraRebuildLock) {
            setTimeout(waitMount, 220);
            return;
          }
          if (this.data.cameraMounted && this.data.cameraContext) {
            done();
            return;
          }
          this._ensureLiveCameraReady(onReady);
        };
        waitMount();
      });
      return;
    }
    this.setData(patch, () => {
      this.rebuildCameraComponent(generation => {
        if (!this._livePageVisible) return;
        this.remountCameraComponent({
          generation,
          onMounted: () => done()
        });
      });
    });
  },
  /**
   * onShow 中在权益通过后执行的相机与滚动分段恢复逻辑。
   * @returns {void}
   */
  _liveCoreOnShowAfterEntitlement: function () {
    /**
     * kickoff 级 severe：`{@link _liveSevereKickoffPruneDone}` 避免同一会话内重复做 rolling 急救；
     * `{@link _liveStorageEntryModalShown}` 仅控制 Modal，勿在每次 onShow 清零 Modal 门闩（否则反复打断）。
     * 注意：已保存高光不在 kickoff 路径自动按条删除（见 `freeRollingFileStorageAggressive`）。
     */
    /**
     * 权益通过后立刻用首页/他处已写入的 globalData 试弹一次严重水位框，勿等待 stopRecord 链路上的异步探测
     * （stopRecord 偶发迟回调会导致 kickoff 探测永远不跑）。
     */
    this.maybeToastFileStoragePressureFromGlobal();
    this.resetViewModeToNormal();

    // 提前重置健康标记，避免清理期间状态灯闪烁
    this.lastSegmentAt = Date.now();
    this.lastRecordStartAt = 0;
    this.startRecordFailStreak = 0;
    this.segmentStartFailStormCycles = 0;
    this.startHealthMonitor();
    const hasReadGuide = wx.getStorageSync('hasReadGuide');
    if (!hasReadGuide) {
      const patch = {
        showGuide: true
      };
      if (!this.data.showGuide) {
        patch.guideSubStep = 0;
      }
      this.setData(patch);
    }

    /** 权限仅在用户主动导出等操作时申请；onShow 不再 wx.authorize，避免反复弹系统授权框。 */
    wx.getSetting({
      success: res => {
        const hasRecord = !!(res.authSetting && res.authSetting['scope.record']);
        const albumGranted = !!(res.authSetting && res.authSetting['scope.writePhotosAlbum']);
        if (!hasRecord || !albumGranted) {
          this.appendHealthLog('live_scope_pending', {
            hasRecord: hasRecord,
            albumGranted: albumGranted
          });
        }
      }
    });
    wx.setKeepScreenOn({
      keepScreenOn: true,
      fail: () => {
        setTimeout(() => wx.setKeepScreenOn({
          keepScreenOn: true
        }), 1000);
      }
    });
    if (wx.setPageOrientation) {
      wx.setPageOrientation({
        orientation: 'landscape'
      });
    }
    this.stopRollingRecording(() => {
      this.ensureRollingDir().then(() => this.clearStaleRollingFiles()).then(() => {
        try {
          this.pruneHighlightClipsWithInvalidFiles('on_show_kickoff');
          const clipsMapKick = clipsStorage.readClipsMapSafe();
          if (clipsMapKick) {
            const deadRm = clipsStorage.pruneUnplayableClipsFromMap(clipsMapKick);
            if (deadRm > 0) {
              clipsStorage.writeClipsMapSafe(clipsMapKick);
            }
          }
          clipsStorage.pruneUnplayableLegacyList();
        } catch (ePrune) {}
        this.pruneSandboxOrphanMediaForQuota('on_show_kickoff');
        return this.probeLiveSandboxStorage('kickoff', true);
      }).finally(() => {
        try {
          clipsStorage.pruneUnplayableLegacyList();
        } catch (ePrune) {}
        // 必须在入场清理完全结束后，再赋予录制活跃状态与标记就绪
        this.rollingActive = true;
        this.rollingSessionId += 1;
        const sessionIdForRolling = this.rollingSessionId;
        if (this._recorderCore) {
          // 显式通知状态机脱离 idle 死锁，进入 ready
          this._recorderCore.markReady('on_show_kickoff');
        }
        if (this._rollingKickoffTimer) {
          clearTimeout(this._rollingKickoffTimer);
          this._rollingKickoffTimer = null;
        }
        if (this._cameraInitDone) {
          this.tryStartRollingWhenCameraReady('on_show_kickoff');
        } else {
          this._rollingKickoffTimer = setTimeout(() => {
            this._rollingKickoffTimer = null;
            if (!this.rollingActive || sessionIdForRolling !== this.rollingSessionId) {
              return;
            }
            this.tryStartRollingWhenCameraReady('on_show_kickoff_deferred');
          }, 1800);
        }
        if (this._rollingStartPendingBeforeKickoff && this._cameraInitDone) {
          this._rollingStartPendingBeforeKickoff = false;
          this.tryStartRollingWhenCameraReady('kickoff_after_early_camera_init');
        }
        this._scheduleRollingKickoffWatchdog(sessionIdForRolling);
      });
    });
    if (this.data.drawerMode === 1) {
      this.refreshDrawerHighlights();
    }
    if (wx.nextTick) {
      wx.nextTick(() => this.updateTeamGroupWidth(true));
    } else {
      setTimeout(() => this.updateTeamGroupWidth(true), 0);
    }
    /**
     * 小程序进后台再回前台（如切换抖音开播）后，部分机型 camera 组件不触发 bindinitdone；
     * 超时仍未就绪则强制重建并绑定本页 CameraContext。
     */
    if (this._cameraShowInitWatchTimer) {
      clearTimeout(this._cameraShowInitWatchTimer);
      this._cameraShowInitWatchTimer = null;
    }
    const selfWatch = this;
    const scheduleCameraInitWatchdog = delayMs => {
      if (selfWatch._cameraShowInitWatchTimer) {
        clearTimeout(selfWatch._cameraShowInitWatchTimer);
        selfWatch._cameraShowInitWatchTimer = null;
      }
      selfWatch._cameraShowInitWatchTimer = setTimeout(() => {
        selfWatch._cameraShowInitWatchTimer = null;
        if (!selfWatch._livePageVisible || !selfWatch.data.liveStreamAllowed) return;
        if (selfWatch.data.showGuide) return;
        if (!selfWatch.data.cameraMounted || selfWatch.data.isRecovering) return;
        if (selfWatch._cameraInitDone) return;
        if (selfWatch._cameraMountInFlight || selfWatch._cameraRebuildLock) {
          scheduleCameraInitWatchdog(2000);
          return;
        }
        const remountAgo = Date.now() - (selfWatch._lastCameraRemountAt || 0);
        if (remountAgo >= 0 && remountAgo < 6500) {
          scheduleCameraInitWatchdog(6500 - remountAgo);
          return;
        }
        selfWatch.appendHealthLog('camera_init_watchdog_rebuild', {});
        selfWatch.armNativeEnhanceModeRestoreAfterCameraRebuild('camera_init_watchdog');
        selfWatch.rebuildCameraComponent(generation => {
          if (!selfWatch._livePageVisible || !selfWatch.data.liveStreamAllowed) return;
          selfWatch.remountCameraComponent({
            generation
          });
        });
      }, delayMs);
    };
    scheduleCameraInitWatchdog(4500);
  },
  // 辅助变量
  lastSetZoomTime: 0,
  suppressScoreTap: false,
  /**
   * 滚动录制单段时长（毫秒）。8s 单段体积更小，在约 200MB 本机文件配额下可保留更多段/更多次高光；
   * 高光「体感窗口」仍由 {@link highlightPlaybackWindowMs} 控制（默认 8s）。
   */
  /** 乒乓录制单段时长（毫秒）：45s 母片（720p@3600kbps 约 19MB），双轨 maxFiles=2 峰值约 39MB。 */
  pingPongChunkDurationMs: 45000,
  /** 双轨重叠（毫秒）：B 在 A 结束前 8s 启动；45s 段下重叠约 18%，满足 8s 高光窗口。 */
  pingPongStaggerMs: 8000,
  /** 720p 滚动录制目标码率（kbps）；低于默认 4800 以减轻落盘体积与配额压力。 */
  pingPongVideoBitsPerSecondKbps: 3600,
  /** 后台 MediaRecorder 目标帧率上限（预热测速后取 min(实测, 24) 写入编码器，保证 1.0x 播放）。 */
  pingPongRecordFps: 24,
  /** 后台录制离屏 canvas 目标宽（低端 Android 在 onLoad 前已按档位初始化）。 */
  pingPongRecordCanvasWidth: INITIAL_RECORD_PROFILE.canvasWidth || 1280,
  /** 后台录制离屏 canvas 目标高。 */
  pingPongRecordCanvasHeight: INITIAL_RECORD_PROFILE.canvasHeight || 720,
  /** 滚动目录最多保留母片数量（720p@3600 下 45s 单段约 19MB，2 段峰值约 39MB）。 */
  pingPongRollingMaxFiles: 2,
  /** 高光强制 flush 最小间隔（毫秒），抑制连按引发 iOS 601。 */
  pingPongHighlightFlushMinIntervalMs: 10000,
  segmentDurationMs: 45000,
  /** 用户点击保存后，回放时希望覆盖的精彩窗口长度（毫秒），可与物理切片时长解耦 */
  highlightPlaybackWindowMs: 8000,
  /** 时间驱动高光窗口：保存点击前过去 8s，不等待未来片段。 */
  highlightLeadMs: 8000,
  highlightTailMs: 0,
  /**
   * stopRecord 与下一段 startRecord 之间的冷却；过短易在部分机型引发句柄未释放。
   * 略缩短可减小墙钟「真空」与状态灯 PAUSE 体感，需与稳定性平衡。
   */
  recordCooldownAfterStopMs: 380,
  /** 高光点击后执行 stopRecord 的最小时长门槛（毫秒），避免刚起录即 stop 在部分机型失败 */
  minRecordMsBeforeHighlightStop: 1300,
  segmentStopTimer: null,
  rollingWatchdogTimer: null,
  segmentWatchdogTimer: null,
  segmentCounter: 0,
  pendingHighlight: null,
  /** 为 true 时 UI 锁需等待 finalize 与下一段 startRecord 成功两道闸门 */
  _highlightSaveAwaitingResume: false,
  _highlightPipelineDoneFinalize: false,
  _highlightPipelineDoneResume: false,
  /** 当前等待恢复录制的会话 id；避免清空 meta 后无法释放保存锁 */
  _highlightSaveSessionId: 0,
  _highlightResumeGuardTimer: null,
  _highlightSaveHardTimeoutTimer: null,
  _highlightDeferredStopTimer: null,
  /** {@link startHighlightSaveProgressAnim} 的轮询 id */
  _highlightSaveProgressTimer: null,
  /** 保存高光期间若用户点了回放，暂存条目，待 {@link endHighlightSaving} 后再真正进入回放 */
  _replayDeferredItem: null,
  /** indexed 滚动母片需等固化完成后再回放（全平台） */
  _replayDeferredMaterializeItem: null,
  _replayMaterializeWaitTimer: null,
  /** 回放期间 materialize 队列 defer 轮询 timer */
  _highlightMaterializeReplayDeferTimer: null,
  /** 回放期间是否已降低 CFR 喂帧 */
  _replayRecordingCfrThrottled: false,
  /** 进入回放前记录的 CFR fps，退出后恢复 */
  _replaySavedEncoderFps: 0,
  _highlightRequestLock: false,
  /**
   * 画质档位切换防抖截止时间（ms 时间戳）；此前拦截工具条连点，减轻 VK 与 camera 互切黑屏。
   * @type {number}
   */
  _enhanceModeSwitchGuardUntil: 0,
  /** 原生画质：零帧自愈后应 setMode 的目标档位（off|lite|standard|strong） */
  _pendingEnhanceModeAfterRecover: null,
  /** 相机硬恢复/看门狗重建后应恢复的原生增强档位（off|lite|standard|strong）。 */
  _pendingEnhanceModeAfterCameraRebuild: null,
  /** {@link onEnhanceModePick} 安排的零帧检测定时器 */
  _enhanceZeroFrameRecoverTimer: null,
  /** MOD: 时间驱动 rolling 素材池，仅记录 temp 文件和墙钟区间，不复制到本地 rolling 目录。 */
  rollingSegments: [],
  /** 兼容旧清理/诊断代码的别名，核心高光逻辑只读 `rollingSegments`。 */
  segmentBuffer: [],
  rollingActive: false,
  rollingSessionId: 0,
  lastHighlightRequestAt: 0,
  lastHighlightSignature: '',
  lastSegmentAt: 0,
  lastRecordStartAt: 0,
  startRecordFailStreak: 0,
  /** ReplayBuffer 热层按时间保留最近 45s；此数量仅作兼容兜底。 */
  rollingBufferMax: 15,
  replayBufferWindowMs: REPLAY_BUFFER_WINDOW_MS,
  /** 兼容旧看门狗字段；时间驱动 rolling 不再做热层落盘。 */
  rollingFsBusy: false,
  /**
   * 并行落盘会话数；与 {@link rollingFsBusy} 同步（>0 即 busy）。
   * 兼容旧诊断字段；时间驱动 rolling 下通常保持为 0。
   * @type {number}
   */
  _rollingPersistInFlight: 0,
  /**
   * 兼容旧调度字段；时间驱动 rolling 下不再由热层落盘写入。
   * @type {number}
   */
  _postUserLocalPersistCooldownMs: 0,
  /** 进入回放前 REPLAY 全屏转场总时长（需与 WXSS 中 replayBadgeMotion 时长一致） */
  replayIntroDurationMs: 520,
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
  /** onHide 时优先冲刷未固化高光，降低 tmp 被系统回收后索引悬空 */
  _highlightMaterializeUrgentOnHide: false,
  /** 回放等待固化时提升 materialize 优先级（indexed 滚动母片须 materialized 才可播）。 */
  _highlightMaterializeUrgentForReplay: false,
  /** 高光异步固化执行中标记。 */
  highlightMaterializeRunning: false,
  /** 当前正在固化的高光 id（防 prune 误删 indexed 条目）。 */
  _highlightMaterializeCurrentId: '',
  /** 存储水位级别：0/70/85/95。 */
  storageWatermarkLevel: 0,
  /** 高光实体最大保留条数（>=30 条实战需求；超出淘汰最旧项）。 */
  highlightsMaxCount: 100,
  /** 紧急清理时全局至少保留的高光条数（720p 大分段下 30 条会占满沙盒，故下调）。 */
  highlightsEmergencyMinKeepCount: 5,
  /** persist 失败且需突破 minKeep 时的硬下限（条数 ≤ 该值时不再删高光，仅清 rolling）。 */
  highlightsEmergencyHardFloor: 3,
  /** 连续 GC 无释放计数，用于避免「高光删不动」误熔断。 */
  _persistIoFailGcStreak: 0,
  /** 最近一次 rolling GC 删除的文件数（诊断用）。 */
  _lastRollingGcFreedCount: 0,
  /** startRecord 连续失败风暴计数（每次达到 failStreak=5 记 1 次）。 */
  segmentStartFailStormCycles: 0,
  /** startOneSegment 单飞锁，防止并发 startRecord 导致状态错乱。 */
  _startOneSegmentInFlight: false,
  /** startOneSegment 的延迟重试 timer（同一时刻仅允许一个）。 */
  _segmentStartRetryTimer: null,
  /** 处理 `is recording` 冲突时的恢复锁，避免并发 stopRecord。 */
  _segmentStartRecoveringFromIsRecording: false,
  /** 处理 `operate fail` 时的受控恢复锁，避免并发 stop/start 与硬恢复。 */
  _segmentStartRecoveringFromOperateFail: false,
  /** 连续 rolling temp 丢失计数（用于触发软恢复熔断）。 */
  _rollingTempMissingStreak: 0,
  /** 连续出现“temp 终态丢失”计数，超过阈值触发硬恢复。 */
  _rollingTempTerminalFailStreak: 0,
  /** temp missing 硬恢复连续未产出有效 chunk 的轮次，用于阻断恢复风暴。 */
  _tempMissingHardRecoverCycles: 0,
  /** 最近一次 chunk 成功入 ReplayBuffer 的墙钟时间（ms）。 */
  _lastSuccessfulChunkAt: 0,
  /** 最近一次 startRecord operate fail 的时间戳；与 temp 丢失联合判定 camera 真故障。 */
  _lastSegmentOperateFailAt: 0,
  /** Segment Watchdog 软恢复单飞锁，避免长时间无段时重复 stop/start。 */
  _segmentWatchdogRecovering: false,
  /** Segment Watchdog 最近一次软恢复时间戳，用于恢复冷却。 */
  _lastSegmentWatchdogRecoverAt: 0,
  // 已合并至文件后部 onUnload：此处不再重复定义，避免后项覆盖导致事件未解绑。

  onPeriodLongPress: function () {
    const self = this;
    if (!this.data.autoSyncWhitelisted) {
      return;
    }
    const items = this.data.isAutoMode ? ['恢复手动记分'] : ['切换至自动记分'];
    wx.showActionSheet({
      itemList: items,
      itemColor: this.data.isAutoMode ? '#FF4D4F' : '#4ADE80',
      success: res => {
        if (res.tapIndex === 0) {
          const nextMode = !self.data.isAutoMode;
          if (nextMode && !self.data.liveWsConnected) {
            self._liveWsOpenPanelPrefilled();
            return;
          }
          if (!nextMode) {
            self._liveWsPreferAutoAfterConnect = false;
            self._liveWsFlushScorePersist();
          }
          self.setData({
            isAutoMode: nextMode
          }, () => {
            self.updateTeamGroupWidth(true);
            if (nextMode) {
              self._liveWsRefreshWxsClockDriver();
            } else {
              self._liveWsTeardownForManualMode();
            }
          });
          wx.showToast({
            title: nextMode ? '已切换至自动模式' : '已恢复手动模式',
            icon: 'none'
          });
        }
      }
    });
  },
  /**
   * 初始化直播健康日志缓冲。
   * 设备信息只采集一次存入 header，避免每条 log 都重复写相同字段浪费体积。
   * @returns {void}
   */
  /** @region LIVE_HEALTH — 健康日志、审计导出 */
initHealthLogs: function () {
    this._healthLogStorageKey = 'LIVE_HEALTH_LOGS_V1';
    this._healthLogFlushTimer = null;
    this._persistIoFailGcStreak = 0;
    this._lastRollingGcFreedCount = 0;
    try {
      LIVE_AUDIT.resetAuditSession();
    } catch (eAuditReset) {/* ignore */}
    this._healthLogs = [];
    try {
      wx.removeStorageSync(this._healthLogStorageKey);
    } catch (eClear) {/* ignore */}
    try {
      const sys = wx.getSystemInfoSync();
      this._healthLogDevice = {
        model: String(sys.model || ''),
        brand: String(sys.brand || ''),
        platform: String(sys.platform || ''),
        wxVersion: String(sys.version || ''),
        system: String(sys.system || ''),
        /** 小程序基础库版本，与接口文档 `device.libVersion` 对齐 */
        libVersion: String(sys.SDKVersion || '')
      };
    } catch (e) {
      this._healthLogDevice = {};
    }
    this.appendHealthLog('page_load', {});
  },
  /**
   * 将关键健康日志事件镜像到审计 RingBuffer（独立于 health log 落盘策略）。
   * @param {string} eventName 事件名
   * @param {Record<string, unknown>} [detail] 事件详情
   * @returns {void}
   */
  mirrorHealthToAudit: function (eventName, detail) {
    const ev = String(eventName || '');
    if (!ev) return;
    const prefixes = ['highlight_', 'rolling_', 'segment_', 'replay_', 'hard_recover', 'stop_record', 'temp_', 'match_switch', 'page_', 'ws_', 'vk_canvas', 'camera_', 'manual_relaunch', 'live_sandbox', 'sandbox_orphan', 'ping_pong_persist'];
    const shouldMirror = prefixes.some(p => ev.indexOf(p) === 0);
    if (!shouldMirror) return;
    try {
      LIVE_AUDIT.appendAuditLog(ev, LIVE_AUDIT.compactAuditDetail(detail || {}));
    } catch (eMirror) {/* ignore */}
  },
  /**
   * 追加一条健康日志（环形缓冲，控制体积）。
   * 每条仅存 timestamp + event + detail，设备信息统一由 header 承载。
   * @param {string} eventName 事件名
   * @param {Record<string, unknown>} [detail] 事件详情
   * @returns {void}
   */
  appendHealthLog: function (eventName, detail) {
    const item = {
      t: Date.now(),
      e: String(eventName || '?'),
      d: detail && typeof detail === 'object' ? detail : {}
    };
    this._healthLogs.push(item);
    if (this._healthLogs.length > 120) {
      this._healthLogs.splice(0, this._healthLogs.length - 120);
    }
    this.mirrorHealthToAudit(item.e, item.d);
    this.scheduleHealthLogFlush();
    const ev = item.e;

    if (ev === 'ping_pong_segment_ready') {
      this._persistIoFailGcStreak = 0;
    }

    if (ev === 'ping_pong_segment_rejected_hollow') {
      if (this.isLiveForegroundRecordingRecoverPending()) {
        this._highlightHollowFlushStreak = (this._highlightHollowFlushStreak || 0) + 1;
      }
      this._scheduleHollowPipelineRestart(item.d || {});
    }
    if (ev === 'highlight_soft_timeout_release' && this._pendingHollowPipelineRestart) {
      this._pendingHollowPipelineRestart = false;
      this._restartPreviewPipelineForHollow();
    }

    if (ev === 'hard_recover_fail' || ev === 'hard_recover_start' || ev === 'manual_relaunch_required' || ev === 'segment_start_fail_storm_cycle' || ev === 'camera_insert_conflict' || ev === 'hard_recover_skip_page_hidden' || ev === 'camera_fault_recovery_skip_page_hidden' || ev === 'stop_record_fail' || ev === 'rolling_persist_temp_gone_presync' || ev === 'segment_persist_reject_temp_unstable' || ev === 'rolling_persist_phase7_temp_missing_abort' || ev === 'highlight_finalize_no_segments' || ev === 'highlight_abort_no_fresh_rolling' || ev === 'highlight_hard_timeout_unlock' || ev === 'replay_buffer_chunk_reject' || ev === 'temp_missing_storm_hard_recover' || ev === 'temp_missing_storm_observed' || ev === 'match_switch_rolling_reset') {
      this.scheduleRemoteHealthLogUpload(ev);
    }
  },
  /**
   * 节流写入健康日志到 storage，避免频繁 IO 干扰直播。
   * @returns {void}
   */
  scheduleHealthLogFlush: function () {
    if (this._healthLogFlushTimer) return;
    this._healthLogFlushTimer = setTimeout(() => {
      this._healthLogFlushTimer = null;
      try {
        wx.setStorageSync(this._healthLogStorageKey, this._healthLogs.slice(-240));
      } catch (e) {}
    }, 1800);
  },
  /**
   * 收集 rolling / 相机管线瞬时状态，供健康日志与远程诊断上报。
   * @param {Record<string, unknown>} [extra] 与现场事件相关的附加字段
   * @returns {Record<string, unknown>}
   */
  getLiveRollingDiagSnapshot: function (extra) {
    let matchId = '';
    try {
      matchId = String(wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '');
    } catch (eMid) {
      matchId = '';
    }
    let wsSnap = null;
    try {
      if (this._liveWsClient && typeof this._liveWsClient.getDiagnosticSnapshot === 'function') {
        wsSnap = this._liveWsClient.getDiagnosticSnapshot();
      }
    } catch (eWsSnap) {
      wsSnap = null;
    }
    const base = {
      v: 1,
      matchId,
      pageVisible: !!this._livePageVisible,
      ws: wsSnap || {},
      rollingActive: !!this.rollingActive,
      rollingSessionId: this.rollingSessionId,
      segmentCounter: this.segmentCounter,
      isRecording: !!this.data.isRecording,
      rollingFsBusy: !!this.rollingFsBusy,
      rollingPersistInFlight: this._rollingPersistInFlight || 0,
      cameraInitDone: !!this._cameraInitDone,
      isRecovering: !!this.data.isRecovering,
      recoveryLock: !!this._recoveryLock,
      enhanceMode: this.data.enhanceMode || 'off',
      enhanceCanvasVisible: !!this.data.enhanceCanvasVisible,
      enhanceVkTransitioning: !!this.data.enhanceVkTransitioning,
      pipelineHealth: this.data.pipelineHealth || '',
      startRecordFailStreak: this.startRecordFailStreak,
      segmentStartFailStormCycles: this.segmentStartFailStormCycles || 0,
      lastSegmentAgeMs: this.lastSegmentAt > 0 ? Date.now() - this.lastSegmentAt : -1,
      lastSuccessfulChunkAgeMs: this._lastSuccessfulChunkAt > 0 ? Date.now() - this._lastSuccessfulChunkAt : -1,
      rollingTempTerminalFailStreak: this._rollingTempTerminalFailStreak || 0,
      postUserLocalPersistCooldownMs: this._postUserLocalPersistCooldownMs || 0,
      hasPendingHighlight: !!this.pendingHighlight,
      isSavingHighlight: !!this.data.isSavingHighlight,
      storageWatermarkLevel: this.storageWatermarkLevel || 0,
      needManualRelaunch: !!this._needManualRelaunch
    };
    return Object.assign(base, extra || {});
  },
  /**
   * 将近期健康日志异步上报服务端；**不强制登录**，无 token 仍会上报（服务端不关联 openid）。
   * @param {string} reason 触发原因（事件名或汇总标签）
   * @returns {void}
   */
  scheduleRemoteHealthLogUpload: function (reason) {
    if (this._remoteHealthLogTimer) {
      this._remoteHealthLogPendingReason = reason || this._remoteHealthLogPendingReason;
      return;
    }
    this._remoteHealthLogPendingReason = reason || 'batch';
    this._remoteHealthLogTimer = setTimeout(() => {
      this._remoteHealthLogTimer = null;
      this.flushRemoteHealthLogsNow(this._remoteHealthLogPendingReason || 'batch');
      this._remoteHealthLogPendingReason = '';
    }, 14000);
  },
  /**
   * 构造诊断接口要求的自定义 Header，与 Body `device` 一并供服务端合并入 device_json。
   * @returns {Record<string, string>}
   */
  buildDiagnosticLogHeaders: function () {
    const dev = this._healthLogDevice || {};
    const model = typeof dev.model === 'string' ? dev.model : '';
    const system = typeof dev.system === 'string' ? dev.system : '';
    const wxVer = typeof dev.wxVersion === 'string' ? dev.wxVersion : '';
    let infoJson = '{}';
    try {
      infoJson = JSON.stringify(dev);
    } catch (eJson) {
      infoJson = '{}';
    }
    if (infoJson.length > 4090) {
      infoJson = `${infoJson.slice(0, 4090)}…`;
    }
    const clientDevice = [model, system].filter(Boolean).join(' / ').slice(0, 240);
    return {
      'X-Client-Device': clientDevice || 'unknown',
      'X-Device-Info': infoJson,
      'X-Wx-Client-Version': wxVer || ''
    };
  },
  /**
   * 立即执行一次远程健康日志上报（内部由 {@link scheduleRemoteHealthLogUpload} 节流调用）。
   * 使用 skipAuth：避免诊断接口返回 401 时触发全局登出；有 token 时仍手动携带 Bearer。
   * @param {string} reason
   * @returns {void}
   */
  flushRemoteHealthLogsNow: function (reason) {
    const logs = (this._healthLogs || []).slice(-80);
    if (logs.length === 0) return;
    const device = this._healthLogDevice && typeof this._healthLogDevice === 'object' ? this._healthLogDevice : {};
    const payload = {
      at: Date.now(),
      reason: String(reason || 'unspecified'),
      device,
      diag: this.getLiveRollingDiagSnapshot({}),
      logs
    };
    const token = getToken();
    const header = this.buildDiagnosticLogHeaders();
    if (token) {
      header.Authorization = `Bearer ${token}`;
    }
    post(API_PATH_CLIENT_DIAGNOSTIC_LOG, payload, {
      skipAuth: true,
      header
    }).then(() => {}).catch(() => {});
  },
  /**
   * 同步写入直播审计导出 JSON（RingBuffer + health log + diag）。
   * @returns {{ ok: boolean, path?: string, fileName?: string, size?: number, summary?: Record<string, unknown>, healthCount?: number, error?: string }}
   */
  _prepareLiveAuditExportFile: function () {
    const dump = LIVE_AUDIT.dumpLiveAudit();
    if (!dump.count) {
      return {
        ok: false,
        error: 'empty'
      };
    }
    const compactHealthDetail = detail => {
      if (!detail || typeof detail !== 'object') return detail;
      const out = {};
      Object.keys(detail).slice(0, 28).forEach(key => {
        let val = detail[key];
        if (typeof val === 'string' && val.indexOf('wxfile://') === 0) {
          val = val.slice(-80);
        }
        out[key] = val;
      });
      return out;
    };
    const healthLogs = (this._healthLogs || []).slice(-120).map(it => ({
      t: it.t,
      e: it.e,
      d: compactHealthDetail(it.d)
    }));
    const fileResult = LIVE_AUDIT.exportAuditToFile({
      healthLogs,
      healthDevice: this._healthLogDevice || {},
      diag: this.getLiveRollingDiagSnapshot({}),
      ndjsonPath: LIVE_AUDIT.getAuditNdjsonPath()
    });
    if (!fileResult.ok || !fileResult.path) {
      return {
        ok: false,
        error: fileResult.error || 'export_fail'
      };
    }
    return Object.assign({}, fileResult, {
      healthCount: healthLogs.length
    });
  },
  /**
   * 隐藏「发送审计」按钮并清理预生成文件引用。
   * @returns {void}
   */
  _dismissAuditExportShare: function () {
    if (this._auditExportShareTimer) {
      clearTimeout(this._auditExportShareTimer);
      this._auditExportShareTimer = null;
    }
    this._pendingAuditExport = null;
    if (this.data.auditExportShareVisible) {
      this.setData({
        auditExportShareVisible: false
      });
    }
  },
  /**
   * 展示审计文件就绪弹窗（分享/保存均失败时的兜底）。
   * @param {{ fileName: string, sizeKb: number, summaryText: string, healthCount: number, path: string }} info
   * @param {string} [hint]
   * @returns {void}
   */
  _showAuditExportReadyModal: function (info, hint) {
    wx.showModal({
      title: '审计文件已生成',
      content: [info.fileName, info.sizeKb + ' KB', info.summaryText, 'health: ' + info.healthCount + ' 条', hint || '', '可搜索 highlight_trim_diagnostic 定位高光裁剪问题'].filter(Boolean).join('\n'),
      showCancel: false,
      confirmText: '知道了'
    });
  },
  /**
   * 在 **tap 手势** 内调用 wx.shareFileMessage（微信要求，longpress 无效）。
   * @param {{ path: string, fileName: string, sizeKb: number, summaryText: string, healthCount: number }} pending
   * @returns {void}
   */
  _shareLiveAuditFileNow: function (pending) {
    if (!pending || !pending.path) return;
    const showFallbackModal = (hint, errMsg) => {
      if (errMsg) {
        try {
          this.appendHealthLog('audit_export_share_fail', {
            errMsg: String(errMsg).slice(0, 120)
          });
        } catch (eLog) {/* ignore */}
      }
      this._showAuditExportReadyModal(pending, hint);
    };
    if (typeof wx.shareFileMessage !== 'function') {
      if (typeof wx.saveFileToDisk === 'function') {
        wx.saveFileToDisk({
          filePath: pending.path,
          success: () => {
            wx.showToast({
              title: '已保存到手机',
              icon: 'success'
            });
            this._dismissAuditExportShare();
          },
          fail: () => {
            showFallbackModal('当前环境不支持分享，请通过调试器取回文件');
          }
        });
        return;
      }
      showFallbackModal('当前环境不支持分享，请通过调试器取回文件');
      return;
    }
    wx.shareFileMessage({
      filePath: pending.path,
      fileName: pending.fileName,
      success: () => {
        wx.showToast({
          title: '请选择好友发送',
          icon: 'none'
        });
        this._dismissAuditExportShare();
      },
      fail: err => {
        const errMsg = err && err.errMsg ? err.errMsg : '';
        if (typeof wx.saveFileToDisk === 'function') {
          wx.saveFileToDisk({
            filePath: pending.path,
            success: () => {
              wx.showToast({
                title: '已保存到手机',
                icon: 'success'
              });
              this._dismissAuditExportShare();
            },
            fail: () => {
              showFallbackModal('分享不可用，可通过调试器取回文件', errMsg);
            }
          });
          return;
        }
        showFallbackModal('分享不可用，请通过调试器取回文件', errMsg);
      }
    });
  },
  /**
   * 长按比赛名：预生成审计 JSON 文件，并显示「发送审计」按钮。
   * wx.shareFileMessage 仅认 tap 手势，不能在 longpress 回调里直接分享（采集端用 catchtap 故可分享）。
   * @returns {void}
   */
  onPrepareLiveAuditExport: function () {
    const fileResult = this._prepareLiveAuditExportFile();
    if (!fileResult.ok || !fileResult.path) {
      wx.showToast({
        title: fileResult.error === 'empty' ? '暂无审计日志' : '导出文件失败',
        icon: 'none'
      });
      return;
    }
    const summary = fileResult.summary || {};
    this._pendingAuditExport = {
      path: fileResult.path,
      fileName: fileResult.fileName,
      sizeKb: Math.max(1, Math.round((fileResult.size || 0) / 1024)),
      summaryText: summary.total ? '共 ' + summary.total + ' 条审计' : '',
      healthCount: fileResult.healthCount || 0
    };
    this.setData({
      auditExportShareVisible: true
    });
    wx.showToast({
      title: '点击「发送审计」分享',
      icon: 'none',
      duration: 2400
    });
    if (this._auditExportShareTimer) {
      clearTimeout(this._auditExportShareTimer);
    }
    this._auditExportShareTimer = setTimeout(() => {
      this._dismissAuditExportShare();
    }, 60000);
  },
  /**
   * 点击「发送审计」：在用户 tap 手势内同步调起 wx.shareFileMessage。
   * 若尚未长按预生成，则在同一次 tap 内先写文件再立即分享。
   * @returns {void}
   */
  onTapShareLiveAuditFile: function () {
    let pending = this._pendingAuditExport;
    if (!pending || !pending.path) {
      const fileResult = this._prepareLiveAuditExportFile();
      if (!fileResult.ok || !fileResult.path) {
        wx.showToast({
          title: '导出文件失败',
          icon: 'none'
        });
        return;
      }
      const summary = fileResult.summary || {};
      pending = {
        path: fileResult.path,
        fileName: fileResult.fileName,
        sizeKb: Math.max(1, Math.round((fileResult.size || 0) / 1024)),
        summaryText: summary.total ? '共 ' + summary.total + ' 条审计' : '',
        healthCount: fileResult.healthCount || 0
      };
    }
    this._shareLiveAuditFileNow(pending);
  },
  /**
   * 保存高光的事务开始：快速反馈 + UI 锁，防止重复点击引发 I/O 冲突。
   * @returns {void}
   */
  /** @region LIVE_HIGHLIGHT_LOCK — 高光保存事务锁与进度动画 */
beginHighlightSaving: function () {
    if (this._highlightRequestLock) return;
    this._highlightRequestLock = true;
    if (this.data.isSavingHighlight) return;
    this.setData({
      isSavingHighlight: true
    });
    try {
      LIVE_AUDIT.auditHighlight('save_begin', {
        sessionId: this._highlightSaveSessionId || 0,
        rollingActive: !!this.rollingActive,
        segmentCounter: this.segmentCounter || 0
      });
    } catch (eAuditBegin) {/* ignore */}
    if (this._highlightSaveHardTimeoutTimer) {
      clearTimeout(this._highlightSaveHardTimeoutTimer);
      this._highlightSaveHardTimeoutTimer = null;
    }
    let hardTimeoutMs = Math.max(18000, Math.floor(this.segmentDurationMs * 1.6));
    try {
      const si = wx.getSystemInfoSync();
      if (si && si.platform === 'android') {
        hardTimeoutMs = Math.max(hardTimeoutMs, 56000, Math.floor(this.segmentDurationMs * 2.25) + 38000);
      }
    } catch (eHt) {}
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
  endHighlightSaving: function () {
    this._highlightRequestLock = false;
    if (this.data.isSavingHighlight) {
      this.setData({
        isSavingHighlight: false
      });
    }
    this.stopHighlightSaveProgressAnim();
    if (this._highlightSaveHardTimeoutTimer) {
      clearTimeout(this._highlightSaveHardTimeoutTimer);
      this._highlightSaveHardTimeoutTimer = null;
    }
    const deferred = this._replayDeferredItem;
    this._replayDeferredItem = null;
    if (deferred && typeof deferred === 'object') {
      /**
       * 略延迟：避免与刚结束的 stopRecord/落盘同一帧抢相机；并与 pauseRollingForReplay 真正完成对齐。
       */
      setTimeout(() => {
        if (!this._livePageVisible) return;
        this.startReplay(deferred);
      }, 320);
    }
  },
  /**
   * 停止高光保存进度环（状态灯上的低透明度 conic）。
   * @returns {void}
   */
  stopHighlightSaveProgressAnim: function () {
    if (this._highlightSaveProgressTimer) {
      clearInterval(this._highlightSaveProgressTimer);
      this._highlightSaveProgressTimer = null;
    }
    if ((this.data.highlightSaveConicEndDeg || 0) > 0) {
      this.setData({
        highlightSaveConicEndDeg: 0
      });
    }
  },
  /**
   * 在状态灯上展示从点击到本段结束（或短落地）的保存进度，无 Toast、低打扰。
   *
   * @param {number} startWallMs 进度起点墙钟（通常为点击时刻）
   * @param {number} endWallMs 进度终点墙钟（自然分段场景为当前段理论结束）
   * @returns {void}
   */
  startHighlightSaveProgressAnim: function (startWallMs, endWallMs) {
    this.stopHighlightSaveProgressAnim();
    const start = typeof startWallMs === 'number' ? startWallMs : Date.now();
    const end = typeof endWallMs === 'number' ? endWallMs : start + 600;
    /** 与硬恢复同口径：总时长随「本段剩余墙钟」变动，进度与真实等待同步 */
    const total = Math.max(120, end - start);
    const tick = () => {
      if (!this.data.isSavingHighlight) {
        this.stopHighlightSaveProgressAnim();
        return;
      }
      const t = Date.now();
      const p = Math.max(0, Math.min(1, (t - start) / total));
      /** 参照硬恢复：爬升阶段最高约 88% 圆周，满环在落盘完成时一次拉满 */
      let deg;
      if (p >= 1) {
        deg = 360;
      } else {
        const pct = Math.min(88, Math.round(p * 100));
        deg = Math.round(pct * 3.6);
      }
      this.setData({
        highlightSaveConicEndDeg: deg
      });
      if (p >= 1 && this._highlightSaveProgressTimer) {
        clearInterval(this._highlightSaveProgressTimer);
        this._highlightSaveProgressTimer = null;
      }
    };
    tick();
    this._highlightSaveProgressTimer = setInterval(tick, 100);
  },
  /**
   * 重置「截断保存」双闸门状态（出错、会话失效、页面离开时调用）。
   * @returns {void}
   */
  clearHighlightSavePipelineState: function () {
    this._highlightSaveAwaitingResume = false;
    this._highlightPipelineDoneFinalize = false;
    this._highlightPipelineDoneResume = false;
    this._highlightSaveSessionId = 0;
    if (this._highlightResumeUnlockFallbackTimer) {
      clearTimeout(this._highlightResumeUnlockFallbackTimer);
      this._highlightResumeUnlockFallbackTimer = null;
    }
    if (this._highlightResumeGuardTimer) {
      clearTimeout(this._highlightResumeGuardTimer);
      this._highlightResumeGuardTimer = null;
    }
    if (this._highlightDeferredStopTimer) {
      clearTimeout(this._highlightDeferredStopTimer);
      this._highlightDeferredStopTimer = null;
    }
  },
  /**
   * finalize 与下一段录制均完成时释放 {@link data.isSavingHighlight}。
   * @returns {void}
   */
  maybeReleaseHighlightSaveLock: function () {
    if (!this._highlightSaveAwaitingResume) return;
    if (this._highlightPipelineDoneFinalize && this._highlightPipelineDoneResume) {
      this.clearHighlightSavePipelineState();
      this.endHighlightSaving();
    }
  },
  /**
   * finalize 已完成但下一段 startRecord 迟迟未成功时，解锁保存锁并触发延迟回放，避免界面永久卡住。
   * @returns {void}
   */
  scheduleHighlightResumeUnlockFallback: function () {
    if (this._highlightResumeUnlockFallbackTimer) {
      clearTimeout(this._highlightResumeUnlockFallbackTimer);
      this._highlightResumeUnlockFallbackTimer = null;
    }
    if (!this._highlightSaveAwaitingResume || !this._highlightPipelineDoneFinalize) {
      return;
    }
    let fallbackMs = 4000;
    try {
      const si = wx.getSystemInfoSync();
      if (si && si.platform === 'android') {
        fallbackMs = 5600;
      }
    } catch (e) {
      fallbackMs = 4000;
    }
    this._highlightResumeUnlockFallbackTimer = setTimeout(() => {
      this._highlightResumeUnlockFallbackTimer = null;
      if (!this._highlightSaveAwaitingResume) return;
      if (!this._highlightPipelineDoneFinalize) return;
      this.appendHealthLog('highlight_resume_unlock_fallback', {});
      this._highlightPipelineDoneResume = true;
      this.maybeReleaseHighlightSaveLock();
    }, fallbackMs);
  },
  /**
   * stopRecord 未产出文件或失败时，取消本次等待中的时间高光并解锁 UI。
   * @param {number} sessionId 发起 stop 时的 rolling 会话 id
   * @param {string} reason 诊断用原因码
   * @returns {void}
   */
  abortHighlightAfterStopIfNeeded: function (sessionId, reason) {
    if (!this.pendingHighlight) return;
    this.appendHealthLog('highlight_time_pending_abort', {
      sessionId,
      reason
    });
    if (reason === 'segment_persist_fail' || reason === 'segment_persist_unstable') {
      this.segmentPersistFailStreak = (this.segmentPersistFailStreak || 0) + 1;
      if (this.segmentPersistFailStreak >= 4) {
        this.segmentPersistFailStreak = 0;
        this.markNeedManualRelaunch('segment_persist_fail_streak');
      }
    }
    this.clearHighlightSavePipelineState();
    if (this._recorderCore) {
      this._recorderCore.clearPendingHighlight();
    } else {
      this.pendingHighlight = null;
    }
    this.endHighlightSaving();
    /**
     * iOS 上 persist 失败后 rolling 易与相机争用进入 start_fail；中止高光后软恢复 rolling，
     * 避免仅解锁 UI 而录制链仍处于亚健康（参考 segment_persist_reject_temp_unstable 日志链）。
     */
    if (reason === 'segment_persist_unstable' || reason === 'segment_persist_fail') {
      let recoverDelayMs = 140;
      try {
        const siAb = wx.getSystemInfoSync();
        if (siAb && siAb.platform === 'ios') {
          recoverDelayMs = 420;
        }
      } catch (eAb) {
        recoverDelayMs = 140;
      }
      setTimeout(() => {
        this.recoverRollingPipelineForHighlight();
      }, recoverDelayMs);
    }
  },
  // 相机初始化完成回调
  /** @region LIVE_CAMERA — 相机、16:9 布局、曝光对焦、变焦机位 */
onCameraInit: function (e) {
    if (!this.data.cameraMounted) {
      this.appendHealthLog('camera_init_ignored_unmounted', {});
      return;
    }
    const mountGen = this._cameraMountGeneration || 0;
    const activeGen = this._cameraRebuildGeneration || 0;
    if (mountGen > 0 && mountGen !== activeGen) {
      this.appendHealthLog('camera_init_ignored_stale_generation', {
        mountGen,
        activeGen
      });
      return;
    }
    if (this._cameraShowInitWatchTimer) {
      clearTimeout(this._cameraShowInitWatchTimer);
      this._cameraShowInitWatchTimer = null;
    }
    const maxZoom = e.detail.maxZoom || 5;
    var minZoomRaw = null;
    if (typeof e.detail.minZoom === 'number' && isFinite(e.detail.minZoom)) {
      minZoomRaw = e.detail.minZoom;
    } else if (e.detail.minZoom != null && e.detail.minZoom !== '') {
      var parsedMz = parseFloat(String(e.detail.minZoom));
      if (isFinite(parsedMz)) minZoomRaw = parsedMz;
    }
    const minZoom = minZoomRaw !== null ? minZoomRaw : 1;
    var previewZ = getDefaultPreviewZoomForMax(maxZoom);
    this.setData({
      maxZoom: maxZoom,
      minZoom: minZoom,
      zoom: previewZ,
      cameraViewMode: CameraViewMode.NORMAL
    });
    /**
     * VK 模式下尚无可用 cameraContext.setZoom；若仍调 updateZoom(1) 会被 vk 守卫拦截。
     * iOS 上小程序 camera 的 zoom=2 更接近系统相机「1×」主摄，默认从此起播避免一进来就是最广视角。
     */
    if (this.data.enhanceMode !== 'vk') {
      /**
       * Android：&lt;camera zoom="{{zoom}}"&gt; 与 context.setZoom 需与 data.zoom 一致，否则下一帧属性会覆盖 setZoom，
       * 小米等机型上表现为亚 1× 无效、广角与 1× 相同。iOS 保持同步调用。
       */
      if (isLiveHostIos()) {
        if (this.data.cameraContext && this.data.cameraContext.setZoom) {
          try {
            this.data.cameraContext.setZoom({
              zoom: previewZ,
              fail: function () {}
            });
          } catch (ez) {}
        }
        this.maybeSchedulePostZoomSilentFocus();
        this.detectCameraCapabilities({
          minZoom: minZoomRaw,
          maxZoom: maxZoom
        });
      } else {
        this._armAndroidCameraSettleGate('camera_init');
        var selfInit = this;
        var pzInit = previewZ;
        var capMz = minZoomRaw;
        var capMax = maxZoom;
        setTimeout(function () {
          selfInit.setData({
            zoom: pzInit
          }, function () {
            if (selfInit.data.cameraContext && selfInit.data.cameraContext.setZoom) {
              try {
                selfInit.data.cameraContext.setZoom({
                  zoom: pzInit,
                  fail: function () {}
                });
              } catch (ez2) {}
            }
            selfInit.maybeSchedulePostZoomSilentFocus();
            selfInit.detectCameraCapabilities({
              minZoom: capMz,
              maxZoom: capMax
            });
          });
        }, 0);
      }
    } else if (!isLiveHostIos()) {
      this._armAndroidCameraSettleGate('camera_init_vk');
      this._finishAndroidCameraSettle(ANDROID_CAMERA_SETTLE_AFTER_PROBE_MS, 'vk_mode');
    }
    if (this._rollingKickoffTimer) {
      clearTimeout(this._rollingKickoffTimer);
      this._rollingKickoffTimer = null;
    }
    this._cameraInitDone = true;
    /**
     * 硬件 EV 能力探测：只要 cameraContext 上存在任一官方/灰度接口即视为支持。
     * 不支持的机型直接隐藏曝光滑条——小程序 <camera> 是原生层渲染，JS 无法介入视频流像素，
     * 所谓“软补光”只能在预览层叠加半透明遮罩，既不会写入录制文件，又会误导用户，
     * 因此不给不支持的机型提供任何“软补光”兜底（参考本次需求说明）。
     */
    this.detectExposureHardwareSupport();
    /**
     * 相机上下文若被系统回收/重建，恢复上次用户设置，避免“重启后锁焦与曝光丢失”。
     * 注：AF/AE 是否真正生效仍取决于机型能力，但会尽最大可能重放参数。
     */
    if (this._lastFocusNorm && this.data.aeControlsVisible) {
      this.invokeSetTargetFocus(this._lastFocusNorm.nx, this._lastFocusNorm.ny);
    }
    if (typeof this._exposureNormPending === 'number' && this.data.aeExposureHardwareSupported) {
      this.applyExposureFromNorm(this._exposureNormPending);
    }
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
      this.setData({
        isRecovering: false,
        showRecoveryVeil: false
      });
      this._recoveryLock = false;
      if (this._recorderCore) {
        this._recorderCore.onRecoverSuccess('camera_init');
      }
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
    this.appendHealthLog('camera_init', {
      maxZoom: maxZoom,
      minZoom: minZoom,
      recordProfileTier: this._deviceRecordProfileTier || '720p',
      recordCanvas: `${this.pingPongRecordCanvasWidth || 1280}x${this.pingPongRecordCanvasHeight || 720}`
    });
    if (this._recorderCore) {
      this._recorderCore.markReady('camera_init');
    }
    // 直播态相机锁定：Android 冷启动须等预览稳定后再锁 AE/AF，否则部分红米机型预览黑屏且 onCameraFrame 零帧
    if (this.data.liveStreamAllowed && this._liveAeCameraLockArmed) {
      if (isLiveHostIos()) {
        this._applyLiveCameraLock();
      } else {
        this._scheduleDeferredLiveCameraLock('camera_init');
      }
    }
    // camera_init 后重新初始化快捷变焦默认档位（onLoad 时机位尚未探测）
    this._loadQuickZoomStops();
    this._schedulePreviewRecordStartAfterCameraInit('camera_init');
  },
  /**
   * Android：在超广探测与 setZoom 全部结束后再执行回调，避免与 onCameraFrame 注册竞态。
   * @param {function(): void} fn
   * @returns {void}
   */
  _runAfterAndroidCameraSettle: function (fn) {
    if (typeof fn !== 'function') return;
    if (isLiveHostIos()) {
      fn();
      return;
    }
    if (!this._androidCameraSettlePending) {
      fn();
      return;
    }
    if (!this._androidCameraSettleQueue) {
      this._androidCameraSettleQueue = [];
    }
    this._androidCameraSettleQueue.push(fn);
  },
  /**
   * 打开 Android 相机稳定门禁（超广探测或 VK 无探测路径均须配对 finish）。
   * @param {string} [source]
   * @returns {void}
   */
  _armAndroidCameraSettleGate: function (source) {
    if (isLiveHostIos()) return;
    this._androidCameraSettlePending = true;
    if (this._androidCameraSettleFailsafeTimer) {
      clearTimeout(this._androidCameraSettleFailsafeTimer);
      this._androidCameraSettleFailsafeTimer = null;
    }
    const self = this;
    this._androidCameraSettleFailsafeTimer = setTimeout(function () {
      self._androidCameraSettleFailsafeTimer = null;
      if (!self._androidCameraSettlePending) return;
      self.appendHealthLog('android_camera_settle_failsafe', {
        source: source || ''
      });
      self._finishAndroidCameraSettle(0, 'failsafe');
    }, 3200);
  },
  /**
   * 关闭 Android 相机稳定门禁并冲刷排队中的 preview record 启动。
   * @param {number} [delayMs]
   * @param {string} [source]
   * @returns {void}
   */
  _finishAndroidCameraSettle: function (delayMs, source) {
    if (isLiveHostIos()) return;
    const self = this;
    const waitMs = Math.max(0, Number(delayMs) || 0);
    if (this._androidCameraSettleFinishTimer) {
      clearTimeout(this._androidCameraSettleFinishTimer);
      this._androidCameraSettleFinishTimer = null;
    }
    this._androidCameraSettleFinishTimer = setTimeout(function () {
      self._androidCameraSettleFinishTimer = null;
      if (self._androidCameraSettleFailsafeTimer) {
        clearTimeout(self._androidCameraSettleFailsafeTimer);
        self._androidCameraSettleFailsafeTimer = null;
      }
      self._androidCameraSettlePending = false;
      const queued = (self._androidCameraSettleQueue || []).slice(0);
      self._androidCameraSettleQueue = [];
      self.appendHealthLog('android_camera_settle_done', {
        source: source || '',
        delayMs: waitMs,
        queued: queued.length
      });
      queued.forEach(function (fn) {
        try {
          fn();
        } catch (eRun) {}
      });
    }, waitMs);
  },
  /**
   * Android 冷启动延后直播 AE/AF 锁定，待首帧或超时后再应用。
   * @param {string} [source]
   * @returns {void}
   */
  _scheduleDeferredLiveCameraLock: function (source) {
    if (isLiveHostIos() || !this._liveAeCameraLockArmed) return;
    if (this._liveCameraLockDeferTimer) {
      clearTimeout(this._liveCameraLockDeferTimer);
      this._liveCameraLockDeferTimer = null;
    }
    const self = this;
    const apply = function () {
      self._liveCameraLockDeferTimer = null;
      if (!self._liveAeCameraLockArmed || !self.data.liveStreamAllowed) return;
      if (!self.data.cameraContext || !self._cameraInitDone) return;
      self._applyLiveCameraLock();
    };
    if (self._previewRecordFirstFrameAt && Date.now() - self._previewRecordFirstFrameAt < 8000) {
      apply();
      return;
    }
    this._liveCameraLockDeferTimer = setTimeout(apply, ANDROID_LIVE_CAMERA_LOCK_DEFER_MS);
    this.appendHealthLog('live_camera_lock_deferred', {
      source: source || '',
      deferMs: ANDROID_LIVE_CAMERA_LOCK_DEFER_MS
    });
  },
  /**
   * 相机 bindinitdone 后延迟启动 preview record，避免 remount 后立即抽帧得到空壳段。
   * @param {string} [source]
   * @returns {void}
   */
  _schedulePreviewRecordStartAfterCameraInit: function (source) {
    const warmupUntil = this._previewRecordWarmupUntil || 0;
    const delayMs = Math.max(0, warmupUntil - Date.now());
    if (this._previewRecordStartTimer) {
      clearTimeout(this._previewRecordStartTimer);
      this._previewRecordStartTimer = null;
    }
    const triggerSource = source || 'camera_init';
    const run = () => {
      this._previewRecordStartTimer = null;
      this._runAfterAndroidCameraSettle(() => {
        this.tryStartRollingWhenCameraReady(triggerSource);
      });
    };
    if (delayMs > 0) {
      this.appendHealthLog('preview_record_start_deferred_warmup', {
        delayMs,
        source: triggerSource
      });
      this._previewRecordStartTimer = setTimeout(run, delayMs);
      return;
    }
    run();
  },
  /**
   * 相机 remount 后 preview record 预热时长（ms）。
   * @returns {number}
   */
  getPreviewRecordWarmupMs: function () {
    return isLiveHostIos() ? PREVIEW_RECORD_WARMUP_IOS_MS : PREVIEW_RECORD_WARMUP_ANDROID_MS;
  },
  /**
   * 保存高光所需的最短起录等待（ms）。
   * @returns {number}
   */
  /**
   * 是否仍处于「从后台/外置相机返回后、新管线尚未验证」的增强恢复阶段。
   * @returns {boolean}
   */
  isLiveForegroundRecordingRecoverPending: function () {
    return !!(this._liveReturnedFromBackground || this._liveNeedsForegroundRecordingRecover);
  },
  getPreviewRecordMinHighlightMs: function () {
    return this.isLiveForegroundRecordingRecoverPending()
      ? PREVIEW_RECORD_MIN_MS_BEFORE_HIGHLIGHT_AFTER_PAGE_HIDE
      : PREVIEW_RECORD_MIN_MS_BEFORE_HIGHLIGHT;
  },
  /**
   * 保存高光前 preview 乒乓管线是否已就绪（已起录、过预热、至少一条有效轨）。
   * @returns {{ ready: boolean, reason?: string, remainMs?: number, recordAgeMs?: number, minHighlightMs?: number }}
   */
  getPreviewRecordHighlightGate: function () {
    if (!this.rollingActive || !this._cameraInitDone || !this.data.cameraContext) {
      return {
        ready: false,
        reason: 'camera_not_ready'
      };
    }
    if (this._awaitingFirstSuccessChunkAfterRemount) {
      return {
        ready: false,
        reason: 'awaiting_first_chunk',
        remainMs: 0
      };
    }
    if (this.data.showGuide) {
      return {
        ready: false,
        reason: 'guide_visible'
      };
    }
    const pipeline = this._ensurePreviewRecordPipeline();
    if (!pipeline.isSupported()) {
      return {
        ready: false,
        reason: 'unsupported'
      };
    }
    if (!pipeline.isActive()) {
      return {
        ready: false,
        reason: 'pipeline_inactive'
      };
    }
    if (this._previewRecordWarmupUntil && Date.now() < this._previewRecordWarmupUntil) {
      return {
        ready: false,
        reason: 'warmup_until',
        remainMs: this._previewRecordWarmupUntil - Date.now()
      };
    }
    if (this._matchSwitchHighlightWarmupUntil && Date.now() < this._matchSwitchHighlightWarmupUntil) {
      return {
        ready: false,
        reason: 'match_switch_warming',
        remainMs: this._matchSwitchHighlightWarmupUntil - Date.now()
      };
    }
    if (!this._previewRecordFirstFrameAt) {
      return {
        ready: false,
        reason: 'no_first_frame'
      };
    }
    if (typeof pipeline.isEncoderWarmupComplete === 'function' && !pipeline.isEncoderWarmupComplete()) {
      return {
        ready: false,
        reason: 'encoder_live_warming',
        remainMs: 0
      };
    }
    if (this.isLiveForegroundRecordingRecoverPending() && !this._previewRecordEncoderVerified) {
      return {
        ready: false,
        reason: 'encoder_not_verified',
        remainMs: 0
      };
    }
    const recordStartAt = Number(this.lastRecordStartAt || 0);
    const recordAgeMs = recordStartAt > 0 ? Date.now() - recordStartAt : 0;
    const minHighlightMs = this.getPreviewRecordMinHighlightMs();
    if (recordStartAt <= 0 || recordAgeMs < minHighlightMs) {
      return {
        ready: false,
        reason: 'record_warming',
        remainMs: recordStartAt <= 0 ? minHighlightMs : Math.max(1, minHighlightMs - recordAgeMs),
        recordAgeMs,
        minHighlightMs
      };
    }
    const trackCount = typeof pipeline.getRecordingTrackCount === 'function' ? pipeline.getRecordingTrackCount() : 0;
    if (trackCount <= 0) {
      return {
        ready: false,
        reason: 'no_recording_tracks',
        recordAgeMs,
        minHighlightMs
      };
    }
    const nowMs = Date.now();
    const maxAvailableLeadMs = typeof pipeline.getMaxAvailableHighlightLeadMs === 'function'
      ? pipeline.getMaxAvailableHighlightLeadMs(nowMs, minHighlightMs)
      : recordAgeMs;
    if (maxAvailableLeadMs < minHighlightMs) {
      return {
        ready: false,
        reason: 'highlight_window_warming',
        remainMs: Math.max(1, minHighlightMs - maxAvailableLeadMs),
        recordAgeMs,
        minHighlightMs,
        maxAvailableLeadMs
      };
    }
    return {
      ready: true,
      recordAgeMs,
      minHighlightMs,
      maxAvailableLeadMs
    };
  },
  /**
   * 入场 kickoff 后若 rollingActive 但 preview 仍未起录，延迟重试 tryStartRolling。
   * @param {number} sessionIdForRolling
   * @returns {void}
   */
  _scheduleRollingKickoffWatchdog: function (sessionIdForRolling) {
    if (this._rollingKickoffWatchdogTimer) {
      clearTimeout(this._rollingKickoffWatchdogTimer);
      this._rollingKickoffWatchdogTimer = null;
    }
    const self = this;
    this._rollingKickoffWatchdogTimer = setTimeout(() => {
      self._rollingKickoffWatchdogTimer = null;
      if (!self._livePageVisible || !self.rollingActive) return;
      if (sessionIdForRolling !== self.rollingSessionId) return;
      if (self.data.showGuide || self.data.isRecovering || self._recoveryLock) return;
      if (!self._cameraInitDone || !self.data.cameraContext) return;
      if (self.data.isRecording) return;
      const pipeline = self._previewRecordPipeline;
      if (pipeline && pipeline.isActive()) return;
      self.appendHealthLog('rolling_kickoff_watchdog_retry', {
        sessionId: sessionIdForRolling,
        rollingSessionId: self.rollingSessionId
      });
      self.tryStartRollingWhenCameraReady('kickoff_watchdog');
    }, ROLLING_KICKOFF_WATCHDOG_MS);
  },
  /**
   * 按机型能力（enableEnhanceRender）与内测白名单（enhanceBetaWhitelisted）决定是否拉起增强渲染管线；
   * 与抽屉内「画质增强」工具条可见条件一致，避免仅机型通过的非白名单用户仍走 WebGL 锐化。
   * 幂等：存在旧管线先销毁再重建（硬恢复后调用同样安全）。
   * @returns {void}
   */
  _maybeBootEnhanceRender: function () {

    /** 视录分离重构后已移除 WebGL 增强/VK 管线。 */},
  /**
   * @returns {void}
   */
  _teardownEnhanceRender: function () {
    if (this.data.enhanceCanvasVisible || this.data.enhanceMode !== 'off') {
      this.setData({
        enhanceCanvasVisible: false,
        enhanceMode: 'off'
      });
    }
  },
  /**
   * 在相机重建前记住当前原生增强档位；rebuild 完成后由 _maybeBootEnhanceRender 恢复。
   * VK 模式使用专门的切换编排，不走这里。
   * @param {string} reason
   * @returns {void}
   */
  armNativeEnhanceModeRestoreAfterCameraRebuild: function (reason) {
    var mode = this.data && this.data.enhanceMode ? String(this.data.enhanceMode) : 'off';
    if (mode === 'vk') return;
    this._pendingEnhanceModeAfterCameraRebuild = mode;
    if (mode !== 'off') {
      this.appendHealthLog('enhance_mode_restore_armed', {
        mode: mode,
        reason: reason || ''
      });
    }
  },
  /**
   * 将直播取景区设为窗口内接 16:9，并同步增强/VK 的 WebGL 画布 CSS 像素，避免全屏与相机比例不一致。
   * 边距为页底黑。
   * @returns {void}
   */
  _updateLiveStageLayout: function () {
    var sysW = 375;
    var sysH = 667;
    var sL = 0;
    var sR = 0;
    var sB = 0;
    try {
      var si = wx.getSystemInfoSync();
      sysW = si.windowWidth || sysW;
      sysH = si.windowHeight || sysH;
      if (si.safeArea) {
        sL = Math.max(0, si.safeArea.left || 0);
        sB = Math.max(0, sysH - (si.safeArea.top + (si.safeArea.height || 0)));
        sR = Math.max(0, sysW - (si.safeArea.left + (si.safeArea.width || 0)));
      }
    } catch (e) {}
    var isFullMode = this.data.liveVideoAspectMode === 'full';
    var box = isFullMode ? { w: sysW, h: sysH } : computeLiveStage16x9SizePx(sysW, sysH);
    var style = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' + 'width:' + box.w + 'px;height:' + box.h + 'px;';
    /** 角标/REC/快捷变焦始终锚定在 16:9 黑边位置，与画幅模式无关 */
    var letterboxRect = computeLiveStage16x9RectPx(sysW, sysH);
    var factor = 750 / Math.max(1, sysW);
    /** 取景区左内缘 + 间距（rpx），呼出条仅在画幅内展示 */
    var panelInsetRpx = 12;
    var leftRpx = letterboxRect.left * factor + panelInsetRpx;
    var topCenterRpx = (letterboxRect.top + letterboxRect.h * 0.5) * factor;
    var cameraSettingsPanelStyle = 'left:' + leftRpx + 'rpx;top:' + topCenterRpx + 'rpx;transform:translateY(-50%);';
    var corner = buildCornerFabStylesInLetterboxPx(sysW, sysH, letterboxRect, {
      sL: sL,
      sR: sR,
      sB: sB
    });
    var safePx = {
      sL: sL,
      sR: sR,
      sB: sB
    };
    this.setData({
      liveStageInlineStyle: style,
      cameraSettingsPanelStyle: cameraSettingsPanelStyle,
      leftCameraFabStyle: corner.leftCameraFab,
      recoverFabStackStyle: corner.recoverStack,
      replayRailStyle: corner.replayRail,
      bottomCenterBoardStyle: buildBottomCenterBoardStyleInLetterboxPx(
        sysW,
        sysH,
        letterboxRect,
        safePx
      ),
      shotClockBoxStyle: buildShotClockBoxStyleInLetterboxPx(sysW, sysH, letterboxRect, safePx)
    });
    if (this.data.useCornerScoreboard && this._proScoreboardMovableInited) {
      var selfScoreLayout = this;
      setTimeout(function () {
        selfScoreLayout._syncProScoreboardCornerLayout(false);
      }, 0);
      setTimeout(function () {
        selfScoreLayout._refineProScoreboardLayoutFromDom(false);
      }, 80);
    }
    if (this.data.useCornerScoreboard && this._proMatchNameMovableInited) {
      var selfMatchNameLayout = this;
      setTimeout(function () {
        selfMatchNameLayout._syncProMatchNameLayout(false);
      }, 0);
      setTimeout(function () {
        selfMatchNameLayout._refineProMatchNameLayoutFromDom(false);
      }, 100);
    }
    if (this._renderPipeline && typeof this._renderPipeline.resizeToCssPixels === 'function') {
      try {
        this._renderPipeline.resizeToCssPixels(box.w, box.h);
      } catch (e1) {}
    }
  },
  /**
   * 零帧自愈重建管线成功后，将档位设回用户所选（非 VK）。
   * @returns {void}
   */
  _applyPendingEnhanceModeAfterRecover: function () {
    var target = this._pendingEnhanceModeAfterRecover;
    if (!target) return;
    this._pendingEnhanceModeAfterRecover = null;
    if (target === 'off') {
      this._teardownEnhanceRender();
      return;
    }
    if (this._renderPipeline && typeof this._renderPipeline.setMode === 'function') {
      try {
        this._renderPipeline.setMode(target, {
          reason: 'user',
          force: true
        });
      } catch (e) {}
    }
  },
  /**
   * 把 vk 管线内部抛出的 error message 翻译成一句面向用户的 toast 文案。
   * frame-source.js 里统一前缀为 [vk:create|start|frame]，这里按前缀分派。
   * @param {string} msg
   * @returns {string}
   */
  _vkErrorToHuman: function (msg) {
    if (!msg) return '超频模式启动失败，已回到标准模式';
    if (msg.indexOf('[vk:create]') !== -1) {
      return '超频初始化失败，本机暂不支持，已回到标准';
    }
    if (msg.indexOf('[vk:start]') !== -1) {
      // session.start 常见：相机未释放干净、权限、机型不在 VK v2 白名单
      return '超频启动被相机拒绝，已回到标准（请退出重进）';
    }
    if (msg.indexOf('getCameraBuffer') !== -1) {
      return '超频通道不兼容当前微信，已回到标准';
    }
    if (msg.indexOf('no_frame_streak') !== -1) {
      return '超频未拿到画面，已回到标准（相机占用中）';
    }
    if (msg.indexOf('[vk:frame]') !== -1) {
      return '超频画面处理异常，已回到标准';
    }
    return '超频模式启动失败，已回到标准';
  },
  /**
   * 动态切换档位（调试入口 / 未来设置页入口）。
   * 管线尚未拉起且非 'off' 时会尝试首次 boot；失败由 pipeline 内部回退到 off。
   * @param {'off'|'lite'|'standard'|'strong'} mode
   * @returns {void}
   */
  setEnhanceMode: function () {

    /** 视录分离重构后已移除画质增强档位。 */},
  /**
   * 由 render-pipeline 在档位落到 off（含自动降级/异常）后下一 tick 调用；须比对实例，避免误杀用户新起的管线。
   *
   * @param {Object|null} pipeRef createRenderPipeline() 返回的同一引用
   * @returns {void}
   */
  _deferTeardownEnhanceForPipeline: function (pipeRef) {
    if (!this._livePageVisible) return;
    if (!pipeRef || this._renderPipeline !== pipeRef) return;
    this._teardownEnhanceRender();
  },
  /**
   * camera 非正常中断（如切后台/系统打断）后的恢复入口。
   * @param {WechatMiniprogram.CustomEvent} e
   * @returns {void}
   */
  onCameraStop: function (e) {
    const detail = e && e.detail || {};
    const reason = detail && detail.reason ? String(detail.reason) : '';
    this.appendHealthLog('camera_stop', {
      reason
    });
    /** 视录分离：camera 仅预览，后台录制走 MediaRecorder，bindstop 多为切后台。 */
    if (this._previewRecordPipeline && this._previewRecordPipeline.isActive()) {
      this.appendHealthLog('camera_stop_preview_only', {
        reason
      });
      this._liveNeedsForegroundRecordingRecover = true;
      return;
    }
    if (!reason && this.rollingActive && this._livePageVisible) return;
    this.triggerCameraFaultRecovery(`stop:${reason}`);
  },
  /**
   * camera 组件错误回调（权限变化、系统相机异常等）。
   * @param {WechatMiniprogram.CustomEvent} e
   * @returns {void}
   */
  onCameraError: function (e) {
    const detail = e && e.detail || {};
    const errMsg = detail && detail.errMsg ? String(detail.errMsg) : '';
    this.appendHealthLog('camera_error', {
      errMsg
    });
    const lower = errMsg.toLowerCase();
    const isInsertConflict = lower.indexOf('can insert only one camera') >= 0 || lower.indexOf('insertcamera:fail') >= 0;
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
  triggerCameraFaultRecovery: function (reason) {
    if (!this.data.liveStreamAllowed) return;
    if (!this._livePageVisible) {
      this.appendHealthLog('camera_fault_recovery_skip_page_hidden', {
        reason: reason || '',
        diag: this.getLiveRollingDiagSnapshot({})
      });
      return;
    }
    if (this.data.isRecovering || this._recoveryLock) return;
    if (this.pendingHighlight) return;
    /** 高光等待自然分段落盘期间避免硬恢复抢管线，降低 stop/start 风暴 */
    if (this.data.isSavingHighlight) return;
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
   * 统一重新挂载 camera 组件，避免多个恢复/切模路径并发执行重复 mount。
   * @param {{
   *   generation?: number,
   *   extraData?: Record<string, any>,
   *   onMounted?: function(WechatMiniprogram.CameraContext): void
   * }} [opts]
   * @returns {boolean}
   */
  remountCameraComponent: function (opts, source) {
    if (this._recorderCore && !this._recorderCore.isOwnerActive()) {
      return this._recorderCore.withOwner(source || 'remountCameraComponent', 'cameraRemount', () => this._remountCameraComponentImpl(opts));
    }
    return this._remountCameraComponentImpl(opts);
  },
  _remountCameraComponentImpl: function (opts) {
    const options = opts || {};
    const generation = typeof options.generation === 'number' ? options.generation : this._cameraRebuildGeneration || 0;
    if (generation !== (this._cameraRebuildGeneration || 0)) {
      this.appendHealthLog('camera_mount_skip_stale_generation', {
        requestGeneration: generation,
        activeGeneration: this._cameraRebuildGeneration || 0
      });
      return false;
    }
    if (this._cameraMountInFlight) {
      this.appendHealthLog('camera_mount_skip_inflight', {
        requestGeneration: generation,
        inflightGeneration: this._cameraMountInFlightGeneration || 0
      });
      return false;
    }
    this._cameraMountInFlight = true;
    this._cameraMountInFlightGeneration = generation;
    const finalize = () => {
      this._cameraMountInFlight = false;
      this._cameraMountInFlightGeneration = 0;
    };
    const nextPatch = Object.assign({}, options.extraData || {}, {
      cameraMounted: true
    });
    this.setData(nextPatch, () => {
      if (generation !== (this._cameraRebuildGeneration || 0)) {
        finalize();
        this.appendHealthLog('camera_mount_abandon_after_setdata', {
          requestGeneration: generation,
          activeGeneration: this._cameraRebuildGeneration || 0
        });
        return;
      }
      const bindCameraContext = () => {
        if (generation !== (this._cameraRebuildGeneration || 0)) {
          finalize();
          this.appendHealthLog('camera_mount_abandon_before_context', {
            requestGeneration: generation,
            activeGeneration: this._cameraRebuildGeneration || 0
          });
          return;
        }
        const nextCameraContext = wx.createCameraContext(this);
        this.setData({
          cameraContext: nextCameraContext,
          isRecording: false
        }, () => {
          this._cameraMountGeneration = generation;
          this._lastCameraRemountAt = Date.now();
          finalize();
          if (typeof options.onMounted === 'function') {
            try {
              options.onMounted(nextCameraContext);
            } catch (e) {}
          }
        });
      };
      if (wx.nextTick) wx.nextTick(bindCameraContext);else setTimeout(bindCameraContext, 0);
    });
    return true;
  },
  /**
   * 强制重建 camera 组件并释放旧上下文，避免会话切换后复用脏资源。
   * @param {function(): void} [onRebuilt]
   * @returns {void}
   */
  rebuildCameraComponent: function (onRebuilt, source) {
    if (this._recorderCore && !this._recorderCore.isOwnerActive()) {
      return this._recorderCore.withOwner(source || 'rebuildCameraComponent', 'cameraRebuild', () => this._rebuildCameraComponentImpl(onRebuilt));
    }
    return this._rebuildCameraComponentImpl(onRebuilt);
  },
  _rebuildCameraComponentImpl: function (onRebuilt) {
    this._clearLensSwitchScaleTransitionTimers(true);
    if (this._cameraRebuildLock) {
      if (typeof onRebuilt === 'function') {
        this._cameraRebuildQueue.push(onRebuilt);
      }
      return;
    }
    this._cameraRebuildLock = true;
    const generation = (this._cameraRebuildGeneration || 0) + 1;
    this._cameraRebuildGeneration = generation;
    this._cameraMountInFlight = false;
    this._cameraMountInFlightGeneration = 0;
    this._cameraInitDone = false;
    this._androidCameraSettlePending = false;
    this._androidCameraSettleQueue = [];
    if (this._androidCameraSettleFailsafeTimer) {
      clearTimeout(this._androidCameraSettleFailsafeTimer);
      this._androidCameraSettleFailsafeTimer = null;
    }
    if (this._androidCameraSettleFinishTimer) {
      clearTimeout(this._androidCameraSettleFinishTimer);
      this._androidCameraSettleFinishTimer = null;
    }
    // 重建 camera 必然产生新的 cameraContext；先销毁旧增强管线，避免 listener / GL 资源悬挂
    this._teardownEnhanceRender();
    this.setData({
      cameraMounted: false,
      cameraContext: null,
      isRecording: false,
      cameraRenderNonce: (this.data.cameraRenderNonce || 0) + 1
    }, () => {
      this._lastCameraUnmountAt = Date.now();
      const kick = () => {
        if (typeof onRebuilt === 'function') onRebuilt(generation);
        this._cameraRebuildLock = false;
        const queued = this._cameraRebuildQueue.splice(0, this._cameraRebuildQueue.length);
        if (queued.length > 0) {
          const next = queued.shift();
          if (typeof next === 'function') {
            this.rebuildCameraComponent(next);
          }
          queued.forEach(fn => {
            if (typeof fn === 'function') this._cameraRebuildQueue.push(fn);
          });
        }
      };
      const baseMs = (this.recordCooldownAfterStopMs || 500) + this.getAdaptiveRecordCooldownExtraMs() + this.getIosParallelRollingStopExtraMs();
      const extraMs = this._cameraRebuildExtraDelayMs || 0;
      setTimeout(kick, baseMs + extraMs);
    });
  },
  /**
   * 长会话后附加 stop→start 冷却：Android 针对高压 I/O；iOS 略增句柄释放时间。
   * 非上述平台返回 0。
   * @returns {number}
   */
  getAdaptiveRecordCooldownExtraMs: function () {
    try {
      const si = wx.getSystemInfoSync();
      if (!si) return 0;
      const n = typeof this.segmentCounter === 'number' ? this.segmentCounter : 0;
      if (si.platform === 'android') {
        /** 长会话 + 频繁 user 目录落盘时略抬高上限，降低句柄竞态 */
        return Math.min(680, Math.floor(n / 12) * 38);
      }
      if (si.platform === 'ios') {
        /** 与 Android 同为并行落盘；具体加长见 {@link getIosParallelRollingStopExtraMs} */
        return Math.min(300, 72 + Math.floor(n / 10) * 22);
      }
    } catch (e) {
      return 0;
    }
    return 0;
  },
  /**
   * iOS 与 Android 均并行调度下一段时，额外拉长 stop→start，降低上一段 temp 被回收前未完成 save 的概率。
   * Android 返回 0。
   * @returns {number}
   */
  getIosParallelRollingStopExtraMs: function () {
    try {
      const si = wx.getSystemInfoSync();
      if (!si || si.platform !== 'ios') return 0;
    } catch (e) {
      return 0;
    }
    const n = typeof this.segmentCounter === 'number' ? this.segmentCounter : 0;
    return Math.min(920, 380 + Math.floor(n / 4) * 36);
  },
  /**
   * stopRecord 与下一段 startRecord 之间的总冷却（含长会话自适应）。
   * @returns {number}
   */
  getSegmentStopToStartDelayMs: function () {
    let base = typeof this.recordCooldownAfterStopMs === 'number' ? this.recordCooldownAfterStopMs : 380;
    base += this.getAdaptiveRecordCooldownExtraMs();
    if (isLiveHostIos()) {
      base += this.getIosParallelRollingStopExtraMs();
    }
    return Math.max(RECORDER_SAFE_RESTART_DELAY_MIN_MS, Math.min(2400, Math.round(base)));
  },
  /**
   * 长会话自适应单段时长：iOS 上随 segmentCounter 略拉长，降低 4h+ 直播的 stop/start 频率。
   * 高光时间窗仍由 highlightLeadMs 控制，与物理切片时长解耦。
   * @returns {number}
   */
  getEffectiveSegmentDurationMs: function () {
    const base = typeof this.segmentDurationMs === 'number' && this.segmentDurationMs > 0 ? this.segmentDurationMs : 8000;
    if (!isLiveHostIos()) return base;
    const n = typeof this.segmentCounter === 'number' ? this.segmentCounter : 0;
    if (n >= 600) return Math.max(base, 16000);
    if (n >= 300) return Math.max(base, 12000);
    if (n >= 120) return Math.max(base, 10000);
    return base;
  },
  /**
   * 连续收到 operateCamera is recording 时，在 scheduleAfterStopRecord 之后再追加的启动延迟。
   * 小米等 Android：第二次及以后若不再 stopRecord、仅靠短重试会永久与 Native 录制态脱节。
   * @returns {number}
   */
  getIsRecordingConflictExtraStartDelayMs: function () {
    const streak = typeof this.startRecordFailStreak === 'number' ? this.startRecordFailStreak : 0;
    if (streak < 2) return 0;
    try {
      const si = wx.getSystemInfoSync();
      if (si && si.platform === 'android') {
        /** 小米等机型在 Native 录制态回收偏慢，冲突时拉长退避避免“is recording”风暴。 */
        return Math.min(5200, 900 + streak * 240);
      }
      if (si && si.platform === 'ios') {
        return Math.min(1500, 70 + streak * 75);
      }
    } catch (e) {
      return Math.min(2200, 90 + streak * 100);
    }
    return Math.min(2200, 90 + streak * 100);
  },
  /**
   * stopRecord 完成后延迟再启动下一段录制，避免 Native 句柄未释放即 startRecord。
   * 时间驱动 rolling 不再做热层落盘；这里仍保留统一冷却入口。
   * iOS 另加 {@link getIosParallelRollingStopExtraMs}（与 Android 并行模型一致，仅时间不同）。
   * @param {function(): void} fn
   * @returns {void}
   */
  scheduleAfterStopRecord: function (fn) {
    const ms = typeof this.getSegmentStopToStartDelayMs === 'function' ? this.getSegmentStopToStartDelayMs() : RECORDER_SAFE_RESTART_DELAY_MIN_MS;
    setTimeout(() => {
      const extra = typeof this._postUserLocalPersistCooldownMs === 'number' ? this._postUserLocalPersistCooldownMs : 0;
      const run = () => {
        if (typeof fn === 'function') {
          fn();
        }
      };
      if (extra > 0) {
        this._postUserLocalPersistCooldownMs = 0;
        setTimeout(run, extra);
        return;
      }
      run();
    }, ms);
  },
  /**
   * 强制 stop/re-align 路径也必须先回到 READY，再允许下一次 start。
   * @param {string} source
   * @param {function(): void} fn
   * @returns {void}
   */
  scheduleAfterForcedStopReady: function (source, fn) {
    if (this._recorderCore) {
      this._recorderCore.onSegmentStopSuccess(source || 'forced_stop_ready', Promise.resolve(), () => this.scheduleAfterStopRecord(fn));
      return;
    }
    this.scheduleAfterStopRecord(fn);
  },
  /**
   * 清理 startOneSegment 延迟重试 timer，避免形成并发重试链。
   * @returns {void}
   */
  clearSegmentStartRetryTimer: function () {
    if (this._segmentStartRetryTimer) {
      clearTimeout(this._segmentStartRetryTimer);
      this._segmentStartRetryTimer = null;
    }
  },
  /**
   * 串行调度下一次 startOneSegment（会覆盖旧重试，确保只有一条链）。
   * @param {number} sessionId
   * @param {number} retryCount
   * @param {number} delayMs
   * @returns {void}
   */
  scheduleStartOneSegmentRetry: function (sessionId, retryCount, delayMs) {
    this.clearSegmentStartRetryTimer();
    this._segmentStartRetryTimer = setTimeout(() => {
      this._segmentStartRetryTimer = null;
      this.startOneSegment(sessionId, retryCount);
    }, Math.max(0, delayMs || 0));
  },
  /**
   * 在相机预览就绪后再启动滚动分段，避免首屏即 startRecord 导致预览黑屏。
   * 注意：不可因 isRecording 直接 return——会话切换后旧段 stopOneSegment 会早退且不置 false，
   * 会遗留「假 true」，此处若拦截则永远无法 startRollingRecording，高光永远无片段。
   * @returns {void}
   */
  tryStartRollingWhenCameraReady: function (source) {
    return this._tryStartRollingWhenCameraReadyImpl(source);
  },
  _tryStartRollingWhenCameraReadyImpl: function (source) {
    if (this.data.showGuide) {
      this.appendHealthLog('rolling_start_deferred_by_guide', {});
      return;
    }
    const now = Date.now();
    if (this._previewRecordWarmupUntil && now < this._previewRecordWarmupUntil) {
      const delayMs = this._previewRecordWarmupUntil - now;
      if (this._previewRecordStartTimer) {
        clearTimeout(this._previewRecordStartTimer);
      }
      const triggerSource = source || 'tryStartRollingWhenCameraReady';
      this._previewRecordStartTimer = setTimeout(() => {
        this._previewRecordStartTimer = null;
        this._tryStartRollingWhenCameraReadyImpl(triggerSource);
      }, delayMs);
      this.appendHealthLog('rolling_start_deferred_warmup', {
        delayMs,
        source: triggerSource
      });
      return;
    }
    if (this._fileQuotaCircuitUntil && now < this._fileQuotaCircuitUntil) {
      this.appendHealthLog('rolling_start_blocked_by_file_quota_circuit', {
        remainMs: this._fileQuotaCircuitUntil - now
      });
      return;
    }
    if (!this.rollingActive) {
      this._rollingStartPendingBeforeKickoff = true;
      return;
    }
    if (!this._cameraInitDone) return;
    if (!this.data.cameraContext) return;
    const pipeline = this._ensurePreviewRecordPipeline();
    if (!pipeline.isSupported()) {
      this.appendHealthLog('preview_record_unsupported', {});
      wx.showToast({
        title: '本机不支持后台录制',
        icon: 'none',
        duration: 2500
      });
      return;
    }
    this._startRollingRecordingImpl(source || 'tryStartRollingWhenCameraReady');
  },
  updateZoom: function (zoomVal) {
    /** 超频（VK）模式使用渲染管线数字变焦；原生家族使用 camera.setZoom。 */
    var isVkMode = this.data.enhanceMode === 'vk';
    var minZ = 1;
    if (this._cameraCaps && typeof this._cameraCaps.minZoom === 'number' && this._cameraCaps.minZoom > 0) {
      minZ = this._cameraCaps.minZoom;
    } else if (this._cameraCaps && this._cameraCaps.hasUltraWide) {
      minZ = isLiveHostIos() ? 1 : 0.5;
    } else if (!isLiveHostIos() && (!this._cameraCaps || !this._cameraCaps.probed)) {
      /** Android 超广探测完成前勿将 minZ 锁为 1，否则 setZoom(0.6) 会被钳成 1×。 */
      minZ = 0.5;
    }
    if (isVkMode) minZ = 1;
    const actualZoom = Math.max(minZ, Math.min(this.data.maxZoom, zoomVal));

    // 只在数值发生实质变化时更新，减少 setData 频率
    if (Math.abs(this.data.zoom - actualZoom) < 0.01) return;
    var selfZ = this;
    /**
     * @returns {void}
     */
    var applyCtxZoomAndEnhance = function () {
      if (selfZ.data.cameraContext && selfZ.data.cameraContext.setZoom) {
        try {
          selfZ.data.cameraContext.setZoom({
            zoom: actualZoom,
            fail: function () {}
          });
        } catch (eCtx) {}
      }
      selfZ.syncNativeEnhanceZoomCompensation(actualZoom);
      selfZ.maybeSchedulePostZoomSilentFocus();
    };
    if (isVkMode) {
      this.setData({
        zoom: actualZoom
      });
      if (this._renderPipeline && typeof this._renderPipeline.setVkZoom === 'function') {
        try {
          this._renderPipeline.setVkZoom(actualZoom);
        } catch (eZ) {}
      }
      return;
    }
    this.setData({
      zoom: actualZoom
    }, applyCtxZoomAndEnhance);
  },
  /**
   * 将当前 zoom 同步为原生增强路径的补偿倍率（仅标准/高性能档生效）。
   * 根因：onCameraFrame 在部分设备/基础库上与 camera.setZoom 视角不同步，需在 WebGL 侧补偿。
   * @param {number} zoomVal
   * @returns {void}
   */
  syncNativeEnhanceZoomCompensation: function (zoomVal) {
    if (!this._renderPipeline || typeof this._renderPipeline.setNativeZoomCompensation !== 'function') return;
    var mode = this.data.enhanceMode;
    var caps = this._cameraCaps || {};
    if (mode !== 'standard' && mode !== 'strong') {
      try {
        this._renderPipeline.setNativeZoomCompensation(1);
      } catch (e0) {}
      return;
    }
    if (!caps.hasUltraWide) {
      try {
        this._renderPipeline.setNativeZoomCompensation(1);
      } catch (e1) {}
      return;
    }
    var base = 1;
    if (typeof caps.minZoom === 'number' && caps.minZoom > 0) {
      base = caps.minZoom;
    }
    var z = Number(zoomVal);
    if (!isFinite(z) || z <= 0) z = this.data.zoom || 1;
    var comp = z / Math.max(0.2, base);
    if (!isFinite(comp) || comp < 1) comp = 1;
    try {
      this._renderPipeline.setNativeZoomCompensation(comp);
    } catch (e2) {}
  },
  /**
   * 读取本机相机变焦能力并生成机位按钮。
   * - iOS：系统相机 0.5/1/2 与小程序 zoom 刻度常不一致；在 maxZoom≥2 时按 1（最广）/ 2（≈系统1×）/ 4（≈系统2×）对齐。
   * - Android：一律 setZoom 序列探测；init 的 minZoom 只作候选与全失败时的兜底（小米等常见 0.6）。
   * @param {{ minZoom?: number, maxZoom?: number }} [hint]
   * @returns {void}
   */
  detectCameraCapabilities: function (hint) {
    var maxZ = hint && hint.maxZoom || this.data.maxZoom || 10;
    var minRaw = hint && typeof hint.minZoom === 'number' && isFinite(hint.minZoom) ? hint.minZoom : null;
    if (minRaw === null && hint && hint.minZoom != null && hint.minZoom !== '') {
      var pr = parseFloat(String(hint.minZoom));
      if (isFinite(pr)) minRaw = pr;
    }
    var isIos = isLiveHostIos();
    if (!isIos) {
      this._probeAndroidUltraWideZoom(maxZ, minRaw);
      return;
    }
    if (minRaw !== null && minRaw < 0.999) {
      this._cameraCaps = {
        hasUltraWide: true,
        minZoom: minRaw,
        maxZoom: maxZ,
        probed: true
      };
      this.rebuildCameraViewModeStops();
      return;
    }
    if (isIos && maxZ >= 2) {
      this._cameraCaps = {
        hasUltraWide: true,
        minZoom: 1,
        maxZoom: maxZ,
        probed: true
      };
      this.rebuildCameraViewModeStops();
      return;
    }
    this._cameraCaps = {
      hasUltraWide: false,
      minZoom: 1,
      maxZoom: maxZ,
      probed: true
    };
    this.rebuildCameraViewModeStops();
  },
  /**
   * Android：用 setZoom 短序列探测真超广倍率（小米常见 0.6）；init 的 minZoom 仅作候选提示，不因「假 1」跳过探测。
   * 全部候选失败时，若 init 曾给出 0&lt;min&lt;1 则仍采信该值（部分机型回调不完整）。
   * 仅 Android 调用；iOS 不走此函数。
   * @param {number} maxZ
   * @param {number|null} [minRawHint] bindinitdone.minZoom，可能为 null
   * @returns {void}
   */
  _probeAndroidUltraWideZoom: function (maxZ, minRawHint) {
    var self = this;
    this.appendHealthLog('android_uwzoom_probe_start', {
      maxZ: maxZ,
      minRawHint: typeof minRawHint === 'number' ? minRawHint : null
    });
    var ctx = this.data.cameraContext;
    if (!ctx || typeof ctx.setZoom !== 'function') {
      this._cameraCaps = {
        hasUltraWide: false,
        minZoom: 1,
        maxZoom: maxZ,
        probed: true
      };
      this.appendHealthLog('android_uwzoom_probe_no_api', { maxZ: maxZ });
      this.rebuildCameraViewModeStops();
      this._finishAndroidCameraSettle(ANDROID_CAMERA_SETTLE_AFTER_PROBE_MS, 'uwzoom_no_api');
      return;
    }
    var restoreZ = self.getDeviceDefaultPreviewZoom();
    /**
     * 探测结束后回到默认预览倍率（须先写 data.zoom，再 setZoom，与 &lt;camera zoom&gt; 绑定一致）。
     * @returns {void}
     */
    var restore = function () {
      if (!self.data.cameraContext || typeof self.data.cameraContext.setZoom !== 'function') {
        self._finishAndroidCameraSettle(ANDROID_CAMERA_SETTLE_AFTER_PROBE_MS, 'uwzoom_restore_no_api');
        return;
      }
      self.setData({
        zoom: restoreZ
      }, function () {
        try {
          self.data.cameraContext.setZoom({
            zoom: restoreZ,
            fail: function () {}
          });
        } catch (er) {}
        self._finishAndroidCameraSettle(ANDROID_CAMERA_SETTLE_AFTER_PROBE_MS, 'uwzoom_restore');
      });
    };
    var rawList = [0.6, 0.5, 0.55, 0.65, 2 / 3, 0.625];
    if (typeof minRawHint === 'number' && minRawHint > 0 && minRawHint < 1) {
      rawList.unshift(minRawHint);
    }
    var seen = {};
    var candidates = [];
    var ri;
    for (ri = 0; ri < rawList.length; ri++) {
      var rv = rawList[ri];
      if (!isFinite(rv) || rv <= 0 || rv >= 1) continue;
      var rk = String(Math.round(rv * 1000) / 1000);
      if (seen[rk]) continue;
      seen[rk] = true;
      candidates.push(rv);
    }
    if (candidates.length === 0) {
      candidates = [0.6, 0.5];
    }
    var ci = 0;
    /**
     * 当前候选失败则试下一档。
     * @returns {void}
     */
    var onCandidateFail = function () {
      ci++;
      if (ci >= candidates.length) {
        if (typeof minRawHint === 'number' && minRawHint > 0 && minRawHint < 0.999) {
          self._cameraCaps = {
            hasUltraWide: true,
            minZoom: minRawHint,
            maxZoom: maxZ,
            probed: true
          };
          self.appendHealthLog('android_uwzoom_probe_fallback_hint', {
            minZoom: minRawHint,
            maxZ: maxZ,
            tried: candidates
          });
          self.rebuildCameraViewModeStops();
        } else {
          self._cameraCaps = {
            hasUltraWide: false,
            minZoom: 1,
            maxZoom: maxZ,
            probed: true
          };
          self.appendHealthLog('android_uwzoom_probe_failed', {
            maxZ: maxZ,
            tried: candidates
          });
          self.rebuildCameraViewModeStops();
        }
        restore();
        return;
      }
      tryCandidate(candidates[ci]);
    };
    /**
     * @param {number} z
     * @returns {void}
     */
    var tryCandidate = function (z) {
      var settled = false;
      try {
        self.setData({
          zoom: z
        }, function () {
          try {
            ctx.setZoom({
              zoom: z,
              success: function () {
                if (settled) return;
                settled = true;
                self._cameraCaps = {
                  hasUltraWide: true,
                  minZoom: z,
                  maxZoom: maxZ,
                  probed: true
                };
                self.appendHealthLog('android_uwzoom_probe_success', {
                  minZoom: z,
                  maxZ: maxZ
                });
                self.rebuildCameraViewModeStops();
                restore();
              },
              fail: function () {
                if (settled) return;
                settled = true;
                onCandidateFail();
              },
              complete: function () {
                setTimeout(function () {
                  if (settled) return;
                  settled = true;
                  onCandidateFail();
                }, ANDROID_ULTRAWIDE_PROBE_COMPLETE_MS);
              }
            });
          } catch (eInner) {
            if (!settled) {
              settled = true;
              onCandidateFail();
            }
          }
        });
      } catch (eTry) {
        onCandidateFail();
      }
    };
    tryCandidate(candidates[0]);
  },
  /**
   * 进入页面 / 复位机位时使用的默认预览 zoom（iOS max≥2 时为 2，接近系统「1×」主摄）。
   * @returns {number}
   */
  getDeviceDefaultPreviewZoom: function () {
    return getDefaultPreviewZoomForMax(this.data.maxZoom || 10);
  },
  /**
   * 根据当前能力生成机位按钮：支持超广则显示「广角」，其余使用数字倍数。
   * @returns {void}
   */
  rebuildCameraViewModeStops: function () {
    var caps = this._cameraCaps || {};
    var maxZ = this.data.maxZoom || caps.maxZoom || 10;
    var isIos = isLiveHostIos();
    var stops = [];
    if (caps.hasUltraWide) {
      var wideZ = typeof caps.minZoom === 'number' && caps.minZoom > 0 && caps.minZoom < 1 ? caps.minZoom : 1;
      stops.push({
        label: '广角',
        mode: CameraViewMode.WIDE,
        zoom: wideZ
      });
    }
    var normZ = isIos && maxZ >= 2 ? 2 : 1;
    stops.push({
      label: formatCameraZoomLabel(normZ),
      mode: CameraViewMode.NORMAL,
      zoom: normZ
    });
    if (maxZ > normZ + 0.05) {
      var closeZ = isIos && maxZ >= 4 ? 4 : Math.min(VIEW_MODE_CLOSE_ZOOM, maxZ);
      closeZ = Math.min(closeZ, maxZ);
      if (closeZ <= normZ) {
        closeZ = maxZ;
      }
      if (closeZ > normZ) {
        stops.push({
          label: formatCameraZoomLabel(closeZ),
          mode: CameraViewMode.CLOSE,
          zoom: closeZ
        });
      }
    }
    this.setData({
      cameraViewModeStops: stops
    });
    this.appendHealthLog('camera_view_mode_stops_built', {
      count: stops.length,
      stops: stops.map(function (s) {
        return { label: s.label, zoom: s.zoom };
      }),
      hasUltraWide: !!(this._cameraCaps && this._cameraCaps.hasUltraWide),
      isIos: isLiveHostIos()
    });
    this.syncNativeEnhanceZoomCompensation(this.data.zoom || 1);
    this._loadQuickZoomStops();
  },
  /**
   * 将机位状态与预览恢复为「标准」1×；画质切换、相机重建、回前台时调用。
   * @param {{ skipCamera?: boolean }} [opts] skipCamera：仅更新 data，不调 setZoom（如相机即将卸载）。
   * @returns {void}
   */
  resetViewModeToNormal: function (opts) {
    var skip = opts && opts.skipCamera;
    var defZ = this.getDeviceDefaultPreviewZoom();
    var selfR = this;
    this.syncNativeEnhanceZoomCompensation(defZ);
    if (skip || this.data.enhanceMode === 'vk') {
      this.setData({
        cameraViewMode: CameraViewMode.NORMAL,
        zoom: defZ
      });
      return;
    }
    if (isLiveHostIos()) {
      this.setData({
        cameraViewMode: CameraViewMode.NORMAL,
        zoom: defZ
      });
      if (this.data.cameraContext && this.data.cameraContext.setZoom) {
        try {
          this.data.cameraContext.setZoom({
            zoom: defZ,
            fail: function () {}
          });
        } catch (eZ) {}
      }
    } else {
      this.setData({
        cameraViewMode: CameraViewMode.NORMAL,
        zoom: defZ
      }, function () {
        if (selfR.data.cameraContext && selfR.data.cameraContext.setZoom) {
          try {
            selfR.data.cameraContext.setZoom({
              zoom: defZ,
              fail: function () {}
            });
          } catch (eZ2) {}
        }
      });
    }
  },
  /**
   * 按机位切换预览变焦：原生家族统一走 camera.setZoom（含标准/高性能 WebGL 覆盖层，禁止 shader 假广角）。
   * 超频（VK）模式不支持，入口应已隐藏 UI，本函数仍做守卫。
   * @param {'wide'|'normal'|'close'} mode
   * @returns {void}
  */
  applyViewMode: function (mode) {
    try {
      this.appendHealthLog('apply_view_mode_enter', {
        mode: mode,
        currentMode: this.data.cameraViewMode,
        zoom: this.data.zoom
      });
    } catch (eApplyViewModeEnter) {}
    if (this.data.enhanceMode === 'vk') {
      try {
        wx.showToast({
          title: '超频模式已隐藏机位按钮，可双指缩放',
          icon: 'none',
          duration: 2000
        });
      } catch (eT) {}
      return;
    }
    if (!this.data.cameraMounted || !this.data.cameraContext || !this._cameraInitDone) return;
    var stop = null;
    var i;
    for (i = 0; i < this.data.cameraViewModeStops.length; i++) {
      if (this.data.cameraViewModeStops[i].mode === mode) {
        stop = this.data.cameraViewModeStops[i];
        break;
      }
    }
    if (!stop) {
      if (mode === CameraViewMode.WIDE) {
        try {
          wx.showToast({
            title: '当前设备不支持广角',
            icon: 'none',
            duration: 2000
          });
        } catch (eNoW) {}
      }
      return;
    }
    var caps = this._cameraCaps && this._cameraCaps.probed ? this._cameraCaps : {
      hasUltraWide: false,
      minZoom: 1,
      maxZoom: this.data.maxZoom || 10
    };
    var maxZ = this.data.maxZoom || caps.maxZoom || 10;
    var target;
    if (mode === CameraViewMode.WIDE) {
      var stopWide = Number(stop.zoom);
      if (!isFinite(stopWide) || stopWide <= 0) stopWide = 0.6;
      var wideFloor = 0.01;
      if (caps.probed && caps.hasUltraWide && typeof caps.minZoom === 'number' && caps.minZoom > 0) {
        wideFloor = caps.minZoom;
      }
      target = Math.max(wideFloor, Math.min(maxZ, stopWide));
    } else {
      var minTarget = 1;
      target = Math.max(minTarget, Math.min(maxZ, Number(stop.zoom) || 1));
    }
    var fromMode = this.data.cameraViewMode;
    var switchCaps = this._cameraCaps || {};
    var isUltraWideSwitch = !!(switchCaps.hasUltraWide && switchCaps.probed) &&
      ((fromMode === CameraViewMode.WIDE) !== (mode === CameraViewMode.WIDE));
    var ultraWideZoom = typeof switchCaps.minZoom === 'number' ? switchCaps.minZoom : null;
    try {
      this.appendHealthLog('lens_switch_decision', {
        fromMode: fromMode,
        toMode: mode,
        fromZoom: this.data.zoom,
        targetZoom: target,
        hasUltraWide: !!(switchCaps.hasUltraWide),
        capsProbed: !!(switchCaps.probed),
        ultraWideZoom: ultraWideZoom,
        isRealUltraWideSwitch: isUltraWideSwitch
      });
    } catch (eLensDecision) {}
    if (isUltraWideSwitch) {
      this._applyLensSwitchWithScaleTransition(target, mode);
    } else {
      this.setData({
        cameraViewMode: mode
      });
      this.updateZoom(target);
      this._syncQuickZoomActiveByZoom(target, {
        clearTemp: true
      });
    }
    if (this._renderPipeline && typeof this._renderPipeline.pauseAutoDegradeOnce === 'function') {
      try {
        this._renderPipeline.pauseAutoDegradeOnce();
      } catch (eP) {}
    }
  },
  /**
   * 清理超广 ↔ 主摄视觉过渡 timer；相机卸载/重建时可同步复位 scale。
   * @param {boolean} resetScale 是否立即复位视觉缩放
   * @returns {void}
   */
  _clearLensSwitchScaleTransitionTimers: function (resetScale) {
    if (this._lensSwitchAnimTimer) {
      clearTimeout(this._lensSwitchAnimTimer);
      this._lensSwitchAnimTimer = null;
    }
    if (this._lensSwitchResetTimer) {
      clearTimeout(this._lensSwitchResetTimer);
      this._lensSwitchResetTimer = null;
    }
    if (resetScale && this.data && this.data.cameraLensSwitchScale !== 1.0) {
      this.setData({
        cameraLensSwitchScale: 1.0,
        cameraLensSwitchScaleDuration: 0
      });
    }
  },
  /**
   * 超广 ↔ 主摄切换时的视觉过渡编排。
   * CSS scale 微小爬升先跑，setZoom 在爬升后段（scale≈1.05x）时才触发，
   * 使镜头物理切换产生的横移落在画面运动中，降低用户感知。
   * 不影响录制链路、相机重建、变焦钳位任何路径。
   * @param {number} targetZoom 目标 zoom 值
   * @param {'wide'|'normal'|'close'} mode 目标机位
   * @returns {void}
   */
  _applyLensSwitchWithScaleTransition: function (targetZoom, mode) {
    try {
      this.appendHealthLog('lens_switch_anim_start', {
        targetZoom: targetZoom,
        mode: mode,
        peakScale: 1.08,
        scaleUpMs: isLiveHostIos() ? 200 : 240,
        zoomTriggerMs: isLiveHostIos() ? Math.round(200 * 0.70) : Math.round(240 * 0.70)
      });
    } catch (eLensAnimStart) {}
    this._lensSwitchAnimStartAt = Date.now();

    if (this._lensSwitchAnimTimer) {
      clearTimeout(this._lensSwitchAnimTimer);
      this._lensSwitchAnimTimer = null;
    }
    if (this._lensSwitchResetTimer) {
      clearTimeout(this._lensSwitchResetTimer);
      this._lensSwitchResetTimer = null;
    }

    const isIos = isLiveHostIos();

    // 放大幅度：只需覆盖传感器光学中心偏差（约画面宽度 4-6%）。
    // 1.08 在视觉上几乎不可察觉，但足以让横移量落在裁切区域内被稀释。
    // 不使用 1.3+ 的大幅放大——那会让用户明显感知到放大动画本身。
    const PEAK_SCALE = 1.08;

    // 整个过渡分三段：
    // 1. 缓慢爬升到峰值（ease-out，用户几乎感知不到）
    // 2. 在峰值附近触发 setZoom（横移发生在这里，被裁切稀释）
    // 3. 缓慢还原到 1.0（ease-in，比爬升更慢，避免缩回动作突兀）

    // iOS AF/AE 收敛约 80-200ms；setZoom 在爬升到约 70% 时触发（约 140ms），
    // 此时 scale 约 1.05x，横移量约被压缩到视觉宽度的 3-4%。
    const scaleUpMs = isIos ? 200 : 240;   // 爬升总时长
    const zoomTriggerMs = Math.round(scaleUpMs * 0.70); // setZoom 触发时刻
    // 还原时长故意比爬升长，让整体动感更像"呼吸"而非"缩放"
    const scaleDownMs = isIos ? 280 : 320;

    // Step 1：启动微小爬升（CSS transition，渲染线程，不阻塞 JS）
    this.setData({
      cameraLensSwitchScale: PEAK_SCALE,
      cameraLensSwitchScaleDuration: scaleUpMs
    });

    // Step 2：爬升到约 70% 时触发真正的镜头切换
    this._lensSwitchAnimTimer = setTimeout(() => {
      this._lensSwitchAnimTimer = null;
      this.setData({
        cameraViewMode: mode
      });
      try {
        this.appendHealthLog('lens_switch_zoom_fired', {
          targetZoom: targetZoom,
          mode: mode,
          elapsedSinceAnimStart: Date.now() - (this._lensSwitchAnimStartAt || 0)
        });
      } catch (eLensZoomFired) {}
      this.updateZoom(targetZoom);
      this._syncQuickZoomActiveByZoom(targetZoom, {
        clearTemp: true
      });

      // Step 3：给 AF/AE 收敛留足余量后，缓慢还原 scale
      // 剩余爬升时间 + 50ms AF/AE 余量后开始还原
      const resetDelay = (scaleUpMs - zoomTriggerMs) + 50;
      this._lensSwitchResetTimer = setTimeout(() => {
        this._lensSwitchResetTimer = null;
        try {
          this.appendHealthLog('lens_switch_anim_done', {
            targetZoom: targetZoom,
            totalMs: Date.now() - (this._lensSwitchAnimStartAt || 0)
          });
        } catch (eLensAnimDone) {}
        this.setData({
          cameraLensSwitchScale: 1.0,
          cameraLensSwitchScaleDuration: scaleDownMs
        });
      }, resetDelay);
    }, zoomTriggerMs);
  },
  /**
   * 格式化快捷变焦倍数展示文案（与机位按钮一致，如 4x）。
   * @param {number} zoomVal
   * @returns {string}
   */
  _formatQuickZoomDisplay: function (zoomVal) {
    return formatCameraZoomLabel(zoomVal);
  },
  /**
   * 构建固定默认三档快捷变焦（远 4× / 中 2× / 近 1×），供关闭后重新开启时重置。
   * @returns {Array<{label:string, zoom:number, displayZoom:string, isActive:boolean}>}
   */
  _buildFixedQuickZoomStops: function () {
    var labels = ['远', '中', '近'];
    var self = this;
    return QUICK_ZOOM_DEFAULT_ZOOMS.map(function (zoomVal, i) {
      var zoom = self._clampQuickZoomValue(zoomVal);
      return {
        label: labels[i],
        zoom: zoom,
        displayZoom: self._formatQuickZoomDisplay(zoom),
        isActive: false
      };
    });
  },
  /**
   * 长按保存进行中或进度已满待松手时，延迟执行 _loadQuickZoomStops，避免 reload 打断保存。
   * @returns {void}
   */
  _flushPendingQuickZoomStopsReload: function () {
    if (!this._quickZoomStopsReloadPending) return;
    if (this._quickZoomSaveTimer || this._quickZoomSaveReady) return;
    this._quickZoomStopsReloadPending = false;
    this._loadQuickZoomStops();
  },
  /**
   * 构建长按保存圆环的内联样式。
   * @param {number} deg 0–360
   * @returns {string}
   */
  _buildQuickZoomSaveProgressStyle: function (deg) {
    var d = Math.max(0, Math.min(360, Number(deg) || 0));
    return 'background: conic-gradient(from -90deg, rgba(74, 222, 128, 0.85) 0deg, rgba(74, 222, 128, 0.85) '
      + d + 'deg, rgba(255, 255, 255, 0.05) 0deg);';
  },
  /**
   * 根据已探测的原生机位档位（cameraViewModeStops）构建快捷变焦三档默认值。
   * iOS：zoom=2 ≈ 主摄 1×，zoom=4 ≈ 长焦 2×，三档直接映射 nativeStops。
   * 安卓：zoom&lt;1 的「广角」为主摄数字上采样，实际等同 1×，默认从 1× 起算并向长焦延伸。
   * @param {Array<{label:string, zoom:number}>} nativeStops cameraViewModeStops 当前值
   * @returns {Array<{label:string, zoom:number, isActive:boolean}>}
   */
  _buildQuickZoomDefaults: function (nativeStops) {
    var labels = ['远', '中', '近'];
    var maxZ = this.data.maxZoom || 10;
    var isIos = isLiveHostIos();

    if (!nativeStops || nativeStops.length === 0) {
      var placeholders = [4, 2, 1];
      return labels.map(function (label, i) {
        return {
          label: label,
          zoom: placeholders[i],
          isActive: false
        };
      });
    }

    var n = nativeStops.length;

    if (n >= 3) {
      if (!isIos && nativeStops[0].zoom < 1) {
        var nearMain = nativeStops[1].zoom;
        var teleZoom = nativeStops[2].zoom;
        var extFarZoom = Math.min(Math.round(teleZoom * 2 * 10) / 10, maxZ);
        if (extFarZoom <= teleZoom) {
          extFarZoom = Math.min(teleZoom + 0.5, maxZ);
        }
        return [
          { label: '远', zoom: extFarZoom, isActive: false },
          { label: '中', zoom: teleZoom, isActive: false },
          { label: '近', zoom: nearMain, isActive: false }
        ];
      }
      return [
        { label: '远', zoom: nativeStops[2].zoom, isActive: false },
        { label: '中', zoom: nativeStops[1].zoom, isActive: false },
        { label: '近', zoom: nativeStops[0].zoom, isActive: false }
      ];
    }

    if (n === 2) {
      var nearZoom = nativeStops[0].zoom;
      var farZoom = nativeStops[1].zoom;
      if (!isIos) {
        var androidExtFar = Math.min(Math.round(farZoom * 2 * 10) / 10, maxZ);
        if (androidExtFar <= farZoom) {
          androidExtFar = Math.min(farZoom + 0.5, maxZ);
        }
        return [
          { label: '远', zoom: androidExtFar, isActive: false },
          { label: '中', zoom: farZoom, isActive: false },
          { label: '近', zoom: nearZoom, isActive: false }
        ];
      }
      var midZoom = Math.round((nearZoom + farZoom) / 2 * 10) / 10;
      return [
        { label: '远', zoom: farZoom, isActive: false },
        { label: '中', zoom: midZoom, isActive: false },
        { label: '近', zoom: nearZoom, isActive: false }
      ];
    }

    var baseZoom = nativeStops[0].zoom;
    return [
      { label: '远', zoom: Math.min(Math.round(baseZoom * 3 * 10) / 10, maxZ), isActive: false },
      { label: '中', zoom: Math.min(Math.round(baseZoom * 1.5 * 10) / 10, maxZ), isActive: false },
      { label: '近', zoom: baseZoom, isActive: false }
    ];
  },
  /**
   * 快捷变焦合法 zoom 区间（与 updateZoom 钳位逻辑一致）。
   * @returns {{ minZ: number, maxZ: number }}
   */
  _getQuickZoomClampRange: function () {
    var minZ = 1;
    if (this._cameraCaps && typeof this._cameraCaps.minZoom === 'number' && this._cameraCaps.minZoom > 0) {
      minZ = this._cameraCaps.minZoom;
    } else if (this._cameraCaps && this._cameraCaps.hasUltraWide) {
      minZ = isLiveHostIos() ? 1 : 0.5;
    } else if (!isLiveHostIos() && (!this._cameraCaps || !this._cameraCaps.probed)) {
      minZ = 0.5;
    }
    return {
      minZ: minZ,
      maxZ: this.data.maxZoom || 10
    };
  },
  /**
   * 将 zoom 钳位到当前设备可用范围并保留一位小数。
   * @param {number} zoomVal
   * @returns {number}
   */
  _clampQuickZoomValue: function (zoomVal) {
    var range = this._getQuickZoomClampRange();
    var z = Number(zoomVal);
    if (!isFinite(z) || z <= 0) {
      z = range.minZ;
    }
    return Math.round(Math.max(range.minZ, Math.min(range.maxZ, z)) * 10) / 10;
  },
  /**
   * 按档位 label 返回双指微调区间（未选中档时不调用）。
   * @param {'远'|'中'|'近'} label
   * @returns {{ minZ: number, maxZ: number, maxExclusive: boolean }|null}
   */
  _getQuickZoomPinchBandByLabel: function (label) {
    var deviceMax = this.data.maxZoom || 10;
    if (label === '近') {
      return {
        minZ: QUICK_ZOOM_PINCH_NEAR_MIN,
        maxZ: QUICK_ZOOM_PINCH_NEAR_MAX,
        maxExclusive: true
      };
    }
    if (label === '中') {
      return {
        minZ: QUICK_ZOOM_PINCH_MID_MIN,
        maxZ: QUICK_ZOOM_PINCH_MID_MAX,
        maxExclusive: true
      };
    }
    if (label === '远') {
      return {
        minZ: QUICK_ZOOM_PINCH_FAR_MIN,
        maxZ: deviceMax,
        maxExclusive: false
      };
    }
    return null;
  },
  /**
   * 当前激活快捷档的双指微调区间；未开启或无选中档时返回 null。
   * @returns {{ minZ: number, maxZ: number, maxExclusive: boolean }|null}
   */
  _getQuickZoomActivePinchRange: function () {
    if (!this.data.quickZoomEnabled) return null;
    var stops = this.data.quickZoomStops || [];
    var active = null;
    var i;
    for (i = 0; i < stops.length; i++) {
      if (stops[i].isActive) {
        active = stops[i];
        break;
      }
    }
    if (!active) return null;
    return this._getQuickZoomPinchBandByLabel(active.label);
  },
  /**
   * 将双指缩放值钳位到当前激活档的微调区间（未选中档时不钳位）。
   * @param {number} zoomVal
   * @returns {number}
   */
  _clampQuickZoomPinchValue: function (zoomVal) {
    var band = this._getQuickZoomActivePinchRange();
    if (!band) return zoomVal;
    var z = Number(zoomVal);
    if (!isFinite(z)) return zoomVal;
    var maxZ = band.maxZ;
    if (band.maxExclusive) {
      maxZ = Math.round((band.maxZ - 0.1) * 10) / 10;
    }
    maxZ = Math.max(band.minZ, maxZ);
    z = Math.max(band.minZ, Math.min(maxZ, z));
    return Math.round(z * 10) / 10;
  },
  /**
   * 按固定区间 [1,2) / [2,4) / [4,max] 判定 zoom 所属快捷档 index。
   * @param {number} zoomVal
   * @returns {number} 0|1|2 或 -1
   */
  _findQuickZoomStopIndexByBand: function (zoomVal) {
    var stops = this.data.quickZoomStops || [];
    if (stops.length !== 3) return -1;
    var z = Number(zoomVal);
    if (!isFinite(z)) return -1;
    var label = null;
    if (z >= QUICK_ZOOM_PINCH_FAR_MIN) {
      label = '远';
    } else if (z >= QUICK_ZOOM_PINCH_MID_MIN) {
      label = '中';
    } else if (z >= QUICK_ZOOM_PINCH_NEAR_MIN) {
      label = '近';
    } else {
      return -1;
    }
    for (var i = 0; i < stops.length; i++) {
      if (stops[i].label === label) return i;
    }
    return -1;
  },
  /**
   * 按当前 zoom 同步快捷变焦档位高亮（与机位药丸切换联动）。
   * @param {number} zoomVal
   * @param {{ clearTemp?: boolean }} [opts] clearTemp 默认 true
   * @returns {void}
   */
  _syncQuickZoomActiveByZoom: function (zoomVal, opts) {
    if (!this.data.quickZoomEnabled) return;
    var options = opts || {};
    var clearTemp = options.clearTemp !== false;
    var stops = this.data.quickZoomStops;
    if (!stops || stops.length !== 3) return;
    var z = Number(zoomVal);
    if (!isFinite(z)) return;
    var activeIdx = this._findQuickZoomStopIndexByBand(z);
    var changed = false;
    var newStops = stops.map(function (s, idx) {
      var nextActive = idx === activeIdx;
      if (s.isActive !== nextActive) changed = true;
      return Object.assign({}, s, {
        isActive: nextActive
      });
    });
    var patch = {};
    if (changed) patch.quickZoomStops = newStops;
    if (clearTemp && (this.data.quickZoomTempZoom !== null || this.data.quickZoomTempDisplay)) {
      patch.quickZoomTempZoom = null;
      patch.quickZoomTempDisplay = '';
    }
    if (Object.keys(patch).length > 0) {
      patch.quickZoomMainDisplay = this._getQuickZoomMainDisplayText({
        quickZoomStops: patch.quickZoomStops || stops,
        quickZoomTempZoom: patch.quickZoomTempZoom !== undefined
          ? patch.quickZoomTempZoom
          : this.data.quickZoomTempZoom,
        quickZoomTempDisplay: patch.quickZoomTempDisplay !== undefined
          ? patch.quickZoomTempDisplay
          : this.data.quickZoomTempDisplay,
        zoom: z
      });
      this.setData(patch);
    }
  },
  /**
   * 按 zoom 同步抽屉机位药丸高亮（与快捷档点击联动）。
   * @param {number} zoomVal
   * @returns {void}
   */
  _syncCameraViewModeFromZoom: function (zoomVal) {
    var stops = this.data.cameraViewModeStops || [];
    var z = Number(zoomVal);
    if (!isFinite(z) || stops.length === 0) return;
    var best = null;
    var bestDist = Infinity;
    var i;
    for (i = 0; i < stops.length; i++) {
      var dist = Math.abs(stops[i].zoom - z);
      if (dist < bestDist) {
        bestDist = dist;
        best = stops[i];
      }
    }
    if (best && bestDist <= 0.25 && best.mode !== this.data.cameraViewMode) {
      this.setData({
        cameraViewMode: best.mode
      });
    }
  },
  /**
   * 从 Storage 加载快捷变焦配置；默认值取自 cameraViewModeStops（见 _buildQuickZoomDefaults）。
   * 默认保留运行时 isActive / 微调态，避免 onShow、相机 init 后 UI 与 zoom 脱节。
   * @param {{ resetRuntime?: boolean }} [opts] resetRuntime=true 时清空激活档与微调态
   * @returns {void}
   */
  _loadQuickZoomStops: function (opts) {
    var options = opts || {};
    var resetRuntime = options.resetRuntime === true;
    /** 直播中途相机能力探测会触发 reload；长按保存期间须延后，否则进度满但松手时 ready 已被清零。 */
    if (this._quickZoomSaveTimer || this._quickZoomSaveReady) {
      this._quickZoomStopsReloadPending = true;
      return;
    }
    var prevStops = this.data.quickZoomStops || [];
    var prevActiveIdx = resetRuntime ? -1 : prevStops.findIndex(function (s) {
      return s.isActive;
    });
    var prevTempZoom = resetRuntime ? null : this.data.quickZoomTempZoom;
    var recentSaveGuard = this._quickZoomLastSaveMs
      && (Date.now() - this._quickZoomLastSaveMs < QUICK_ZOOM_SAVE_GUARD_MS);
    try {
      const enabled = wx.getStorageSync(QUICK_ZOOM_ENABLED_KEY);
      const savedStops = wx.getStorageSync(QUICK_ZOOM_STOPS_KEY);
      var selfLoad = this;
      var rawDefaults = this._buildQuickZoomDefaults(this.data.cameraViewModeStops || []);
      var defaultStops = rawDefaults.map(function (s) {
        var zoom = selfLoad._clampQuickZoomValue(s.zoom);
        return {
          label: s.label,
          zoom: zoom,
          displayZoom: selfLoad._formatQuickZoomDisplay(zoom),
          isActive: false
        };
      });
      var stops = defaultStops;
      if (Array.isArray(savedStops) && savedStops.length === 3) {
        stops = savedStops.map(function (s, i) {
          var rawZoom = typeof s.zoom === 'number' && s.zoom > 0 ? s.zoom : defaultStops[i].zoom;
          var zoom = selfLoad._clampQuickZoomValue(rawZoom);
          return {
            label: defaultStops[i].label,
            zoom: zoom,
            displayZoom: selfLoad._formatQuickZoomDisplay(zoom),
            isActive: false
          };
        });
      }
      if (prevActiveIdx >= 0 && prevActiveIdx < stops.length) {
        stops = stops.map(function (s, i) {
          return Object.assign({}, s, {
            isActive: i === prevActiveIdx
          });
        });
      }
      /** 刚保存完时优先保留内存中的 zoom，避免 storage 读写竞态把档位打回旧值。 */
      if (recentSaveGuard && prevStops.length === 3 && stops.length === 3) {
        stops = stops.map(function (s, i) {
          var mem = prevStops[i];
          if (!mem || typeof mem.zoom !== 'number') return s;
          return Object.assign({}, s, {
            zoom: mem.zoom,
            displayZoom: mem.displayZoom || selfLoad._formatQuickZoomDisplay(mem.zoom)
          });
        });
      }
      var patch = {
        quickZoomEnabled: !!enabled,
        quickZoomStops: stops
      };
      if (resetRuntime) {
        patch.quickZoomTempZoom = null;
        patch.quickZoomTempDisplay = '';
        patch.quickZoomSaveConicDeg = 0;
        patch.quickZoomSaveProgressStyle = '';
        patch.quickZoomSaveIdx = -1;
      } else if (typeof prevTempZoom === 'number') {
        var activeIdx = stops.findIndex(function (s) {
          return s.isActive;
        });
        if (activeIdx >= 0) {
          var clampedTemp = this._clampQuickZoomValue(prevTempZoom);
          var savedZoom = stops[activeIdx].zoom;
          if (Math.abs(clampedTemp - savedZoom) > 0.05) {
            patch.quickZoomTempZoom = clampedTemp;
            patch.quickZoomTempDisplay = this._formatQuickZoomDisplay(clampedTemp);
          } else {
            patch.quickZoomTempZoom = null;
            patch.quickZoomTempDisplay = '';
          }
        } else {
          patch.quickZoomTempZoom = null;
          patch.quickZoomTempDisplay = '';
        }
      }
      patch.quickZoomMainDisplay = this._getQuickZoomMainDisplayText({
        quickZoomStops: patch.quickZoomStops || stops,
        quickZoomTempZoom: patch.quickZoomTempZoom !== undefined
          ? patch.quickZoomTempZoom
          : this.data.quickZoomTempZoom,
        quickZoomTempDisplay: patch.quickZoomTempDisplay !== undefined
          ? patch.quickZoomTempDisplay
          : this.data.quickZoomTempDisplay
      });
      this.setData(patch);
      this.appendHealthLog('quick_zoom_stops_loaded', {
        enabled: !!enabled,
        hasSavedStops: Array.isArray(savedStops) && savedStops.length === 3,
        nativeStopsCount: (this.data.cameraViewModeStops || []).length,
        preservedActiveIdx: prevActiveIdx,
        stops: stops.map(function (s) {
          return { label: s.label, zoom: s.zoom, isActive: s.isActive };
        })
      });
    } catch (e) {
      // Storage 读取失败，保留 data 默认值
    }
  },
  /**
   * 切换快速变焦开关（来自抽屉）。
   * @returns {void}
   */
  onQuickZoomToggle: function () {
    const next = !this.data.quickZoomEnabled;
    this.setData({
      quickZoomEnabled: next,
      quickZoomMenuOpen: false
    });
    try {
      wx.setStorageSync(QUICK_ZOOM_ENABLED_KEY, next);
    } catch (e) {}
    if (next) {
      /** 关闭后重新开启：清空已保存倍数，恢复默认 4× / 2× / 1×。 */
      const resetStops = this._buildFixedQuickZoomStops();
      try {
        wx.removeStorageSync(QUICK_ZOOM_STOPS_KEY);
      } catch (eRm) {}
      this._quickZoomLastSaveMs = 0;
      this.setData({
        quickZoomStops: resetStops,
        quickZoomTempZoom: null,
        quickZoomTempDisplay: '',
        quickZoomMainDisplay: this._getQuickZoomMainDisplayText({
          quickZoomStops: resetStops,
          quickZoomTempZoom: null,
          quickZoomTempDisplay: ''
        })
      });
    } else {
      const stops = this.data.quickZoomStops.map(function (s) {
        return Object.assign({}, s, {
          isActive: false
        });
      });
      this.setData({
        quickZoomStops: stops,
        quickZoomTempZoom: null,
        quickZoomTempDisplay: '',
        quickZoomMainDisplay: this._getQuickZoomMainDisplayText({
          quickZoomStops: stops,
          quickZoomTempZoom: null,
          quickZoomTempDisplay: ''
        })
      });
    }
  },
  /**
   * 计算主变焦按钮应展示的倍数文案。
   * @param {{ quickZoomTempZoom?: number|null, quickZoomTempDisplay?: string, quickZoomStops?: Array<{displayZoom:string,isActive:boolean}>, zoom?: number }} [ctx]
   * @returns {string}
   */
  _getQuickZoomMainDisplayText: function (ctx) {
    var state = ctx || {};
    var tempZoom = state.quickZoomTempZoom !== undefined
      ? state.quickZoomTempZoom
      : this.data.quickZoomTempZoom;
    var tempDisplay = state.quickZoomTempDisplay !== undefined
      ? state.quickZoomTempDisplay
      : this.data.quickZoomTempDisplay;
    if (tempZoom !== null && tempDisplay) {
      return tempDisplay;
    }
    var stops = state.quickZoomStops || this.data.quickZoomStops || [];
    var i;
    for (i = 0; i < stops.length; i++) {
      if (stops[i].isActive) {
        return stops[i].displayZoom;
      }
    }
    var zoomVal = state.zoom !== undefined ? state.zoom : this.data.zoom;
    var bandIdx = this._findQuickZoomStopIndexByBand(zoomVal);
    if (bandIdx >= 0 && stops[bandIdx]) {
      return stops[bandIdx].displayZoom;
    }
    return formatCameraZoomLabel(zoomVal);
  },
  /**
   * 返回当前激活的快捷变焦档位 index，无激活档时返回 -1。
   * @returns {number}
   */
  _findQuickZoomActiveIdx: function () {
    var stops = this.data.quickZoomStops || [];
    var i;
    for (i = 0; i < stops.length; i++) {
      if (stops[i].isActive) return i;
    }
    return -1;
  },
  /**
   * 收起快捷变焦折叠菜单。
   * @returns {void}
   */
  _closeQuickZoomMenu: function () {
    if (!this.data.quickZoomMenuOpen) return;
    this.setData({
      quickZoomMenuOpen: false
    });
  },
  /**
   * 主变焦按钮：展开/收起档位列表。
   * @returns {void}
   */
  onQuickZoomMainTap: function () {
    if (this._quickZoomSuppressTap) return;
    this.setData({
      quickZoomMenuOpen: !this.data.quickZoomMenuOpen
    });
  },
  /**
   * 主变焦按钮长按：对当前激活档启动保存进度（菜单收起时）。
   * @returns {void}
   */
  onQuickZoomMainTouchStart: function () {
    if (this.data.quickZoomMenuOpen) return;
    var activeIdx = this._findQuickZoomActiveIdx();
    if (activeIdx < 0) return;
    this._startQuickZoomStopLongPress(activeIdx);
  },
  /**
   * 点击快速变焦档位——非激活档切换倍数；激活档恢复保存值（不清除存储，仅复位临时微调）。
   * @param {WechatMiniprogram.TouchEvent} e dataset.index: 0|1|2
   * @returns {void}
   */
  onQuickZoomStopTap: function (e) {
    if (this._quickZoomSuppressTap) return;
    const idx = e && e.currentTarget && e.currentTarget.dataset
      ? Number(e.currentTarget.dataset.index)
      : -1;
    if (idx < 0 || idx > 2) return;
    if (this.data.enhanceMode === 'vk') return;
    if (!this.data.cameraMounted || !this.data.cameraContext || !this._cameraInitDone) return;

    const stops = this.data.quickZoomStops;
    const newStops = stops.map(function (s, i) {
      return Object.assign({}, s, {
        isActive: i === idx
      });
    });
    this.setData({
      quickZoomStops: newStops,
      quickZoomTempZoom: null,
      quickZoomTempDisplay: '',
      quickZoomMenuOpen: false,
      quickZoomMainDisplay: this._getQuickZoomMainDisplayText({
        quickZoomStops: newStops,
        quickZoomTempZoom: null,
        quickZoomTempDisplay: '',
        zoom: newStops[idx].zoom
      })
    });
    this.updateZoom(newStops[idx].zoom);
    this._syncCameraViewModeFromZoom(newStops[idx].zoom);
  },
  /**
   * 长按快捷变焦档位：启动 0.8s 圆环进度，松手后写入当前 zoom（仅激活档有效）。
   * @param {number} idx 0|1|2
   * @returns {void}
   */
  _startQuickZoomStopLongPress: function (idx) {
    if (idx < 0 || idx > 2) return;
    if (this.data.enhanceMode === 'vk') return;
    if (!this.data.cameraMounted || !this.data.cameraContext || !this._cameraInitDone) return;
    const stops = this.data.quickZoomStops;
    if (!stops[idx] || !stops[idx].isActive) return;

    this._cancelQuickZoomSaveProgress();
    this._quickZoomSaveIdx = idx;
    this._quickZoomSaveReady = false;
    this._quickZoomSaveStartMs = Date.now();
    this.setData({
      quickZoomSaveIdx: idx,
      quickZoomSaveConicDeg: 0,
      quickZoomSaveProgressStyle: this._buildQuickZoomSaveProgressStyle(0)
    });
    const self = this;
    /**
     * 递归 setTimeout 降低 setData 频率（约 64ms），录制中减轻主线程压力。
     * @returns {void}
     */
    var tickSaveProgress = function () {
      if (self._quickZoomSaveIdx !== idx) return;
      const elapsed = Date.now() - self._quickZoomSaveStartMs;
      const deg = Math.min(360, elapsed / QUICK_ZOOM_LONG_PRESS_MS * 360);
      self.setData({
        quickZoomSaveConicDeg: deg,
        quickZoomSaveProgressStyle: self._buildQuickZoomSaveProgressStyle(deg)
      });
      if (elapsed >= QUICK_ZOOM_LONG_PRESS_MS) {
        self._quickZoomSaveTimer = null;
        self._quickZoomSaveReady = true;
        var rawCap = typeof self.data.quickZoomTempZoom === 'number'
          ? self.data.quickZoomTempZoom
          : self.data.zoom;
        self._quickZoomSaveCapturedZoom = self._clampQuickZoomValue(rawCap);
        try {
          self.vibrate('light');
        } catch (eV) {}
        return;
      }
      self._quickZoomSaveTimer = setTimeout(tickSaveProgress, 64);
    };
    this._quickZoomSaveTimer = setTimeout(tickSaveProgress, 64);
  },
  /**
   * 长按快速变焦档位：启动 0.8s 圆环进度，松手后写入当前 zoom。
   * @param {WechatMiniprogram.TouchEvent} e dataset.index: 0|1|2
   * @returns {void}
   */
  onQuickZoomStopTouchStart: function (e) {
    const idx = e && e.currentTarget && e.currentTarget.dataset
      ? Number(e.currentTarget.dataset.index)
      : -1;
    this._startQuickZoomStopLongPress(idx);
  },
  /**
   * 快速变焦档位松手：进度满则保存当前 zoom 到该档。
   * @returns {void}
   */
  onQuickZoomStopTouchEnd: function () {
    const idx = this._quickZoomSaveIdx;
    const ready = !!this._quickZoomSaveReady;
    const capturedZoom = this._quickZoomSaveCapturedZoom;
    this._cancelQuickZoomSaveProgress();
    if (!ready || idx < 0 || idx > 2) {
      this._flushPendingQuickZoomStopsReload();
      return;
    }
    this._quickZoomSuppressTap = true;
    const self = this;
    setTimeout(function () {
      self._quickZoomSuppressTap = false;
    }, 120);
    this._commitQuickZoomStopSave(idx, capturedZoom);
    this._flushPendingQuickZoomStopsReload();
  },
  /**
   * 取消快速变焦长按保存进度动画。
   * @returns {void}
   */
  _cancelQuickZoomSaveProgress: function () {
    if (this._quickZoomSaveTimer) {
      clearTimeout(this._quickZoomSaveTimer);
      this._quickZoomSaveTimer = null;
    }
    this._quickZoomSaveReady = false;
    this._quickZoomSaveIdx = -1;
    this._quickZoomSaveStartMs = 0;
    this._quickZoomSaveCapturedZoom = null;
    this.setData({
      quickZoomSaveIdx: -1,
      quickZoomSaveConicDeg: 0,
      quickZoomSaveProgressStyle: ''
    });
  },
  /**
   * 将当前实际 zoom 写入指定快速变焦档位并持久化。
   * @param {number} idx 0|1|2
   * @param {number|null|undefined} capturedZoom 长按进度满时快照的 zoom，避免 reload 后取值失真
   * @returns {void}
   */
  _commitQuickZoomStopSave: function (idx, capturedZoom) {
    const stops = this.data.quickZoomStops;
    if (!stops[idx]) return;

    var rawZoom = typeof capturedZoom === 'number' && isFinite(capturedZoom)
      ? capturedZoom
      : (typeof this.data.quickZoomTempZoom === 'number'
        ? this.data.quickZoomTempZoom
        : this.data.zoom);
    const currentZoom = this._clampQuickZoomValue(rawZoom);
    const zoomLabel = this._formatQuickZoomDisplay(currentZoom);

    const newStops = stops.map(function (s, i) {
      if (i !== idx) return Object.assign({}, s);
      return Object.assign({}, s, {
        zoom: currentZoom,
        displayZoom: this._formatQuickZoomDisplay(currentZoom)
      });
    }.bind(this));
    this.setData({
      quickZoomStops: newStops,
      quickZoomTempZoom: null,
      quickZoomTempDisplay: '',
      quickZoomMainDisplay: this._getQuickZoomMainDisplayText({
        quickZoomStops: newStops,
        quickZoomTempZoom: null,
        quickZoomTempDisplay: ''
      })
    });
    var persistOk = false;
    try {
      var toStore = newStops.map(function (s) {
        return {
          zoom: s.zoom
        };
      });
      wx.setStorageSync(QUICK_ZOOM_STOPS_KEY, toStore);
      var verify = wx.getStorageSync(QUICK_ZOOM_STOPS_KEY);
      persistOk = Array.isArray(verify) && verify.length === 3
        && typeof verify[idx].zoom === 'number'
        && Math.abs(verify[idx].zoom - currentZoom) < 0.05;
    } catch (e2) {}
    if (persistOk) {
      this._quickZoomLastSaveMs = Date.now();
      this._showLightHint('已保存 ' + zoomLabel);
    } else {
      this._showLightHint('保存失败，请重试');
    }
  },
  /**
   * 在双指缩放（pinch）结束时，若有激活的快速变焦档位，记录临时 zoom。
   * @returns {void}
   */
  _syncQuickZoomTempZoom: function () {
    if (!this.data.quickZoomEnabled) return;
    const activeIdx = this.data.quickZoomStops.findIndex(function (s) {
      return s.isActive;
    });
    if (activeIdx < 0) return;

    const currentZoom = this.data.zoom;
    const savedZoom = this.data.quickZoomStops[activeIdx].zoom;
    const rounded = Math.round(currentZoom * 10) / 10;
    const isDifferent = Math.abs(currentZoom - savedZoom) > 0.05;

    if (isDifferent) {
      var tempDisplay = this._formatQuickZoomDisplay(rounded);
      this.setData({
        quickZoomTempZoom: rounded,
        quickZoomTempDisplay: tempDisplay,
        quickZoomMainDisplay: tempDisplay
      });
    } else {
      this.setData({
        quickZoomTempZoom: null,
        quickZoomTempDisplay: '',
        quickZoomMainDisplay: this._getQuickZoomMainDisplayText({
          quickZoomTempZoom: null,
          quickZoomTempDisplay: ''
        })
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
  onTouchStart: function (e) {
    if (e.touches && e.touches.length >= 2) {
      this._everHadMultiTouch = true;
      this._aeTwoFinger = {
        startMidY: (e.touches[0].pageY + e.touches[1].pageY) / 2,
        startDist: this.getDistance(e.touches[0], e.touches[1]) || 1,
        maxDown: 0,
        zoomed: false
      };
      this.isPinching = true;
      this.isMultiTouch = true;
      this.pinchStartDistance = this.getDistance(e.touches[0], e.touches[1]);
      this.pinchStartZoom = this.data.zoom;
    } else if (e.touches && e.touches.length === 1) {
      this._everHadMultiTouch = false;
      this._preTapValid = true;
      this._tapStart = {
        x: e.touches[0].pageX,
        y: e.touches[0].pageY
      };
      /**
       * 旧逻辑：live 态下单指在画面任意处竖滑调 EV，但这会吃掉“点击画面移动对焦框”的 tap。
       * 现在 EV 仅由右侧小太阳滑条负责，画面 tap 始终用于移动对焦框，互不干扰。
       */
      this._aeLiveAdjustStartY = null;
      this._aeLiveAdjustStartNorm = 0.5;
    }
  },
  onTouchMove: function (e) {
    // EV 调节已收敛到右侧小太阳滑条，画面单指移动不再抢占 EV，避免与 tap 对焦冲突
    if (e.touches && e.touches.length === 1 && this._tapStart) {
      const t = e.touches[0];
      const dx = t.pageX - this._tapStart.x;
      const dy = t.pageY - this._tapStart.y;
      if (Math.abs(dx) > AE_PRE_TAP_SLOP_PX || Math.abs(dy) > AE_PRE_TAP_SLOP_PX) {
        this._preTapValid = false;
      }
    }
    if (e.touches && e.touches.length >= 2) {
      this.isMultiTouch = true;
      if (this._aeTwoFinger && e.touches.length >= 2) {
        const d0 = this.getDistance(e.touches[0], e.touches[1]);
        if (d0 > 0 && this._aeTwoFinger.startDist > 0) {
          if (Math.abs(d0 - this._aeTwoFinger.startDist) / this._aeTwoFinger.startDist > AE_PINCH_VS_SWIPE_DIST_RATIO) {
            this._aeTwoFinger.zoomed = true;
          }
        }
        const midY = (e.touches[0].pageY + e.touches[1].pageY) / 2;
        const down = midY - this._aeTwoFinger.startMidY;
        if (down > this._aeTwoFinger.maxDown) {
          this._aeTwoFinger.maxDown = down;
        }
      }
    }
    if (!this.isPinching || !e.touches || e.touches.length < 2 || this.pinchStartDistance <= 0) {
      return;
    }
    const currentDistance = this.getDistance(e.touches[0], e.touches[1]);
    if (currentDistance <= 0) return;
    const ratio = currentDistance / this.pinchStartDistance;
    var newZoomVal = this.pinchStartZoom * ratio;
    newZoomVal = this._clampQuickZoomPinchValue(newZoomVal);
    this.updateZoom(newZoomVal);
  },
  onTouchEnd: function (e) {
    this.onScoreTouchEnd(); // 防止干扰记分长按
    if (e.touches && e.touches.length === 0) {
      if (this._aeTwoFinger) {
        this._aeTwoFinger = null;
      }
      if (!this._everHadMultiTouch && this._preTapValid && this._tapStart
      /** 仅当用户已主动呼出对焦/曝光（pre 或 live）时，单击预览区才移动对焦点，避免被动打扰。 */ && this.data.aeControlsVisible && (this.data.aeContext === 'pre' || this.data.aeContext === 'live') && !this.data.aeFocusUserLocked && e.changedTouches && e.changedTouches[0]) {
        const t = e.changedTouches[0];
        const dx = t.pageX - this._tapStart.x;
        const dy = t.pageY - this._tapStart.y;
        if (Math.abs(dx) < AE_PRE_TAP_SLOP_PX && Math.abs(dy) < AE_PRE_TAP_SLOP_PX) {
          this.applyPreGameFocusAtPage(t.pageX, t.pageY);
        }
      }
      this._aeLiveAdjustStartY = null;
      this._aeLiveAdjustStartNorm = 0.5;
      this._tapStart = null;
      this._preTapValid = true;
    }
    if (!e.touches || e.touches.length === 0) {
      this.isPinching = false;
      this.pinchStartDistance = 0;
      this._syncQuickZoomTempZoom();
      // 延迟重置多指锁，避免 touchend 与 longpress 事件时序竞争
      setTimeout(() => {
        this.isMultiTouch = false;
      }, 200);
    } else if (!e.touches || e.touches.length < 2) {
      this.isPinching = false;
      this.pinchStartDistance = 0;
      this._syncQuickZoomTempZoom();
    } else if (this.isPinching) {
      // 仍然有两个或以上手指在屏幕上，重置缩放基准
      this.pinchStartDistance = this.getDistance(e.touches[0], e.touches[1]);
      this.pinchStartZoom = this.data.zoom;
    }
  },
  /**
   * 左下角与 REC 对称的「相机」快捷：展开/收拢变焦+对焦行。
   * @returns {void}
   */
  onCameraSettingsFabTap: function () {
    if (this.data.drawerMode !== 0) return;
    if (this.data.enhanceMode === 'vk') return;
    if (!this.data.cameraMounted || !this.data.liveStreamAllowed || this.data.isReplaying) return;
    try {
      this._updateLiveStageLayout();
    } catch (eU) {}
    this.setData({
      cameraSettingsOpen: !this.data.cameraSettingsOpen
    });
  },
  /**
   * 机位药丸：广角 / 数字倍数；关闭侧栏以减轻挡视野。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onCameraViewModeTap: function (e) {
    var mode = e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.mode : '';
    if (!mode) return;
    this.applyViewMode(mode);
    this.setData({
      cameraSettingsOpen: false
    });
  },
  /**
   * 「调焦/变焦」侧栏内「对焦」项：呼出对焦点与曝光条。
   * @returns {void}
   */
  onCameraFocusControlTap: function () {
    if (!this.data.cameraMounted || !this.data.cameraContext || !this._cameraInitDone) return;
    this.setData({
      cameraSettingsOpen: false
    });
    this.wakeLiveAeControls();
    // 关闭抽屉，让用户能看到对焦/曝光控件
    if (this.data.drawerMode === 1) {
      this.setData({
        drawerMode: 0
      });
    }
  },
  /**
   * 切换直播画幅比例 (从弹出面板触发)
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onChangeAspectMode: function (e) {
    const targetMode = e.currentTarget.dataset.mode;
    if (!targetMode || targetMode === this.data.liveVideoAspectMode) {
      if (this.data.aspectModePanelOpen) {
        this.setData({ aspectModePanelOpen: false });
      }
      return;
    }

    const applyMode = () => {
      this.setData({
        liveVideoAspectMode: targetMode,
        aspectModePanelOpen: false
      });
      try {
        wx.setStorageSync('live_video_aspect_mode', targetMode);
      } catch (err) {}

      if (targetMode === '16x9') {
        wx.showModal({
          title: '⚠️ 抖音直播设置提示',
          content: '切换为 16:9 画幅后，为避免抖音画面出现黑边或被严重压缩，请务必在抖音开播前，将【画面方向】设置为【横屏】。',
          showCancel: false,
          confirmText: '我知道了'
        });
      }

      wx.showLoading({ title: '切换画幅中' });
      this._teardownEnhanceRender();
      this.rebuildCameraComponent((generation) => {
        if (!this._livePageVisible) return;
        this.remountCameraComponent({
          generation,
          onMounted: () => {
            wx.hideLoading();
            this._updateLiveStageLayout();
            this._showLightHint(targetMode === '16x9' ? '已切为 16:9 画幅' : '已切为满屏画幅');
          }
        });
      }, 'aspect_mode_change');
    };

    if (this.data.isRecording || this.rollingActive) {
      wx.showModal({
        title: '正在录像中',
        content: '切换画幅需要重启相机，当前录像将会分段。是否确认切换？',
        success: (res) => {
          if (res.confirm) {
            this.rollingActive = false;
            this.stopRollingRecording(() => applyMode());
          }
        }
      });
    } else {
      applyMode();
    }
  },
  /**
   * 点击抽屉工具条「画幅」：展开/收起画幅选择面板。
   * @returns {void}
   */
  onAspectModePanelTap: function () {
    if (this.data.aspectModePanelOpen) {
      this.setData({ aspectModePanelOpen: false });
      return;
    }
    if (this.data.drawerMode === 1) {
      this.stopEnhanceFpsPolling();
    }
    this.setData({
      drawerMode: 0,
      aspectModePanelOpen: true
    });
  },
  /**
   * 轻点遮罩关闭画幅选择面板。
   * @returns {void}
   */
  onAspectModePanelBackdropTap: function () {
    this.setData({ aspectModePanelOpen: false });
  },
  getDistance: function (p1, p2) {
    const x = p2.pageX - p1.pageX;
    const y = p2.pageY - p1.pageY;
    return Math.sqrt(x * x + y * y);
  },
  /**
   * 将点击坐标归一化到 0–1，与 16:9 取景内接框（{@link computeLiveStage16x9RectPx}）对齐；
   * 全窗口映射会导致取景区外黑边上的点压在 0/1 边界，与 camera 全屏/裁切与 setTargetFocus 预期不一致。
   * @param {number} pageX
   * @param {number} pageY
   * @returns {{ nx: number, ny: number }}
   */
  pageXYToCameraNorm: function (pageX, pageY) {
    let w = 375;
    let h = 667;
    try {
      const si = wx.getSystemInfoSync();
      w = si.windowWidth || w;
      h = si.windowHeight || h;
    } catch (e) {}
    const r = computeLiveStage16x9RectPx(w, h);
    const nx0 = (pageX - r.left) / Math.max(1, r.w);
    const ny0 = (pageY - r.top) / Math.max(1, r.h);
    return {
      nx: Math.max(0, Math.min(1, nx0)),
      ny: Math.max(0, Math.min(1, ny0))
    };
  },
  /**
   * 在部分基础库/灰度中存在的对焦 API；官方文档常滞后。不存在时仅作 UI 提示，不抛错。
   * @param {number} nx 0–1
   * @param {number} ny 0–1
   * @returns {void}
   */
  invokeSetTargetFocus: function (nx, ny) {
    const ctx = this.data.cameraContext;
    if (!ctx) return;
    if (typeof ctx.setTargetFocus === 'function') {
      try {
        ctx.setTargetFocus({
          x: nx,
          y: ny
        });
        return;
      } catch (e) {}
    }
  },
  /**
   * 探测当前相机上下文是否支持硬件 EV 调节。
   * 仅在 onCameraInit（或重建后）调用一次，探测结果写入 {@link data.aeExposureHardwareSupported}。
   * 判定口径：只要 cameraContext 暴露 setExposureCompensation / setEV / setExposureOffset 任一接口，即视为支持。
   * 注意：小程序内 <camera> 组件在部分机型（尤其低版本基础库的 Android）上不提供上述接口——
   * 此时完全不展示曝光滑条，避免“界面能动但实际不生效”的伪交互。
   * @returns {boolean}
   */
  detectExposureHardwareSupport: function () {
    const ctx = this.data.cameraContext;
    const supported = !!(ctx && (typeof ctx.setExposureCompensation === 'function' || typeof ctx.setEV === 'function' || typeof ctx.setExposureOffset === 'function'));
    if (this.data.aeExposureHardwareSupported !== supported) {
      this.setData({
        aeExposureHardwareSupported: supported
      });
    }
    return supported;
  },
  /**
   * 将「小太阳」归一化位映射为曝光补偿，仅走硬件 EV 接口。
   * 硬件不支持的机型不调用任何伪补偿逻辑——见 {@link detectExposureHardwareSupport} 设计说明。
   * 性能：录制中用 {@link _flushExposureNormToData} 节流，避免与编码同帧连打 setData。
   * @param {number} norm 0=偏暗, 0.5=中心, 1=偏亮
   * @returns {void}
   */
  applyExposureFromNorm: function (norm) {
    if (!this.data.aeExposureHardwareSupported) return;
    const n = Math.max(0, Math.min(1, norm));
    this._exposureNormPending = n;
    this._exposureValueEV = (n - 0.5) * 4;
    const ctx = this.data.cameraContext;
    if (!ctx) {
      this._flushExposureNormToData(true);
      return;
    }
    const ev = this._exposureValueEV;
    if (typeof ctx.setExposureCompensation === 'function') {
      try {
        ctx.setExposureCompensation({
          value: ev
        });
      } catch (e) {}
    } else if (typeof ctx.setEV === 'function') {
      try {
        ctx.setEV({
          ev: ev
        });
      } catch (e) {}
    } else if (typeof ctx.setExposureOffset === 'function') {
      try {
        ctx.setExposureOffset({
          offset: ev
        });
      } catch (e) {}
    }
    if (this.data.isRecording) {
      this._flushExposureNormToData(false);
    } else {
      this._flushExposureNormToData(true);
    }
  },
  /**
   * 将内部曝光 norm 写回小太阳位置；录制中可节流，交互结束可 force。
   * @param {boolean} force 是否跳过节流立即 setData
   * @returns {void}
   */
  _flushExposureNormToData: function (force) {
    const n = typeof this._exposureNormPending === 'number' ? this._exposureNormPending : 0.5;
    const now = Date.now();
    if (!force && this.data.isRecording) {
      if (now - (this._lastExposureSetDataAt || 0) < AE_EXPOSURE_SETDATA_THROTTLE_MS) {
        if (this._exposureSetDataTimer) clearTimeout(this._exposureSetDataTimer);
        this._exposureSetDataTimer = setTimeout(() => {
          this._exposureSetDataTimer = null;
          this._flushExposureNormToData(true);
        }, AE_EXPOSURE_SETDATA_THROTTLE_MS);
        return;
      }
    }
    this._lastExposureSetDataAt = now;
    this.setData({
      aeSunTopPct: Math.round((1 - n) * 100)
    });
  },
  /**
   * 双指离开且变焦静止后，对几何中心执行一次不展示 UI 的对焦，缓解数码变焦后虚焦。
   * 通过 {@link updateZoom} 内防抖触发，避免捏合过程高频调用。
   * @returns {void}
   */
  silentRefocusGeometricCenter: function () {
    this.invokeSetTargetFocus(0.5, 0.5);
  },
  /**
   * 直播态相机锁定：固定对焦中心 + 固定当前曝光值，全程不随云台转动重新评估。
   * 在进入直播（liveStreamAllowed）且相机就绪后调用一次；相机重建后（onCameraInit）自动重放。
   * @returns {void}
   */
  _applyLiveCameraLock: function () {
    const ctx = this.data.cameraContext;
    if (!ctx) return;

    // 1. 把对焦点锁在画面中心（几何中心是篮球场景最合理的锚点）
    this.invokeSetTargetFocus(0.5, 0.5);
    this._lastFocusNorm = { nx: 0.5, ny: 0.5 };

    // 2. 固定曝光：用当前环境已测光的值，不强制归中，避免场馆偏暗时画面变黑
    if (this.data.aeExposureHardwareSupported) {
      const norm = typeof this._exposureNormPending === 'number'
        ? this._exposureNormPending
        : 0.5;
      this.applyExposureFromNorm(norm);
    }

    // 3. 锁定状态写入 data，同时隐藏 AE 控件（直播中不需要常驻画面）
    this.setData({
      aeFocusUserLocked: true,
      aeControlsVisible: false,
      aeContext: '',
      aeShowDoubleTapHint: false
    });

    // 4. 清除所有自动隐藏计时器，防止 3s 后误触发 hide 流程
    this.clearAeLiveHideTimer();
    if (this._aeDoubleTapHintTimer) {
      clearTimeout(this._aeDoubleTapHintTimer);
      this._aeDoubleTapHintTimer = null;
    }

    this.appendHealthLog('live_camera_lock_applied', {
      exposureNorm: typeof this._exposureNormPending === 'number'
        ? this._exposureNormPending
        : 0.5
    });
  },

  /**
   * 启用直播相机锁定模式：标记 armed 并立即执行一次锁定（若相机已就绪）。
   * 在权益通过、直播正式开始时由 refreshLiveEntitlementAndResume 调用。
   * 相机重建后由 onCameraInit 通过 _liveAeCameraLockArmed 标志自动重放锁定。
   * @returns {void}
   */
  armLiveCameraLock: function () {
    this._liveAeCameraLockArmed = true;
    if (this._cameraInitDone && this.data.cameraContext && this.data.liveStreamAllowed) {
      if (isLiveHostIos()) {
        this._applyLiveCameraLock();
      } else {
        this._scheduleDeferredLiveCameraLock('arm_live_camera_lock');
      }
    }
  },
  /**
   * 变焦量变化时重置静默对焦定时器；与缩放手势「争用」：仅响应 zoom 的实质变化，而非手指 xy。
   * @returns {void}
   */
  maybeSchedulePostZoomSilentFocus: function () {
    if (this._postZoomFocusTimer) {
      clearTimeout(this._postZoomFocusTimer);
      this._postZoomFocusTimer = null;
    }
    this._postZoomFocusTimer = setTimeout(() => {
      this._postZoomFocusTimer = null;
      // 捏合过程会导致短时帧时升高（UI setData 密集），统一先告知渲染管线暂停一次自动降级评估，
      // 再下发静默中心对焦；避免「变焦→误判掉帧→被拉到 lite」。
      if (this._renderPipeline && typeof this._renderPipeline.pauseAutoDegradeOnce === 'function') {
        this._renderPipeline.pauseAutoDegradeOnce();
      }
      this.silentRefocusGeometricCenter();
    }, AE_POST_ZOOM_SILENT_FOCUS_MS);
  },
  /**
   * 在预览区任意点击位置放置/移动对焦框：开赛前（pre）与直播态（含左下「相机 → 对焦」）共用。
   * live 态下每次点击都会续期 3s 自动隐藏计时器，且会把“中心模式簇”切换到“点击点模式簇”。
   * @param {number} pageX
   * @param {number} pageY
   * @returns {void}
   */
  applyPreGameFocusAtPage: function (pageX, pageY) {
    const {
      nx,
      ny
    } = this.pageXYToCameraNorm(pageX, pageY);
    this.invokeSetTargetFocus(nx, ny);
    let rpxFactor = 750 / 375;
    let rpxH = 1334;
    try {
      const si = wx.getSystemInfoSync();
      rpxFactor = 750 / (si.windowWidth || 375);
      rpxH = (si.windowHeight || 667) * rpxFactor;
    } catch (e) {
      rpxH = 1334;
    }
    const halfB = AE_BRACKET_RPX / 2;
    let rpxX = pageX * rpxFactor;
    let rpxY = pageY * rpxFactor;
    /** 方框中心与点击点一致；曝光条在屏幕右侧独立层，不占用本簇宽度。 */
    this._lastFocusNorm = {
      nx,
      ny
    };
    let clusterLeft = rpxX - halfB;
    let clusterTop = rpxY - halfB;
    const maxL = Math.max(0, 750 - AE_BRACKET_RPX);
    const maxT = Math.max(0, rpxH - AE_BRACKET_RPX - AE_CLUSTER_EXTRA_BELOW_RPX);
    clusterLeft = Math.max(0, Math.min(maxL, clusterLeft));
    clusterTop = Math.max(0, Math.min(maxT, clusterTop));
    if (this._aeFocusLockFlashTimer) {
      clearTimeout(this._aeFocusLockFlashTimer);
      this._aeFocusLockFlashTimer = null;
    }
    if (this._aeDoubleTapHintTimer) {
      clearTimeout(this._aeDoubleTapHintTimer);
      this._aeDoubleTapHintTimer = null;
    }
    try {
      wx.vibrateShort({
        type: 'light'
      });
    } catch (eV) {}
    /** 直播长按呼出后继续保持 live 上下文，避免 3s 自动隐藏失效；开赛前首次 tap 切到 pre。 */
    const nextCtx = this.data.aeContext === 'live' ? 'live' : 'pre';
    const patch = {
      aeControlsVisible: true,
      aeContext: nextCtx,
      aeFocusIsTapPosition: true,
      aeClusterLeftRpx: clusterLeft,
      aeClusterTopRpx: clusterTop,
      aeFocusLockFlash: true,
      aeFocusUserLocked: false,
      aeShowDoubleTapHint: true
    };
    /** 仅在支持硬件 EV 的机型上把滑块复位到 50%；不支持时该字段无视觉意义。 */
    if (this.data.aeExposureHardwareSupported) {
      patch.aeSunTopPct = 50;
    }
    this.setData(patch);
    if (this.data.aeExposureHardwareSupported) {
      this._exposureNormPending = 0.5;
      this.applyExposureFromNorm(0.5);
    }
    if (nextCtx === 'live') {
      this.scheduleAeLiveHide();
    }
    this._aeFocusLockFlashTimer = setTimeout(() => {
      this._aeFocusLockFlashTimer = null;
      this.setData({
        aeFocusLockFlash: false
      });
    }, 520);
    this._aeDoubleTapHintTimer = setTimeout(() => {
      this._aeDoubleTapHintTimer = null;
      this.setData({
        aeShowDoubleTapHint: false
      });
    }, 8000);
  },
  /**
   * 直播/录制中呼出对焦点+曝光条：对焦点先置于 16:9 取景区几何中心，曝光条（若支持）可拖调。
   * 可继续单指点击预览或拖动方框以移动对焦点，见 {@link applyPreGameFocusAtPage} 与方框 touch 系列。
   * 不强制复位既有 EV，避免打断用户之前的曝光选择。
   * @returns {void}
   */
  wakeLiveAeControls: function () {
    this.clearAeLiveHideTimer();
    this._lastFocusNorm = {
      nx: 0.5,
      ny: 0.5
    };
    this.invokeSetTargetFocus(0.5, 0.5);
    if (this._aeDoubleTapHintTimer) {
      clearTimeout(this._aeDoubleTapHintTimer);
      this._aeDoubleTapHintTimer = null;
    }
    this.setData({
      aeControlsVisible: true,
      aeContext: 'live',
      aeFocusIsTapPosition: false,
      aeFocusLockFlash: true,
      aeFocusUserLocked: this.data.aeFocusUserLocked,
      aeShowDoubleTapHint: !this.data.aeFocusUserLocked
    });
    this.scheduleAeLiveHide();
    if (this._aeFocusLockFlashTimer) {
      clearTimeout(this._aeFocusLockFlashTimer);
      this._aeFocusLockFlashTimer = null;
    }
    this._aeFocusLockFlashTimer = setTimeout(() => {
      this._aeFocusLockFlashTimer = null;
      this.setData({
        aeFocusLockFlash: false
      });
    }, 420);
    this._aeDoubleTapHintTimer = setTimeout(() => {
      this._aeDoubleTapHintTimer = null;
      this.setData({
        aeShowDoubleTapHint: false
      });
    }, 8000);
  },
  /**
   * 双击对焦框：在 {@link AE_BRACKET_DOUBLE_TAP_MS} 内连点两次方框则锁定；用 bindtap 且不使用 touchmove，避免与单击/连击判定冲突。
   * @returns {void}
   */
  onAeFocusBracketTap: function () {
    if (!this.data.aeControlsVisible) return;
    if (this.data.aeContext !== 'pre' && this.data.aeContext !== 'live') return;
    if (this.data.aeFocusUserLocked) {
      try {
        wx.showToast({
          title: '对焦已锁定',
          icon: 'none',
          duration: 1000
        });
      } catch (e) {}
      return;
    }
    const now = Date.now();
    if (now - (this._aeBracketLastTapAt || 0) < AE_BRACKET_DOUBLE_TAP_MS) {
      this._aeBracketLastTapAt = 0;
      const p = this._lastFocusNorm || {
        nx: 0.5,
        ny: 0.5
      };
      this.invokeSetTargetFocus(p.nx, p.ny);
      if (this._aeDoubleTapHintTimer) {
        clearTimeout(this._aeDoubleTapHintTimer);
        this._aeDoubleTapHintTimer = null;
      }
      this.setData({
        aeFocusUserLocked: true,
        aeShowDoubleTapHint: false
      });
      try {
        wx.vibrateShort({
          type: 'medium'
        });
      } catch (e) {}
      try {
        wx.showToast({
          title: '对焦已锁定',
          icon: 'success',
          duration: 1400
        });
      } catch (eT) {}
    } else {
      this._aeBracketLastTapAt = now;
    }
  },
  /**
   * 无操作 3s 后隐藏 live 态控件（开赛前 pre 不自动关，由起录时收起）。
   * @returns {void}
   */
  scheduleAeLiveHide: function () {
    this.clearAeLiveHideTimer();
    this._aeLiveHideTimer = setTimeout(() => {
      this._aeLiveHideTimer = null;
      if (this.data.aeContext === 'live') {
        this.setData({
          aeControlsVisible: false,
          aeContext: ''
        });
      }
    }, AE_LIVE_AUTO_HIDE_MS);
  },
  /**
   * @returns {void}
   */
  clearAeLiveHideTimer: function () {
    if (this._aeLiveHideTimer) {
      clearTimeout(this._aeLiveHideTimer);
      this._aeLiveHideTimer = null;
    }
  },
  /**
   * 开赛前/直播态在小太阳条上拖动调节曝光（catch 避免与底层缩放手势冲突）。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onAeSunTouchStart: function (e) {
    if (!this.data.aeExposureHardwareSupported) return;
    if (!this.data.aeControlsVisible) return;
    if (this.data.aeContext !== 'pre' && this.data.aeContext !== 'live') return;
    if (!e.touches || !e.touches[0]) return;
    this._aePreSunStartY = e.touches[0].pageY;
    this._aePreSunStartNorm = typeof this._exposureNormPending === 'number' ? this._exposureNormPending : 0.5;
  },
  /**
   * 滑条与全局手势层分离（catch），避免与缩放手势串扰；开赛前/直播态共用同一套数值。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onAeSunTouchMove: function (e) {
    if (!this.data.aeExposureHardwareSupported) return;
    if (!this.data.aeControlsVisible) return;
    if (this.data.aeContext !== 'pre' && this.data.aeContext !== 'live') return;
    if (!e.touches || !e.touches[0] || this._aePreSunStartY == null) return;
    let h = 667;
    try {
      h = wx.getSystemInfoSync().windowHeight || h;
    } catch (err) {
      h = 667;
    }
    const delta = (this._aePreSunStartY - e.touches[0].pageY) / h;
    let next = (this._aePreSunStartNorm || 0.5) + delta * 1.15;
    next = Math.max(0, Math.min(1, next));
    this.applyExposureFromNorm(next);
    if (this.data.aeContext === 'live') {
      this.clearAeLiveHideTimer();
      this.scheduleAeLiveHide();
    }
  },
  /**
   * @returns {void}
   */
  onAeSunTouchEnd: function () {
    this._aePreSunStartY = null;
    this._aePreSunStartNorm = 0.5;
    if (this.data.aeContext === 'live' && this.data.aeControlsVisible) {
      this.clearAeLiveHideTimer();
      this.scheduleAeLiveHide();
    }
  },
  hexToRgba: function (hex, opacity) {
    const color = (hex || '#000000').replace('#', '');
    const fullHex = color.length === 3 ? color.split('').map(c => c + c).join('') : color;
    const r = parseInt(fullHex.substr(0, 2), 16);
    const g = parseInt(fullHex.substr(2, 2), 16);
    const b = parseInt(fullHex.substr(4, 2), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  },
  getContrastColor: function (hexcolor) {
    if (!hexcolor) return '#000000';
    let color = hexcolor.replace('#', '');
    if (color.length === 3) {
      color = color.split('').map(c => c + c).join('');
    }
    if (color.length !== 6) return '#000000';
    const r = parseInt(color.substr(0, 2), 16);
    const g = parseInt(color.substr(2, 2), 16);
    const b = parseInt(color.substr(4, 2), 16);
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 128 ? '#000000' : '#FFFFFF';
  },
  normalizeMatchConfig: function (config) {
    const base = config || this.data.matchConfig;
    const normalizedConfig = JSON.parse(JSON.stringify(base || {}));
    if (!normalizedConfig.matchNameColor) normalizedConfig.matchNameColor = '#E64340';
    normalizedConfig.sportType = normalizeSportType(normalizedConfig.sportType);
    const teamDefaultsA = {
      name: '队 A',
      bgColor: '#E64340',
      textColor: '#FFFFFF',
      score: 0,
      currentSetScore: 0,
      subScores: []
    };
    const teamDefaultsB = {
      name: '队 B',
      bgColor: '#10AEFF',
      textColor: '#FFFFFF',
      score: 0,
      currentSetScore: 0,
      subScores: []
    };
    ['teamA', 'teamB'].forEach(teamKey => {
      const teamDefaults = teamKey === 'teamA' ? teamDefaultsA : teamDefaultsB;
      const sourceTeam = normalizedConfig[teamKey] || {};
      const bgColor = sourceTeam.bgColor || sourceTeam.color || teamDefaults.bgColor;
      const textColor = this.getContrastColor(bgColor);
      const subScores = Array.isArray(sourceTeam.subScores) ? sourceTeam.subScores.slice() : [];
      normalizedConfig[teamKey] = {
        ...teamDefaults,
        ...sourceTeam,
        bgColor,
        rgbaBg: this.hexToRgba(bgColor, 0.8),
        textColor,
        score: Math.max(0, Math.floor(Number(sourceTeam.score) || 0)),
        currentSetScore: Math.max(0, Math.floor(Number(sourceTeam.currentSetScore) || 0)),
        subScores: subScores.map(n => Math.max(0, Math.floor(Number(n) || 0)))
      };
    });
    if (typeof normalizedConfig.period !== 'number') {
      normalizedConfig.period = 0;
    }
    const bs = normalizedConfig.badmintonState || {};
    normalizedConfig.badmintonState = {
      ...DEFAULT_BADMINTON_STATE,
      ...bs,
      servingTeam: bs.servingTeam === 'B' ? 'B' : 'A',
      servingZone: bs.servingZone === 'left' ? 'left' : 'right',
      ruleType: bs.ruleType === 'double' ? 'double' : 'single',
      maxSets: Math.max(1, Math.floor(Number(bs.maxSets) || DEFAULT_BADMINTON_STATE.maxSets)),
      pointsPerSet: bs.pointsPerSet === 11 ? 11 : 21,
      isScoreEnabled: bs.isScoreEnabled !== false
    };
    const sc = normalizedConfig.sportConfig || {};
    normalizedConfig.sportConfig = {
      periodMinutes: Math.max(1, Math.floor(Number(sc.periodMinutes) || 10)),
      enable24Sec: false,
      halfMinutes: Math.max(1, Math.floor(Number(sc.halfMinutes) || 45)),
      ruleType: sc.ruleType === 'double' ? 'double' : 'single',
      pointsPerSet: sc.pointsPerSet === 11 ? 11 : 21,
      maxSets: Math.max(1, Math.floor(Number(sc.maxSets) || 3)),
      isScoreEnabled: sc.isScoreEnabled !== false
    };
    if (normalizedConfig.sportType === SPORT_BADMINTON) {
      normalizedConfig.badmintonState.ruleType = normalizedConfig.sportConfig.ruleType;
      normalizedConfig.badmintonState.pointsPerSet = normalizedConfig.sportConfig.pointsPerSet;
      normalizedConfig.badmintonState.maxSets = normalizedConfig.sportConfig.maxSets;
    }
    if (normalizedConfig.sportType === SPORT_FOOTBALL) {
      normalizedConfig.footballState = normalizeFootballState(normalizedConfig.footballState);
      if (normalizedConfig.footballState.periodModel !== 2) {
        normalizedConfig.period = migrateLegacyFootballPeriod(normalizedConfig.period, normalizedConfig);
      }
      normalizedConfig.footballState.periodModel = 2;
      normalizedConfig.period = Math.min(5, Math.max(1, Math.floor(Number(normalizedConfig.period) || 1)));
    }
    if (normalizedConfig.sportType === SPORT_FOOTBALL && normalizedConfig.period < 1) {
      normalizedConfig.period = 1;
    }
    if (normalizedConfig.sportType === SPORT_BADMINTON && normalizedConfig.period < 1) {
      normalizedConfig.period = 1;
    }
    normalizedConfig.footballElapsedSec = Math.max(0, Math.floor(Number(normalizedConfig.footballElapsedSec) || 0));
    normalizedConfig.footballState = normalizeFootballState(normalizedConfig.footballState);
    return normalizedConfig;
  },
  /**
   * 根据 matchConfig 生成运动类型相关的 UI 展示 patch。
   * @param {object} mc 已规范化的 matchConfig
   * @param {string} [sportType]
   * @returns {object}
   */
  buildSportUiPatch: function (mc, sportType) {
    const sport = normalizeSportType(sportType || mc && mc.sportType);
    const localFootball = formatWxsMainText(this._computeFootballElapsedFromStored(mc));
    const fs = normalizeFootballState(mc && mc.footballState);
    const labelParts = getFootballHalfLabelParts(mc && mc.period, fs);
    return {
      sportType: sport,
      showMainClock: sport !== SPORT_BADMINTON,
      showShotClock: sport === SPORT_BASKETBALL && !!this.data.isAutoMode && !!(mc && mc.sportConfig && mc.sportConfig.enable24Sec),
      footballHalfLabel: labelParts.base + labelParts.stoppage,
      footballHalfLabelBase: labelParts.base,
      footballHalfStoppageText: labelParts.stoppage,
      footballClockPaused: fs.clockPaused,
      footballDisplayTime: this._resolveFootballDisplayTime(localFootball),
      badmintonSetHistory: buildBadmintonSetHistoryDisplay(mc),
      useCornerScoreboard: sport === SPORT_FOOTBALL || sport === SPORT_BADMINTON
    };
  },
  /**
   * 刷新运动类型相关 UI 字段（计分/节次变更后调用）。
   * @returns {void}
   */
  refreshSportUiMeta: function () {
    const mc = this.data.matchConfig;
    const patch = this.buildSportUiPatch(mc, this.data.sportType);
    this.setData(patch);
  },
  onShow: function () {
    this._livePageVisible = true;
    this._loadQuickZoomStops();
    if (this.isLiveForegroundRecordingRecoverPending()) {
      this._encodeStallGraceUntil = Date.now() + ENCODE_STALL_RECOVER_COOLDOWN_MS;
      // P0: 硬件交接安全期 — 等待 iOS 系统相机资源完全释放后再 rebuild
      this.appendHealthLog('camera_hardware_debounce_wait', { delayMs: 400 });
    }
    const enhanceBetaWhitelisted = false;
    const autoSyncWhitelisted = checkSyncLabWhitelist();
    const enhanceVkSupported = false;
    if (this.data.enhanceBetaWhitelisted !== enhanceBetaWhitelisted || this.data.enhanceVkSupported !== enhanceVkSupported || this.data.autoSyncWhitelisted !== autoSyncWhitelisted) {
      const patch = {
        enhanceBetaWhitelisted: enhanceBetaWhitelisted,
        enhanceVkSupported: enhanceVkSupported,
        autoSyncWhitelisted: autoSyncWhitelisted
      };
      if (!autoSyncWhitelisted && this.data.isAutoMode) {
        patch.isAutoMode = false;
      }
      const self = this;
      this.setData(patch, function () {
        if (patch.isAutoMode === false) {
          self.updateTeamGroupWidth(true);
          self._liveWsTeardownForManualMode();
        }
      });
    }
    var enhanceExperimentEligible = !!(this.data.enhanceWhitelisted && enhanceBetaWhitelisted);
    if (!enhanceExperimentEligible && (this.data.enhanceCanvasVisible || this.data.enhanceMode !== 'off' || this._renderPipeline)) {
      this._teardownEnhanceRender();
    }
    try {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ['shareAppMessage']
      });
    } catch (e) {

      // 低版本基础库忽略
    }
    this.syncMatchConfigFromPageSources();
    try {
      this._liveWsSyncChipConnected();
    } catch (eBleChip) {}
    try {
      this._liveWsHealthCheckOnShow();
    } catch (eHealth) {}
    try {
      if (this.data.recSyncEnabled && this.data.recSyncRoomId.length === 6) {
        this._recSyncWsConnect();
      }
    } catch (eRecSyncShow) {}
    try {
      const cid = wx.getStorageSync('currentMatchId') || app.globalData && app.globalData.currentMatchId || '';
      clipsStorage.mergeDefaultClipBucketIfTargetEmpty(String(cid || '').trim());
    } catch (eMerge) {}
    this.appendHealthLog('page_show', {});

    /**
     * 须在权益拉起 camera 之前置位，避免引导层盖住原生 camera 时仍 startRecord（部分机型关闭引导后预览永久黑屏）。
     */
    if (!wx.getStorageSync('hasReadGuide') && !this.data.showGuide) {
      this.setData({
        showGuide: true,
        guideSubStep: 0
      });
    }
    wx.setKeepScreenOn({
      keepScreenOn: true,
      fail: () => {
        setTimeout(() => wx.setKeepScreenOn({
          keepScreenOn: true
        }), 1000);
      }
    });
    if (wx.setPageOrientation) {
      wx.setPageOrientation({
        orientation: 'landscape'
      });
    }
    try {
      this._updateLiveStageLayout();
    } catch (eLs) {}
    if (this.data.useCornerScoreboard) {
      if (!this._proScoreboardMovableInited) {
        this._initProScoreboardMovableLayout();
      } else {
        var selfShowSb = this;
        if (!this._proScoreboardUserMoved) {
          setTimeout(function () {
            selfShowSb._syncProScoreboardCornerLayout(false);
            selfShowSb._refineProScoreboardLayoutFromDom(false);
          }, 280);
        }
        if (!this._proMatchNameMovableInited) {
          this._initProMatchNameMovableLayout();
        } else if (!this._proMatchNameUserMoved) {
          setTimeout(function () {
            selfShowSb._syncProMatchNameLayout(false);
            selfShowSb._refineProMatchNameLayoutFromDom(false);
          }, 300);
        }
      }
    }
    try {
      const snap = storageEst.readFileStorageEstimateSnapshot();
      if (snap && typeof snap.clipBytes === 'number' && Number.isFinite(snap.clipBytes) && typeof snap.userDataBytes === 'number' && Number.isFinite(snap.userDataBytes)) {
        this._syncCacheStorageLampData(storageEst.getClipStorageHealthHint(snap.clipBytes, snap.userDataBytes));
      }
    } catch (eSnap) {}
    if (this.isLiveForegroundRecordingRecoverPending()) {
      this._hardRecoverQuarantineUntil = 0; // 强制清除背景返回的隔离保护锁
      if (this._cameraHardwareDebounceTimer) clearTimeout(this._cameraHardwareDebounceTimer);
      this._cameraHardwareDebounceTimer = setTimeout(() => {
        this._cameraHardwareDebounceTimer = null;
        this._destructiveCameraRemount('force_background_recover');
      }, 400);
      return;
    }
    if (this._entitlementEverAllowedInSession) {
      this._ensureLiveCameraReady(() => this._liveCoreOnShowAfterEntitlement());
      return;
    }
    this.refreshLiveEntitlementAndResume(() => {
      this._liveCoreOnShowAfterEntitlement();
    });
  },
  /**
   * 权益通过后：若 globalData 中已有首页写入的 severe，则安排弹窗（与异步 kickoff 探测并行）。
   * 策略说明（历史踩坑）：
   * - 原 10 分钟过期 + 必须有 clipBytes，极易在用户稍晚进直播时整段跳过；
   * - 用字节再算一遍若已因删片段降到非 severe，会误拦截，与首页红色严重提示不一致；
   * - 故：以 `healthLevel === 'severe'` 为准，缺字节时用 clipMb/totalMb + 兜底文案；24h 内信任首页快照。
   *
   * @returns {void}
   */
  /** @region LIVE_STORAGE — 存储水位、缓存灯、空间弹窗 */
maybeToastFileStoragePressureFromGlobal: function () {
    try {
      if (this._liveStorageEntryModalShown) return;

      /**
       * @param {unknown} raw
       * @returns {Record<string, unknown>|null}
       */
      const asSevereEstimate = raw => {
        if (!raw || typeof raw !== 'object') return null;
        const hl = String(/** @type {{ healthLevel?: string }} */raw.healthLevel || '').trim().toLowerCase();
        if (hl !== 'severe') return null;
        return /** @type {Record<string, unknown>} */raw;
      };
      let est = asSevereEstimate(app.globalData && app.globalData.fileStorageEstimate);
      if (!est) {
        const snap = storageEst.readFileStorageEstimateSnapshot();
        const cand = asSevereEstimate(snap);
        const sat = cand && typeof cand.at === 'number' ? cand.at : 0;
        if (cand && sat && Date.now() - sat <= 24 * 60 * 60 * 1000) {
          est = cand;
        }
      }
      if (!est) return;
      const at = typeof est.at === 'number' ? est.at : 0;
      if (at && Date.now() - at > 24 * 60 * 60 * 1000) return;
      const cm = typeof est.clipMb === 'number' && Number.isFinite(est.clipMb) ? est.clipMb : 0;
      const tm = typeof est.totalMb === 'number' && Number.isFinite(est.totalMb) ? est.totalMb : 0;
      let hintText = typeof est.hintText === 'string' ? est.hintText.trim() : '';
      const cb = /** @type {number|undefined} */est.clipBytes;
      const ub = /** @type {number|undefined} */est.userDataBytes;
      if (typeof cb === 'number' && typeof ub === 'number' && Number.isFinite(cb) && Number.isFinite(ub)) {
        const recalc = storageEst.getClipStorageHealthHint(cb, ub);
        if (recalc.level === 'severe') {
          hintText = recalc.hintText;
        } else if (!hintText) {
          hintText = `高光片段约 ${recalc.clipMb} MB，本机小程序文件约 ${recalc.totalMb} MB（首页仍为严重水位）：` + '保存仍可能失败，请尽快「下载至相册并清空」或删除旧片段';
        }
      }
      if (!hintText) {
        hintText = `高光片段约 ${cm} MB，本机小程序文件约 ${tm} MB（空间严重紧张）：` + '保存极易失败，请尽快「下载至相册并清空」或删除旧片段';
      }
      this.maybeNotifyLiveStoragePressure({
        clipMb: cm,
        totalMb: tm,
        level: 'severe',
        hintText
      }, 'kickoff');
    } catch (eToast) {}
  },
  /**
   * 异步估算 USER_DATA_PATH 与高光片段体积，写入健康日志并可选提示用户。
   * @param {string} [trigger] kickoff | periodic 等
   * @param {boolean} [force] 为 true 时跳过短时间防抖（开播首次探测）
   * @returns {Promise<void>}
   */
  probeLiveSandboxStorage: function (trigger, force) {
    const t = typeof trigger === 'string' ? trigger : '';
    const now = Date.now();
    if (!force && this._lastLiveStorageProbeAt && now - this._lastLiveStorageProbeAt < 25000) {
      return Promise.resolve();
    }
    this._lastLiveStorageProbeAt = now;
    return Promise.all([storageEst.estimateClipSegmentsBytesFromStorage(), storageEst.estimateUserDataPathUsageBytes()]).then(([clipBytes, userBytes]) => {
      const hint = storageEst.getClipStorageHealthHint(clipBytes, userBytes);
      this._syncCacheStorageLampData(hint);
      if (t === 'periodic' && !this.rollingActive) {
        return;
      }
      this.appendHealthLog('live_sandbox_storage_probe', {
        trigger: t,
        clipMb: hint.clipMb,
        userDataWalkMb: hint.userDataWalkMb,
        totalMb: hint.totalMb,
        effectiveTotalMb: hint.totalMb,
        level: hint.level,
        rollingSessionId: this.rollingSessionId
      });
      try {
        if (app.globalData) {
          app.globalData.fileStorageEstimate = {
            clipBytes,
            userDataBytes: userBytes,
            userDataWalkBytes: hint.userDataWalkBytes,
            effectiveTotalBytes: hint.effectiveTotalBytes,
            clipMb: hint.clipMb,
            totalMb: hint.totalMb,
            userDataWalkMb: hint.userDataWalkMb,
            healthLevel: hint.level,
            hintText: hint.hintText,
            at: Date.now()
          };
          storageEst.writeFileStorageEstimateSnapshot(app.globalData.fileStorageEstimate);
        }
      } catch (eG) {}
      this.maybeNotifyLiveStoragePressure(hint, t);
      this._lastLiveStorageProbeLevel = hint.level;
      if (hint.level === 'severe' && t === 'kickoff' && !this._liveSevereKickoffPruneDone) {
        this._liveSevereKickoffPruneDone = true;
        this.freeRollingFileStorageAggressive('live_storage_severe_kickoff');
      }
      if (hint.level === 'severe' && t === 'periodic' && this.rollingActive) {
        try {
          this.appendHealthLog('live_periodic_severe_lock_only', {
            noAutoClipPrune: false
          });
        } catch (eL) {}
        this.freeRollingFileStorageAggressive('live_storage_severe_periodic');
      }
    }).catch(eProbe => {
      try {
        this.appendHealthLog('live_sandbox_storage_probe_fail', {
          trigger: t,
          err: eProbe && eProbe.message || String(eProbe || '')
        });
      } catch (eLog) {}
    });
  },
  /**
   * 同步缓存角标灯与严重水位锁：severe 时 storageSevereLock，禁新分段/禁高光，仅此时下灯 EX 可点按批量导出。
   *
   * @param {{ level?: string, clipMb?: number, totalMb?: number, hintText?: string }} hint
   * @returns {void}
   */
  _syncCacheStorageLampData: function (hint) {
    if (!hint || typeof hint !== 'object') return;
    const raw = String(hint.level || 'ok').trim().toLowerCase();
    const lv = raw === 'warn' || raw === 'severe' || raw === 'ok' ? raw : 'ok';
    const wasSevere = !!this.data.storageSevereLock;
    const storageSevereLock = lv === 'severe';
    let txt = 'OK';
    if (lv === 'warn') txt = 'WT';
    if (lv === 'severe') txt = 'EX';
    if (lv === this.data.cacheStorageLampLevel && storageSevereLock === this.data.storageSevereLock && txt === this.data.cacheStorageLampText) {
      return;
    }
    this.setData({
      cacheStorageLampLevel: lv,
      storageSevereLock: storageSevereLock,
      cacheStorageLampActionable: storageSevereLock,
      cacheStorageLampText: txt
    }, () => {
      if (wasSevere && !storageSevereLock) {
        this._onStorageSevereLockReleased();
      } else if (storageSevereLock) {
        this._storageSevereRecoveryUntil = 0;
      }
    });
  },
  /**
   * severe 解除后：自动尝试恢复 rolling，并在短窗口内抑制 idle-ERR 误判。
   * @returns {void}
   */
  _onStorageSevereLockReleased: function () {
    const now = Date.now();
    const graceMs = Math.max(8000, Math.floor((this.segmentDurationMs || 16000) * 1.2));
    this._storageSevereRecoveryUntil = now + graceMs;
    this.lastSegmentAt = now;
    this.startRecordFailStreak = 0;
    this.segmentStartFailStormCycles = 0;
    if (this._needManualRelaunch && String(this._manualRelaunchReason || '').indexOf('file_quota') >= 0) {
      this._needManualRelaunch = false;
      this._manualRelaunchReason = '';
    }
    if (this._fileQuotaCircuitUntil && this._fileQuotaCircuitUntil > now) {
      this._fileQuotaCircuitUntil = 0;
    }
    try {
      this.appendHealthLog('storage_severe_released_resume_rolling', {
        graceMs,
        rollingActive: !!this.rollingActive,
        cameraReady: !!this._cameraInitDone
      });
    } catch (eLog) {}
    if (!this.rollingActive || !this._cameraInitDone || !this.data.cameraContext || this.data.isRecording) {
      this.updatePipelineHealth();
      return;
    }
    const sessionId = this.rollingSessionId;
    this.scheduleAfterStopRecord(() => {
      if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
      if (this.data.storageSevereLock) return;
      if (this.data.isRecording) return;
      this.startOneSegment(sessionId, 0);
    });
    this.updatePipelineHealth();
  },
  /**
   * 自绘轻提示：小字无底色、短时长、2 次 setData 以内，不调用 wx.showToast。
   * @param {string} message
   * @returns {void}
   */
  _showLightHint: function (message) {
    const t = String(message || '').trim();
    if (!t) return;
    if (this._lightHintFadeTimer) {
      try {
        clearTimeout(this._lightHintFadeTimer);
      } catch (e) {}
      this._lightHintFadeTimer = null;
    }
    /** 略短于系统 Toast，低存在感；约 1.6s 后淡出 */
    this.setData({
      lightHintText: t,
      lightHintOpacity: 0.5
    });
    const self = this;
    this._lightHintFadeTimer = setTimeout(function () {
      self.setData({
        lightHintOpacity: 0
      });
      self._lightHintFadeTimer = setTimeout(function () {
        self.setData({
          lightHintText: ''
        });
        self._lightHintFadeTimer = null;
      }, 220);
    }, 1600);
  },
  /**
   * 选最旧 1 条、带本地路径且未标相册导出的片段。
   * 在 storageSevereLock 下 minKeep 按 0 计：否则会出现「条数=应急保留量 → 可删 0 条」却仍为 severe 的死锁。
   * @returns {{ matchId: string, item: Record<string, unknown> }|null}
   */
  _getOneOldestPrunableClipForCacheLamp: function () {
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) return null;
    const entries = [];
    Object.keys(clipsMap).forEach(matchId => {
      const list = clipsMap[matchId];
      if (!Array.isArray(list)) return;
      list.forEach(it => {
        if (!it || typeof it !== 'object') return;
        if (it.exportedToAlbum) return;
        const id = it.id != null ? String(it.id) : '';
        if (!id) return;
        const segs = Array.isArray(it.segments) ? it.segments.filter(p => p && typeof p === 'string') : [];
        const ex = it.replaySegment && typeof it.replaySegment === 'string' ? [it.replaySegment] : [];
        const hasPaths = [...new Set([...segs, ...ex])].length > 0;
        if (!hasPaths) return;
        const createdAt = this.resolveHighlightCreatedAt(/** @type {Record<string, unknown>} */it);
        entries.push({
          matchId,
          id,
          createdAt
        });
      });
    });
    if (entries.length === 0) return null;
    const baseMin = Math.max(0, Number(this.highlightsEmergencyMinKeepCount || 0));
    const minKeep = this.data.storageSevereLock ? 0 : baseMin;
    const removableBudget = Math.max(0, entries.length - minKeep);
    if (removableBudget <= 0) return null;
    entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const first = entries[0];
    const list = clipsMap[first.matchId];
    if (!Array.isArray(list)) return null;
    const it = list.find(x => x && String(x.id) === first.id);
    if (!it || typeof it !== 'object') return null;
    return {
      matchId: first.matchId,
      item: it
    };
  },
  /**
   * 将单条高光对应本地视频依次保存至相册、unlink，并同步删除索引行（EX 清理语义：从列表与统计中消失）。
   *
   * @param {string} matchId
   * @param {Record<string, unknown>} item
   * @param {(err: string|null) => void} onDone
   * @returns {void}
   */
  _exportOneClipToAlbumForCacheLamp: function (matchId, item, onDone) {
    const done = typeof onDone === 'function' ? onDone : function () {};
    const fs = wx.getFileSystemManager();
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) {
      done('map');
      return;
    }
    const segs = Array.isArray(item.segments) ? item.segments.filter(p => p && typeof p === 'string') : [];
    const extra = item.replaySegment && typeof item.replaySegment === 'string' ? [item.replaySegment] : [];
    const exportPaths = this._collectHighlightExportPaths(item);
    const paths = exportPaths.length ? exportPaths : [...new Set([...segs, ...extra])];
    if (paths.length === 0) {
      done('paths');
      return;
    }
    const runPaths = (pi, failStreak) => {
      if (pi >= paths.length) {
        const list = clipsMap[matchId];
        if (Array.isArray(list)) {
          const id = item.id != null ? String(item.id) : '';
          const idx = list.findIndex(x => x && String(x.id) === id);
          if (idx >= 0) {
            list.splice(idx, 1);
          }
          if (list.length <= 0) {
            delete clipsMap[matchId];
          }
        }
        if (clipsStorage.writeClipsMapSafe(clipsMap)) {
          try {
            if (typeof this.refreshDrawerHighlights === 'function') this.refreshDrawerHighlights();
          } catch (eR) {}
          try {
            if (typeof this.loadMatchList === 'function') this.loadMatchList();
          } catch (eM) {}
          try {
            this.appendHealthLog('cache_lamp_export_one', {
              matchId: String(matchId),
              id: String(item.id),
              saveFailCount: failStreak
            });
          } catch (eL) {}
          done(failStreak > 0 ? 'partial' : null);
        } else {
          done('write');
        }
        return;
      }
      const p = paths[pi];
      const nextPi = pi + 1;
      let failCount = failStreak;
      wx.saveVideoToPhotosAlbum({
        filePath: p,
        success: () => {
          try {
            fs.unlinkSync(p);
          } catch (eUn) {}
          runPaths(nextPi, failCount);
        },
        fail: () => {
          failCount += 1;
          runPaths(nextPi, failCount);
        }
      });
    };
    const start = () => runPaths(0, 0);
    wx.getSetting({
      success: res => {
        if (res.authSetting && res.authSetting['scope.writePhotosAlbum']) {
          start();
        } else {
          wx.authorize({
            scope: 'scope.writePhotosAlbum',
            success: start,
            fail: () => {
              try {
                wx.showModal({
                  title: '需要相册权限',
                  content: '导出后可释放本机空间',
                  showCancel: false
                });
              } catch (e) {}
              done('auth');
            }
          });
        }
      },
      fail: () => done('set')
    });
  },
  /**
   * 严重水位下点按：立即按序导出最旧可删的若干条到相册并 unlink 本地（不排队）；单次最多 3 条，降低与相机 I/O 冲突。
   * @returns {void}
   */
  onCacheStorageLampTap: function () {
    if (!this.data.storageSevereLock) return;
    if (this._cacheLampBatchRunning) {
      this._showLightHint('处理中');
      return;
    }
    if (this.data.isRecording || this.data.isSavingHighlight) {
      this._showLightHint('请稍候');
      return;
    }
    const batchMax = 3;
    this._cacheLampBatchRunning = true;
    const self = this;
    let doneCount = 0;
    try {
      this.appendHealthLog('cache_lamp_tap_batch', {
        max: batchMax
      });
    } catch (eL) {}
    const finishBatch = hintKey => {
      self._cacheLampBatchRunning = false;
      if (doneCount === 0) {
        self._showLightHint('无未导出的本地文件');
      } else {
        self._showLightHint('已导' + String(doneCount) + '条');
      }
      try {
        self.probeLiveSandboxStorage(hintKey || 'after_cache_lamp_batch', true);
      } catch (e) {}
    };
    const runNext = left => {
      if (left <= 0) {
        finishBatch('after_cache_lamp_batch');
        return;
      }
      const t = self._getOneOldestPrunableClipForCacheLamp();
      if (!t) {
        finishBatch('after_cache_lamp_batch');
        return;
      }
      self._exportOneClipToAlbumForCacheLamp(t.matchId, t.item, function (err) {
        if (err === 'auth') {
          self._cacheLampBatchRunning = false;
          self._showLightHint('需相册权限');
          if (doneCount > 0) {
            self.probeLiveSandboxStorage('after_cache_lamp_batch_partial', true);
          }
          return;
        }
        if (!err || err === 'partial') {
          doneCount += 1;
          runNext(left - 1);
          return;
        }
        self._cacheLampBatchRunning = false;
        if (doneCount > 0) {
          self._showLightHint('已导' + String(doneCount) + '条');
          self.probeLiveSandboxStorage('after_cache_lamp_batch_err', true);
        } else {
          self._showLightHint('未完成');
        }
      });
    };
    runNext(batchMax);
  },
  /**
   * 按档位提示存储压力。
   * - severe：kickoff 时用页面级自定义浮层（避免 `wx.showModal` 与 camera 内 cover-view 布局缺陷）；
   *   门闩 {@link _liveStorageEntryModalShown} 仅在 {@link onLoad} 置 false；periodic 不弹。
   * - warn：静默记录日志，不弹任何 Toast，避免打断直播。
   * @param {{ clipMb: number, totalMb: number, level: string, hintText: string }} hint
   * @param {string} [trigger] kickoff | periodic 等，由 probeLiveSandboxStorage 传入
   * @returns {void}
   */
  maybeNotifyLiveStoragePressure: function (hint, trigger) {
    if (!hint || hint.level === 'ok') {
      return;
    }
    if (hint.level === 'severe') {
      if (trigger !== 'kickoff') return;
      if (this._liveStorageEntryModalShown) return;
      this._liveStorageEntryModalShown = true;
      const self = this;
      let text = typeof hint.hintText === 'string' ? hint.hintText.trim() : '';
      if (!text) {
        text = '本机小程序存储占用过高，保存极易失败，请尽快「下载至相册并清空」或删除旧片段';
      }
      if (this._liveStorageSevereModalTimer) {
        clearTimeout(this._liveStorageSevereModalTimer);
        this._liveStorageSevereModalTimer = null;
      }
      const openStorageModal = () => {
        self._liveStorageSevereModalTimer = null;
        if (!self._livePageVisible) {
          self._liveStorageEntryModalShown = false;
          return;
        }
        try {
          self.appendHealthLog('live_storage_severe_modal_show', {
            trigger: trigger || ''
          });
        } catch (eLog) {}
        self.setData({
          showStoragePressureModal: true,
          storagePressureModalText: text
        });
      };
      this._liveStorageSevereModalTimer = setTimeout(openStorageModal, LIVE_STORAGE_SEVERE_MODAL_DELAY_MS);
    }
  },
  /**
   * 长直播期间周期性探测（全量 walk 较重，默认 8 分钟）。
   * @returns {void}
   */
  startLiveSandboxStorageWatch: function () {
    this.stopLiveSandboxStorageWatch();
    this._liveFileStorageTimer = setInterval(() => {
      if (!this.rollingActive) {
        return;
      }
      this.probeLiveSandboxStorage('periodic', false);
    }, 8 * 60 * 1000);
  },
  /**
   * @returns {void}
   */
  stopLiveSandboxStorageWatch: function () {
    if (this._liveFileStorageTimer) {
      clearInterval(this._liveFileStorageTimer);
      this._liveFileStorageTimer = null;
    }
  },
  /**
   * 分享给好友：路径携带当前用户 openid，供新用户登录时上报邀请关系。
   * @returns {WechatMiniprogram.Page.ICustomShareContent}
   */
  /** @region LIVE_DRAWER — 抽屉、推广 Logo、场次切换 UI */
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
      const o = /** @type {Record<string, unknown>} */raw;
      const v = o.openid;
      openid = typeof v === 'string' ? v.trim() : '';
    }
    const path = openid.length > 0 ? `/pages/index/index?referrerId=${encodeURIComponent(openid)}` : '/pages/index/index';
    return {
      title: '高光记分 — 邀你免费试用直播记分',
      path,
      imageUrl: SHARE_IMAGE_URL
    };
  },
  onReady: function () {
    try {
      this._updateLiveStageLayout();
    } catch (eL1) {}
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
  getDisplayTeamNameCharCount: function (name) {
    const s = String(name || '');
    return Math.min(Array.from(s).length, 12);
  },
  /**
   * 单侧球队区（队名+比分）固定宽度：按 12 个中文字符占位 + 左右边距估算，与队名实际长短无关。
   *
   * @returns {number} 宽度（px）
   */
  computeTeamGroupWidthPx: function () {
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
    let needRpx = DISPLAY_CHAR_SLOTS * NAME_CHAR_RPX + SCORE_SLOT_RPX + CONTENT_GAP_RPX + ROW_PADDING_RPX;
    needRpx = Math.max(needRpx, MIN_RPX);
    let widthPx = needRpx * rpxToPx;
    const boardPx = shortEdge * 0.98;
    /** 需与 `.period-center-outer` 的最小宽度 + padding 保持一致。 */
    const centerRpx = this.data.isAutoMode ? 72 : 80;
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
  updateTeamGroupWidth: function (force) {
    const wSide = this.computeTeamGroupWidthPx();
    if (!force && Math.abs(wSide - (this.data.teamGroupWidthPxA || 0)) < 0.5 && Math.abs(wSide - (this.data.teamGroupWidthPxB || 0)) < 0.5) {
      return;
    }
    this.setData({
      teamGroupWidthPxA: wSide,
      teamGroupWidthPxB: wSide
    });
  },
  onUnload: function () {
    try {
      this._liveWsFlushScorePersist();
    } catch (eWsU0) {}
    try {
      this._liveWsTeardownForManualMode();
    } catch (eWsU2) {}
    /* 页面真正卸载时摘除 WS 客户端的网络监听 + 全部定时器，避免泄漏 */
    try {
      if (this._liveWsClient && typeof this._liveWsClient.destroy === 'function') {
        this._liveWsClient.destroy();
      }
    } catch (eWsDestroy) {/* ignore */}
    this._liveWsClient = null;
    try {
      this._recSyncWsDisconnect();
    } catch (eRecDestroy) {}
    wx.setKeepScreenOn({
      keepScreenOn: false
    });
    if (this._windowResizeListener && wx.offWindowResize) {
      try {
        wx.offWindowResize(this._windowResizeListener);
      } catch (eRz) {}
      this._windowResizeListener = null;
    }
    this._replayDeferredItem = null;
    this._restoreReplayRecordingCfrThrottle();
    if (this._highlightMaterializeReplayDeferTimer) {
      clearTimeout(this._highlightMaterializeReplayDeferTimer);
      this._highlightMaterializeReplayDeferTimer = null;
    }
    this._clearReplayMaterializeWait();
    if (this._replayPauseWaitTimer) {
      clearTimeout(this._replayPauseWaitTimer);
      this._replayPauseWaitTimer = null;
    }
    this.stopHighlightSaveProgressAnim();
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
    if (this._cameraShowInitWatchTimer) {
      clearTimeout(this._cameraShowInitWatchTimer);
      this._cameraShowInitWatchTimer = null;
    }
    if (this._relaunchPressTimer) {
      clearTimeout(this._relaunchPressTimer);
      this._relaunchPressTimer = null;
    }
    this._cancelQuickZoomSaveProgress();
    if (this._remoteHealthLogTimer) {
      clearTimeout(this._remoteHealthLogTimer);
      this._remoteHealthLogTimer = null;
    }
    this._dismissAuditExportShare();
    this._insertConflictRecovering = false;
    this._needManualRelaunch = false;
    this._hardRecoverAwaitingCamera = false;
    this._cameraInitDone = false;
    this._clearLensSwitchScaleTransitionTimers(true);
    if (this._previewRecordStartTimer) {
      clearTimeout(this._previewRecordStartTimer);
      this._previewRecordStartTimer = null;
    }
    if (this._rollingKickoffTimer) {
      clearTimeout(this._rollingKickoffTimer);
      this._rollingKickoffTimer = null;
    }
    if (this._rollingKickoffWatchdogTimer) {
      clearTimeout(this._rollingKickoffWatchdogTimer);
      this._rollingKickoffWatchdogTimer = null;
    }
    if (this._matchSwitchRestartTimer) {
      clearTimeout(this._matchSwitchRestartTimer);
      this._matchSwitchRestartTimer = null;
    }
    if (this._matchSwitchRestartFailsafeTimer) {
      clearTimeout(this._matchSwitchRestartFailsafeTimer);
      this._matchSwitchRestartFailsafeTimer = null;
    }
    this._rollingStartPendingBeforeKickoff = false;
    if (this.pendingHighlight && this.pendingHighlight.timeout) {
      clearTimeout(this.pendingHighlight.timeout);
    }
    if (this._recorderCore) {
      this._recorderCore.clearPendingHighlight();
    } else {
      this.pendingHighlight = null;
    }
    this.clearHighlightSavePipelineState();
    if (this._replayBuffer && typeof this._replayBuffer.clear === 'function') {
      this._replayBuffer.clear();
    }
    this.rollingSegments = [];
    this.segmentBuffer = [];
    this.highlightMaterializeQueue = [];
    this.highlightMaterializeRunning = false;
    this._highlightMaterializeUrgentOnHide = false;
    this._highlightMaterializeUrgentForReplay = false;
    this._highlightMaterializeCurrentId = '';
    this.highlightMissStreak = 0;
    this.rollingFsBusy = false;
    this._rollingPersistInFlight = 0;
    this._postUserLocalPersistCooldownMs = 0;
    if (this.rollingWatchdogTimer) {
      clearInterval(this.rollingWatchdogTimer);
      this.rollingWatchdogTimer = null;
    }
    this.appendHealthLog('page_unload', {});
    try {
      LIVE_AUDIT.exportAuditSnapshot();
      LIVE_AUDIT.flushAuditFileLines();
    } catch (eAuditUnload) {/* ignore */}
    if (this._postZoomFocusTimer) {
      clearTimeout(this._postZoomFocusTimer);
      this._postZoomFocusTimer = null;
    }
    if (this._exposureSetDataTimer) {
      clearTimeout(this._exposureSetDataTimer);
      this._exposureSetDataTimer = null;
    }
    this.clearAeLiveHideTimer();
    if (this._aeDoubleTapHintTimer) {
      clearTimeout(this._aeDoubleTapHintTimer);
      this._aeDoubleTapHintTimer = null;
    }
    if (this._aeFocusLockFlashTimer) {
      clearTimeout(this._aeFocusLockFlashTimer);
      this._aeFocusLockFlashTimer = null;
    }
    if (this._enhanceZeroFrameRecoverTimer) {
      clearTimeout(this._enhanceZeroFrameRecoverTimer);
      this._enhanceZeroFrameRecoverTimer = null;
    }
    if (this._liveStorageSevereModalTimer) {
      clearTimeout(this._liveStorageSevereModalTimer);
      this._liveStorageSevereModalTimer = null;
    }
    this._pendingEnhanceModeAfterRecover = null;
    this._pendingEnhanceModeAfterCameraRebuild = null;
    this._lastSegmentOperateFailAt = 0;
    this._teardownEnhanceRender();
    this.stopEnhanceFpsPolling();
    this.setData({
      cameraMounted: false,
      cameraContext: null,
      isRecording: false,
      showRecoveryVeil: false,
      showStoragePressureModal: false
    });
    this.stopRollingRecording(undefined, 'page_unload');
    if (this._previewRecordPipeline) {
      this._previewRecordPipeline.destroy();
      this._previewRecordPipeline = null;
    }
  },
  onHide: function () {
    this._cancelQuickZoomSaveProgress();
    this._flushPendingQuickZoomStopsReload();
    // P0: 清除帧脉搏监控与硬件 debounce 定时器
    if (this._framePulseTimer) {
      clearTimeout(this._framePulseTimer);
      this._framePulseTimer = null;
    }
    if (this._cameraHardwareDebounceTimer) {
      clearTimeout(this._cameraHardwareDebounceTimer);
      this._cameraHardwareDebounceTimer = null;
    }
    // P1: 主动暂停录制管线，释放 requestAnimationFrame，避免后台空转超时
    if (this._previewRecordPipeline && this._previewRecordPipeline.isActive()) {
      this.appendHealthLog('page_hide_pipeline_graceful_pause', {});
    }
    this._stopFootballLocalClock();
    this.setData({
      footballOpsPanelOpen: false
    });
    if (this._cameraShowInitWatchTimer) {
      clearTimeout(this._cameraShowInitWatchTimer);
      this._cameraShowInitWatchTimer = null;
    }
    if (this._rollingKickoffWatchdogTimer) {
      clearTimeout(this._rollingKickoffWatchdogTimer);
      this._rollingKickoffWatchdogTimer = null;
    }
    if (this._matchSwitchRestartTimer) {
      clearTimeout(this._matchSwitchRestartTimer);
      this._matchSwitchRestartTimer = null;
    }
    if (this._matchSwitchRestartFailsafeTimer) {
      clearTimeout(this._matchSwitchRestartFailsafeTimer);
      this._matchSwitchRestartFailsafeTimer = null;
    }
    this._rollingStartPendingBeforeKickoff = false;
    if (this._liveStorageSevereModalTimer) {
      clearTimeout(this._liveStorageSevereModalTimer);
      this._liveStorageSevereModalTimer = null;
      /** 未真正弹出前离开页面，解锁以便下次 onShow 再排期 */
      this._liveStorageEntryModalShown = false;
    }
    if (this.data.showStoragePressureModal) {
      this.setData({
        showStoragePressureModal: false
      });
    }
    this._livePageVisible = false;

    // 尽力将排队中的 temp 高光固化落盘（无法阻塞 onHide，但可抢在系统回收 tmp 前发起 saveFile）
    this._kickHighlightMaterializeOnHide();

    // 切后台时彻底挂起录制管线，让出相机给外置 App，并阻断看门狗在后台自愈死循环
    this.rollingActive = false;
    this.clearSegmentStartRetryTimer();
    if (this.rollingWatchdogTimer) {
      clearInterval(this.rollingWatchdogTimer);
      this.rollingWatchdogTimer = null;
    }
    this.stopRollingRecording();

    /**
     * 切后台时系统会中断底层摄像头；若不重置 cameraMounted/cameraContext，
     * 回前台 _ensureLiveCameraReady 会误判 cameraOk 而跳过 rebuild，录制段为静止画面。
     */
    this._cameraInitDone = false;
    this._previewRecordFirstFrameAt = 0;
    this._previewRecordWarmupUntil = Date.now() + this.getPreviewRecordWarmupMs();
    this._liveReturnedFromBackground = true;
    this._liveNeedsForegroundRecordingRecover = true;
    this._clearLensSwitchScaleTransitionTimers(true);
    this._previewRecordEncoderVerified = false;
    this._encoderVerifyRestartAttempts = 0;
    if (this._hardRecoverQuarantineUntil && Date.now() < this._hardRecoverQuarantineUntil) {
      this._hardRecoverQuarantineUntil = Math.max(this._hardRecoverQuarantineUntil, Date.now() + PREVIEW_RECORD_MIN_MS_BEFORE_HIGHLIGHT_AFTER_PAGE_HIDE);
    }
    this.setData({
      cameraMounted: false,
      cameraContext: null
    });
    this._lastCameraUnmountAt = Date.now();
    if (this._previewRecordStartTimer) {
      clearTimeout(this._previewRecordStartTimer);
      this._previewRecordStartTimer = null;
    }
    this._previewRecordStartInFlight = false;
    this._liveWsFlushScorePersist();
    this.setData({
      liveWsPanelOpen: false,
      liveWsStatusText: ''
    });
    this._cacheLampBatchRunning = false;
    if (this._lightHintFadeTimer) {
      try {
        clearTimeout(this._lightHintFadeTimer);
      } catch (e) {}
      this._lightHintFadeTimer = null;
    }
    this.setData({
      lightHintText: '',
      lightHintOpacity: 0
    });
    /** 切后台不打断保存，但取消「保存完成后自动回放」，避免隐藏态误开全屏回放 */
    this._replayDeferredItem = null;
    if (this._highlightResumeUnlockFallbackTimer) {
      clearTimeout(this._highlightResumeUnlockFallbackTimer);
      this._highlightResumeUnlockFallbackTimer = null;
    }
    if (this._replayPauseWaitTimer) {
      clearTimeout(this._replayPauseWaitTimer);
      this._replayPauseWaitTimer = null;
    }
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
    this.appendHealthLog('page_hide', {});
    if (this._enhanceZeroFrameRecoverTimer) {
      clearTimeout(this._enhanceZeroFrameRecoverTimer);
      this._enhanceZeroFrameRecoverTimer = null;
    }
    this._pendingEnhanceModeAfterRecover = null;
    this._pendingEnhanceModeAfterCameraRebuild = null;
    try {
      this._recSyncWsDisconnect();
    } catch (eRecHide) {}
    this.stopEnhanceFpsPolling();
  },
  /**
   * 清除恢复按钮成功闪烁状态（页面隐藏/卸载时调用）。
   * @returns {void}
   */
  clearRecoveryFabAck: function () {
    if (this._opsAckTimer) {
      clearTimeout(this._opsAckTimer);
      this._opsAckTimer = null;
    }
    if (this.data.opsControlAck) {
      this.setData({
        opsControlAck: false
      });
    }
  },
  /**
   * 触发恢复成功的隐式反馈：一次短震 + 恢复按钮外环轻微闪烁，不显示文字提示。
   * @returns {void}
   */
  emitRecoverySuccessFeedback: function () {
    this.vibrate('light');
    if (this._opsAckTimer) {
      clearTimeout(this._opsAckTimer);
      this._opsAckTimer = null;
    }
    this.setData({
      opsControlAck: true
    });
    this._opsAckTimer = setTimeout(() => {
      this._opsAckTimer = null;
      this.setData({
        opsControlAck: false
      });
    }, 820);
  },
  /**
   * 刷新管线健康状态（低干扰状态灯）。
   * 分段之间 stop→冷却→start 的短瞬间 isRecording 为 false，文案会呈 PAUSE，与墙钟「接缝」基本同量级。
   * @returns {void}
   */
  /** @region LIVE_RECORDING — 滚动录制、看门狗、硬恢复、乒乓缓冲 */
updatePipelineHealth: function () {
    let health = 'ok';
    let text = 'PAUSE';
    let actionable = false;
    /** VK 模式故意停 rolling / 无分段，不得判为采集中断 ERR。 */
    const vkOrVkTransition = this.data.enhanceMode === 'vk' || !!this.data.enhanceVkTransitioning;
    if (this._needManualRelaunch) {
      if (this.data.pipelineHealth !== 'warn' || this.data.opsControlText !== 'ERR' || this.data.opsControlActionable !== true) {
        this.setData({
          pipelineHealth: 'warn',
          opsControlText: 'ERR',
          opsControlActionable: true
        });
      }
      return;
    }
    const now = Date.now();
    const pendingAgeMs = this.pendingHighlight ? now - (this.pendingHighlight.clickTime || this.pendingHighlight.createdAt || now) : 0;
    const inStorageRecoveryWindow = !!(this._storageSevereRecoveryUntil && now < this._storageSevereRecoveryUntil);
    const effectiveSegMs = this.getEffectiveSegmentDurationMs ? this.getEffectiveSegmentDurationMs() : this.segmentDurationMs || 8000;
    const idleAnchorAt = Number(this.lastRecordStartAt || 0) > 0 ? Number(this.lastRecordStartAt) : Number(this.lastSegmentAt || 0);
    const idleTooLong = this.rollingActive && this._cameraInitDone && now - idleAnchorAt > Math.max(effectiveSegMs * 3.5, ROLLING_KICKOFF_WATCHDOG_MS + 2500) && !this.data.isRecording && !this.rollingFsBusy && !inStorageRecoveryWindow && !this.data.storageSevereLock;
    const chunkStarved = this.rollingActive && (this._rollingTempTerminalFailStreak || 0) >= 2;
    const captureLikelyBlocked = this.highlightMissStreak > 0 || this.startRecordFailStreak >= 3 || chunkStarved || this.pendingHighlight && pendingAgeMs > effectiveSegMs * 2.2 || idleTooLong;
    if (this.data.isRecovering) {
      health = 'recovering';
      text = '...';
    } else if (vkOrVkTransition) {
      health = 'ok';
      text = '超频';
    } else if (captureLikelyBlocked) {
      health = 'warn';
      text = 'ERR';
      actionable = true;
    } else if (this.data.isRecording) {
      health = 'recording';
      text = 'REC';
    } else if (this.rollingActive && this._cameraInitDone && !this.getPreviewRecordHighlightGate().ready) {
      health = 'ok';
      text = '预热';
    } else if (this.data.storageSevereLock) {
      /** 严重水位停分段：非 ERR，避免与采集中断混淆 */
      health = 'ok';
      text = 'STO';
    }
    if (health !== this.data.pipelineHealth || text !== this.data.opsControlText || actionable !== this.data.opsControlActionable) {
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
  startHealthMonitor: function () {
    this.stopHealthMonitor();
    this.updatePipelineHealth();
    this._healthTimer = setInterval(() => this.updatePipelineHealth(), 1200);
    this.startSegmentWatchdog();
    this.startLiveSandboxStorageWatch();
  },
  /**
   * 停止健康状态监控定时器。
   * @returns {void}
   */
  stopHealthMonitor: function () {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
    this.stopSegmentWatchdog();
    this.stopLiveSandboxStorageWatch();
  },
  /**
   * 启动片段心跳看门狗：只检测“前台录制态长期没有新 segment”的假录制。
   * @returns {void}
   */
  startSegmentWatchdog: function () {
    this.stopSegmentWatchdog();
    this.segmentWatchdogTimer = setInterval(() => this.checkSegmentHeartbeat(), SEGMENT_WATCHDOG_CHECK_INTERVAL_MS);
  },
  /**
   * 停止片段心跳看门狗。
   * @returns {void}
   */
  stopSegmentWatchdog: function () {
    if (this.segmentWatchdogTimer) {
      clearInterval(this.segmentWatchdogTimer);
      this.segmentWatchdogTimer = null;
    }
    this._segmentWatchdogRecovering = false;
  },
  /**
   * Segment Watchdog 超时阈值。默认至少 15s，并随分段时长轻微放大。
   * @returns {number}
   */
  getSegmentWatchdogTimeoutMs: function () {
    if (this._previewRecordPipeline && this._previewRecordPipeline.isActive()) {
      const chunkMs = this.pingPongChunkDurationMs || 180000;
      const staggerMs = this.pingPongStaggerMs || 8000;
      return Math.max(120000, chunkMs + staggerMs + 30000);
    }
    const segmentMs = Number(this.getEffectiveSegmentDurationMs && this.getEffectiveSegmentDurationMs() || this.segmentDurationMs || 0);
    const scaled = segmentMs > 0 ? Math.floor(segmentMs * 1.8) : 0;
    return Math.max(SEGMENT_WATCHDOG_TIMEOUT_MIN_MS, scaled);
  },
  /**
   * 检查 rolling segment 心跳，覆盖 isRecording 假活但长期无新段的场景。
   * @returns {void}
   */
  checkSegmentHeartbeat: function () {
    if (!this._livePageVisible) return;
    if (!this.data.liveStreamAllowed) return;
    if (!this.data.isRecording) return;
    if (this.data.isRecovering || this._recoveryLock) return;
    if (this._segmentWatchdogRecovering) return;
    if (this._needManualRelaunch) return;
    if (this.data.storageSevereLock) return;
    if (this.pendingHighlight || this.data.isSavingHighlight) return;
    if (this.data.enhanceMode === 'vk' || this.data.enhanceVkTransitioning) return;
    if (this.rollingFsBusy || this._rollingPersistInFlight > 0) return;
    if (!this.data.cameraContext) return;
    if (this._storageSevereRecoveryUntil && Date.now() < this._storageSevereRecoveryUntil) return;
    const now = Date.now();
    const previewActive = !!(this._previewRecordPipeline && this._previewRecordPipeline.isActive());
    const lastSegmentAt = Number(previewActive ? Math.max(this._previewRecordLastHeartbeatAt || 0, this._lastSuccessfulChunkAt || 0, this.lastSegmentAt || 0, typeof this._previewRecordPipeline.getLastHeartbeatAt === 'function' ? this._previewRecordPipeline.getLastHeartbeatAt() : 0) : this.lastSegmentAt || 0);
    if (lastSegmentAt <= 0) return;
    const recordStartAt = Number(this.lastRecordStartAt || 0);
    const recordAgeMs = recordStartAt > 0 ? now - recordStartAt : now - lastSegmentAt;
    const timeoutMs = this.getSegmentWatchdogTimeoutMs();
    const segmentGapMs = now - lastSegmentAt;
    if (previewActive && recordAgeMs >= PREVIEW_FRAME_FEED_STALL_MS && segmentGapMs >= PREVIEW_FRAME_FEED_STALL_MS) {
      this.appendHealthLog('preview_record_frame_stall', {
        gapMs: segmentGapMs,
        recordAgeMs,
        stallMs: PREVIEW_FRAME_FEED_STALL_MS,
        diag: this.getLiveRollingDiagSnapshot({})
      });
      this.requestPreviewRecordWatchdogRecover('preview_frame_stall');
      return;
    }
    if (previewActive && recordAgeMs >= 15000) {
      if (now < (this._encodeStallGraceUntil || 0)) {
        return;
      }
      const stallThresholdMs = this._liveReturnedFromBackground ? ENCODE_STALL_AFTER_PAGE_HIDE_MS : 15000;
      if (recordAgeMs < stallThresholdMs) {
        return;
      }
      if (this._liveReturnedFromBackground && now - (this._lastEncodeStallRecoverAt || 0) < ENCODE_STALL_RECOVER_COOLDOWN_MS) {
        return;
      }
      const lastGoodChunkAt = Number(this._lastSuccessfulChunkAt || 0);
      const pipelineHeartbeatAt = Number(this._previewRecordLastHeartbeatAt || 0);
      const effectiveGoodAt = Math.max(lastGoodChunkAt, pipelineHeartbeatAt, Number(this.lastSegmentAt || 0));
      const chunkGapMs = effectiveGoodAt > 0 ? now - effectiveGoodAt : recordAgeMs;
      if (chunkGapMs >= Math.min(recordAgeMs, stallThresholdMs)) {
        if (pipelineHeartbeatAt > 0 && now - pipelineHeartbeatAt < PREVIEW_FRAME_FEED_STALL_MS) {
          return;
        }
        this.appendHealthLog('preview_record_encode_stall', {
          recordAgeMs,
          chunkGapMs,
          stallThresholdMs,
          afterPageHide: !!this._liveReturnedFromBackground,
          diag: this.getLiveRollingDiagSnapshot({})
        });
        if (this._liveReturnedFromBackground) {
          this._lastEncodeStallRecoverAt = now;
          this._encodeStallGraceUntil = now + ENCODE_STALL_RECOVER_COOLDOWN_MS;
          this.hardRecoverLivePipeline('encode_stall_after_page_show');
        } else {
          this.requestPreviewRecordWatchdogRecover('encode_stall');
        }
        return;
      }
    }
    if (segmentGapMs < timeoutMs) return;
    if (recordAgeMs < timeoutMs) return;
    if (now - (this._lastSegmentWatchdogRecoverAt || 0) < SEGMENT_WATCHDOG_RECOVER_COOLDOWN_MS) {
      return;
    }
    this.appendHealthLog('segment_watchdog_timeout', {
      gapMs: segmentGapMs,
      recordAgeMs,
      timeoutMs,
      previewActive,
      diag: this.getLiveRollingDiagSnapshot({})
    });
    if (previewActive) {
      this.requestPreviewRecordWatchdogRecover('segment_watchdog');
      return;
    }
    this.requestSegmentWatchdogRollingRecover('segment_watchdog');
  },
  /**
   * 高光 flush 未拿到有效 segment（常见：remount 后空壳段被拒）时触发自愈。
   * @param {number} anchorClickTime
   * @returns {void}
   */
  _recoverAfterHighlightFlushMiss: function (anchorClickTime) {
    const pipeline = this._previewRecordPipeline;
    const recordStartAt = Number(this.lastRecordStartAt || 0);
    const recordAgeMs = recordStartAt > 0 ? Date.now() - recordStartAt : 0;
    const minHighlightMs = this.getPreviewRecordMinHighlightMs();
    const trackCount = pipeline && typeof pipeline.getRecordingTrackCount === 'function' ? pipeline.getRecordingTrackCount() : 0;
    const pipelineInactive = !pipeline || !pipeline.isActive();
    const hasZombieTracks = pipeline && typeof pipeline.hasZombieTracks === 'function' && pipeline.hasZombieTracks();
    if (hasZombieTracks && typeof pipeline.recoverZombieTracks === 'function') {
      this.appendHealthLog('highlight_flush_recover_zombie_tracks', {
        anchorClickTime: anchorClickTime || 0,
        trackCount,
        recordAgeMs,
        whileSaving: !!(this.data.isSavingHighlight || this.pendingHighlight)
      });
      pipeline.recoverZombieTracks('highlight_flush_miss');
      return;
    }
    if (this.data.isSavingHighlight || this.pendingHighlight || this.highlightMaterializeRunning) {
      this.appendHealthLog('highlight_flush_recover_skip_saving', {
        anchorClickTime: anchorClickTime || 0,
        trackCount,
        materializeRunning: !!this.highlightMaterializeRunning
      });
      return;
    }
    if (!pipelineInactive && trackCount > 0) {
      if (this.isLiveForegroundRecordingRecoverPending()) {
        this._highlightHollowFlushStreak = (this._highlightHollowFlushStreak || 0) + 1;
        this.appendHealthLog('highlight_flush_recover_hollow_active_tracks', {
          anchorClickTime: anchorClickTime || 0,
          trackCount,
          recordAgeMs,
          streak: this._highlightHollowFlushStreak
        });
        if (this._highlightHollowFlushStreak >= 2) {
          this.hardRecoverLivePipeline('highlight_hollow_flush');
        } else {
          this._restartPreviewPipelineForHollow();
        }
        return;
      }
      this.appendHealthLog('highlight_flush_recover_skip_active_tracks', {
        anchorClickTime: anchorClickTime || 0,
        trackCount,
        recordAgeMs
      });
      return;
    }
    const notReadyForFlush = pipelineInactive || recordStartAt <= 0 || recordAgeMs < minHighlightMs || trackCount <= 0;
    if (notReadyForFlush) {
      this.appendHealthLog('highlight_flush_recover_deferred_not_ready', {
        anchorClickTime: anchorClickTime || 0,
        pipelineInactive,
        recordStartAt,
        recordAgeMs,
        minHighlightMs,
        trackCount,
        afterPageHide: !!this._liveReturnedFromBackground
      });
      this.tryStartRollingWhenCameraReady('highlight_flush_not_ready');
      return;
    }
    this._highlightHollowFlushStreak = (this._highlightHollowFlushStreak || 0) + 1;
    this.appendHealthLog('highlight_flush_recover_scheduled', {
      streak: this._highlightHollowFlushStreak,
      afterPageHide: !!this._liveReturnedFromBackground,
      anchorClickTime: anchorClickTime || 0
    });
    if (this._highlightFlushRecoverTimer) {
      clearTimeout(this._highlightFlushRecoverTimer);
      this._highlightFlushRecoverTimer = null;
    }
    const self = this;
    this._highlightFlushRecoverTimer = setTimeout(() => {
      self._highlightFlushRecoverTimer = null;
      if (!self._livePageVisible || !self.rollingActive) return;
      if (self.data.isRecovering || self._recoveryLock) return;
      if (self.data.isSavingHighlight || self.pendingHighlight || self.highlightMaterializeRunning) {
        self.appendHealthLog('highlight_flush_recover_skip_saving', {
          anchorClickTime: anchorClickTime || 0,
          phase: 'timer'
        });
        return;
      }
      const liveTracks = pipeline && typeof pipeline.getRecordingTrackCount === 'function' ? pipeline.getRecordingTrackCount() : 0;
      if (pipeline && pipeline.isActive() && liveTracks > 0) {
        self.appendHealthLog('highlight_flush_recover_skip_active_tracks', {
          anchorClickTime: anchorClickTime || 0,
          trackCount: liveTracks,
          phase: 'timer'
        });
        return;
      }
      if (self._liveReturnedFromBackground || self._highlightHollowFlushStreak >= 2) {
        self.hardRecoverLivePipeline('highlight_hollow_flush');
        return;
      }
      self.requestPreviewRecordWatchdogRecover('highlight_hollow_flush');
    }, 500);
  },
  /**
   * 视录分离模式：仅重启乒乓管线，不 bump rollingSessionId、不重建 camera。
   * @param {string} source
   * @returns {boolean}
   */
  requestPreviewRecordWatchdogRecover: function (source) {
    const now = Date.now();
    if (this._segmentWatchdogRecovering) return false;
    if (this.data.isRecovering || this._recoveryLock) return false;
    if (this.data.isSavingHighlight || this.pendingHighlight || this.highlightMaterializeRunning) {
      return false;
    }
    if (!this._livePageVisible) return false;
    if (now - (this._lastSegmentWatchdogRecoverAt || 0) < SEGMENT_WATCHDOG_RECOVER_COOLDOWN_MS) {
      return false;
    }
    const pipeline = this._previewRecordPipeline;
    if (!pipeline) return false;
    this._segmentWatchdogRecovering = true;
    this._lastSegmentWatchdogRecoverAt = now;
    const triggerSource = source || 'preview_watchdog';
    this.appendHealthLog('preview_record_watchdog_recover_start', {
      triggerSource,
      diag: this.getLiveRollingDiagSnapshot({})
    });
    const restart = () => {
      this._segmentWatchdogRecovering = false;
      if (!this._livePageVisible || !this.rollingActive) return;
      if (!this._cameraInitDone || !this.data.cameraContext) return;
      this.tryStartRollingWhenCameraReady(triggerSource);
    };
    if (pipeline.isActive()) {
      pipeline.stop().then(restart).catch(restart);
    } else {
      restart();
    }
    return true;
  },
  /**
   * Segment Watchdog 触发的低侵入 rolling-only 恢复：不重建 camera，不进入 hard recover。
   * @param {string} source 触发来源
   * @returns {boolean}
   */
  requestSegmentWatchdogRollingRecover: function (source) {
    const now = Date.now();
    if (this._segmentWatchdogRecovering) return false;
    if (this.data.isRecovering || this._recoveryLock) return false;
    if (!this._livePageVisible) return false;
    if (this.data.enhanceMode === 'vk' || this.data.enhanceVkTransitioning) return false;
    if (now - (this._lastSegmentWatchdogRecoverAt || 0) < SEGMENT_WATCHDOG_RECOVER_COOLDOWN_MS) {
      return false;
    }
    const triggerSource = source || 'segment_watchdog';
    const prevSessionId = this.rollingSessionId;
    this._segmentWatchdogRecovering = true;
    this._lastSegmentWatchdogRecoverAt = now;
    this.appendHealthLog('segment_watchdog_soft_recover_start', {
      triggerSource,
      diag: this.getLiveRollingDiagSnapshot({})
    });
    this.rollingActive = false;
    this.stopRollingRecording(() => {
      setTimeout(() => {
        this._segmentWatchdogRecovering = false;
        if (!this._livePageVisible) return;
        if (this.data.isRecovering || this._recoveryLock) return;
        if (this._needManualRelaunch || this.data.storageSevereLock) return;
        if (this.data.enhanceMode === 'vk' || this.data.enhanceVkTransitioning) return;
        if (!this._cameraInitDone || !this.data.cameraContext) {
          this.appendHealthLog('segment_watchdog_soft_recover_skip_camera_not_ready', {
            triggerSource,
            diag: this.getLiveRollingDiagSnapshot({})
          });
          this.updatePipelineHealth();
          return;
        }
        this.lastSegmentAt = Date.now();
        this.lastRecordStartAt = 0;
        this.startRecordFailStreak = 0;
        this.segmentStartFailStormCycles = 0;
        this.rollingActive = true;
        this.rollingSessionId += 1;
        if (this._recorderCore) {
          this._recorderCore.markReady(triggerSource);
        }
        this.appendHealthLog('segment_watchdog_soft_recover_kick', {
          triggerSource,
          prevSessionId,
          rollingSessionId: this.rollingSessionId
        });
        this.tryStartRollingWhenCameraReady(triggerSource);
      }, SEGMENT_WATCHDOG_RESTART_DELAY_MS);
    }, triggerSource);
    return true;
  },
  /**
   * 启动恢复进度圆环动画（在 isRecovering 期间爬升至约 88%，就绪后由 stopRecoveryProgressAnim(true) 拉满）。
   * @returns {void}
   */
  startRecoveryProgressAnim: function () {
    if (this._recoverProgTimer) {
      clearInterval(this._recoverProgTimer);
      this._recoverProgTimer = null;
    }
    if (this._recoverProgressResetTimer) {
      clearTimeout(this._recoverProgressResetTimer);
      this._recoverProgressResetTimer = null;
    }
    this.setData({
      recoveryProgress: 0,
      recoveryConicEndDeg: 0
    });
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
  stopRecoveryProgressAnim: function (complete) {
    if (this._recoverProgTimer) {
      clearInterval(this._recoverProgTimer);
      this._recoverProgTimer = null;
    }
    if (this._recoverProgressResetTimer) {
      clearTimeout(this._recoverProgressResetTimer);
      this._recoverProgressResetTimer = null;
    }
    if (!complete) {
      this.setData({
        recoveryProgress: 0,
        recoveryConicEndDeg: 0
      });
      return;
    }
    this.setData({
      recoveryProgress: 100,
      recoveryConicEndDeg: 360
    });
    this._recoverProgressResetTimer = setTimeout(() => {
      this._recoverProgressResetTimer = null;
      if (!this.data.isRecovering) {
        this.setData({
          recoveryProgress: 0,
          recoveryConicEndDeg: 0
        });
      }
    }, 480);
  },
  /**
   * 恢复失败兜底：释放锁并回退 UI，避免状态钮永久不可点击。
   * @param {string} reason
   * @returns {void}
   */
  finalizeRecoveryAsFailed: function (reason) {
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
    this.setData({
      isRecovering: false,
      showRecoveryVeil: false
    });
    this._recoveryLock = false;
    if (this._recorderCore) {
      this._recorderCore.onRecoverFail(reason || 'unknown');
    }
    this.appendHealthLog('hard_recover_fail', {
      reason: reason || 'unknown',
      diag: this.getLiveRollingDiagSnapshot({})
    });
    if (reason === 'recovering_ui_5s_failsafe' && (this._insertCameraErrorStreak || 0) >= 2) {
      this.markNeedManualRelaunch('recovering_failsafe_after_insert_conflict');
    }
    this.updatePipelineHealth();
  },
  /**
   * 页面内一键恢复：硬重建 camera 与 rolling 管线，避免必须退回微信。
   * @param {string} trigger 触发来源（manual/auto）
   * @returns {void}
   */
  hardRecoverLivePipeline: function (trigger) {
    if (this._recorderCore) {
      return this._recorderCore.requestRecover(trigger || 'manual');
    }
    return this._hardRecoverLivePipelineImpl(trigger);
  },
  _hardRecoverLivePipelineImpl: function (trigger) {
    if (this._recoveryLock) return;
    const source = trigger || 'manual';
    const now = Date.now();
    if (source.indexOf('auto:') === 0 && this._fileQuotaCircuitUntil && now < this._fileQuotaCircuitUntil) {
      this.appendHealthLog('hard_recover_blocked_by_file_quota_circuit', {
        trigger: source,
        remainMs: this._fileQuotaCircuitUntil - now
      });
      return;
    }
    if (!this._livePageVisible) {
      this.appendHealthLog('hard_recover_skip_page_hidden', {
        trigger: source,
        diag: this.getLiveRollingDiagSnapshot({})
      });
      return;
    }
    const cooldownUntil = this._insertCameraRecoverCooldownUntil || 0;
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
      this.appendHealthLog('hard_recover_skip_too_frequent', {
        trigger: trigger || 'manual'
      });
      return;
    }
    this._lastHardRecoverAt = now;
    this._hardRecoverHadTimeoutRebuild = false;
    this._rollingPipelineEpoch = (this._rollingPipelineEpoch || 0) + 1;
    this._hardRecoverQuarantineUntil = now + HARD_RECOVER_HIGHLIGHT_QUARANTINE_MS;
    this._recoveryLock = true;
    if (this._recoveryGuardTimer) {
      clearTimeout(this._recoveryGuardTimer);
      this._recoveryGuardTimer = null;
    }
    this.appendHealthLog('hard_recover_start', {
      trigger: source,
      diag: this.getLiveRollingDiagSnapshot({})
    });
    this._manualRecoveryPendingAck = typeof source === 'string' && source.indexOf('manual') === 0;
    this._hardRecoverAwaitingCamera = true;
    this._recoveryGuardTimer = setTimeout(() => {
      this._recoveryGuardTimer = null;
      if (!this._hardRecoverAwaitingCamera) return;
      this.appendHealthLog('hard_recover_timeout', {
        trigger: source
      });
      this._hardRecoverHadTimeoutRebuild = true;
      this._hardRecoverQuarantineUntil = Math.max(this._hardRecoverQuarantineUntil || 0, Date.now() + HARD_RECOVER_TIMEOUT_EXTRA_QUARANTINE_MS);
      this._previewRecordWarmupUntil = Date.now() + this.getPreviewRecordWarmupMs() + 2400;
      if (this._previewRecordStartTimer) {
        clearTimeout(this._previewRecordStartTimer);
        this._previewRecordStartTimer = null;
      }
      this._previewRecordStartInFlight = false;
      const kickTimeoutRebuild = () => {
        // 超时后二次强制重建一次，避免 iOS 在 stop 后偶发不再触发 initdone。
        this.rebuildCameraComponent(generation => {
          this.remountCameraComponent({
            generation
          });
        });
      };
      const pipeline = this._previewRecordPipeline;
      if (pipeline && pipeline.isActive()) {
        this.stopRollingRecording(kickTimeoutRebuild, 'hard_recover_timeout');
        return;
      }
      kickTimeoutRebuild();
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
    if (this._recorderCore) {
      this._recorderCore.clearPendingHighlight();
    } else {
      if (this.pendingHighlight && this.pendingHighlight.timeout) {
        clearTimeout(this.pendingHighlight.timeout);
      }
      this.pendingHighlight = null;
    }
    this.clearHighlightSavePipelineState();
    /** 避免 isSavingHighlight 仍为 true 时阻塞 FAB / 自动恢复，且与 Native is recording 假死叠加 */
    this.endHighlightSaving();
    this.rollingFsBusy = false;
    this._rollingPersistInFlight = 0;
    this.lastRecordStartAt = 0;
    this.startRecordFailStreak = 0;
    this.segmentPersistFailStreak = 0;
    this.segmentStartFailStormCycles = 0;
    this._rollingTempTerminalFailStreak = 0;
    this._rollingTempMissingStreak = 0;
    this._lastSuccessfulChunkAt = 0;
    this._lastSegmentOperateFailAt = 0;
    this._previewRecordEncoderVerified = false;
    this._encoderVerifyRestartAttempts = 0;
    if (String(source || '').indexOf('temp_missing_storm') >= 0) {
      this._tempMissingHardRecoverCycles = (this._tempMissingHardRecoverCycles || 0) + 1;
    }
    this.setData({
      isRecovering: true,
      showRecoveryVeil: true,
      recoveryVeilSrc: this.data.defaultCover
    });
    if (this._recoverUiFailsafeTimer) {
      clearTimeout(this._recoverUiFailsafeTimer);
      this._recoverUiFailsafeTimer = null;
    }
    let recoverUiFailsafeMs = 6000;
    try {
      const siFs = wx.getSystemInfoSync();
      if (siFs && siFs.platform === 'ios') {
        recoverUiFailsafeMs = 11000;
      }
    } catch (eFs) {
      recoverUiFailsafeMs = 6000;
    }
    this._recoverUiFailsafeTimer = setTimeout(() => {
      this._recoverUiFailsafeTimer = null;
      if (this.data.isRecovering) {
        this.finalizeRecoveryAsFailed('recovering_ui_5s_failsafe');
      }
    }, recoverUiFailsafeMs);
    this.startRecoveryProgressAnim();
    this.armNativeEnhanceModeRestoreAfterCameraRebuild('hard_recover');
    const triggerText = String(source || '');
    const longSessionNeedsRebuild = (this.segmentCounter || 0) >= 80;
    /**
     * 切后台回前台后 cameraContext 常已假死：仅重启 recorder 无法恢复画面，
     * highlight 空壳 flush / 编码停滞等必须走 rebuildCameraComponent。
     */
    const forceCameraRebuild = !!(this._liveReturnedFromBackground || triggerText.indexOf('highlight_hollow') >= 0 || triggerText.indexOf('encode_stall_after_page_show') >= 0 || triggerText.indexOf('page_show') >= 0);
    const allowCameraRebuild = forceCameraRebuild || !!(this._recorderCore && this._recorderCore.recoverFailCount >= 2 || triggerText.indexOf('temp_missing_storm') >= 0 || triggerText.indexOf('auto:stop:') >= 0 && longSessionNeedsRebuild);
    this.stopRollingRecording(() => {
      this.rollingSegments = [];
      this.segmentBuffer = [];
      this.segmentCounter = 0;
      this.purgeAllRollingMp4('hard_recover');
      if (this._replayBuffer && typeof this._replayBuffer.clear === 'function') {
        this._replayBuffer.clear();
      }
      this.lastSegmentAt = Date.now();
      if (!allowCameraRebuild) {
        this.appendHealthLog('hard_recover_recorder_restart_only', {
          trigger: source
        });
        this.rollingActive = true;
        this.rollingSessionId += 1;
        this.highlightMissStreak = 0;
        this._cameraFaultStreak = 0;
        this.tryStartRollingWhenCameraReady('recover_restart_only');
        if (this._recoveryGuardTimer) {
          clearTimeout(this._recoveryGuardTimer);
          this._recoveryGuardTimer = null;
        }
        if (this._recoverUiFailsafeTimer) {
          clearTimeout(this._recoverUiFailsafeTimer);
          this._recoverUiFailsafeTimer = null;
        }
        this._hardRecoverAwaitingCamera = false;
        this.stopRecoveryProgressAnim(true);
        this.setData({
          isRecovering: false,
          showRecoveryVeil: false
        });
        this._recoveryLock = false;
        if (this._manualRecoveryPendingAck) {
          this._manualRecoveryPendingAck = false;
          this.emitRecoverySuccessFeedback();
        }
        if (this._recorderCore) {
          this._recorderCore.onRecoverSuccess('recorder_restart_only');
        }
        return;
      }
      this._cameraInitDone = false;
      this.setData({
        cameraMounted: false,
        cameraContext: null
      });
      this._lastCameraUnmountAt = Date.now();
      this.rebuildCameraComponent(generation => {
        this.remountCameraComponent({
          generation,
          onMounted: () => {
            this.rollingActive = true;
            this.rollingSessionId += 1;
            this.highlightMissStreak = 0;
            this._cameraFaultStreak = 0;
            this._encodeStallGraceUntil = Date.now() + ENCODE_STALL_RECOVER_COOLDOWN_MS;
            this.appendHealthLog('hard_recover_rebuild_done', {
              trigger: source
            });
          }
        });
      });
    }, 'hard_recover');
  },
  /**
   * P0: 主动式帧数脉搏监控。
   * 仅在切后台回前台时启用（冷启动不需要）——检测 iOS 系统相机假死。
   * 录制启动 6 秒后检查 pipeline heartbeat + recording track 双信号；
   * 若两者均无活跃迹象则判定管线假死，触发毁灭性重建。
   * @returns {void}
   */
  _armFramePulseMonitor: function () {
    if (this._framePulseTimer) {
      clearTimeout(this._framePulseTimer);
      this._framePulseTimer = null;
    }
    // 仅在切后台回前台时启用——冷启动时 onCameraFrame heartbeat 周期为 5s，
    // 不需要也不应该触发帧脉搏检测
    if (!this.isLiveForegroundRecordingRecoverPending()) return;
    const pipeline = this._previewRecordPipeline;
    if (!pipeline || !pipeline.isActive()) return;
    // heartbeat 刷新周期为 5s，检查延迟须 > 5s 避免误判
    const checkDelayMs = 6000;
    const armTs = Date.now();
    this._framePulseTimer = setTimeout(() => {
      this._framePulseTimer = null;
      if (!this._livePageVisible || !this.rollingActive) return;
      if (!pipeline.isActive()) return;
      const heartbeatAt = typeof pipeline.getLastHeartbeatAt === 'function'
        ? pipeline.getLastHeartbeatAt() : 0;
      const heartbeatAgeMs = heartbeatAt > 0 ? Date.now() - heartbeatAt : -1;
      // heartbeat 刷新周期 5s，6s 内收到过即视为存活
      const hasRecentHeartbeat = heartbeatAgeMs >= 0 && heartbeatAgeMs < checkDelayMs;
      // 双信号：recording track 数量 > 0 也视为管线存活
      const trackCount = typeof pipeline.getRecordingTrackCount === 'function'
        ? pipeline.getRecordingTrackCount() : 0;
      const isAlive = hasRecentHeartbeat || trackCount > 0;
      this.appendHealthLog('frame_pulse_check', {
        heartbeatAgeMs,
        hasRecentHeartbeat,
        trackCount,
        isAlive,
        afterPageHide: !!this._liveReturnedFromBackground
      });
      if (!isAlive) {
        this.appendHealthLog('frame_pulse_dead_detected', {
          heartbeatAgeMs,
          trackCount,
          armTs,
          afterPageHide: !!this._liveReturnedFromBackground
        });
        this._destructiveCameraRemount('frame_pulse_dead');
      }
    }, checkDelayMs);
  },
  /**
   * WebGL 渲染上下文发生致命丢失时触发的自愈回调。
   * @returns {void}
   */
  onWebGLContextFatal: function () {
    this.appendHealthLog('webgl_context_fatal_event', {});
    this._destructiveCameraRemount('webgl_context_fatal');
  },
  /**
   * P0: 毁灭性原生组件销毁。
   * 时序锁串行保证：先 stopRolling（等 I/O 写完）→ setData(isCameraRendered:false) 销毁 →
   * wx.nextTick + 100ms 等底层清理 → setData(isCameraRendered:true) 重新索取硬件锁 →
   * rebuildCameraComponent → remountCameraComponent → start pipeline。
   * @param {string} reason
   * @returns {void}
   */
  _destructiveCameraRemount: function (reason) {
    if (this._destructiveRemountLock) {
      this.appendHealthLog('destructive_remount_skip_locked', { reason: reason || '' });
      return;
    }
    if (!this._livePageVisible) {
      this.appendHealthLog('destructive_remount_skip_hidden', { reason: reason || '' });
      return;
    }
    this._clearLensSwitchScaleTransitionTimers(true);
    this._previewRecordEncoderVerified = false;
    this._encoderVerifyRestartAttempts = 0;
    this._awaitingFirstSuccessChunkAfterRemount = true;
    if (this._awaitingChunkTimeout) {
      clearTimeout(this._awaitingChunkTimeout);
    }
    this._awaitingChunkTimeout = setTimeout(() => {
      if (this._awaitingFirstSuccessChunkAfterRemount) {
        this._awaitingFirstSuccessChunkAfterRemount = false;
        this.appendHealthLog('awaiting_first_chunk_timeout_fallback', { reason: reason || '' });
      }
    }, 15000);
    this._destructiveRemountLock = true;
    this.appendHealthLog('destructive_camera_remount_start', { reason: reason || '' });
    const self = this;
    // Step 1: 停止 pipeline，释放文件句柄
    this.stopRollingRecording(() => {
      // Step 2: 销毁原生 <camera> 组件
      self.setData({ isCameraRendered: false }, () => {
        // Step 3: wx.nextTick 确保底层彻底抹去节点
        const afterDestroy = () => {
          // Step 4: 100ms 延时后重新创建 camera 节点
          setTimeout(() => {
            if (!self._livePageVisible) {
              self._destructiveRemountLock = false;
              self.appendHealthLog('destructive_camera_remount_abort_hidden', { reason: reason || '' });
              // 仍需恢复 isCameraRendered，否则回前台后永远黑屏
              self.setData({ isCameraRendered: true });
              return;
            }
            self.setData({ isCameraRendered: true }, () => {
              self.appendHealthLog('destructive_camera_remount_dom_restored', { reason: reason || '' });
              // Step 5: rebuild → remount → start pipeline
              self._cameraInitDone = false;
              self._previewRecordWarmupUntil = Date.now() + self.getPreviewRecordWarmupMs();
              self.rebuildCameraComponent(generation => {
                self.remountCameraComponent({
                  generation,
                  onMounted: () => {
                    self._destructiveRemountLock = false;
                    self.rollingActive = true;
                    self.rollingSessionId += 1;
                    self.highlightMissStreak = 0;
                    self._cameraFaultStreak = 0;
                    self._encodeStallGraceUntil = Date.now() + ENCODE_STALL_RECOVER_COOLDOWN_MS;
                    if (reason !== 'force_background_recover') {
                      self._hardRecoverQuarantineUntil = Date.now() + HARD_RECOVER_HIGHLIGHT_QUARANTINE_MS;
                    } else {
                      self._hardRecoverQuarantineUntil = 0;
                    }
                    self.appendHealthLog('destructive_camera_remount_done', { reason: reason || '' });
                    self.tryStartRollingWhenCameraReady('destructive_remount_done');
                  }
                });
              });
            });
          }, isLiveHostIos() ? 400 : 100);
        };
        if (wx.nextTick) {
          wx.nextTick(afterDestroy);
        } else {
          setTimeout(afterDestroy, 0);
        }
      });
    }, 'destructive_remount');
  },
  /**
   * remount 后约 10s 强制探针轮换，空壳则自动重启管线。
   * @returns {void}
   */
  _armPostRemountEncodingProbe: function () {
    if (this._encodingProbeTimer) {
      clearTimeout(this._encodingProbeTimer);
      this._encodingProbeTimer = null;
    }
    const self = this;
    this._encodingProbeTimer = setTimeout(() => {
      self._encodingProbeTimer = null;
      self._runPostRemountEncodingProbe();
    }, 18000);
  },
  /**
   * remount 后探针超时：若仍未验证编码器则强制轮换 A 轨或重启管线。
   * @returns {void}
   */
  _runPostRemountEncodingProbe: function () {
    if (!this._livePageVisible || !this.rollingActive) return;
    if (!this.isLiveForegroundRecordingRecoverPending()) return;
    if (this._previewRecordEncoderVerified) return;
    const pipeline = this._previewRecordPipeline;
    if (!pipeline || !pipeline.isActive()) return;
    if (typeof pipeline.ensureDualTrackHealth === 'function') {
      pipeline.ensureDualTrackHealth();
    }
    this.appendHealthLog('encoding_probe_timeout_no_verify', {
      segmentCounter: this.segmentCounter || 0,
      lastSuccessfulChunkAgeMs: this._lastSuccessfulChunkAt
        ? Date.now() - this._lastSuccessfulChunkAt
        : -1,
      verifyAttempts: this._encoderVerifyRestartAttempts || 0
    });
    if (typeof pipeline.forceProbeRotate === 'function') {
      pipeline.forceProbeRotate('A');
      return;
    }
    this._scheduleHollowPipelineRestart({ source: 'encoding_probe' });
  },
  /**
   * 空壳段落盘后调度管线重启（debounce，避免双轨同时空壳重复触发）。
   * @param {{ source?: string, trackId?: string, sizeBytes?: number }} [detail]
   * @returns {void}
   */
  _scheduleHollowPipelineRestart: function (detail) {
    const recoverPending = this.isLiveForegroundRecordingRecoverPending();
    const source = detail && detail.source ? String(detail.source) : '';
    if (!recoverPending && source !== 'chunk_duration' && source !== 'highlight_flush') {
      return;
    }
    if (this._hollowRestartDebounceTimer) {
      clearTimeout(this._hollowRestartDebounceTimer);
      this._hollowRestartDebounceTimer = null;
    }
    this._previewRecordEncoderVerified = false;
    const self = this;
    this._hollowRestartDebounceTimer = setTimeout(() => {
      self._hollowRestartDebounceTimer = null;
      self._encoderVerifyRestartAttempts = (self._encoderVerifyRestartAttempts || 0) + 1;
      if (self._encoderVerifyRestartAttempts > ENCODER_VERIFY_RESTART_MAX) {
        self.appendHealthLog('encoder_verify_restart_exhausted', {
          attempts: self._encoderVerifyRestartAttempts,
          source
        });
        self.hardRecoverLivePipeline('highlight_hollow_flush');
        return;
      }
      if (self.data.isSavingHighlight || self.pendingHighlight || self.highlightMaterializeRunning) {
        self._pendingHollowPipelineRestart = true;
        self.appendHealthLog('hollow_restart_deferred_saving', { source });
        return;
      }
      self._restartPreviewPipelineForHollow();
    }, 400);
  },
  /**
   * 高光 flush 空壳后重启 preview 管线（保留相机不重 mount）。
   * @returns {void}
   */
  _restartPreviewPipelineForHollow: function () {
    if (!this._livePageVisible || !this.rollingActive) return;
    if (this.data.isRecovering || this._recoveryLock) return;
    const pipeline = this._previewRecordPipeline;
    if (!pipeline) return;
    this._previewRecordEncoderVerified = false;
    this.appendHealthLog('preview_pipeline_hollow_restart', {
      attempts: this._encoderVerifyRestartAttempts || 0
    });
    const self = this;
    const restart = () => {
      if (!self._livePageVisible || !self.rollingActive) return;
      self.tryStartRollingWhenCameraReady('hollow_restart');
    };
    if (pipeline.isActive()) {
      pipeline.stop().then(restart).catch(restart);
    } else {
      restart();
    }
  },
  /**
   * 右下角状态钮：REC 时保存高光；ERR 时单击触发页内硬恢复（不跳页、不挡预览）。
   * @returns {void}
   */
  onRecoveryFabTap: function () {
    this.appendHealthLog('recovery_fab_tap', {
      pipelineHealth: this.data.pipelineHealth,
      opsControlText: this.data.opsControlText,
      isRecording: !!this.data.isRecording,
      rollingActive: !!this.rollingActive,
      recorderState: this._recorderCore ? this._recorderCore.state : ''
    });
    if (this.data.isRecovering) {
      this.appendHealthLog('recovery_fab_tap_ignored', {
        reason: 'recovering'
      });
      return;
    }
    if (this.data.storageSevereLock) {
      this.appendHealthLog('recovery_fab_tap_ignored', {
        reason: 'storage_severe'
      });
      this._showLightHint('请先清理空间');
      return;
    }
    if (this.data.isSavingHighlight || this.pendingHighlight) {
      this.appendHealthLog('recovery_fab_tap_ignored', {
        reason: this.data.isSavingHighlight ? 'saving_highlight' : 'pending_highlight'
      });
      return;
    }
    if (this._recoveryFabLongPressConsumed) {
      this._recoveryFabLongPressConsumed = false;
      this.appendHealthLog('recovery_fab_tap_ignored', {
        reason: 'longpress_consumed'
      });
      return;
    }
    const canCaptureWhileRolling = !!this.rollingActive && !!this._cameraInitDone && !!this.data.cameraContext && !this.data.isRecovering && !this._recoveryLock;
    if (this.data.enhanceMode === 'vk') {
      this.requestHighlightCapture();
      return;
    }
    const highlightGate = this.getPreviewRecordHighlightGate();
    if (highlightGate.ready) {
      this.requestHighlightCapture();
      return;
    }
    if (canCaptureWhileRolling || this.data.pipelineHealth === 'recording') {
      this.appendHealthLog('recovery_fab_tap_not_ready', {
        reason: highlightGate.reason || 'unknown',
        recordAgeMs: highlightGate.recordAgeMs || 0,
        minHighlightMs: highlightGate.minHighlightMs || 0,
        remainMs: highlightGate.remainMs || 0
      });
      if (highlightGate.reason === 'awaiting_first_chunk') {
        wx.showToast({
          title: '相机恢复中，等待录制数据稳定...',
          icon: 'none',
          duration: 2200
        });
        return;
      }
      if (highlightGate.reason === 'encoder_not_verified' || highlightGate.reason === 'encoder_live_warming') {
        wx.showToast({
          title: '编码器校验中，请稍候...',
          icon: 'none',
          duration: 2200
        });
        return;
      }
      if (highlightGate.reason === 'guide_visible') {
        wx.showToast({
          title: '请先完成新手引导',
          icon: 'none',
          duration: 2200
        });
        return;
      }
      const remainSec = highlightGate.remainMs ? Math.max(1, Math.ceil(highlightGate.remainMs / 1000)) : 0;
      const fabWarmTitle = highlightGate.reason === 'match_switch_warming' ? remainSec > 0 ? `新场次缓冲中，约${remainSec}秒后可保存` : '新场次缓冲中，请稍后再保存' : remainSec > 0 ? this._liveReturnedFromBackground ? `相机恢复中，约${remainSec}秒后可保存` : `相机预热中，约${remainSec}秒后可保存` : '相机预热中，请稍后再保存';
      wx.showToast({
        title: fabWarmTitle,
        icon: 'none',
        duration: 2200
      });
      this.tryStartRollingWhenCameraReady('recovery_fab_tap');
      return;
    }
    const isErr = this.data.pipelineHealth === 'warn' || this._needManualRelaunch || this.data.opsControlText === 'ERR';
    if (isErr) {
      this.vibrate('light');
      this.appendHealthLog('recovery_fab_tap_recover', {});
      this.hardRecoverLivePipeline('manual_tap');
      return;
    }
    if (!this.rollingActive && this._livePageVisible && this.data.liveStreamAllowed && this._cameraInitDone && !!this.data.cameraContext && !this.data.showGuide) {
      this.appendHealthLog('recovery_fab_tap_restart_rolling', {});
      this.rollingActive = true;
      this.tryStartRollingWhenCameraReady('recovery_fab_tap_restart');
      return;
    }
    this.appendHealthLog('recovery_fab_tap_ignored', {
      reason: 'not_recording_or_err'
    });
  },
  /**
   * 系统 longpress：ERR 态下触发页内硬恢复。
   * @returns {void}
   */
  onRecoveryFabLongPress: function () {
    if (this.data.isRecovering) return;
    this._recoveryFabLongPressConsumed = true;
    const isErr = this.data.pipelineHealth === 'warn' || this._needManualRelaunch || this.data.opsControlText === 'ERR';
    if (!isErr) return;
    this.vibrate('light');
    this.appendHealthLog('recovery_fab_longpress_recover', {});
    this.hardRecoverLivePipeline('manual_longpress');
  },
  /**
   * 状态灯按下：ERR 态长按约 1.8s 触发页内硬恢复（与单击互为补充）。
   * @returns {void}
   */
  onRecoveryFabTouchStart: function () {
    const isErr = this.data.pipelineHealth === 'warn' || this._needManualRelaunch || this.data.opsControlText === 'ERR';
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
  onRecoveryFabTouchEnd: function () {
    if (this._relaunchPressTimer) {
      clearTimeout(this._relaunchPressTimer);
      this._relaunchPressTimer = null;
    }
  },
  // 节次切换
  onPeriodTap: function () {
    const sport = normalizeSportType(this.data.sportType);
    const mc = this.data.matchConfig || {};
    let next = mc.period;
    if (sport === SPORT_FOOTBALL) {
      return;
    } else if (sport === SPORT_BADMINTON) {
      const maxSets = mc.badmintonState && mc.badmintonState.maxSets || 3;
      next = Math.floor(Number(mc.period) || 1) % maxSets + 1;
    } else {
      const len = this.data.periods.length;
      if (!len) return;
      next = (mc.period + 1) % len;
    }
    this.setData({
      'matchConfig.period': next
    }, () => {
      this.refreshSportUiMeta();
      this.persistConfig();
    });
    this.vibrate('light');
  },
  // 核心记分逻辑
  onScoreTap: function (e) {
    const mc = this.data.matchConfig || {};
    const sport = normalizeSportType(this.data.sportType);
    if (sport === SPORT_BADMINTON && mc.sportConfig && mc.sportConfig.isScoreEnabled === false) {
      return;
    }
    const {
      team,
      type
    } = e.currentTarget.dataset;
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
  applyScoreChange: function (team, type) {
    const sport = normalizeSportType(this.data.sportType);
    if (sport === SPORT_BADMINTON) {
      this.applyBadmintonScoreChange(team, type);
      return;
    }
    let score = this.data.matchConfig[team].score;
    if (type === 'plus') {
      score += 1;
    } else if (type === 'minus') {
      score = Math.max(0, score - 1);
    }
    this.setData({
      [`matchConfig.${team}.score`]: score
    });
  },
  /**
   * 羽毛球小分递增/递减，含发球权轮转与局结束判定。
   * @param {'teamA'|'teamB'} team
   * @param {'plus'|'minus'} type
   * @returns {void}
   */
  applyBadmintonScoreChange: function (team, type) {
    const mc = this.data.matchConfig || {};
    const bs = mc.badmintonState || DEFAULT_BADMINTON_STATE;
    const pointsPerSet = bs.pointsPerSet || 21;
    let scoreA = mc.teamA.currentSetScore || 0;
    let scoreB = mc.teamB.currentSetScore || 0;
    if (team === 'teamA') {
      if (type === 'plus') scoreA += 1;else scoreA = Math.max(0, scoreA - 1);
    } else {
      if (type === 'plus') scoreB += 1;else scoreB = Math.max(0, scoreB - 1);
    }
    let servingTeam = bs.servingTeam || 'A';
    let servingZone = bs.servingZone || 'right';
    if (type === 'plus') {
      servingTeam = team === 'teamA' ? 'A' : 'B';
      const scorerSetScore = team === 'teamA' ? scoreA : scoreB;
      servingZone = scorerSetScore % 2 === 0 ? 'right' : 'left';
    }
    const patch = {
      'matchConfig.teamA.currentSetScore': scoreA,
      'matchConfig.teamB.currentSetScore': scoreB,
      'matchConfig.badmintonState.servingTeam': servingTeam,
      'matchConfig.badmintonState.servingZone': servingZone
    };
    if (type === 'plus') {
      const setWinner = checkBadmintonSetWin(scoreA, scoreB, pointsPerSet);
      if (setWinner) {
        const subA = (mc.teamA.subScores || []).slice();
        const subB = (mc.teamB.subScores || []).slice();
        subA.push(scoreA);
        subB.push(scoreB);
        const setsA = (mc.teamA.score || 0) + (setWinner === 'A' ? 1 : 0);
        const setsB = (mc.teamB.score || 0) + (setWinner === 'B' ? 1 : 0);
        patch['matchConfig.teamA.subScores'] = subA;
        patch['matchConfig.teamB.subScores'] = subB;
        patch['matchConfig.teamA.score'] = setsA;
        patch['matchConfig.teamB.score'] = setsB;
        patch['matchConfig.teamA.currentSetScore'] = 0;
        patch['matchConfig.teamB.currentSetScore'] = 0;
        patch['matchConfig.period'] = Math.max(1, Math.floor(Number(mc.period) || 1)) + 1;
        patch['matchConfig.badmintonState.servingTeam'] = setWinner;
        patch['matchConfig.badmintonState.servingZone'] = 'right';
        this.flashPeriod();
      }
    }
    this.setData(patch, () => {
      this.refreshSportUiMeta();
    });
  },
  /**
   * 手动切换羽毛球发球方（点击发球指示灯）。
   * @returns {void}
   */
  toggleServingTeamManually: function () {
    if (normalizeSportType(this.data.sportType) !== SPORT_BADMINTON) return;
    const mc = this.data.matchConfig || {};
    if (mc.sportConfig && mc.sportConfig.isScoreEnabled === false) return;
    const bs = mc.badmintonState || DEFAULT_BADMINTON_STATE;
    const nextTeam = bs.servingTeam === 'B' ? 'A' : 'B';
    const teamKey = nextTeam === 'A' ? 'teamA' : 'teamB';
    const setScore = this.data.matchConfig[teamKey].currentSetScore || 0;
    this.setData({
      'matchConfig.badmintonState.servingTeam': nextTeam,
      'matchConfig.badmintonState.servingZone': setScore % 2 === 0 ? 'right' : 'left'
    }, () => {
      this.persistConfig();
    });
    this.vibrate('light');
  },
  onBackTap: function () {
    this.closeAllDrawers();
    this.stopRollingRecording();
    wx.navigateBack();
  },
  // 长按连续记分
  onScoreLongPress: function (e) {
    const mc = this.data.matchConfig || {};
    const sport = normalizeSportType(this.data.sportType);
    if (sport === SPORT_BADMINTON && mc.sportConfig && mc.sportConfig.isScoreEnabled === false) {
      return;
    }
    const {
      team,
      type
    } = e.currentTarget.dataset;
    this.vibrate('heavy');
    this.suppressScoreTap = true;
    if (this.data.longPressTimer) {
      clearInterval(this.data.longPressTimer);
    }
    this.applyScoreChange(team, type);
    const timer = setInterval(() => {
      this.applyScoreChange(team, type);
    }, 120);
    this.setData({
      longPressTimer: timer
    });
  },
  // 停止长按
  onScoreTouchEnd: function () {
    if (this.data.longPressTimer) {
      clearInterval(this.data.longPressTimer);
      this.setData({
        longPressTimer: null
      });
      this.persistConfig();
    }
    setTimeout(() => {
      this.suppressScoreTap = false;
    }, 0);
  },
  // 震动反馈
  vibrate: function (type) {
    // 兼容性与稳定性修复：
    // 1. iOS 优先使用 type 参数以获得细腻的触觉反馈。
    // 2. Android 部分机型在传入 type 时可能失效或无响应，故直接调用无参版以确保触发。
    try {
      const sys = wx.getSystemInfoSync();
      if (sys.platform === 'ios') {
        wx.vibrateShort({
          type: type || 'medium'
        });
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
  vibrateHighlightSaved: function () {
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
  getHighlightDir: function () {
    return `${wx.env.USER_DATA_PATH}/highlights`;
  },
  /**
   * 滚动录制缓存目录（用于提高高光保存稳定性）。
   * 注意：这里存的是最近若干段“已落盘”的视频片段，避免 temp 文件被系统回收。
   * @returns {string}
   */
  getRollingDir: function () {
    return `${this.getHighlightDir()}/_rolling`;
  },
  ensureHighlightDir: function () {
    const fs = wx.getFileSystemManager();
    const dirPath = this.getHighlightDir();
    return new Promise(resolve => {
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
  ensureRollingDir: function () {
    const fs = wx.getFileSystemManager();
    const dirPath = this.getRollingDir();
    return new Promise(resolve => {
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
  clearStaleRollingFiles: function () {
    const fs = wx.getFileSystemManager();
    const rollingDir = this.getRollingDir();
    return new Promise(resolve => {
      fs.readdir({
        dirPath: rollingDir,
        success: res => {
          const files = Array.isArray(res && res.files) ? res.files : [];
          if (files.length === 0) {
            resolve();
            return;
          }
          let pending = files.length;
          files.forEach(name => {
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
  /**
   * iOS：将 camera temp 固化到 `_rolling`，避免下一段 startRecord 后系统回收上一段 temp。
   *
   * @param {string} tempPath stopRecord 返回的临时路径
   * @param {number} segNo 片段序号
   * @param {number} recordSessionId 录制会话 id
   * @returns {Promise<string>} 稳定路径；失败时返回空字符串
   */
  persistRollingSegmentFromTemp: function (tempPath, segNo, recordSessionId) {
    if (!tempPath) return Promise.resolve('');
    const fs = wx.getFileSystemManager();
    const rollingDir = this.getRollingDir();
    const destPath = `${rollingDir}/rs${recordSessionId || 0}_s${segNo || 0}_${Date.now()}.mp4`;
    return this.ensureRollingDir().then(() => new Promise(resolve => {
      const useCopyFallback = () => {
        if (!fs.copyFile) {
          resolve('');
          return;
        }
        fs.copyFile({
          srcPath: tempPath,
          destPath: destPath,
          success: () => resolve(destPath),
          fail: () => resolve('')
        });
      };
      if (fs.saveFile) {
        fs.saveFile({
          tempFilePath: tempPath,
          filePath: destPath,
          success: res => {
            resolve(res && res.savedFilePath ? res.savedFilePath : destPath);
          },
          fail: useCopyFallback
        });
        return;
      }
      useCopyFallback();
    }));
  },
  /**
   * 从 rolling 文件名提取排序用时间戳（如 pp_A_17_1782142863236.mp4）。
   * @param {string} name 文件名
   * @returns {number}
   */
  _extractRollingMp4SortKey: function (name) {
    if (!name) return 0;
    const m = String(name).match(/_(\d{10,})\.mp4$/i);
    return m ? Number(m[1]) : 0;
  },
  /**
   * 收集当前应保留的 rolling mp4 路径（ReplayBuffer + 视录分离管线在录/缓冲段）。
   * @returns {Set<string>}
   */
  _collectRollingPathKeepSet: function () {
    const keep = new Set();
    const add = (p) => {
      if (p && typeof p === 'string') keep.add(p);
    };
    (this.segmentBuffer || []).forEach(it => {
      add(it && it.path);
    });
    (this.rollingSegments || []).forEach(seg => {
      add(seg && seg.path);
    });
    const pipeline = this._previewRecordPipeline;
    if (pipeline && typeof pipeline.getActiveDiskPaths === 'function') {
      pipeline.getActiveDiskPaths().forEach((p) => {
        add(p);
      });
    } else if (pipeline && typeof pipeline.getSegments === 'function') {
      pipeline.getSegments().forEach((seg) => {
        add(seg && seg.path);
      });
    }
    return keep;
  },
  /**
   * 删除 `_rolling` 中不在 keepSet 内的 mp4（孤儿文件）。
   * @param {Set<string>} keepSet 应保留的路径集合
   * @param {string} [reason] 诊断用
   * @returns {number} 删除文件数
   */
  _unlinkRollingMp4ExceptKeep: function (keepSet, reason) {
    const fs = wx.getFileSystemManager();
    const rollingDir = this.getRollingDir();
    const keep = keepSet instanceof Set ? keepSet : new Set();
    let removed = 0;
    try {
      if (typeof fs.readdirSync !== 'function') return removed;
      const names = fs.readdirSync(rollingDir) || [];
      names.forEach(name => {
        if (!name || String(name).indexOf('.mp4') < 0) return;
        const full = `${rollingDir}/${name}`;
        if (keep.has(full)) return;
        try {
          fs.unlinkSync(full);
          removed += 1;
        } catch (eUn) {/* ignore */}
      });
    } catch (eRd) {/* ignore */}
    if (removed > 0) {
      this.appendHealthLog('rolling_orphan_file_unlinked', {
        n: removed,
        reason: reason || 'orphan'
      });
    }
    return removed;
  },
  /**
   * 将 `_rolling` 内 mp4 数量压至 maxCount 以下（优先删最旧且不在 keepSet 的文件）。
   * @param {number} maxCount 允许保留的最大文件数
   * @param {Set<string>} keepSet 当前活跃路径，尽量不删
   * @param {string} [reason] 诊断用
   * @returns {number} 删除文件数
   */
  _trimRollingMp4ToMaxCount: function (maxCount, keepSet, reason) {
    const fs = wx.getFileSystemManager();
    const rollingDir = this.getRollingDir();
    const keep = keepSet instanceof Set ? keepSet : new Set();
    const cap = Math.max(2, Math.floor(Number(maxCount) || 6));
    let removed = 0;
    try {
      if (typeof fs.readdirSync !== 'function') return removed;
      const names = (fs.readdirSync(rollingDir) || []).filter(n => n && String(n).indexOf('.mp4') >= 0);
      if (names.length <= cap) return removed;
      const entries = names.map(name => ({
        name,
        full: `${rollingDir}/${name}`,
        ts: this._extractRollingMp4SortKey(name)
      }));
      entries.sort((a, b) => a.ts - b.ts || a.name.localeCompare(b.name));
      let remain = entries.length;
      for (let i = 0; i < entries.length && remain > cap; i += 1) {
        const ent = entries[i];
        if (keep.has(ent.full)) continue;
        try {
          fs.unlinkSync(ent.full);
          removed += 1;
          remain -= 1;
        } catch (eUn) {/* ignore */}
      }
    } catch (eRd) {/* ignore */}
    if (removed > 0) {
      this.appendHealthLog('rolling_dir_trimmed', {
        reason: reason || 'trim',
        removed,
        maxCount: cap
      });
    }
    return removed;
  },
  /**
   * 配额紧张时清理 rolling：删孤儿 + 按数量上限裁最旧文件（保留当前管线活跃段）。
   * @param {string} [reason] 诊断用
   * @param {{ maxCount?: number }} [opts]
   * @returns {number} 合计删除文件数
   */
  pruneRollingMp4ForQuota: function (reason, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const keepSet = this._collectRollingPathKeepSet();
    const why = typeof reason === 'string' ? reason : 'quota';
    const orphanRm = this._unlinkRollingMp4ExceptKeep(keepSet, why + '_orphan');
    const maxCount = Number.isFinite(options.maxCount)
      ? options.maxCount
      : Math.max(6, keepSet.size + 2);
    const trimRm = this._trimRollingMp4ToMaxCount(maxCount, keepSet, why + '_trim');
    const total = orphanRm + trimRm;
    this._lastRollingGcFreedCount = total;
    if (total > 0) {
      this._persistIoFailGcStreak = 0;
    }
    return total;
  },
  /**
   * 清理沙盒内索引外 / rolling 外的 mp4 与过期审计导出，释放 invisible 占用。
   * @param {string} [reason] 诊断用
   * @returns {number} 合计删除文件数
   */
  pruneSandboxOrphanMediaForQuota: function (reason) {
    const why = typeof reason === 'string' ? reason : 'sandbox_orphan';
    const keepSet = this._collectRollingPathKeepSet();
    const result = storageEst.pruneSandboxOrphanMediaSync(keepSet, { reason: why });
    const total = (result && result.removedMp4 ? result.removedMp4 : 0)
      + (result && result.removedAudit ? result.removedAudit : 0);
    if (total > 0) {
      this.appendHealthLog('sandbox_orphan_media_pruned', {
        removedMp4: result.removedMp4 || 0,
        removedAudit: result.removedAudit || 0,
        reason: why
      });
      this._persistIoFailGcStreak = 0;
    }
    return total;
  },
  /**
   * 硬恢复时清空 `_rolling` 下全部 mp4，避免损坏母片在乒乓双轨中继续轮换。
   * @param {string} [reason]
   * @returns {number} 删除文件数
   */
  purgeAllRollingMp4: function (reason) {
    const fs = wx.getFileSystemManager();
    const rollingDir = this.getRollingDir();
    let removed = 0;
    try {
      if (typeof fs.readdirSync !== 'function') return removed;
      const names = fs.readdirSync(rollingDir) || [];
      names.forEach(name => {
        if (!name || String(name).indexOf('.mp4') < 0) return;
        const full = `${rollingDir}/${name}`;
        try {
          fs.unlinkSync(full);
          removed += 1;
        } catch (eUn) {/* ignore */}
      });
    } catch (eRd) {/* ignore */}
    if (removed > 0) {
      this.appendHealthLog('rolling_dir_purged', {
        reason: reason || 'purge',
        removed
      });
    }
    return removed;
  },
  pruneRollingDirOrphans: function () {
    const rollingDir = this.getRollingDir();
    const keep = this._collectRollingPathKeepSet();
    try {
      const fs = wx.getFileSystemManager();
      if (typeof fs.readdirSync !== 'function') return;
      const names = fs.readdirSync(rollingDir) || [];
      names.forEach(name => {
        if (!name || String(name).indexOf('.mp4') < 0) return;
        const full = `${rollingDir}/${name}`;
        if (keep.has(full)) return;
        try {
          fs.unlinkSync(full);
        } catch (eUn) {}
      });
    } catch (eRd) {}
  },
  startRollingRecording: function (source) {
    return this._startRollingRecordingImpl(source);
  },
  /**
   * 确保视录分离管线实例存在（onShow kickoff 的 stopRolling 在未起录时不得丢弃实例）。
   * @returns {Object}
   */
  _ensurePreviewRecordPipeline: function () {
    if (!this._previewRecordPipeline) {
      this._previewRecordPipeline = replayBufferMod.createPreviewRecordPipeline(this);
    }
    return this._previewRecordPipeline;
  },
  /**
   * 视录分离：启动 onCameraFrame + 双轨 MediaRecorder 乒乓缓冲（永不 startRecord）。
   * @param {string} [source]
   * @returns {void}
   */
  _startRollingRecordingImpl: function (source) {
    this._ensurePreviewRecordPipeline();
    if (!this.rollingActive || !this._cameraInitDone) return;
    if (!this.data.cameraContext) return;
    if (this._previewRecordPipeline.isActive()) return;
    if (this._previewRecordStartInFlight) return;
    this._previewRecordStartInFlight = true;
    const self = this;
    const retireWait = this._previewRecordRetirePromise || Promise.resolve();
    retireWait.then(() => {
      if (!self.rollingActive) return Promise.resolve();
      const afterPageHide = self.isLiveForegroundRecordingRecoverPending();
      const afterHardRecoverTimeout = !!self._hardRecoverHadTimeoutRebuild;
      const settleMs = afterPageHide ? 1500 : 0;
      if (settleMs > 0) {
        return new Promise((resolve) => setTimeout(resolve, settleMs));
      }
      return Promise.resolve();
    }).then(() => self.ensureRollingDir()).then(() => {
      if (!self.rollingActive) return;
      const afterPageHide = self.isLiveForegroundRecordingRecoverPending();
      const afterHardRecoverTimeout = !!self._hardRecoverHadTimeoutRebuild;
      let warmupMinFrames = PREVIEW_RECORD_WARMUP_FRAMES_DEFAULT;
      if (afterHardRecoverTimeout) {
        warmupMinFrames = PREVIEW_RECORD_WARMUP_FRAMES_AFTER_HARD_RECOVER_TIMEOUT;
      } else if (afterPageHide) {
        warmupMinFrames = PREVIEW_RECORD_WARMUP_FRAMES_AFTER_PAGE_HIDE;
      }
      let firstFrameTimeoutMs = afterPageHide || afterHardRecoverTimeout
        ? 5500
        : PREVIEW_RECORD_FIRST_FRAME_TIMEOUT_MS;
      if (!isLiveHostIos() && !afterPageHide && !afterHardRecoverTimeout) {
        firstFrameTimeoutMs = PREVIEW_RECORD_FIRST_FRAME_TIMEOUT_ANDROID_MS;
      }
      return self._previewRecordPipeline.start({
        cameraContext: self.data.cameraContext,
        chunkDurationMs: self.pingPongChunkDurationMs || 180000,
        staggerMs: self.pingPongStaggerMs || 8000,
        highlightFlushMinIntervalMs: self.pingPongHighlightFlushMinIntervalMs || 10000,
        recycleIntervalMs: 25 * 60 * 1000,
        fps: self.pingPongRecordFps || 15,
        canvasWidth: self.pingPongRecordCanvasWidth || 1280,
        canvasHeight: self.pingPongRecordCanvasHeight || 720,
        videoBitsPerSecondKbps: self.pingPongVideoBitsPerSecondKbps || 0,
        maxFiles: self.pingPongRollingMaxFiles || 2,
        requireFirstFrame: true,
        firstFrameTimeoutMs,
        warmupMinFrames,
        deferEncoderInit: true,
        encoderLiveWarmupFrames: afterPageHide ? 48 : 0,
        probeChunkDurationMs: afterPageHide ? POST_RE_MOUNT_PROBE_CHUNK_MS : 0
      });
    }).then(() => {
      self._previewRecordStartInFlight = false;
      if (!self.rollingActive || !self._previewRecordPipeline.isActive()) return;
      if (self.isLiveForegroundRecordingRecoverPending()) {
        self._lastSuccessfulChunkAt = 0;
      }
      self._previewRecordWarmupUntil = 0;
      if (self._rollingKickoffWatchdogTimer) {
        clearTimeout(self._rollingKickoffWatchdogTimer);
        self._rollingKickoffWatchdogTimer = null;
      }
      self.appendHealthLog('preview_record_started', {
        source: source || 'startRollingRecording'
      });
      self.lastSegmentAt = Date.now();
      self.lastRecordStartAt = Date.now();
      self.setData({
        isRecording: true
      });
      self.updatePipelineHealth();
      self._armFramePulseMonitor();
      if (self.isLiveForegroundRecordingRecoverPending()) {
        self._armPostRemountEncodingProbe();
      }
    }).catch(err => {
      self._previewRecordStartInFlight = false;
      const errMsg = String(err && err.message || err);
      self.appendHealthLog('preview_record_start_fail', {
        source: source || 'startRollingRecording',
        err: errMsg
      });
      if (errMsg.indexOf('first frame timeout') >= 0 && self.rollingActive && self._livePageVisible) {
        self._previewRecordWarmupUntil = Date.now() + Math.min(2400, self.getPreviewRecordWarmupMs() + 600);
        setTimeout(() => {
          self.tryStartRollingWhenCameraReady((source || 'startRollingRecording') + '_frame_retry');
        }, 900);
      }
    });
  },
  startOneSegment: function () {

    /** @deprecated 视录分离架构下由乒乓调度器管理分段，保留空实现兼容旧调用。 */},
  _startOneSegmentImpl: function (sessionId, retryCount = 0) {
    // 页面不可见时禁止调起相机，杜绝切后台后的 startRecord fail storm
    if (!this._livePageVisible) return;
    if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
    if (!this.data.cameraContext) return;
    if (this.data.storageSevereLock) {
      try {
        this.appendHealthLog('segment_start_skipped_storage_severe', {
          retryCount
        });
      } catch (eL) {}
      return;
    }
    if (this._needManualRelaunch) return;
    if (this._startOneSegmentInFlight) return;
    this._startOneSegmentInFlight = true;
    const effectiveSegMs = this.getEffectiveSegmentDurationMs ? this.getEffectiveSegmentDurationMs() : this.segmentDurationMs || 8000;
    this.data.cameraContext.startRecord({
      timeout: Math.max(12, Math.ceil(effectiveSegMs / 1000) + 2),
      success: () => {
        this._startOneSegmentInFlight = false;
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        if (this._recorderCore) {
          this._recorderCore.onSegmentStartSuccess('segment_start_ok', sessionId);
        }
        this.clearSegmentStartRetryTimer();
        this._segmentStartRecoveringFromIsRecording = false;
        this._segmentStartRecoveringFromOperateFail = false;
        const hadFailBefore = this.startRecordFailStreak > 0;
        this.startRecordFailStreak = 0;
        this.segmentStartFailStormCycles = 0;
        this._currentRollingSegmentRecordStartMs = Date.now();
        this.lastRecordStartAt = Date.now();
        const nextRec = {
          isRecording: true
        };
        if (this.data.aeContext === 'pre' && this.data.aeControlsVisible) {
          nextRec.aeControlsVisible = false;
          nextRec.aeContext = '';
          nextRec.aeShowDoubleTapHint = false;
        }
        this.setData(nextRec);
        if (this._highlightSaveAwaitingResume && this._highlightSaveSessionId === sessionId) {
          this._highlightPipelineDoneResume = true;
          this.maybeReleaseHighlightSaveLock();
        }
        if (hadFailBefore) {
          this.appendHealthLog('segment_start_ok_recovered', {
            retryCount
          });
        }
        if (retryCount > 0) {
          this.appendHealthLog('segment_start_ok_after_retry', {
            retryCount
          });
        }
        if (this.segmentStopTimer) clearTimeout(this.segmentStopTimer);
        this.segmentStopTimer = setTimeout(() => {
          this.stopOneSegment(sessionId);
        }, effectiveSegMs);
        if (effectiveSegMs > (this.segmentDurationMs || 8000)) {
          this.appendHealthLog('rolling_segment_duration_tier', {
            segNo: this.segmentCounter + 1,
            effectiveSegMs: effectiveSegMs,
            baseSegMs: this.segmentDurationMs || 8000
          });
        }
      },
      fail: err => {
        this._startOneSegmentInFlight = false;
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        if (this._recorderCore) {
          this._recorderCore.onSegmentStartFail('segment_start_fail');
        }
        this.startRecordFailStreak += 1;
        const errMsg = err && err.errMsg ? String(err.errMsg) : '';
        /** 全量 diag 仅在连续失败时附带，避免健康缓冲被长直播刷屏撑满 */
        const logDetail = {
          retryCount,
          failStreak: this.startRecordFailStreak,
          errMsg: errMsg || '(empty)'
        };
        if (this.startRecordFailStreak >= 2) {
          logDetail.diag = this.getLiveRollingDiagSnapshot({});
        }
        this.appendHealthLog('segment_start_fail', logDetail);
        const lowerErr = errMsg.toLowerCase();
        const isRecordingConflict = lowerErr.indexOf('is recording') >= 0;
        if (isRecordingConflict) {
          this.appendHealthLog('segment_start_realign_is_recording_conflict', {
            retryCount,
            failStreak: this.startRecordFailStreak
          });
          /**
           * 关键修复：is recording 冲突在部分安卓机（如小米）常由 Native 状态滞后引发，
           * 继续硬恢复会放大“重启风暴”。这里改为长冷却重试，不再直接硬恢复。
           */
          if (this.startRecordFailStreak >= 10) {
            this.clearSegmentStartRetryTimer();
            this._segmentStartRecoveringFromIsRecording = false;
            this.appendHealthLog('segment_start_is_recording_conflict_cooldown', {
              streak: this.startRecordFailStreak
            });
            this.startRecordFailStreak = 0;
            const retryLater = () => {
              this.scheduleStartOneSegmentRetry(sessionId, 0, 4600);
            };
            try {
              this.data.cameraContext.stopRecord({
                complete: retryLater,
                fail: retryLater
              });
            } catch (eStopRec) {
              retryLater();
            }
            return;
          }
          this._segmentStartRecoveringFromIsRecording = true;
          const restartAfterStop = () => {
            this.setData({
              isRecording: false
            });
            this.lastRecordStartAt = 0;
            const extraAlign = this.getIsRecordingConflictExtraStartDelayMs();
            this.scheduleAfterForcedStopReady('is_recording_conflict_stop', () => {
              this._segmentStartRecoveringFromIsRecording = false;
              if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
              if (extraAlign > 0) {
                setTimeout(() => {
                  if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
                  this.startOneSegment(sessionId, 0, 'is_recording_conflict_retry');
                }, extraAlign);
              } else {
                this.startOneSegment(sessionId, 0, 'is_recording_conflict_retry');
              }
            });
          };
          try {
            this.data.cameraContext.stopRecord({
              complete: restartAfterStop,
              fail: restartAfterStop
            });
          } catch (eStopRec) {
            restartAfterStop();
          }
          return;
        }
        const isOperateFail = lowerErr.indexOf('operate fail') >= 0;
        if (isOperateFail) {
          this._lastSegmentOperateFailAt = Date.now();
          if (this._segmentStartRecoveringFromOperateFail) {
            this.scheduleStartOneSegmentRetry(sessionId, 0, 520);
            return;
          }
          this._segmentStartRecoveringFromOperateFail = true;
          this.appendHealthLog('segment_start_realign_operate_fail', {
            retryCount,
            failStreak: this.startRecordFailStreak
          });
          const restartAfterStop = () => {
            this.setData({
              isRecording: false
            });
            this.lastRecordStartAt = 0;
            this.scheduleAfterForcedStopReady('operate_fail_stop', () => {
              this._segmentStartRecoveringFromOperateFail = false;
              if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
              if (this._needManualRelaunch) return;
              this.startOneSegment(sessionId, 0, 'operate_fail_retry');
            });
          };
          try {
            this.data.cameraContext.stopRecord({
              complete: restartAfterStop
            });
          } catch (eStopRec) {
            restartAfterStop();
          }
          if (this.startRecordFailStreak >= 5) {
            this.appendHealthLog('segment_start_operate_fail_auto_recover', {
              retryCount,
              failStreak: this.startRecordFailStreak
            });
            this.triggerCameraFaultRecovery('start:operate_fail');
          }
          return;
        }
        // 关键修复：不能在少量失败后停止，否则 segmentCounter 会冻结，后续高光重复。
        const nextRetry = retryCount + 1;
        let platformSegPad = 0;
        let isIosFail = false;
        try {
          const si = wx.getSystemInfoSync();
          const n = typeof this.segmentCounter === 'number' ? this.segmentCounter : 0;
          if (si && si.platform === 'android') {
            platformSegPad = Math.min(380, Math.floor(n / 16) * 30);
          } else if (si && si.platform === 'ios') {
            isIosFail = true;
            /** iOS startRecord 失败后略拉长退避，避免与文件落盘叠峰 */
            platformSegPad = Math.min(380, Math.floor(n / 10) * 32);
          }
        } catch (ePad) {
          platformSegPad = 0;
        }
        const baseBackoff = isIosFail ? 300 : 220;
        const perStep = isIosFail ? 175 : 140;
        const delay = Math.min(2200, baseBackoff + nextRetry * perStep + platformSegPad);
        if (this.startRecordFailStreak >= 5) {
          this.segmentStartFailStormCycles = (this.segmentStartFailStormCycles || 0) + 1;
          this.appendHealthLog('segment_start_fail_storm_cycle', {
            cycles: this.segmentStartFailStormCycles,
            lastErrMsg: errMsg || '(empty)',
            diag: this.getLiveRollingDiagSnapshot({})
          });
          /** 易与回放恢复、磁盘抖动叠加误报，略提高阈值；真正死锁仍由 ERR + 手动恢复覆盖 */
          if (this.segmentStartFailStormCycles >= 4) {
            this.segmentStartFailStormCycles = 0;
            this.markNeedManualRelaunch('segment_start_fail_storm');
            this.startRecordFailStreak = 0;
            this.setData({
              isRecording: false
            });
            this.lastRecordStartAt = 0;
            return;
          }
          this.startRecordFailStreak = 0;
          this.setData({
            isRecording: false
          });
          this.lastRecordStartAt = 0;
          this.scheduleAfterForcedStopReady('start_fail_storm_reset', () => this.startOneSegment(sessionId, 0, 'start_fail_storm_retry'));
          return;
        }
        this.scheduleStartOneSegmentRetry(sessionId, nextRetry, delay);
      }
    });
  },
  stopOneSegment: function (sessionId, source) {
    if (this._recorderCore) {
      return this._recorderCore.requestStopSegment(source || 'stopOneSegment', sessionId);
    }
    return this._stopOneSegmentImpl(sessionId);
  },
  _stopOneSegmentImpl: function (sessionId) {
    if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
    if (!this.data.cameraContext || !this.data.isRecording) return;
    this.data.cameraContext.stopRecord({
      success: res => {
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        this.setData({
          isRecording: false
        });
        this.lastRecordStartAt = 0;
        const tempPath = res && res.tempVideoPath ? res.tempVideoPath : '';
        const recordStartWallMs = this._currentRollingSegmentRecordStartMs || 0;
        /** 在 copy 完成前就刷新心跳，避免仅依赖 finalize 时写盘慢导致看门狗误判空闲 */
        this.lastSegmentAt = Date.now();
        this.segmentCounter += 1;
        let persistPromise = Promise.resolve();
        const stopCompletedAt = Date.now();
        if (tempPath) {
          /**
           * Android：落盘与下一段并行（temp 相对稳定）。
           * iOS：须先 wait + saveFile 到 `_rolling`（见 onSegmentRecorded），再 schedule 下一段。
           */
          persistPromise = this.onSegmentRecorded(tempPath, this.segmentCounter, sessionId, recordStartWallMs);
        } else {
          this.abortHighlightAfterStopIfNeeded(sessionId, 'empty_temp_path');
        }
        const kickNextSegment = () => {
          if (this._recorderCore) {
            this._recorderCore.noteFlushLag(Date.now() - stopCompletedAt);
          }
          if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
          if (this.data.storageSevereLock) {
            try {
              this.appendHealthLog('next_segment_suppressed_storage_severe', {
                reason: tempPath ? 'storage_severe' : 'empty_temp'
              });
            } catch (eN) {}
            return;
          }
          this.scheduleAfterStopRecord(() => this.startOneSegment(sessionId, 0, 'segment_flush_ready'));
        };
        if (this._recorderCore) {
          this._recorderCore.onSegmentStopSuccess('segment_stop_ok', persistPromise, kickNextSegment);
        } else {
          Promise.resolve(persistPromise).finally(kickNextSegment);
        }
      },
      fail: err => {
        if (!this.rollingActive || sessionId !== this.rollingSessionId) return;
        const errMsg = err && err.errMsg ? String(err.errMsg) : '';
        this.appendHealthLog('stop_record_fail', {
          errMsg: errMsg || '(empty)',
          diag: this.getLiveRollingDiagSnapshot({})
        });
        this.setData({
          isRecording: false
        });
        this.lastRecordStartAt = 0;
        this.abortHighlightAfterStopIfNeeded(sessionId, 'stop_record_fail');
        if (this.data.storageSevereLock) {
          try {
            this.appendHealthLog('next_segment_suppressed_storage_severe', {
              reason: 'stop_fail'
            });
          } catch (eF) {}
          return;
        }
        if (this._recorderCore) {
          this._recorderCore.onSegmentStopSuccess('segment_stop_fail_fallback', Promise.resolve(), () => this.scheduleAfterStopRecord(() => this.startOneSegment(sessionId, 0, 'segment_stop_fail_ready')));
          return;
        }
        this.scheduleAfterStopRecord(() => this.startOneSegment(sessionId));
      }
    });
  },
  /**
   * 停止滚动分段录制并清理定时器。
   * @param {function(): void} [onStopped] 在录制状态已释放后调用（无录制时下一 tick 调用）
   * @returns {void}
   */
  stopRollingRecording: function (onStopped, source) {
    return this._stopRollingRecordingImpl(onStopped, source);
  },
  /**
   * 停止视录分离乒乓管线（不调用 camera stopRecord）。
   * @param {function(): void} [onStopped]
   * @param {string} [source]
   * @returns {void}
   */
  _stopRollingRecordingImpl: function (onStopped, source) {
    this.clearSegmentStartRetryTimer();
    if (this.rollingWatchdogTimer) {
      clearInterval(this.rollingWatchdogTimer);
      this.rollingWatchdogTimer = null;
    }
    if (this.segmentStopTimer) {
      clearTimeout(this.segmentStopTimer);
      this.segmentStopTimer = null;
    }
    let finishOnce = false;
    const finish = () => {
      if (finishOnce) return;
      finishOnce = true;
      this.lastRecordStartAt = 0;
      /**
       * setData 回调与 120ms 兜底超时会重复调用 runStopped，必须 dedupe，
       * 否则 onStopped 二次回调会让 watchdog kick / rollingSessionId += 1 多执行一次。
       */
      let stoppedOnce = false;
      const runStopped = () => {
        if (stoppedOnce) return;
        stoppedOnce = true;
        if (typeof onStopped !== 'function') return;
        if (wx.nextTick) wx.nextTick(onStopped);else setTimeout(onStopped, 0);
      };
      if (this.data.isRecording) {
        this.setData({
          isRecording: false
        }, runStopped);
        setTimeout(runStopped, 120);
      } else {
        runStopped();
      }
    };
    const pipeline = this._previewRecordPipeline;
    if (!pipeline || !pipeline.isActive()) {
      finish();
      return;
    }
    const retirePromise = pipeline.stop().then(() => {
      this.appendHealthLog('preview_record_stopped', {
        source: source || 'stopRollingRecording'
      });
    }).catch(() => {}).finally(() => {
      this._previewRecordPipeline = null;
    });
    this._previewRecordRetirePromise = retirePromise;
    retirePromise.finally(() => finish());
  },
  /**
   * @deprecated 视录分离架构下片段由乒乓调度器落盘。
   */
  onSegmentRecorded: function () {
    return Promise.resolve();
  },
  /**
   * @deprecated 保留占位，避免旧 health/recover 路径引用报错。
   */
  _onSegmentRecordedLegacy: function (tempPath, segNo, recordSessionId, recordStartWallMs) {
    const sessionMatch = recordSessionId === this.rollingSessionId || typeof recordSessionId === 'number' && recordSessionId > 0 && recordSessionId === this.rollingSessionId - 1;
    if (!sessionMatch) {
      return Promise.resolve();
    }
    const recordStart = typeof recordStartWallMs === 'number' && recordStartWallMs > 0 ? recordStartWallMs : Date.now();
    if (!tempPath) {
      this.abortHighlightAfterStopIfNeeded(recordSessionId, 'empty_temp_path');
      return Promise.resolve();
    }
    const indexSegmentPath = stablePath => {
      const segment = {
        path: stablePath || '',
        startTime: recordStart,
        endTime: Date.now(),
        sessionId: recordSessionId,
        segNo: segNo,
        source: 'camera'
      };
      if (!segment.path) {
        this.abortHighlightAfterStopIfNeeded(recordSessionId, 'empty_temp_path');
        return Promise.resolve();
      }
      const currentChunks = this._replayBuffer && typeof this._replayBuffer.getChunks === 'function' ? this._replayBuffer.getChunks() : Array.isArray(this.rollingSegments) ? this.rollingSegments : [];
      const prev = currentChunks.length ? currentChunks[currentChunks.length - 1] : null;
      if (prev && typeof prev.endTime === 'number' && segment.startTime > prev.endTime + 240) {
        const gapMs = segment.startTime - prev.endTime;
        if (this._recorderCore) {
          this._recorderCore.noteTimelineGap('segment_recorded', gapMs);
        }
        if (gapMs > 60000) {
          this._clearStaleReplayBufferForTimelineGap(gapMs);
        }
      }
      const chunkMeta = Object.assign({}, segment, {
        fileReadyWaitMs: isLiveHostIos() ? 0 : 1200
      });
      const addPromise = this._replayBuffer && typeof this._replayBuffer.addChunk === 'function' ? this._replayBuffer.addChunk(chunkMeta) : Promise.resolve(Object.assign({}, segment, {
        ready: true,
        refCount: 0
      }));
      return Promise.resolve(addPromise).then(chunk => {
        if (!chunk) {
          this._rollingTempMissingStreak = (this._rollingTempMissingStreak || 0) + 1;
          this._rollingTempTerminalFailStreak = (this._rollingTempTerminalFailStreak || 0) + 1;
          this.maybeHardRecoverForTempMissingStorm(this._rollingTempTerminalFailStreak, segNo);
          this.abortHighlightAfterStopIfNeeded(recordSessionId, 'segment_not_ready');
          return;
        }
        const chunks = this._replayBuffer && typeof this._replayBuffer.getChunks === 'function' ? this._replayBuffer.getChunks() : [chunk];
        this.rollingSegments = chunks;
        while (!this._replayBuffer && this.rollingSegments.length > (this.rollingBufferMax || 15)) {
          this.rollingSegments.shift();
        }
        this.segmentBuffer = this.rollingSegments;
        this._rollingTempMissingStreak = 0;
        this._rollingTempTerminalFailStreak = 0;
        this._tempMissingHardRecoverCycles = 0;
        this._lastSuccessfulChunkAt = Date.now();
        this.segmentPersistFailStreak = 0;
        this.appendHealthLog('rolling_segment_indexed_by_time', {
          segNo,
          startTime: chunk.startTime,
          endTime: chunk.endTime,
          durationMs: chunk.endTime - chunk.startTime,
          sizeBytes: chunk.sizeBytes || 0,
          bufferSize: this.rollingSegments.length
        });
        if (isLiveHostIos()) {
          this.pruneRollingDirOrphans();
        }
        this._tryGenerateHighlight();
      });
    };
    if (!isLiveHostIos()) {
      return indexSegmentPath(tempPath);
    }
    this._rollingPersistInFlight = (this._rollingPersistInFlight || 0) + 1;
    this.rollingFsBusy = true;
    const fsReadyMod = replayBufferMod.fsReady || null;
    const waitReady = fsReadyMod && typeof fsReadyMod.waitForFileReady === 'function' ? fsReadyMod.waitForFileReady(tempPath, {
      minBytes: fsReadyMod.DEFAULT_MIN_BYTES || 1024,
      maxWaitMs: 3200,
      pollMs: 100
    }) : Promise.resolve({
      ready: true,
      size: 0,
      reason: 'ok'
    });
    return waitReady.then(readyInfo => {
      if (!readyInfo || !readyInfo.ready) {
        return '';
      }
      return this.persistRollingSegmentFromTemp(tempPath, segNo, recordSessionId);
    }).then(stablePath => {
      this._rollingPersistInFlight = Math.max(0, (this._rollingPersistInFlight || 0) - 1);
      this.rollingFsBusy = this._rollingPersistInFlight > 0;
      return indexSegmentPath(stablePath);
    }).catch(() => {
      this._rollingPersistInFlight = Math.max(0, (this._rollingPersistInFlight || 0) - 1);
      this.rollingFsBusy = this._rollingPersistInFlight > 0;
      return indexSegmentPath('');
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
  recoverRollingPipelineForHighlight: function (onDone, busyRetries) {
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
    if (wx.nextTick) wx.nextTick(kick);else setTimeout(kick, 0);
  },
  /**
   * temp 文件在 stopRecord 后连续出现“终态丢失”时的处理。
   *
   * 默认仍以“观察 + 放行下一段”为主，避免把偶发 temp 抖动放大成恢复风暴。
   * 但若它与最近的 startRecord operate fail 成簇出现，说明已不只是单纯落盘慢，
   * 更可能是 native camera/record 会话退化，此时升级到受控 hard recover。
   *
   * 这样既保留了对偶发 temp 丢失的容忍，也能在真故障时尽快自愈，减少黑屏/空录持续时间。
   *
   * @param {number} streak 当前连续失败次数
   * @param {number} segNo 触发时片段号
   * @returns {void}
   */
  maybeHardRecoverForTempMissingStorm: function (streak, segNo) {
    const n = Number(streak || 0);
    if (n < 2) return;
    const now = Date.now();
    const operateFailAgoMs = this._lastSegmentOperateFailAt > 0 ? now - this._lastSegmentOperateFailAt : -1;
    this.appendHealthLog('temp_missing_storm_observed', {
      streak: n,
      segNo,
      operateFailAgoMs: operateFailAgoMs
    });
    if ((this._tempMissingHardRecoverCycles || 0) >= 4) {
      this.markNeedManualRelaunch('temp_missing_storm_exhausted');
      return;
    }
    const recentOperateFail = this._lastSegmentOperateFailAt > 0 && operateFailAgoMs >= 0 && operateFailAgoMs <= 15000;
    const streakAloneTrigger = n >= 3;
    const longSession = (this.segmentCounter || 0) >= 120;
    const minRecoverGapMs = longSession ? 45000 : 18000;
    const shouldHardRecover = (recentOperateFail || streakAloneTrigger) && this.data.enhanceMode !== 'vk' && now - (this._lastTempMissingStormRecoverAt || 0) >= minRecoverGapMs && this._livePageVisible && !this.data.isRecovering && !this._recoveryLock;
    if (shouldHardRecover) {
      this._lastTempMissingStormRecoverAt = now;
      this.appendHealthLog('temp_missing_storm_hard_recover', {
        streak: n,
        segNo,
        operateFailAgoMs: operateFailAgoMs,
        trigger: streakAloneTrigger ? 'streak_alone' : 'operate_fail_cluster'
      });
      this.hardRecoverLivePipeline(streakAloneTrigger ? 'auto:temp_missing_storm' : 'auto:temp_missing_storm_operate_fail');
      this._rollingTempTerminalFailStreak = 0;
      this._rollingTempMissingStreak = 0;
    }
  },
  /**
   * 时间轴出现大缺口时清空 ReplayBuffer，避免旧场次/旧会话 chunk 误导高光匹配。
   * @param {number} gapMs 与上一有效 chunk 的间隔（毫秒）
   * @returns {void}
   */
  _clearStaleReplayBufferForTimelineGap: function (gapMs) {
    if (this._replayBuffer && typeof this._replayBuffer.clear === 'function') {
      this._replayBuffer.clear();
    }
    this.rollingSegments = [];
    this.segmentBuffer = [];
    this.appendHealthLog('replay_buffer_cleared_timeline_gap', {
      gapMs: typeof gapMs === 'number' ? gapMs : 0
    });
  },
  /**
   * 场次切换后延迟合并重启滚动录制（防抖连点切换）。
   * @param {string} [source]
   * @returns {void}
   */
  _scheduleRollingRestartAfterMatchSwitch: function (source) {
    if (this._matchSwitchRestartTimer) {
      clearTimeout(this._matchSwitchRestartTimer);
      this._matchSwitchRestartTimer = null;
    }
    const sessionId = this.rollingSessionId;
    const triggerSource = source || 'match_switch';
    const self = this;
    this._matchSwitchRestartTimer = setTimeout(() => {
      self._matchSwitchRestartTimer = null;
      self._restartRollingAfterMatchSwitchImpl(triggerSource, sessionId);
    }, MATCH_SWITCH_RESTART_DEFER_MS);
  },
  /**
   * 场次切换专用：重启 preview 乒乓管线，保持 rollingActive，不二次 bump rollingSessionId。
   * @param {string} [source]
   * @param {number} expectedSessionId
   * @returns {void}
   */
  _restartRollingAfterMatchSwitchImpl: function (source, expectedSessionId) {
    if (!this._livePageVisible || !this.data.liveStreamAllowed) return;
    if (this.data.showGuide) return;
    if (this.data.isRecovering || this._recoveryLock) return;
    if (this._needManualRelaunch || this.data.storageSevereLock) return;
    if (expectedSessionId !== this.rollingSessionId) return;
    if (!this._cameraInitDone || !this.data.cameraContext) {
      this.appendHealthLog('match_switch_restart_deferred_camera', {
        source: source || 'match_switch',
        cameraInitDone: !!this._cameraInitDone
      });
      this._rollingStartPendingBeforeKickoff = true;
      return;
    }
    this._segmentWatchdogRecovering = false;
    this.rollingActive = true;
    this.lastSegmentAt = Date.now();
    this.lastRecordStartAt = 0;
    this._lastSuccessfulChunkAt = 0;
    this._previewRecordLastHeartbeatAt = 0;
    const triggerSource = source || 'match_switch_restart';
    const kickStart = () => {
      if (!this._livePageVisible || expectedSessionId !== this.rollingSessionId) return;
      if (!this.rollingActive) return;
      if (this._matchSwitchRestartFailsafeTimer) {
        clearTimeout(this._matchSwitchRestartFailsafeTimer);
        this._matchSwitchRestartFailsafeTimer = null;
      }
      this.appendHealthLog('match_switch_restart_kick', {
        source: triggerSource,
        rollingSessionId: this.rollingSessionId
      });
      this._matchSwitchHighlightWarmupUntil = Date.now() + MATCH_SWITCH_HIGHLIGHT_WARMUP_MS;
      if (this._recorderCore) {
        this._recorderCore.markReady(triggerSource);
      }
      this.tryStartRollingWhenCameraReady(triggerSource);
    };
    const pipeline = this._previewRecordPipeline;
    if (!pipeline || !pipeline.isActive()) {
      kickStart();
      return;
    }
    let kicked = false;
    const runKickOnce = via => {
      if (kicked) return;
      kicked = true;
      if (this._matchSwitchRestartFailsafeTimer) {
        clearTimeout(this._matchSwitchRestartFailsafeTimer);
        this._matchSwitchRestartFailsafeTimer = null;
      }
      if (via) {
        this.appendHealthLog('match_switch_restart_after_stop', {
          source: triggerSource,
          via
        });
      }
      kickStart();
    };
    this._matchSwitchRestartFailsafeTimer = setTimeout(() => {
      this._matchSwitchRestartFailsafeTimer = null;
      this.appendHealthLog('match_switch_restart_failsafe', {
        source: triggerSource
      });
      runKickOnce('failsafe');
    }, MATCH_SWITCH_PIPELINE_STOP_FAILSAFE_MS);
    pipeline.stop().then(() => runKickOnce('pipeline_stop')).catch(() => runKickOnce('pipeline_stop_fail'));
  },
  /**
   * 切换场次时隔离 rolling 缓冲与会话，避免上一场素材污染新高光时间窗。
   * @param {string} [source] 触发来源
   * @returns {void}
   */
  _resetRollingPipelineForMatchSwitch: function (source) {
    if (this.data.isSavingHighlight) {
      this.appendHealthLog('match_switch_deferred_for_highlight', {
        source: source || 'switch_match'
      });
      setTimeout(() => {
        this._resetRollingPipelineForMatchSwitch(source);
      }, 500);
      return;
    }
    const prevSessionId = this.rollingSessionId;
    const prevSegmentCounter = this.segmentCounter || 0;
    this.rollingSessionId += 1;
    this._rollingTempMissingStreak = 0;
    this._rollingTempTerminalFailStreak = 0;
    this._lastSuccessfulChunkAt = 0;
    /**
     * 切场次时一并清零监控字段，避免 prev session 的 lastSegmentAt / heartbeat
     * 让 watchdog 的 segmentGap 计算出现"刚切换就异常老化"假象，
     * 也避免 prev session segmentCounter 残留误导后续诊断/UI。
     */
    this.segmentCounter = 0;
    this.lastSegmentAt = 0;
    this._previewRecordLastHeartbeatAt = 0;
    if (this._replayBuffer && typeof this._replayBuffer.clear === 'function') {
      this._replayBuffer.clear();
    }
    this.rollingSegments = [];
    this.segmentBuffer = [];
    if (this.pendingHighlight) {
      if (this._recorderCore) {
        this._recorderCore.clearPendingHighlight();
      } else {
        this.pendingHighlight = null;
      }
      this.endHighlightSaving();
    }
    this.appendHealthLog('match_switch_rolling_reset', {
      source: source || 'switch_match',
      prevSessionId,
      rollingSessionId: this.rollingSessionId,
      rollingActive: !!this.rollingActive,
      prevSegmentCounter,
      segmentCounter: this.segmentCounter || 0
    });
    /**
     * 切场次后须重启 preview 管线并绑定新 sessionId。
     * 勿走 segment_watchdog_soft_recover：会把 rollingActive 置 false 且二次 bump sessionId，
     * pipeline.stop 偶发不回调时会导致新场次永久 PAUSE。
     */
    if (this._livePageVisible && this.data.liveStreamAllowed && !this.data.isRecovering && !this._recoveryLock) {
      this.rollingActive = true;
      this._scheduleRollingRestartAfterMatchSwitch(source);
    }
  },
  /**
   * MOD: temp rolling 不再主动删除文件，引用锁保留为空实现以兼容固化流程。
   * @param {string[]} paths
   * @returns {void}
   */
  retainRollingSegmentsByPaths: function (paths) {
    const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
    if (this._previewRecordPipeline && typeof this._previewRecordPipeline.pinPaths === 'function') {
      this._previewRecordPipeline.pinPaths(list);
    }
    if (this._replayBuffer && typeof this._replayBuffer.retainByPaths === 'function') {
      this._replayBuffer.retainByPaths(list);
      this.rollingSegments = this._replayBuffer.getChunks();
      this.segmentBuffer = this.rollingSegments;
    }
    return;
  },
  /**
   * MOD: temp rolling 不再主动删除文件，释放引用锁保留为空实现以兼容固化流程。
   * @param {string[]} paths
   * @returns {void}
   */
  releaseRollingSegmentsByPaths: function (paths) {
    if (this._replayBuffer && typeof this._replayBuffer.releaseByPaths === 'function') {
      this._replayBuffer.releaseByPaths(paths);
      this.rollingSegments = this._replayBuffer.getChunks();
      this.segmentBuffer = this.rollingSegments;
    }
    return;
  },
  /**
   * 高光已固化到 highlights 目录后，释放对应 rolling 母片并 unpin，避免配额被母片占满。
   * @param {string[]} sourcePaths materialize 前的 rolling 路径
   * @param {string[]} savedPaths 已写入 highlights 的路径
   * @returns {void}
   */
  _releaseMaterializedRollingSources: function (sourcePaths, savedPaths) {
    const saved = Array.isArray(savedPaths) ? savedPaths.filter(Boolean) : [];
    if (!saved.length) return;
    const sources = Array.isArray(sourcePaths) ? sourcePaths : [];
    const pipeline = this._previewRecordPipeline;
    const fs = wx.getFileSystemManager();
    let removed = 0;
    /** @type {string[]} */
    const released = [];
    sources.forEach(src => {
      if (!src || typeof src !== 'string') return;
      if (src.indexOf('_rolling/') < 0) return;
      if (saved.indexOf(src) >= 0) return;
      try {
        fs.unlinkSync(src);
        removed += 1;
        released.push(src);
      } catch (eUn) {}
      if (pipeline && typeof pipeline.unpinPaths === 'function') {
        pipeline.unpinPaths([src]);
      }
    });
    if (pipeline && typeof pipeline.releaseSegmentPaths === 'function') {
      pipeline.releaseSegmentPaths(released);
    }
    if (removed > 0) {
      this.appendHealthLog('highlight_rolling_source_released', {
        removed
      });
    }
  },
  /**
   * 写入高光裁剪诊断日志（长按比赛名导出 health log 后可检索 highlight_trim_diagnostic）。
   * @param {string} phase 阶段：click|seek|materialize|replay
   * @param {Record<string, unknown>} detail
   * @returns {void}
   */
  /** @region LIVE_HIGHLIGHT — 高光生成、裁剪、固化、存储淘汰 */
_logHighlightTrimDiagnostic: function (phase, detail) {
    try {
      this.appendHealthLog('highlight_trim_diagnostic', Object.assign({
        phase: phase || 'unknown'
      }, detail && typeof detail === 'object' ? detail : {}));
    } catch (eLog) {}
  },
  /**
   * 是否允许执行高光实体固化（degraded/recovering/故障态时暂停重 IO）。
   * @returns {boolean}
   */
  canMaterializeHighlightNow: function () {
    if (this.data.isRecovering || this._needManualRelaunch) return false;
    /** 回放进行中暂停 trim 重 IO；onHide 加急固化仍放行。 */
    if (this.data.isReplaying && !this._highlightMaterializeUrgentOnHide) return false;
    if (this._highlightMaterializeUrgentOnHide || this._highlightMaterializeUrgentForReplay) return true;
    if ((this.highlightMaterializeQueue || []).some(t => t && t.tailTrim)) return true;
    if (this.data.pipelineHealth === 'warn') return false;
    return true;
  },
  /**
   * 从已 indexed 的高光条目重建 materialize 任务。
   * @param {Record<string, unknown>} item
   * @returns {Record<string, unknown>|null}
   */
  _buildMaterializeTaskFromClipItem: function (item) {
    if (!item || typeof item !== 'object' || !item.id) return null;
    const segments = Array.isArray(item.segments) ? item.segments.filter(Boolean) : [];
    if (!segments.length) return null;
    const coverRaw = typeof item.cover === 'string' ? item.cover : '';
    const dc = this.data.defaultCover;
    const coverTempPath = coverRaw && coverRaw !== dc && coverRaw.indexOf('data:') !== 0 ? coverRaw : '';
    return {
      id: item.id,
      matchId: item.matchId,
      segments: segments.slice(),
      coverTempPath,
      isVkTimeshift: !!item.isVkTimeshift,
      tailTrim: !!item.replayTailTrim,
      tailLeadMs: this.highlightLeadMs || 8000,
      seekMode: item.seekMode || '',
      clickTime: typeof item.clickTime === 'number' ? item.clickTime : item.createdAt,
      windowStartInSegMs: typeof item.windowStartInSegMs === 'number' ? item.windowStartInSegMs : -1,
      windowEndInSegMs: typeof item.windowEndInSegMs === 'number' ? item.windowEndInSegMs : -1,
      trimDiagnostic: item.trimDiagnostic && typeof item.trimDiagnostic === 'object' ? item.trimDiagnostic : null,
      fallbackWallDurationMs: typeof item.segmentWallDurationMs === 'number' ? item.segmentWallDurationMs : 0,
      trimStartMs: typeof item.replayInitialTimeSec === 'number' ? Math.max(0, Math.floor(item.replayInitialTimeSec * 1000)) : -1,
      trimEndMs: typeof item.replayMediaStopAtSec === 'number' ? Math.max(0, Math.floor(item.replayMediaStopAtSec * 1000)) : -1,
      retryCount: 0
    };
  },
  /**
   * 回放等待固化时，重新入队并提升 materialize 优先级。
   * @param {Record<string, unknown>} item
   * @returns {void}
   */
  _kickUrgentMaterializeForReplay: function (item) {
    if (!item) return;
    const taskId = String(item.id || '');
    const queue = this.highlightMaterializeQueue || [];
    const alreadyQueued = queue.some(t => t && String(t.id) === taskId);
    if (!alreadyQueued && item.status === 'indexed') {
      const task = this._buildMaterializeTaskFromClipItem(item);
      if (task) {
        this.highlightMaterializeQueue.push(task);
      }
    }
    this._highlightMaterializeUrgentForReplay = true;
    try {
      this.appendHealthLog('highlight_materialize_urgent_for_replay', {
        id: taskId,
        queueLen: (this.highlightMaterializeQueue || []).length,
        running: !!this.highlightMaterializeRunning
      });
    } catch (eLog) {}
    this.processHighlightMaterializeQueue();
  },
  /**
   * 导出/相册保存时只取一条可播放路径，避免把未裁剪 rolling 母片一并导出。
   * @param {Record<string, unknown>} item
   * @returns {string[]}
   */
  _collectHighlightExportPaths: function (item) {
    const source = this._resolveHighlightReplaySource(item);
    const target = source.target || (source.paths && source.paths.length ? source.paths[0] : '');
    if (target && this._isHighlightPathPlayable(target)) return [target];
    return [];
  },
  /**
   * 收集高光条目内所有可回放视频路径。
   * @param {Record<string, unknown>} item
   * @returns {string[]}
   */
  _collectHighlightPlaybackPaths: function (item) {
    if (!item || typeof item !== 'object') return [];
    /** @type {string[]} */
    const paths = [];
    const segs = item.segments;
    if (Array.isArray(segs)) {
      segs.forEach(seg => {
        if (seg && typeof seg === 'string') paths.push(seg);
      });
    }
    const rp = item.replaySegment;
    if (rp && typeof rp === 'string' && paths.indexOf(rp) < 0) paths.push(rp);
    return paths;
  },
  /**
   * 从 manifest 生成逐段播放计划。计划只描述播放窗口，不做物理合成。
   * @param {Record<string, unknown>} item
   * @returns {{path:string,initialTimeSec:number,stopAtSec:number|null,index:number}[]}
   */
  _collectManifestReplayPlan: function (item) {
    if (!item || typeof item !== 'object') return [];
    const manifest = item.replayManifest;
    if (!manifest || typeof manifest !== 'object') return [];
    const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
    const windowStart = typeof manifest.startTime === 'number' ? manifest.startTime : null;
    const windowEnd = typeof manifest.endTime === 'number' ? manifest.endTime : null;
    return chunks.map((chunk, idx) => {
      const path = chunk && typeof chunk.path === 'string' ? chunk.path : '';
      if (!path) return null;
      const chunkStart = typeof chunk.startTime === 'number' ? chunk.startTime : 0;
      const chunkEnd = typeof chunk.endTime === 'number' ? chunk.endTime : 0;
      const durationMs = typeof chunk.durationMs === 'number' && chunk.durationMs > 0 ? chunk.durationMs : Math.max(0, chunkEnd - chunkStart);
      const startMs = typeof chunk.playStartMs === 'number' ? chunk.playStartMs : windowStart !== null ? Math.max(0, windowStart - chunkStart) : 0;
      const endMs = typeof chunk.playEndMs === 'number' ? chunk.playEndMs : windowEnd !== null ? Math.max(startMs, windowEnd - chunkStart) : durationMs;
      const boundedStartMs = durationMs > 0 ? Math.min(durationMs, Math.max(0, startMs)) : Math.max(0, startMs);
      const boundedEndMs = durationMs > 0 ? Math.min(durationMs, Math.max(boundedStartMs, endMs)) : Math.max(boundedStartMs, endMs);
      return {
        path,
        initialTimeSec: boundedStartMs / 1000,
        stopAtSec: boundedEndMs > 0 ? Math.max(0.08, boundedEndMs / 1000) : null,
        durationSec: durationMs > 0 ? durationMs / 1000 : null,
        index: idx
      };
    }).filter(Boolean);
  },
  /**
   * 从高光条目自身读取播放计划；用于 materialized 后 manifest 失效时的稳定回退。
   * @param {Record<string, unknown>} item
   * @returns {{path:string,initialTimeSec:number,stopAtSec:number|null,index:number}[]}
   */
  _collectIndexedReplayPlan: function (item) {
    if (!item || typeof item !== 'object') return [];
    const plan = Array.isArray(item.replayPlan) ? item.replayPlan : [];
    return plan.map((entry, idx) => {
      const path = entry && typeof entry.path === 'string' ? entry.path : '';
      if (!path) return null;
      const initialTimeSec = entry && typeof entry.initialTimeSec === 'number' ? Math.max(0, entry.initialTimeSec) : 0;
      const stopAtSec = entry && typeof entry.stopAtSec === 'number' && entry.stopAtSec > 0 ? Math.max(0.08, entry.stopAtSec) : null;
      return {
        path,
        initialTimeSec,
        stopAtSec,
        durationSec: entry && typeof entry.durationSec === 'number' ? entry.durationSec : null,
        index: idx
      };
    }).filter(Boolean);
  },
  /**
   * 判断已标记 replayPreTrimmed 的固化文件是否实为「假裁剪」（仍接近母片体积）。
   * Android 8s 高光码率更高，体积常 >1.8MB，须结合 trimVerified / 源目标体积比。
   * @param {Record<string, unknown>} item
   * @param {number} replayFileSizeBytes
   * @returns {boolean}
   */
  _isReplaySuspectFakeTrim: function (item, replayFileSizeBytes) {
    if (!item || !item.replayPreTrimmed) return false;
    if (item.trimVerified === true) return false;
    const srcBytes = typeof item.srcSizeBytes === 'number' ? item.srcSizeBytes : 0;
    const outBytes = typeof item.trimOutputSizeBytes === 'number' ? item.trimOutputSizeBytes : 0;
    const fileBytes = Number(replayFileSizeBytes) || 0;
    if (srcBytes > 0 && outBytes > 0 && outBytes < srcBytes * 0.65) return false;
    if (srcBytes > 0 && fileBytes > 0 && fileBytes < srcBytes * 0.65) return false;
    const thresholdMb = isLiveHostIos() ? 1.8 : 5.5;
    return fileBytes > thresholdMb * 1024 * 1024;
  },
  /**
   * 已裁剪固化的高光条目：回放 seek 须从 0 起，不可沿用母片内偏移。
   * 若固化时裁剪失败（整段母片拷贝），不可误判为已裁剪。
   * @param {Record<string, unknown>} item
   * @returns {Record<string, unknown>}
   */
  _normalizeMaterializedReplaySeek: function (item) {
    if (!item || item.replayPreTrimmed) return item;
    if (item.status !== 'materialized') return item;
    if (item.trimVerified === false) return item;
    const target = item.replaySegment || (Array.isArray(item.segments) ? item.segments[item.segments.length - 1] : '');
    if (!target || typeof target !== 'string' || target.indexOf('_rolling/') >= 0) return item;
    let replayFileSizeBytes = 0;
    try {
      const st = wx.getFileSystemManager().statSync(target);
      replayFileSizeBytes = st && typeof st.size === 'number' ? st.size : 0;
    } catch (eStat) {}
    if (this._isReplaySuspectFakeTrim(item, replayFileSizeBytes)) {
      return item;
    }
    const init = typeof item.replayInitialTimeSec === 'number' ? item.replayInitialTimeSec : 0;
    const stop = typeof item.replayMediaStopAtSec === 'number' ? item.replayMediaStopAtSec : 0;
    if (init <= 0.05) return item;
    const windowSec = stop > init ? stop - init : 0;
    if (windowSec <= 0 || windowSec > 15) return item;
    return Object.assign({}, item, {
      replayPreTrimmed: true,
      replayInitialTimeSec: 0,
      replayMediaStopAtSec: windowSec,
      replayChainPart2StopAtSec: null,
      replayPlan: [{
        path: target,
        initialTimeSec: 0,
        stopAtSec: windowSec,
        durationSec: windowSec,
        index: 0
      }]
    });
  },
  /**
   * 滚动母片回放：墙钟 seek 需减去起录延迟后再映射到文件轴，避免 seek 越界（currentTime:-1）。
   * @param {Record<string, unknown>} item
   * @param {number} wallInitialSec
   * @param {number} wallStopSec
   * @returns {{ initialSec: number, stopSec: number, encodeStartOffsetMs: number }}
   */
  _resolveRollingReplaySeek: function (item, wallInitialSec, wallStopSec) {
    const wallDur = typeof item.segmentWallDurationMs === 'number' ? item.segmentWallDurationMs : 0;
    const winStart = typeof item.windowStartInSegMs === 'number' && item.windowStartInSegMs >= 0 ? item.windowStartInSegMs : Math.max(0, Math.floor((Number(wallInitialSec) || 0) * 1000));
    const winEnd = typeof item.windowEndInSegMs === 'number' && item.windowEndInSegMs > winStart ? item.windowEndInSegMs : Math.max(winStart + 500, Math.floor((Number(wallStopSec) || 0) * 1000));
    if (wallDur <= 500 || winEnd <= winStart) {
      return {
        initialSec: Number(wallInitialSec) || 0,
        stopSec: Number(wallStopSec) || 0,
        encodeStartOffsetMs: 0
      };
    }
    const trimMod = replayBufferMod.mediaContainerTrim;
    if (!trimMod || typeof trimMod.mapWallWindowToFileMs !== 'function') {
      return {
        initialSec: Number(wallInitialSec) || 0,
        stopSec: Number(wallStopSec) || 0,
        encodeStartOffsetMs: 0
      };
    }
    /** 真机观测 fileDur ≈ wallDur * 0.832（起录延迟 ~16.8%） */
    const fileEstMs = Math.max(500, Math.floor(wallDur * 0.832));
    const mapped = trimMod.mapWallWindowToFileMs(winStart, winEnd, wallDur, fileEstMs);
    return {
      initialSec: mapped.trimStartMs / 1000,
      stopSec: mapped.trimEndMs / 1000,
      encodeStartOffsetMs: mapped.encodeStartOffsetMs
    };
  },
  /**
   * 选择高光回放路径。manifest-first，但只有 manifest 内所有文件仍可读时才使用，
   * 避免固化后 temp manifest 失效反而误伤回放。
   * @param {Record<string, unknown>} item
   * @returns {{ paths: string[], plan: Array<Record<string, unknown>>, useChain: boolean, target: string, fromManifest: boolean }}
   */
  _resolveHighlightReplaySource: function (item) {
    const normalized = this._normalizeMaterializedReplaySeek(item);
    const manifestPlan = this._collectManifestReplayPlan(normalized);
    const manifestPaths = manifestPlan.map(entry => entry.path).filter(Boolean);
    if (manifestPaths.length && manifestPaths.every(p => this._isHighlightPathPlayable(p))) {
      return {
        paths: manifestPaths.slice(),
        plan: manifestPlan,
        useChain: manifestPlan.length >= 2,
        target: manifestPaths[manifestPaths.length - 1] || manifestPaths[0] || '',
        fromManifest: true
      };
    }
    const indexedPlan = this._collectIndexedReplayPlan(normalized);
    const indexedPaths = indexedPlan.map(entry => entry.path).filter(Boolean);
    if (indexedPaths.length && indexedPaths.every(p => this._isHighlightPathPlayable(p))) {
      return {
        paths: indexedPaths.slice(),
        plan: indexedPlan,
        useChain: indexedPlan.length >= 2,
        target: indexedPaths[indexedPaths.length - 1] || indexedPaths[0] || '',
        fromManifest: false
      };
    }
    const useChain = !!(normalized && normalized.replayUseChain && normalized.segments && normalized.segments.length >= 2);
    const paths = useChain && Array.isArray(normalized.segments) ? normalized.segments.slice() : [];
    const target = normalized && normalized.replaySegment || (normalized && Array.isArray(normalized.segments) && normalized.segments[normalized.segments.length - 1] ? normalized.segments[normalized.segments.length - 1] : '');
    const fallbackPaths = useChain ? paths.slice() : target ? [target] : [];
    const fallbackPlan = fallbackPaths.map((path, idx) => {
      const isFirst = idx === 0;
      const isLast = idx === fallbackPaths.length - 1;
      const preTrimmed = !!(normalized && normalized.replayPreTrimmed);
      let stopAtSec = null;
      if (isLast) {
        stopAtSec = idx === 0 ? typeof normalized.replayMediaStopAtSec === 'number' ? normalized.replayMediaStopAtSec : null : typeof normalized.replayChainPart2StopAtSec === 'number' ? normalized.replayChainPart2StopAtSec : null;
      }
      return {
        path,
        initialTimeSec: preTrimmed ? 0 : isFirst && typeof normalized.replayInitialTimeSec === 'number' ? Math.max(0, normalized.replayInitialTimeSec) : 0,
        stopAtSec,
        durationSec: null,
        index: idx
      };
    });
    return {
      paths: fallbackPaths,
      plan: fallbackPlan,
      useChain,
      target,
      fromManifest: false
    };
  },
  /**
   * 同步探测路径是否可播放（存在且体积合理）。
   * @param {string} p
   * @param {number} [wallDurationMs] 可选墙钟跨度，用于识别空壳 mp4
   * @returns {boolean}
   */
  _isHighlightPathPlayable: function (p, wallDurationMs) {
    if (!p || typeof p !== 'string') return false;
    const fs = wx.getFileSystemManager();
    try {
      const st = fs.statSync(p);
      const sz = st && typeof st.size === 'number' ? st.size : 0;
      if (sz < 64) return false;
      const fsReadyMod = replayBufferMod.fsReady;
      if (fsReadyMod && typeof fsReadyMod.isHollowSegment === 'function' && typeof wallDurationMs === 'number' && wallDurationMs > 500) {
        return !fsReadyMod.isHollowSegment(sz, wallDurationMs);
      }
      return true;
    } catch (eStat) {
      return false;
    }
  },
  /**
   * 判断高光源文件是否为空壳（Android 部分机型 B 轨常见）。
   * @param {string} path
   * @param {number} [wallDurationMs]
   * @returns {boolean}
   */
  _isHighlightSourceHollow: function (path, wallDurationMs) {
    if (!path || typeof path !== 'string') return true;
    const fsReadyMod = replayBufferMod.fsReady;
    if (!fsReadyMod || typeof fsReadyMod.isHollowSegment !== 'function') return false;
    try {
      const st = wx.getFileSystemManager().statSync(path);
      const sz = st && typeof st.size === 'number' ? st.size : 0;
      const wallMs = typeof wallDurationMs === 'number' && wallDurationMs > 0 ? wallDurationMs : 8000;
      return fsReadyMod.isHollowSegment(sz, wallMs);
    } catch (eStat) {
      return true;
    }
  },
  /**
   * 判断 rolling 母片码率是否达标（切后台回前台后静止画面常表现为极低码率）。
   * @param {number} sizeBytes
   * @param {number} wallDurationMs
   * @returns {boolean}
   */
  _isRollingSegmentQualityHealthy: function (sizeBytes, wallDurationMs) {
    const size = Math.max(0, Math.floor(Number(sizeBytes) || 0));
    const wallMs = Math.max(0, Math.floor(Number(wallDurationMs) || 0));
    if (size < 16384) return false;
    if (wallMs < 8000) return size >= 400000;
    const durSec = Math.max(1, wallMs / 1000);
    return size / durSec >= MIN_ROLLING_SEGMENT_BYTES_PER_SEC;
  },
  /**
   * preview 管线落盘段码率过低时触发自愈（仅切后台回前台会话）。
   * @param {{ sizeBytes?: number, startTime?: number, endTime?: number, trackId?: string }} segment
   * @returns {void}
   */
  _handleDegradedRollingSegment: function (segment) {
    if (!this.isLiveForegroundRecordingRecoverPending()) return;
    const wallMs = Math.max(0, (segment.endTime || 0) - (segment.startTime || 0));
    const sizeBytes = segment.sizeBytes || 0;
    if (this._isRollingSegmentQualityHealthy(sizeBytes, wallMs)) {
      this._liveReturnedFromBackground = false;
      this._highlightHollowFlushStreak = 0;
      return;
    }
    this.appendHealthLog('preview_record_segment_degraded', {
      trackId: segment.trackId || '',
      sizeBytes,
      wallDurationMs: wallMs,
      bytesPerSec: wallMs > 0 ? Math.round(sizeBytes / Math.max(1, wallMs / 1000)) : 0
    });
    if (this.data.isRecovering || this._recoveryLock) return;
    this.hardRecoverLivePipeline('highlight_hollow_flush');
  },
  /**
   * 长跑/发热导致 rolling 段码率持续偏低时，自动降低 CFR 与新建编码器档位（双轨不停）。
   * @param {{ sizeBytes?: number, startTime?: number, endTime?: number, trackId?: string }} segment
   * @returns {void}
   */
  _handleThermalRollingSegment: function (segment) {
    if (!segment || this.data.isReplaying) return;
    const wallMs = Math.max(0, (segment.endTime || 0) - (segment.startTime || 0));
    if (wallMs < THERMAL_SEGMENT_MIN_WALL_MS) return;
    const sizeBytes = segment.sizeBytes || 0;
    const bytesPerSec = wallMs > 0 ? Math.round(sizeBytes / Math.max(1, wallMs / 1000)) : 0;
    const healthy = bytesPerSec >= THERMAL_ROLLING_SEGMENT_BYTES_PER_SEC && sizeBytes >= 16384;
    if (healthy) {
      this._thermalDegradedSegmentStreak = 0;
      if (this._thermalRecordingMode) {
        this._thermalHealthySegmentStreak = (this._thermalHealthySegmentStreak || 0) + 1;
        if (this._thermalHealthySegmentStreak >= THERMAL_HEALTHY_SEGMENT_STREAK_EXIT) {
          this._exitThermalRecordingMode();
        }
      }
      return;
    }
    this._thermalHealthySegmentStreak = 0;
    this._thermalDegradedSegmentStreak = (this._thermalDegradedSegmentStreak || 0) + 1;
    this.appendHealthLog('recording_thermal_segment_degraded', {
      trackId: segment.trackId || '',
      sizeBytes,
      wallDurationMs: wallMs,
      bytesPerSec,
      streak: this._thermalDegradedSegmentStreak
    });
    if (
      this._thermalDegradedSegmentStreak >= THERMAL_DEGRADED_SEGMENT_STREAK_ENTER
      && !this._thermalRecordingMode
    ) {
      this._enterThermalRecordingMode();
    }
  },
  /**
   * 设备发热时进入录制降载模式（降低 CFR 与后续 MediaRecorder 码率/fps）。
   * @returns {void}
   */
  _enterThermalRecordingMode: function () {
    if (this._thermalRecordingMode) return;
    this._thermalRecordingMode = true;
    this._thermalHealthySegmentStreak = 0;
    this._thermalSavedRecordFps = this.pingPongRecordFps || 24;
    this._thermalSavedRecordKbps = this.pingPongVideoBitsPerSecondKbps || 3600;
    this.pingPongRecordFps = THERMAL_RECORDING_NOMINAL_FPS;
    this.pingPongVideoBitsPerSecondKbps = THERMAL_RECORDING_KBPS;
    const pipeline = this._previewRecordPipeline;
    if (pipeline && typeof pipeline.setRecordingProfile === 'function') {
      pipeline.setRecordingProfile({
        fps: THERMAL_RECORDING_NOMINAL_FPS,
        videoBitsPerSecondKbps: THERMAL_RECORDING_KBPS,
        cfrPumpFps: THERMAL_RECORDING_CFR_FPS
      });
    } else if (pipeline && typeof pipeline.setCfrPumpFps === 'function' && !this.data.isReplaying) {
      pipeline.setCfrPumpFps(THERMAL_RECORDING_CFR_FPS);
    }
    this.appendHealthLog('recording_thermal_throttle_enter', {
      cfrFps: THERMAL_RECORDING_CFR_FPS,
      recordFps: THERMAL_RECORDING_NOMINAL_FPS,
      kbps: THERMAL_RECORDING_KBPS,
      savedFps: this._thermalSavedRecordFps,
      savedKbps: this._thermalSavedRecordKbps
    });
    if (!this._thermalThrottleToastShown) {
      this._thermalThrottleToastShown = true;
      try {
        wx.showToast({
          title: '设备发热，已自动降低录制负载',
          icon: 'none',
          duration: 2600
        });
      } catch (eToast) {}
    }
  },
  /**
   * 连续健康 rolling 段后恢复默认录制档位。
   * @returns {void}
   */
  _exitThermalRecordingMode: function () {
    if (!this._thermalRecordingMode) return;
    const restoreFps = this._thermalSavedRecordFps > 0 ? this._thermalSavedRecordFps : 24;
    const restoreKbps = this._thermalSavedRecordKbps > 0 ? this._thermalSavedRecordKbps : 3600;
    this.pingPongRecordFps = restoreFps;
    this.pingPongVideoBitsPerSecondKbps = restoreKbps;
    this._thermalRecordingMode = false;
    this._thermalDegradedSegmentStreak = 0;
    this._thermalHealthySegmentStreak = 0;
    const pipeline = this._previewRecordPipeline;
    if (pipeline && typeof pipeline.setRecordingProfile === 'function') {
      pipeline.setRecordingProfile({
        fps: restoreFps,
        videoBitsPerSecondKbps: restoreKbps,
        cfrPumpFps: restoreFps
      });
    } else if (pipeline && typeof pipeline.setCfrPumpFps === 'function' && !this.data.isReplaying) {
      pipeline.setCfrPumpFps(restoreFps);
    }
    this.appendHealthLog('recording_thermal_throttle_exit', {
      fps: restoreFps,
      kbps: restoreKbps
    });
  },
  /**
   * indexed 滚动母片 + tailTrim 在固化前 seek 回放易卡顿/残缺，须等 materialized（iOS/Android 同策略）。
   * @param {Record<string, unknown>} item
   * @returns {boolean}
   */
  _needsMaterializedReplay: function (item) {
    if (!item || typeof item !== 'object') return false;
    if (item.replayPreTrimmed && item.status === 'materialized') return false;
    if (!item.replayTailTrim && item.seekMode !== 'click_wall_mapped') return false;
    const source = this._resolveHighlightReplaySource(item);
    const target = source && source.target ? source.target : '';
    if (typeof target !== 'string') return false;
    if (target.indexOf('_rolling/') >= 0) return true;
    return item.status !== 'materialized';
  },
  /**
   * @deprecated 请使用 {@link _needsMaterializedReplay}
   * @param {Record<string, unknown>} item
   * @returns {boolean}
   */
  _needsAndroidMaterializedReplay: function (item) {
    return this._needsMaterializedReplay(item);
  },
  /**
   * 从 clips 存储读取最新高光条目。
   * @param {string} matchId
   * @param {string|number} id
   * @returns {Record<string, unknown>|null}
   */
  _getHighlightClipFromStorage: function (matchId, id) {
    const key = clipsStorage.normalizeMatchIdKey(matchId);
    if (!key || id == null) return null;
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap || !Array.isArray(clipsMap[key])) return null;
    return clipsMap[key].find(clip => clip && String(clip.id) === String(id)) || null;
  },
  /**
   * 取消固化等待回放轮询。
   * @returns {void}
   */
  _clearReplayMaterializeWait: function () {
    if (this._replayMaterializeWaitTimer) {
      clearTimeout(this._replayMaterializeWaitTimer);
      this._replayMaterializeWaitTimer = null;
    }
  },
  /**
   * 固化完成后尝试启动此前 deferred 的回放。
   * @param {string|number} highlightId
   * @param {string} matchId
   * @returns {void}
   */
  _maybeStartDeferredMaterializeReplay: function (highlightId, matchId) {
    const deferred = this._replayDeferredMaterializeItem;
    if (!deferred || String(deferred.id) !== String(highlightId)) return;
    this._clearReplayMaterializeWait();
    this._replayDeferredMaterializeItem = null;
    const fresh = this._getHighlightClipFromStorage(matchId, highlightId);
    if (!fresh || fresh.status !== 'materialized') return;
    this.appendHealthLog('replay_start_after_materialize', {
      id: String(highlightId || ''),
      replayPreTrimmed: !!fresh.replayPreTrimmed
    });
    setTimeout(() => {
      if (!this._livePageVisible) return;
      this.startReplay(fresh);
    }, 160);
  },
  /**
   * indexed 高光：等待固化完成后再回放（全平台）。
   * @param {Record<string, unknown>} item
   * @returns {void}
   */
  _deferReplayUntilMaterialized: function (item) {
    if (!item || typeof item !== 'object') return;
    this._clearReplayMaterializeWait();
    this._replayDeferredMaterializeItem = item;
    /** 异步加急固化，不阻塞主线程。 */
    setTimeout(() => {
      this._kickUrgentMaterializeForReplay(item);
    }, 0);
    this.appendHealthLog('replay_deferred_until_materialize', {
      id: item.id != null ? String(item.id) : '',
      status: item.status || ''
    });
    wx.showToast({
      title: '正在处理高光视频…',
      icon: 'none',
      duration: 1800
    });
    const startedAt = Date.now();
    const poll = () => {
      const fresh = this._getHighlightClipFromStorage(item.matchId, item.id);
      if (fresh && fresh.status === 'materialized' && !this._needsMaterializedReplay(fresh)) {
        this._maybeStartDeferredMaterializeReplay(item.id, item.matchId);
        return;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= 6000 && elapsed < 6400 && fresh && fresh.status === 'indexed') {
        setTimeout(() => {
          this._kickUrgentMaterializeForReplay(fresh);
        }, 0);
      }
      if (elapsed >= REPLAY_MATERIALIZE_WAIT_MS) {
        this._clearReplayMaterializeWait();
        this._replayDeferredMaterializeItem = null;
        wx.showToast({
          title: '高光视频正在努力生成中，请稍后在列表查看',
          icon: 'none',
          duration: 2800
        });
        return;
      }
      this._replayMaterializeWaitTimer = setTimeout(poll, 420);
    };
    this._replayMaterializeWaitTimer = setTimeout(poll, 420);
  },
  /**
   * 高光条目是否具备可回放物理文件。
   * @param {Record<string, unknown>} item
   * @returns {boolean}
   */
  _isHighlightItemPlayable: function (item) {
    const source = this._resolveHighlightReplaySource(item);
    const paths = source.useChain ? source.paths : source.target ? [source.target] : [];
    if (!paths.length) return false;
    const wallDurationMs = typeof item.segmentWallDurationMs === 'number' ? item.segmentWallDurationMs : this.highlightPlaybackWindowMs || 8000;
    return paths.every(p => this._isHighlightPathPlayable(p, wallDurationMs));
  },
  /**
   * 回放前发现文件丢失：清理索引并温和提示（不弹系统级 Modal）。
   * @param {Record<string, unknown>} item
   * @returns {void}
   */
  _rejectHighlightReplayMissingFiles: function (item) {
    if (!item || item.id == null) return;
    try {
      this.appendHealthLog('highlight_replay_file_missing', {
        id: String(item.id),
        status: item.status || ''
      });
    } catch (eLog) {}
    this.doDeleteHighlight(item.id);
    wx.showToast({
      title: '片段未缓存成功',
      icon: 'none',
      duration: 2000
    });
  },
  /**
   * onHide 时尽力将排队中的 temp 高光固化落盘。
   * @returns {void}
   */
  _kickHighlightMaterializeOnHide: function () {
    if (!Array.isArray(this.highlightMaterializeQueue) || !this.highlightMaterializeQueue.length) {
      return;
    }
    this._highlightMaterializeUrgentOnHide = true;
    try {
      this.appendHealthLog('highlight_materialize_urgent_on_hide', {
        queueLen: this.highlightMaterializeQueue.length
      });
    } catch (eLog) {}
    this.processHighlightMaterializeQueue();
  },
  /**
   * 清理过量高光实体，避免温层无限增长与沙盒爆满。
   * @param {string} matchId
   * @returns {void}
   */
  pruneHighlightStorageForMatch: function (matchId) {
    const key = clipsStorage.normalizeMatchIdKey(matchId);
    if (!key) return;
    const fs = wx.getFileSystemManager();
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) return;
    const list = Array.isArray(clipsMap[key]) ? clipsMap[key] : [];
    const maxCount = this.highlightsMaxCount || 100;
    if (list.length <= maxCount) return;
    const sorted = list.slice().sort((a, b) => this.resolveHighlightCreatedAt(/** @type {Record<string, unknown>} */b) - this.resolveHighlightCreatedAt(/** @type {Record<string, unknown>} */a));
    const removed = sorted.slice(maxCount);
    clipsMap[key] = sorted.slice(0, maxCount);
    clipsStorage.writeClipsMapSafe(clipsMap);
    removed.forEach(it => {
      const segs = it && Array.isArray(it.segments) ? it.segments : [];
      segs.forEach(p => {
        if (!p) return;
        try {
          fs.unlinkSync(p);
        } catch (e) {}
      });
    });
  },
  /**
   * 统计高光索引总条数（跨场次）。
   * @returns {number}
   */
  getTotalHighlightClipCount: function () {
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) return 0;
    let total = 0;
    Object.keys(clipsMap).forEach(matchId => {
      const list = clipsMap[matchId];
      if (!Array.isArray(list)) return;
      total += list.length;
    });
    return total;
  },
  /**
   * 按创建时间删除最旧的高光条目并 unlink 片段文件，缓解小程序「文件存储」上限（非 KV）。
   * @param {number} maxRemove 最多删除几条（跨场次全局最旧）
   * @param {string} [reason] 触发来源（诊断日志用）
   * @returns {number} 实际删除条数
   */
  pruneOldestHighlightClipsFromStorage: function (maxRemove, reason, opts) {
    const cap = typeof maxRemove === 'number' && maxRemove > 0 ? Math.min(maxRemove, 30) : 1;
    const why = typeof reason === 'string' ? reason : '';
    const options = opts && typeof opts === 'object' ? opts : {};
    const fs = wx.getFileSystemManager();
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) return 0;
    /** @type {{ matchId: string, id: string, createdAt: number }[]} */
    const entries = [];
    Object.keys(clipsMap).forEach(matchId => {
      const list = clipsMap[matchId];
      if (!Array.isArray(list)) return;
      list.forEach(it => {
        if (!it || typeof it !== 'object') return;
        const id = it.id != null ? String(it.id) : '';
        if (!id) return;
        const createdAt = this.resolveHighlightCreatedAt(/** @type {Record<string, unknown>} */it);
        entries.push({
          matchId,
          id,
          createdAt
        });
      });
    });
    if (entries.length === 0) {
      return 0;
    }
    const optMinKeep = Number(options.minKeepOverride);
    const minKeep = Number.isFinite(optMinKeep) ? Math.max(0, Math.floor(optMinKeep)) : Math.max(0, Number(this.highlightsEmergencyMinKeepCount || 0));
    const removableBudget = Math.max(0, entries.length - minKeep);
    if (removableBudget <= 0) {
      this.appendHealthLog('live_prune_skipped_min_keep', {
        total: entries.length,
        minKeep,
        reason: why
      });
      return 0;
    }
    const targetRemove = Math.min(cap, removableBudget);
    entries.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    let removed = 0;
    for (let i = 0; i < entries.length && removed < targetRemove; i += 1) {
      const {
        matchId,
        id
      } = entries[i];
      const list = clipsMap[matchId];
      if (!Array.isArray(list)) continue;
      const idx = list.findIndex(x => x && String(x.id) === id);
      if (idx < 0) continue;
      const item = list[idx];
      const toUnlink = new Set();
      (item.segments || []).forEach(p => {
        if (p && typeof p === 'string') toUnlink.add(p);
      });
      if (item.replaySegment && typeof item.replaySegment === 'string') {
        toUnlink.add(item.replaySegment);
      }
      toUnlink.forEach(p => {
        try {
          fs.unlinkSync(p);
        } catch (eUn) {}
      });
      list.splice(idx, 1);
      removed += 1;
    }
    if (removed > 0) {
      clipsStorage.writeClipsMapSafe(clipsMap);
      this.appendHealthLog('live_pruned_oldest_highlights', {
        removed,
        requested: cap,
        minKeep,
        totalBefore: entries.length,
        reason: why
      });
      try {
        if (typeof this.refreshDrawerHighlights === 'function') {
          this.refreshDrawerHighlights();
        }
      } catch (eR) {}
    }
    return removed;
  },
  /**
   * 移除「索引存在但视频文件已全部不可用」的高光（缺失或过小），优先于按时间删最旧。
   *
   * @param {string} [reason] 诊断日志
   * @returns {number} 删除条数
   */
  pruneHighlightClipsWithInvalidFiles: function (reason) {
    const why = typeof reason === 'string' ? reason : '';
    const fs = wx.getFileSystemManager();
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) return 0;
    /**
     * @param {string} p
     * @returns {boolean} true 表示不可播放
     */
    const isPathUnusable = p => {
      if (!p || typeof p !== 'string') return true;
      try {
        const st = fs.statSync(p);
        const sz = st && typeof st.size === 'number' ? st.size : 0;
        return sz < 64;
      } catch (eStat) {
        return true;
      }
    };
    /**
     * @param {Record<string, unknown>} it
     * @returns {boolean}
     */
    const itemIsDead = it => {
      if (!it || typeof it !== 'object') return false;
      const itemId = it.id != null ? String(it.id) : '';
      const pendingIds = new Set((this.highlightMaterializeQueue || []).map(t => t && t.id != null ? String(t.id) : ''));
      if (itemId && (pendingIds.has(itemId) || itemId === String(this._highlightMaterializeCurrentId || ''))) {
        return false;
      }
      if (it.status === 'indexed' && itemId && this.highlightMaterializeRunning) {
        return false;
      }
      /** @type {string[]} */
      const paths = [];
      const segs = it.segments;
      if (Array.isArray(segs)) {
        segs.forEach(seg => {
          if (seg && typeof seg === 'string') paths.push(seg);
        });
      }
      const rp = it.replaySegment;
      if (rp && typeof rp === 'string') paths.push(rp);
      if (paths.length === 0) return true;
      return paths.every(isPathUnusable);
    };
    let removed = 0;
    Object.keys(clipsMap).forEach(matchId => {
      const list = clipsMap[matchId];
      if (!Array.isArray(list)) return;
      for (let i = list.length - 1; i >= 0; i -= 1) {
        const it = list[i];
        if (!itemIsDead(it)) continue;
        const toUnlink = new Set();
        const segs2 = it.segments;
        if (Array.isArray(segs2)) {
          segs2.forEach(p => {
            if (p && typeof p === 'string') toUnlink.add(p);
          });
        }
        if (it.replaySegment && typeof it.replaySegment === 'string') {
          toUnlink.add(it.replaySegment);
        }
        toUnlink.forEach(p => {
          try {
            fs.unlinkSync(p);
          } catch (eUn) {}
        });
        list.splice(i, 1);
        removed += 1;
      }
    });
    if (removed > 0) {
      clipsStorage.writeClipsMapSafe(clipsMap);
      this.appendHealthLog('live_pruned_dead_highlights', {
        removed,
        reason: why
      });
      try {
        if (typeof this.refreshDrawerHighlights === 'function') {
          this.refreshDrawerHighlights();
        }
      } catch (eR) {}
    }
    return removed;
  },
  /**
   * 评估 Storage 水位并执行分级治理。
   * @returns {number}
   */
  evaluateStorageWatermark: function () {
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
    if (ratio >= 0.95) level = 95;else if (ratio >= 0.85) level = 85;else if (ratio >= 0.7) level = 70;
    if (level !== this.storageWatermarkLevel) {
      this.storageWatermarkLevel = level;
      this.appendHealthLog('storage_watermark_change', {
        level,
        ratio: Number(ratio.toFixed(3))
      });
    }
    // 95%：强制淘汰最旧高光实体，优先保直播
    if (level >= 95) {
      const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
      if (currentMatchId) this.pruneHighlightStorageForMatch(currentMatchId);
    }
    if (ratio >= 0.85) {
      try {
        const siPr = wx.getSystemInfoSync();
        if (siPr && siPr.platform === 'ios') {
          this.pruneIosSegmentBufferUserLocals(4);
        }
      } catch (ePr) {}
    }
    return level;
  },
  /**
   * MOD: rolling buffer 改为 temp 时间索引后，buffer 淘汰只 shift，不主动 unlink temp 文件。
   * @returns {void}
   */
  pruneIosSegmentBufferUserLocals: function () {
    return;
  },
  /**
   * 判断是否为小程序本地「文件存储」配额已满（与 KV storage 的 limitSize 不同）。
   * @param {string} errMsg 接口 fail 回调中的 errMsg
   * @returns {boolean}
   */
  isMiniProgramFileQuotaExceeded: function (errMsg) {
    if (!errMsg || typeof errMsg !== 'string') return false;
    const s = errMsg.toLowerCase();
    return s.indexOf('storage limit') >= 0 || s.indexOf('maximum size') >= 0 || s.indexOf('file storage') >= 0;
  },
  /**
   * MOD: rolling buffer 改为 temp 时间索引后，buffer 淘汰只 shift，不主动 unlink temp 文件。
   * @returns {void}
   */
  trimRollingSegmentBufferForQuota: function () {
    return;
  },
  /**
   * 文件配额告警时尽量释放空间：淘汰 user-local 副本、rolling 热层最旧项、清理 _rolling 孤儿文件。
   * @param {string} [reason] 诊断用
   * @returns {void}
   */
  freeRollingFileStorageAggressive: function (reason) {
    const now = Date.now();
    const r = typeof reason === 'string' ? reason : '';
    // P0: severe 水位或 persist_io_fail 时缩短节流间隔
    const isSevereBreach = r === 'live_storage_severe_periodic' || r === 'persist_io_fail';
    const gapMs = isSevereBreach ? 200 : r === 'phase7_user_save_exhausted' ? 450 : r === 'live_storage_severe_kickoff' ? 800 : 2400;
    if (this._lastRollingAggressiveFreeAt && now - this._lastRollingAggressiveFreeAt < gapMs) {
      this.appendHealthLog('rolling_aggressive_free_throttled', {
        reason: r,
        sinceLastMs: now - this._lastRollingAggressiveFreeAt
      });
      return;
    }
    this._lastRollingAggressiveFreeAt = now;
    this.appendHealthLog('rolling_file_quota_emergency_free', {
      reason: r
    });
    this.pruneIosSegmentBufferUserLocals(2);
    this.trimRollingSegmentBufferForQuota(5);
    let rollingFreed = this.pruneRollingMp4ForQuota(r, {
      maxCount: isSevereBreach ? 4 : 6
    });
    rollingFreed += this.pruneSandboxOrphanMediaForQuota(r + '_sandbox');
    let clipPrune = 0;
    if (r === 'persist_io_fail' || r === 'phase7_user_save_exhausted' || r === 'live_storage_severe_periodic') {
      clipPrune = 4;
    }
    /**
     * 不在「入场 severe kickoff」自动删已保存高光：用户每次从首页进直播都会走 onLoad，
     * `_liveSevereKickoffPruneDone` 会重置，若此处 clipPrune=2 会反复每次少 2 条直到触及 minKeep。
     * 严重水位仅清理 rolling 临时层 + 孤儿文件；索引高光交给用户点「下载并清空」或 persist 真失败路径。
     */
    if (clipPrune > 0) {
      const deadRm = this.pruneHighlightClipsWithInvalidFiles(r + '_orphan_first');
      if (deadRm > 0) {
        this._persistIoFailGcStreak = 0;
        this.appendHealthLog('rolling_clip_prune_dead_first', {
          removed: deadRm,
          reason: r
        });
      }
      const nowPr = Date.now();
      const emergencyPruneGapMs = 15 * 60 * 1000;
      const isUrgent = r === 'live_storage_severe_periodic' || r === 'persist_io_fail' || r === 'phase7_user_save_exhausted';
      // P0: severe 水位时击穿 15 分钟冷却期，再压一轮 rolling（保留活跃段，不 purgeAll 误删在录文件）
      if (isSevereBreach) {
        this.appendHealthLog('severe_gc_cooldown_breach', {
          reason: r,
          sinceLastMs: this._lastEmergencyClipPruneAt ? nowPr - this._lastEmergencyClipPruneAt : -1
        });
        const extraFreed = this.pruneRollingMp4ForQuota(r + '_severe', {
          maxCount: 3
        });
        if (extraFreed > 0) {
          rollingFreed += extraFreed;
        }
      }
      if (!isUrgent && !isSevereBreach && this._lastEmergencyClipPruneAt && nowPr - this._lastEmergencyClipPruneAt < emergencyPruneGapMs) {
        this.appendHealthLog('rolling_clip_prune_cooldown_skip', {
          reason: r,
          sinceLastMs: nowPr - this._lastEmergencyClipPruneAt
        });
        return;
      }
      const totalClips = this.getTotalHighlightClipCount();
      const minKeep = Math.max(0, Number(this.highlightsEmergencyMinKeepCount || 0));
      let minKeepForPrune = minKeep;
      let highlightPruneSkipped = false;
      if (totalClips <= minKeep) {
        const emergencyFloor = Math.max(1, Number(this.highlightsEmergencyHardFloor || 3));
        if (totalClips > emergencyFloor) {
          minKeepForPrune = emergencyFloor;
          this.appendHealthLog('rolling_clip_prune_break_min_keep', {
            reason: r,
            totalClips,
            minKeep,
            emergencyFloor
          });
        } else if (totalClips > 0 && isSevereBreach) {
          minKeepForPrune = Math.max(0, totalClips - 1);
          this.appendHealthLog('rolling_clip_prune_emergency_one', {
            reason: r,
            totalClips,
            minKeepForPrune
          });
        } else {
          highlightPruneSkipped = true;
          this.appendHealthLog('rolling_clip_prune_min_keep_skip', {
            reason: r,
            totalClips,
            minKeep,
            rollingFreed
          });
        }
      }
      if (highlightPruneSkipped) {
        if (rollingFreed <= 0) {
          this._persistIoFailGcStreak = (this._persistIoFailGcStreak || 0) + 1;
        } else {
          this._persistIoFailGcStreak = 0;
        }
        if (this._persistIoFailGcStreak >= 12) {
          this.activateFileQuotaCircuitBreaker('persist_io_fail_gc_exhausted');
        }
        return;
      }
      this._lastEmergencyClipPruneAt = nowPr;
      const pr = this.pruneOldestHighlightClipsFromStorage(clipPrune, r, {
        minKeepOverride: minKeepForPrune
      });
      if (pr > 0) {
        this._persistIoFailGcStreak = 0;
        this.appendHealthLog('rolling_clip_prune_with_quota_free', {
          pruned: pr,
          reason: r
        });
      } else if (rollingFreed <= 0) {
        this._persistIoFailGcStreak = (this._persistIoFailGcStreak || 0) + 1;
        if (this._persistIoFailGcStreak >= 12) {
          this.activateFileQuotaCircuitBreaker('persist_io_fail_gc_exhausted');
        }
      }
    }
  },
  /**
   * 创建高光索引项（立即可回看，不依赖固化完成）。
   * @param {Record<string, unknown>} pending
   * @param {string[]} segments
   * @returns {Record<string, unknown>}
   */
  buildIndexedHighlightItem: function (pending, segments) {
    const replaySegment = segments[segments.length - 1] || segments[0] || '';
    const mc = this.data.matchConfig;
    const scoreA = mc && mc.teamA ? Number(mc.teamA.score || 0) : 0;
    const scoreB = mc && mc.teamB ? Number(mc.teamB.score || 0) : 0;
    const nameA = mc && mc.teamA && mc.teamA.name ? mc.teamA.name : 'A';
    const nameB = mc && mc.teamB && mc.teamB.name ? mc.teamB.name : 'B';
    const colorA = mc && mc.teamA && mc.teamA.bgColor ? mc.teamA.bgColor : '#E64340';
    const colorB = mc && mc.teamB && mc.teamB.bgColor ? mc.teamB.bgColor : '#10AEFF';
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
      replayMediaStopAtSec: typeof pending.replayMediaStopAtSec === 'number' ? pending.replayMediaStopAtSec : null,
      replayChainPart2StopAtSec: typeof pending.replayChainPart2StopAtSec === 'number' ? pending.replayChainPart2StopAtSec : null,
      replayTailTrim: !!pending.replayTailTrim,
      seekMode: pending.seekMode || '',
      clickTime: typeof pending.clickTime === 'number' ? pending.clickTime : pending.createdAt,
      segmentWallDurationMs: typeof pending.segmentWallDurationMs === 'number' ? pending.segmentWallDurationMs : null,
      windowStartInSegMs: typeof pending.windowStartInSegMs === 'number' ? pending.windowStartInSegMs : pending.trimDiagnostic && typeof pending.trimDiagnostic.windowStartInSegMs === 'number' ? pending.trimDiagnostic.windowStartInSegMs : null,
      windowEndInSegMs: typeof pending.windowEndInSegMs === 'number' ? pending.windowEndInSegMs : pending.trimDiagnostic && typeof pending.trimDiagnostic.windowEndInSegMs === 'number' ? pending.trimDiagnostic.windowEndInSegMs : null,
      trimDiagnostic: pending.trimDiagnostic && typeof pending.trimDiagnostic === 'object' ? pending.trimDiagnostic : null,
      replayManifest: pending.replayManifest || null,
      replayPlan: Array.isArray(pending.replayPlan) ? pending.replayPlan.slice() : [],
      replayWindowStartTime: typeof pending.replayWindowStartTime === 'number' ? pending.replayWindowStartTime : null,
      replayWindowEndTime: typeof pending.replayWindowEndTime === 'number' ? pending.replayWindowEndTime : null,
      status: 'indexed',
      scoreA,
      scoreB,
      nameA,
      nameB,
      colorA,
      colorB,
      isVkTimeshift: !!pending.isVkTimeshift
    };
  },
  /**
   * 入队一个高光固化任务并触发后台执行。
   * @param {Record<string, unknown>} task
   * @returns {void}
   */
  enqueueHighlightMaterializeTask: function (task) {
    this.highlightMaterializeQueue.push(task);
    this.processHighlightMaterializeQueue();
  },
  /**
   * 后台串行执行高光固化队列（带降级暂停与退避）。
   * @returns {void}
   */
  processHighlightMaterializeQueue: function () {
    if (this.highlightMaterializeRunning) return;
    if (!this.highlightMaterializeQueue.length) return;
    const watermark = this.evaluateStorageWatermark();
    const urgentHide = !!this._highlightMaterializeUrgentOnHide;
    const urgentReplay = !!this._highlightMaterializeUrgentForReplay;
    if (this.data.isReplaying && !urgentHide) {
      if (this._highlightMaterializeReplayDeferTimer) {
        clearTimeout(this._highlightMaterializeReplayDeferTimer);
      }
      this._highlightMaterializeReplayDeferTimer = setTimeout(() => {
        this._highlightMaterializeReplayDeferTimer = null;
        this.processHighlightMaterializeQueue();
      }, REPLAY_MATERIALIZE_DEFER_POLL_MS);
      return;
    }
    if ((!this.canMaterializeHighlightNow() || watermark >= 85) && !urgentHide && !urgentReplay) {
      setTimeout(() => this.processHighlightMaterializeQueue(), 1200);
      return;
    }
    const task = this.highlightMaterializeQueue.shift();
    if (!task) return;
    this.highlightMaterializeRunning = true;
    this._highlightMaterializeCurrentId = task.id != null ? String(task.id) : '';
    this.materializeHighlightTask(task).catch(() => Promise.resolve()).finally(() => {
      this.highlightMaterializeRunning = false;
      this._highlightMaterializeCurrentId = '';
      if (!this.highlightMaterializeQueue.length) {
        this._highlightMaterializeUrgentOnHide = false;
        this._highlightMaterializeUrgentForReplay = false;
      }
      let gap = 0;
      if (this.data.isRecording) gap = Math.max(gap, 650);
      if (this.data.isRecording && (this.segmentCounter || 0) > 32) {
        gap = Math.max(gap, 840);
      }
      if (!this.data.drawerMode) gap = Math.max(gap, 320);
      setTimeout(() => this.processHighlightMaterializeQueue(), gap);
    });
  },
  /**
   * MOD: 点击高光只记录时间窗口和索引元数据，不 stopRecord、不复制文件。
   * @param {Record<string, unknown>} [meta]
   * @returns {void}
   */
  onHighlightClick: function (meta) {
    const m = meta && typeof meta === 'object' ? meta : {};
    if (this._recorderCore) {
      return this._recorderCore.setPendingHighlight(m);
    }
    const now = Date.now();
    const clickTime = typeof m.clickTime === 'number' ? m.clickTime : now;
    this.pendingHighlight = this._highlightManager ? this._highlightManager.createRequest(Object.assign({}, m, {
      clickTime
    })) : {
      clickTime: clickTime,
      startTime: clickTime - (this.highlightLeadMs || 8000),
      endTime: clickTime + (this.highlightTailMs || 0),
      id: m.id || String(now),
      createdAt: clickTime,
      matchName: m.matchName || this.data.matchConfig && this.data.matchConfig.matchName || '未命名比赛',
      matchId: m.matchId || this.resolveMatchIdForHighlightStorage(),
      cover: m.cover || this.data.defaultCover
    };
    this.pendingHighlight.matchName = m.matchName || this.data.matchConfig && this.data.matchConfig.matchName || this.pendingHighlight.matchName;
    this.pendingHighlight.matchId = m.matchId || this.resolveMatchIdForHighlightStorage() || this.pendingHighlight.matchId;
    this.pendingHighlight.cover = m.cover || this.data.defaultCover || this.pendingHighlight.cover;
  },
  /**
   * MOD: 安全时机调度高光生成。
   * 过去 8s 模式下，只要“包含 clickTime 的当前段”已经 stop+flush 完成并入 rolling buffer，
   * 就可以生成高光；不再等待未来片段。
   * @returns {void}
   */
  _tryGenerateHighlight: function () {
    if (!this.pendingHighlight) return;
    const pending = this.pendingHighlight;
    const clickTime = pending.clickTime || Date.now();
    const leadMs = this.highlightLeadMs || 8000;
    if (this._previewRecordPipeline) {
      const seekPlan = this._previewRecordPipeline.resolveHighlightSeek(clickTime, leadMs);
      if (seekPlan && seekPlan.path) {
        this._previewRecordPipeline.pinPaths([seekPlan.path]);
        this.finalizeHighlight({
          id: pending.id || String(Date.now()),
          createdAt: pending.createdAt || clickTime,
          matchName: pending.matchName || '未命名比赛',
          matchId: pending.matchId || this.resolveMatchIdForHighlightStorage(),
          cover: pending.cover || this.data.defaultCover,
          finalizing: false,
          preSegments: [seekPlan.path],
          postSegments: [],
          replayInitialTimeSec: seekPlan.replayInitialTimeSec,
          replayUseChain: false,
          replayMediaStopAtSec: seekPlan.replayMediaStopAtSec,
          replayChainPart2StopAtSec: null,
          replayTailTrim: !!seekPlan.tailTrim,
          seekMode: seekPlan.seekMode || '',
          clickTime: clickTime,
          windowStartInSegMs: typeof seekPlan.windowStartInSegMs === 'number' ? seekPlan.windowStartInSegMs : -1,
          windowEndInSegMs: typeof seekPlan.windowEndInSegMs === 'number' ? seekPlan.windowEndInSegMs : -1,
          trimDiagnostic: seekPlan.trimDiagnostic || null,
          segmentWallDurationMs: typeof seekPlan.wallDurationMs === 'number' ? seekPlan.wallDurationMs : 0,
          replayPlan: [{
            path: seekPlan.path,
            initialTimeSec: seekPlan.replayInitialTimeSec,
            stopAtSec: seekPlan.replayMediaStopAtSec,
            index: 0
          }]
        });
        this.pendingHighlight = null;
        if (this._recorderCore) this._recorderCore.clearPendingHighlight();
        return;
      }
    }
    const {
      startTime,
      endTime
    } = pending;
    const epoch = this._rollingPipelineEpoch || 0;
    const covered = (this.rollingSegments || []).some(seg => seg && seg.path && seg.startTime <= endTime && seg.endTime >= endTime && (seg.pipelineEpoch === undefined || seg.pipelineEpoch === epoch));
    if (!covered) return;
    this._generateHighlight(startTime, endTime, pending);
    this.pendingHighlight = null;
  },
  /**
   * MOD: 按时间区间匹配素材段，并计算未来精确裁剪所需 offset。
   * @param {number} startTime
   * @param {number} endTime
   * @param {Record<string, unknown>} [pending]
   * @returns {void}
   */
  _generateHighlight: function (startTime, endTime, pending) {
    const epoch = this._rollingPipelineEpoch || 0;
    const chunks = this._replayBuffer && typeof this._replayBuffer.snapshotWindow === 'function' ? this._replayBuffer.snapshotWindow(startTime, endTime) : (this.rollingSegments || []).filter(seg => seg && seg.path && seg.endTime > startTime && seg.startTime < endTime && (seg.pipelineEpoch === undefined || seg.pipelineEpoch === epoch));
    const coverage = this._validateHighlightChunkCoverage(chunks, startTime, endTime);
    if (!coverage.ok) {
      this._abortHighlightForInsufficientBuffer(pending, coverage);
      return;
    }
    const parts = chunks.map(seg => {
      const clipStart = Math.max(startTime, seg.startTime);
      const clipEnd = Math.min(endTime, seg.endTime);
      return {
        path: seg.path,
        offsetStart: clipStart - seg.startTime,
        offsetEnd: clipEnd - seg.startTime
      };
    });
    const nextPending = pending || {};
    if (this._highlightManager && typeof this._highlightManager.buildManifest === 'function') {
      nextPending.replayManifest = this._highlightManager.buildManifest(nextPending, chunks, parts);
    }
    const gapStats = chunks.reduce((acc, seg, idx) => {
      if (idx > 0) {
        const prev = chunks[idx - 1];
        const gapMs = Math.max(0, seg.startTime - prev.endTime);
        acc.totalGapMs += gapMs;
        acc.maxGapMs = Math.max(acc.maxGapMs, gapMs);
      }
      return acc;
    }, {
      totalGapMs: 0,
      maxGapMs: 0
    });
    this.appendHealthLog('highlight_snapshot_ready', {
      id: nextPending.id || '',
      startTime,
      endTime,
      chunkCount: chunks.length,
      firstStartTime: chunks[0] ? chunks[0].startTime : 0,
      lastEndTime: chunks[chunks.length - 1] ? chunks[chunks.length - 1].endTime : 0,
      totalGapMs: gapStats.totalGapMs,
      maxGapMs: gapStats.maxGapMs
    });
    const paths = parts.map(p => p && p.path).filter(Boolean);
    this._saveHighlight(paths, nextPending, parts);
  },
  /**
   * ReplayBuffer 高光必须覆盖完整时间窗；允许小幅 stop/start 接缝，但不保存明显缺头/断续的半截片段。
   * @param {Array<Record<string, unknown>>} chunks
   * @param {number} startTime
   * @param {number} endTime
   * @returns {{ok:boolean, reason:string, missingStartMs?:number, missingEndMs?:number, gapMs?:number, chunkCount?:number}}
   */
  _validateHighlightChunkCoverage: function (chunks, startTime, endTime) {
    const list = Array.isArray(chunks) ? chunks.filter(seg => seg && seg.path && typeof seg.startTime === 'number' && typeof seg.endTime === 'number').sort((a, b) => a.startTime - b.startTime) : [];
    if (!list.length) {
      return {
        ok: false,
        reason: 'no_chunks',
        chunkCount: 0
      };
    }
    const edgeToleranceMs = 1500;
    const maxGapMs = 1800;
    const first = list[0];
    const last = list[list.length - 1];
    if (first.startTime > startTime + edgeToleranceMs) {
      return {
        ok: false,
        reason: 'missing_window_start',
        missingStartMs: first.startTime - startTime,
        chunkCount: list.length
      };
    }
    if (last.endTime < endTime - edgeToleranceMs) {
      return {
        ok: false,
        reason: 'missing_window_end',
        missingEndMs: endTime - last.endTime,
        chunkCount: list.length
      };
    }
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const cur = list[i];
      const gapMs = cur.startTime - prev.endTime;
      if (gapMs > maxGapMs) {
        return {
          ok: false,
          reason: 'timeline_gap',
          gapMs,
          chunkCount: list.length
        };
      }
    }
    return {
      ok: true,
      reason: 'ok',
      chunkCount: list.length
    };
  },
  /**
   * 素材不足时不保存半截高光，避免用户误以为系统丢画面。
   * @param {Record<string, unknown>} pending
   * @param {Record<string, unknown>} detail
   * @returns {void}
   */
  _abortHighlightForInsufficientBuffer: function (pending, detail) {
    const d = detail || {};
    this.appendHealthLog('highlight_buffer_insufficient', {
      id: pending && pending.id ? String(pending.id) : '',
      reason: d.reason || '',
      missingStartMs: d.missingStartMs || 0,
      missingEndMs: d.missingEndMs || 0,
      gapMs: d.gapMs || 0,
      chunkCount: d.chunkCount || 0
    });
    this.pendingHighlight = null;
    if (this._recorderCore) {
      this._recorderCore.clearPendingHighlight();
    }
    this._showLightHint('素材未满8秒');
    this.endHighlightSaving();
  },
  /**
   * MOD: 保存高光索引；只有这里进入高光持久化队列。
   * @param {string[]} paths
   * @param {Record<string, unknown>} [pending]
   * @param {{path:string,offsetStart:number,offsetEnd:number}[]} [parts]
   * @returns {void}
   */
  _saveHighlight: function (paths, pending, parts) {
    const p = pending || this.pendingHighlight || {};
    if (!Array.isArray(paths) || paths.length === 0) {
      this.appendHealthLog('highlight_finalize_no_segments', {});
      this.pendingHighlight = null;
      this.endHighlightSaving();
      return;
    }
    const firstPart = Array.isArray(parts) && parts.length ? parts[0] : null;
    const lastPart = Array.isArray(parts) && parts.length ? parts[parts.length - 1] : null;
    const replayPlan = (Array.isArray(parts) ? parts : []).map((part, idx) => ({
      path: part.path,
      initialTimeSec: Math.max(0, Number(part.offsetStart || 0) / 1000),
      stopAtSec: Math.max(0.08, Number(part.offsetEnd || 0) / 1000),
      durationSec: null,
      index: idx
    }));
    const replayInitialTimeSec = firstPart ? Math.max(0, firstPart.offsetStart / 1000) : 0;
    const replayMediaStopAtSec = paths.length === 1 && lastPart ? Math.max(0.08, lastPart.offsetEnd / 1000) : null;
    const replayChainPart2StopAtSec = paths.length >= 2 && lastPart ? Math.max(0.08, lastPart.offsetEnd / 1000) : null;
    this.appendHealthLog('highlight_index_ready', {
      id: p.id || '',
      segmentCount: paths.length,
      planCount: replayPlan.length,
      replayInitialTimeSec,
      replayMediaStopAtSec,
      replayChainPart2StopAtSec,
      hasManifest: !!p.replayManifest
    });
    this.finalizeHighlight({
      id: p.id || String(Date.now()),
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : p.clickTime || Date.now(),
      matchName: p.matchName || '未命名比赛',
      matchId: p.matchId || this.resolveMatchIdForHighlightStorage(),
      cover: p.cover || this.data.defaultCover,
      finalizing: false,
      preSegments: paths,
      postSegments: [],
      replayInitialTimeSec,
      replayUseChain: paths.length >= 2,
      replayMediaStopAtSec,
      replayChainPart2StopAtSec,
      replayManifest: p.replayManifest || null,
      replayPlan,
      replayWindowStartTime: typeof p.startTime === 'number' ? p.startTime : null,
      replayWindowEndTime: typeof p.endTime === 'number' ? p.endTime : null
    });
  },
  /**
   * 保存高光：由右下角状态钮在管线为「录制中」（界面显示 REC）时单击触发。
   * MOD: 点击时只记录时间点，不打断 rolling，也不等待/选择 segment index。
   */
  requestHighlightCapture: function () {
    if (this._highlightRequestLock || this.data.isSavingHighlight || this.pendingHighlight) {
      this.appendHealthLog('highlight_request_ignored', {
        reason: this._highlightRequestLock ? 'request_lock' : this.data.isSavingHighlight ? 'saving_highlight' : 'pending_highlight'
      });
      return;
    }
    if (this.data.storageSevereLock) {
      this._showLightHint('请先清理空间');
      try {
        this.appendHealthLog('highlight_skip_storage_severe', {});
      } catch (e) {}
      return;
    }
    if (this.data.isRecovering || this._recoveryLock || !this._cameraInitDone) {
      this.appendHealthLog('highlight_skip_camera_not_ready', {});
      return;
    }
    const nowMs = Date.now();
    if (this._hardRecoverQuarantineUntil && nowMs < this._hardRecoverQuarantineUntil) {
      const remainSec = Math.max(1, Math.ceil((this._hardRecoverQuarantineUntil - nowMs) / 1000));
      this.appendHealthLog('highlight_skip_hard_recover_quarantine', {
        remainMs: this._hardRecoverQuarantineUntil - nowMs,
        hadTimeoutRebuild: !!this._hardRecoverHadTimeoutRebuild
      });
      wx.showToast({
        title: `相机恢复中，约${remainSec}秒后可保存`,
        icon: 'none',
        duration: 2200
      });
      return;
    }
    const highlightGate = this.getPreviewRecordHighlightGate();
    if (!highlightGate.ready) {
      const gateReason = highlightGate.reason || 'unknown';
      if (
        gateReason === 'record_warming'
        || gateReason === 'warmup_until'
        || gateReason === 'no_first_frame'
        || gateReason === 'match_switch_warming'
        || gateReason === 'encoder_not_verified'
        || gateReason === 'encoder_live_warming'
        || gateReason === 'highlight_window_warming'
      ) {
        this.appendHealthLog('highlight_skip_record_warming', {
          reason: gateReason,
          recordAgeMs: highlightGate.recordAgeMs || 0,
          minHighlightMs: highlightGate.minHighlightMs || 0,
          maxAvailableLeadMs: highlightGate.maxAvailableLeadMs || 0,
          remainMs: highlightGate.remainMs || 0,
          afterPageHide: !!this._liveReturnedFromBackground
        });
      } else {
        this.appendHealthLog('highlight_skip_pipeline_not_ready', {
          reason: gateReason,
          recordAgeMs: highlightGate.recordAgeMs || 0,
          minHighlightMs: highlightGate.minHighlightMs || 0
        });
      }
      const remainSec = highlightGate.remainMs ? Math.max(1, Math.ceil(highlightGate.remainMs / 1000)) : 0;
      const gateToastTitle = gateReason === 'encoder_not_verified' || gateReason === 'encoder_live_warming'
        ? '编码器校验中，请稍候...'
        : gateReason === 'guide_visible'
          ? '请先完成新手引导'
          : gateReason === 'match_switch_warming'
            ? remainSec > 0 ? `新场次缓冲中，约${remainSec}秒后可保存` : '新场次缓冲中，请稍后再保存'
            : gateReason === 'highlight_window_warming'
              ? remainSec > 0 ? `录制缓冲中，约${remainSec}秒后可保存` : '录制缓冲中，请稍后再保存'
              : remainSec > 0
                ? this._liveReturnedFromBackground ? `相机恢复中，约${remainSec}秒后可保存` : `相机预热中，约${remainSec}秒后可保存`
                : '相机预热中，请稍后再保存';
      wx.showToast({
        title: gateToastTitle,
        icon: 'none',
        duration: 2200
      });
      this.tryStartRollingWhenCameraReady('highlight_request_blocked');
      return;
    }
    if (this.data.drawerMode > 0) {
      wx.showToast({
        title: '请先关闭抽屉再保存高光',
        icon: 'none'
      });
      return;
    }
    if (this.data.isReplaying) {
      wx.showToast({
        title: '回放中无法保存高光',
        icon: 'none'
      });
      return;
    }
    const currentMatchId = this.resolveMatchIdForHighlightStorage();
    if (!currentMatchId) {
      this.appendHealthLog('highlight_abort_no_match_id', {});
      wx.showToast({
        title: '无法识别比赛场次，请返回首页从赛程卡片进入',
        icon: 'none',
        duration: 2800
      });
      return;
    }
    const now = Date.now();
    const anchorClickTime = now;
    if (this.data.recSyncEnabled && this._recSyncWs && this._recSyncWs.isConnected()) {
      try {
        const triggerId = this._recSyncWs.sendTrigger();
        this.appendHealthLog('rec_trigger_sent', { triggerId: triggerId, recRoomId: this.data.recSyncRoomId });
      } catch (err) {
        console.error('发送同步高光信令失败:', err);
      }
    }
    const matchName = this.data.matchConfig.matchName || '未命名比赛';
    const id = String(now);
    const initialLeadMs = this.highlightLeadMs || 8000;
    const pipeline = this._previewRecordPipeline;
    let leadMs = initialLeadMs;
    if (pipeline && typeof pipeline.getMaxAvailableHighlightLeadMs === 'function') {
      const maxLead = pipeline.getMaxAvailableHighlightLeadMs(now, initialLeadMs);
      if (maxLead > 0 && maxLead < initialLeadMs) {
        leadMs = maxLead;
      }
    } else if (pipeline && typeof pipeline.getSegments === 'function') {
      const segs = pipeline.getSegments();
      const earliestStart = segs.reduce((min, seg) => {
        if (seg && typeof seg.startTime === 'number' && seg.startTime > 0) {
          return Math.min(min, seg.startTime);
        }
        return min;
      }, now);
      const maxAgeMs = now - earliestStart;
      if (maxAgeMs > 0 && maxAgeMs < initialLeadMs) {
        leadMs = maxAgeMs;
      }
    }
    const self = this;
    this.beginHighlightSaving();
    this.vibrate('heavy');
    this.lastHighlightRequestAt = now;
    this._highlightRequestLock = true;
    if (pipeline && typeof pipeline.getSegments === 'function') {
      const liveSnap = pipeline.getSegments().filter(s => s && s.live);
      self._logHighlightTrimDiagnostic('click', {
        highlightId: id,
        clickTime: anchorClickTime,
        leadMs,
        recordingTracks: typeof pipeline.getRecordingTrackCount === 'function' ? pipeline.getRecordingTrackCount() : -1,
        liveTrackCount: liveSnap.length,
        liveTracks: liveSnap.map(s => ({
          trackId: s.trackId || '',
          startTime: s.startTime || 0,
          ageMs: anchorClickTime - (s.startTime || anchorClickTime),
          endTime: s.endTime || 0
        }))
      });
    }
    const finalizeSeekPlan = (seekPlan, sourceTag) => {
      self._highlightRequestLock = false;
      if (!seekPlan || !seekPlan.path) {
        self.appendHealthLog('highlight_request_wait_segment', {
          anchorClickTime,
          rollingActive: !!self.rollingActive,
          source: sourceTag || 'wait',
          recordingTracks: pipeline && typeof pipeline.getRecordingTrackCount === 'function' ? pipeline.getRecordingTrackCount() : -1
        });
        if (sourceTag === 'live_flush') {
          const retryPlan = pipeline && typeof pipeline.resolveHighlightSeek === 'function' ? pipeline.resolveHighlightSeek(anchorClickTime, leadMs) : null;
          if (retryPlan && retryPlan.path) {
            finalizeSeekPlan(retryPlan, 'live_flush_retry');
            return;
          }
          self._recoverAfterHighlightFlushMiss(anchorClickTime);
        }
        const chunkMs = self.pingPongChunkDurationMs || 180000;
        const waitHint = chunkMs >= 45000 ? '正在生成高光…' : '录制缓冲同步中…';
        self._showLightHint(waitHint);
        self.onHighlightClick({
          id,
          matchName,
          matchId: currentMatchId,
          cover: self.data.defaultCover,
          clickTime: anchorClickTime,
          afterMs: 0
        });
        self.tryStartRollingWhenCameraReady('highlight_request');
        const flushProgressMs = Math.min((self.pingPongHighlightFlushMinIntervalMs || 10000) + 6000, 22000);
        self.startHighlightSaveProgressAnim(anchorClickTime, anchorClickTime + flushProgressMs);
        self._tryGenerateHighlight();
        return;
      }
      pipeline.pinPaths([seekPlan.path]);
      const playSec = seekPlan.replayMediaStopAtSec - seekPlan.replayInitialTimeSec;
      const playDurationMs = Math.floor(playSec * 1000);
      if (playDurationMs < MIN_HIGHLIGHT_PLAYABLE_MS) {
        self.appendHealthLog('highlight_abort_window_too_short', {
          playDurationMs,
          minMs: MIN_HIGHLIGHT_PLAYABLE_MS,
          source: sourceTag || 'sync',
          clickTime: anchorClickTime,
          leadMs
        });
        if (typeof pipeline.unpinPaths === 'function') {
          pipeline.unpinPaths([seekPlan.path]);
        }
        self.endHighlightSaving();
        wx.showToast({
          title: '录制缓冲不足，请稍后再保存',
          icon: 'none',
          duration: 2200
        });
        return;
      }
      if (seekPlan.trimDiagnostic && typeof seekPlan.trimDiagnostic === 'object') {
        self._logHighlightTrimDiagnostic('seek', Object.assign({
          highlightId: id,
          source: sourceTag || 'sync'
        }, seekPlan.trimDiagnostic));
      } else {
        self._logHighlightTrimDiagnostic('seek', {
          highlightId: id,
          source: sourceTag || 'sync',
          clickTime: anchorClickTime,
          leadMs: leadMs,
          trimStartMs: Math.floor((seekPlan.replayInitialTimeSec || 0) * 1000),
          trimEndMs: Math.floor((seekPlan.replayMediaStopAtSec || 0) * 1000),
          playDurationMs: Math.floor(playSec * 1000),
          seekMode: seekPlan.seekMode || '',
          tailTrim: !!seekPlan.tailTrim
        });
      }
      self.appendHealthLog('highlight_ping_pong_seek', {
        clickTime: anchorClickTime,
        path: seekPlan.path,
        initialSec: seekPlan.replayInitialTimeSec,
        stopSec: seekPlan.replayMediaStopAtSec,
        playSec: playSec,
        tailTrim: !!seekPlan.tailTrim,
        seekMode: seekPlan.seekMode || '',
        source: sourceTag || 'sync'
      });
      self.finalizeHighlight({
        id,
        createdAt: now,
        matchName,
        matchId: currentMatchId,
        cover: self.data.defaultCover,
        finalizing: false,
        preSegments: [seekPlan.path],
        postSegments: [],
        replayInitialTimeSec: seekPlan.replayInitialTimeSec,
        replayUseChain: false,
        replayMediaStopAtSec: seekPlan.replayMediaStopAtSec,
        replayChainPart2StopAtSec: null,
        replayTailTrim: !!seekPlan.tailTrim,
        seekMode: seekPlan.seekMode || '',
        clickTime: anchorClickTime,
        windowStartInSegMs: typeof seekPlan.windowStartInSegMs === 'number' ? seekPlan.windowStartInSegMs : seekPlan.trimDiagnostic && typeof seekPlan.trimDiagnostic.windowStartInSegMs === 'number' ? seekPlan.trimDiagnostic.windowStartInSegMs : -1,
        windowEndInSegMs: typeof seekPlan.windowEndInSegMs === 'number' ? seekPlan.windowEndInSegMs : seekPlan.trimDiagnostic && typeof seekPlan.trimDiagnostic.windowEndInSegMs === 'number' ? seekPlan.trimDiagnostic.windowEndInSegMs : -1,
        trimDiagnostic: seekPlan.trimDiagnostic || null,
        segmentWallDurationMs: typeof seekPlan.wallDurationMs === 'number' ? seekPlan.wallDurationMs : 0,
        replayPlan: [{
          path: seekPlan.path,
          initialTimeSec: seekPlan.replayInitialTimeSec,
          stopAtSec: seekPlan.replayMediaStopAtSec,
          index: 0
        }]
      });
    };
    if (!pipeline) {
      finalizeSeekPlan(null, 'no_pipeline');
      return;
    }
    const syncPlan = pipeline.resolveHighlightSeek(anchorClickTime, leadMs);
    if (syncPlan && syncPlan.path) {
      finalizeSeekPlan(syncPlan, 'sync_file');
      return;
    }
    const flushPromise = typeof pipeline.flushAndResolveHighlightSeek === 'function' ? pipeline.flushAndResolveHighlightSeek(anchorClickTime, leadMs) : Promise.resolve(null);
    self._showLightHint('正在生成高光…');
    self.startHighlightSaveProgressAnim(anchorClickTime, anchorClickTime + 12000);
    flushPromise.then(flushed => finalizeSeekPlan(flushed, 'live_flush')).catch(err => {
      if (err && err.code === 'HIGHLIGHT_FLUSH_RATE_LIMITED') {
        self._highlightRequestLock = false;
        self.appendHealthLog('highlight_flush_rate_limited', {
          anchorClickTime
        });
        self._showLightHint('操作太频繁，请稍候再试');
        self.endHighlightSaving();
        return;
      }
      finalizeSeekPlan(null, 'flush_fail');
    });
  },
  finalizeHighlight: function (pending) {
    if (!pending || pending.finalizing) return;
    pending.finalizing = true;
    if (pending.timeout) {
      clearTimeout(pending.timeout);
      pending.timeout = null;
    }
    const segments = [...pending.preSegments, ...pending.postSegments].filter(Boolean);
    if (segments.length > 0 && this._highlightResumeGuardTimer) {
      clearTimeout(this._highlightResumeGuardTimer);
      this._highlightResumeGuardTimer = null;
    }
    if (segments.length === 0) {
      this.appendHealthLog('highlight_finalize_no_segments', {});
      if (this._highlightSaveAwaitingResume) {
        this._highlightPipelineDoneFinalize = true;
        this.maybeReleaseHighlightSaveLock();
        if (this._highlightSaveAwaitingResume) {
          this.scheduleHighlightResumeUnlockFallback();
        }
      } else {
        this.endHighlightSaving();
      }
      return;
    }
    let matchId = clipsStorage.normalizeMatchIdKey(pending.matchId);
    if (!matchId) matchId = this.resolveMatchIdForHighlightStorage();
    if (!matchId) {
      pending.finalizing = false;
      this.appendHealthLog('highlight_finalize_missing_match_id', {});
      wx.showToast({
        title: '无法识别场次，高光未保存',
        icon: 'none'
      });
      if (this._highlightSaveAwaitingResume) {
        this._highlightPipelineDoneFinalize = true;
        this.maybeReleaseHighlightSaveLock();
        if (this._highlightSaveAwaitingResume) {
          this.scheduleHighlightResumeUnlockFallback();
        }
      } else {
        this.endHighlightSaving();
      }
      return;
    }
    const item = this.buildIndexedHighlightItem(pending, segments);
    item.matchId = matchId;
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) {
      pending.finalizing = false;
      this.appendHealthLog('highlight_clips_corrupt_read', {});
      wx.showToast({
        title: '高光索引读取失败，请稍后再试',
        icon: 'none'
      });
      if (this._highlightSaveAwaitingResume) {
        this._highlightPipelineDoneFinalize = true;
        this.maybeReleaseHighlightSaveLock();
        if (this._highlightSaveAwaitingResume) {
          this.scheduleHighlightResumeUnlockFallback();
        }
      } else {
        this.endHighlightSaving();
      }
      return;
    }
    if (!clipsMap[matchId]) clipsMap[matchId] = [];
    clipsMap[matchId].unshift(item);
    if (!clipsStorage.writeClipsMapSafe(clipsMap)) {
      pending.finalizing = false;
      this.appendHealthLog('highlight_clips_write_fail', {});
      wx.showToast({
        title: '存储空间不足，高光未保存',
        icon: 'none'
      });
      if (this._highlightSaveAwaitingResume) {
        this._highlightPipelineDoneFinalize = true;
        this.maybeReleaseHighlightSaveLock();
        if (this._highlightSaveAwaitingResume) {
          this.scheduleHighlightResumeUnlockFallback();
        }
      } else {
        this.endHighlightSaving();
      }
      return;
    }
    this.pruneHighlightStorageForMatch(matchId);
    this._enforceHighlightStorageLimit();
    const list = this.getHighlightList();
    list.unshift(item);
    wx.setStorageSync('highlight_list', list);
    this.appendHealthLog('highlight_finalize_indexed', {
      id: String(item.id || ''),
      matchId,
      segmentCount: segments.length,
      planCount: Array.isArray(item.replayPlan) ? item.replayPlan.length : 0,
      hasManifest: !!item.replayManifest,
      status: item.status || ''
    });
    try {
      LIVE_AUDIT.auditHighlight('finalize_indexed', {
        id: String(item.id || ''),
        matchId,
        segmentCount: segments.length,
        seekMode: pending.seekMode || '',
        tailTrim: !!pending.replayTailTrim,
        trimStartMs: typeof pending.replayInitialTimeSec === 'number' ? Math.max(0, Math.floor(pending.replayInitialTimeSec * 1000)) : -1,
        trimEndMs: typeof pending.replayMediaStopAtSec === 'number' ? Math.max(0, Math.floor(pending.replayMediaStopAtSec * 1000)) : -1,
        clickTime: typeof pending.clickTime === 'number' ? pending.clickTime : pending.createdAt,
        windowStartInSegMs: typeof pending.windowStartInSegMs === 'number' ? pending.windowStartInSegMs : -1,
        windowEndInSegMs: typeof pending.windowEndInSegMs === 'number' ? pending.windowEndInSegMs : -1,
        segmentPaths: segments.map(p => typeof p === 'string' ? p.slice(-72) : ''),
        replayInitialTimeSec: pending.replayInitialTimeSec,
        replayMediaStopAtSec: pending.replayMediaStopAtSec
      });
    } catch (eAuditFin) {/* ignore */}
    this.retainRollingSegmentsByPaths(segments);
    const dcFin = this.data.defaultCover;
    const coverRaw = typeof pending.cover === 'string' ? pending.cover : dcFin;
    const coverTempPath = coverRaw !== dcFin && coverRaw.indexOf('data:') !== 0 ? coverRaw : '';
    this.enqueueHighlightMaterializeTask({
      id: pending.id,
      matchId,
      segments: segments.slice(),
      coverTempPath: coverTempPath,
      isVkTimeshift: !!pending.isVkTimeshift,
      tailTrim: !!pending.replayTailTrim,
      tailLeadMs: this.highlightLeadMs || 8000,
      seekMode: pending.seekMode || '',
      clickTime: typeof pending.clickTime === 'number' ? pending.clickTime : pending.createdAt,
      windowStartInSegMs: typeof pending.windowStartInSegMs === 'number' ? pending.windowStartInSegMs : pending.trimDiagnostic && typeof pending.trimDiagnostic.windowStartInSegMs === 'number' ? pending.trimDiagnostic.windowStartInSegMs : -1,
      windowEndInSegMs: typeof pending.windowEndInSegMs === 'number' ? pending.windowEndInSegMs : pending.trimDiagnostic && typeof pending.trimDiagnostic.windowEndInSegMs === 'number' ? pending.trimDiagnostic.windowEndInSegMs : -1,
      trimDiagnostic: pending.trimDiagnostic || null,
      fallbackWallDurationMs: typeof pending.segmentWallDurationMs === 'number' ? pending.segmentWallDurationMs : 0,
      trimStartMs: typeof pending.replayInitialTimeSec === 'number' ? Math.max(0, Math.floor(pending.replayInitialTimeSec * 1000)) : -1,
      trimEndMs: typeof pending.replayMediaStopAtSec === 'number' ? Math.max(0, Math.floor(pending.replayMediaStopAtSec * 1000)) : -1,
      retryCount: 0
    });
    this.highlightMissStreak = 0;
    this.vibrateHighlightSaved();
    this.flashPeriod();
    if (this.data.drawerMode === 1) {
      this.refreshDrawerHighlights();
    }
    if (this._highlightSaveAwaitingResume) {
      this._highlightPipelineDoneFinalize = true;
      this.maybeReleaseHighlightSaveLock();
      if (this._highlightSaveAwaitingResume) {
        this.scheduleHighlightResumeUnlockFallback();
      }
    } else {
      this.endHighlightSaving();
    }
  },
  formatTime: function (ts) {
    const d = new Date(ts);
    const pad = n => `${n}`.padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  },
  getHighlightList: function (matchId) {
    if (matchId) {
      const clipsMap = clipsStorage.readClipsMapSafe();
      if (!clipsMap) return [];
      const key = clipsStorage.normalizeMatchIdKey(matchId);
      return Array.isArray(clipsMap[key]) ? clipsMap[key] : [];
    }
    const raw = wx.getStorageSync('highlight_list');
    return Array.isArray(raw) ? raw : [];
  },
  onBackgroundLongPress: function () {
    if (this.isMultiTouch) return;
    this.openDrawerMode1();
  },
  /**
   * 调试工具条点击切档：
   *  - 机型未通过白名单直接忽略（不应出现，但防御）。
   *  - 用户显式切档走 force，穿透 render-pipeline 的 MIN_SWITCH_GAP_MS 防抖。
   *  - 切档后记录健康日志，便于真机对比时回溯。
   * @param {WechatMiniprogram.TouchEvent} e data-mode: off|standard|strong
   */
  onEnhanceModePick: function () {

    /** 已移除画质增强工具条。 */},
  /** 工具条自身吞事件，避免点胶囊内部时触发遮罩 closeAllDrawers。 */
  stopEnhanceToolbarBubble: function () {},
  /**
   * 启动 1s 轮询把 render-pipeline 的 FPS 拉到 data.enhanceFpsText；
   * 仅在抽屉打开期间运行，避免长驻开销。未启用增强渲染时显示 "— fps"。
   * @returns {void}
   */
  startEnhanceFpsPolling: function () {
    if (!this.data.enhanceWhitelisted || !this.data.enhanceBetaWhitelisted) return;
    if (this._enhanceFpsPollTimer) return;
    var self = this;
    var poll = function () {
      if (!self._livePageVisible || self.data.drawerMode !== 1) {
        self.stopEnhanceFpsPolling();
        return;
      }
      var text = '— fps';
      try {
        var pipeline = self._renderPipeline;
        if (pipeline) {
          var diag = typeof pipeline.diagnostics === 'function' ? pipeline.diagnostics() : null;
          var snap = typeof pipeline.snapshot === 'function' ? pipeline.snapshot() : null;
          var curMode = diag ? diag.mode : self.data.enhanceMode || 'off';
          if (curMode === 'off') {
            text = '已关闭';
          } else if (!diag || diag.framesRendered === 0) {
            text = '⚠ 无帧';
          } else if (diag.sinceLastFrameMs > 1200) {
            text = '⚠ 停滞 ' + Math.round(diag.sinceLastFrameMs / 100) / 10 + 's';
          } else if (snap && typeof snap.avgFps === 'number' && isFinite(snap.avgFps)) {
            text = Math.round(snap.avgFps) + ' fps · ' + diag.framesRendered + '帧';
          } else {
            text = diag.framesRendered + '帧 · 采样中';
          }
        }
      } catch (eSnap) {}
      if (text !== self.data.enhanceFpsText) {
        self.setData({
          enhanceFpsText: text
        });
      }
    };
    poll();
    this._enhanceFpsPollTimer = setInterval(poll, 1000);
  },
  /** @returns {void} */
  stopEnhanceFpsPolling: function () {
    if (this._enhanceFpsPollTimer) {
      clearInterval(this._enhanceFpsPollTimer);
      this._enhanceFpsPollTimer = null;
    }
  },
  /**
   * 快速上手第一步结束，进入抖音直播画幅（16:9）说明。
   * @returns {void}
   */
  onGuideToDyFrame: function () {
    this.setData({
      guideSubStep: 1
    });
  },
  /**
   * 关闭引导并写入已读；两步均视为完成。
   * 引导层盖住原生 camera 时易导致预览黑屏：关闭后须重建 camera 再拉起 rolling。
   * @returns {void}
   */
  dismissGuide: function () {
    const self = this;
    this.setData({
      showGuide: false,
      guideSubStep: 0
    }, () => {
      wx.setStorageSync('hasReadGuide', true);
      if (wx.nextTick) {
        wx.nextTick(() => self._refreshCameraAfterGuideDismiss());
      } else {
        setTimeout(() => self._refreshCameraAfterGuideDismiss(), 0);
      }
    });
  },
  /**
   * 首次引导关闭后刷新相机预览并恢复滚动分段（避免遮罩下 startRecord 导致永久黑屏）。
   * @returns {void}
   */
  _refreshCameraAfterGuideDismiss: function () {
    if (!this._livePageVisible || !this.data.liveStreamAllowed) return;
    this.appendHealthLog('guide_dismiss_camera_refresh', {
      cameraInitDone: !!this._cameraInitDone,
      cameraMounted: !!this.data.cameraMounted
    });
    try {
      this._updateLiveStageLayout();
    } catch (eLayout) {}
    if (this._cameraShowInitWatchTimer) {
      clearTimeout(this._cameraShowInitWatchTimer);
      this._cameraShowInitWatchTimer = null;
    }
    if (this._rollingKickoffTimer) {
      clearTimeout(this._rollingKickoffTimer);
      this._rollingKickoffTimer = null;
    }
    /** 相机已就绪时勿 rebuild，避免 insertCamera 冲突与重复授权弹窗。 */
    if (this._cameraInitDone && this.data.cameraMounted && this.data.cameraContext) {
      if (this.rollingActive) {
        this.tryStartRollingWhenCameraReady('guide_dismiss');
      }
      return;
    }
    this.armNativeEnhanceModeRestoreAfterCameraRebuild('guide_dismiss');
    const self = this;
    this.rebuildCameraComponent(generation => {
      if (!self._livePageVisible || !self.data.liveStreamAllowed) return;
      self.remountCameraComponent({
        generation,
        onMounted: () => {
          if (self.rollingActive) {
            self.tryStartRollingWhenCameraReady('guide_dismiss');
          }
        }
      });
    }, 'guide_dismiss');
  },
  /**
   * 打开抽屉（mode 1）：左侧比赛列表 + 右侧高光缩略图
   */
  openDrawerMode1: function () {
    this.refreshDrawerHighlights();
    this.loadMatchList();
    this.setData({
      drawerMode: 1,
      cameraSettingsOpen: false,
      footballOpsPanelOpen: false,
      quickZoomMenuOpen: false
    });
    // 仅白名单机型内部拉起 FPS 轮询；内部已二次判定，调用幂等
    this.startEnhanceFpsPolling();
  },
  /**
   * 关闭所有抽屉，回到 mode 0
   */
  closeAllDrawers: function () {
    const patch = {};
    if (this.data.drawerMode !== 0) {
      patch.drawerMode = 0;
    }
    if (this.data.aspectModePanelOpen) {
      patch.aspectModePanelOpen = false;
    }
    if (Object.keys(patch).length > 0) {
      this.setData(patch);
    }
    this.stopEnhanceFpsPolling();
  },
  /**
   * 点击镜头工具条「Ads」：展开/收起母比赛 ID 输入面板。
   * @returns {void}
   */
  onPromoLoadTap: function () {
    if (!this.data.autoSyncWhitelisted) {
      return;
    }
    if (this.data.promoAdsPanelOpen) {
      if (!this.data.promoLoadBusy) {
        this.setData({
          promoAdsPanelOpen: false
        });
      }
      return;
    }
    if (this.data.drawerMode === 1) {
      this.stopEnhanceFpsPolling();
    }
    this.setData({
      drawerMode: 0,
      promoAdsPanelOpen: true,
      promoLoadInput: this.data.promoMatchId || ''
    });
  },
  /**
   * 载入推广弹窗：输入母比赛 ID。
   * @param {Object} e
   * @returns {void}
   */
  onPromoLoadInput: function (e) {
    this.setData({
      promoLoadInput: e.detail && e.detail.value !== undefined ? String(e.detail.value) : ''
    });
  },
  /**
   * 轻点遮罩关闭 Ads 输入面板。
   * @returns {void}
   */
  onPromoAdsPanelBackdropTap: function () {
    if (this.data.promoLoadBusy) {
      return;
    }
    this.setData({
      promoAdsPanelOpen: false
    });
  },
  /**
   * 确认载入商业推广 Logo（POST load_promo_ads，字段 promo_match_id）。
   * @returns {void}
   */
  onPromoLoadConfirm: function () {
    const self = this;
    if (self.data.promoLoadBusy) {
      return;
    }
    const id = (self.data.promoLoadInput || '').trim();
    if (!id) {
      wx.showToast({
        title: '请输入母比赛 ID',
        icon: 'none'
      });
      return;
    }
    if (!getToken()) {
      wx.showToast({
        title: '请先登录',
        icon: 'none'
      });
      return;
    }
    self.setData({
      promoLoadBusy: true
    });
    loadPromoAds(id).then(function (body) {
      const rawAds = Array.isArray(body.ads) ? body.ads : [];
      const baseAds = rawAds.map(function (ad, index) {
        const item = ad && typeof ad === 'object' ? ad : {};
        return {
          id: 'promo_ad_' + index,
          brand_name: String(item.brand_name || ''),
          image_url: String(item.image_url || ''),
          width: 1,
          height: 1,
          displayWidth: 1,
          displayHeight: 1,
          scale: 1,
          x: 12 + index % 3 * 140,
          y: 12 + Math.floor(index / 3) * 100
        };
      });
      return Promise.all(baseAds.map(function (entry) {
        const url = entry.image_url;
        if (!url) {
          return Promise.resolve(entry);
        }
        return new Promise(function (resolve) {
          wx.getImageInfo({
            src: url,
            success: function (info) {
              const sized = self._applyPromoAdBaseSize(entry, info.width, info.height);
              resolve(sized);
            },
            fail: function () {
              resolve(entry);
            }
          });
        });
      })).then(function (promoAds) {
        const margin = PROMO_AD_EDGE_MARGIN_PX || 8;
        let currentX = margin;
        const positioned = promoAds.map(function (ad, index) {
          const x = currentX;
          const y = margin;
          currentX += (ad.displayWidth || 0);
          return Object.assign({}, ad, {
            x: x,
            y: y
          });
        });
        self.setData({
          promoLoadBusy: false,
          promoAdsPanelOpen: false,
          promoMatchId: id,
          promoAds: positioned,
          promoAdsVisible: positioned.length > 0
        });
        if (positioned.length === 0) {
          wx.showToast({
            title: '暂无广告 Logo',
            icon: 'none'
          });
        } else {
          wx.showToast({
            title: '已载入 ' + positioned.length + ' 个 Logo',
            icon: 'success'
          });
        }
      });
    }).catch(function (err) {
      self.setData({
        promoLoadBusy: false
      });
      const msg = err && err.message ? err.message : '载入失败';
      wx.showToast({
        title: msg,
        icon: 'none'
      });
    });
  },
  /**
   * 清除已载入的商业推广 Logo。
   * @returns {void}
   */
  onClearPromoAdsTap: function () {
    this.setData({
      promoAds: [],
      promoAdsVisible: false,
      promoMatchId: ''
    });
    wx.showToast({
      title: '已清除推广 Logo',
      icon: 'none'
    });
  },
  /**
   * 初始化本场比赛的本地广告
   */
  _initLocalAds: function () {
    const mc = this.data.matchConfig;
    if (!mc || !Array.isArray(mc.localAds) || mc.localAds.length === 0) {
      return;
    }
    const self = this;
    const baseAds = mc.localAds.map(function (ad, index) {
      return {
        id: ad.id || ('local_ad_' + index),
        brand_name: String(ad.brandName || ad.brand_name || ''),
        image_url: String(ad.path || ad.image_url || ''),
        width: 1,
        height: 1,
        displayWidth: 1,
        displayHeight: 1,
        scale: ad.scale || 1,
        x: ad.x !== undefined ? ad.x : (12 + index % 3 * 140),
        y: ad.y !== undefined ? ad.y : (12 + Math.floor(index / 3) * 100)
      };
    });

    Promise.all(baseAds.map(function (entry) {
      const url = entry.image_url;
      if (!url) {
        return Promise.resolve(entry);
      }
      return new Promise(function (resolve) {
        wx.getImageInfo({
          src: url,
          success: function (info) {
            const sized = self._applyPromoAdBaseSize(entry, info.width, info.height);
            resolve(sized);
          },
          fail: function () {
            resolve(entry);
          }
        });
      });
    })).then(function (promoAds) {
      const margin = PROMO_AD_EDGE_MARGIN_PX || 8;
      let currentX = margin;
      const positioned = promoAds.map(function (ad, index) {
        const defaultX = 12 + index % 3 * 140;
        const defaultY = 12 + Math.floor(index / 3) * 100;
        const x = ad.x !== defaultX ? ad.x : currentX;
        const y = ad.y !== defaultY ? ad.y : margin;
        currentX += (ad.displayWidth || 0);
        return Object.assign({}, ad, {
          x: x,
          y: y
        });
      });
      self.setData({
        promoAds: positioned,
        promoAdsVisible: positioned.length > 0
      });
    });
  },
  /**
   * 推广 Logo 目标展示高度（屏幕高度约 1/10）。
   * @returns {number}
   */
  _getPromoAdTargetHeightPx: function () {
    const sys = wx.getSystemInfoSync();
    const screenH = Math.max(1, Number(sys.windowHeight) || 375);
    return Math.max(20, Math.round(screenH * PROMO_AD_HEIGHT_RATIO));
  },
  /**
   * 推广 Logo 可拖拽区域尺寸（与 16:9 取景框一致）。
   * @returns {{ w: number, h: number }}
   */
  _getPromoMovableAreaSize: function () {
    const sys = wx.getSystemInfoSync();
    return computeLiveStage16x9SizePx(Math.max(1, Number(sys.windowWidth) || 375), Math.max(1, Number(sys.windowHeight) || 667));
  },
  /**
   * 按图片原始比例计算基准尺寸：展示高度不超过屏幕高度 1/10（仅缩小、不放大）。
   * @param {number} naturalWidth
   * @param {number} naturalHeight
   * @returns {{ width: number, height: number }}
   */
  _computePromoAdDisplaySize: function (naturalWidth, naturalHeight) {
    let nw = Math.round(Number(naturalWidth) || 0);
    let nh = Math.round(Number(naturalHeight) || 0);
    if (nw <= 0 || nh <= 0) {
      return {
        width: 0,
        height: 0
      };
    }
    const targetH = this._getPromoAdTargetHeightPx();
    if (nh > targetH) {
      const ratio = targetH / nh;
      nw = Math.max(1, Math.round(nw * ratio));
      nh = targetH;
    }
    return {
      width: nw,
      height: nh
    };
  },
  /**
   * 将推广 Logo 吸附到最近的取景框边缘（仅在拖拽结束后调用一次）。
   * @param {number} idx
   * @returns {void}
   */
  _snapPromoAdToEdge: function (idx) {
    const ads = this.data.promoAds || [];
    const ad = ads[idx];
    if (!ad) {
      return;
    }
    const area = this._getPromoMovableAreaSize();
    const margin = PROMO_AD_EDGE_MARGIN_PX;
    const threshold = PROMO_AD_SNAP_THRESHOLD_PX;
    const viewW = Math.max(1, Number(ad.displayWidth) || 1);
    const viewH = Math.max(1, Number(ad.displayHeight) || 1);
    const maxX = Math.max(margin, area.w - viewW - margin);
    const maxY = Math.max(margin, area.h - viewH - margin);
    let x = typeof ad.x === 'number' ? ad.x : margin;
    let y = typeof ad.y === 'number' ? ad.y : margin;
    const distLeft = x;
    const distTop = y;
    const distRight = area.w - (x + viewW);
    const distBottom = area.h - (y + viewH);
    const minDist = Math.min(distLeft, distTop, distRight, distBottom);
    if (minDist > threshold) {
      return;
    }
    if (minDist === distLeft) {
      x = margin;
    } else if (minDist === distTop) {
      y = margin;
    } else if (minDist === distRight) {
      x = maxX;
    } else {
      y = maxY;
    }
    x = Math.max(margin, Math.min(maxX, Math.round(x)));
    y = Math.max(margin, Math.min(maxY, Math.round(y)));
    if (x === ad.x && y === ad.y) {
      return;
    }
    const patch = {};
    patch['promoAds[' + idx + '].x'] = x;
    patch['promoAds[' + idx + '].y'] = y;
    this.setData(patch);
  },
  /**
   * 拖拽结束后延迟触发边缘吸附（防抖，避免拖动过程中重复 setData）。
   * @param {number} idx
   * @returns {void}
   */
  _schedulePromoAdEdgeSnap: function (idx) {
    const self = this;
    if (self._promoAdSnapTimers == null) {
      self._promoAdSnapTimers = {};
    }
    const key = String(idx);
    if (self._promoAdSnapTimers[key]) {
      clearTimeout(self._promoAdSnapTimers[key]);
    }
    self._promoAdSnapTimers[key] = setTimeout(function () {
      delete self._promoAdSnapTimers[key];
      if (self._promoAdPinching || self._promoAdPinchState) {
        return;
      }
      self._snapPromoAdToEdge(idx);
    }, PROMO_AD_SNAP_DELAY_MS);
  },
  /**
   * 根据基准尺寸与缩放比例计算 movable-view 实际宽高。
   * @param {number} baseWidth
   * @param {number} baseHeight
   * @param {number} scale
   * @returns {{ displayWidth: number, displayHeight: number, scale: number }}
   */
  _computePromoAdScaledSize: function (baseWidth, baseHeight, scale) {
    const baseW = Math.max(1, Math.round(Number(baseWidth) || 1));
    const baseH = Math.max(1, Math.round(Number(baseHeight) || 1));
    let s = Number(scale);
    if (!Number.isFinite(s) || s <= 0) {
      s = 1;
    }
    s = Math.max(PROMO_AD_SCALE_MIN, Math.min(PROMO_AD_SCALE_MAX, s));
    return {
      scale: s,
      displayWidth: Math.max(1, Math.round(baseW * s)),
      displayHeight: Math.max(1, Math.round(baseH * s))
    };
  },
  /**
   * 写入推广 Logo 基准尺寸，并按当前 scale 同步展示尺寸。
   * @param {Record<string, unknown>} entry
   * @param {number} naturalWidth
   * @param {number} naturalHeight
   * @returns {Record<string, unknown>}
   */
  _applyPromoAdBaseSize: function (entry, naturalWidth, naturalHeight) {
    const size = this._computePromoAdDisplaySize(naturalWidth, naturalHeight);
    if (size.width <= 0 || size.height <= 0) {
      return entry;
    }
    const scaled = this._computePromoAdScaledSize(size.width, size.height, typeof entry.scale === 'number' ? entry.scale : 1);
    return Object.assign({}, entry, {
      width: size.width,
      height: size.height,
      scale: scaled.scale,
      displayWidth: scaled.displayWidth,
      displayHeight: scaled.displayHeight
    });
  },
  /**
   * 提交推广 Logo 缩放结果（路径 setData，避免整表重渲染引发回弹）。
   * @param {number} idx
   * @param {number} scale
   * @returns {void}
   */
  _commitPromoAdScale: function (idx, scale) {
    const ads = this.data.promoAds || [];
    const ad = ads[idx];
    if (!ad) {
      return;
    }
    const scaled = this._computePromoAdScaledSize(ad.width, ad.height, scale);
    const patch = {};
    patch['promoAds[' + idx + '].scale'] = scaled.scale;
    patch['promoAds[' + idx + '].displayWidth'] = scaled.displayWidth;
    patch['promoAds[' + idx + '].displayHeight'] = scaled.displayHeight;
    this.setData(patch);
  },
  /**
   * 推广 Logo 图片加载后补齐基准尺寸（getImageInfo 失败时的兜底）。
   * @param {Object} e
   * @returns {void}
   */
  onPromoAdImageLoad: function (e) {
    const idx = Number(e.currentTarget.dataset.index);
    if (Number.isNaN(idx)) {
      return;
    }
    const detail = e.detail || {};
    const ads = (this.data.promoAds || []).slice();
    if (!ads[idx]) {
      return;
    }
    const next = this._applyPromoAdBaseSize(ads[idx], detail.width, detail.height);
    if (next.width === ads[idx].width && next.height === ads[idx].height) {
      return;
    }
    const patch = {};
    patch['promoAds[' + idx + '].width'] = next.width;
    patch['promoAds[' + idx + '].height'] = next.height;
    patch['promoAds[' + idx + '].scale'] = next.scale;
    patch['promoAds[' + idx + '].displayWidth'] = next.displayWidth;
    patch['promoAds[' + idx + '].displayHeight'] = next.displayHeight;
    this.setData(patch);
  },
  /**
   * 推广 Logo movable-view 拖拽位置变更（缩放过程中忽略，避免与捏合冲突）。
   * @param {Object} e
   * @returns {void}
   */
  onPromoAdPositionChange: function (e) {
    if (this._promoAdPinching || this._promoAdPinchState) {
      return;
    }
    const detail = e.detail || {};
    if (detail.source === 'friction') {
      return;
    }
    const idx = Number(e.currentTarget.dataset.index);
    if (Number.isNaN(idx)) {
      return;
    }
    if (typeof detail.x !== 'number' || typeof detail.y !== 'number') {
      return;
    }
    const patch = {};
    patch['promoAds[' + idx + '].x'] = detail.x;
    patch['promoAds[' + idx + '].y'] = detail.y;
    this.setData(patch);
  },
  /**
   * 推广 Logo 双指捏合起始。
   * @param {Object} e
   * @returns {void}
   */
  onPromoAdTouchStart: function (e) {
    const idx = Number(e.currentTarget.dataset.index);
    if (Number.isNaN(idx) || !e.touches || e.touches.length < 2) {
      return;
    }
    const ad = (this.data.promoAds || [])[idx];
    if (!ad) {
      return;
    }
    const dist = this.getDistance(e.touches[0], e.touches[1]);
    if (dist <= 0) {
      return;
    }
    this._promoAdPinching = true;
    this._promoAdPinchState = {
      index: idx,
      startDist: dist,
      startScale: typeof ad.scale === 'number' && ad.scale > 0 ? ad.scale : 1
    };
  },
  /**
   * 推广 Logo 双指捏合缩放（自定义等比缩放，不依赖 movable-view 原生 scale）。
   * @param {Object} e
   * @returns {void}
   */
  onPromoAdTouchMove: function (e) {
    const st = this._promoAdPinchState;
    if (!st || !e.touches || e.touches.length < 2) {
      return;
    }
    const dist = this.getDistance(e.touches[0], e.touches[1]);
    if (st.startDist <= 0 || dist <= 0) {
      return;
    }
    const rawScale = st.startScale * (dist / st.startDist);
    const lastScale = typeof st.lastScale === 'number' ? st.lastScale : st.startScale;
    if (Math.abs(rawScale - lastScale) < 0.015) {
      return;
    }
    st.lastScale = rawScale;
    this._commitPromoAdScale(st.index, rawScale);
  },
  /**
   * 推广 Logo 双指捏合结束。
   * @returns {void}
   */
  onPromoAdTouchEnd: function (e) {
    const self = this;
    const wasPinching = Boolean(self._promoAdPinchState);
    const idx = Number(e && e.currentTarget && e.currentTarget.dataset ? e.currentTarget.dataset.index : NaN);
    setTimeout(function () {
      self._promoAdPinching = false;
      self._promoAdPinchState = null;
      if (!wasPinching && !Number.isNaN(idx)) {
        self._schedulePromoAdEdgeSnap(idx);
      }
    }, 80);
  },
  /** 向后兼容：内部调用 closeDrawer 的地方统一走 closeAllDrawers */
  closeDrawer: function () {
    this.closeAllDrawers();
  },
  stopDrawerBubbling: function () {
    return;
  },
  stopLeftDrawerBubbling: function () {
    return;
  },
  onDrawerBackdropMove: function (e) {
    const touch = e.touches && e.touches[0] ? e.touches[0] : null;
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
  loadMatchList: function () {
    const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    const matches = Array.isArray(raw) ? raw : [];
    const matchList = matches.map(m => ({
      ...m,
      isCurrent: m.id === currentMatchId
    }));
    this.setData({
      matchList,
      matchCount: matchList.length
    });
  },
  /**
   * 点击比赛卡片：关闭抽屉，弹出颜色设置浮层
   * @param {WechatMiniprogram.TouchEvent} e data-id
   */
  openColorModal: function (e) {
    const {
      id
    } = e.currentTarget.dataset;
    const match = this.data.matchList.find(m => m.id === id);
    if (!match) return;
    const cloned = JSON.parse(JSON.stringify(match));
    ['teamA', 'teamB'].forEach(t => {
      if (cloned[t] && typeof cloned[t].bgColor === 'string') {
        cloned[t].bgColor = cloned[t].bgColor.toUpperCase();
      }
    });
    this.setData({
      drawerMode: 0,
      showColorModal: true,
      colorModalMatch: cloned,
      colorModalTeam: 'teamA',
      colorModalCacheRowHint: '正在估算空间…',
      colorModalDownloadCleared: false
    });
    try {
      const {
        estimateClipSegmentsBytesFromStorage
      } = require('../../utils/file-storage-estimate.js');
      estimateClipSegmentsBytesFromStorage().then(bytes => {
        if (!this.data.showColorModal) return;
        const mb = Math.max(0, Math.round(bytes / (1024 * 1024) * 10) / 10);
        const empty = mb < 0.05;
        // 缓存为 0 时将 hint 置空，WXML 的 wx:if 会隐藏整个 Footer 行，用户无需操作
        this.setData({
          colorModalCacheRowHint: empty ? '' : `当前已保存高光约 ${mb} MB，建议开播前下载至相册以腾出空间。`,
          colorModalDownloadCleared: empty
        });
      });
    } catch (eEst) {}
  },
  /**
   * 关闭颜色设置浮层
   */
  closeColorModal: function () {
    this.setData({
      showColorModal: false,
      colorModalMatch: null,
      colorModalCacheRowHint: '',
      colorModalDownloadCleared: false
    });
  },
  /**
   * 将全部高光本地视频保存到系统相册并 unlink，索引保留为「已导出」（小程序内无法直连相册路径回放）。
   * @returns {void}
   */
  onDownloadHighlightsToAlbumAndClearCache: function () {
    const fs = wx.getFileSystemManager();
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) {
      wx.showToast({
        title: '高光索引读取失败',
        icon: 'none'
      });
      return;
    }
    /** @type {{ matchId: string, item: Record<string, unknown>, paths: string[] }[]} */
    const tasks = [];
    Object.keys(clipsMap).forEach(matchId => {
      const list = clipsMap[matchId];
      if (!Array.isArray(list)) return;
      list.forEach(it => {
        if (!it || typeof it !== 'object' || it.exportedToAlbum) return;
        const exportPaths = this._collectHighlightExportPaths(it);
        const segs = Array.isArray(it.segments) ? it.segments.filter(p => p && typeof p === 'string') : [];
        const extra = it.replaySegment && typeof it.replaySegment === 'string' ? [it.replaySegment] : [];
        const merged = exportPaths.length ? exportPaths : [...new Set([...segs, ...extra])];
        if (merged.length === 0) return;
        tasks.push({
          matchId,
          item: it,
          paths: merged
        });
      });
    });
    if (tasks.length === 0) {
      try {
        const {
          estimateClipSegmentsBytesFromStorage,
          estimateUserDataPathUsageBytes,
          getClipStorageHealthHint
        } = require('../../utils/file-storage-estimate.js');
        Promise.all([estimateClipSegmentsBytesFromStorage(), estimateUserDataPathUsageBytes()]).then(([b, userB]) => {
          const mb = Math.max(0, Math.round(b / (1024 * 1024) * 10) / 10);
          const empty = mb < 0.05;
          let hint = null;
          try {
            hint = getClipStorageHealthHint(b, userB);
            this._syncCacheStorageLampData(hint);
          } catch (eHint) {}
          this.setData({
            colorModalCacheRowHint: empty ? '本地高光视频保存约 0 MB，暂无可导出的本地文件。' : `本地高光视频保存约 ${mb} MB，暂无可导出的本地文件。`,
            colorModalDownloadCleared: empty || !!(hint && hint.level !== 'severe')
          });
        });
      } catch (eZ) {}
      wx.showToast({
        title: '无待导出本地文件',
        icon: 'none'
      });
      return;
    }
    const runChain = taskIdx => {
      if (taskIdx >= tasks.length) {
        if (!clipsStorage.writeClipsMapSafe(clipsMap)) {
          wx.showToast({
            title: '索引更新失败',
            icon: 'none'
          });
        }
        this.segmentBuffer = [];
        this.clearStaleRollingFiles().then(() => {
          this.refreshDrawerHighlights();
          this.loadMatchList();
          wx.showToast({
            title: '已保存至相册并清理空间',
            icon: 'success'
          });
          try {
            const {
              estimateClipSegmentsBytesFromStorage,
              estimateUserDataPathUsageBytes,
              getClipStorageHealthHint
            } = require('../../utils/file-storage-estimate.js');
            Promise.all([estimateUserDataPathUsageBytes(), estimateClipSegmentsBytesFromStorage()]).then(([userB, clipB]) => {
              const mb = Math.max(0, Math.round(clipB / (1024 * 1024) * 10) / 10);
              let levelNow = 'severe';
              try {
                const h = getClipStorageHealthHint(clipB, userB);
                levelNow = String(h.level || '').toLowerCase();
                this._syncCacheStorageLampData(h);
                app.globalData.fileStorageEstimate = {
                  clipBytes: clipB,
                  userDataBytes: userB,
                  userDataWalkBytes: h.userDataWalkBytes,
                  effectiveTotalBytes: h.effectiveTotalBytes,
                  clipMb: h.clipMb,
                  totalMb: h.totalMb,
                  userDataWalkMb: h.userDataWalkMb,
                  healthLevel: h.level,
                  hintText: h.hintText,
                  at: Date.now()
                };
                storageEst.writeFileStorageEstimateSnapshot(app.globalData.fileStorageEstimate);
              } catch (eG) {}
              if (this.data.showColorModal) {
                const emptied = mb < 0.05;
                this.setData({
                  colorModalCacheRowHint: `本地高光视频保存约 ${mb} MB，已导出至系统相册。`,
                  colorModalDownloadCleared: emptied || levelNow !== 'severe'
                });
              }
            });
          } catch (eUpd) {}
        });
        return;
      }
      const {
        matchId,
        item,
        paths
      } = tasks[taskIdx];
      let pi = 0;
      const step = () => {
        if (pi >= paths.length) {
          const list = clipsMap[matchId];
          const idx = Array.isArray(list) ? list.findIndex(x => x && String(x.id) === String(item.id)) : -1;
          if (idx >= 0) {
            list[idx].segments = [];
            list[idx].replaySegment = '';
            list[idx].exportedToAlbum = true;
            list[idx].exportedToAlbumAt = Date.now();
          }
          runChain(taskIdx + 1);
          return;
        }
        const p = paths[pi];
        pi += 1;
        wx.saveVideoToPhotosAlbum({
          filePath: p,
          success: () => {
            try {
              fs.unlinkSync(p);
            } catch (eUn) {}
            step();
          },
          fail: () => {
            step();
          }
        });
      };
      step();
    };
    const start = () => runChain(0);
    wx.getSetting({
      success: res => {
        if (res.authSetting['scope.writePhotosAlbum']) {
          start();
        } else {
          wx.authorize({
            scope: 'scope.writePhotosAlbum',
            success: start,
            fail: () => {
              wx.showModal({
                title: '需要相册权限',
                content: '请在设置中允许保存到相册',
                showCancel: false
              });
            }
          });
        }
      }
    });
  },
  /** 阻止颜色浮层内部点击冒泡到遮罩关闭 */
  stopColorModalBubbling: function () {
    return;
  },
  /**
   * 严重存储自定义浮层：用户点「知道了」关闭。
   * @returns {void}
   */
  onStoragePressureModalDismiss: function () {
    this.setData({
      showStoragePressureModal: false
    });
  },
  /**
   * 严重存储自定义浮层：跳转与 `wx.showModal` 确认一致，执行下载并清空。
   * @returns {void}
   */
  onStoragePressureModalConfirm: function () {
    this.setData({
      showStoragePressureModal: false
    });
    this.onDownloadHighlightsToAlbumAndClearCache();
  },
  /**
   * 浮层中选中队伍名，切换共用色盘指向
   * @param {WechatMiniprogram.TouchEvent} e data-team
   */
  onSelectModalTeam: function (e) {
    const {
      team
    } = e.currentTarget.dataset;
    if (team === 'teamA' || team === 'teamB') {
      this.setData({
        colorModalTeam: team
      });
    }
  },
  /**
   * 从颜色浮层切换场次：更新 currentMatchId 并关闭浮层
   */
  onSwitchMatchFromModal: function () {
    const modal = this.data.colorModalMatch;
    if (!modal || !modal.id) return;

    // 如果已经是当前场次，点击应关闭浮层
    if (modal.isCurrent) {
      this.closeColorModal();
      return;
    }
    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    if (!Array.isArray(raw)) return;
    const idx = raw.findIndex(m => m.id === modal.id);
    if (idx < 0) return;
    const found = raw[idx];
    if (!found.teamA || !found.teamA.name || !found.teamB || !found.teamB.name) {
      wx.showToast({
        title: '该比赛队名不完整',
        icon: 'none'
      });
      return;
    }
    /** 将浮层内最新颜色写回 Storage，再切换场次 */
    raw[idx].teamA = {
      ...found.teamA,
      ...modal.teamA
    };
    raw[idx].teamB = {
      ...found.teamB,
      ...modal.teamB
    };
    wx.setStorageSync('MIAOXIE_MATCHES', raw);
    const merged = raw[idx];
    if (!this.applyMatchSwitchConfig(merged)) return;
    this._resetRollingPipelineForMatchSwitch('switch_match_from_modal');
    this.closeColorModal();
    this.loadMatchList();
    this.refreshDrawerHighlights();
    this.vibrate('medium');
    wx.showToast({
      title: '已切换',
      icon: 'success',
      duration: 800
    });
  },
  /**
   * 修改某场比赛的队服颜色球（点击色球直接生效）
   * @param {WechatMiniprogram.TouchEvent} e data-match-id / data-team / data-color
   */
  onChangeTeamColor: function (e) {
    const {
      color
    } = e.currentTarget.dataset;
    const modal = this.data.colorModalMatch;
    if (!modal) return;
    const matchId = modal.id;
    const team = this.data.colorModalTeam;
    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    if (!Array.isArray(raw)) return;
    const idx = raw.findIndex(m => m.id === matchId);
    if (idx < 0) return;
    const colorUpper = (color || '').toUpperCase();
    const textColor = this.getContrastColor(colorUpper);
    raw[idx][team] = {
      ...raw[idx][team],
      bgColor: colorUpper,
      textColor: textColor
    };
    wx.setStorageSync('MIAOXIE_MATCHES', raw);
    const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    if (matchId === currentMatchId) {
      const updated = this.normalizeMatchConfig(raw[idx]);
      this.setData({
        matchConfig: updated
      });
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
    this.setData({
      colorModalMatch: updatedModal
    });
    this.loadMatchList();
  },
  /**
   * 切换到指定场次，加载数据并关闭抽屉
   * @param {WechatMiniprogram.TouchEvent} e data-id
   */
  onSwitchMatch: function (e) {
    const {
      id
    } = e.currentTarget.dataset;
    if (!id) return;
    const raw = wx.getStorageSync('MIAOXIE_MATCHES');
    if (!Array.isArray(raw)) return;
    const match = raw.find(m => m.id === id);
    if (!match) return;
    if (!match.teamA.name || !match.teamB.name) {
      wx.showToast({
        title: '该比赛队名不完整',
        icon: 'none'
      });
      return;
    }
    if (!this.applyMatchSwitchConfig(match)) return;
    this._resetRollingPipelineForMatchSwitch('switch_match');
    this.closeAllDrawers();
    this.refreshDrawerHighlights();
    this.vibrate('medium');
    wx.showToast({
      title: '已切换',
      icon: 'success',
      duration: 800
    });
  },
  refreshDrawerHighlights: function () {
    const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    const fullList = (this.getHighlightList(currentMatchId) || []).filter(it => it && !it.exportedToAlbum && this._isHighlightItemPlayable(it));
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
        needsCover: !rawCover || rawCover === dc,
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
    this.setData({
      drawerHighlights,
      highlightCount: total
    });
  },
  onDrawerImageError: function (e) {
    const {
      id
    } = e.currentTarget.dataset;
    const dc = this.data.defaultCover;
    const updated = (this.data.drawerHighlights || []).map(it => {
      if (it.id === id) {
        return {
          ...it,
          cover: dc,
          thumbSrc: dc
        };
      }
      return it;
    });
    this.setData({
      drawerHighlights: updated
    });
  },
  onDrawerSelect: function (e) {
    const {
      id
    } = e.currentTarget.dataset;
    const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    const list = this.getHighlightList(currentMatchId);
    const item = list.find(x => x && String(x.id) === String(id));
    if (!item) return;
    if (item.savedToAlbum) {
      wx.showToast({
        title: '已为您节省空间并转存至手机相册，请前往相册观看',
        icon: 'none',
        duration: 3000
      });
      return;
    }
    this.closeAllDrawers();
    this.startReplay(item);
  },
  /**
   * 长按删除高光
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onDeleteHighlight: function (e) {
    const {
      id
    } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除高光',
      content: '确定要永久删除这段高光视频吗？',
      confirmColor: '#E64340',
      success: res => {
        if (res.confirm) {
          this.doDeleteHighlight(id);
        }
      }
    });
  },
  /** 真正执行删除逻辑（双端一致） */
  doDeleteHighlight: function (id) {
    const fs = wx.getFileSystemManager();

    // 1. 处理 MIAOXIE_CLIPS
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) {
      wx.showToast({
        title: '高光索引读取失败',
        icon: 'none'
      });
      return;
    }
    let foundInClips = false;
    for (const matchId in clipsMap) {
      const bucket = clipsMap[matchId];
      if (!Array.isArray(bucket)) continue;
      const idx = bucket.findIndex(x => x && String(x.id) === String(id));
      if (idx >= 0) {
        const item = bucket[idx];
        clipsStorage.collectClipFilePaths(item).forEach(p => {
          try {
            fs.unlinkSync(p);
          } catch (e) {}
        });
        bucket.splice(idx, 1);
        foundInClips = true;
        break;
      }
    }
    if (foundInClips) {
      clipsStorage.writeClipsMapSafe(clipsMap);
    }

    // 2. 处理 legacy highlight_list
    const legacyList = wx.getStorageSync('highlight_list') || [];
    const legacyIdx = legacyList.findIndex(x => x.id === id);
    if (legacyIdx >= 0) {
      const item = legacyList[legacyIdx];
      (item.segments || []).forEach(p => {
        try {
          fs.unlinkSync(p);
        } catch (e) {}
      });
      legacyList.splice(legacyIdx, 1);
      wx.setStorageSync('highlight_list', legacyList);
    }
    wx.showToast({
      title: '已删除',
      icon: 'success'
    });
    this.refreshDrawerHighlights();
  },
  /**
   * 自动将高光保存至相册并删除微信本地缓存（仅针对 VK 模式）
   * @param {object} item 高光对象
   */
  _saveHighlightToAlbumAndClean: function (item, silent) {
    if (!item || !item.isVkTimeshift || item.savedToAlbum) return;
    const src = item.preSegments && item.preSegments[0] || item.replaySegment;
    if (!src) return;
    wx.saveVideoToPhotosAlbum({
      filePath: src,
      success: () => {
        const fs = wx.getFileSystemManager();
        try {
          fs.unlinkSync(src);
        } catch (e) {}
        const clipsMap = clipsStorage.readClipsMapSafe();
        if (clipsMap && clipsMap[item.matchId]) {
          const bucket = clipsMap[item.matchId];
          const target = bucket.find(c => String(c.id) === String(item.id));
          if (target) {
            target.savedToAlbum = true;
            target.preSegments = [];
            clipsStorage.writeClipsMapSafe(clipsMap);
          }
        }
        if (Array.isArray(this.data.highlights)) {
          const updatedHighlights = this.data.highlights.map(h => {
            if (String(h.id) === String(item.id)) {
              return {
                ...h,
                savedToAlbum: true,
                preSegments: []
              };
            }
            return h;
          });
          this.setData({
            highlights: updatedHighlights
          });
        }
        this.refreshDrawerHighlights();
        if (!silent) {

          // 看多次后自动触发的不弹 toast，避免打扰
        }
      },
      fail: err => {

        // 如果用户拒绝授权等，暂不做处理，留待下次播放后再试
      }
    });
  },
  /**
   * 存储超限保护：扫描当前所有已落盘且未转存的 VK 高光，若大于等于 8 个，自动将最老的一个转存相册并清理微信缓存
   */
  _enforceHighlightStorageLimit: function () {
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) return;
    let pendingClips = [];
    for (let mId in clipsMap) {
      if (Array.isArray(clipsMap[mId])) {
        clipsMap[mId].forEach(clip => {
          if (clip.isVkTimeshift && !clip.savedToAlbum) {
            pendingClips.push(clip);
          }
        });
      }
    }
    if (pendingClips.length >= 8) {
      // 找出时间戳最早的（数字越小越早）
      pendingClips.sort((a, b) => a.id - b.id);
      const oldest = pendingClips[0];
      if (oldest) {
        this._saveHighlightToAlbumAndClean(oldest, true);
      }
    }
  },
  /**
   * 进入回放前暂停滚动录制，降低 camera 与 video 并行造成的失败/闪退概率。
   * rollingFsBusy 时必须等待后再继续，禁止调用方在未停录时启动回放（此前会直接导致卡死或微信崩溃）。
   * @param {function(): void} [onPaused] 录制已停止、可安全起播时回调
   * @returns {void}
   */
  /** @region LIVE_REPLAY — 回放、双槽播放、捏合缩放 */
  /**
   * 回放期间是否调整 CFR（已关闭：全速喂帧以保证 rolling 时间轴与高光完整）。
   * @returns {void}
   */
  _applyReplayRecordingCfrThrottle: function () {
    if (!REPLAY_RECORDING_CFR_THROTTLE_ENABLED) return;
  },
  /**
   * 退出回放后恢复 CFR（仅在与 {@link _applyReplayRecordingCfrThrottle} 配对启用时有效）。
   * @returns {void}
   */
  _restoreReplayRecordingCfrThrottle: function () {
    if (!REPLAY_RECORDING_CFR_THROTTLE_ENABLED || !this._replayRecordingCfrThrottled) return;
    const pipeline = this._previewRecordPipeline;
    const restoreFps = this._replaySavedEncoderFps > 0
      ? this._replaySavedEncoderFps
      : (this.pingPongRecordFps || 24);
    if (pipeline && typeof pipeline.resumeCfrFeed === 'function') {
      pipeline.resumeCfrFeed(restoreFps);
    } else if (pipeline && typeof pipeline.setCfrPumpFps === 'function') {
      pipeline.setCfrPumpFps(restoreFps);
    }
    this.appendHealthLog('replay_recording_cfr_restore', {
      fps: restoreFps
    });
    this._replayRecordingCfrThrottled = false;
    this._replaySavedEncoderFps = 0;
  },
  /**
   * 回放结束后恢复 materialize 队列调度。
   * @returns {void}
   */
  _resumeHighlightMaterializeAfterReplay: function () {
    if (this._highlightMaterializeReplayDeferTimer) {
      clearTimeout(this._highlightMaterializeReplayDeferTimer);
      this._highlightMaterializeReplayDeferTimer = null;
    }
    if (this.highlightMaterializeQueue && this.highlightMaterializeQueue.length) {
      setTimeout(() => {
        this.processHighlightMaterializeQueue();
      }, 120);
    }
  },
pauseRollingForReplay: function (onPaused) {
    this._rollingPausedForReplay = false;
    this.appendHealthLog('replay_pause_ui_only', {
      recorderState: this._recorderCore ? this._recorderCore.state : ''
    });
    if (this._recorderCore) {
      this._recorderCore.requestReplayPause('replay', onPaused);
      return;
    }
    if (typeof onPaused === 'function') {
      if (wx.nextTick) wx.nextTick(onPaused);else setTimeout(onPaused, 0);
    }
  },
  /**
   * 退出回放后恢复滚动录制；仅在相机可用且非恢复流程中重启。
   * @returns {void}
   */
  resumeRollingAfterReplay: function () {
    this._rollingPausedForReplay = false;
    this.appendHealthLog('replay_resume_ui_only', {
      recorderState: this._recorderCore ? this._recorderCore.state : ''
    });
    if (this._recorderCore) {
      this._recorderCore.requestReplayResume('replay');
    }
  },
  /**
   * 启动回放，采用双 slot 预加载方案消除链式切换时的黑帧。
   * - slot-a 播放第一段（或单段）；slot-b 同步预加载第二段（如有）。
   * - 切换时只改 replayActiveSlot，两个 video 组件始终在 DOM 中，不触发重新加载。
   * @param {object} item 高光条目
   */
  startReplay: function (item) {
    if (this.data.isSavingHighlight) {
      this._replayDeferredItem = item;
      this.appendHealthLog('replay_deferred_until_highlight_done', {
        id: item && item.id ? String(item.id) : ''
      });
      wx.showToast({
        title: '正在保存高光，完成后自动播放',
        icon: 'none'
      });
      return;
    }
    if (this._needsMaterializedReplay(item)) {
      this._deferReplayUntilMaterialized(item);
      return;
    }
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
    if (item && item.exportedToAlbum) {
      wx.showToast({
        title: '已导出至系统相册，小程序无法直连播放，请到相册查看',
        icon: 'none',
        duration: 3200
      });
      return;
    }
    const replaySource = this._resolveHighlightReplaySource(item);
    if (!replaySource.target) return;
    if (!this._isHighlightItemPlayable(item)) {
      this._rejectHighlightReplayMissingFiles(item);
      return;
    }
    this.pauseRollingForReplay(() => {
      this.startReplayContinue(item);
    });
  },
  /**
   * 在 {@link pauseRollingForReplay} 真正停录后再绑定 video、起播（必须与相机互斥）。
   * @param {object} item 高光条目
   * @returns {void}
   */
  startReplayContinue: function (item) {
    if (!item || typeof item !== 'object') return;
    this._applyReplayRecordingCfrThrottle();
    item = this._normalizeMaterializedReplaySeek(item);
    this._replayActiveItem = item;

    // 递增观看次数并入库
    item.viewCount = (item.viewCount || 0) + 1;
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (clipsMap && clipsMap[item.matchId]) {
      const bucket = clipsMap[item.matchId];
      const target = bucket.find(c => String(c.id) === String(item.id));
      if (target) {
        target.viewCount = item.viewCount;
        clipsStorage.writeClipsMapSafe(clipsMap);
      }
    }
    if (Array.isArray(this.data.highlights)) {
      const updatedHighlights = this.data.highlights.map(h => {
        if (String(h.id) === String(item.id)) return {
          ...h,
          viewCount: item.viewCount
        };
        return h;
      });
      this.setData({
        highlights: updatedHighlights
      });
    }
    const replaySource = this._resolveHighlightReplaySource(item);
    const useChain = replaySource.useChain;
    const paths = replaySource.paths;
    const replayPlan = Array.isArray(replaySource.plan) ? replaySource.plan : [];
    const target = replaySource.target;
    if (!target) return;
    const sourcePaths = useChain ? paths : [target];
    const replayWallDurationMs = typeof item.segmentWallDurationMs === 'number' && item.segmentWallDurationMs > 0 ? item.segmentWallDurationMs : this.highlightPlaybackWindowMs || 8000;
    if (!sourcePaths.every(p => this._isHighlightPathPlayable(p, replayWallDurationMs))) {
      this._rejectHighlightReplayMissingFiles(item);
      return;
    }
    if (this._isHighlightSourceHollow(target, replayWallDurationMs)) {
      this.appendHealthLog('highlight_replay_reject_hollow', {
        id: item.id != null ? String(item.id) : '',
        pathTail: typeof target === 'string' ? target.slice(-72) : '',
        wallDurationMs: replayWallDurationMs
      });
      this._rejectHighlightReplayMissingFiles(item);
      return;
    }
    let replayFileSizeBytes = 0;
    try {
      const st = wx.getFileSystemManager().statSync(target);
      replayFileSizeBytes = st && typeof st.size === 'number' ? st.size : 0;
    } catch (eStat) {}
    this._logHighlightTrimDiagnostic('replay', {
      highlightId: item.id != null ? String(item.id) : '',
      status: item.status || '',
      replayPreTrimmed: !!item.replayPreTrimmed,
      seekMode: item.seekMode || '',
      tailTrim: !!item.replayTailTrim,
      clickTime: typeof item.clickTime === 'number' ? item.clickTime : item.createdAt || 0,
      initialSec: replayPlan[0] && typeof replayPlan[0].initialTimeSec === 'number' ? replayPlan[0].initialTimeSec : typeof item.replayInitialTimeSec === 'number' ? item.replayInitialTimeSec : 0,
      stopSec: replayPlan[0] && typeof replayPlan[0].stopAtSec === 'number' ? replayPlan[0].stopAtSec : typeof item.replayMediaStopAtSec === 'number' ? item.replayMediaStopAtSec : 0,
      pathTail: typeof target === 'string' ? target.slice(-72) : '',
      fileSizeBytes: replayFileSizeBytes,
      fromManifest: !!replaySource.fromManifest
    });
    if (wx.setPageOrientation) {
      wx.setPageOrientation({
        orientation: 'landscape'
      });
    }

    /** 缩短全黑 REPLAY 叠层，首帧略早露出（与 replayIntroDurationMs 可再对齐 WXSS） */
    const introMs = 520;
    const peakMs = 140;
    let initialSec = replayPlan[0] && typeof replayPlan[0].initialTimeSec === 'number' ? replayPlan[0].initialTimeSec : typeof item.replayInitialTimeSec === 'number' ? item.replayInitialTimeSec : 0;
    let replayStopSec = replayPlan[0] && typeof replayPlan[0].stopAtSec === 'number' ? replayPlan[0].stopAtSec : typeof item.replayMediaStopAtSec === 'number' ? item.replayMediaStopAtSec : 0;
    const suspectFakeTrim = this._isReplaySuspectFakeTrim(item, replayFileSizeBytes);
    let mappedRollingSeek = false;
    if ((item.replayPreTrimmed && !suspectFakeTrim) || item.trimVerified === true) {
      initialSec = 0;
      if (typeof item.replayMediaStopAtSec === 'number' && item.replayMediaStopAtSec > 0) {
        replayStopSec = item.replayMediaStopAtSec;
      }
    } else if (item.replayTailTrim && (suspectFakeTrim || typeof target === 'string' && target.indexOf('_rolling/') >= 0)) {
      const wallInitialSec = typeof item.windowStartInSegMs === 'number' && item.windowStartInSegMs >= 0 ? item.windowStartInSegMs / 1000 : initialSec;
      const wallStopSec = typeof item.windowEndInSegMs === 'number' && item.windowEndInSegMs > 0 ? item.windowEndInSegMs / 1000 : replayStopSec;
      const mappedSeek = this._resolveRollingReplaySeek(item, wallInitialSec, wallStopSec);
      initialSec = mappedSeek.initialSec;
      replayStopSec = mappedSeek.stopSec;
      mappedRollingSeek = true;
      this._logHighlightTrimDiagnostic('replay', {
        highlightId: item.id != null ? String(item.id) : '',
        subPhase: suspectFakeTrim ? 'fake_trim_fallback' : 'rolling_seek_map',
        status: item.status || '',
        seekMode: item.seekMode || '',
        suspectFakeTrim,
        encodeStartOffsetMs: mappedSeek.encodeStartOffsetMs,
        initialSec,
        stopSec: replayStopSec,
        pathTail: typeof target === 'string' ? target.slice(-72) : '',
        fileSizeBytes: replayFileSizeBytes
      });
    }

    // VK 模式特殊处理：废弃底层的 initial-time 属性（会因无关键帧导致黑屏报错）
    // 改为从 0 开始播，由业务层在 loadedmetadata/bindplay 中强行 seek 过去，并辅以 UI 遮罩
    // Fix: 不再依赖 initialSec > 0 判断；VK 高光始终需要跳到末尾 8s，
    // 即使 startTimeSec=0（短片段），loadedmetadata 拿到 duration 后会用 duration-8 计算，
    // 得到 0 也是正确退化行为（从头播就是高光起点）。
    this._vkDelayedSeekTarget = null;
    this._vkSeekDone = false;
    let showFastForwardMask = false;
    const isVk = !!item.isVkTimeshift;
    this._isVkTimeshift = isVk; // 使用私有变量规避 setData 异步延迟风险
    this._vkSeekConfirmed = false; // 重置系统级校验锁
    this._vkSeekTarget = 0;
    this._replayStopAtMediaSec = 0;
    if (isVk) {
      this._vkDelayedSeekTarget = 'pending';
      showFastForwardMask = false; // 直接显示快进过程，去掉遮罩
      initialSec = 0;
    }

    /** 第一段路径与第二段路径（链式时预加载，单段为空） */
    const firstPath = useChain ? paths[0] : target;
    const secondPath = useChain && paths.length >= 2 ? paths[1] : '';
    const secondInitialSec = useChain && replayPlan[1] && typeof replayPlan[1].initialTimeSec === 'number' ? replayPlan[1].initialTimeSec : 0;
    const segLenSec = (this.highlightPlaybackWindowMs || 8000) / 1000;
    const winSec = (this.highlightPlaybackWindowMs || 8000) / 1000;
    if (mappedRollingSeek && replayStopSec > initialSec + 0.08) {
      this._replayStopAtMediaSec = replayStopSec;
    } else if (typeof item.replayMediaStopAtSec === 'number') {
      const stopAbs = item.replayMediaStopAtSec;
      this._replayStopAtMediaSec = isVk ? stopAbs : Math.min(segLenSec, Math.max(stopAbs, initialSec + 0.5));
    } else {
      // VK 模式初始化时不写死 stopAt，等待 loadedmetadata 拿到真实时长后再定
      this._replayStopAtMediaSec = isVk ? 0 : Math.min(segLenSec, initialSec + winSec);
    }
    if (typeof item.replayChainPart2StopAtSec === 'number') {
      this._replayChainPart2StopAt = isVk ? item.replayChainPart2StopAtSec : Math.min(segLenSec, item.replayChainPart2StopAtSec);
    } else {
      this._replayChainPart2StopAt = null;
    }
    if (replayPlan.length && !mappedRollingSeek) {
      const firstStop = replayPlan[0] && typeof replayPlan[0].stopAtSec === 'number' ? replayPlan[0].stopAtSec : null;
      this._replayStopAtMediaSec = firstStop;
      this._replayChainPart2StopAt = replayPlan[1] && typeof replayPlan[1].stopAtSec === 'number' ? replayPlan[1].stopAtSec : null;
    }
    const coldReplay = !isVk && useChain && Number(item.viewCount || 0) <= 1;
    this._replayPrimeHoldMs = useChain && !isVk ? coldReplay ? 320 : 180 : 120;
    this._replaySwitchFallbackMs = useChain && !isVk ? coldReplay ? 320 : 240 : 420;
    this._replayIntroGuardActive = coldReplay && initialSec > 0.04;
    this._replayIntroGuardTargetSec = this._replayIntroGuardActive ? initialSec : 0;
    this.appendHealthLog('replay_source_selected', {
      id: item && item.id ? String(item.id) : '',
      fromManifest: !!replaySource.fromManifest,
      useChain,
      pathCount: paths.length,
      planCount: replayPlan.length,
      initialSec,
      firstStopAtSec: this._replayStopAtMediaSec,
      secondInitialSec,
      secondStopAtSec: this._replayChainPart2StopAt,
      coldReplay,
      primeHoldMs: this._replayPrimeHoldMs,
      switchFallbackMs: this._replaySwitchFallbackMs,
      introGuard: !!this._replayIntroGuardActive,
      introGuardTargetSec: this._replayIntroGuardTargetSec
    });
    this._cancelReplayZoomAnim();
    this._replayDoubleTapLast = null;
    this._replayMultiTouchActive = false;
    this._replayHadMultiTouchThisGesture = false;
    this._replayPinchFormulaUntil = 0;
    this._replayPinchSnapSession = false;
    this._replayPinchBaselineScale = 1;
    this._clearReplayPinchSnapTimer();
    this._resetReplayTransformCache();
    this.setData({
      showReplayMask: true,
      replayMaskText: 'REPLAY',
      replayMaskKind: 'replay',
      replayFastForwarding: showFastForwardMask,
      // 追加快进遮罩状态
      isVkTimeshift: isVk,
      // 记录当前是否为 VK 模式，用于后续逻辑隔离
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
      replayHighlightPlan: replayPlan,
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
        replayHighlightPlan: replayPlan,
        replayHighlightIndex: 0,
        replayActiveSlot: 0,
        replaySlotASrc: firstPath,
        replaySlotAInitialTime: initialSec,
        replaySlotBSrc: secondPath,
        replaySlotBInitialTime: secondInitialSec
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
      if (this._replayIntroGuardActive) {
        this._replayMaskHideTimer = setTimeout(() => {
          this._replayMaskHideTimer = null;
          this._releaseReplayIntroMask('guard_timeout', -1);
        }, 900);
        return;
      }
      this._releaseReplayIntroMask('timer', -1);
    }, introMs);
  },
  /**
   * 冷启动首段 initial-time seek 完成前保留 REPLAY 遮罩，避免用户看到起播跳动。
   * @param {string} reason
   * @param {number} currentTime
   * @returns {void}
   */
  _releaseReplayIntroMask: function (reason, currentTime) {
    if (!this.data.showReplayMask || this.data.replayMaskKind !== 'replay') {
      this._replayIntroGuardActive = false;
      return;
    }
    this._replayIntroGuardActive = false;
    this._replayIntroGuardTargetSec = 0;
    this.appendHealthLog('replay_intro_mask_release', {
      reason: reason || '',
      currentTime: typeof currentTime === 'number' ? currentTime : -1
    });
    this.setData({
      showReplayMask: false
    });
  },
  /**
   * 获取当前活跃 slot 对应的 VideoContext id。
   * @returns {string} 'replayVideoA' | 'replayVideoB'
   */
  _activeReplayVideoId: function () {
    return this.data.replayActiveSlot === 1 ? 'replayVideoB' : 'replayVideoA';
  },
  /**
   * 结束回放并播放回到直播的转场（正常播完或用户点击中断）。
   * @param {boolean} stopPlayer 是否立即停止 video（点击中断时为 true）
   */
  finishReplayToLive: function (stopPlayer) {
    this._restoreReplayRecordingCfrThrottle();
    if (this._replayActiveItem) {
      if ((this._replayActiveItem.viewCount || 0) >= 2) {
        this._saveHighlightToAlbumAndClean(this._replayActiveItem, true);
      }
      this._replayActiveItem = null;
    }
    this._replayStopAtMediaSec = null;
    this._replayChainPart2StopAt = null;
    this._replayPrimeHoldMs = 0;
    this._replaySwitchFallbackMs = 0;
    this._replayIntroGuardActive = false;
    this._replayIntroGuardTargetSec = 0;
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
    if (this._vkFastForwardMaskTimer) {
      clearTimeout(this._vkFastForwardMaskTimer);
      this._vkFastForwardMaskTimer = null;
    }
    this._vkDelayedSeekTarget = 0;
    this.setData({
      replayFastForwarding: false
    });
    this._replayPrimedSlot0 = false;
    this._replayPrimedSlot1 = false;
    this._cancelReplayZoomAnim();
    this._replayDoubleTapLast = null;
    this._replayMultiTouchActive = false;
    this._replayHadMultiTouchThisGesture = false;
    this._replayPinchFormulaUntil = 0;
    this._replayPinchSnapSession = false;
    this._replayPinchBaselineScale = 1;
    this._clearReplayPinchSnapTimer();
    this._resetReplayTransformCache();
    if (stopPlayer) {
      try {
        ['replayVideoA', 'replayVideoB'].forEach(vid => {
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
      replayHighlightPlan: [],
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
      this.setData({
        showReplayMask: false,
        replayMaskText: 'REPLAY',
        replayMaskKind: 'replay'
      });
      this.resumeRollingAfterReplay();
      this._resumeHighlightMaterializeAfterReplay();
    }, outroMs);
  },
  /**
   * 活跃 slot 播放结束：链式时切换到预加载好的另一 slot，无需重新加载。
   * 仅在活跃 slot 的 bindended 中调用（通过 data-slot 区分）。
   * @param {number} slotIdx 触发事件的 slot（0=A, 1=B）
   */
  onReplaySlotEnded: function (slotIdx) {
    if (slotIdx !== this.data.replayActiveSlot) return;
    // 双保险：VK 模式下视频自然结束（ended）也必须触发回到直播，弥补 timeupdate 可能的不及时
    if (this._isVkTimeshift || !this.data.replayHighlightChain) {
      this.finishReplayToLive(false);
      return;
    }
    const paths = this.data.replayHighlightPaths || [];
    const plan = Array.isArray(this.data.replayHighlightPlan) ? this.data.replayHighlightPlan : [];
    const currentIdx = this.data.replayHighlightIndex || 0;
    const nextIdx = currentIdx + 1;
    if (nextIdx >= paths.length) {
      this.setData({
        replayHighlightChain: false
      });
      this.finishReplayToLive(false);
      return;
    }
    /** 切换 slot：另一个 slot 已在 src 写入阶段完成预加载，直接翻到最前 */
    const nextSlot = slotIdx === 0 ? 1 : 0;
    const nextNextPath = paths[nextIdx + 1] || '';
    const nextEntry = plan[nextIdx] || {};
    const nextNextEntry = plan[nextIdx + 1] || {};
    const updates = {
      replayHighlightIndex: nextIdx
    };
    /** 仅在有下一段时才改「旧槽」src，避免与切层同一帧把 src 置空导致闪一下 */
    if (nextNextPath) {
      if (slotIdx === 0) {
        updates.replaySlotASrc = nextNextPath;
        updates.replaySlotAInitialTime = typeof nextNextEntry.initialTimeSec === 'number' ? nextNextEntry.initialTimeSec : 0;
      } else {
        updates.replaySlotBSrc = nextNextPath;
        updates.replaySlotBInitialTime = typeof nextNextEntry.initialTimeSec === 'number' ? nextNextEntry.initialTimeSec : 0;
      }
      this._replayPrimedSlot0 = false;
      this._replayPrimedSlot1 = false;
    }
    this._replayStopAtMediaSec = typeof nextEntry.stopAtSec === 'number' ? nextEntry.stopAtSec : null;
    this._replayChainPart2StopAt = typeof nextEntry.stopAtSec === 'number' ? nextEntry.stopAtSec : null;
    this.appendHealthLog('replay_chain_slot_switch', {
      currentIdx,
      nextIdx,
      nextSlot,
      nextInitialSec: typeof nextEntry.initialTimeSec === 'number' ? nextEntry.initialTimeSec : 0,
      nextStopAtSec: this._replayStopAtMediaSec,
      preloadNext: !!nextNextPath
    });
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
          if (ctx && ctx.play) ctx.play();
          if (ctx && ctx.playbackRate) ctx.playbackRate(rate);
        } catch (e) {}
      });
      const fallbackMs = this._replaySwitchFallbackMs || 300;
      this._replayPendingFallbackTimer = setTimeout(() => {
        if (this._replayPendingActiveSlot !== nextSlot) return;
        this._replayPendingActiveSlot = null;
        this._replayPendingFallbackTimer = null;
        this.appendHealthLog('replay_chain_slot_switch_fallback', {
          nextIdx,
          nextSlot,
          fallbackMs
        });
        this.setData({
          replayActiveSlot: nextSlot
        });
        try {
          const oldId = slotIdx === 0 ? 'replayVideoA' : 'replayVideoB';
          const oldCtx = wx.createVideoContext(oldId, this);
          if (oldCtx && oldCtx.pause) oldCtx.pause();
        } catch (e2) {}
      }, fallbackMs);
    });
  },
  /**
   * 链式回放：后台 slot 轻量预热到 manifest 计划起点，促使解码器先出首帧，切换时少黑场。
   * @param {number} slotIdx 0=A, 1=B
   * @returns {void}
   */
  _maybePrimeHiddenChainSlot: function (slotIdx) {
    if (!this.data.isReplaying || !this.data.replayHighlightChain) return;
    const active = this.data.replayActiveSlot;
    const src = slotIdx === 0 ? this.data.replaySlotASrc : this.data.replaySlotBSrc;
    if (!src || active === slotIdx) return;
    if (slotIdx === 0 && this._replayPrimedSlot0) return;
    if (slotIdx === 1 && this._replayPrimedSlot1) return;
    if (slotIdx === 0) this._replayPrimedSlot0 = true;else this._replayPrimedSlot1 = true;
    const id = slotIdx === 0 ? 'replayVideoA' : 'replayVideoB';
    const paths = this.data.replayHighlightPaths || [];
    const plan = Array.isArray(this.data.replayHighlightPlan) ? this.data.replayHighlightPlan : [];
    const srcIdx = paths.indexOf(src);
    const entry = srcIdx >= 0 ? plan[srcIdx] : null;
    const initialSec = entry && typeof entry.initialTimeSec === 'number' ? entry.initialTimeSec : 0;
    const holdMs = this._replayPrimeHoldMs || 180;
    wx.nextTick(() => {
      try {
        const ctx = wx.createVideoContext(id, this);
        const rate = this.data.replayPlaybackRate || 0.75;
        if (ctx && ctx.playbackRate) ctx.playbackRate(rate);
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
            if (c2 && c2.seek) c2.seek(initialSec);
            this.appendHealthLog('replay_hidden_slot_primed', {
              slotIdx,
              srcIdx,
              initialSec,
              holdMs
            });
          } catch (e2) {}
        }, holdMs);
      } catch (e) {}
    });
  },
  /**
   * 待置顶 slot 已推进到可显示时间后，再切换 z-index 并暂停旧槽，避免与解码空窗重叠。
   * @param {number} slotIdx 触发 timeupdate 的 slot
   * @param {WechatMiniprogram.CustomEvent} e
   * @returns {void}
   */
  _onReplaySlotTimeUpdate: function (slotIdx, e) {
    const t = e && e.detail && typeof e.detail.currentTime === 'number' ? e.detail.currentTime : 0;
    if (slotIdx === 0 && this._replayIntroGuardActive && t >= Math.max(0, (this._replayIntroGuardTargetSec || 0) - 0.08)) {
      if (this._replayMaskHideTimer) {
        clearTimeout(this._replayMaskHideTimer);
        this._replayMaskHideTimer = null;
      }
      this._releaseReplayIntroMask('first_frame_ready', t);
    }
    if (this._replayPendingActiveSlot !== slotIdx) return;

    // 如果物理长度太短或算算无需跳转，在此立刻解开遮罩
    if (this._vkDelayedSeekTarget === 0 && this.data.replayFastForwarding) {
      this._vkDelayedSeekTarget = null;
      if (this._vkFastForwardMaskTimer) clearTimeout(this._vkFastForwardMaskTimer);
      this.setData({
        replayFastForwarding: false
      });
    }

    // 监听快进进度，一旦越过目标线，立即解除遮罩
    if (this.data.replayFastForwarding && typeof this._vkDelayedSeekTarget === 'number' && this._vkDelayedSeekTarget >= 0) {
      // 只要到达目标起跳点附近，立即释放 UI，无需等待固定时长
      if (t >= this._vkDelayedSeekTarget - 0.2) {
        if (this._vkFastForwardMaskTimer) clearTimeout(this._vkFastForwardMaskTimer);
        if (this._vkSeekFallbackTimer) clearTimeout(this._vkSeekFallbackTimer);
        this.setData({
          replayFastForwarding: false
        });
        this._vkDelayedSeekTarget = null;
        this._vkSeekConfirmed = true;
      }
    }
    if (t < 0.05) return;
    this._replayPendingActiveSlot = null;
    if (this._replayPendingFallbackTimer) {
      clearTimeout(this._replayPendingFallbackTimer);
      this._replayPendingFallbackTimer = null;
    }
    const oldSlot = slotIdx === 0 ? 1 : 0;
    this.appendHealthLog('replay_active_slot_confirmed', {
      slotIdx,
      currentTime: t
    });
    this.setData({
      replayActiveSlot: slotIdx
    }, () => {
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
  onReplayVideoATimeUpdate: function (e) {
    this._onReplaySlotTimeUpdate(0, e);
    this._enforceReplayHighlightWindow(0, e);
  },
  /**
   * slot-b timeupdate：用于链式切换后待置顶确认。
   * @param {WechatMiniprogram.CustomEvent} e
   */
  onReplayVideoBTimeUpdate: function (e) {
    this._onReplaySlotTimeUpdate(1, e);
    this._enforceReplayHighlightWindow(1, e);
  },
  /**
   * 将高光回放限制在「点击时刻前约 8s」对应的媒体时间窗内，避免播完整段 mp4。
   * 旧索引无新字段时退化为 initial + 8s。
   *
   * @param {number} slotIdx 0=A / 1=B
   * @param {WechatMiniprogram.CustomEvent} e
   * @returns {void}
   */
  _enforceReplayHighlightWindow: function (slotIdx, e) {
    if (!this.data.isReplaying) return;
    if (this.data.replayActiveSlot !== slotIdx) return;
    if (this._replayPendingActiveSlot !== null && this._replayPendingActiveSlot !== undefined) {
      return;
    }
    const t = e && e.detail && typeof e.detail.currentTime === 'number' ? e.detail.currentTime : 0;
    const chain = this.data.replayHighlightChain;
    const idx = this.data.replayHighlightIndex || 0;
    if (chain) {
      const paths = this.data.replayHighlightPaths || [];
      const plan = Array.isArray(this.data.replayHighlightPlan) ? this.data.replayHighlightPlan : [];
      const entry = plan[idx] || {};
      const lim = typeof entry.stopAtSec === 'number' ? entry.stopAtSec : idx === 1 ? this._replayChainPart2StopAt : null;
      const isLastChainPart = idx >= paths.length - 1;
      const durationSec = typeof entry.durationSec === 'number' ? entry.durationSec : null;
      const reachesNaturalEnd = !isLastChainPart && durationSec !== null && lim >= durationSec - 0.18;
      const guardSec = isLastChainPart ? 0.12 : 0.04;
      if (typeof lim === 'number' && lim > 0.04 && !reachesNaturalEnd && t >= lim - guardSec) {
        if (isLastChainPart) {
          this.appendHealthLog('replay_plan_stop', {
            idx,
            slotIdx,
            currentTime: t,
            stopAtSec: lim
          });
          this.finishReplayToLive(false);
        } else {
          this.appendHealthLog('replay_chain_plan_advance', {
            idx,
            slotIdx,
            currentTime: t,
            stopAtSec: lim
          });
          this.onReplaySlotEnded(slotIdx);
        }
      }
      return;
    }
    if (!chain) {
      // VK 模式防护：使用私有变量判断，绕过异步 data 延迟
      if (this._isVkTimeshift) {
        // ✅ 系统级保险：判定是否越过起跳线（允许 0.3s 误差）
        if (!this._vkSeekConfirmed) {
          if (t >= this._vkSeekTarget - 0.3) {
            this._vkSeekConfirmed = true;
          } else {
            return; // ❗未越过目标点前，禁止进入结束逻辑
          }
        }
        // ✅ 提前 250ms 结束（iOS 适配极限优化），给解码与 UI 切换预留更充裕 buffer，确保完全无缝
        if (typeof this._replayStopAtMediaSec === 'number' && this._replayStopAtMediaSec > 0 && t >= this._replayStopAtMediaSec - 0.25) {
          this.finishReplayToLive(false);
        }
        return;
      }
      const lim = this._replayStopAtMediaSec;
      if (typeof lim === 'number' && lim > 0.04 && t >= lim - 0.12) {
        this.finishReplayToLive(false);
      }
    }
  },
  /**
   * slot-a 的 bindended 回调。
   */
  onReplayVideoAEnded: function () {
    this.onReplaySlotEnded(0);
  },
  /**
   * slot-b 的 bindended 回调。
   */
  onReplayVideoBEnded: function () {
    this.onReplaySlotEnded(1);
  },
  /**
   * 兼容旧 WXML bindended="onReplayEnded"（单 video 模式下仍可调用）。
   */
  onReplayEnded: function () {
    this.onReplaySlotEnded(this.data.replayActiveSlot);
  },
  /**
   * 回放中点击屏幕：中断播放并进入直播转场。
   */
  onReplayInterruptTap: function () {
    if (!this.data.isReplaying) return;
    this.finishReplayToLive(true);
  },
  /**
   * 仅对活跃 slot 生效：设置回放倍速。
   * @param {number} slotIdx 触发事件的 slot（0=A, 1=B）
   */
  _applyPlaybackRateToSlot: function (slotIdx) {
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
  _maybeVkSeekOnPlay: function (slotIdx) {
    if (this._vkSeekDone) return;
    if (typeof this._vkDelayedSeekTarget === 'number' && this._vkDelayedSeekTarget > 0 && this.data.replayFastForwarding) {
      this._vkSeekDone = true;
      const id = slotIdx === 0 ? 'replayVideoA' : 'replayVideoB';
      try {
        const ctx = wx.createVideoContext(id, this);
        if (ctx && ctx.seek) {
          ctx.seek(this._vkDelayedSeekTarget);
        }
      } catch (e) {}
    }
  },
  /**
   * slot-a bindplay 回调：设置倍速 + VK seek 兜底。
   */
  onReplayVideoAPlay: function () {
    this._applyPlaybackRateToSlot(0);
    this._maybeVkSeekOnPlay(0);
  },
  /**
   * slot-b bindplay 回调：设置倍速 + VK seek 兜底。
   */
  onReplayVideoBPlay: function () {
    this._applyPlaybackRateToSlot(1);
    this._maybeVkSeekOnPlay(1);
  },
  /**
   * 兼容旧 WXML bindplay="onReplayVideoPlay"。
   */
  onReplayVideoPlay: function () {
    this._applyPlaybackRateToSlot(this.data.replayActiveSlot);
    this._maybeVkSeekOnPlay(this.data.replayActiveSlot);
  },
  /**
   * 对 loadedmetadata 处理：VK seek + 旋转检测。
   * Fix: VK seek 分支移到 slot guard 之前——seek 不应受 replayActiveSlot 的状态限制，
   * 因为 slot 赋值（setData）与 video 事件触发存在异步竞态，可能导致 guard 误杀 seek。
   * @param {WechatMiniprogram.CustomEvent} e
   * @param {number} slotIdx 触发事件的 slot（0=A, 1=B）
   */
  _handleReplayLoadedMeta: function (e, slotIdx) {
    const detail = e && e.detail || {};

    // VK seek：不受 slot guard 限制，仅检查 _vkDelayedSeekTarget 状态。
    // loadedmetadata 阶段拿到 duration 后立即计算目标，发出第一次 seek。
    // 第二次 seek 在 bindplay 回调中由 _maybeVkSeekOnPlay 兜底（iOS seek 延迟生效）。
    if (this._vkDelayedSeekTarget === 'pending' && detail.duration) {
      const dur = Number(detail.duration);
      // 工程防护：校验 duration 有效性，防止 0/NaN 导致秒切或计算错误
      if (dur > 0.5 && isFinite(dur)) {
        // 跳转到倒数 10 秒处
        const target = Math.max(0, dur - 10);
        this._vkSeekTarget = target;
        this._vkSeekConfirmed = false;
        this._vkDelayedSeekTarget = target;
        this._vkSeekDone = false; // 让 bindplay 还能再 seek 一次

        // 核心修正：同步更新停止点为视频实际终点，确保 seek 后能完整播放到尾部
        this._replayStopAtMediaSec = dur;
        this.setData({
          replaySlotAInitialTime: target
        });
        try {
          const id = slotIdx === 0 ? 'replayVideoA' : 'replayVideoB';
          const ctx = wx.createVideoContext(id, this);
          if (ctx && ctx.seek) {
            ctx.seek(target);
            // ✅ 系统级超时兜底：防止某些极低性能机型不触发 bindseeked/timeupdate 导致死锁
            if (this._vkSeekFallbackTimer) clearTimeout(this._vkSeekFallbackTimer);
            this._vkSeekFallbackTimer = setTimeout(() => {
              this._vkSeekFallbackTimer = null;
              if (this._isVkTimeshift && !this._vkSeekConfirmed) {
                this._vkSeekConfirmed = true;
                this.setData({
                  replayFastForwarding: false
                });
              }
            }, 600);

            // 2.5 秒后强行解除遮罩防卡死（极端安全网）
            if (this._vkFastForwardMaskTimer) clearTimeout(this._vkFastForwardMaskTimer);
            this._vkFastForwardMaskTimer = setTimeout(() => {
              this._vkFastForwardMaskTimer = null;
              this.setData({
                replayFastForwarding: false
              });
            }, 2500);
          }
        } catch (seekErr) {}
      } else {
        // duration 为 0（极短录制），退化为从头播，直接解除遮罩
        this._vkDelayedSeekTarget = 0;
        this._vkSeekDone = true;
        if (this._vkFastForwardMaskTimer) clearTimeout(this._vkFastForwardMaskTimer);
        this.setData({
          replayFastForwarding: false
        });
      }
    }

    // 旋转检测与倍速：仍需 slot guard，避免非活跃 slot 的尺寸信息覆盖活跃 slot
    if (slotIdx !== this.data.replayActiveSlot) return;
    const width = Number(detail.width || 0);
    const height = Number(detail.height || 0);
    const needRotate = width > 0 && height > 0 && height > width;
    const rotateDeg = needRotate ? this.getReplayRotateDegForDevice() : 90;
    this.setData({
      replayVideoNeedRotate: needRotate,
      replayVideoRotateDeg: rotateDeg
    });
    this._applyPlaybackRateToSlot(slotIdx);
  },
  onReplayVideoASeeked: function () {
    this._onReplaySlotSeeked(0);
  },
  onReplayVideoBSeeked: function () {
    this._onReplaySlotSeeked(1);
  },
  _onReplaySlotSeeked: function (slotIdx) {
    if (slotIdx !== this.data.replayActiveSlot) return;
    if (this._isVkTimeshift && this.data.replayFastForwarding) {
      // ✅ 物理级命中信号：一旦 seek 完成，立即打断“定位中”动画，开始播放
      if (this._vkFastForwardMaskTimer) clearTimeout(this._vkFastForwardMaskTimer);
      if (this._vkSeekFallbackTimer) clearTimeout(this._vkSeekFallbackTimer);
      this._vkSeekConfirmed = true;
      this.setData({
        replayFastForwarding: false
      });
      this._vkDelayedSeekTarget = null;
    }
  },
  /**
   * slot-a bindloadedmetadata 回调。
   * @param {WechatMiniprogram.CustomEvent} e
   */
  onReplayVideoALoadedMeta: function (e) {
    this._maybePrimeHiddenChainSlot(0);
    this._handleReplayLoadedMeta(e, 0);
  },
  /**
   * slot-b bindloadedmetadata 回调。
   * @param {WechatMiniprogram.CustomEvent} e
   */
  onReplayVideoBLoadedMeta: function (e) {
    this._maybePrimeHiddenChainSlot(1);
    this._handleReplayLoadedMeta(e, 1);
  },
  /**
   * 兼容旧 WXML bindloadedmetadata="onReplayVideoLoadedMeta"。
   * @param {WechatMiniprogram.CustomEvent} e
   */
  onReplayVideoLoadedMeta: function (e) {
    this._handleReplayLoadedMeta(e, this.data.replayActiveSlot);
  },
  /**
   * 根据设备品牌选择回放旋转方向。
   * 仅对小米系设备做反向旋转修正，避免影响 iPhone 与其他安卓机型。
   * @returns {number} 90 或 -90
   */
  getReplayRotateDegForDevice: function () {
    try {
      const sys = wx.getSystemInfoSync();
      const brand = String(sys && sys.brand || '').toLowerCase();
      const model = String(sys && sys.model || '').toLowerCase();
      const isXiaomi = brand.indexOf('xiaomi') >= 0 || brand.indexOf('redmi') >= 0 || model.indexOf('xiaomi') >= 0 || model.indexOf('redmi') >= 0;
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
  onReplaySpeedChange: function (e) {
    const rate = parseFloat(e.currentTarget.dataset.rate);
    if (!rate || isNaN(rate)) return;
    const muted = rate < 1.0;
    this.setData({
      replayPlaybackRate: rate,
      replayMuted: muted
    });
    this._applyPlaybackRateToSlot(this.data.replayActiveSlot);
  },
  /**
   * 专用退出键：中断回放并进入直播转场。
   * @returns {void}
   */
  onReplayClose: function () {
    if (!this.data.isReplaying) return;
    this.finishReplayToLive(true);
  },
  /**
   * 一键重置 movable-view 的缩放与位置至初始状态（scale=1，x=0，y=0）。
   * @returns {void}
   */
  onReplayResetView: function () {
    this._cancelReplayZoomAnim();
    this._clearReplayPinchSnapTimer();
    this._replayDoubleTapLast = null;
    this._replayMultiTouchActive = false;
    this._replayHadMultiTouchThisGesture = false;
    this._replayPinchFormulaUntil = 0;
    this._replayPinchSnapSession = false;
    this._replayPinchBaselineScale = 1;
    this._resetReplayTransformCache();
    this.setData({
      replayViewScale: 1,
      replayViewX: 0,
      replayViewY: 0
    });
  },
  /**
   * 拖动 movable-view 时同步 x/y；双指过程中不同步，避免与 bindscale 的 x/y 打架。
   * @param {WechatMiniprogram.CustomEvent} e detail.x / detail.y / detail.source
   * @returns {void}
   */
  onReplayViewChange: function (e) {
    if (this._replayZoomAnimating) return;
    const d = e && e.detail || {};
    if (typeof d.x !== 'number' || typeof d.y !== 'number') return;
    if (isNaN(d.x) || isNaN(d.y)) return;
    if (d.source === 'touch') {
      // 单指拖动回调到达时，强制解除多指锁，避免「捏合后无法拖动」。
      this._replayMultiTouchActive = false;
    }
    this._touchReplayMergeCache({
      x: d.x,
      y: d.y
    });
    this.setData({
      replayViewX: d.x,
      replayViewY: d.y
    });
  },
  /**
   * 双指缩放回调：scale 与 x/y 在同一次 setData 提交；
   * 若 detail 自带 x/y 则直接采用，否则用「双指中点 + 焦点公式」推导避免视觉中心偏移。
   * 公式：x_new = x_old - (scale_new/scale_old - 1) * (focalX - x_old)（y 同理）。
   * @param {WechatMiniprogram.CustomEvent} e detail.scale / detail.x / detail.y
   * @returns {void}
   */
  onReplayViewScale: function (e) {
    if (this._replayZoomAnimating) return;
    const d = e && e.detail || {};
    const scaleNew = typeof d.scale === 'number' && !isNaN(d.scale) ? d.scale : 1;
    const prevScale = this.data.replayViewScale || 1;
    if (Math.abs(scaleNew - prevScale) > 0.02) {
      this._replayHadMultiTouchThisGesture = true;
      this._replayMultiTouchActive = true;
    }
    const base = this._replayTransformCache || {
      x: this.data.replayViewX || 0,
      y: this.data.replayViewY || 0,
      scale: this.data.replayViewScale || 1
    };
    const scaleOld = Math.max(0.001, base.scale);
    const vp = this._getReplayViewportPx();
    const w = vp.w;
    const h = vp.h;
    const hasNativeXY = typeof d.x === 'number' && !isNaN(d.x) && typeof d.y === 'number' && !isNaN(d.y);
    const now = Date.now();
    const usePinchFocal = this._replayMultiTouchActive || typeof this._replayPinchFormulaUntil === 'number' && now < this._replayPinchFormulaUntil;
    let xNew;
    let yNew;
    if (hasNativeXY) {
      // 优先使用原生返回的 x/y，避免与内核手势解算冲突导致回弹。
      xNew = d.x;
      yNew = d.y;
    } else if (usePinchFocal) {
      const fx = typeof this._replayPinchFocalX === 'number' && !isNaN(this._replayPinchFocalX) ? this._replayPinchFocalX : w * 0.5;
      const fy = typeof this._replayPinchFocalY === 'number' && !isNaN(this._replayPinchFocalY) ? this._replayPinchFocalY : h * 0.5;
      const ratio = scaleNew / scaleOld;
      xNew = base.x - (ratio - 1) * (fx - base.x);
      yNew = base.y - (ratio - 1) * (fy - base.y);
    } else {
      const fx = w * 0.5;
      const fy = h * 0.5;
      const ratio = scaleNew / scaleOld;
      xNew = base.x - (ratio - 1) * (fx - base.x);
      yNew = base.y - (ratio - 1) * (fy - base.y);
    }
    const cl = this._clampReplayPan(xNew, yNew, scaleNew, w, h);
    this._touchReplayMergeCache({
      x: cl.x,
      y: cl.y,
      scale: scaleNew
    });
    this.setData({
      replayViewScale: scaleNew,
      replayViewX: cl.x,
      replayViewY: cl.y
    });
  },
  /**
   * 捕获阶段 touchstart：双指落下时记录捏合起始 scale，并更新双指中点（供 bindscale 焦点公式与松手居中）。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onReplayPinchCaptureStart: function (e) {
    if (!this.data.isReplaying || this._replayZoomAnimating) return;
    const touches = e && e.touches || [];
    if (touches.length < 2) return;
    this._replayUpdatePinchFocal(touches);
    if (!this._replayPinchSnapSession) {
      this._replayPinchSnapSession = true;
      const t = this._replayTransformCache || {
        scale: this.data.replayViewScale || 1
      };
      this._replayPinchBaselineScale = typeof t.scale === 'number' && !isNaN(t.scale) ? t.scale : 1;
    }
  },
  /**
   * 捕获阶段 touchmove：持续更新双指中点。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onReplayPinchCaptureMove: function (e) {
    if (!this.data.isReplaying || this._replayZoomAnimating) return;
    const touches = e && e.touches || [];
    if (touches.length >= 2) {
      this._replayUpdatePinchFocal(touches);
    }
  },
  /**
   * movable-view 上 touchend：维护捏合尾窗；若本轮为双指捏合，延迟吸附档位并将捏合中心平滑移到屏幕中心。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onReplayMovableTouchEnd: function (e) {
    if (!this.data.isReplaying) return;
    const touches = e && e.touches || [];
    this._replayMultiTouchActive = touches.length >= 2;
    if (touches.length === 0 && this._replayHadMultiTouchThisGesture) {
      this._replayHadMultiTouchThisGesture = false;
      this._replayPinchFormulaUntil = Date.now() + REPLAY_PINCH_SCALE_TAIL_MS;
    }
    if (touches.length === 0 && this._replayPinchSnapSession) {
      this._replayPinchSnapSession = false;
      const self = this;
      this._clearReplayPinchSnapTimer();
      this._replayPinchSnapTimer = setTimeout(() => {
        self._replayPinchSnapTimer = null;
        self._finishReplayPinchSnap();
      }, REPLAY_PINCH_SNAP_DEFER_MS);
    }
  },
  /**
   * movable-view touchcancel：取消待执行的捏合吸附。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onReplayMovableTouchCancel: function (e) {
    this._replayPinchSnapSession = false;
    this._clearReplayPinchSnapTimer();
    this.onReplayMovableTouchEnd(e);
  },
  /**
   * 取消正在进行的双击缩放动画帧。
   * @returns {void}
   */
  _cancelReplayZoomAnim: function () {
    if (this._replayZoomRafId != null) {
      try {
        wx.cancelAnimationFrame(this._replayZoomRafId);
      } catch (err) {}
      this._replayZoomRafId = null;
    }
    this._replayZoomAnimating = false;
  },
  /**
   * 清除捏合松手后延迟执行的 setTimeout，避免退出回放后仍改 scale。
   * @returns {void}
   */
  _clearReplayPinchSnapTimer: function () {
    if (this._replayPinchSnapTimer != null) {
      clearTimeout(this._replayPinchSnapTimer);
      this._replayPinchSnapTimer = null;
    }
  },
  /**
   * 将回放层变换缓存重置为 1x 且左上角对齐。
   * @returns {void}
   */
  _resetReplayTransformCache: function () {
    this._replayTransformCache = {
      x: 0,
      y: 0,
      scale: 1
    };
  },
  /**
   * 合并最近一次 movable-view 的 x/y/scale 到内存缓存（优先于 data，避免节流延迟）。
   * @param {{ x?: number, y?: number, scale?: number }} patch
   * @returns {{ x: number, y: number, scale: number }}
   */
  _touchReplayMergeCache: function (patch) {
    const base = this._replayTransformCache || {
      x: this.data.replayViewX || 0,
      y: this.data.replayViewY || 0,
      scale: this.data.replayViewScale || 1
    };
    this._replayTransformCache = {
      x: typeof patch.x === 'number' ? patch.x : base.x,
      y: typeof patch.y === 'number' ? patch.y : base.y,
      scale: typeof patch.scale === 'number' ? patch.scale : base.scale
    };
    return this._replayTransformCache;
  },
  /**
   * 用双指中点更新捏合焦点（client 坐标，与 x/y 同属视口系）。
   * @param {Array<WechatMiniprogram.Touch>} touches touches.length >= 2
   * @returns {void}
   */
  _replayUpdatePinchFocal: function (touches) {
    if (!touches || touches.length < 2) return;
    const a = touches[0];
    const b = touches[1];
    const vp = this._getReplayViewportPx();
    const offL = typeof vp.left === 'number' ? vp.left : 0;
    const offT = typeof vp.top === 'number' ? vp.top : 0;
    this._replayPinchFocalX = (a.clientX + b.clientX) * 0.5 - offL;
    this._replayPinchFocalY = (a.clientY + b.clientY) * 0.5 - offT;
  },
  /**
   * 读取回放 movable-area 与 live-stage 一致的 16:9 内接框（px）及在窗口内偏移，供平移钳位与捏合焦点换算。
   * @returns {{ w: number, h: number, left: number, top: number }}
   */
  _getReplayViewportPx: function () {
    var winW = 375;
    var winH = 667;
    try {
      if (typeof wx.getWindowInfo === 'function') {
        const wi = wx.getWindowInfo();
        winW = wi.windowWidth || winW;
        winH = wi.windowHeight || winH;
      } else {
        const s = wx.getSystemInfoSync();
        winW = s.windowWidth || winW;
        winH = s.windowHeight || winH;
      }
    } catch (err) {}
    var r = computeLiveStage16x9RectPx(winW, winH);
    return {
      w: r.w,
      h: r.h,
      left: r.left,
      top: r.top
    };
  },
  /**
   * cubic ease-out，t∈[0,1]。
   * @param {number} t
   * @returns {number}
   */
  _easeOutCubic: function (t) {
    const u = 1 - t;
    return 1 - u * u * u;
  },
  /**
   * 根据当前缩放比例得到双击后的下一档比例（1→1.5→…→3→1）。
   * @param {number} s 当前 scale
   * @returns {number}
   */
  _nextReplayDiscreteScale: function (s) {
    for (let i = 0; i < REPLAY_ZOOM_LEVELS.length; i += 1) {
      if (s < REPLAY_ZOOM_LEVELS[i] - REPLAY_ZOOM_LEVEL_EPS) {
        return REPLAY_ZOOM_LEVELS[i];
      }
    }
    return 1;
  },
  /**
   * 取与 s 最接近的离散缩放档位。
   * @param {number} s
   * @returns {number}
   */
  _replayNearestDiscreteLevel: function (s) {
    let best = REPLAY_ZOOM_LEVELS[0];
    let bestD = Infinity;
    for (let i = 0; i < REPLAY_ZOOM_LEVELS.length; i += 1) {
      const lv = REPLAY_ZOOM_LEVELS[i];
      const d = Math.abs(s - lv);
      if (d < bestD) {
        bestD = d;
        best = lv;
      }
    }
    return best;
  },
  /**
   * 取与 s 最接近档位在 REPLAY_ZOOM_LEVELS 中的下标。
   * @param {number} s
   * @returns {number}
   */
  _replayDiscreteLevelIndex: function (s) {
    let bestI = 0;
    let bestD = Infinity;
    for (let i = 0; i < REPLAY_ZOOM_LEVELS.length; i += 1) {
      const d = Math.abs(s - REPLAY_ZOOM_LEVELS[i]);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    return bestI;
  },
  /**
   * 根据捏合起始 scale 与松手时 scale 判定目标档位：明显张开升一档，明显捏拢降一档，否则对齐最近档。
   * 最大档再张开时回到 1x（与双击循环一致）。
   * @param {number} baseline 双指刚落下时的 scale
   * @param {number} endScale 松手时（末帧）scale
   * @returns {number}
   */
  _replayPickPinchSnapScale: function (baseline, endScale) {
    const b = typeof baseline === 'number' && !isNaN(baseline) ? baseline : 1;
    const e = typeof endScale === 'number' && !isNaN(endScale) ? endScale : 1;
    const i0 = this._replayDiscreteLevelIndex(b);
    const last = REPLAY_ZOOM_LEVELS.length - 1;
    if (e > b + REPLAY_PINCH_INTENT_DELTA) {
      if (i0 >= last) return 1;
      return REPLAY_ZOOM_LEVELS[i0 + 1];
    }
    if (e < b - REPLAY_PINCH_INTENT_DELTA) {
      if (i0 <= 0) return 1;
      return REPLAY_ZOOM_LEVELS[i0 - 1];
    }
    return this._replayNearestDiscreteLevel(e);
  },
  /**
   * 捏合手势完全结束后：吸附档位并将双指中心点对应的内容移到屏幕中心（带缓动）。
   * @returns {void}
   */
  _finishReplayPinchSnap: function () {
    if (!this.data.isReplaying || this._replayZoomAnimating) return;
    const base = this._replayTransformCache || {
      x: this.data.replayViewX || 0,
      y: this.data.replayViewY || 0,
      scale: this.data.replayViewScale || 1
    };
    const baseline = typeof this._replayPinchBaselineScale === 'number' && !isNaN(this._replayPinchBaselineScale) ? this._replayPinchBaselineScale : 1;
    const s0 = base.scale;
    const x0 = base.x;
    const y0 = base.y;
    const vp = this._getReplayViewportPx();
    const w = vp.w;
    const h = vp.h;
    const sTarget = this._replayPickPinchSnapScale(baseline, s0);
    const fx = typeof this._replayPinchFocalX === 'number' && !isNaN(this._replayPinchFocalX) ? this._replayPinchFocalX : w * 0.5;
    const fy = typeof this._replayPinchFocalY === 'number' && !isNaN(this._replayPinchFocalY) ? this._replayPinchFocalY : h * 0.5;
    let x1;
    let y1;
    if (sTarget <= 1 + REPLAY_ZOOM_LEVEL_EPS) {
      x1 = 0;
      y1 = 0;
    } else {
      const sm = Math.max(0.001, s0);
      const ux = (fx - x0) / sm;
      const uy = (fy - y0) / sm;
      x1 = w * 0.5 - ux * sTarget;
      y1 = h * 0.5 - uy * sTarget;
      const cl = this._clampReplayPan(x1, y1, sTarget, w, h);
      x1 = cl.x;
      y1 = cl.y;
    }
    const skip = Math.abs(sTarget - s0) < REPLAY_PINCH_SNAP_EPS_SCALE && Math.abs(x1 - x0) < REPLAY_PINCH_SNAP_EPS_PX && Math.abs(y1 - y0) < REPLAY_PINCH_SNAP_EPS_PX;
    if (skip) return;
    this._runReplayPanZoomAnim(x0, y0, s0, x1, y1, sTarget, w, h, REPLAY_PINCH_SNAP_ANIM_MS);
  },
  /**
   * 将平移限制在 out-of-bounds=false 时的合法范围内：x∈[W(1-S),0]，y∈[H(1-S),0]。
   * S>1 时向内收缩少量像素，减轻与原生边界判定的竞态导致的回弹。
   * @param {number} x
   * @param {number} y
   * @param {number} scale
   * @param {number} w
   * @param {number} h
   * @returns {{ x: number, y: number }}
   */
  _clampReplayPan: function (x, y, scale, w, h) {
    const s = !scale || scale <= 0 || !Number.isFinite(scale) ? 1 : scale;
    const ww = Math.max(0, w);
    const hh = Math.max(0, h);
    let minX = ww * (1 - s);
    let minY = hh * (1 - s);
    let maxX = 0;
    let maxY = 0;
    if (s > 1 + 1e-6) {
      minX += REPLAY_PAN_CLAMP_EPS;
      minY += REPLAY_PAN_CLAMP_EPS;
      maxX -= REPLAY_PAN_CLAMP_EPS;
      maxY -= REPLAY_PAN_CLAMP_EPS;
    }
    let nx = Number.isFinite(x) ? x : 0;
    let ny = Number.isFinite(y) ? y : 0;
    if (nx > maxX) nx = maxX;
    if (nx < minX) nx = minX;
    if (ny > maxY) ny = maxY;
    if (ny < minY) ny = minY;
    return {
      x: nx,
      y: ny
    };
  },
  /**
   * 以屏幕坐标 (fx,fy) 为锚点执行双击缩放（含 300ms ease-out 动画）。
   * @param {number} fx
   * @param {number} fy
   * @returns {void}
   */
  _replayApplyDoubleTapZoom: function (fx, fy) {
    const t = this._replayTransformCache || {
      x: this.data.replayViewX || 0,
      y: this.data.replayViewY || 0,
      scale: this.data.replayViewScale || 1
    };
    const s0 = t.scale;
    if (s0 < 0.05) return;
    const s1 = this._nextReplayDiscreteScale(s0);
    const x0 = t.x;
    const y0 = t.y;
    const vp = this._getReplayViewportPx();
    const w = vp.w;
    const h = vp.h;
    this._runReplayZoomAnim(s0, x0, y0, s1, fx, fy, w, h);
  },
  /**
   * 使用 requestAnimationFrame 在 REPLAY_ZOOM_ANIM_MS 内插值 scale 与 x/y，保持锚点稳定。
   * @param {number} s0
   * @param {number} x0
   * @param {number} y0
   * @param {number} s1
   * @param {number} fx 锚点 x（视口 px）
   * @param {number} fy 锚点 y（视口 px）
   * @param {number} w
   * @param {number} h
   * @returns {void}
   */
  _runReplayZoomAnim: function (s0, x0, y0, s1, fx, fy, w, h) {
    this._cancelReplayZoomAnim();
    this._replayZoomAnimating = true;
    const tStart = Date.now();
    const tick = () => {
      const elapsed = Date.now() - tStart;
      const p = REPLAY_ZOOM_ANIM_MS <= 0 ? 1 : Math.min(1, elapsed / REPLAY_ZOOM_ANIM_MS);
      const e = this._easeOutCubic(p);
      const s = s0 + (s1 - s0) * e;
      const x = x0 - (s / s0 - 1) * (fx - x0);
      const y = y0 - (s / s0 - 1) * (fy - y0);
      const cl = this._clampReplayPan(x, y, s, w, h);
      this._replayTransformCache = {
        x: cl.x,
        y: cl.y,
        scale: s
      };
      if (p >= 1) {
        this._replayZoomRafId = null;
        this._replayZoomAnimating = false;
        const fin = this._clampReplayPan(x0 - (s1 / s0 - 1) * (fx - x0), y0 - (s1 / s0 - 1) * (fy - y0), s1, w, h);
        this._replayTransformCache = {
          x: fin.x,
          y: fin.y,
          scale: s1
        };
        this.setData({
          replayViewScale: s1,
          replayViewX: fin.x,
          replayViewY: fin.y
        });
        return;
      }
      this.setData({
        replayViewScale: s,
        replayViewX: cl.x,
        replayViewY: cl.y
      });
      this._replayZoomRafId = wx.requestAnimationFrame(tick);
    };
    this._replayZoomRafId = wx.requestAnimationFrame(tick);
  },
  /**
   * 同步插值 x/y/scale（ease-out），用于捏合松手后的档位吸附 + 居中，避免突变闪屏。
   * @param {number} x0
   * @param {number} y0
   * @param {number} s0
   * @param {number} x1
   * @param {number} y1
   * @param {number} s1
   * @param {number} w
   * @param {number} h
   * @param {number} durationMs
   * @returns {void}
   */
  _runReplayPanZoomAnim: function (x0, y0, s0, x1, y1, s1, w, h, durationMs) {
    this._cancelReplayZoomAnim();
    this._replayZoomAnimating = true;
    const dur = typeof durationMs === 'number' && durationMs > 0 ? durationMs : REPLAY_PINCH_SNAP_ANIM_MS;
    const tStart = Date.now();
    const tick = () => {
      const elapsed = Date.now() - tStart;
      const p = dur <= 0 ? 1 : Math.min(1, elapsed / dur);
      const e = this._easeOutCubic(p);
      const s = s0 + (s1 - s0) * e;
      const x = x0 + (x1 - x0) * e;
      const y = y0 + (y1 - y0) * e;
      const cl = this._clampReplayPan(x, y, s, w, h);
      this._replayTransformCache = {
        x: cl.x,
        y: cl.y,
        scale: s
      };
      if (p >= 1) {
        this._replayZoomRafId = null;
        this._replayZoomAnimating = false;
        const fin = this._clampReplayPan(x1, y1, s1, w, h);
        this._replayTransformCache = {
          x: fin.x,
          y: fin.y,
          scale: s1
        };
        this.setData({
          replayViewScale: s1,
          replayViewX: fin.x,
          replayViewY: fin.y
        });
        return;
      }
      this.setData({
        replayViewScale: s,
        replayViewX: cl.x,
        replayViewY: cl.y
      });
      this._replayZoomRafId = wx.requestAnimationFrame(tick);
    };
    this._replayZoomRafId = wx.requestAnimationFrame(tick);
  },
  flashPeriod: function () {
    this.setData({
      periodFlash: true
    });
    setTimeout(() => this.setData({
      periodFlash: false
    }), 160);
  },
  persistConfig: function () {
    if (normalizeSportType(this.data.sportType) === SPORT_FOOTBALL) {
      this._persistFootballClock();
    }
    const normalizedConfig = this.normalizeMatchConfig(this.data.matchConfig);
    const sportType = normalizeSportType(normalizedConfig.sportType);
    normalizedConfig.sportType = sportType;
    const sportUi = this.buildSportUiPatch(normalizedConfig, sportType);
    this.setData({
      matchConfig: normalizedConfig,
      sportType: sportType,
      ...sportUi
    });
    wx.setStorageSync('matchConfig', normalizedConfig);
    app.globalData.matchConfig = normalizedConfig;

    // 将最新比分/节次实时回写到 MIAOXIE_MATCHES，保持首页数据同步
    const currentMatchId = wx.getStorageSync('currentMatchId') || app.globalData.currentMatchId || '';
    if (currentMatchId) {
      const matches = wx.getStorageSync('MIAOXIE_MATCHES');
      if (Array.isArray(matches)) {
        const idx = matches.findIndex(m => m.id === currentMatchId);
        if (idx >= 0) {
          matches[idx] = {
            ...matches[idx],
            sportType: normalizedConfig.sportType,
            sportConfig: normalizedConfig.sportConfig,
            badmintonState: normalizedConfig.badmintonState,
            footballElapsedSec: normalizedConfig.footballElapsedSec,
            footballState: normalizedConfig.footballState,
            teamA: {
              ...matches[idx].teamA,
              score: normalizedConfig.teamA.score,
              currentSetScore: normalizedConfig.teamA.currentSetScore,
              subScores: normalizedConfig.teamA.subScores
            },
            teamB: {
              ...matches[idx].teamB,
              score: normalizedConfig.teamB.score,
              currentSetScore: normalizedConfig.teamB.currentSetScore,
              subScores: normalizedConfig.teamB.subScores
            },
            period: normalizedConfig.period
          };
          wx.setStorageSync('MIAOXIE_MATCHES', matches);
        }
      }
    }
  },
  /**
   * 执行单个高光固化任务：拷贝到高光目录并更新索引状态。
   */
  materializeHighlightTask: function (task) {
    const segments = Array.isArray(task.segments) ? task.segments.filter(Boolean) : [];
    if (!segments.length || !task.id) {
      return Promise.resolve();
    }
    const coverTempPath = typeof task.coverTempPath === 'string' ? task.coverTempPath : '';
    const dir = this.getHighlightDir();
    const copyAllSerial = () => {
      const saved = [];
      const run = idx => {
        if (idx >= segments.length) return Promise.resolve(saved);
        return this._materializeCopyOneSegment(task, dir, segments[idx], idx).then(savedPath => {
          saved.push(savedPath);
          return run(idx + 1);
        });
      };
      return run(0);
    };
    return this.ensureHighlightDir().then(copyAllSerial).then(saved => {
      const savedPaths = saved.filter(Boolean);
      const matchId = require('../../utils/miaoxie-clips-storage.js').normalizeMatchIdKey(task.matchId);
      if (!matchId) return;
      if (savedPaths.length === segments.length && coverTempPath) {
        const coverDest = `${dir}/${task.id}_cover.jpg`;
        this._persistTempLikeFile(coverTempPath, coverDest, savedPath => {
          this._applyHighlightClipUpdate(task, savedPaths, segments, savedPath || '', matchId, dir);
        });
      } else {
        this._applyHighlightClipUpdate(task, savedPaths, segments, '', matchId, dir);
      }
      if (savedPaths.length !== segments.length) {
        this._retryMaterializeTask(task, segments, savedPaths);
      } else {
        this._releaseMaterializedRollingSources(segments, savedPaths);
      }
    }).catch(() => {
      this._retryMaterializeTask(task, segments, []);
      return Promise.resolve();
    });
  },
  _retryMaterializeTask: function (task, segments, savedPaths) {
    const retryCount = Number(task.retryCount || 0);
    if (retryCount < 3) {
      const next = Object.assign({}, task, {
        retryCount: retryCount + 1
      });
      const delays = [300, 800, 1500, 3000];
      const delay = delays[next.retryCount] || 3000;
      setTimeout(() => {
        this.highlightMaterializeQueue.unshift(next);
        this.processHighlightMaterializeQueue();
      }, delay);
    } else {
      this._releaseMaterializedRollingSources(segments, savedPaths);
    }
  },
  _persistTempLikeFile: function (fromPath, toPath, resolve) {
    const fs = wx.getFileSystemManager();
    const src = typeof fromPath === 'string' ? fromPath : '';
    const dst = typeof toPath === 'string' ? toPath : '';
    if (!src || !dst) {
      resolve('');
      return;
    }
    const isTempLike = src.indexOf('wxfile://tmp_') === 0 || src.indexOf('wxfile://tmp') === 0 || src.indexOf(`${wx.env.USER_DATA_PATH}/tmp_`) === 0 || src.indexOf('/tmp_') >= 0;
    const useCopyFallback = () => {
      if (!fs.copyFile) {
        resolve('');
        return;
      }
      fs.copyFile({
        srcPath: src,
        destPath: dst,
        success: () => resolve(dst),
        fail: () => resolve('')
      });
    };
    const saveAutoThenMove = () => {
      fs.saveFile({
        tempFilePath: src,
        success: autoRes => {
          const autoPath = autoRes && autoRes.savedFilePath ? autoRes.savedFilePath : '';
          if (!autoPath) {
            useCopyFallback();
            return;
          }
          if (autoPath === dst) {
            resolve(dst);
            return;
          }
          if (!fs.copyFile) {
            resolve(autoPath);
            return;
          }
          fs.copyFile({
            srcPath: autoPath,
            destPath: dst,
            success: () => resolve(dst),
            fail: () => resolve(autoPath)
          });
        },
        fail: useCopyFallback
      });
    };
    if (isTempLike) {
      fs.saveFile({
        tempFilePath: src,
        filePath: dst,
        success: r => resolve(r && r.savedFilePath ? r.savedFilePath : dst),
        fail: saveAutoThenMove
      });
      return;
    }
    useCopyFallback();
  },
  _materializeCopyOneSegment: function (task, dir, srcPath, idx) {
    const fs = wx.getFileSystemManager();
    const replayBufferMod = require('../../utils/replay-buffer/index.js');
    return new Promise(resolve => {
      const filePath = `${dir}/${task.id}_${idx}.mp4`;
      const trimStartMs = typeof task.trimStartMs === 'number' ? task.trimStartMs : -1;
      const trimEndMs = typeof task.trimEndMs === 'number' ? task.trimEndMs : -1;
      const trimMod = replayBufferMod.mediaContainerTrim;
      const tailTrim = !!task.tailTrim;
      const tailLeadMs = typeof task.tailLeadMs === 'number' && task.tailLeadMs > 0 ? task.tailLeadMs : 8000;
      const fallbackWallDurationMs = typeof task.fallbackWallDurationMs === 'number' ? task.fallbackWallDurationMs : 0;
      const windowStartInSegMs = typeof task.windowStartInSegMs === 'number' ? task.windowStartInSegMs : -1;
      const windowEndInSegMs = typeof task.windowEndInSegMs === 'number' ? task.windowEndInSegMs : -1;
      const seekMode = typeof task.seekMode === 'string' ? task.seekMode : '';
      const canClickWallMap = windowStartInSegMs >= 0 && windowEndInSegMs > windowStartInSegMs + 400 && fallbackWallDurationMs > 500 && (seekMode === 'click_wall_mapped' || seekMode === 'click_wall_full' || tailTrim);
      const canTrim = !tailTrim && !canClickWallMap && trimStartMs >= 0 && trimEndMs > trimStartMs + 400 && trimMod && typeof trimMod.isMediaContainerSupported === 'function' && trimMod.isMediaContainerSupported();
      const canTailTrim = tailTrim && !canClickWallMap && trimMod && typeof trimMod.trimVideoTail === 'function' && typeof trimMod.isMediaContainerSupported === 'function' && trimMod.isMediaContainerSupported();
      /** Android 单次 trim + 14s 熔断后即转全量拷贝，避免多轮重试拖死 secondary 队列。 */
      const trimMaxAttempts = isLiveHostIos() ? 3 : 1;
      const doMove = physicalSrc => {
        const movePhysical = fromPath => {
          const cleanupOriginal = () => {
            if (fromPath !== srcPath && fromPath !== physicalSrc) {
              try {
                fs.unlink({
                  filePath: srcPath
                });
              } catch (e) {}
            }
          };
          const handleFail = () => {
            if (fromPath !== srcPath && fromPath !== physicalSrc) {
              try {
                fs.unlink({
                  filePath: fromPath
                });
              } catch (e) {}
            }
            resolve('');
          };
          this._persistTempLikeFile(fromPath, filePath, savedPath => {
            if (!savedPath) {
              this.appendHealthLog('highlight_materialize_save_fail', {
                id: String(task.id || ''),
                fromPathTail: typeof fromPath === 'string' ? fromPath.slice(-96) : '',
                destPathTail: typeof filePath === 'string' ? filePath.slice(-96) : ''
              });
              handleFail();
              return;
            }
            cleanupOriginal();
            resolve(savedPath);
          });
        };
        movePhysical(physicalSrc);
      };
      const checkSrc = () => {
        fs.getFileInfo({
          filePath: srcPath,
          success: resSrc => {
            if (!resSrc || !(resSrc.size > 1024)) {
              this.appendHealthLog('highlight_materialize_src_missing', {
                id: String(task.id || ''),
                srcPath: srcPath.slice(-56),
                size: resSrc && resSrc.size ? resSrc.size : 0
              });
              resolve('');
              return;
            }
            const srcSizeBytes = resSrc.size || 0;
            const logMaterializeDiag = (subPhase, extra) => {
              this._logHighlightTrimDiagnostic('materialize', Object.assign({
                highlightId: String(task.id || ''),
                subPhase: subPhase || '',
                tailTrim,
                seekMode: task.seekMode || '',
                clickTime: typeof task.clickTime === 'number' ? task.clickTime : 0,
                wallDurationMs: fallbackWallDurationMs,
                plannedTrimStartMs: trimStartMs,
                plannedTrimEndMs: trimEndMs,
                srcSizeBytes
              }, extra || {}));
            };
            const srcWallDurationMs = typeof task.fallbackWallDurationMs === 'number' && task.fallbackWallDurationMs > 0 ? task.fallbackWallDurationMs : this.highlightPlaybackWindowMs || 8000;
            const fsReadyMod = replayBufferMod.fsReady;
            if (fsReadyMod && typeof fsReadyMod.isHollowSegment === 'function' && fsReadyMod.isHollowSegment(srcSizeBytes, srcWallDurationMs)) {
              this.appendHealthLog('highlight_materialize_src_hollow', {
                id: String(task.id || ''),
                srcPath: srcPath.slice(-56),
                size: srcSizeBytes,
                wallDurationMs: srcWallDurationMs
              });
              logMaterializeDiag('src_hollow_reject', {
                wallDurationMs: srcWallDurationMs
              });
              resolve('');
              return;
            }
            const formatWxErr = replayBufferMod.formatWxErr;
            const runFullCopyFallback = reason => {
              const isLowEndDirectCopy = reason === 'low_end_skip_trim';
              /** 低端机：跳过 trim，直接拷贝 rolling 母片（≤16MB 单段）。 */
              if (isLowEndDirectCopy) {
                const lowEndCap = deviceRecordProfile.LOW_END_ROLLING_FULL_COPY_CAP_BYTES
                  || Math.floor(16 * 1024 * 1024);
                if (srcSizeBytes > lowEndCap) {
                  logMaterializeDiag('full_copy_blocked_oversize', {
                    reason: reason || '',
                    srcSizeBytes,
                    fullCopyMaxBytes: lowEndCap,
                    lowEndDirectCopy: true
                  });
                  this.appendHealthLog('highlight_materialize_full_copy_blocked', {
                    id: String(task.id || ''),
                    reason: reason || '',
                    srcSizeBytes,
                    fullCopyMaxBytes: lowEndCap,
                    lowEndDirectCopy: true
                  });
                  resolve('');
                  return;
                }
                logMaterializeDiag('trim_fallback_full_copy', {
                  reason: reason || '',
                  lowEndDirectCopy: true,
                  srcSizeBytes,
                  fullCopyMaxBytes: lowEndCap
                });
                this.appendHealthLog('highlight_materialize_full_copy_fallback', {
                  id: String(task.id || ''),
                  reason: reason || '',
                  lowEndDirectCopy: true,
                  srcSizeBytes
                });
                doMove(srcPath);
                return;
              }
              /** 720p 母片常 3–10MB，全量拷贝会导致超长视频与 save 失败。 */
              const shortWallMs = typeof task.fallbackWallDurationMs === 'number' ? task.fallbackWallDurationMs : 0;
              const shortSeg = shortWallMs > 0 && shortWallMs <= 20000;
              const fullCopyMaxBytes = shortSeg
                ? Math.floor(4.8 * 1024 * 1024)
                : Math.floor(3.2 * 1024 * 1024);
              if (srcSizeBytes > fullCopyMaxBytes) {
                logMaterializeDiag('full_copy_blocked_oversize', {
                  reason: reason || '',
                  srcSizeBytes,
                  fullCopyMaxBytes
                });
                this.appendHealthLog('highlight_materialize_full_copy_blocked', {
                  id: String(task.id || ''),
                  reason: reason || '',
                  srcSizeBytes,
                  fullCopyMaxBytes
                });
                resolve('');
                return;
              }
              // P0: 禁止全量拷贝 60MB 母片；先尝试 tail trim 兜底
              if (trimMod && typeof trimMod.trimVideoTail === 'function'
                  && typeof trimMod.isMediaContainerSupported === 'function'
                  && trimMod.isMediaContainerSupported()) {
                logMaterializeDiag('trim_retry_instead_of_full_copy', { reason: reason || '' });
                trimMod.trimVideoTail(
                  srcPath,
                  tailLeadMs,
                  fallbackWallDurationMs || 8000,
                  { sourceSizeBytes: srcSizeBytes, maxAttempts: 2 }
                ).then(tailResult => {
                  applyTailTrimResult(tailResult, 'full_copy_salvage_tail', { originalReason: reason });
                }).catch(trimErr => {
                  logMaterializeDiag('trim_all_failed_forced_copy', {
                    reason: reason || '',
                    trimErr: formatWxErr(trimErr)
                  });
                  this.appendHealthLog('highlight_materialize_forced_full_copy', {
                    id: String(task.id || ''),
                    reason: reason || '',
                    srcSizeBytes
                  });
                  doMove(srcPath);
                });
                return;
              }
              logMaterializeDiag('trim_fallback_full_copy', {
                reason: reason || ''
              });
              this.appendHealthLog('highlight_materialize_full_copy_fallback', {
                id: String(task.id || ''),
                reason: reason || ''
              });
              doMove(srcPath);
            };

            const applyTailTrimResult = (tailResult, trimStrategy, extra) => {
              logMaterializeDiag('after_trim', Object.assign({
                appliedTrimStartMs: tailResult.trimStartMs,
                appliedTrimEndMs: tailResult.trimEndMs,
                outputDurationMs: tailResult.outputDurationMs || 0,
                outputSizeBytes: tailResult.outputSizeBytes || 0,
                durationSource: tailResult.durationSource || '',
                srcSizeBytes,
                trimStrategy: trimStrategy || 'tail_trim'
              }, extra || {}));
              this.appendHealthLog('highlight_media_container_trim_ok', {
                id: String(task.id || ''),
                trimStartMs: tailResult.trimStartMs,
                trimEndMs: tailResult.trimEndMs,
                durationMs: tailResult.durationMs,
                outputDurationMs: tailResult.outputDurationMs || 0,
                outputSizeBytes: tailResult.outputSizeBytes || 0,
                srcSizeBytes,
                durationSource: tailResult.durationSource || '',
                tailTrim: true,
                trimStrategy: trimStrategy || 'tail_trim'
              });
              task.trimVerified = true;
              task.trimOutputSizeBytes = tailResult.outputSizeBytes || 0;
              task.trimOutputDurationMs = tailResult.outputDurationMs || 0;
              task.srcSizeBytes = srcSizeBytes;
              doMove(tailResult.path);
            };

            const runAfterProbe = (probe) => {
              const probedDurationMs = probe && probe.durationMs ? probe.durationMs : 0;
              const durationSource = probe && probe.source ? probe.source : '';
              const runTailTrimFallback = (primaryErr, primaryStrategy) => {
                const errText = formatWxErr(primaryErr);
                const trimTimedOut = trimMod
                  && typeof trimMod.isTrimTimeoutError === 'function'
                  && trimMod.isTrimTimeoutError(primaryErr);
                /**
                 * Android 超时或 click_wall 失败：立即全量拷贝，不重试 tail trim，避免阻塞 secondary 队列。
                 */
                if (!isLiveHostIos() && (trimTimedOut || primaryStrategy === 'click_wall_mapped')) {
                  logMaterializeDiag('trim_fail', {
                    err: errText,
                    trimStrategy: primaryStrategy,
                    androidFastFullCopy: true,
                    trimTimedOut: !!trimTimedOut
                  });
                  this.appendHealthLog('highlight_media_container_trim_fail', {
                    id: String(task.id || ''),
                    tailTrim: true,
                    trimStrategy: primaryStrategy,
                    err: errText,
                    androidFastFullCopy: true,
                    trimTimedOut: !!trimTimedOut
                  });
                  runFullCopyFallback(trimTimedOut ? 'trim_timeout_full_copy' : (errText || 'click_wall_trim_fail'));
                  return undefined;
                }
                logMaterializeDiag('trim_fail', {
                  err: errText,
                  trimStrategy: primaryStrategy
                });
                this.appendHealthLog('highlight_media_container_trim_fail', {
                  id: String(task.id || ''),
                  tailTrim: true,
                  trimStrategy: primaryStrategy,
                  err: errText
                });
                if (!trimMod || typeof trimMod.trimVideoTail !== 'function') {
                  runFullCopyFallback('tail_trim_unsupported');
                  return undefined;
                }
                logMaterializeDiag('trim_retry', {
                  trimStrategy: 'tail_after_fail',
                  priorStrategy: primaryStrategy
                });
                return new Promise((resolveDelay) => {
                  setTimeout(resolveDelay, 520);
                }).then(() => {
                  return trimMod.trimVideoTail(
                    srcPath,
                    tailLeadMs,
                    fallbackWallDurationMs || probedDurationMs,
                    { sourceSizeBytes: srcSizeBytes, maxAttempts: 2 }
                  )
                    .then((tailResult) => {
                      applyTailTrimResult(tailResult, 'tail_fallback', { priorStrategy: primaryStrategy });
                    })
                    .catch((tailErr) => {
                      runFullCopyFallback(formatWxErr(tailErr) || 'tail_trim_fail');
                    });
                });
              };
              const wallVsProbeMs = fallbackWallDurationMs > 0
                ? probedDurationMs - fallbackWallDurationMs
                : 0;
              logMaterializeDiag('before_trim', {
                probedDurationMs,
                durationSource,
                wallVsProbeMs,
                windowStartInSegMs,
                windowEndInSegMs,
                mapRatio: fallbackWallDurationMs > 0 ? probedDurationMs / fallbackWallDurationMs : 0
              });
              /** 低端 Android：跳过 MediaContainer trim，直接全量拷贝母片，保证录制管线零中断。 */
              if (!isLiveHostIos() && deviceRecordProfile.shouldSkipMediaContainerTrimForHighlight()) {
                logMaterializeDiag('trim_strategy', {
                  trimStrategy: 'low_end_full_copy_only',
                  recordProfileTier: this._deviceRecordProfileTier || '480p'
                });
                runFullCopyFallback('low_end_skip_trim');
                return undefined;
              }
              const preferTailForLongSeg = fallbackWallDurationMs > 120000;
              if (preferTailForLongSeg && tailTrim && trimMod && typeof trimMod.trimVideoTail === 'function') {
                logMaterializeDiag('trim_strategy', {
                  trimStrategy: 'long_seg_tail_first',
                  wallDurationMs: fallbackWallDurationMs
                });
                return trimMod.trimVideoTail(
                  srcPath,
                  tailLeadMs,
                  fallbackWallDurationMs || probedDurationMs,
                  { sourceSizeBytes: srcSizeBytes, maxAttempts: trimMaxAttempts }
                )
                  .then((tailResult) => {
                    applyTailTrimResult(tailResult, 'long_seg_tail', {});
                  })
                  .catch((tailErr) => {
                    if (canClickWallMap && probedDurationMs > 500 && trimMod.mapWallWindowToFileMs) {
                      logMaterializeDiag('trim_retry', {
                        trimStrategy: 'click_wall_after_long_tail_fail',
                        priorErr: formatWxErr(tailErr)
                      });
                      const mapped = trimMod.mapWallWindowToFileMs(
                        windowStartInSegMs,
                        windowEndInSegMs,
                        fallbackWallDurationMs,
                        probedDurationMs
                      );
                      return trimMod.trimVideoSegment(srcPath, mapped.trimStartMs, mapped.trimEndMs, {
                        sourceSizeBytes: srcSizeBytes,
                        sourceDurationMs: probedDurationMs,
                        maxAttempts: trimMaxAttempts
                      })
                        .then((trimResult) => {
                          if (!trimResult || !trimResult.path) {
                            return runTailTrimFallback('long_seg_wall_empty', 'long_seg_tail');
                          }
                          logMaterializeDiag('after_trim', {
                            probedDurationMs,
                            durationSource,
                            mapRatio: mapped.mapRatio,
                            encodeStartOffsetMs: mapped.encodeStartOffsetMs,
                            appliedTrimStartMs: mapped.trimStartMs,
                            appliedTrimEndMs: mapped.trimEndMs,
                            outputDurationMs: trimResult.outputDurationMs,
                            outputSizeBytes: trimResult.outputSizeBytes,
                            srcSizeBytes,
                            trimStrategy: 'long_seg_then_wall'
                          });
                          this.appendHealthLog('highlight_media_container_trim_ok', {
                            id: String(task.id || ''),
                            trimStartMs: mapped.trimStartMs,
                            trimEndMs: mapped.trimEndMs,
                            durationMs: probedDurationMs,
                            outputDurationMs: trimResult.outputDurationMs,
                            outputSizeBytes: trimResult.outputSizeBytes,
                            srcSizeBytes,
                            trimStrategy: 'long_seg_then_wall'
                          });
                          task.trimVerified = true;
                          task.trimOutputSizeBytes = trimResult.outputSizeBytes;
                          task.trimOutputDurationMs = trimResult.outputDurationMs;
                          task.srcSizeBytes = srcSizeBytes;
                          doMove(trimResult.path);
                        })
                        .catch((wallErr) => runTailTrimFallback(wallErr, 'long_seg_tail'));
                    }
                    return runTailTrimFallback(tailErr, 'long_seg_tail');
                  });
              }
              if (canClickWallMap && probedDurationMs > 500 && trimMod.mapWallWindowToFileMs) {
                const mapped = trimMod.mapWallWindowToFileMs(
                  windowStartInSegMs,
                  windowEndInSegMs,
                  fallbackWallDurationMs,
                  probedDurationMs
                );
                return trimMod.trimVideoSegment(srcPath, mapped.trimStartMs, mapped.trimEndMs, {
                  sourceSizeBytes: srcSizeBytes,
                  sourceDurationMs: probedDurationMs,
                  maxAttempts: trimMaxAttempts
                })
                  .then((trimResult) => {
                    if (!trimResult || !trimResult.path) {
                      return runTailTrimFallback('click_wall_trim_empty', 'click_wall_mapped');
                    }
                    logMaterializeDiag('after_trim', {
                      probedDurationMs,
                      durationSource,
                      mapRatio: mapped.mapRatio,
                      encodeStartOffsetMs: mapped.encodeStartOffsetMs,
                      appliedTrimStartMs: mapped.trimStartMs,
                      appliedTrimEndMs: mapped.trimEndMs,
                      outputDurationMs: trimResult.outputDurationMs,
                      outputSizeBytes: trimResult.outputSizeBytes,
                      srcSizeBytes,
                      trimStrategy: 'click_wall_mapped',
                      videoOnly: !!trimResult.videoOnly
                    });
                    this.appendHealthLog('highlight_media_container_trim_ok', {
                      id: String(task.id || ''),
                      trimStartMs: mapped.trimStartMs,
                      trimEndMs: mapped.trimEndMs,
                      durationMs: probedDurationMs,
                      outputDurationMs: trimResult.outputDurationMs,
                      outputSizeBytes: trimResult.outputSizeBytes,
                      srcSizeBytes,
                      mapRatio: mapped.mapRatio,
                      encodeStartOffsetMs: mapped.encodeStartOffsetMs,
                      tailTrim: true,
                      trimStrategy: 'click_wall_mapped',
                      videoOnly: !!trimResult.videoOnly
                    });
                    task.trimVerified = true;
                    task.trimOutputSizeBytes = trimResult.outputSizeBytes;
                    task.trimOutputDurationMs = trimResult.outputDurationMs;
                    task.srcSizeBytes = srcSizeBytes;
                    doMove(trimResult.path);
                  })
                  .catch((trimErr) => runTailTrimFallback(trimErr, 'click_wall_mapped'));
              }
              if (canTailTrim) {
                return trimMod.trimVideoTail(srcPath, tailLeadMs, fallbackWallDurationMs, {
                  sourceSizeBytes: srcSizeBytes,
                  maxAttempts: trimMaxAttempts
                })
                  .then((tailResult) => {
                    applyTailTrimResult(tailResult, 'tail_trim', {});
                  })
                  .catch((trimErr) => runFullCopyFallback(formatWxErr(trimErr) || 'tail_trim_fail'));
              }
              if (canTrim) {
                return trimMod.trimVideoSegment(srcPath, trimStartMs, trimEndMs, {
                  sourceSizeBytes: srcSizeBytes,
                  sourceDurationMs: probedDurationMs,
                  maxAttempts: trimMaxAttempts
                })
                  .then((trimResult) => {
                    if (!trimResult || !trimResult.path) {
                      runFullCopyFallback('wall_trim_empty');
                      return;
                    }
                    logMaterializeDiag('after_trim', {
                      appliedTrimStartMs: trimStartMs,
                      appliedTrimEndMs: trimEndMs,
                      appliedPlayMs: trimEndMs - trimStartMs,
                      outputDurationMs: trimResult.outputDurationMs,
                      outputSizeBytes: trimResult.outputSizeBytes,
                      srcSizeBytes
                    });
                    this.appendHealthLog('highlight_media_container_trim_ok', {
                      id: String(task.id || ''),
                      trimStartMs,
                      trimEndMs,
                      outputDurationMs: trimResult.outputDurationMs,
                      outputSizeBytes: trimResult.outputSizeBytes,
                      srcSizeBytes
                    });
                    task.trimVerified = true;
                    task.trimOutputSizeBytes = trimResult.outputSizeBytes;
                    task.trimOutputDurationMs = trimResult.outputDurationMs;
                    task.srcSizeBytes = srcSizeBytes;
                    doMove(trimResult.path);
                  })
                  .catch((trimErr) => {
                    logMaterializeDiag('trim_fail', { err: formatWxErr(trimErr) });
                    this.appendHealthLog('highlight_media_container_trim_fail', {
                      id: String(task.id || ''),
                      err: formatWxErr(trimErr)
                    });
                    runFullCopyFallback(formatWxErr(trimErr) || 'wall_trim_fail');
                  });
              }
              runFullCopyFallback('no_trim_strategy');
              return undefined;
            };
            if (trimMod && typeof trimMod.probeVideoDurationMs === 'function') {
              trimMod.probeVideoDurationMs(srcPath).then(runAfterProbe).catch(() => {
                runAfterProbe({ durationMs: 0, source: 'probe_error' });
              });
              return;
            }
            runAfterProbe({ durationMs: 0, source: 'probe_unavailable' });
          },
          fail: () => resolve('')
        });
      };
      fs.getFileInfo({
        filePath: filePath,
        success: resDest => {
          if (resDest && resDest.size > 1024) resolve(filePath);else checkSrc();
        },
        fail: checkSrc
      });
    });
  },
  _applyHighlightClipUpdate: function (task, savedPaths, segments, coverDest, matchId, dir) {
    const clipsStorage = require('../../utils/miaoxie-clips-storage.js');
    const replayBufferMod = require('../../utils/replay-buffer/index.js');
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) {
      this.appendHealthLog('highlight_materialize_clips_read_fail', {
        id: task.id
      });
      return;
    }
    const list = Array.isArray(clipsMap[matchId]) ? clipsMap[matchId] : [];
    const idx = list.findIndex(it => it && String(it.id) === String(task.id));
    if (idx < 0) return;
    const remapReplayPlanPaths = (plan, nextPaths) => {
      if (!Array.isArray(plan)) return [];
      return plan.map((entry, planIdx) => Object.assign({}, entry || {}, {
        path: nextPaths[planIdx] || (entry && entry.path) || '',
        index: planIdx
      }));
    };
    const remapReplayManifestPaths = (manifest, nextPaths) => {
      if (!manifest || typeof manifest !== 'object') return null;
      const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : [];
      return Object.assign({}, manifest, {
        chunks: chunks.map((chunk, chunkIdx) => Object.assign({}, chunk || {}, {
          path: nextPaths[chunkIdx] || (chunk && chunk.path) || ''
        }))
      });
    };

    if (savedPaths.length === segments.length) {
      const replaySegment = savedPaths[savedPaths.length - 1] || savedPaths[0] || '';
      const wasTailTrim = !!task.tailTrim;
      const wasWallTrim = typeof task.trimStartMs === 'number'
        && task.trimStartMs >= 0
        && typeof task.trimEndMs === 'number'
        && task.trimEndMs > task.trimStartMs + 400;
      const srcSizeBytes = typeof task.srcSizeBytes === 'number' ? task.srcSizeBytes : 0;
      const outSizeBytes = typeof task.trimOutputSizeBytes === 'number' ? task.trimOutputSizeBytes : 0;
      const fsReadyMod = replayBufferMod.fsReady;
      const minHighlightBytes = fsReadyMod && typeof fsReadyMod.estimateMinSegmentBytes === 'function'
        ? fsReadyMod.estimateMinSegmentBytes(Math.floor((task.tailLeadMs || 8000) * 0.85))
        : 32000;
      const outputLooksLikeHighlight = !!task.trimVerified
        && outSizeBytes >= minHighlightBytes
        && typeof task.trimOutputDurationMs === 'number'
        && task.trimOutputDurationMs >= Math.floor((task.tailLeadMs || 8000) * 0.45)
        && task.trimOutputDurationMs <= Math.floor((task.tailLeadMs || 8000) + 2500);
      const trimLooksValid = !!task.trimVerified && (
        srcSizeBytes <= 0
        || outSizeBytes <= 0
        || outputLooksLikeHighlight
        || (outSizeBytes <= srcSizeBytes * 0.96 && outputLooksLikeHighlight)
      );
      const wasTrimmed = (wasTailTrim || wasWallTrim) && trimLooksValid;
      const trimDurationSec = wasTailTrim
        ? (typeof task.trimOutputDurationMs === 'number' && task.trimOutputDurationMs > 500
          ? Math.max(0.5, task.trimOutputDurationMs / 1000)
          : Math.max(0.5, (task.tailLeadMs || 8000) / 1000))
        : wasWallTrim
          ? Math.max(0.5, (task.trimEndMs - task.trimStartMs) / 1000)
          : null;

      list[idx].segments = savedPaths;
      list[idx].replaySegment = replaySegment;
      list[idx].trimVerified = wasTrimmed;
      list[idx].srcSizeBytes = srcSizeBytes;
      list[idx].trimOutputSizeBytes = outSizeBytes;
      list[idx].trimOutputDurationMs = typeof task.trimOutputDurationMs === 'number' ? task.trimOutputDurationMs : 0;
      if (wasTrimmed && trimDurationSec) {
        list[idx].replayInitialTimeSec = 0;
        list[idx].replayMediaStopAtSec = trimDurationSec;
        list[idx].replayChainPart2StopAtSec = null;
        list[idx].replayPreTrimmed = true;
        list[idx].replayPlan = savedPaths.map((path, planIdx) => ({
          path,
          initialTimeSec: 0,
          stopAtSec: trimDurationSec,
          durationSec: trimDurationSec,
          index: planIdx
        }));
      } else {
        list[idx].trimVerified = false;
        list[idx].replayPlan = remapReplayPlanPaths(list[idx].replayPlan, savedPaths);
      }
      if (list[idx].replayManifest) {
        list[idx].replayManifest = remapReplayManifestPaths(list[idx].replayManifest, savedPaths);
      }
      list[idx].status = 'materialized';
      if (coverDest) {
        list[idx].cover = coverDest;
      }
      try {
        const legacyList = wx.getStorageSync('highlight_list') || [];
        const legacyIdx = legacyList.findIndex(it => it && String(it.id) === String(task.id));
        if (legacyIdx >= 0) {
          legacyList[legacyIdx] = Object.assign({}, legacyList[legacyIdx], list[idx]);
          wx.setStorageSync('highlight_list', legacyList);
        }
      } catch (eLegacy) {}
    } else {
      list[idx].status = 'failed';
    }
    clipsMap[matchId] = list;
    this.appendHealthLog('highlight_materialize_done', {
      id: String(task.id || ''),
      matchId,
      savedCount: savedPaths.length,
      sourceCount: segments.length,
      status: list[idx] && list[idx].status ? list[idx].status : '',
      hasManifest: !!(list[idx] && list[idx].replayManifest),
      planCount: list[idx] && Array.isArray(list[idx].replayPlan) ? list[idx].replayPlan.length : 0,
      replayPreTrimmed: !!(list[idx] && list[idx].replayPreTrimmed)
    });
    if (!clipsStorage.writeClipsMapSafe(clipsMap)) {
      this.appendHealthLog('highlight_materialize_clips_write_fail', {
        id: task.id
      });
    }
    if (typeof this.refreshDrawerHighlights === 'function') {
      this.refreshDrawerHighlights();
    }
    this._maybeStartDeferredMaterializeReplay(task.id, matchId);
  },
  /** @region LIVE_LIFECYCLE — onLoad/onShow/onHide/onReady/onUnload、初始化 */
onLoad: function (options) {
    this.initHealthLogs();
    this.syncMatchConfigFromPageSources();
    this._initLiveCoreState(options);
    this._initCameraState();
    this._initLiveWsState();
    this._initLiveUiSettings();
    this._loadQuickZoomStops();
    try {
      const savedAspectMode = wx.getStorageSync('live_video_aspect_mode') || 'full';
      this.setData({ liveVideoAspectMode: savedAspectMode });
    } catch (e) {}
    try {
      const recSyncEnabled = wx.getStorageSync('rec_sync_enabled') || false;
      const recSyncRoomId = wx.getStorageSync('rec_sync_room_id') || '';
      this.setData({
        recSyncEnabled: recSyncEnabled,
        recSyncRoomId: recSyncRoomId
      });
    } catch (e) {}
    this._initLocalAds();
  },
  _initLiveCoreState: function (options) {
    const replayBufferMod = require('../../utils/replay-buffer/index.js');
    this._applyDeviceRecordProfile();
    this._routeSportType = normalizeSportType ? normalizeSportType(options && options.sportType) : '';
    this._proScoreboardUserMoved = false;
    this._proScoreboardMovableInited = false;
    this._proMatchNameUserMoved = false;
    this._proMatchNameMovableInited = false;
    this._previewRecordPipeline = replayBufferMod.createPreviewRecordPipeline(this);
    this._previewRecordRetirePromise = null;
    this._recorderCore = new replayBufferMod.RecorderCore(this);
    this._replayBuffer = replayBufferMod.createReplayBuffer({
      windowMs: this.replayBufferWindowMs || 45000,
      minBytes: 1024,
      logger: (eventName, detail) => {
        if (typeof this.appendHealthLog === 'function') {
          this.appendHealthLog(eventName, detail || {});
        }
      }
    });
    this._highlightManager = new replayBufferMod.HighlightManager({
      beforeMs: this.highlightLeadMs || 8000,
      afterMs: this.highlightTailMs || 0
    });
  },
  /**
   * 按设备能力应用录制档位（低端 Android 降级 480p，不暂停主录制管线）。
   * @returns {void}
   */
  _applyDeviceRecordProfile: function () {
    const profile = deviceRecordProfile.getDeviceRecordProfile();
    this._deviceRecordProfile = profile;
    this._deviceRecordProfileTier = profile.tier || '720p';
    this.pingPongRecordCanvasWidth = profile.canvasWidth;
    this.pingPongRecordCanvasHeight = profile.canvasHeight;
    /** camera frame-size 须与首屏 data 一致且初始化后不可变；480p 仅缩编码 canvas，不改 camera 档位。 */
    if (profile.tier === '480p') {
      try {
        this.appendHealthLog('device_record_profile_downgrade', {
          tier: profile.tier,
          canvasWidth: profile.canvasWidth,
          canvasHeight: profile.canvasHeight,
          cameraFrameSize: this.data.recordFrameSize || 'large',
          encoderDownscaleOnly: true,
          skipMediaContainerTrim: profile.skipMediaContainerTrim
        });
      } catch (eLog) {}
    }
  },
  _initCameraState: function () {
    this._cameraInitDone = false;
    this._cameraRebuildLock = false;
    this._androidCameraSettlePending = false;
    this._androidCameraSettleQueue = [];
    this._androidCameraSettleFailsafeTimer = null;
    this._androidCameraSettleFinishTimer = null;
    this._liveCameraLockDeferTimer = null;
    this._cameraRebuildQueue = [];
    this._cameraRebuildGeneration = 0;
    this._cameraMountInFlight = false;
    this._cameraMountInFlightGeneration = 0;
    this._lastHardRecoverAt = 0;
    this._lastTempMissingStormRecoverAt = 0;
    this._hardRecoverMinGapMs = 2200;
    // P0: 毁灭性重建相关状态
    this._destructiveRemountLock = false;
    this._framePulseTimer = null;
    this._cameraHardwareDebounceTimer = null;
    this._awaitingFirstSuccessChunkAfterRemount = false;
    this._liveNeedsForegroundRecordingRecover = false;
    this._encodingProbeTimer = null;
    this._lensSwitchAnimTimer = null;
    this._lensSwitchResetTimer = null;
    if (this._awaitingChunkTimeout) {
      clearTimeout(this._awaitingChunkTimeout);
      this._awaitingChunkTimeout = null;
    }
  },
  _initLiveWsState: function () {
    this._liveWsCurrentSeq = 0;
    this._liveWsSessionId = '';
    this._liveWsClockRunning = false;
    this._liveWsClockTickTimer = null;
    this._liveWsPreferAutoAfterConnect = false;
    this._liveWsWaitingCollector = false;
    this._liveWsPersistTimer = null;
    this._liveWsManualTeardown = false;
    this._liveWsClient = null;
    if (typeof this._liveWsEnsureClient === 'function') {
      this._liveWsEnsureClient();
    }
  },
  _initLiveUiSettings: function () {
    if (wx.hideHomeButton) wx.hideHomeButton();
    wx.setBackgroundColor({
      backgroundColor: '#000000',
      backgroundColorTop: '#000000',
      backgroundColorBottom: '#000000'
    });
    wx.setNavigationBarColor({
      frontColor: '#ffffff',
      backgroundColor: '#000000',
      animation: {
        duration: 0
      }
    });
    wx.setKeepScreenOn({
      keepScreenOn: true,
      fail: () => {
        setTimeout(() => wx.setKeepScreenOn({
          keepScreenOn: true
        }), 1000);
      }
    });
    if (wx.setPageOrientation) wx.setPageOrientation({
      orientation: 'landscape'
    });
    try {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ['shareAppMessage']
      });
    } catch (e) {}
    this._windowResizeListener = function () {
      try {
        this._updateLiveStageLayout();
        this.updateTeamGroupWidth(true);
      } catch (eRz) {}
    }.bind(this);
    if (wx.onWindowResize) {
      try {
        wx.onWindowResize(this._windowResizeListener);
      } catch (eWz) {}
    }
    try {
      this._updateLiveStageLayout();
    } catch (eL0) {}
    try {
      this._liveWsSyncChipConnected();
    } catch (eWs0) {}
    try {
      var selfWsBoot = this;
      setTimeout(function () {
        try {
          if (!selfWsBoot.data.isAutoMode && typeof selfWsBoot._liveWsTeardownForManualMode === 'function') {
            selfWsBoot._liveWsTeardownForManualMode();
          }
        } catch (eBootWs) {}
      }, 0);
    } catch (eBootT) {}
  },
  _recSyncWsConnect: function () {
    if (this._recSyncWs) {
      this._recSyncWs.destroy();
    }
    const recSyncRoomId = this.data.recSyncRoomId;
    const self = this;
    const client = require('../../services/rec-sync-ws-client.js');
    this._recSyncWs = client.createRecSyncWsClient({
      onOpen: function () {
        self.setData({ recSyncConnected: true });
        self.appendHealthLog('rec_sync_ws_open', { roomId: recSyncRoomId });
      },
      onClose: function () {
        self.setData({ recSyncConnected: false });
        self.appendHealthLog('rec_sync_ws_close', { roomId: recSyncRoomId });
      },
      onError: function (err) {
        self.setData({ recSyncConnected: false });
        self.appendHealthLog('rec_sync_ws_error', { err: err.message || err });
      }
    });
    this._recSyncWs.connect(recSyncRoomId, 'controller');
  },
  _recSyncWsDisconnect: function () {
    if (this._recSyncWs) {
      this._recSyncWs.destroy();
      this._recSyncWs = null;
    }
    this.setData({ recSyncConnected: false });
  },
  onRecSyncPanelToggle: function () {
    this.setData({
      recSyncPanelOpen: !this.data.recSyncPanelOpen
    });
  },
  onRecSyncPanelClose: function () {
    this.setData({
      recSyncPanelOpen: false
    });
  },
  onRecSyncEnabledChange: function (e) {
    const val = e.detail.value;
    this.setData({ recSyncEnabled: val });
    wx.setStorageSync('rec_sync_enabled', val);
    if (val) {
      if (this.data.recSyncRoomId.length === 6) {
        this._recSyncWsConnect();
      }
    } else {
      this._recSyncWsDisconnect();
    }
  },
  onRecSyncRoomIdInput: function (e) {
    const val = String(e.detail.value || '').replace(/\D/g, '').slice(0, 6);
    this.setData({ recSyncRoomId: val });
    wx.setStorageSync('rec_sync_room_id', val);
  },
  onRecSyncConnectTap: function () {
    if (this.data.recSyncRoomId.length !== 6) {
      wx.showToast({ title: '请输入6位房间号', icon: 'none' });
      return;
    }
    this._recSyncWsConnect();
  }
});
