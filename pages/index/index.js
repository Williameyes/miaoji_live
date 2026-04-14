const app = getApp();

const { STORAGE_USER_INFO_KEY } = require('../../utils/request.js');
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

    /** 高光录像列表 */
    highlightList: [],
    groupedHighlights: [],

    defaultCover: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90"><rect width="160" height="90" rx="12" ry="12" fill="%2322262f"/><path d="M66 58V32l28 13-28 13z" fill="%23ffffff" fill-opacity="0.75"/></svg>'
  },

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
      title: '秒记篮球场助手 — 邀你免费试用直播计分',
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
      showEditModal: true
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
    this.setData({
      editingId: id,
      editingMatch: JSON.parse(JSON.stringify(match)),
      showEditModal: true
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
   * 进入计分页：增加登录拦截，设置 currentMatchId，同步 globalData，跳转 live 页
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onGoToLive(e) {
    // 1. 登录鉴权拦截
    const userInfo = wx.getStorageSync('userInfo') || app.globalData.userInfo;
    const isLoggedIn = !!userInfo;

    if (!isLoggedIn) {
      wx.showModal({
        title: '需要登录',
        content: '请先登录后再进行比赛计分',
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
    this.setData({ editingMatch: draft, showColorPicker: false });
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
  // 高光录像管理（沿用原有逻辑）
  // ─────────────────────────────────────────────

  /**
   * 从 Storage 读取高光列表并按比赛场次唯一 ID 分组
   */
  loadHighlights() {
    const rawClips = wx.getStorageSync('MIAOXIE_CLIPS') || {};
    const rawMatches = wx.getStorageSync(STORAGE_KEY) || [];
    
    // 兼容旧版本：从全局 highlight_list 中提取未按 ID 归类的数据（如果需要）
    const legacyClips = wx.getStorageSync('highlight_list') || [];
    
    const groupedList = [];
    
    // 遍历所有比赛场次，按 ID 提取高光
    rawMatches.forEach((match) => {
      const matchId = match.id;
      let matchClips = Array.isArray(rawClips[matchId]) ? rawClips[matchId] : [];
      
      // 兼容逻辑：如果该 matchId 在 MIAOXIE_CLIPS 中没找到，尝试从 legacyClips 中按 matchName 匹配（不推荐，仅作过渡）
      if (matchClips.length === 0 && match.matchName) {
        matchClips = legacyClips.filter(c => c.matchId === matchId || (!c.matchId && c.matchName === match.matchName));
      }

      if (matchClips.length > 0) {
        // 格式化场次标题：【日期】队名A VS 队名B
        const dateStr = this.formatDate(match.createdAt);
        const matchTitle = `【${dateStr}】${match.teamA.name || 'A'} VS ${match.teamB.name || 'B'}`;
        const scoreInfo = `${match.teamA.score} : ${match.teamB.score}`;

        groupedList.push({
          matchId: match.id,
          matchTitle: matchTitle,
          matchName: match.matchName,
          scoreInfo: scoreInfo,
          dateStr: dateStr,
          videos: matchClips.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(v => ({
            ...v,
            timeText: v.timeText || this.formatTime(v.createdAt),
            cover: v.cover || this.data.defaultCover,
            videoPath: v.replaySegment || (v.segments && v.segments[0]) || ''
          }))
        });
      }
    });

    // 还有一种情况：MIAOXIE_CLIPS 中有数据，但对应的比赛场次在 MIAOXIE_MATCHES 中被删除了
    // 这些数据我们也应该显示出来，作为“历史遗留”分组
    const matchIdsInList = rawMatches.map(m => m.id);
    Object.keys(rawClips).forEach(id => {
      if (!matchIdsInList.includes(id) && rawClips[id].length > 0) {
        const firstClip = rawClips[id][0];
        const dateStr = this.formatDate(firstClip.createdAt);
        groupedList.push({
          matchId: id,
          matchTitle: `【${dateStr}】${firstClip.matchName || '已删比赛'} (遗留)`,
          videos: rawClips[id].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).map(v => ({
            ...v,
            timeText: v.timeText || this.formatTime(v.createdAt),
            cover: v.cover || this.data.defaultCover,
            videoPath: v.replaySegment || (v.segments && v.segments[0]) || ''
          }))
        });
      }
    });

    this.setData({ 
      highlightList: legacyClips, // 仅用于兼容性参考
      groupedHighlights: groupedList.sort((a, b) => {
        const timeA = a.videos[0]?.createdAt || 0;
        const timeB = b.videos[0]?.createdAt || 0;
        return timeB - timeA;
      })
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

  /** 一键清理所有高光 */
  clearAllHighlights() {
    if (this.data.groupedHighlights.length === 0) return;
    wx.showModal({
      title: '一键清理',
      content: '确定要删除所有场次的高光片段吗？此操作不可撤销。',
      confirmColor: '#E64340',
      success: (res) => {
        if (res.confirm) {
          const fs = wx.getFileSystemManager();
          
          // 清理 MIAOXIE_CLIPS
          const clipsMap = wx.getStorageSync('MIAOXIE_CLIPS') || {};
          Object.values(clipsMap).forEach(matchClips => {
            matchClips.forEach(item => {
              (Array.isArray(item.segments) ? item.segments : []).forEach(p => {
                try { fs.unlinkSync(p); } catch (e) {}
              });
            });
          });
          wx.setStorageSync('MIAOXIE_CLIPS', {});

          // 清理 legacy highlight_list
          const legacyList = wx.getStorageSync('highlight_list') || [];
          legacyList.forEach(item => {
            (Array.isArray(item.segments) ? item.segments : []).forEach(p => {
              try { fs.unlinkSync(p); } catch (e) {}
            });
          });
          wx.setStorageSync('highlight_list', []);

          wx.showToast({ title: '清理完成', icon: 'success' });
          this.loadHighlights();
        }
      }
    });
  },

  /**
   * 播放高光片段
   * @param {WechatMiniprogram.TouchEvent} e
   */
  playHighlight(e) {
    const { id } = e.currentTarget.dataset;
    const clipsMap = wx.getStorageSync('MIAOXIE_CLIPS') || {};
    let item = null;
    let foundMatchId = null;

    // 先从 MIAOXIE_CLIPS 查找
    for (const matchId in clipsMap) {
      item = clipsMap[matchId].find(x => x.id === id);
      if (item) {
        foundMatchId = matchId;
        break;
      }
    }

    // 如果没找到，从 legacy highlight_list 查找
    if (!item) {
      const legacyList = wx.getStorageSync('highlight_list') || [];
      item = legacyList.find(x => x.id === id);
    }

    if (!item || !item.segments || item.segments.length === 0) {
      wx.showToast({ title: '视频信息不存在', icon: 'none' });
      return;
    }

    // 安全性检查：检查物理文件是否存在
    const fs = wx.getFileSystemManager();
    const validSegments = item.segments.filter(p => {
      try {
        fs.accessSync(p);
        return true;
      } catch (e) {
        return false;
      }
    });

    if (validSegments.length === 0) {
      wx.showModal({
        title: '文件已移除',
        content: '该视频文件已不存在，系统将自动清理无效记录。',
        showCancel: false,
        success: () => {
          this.doDeleteHighlight(id);
        }
      });
      return;
    }

    wx.previewMedia({ sources: validSegments.map((p) => ({ url: p, type: 'video' })) });
  },

  /**
   * 长按删除高光
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onDeleteHighlight(e) {
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

  /** 真正执行删除逻辑（复用） */
  doDeleteHighlight(id) {
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
    this.loadHighlights();
  },

  /**
   * 下载高光到相册
   * @param {WechatMiniprogram.TouchEvent} e
   */
  onDownloadHighlight(e) {
    const { id } = e.currentTarget.dataset;
    const list = Array.isArray(wx.getStorageSync('highlight_list'))
      ? wx.getStorageSync('highlight_list') : [];
    const item = list.find((x) => x.id === id);
    const segments = item && Array.isArray(item.segments) ? item.segments : [];
    if (segments.length === 0) return;

    wx.getSetting({
      success: (res) => {
        const hasAuth = !!res.authSetting['scope.writePhotosAlbum'];
        const doSave = () => {
          const saveNext = (i) => {
            if (i >= segments.length) {
              wx.showToast({ title: '已保存到相册', icon: 'success' });
              return;
            }
            wx.saveVideoToPhotosAlbum({
              filePath: segments[i],
              success: () => saveNext(i + 1),
              fail: () => wx.showToast({ title: '保存失败', icon: 'none' })
            });
          };
          saveNext(0);
        };

        if (hasAuth) { doSave(); return; }

        wx.authorize({
          scope: 'scope.writePhotosAlbum',
          success: doSave,
          fail: () => {
            wx.showModal({
              title: '需要相册权限',
              content: '请在系统设置中允许保存到相册。',
              confirmText: '去设置',
              success: (r) => { if (r.confirm) wx.openSetting({}); }
            });
          }
        });
      }
    });
  }
});
