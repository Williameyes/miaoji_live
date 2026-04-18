const app = getApp();

const { STORAGE_USER_INFO_KEY } = require('../../utils/request.js');
const { buildJerseyIconDataUrl } = require('../../utils/jersey-icon.js');

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
    colorPickerTarget: '', // 'teamA' | 'teamB'
    tempSelectedColor: '',
    colorPresets: COLOR_PRESETS,
    extendedColors: EXTENDED_COLORS,

    /** 编辑浮层：主客队球衣剪影图标（随 bgColor 更新） */
    jerseyIconEditTeamA: '',
    jerseyIconEditTeamB: '',

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

    defaultCover: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90"><rect width="160" height="90" rx="12" ry="12" fill="%2322262f"/><path d="M66 58V32l28 13-28 13z" fill="%23ffffff" fill-opacity="0.75"/></svg>'
  },

  /**
   * @param {WechatMiniprogram.Page.ILifetimePageOptions} [options]
   */
  onLoad() {
    const sys = wx.getSystemInfoSync();
    this.setData({ statusBarHeight: sys.statusBarHeight || 0 });
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
    const matches = Array.isArray(raw) ? raw : [];
    this.setData({ matches });
  },

  /**
   * 持久化并更新视图
   * @param {Array} matches 要保存的完整比赛列表
   */
  saveMatches(matches) {
    wx.setStorageSync(STORAGE_KEY, matches);
    this.setData({ matches });
  },

  /**
   * 构建一个含默认值的新比赛对象
   * @param {number} ts 时间戳，用作唯一 ID
   * @returns {object}
   */
  buildDefaultMatch(ts) {
    return {
      id: `${ts}`,
      matchName: '',
      matchNameColor: '#FFFFFF',
      teamA: { name: '', bgColor: '#E64340', textColor: '#FFFFFF', score: 0 },
      teamB: { name: '', bgColor: '#10AEFF', textColor: '#FFFFFF', score: 0 },
      period: 0,
      isFinished: false,
      createdAt: ts
    };
  },

  /** 点击「新增比赛」——打开编辑浮层，赛名默认沿用上一场 */
  onAddMatch() {
    const draft = this.buildDefaultMatch(Date.now());
    const matches = this.data.matches;
    if (matches.length > 0) {
      // 继承最近一场的赛名与赛名颜色，方便同系列多场比赛快速创建
      const last = matches[0];
      draft.matchName = last.matchName || '';
      draft.matchNameColor = last.matchNameColor || '#FFFFFF';
    }
    this.setData({
      editingId: '',
      editingMatch: draft,
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
    const copied = JSON.parse(JSON.stringify(match));
    this.setData({
      editingId: id,
      editingMatch: copied,
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

    wx.navigateTo({ url: '/pages/live/live' });
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

    let matches = [...this.data.matches];

    if (this.data.editingId) {
      const idx = matches.findIndex((m) => m.id === this.data.editingId);
      if (idx >= 0) {
        // 保留 score / period 等运行时状态，仅更新用户编辑的字段
        matches[idx] = {
          ...matches[idx],
          matchName: draft.matchName,
          matchNameColor: draft.matchNameColor,
          teamA: { ...matches[idx].teamA, name: draft.teamA.name, bgColor: draft.teamA.bgColor, textColor: draft.teamA.textColor },
          teamB: { ...matches[idx].teamB, name: draft.teamB.name, bgColor: draft.teamB.bgColor, textColor: draft.teamB.textColor }
        };
      }
    } else {
      const newMatch = { ...draft, id: `${Date.now()}`, createdAt: Date.now() };
      matches.unshift(newMatch);
    }

    this.saveMatches(matches);
    this.setData({ showEditModal: false, editingMatch: null, editingId: '' });
  },

  /** 关闭编辑浮层（丢弃草稿） */
  closeEditModal() {
    this.setData({ showEditModal: false, editingMatch: null, editingId: '' });
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
    this.setData({
      showColorPicker: true,
      colorPickerTarget: target,
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
    const rawClips = wx.getStorageSync('MIAOXIE_CLIPS') || {};
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
      if (matchClips.length > 0) {
        const dateStr = this.formatDate(match.createdAt);
        groupedList.push({
          matchId: match.id,
          matchTitle: `【${dateStr}】${match.teamA.name || 'A'} VS ${match.teamB.name || 'B'}`,
          matchName: match.matchName,
          scoreInfo: `${match.teamA.score} : ${match.teamB.score}`,
          dateStr,
          videos: matchClips
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .map((v) => ({
              ...v,
              timeText: v.timeText || this.formatTime(v.createdAt),
              cover: v.cover || this.data.defaultCover,
              videoPath: v.replaySegment || (v.segments && v.segments[0]) || ''
            }))
        });
      }
    });

    const matchIdsInList = rawMatches.map((m) => m.id);
    Object.keys(rawClips).forEach((id) => {
      if (!matchIdsInList.includes(id) && rawClips[id].length > 0) {
        const firstClip = rawClips[id][0];
        const dateStr = this.formatDate(firstClip.createdAt);
        groupedList.push({
          matchId: id,
          matchTitle: `【${dateStr}】${firstClip.matchName || '已删比赛'} (遗留)`,
          videos: rawClips[id]
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
            .map((v) => ({
              ...v,
              timeText: v.timeText || this.formatTime(v.createdAt),
              cover: v.cover || this.data.defaultCover,
              videoPath: v.replaySegment || (v.segments && v.segments[0]) || ''
            }))
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
    const clipsMap = wx.getStorageSync('MIAOXIE_CLIPS') || {};
    for (const matchId in clipsMap) {
      const item = clipsMap[matchId].find((x) => x.id === id);
      if (item) return item;
    }
    const legacyList = wx.getStorageSync('highlight_list') || [];
    return legacyList.find((x) => x.id === id) || null;
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
   * 打开自定义播放器，构建全局片段列表并定位到所点击项
   * @param {WechatMiniprogram.TouchEvent} e
   */
  openPlayer(e) {
    const { id } = e.currentTarget.dataset;
    const playerList = [];
    this.data.groupedHighlights.forEach((group) => {
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
          return;
        }
        const newIndex = Math.min(this.data.playerIndex, newList.length - 1);
        this.setData({ playerList: newList, playerIndex: newIndex, playerPaused: false });
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },

  /** 播放器内下载当前片段到相册 */
  playerDownload() {
    const item = this.data.playerList[this.data.playerIndex];
    if (!item) return;
    this.doSaveToAlbum(item.segments);
  },

  /** 播放器内下载并删除当前片段 */
  playerDownloadAndDelete() {
    const item = this.data.playerList[this.data.playerIndex];
    if (!item) return;
    this.doSaveToAlbum(item.segments, () => {
      this.doDeleteHighlight(item.id, true);
      const newList = this.data.playerList.filter((x) => x.id !== item.id);
      if (newList.length === 0) {
        this.closePlayer();
        return;
      }
      const newIndex = Math.min(this.data.playerIndex, newList.length - 1);
      this.setData({ playerList: newList, playerIndex: newIndex, playerPaused: false });
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
    const allSegments = [];
    ids.forEach((id) => {
      const item = this.findClipById(id);
      if (item && Array.isArray(item.segments)) {
        allSegments.push(...item.segments);
      }
    });
    this.doSaveToAlbum(allSegments, () => {
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
    const clipsMap = wx.getStorageSync('MIAOXIE_CLIPS') || {};
    let foundInClips = false;
    for (const matchId in clipsMap) {
      const idx = clipsMap[matchId].findIndex((x) => x.id === id);
      if (idx >= 0) {
        const item = clipsMap[matchId][idx];
        (item.segments || []).forEach((p) => { try { fs.unlinkSync(p); } catch (e) {} });
        clipsMap[matchId].splice(idx, 1);
        foundInClips = true;
        break;
      }
    }
    if (foundInClips) wx.setStorageSync('MIAOXIE_CLIPS', clipsMap);

    const legacyList = wx.getStorageSync('highlight_list') || [];
    const legacyIdx = legacyList.findIndex((x) => x.id === id);
    if (legacyIdx >= 0) {
      const item = legacyList[legacyIdx];
      (item.segments || []).forEach((p) => { try { fs.unlinkSync(p); } catch (e) {} });
      legacyList.splice(legacyIdx, 1);
      wx.setStorageSync('highlight_list', legacyList);
    }

    if (!silent) {
      wx.showToast({ title: '已删除', icon: 'success' });
      this.loadHighlights();
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
    this.doSaveToAlbum(item.segments);
  }
});
