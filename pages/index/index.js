const app = getApp();

const { STORAGE_USER_INFO_KEY } = require('../../utils/request.js');
const {
  resolvePromoTargetMatchId,
  buildPromoSquarePageUrl
} = require('../../utils/promo-entry.js');
const { buildJerseyIconDataUrl } = require('../../utils/jersey-icon.js');
const {
  estimateUserDataPathUsageBytes,
  estimateClipSegmentsBytesFromStorage,
  getClipStorageHealthHint,
  getKvStorageInfoSafe,
  writeFileStorageEstimateSnapshot
} = require('../../utils/file-storage-estimate.js');
const clipsStorage = require('../../utils/miaoxie-clips-storage.js');
const mediaContainerTrim = require('../../utils/replay-buffer/media-container-trim.js');

/**
 * 根据编辑草稿中的队服色生成球衣剪影 data URL，供浮层内 `<image>` 绑定。
 * @param {Record<string, unknown>|null} draft 编辑中的比赛对象
 * @returns {{ jerseyIconEditTeamA: string, jerseyIconEditTeamB: string }}
 */
function jerseyUrlsFromEditDraft(draft) {
  if (!draft || !draft.teamA || !draft.teamB) {
    return { jerseyIconEditTeamA: '', jerseyIconEditTeamB: '' };
  }
  const a = /** @type {{ bgColor?: string }} */ (draft.teamA);
  const b = /** @type {{ bgColor?: string }} */ (draft.teamB);
  return {
    jerseyIconEditTeamA: buildJerseyIconDataUrl(a.bgColor || '#E64340'),
    jerseyIconEditTeamB: buildJerseyIconDataUrl(b.bgColor || '#10AEFF')
  };
}
const SHARE_IMAGE_URL = '/assets/images/global_share_card-1-288.png';

/** @const {string} 赛名强制前缀（广告标识，不可由用户删除） */
const MATCH_NAME_PREFIX = '《高光记分》';

/**
 * 从完整赛名中提取用户可编辑的后缀部分
 * @param {string} matchName 完整赛名
 * @returns {string} 用户输入的后缀（不含前缀和连接符）
 */
function extractMatchSuffix(matchName) {
  if (!matchName) return '';
  const sep = MATCH_NAME_PREFIX + '-';
  if (matchName.startsWith(sep)) return matchName.slice(sep.length);
  if (matchName === MATCH_NAME_PREFIX) return '';
  // 兼容历史数据：若无前缀，则视整体为后缀
  return matchName;
}

/**
 * 将用户输入的后缀拼合为完整赛名
 * @param {string} suffix 用户输入部分
 * @returns {string} 完整赛名
 */
function buildFullMatchName(suffix) {
  const s = (suffix || '').trim();
  return s ? `${MATCH_NAME_PREFIX}-${s}` : MATCH_NAME_PREFIX;
}

/** @const 开赛超过该时长视为「已过去很久」，排到列表下方（毫秒） */
const MATCH_START_STALE_MS = 2 * 60 * 60 * 1000;

/**
 * 用于排序的开赛时间戳：有 startAt 用 startAt，否则用 createdAt
 * @param {Record<string, unknown>} m 比赛对象
 * @returns {number}
 */
function getEffectiveStartMs(m) {
  const s = m.startAt;
  if (typeof s === 'number' && s > 0) return s;
  const c = m.createdAt;
  return typeof c === 'number' && c > 0 ? c : 0;
}

/**
 * 列表排序：未超过 2 小时的场次在上；已超过 2 小时的在下。
 * 各组内按与当前时间的绝对差升序（最接近现在优先）。
 * @param {Record<string, unknown>} a
 * @param {Record<string, unknown>} b
 * @param {number} now
 * @returns {number}
 */
function compareMatchesForList(a, b, now) {
  const ta = getEffectiveStartMs(a);
  const tb = getEffectiveStartMs(b);
  const staleA = ta > 0 && now - ta >= MATCH_START_STALE_MS;
  const staleB = tb > 0 && now - tb >= MATCH_START_STALE_MS;
  if (staleA !== staleB) return staleA ? 1 : -1;
  const da = ta > 0 ? Math.abs(now - ta) : Number.MAX_SAFE_INTEGER;
  const db = tb > 0 ? Math.abs(now - tb) : Number.MAX_SAFE_INTEGER;
  if (da !== db) return da - db;
  return tb - ta;
}

/**
 * 返回按开赛规则排序后的新数组（不修改原数组）
 * @param {unknown[]} matches
 * @returns {unknown[]}
 */
function sortMatchesForList(matches) {
  const now = Date.now();
  return matches.slice().sort((a, b) => compareMatchesForList(a, b, now));
}

/**
 * 时间戳对齐到分钟（秒、毫秒归零）
 * @param {number} ts
 * @returns {number}
 */
function alignTimestampToMinute(ts) {
  const d = new Date(ts);
  d.setSeconds(0, 0);
  return d.getTime();
}

/**
 * @param {number} ts
 * @returns {string} YYYY-MM-DD
 */
