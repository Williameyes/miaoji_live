var API = require('../../../config/api.js');
var wsTokenReq = require('../../../utils/ws-token-request.js');
var checkSyncLabWhitelist = require('../../../utils/sync-lab-whitelist.js').checkSyncLabWhitelist;
var app = getApp();

var STORAGE_KEY = 'MIAOXIE_MATCHES';
var FIXED_ROOM_KEY = 'MIAOXIE_FIXED_ROOM_ID';

/** @const {string[]} 快捷常用预设色 */
var COLOR_PRESETS = [
  '#E64340', '#10AEFF', '#FFBE00', '#07C160',
  '#FF69B4', '#9B59B6', '#34495E', '#000000',
  '#22D3EE', '#F87171', '#60A5FA', '#34D399'
];

/** @const {string[]} 扩展色板 */
var EXTENDED_COLORS = [
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
 * 根据背景色计算高对比度文字色
 * @param {string} hexcolor
 * @returns {string} '#0F172A' | '#FFFFFF'
 */
function getContrastColor(hexcolor) {
  if (!hexcolor) return '#FFFFFF';
  var c = String(hexcolor).replace('#', '');
  if (c.length === 3) c = c.split('').map(function (x) { return x + x; }).join('');
  if (c.length !== 6) return '#FFFFFF';
  var r = parseInt(c.substr(0, 2), 16);
  var g = parseInt(c.substr(2, 2), 16);
  var b = parseInt(c.substr(4, 2), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return '#FFFFFF';
  var yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 145 ? '#0F172A' : '#FFFFFF';
}

/**
 * 获取每场比赛独立的高光切片持久化 Storage Key
 */
function getHighlightStorageKey(matchId, roomId) {
  var cleanMatchId = String(matchId || '').trim();
  var cleanRoomId = String(roomId || '').trim();
  return 'MIAOXIE_HIGHLIGHT_CLIPS_' + (cleanMatchId || ('ROOM_' + (cleanRoomId || 'default')));
}

/**
 * 生成主播本机专属 6 位房间号
 * @returns {string}
 */
function generateUniqueRoomId() {
  return ('000000' + Math.floor(Math.random() * 1000000)).slice(-6);
}

/**
 * 确保 roomId 为合规的 6 位纯数字房间码；不合规返回空串
 * @param {string|number} rawId
 * @returns {string}
 */
function ensure6DigitRoomId(rawId) {
  var digits = String(rawId || '').replace(/\D/g, '');
  if (digits.length >= 6) {
    return digits.slice(0, 6);
  }
  return '';
}

/**
 * 纯 JS 标准 UTF-8 Base64 编码器，保证中文与表情在任意环境零报错、零依赖
 * @param {string} str
 * @returns {string}
 */
function base64EncodeUtf8(str) {
  if (!str) return '';
  var utf8Bytes = [];
  for (var i = 0; i < str.length; i++) {
    var code = str.charCodeAt(i);
    if (code < 0x80) {
      utf8Bytes.push(code);
    } else if (code < 0x800) {
      utf8Bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0xd800 || code >= 0xe000) {
      utf8Bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      i++;
      code = 0x10000 + (((code & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      utf8Bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  var b64Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var result = '';
  var len = utf8Bytes.length;
  for (var j = 0; j < len; j += 3) {
    var b1 = utf8Bytes[j];
    var b2 = j + 1 < len ? utf8Bytes[j + 1] : 0;
    var b3 = j + 2 < len ? utf8Bytes[j + 2] : 0;
    var triplet = (b1 << 16) | (b2 << 8) | b3;
    result += b64Chars.charAt((triplet >> 18) & 63);
    result += b64Chars.charAt((triplet >> 12) & 63);
    result += (j + 1 < len) ? b64Chars.charAt((triplet >> 6) & 63) : '=';
    result += (j + 2 < len) ? b64Chars.charAt(triplet & 63) : '=';
  }
  return result;
}

/**
 * 解析主播专属房间号：URL 显式指定 > 本机已持久化的专属房间 > 默认对齐 313251 开箱即用
 * @param {string} queryRoomId
 * @returns {string}
 */
function resolveHostRoomId(queryRoomId) {
  var queryId = ensure6DigitRoomId(queryRoomId);
  if (queryId) {
    return queryId;
  }
  var storedId = ensure6DigitRoomId(wx.getStorageSync(FIXED_ROOM_KEY) || '');
  if (storedId) {
    return storedId;
  }
  return '313251';
}

/**
 * 生成 OBS 浏览器源链接。hash 再写一遍 roomId，避免 OBS CEF 丢掉 ?query。
 * @param {string} roomId
 * @param {string} [extraQuery] 例如 'mode=live_only' 或 'livePos=score'
 * @returns {string}
 */
function buildObsOverlayUrl(roomId, extraQuery) {
  var id = ensure6DigitRoomId(roomId) || '313251';
  var q = 'roomId=' + id;
  if (extraQuery) {
    q += extraQuery.charAt(0) === '&' ? extraQuery : '&' + extraQuery;
  }
  return 'https://api.mx.server.ndcoo.com/obs-overlay/index.html?' + q;
}

Page({
  data: {
    statusBarHeight: 20,
    roomId: '313251',
    matchId: '',
    matchTitle: '常规赛',
    obsUrl: '',
    wsConnected: false,
    wsStatusText: '未连接',

    // 开始记分与同步开关
    isScoringStarted: false,

    // 场次选择器
    matchList: [],
    selectedMatchIndex: 0,
    
    // 调试日志
    debugLogs: [],
    
    // 球队数据 (包含背景球衣色与自动计算的高对比度文本色)
    teamA: {
      name: '主队',
      color: '#FF2D55',
      textColor: '#FFFFFF',
      score: 0
    },
    teamB: {
      name: '客队',
      color: '#007AFF',
      textColor: '#FFFFFF',
      score: 0
    },
    
    // 颜色选择器浮层状态
    showColorPicker: false,
    colorPickerTarget: '', // 'teamA' | 'teamB'
    colorPickerTitle: '设置队服颜色',
    tempSelectedColor: '#FF2D55',
    colorPresets: COLOR_PRESETS,
    extendedColors: EXTENDED_COLORS,

    // 节次字典
    period: 1,
    periodList: [
      { val: 0, label: '热身' },
      { val: 1, label: '第 1 节' },
      { val: 2, label: '第 2 节' },
      { val: 3, label: '第 3 节' },
      { val: 4, label: '第 4 节' },
      { val: 5, label: '加时赛' },
      { val: 6, label: '完赛' }
    ],

    // 时间采集设备联动 (大表切图)
    timeDeviceRoomId: '',
    isTimeDeviceConnected: false,
    connectedTimeRoomId: '',

    // 赛场高光回放控制
    isHighlightReplaying: false,
    isReplayOperating: false,
    operatingClipIndex: -1,
    isSaveOperating: false,

    // 直播者昵称与版权署名
    broadcasterNickname: '',

    // 防盗播飘动欢迎文案
    isWelcomeMarqueeVisible: false,
    welcomeMarqueeText: '欢迎来到直播间，关注主播一起看球！'
  },

  _socketTask: null,
  _socketGen: 0,
  _wsConnected: false,
  _seq: 0,
  _sessionId: '',
  _heartbeatTimer: null,
  _isConnecting: false,
  _broadcasterNickname: '',

  _addLog: function (msg, type) {
    var now = new Date();
    var timeStr = now.toTimeString().split(' ')[0];
    var logItem = { time: timeStr, msg: msg, type: type || '' };
    var currentLogs = this.data.debugLogs || [];
    var logs = [logItem].concat(currentLogs).slice(0, 30);
    this.setData({ debugLogs: logs });
  },

  onClearLogs: function () {
    this.setData({ debugLogs: [] });
  },

  onForceSync: function () {
    this._loadBroadcasterNickname();
    var nick = this._broadcasterNickname || '';
    this._addLog('🚀 手动触发全量强制同步(比分/队伍/署名: ' + (nick || '本人') + ')...', 'success');
    this._broadcastMatchInfo();
    wx.showToast({ title: '全量同步已下发', icon: 'success' });
  },

  /**
   * 单独下发主播版权署名与欢迎文案到网页端
   */
  onSyncBroadcasterToWeb: function () {
    this._loadBroadcasterNickname();
    var nick = this._broadcasterNickname || '';
    this._addLog('📡 单独下发主播版权署名至网页端: [' + (nick || '本人') + ']...', 'success');
    this._broadcastMatchInfo();
    wx.showToast({
      title: nick ? ('已同步署名: ' + nick) : '已同步默认署名',
      icon: 'success'
    });
  },

  /**
   * 自动从缓存、globalData 读取播主昵称
   */
  _loadBroadcasterNickname: function () {
    var cachedNick = '';
    try { cachedNick = wx.getStorageSync('MIAOXIE_BROADCASTER_NICKNAME') || ''; } catch (e) {}
    if (!cachedNick || cachedNick === '微信用户' || cachedNick === 'WeChat User') {
      var app = getApp();
      var gUser = app && app.globalData && app.globalData.userInfo;
      if (gUser && typeof gUser.nickName === 'string') {
        cachedNick = gUser.nickName.trim();
      }
    }
    if (!cachedNick || cachedNick === '微信用户' || cachedNick === 'WeChat User') {
      try {
        var sUser = wx.getStorageSync('userInfo');
        if (sUser && typeof sUser.nickName === 'string') {
          cachedNick = sUser.nickName.trim();
        }
      } catch (e) {}
    }
    if (cachedNick && cachedNick !== '微信用户' && cachedNick !== 'WeChat User') {
      this._broadcasterNickname = cachedNick;
      try { wx.setStorageSync('MIAOXIE_BROADCASTER_NICKNAME', cachedNick); } catch (e) {}
      this.setData({ broadcasterNickname: cachedNick });
      this._updateWelcomeMarqueeText(cachedNick);
      return cachedNick;
    }
    return '';
  },

  /**
   * 手动设置/修改播主昵称（如输入"韦伯"，清空则恢复"本人"）
   */
  onEditBroadcasterNickname: function () {
    var self = this;
    var current = this.data.broadcasterNickname || '';
    wx.showModal({
      title: '设置主播昵称 / 抖音号',
      content: current,
      editable: true,
      placeholderText: '例如: 韦伯（留空则默认用"本人"）',
      confirmText: '保存并同步',
      success: function (res) {
        if (!res.confirm) return;
        var newNick = (res.content || '').trim();
        if (newNick === '微信用户' || newNick === 'WeChat User') {
          newNick = '';
        }
        self._broadcasterNickname = newNick;
        try {
          if (newNick) {
            wx.setStorageSync('MIAOXIE_BROADCASTER_NICKNAME', newNick);
          } else {
            wx.removeStorageSync('MIAOXIE_BROADCASTER_NICKNAME');
          }
        } catch (e) {}
        self.setData({ broadcasterNickname: newNick });
        self._updateWelcomeMarqueeText(newNick);
        self._addLog(newNick ? ('✅ 署名已更新为: ' + newNick) : 'ℹ️ 署名已恢复默认「本人」', 'success');
        wx.showToast({ title: newNick ? ('已更新: ' + newNick) : '已恢复默认', icon: 'success' });
        // 立即广播更新至网页记分牌
        self._broadcastMatchInfo();
      }
    });
  },

  /**
   * 点击「获取昵称授权」按钮时触发（兼容辅助）
   */
  onGetUserProfile: function () {
    var self = this;
    wx.getUserProfile({
      desc: '用于在直播版权声明中显示您的昵称',
      success: function (res) {
        var nickName = (res.userInfo && res.userInfo.nickName) || '';
        var isDefault = !nickName || nickName === '微信用户' || nickName === 'WeChat User';
        if (!isDefault) {
          self._broadcasterNickname = nickName;
          try { wx.setStorageSync('MIAOXIE_BROADCASTER_NICKNAME', nickName); } catch (e) {}
          self.setData({ broadcasterNickname: nickName });
          self._updateWelcomeMarqueeText(nickName);
          self._addLog('✅ 已获取昵称: ' + nickName + '，版权署名已更新', 'success');
          wx.showToast({ title: '昵称已更新: ' + nickName, icon: 'success' });
          self._broadcastMatchInfo();
        } else {
          self._addLog('⚠️ 微信返回默认占位昵称，请点击按钮手动输入', '');
          self.onEditBroadcasterNickname();
        }
      },
      fail: function () {
        self._addLog('⚠️ 微信未授权，可直接手动设置昵称', '');
        self.onEditBroadcasterNickname();
      }
    });
  },

  /** 根据直播者昵称更新欢迎文案 */
  _updateWelcomeMarqueeText: function (nick) {
    var n = (typeof nick === 'string' ? nick.trim() : '');
    var text = '';
    if (n && n !== '微信用户' && n !== 'WeChat User') {
      text = '欢迎来到 ' + n + ' 直播间，关注 ' + n + ' 一起看球！';
    } else {
      text = '欢迎来到直播间，关注主播一起看球！';
    }
    this.setData({ welcomeMarqueeText: text });
    return text;
  },

  // 点击【▶ 开始记分并同步至网页】
  onToggleStartScore: function () {
    var nextState = !this.data.isScoringStarted;
    this.setData({ isScoringStarted: nextState });

    if (nextState) {
      this._addLog('🚀 激活【开始记分】，全量元数据推送到网页记分牌', 'success');
      this._broadcastMatchInfo();
      wx.showToast({ title: '已开始记分，已同步至网页', icon: 'success' });
    } else {
      this._addLog('⏸️ 记分同步已暂停', '');
      wx.showToast({ title: '记分同步已暂停', icon: 'none' });
    }
  },

  onLoad: function (options) {
    if (!checkSyncLabWhitelist()) {
      wx.showModal({
        title: '提示',
        content: '网页记分功能目前仅对实验白名单用户开放',
        showCancel: false,
        success: function () {
          wx.navigateBack({
            fail: function () {
              wx.switchTab({ url: '/pages/index/index' });
            }
          });
        }
      });
      return;
    }

    var sysInfo = wx.getSystemInfoSync();
    var sbh = sysInfo.statusBarHeight || 20;

    // 唯一 session_id，服务端判断合规 Session
    this._sessionId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    // 自动多级检测并加载登录用户的播主昵称
    this._loadBroadcasterNickname();

    var currentId = options.matchId || options.id || '';
    var rawMatches = wx.getStorageSync(STORAGE_KEY) || wx.getStorageSync('matches') || [];
    var formattedList = [];
    var targetMatch = null;
    var targetIndex = 0;

    if (Array.isArray(rawMatches) && rawMatches.length > 0) {
      formattedList = rawMatches.map(function (m, idx) {
        var tA = (m.teamA && typeof m.teamA === 'object' && m.teamA.name) || (typeof m.teamA === 'string' ? m.teamA : '主队');
        var tB = (m.teamB && typeof m.teamB === 'object' && m.teamB.name) || (typeof m.teamB === 'string' ? m.teamB : '客队');
        var title = (m.matchName || '比赛') + ' (' + tA + ' VS ' + tB + ')';
        if (m.id === currentId) {
          targetIndex = idx;
          targetMatch = m;
        }
        return Object.assign({}, m, { displayTitle: title });
      });
    }

    if (!targetMatch && formattedList.length > 0) {
      targetMatch = formattedList[0];
      targetIndex = 0;
    }

    // 主播专属房间号：URL query > 本机私有缓存 > 首次自动生成（禁止落入公共房间）
    var queryRoomId = options.roomId || options.room_id || options.matchCode || '';
    var roomId = resolveHostRoomId(queryRoomId);
    wx.setStorageSync(FIXED_ROOM_KEY, roomId);

    var matchId = (targetMatch && targetMatch.id) || currentId || ('M_' + roomId);
    var obsUrl = buildObsOverlayUrl(roomId);

    var tA_obj = targetMatch && targetMatch.teamA;
    var tB_obj = targetMatch && targetMatch.teamB;

    var tA_name = (tA_obj && typeof tA_obj === 'object' && tA_obj.name) || (typeof tA_obj === 'string' ? tA_obj : '') || (options.teamA && options.teamA !== 'undefined' ? decodeURIComponent(options.teamA) : '主队');
    var tB_name = (tB_obj && typeof tB_obj === 'object' && tB_obj.name) || (typeof tB_obj === 'string' ? tB_obj : '') || (options.teamB && options.teamB !== 'undefined' ? decodeURIComponent(options.teamB) : '客队');

    var tA_color = (tA_obj && typeof tA_obj === 'object' && (tA_obj.bgColor || tA_obj.color)) || (options.colorA && options.colorA !== 'undefined' ? '#' + options.colorA.replace('#', '') : '#FF2D55');
    var tB_color = (tB_obj && typeof tB_obj === 'object' && (tB_obj.bgColor || tB_obj.color)) || (options.colorB && options.colorB !== 'undefined' ? '#' + options.colorB.replace('#', '') : '#007AFF');

    var tA_score = (tA_obj && typeof tA_obj.score === 'number') ? tA_obj.score : 0;
    var tB_score = (tB_obj && typeof tB_obj.score === 'number') ? tB_obj.score : 0;

    var mTitle = (targetMatch && targetMatch.matchName) || '常规赛';
    var mPeriod = (targetMatch && targetMatch.period !== undefined) ? targetMatch.period : 1;

    if (formattedList.length === 0) {
      formattedList = [{
        id: matchId,
        matchName: mTitle,
        period: mPeriod,
        teamA: { name: tA_name, bgColor: tA_color, score: tA_score },
        teamB: { name: tB_name, bgColor: tB_color, score: tB_score },
        displayTitle: mTitle + ' (' + tA_name + ' VS ' + tB_name + ')'
      }];
    }

    var storedTimeRoomId = wx.getStorageSync('MIAOXIE_TIME_DEVICE_ROOM_ID') || '';
    var highlightKey = getHighlightStorageKey(matchId, roomId);
    var storedClips = wx.getStorageSync(highlightKey) || [];

    var tA_textColor = getContrastColor(tA_color);
    var tB_textColor = getContrastColor(tB_color);

    this.setData({
      statusBarHeight: sbh,
      roomId: roomId,
      timeDeviceRoomId: storedTimeRoomId,
      matchId: matchId,
      matchTitle: mTitle,
      obsUrl: obsUrl,
      matchList: formattedList,
      selectedMatchIndex: targetIndex,
      period: mPeriod,
      savedHighlightClips: storedClips,
      'teamA.name': tA_name,
      'teamA.color': tA_color,
      'teamA.textColor': tA_textColor,
      'teamA.score': tA_score,
      'teamB.name': tB_name,
      'teamB.color': tB_color,
      'teamB.textColor': tB_textColor,
      'teamB.score': tB_score
    });

    this._addLog('🚀 页面初始化: [' + mTitle + '] ' + tA_name + '(' + tA_color + ') VS ' + tB_name + '(' + tB_color + ') | 本场切片: ' + storedClips.length + '段', 'success');
    this._connectWs(roomId);
  },

  onShow: function () {
    this._loadBroadcasterNickname();
    if (!this.data.wsConnected && !this._isConnecting && this.data.roomId) {
      this._addLog('📱 页面恢复前台，尝试建连...', '');
      this._connectWs(this.data.roomId);
    }
  },

  onUnload: function () {
    this._manualClosed = true;
    this._closeWs();
  },

  onGoBack: function () {
    wx.navigateBack({
      fail: function () {
        wx.switchTab({ url: '/pages/index/index' });
      }
    });
  },

  // 1. 下拉框无缝切换比赛（不换房间号，网页端平滑切队名比分）
  onMatchPickerChange: function (e) {
    var index = parseInt(e.detail.value, 10) || 0;
    var match = this.data.matchList[index];
    if (!match) return;

    var newMatchId = match.id || ('M_' + this.data.roomId);

    var tA_obj = match.teamA;
    var tB_obj = match.teamB;

    var tA_name = (tA_obj && typeof tA_obj === 'object' && tA_obj.name) || (typeof tA_obj === 'string' ? tA_obj : '') || '主队';
    var tB_name = (tB_obj && typeof tB_obj === 'object' && tB_obj.name) || (typeof tB_obj === 'string' ? tB_obj : '') || '客队';

    var tA_color = (tA_obj && typeof tA_obj === 'object' && (tA_obj.bgColor || tA_obj.color)) || '#FF2D55';
    var tB_color = (tB_obj && typeof tB_obj === 'object' && (tB_obj.bgColor || tB_obj.color)) || '#007AFF';

    var tA_score = (tA_obj && typeof tA_obj.score === 'number') ? tA_obj.score : 0;
    var tB_score = (tB_obj && typeof tB_obj.score === 'number') ? tB_obj.score : 0;

    var mTitle = match.matchName || '常规赛';
    var mPeriod = (match.period !== undefined) ? match.period : 1;

    var matchHighlightKey = getHighlightStorageKey(newMatchId, this.data.roomId);
    var matchStoredClips = wx.getStorageSync(matchHighlightKey) || [];

    var tA_textColor = getContrastColor(tA_color);
    var tB_textColor = getContrastColor(tB_color);

    var self = this;
    this.setData({
      selectedMatchIndex: index,
      matchId: newMatchId,
      matchTitle: mTitle,
      period: mPeriod,
      savedHighlightClips: matchStoredClips,
      'teamA.name': tA_name,
      'teamA.color': tA_color,
      'teamA.textColor': tA_textColor,
      'teamA.score': tA_score,
      'teamB.name': tB_name,
      'teamB.color': tB_color,
      'teamB.textColor': tB_textColor,
      'teamB.score': tB_score
    }, function () {
      self._addLog('🔄 无缝切换场次: [' + mTitle + '] ' + tA_name + ' VS ' + tB_name + ' (已载入切片: ' + matchStoredClips.length + '段)', 'success');
      if (!self.data.isScoringStarted) {
        self.setData({ isScoringStarted: true });
      }
      self._broadcastMatchInfo();
    });

    wx.showToast({ title: '已切换至: ' + tA_name + ' VS ' + tB_name, icon: 'none' });
  },

  // 快捷一键切换房间 (直接切断旧房间并极速接入新房间)
  _switchDirectRoom: function (newRoomId) {
    var digits = ensure6DigitRoomId(newRoomId);
    if (!digits) return;
    wx.setStorageSync(FIXED_ROOM_KEY, digits);
    var newObsUrl = buildObsOverlayUrl(digits);
    this._isConnecting = false;
    this.setData({
      roomId: digits,
      obsUrl: newObsUrl,
      wsConnected: false,
      wsStatusText: '切换中(' + digits + ')...'
    });
    this._addLog('🔑 专属房间号已切换为: ' + digits + '，正在建立连接...', 'success');
    wx.showToast({ title: '已切换至房间 ' + digits, icon: 'success' });
    this._connectWs(digits);
  },

  // 点击状态栏弹出快捷面板（核对房间、切换房间、立即重连）
  onTapWsStatus: function () {
    var self = this;
    var currentRoom = this.data.roomId || '313251';
    var isOnline = this.data.wsConnected;
    var statusTitle = isOnline ? ('🟢 当前已连通房间: ' + currentRoom) : ('🔴 当前未连通房间: ' + currentRoom);
    
    wx.showActionSheet({
      itemList: [
        '🔄 立即刷新长连接 (当前房间 ' + currentRoom + ')',
        '✏️ 手动输入修改房间号',
        '⚡ 快捷切到 313251 (当前测试房)',
        '⚡ 快捷切到 178884 (备用测试房)',
        '🚀 发送双端互通测试指令 (推送比分+横幅)'
      ],
      success: function (res) {
        if (res.tapIndex === 0) {
          self._manualClosed = false;
          self._reconnectAttempt = 0;
          self._connectWs(currentRoom);
          wx.showToast({ title: '已刷新: ' + currentRoom, icon: 'none' });
        } else if (res.tapIndex === 1) {
          self.onEditRoomId();
        } else if (res.tapIndex === 2) {
          self._switchDirectRoom('313251');
        } else if (res.tapIndex === 3) {
          self._switchDirectRoom('178884');
        } else if (res.tapIndex === 4) {
          self.onTestPingOBS();
        }
      }
    });
  },

  // 调度自动重连 (退避重试)
  _scheduleWsReconnect: function () {
    if (this._manualClosed) return;
    if (this._reconnectTimer) return;

    var attempt = this._reconnectAttempt || 0;
    var wait = Math.min(12000, 1500 * Math.pow(1.5, attempt));
    this._reconnectAttempt = attempt + 1;

    var self = this;
    console.log('[WebScorePanel] scheduleWsReconnect in', wait, 'ms, attempt:', this._reconnectAttempt);
    this.setData({ wsConnected: false, wsStatusText: '重连中(' + Math.round(wait / 1000) + 's)...' });

    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      if (!self._manualClosed && !self._wsConnected) {
        self._connectWs(self.data.roomId);
      }
    }, wait);
  },

  // 2. 建立 WebSocket 长连接 (带防重复并发锁与代际保护，彻底杜绝僵尸旧连接抢占)
  _connectWs: function (rawRoomId) {
    var roomId = ensure6DigitRoomId(rawRoomId);
    var self = this;
    if (!roomId) {
      this.setData({ wsConnected: false, wsStatusText: '无房间号' });
      this._addLog('❌ 缺少有效 6 位房间号，已跳过连接', 'error');
      return;
    }

    // 先强制关闭可能遗留的旧 Socket 任务并递增代际，旧回调自动丢弃
    this._closeWs();
    this._manualClosed = false;
    var currentGen = ++this._socketGen;

    this._isConnecting = true;
    this.setData({ wsStatusText: '连接中(' + roomId + ')...', roomId: roomId, obsUrl: buildObsOverlayUrl(roomId) });
    this._addLog('🔑 正在请求 Token (房间: ' + roomId + ')...', '');

    wsTokenReq.fetchWsToken(roomId)
      .then(function (tokenStr) {
        if (self._socketGen !== currentGen) return;

        if (!tokenStr || typeof tokenStr !== 'string') {
          self._isConnecting = false;
          self._wsConnected = false;
          self.setData({ wsConnected: false, wsStatusText: 'Token无效' });
          self._addLog('❌ Token 异常', 'error');
          self._scheduleWsReconnect();
          return;
        }

        self._addLog('🟢 Token 获取成功, 正在建立 WebSocket 链接...', 'success');
        var wsUrl = 'wss://api.mx.server.ndcoo.com/gaoguang-ws?roomId=' + roomId + '&token=' + encodeURIComponent(tokenStr);

        self._socketTask = wx.connectSocket({
          url: wsUrl,
          success: function () {
            console.log('[WebScorePanel] connectSocket init success, roomId=' + roomId);
          },
          fail: function (err) {
            if (self._socketGen !== currentGen) return;
            console.error('[WebScorePanel] connectSocket fail', err);
            self._isConnecting = false;
            self._wsConnected = false;
            var msg = err && err.errMsg ? err.errMsg : '连接失败';
            self.setData({ wsConnected: false, wsStatusText: msg });
            self._addLog('❌ connectSocket 失败: ' + msg, 'error');
            self._scheduleWsReconnect();
          }
        });

        self._socketTask.onOpen(function () {
          if (self._socketGen !== currentGen) return;
          console.log('[WebScorePanel] WebSocket onOpen! (gen=' + currentGen + ', room=' + roomId + ')');
          self._isConnecting = false;
          self._wsConnected = true;
          self._reconnectAttempt = 0;
          if (self._reconnectTimer) {
            clearTimeout(self._reconnectTimer);
            self._reconnectTimer = null;
          }
          self.setData({ wsConnected: true, wsStatusText: '🟢 房间 ' + roomId + ' 已连通' });
          self._addLog('✅ WebSocket 成功建立! (房间:' + roomId + ')', 'success');

          // 发送 BROADCAST_JOIN 确保网关登记该连接
          try {
            self._socketTask.send({
              data: JSON.stringify({
                type: 'BROADCAST_JOIN',
                roomId: roomId,
                sys_t: Date.now()
              })
            });
          } catch (eJoin) {}

          self._startHeartbeat();

          // 连通后自动发全量比赛快照
          self._broadcastMatchInfo();
        });

        self._socketTask.onMessage(function (event) {
          if (self._socketGen !== currentGen) return;
          try {
            var msg = JSON.parse(event.data);
            var d = (msg.data || msg);
            var act = d.act || msg.act || msg.type || '';

            // 监听 OBS 高光自动结束广播 -> 自动将小程序按钮重置为【播放高光】
            if (act === 'STOP_HIGHLIGHT_REPLAY' || d.isReplay === false) {
              if (self.data.isHighlightReplaying) {
                self.setData({ isHighlightReplaying: false });
                self._addLog('🎬 OBS 高光播放结束，已自动切回直播控制', 'success');
              }
            } else if (act === 'HIGHLIGHT_LIST_SYNC' && Array.isArray(d.clips)) {
              var mapped = d.clips.map(function (pathStr, idx) {
                var fName = decodeURIComponent(String(pathStr).split('/').pop().split('\\').pop());
                return {
                  id: 'clip_' + idx + '_' + fName,
                  index: idx,
                  filePath: pathStr,
                  title: '精彩高光 #' + (d.clips.length - idx),
                  fileName: fName
                };
              });
              self.setData({ savedHighlightClips: mapped });
              self._addLog('⚡ 已同步 OBS 实际高光切片 (' + mapped.length + '段)', 'success');
            }

            if (msg.type === 'BROADCAST_JOIN' || msg.act === 'BROADCAST_JOIN' || msg.type === 'BROADCAST_JOINED_TRIGGER' || msg.act === 'BROADCAST_JOINED_TRIGGER' || msg.type === 'REQUEST_CROP_FRAME') {
              self._addLog('🔔 收到 OBS 网页端进房请求，实时推送队伍及比分快照!', 'success');
              if (!self.data.isScoringStarted) {
                self.setData({ isScoringStarted: true });
              }
              self._broadcastMatchInfo();
            }
          } catch (e) {}
        });

        self._socketTask.onClose(function (e) {
          if (self._socketGen !== currentGen) return;
          console.log('[WebScorePanel] WebSocket onClose (gen=' + currentGen + ')', e);
          self._isConnecting = false;
          self._wsConnected = false;
          self._stopHeartbeat();
          self.setData({ wsConnected: false, wsStatusText: '已断开重连中(' + roomId + ')...' });
          self._addLog('⚠️ WebSocket 断开，准备自动重连', 'error');
          self._scheduleWsReconnect();
        });

        self._socketTask.onError(function (err) {
          if (self._socketGen !== currentGen) return;
          console.error('[WebScorePanel] WebSocket onError (gen=' + currentGen + ')', err);
          self._isConnecting = false;
          self._wsConnected = false;
          self._stopHeartbeat();
          var errMsg = err && err.errMsg ? err.errMsg : '异常';
          self.setData({ wsConnected: false, wsStatusText: '连接异常重连中(' + roomId + ')...' });
          self._addLog('❌ WebSocket 错误: ' + errMsg + '，准备自动重连', 'error');
          self._scheduleWsReconnect();
        });
      })
      .catch(function (err) {
        if (self._socketGen !== currentGen) return;
        console.error('[WebScorePanel] fetchWsToken fail', err);
        self._isConnecting = false;
        self._wsConnected = false;
        var errDesc = err && err.message ? err.message : 'Token异常';
        self.setData({ wsConnected: false, wsStatusText: errDesc });
        self._addLog('❌ Token 请求失败: ' + errDesc, 'error');
        self._scheduleWsReconnect();
      });
  },

  _closeWs: function () {
    this._socketGen++;
    this._wsConnected = false;
    this._stopHeartbeat();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._socketTask) {
      try {
        this._socketTask.close({});
      } catch (e) {}
      this._socketTask = null;
    }
  },

  _startHeartbeat: function () {
    var self = this;
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(function () {
      if (self._socketTask && (self._wsConnected || self.data.wsConnected)) {
        self._socketTask.send({
          data: JSON.stringify({
            type: 'BROADCAST_HEARTBEAT',
            roomId: self.data.roomId,
            sys_t: Date.now(),
            seq: self._seq,
            t: 600,
            session_id: self._sessionId,
            match_id: self._buildEncodedMatchId(),
            ping: 1
          })
        });
      }
    }, 8000);
  },

  _stopHeartbeat: function () {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  },

  // 手动修改主播专属房间号（支持 313251 / 178884 测试或任意自定义）
  onEditRoomId: function () {
    var self = this;
    var current = this.data.roomId || '313251';
    wx.showModal({
      title: '设置主播房间号 (6位纯数字)',
      content: current,
      editable: true,
      placeholderText: '例如: 313251',
      confirmText: '保存并切换',
      success: function (res) {
        if (!res.confirm) return;
        var digits = String(res.content || '').replace(/\D/g, '').slice(0, 6);
        if (digits.length !== 6) {
          wx.showToast({ title: '请输入 6 位纯数字', icon: 'none' });
          return;
        }
        wx.setStorageSync(FIXED_ROOM_KEY, digits);
        var newObsUrl = buildObsOverlayUrl(digits);
        self.setData({
          roomId: digits,
          obsUrl: newObsUrl,
          wsConnected: false,
          wsStatusText: '重连中...'
        });
        self._addLog('🔑 专属房间号已切换为: ' + digits + '，正在重新建立连接...', 'success');
        wx.showToast({ title: '已切换至房间 ' + digits, icon: 'success' });
        self._connectWs(digits);
      }
    });
  },

  // 一键生成全新专属独立房间号 (防止多人共用)
  onGenerateNewRoomId: function () {
    var self = this;
    var newId = generateUniqueRoomId();
    wx.showModal({
      title: '生成专属新房间',
      content: '确定切换为新的专属房间号【' + newId + '】吗？切换后 OBS 请重新复制粘贴此新链接。',
      confirmText: '确认切换',
      success: function (res) {
        if (!res.confirm) return;
        wx.setStorageSync(FIXED_ROOM_KEY, newId);
        var newObsUrl = buildObsOverlayUrl(newId);
        self.setData({
          roomId: newId,
          obsUrl: newObsUrl,
          wsConnected: false,
          wsStatusText: '重连中...'
        });
        self._addLog('🔑 已生成全新专属房间号: ' + newId + '，正在连接...', 'success');
        wx.showToast({ title: '新房间: ' + newId, icon: 'success' });
        self._connectWs(newId);
      }
    });
  },

  // 3.0 复制 6 位纯房间码 (手动输入连接方式)
  onCopyRoomCode: function () {
    var code = this.data.roomId || '178884';
    var self = this;
    wx.setClipboardData({
      data: code,
      success: function () {
        self._addLog('📋 已复制专属房间码: ' + code, 'success');
        wx.showToast({ title: '房间码已复制: ' + code, icon: 'success' });
      }
    });
  },

  // 3.0.1 复制纯 OBS 网页链接 (无参版，搭配手动输入房间码使用)
  onCopyCleanObsUrl: function () {
    var cleanUrl = 'https://api.mx.server.ndcoo.com/obs-overlay/index.html';
    var self = this;
    wx.setClipboardData({
      data: cleanUrl,
      success: function () {
        self._addLog('📋 已复制 OBS 纯网页链接 (无参版): ' + cleanUrl, 'success');
        wx.showToast({ title: '纯网页链接已复制', icon: 'success' });
      }
    });
  },

  // 3. 复制 OBS URL (带参数版)
  onCopyObsUrl: function () {
    var url = buildObsOverlayUrl(this.data.roomId);
    var self = this;
    wx.setClipboardData({
      data: url,
      success: function () {
        self._addLog('📋 已复制 1080P 标准全屏记分牌链接: ' + url, 'success');
        wx.showToast({ title: '全屏链接已复制', icon: 'success' });
      }
    });
  },

  onCopyScoreDockedUrl: function () {
    var url = buildObsOverlayUrl(this.data.roomId, 'livePos=score');
    var self = this;
    wx.setClipboardData({
      data: url,
      success: function () {
        self._addLog('📋 已复制记分牌左侧一体角标链接: ' + url, 'success');
        wx.showToast({ title: '一体角标链接已复制', icon: 'success' });
      }
    });
  },

  onCopyLiveOnlyUrl: function () {
    var url = buildObsOverlayUrl(this.data.roomId, 'mode=live_only');
    var self = this;
    wx.setClipboardData({
      data: url,
      success: function () {
        self._addLog('📋 已复制独立 LIVE 角标小图层链接: ' + url, 'success');
        wx.showToast({ title: '独立角标链接已复制', icon: 'success' });
      }
    });
  },

  // 3.1 时间设备联动 (输入采集端房间号控制)
  onTimeDeviceRoomInput: function (e) {
    var val = (e && e.detail && e.detail.value) || '';
    var cleanVal = String(val).replace(/\D/g, '').slice(0, 6);
    this.setData({ timeDeviceRoomId: cleanVal });
  },

  onConnectTimeDevice: function () {
    var cleanId = String(this.data.timeDeviceRoomId || '').replace(/\D/g, '').slice(0, 6);
    if (cleanId.length !== 6) {
      wx.showToast({ title: '请输入 6 位采集房间码', icon: 'none' });
      return;
    }
    wx.setStorageSync('MIAOXIE_TIME_DEVICE_ROOM_ID', cleanId);
    this.setData({
      isTimeDeviceConnected: true,
      connectedTimeRoomId: cleanId
    });
    this._addLog('⏱️ 下发连接时间设备指令 (房间: ' + cleanId + ')', 'success');
    this._sendUpdatePacket('CONNECT_TIME_ROOM', {
      timeRoomId: cleanId,
      time_room_id: cleanId,
      timeSyncEnabled: 1,
      time_device: {
        enabled: true,
        roomId: cleanId
      }
    });
    wx.showToast({ title: '已通知网页端连接时间设备', icon: 'success' });
  },

  onDisconnectTimeDevice: function () {
    this.setData({
      isTimeDeviceConnected: false,
      connectedTimeRoomId: ''
    });
    this._addLog('🔌 下发断开时间设备指令并通知网页端撤下时间', 'error');
    this._sendUpdatePacket('DISCONNECT_TIME_ROOM', {
      timeRoomId: '',
      time_room_id: '',
      timeSyncEnabled: 0,
      time_device: {
        enabled: false,
        roomId: ''
      }
    });
    wx.showToast({ title: '已通知网页端断开并撤下时间', icon: 'none' });
  },

  // 3.2 赛场高光回放控制下发
  onTriggerSaveHighlight: function () {
    var self = this;
    var now = Date.now();

    // 防抖处理：防止 2 秒内因网络延迟多次快速点击
    if (this._lastSaveClickTime && (now - this._lastSaveClickTime < 2000)) {
      wx.showToast({ title: '保存指令下发中，请稍候...', icon: 'none' });
      return;
    }
    this._lastSaveClickTime = now;

    this.setData({ isSaveOperating: true });
    wx.showLoading({ title: '正在保存高光...', mask: true });

    var timeStr = (new Date().getHours() < 10 ? '0' : '') + new Date().getHours() + ':' +
                  (new Date().getMinutes() < 10 ? '0' : '') + new Date().getMinutes() + ':' +
                  (new Date().getSeconds() < 10 ? '0' : '') + new Date().getSeconds();

    var currentList = this.data.savedHighlightClips || [];
    var newClip = {
      id: 'clip_' + now,
      index: 0,
      time: timeStr,
      title: '精彩高光 #' + (currentList.length + 1)
    };

    var updatedList = [newClip].concat(currentList).map(function (item, idx) {
      item.index = idx;
      return item;
    });

    var highlightKey = getHighlightStorageKey(this.data.matchId, this.data.roomId);
    this.setData({ savedHighlightClips: updatedList });
    try {
      wx.setStorageSync(highlightKey, updatedList);
    } catch (e) {}

    this._addLog('💾 远程下发【保存 OBS 重放缓冲区高光片段】指令 (' + timeStr + ')', 'success');
    this._sendUpdatePacket('TRIGGER_SAVE_HIGHLIGHT', {
      timestamp: now
    });

    setTimeout(function () {
      wx.hideLoading();
      self.setData({ isSaveOperating: false });
      wx.showToast({ title: '已保存高光 #' + updatedList.length, icon: 'success' });
    }, 1200);
  },

  onClearHighlightClips: function () {
    var self = this;
    wx.showModal({
      title: '清空本场高光',
      content: '确定清空本场比赛已保存的高光切片列表吗？',
      confirmText: '清空',
      confirmColor: '#FF2D55',
      success: function (res) {
        if (res.confirm) {
          var highlightKey = getHighlightStorageKey(self.data.matchId, self.data.roomId);
          try {
            wx.removeStorageSync(highlightKey);
          } catch (e) {}
          self.setData({ savedHighlightClips: [] });
          self._addLog('🗑️ 已清空本场比赛高光切片记录', 'success');
          wx.showToast({ title: '已清空记录', icon: 'none' });
        }
      }
    });
  },

  onPlaySpecificClip: function (e) {
    var self = this;
    var ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    var clipIdx = parseInt(ds.index, 10);
    if (isNaN(clipIdx) || clipIdx < 0) clipIdx = 0;
    var targetNum = clipIdx + 1;
    var customAct = 'START_HIGHLIGHT_REPLAY_' + targetNum;
    var now = Date.now();

    // 防抖处理：防止 2.5 秒内因网络延迟重复点击相同高光片段导致 OBS 不断被重置
    if (this._lastPlayClickTime && (now - this._lastPlayClickTime < 2500) && this.data.operatingClipIndex === clipIdx) {
      wx.showToast({ title: '回放拉起中，请勿重复点击', icon: 'none' });
      return;
    }
    this._lastPlayClickTime = now;

    this.setData({
      isHighlightReplaying: true,
      isReplayOperating: true,
      operatingClipIndex: clipIdx
    });

    wx.showLoading({ title: '正在拉起回放...', mask: true });

    this._addLog('🎬 下发【播放第 ' + targetNum + ' 段高光】指令 (ACT: ' + customAct + ')', 'success');
    this._sendUpdatePacket(customAct, {
      isReplay: true,
      targetIndex: targetNum,
      clipIndex: clipIdx,
      act: customAct,
      timestamp: now
    });

    setTimeout(function () {
      wx.hideLoading();
      self.setData({
        isReplayOperating: false,
        operatingClipIndex: -1
      });
      wx.showToast({ title: '已下发第 ' + targetNum + ' 段高光播放', icon: 'success' });
    }, 1500);
  },

  onStopHighlightReplay: function () {
    var now = Date.now();
    if (this._lastStopClickTime && (now - this._lastStopClickTime < 1500)) {
      return;
    }
    this._lastStopClickTime = now;

    wx.hideLoading();
    this.setData({
      isHighlightReplaying: false,
      isReplayOperating: false,
      operatingClipIndex: -1
    });

    this._addLog('📺 下发【立即中断回放】指令到网页记分牌 (红色 Live 转场)', 'error');
    this._sendUpdatePacket('STOP_HIGHLIGHT_REPLAY', {
      isReplay: false,
      timestamp: now
    });
    wx.showToast({ title: '已中断切回直播', icon: 'none' });
  },

  // ─────────────────────────────────────────────
  // 防盗播飘动欢迎文案控制
  // ─────────────────────────────────────────────

  /** 显示飘动欢迎文案（由主播在节间休息时主动触发） */
  onShowWelcomeMarquee: function () {
    var nick = this._broadcasterNickname || this.data.broadcasterNickname || '';
    var text = this._updateWelcomeMarqueeText(nick);
    this.setData({ isWelcomeMarqueeVisible: true });
    this._addLog('🎉 下发【显示欢迎文案】指令: ' + text, 'success');
    this._sendUpdatePacket('SHOW_WELCOME_MARQUEE', {
      marqueeText: text,
      welcomeText: text,
      text: text,
      broadcaster: nick,
      broadcasterNickname: nick,
      bc: nick,
      timestamp: Date.now()
    });
    wx.showToast({ title: '已触发欢迎文案飘动', icon: 'success' });
  },

  /** 关闭飘动欢迎文案（开始比赛时关闭，不影响观看） */
  onHideWelcomeMarquee: function () {
    this.setData({ isWelcomeMarqueeVisible: false });
    this._addLog('🔕 下发【关闭欢迎文案】指令', '');
    this._sendUpdatePacket('HIDE_WELCOME_MARQUEE', {
      timestamp: Date.now()
    });
    wx.showToast({ title: '欢迎文案已关闭', icon: 'none' });
  },

  // 将比赛元数据（比赛名、主客队名、主客队球衣颜色、高光目标索引、动作类型）编码进 match_id 字段中，确保服务端广播 100% 透传
  _buildEncodedMatchId: function (extra, act) {
    var mTitle = this.data.matchTitle || '常规赛';
    var tA_name = this.data.teamA.name || '主队';
    var tB_name = this.data.teamB.name || '客队';
    var tA_color = (this.data.teamA.color || '#FF2D55').replace('#', '');
    var tB_color = (this.data.teamB.color || '#007AFF').replace('#', '');
    var mId = this.data.matchId || ('M_' + this.data.roomId);
    var actType = act || (extra && extra.act) || '';

    try {
      var payload = {
        id: mId,
        t: mTitle,
        a: tA_name,
        b: tB_name,
        ca: tA_color,
        cb: tB_color,
        tr: this.data.isTimeDeviceConnected ? this.data.connectedTimeRoomId : '',
        ci: (extra && typeof extra.targetIndex !== 'undefined') ? extra.targetIndex : ((extra && typeof extra.clipIndex !== 'undefined') ? (extra.clipIndex + 1) : 0),
        act: actType,
        bc: this._broadcasterNickname || '',
        mt: (extra && (extra.marqueeText || extra.welcomeText || extra.text)) || (this.data.welcomeMarqueeText || '')
      };
      var jsonStr = JSON.stringify(payload);
      var b64 = base64EncodeUtf8(jsonStr);
      return 'META64_' + b64;
    } catch (e) {
      return 'META_' + encodeURIComponent(mTitle) + '~' + encodeURIComponent(tA_name) + '~' + encodeURIComponent(tB_name) + '~' + tA_color + '~' + tB_color + '~' + encodeURIComponent(mId) + '~' + encodeURIComponent(this._broadcasterNickname || '');
    }
  },

  // 4. 广播数据包（关键：携带 session_id、比赛名称、队伍名与球衣颜色）
  _sendUpdatePacket: function (act, extra) {
    var actType = act || 'SCORE';
    var self = this;

    if (!this._socketTask || (!this._wsConnected && !this.data.wsConnected)) {
      this._addLog('⚠️ 长连接未在线 (当前房间: ' + this.data.roomId + ')，正在重新建连...', 'error');
      wx.showToast({ title: '网络未连通，正在重连...', icon: 'none' });
      this._connectWs(this.data.roomId);
      return;
    }
    this._seq += 1;
    var now = Date.now();

    var tA_name = this.data.teamA.name || '主队';
    var tB_name = this.data.teamB.name || '客队';
    var tA_color = this.data.teamA.color || '#FF2D55';
    var tB_color = this.data.teamB.color || '#007AFF';
    var tA_score = Number(this.data.teamA.score) || 0;
    var tB_score = Number(this.data.teamB.score) || 0;
    var mTitle = this.data.matchTitle || '常规赛';
    var rawPeriod = Number(this.data.period);
    var mPeriod = isNaN(rawPeriod) ? 1 : rawPeriod;

    var encodedMatchId = this._buildEncodedMatchId(extra, actType);

    var packet = {
      type: 'COLLECTOR_UPDATE',
      act: actType,
      t: 600,
      a: tA_score,
      b: tB_score,
      p: mPeriod,
      seq: this._seq,
      sys_t: now,
      session_id: this._sessionId,
      match_id: encodedMatchId,
      sync_score: 1,
      broadcaster: this._broadcasterNickname || '',
      broadcasterNickname: this._broadcasterNickname || '',
      bc: this._broadcasterNickname || '',

      // 时间设备联动状态
      timeRoomId: this.data.isTimeDeviceConnected ? this.data.connectedTimeRoomId : '',
      time_room_id: this.data.isTimeDeviceConnected ? this.data.connectedTimeRoomId : '',
      timeSyncEnabled: this.data.isTimeDeviceConnected ? 1 : 0,
      time_device: {
        enabled: this.data.isTimeDeviceConnected,
        roomId: this.data.isTimeDeviceConnected ? this.data.connectedTimeRoomId : ''
      },

      // 全量平铺元数据
      title: mTitle,
      matchTitle: mTitle,
      match_name: mTitle,
      matchName: mTitle,

      teamA: tA_name,
      teamB: tB_name,
      colorA: tA_color,
      colorB: tB_color,
      team_a_name: tA_name,
      team_b_name: tB_name,
      color_a: tA_color,
      color_b: tB_color,

      // 结构化嵌套对象
      team_a: {
        name: tA_name,
        color: tA_color,
        bgColor: tA_color,
        score: tA_score
      },
      team_b: {
        name: tB_name,
        color: tB_color,
        bgColor: tB_color,
        score: tB_score
      },
      meta: {
        title: mTitle,
        teamA: tA_name,
        teamB: tB_name,
        colorA: tA_color,
        colorB: tB_color,
        period: mPeriod,
        timeRoomId: this.data.isTimeDeviceConnected ? this.data.connectedTimeRoomId : '',
        broadcaster: this._broadcasterNickname || '',
        bc: this._broadcasterNickname || ''
      }
    };

    if (extra && typeof extra === 'object') {
      Object.assign(packet, extra);
    }

    this._socketTask.send({
      data: JSON.stringify(packet),
      success: function () {
        console.log('[WebScorePanel] send ok act=' + actType);
        self._addLog('📤 广播成功 [' + actType + '] [' + mTitle + '] ' + tA_name + ':' + tA_score + ' VS ' + tB_name + ':' + tB_score, 'success');
      },
      fail: function (err) {
        console.error('[WebScorePanel] send fail', err);
        var msg = err && err.errMsg ? err.errMsg : '失败';
        self._addLog('❌ 发包失败: ' + msg + '，正在触发重连', 'error');
        wx.showToast({ title: '发送失败，正在重连', icon: 'none' });
        self.setData({ wsConnected: false, wsStatusText: '已掉线' });
        self._connectWs(self.data.roomId);
      }
    });
  },

  // 🚀 测试双端互通功能：向当前房间主动发送即时测试指令（比分+欢迎横幅）
  onTestPingOBS: function () {
    var self = this;
    var currentRoom = this.data.roomId || '313251';

    if (!this.data.wsConnected || !this._socketTask) {
      wx.showToast({ title: '长连接正在建立 (房间:' + currentRoom + ')', icon: 'none' });
      this._addLog('🔑 正在尝试为房间 ' + currentRoom + ' 建立长连接...', '');
      this._connectWs(currentRoom);
      return;
    }

    wx.showLoading({ title: '正在下发测试指令...' });
    // 1. 发送比分更新包
    this._sendUpdatePacket('SCORE', {
      pingTest: Date.now()
    });

    // 2. 发送欢迎横幅指令
    var nick = this._broadcasterNickname || '现场实拍';
    var testText = '🏀 妙计记分牌连接成功！' + this.data.matchTitle + ' [' + this.data.teamA.name + ' VS ' + this.data.teamB.name + '] 实时互通正常';
    this._sendUpdatePacket('SHOW_WELCOME_MARQUEE', {
      welcomeText: testText,
      marqueeText: testText,
      text: testText,
      broadcaster: nick,
      timestamp: Date.now()
    });

    setTimeout(function () {
      wx.hideLoading();
      wx.showModal({
        title: '✅ 测试指令已下发',
        content: '已成功向房间【' + currentRoom + '】下发比分与欢迎横幅指令！\n\n请核对 OBS 页面中的房间号是否为【' + currentRoom + '】。如果一致，OBS 记分牌将立即响应更新并飘动横幅！',
        showCancel: false,
        confirmText: '我知道了'
      });
      self._addLog('🚀 已主动向房间【' + currentRoom + '】下发测试比分与欢迎横幅指令', 'success');
    }, 400);
  },

  _broadcastMatchInfo: function () {
    this._sendUpdatePacket('SCORE');
  },

  // 核心能力：将比分与节次持久化同步回小程序本地 `MIAOXIE_MATCHES`
  _syncMatchToStorage: function () {
    var idx = this.data.selectedMatchIndex;
    var list = this.data.matchList;
    if (!list || !list[idx]) return;

    var curMatch = list[idx];
    if (!curMatch.teamA) curMatch.teamA = {};
    if (!curMatch.teamB) curMatch.teamB = {};

    curMatch.teamA.score = this.data.teamA.score;
    curMatch.teamB.score = this.data.teamB.score;
    curMatch.period = this.data.period;

    var rawMatches = wx.getStorageSync(STORAGE_KEY) || [];
    if (Array.isArray(rawMatches)) {
      for (var i = 0; i < rawMatches.length; i++) {
        if (rawMatches[i].id === curMatch.id) {
          if (!rawMatches[i].teamA) rawMatches[i].teamA = {};
          if (!rawMatches[i].teamB) rawMatches[i].teamB = {};
          rawMatches[i].teamA.score = this.data.teamA.score;
          rawMatches[i].teamB.score = this.data.teamB.score;
          rawMatches[i].period = this.data.period;
          break;
        }
      }
      wx.setStorageSync(STORAGE_KEY, rawMatches);
      if (app && app.globalData) {
        app.globalData.matches = rawMatches;
      }
    }
  },

  // 5. 比分加减
  onScoreChange: function (e) {
    if (!this.data.isScoringStarted) {
      this.setData({ isScoringStarted: true });
    }

    var target = e.currentTarget.dataset.target;
    var delta = parseInt(e.currentTarget.dataset.delta, 10) || 0;

    var currentScore = this.data[target].score;
    var newScore = Math.max(0, currentScore + delta);

    var updateData = {};
    updateData[target + '.score'] = newScore;

    var self = this;
    this.setData(updateData, function () {
      self._sendUpdatePacket('SCORE');
      self._syncMatchToStorage();
    });
  },

  // 6. 切换节次
  onSelectPeriod: function (e) {
    if (!this.data.isScoringStarted) {
      this.setData({ isScoringStarted: true });
    }

    var val = parseInt(e.currentTarget.dataset.val, 10);
    if (isNaN(val)) val = 1;

    var self = this;
    this.setData({ period: val }, function () {
      self._sendUpdatePacket('PERIOD');
      self._syncMatchToStorage();
    });
  },

  // ─────────────────────────────────────────────
  // 7. 🎨 球衣颜色选择器交互与实时广播
  // ─────────────────────────────────────────────

  /** 长按比分或点击色块弹出颜色选择器 */
  onOpenColorPicker: function (e) {
    var ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    var target = ds.target || 'teamA';
    var curColor = target === 'teamA' ? (this.data.teamA.color || '#FF2D55') : (this.data.teamB.color || '#007AFF');
    var teamName = target === 'teamA' ? (this.data.teamA.name || '主队') : (this.data.teamB.name || '客队');

    this.setData({
      showColorPicker: true,
      colorPickerTarget: target,
      colorPickerTitle: '设置【' + teamName + '】球衣颜色',
      tempSelectedColor: curColor
    });

    if (wx.vibrateShort) wx.vibrateShort({ type: 'light' });
  },

  onCloseColorPicker: function () {
    this.setData({ showColorPicker: false });
  },

  stopBubbling: function () {
    // 阻止点击浮层面板时的冒泡关闭
  },

  onModalPresetColorTap: function (e) {
    var color = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.color) || '';
    if (color) this.setData({ tempSelectedColor: color });
  },

  onColorGridSelect: function (e) {
    var color = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.color) || '';
    if (color) this.setData({ tempSelectedColor: color });
  },

  /** 确认选择球衣颜色：写回本地存储并立即广播给网页端 OBS */
  onConfirmColorSelection: function () {
    var color = this.data.tempSelectedColor;
    var target = this.data.colorPickerTarget; // 'teamA' | 'teamB'
    if (!color || !target) {
      this.setData({ showColorPicker: false });
      return;
    }

    var textColor = getContrastColor(color);
    var upd = { showColorPicker: false };
    if (target === 'teamA') {
      upd['teamA.color'] = color;
      upd['teamA.textColor'] = textColor;
    } else {
      upd['teamB.color'] = color;
      upd['teamB.textColor'] = textColor;
    }

    // 1. 同步保存到本地持久化 Storage (当前比赛场次列表)
    var rawMatches = wx.getStorageSync(STORAGE_KEY) || [];
    var matchId = this.data.matchId;
    if (Array.isArray(rawMatches) && rawMatches.length > 0) {
      for (var i = 0; i < rawMatches.length; i++) {
        if (rawMatches[i].id === matchId) {
          if (target === 'teamA') {
            if (!rawMatches[i].teamA || typeof rawMatches[i].teamA !== 'object') rawMatches[i].teamA = {};
            rawMatches[i].teamA.bgColor = color;
            rawMatches[i].teamA.color = color;
          } else {
            if (!rawMatches[i].teamB || typeof rawMatches[i].teamB !== 'object') rawMatches[i].teamB = {};
            rawMatches[i].teamB.bgColor = color;
            rawMatches[i].teamB.color = color;
          }
          break;
        }
      }
      try { wx.setStorageSync(STORAGE_KEY, rawMatches); } catch (e) {}
    }

    var self = this;
    this.setData(upd, function () {
      var teamName = target === 'teamA' ? self.data.teamA.name : self.data.teamB.name;
      self._addLog('🎨 已更新【' + teamName + '】球衣颜色为 ' + color + '，实时同步网页端', 'success');
      // 2. 立即向 OBS 网页端广播更新球衣颜色！
      self._broadcastMatchInfo();
    });

    wx.showToast({ title: '球衣颜色已更新', icon: 'success' });
  }
});
