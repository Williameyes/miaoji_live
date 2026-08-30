var API = require('../../../config/api.js');
var wsTokenReq = require('../../../utils/ws-token-request.js');
var app = getApp();

var STORAGE_KEY = 'MIAOXIE_MATCHES';
var FIXED_ROOM_KEY = 'MIAOXIE_FIXED_ROOM_ID';

/**
 * 获取每场比赛独立的高光切片持久化 Storage Key
 */
function getHighlightStorageKey(matchId, roomId) {
  var cleanMatchId = String(matchId || '').trim();
  var cleanRoomId = String(roomId || '').trim();
  return 'MIAOXIE_HIGHLIGHT_CLIPS_' + (cleanMatchId || ('ROOM_' + (cleanRoomId || 'default')));
}

/**
 * 确保 roomId 为合规的 6 位纯数字房间码（默认 666888）
 * @param {string|number} rawId
 * @returns {string}
 */
function ensure6DigitRoomId(rawId) {
  var digits = String(rawId || '').replace(/\D/g, '');
  if (digits.length >= 6) {
    return digits.slice(0, 6);
  }
  if (digits.length > 0) {
    return (digits + '666888').slice(0, 6);
  }
  return '666888';
}

Page({
  data: {
    statusBarHeight: 20,
    roomId: '666888',
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
    
    // 球队数据
    teamA: {
      name: '主队',
      color: '#FF2D55',
      score: 0
    },
    teamB: {
      name: '客队',
      color: '#007AFF',
      score: 0
    },
    
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
    isHighlightReplaying: false
  },

  _socketTask: null,
  _seq: 0,
  _sessionId: '',
  _heartbeatTimer: null,
  _isConnecting: false,

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
    this._addLog('手动触发强制同步广播...', 'success');
    this._broadcastMatchInfo();
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
    var sysInfo = wx.getSystemInfoSync();
    var sbh = sysInfo.statusBarHeight || 20;

    // 唯一 session_id，服务端判断合规 Session
    this._sessionId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);

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

    // 主播专属房间号：优先读取 URL query，再读取本地缓存，默认 666888
    var queryRoomId = options.roomId || options.room_id || options.matchCode || '';
    var storedRoomId = wx.getStorageSync(FIXED_ROOM_KEY) || '666888';
    var roomId = ensure6DigitRoomId(queryRoomId || storedRoomId);
    wx.setStorageSync(FIXED_ROOM_KEY, roomId);

    var matchId = (targetMatch && targetMatch.id) || currentId || ('M_' + roomId);
    var obsUrl = 'https://api.mx.server.ndcoo.com/obs-overlay/index.html?roomId=' + roomId;

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
      'teamA.score': tA_score,
      'teamB.name': tB_name,
      'teamB.color': tB_color,
      'teamB.score': tB_score
    });

    this._addLog('🚀 页面初始化: [' + mTitle + '] ' + tA_name + '(' + tA_color + ') VS ' + tB_name + '(' + tB_color + ') | 本场切片: ' + storedClips.length + '段', 'success');
    this._connectWs(roomId);
  },

  onShow: function () {
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

    var self = this;
    this.setData({
      selectedMatchIndex: index,
      matchId: newMatchId,
      matchTitle: mTitle,
      period: mPeriod,
      savedHighlightClips: matchStoredClips,
      'teamA.name': tA_name,
      'teamA.color': tA_color,
      'teamA.score': tA_score,
      'teamB.name': tB_name,
      'teamB.color': tB_color,
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

  // 点击状态栏手动重连
  onTapWsStatus: function () {
    if (!this.data.wsConnected && !this._isConnecting) {
      this._manualClosed = false;
      this._reconnectAttempt = 0;
      this._addLog('👆 手动点击尝试重连...', '');
      this._connectWs(this.data.roomId);
    }
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
      if (!self._manualClosed && !self.data.wsConnected) {
        self._connectWs(self.data.roomId);
      }
    }, wait);
  },

  // 2. 建立 WebSocket 长连接 (带防重复并发锁与旧 Socket 强关)
  _connectWs: function (rawRoomId) {
    if (this._isConnecting) {
      console.log('[WebScorePanel] _connectWs skipped: already connecting...');
      return;
    }
    var roomId = ensure6DigitRoomId(rawRoomId);
    var self = this;

    // 先强制关闭可能遗留的旧 Socket 任务，防止并发上限冲突
    this._closeWs();
    this._manualClosed = false;

    this._isConnecting = true;
    this.setData({ wsStatusText: '连接中...', roomId: roomId, obsUrl: 'https://api.mx.server.ndcoo.com/obs-overlay/index.html?roomId=' + roomId });
    this._addLog('🔑 正在请求 Token (房间: ' + roomId + ')...', '');

    wsTokenReq.fetchWsToken(roomId)
      .then(function (tokenStr) {
        if (!tokenStr || typeof tokenStr !== 'string') {
          self._isConnecting = false;
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
            console.error('[WebScorePanel] connectSocket fail', err);
            self._isConnecting = false;
            var msg = err && err.errMsg ? err.errMsg : '连接失败';
            self.setData({ wsConnected: false, wsStatusText: msg });
            self._addLog('❌ connectSocket 失败: ' + msg, 'error');
            self._scheduleWsReconnect();
          }
        });

        self._socketTask.onOpen(function () {
          console.log('[WebScorePanel] WebSocket onOpen!');
          self._isConnecting = false;
          self._reconnectAttempt = 0;
          if (self._reconnectTimer) {
            clearTimeout(self._reconnectTimer);
            self._reconnectTimer = null;
          }
          self.setData({ wsConnected: true, wsStatusText: '已在线' });
          self._addLog('✅ WebSocket 成功建立! (房间:' + roomId + ')', 'success');
          self._startHeartbeat();

          // 连通后自动发全量比赛快照
          self._broadcastMatchInfo();
        });

        self._socketTask.onMessage(function (event) {
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
          console.log('[WebScorePanel] WebSocket onClose', e);
          self._isConnecting = false;
          self._stopHeartbeat();
          self.setData({ wsConnected: false, wsStatusText: '已断开(重连中...)' });
          self._addLog('⚠️ WebSocket 断开，准备自动重连', 'error');
          self._scheduleWsReconnect();
        });

        self._socketTask.onError(function (err) {
          console.error('[WebScorePanel] WebSocket onError', err);
          self._isConnecting = false;
          self._stopHeartbeat();
          var errMsg = err && err.errMsg ? err.errMsg : '异常';
          self.setData({ wsConnected: false, wsStatusText: '连接异常(重连中...)' });
          self._addLog('❌ WebSocket 错误: ' + errMsg + '，准备自动重连', 'error');
          self._scheduleWsReconnect();
        });
      })
      .catch(function (err) {
        console.error('[WebScorePanel] fetchWsToken fail', err);
        self._isConnecting = false;
        var errDesc = err && err.message ? err.message : 'Token异常';
        self.setData({ wsConnected: false, wsStatusText: errDesc });
        self._addLog('❌ Token 请求失败: ' + errDesc, 'error');
        self._scheduleWsReconnect();
      });
  },

  _closeWs: function () {
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
      if (self._socketTask && self.data.wsConnected) {
        self._socketTask.send({
          data: JSON.stringify({
            type: 'BROADCAST_HEARTBEAT',
            sys_t: Date.now(),
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

  // 3. 复制 OBS URL
  onCopyObsUrl: function () {
    var url = this.data.obsUrl;
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
    var url = this.data.obsUrl + '&livePos=score';
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
    var url = this.data.obsUrl + '&mode=live_only';
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
    var now = new Date();
    var timeStr = (now.getHours() < 10 ? '0' : '') + now.getHours() + ':' +
                  (now.getMinutes() < 10 ? '0' : '') + now.getMinutes() + ':' +
                  (now.getSeconds() < 10 ? '0' : '') + now.getSeconds();

    var currentList = this.data.savedHighlightClips || [];
    var newClip = {
      id: 'clip_' + Date.now(),
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
      timestamp: Date.now()
    });
    wx.showToast({ title: '已保存高光 #' + updatedList.length, icon: 'success' });
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
    var ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
    var clipIdx = parseInt(ds.index, 10);
    if (isNaN(clipIdx) || clipIdx < 0) clipIdx = 0;
    var targetNum = clipIdx + 1;
    var customAct = 'START_HIGHLIGHT_REPLAY_' + targetNum;

    this.setData({ isHighlightReplaying: true });
    this._addLog('🎬 下发【播放第 ' + targetNum + ' 段高光】指令 (ACT: ' + customAct + ')', 'success');
    this._sendUpdatePacket(customAct, {
      isReplay: true,
      targetIndex: targetNum,
      clipIndex: clipIdx,
      act: customAct,
      timestamp: Date.now()
    });
    wx.showToast({ title: '播放第 ' + targetNum + ' 段高光', icon: 'success' });
  },

  onStopHighlightReplay: function () {
    this.setData({ isHighlightReplaying: false });
    this._addLog('📺 下发【立即中断回放】指令到网页记分牌 (红色 Live 转场)', 'error');
    this._sendUpdatePacket('STOP_HIGHLIGHT_REPLAY', {
      isReplay: false,
      timestamp: Date.now()
    });
    wx.showToast({ title: '已中断切回直播', icon: 'none' });
  },

  // 将比赛元数据（比赛名、主客队名、主客队球衣颜色、高光目标索引）编码进 match_id 字段中，确保服务端广播 100% 透传
  _buildEncodedMatchId: function (extra) {
    var mTitle = this.data.matchTitle || '常规赛';
    var tA_name = this.data.teamA.name || '主队';
    var tB_name = this.data.teamB.name || '客队';
    var tA_color = (this.data.teamA.color || '#FF2D55').replace('#', '');
    var tB_color = (this.data.teamB.color || '#007AFF').replace('#', '');
    var mId = this.data.matchId || ('M_' + this.data.roomId);

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
        act: (extra && extra.act) || ''
      };
      var jsonStr = JSON.stringify(payload);
      var utf8Bytes = [];
      for (var i = 0; i < jsonStr.length; i++) {
        var code = jsonStr.charCodeAt(i);
        if (code < 0x80) {
          utf8Bytes.push(code);
        } else if (code < 0x800) {
          utf8Bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0xd800 || code >= 0xe000) {
          utf8Bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        } else {
          i++;
          code = 0x10000 + (((code & 0x3ff) << 10) | (jsonStr.charCodeAt(i) & 0x3ff));
          utf8Bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
      }
      var b64 = wx.arrayBufferToBase64(new Uint8Array(utf8Bytes).buffer);
      return 'META64_' + b64;
    } catch (e) {
      return 'META_' + encodeURIComponent(mTitle) + '~' + encodeURIComponent(tA_name) + '~' + encodeURIComponent(tB_name) + '~' + tA_color + '~' + tB_color + '~' + encodeURIComponent(mId);
    }
  },

  // 4. 广播数据包（关键：携带 session_id、比赛名称、队伍名与球衣颜色）
  _sendUpdatePacket: function (act, extra) {
    if (!this._socketTask || !this.data.wsConnected) {
      this._addLog('⚠️ 长连接未上线，触发重连...', 'error');
      this._connectWs(this.data.roomId);
      return;
    }
    this._seq += 1;
    var now = Date.now();
    var actType = act || 'SCORE';

    var tA_name = this.data.teamA.name || '主队';
    var tB_name = this.data.teamB.name || '客队';
    var tA_color = this.data.teamA.color || '#FF2D55';
    var tB_color = this.data.teamB.color || '#007AFF';
    var tA_score = Number(this.data.teamA.score) || 0;
    var tB_score = Number(this.data.teamB.score) || 0;
    var mTitle = this.data.matchTitle || '常规赛';
    var mPeriod = Number(this.data.period) || 1;

    var encodedMatchId = this._buildEncodedMatchId(extra);

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
        timeRoomId: this.data.isTimeDeviceConnected ? this.data.connectedTimeRoomId : ''
      }
    };

    if (extra && typeof extra === 'object') {
      Object.assign(packet, extra);
    }

    var self = this;
    this._socketTask.send({
      data: JSON.stringify(packet),
      success: function () {
        console.log('[WebScorePanel] send ok act=' + actType);
        self._addLog('📤 广播成功 [' + actType + '] [' + mTitle + '] ' + tA_name + ':' + tA_score + ' VS ' + tB_name + ':' + tB_score, 'success');
      },
      fail: function (err) {
        console.error('[WebScorePanel] send fail', err);
        var msg = err && err.errMsg ? err.errMsg : '失败';
        self._addLog('❌ 发包失败: ' + msg, 'error');
      }
    });
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
  }
});