function timestampToDateStr(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * @param {number} ts
 * @returns {string} HH:mm
 */
function timestampToTimeStr(ts) {
  const d = new Date(ts);
  const h = `${d.getHours()}`.padStart(2, '0');
  const mi = `${d.getMinutes()}`.padStart(2, '0');
  return `${h}:${mi}`;
}

/**
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} timeStr HH:mm
 * @returns {number} 毫秒时间戳（对齐到分钟）
 */
function combineDateTimeToMs(dateStr, timeStr) {
  const dp = (dateStr || '').split('-');
  const tp = (timeStr || '00:00').split(':');
  const y = parseInt(dp[0], 10) || 1970;
  const mo = parseInt(dp[1], 10) || 1;
  const d = parseInt(dp[2], 10) || 1;
  const h = parseInt(tp[0], 10) || 0;
  const mi = parseInt(tp[1], 10) || 0;
  return alignTimestampToMinute(new Date(y, mo - 1, d, h, mi, 0, 0).getTime());
}

/** @const {string} 比赛列表 Storage 主键 */
const STORAGE_KEY = 'MIAOXIE_MATCHES';

/** @const {string} 当前场次 ID Storage 键 */
const CURRENT_ID_KEY = 'currentMatchId';

/** @const {string[]} 快捷预设色 */
const COLOR_PRESETS = [
  '#E64340', '#10AEFF', '#FFBE00', '#07C160',
  '#FF69B4', '#9B59B6', '#34495E', '#000000',
  '#22D3EE', '#F87171', '#60A5FA', '#34D399'
];

/** @const {string} 篮球运动类型 */
const SPORT_BASKETBALL = 'basketball';
/** @const {string} 足球运动类型 */
const SPORT_FOOTBALL = 'football';
/** @const {string} 羽毛球运动类型 */
const SPORT_BADMINTON = 'badminton';

/** @const {Array<{ id: string, label: string, icon: string }>} 可选运动类型 */
const SPORT_OPTIONS = [
  { id: SPORT_BASKETBALL, label: '篮球', icon: '🏀' },
  { id: SPORT_FOOTBALL, label: '足球', icon: '⚽' },
  { id: SPORT_BADMINTON, label: '羽毛球', icon: '🏸' }
];

/**
 * 规范化运动类型。
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeSportType(raw) {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === SPORT_FOOTBALL || s === SPORT_BADMINTON) return s;
  return SPORT_BASKETBALL;
}

/** @const {object} 默认运动配置 */
const DEFAULT_SPORT_CONFIG = {
  periodMinutes: 10,
  enable24Sec: true,
  halfMinutes: 45,
  ruleType: 'single',
  pointsPerSet: 21,
  maxSets: 3
};

/**
 * 确保编辑草稿含完整运动配置字段。
 * @param {Record<string, unknown>} draft
 * @returns {Record<string, unknown>}
 */
function normalizeEditingMatchDraft(draft) {
  const next = JSON.parse(JSON.stringify(draft || {}));
  next.sportType = normalizeSportType(next.sportType);
  next.sportConfig = { ...DEFAULT_SPORT_CONFIG, ...(next.sportConfig || {}) };
  if (!next.badmintonState) {
    next.badmintonState = {
      servingTeam: 'A',
      servingZone: 'right',
      ruleType: next.sportConfig.ruleType,
      maxSets: next.sportConfig.maxSets,
      pointsPerSet: next.sportConfig.pointsPerSet
    };
  }
  if (!next.teamA) {
    next.teamA = {
      name: '', bgColor: '#E64340', textColor: '#FFFFFF', score: 0, currentSetScore: 0, subScores: []
    };
  }
  if (!next.teamB) {
    next.teamB = {
      name: '', bgColor: '#10AEFF', textColor: '#FFFFFF', score: 0, currentSetScore: 0, subScores: []
    };
  }
  return next;
}

/**
 * 为列表展示补充运动类型图标与标签。
 * @param {Record<string, unknown>} match
 * @returns {Record<string, unknown>}
 */
function enrichMatchForList(match) {
  const sportType = normalizeSportType(match.sportType);
  const opt = SPORT_OPTIONS.find((o) => o.id === sportType) || SPORT_OPTIONS[0];
  return {
    ...match,
    sportType,
    sportIcon: opt.icon,
    sportLabel: opt.label
  };
}

/** @const {string[]} 扩展色板 */
const EXTENDED_COLORS = [
  '#FFFFFF',
  '#E64340', '#F87171', '#EF4444', '#B91C1C', '#991B1B', '#7F1D1D',
  '#10AEFF', '#60A5FA', '#3B82F6', '#2563EB', '#1D4ED8', '#1E3A8A',
  '#FFBE00', '#FBBF24', '#F59E0B', '#D97706', '#B45309', '#78350F',
  '#07C160', '#34D399', '#10B981', '#059669', '#047857', '#064E3B',
  '#FF69B4', '#F472B6', '#EC4899', '#DB2777', '#BE185D', '#831843',
  '#9B59B6', '#A855F7', '#8B5CF6', '#7C3AED', '#6D28D9', '#4C1D95',
  '#34495E', '#475569', '#334155', '#1E293B', '#0F172A', '#020617',
  '#000000', '#171717', '#262626', '#404040', '#525252', '#737373',
  '#22D3EE', '#06B6D4', '#0891B2', '#0E7490', '#155E75', '#164E63'
];

/**
 * 从封面字段推导 `<video poster>`：仅 wxfile/http(s) 等位图路径可用。
 * `defaultCover` 为深色 SVG data URL，作 poster 时部分基础库会整层盖住解码后的视频画面（缩略图发灰/发黑）。
 *
 * @param {string} cover 已含默认回退后的展示用 cover（可能与 defaultCover 相同）
 * @param {string} defaultCover 与 data.defaultCover 一致，用于判「无独立封面」
 * @returns {string} 可作 poster 则返回路径，否则空串（勿绑 poster）
 */
function videoPosterFromCover(cover, defaultCover) {
  const c = typeof cover === 'string' ? cover.trim() : '';
  if (!c || c === defaultCover) return '';
  /** 任意 data:（含 SVG）作 poster 均可能触发原生层异常遮罩 */
  if (c.indexOf('data:') === 0) return '';
  return c;
}

Page({
  data: {
    statusBarHeight: 0,

    /** @type {Array} 所有比赛场次 */
    matches: [],

    /** @type {boolean} 编辑/新增浮层可见 */
    showEditModal: false,

    /** @type {string} 正在编辑的比赛 ID，空字符串表示新增 */
    editingId: '',

    /**
     * @type {object|null} 编辑浮层中的草稿数据
     * schema 与 matchConfig 保持一致，附加 id / isFinished / createdAt
     */
    editingMatch: null,

    /** 颜色选择器 */
    showColorPicker: false,
    colorPickerTarget: '', // 'matchName' | 'teamA' | 'teamB'
    /** 颜色浮层标题（赛名 / 队服） */
    colorPickerTitle: '设置赛名字体颜色',
    tempSelectedColor: '',
    colorPresets: COLOR_PRESETS,
    extendedColors: EXTENDED_COLORS,

    /** 编辑浮层：开赛日期、时间（picker 绑定，精确到分钟） */
    editingStartDate: '',
    editingStartTime: '',

    /** 编辑浮层：主客队球衣剪影图标（随 bgColor 更新） */
    jerseyIconEditTeamA: '',
    jerseyIconEditTeamB: '',

    /** 赛名后缀（用户可编辑部分，前缀《高光记分》固定不可删除） */
    editingMatchSuffix: '',

    /** 运动类型选项（编辑浮层） */
    sportOptions: SPORT_OPTIONS,
    /** 篮球单节时长 picker 选项 */
    basketballPeriodOptions: [8, 10, 12, 15, 20],
    /** 足球半场时长 picker 选项 */
    footballHalfOptions: [30, 35, 40, 45],

    /** 高光录像列表 */
    highlightList: [],
    groupedHighlights: [],

    /** 批量管理模式 */
    batchMode: false,
    /** 已选中片段 ID → true 映射（用于 WXML 快速判断） */
    selectedIdsMap: {},
    /** 已选中片段数量 */
    selectedCount: 0,
    /** 当前列表中可批量选择的高光片段总数（用于全选/全不选） */
    batchSelectableTotal: 0,

    /** 自定义播放器是否可见 */
    showPlayer: false,
    /** 播放列表（全部片段展平） */
    playerList: [],
    /** 当前播放索引 */
    playerIndex: 0,
    /** 页内播放器是否暂停（用于 UI 状态） */
    playerPaused: false,

    defaultCover: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90"><rect width="160" height="90" rx="12" ry="12" fill="%2322262f"/><path d="M66 58V32l28 13-28 13z" fill="%23ffffff" fill-opacity="0.75"/></svg>',

    /** 本机占用：高光文件 MB + 沙盒总 MB（getFileInfo 估算） */
    fileStorageLoading: true,
    fileStorageClipMb: 0,
    fileStorageTotalMb: 0,
    fileStorageHealthLevel: 'ok',
    fileStorageHint: '',
    fileStorageKvText: ''
  },

  /**
   * 小程序码 scene 落地：从首页解析 m= 并跳转推广广场分包页。
   * @param {WechatMiniprogram.Page.ILifetimePageOptions} [options]
   * @returns {void}
   */
  onLoad(options) {
    const sys = wx.getSystemInfoSync();
    this.setData({ statusBarHeight: sys.statusBarHeight || 0 });

    const matchId = resolvePromoTargetMatchId(
      options && typeof options === 'object'
        ? /** @type {Record<string, string | undefined>} */ (options)
        : {}
    );
    if (matchId) {
      wx.navigateTo({
        url: buildPromoSquarePageUrl(matchId),
        fail: function () {
          wx.showToast({ title: '打开推广广场失败', icon: 'none' });
        }
      });
    }
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 });
    }
    try {
      wx.showShareMenu({
        withShareTicket: true,
        menus: ['shareAppMessage']
      });
    } catch (e) {
      // 低版本基础库忽略
    }
    this.loadMatches();
    this.loadHighlights();
    this.refreshFileStorageEstimate();
  },

  /**
   * 遍历 USER_DATA_PATH 估算已用字节，写入 globalData 并更新水位 UI。
   * @returns {void}
   */
  refreshFileStorageEstimate() {
    this.setData({ fileStorageLoading: true });
    Promise.all([estimateUserDataPathUsageBytes(), estimateClipSegmentsBytesFromStorage()])
      .then(([userDataBytes, clipBytes]) => {
        const hint = getClipStorageHealthHint(clipBytes, userDataBytes);
        const kv = getKvStorageInfoSafe();
        const kvText = `配置缓存 ${kv.currentKb}/${kv.limitKb} KB`;
        try {
          app.globalData.fileStorageEstimate = {
            clipBytes,
            userDataBytes,
            clipMb: hint.clipMb,
            totalMb: hint.totalMb,
            healthLevel: hint.level,
            hintText: hint.hintText,
            at: Date.now()
          };
          writeFileStorageEstimateSnapshot(app.globalData.fileStorageEstimate);
        } catch (eG) {}
        this.setData({
          fileStorageLoading: false,
          fileStorageClipMb: hint.clipMb,
          fileStorageTotalMb: hint.totalMb,
          fileStorageHealthLevel: hint.level,
          fileStorageHint: hint.hintText,
          fileStorageKvText: kvText
        });
      })
      .catch(() => {
        this.setData({
          fileStorageLoading: false,
          fileStorageClipMb: 0,
          fileStorageTotalMb: 0,
          fileStorageHealthLevel: 'ok',
          fileStorageHint: '无法估算本机占用',
          fileStorageKvText: ''
        });
      });
  },

  /**
   * 首页分享：路径携带当前用户 openid，供被邀请方启动时写入 pending_referrer。
   * @returns {WechatMiniprogram.Page.ICustomShareContent}
   */
  onShareAppMessage() {
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

  // ─────────────────────────────────────────────
  // 场次 CRUD
  // ─────────────────────────────────────────────

  /**
   * 从 Storage 读取全部比赛并同步到视图
   */
  loadMatches() {
    const raw = wx.getStorageSync(STORAGE_KEY);
    const list = Array.isArray(raw) ? raw : [];
    const matches = sortMatchesForList(list).map((m) => enrichMatchForList(m));
    this.setData({ matches });
  },

  /**
   * 持久化并更新视图
   * @param {Array} matches 要保存的完整比赛列表
   */
  saveMatches(matches) {
    const sorted = sortMatchesForList(matches).map((m) => enrichMatchForList(m));
    wx.setStorageSync(STORAGE_KEY, sorted);
    this.setData({ matches: sorted });
  },

  /**
   * 构建一个含默认值的新比赛对象
   * @param {number} ts 时间戳，用作唯一 ID
   * @returns {object}
   */
  buildDefaultMatch(ts) {
    return {
      id: `${ts}`,
      sportType: SPORT_BASKETBALL,
      matchName: MATCH_NAME_PREFIX,
      matchNameColor: '#FFFFFF',
      teamA: {
        name: '',
        bgColor: '#E64340',
        textColor: '#FFFFFF',
        score: 0,
        currentSetScore: 0,
        subScores: []
      },
      teamB: {
        name: '',
        bgColor: '#10AEFF',
        textColor: '#FFFFFF',
        score: 0,
        currentSetScore: 0,
        subScores: []
      },
      period: 0,
      badmintonState: {
        servingTeam: 'A',
        servingZone: 'right',
        ruleType: 'single',
        maxSets: 3,
        pointsPerSet: 21
      },
      sportConfig: { ...DEFAULT_SPORT_CONFIG },
      footballElapsedSec: 0,
      footballState: {
        clockPaused: false,
        clockWallMs: 0,
        extraMinutesHalf1: 0,
        extraMinutesHalf2: 0
      },
      isFinished: false,
      /** 开赛时间（毫秒，对齐到分钟） */
      startAt: alignTimestampToMinute(ts),
      createdAt: ts
    };
  },

  /** 点击「新增比赛」——打开编辑浮层，赛名默认沿用上一场 */
  onAddMatch() {
    const draft = normalizeEditingMatchDraft(this.buildDefaultMatch(Date.now()));
    const matches = this.data.matches;
    if (matches.length > 0) {
      // 继承最近一场的赛名颜色与后缀，方便同系列多场比赛快速创建
      const last = matches[0];
      draft.matchName = last.matchName || MATCH_NAME_PREFIX;
      draft.matchNameColor = last.matchNameColor || '#FFFFFF';
    }
    const sa = /** @type {number} */ (draft.startAt);
    this.setData({
      editingId: '',
      editingMatch: draft,
      editingMatchSuffix: extractMatchSuffix(draft.matchName),
      editingStartDate: timestampToDateStr(sa),
      editingStartTime: timestampToTimeStr(sa),
      showEditModal: true,
      ...jerseyUrlsFromEditDraft(draft)
    });
  },

  /**
   * 点击卡片「编辑资料」——用该场次数据填充浮层
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onEditMatch(e) {
    const { id } = e.currentTarget.dataset;
    const match = this.data.matches.find((m) => m.id === id);
    if (!match) return;
    const copied = normalizeEditingMatchDraft(JSON.parse(JSON.stringify(match)));
    const rawStart =
      typeof copied.startAt === 'number' && copied.startAt > 0
        ? copied.startAt
        : copied.createdAt || Date.now();
    const alignedStart = alignTimestampToMinute(rawStart);
    copied.startAt = alignedStart;
    this.setData({
      editingId: id,
      editingMatch: copied,
      editingMatchSuffix: extractMatchSuffix(copied.matchName),
      editingStartDate: timestampToDateStr(alignedStart),
      editingStartTime: timestampToTimeStr(alignedStart),
      showEditModal: true,
      ...jerseyUrlsFromEditDraft(copied)
    });
  },

  /**
   * 删除指定场次，二次确认
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onDeleteMatch(e) {
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除比赛',
      content: '确定删除这场比赛？此操作不可撤销。',
      confirmColor: '#E64340',
      success: (res) => {
        if (res.confirm) {
          const matches = this.data.matches.filter((m) => m.id !== id);
          this.saveMatches(matches);
        }
      }
    });
  },

  /**
   * 进入记分页：增加登录拦截，设置 currentMatchId，同步 globalData，跳转 live 页
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onGoToLive(e) {
    // 1. 登录鉴权拦截
    const userInfo = wx.getStorageSync('userInfo') || app.globalData.userInfo;
    const isLoggedIn = !!userInfo;

    if (!isLoggedIn) {
      wx.showModal({
        title: '需要登录',
        content: '请先登录后再进行比赛记分',
        confirmText: '去登录',
        success: (res) => {
          if (res.confirm) {
            wx.switchTab({ url: '/pages/mine/mine' });
          }
        }
      });
      return;
    }

    const { id } = e.currentTarget.dataset;
    const match = this.data.matches.find((m) => m.id === id);
    if (!match) return;

    if (!match.teamA.name || !match.teamB.name) {
      wx.showToast({ title: '请先填写双方队名', icon: 'none' });
      return;
    }

    // 将当前场次 ID 写入 Storage 和 globalData，live 页读取后定位对应数据
    wx.setStorageSync(CURRENT_ID_KEY, id);
    app.globalData.currentMatchId = id;
    app.globalData.matchConfig = match;
    // 兼容旧版 live.js 的 fallback 读取
    wx.setStorageSync('matchConfig', match);

    wx.navigateTo({
      url: '/pages/live/live?sportType=' + encodeURIComponent(normalizeSportType(match.sportType)) + '&matchId=' + encodeURIComponent(id)
    });
  },

  // ─────────────────────────────────────────────
  // 编辑浮层
  // ─────────────────────────────────────────────

  /**
   * 浮层内输入变更
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onEditInputChange(e) {
    const { field } = e.currentTarget.dataset;
    const value = e.detail.value;
    const draft = JSON.parse(JSON.stringify(this.data.editingMatch));

    if (field.includes('.')) {
      const [obj, key] = field.split('.');
      draft[obj][key] = value;
    } else {
      draft[field] = value;
    }
    this.setData({ editingMatch: draft });
  },

  /**
   * 保存编辑浮层的草稿（新增或更新）
   */
  saveEditMatch() {
    const draft = this.data.editingMatch;
    if (!draft.teamA.name || !draft.teamB.name) {
      wx.showToast({ title: '请填写双方队名', icon: 'none' });
      return;
    }

    // 将用户输入的后缀与固定前缀合成完整赛名
    const fullMatchName = buildFullMatchName(this.data.editingMatchSuffix);
    const startAt = combineDateTimeToMs(this.data.editingStartDate, this.data.editingStartTime);

    let matches = [...this.data.matches];

    if (this.data.editingId) {
      const idx = matches.findIndex((m) => m.id === this.data.editingId);
      if (idx >= 0) {
        // 保留 score / period 等运行时状态，仅更新用户编辑的字段
        matches[idx] = {
          ...matches[idx],
          sportType: normalizeSportType(draft.sportType),
          sportConfig: { ...DEFAULT_SPORT_CONFIG, ...(draft.sportConfig || {}) },
          badmintonState: draft.badmintonState || matches[idx].badmintonState,
          matchName: fullMatchName,
          matchNameColor: draft.matchNameColor,
          startAt,
          teamA: {
            ...matches[idx].teamA,
            name: draft.teamA.name,
            bgColor: draft.teamA.bgColor,
            textColor: draft.teamA.textColor
          },
          teamB: {
            ...matches[idx].teamB,
            name: draft.teamB.name,
            bgColor: draft.teamB.bgColor,
            textColor: draft.teamB.textColor
          }
        };
      }
    } else {
      const newMatch = {
        ...draft,
        sportType: normalizeSportType(draft.sportType),
        sportConfig: { ...DEFAULT_SPORT_CONFIG, ...(draft.sportConfig || {}) },
        matchName: fullMatchName,
        startAt,
        id: `${Date.now()}`,
        createdAt: Date.now()
      };
      matches.unshift(newMatch);
    }

    this.saveMatches(matches);
    this.setData({
      showEditModal: false,
      editingMatch: null,
      editingId: '',
      editingMatchSuffix: '',
      editingStartDate: '',
      editingStartTime: ''
    });
  },

  /** 关闭编辑浮层（丢弃草稿） */
  closeEditModal() {
    this.setData({
      showEditModal: false,
      editingMatch: null,
      editingId: '',
      editingMatchSuffix: '',
      editingStartDate: '',
      editingStartTime: ''
    });
  },

  /**
   * 开赛日期变更
   * @param {{ detail: { value: string } }} e
   */
  onMatchStartDateChange(e) {
    const value = /** @type {string} */ (e.detail.value);
    this.setData({ editingStartDate: value });
    this.syncEditingMatchStartAt();
  },

  /**
   * 开赛时间（时分）变更
   * @param {{ detail: { value: string } }} e
   */
  onMatchStartTimeChange(e) {
    const value = /** @type {string} */ (e.detail.value);
    this.setData({ editingStartTime: value });
    this.syncEditingMatchStartAt();
  },

  /**
   * 将日期时间选择结果写回 editingMatch.startAt
   * @returns {void}
   */
  syncEditingMatchStartAt() {
    const { editingStartDate, editingStartTime, editingMatch } = this.data;
    if (!editingMatch) return;
    const ts = combineDateTimeToMs(editingStartDate, editingStartTime);
    const next = JSON.parse(JSON.stringify(editingMatch));
    next.startAt = ts;
    this.setData({ editingMatch: next });
  },

  /**
   * 赛名后缀输入变更（前缀《高光记分》固定不可编辑）
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onMatchNameSuffixInput(e) {
    this.setData({ editingMatchSuffix: e.detail.value });
  },

  /**
   * 编辑浮层：切换运动类型。
   * @param {WechatMiniprogram.TouchEvent} e data-sport
   * @returns {void}
   */
  onEditSportTypeChange(e) {
    const sportType = normalizeSportType(e.currentTarget.dataset.sport);
    const draft = normalizeEditingMatchDraft(this.data.editingMatch || this.buildDefaultMatch(Date.now()));
    draft.sportType = sportType;
    draft.sportConfig = { ...DEFAULT_SPORT_CONFIG, ...(draft.sportConfig || {}) };
    if (sportType === SPORT_FOOTBALL) {
      draft.period = 1;
    } else if (sportType === SPORT_BADMINTON) {
      draft.period = 1;
      draft.badmintonState = {
        servingTeam: 'A',
        servingZone: 'right',
        ruleType: draft.sportConfig.ruleType,
        maxSets: draft.sportConfig.maxSets,
        pointsPerSet: draft.sportConfig.pointsPerSet
      };
    } else {
      draft.period = 0;
    }
    this.setData({ editingMatch: draft });
  },

  /**
   * 编辑浮层：切换羽毛球单打/双打。
   * @param {WechatMiniprogram.TouchEvent} e data-rule
   * @returns {void}
   */
  onEditBadmintonRuleChange(e) {
    const ruleType = e.currentTarget.dataset.rule === 'double' ? 'double' : 'single';
    const draft = JSON.parse(JSON.stringify(this.data.editingMatch));
    draft.sportConfig = { ...(draft.sportConfig || DEFAULT_SPORT_CONFIG), ruleType };
    draft.badmintonState = {
      ...(draft.badmintonState || {}),
      ruleType
    };
    this.setData({ editingMatch: draft });
  },

  /**
   * 编辑浮层：切换羽毛球 11/21 分制。
   * @param {WechatMiniprogram.TouchEvent} e data-points
   * @returns {void}
   */
  onEditBadmintonPointsChange(e) {
    const points = Number(e.currentTarget.dataset.points) === 11 ? 11 : 21;
    const draft = JSON.parse(JSON.stringify(this.data.editingMatch));
    draft.sportConfig = { ...(draft.sportConfig || DEFAULT_SPORT_CONFIG), pointsPerSet: points };
    draft.badmintonState = {
      ...(draft.badmintonState || {}),
      pointsPerSet: points
    };
    this.setData({ editingMatch: draft });
  },

  /**
   * 编辑浮层：切换篮球单节时长。
   * @param {{ detail: { value: string } }} e
   * @returns {void}
   */
  onEditBasketballPeriodMinutesChange(e) {
    const options = this.data.basketballPeriodOptions || [8, 10, 12, 15, 20];
    const idx = Math.max(0, Math.floor(Number(e.detail.value) || 0));
    const minutes = options[idx] || 10;
    const draft = JSON.parse(JSON.stringify(this.data.editingMatch));
    draft.sportConfig = { ...(draft.sportConfig || DEFAULT_SPORT_CONFIG), periodMinutes: minutes };
    this.setData({ editingMatch: draft });
  },

  /**
   * 编辑浮层：切换篮球是否开启 24 秒。
   * @param {{ detail: { value: boolean } }} e
   * @returns {void}
   */
  onEditBasketball24SecChange(e) {
    const draft = JSON.parse(JSON.stringify(this.data.editingMatch));
    draft.sportConfig = {
      ...(draft.sportConfig || DEFAULT_SPORT_CONFIG),
      enable24Sec: !!e.detail.value
    };
    this.setData({ editingMatch: draft });
  },

  /**
   * 编辑浮层：切换足球半场时长。
   * @param {{ detail: { value: string } }} e
   * @returns {void}
   */
  onEditFootballHalfMinutesChange(e) {
    const options = this.data.footballHalfOptions || [30, 35, 40, 45];
    const idx = Math.max(0, Math.floor(Number(e.detail.value) || 0));
    const minutes = options[idx] || 45;
    const draft = JSON.parse(JSON.stringify(this.data.editingMatch));
    draft.sportConfig = { ...(draft.sportConfig || DEFAULT_SPORT_CONFIG), halfMinutes: minutes };
    this.setData({ editingMatch: draft });
  },

  stopBubbling() { return; },

  // ─────────────────────────────────────────────
  // 颜色选择器（在编辑浮层内触发）
  // ─────────────────────────────────────────────

  /**
   * 打开颜色选择浮层
   * @param {WechatMiniprogram.TouchEvent} e data-target: 'teamA' | 'teamB' | 'matchName'
   */
  openColorPicker(e) {
    const { target } = e.currentTarget.dataset;
    const draft = this.data.editingMatch;
    const currentColor = target === 'matchName'
      ? (draft.matchNameColor || '#FFFFFF')
      : draft[target].bgColor;
    const colorPickerTitle =
      target === 'matchName' ? '设置赛名字体颜色' : '设置队服颜色';
    this.setData({
      showColorPicker: true,
      colorPickerTarget: target,
      colorPickerTitle,
      tempSelectedColor: currentColor
    });
  },

  closeColorPicker() {
    this.setData({ showColorPicker: false });
  },

  /**
   * 选择预设色（不立即确认）
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onModalPresetColorTap(e) {
    this.setData({ tempSelectedColor: e.currentTarget.dataset.color });
  },

  /**
   * 在扩展色板中选色
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onColorGridSelect(e) {
    this.setData({ tempSelectedColor: e.currentTarget.dataset.color });
  },

  /** 确认并写回草稿 */
  confirmColorSelection() {
    const color = this.data.tempSelectedColor;
    const target = this.data.colorPickerTarget;
    const draft = JSON.parse(JSON.stringify(this.data.editingMatch));
    if (target === 'matchName') {
      // 赛名颜色直接记录，用于 live 页文字色
      draft.matchNameColor = color;
    } else {
      const textColor = this.getContrastColor(color);
      draft[target].bgColor = color;
      draft[target].textColor = textColor;
    }
    const extra = target === 'matchName' ? {} : jerseyUrlsFromEditDraft(draft);
    this.setData({ editingMatch: draft, showColorPicker: false, ...extra });
  },

  // ─────────────────────────────────────────────
  // 工具函数
  // ─────────────────────────────────────────────

  /**
   * 根据背景色计算高对比度文字色
   * @param {string} hexcolor
   * @returns {string} '#000000' | '#FFFFFF'
   */
  getContrastColor(hexcolor) {
    if (!hexcolor) return '#FFFFFF';
    let c = hexcolor.replace('#', '');
    if (c.length === 3) c = c.split('').map((x) => x + x).join('');
    if (c.length !== 6) return '#FFFFFF';
    const r = parseInt(c.substr(0, 2), 16);
    const g = parseInt(c.substr(2, 2), 16);
    const b = parseInt(c.substr(4, 2), 16);
    return ((r * 299 + g * 587 + b * 114) / 1000) >= 128 ? '#000000' : '#FFFFFF';
  },


  // ─────────────────────────────────────────────
  // 高光录像管理
  // ─────────────────────────────────────────────

  /**
   * 从 Storage 读取高光列表并按比赛场次分组
   */
  loadHighlights() {
    try {
      clipsStorage.mergeDefaultClipBucketIfTargetEmpty(
        String(wx.getStorageSync(CURRENT_ID_KEY) || '').trim()
      );
    } catch (eMerge) {}
    const rawClipsMap = clipsStorage.readClipsMapSafe();
    if (rawClipsMap === null) {
      wx.showToast({ title: '高光索引数据异常', icon: 'none', duration: 2500 });
    }
    const rawClips = rawClipsMap || {};
    const rawMatches = wx.getStorageSync(STORAGE_KEY) || [];
    const legacyClips = wx.getStorageSync('highlight_list') || [];
    const groupedList = [];

    rawMatches.forEach((match) => {
      const matchId = match.id;
      let matchClips = Array.isArray(rawClips[matchId]) ? rawClips[matchId] : [];
      if (matchClips.length === 0 && match.matchName) {
        matchClips = legacyClips.filter(
          (c) => c.matchId === matchId || (!c.matchId && c.matchName === match.matchName)
        );
      }
      matchClips = matchClips.filter((c) => c);
      if (matchClips.length > 0) {
        const dateStr = this.formatDate(match.createdAt);
        const sortedClips = matchClips.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const clipTotal = sortedClips.length;
        const dc = this.data.defaultCover;
        groupedList.push({
          matchId: match.id,
          matchTitle: `${match.teamA.name || 'A'} VS ${match.teamB.name || 'B'}`,
          matchName: match.matchName,
          scoreInfo: `${match.teamA.score} : ${match.teamB.score}`,
          dateStr,
          clipCount: clipTotal,
          videos: sortedClips.map((v, idx) => {
            const cover = v.cover || dc;
            return {
              ...v,
              timeText:
                (v.timeText || this.formatTime(v.createdAt)) +
                (v.exportedToAlbum ? ' · 已导出相册' : ''),
              cover,
              videoPoster: videoPosterFromCover(cover, dc),
              videoPath: v.replaySegment || (v.segments && v.segments[0]) || '',
              videoIndex: idx + 1,
              videoTotal: clipTotal
            };
          })
        });
      }
    });

    const matchIdsInList = rawMatches.map((m) => m.id);
    Object.keys(rawClips).forEach((id) => {
      const bucket = rawClips[id];
      if (!matchIdsInList.includes(id) && Array.isArray(bucket) && bucket.length > 0) {
        const firstClip = bucket[0];
        const dateStr = this.formatDate(firstClip.createdAt);
        const orphanVideos = bucket
          .filter((c) => c)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        if (orphanVideos.length === 0) return;
        const orphanTotal = orphanVideos.length;
        const dcOr = this.data.defaultCover;
        groupedList.push({
          matchId: id,
          matchTitle: `${firstClip.matchName || '已删比赛'} (遗留)`,
          clipCount: orphanTotal,
          videos: orphanVideos.map((v, idx) => {
            const cover = v.cover || dcOr;
            return {
              ...v,
              timeText:
                (v.timeText || this.formatTime(v.createdAt)) +
                (v.exportedToAlbum ? ' · 已导出相册' : ''),
              cover,
              videoPoster: videoPosterFromCover(cover, dcOr),
              videoPath: v.replaySegment || (v.segments && v.segments[0]) || '',
              videoIndex: idx + 1,
              videoTotal: orphanTotal
            };
          })
        });
      }
    });

    const sortedGroups = groupedList.sort((a, b) => {
      const timeA = (a.videos[0] && a.videos[0].createdAt) || 0;
      const timeB = (b.videos[0] && b.videos[0].createdAt) || 0;
      return timeB - timeA;
    });
    const batchSelectableTotal = sortedGroups.reduce(
      (sum, g) => sum + (Array.isArray(g.videos) ? g.videos.length : 0),
      0
    );
    this.setData({
      highlightList: legacyClips,
      groupedHighlights: sortedGroups,
      batchSelectableTotal
    });
  },

  /**
   * 格式化日期
   * @param {number} ts
   * @returns {string}
   */
  formatDate(ts) {
    const d = new Date(ts || Date.now());
    return `${d.getMonth() + 1}/${d.getDate()}`;
  },

  /**
   * 格式化时间戳
   * @param {number} ts
   * @returns {string}
   */
  formatTime(ts) {
    const d = new Date(ts || Date.now());
    const pad = (n) => `${n}`.padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  },

  /**
   * 在两个存储区查找指定 ID 的片段
   * @param {string} id
   * @returns {object|null}
   */
  findClipById(id) {
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) return null;
    for (const matchId in clipsMap) {
      const bucket = clipsMap[matchId];
      if (!Array.isArray(bucket)) continue;
      const item = bucket.find((x) => x && String(x.id) === String(id));
      if (item) return item;
    }
    const legacyList = wx.getStorageSync('highlight_list') || [];
    return legacyList.find((x) => x.id === id) || null;
  },

  /**
   * 导出相册前补裁剪，返回可用于 saveVideoToPhotosAlbum 的路径列表。
   * @param {Record<string, unknown>[]} clips
   * @returns {Promise<string[]>}
   */
  prepareClipExportPaths(clips) {
    const list = Array.isArray(clips) ? clips.filter(Boolean) : [];
    if (!list.length) return Promise.resolve([]);
    if (!mediaContainerTrim || typeof mediaContainerTrim.trimClipForExport !== 'function') {
      const paths = [];
      list.forEach((clip) => {
        const segs = Array.isArray(clip.segments) ? clip.segments : [];
        segs.forEach((p) => { if (p) paths.push(p); });
      });
      return Promise.resolve(paths);
    }
    let chain = Promise.resolve(/** @type {string[]} */ ([]));
    list.forEach((clip) => {
      chain = chain.then((acc) => {
        const segs = Array.isArray(clip.segments) ? clip.segments.filter(Boolean) : [];
        if (!segs.length) return acc;
        let inner = Promise.resolve(acc);
        segs.forEach((segPath) => {
          inner = inner.then((paths) => mediaContainerTrim.trimClipForExport(segPath, clip)
            .then((outPath) => paths.concat(outPath || segPath)));
        });
        return inner;
      });
    });
    return chain;
  },

  /**
   * 将高光条目批量存入相册（必要时先补裁剪）。
   * @param {Record<string, unknown>[]} clips
   * @param {Function} [onComplete]
   * @returns {void}
   */
  saveClipsToAlbum(clips, onComplete) {
    const validClips = (Array.isArray(clips) ? clips : []).filter(
      (c) => c && Array.isArray(c.segments) && c.segments.length
    );
    if (!validClips.length) {
      wx.showToast({ title: '无有效视频文件', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '处理视频中', mask: true });
    this.prepareClipExportPaths(validClips)
      .then((paths) => {
        wx.hideLoading();
        this.doSaveToAlbum(paths, onComplete);
      })
      .catch(() => {
        wx.hideLoading();
        const fallback = [];
        validClips.forEach((clip) => {
          (clip.segments || []).forEach((p) => { if (p) fallback.push(p); });
        });
        this.doSaveToAlbum(fallback, onComplete);
      });
  },

  /**
   * 将视频文件列表批量存入相册（含权限处理）
   * @param {string[]} segments
   * @param {Function} [onComplete]
   */
  doSaveToAlbum(segments, onComplete) {
    const fs = wx.getFileSystemManager();
    const valid = segments.filter((p) => {
      try { fs.accessSync(p); return true; } catch (e) { return false; }
    });
    if (valid.length === 0) {
      wx.showToast({ title: '无有效视频文件', icon: 'none' });
      return;
    }
    const proceed = () => {
      let saved = 0;
      const saveNext = (i) => {
        if (i >= valid.length) {
          wx.showToast({ title: `已保存 ${saved} 个视频到相册`, icon: 'success' });
          if (onComplete) onComplete();
          return;
        }
        wx.saveVideoToPhotosAlbum({
          filePath: valid[i],
          success: () => { saved++; saveNext(i + 1); },
          fail: () => saveNext(i + 1)
        });
      };
      saveNext(0);
    };
    wx.getSetting({
      success: (res) => {
        if (res.authSetting['scope.writePhotosAlbum']) {
          proceed();
        } else {
          wx.authorize({
            scope: 'scope.writePhotosAlbum',
            success: proceed,
            fail: () => {
              wx.showModal({
                title: '需要相册权限',
                content: '请在设置中允许访问相册',
                confirmText: '去设置',
                success: (r) => { if (r.confirm) wx.openSetting({}); }
              });
            }
          });
        }
      }
    });
  },

  // ─────────────────────────────────────────────
  // 自定义播放器
  // ─────────────────────────────────────────────

  /**
   * 点击片段：批量模式下切换选中，普通模式打开播放器
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onHighlightItemTap(e) {
    if (this.data.batchMode) {
      this.onToggleSelect(e);
    } else {
      this.openPlayer(e);
    }
  },

  /**
   * 打开自定义播放器，只加载所属场次的片段列表并定位到所点击项
   * @param {WechatMiniprogram.TouchEvent} e  data-id: 片段ID, data-matchid: 场次ID
   */
  openPlayer(e) {
    const { id, matchid } = e.currentTarget.dataset;
    const direct = this.findClipById(id);
    if (direct && direct.exportedToAlbum) {
      wx.showToast({ title: '该片段已导出至系统相册，请到相册观看', icon: 'none', duration: 2800 });
      return;
    }
    // 只加载同一场次的片段，避免误操作跨场次视频
    const targetGroup = matchid
      ? this.data.groupedHighlights.find((g) => g.matchId === matchid)
      : null;
    const groups = targetGroup ? [targetGroup] : this.data.groupedHighlights;
    const playerList = [];
    groups.forEach((group) => {
      group.videos.forEach((v) => {
        if (v.videoPath) {
          playerList.push({
            id: v.id,
            videoPath: v.videoPath,
            segments: Array.isArray(v.segments) ? v.segments : [v.videoPath],
            timeText: v.timeText || '',
            matchTitle: group.matchTitle || '',
            cover: v.cover || this.data.defaultCover
          });
        }
      });
    });
    const index = playerList.findIndex((x) => x.id === id);
    if (index < 0) {
      wx.showToast({ title: '视频文件不存在', icon: 'none' });
      return;
    }
    this.setData({ showPlayer: true, playerList, playerIndex: index, playerPaused: false });
  },

  /** 关闭播放器面板 */
  closePlayer() {
    this.setData({ showPlayer: false, playerList: [], playerIndex: 0, playerPaused: false });
  },

  /**
   * 播放器点击：切换暂停/播放
   * @returns {void}
   */
  playerTogglePlay() {
    const ctx = wx.createVideoContext('indexPlayerVideo', this);
    if (this.data.playerPaused) {
      ctx.play();
      this.setData({ playerPaused: false });
    } else {
      ctx.pause();
      this.setData({ playerPaused: true });
    }
  },

  /**
   * 当前视频播放结束后自动切换到下一段
   * @returns {void}
   */
  onPlayerVideoEnded() {
    if (this.data.playerIndex < this.data.playerList.length - 1) {
      this.setData({ playerIndex: this.data.playerIndex + 1, playerPaused: false });
      return;
    }
    this.setData({ playerPaused: true });
  },

  /**
   * 触摸开始，记录起始坐标用于滑动判断
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onPlayerTouchStart(e) {
    this._swipeStartX = e.touches[0].clientX;
    this._swipeStartY = e.touches[0].clientY;
  },

  /**
   * 触摸结束，判断水平滑动方向并切换片段
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onPlayerTouchEnd(e) {
    const dx = e.changedTouches[0].clientX - (this._swipeStartX || 0);
    const dy = e.changedTouches[0].clientY - (this._swipeStartY || 0);
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) {
        this.playerNext();
      } else {
        this.playerPrev();
      }
    }
  },

  /** 切换到上一片段 */
  playerPrev() {
    if (this.data.playerIndex > 0) {
      this.setData({ playerIndex: this.data.playerIndex - 1, playerPaused: false });
    }
  },

  /** 切换到下一片段 */
  playerNext() {
    if (this.data.playerIndex < this.data.playerList.length - 1) {
      this.setData({ playerIndex: this.data.playerIndex + 1, playerPaused: false });
    }
  },

  /** 播放器内删除当前片段 */
  playerDelete() {
    const item = this.data.playerList[this.data.playerIndex];
    if (!item) return;
    wx.showModal({
      title: '删除片段',
      content: '确定要删除这段高光视频吗？',
      confirmColor: '#E64340',
      success: (res) => {
        if (!res.confirm) return;
        this.doDeleteHighlight(item.id, true);
        const newList = this.data.playerList.filter((x) => x.id !== item.id);
        if (newList.length === 0) {
          this.closePlayer();
          this.loadHighlights();
          this.refreshFileStorageEstimate();
          return;
        }
        const newIndex = Math.min(this.data.playerIndex, newList.length - 1);
        this.setData({ playerList: newList, playerIndex: newIndex, playerPaused: false });
        this.loadHighlights();
        this.refreshFileStorageEstimate();
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },

  /** 播放器内下载当前片段到相册 */
  playerDownload() {
    const item = this.data.playerList[this.data.playerIndex];
    if (!item) return;
    const clip = this.findClipById(item.id) || item;
    this.saveClipsToAlbum([clip]);
  },

  /** 播放器内下载并删除当前片段 */
  playerDownloadAndDelete() {
    const item = this.data.playerList[this.data.playerIndex];
    if (!item) return;
    const clip = this.findClipById(item.id) || item;
    this.saveClipsToAlbum([clip], () => {
      this.doDeleteHighlight(item.id, true);
      const newList = this.data.playerList.filter((x) => x.id !== item.id);
      if (newList.length === 0) {
        this.closePlayer();
        this.loadHighlights();
        this.refreshFileStorageEstimate();
        return;
      }
      const newIndex = Math.min(this.data.playerIndex, newList.length - 1);
      this.setData({ playerList: newList, playerIndex: newIndex, playerPaused: false });
      this.loadHighlights();
      this.refreshFileStorageEstimate();
    });
  },

  // ─────────────────────────────────────────────
  // 批量管理
  // ─────────────────────────────────────────────

  /** 切换批量管理模式 */
  toggleBatchMode() {
    if (this.data.batchMode) {
      this.setData({ batchMode: false, selectedIdsMap: {}, selectedCount: 0 });
    } else {
      this.setData({ batchMode: true, selectedIdsMap: {}, selectedCount: 0 });
    }
  },

  /**
   * 切换单个片段的选中状态
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onToggleSelect(e) {
    const { id } = e.currentTarget.dataset;
    const map = Object.assign({}, this.data.selectedIdsMap);
    if (map[id]) {
      delete map[id];
    } else {
      map[id] = true;
    }
    this.setData({ selectedIdsMap: map, selectedCount: Object.keys(map).length });
  },

  /**
   * 批量模式：一键全选当前列表全部片段；若已全选则清空选中（全不选）
   * @returns {void}
   */
  toggleSelectAllHighlights() {
    if (!this.data.batchMode) return;
    const total = this.data.batchSelectableTotal || 0;
    if (total === 0) return;
    const selectedCount = this.data.selectedCount;
    if (selectedCount === total) {
      this.setData({ selectedIdsMap: {}, selectedCount: 0 });
      return;
    }
    const map = {};
    this.data.groupedHighlights.forEach((g) => {
      if (!Array.isArray(g.videos)) return;
      g.videos.forEach((v) => {
        if (v && v.id) map[v.id] = true;
      });
    });
    this.setData({ selectedIdsMap: map, selectedCount: Object.keys(map).length });
  },

  /** 批量删除选中片段 */
  batchDelete() {
    const ids = Object.keys(this.data.selectedIdsMap);
    if (ids.length === 0) {
      wx.showToast({ title: '请先选择片段', icon: 'none' });
      return;
    }
    wx.showModal({
      title: `删除 ${ids.length} 个片段`,
      content: '确定要永久删除选中的高光视频吗？此操作不可撤销。',
      confirmColor: '#E64340',
      success: (res) => {
        if (!res.confirm) return;
        ids.forEach((id) => this.doDeleteHighlight(id, true));
        wx.showToast({ title: `已删除 ${ids.length} 个片段`, icon: 'success' });
        this.setData({ batchMode: false, selectedIdsMap: {}, selectedCount: 0 });
        this.loadHighlights();
        this.refreshFileStorageEstimate();
      }
    });
  },

  /** 批量下载选中片段到相册 */
  batchDownload() {
    const ids = Object.keys(this.data.selectedIdsMap);
    if (ids.length === 0) {
      wx.showToast({ title: '请先选择片段', icon: 'none' });
      return;
    }
    const clips = [];
    ids.forEach((id) => {
      const item = this.findClipById(id);
      if (item && item.exportedToAlbum) return;
      if (item && Array.isArray(item.segments)) {
        clips.push(item);
      }
    });
    this.saveClipsToAlbum(clips, () => {
      this.setData({ batchMode: false, selectedIdsMap: {}, selectedCount: 0 });
    });
  },

  /**
   * 长按片段：单独删除（批量模式下忽略）
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onDeleteHighlight(e) {
    if (this.data.batchMode) return;
    const { id } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除高光',
      content: '确定要永久删除这段高光视频吗？',
      confirmColor: '#E64340',
      success: (res) => {
        if (res.confirm) this.doDeleteHighlight(id);
      }
    });
  },

  /**
   * 执行删除（复用）
   * @param {string} id 片段 ID
   * @param {boolean} [silent] true 时不弹 Toast、不刷新列表（批量/播放器操作时使用）
   */
  doDeleteHighlight(id, silent) {
    const fs = wx.getFileSystemManager();
    const clipsMap = clipsStorage.readClipsMapSafe();
    if (!clipsMap) {
      if (!silent) wx.showToast({ title: '高光索引读取失败', icon: 'none' });
      return;
    }
    let foundInClips = false;
    for (const matchId in clipsMap) {
      const bucket = clipsMap[matchId];
      if (!Array.isArray(bucket)) continue;
      const idx = bucket.findIndex((x) => x && String(x.id) === String(id));
      if (idx >= 0) {
        const item = bucket[idx];
        const toUnlink = new Set();
        (item.segments || []).forEach((p) => {
          if (p && typeof p === 'string') toUnlink.add(p);
        });
        if (item.replaySegment && typeof item.replaySegment === 'string') {
          toUnlink.add(item.replaySegment);
        }
        toUnlink.forEach((p) => {
          try {
            fs.unlinkSync(p);
          } catch (e) {}
        });
        bucket.splice(idx, 1);
        foundInClips = true;
        break;
      }
    }
    if (foundInClips) clipsStorage.writeClipsMapSafe(clipsMap);

    const legacyList = wx.getStorageSync('highlight_list') || [];
    const legacyIdx = legacyList.findIndex((x) => x.id === id);
    if (legacyIdx >= 0) {
      const item = legacyList[legacyIdx];
      const toUnlinkL = new Set();
      (item.segments || []).forEach((p) => {
        if (p && typeof p === 'string') toUnlinkL.add(p);
      });
      if (item.replaySegment && typeof item.replaySegment === 'string') {
        toUnlinkL.add(item.replaySegment);
      }
      toUnlinkL.forEach((p) => {
        try {
          fs.unlinkSync(p);
        } catch (e) {}
      });
      legacyList.splice(legacyIdx, 1);
      wx.setStorageSync('highlight_list', legacyList);
    }

    if (!silent) {
      wx.showToast({ title: '已删除', icon: 'success' });
      this.loadHighlights();
      this.refreshFileStorageEstimate();
    }
  },

  /**
   * 单独下载指定片段到相册（点击下载按钮）
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onDownloadHighlight(e) {
    const { id } = e.currentTarget.dataset;
    const item = this.findClipById(id);
    if (!item || !Array.isArray(item.segments) || item.segments.length === 0) {
      wx.showToast({ title: '无可下载文件', icon: 'none' });
      return;
    }
    this.saveClipsToAlbum([item]);
  }
});
