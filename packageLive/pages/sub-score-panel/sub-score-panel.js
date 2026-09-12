const { fetchWsToken } = require('../../../utils/ws-token-request.js');
const { checkSyncLabWhitelist } = require('../../../utils/sync-lab-whitelist.js');
const API = require('../../../config/api.js');
const recSync = require('../../../services/rec-sync-ws-client.js');

const WS_BASE_URL = 'wss://api.mx.server.ndcoo.com';
const WS_SOCKET_PATH = '/gaoguang-ws';
const STORAGE_LAST_ROOM_ID = 'live_sub_score_last_room_id';

Page({
  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    capsuleWidth: 96,

    // 连接状态
    roomId: '',
    inputRoomId: '',
    wsConnected: false,
    recSyncConnected: false,
    wsBusy: false,
    wsStatusText: '',

    // 调试运行日志
    debugLogs: [],

    // 比赛与对阵信息（用于展示队名/颜色）
    matchId: '',
    matchTitle: '比赛记分遥控',
    sportType: 'basketball',
    teamA: {
      name: '主队',
      bgColor: '#E64340',
      textColor: '#FFFFFF'
    },
    teamB: {
      name: '客队',
      bgColor: '#10AEFF',
      textColor: '#FFFFFF'
    },

    // 最近操作反馈
    lastActionText: '',
    lastActionTime: '',
    lastActionTeam: '',
    lastActionDelta: 0,

    // 节次枚举：0=热身, 1=第一节, 2=第二节, 3=第三节, 4=第四节, 5=加时, 6=完赛
    period: 1,
    periods: ['热身', '第一节', '第二节', '第三节', '第四节', '加时', '完赛'],

    // 高光状态
    highlightCount: 0,
    isReplaying: false,
    saveHighlightCooldown: 0
  },

  _socketTask: null,
  _socketGen: 0,
  _recSyncClient: null,
  _sessionId: '',
  _seq: 0,
  _heartbeatTimer: null,
  _reconnectTimer: null,
  _reconnectAttempt: 0,
  _manualClose: false,

  _addLog: function (msg, type) {
    var now = new Date();
    var timeStr = now.toTimeString().split(' ')[0] + '.' + String(now.getMilliseconds()).padStart(3, '0');
    var logItem = { time: timeStr, msg: String(msg), type: type || '' };
    console.log('[SubScoreLog]', timeStr, type ? ('[' + type + ']') : '', msg);
    var currentLogs = this.data.debugLogs || [];
    var logs = [logItem].concat(currentLogs).slice(0, 60);
    this.setData({ debugLogs: logs });
  },

  onLoad: function (options) {
    if (!checkSyncLabWhitelist()) {
      wx.showModal({
        title: '提示',
        content: '副机记分功能目前仅对实验白名单用户开放',
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

    this._sessionId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);

    // 1. 获取胶囊安全区尺寸
    var sys = wx.getSystemInfoSync();
    var sbh = sys.statusBarHeight || 20;
    var nbh = 44;
    var cw = 96;
    try {
      if (wx.getMenuButtonBoundingClientRect) {
        var menu = wx.getMenuButtonBoundingClientRect();
        if (menu && menu.top) {
          nbh = (menu.top - sbh) * 2 + menu.height;
          cw = menu.width + (sys.windowWidth - menu.right) + 12;
        }
      }
    } catch (e) {}

    // 2. 恢复上次连接的房间号
    var lastRoomId = '';
    if (options && options.roomId) {
      lastRoomId = String(options.roomId).replace(/\D/g, '').slice(0, 6);
    } else {
      lastRoomId = String(wx.getStorageSync(STORAGE_LAST_ROOM_ID) || wx.getStorageSync('live_ws_last_room_id') || '').replace(/\D/g, '').slice(0, 6);
    }

    this.setData({
      statusBarHeight: sbh,
      navBarHeight: nbh,
      capsuleWidth: cw,
      inputRoomId: lastRoomId,
      roomId: lastRoomId
    });

    this._addLog('🚀 遥控器已载入 (Session: ' + this._sessionId + ')', 'success');

    if (lastRoomId.length === 6) {
      this._addLog('恢复缓存控制码 #' + lastRoomId + '，自动发起双通道连接', '');
      this.doConnect(lastRoomId);
    }
  },

  onUnload: function () {
    this.manualDisconnect();
  },

  onGoBack: function () {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  },

  onRoomInput: function (e) {
    var val = String(e.detail.value || '').replace(/\D/g, '').slice(0, 6);
    this.setData({ inputRoomId: val });
  },

  onConnectTap: function () {
    if (!checkSyncLabWhitelist()) {
      wx.showToast({ title: '暂无使用权限', icon: 'none' });
      return;
    }
    var rid = this.data.inputRoomId.trim();
    if (rid.length !== 6) {
      wx.showToast({ title: '请输入6位房间码', icon: 'none' });
      return;
    }
    this._addLog('用户手动点击【连接】按钮，目标房间 #' + rid, '');
    this.doConnect(rid);
  },

  onDisconnectTap: function () {
    var self = this;
    wx.showModal({
      title: '断开连接',
      content: '确定断开与主机房间 #' + this.data.roomId + ' 的连接吗？',
      success: function (res) {
        if (res.confirm) {
          self._addLog('用户手动点击【断开连接】', 'warn');
          self.manualDisconnect();
          wx.showToast({ title: '已断开连接', icon: 'none' });
        }
      }
    });
  },

  // ──────── 导出 / 复制 / 清空日志 ────────
  onCopyLogsTap: function () {
    var logs = this.data.debugLogs || [];
    if (logs.length === 0) {
      wx.showToast({ title: '暂无日志', icon: 'none' });
      return;
    }
    var sys = wx.getSystemInfoSync();
    var header = '=== 副机记分遥控端通信调试日志 (共' + logs.length + '条) ===\n' +
                 '生成时间: ' + new Date().toString() + '\n' +
                 '设备/平台: ' + (sys.model || 'Unknown') + ' | ' + (sys.system || '') + ' | SDK:' + (sys.SDKVersion || '') + '\n' +
                 '控制房间号: #' + (this.data.roomId || '未连') + '\n' +
                 '会话 ID: ' + this._sessionId + '\n' +
                 '--------------------------------------------------\n';
    var body = logs.map(function (item) {
      var tag = item.type ? ('[' + item.type + '] ') : '';
      return '[' + item.time + '] ' + tag + item.msg;
    }).join('\n');

    var fullText = header + body;
    wx.setClipboardData({
      data: fullText,
      success: function () {
        wx.showToast({ title: '日志已复制到剪贴板', icon: 'success' });
      },
      fail: function () {
        wx.showToast({ title: '复制失败，请重试', icon: 'none' });
      }
    });
  },

  onClearLogsTap: function () {
    this.setData({ debugLogs: [] });
    wx.showToast({ title: '日志已清空', icon: 'none' });
  },

  // ──────── 核心网络流：双通道并发连接 (主计分通道 + 拍摄副机通道) ────────
  doConnect: function (roomId) {
    var safeRoomId = String(roomId).replace(/\D/g, '').slice(0, 6);
    if (safeRoomId.length !== 6) return;

    this._manualClose = false;
    this.setData({
      roomId: safeRoomId,
      inputRoomId: safeRoomId,
      wsBusy: true,
      wsStatusText: '获取 Token…'
    });

    // 1. 连接计分主通道 (控分 / 直播主机联动)
    this._startSocketFlow(safeRoomId);
    // 2. 连接拍摄副机专属通道 (channel=rec，用于直控拍摄端截取高光)
    this._connectRecSync(safeRoomId);
  },

  _connectRecSync: function (roomId) {
    if (this._recSyncClient) {
      try { this._recSyncClient.destroy(); } catch (e) {}
      this._recSyncClient = null;
    }
    var self = this;
    this._recSyncClient = recSync.createRecSyncWsClient({
      onOpen: function () {
        self.setData({ recSyncConnected: true });
        self._addLog('🎬 拍摄副机同步信道已就绪 (channel=rec)', 'success');
      },
      onClose: function () {
        self.setData({ recSyncConnected: false });
      },
      onError: function (err) {
        self.setData({ recSyncConnected: false });
      }
    });
    this._recSyncClient.connect(roomId, 'controller');
  },

  _startSocketFlow: function (roomId) {
    var self = this;
    var currentGen = ++this._socketGen;

    this._addLog('🔑 正在请求 Token (房间 #' + roomId + ')...', '');

    fetchWsToken(roomId, {
      timeoutMs: 10000,
      logger: function (name, data) {
        if (data && data.code && data.code !== 200) {
          self._addLog('Token 回执: code=' + data.code + ', msg=' + (data.msg || ''), 'warn');
        }
      }
    }).then(function (token) {
      if (self._socketGen !== currentGen || self._manualClose) return;
      if (!token) {
        self._addLog('❌ 未获取到有效 Token', 'error');
        self._scheduleReconnect();
        return;
      }
      self._addLog('🟢 Token 获取成功: ' + token.slice(0, 15) + '...', 'success');
      self._initSocket(roomId, token, currentGen);
    }).catch(function (err) {
      if (self._socketGen !== currentGen || self._manualClose) return;
      var errMsg = err && err.message ? err.message : String(err || 'unknown');
      self._addLog('❌ 请求 Token 失败: ' + errMsg, 'error');
      self.setData({
        wsBusy: false,
        wsStatusText: 'Token 获取失败'
      });
      self._scheduleReconnect();
    });
  },

  _initSocket: function (roomId, token, currentGen) {
    var self = this;
    var wssUrl = WS_BASE_URL + WS_SOCKET_PATH + '?roomId=' + encodeURIComponent(roomId) + '&token=' + encodeURIComponent(token);

    if (this._socketTask) {
      try { this._socketTask.close({}); } catch (e) {}
      this._socketTask = null;
    }

    this.setData({
      wsBusy: true,
      wsStatusText: '建立连接…'
    });
    this._addLog('🔌 发起 wx.connectSocket...', '');

    try {
      var task = wx.connectSocket({
        url: wssUrl,
        fail: function (err) {
          if (self._socketGen !== currentGen) return;
          var errMsg = err && err.errMsg ? err.errMsg : JSON.stringify(err);
          self._addLog('❌ connectSocket 失败: ' + errMsg, 'error');
          self._scheduleReconnect();
        }
      });
      this._socketTask = task;

      task.onOpen(function () {
        if (self._socketGen !== currentGen) return;
        self._addLog('✅ WebSocket onOpen 连接建立成功! 房间 #' + roomId, 'success');
        self._reconnectAttempt = 0;
        self.setData({
          wsConnected: true,
          wsBusy: false,
          wsStatusText: '已连接'
        });
        try {
          wx.setStorageSync(STORAGE_LAST_ROOM_ID, roomId);
        } catch (e) {}

        // 发送 BROADCAST_JOIN 登记房间
        try {
          self._addLog('📤 发送 BROADCAST_JOIN 登记房间', '');
          task.send({
            data: JSON.stringify({
              type: 'BROADCAST_JOIN',
              roomId: roomId,
              sys_t: Date.now()
            })
          });
        } catch (eJoin) {}

        // 启动应用层心跳
        self._startHeartbeat();
      });

      task.onMessage(function (res) {
        if (self._socketGen !== currentGen) return;
        self._onSocketMessage(res.data);
      });

      task.onClose(function (e) {
        if (self._socketGen !== currentGen) return;
        var code = e && typeof e.code !== 'undefined' ? e.code : 'unknown';
        var reason = e && e.reason ? e.reason : '无';
        var errMsg = e && e.errMsg ? e.errMsg : '';
        self._addLog('⚠️ WebSocket onClose 断开! code=' + code + ', reason=' + reason + (errMsg ? (', errMsg=' + errMsg) : ''), 'error');

        self._stopHeartbeat();
        self._socketTask = null;
        self.setData({
          wsConnected: false,
          wsBusy: false,
          wsStatusText: self._manualClose ? '' : '未连接'
        });
        if (!self._manualClose && self.data.roomId) {
          self._scheduleReconnect();
        }
      });

      task.onError(function (err) {
        if (self._socketGen !== currentGen) return;
        var errMsg = err && err.errMsg ? err.errMsg : JSON.stringify(err || {});
        self._addLog('❌ WebSocket onError 异常: ' + errMsg, 'error');
        self._stopHeartbeat();
        self.setData({
          wsConnected: false,
          wsBusy: false,
          wsStatusText: '连接异常'
        });
        if (!self._manualClose && self.data.roomId) {
          self._scheduleReconnect();
        }
      });
    } catch (e) {
      self._addLog('❌ _initSocket 异常: ' + (e.message || String(e)), 'error');
      self._scheduleReconnect();
    }
  },

  _startHeartbeat: function () {
    var self = this;
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(function () {
      if (self._socketTask && self.data.wsConnected) {
        try {
          self._socketTask.send({
            data: JSON.stringify({
              type: 'BROADCAST_HEARTBEAT',
              roomId: self.data.roomId,
              sys_t: Date.now(),
              ping: 1
            })
          });
        } catch (eHb) {}
      }
    }, 8000);
  },

  _stopHeartbeat: function () {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  },

  _scheduleReconnect: function () {
    if (this._manualClose || !this.data.roomId) return;
    if (this._reconnectTimer) return;
    var self = this;
    this._reconnectAttempt = (this._reconnectAttempt || 0) + 1;
    var delay = Math.min(10000, 1500 * Math.pow(1.3, this._reconnectAttempt));
    this._addLog('🔄 触发自动重连 (尝试 #' + this._reconnectAttempt + '), 延迟 ' + Math.round(delay / 1000) + ' 秒', 'warn');
    this.setData({ wsStatusText: '重连中(' + Math.round(delay / 1000) + 's)…' });

    this._reconnectTimer = setTimeout(function () {
      self._reconnectTimer = null;
      if (self._manualClose || !this.data.roomId) return;
      self._startSocketFlow(self.data.roomId);
      self._connectRecSync(self.data.roomId);
    }, delay);
  },

  _onSocketMessage: function (raw) {
    try {
      var msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!msg || typeof msg !== 'object') return;

      var type = msg.type || '';
      var act = msg.act || (msg.data && msg.data.act) || '';

      // 忽略心跳 Pong 回包
      if (type === 'BROADCAST_PONG' || act === 'PONG') {
        return;
      }

      // 服务端拒接/异常判断拦截
      if (type === 'COLLECTOR_EXIST' || type === 'ROOM_FULL' || type === 'ROOM_NOT_FOUND') {
        var reasonText = type === 'COLLECTOR_EXIST' ? '已有裁判在管理此房间' : (type === 'ROOM_FULL' ? '房间连接数已满' : '未找到指定房间');
        this._addLog('⛔ 收到服务端拒绝响应: ' + type + ' - ' + reasonText, 'error');
        this.manualDisconnect();
        wx.showModal({
          title: '连接失败',
          content: reasonText,
          showCancel: false
        });
        return;
      }

      // 防回声抖动：副机自身发出的广播回包直接忽略
      if ((msg.session_id && msg.session_id === this._sessionId) || msg.sender === 'sub_remote') {
        return;
      }

      // 仅从 STATE_SYNC 同步队名、比赛标题、高光状态（绝不覆盖或重置比分）
      if (act === 'STATE_SYNC' || act === 'SCORE') {
        var patch = {};
        if (msg.matchId || msg.match_id) {
          patch.matchId = String(msg.matchId || msg.match_id);
        }
        if (msg.matchTitle || msg.matchName || msg.title) {
          patch.matchTitle = msg.matchTitle || msg.matchName || msg.title;
        }
        if (msg.sportType) {
          patch.sportType = msg.sportType;
        }
        if (typeof msg.isReplaying === 'boolean') {
          patch.isReplaying = msg.isReplaying;
        }
        var tA = msg.team_a || (typeof msg.teamA === 'object' ? msg.teamA : null);
        var tB = msg.team_b || (typeof msg.teamB === 'object' ? msg.teamB : null);
        if (tA && tA.name) patch['teamA.name'] = tA.name;
        if (typeof msg.teamA === 'string' && msg.teamA) patch['teamA.name'] = msg.teamA;
        if (tB && tB.name) patch['teamB.name'] = tB.name;
        if (typeof msg.teamB === 'string' && msg.teamB) patch['teamB.name'] = msg.teamB;
        if (msg.colorA) patch['teamA.bgColor'] = msg.colorA;
        if (msg.colorB) patch['teamB.bgColor'] = msg.colorB;
        if (typeof msg.highlightCount === 'number') {
          patch.highlightCount = msg.highlightCount;
        }

        var pVal = typeof msg.period === 'number' ? msg.period : (typeof msg.p === 'number' ? msg.p : null);
        if (pVal !== null && pVal >= 0 && pVal < this.data.periods.length) {
          patch.period = pVal;
        }

        if (Object.keys(patch).length > 0) {
          this.setData(patch);
          this._addLog('🔄 比赛信息同步: ' + (patch.matchTitle || this.data.matchTitle), 'success');
        }
        return;
      }

      // 消费节次切换广播
      if (act === 'PERIOD') {
        var pValDirect = typeof msg.period === 'number' ? msg.period : (typeof msg.p === 'number' ? msg.p : null);
        if (pValDirect !== null && pValDirect >= 0 && pValDirect < this.data.periods.length) {
          this.setData({ period: pValDirect });
          this._addLog('⏱️ 节次已同步: ' + this.data.periods[pValDirect], 'success');
        }
        return;
      }

      // 高光回放状态变动
      if (act === 'START_HIGHLIGHT_REPLAY') {
        this.setData({ isReplaying: true });
        return;
      }
      if (act === 'STOP_HIGHLIGHT_REPLAY') {
        this.setData({ isReplaying: false });
        return;
      }
      if (act === 'TRIGGER_SAVE_HIGHLIGHT' || type === 'REC_TRIGGER') {
        this.setData({ highlightCount: (this.data.highlightCount || 0) + 1 });
        return;
      }
    } catch (e) {}
  },

  manualDisconnect: function () {
    this._manualClose = true;
    this._socketGen++;
    this._stopHeartbeat();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._socketTask) {
      try {
        if (typeof this._socketTask.onOpen === 'function') this._socketTask.onOpen(function () {});
        if (typeof this._socketTask.onMessage === 'function') this._socketTask.onMessage(function () {});
        if (typeof this._socketTask.onClose === 'function') this._socketTask.onClose(function () {});
        if (typeof this._socketTask.onError === 'function') this._socketTask.onError(function () {});
        this._socketTask.close({});
      } catch (e) {}
      this._socketTask = null;
    }
    if (this._recSyncClient) {
      try { this._recSyncClient.destroy(); } catch (e) {}
      this._recSyncClient = null;
    }
    this.setData({
      wsConnected: false,
      recSyncConnected: false,
      wsBusy: false,
      wsStatusText: ''
    });
  },

  // ──────── 核心发包方法：完全对齐网关 COLLECTOR_UPDATE 标准格式 ────────
  _sendUpdatePacket: function (act, extra) {
    var actType = act || 'SCORE';
    var self = this;

    if (!this._socketTask || !this.data.wsConnected) {
      wx.showToast({ title: '请先连接主机房间', icon: 'none' });
      return;
    }
    this._seq += 1;
    var now = Date.now();

    var tA_name = this.data.teamA.name || '主队';
    var tB_name = this.data.teamB.name || '客队';
    var tA_color = this.data.teamA.bgColor || '#E64340';
    var tB_color = this.data.teamB.bgColor || '#10AEFF';
    var mTitle = this.data.matchTitle || '比赛遥控';

    var packet = {
      type: 'COLLECTOR_UPDATE',
      act: actType,
      sender: 'sub_remote',
      t: 600,
      a: 0,
      b: 0,
      p: 1,
      seq: this._seq,
      sys_t: now,
      session_id: this._sessionId,
      match_id: this.data.matchId || ('M_' + this.data.roomId),
      title: mTitle,
      teamA: tA_name,
      teamB: tB_name,
      colorA: tA_color,
      colorB: tB_color
    };

    if (extra && typeof extra === 'object') {
      Object.assign(packet, extra);
    }

    try {
      this._socketTask.send({
        data: JSON.stringify(packet),
        success: function () {
          self._addLog('📤 发送成功 [' + actType + ']', 'success');
        },
        fail: function (err) {
          self._addLog('❌ 发送失败: ' + (err && err.errMsg ? err.errMsg : 'err'), 'error');
        }
      });
    } catch (eSend) {
      self._addLog('❌ 发送异常: ' + (eSend.message || String(eSend)), 'error');
    }
  },

  _vibrate: function (type) {
    try {
      if (type === 'medium') {
        wx.vibrateShort({ type: 'medium' });
      } else {
        wx.vibrateShort({ type: 'light' });
      }
    } catch (e) {}
  },

  // ──────── 遥控功能 1：加减得分（增量纯遥控模式，永不归零覆盖） ────────
  onScoreChange: function (e) {
    if (!this.data.wsConnected) {
      wx.showToast({ title: '请先连接主机房间', icon: 'none' });
      return;
    }
    var team = e.currentTarget.dataset.team; // 'teamA' | 'teamB'
    var delta = Number(e.currentTarget.dataset.delta) || 0;
    if (!delta) return;

    var teamObj = this.data[team] || {};
    var teamName = teamObj.name || (team === 'teamA' ? '主队' : '客队');
    var sign = delta > 0 ? '+' : '';
    var actionText = teamName + ' ' + sign + delta + '分';

    var now = new Date();
    var timeStr = now.toTimeString().split(' ')[0];

    this.setData({
      lastActionText: actionText,
      lastActionTime: timeStr,
      lastActionTeam: team,
      lastActionDelta: delta
    });

    this._vibrate(delta > 0 ? 'medium' : 'light');

    // 动作语义严格映射为网关原语：
    // SCORE_A_PLUS_1, SCORE_A_PLUS_2, SCORE_A_PLUS_3, SCORE_A_MINUS_1
    // SCORE_B_PLUS_1, SCORE_B_PLUS_2, SCORE_B_PLUS_3, SCORE_B_MINUS_1
    var actPrefix = team === 'teamA' ? 'SCORE_A_' : 'SCORE_B_';
    var actDelta = delta > 0 ? ('PLUS_' + delta) : ('MINUS_' + Math.abs(delta));
    var act = actPrefix + actDelta;

    this._addLog('⚡ 遥控发射: ' + actionText + ' [' + act + ']', 'success');

    // 发送标准增量指令包（带合规基底字段，杜绝网关抛错或将比分置0）
    this._sendUpdatePacket(act, {
      team: team,
      delta: delta,
      a: 0,
      b: 0
    });
  },

  // ──────── 遥控功能 2：切换节次 ────────
  onPeriodSelect: function (e) {
    if (!this.data.wsConnected) {
      wx.showToast({ title: '请先连接主机房间', icon: 'none' });
      return;
    }
    var idx = Number(e.currentTarget.dataset.index);
    if (isNaN(idx) || idx < 0 || idx >= this.data.periods.length) return;
    if (idx === this.data.period) return;

    var periodName = this.data.periods[idx] || '第一节';
    var now = new Date();
    var timeStr = now.toTimeString().split(' ')[0];

    this.setData({
      period: idx,
      lastActionText: '切至 ' + periodName,
      lastActionTime: timeStr
    });

    this._vibrate('light');
    this._addLog('⏱️ 遥控切节次: ' + periodName + ' [PERIOD p=' + idx + ']', 'success');

    this._sendUpdatePacket('PERIOD', {
      period: idx,
      p: idx,
      periodName: periodName
    });

    wx.showToast({
      title: '已切至 ' + periodName,
      icon: 'none',
      duration: 1400
    });
  },

  // ──────── 遥控功能 3：保存高光 (8秒截取) - 双通道全链路直达 ────────
  onSaveHighlightTap: function () {
    if (!this.data.wsConnected && !this.data.recSyncConnected) {
      wx.showToast({ title: '请先连接主机房间', icon: 'none' });
      return;
    }
    if (this.data.saveHighlightCooldown > 0) {
      return;
    }

    this._vibrate('medium');
    this._addLog('⚡ 触发保存高光指令 (直达拍摄副机与主机)', 'success');

    // 1. 直发给拍摄副机 (channel=rec 专属通道，0 延迟直达，不受主机相机门禁制约)
    if (this._recSyncClient && this._recSyncClient.isConnected()) {
      try {
        var trigId = this._recSyncClient.sendTrigger();
        this._addLog('🎬 已直发拍摄副机高光捕获信令 (ID: ' + String(trigId || '').slice(0, 8) + ')', 'success');
      } catch (eTrig) {
        this._addLog('⚠️ 直发拍摄副机失败: ' + (eTrig.message || String(eTrig)), 'warn');
      }
    }

    // 2. 发送给直播主机 (计分主通道，触发主机本地录制保存)
    if (this.data.wsConnected) {
      this._sendUpdatePacket('TRIGGER_SAVE_HIGHLIGHT', {
        type: 'COLLECTOR_UPDATE',
        act: 'TRIGGER_SAVE_HIGHLIGHT'
      });
    }

    wx.showToast({
      title: '⚡ 已发送高光保存指令',
      icon: 'none',
      duration: 1800
    });

    var self = this;
    var count = 3;
    this.setData({ saveHighlightCooldown: count });
    var cdTimer = setInterval(function () {
      count--;
      if (count <= 0) {
        clearInterval(cdTimer);
        self.setData({ saveHighlightCooldown: 0 });
      } else {
        self.setData({ saveHighlightCooldown: count });
      }
    }, 1000);
  },

  // ──────── 遥控功能 3：回放高光 / 切回直播 ────────
  onReplayToggleTap: function () {
    if (!this.data.wsConnected) {
      wx.showToast({ title: '请先连接主机房间', icon: 'none' });
      return;
    }
    this._vibrate('light');

    if (this.data.isReplaying) {
      this._addLog('📺 发送切回实时直播指令', 'warn');
      this._sendUpdatePacket('STOP_HIGHLIGHT_REPLAY');
      this.setData({ isReplaying: false });
      wx.showToast({ title: '📺 已切回实时直播', icon: 'none' });
    } else {
      this._addLog('🎬 发送高光连续集锦回放指令', 'success');
      this._sendUpdatePacket('START_HIGHLIGHT_REPLAY');
      this.setData({ isReplaying: true });
      wx.showToast({ title: '🎬 已开启高光连续回放', icon: 'none' });
    }
  }
});
