const liveHelpers = require('./live-helpers.js');
const liveWsClientMod = require('../../../services/live-ws-client.js');
const LIVE_WS_CLOCK_TICK_MS = 200;
const LIVE_WS_START_LAG_COMP_MAX_MS = 500;
const {
  formatWxsMainText,
  FOOTBALL_HALF2_START_SEC,
  FOOTBALL_EXTRA_START_SEC,
  DEFAULT_FOOTBALL_STATE,
  normalizeFootballState,
  migrateLegacyFootballPeriod,
  getFootballHalfLabelParts,
  getFootballHalfLabel,
  SPORT_BASKETBALL,
  SPORT_FOOTBALL,
  SPORT_BADMINTON,
  normalizeSportType,
  DEFAULT_BADMINTON_STATE,
  checkBadmintonSetWin,
  buildBadmintonSetHistoryDisplay,
  computeClockDisplayFromBundle
} = liveHelpers;

module.exports = Behavior({
  data: {
    /** 时钟束：收包时更新锚点，走表由逻辑层 tick 渲染 */
wxsClockBundle: null,
    /** WXS 回写的大表 MM:SS 文案 */
wxsClockMainText: '00:00',
    /** WXS 回写的 24 秒整秒 */
wxsClockShotSec: 24,
    /** 24 秒 ≤5 时高亮警示 */
wxsClockShotWarn: false,
    /** 采集端是否同步比分（sync_score=1）；false 时自动模式下仍可手动改分 */
liveWsScoreSyncEnabled: false,
    /** 直播送礼实时打出卡片数据 */
    liveBoostItem: null,
    /** 控制打出卡片 CSS 硬件加速显隐动画 */
    liveBoostVisible: false,
    /** 雷达送礼特效 6 位直播房间号 */
    radarBoostRoomId: '',
    /** 雷达送礼特效接入面板显隐 */
    radarBoostPanelOpen: false,
    /** 雷达送礼特效房间连接状态 */
    radarBoostConnected: false,
    /** 雷达送礼特效房间连接过渡状态 */
    radarBoostBusy: false,
    /** 雷达送礼特效房间状态文案 */
    radarBoostStatusText: ''
  },
  methods: {
    // 已合并至文件后部 onUnload：此处不再重复定义，避免后项覆盖导致事件未解绑。

/**
 * 是否为「手动记分」语义：页面 `isAutoMode===false`，或持久化 `matchConfig.mode==='manual'`。
 * （当前主路径为 `isAutoMode`；`matchConfig.mode` 供后续配置对齐预留。）
 * @returns {boolean}
 */
_liveWsIsManualScoringMode: function () {
  var mc = this.data.matchConfig;
  if (mc && mc.mode === 'manual') return true;
  if (mc && mc.mode === 'auto') return false;
  return !this.data.isAutoMode;
},
    /**
 * 懒创建 WebSocket 客户端单例。
 * @returns {void}
 */
_liveWsEnsureClient: function () {
  var self = this;
  if (this._liveWsClient) return;
  this._liveWsClient = liveWsClientMod.createLiveWsClient({
    onOpen: function () {
      self._liveWsOnSocketOpen();
    },
    onMessage: function (raw) {
      self._liveWsOnSocketMessage(raw);
    },
    onClose: function () {
      self._liveWsOnSocketClose();
    },
    onPhase: function (phase, detail) {
      self._liveWsOnPhase(phase, detail);
    },
    logger: function (event, detail) {
      if (typeof self.appendHealthLog === 'function') {
        self.appendHealthLog('ws_' + event, detail || {});
      }
    }
  });
},
    /**
 * onShow / 网络变化时的 WSS 健康自检。
 * 仅在白名单 + 自动模式 + 已记录上次房间号时尝试恢复，避免无差别打扰用户。
 * @returns {void}
 */
_liveWsHealthCheckOnShow: function () {
  if (!this.data.autoSyncWhitelisted) return;
  if (this._liveWsIsManualScoringMode()) return;
  this._liveWsEnsureClient();
  if (!this._liveWsClient) return;
  var connected = !!this._liveWsClient.isConnected();
  var roomId = '';
  try {
    roomId = String(this._liveWsClient.getRoomId() || '').replace(/\D/g, '').slice(0, 6);
  } catch (eRoom) {/* ignore */}
  if (!connected && roomId.length === 6) {
    this.appendHealthLog('ws_app_show_resync', {
      room: roomId
    });
    try {
      this._liveWsClient.signalTransientFailure();
    } catch (eSig) {/* ignore */}
  }
},
    /**
 * WSS 连接阶段文案同步到连房面板。
 * @param {string} phase
 * @param {string} [detail]
 * @returns {void}
 */
_liveWsOnPhase: function (phase, detail) {
  var text = '';
  var busy = false;
  if (phase === 'token') {
    text = '获取 Token…';
    busy = true;
  } else if (phase === 'handshake') {
    text = '握手中…';
    busy = true;
  } else if (phase === 'reconnecting') {
    text = this._liveWsWaitingCollector ? '等待采集端上线…' : '断线重连中…';
    busy = true;
  } else if (phase === 'waiting_collector') {
    text = '等待采集端上线…';
    busy = true;
  } else if (phase === 'error') {
    text = detail === 'token fail' ? 'Token 获取失败' : '连接失败';
    busy = false;
    wx.showToast({
      title: text,
      icon: 'none'
    });
  } else if (phase === 'connected') {
    text = '';
    busy = false;
  } else if (phase === 'idle') {
    text = '';
    busy = false;
  }
  var patch = {
    liveWsQuickBusy: busy,
    liveWsStatusText: text
  };
  if (phase === 'connected') {
    patch.liveWsConnected = true;
  }
  if (phase === 'idle' || phase === 'error') {
    patch.liveWsConnected = false;
  }
  this.setData(patch);
},
    _liveWsRefreshWxsClockDriver: function () {
  if (this.data.wxsClockBundle && this.data.wxsClockBundle.mainRunning) {
    this._liveWsStartClockTick();
  } else {
    this._liveWsTickClockDisplay();
  }
},
    /**
 * 停止走表本地 tick。
 * @returns {void}
 */
_liveWsStopClockTick: function () {
  if (this._liveWsClockTickTimer) {
    clearInterval(this._liveWsClockTickTimer);
    this._liveWsClockTickTimer = null;
  }
},
    /**
 * 启动走表本地 tick（START 后每秒刷新显示）。
 * @returns {void}
 */
_liveWsStartClockTick: function () {
  var self = this;
  this._liveWsStopClockTick();
  if (!this.data.wxsClockBundle || !this.data.wxsClockBundle.mainRunning) return;
  this._liveWsClockTickTimer = setInterval(function () {
    self._liveWsTickClockDisplay();
  }, LIVE_WS_CLOCK_TICK_MS);
},
    /**
 * 根据当前 wxsClockBundle 刷新大表 / 24 秒显示。
 * @returns {void}
 */
_liveWsTickClockDisplay: function () {
  var bundle = this.data.wxsClockBundle;
  if (!bundle || !bundle.mainRunning) {
    this._liveWsStopClockTick();
    return;
  }
  var display = computeClockDisplayFromBundle(bundle, this.data.sportType);
  var sd = {};
  if (display.mainText !== this.data.wxsClockMainText) {
    sd.wxsClockMainText = display.mainText;
  }
  if (display.shotSec !== this.data.wxsClockShotSec) {
    sd.wxsClockShotSec = display.shotSec;
  }
  if (display.shotWarn !== this.data.wxsClockShotWarn) {
    sd.wxsClockShotWarn = display.shotWarn;
  }
  if (Object.keys(sd).length) {
    this.setData(sd);
  }
  if (normalizeSportType(this.data.sportType) === SPORT_FOOTBALL) {
    var fbDisplay = this._resolveFootballDisplayTime(this.data.footballTimeText);
    if (fbDisplay !== this.data.footballDisplayTime) {
      this.setData({
        footballDisplayTime: fbDisplay
      });
    }
  }
},
    /**
 * 由时钟束生成显示 patch。
 * @param {object} bundle
 * @returns {{ wxsClockMainText: string, wxsClockShotSec: number, wxsClockShotWarn: boolean }}
 */
_liveWsBuildClockDisplayPatch: function (bundle) {
  var display = computeClockDisplayFromBundle(bundle, this.data.sportType);
  return {
    wxsClockMainText: display.mainText,
    wxsClockShotSec: display.shotSec,
    wxsClockShotWarn: display.shotWarn
  };
},
    /**
 * WSS onOpen：同步角标并尝试恢复自动记分。
 * @returns {void}
 */
_liveWsOnSocketOpen: function () {
  this._liveWsWaitingCollector = false;
  var patch = {
    liveWsConnected: true,
    liveWsQuickBusy: false,
    liveWsStatusText: '',
    liveWsPanelOpen: false
  };
  if (this.data.autoSyncWhitelisted) {
    patch.isAutoMode = true;
  }
  var self = this;
  this.setData(patch, function () {
    if (patch.isAutoMode) {
      self.updateTeamGroupWidth(true);
      self._liveWsRefreshWxsClockDriver();
    }
  });
  wx.showToast({
    title: '云端已连接',
    icon: 'success',
    duration: 1400
  });
},
    /**
 * WSS onClose：非主动断开时回退手动记分。
 * @returns {void}
 */
_liveWsOnSocketClose: function () {
  if (this._liveWsManualTeardown) return;
  var client = this._liveWsClient;
  var stillRetrying = !!(client && client.getRoomId && client.getRoomId());
  if (this.data.liveWsConnected) {
    this.setData({
      liveWsConnected: false
    });
  }
  if (stillRetrying && this.data.isAutoMode) {
    this.setData({
      liveWsStatusText: this._liveWsWaitingCollector ? '等待采集端上线…' : '断线重连中…',
      liveWsQuickBusy: true
    });
    wx.showToast({
      title: this._liveWsWaitingCollector ? '采集端重连中，请稍候' : '云端重连中…',
      icon: 'none',
      duration: 2200
    });
  }
},
    /**
 * 解析并分发 WSS 下行 JSON。
 * @param {string} raw 原始消息字符串
 * @returns {void}
 */
_liveWsOnSocketMessage: function (raw) {
  try {
    var msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'DEVICE_OFFLINE') {
      this._liveWsHandleCollectorAbsent('offline');
      return;
    }
    if (msg.type === 'COLLECTOR_EXIST') {
      wx.showModal({
        title: '连接失败',
        content: '房间不可用',
        showCancel: false
      });
      var self = this;
      this.setData({
        isAutoMode: false
      }, function () {
        self.updateTeamGroupWidth(true);
      });
      this._liveWsTeardownForManualMode();
      return;
    }
    if (msg.type === 'ROOM_NOT_FOUND') {
      wx.showModal({
        title: '房间不存在',
        content: '请确认采集端已开启且房间号一致',
        showCancel: false
      });
      var self = this;
      this.setData({
        isAutoMode: false
      }, function () {
        self.updateTeamGroupWidth(true);
      });
      this._liveWsTeardownForManualMode();
      return;
    }
    if (msg.type === 'ROOM_FULL') {
      wx.showModal({
        title: '连接失败',
        content: '房间已满',
        showCancel: false
      });
      var self = this;
      this.setData({
        isAutoMode: false
      }, function () {
        self.updateTeamGroupWidth(true);
      });
      this._liveWsTeardownForManualMode();
      return;
    }
    if (msg.type === 'CROP_FRAME_SYNC' || msg.type === 'DATA_CROP_FRAME') {
      this._consumeCropFrameSync(msg.payload || msg);
      return;
    }
    if (msg.type === 'DATA_BROADCAST' || msg.type === 'LIVE_BOOST' || msg.type === 'LIVE_BOOST_REALTIME' || msg.type === 'LIVE_BOOST_TARGETED') {
      var nAct = (msg.payload && msg.payload.act) || msg.act || '';
      if (nAct === 'LIVE_BOOST' || nAct === 'LIVE_BOOST_REALTIME' || nAct === 'LIVE_BOOST_TARGETED') {
        this._consumeLiveBoost(msg.payload || msg);
        return;
      }
      var nested = msg.payload && typeof msg.payload === 'object' ? msg.payload : msg;
      if (!nested || typeof nested.act !== 'string' || typeof nested.seq !== 'number') {
        var nowIgnored = Date.now();
        if (!this._liveWsLastIgnoredBroadcastLogAt || nowIgnored - this._liveWsLastIgnoredBroadcastLogAt > 10000) {
          this._liveWsLastIgnoredBroadcastLogAt = nowIgnored;
          this.appendHealthLog('ws_broadcast_ignored', {
            type: nested && nested.type ? String(nested.type).slice(0, 40) : '',
            keys: nested && typeof nested === 'object' ? Object.keys(nested).slice(0, 8).join(',') : ''
          });
        }
      }
      this._consumeWsBroadcast(nested);
      return;
    }
    if (typeof msg.act === 'string' && typeof msg.seq === 'number') {
      this._consumeWsBroadcast(msg);
    }
  } catch (eParse) {
    console.warn('[Live][WS] message parse fail', eParse);
  }
},

  onTimeSyncModeSelect: function (e) {
    var mode = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.mode) || 'ocr';
    try {
      wx.setStorageSync('HOOPS_TIME_SYNC_MODE', mode);
    } catch (err) { /* ignore */ }
    this.setData({
      timeSyncMode: mode
    });
    wx.showToast({
      title: mode === 'crop_image' ? '已切为: 切图同步' : '已切为: OCR记分',
      icon: 'none'
    });
  },

  _consumeCropFrameSync: function (payload) {
    if (!payload || !payload.time_img || payload.act === 'CLEAR') {
      this.setData({ hasCropFrameImage: false });
      if (this._timeCropCanvasContext && this._timeCropCanvas) {
        try {
          this._timeCropCanvasContext.clearRect(0, 0, this._timeCropCanvas.width, this._timeCropCanvas.height);
        } catch (eClear) { }
      }
      return;
    }
    var seq = payload.seq || 0;
    var prevSeq = this._lastCropSeq || 0;
    var isSeqGap = prevSeq > 0 && seq > prevSeq + 1;
    this._lastCropSeq = seq;

    // 弱化高频切图日志：抽样每 30 帧（约 30 秒）记录一次，或出现跳包丢帧时记录，避免刷屏挤掉直播诊断日志
    if (seq % 30 === 0 || isSeqGap) {
      this.appendHealthLog('ws_crop_frame_recv', {
        seq: seq,
        session: String(payload.session_id || '').slice(0, 20),
        size_kb: (payload.time_img.length / 1024).toFixed(1),
        delay_ms: payload.ts ? Math.max(0, Date.now() - payload.ts) : 0,
        seq_gap: isSeqGap ? (seq - prevSeq - 1) : 0
      });
    }
    var self = this;
    var sd = {};
    if (!this.data.hasCropFrameImage) {
      sd.hasCropFrameImage = true;
    }
    if (this.data.timeSyncMode !== 'crop_image') {
      sd.timeSyncMode = 'crop_image';
    }
    if (this.data.liveWsScoreSyncEnabled !== false) {
      sd.liveWsScoreSyncEnabled = false;
    }
    if (Object.keys(sd).length > 0) {
      this.setData(sd, function () {
        self._renderCropFrameToCanvas(payload.time_img);
      });
    } else {
      this._renderCropFrameToCanvas(payload.time_img);
    }
  },

  _renderCropFrameToCanvas: function (base64Img) {
    var self = this;
    if (!base64Img) return;
    if (this._timeCropCanvasContext && this._timeCropCanvas) {
      var img = this._timeCropCanvas.createImage();
      img.onload = function () {
        var naturalW = img.width || 4;
        var naturalH = img.height || 3;
        var aspect = naturalW / naturalH;
        if (isNaN(aspect) || aspect <= 0) aspect = 4 / 3;

        // 根据自由切图宽高比计算容器的 rpx 宽度（固定高度 30rpx，宽度动态伸缩）
        var targetRpxW = Math.max(24, Math.min(220, Math.round(30 * aspect)));
        var targetStyle = 'width: ' + targetRpxW + 'rpx;';

        if (self.data.cropTimeBoxStyle !== targetStyle) {
          self.setData({ cropTimeBoxStyle: targetStyle });
        }

        var dpr = self._timeCropCanvasDpr || 2;
        var baseH = self._timeCropCanvasLogicalH || 15;
        var renderW = Math.round(baseH * aspect);

        if (self._timeCropCanvas.width !== Math.round(renderW * dpr) || self._timeCropCanvas.height !== Math.round(baseH * dpr)) {
          self._timeCropCanvas.width = Math.round(renderW * dpr);
          self._timeCropCanvas.height = Math.round(baseH * dpr);
          self._timeCropCanvasContext.scale(dpr, dpr);
        }

        self._timeCropCanvasContext.clearRect(0, 0, renderW, baseH);
        self._timeCropCanvasContext.drawImage(img, 0, 0, renderW, baseH);
      };
      img.src = base64Img;
      return;
    }
    var query = wx.createSelectorQuery().in(this);
    query.select('#liveTimeCropCanvas')
      .fields({ node: true, size: true })
      .exec(function (res) {
        if (res && res[0] && res[0].node) {
          var canvas = res[0].node;
          var ctx = canvas.getContext('2d');
          var dpr = (wx.getSystemInfoSync && wx.getSystemInfoSync().pixelRatio) || 2;
          var nodeH = res[0].height || 15;
          if (nodeH <= 0) nodeH = 15;

          self._timeCropCanvas = canvas;
          self._timeCropCanvasContext = ctx;
          self._timeCropCanvasDpr = dpr;
          self._timeCropCanvasLogicalH = nodeH;

          var img = canvas.createImage();
          img.onload = function () {
            var naturalW = img.width || 4;
            var naturalH = img.height || 3;
            var aspect = naturalW / naturalH;
            if (isNaN(aspect) || aspect <= 0) aspect = 4 / 3;

            var targetRpxW = Math.max(24, Math.min(220, Math.round(30 * aspect)));
            var targetStyle = 'width: ' + targetRpxW + 'rpx;';

            if (self.data.cropTimeBoxStyle !== targetStyle) {
              self.setData({ cropTimeBoxStyle: targetStyle });
            }

            var renderW = Math.round(nodeH * aspect);
            canvas.width = Math.round(renderW * dpr);
            canvas.height = Math.round(nodeH * dpr);
            ctx.scale(dpr, dpr);

            ctx.clearRect(0, 0, renderW, nodeH);
            ctx.drawImage(img, 0, 0, renderW, nodeH);
          };
          img.src = base64Img;
        }
      });
  },
    /**
 * 采集端暂不可用：保留房间号与自动模式，退避重连（服务端宽限期内可恢复）。
 * @param {'offline' | 'not_found'} reason 触发原因
 * @returns {void}
 */
_liveWsHandleCollectorAbsent: function (reason) {
  this._liveWsWaitingCollector = true;
  this._liveWsEnsureClient();
  this.setData({
    liveWsConnected: false,
    liveWsQuickBusy: true,
    liveWsStatusText: '等待采集端上线…'
  });
  if (this._liveWsClient && typeof this._liveWsClient.signalTransientFailure === 'function') {
    this._liveWsClient.signalTransientFailure();
  }
  var toastTitle = reason === 'not_found' ? '房间未就绪，等待采集端…' : '采集端离线较久，等待重连…';
  wx.showToast({
    title: toastTitle,
    icon: 'none',
    duration: 2600
  });
},
    /**
 * 复位 WSS 相关 UI（不修改 isAutoMode，由调用方负责）。
 * @returns {void}
 */
_liveWsApplyDisconnectedUiPatch: function () {
  this._liveWsWaitingCollector = false;
  this._liveWsStopClockTick();
  this.setData({
    liveWsConnected: false,
    liveWsPanelOpen: false,
    liveWsQuickBusy: false,
    liveWsStatusText: '',
    liveWsScoreSyncEnabled: false,
    /** 直播送礼实时打出卡片数据 */
    liveBoostItem: null,
    /** 控制打出卡片 CSS 硬件加速显隐动画 */
    liveBoostVisible: false,
    wxsClockBundle: null,
    wxsClockMainText: '00:00',
    wxsClockShotSec: 24,
    wxsClockShotWarn: false
  });
  this._liveWsCurrentSeq = 0;
  this._liveWsSessionId = '';
  this._liveWsClockRunning = false;
},
    /**
 * 手动记分态：断开 WSS 并复位 UI。
 * @returns {void}
 */
_liveWsTeardownForManualMode: function () {
  this._liveWsManualTeardown = true;
  this.setData({
    hasCropFrameImage: false,
    cropFrameBase64: ''
  });
  if (this._timeCropCanvasContext && this._timeCropCanvas) {
    try {
      this._timeCropCanvasContext.clearRect(0, 0, this._timeCropCanvas.width, this._timeCropCanvas.height);
    } catch (eClear) { }
  }
  try {
    this._liveWsFlushScorePersist();
  } catch (eF) {/* ignore */}
  this._liveWsDisconnect(true);
  this._liveWsApplyDisconnectedUiPatch();
  this._liveWsManualTeardown = false;
},
    /**
 * 主动断开 WebSocket。
 * @param {boolean} [manual] 是否为用户/业务主动断开
 * @returns {void}
 */
_liveWsDisconnect: function (manual) {
  this._liveWsEnsureClient();
  if (manual) {
    this._liveWsWaitingCollector = false;
  }
  if (this._liveWsClient) {
    this._liveWsClient.disconnect(!!manual);
  }
  if (manual) {
    this._liveWsCurrentSeq = 0;
    this._liveWsSessionId = '';
    this._liveWsClockRunning = false;
  }
},
    /**
 * 与 WSS 客户端同步角标（onShow 等调用）。
 * @returns {void}
 */
_liveWsSyncChipConnected: function () {
  if (!this.data.autoSyncWhitelisted) return;
  if (this._liveWsIsManualScoringMode()) return;
  this._liveWsEnsureClient();
  var c = !!(this._liveWsClient && this._liveWsClient.isConnected());
  if (this.data.liveWsConnected !== c) {
    this.setData({
      liveWsConnected: c
    });
  }
},
    /**
 * 打开云端连房面板并预填上次 roomId。
 * @returns {void}
 */
_liveWsOpenPanelPrefilled: function () {
  if (!this.data.autoSyncWhitelisted) return;
  var roomId = '';
  try {
    roomId = String(wx.getStorageSync(liveWsClientMod.STORAGE_LAST_ROOM_ID) || '');
  } catch (e0) {/* ignore */}
  roomId = roomId.replace(/\D/g, '').slice(0, 6);
  this.setData({
    liveWsPanelOpen: true,
    liveWsRoomId: roomId || this.data.liveWsRoomId,
    liveWsStatusText: ''
  });
},
    /**
 * 点击左侧「同步」圆钮：展开/收起连房面板。
 * @returns {void}
 */
onLiveWsChipTap: function () {
  if (!this.data.autoSyncWhitelisted) return;
  this._liveWsSyncChipConnected();
  if (this.data.liveWsPanelOpen) {
    if (!this.data.liveWsQuickBusy) {
      this.setData({
        liveWsPanelOpen: false,
        liveWsStatusText: ''
      });
    }
    return;
  }
  this._liveWsOpenPanelPrefilled();
},
    /**
 * 轻点遮罩关闭连房面板。
 * @returns {void}
 */
onLiveWsPanelBackdropTap: function () {
  this.setData({
    liveWsPanelOpen: false,
    liveWsStatusText: ''
  });
},
noopCatchTap: function () {},
    /**
 * roomId 输入框变更。
 * @param {object} e 微信 input 事件
 * @returns {void}
 */
onLiveWsRoomIdInput: function (e) {
  var v = String(e.detail && e.detail.value || '').replace(/\D/g, '').slice(0, 6);
  this.setData({
    liveWsRoomId: v
  });
},
    /**
 * 执行 Token → WSS 连房流程。
 * @returns {void}
 */
onLiveWsConnectRun: function () {
  var self = this;
  if (!this.data.autoSyncWhitelisted || this.data.liveWsQuickBusy) return;
  var roomId = String(this.data.liveWsRoomId || '').replace(/\D/g, '');
  if (roomId.length !== 6) {
    wx.showToast({
      title: '请输入 6 位房间号',
      icon: 'none'
    });
    return;
  }
  this._liveWsEnsureClient();
  this.setData({
    liveWsQuickBusy: true,
    liveWsStatusText: '获取 Token…'
  });
  try {
    wx.setStorageSync(liveWsClientMod.STORAGE_LAST_ROOM_ID, roomId);
  } catch (eS) {/* ignore */}
  this._liveWsClient.connect(roomId);
},
    /**
 * 主动断开云端 WSS。
 * @returns {void}
 */
onLiveWsDisconnectTap: function () {
  var self = this;
  if (!this.data.autoSyncWhitelisted) return;
  this._liveWsFlushScorePersist();
  this._liveWsPreferAutoAfterConnect = false;
  this.setData({
    liveWsQuickBusy: true,
    isAutoMode: false
  }, function () {
    self.updateTeamGroupWidth(true);
  });
  this._liveWsTeardownForManualMode();
  this.setData({
    liveWsQuickBusy: false
  });
  wx.showToast({
    title: '已断开云端',
    icon: 'none'
  });
},
    /**
 * 将当前 matchConfig 比分经 persistConfig 落盘（短防抖）。
 * @returns {void}
 */
_liveWsScheduleScorePersist: function () {
  var self = this;
  if (this._liveWsPersistTimer) {
    clearTimeout(this._liveWsPersistTimer);
    this._liveWsPersistTimer = null;
  }
  this._liveWsPersistTimer = setTimeout(function () {
    self._liveWsPersistTimer = null;
    try {
      self.persistConfig();
    } catch (eP) {
      console.error('[Live] WS score persist:', eP);
    }
  }, 320);
},
    /**
 * 取消防抖并立即执行比分落盘。
 * @returns {void}
 */
_liveWsFlushScorePersist: function () {
  if (this._liveWsPersistTimer) {
    clearTimeout(this._liveWsPersistTimer);
    this._liveWsPersistTimer = null;
  }
  try {
    this.persistConfig();
  } catch (eP) {
    console.error('[Live] WS score persist flush:', eP);
  }
},
  /**
   * 乱序盾牌 + 网络延迟补偿 + 喂给 WXS 时钟束。
   * @param {{
   *   act: string,
   *   t: number,
   *   a: number,
   *   b: number,
   *   p?: number,
   *   seq: number,
   *   sys_t: number,
   *   session_id?: string,
   *   sc?: number
   * }} payload 广播包
   * @returns {void}
   */
  _consumeWsBroadcast: function (payload) {
    if (!payload || typeof payload.act !== 'string') return;
    if (typeof payload.session_id === 'string' && payload.session_id && this._liveWsSessionId !== payload.session_id) {
      console.log('[Live][WS] collector session changed %s -> %s, reset seq', this._liveWsSessionId || 'none', payload.session_id);
      this._liveWsSessionId = payload.session_id;
      this._liveWsCurrentSeq = 0;
      this.setData({ hasCropFrameImage: false });
      if (this._timeCropCanvasContext && this._timeCropCanvas) {
        try {
          this._timeCropCanvasContext.clearRect(0, 0, this._timeCropCanvas.width, this._timeCropCanvas.height);
        } catch (eClear) { }
      }
      this.appendHealthLog('ws_collector_session_changed', {
        session: String(payload.session_id || '').slice(0, 40)
      });
    }
    var currentSeq = this._liveWsCurrentSeq || 0;
    if (payload.seq <= currentSeq) return;
    this._liveWsCurrentSeq = payload.seq;
    var netLagMs = Date.now() - (Number(payload.sys_t) || Date.now());
    if (netLagMs < 0) netLagMs = 0;
    var rawSeconds = Math.max(0, Math.floor(Number(payload.t) || 0));
    var targetSeconds = rawSeconds;
    var nowMs = Date.now();
    var mainAnchorMs = nowMs;
    var prevBundle = this.data.wxsClockBundle || {};
    var mainRunning = !!this._liveWsClockRunning;
    var shotBaseSec = typeof prevBundle.shotBaseSec === 'number' ? prevBundle.shotBaseSec : 24;
    var shotAnchorMs = typeof prevBundle.shotAnchorMs === 'number' ? prevBundle.shotAnchorMs : nowMs;
    if (payload.act === 'START') {
      var lagCompMs = Math.min(netLagMs, LIVE_WS_START_LAG_COMP_MAX_MS);
      targetSeconds = rawSeconds;
      mainAnchorMs = nowMs - lagCompMs;
      mainRunning = true;
      this._liveWsClockRunning = true;
    } else if (payload.act === 'STOP') {
      targetSeconds = rawSeconds;
      mainRunning = false;
      this._liveWsClockRunning = false;
      this._liveWsStopClockTick();
      if (prevBundle.mainRunning) {
        var shotElapsed = (nowMs - shotAnchorMs) / 1000;
        shotBaseSec = Math.max(0, Math.floor(shotBaseSec - shotElapsed));
        shotAnchorMs = nowMs;
      }
    } else if (payload.act === 'SYNC') {
      targetSeconds = rawSeconds;
      mainRunning = !!this._liveWsClockRunning;
      if (prevBundle.mainRunning && !mainRunning) {
        var syncShotElapsed = (nowMs - shotAnchorMs) / 1000;
        shotBaseSec = Math.max(0, Math.floor(shotBaseSec - syncShotElapsed));
        shotAnchorMs = nowMs;
      }
    } else if (payload.act === 'S_RESET') {
      targetSeconds = rawSeconds;
      mainRunning = !!this._liveWsClockRunning;
      var resetShot = Number(payload.sc);
      if (!resetShot || resetShot <= 0) resetShot = 24;
      shotBaseSec = Math.max(0, Math.min(24, Math.floor(resetShot)));
      shotAnchorMs = nowMs;
    }
    var patch = {};
    var timeActs = {
      START: 1,
      STOP: 1,
      SYNC: 1,
      S_RESET: 1
    };
    var hadTimeAct = !!timeActs[payload.act];
    if (hadTimeAct) {
      var bundleToken = (prevBundle.token || 0) + 1;
      patch.wxsClockBundle = {
        token: bundleToken,
        mainBaseSec: targetSeconds,
        mainAnchorMs: mainAnchorMs,
        mainRunning: mainRunning,
        shotBaseSec: shotBaseSec,
        shotAnchorMs: shotAnchorMs
      };
      var clockDisplayPatch = this._liveWsBuildClockDisplayPatch(patch.wxsClockBundle);
      patch.wxsClockMainText = clockDisplayPatch.wxsClockMainText;
      patch.wxsClockShotSec = clockDisplayPatch.wxsClockShotSec;
      patch.wxsClockShotWarn = clockDisplayPatch.wxsClockShotWarn;
      console.log('[Live][WS] clock act=%s seq=%s t=%s running=%s text=%s', payload.act, payload.seq, rawSeconds, mainRunning, patch.wxsClockMainText);
      var isClockStateChange = !this._lastClockAct || this._lastClockAct !== payload.act || this._lastClockText !== patch.wxsClockMainText || !!mainRunning !== this._lastClockRunning;
      this._lastClockAct = payload.act;
      this._lastClockText = patch.wxsClockMainText;
      this._lastClockRunning = !!mainRunning;

      if (isClockStateChange || (payload.seq % 30 === 0)) {
        this.appendHealthLog('ws_clock_act', {
          act: String(payload.act || ''),
          seq: payload.seq,
          t: rawSeconds,
          running: !!mainRunning,
          text: patch.wxsClockMainText,
          heartbeat: payload.heartbeat ? 1 : 0
        });
      }
    }
    /* [OCR功能已注释/移除] 仅保留切图同步方案；比分同步统一由直播端手动加减分控制 */
    patch.liveWsScoreSyncEnabled = false;
    if (Object.keys(patch).length) {
      var selfTick = this;
      this.setData(patch, function () {
        if (!hadTimeAct) return;
        if (selfTick.data.wxsClockBundle && selfTick.data.wxsClockBundle.mainRunning) {
          selfTick._liveWsStartClockTick();
        } else {
          selfTick._liveWsStopClockTick();
        }
      });
    }
  },
  /**
   * 消费直播送礼 / 互动打出消息，渲染滑出特效卡片。
   * @param {object} payload
   */
  _consumeLiveBoost: function (payload) {
    if (!payload) return;
    var self = this;
    var isTargeted = payload.act === 'LIVE_BOOST_TARGETED' || !!payload.is_targeted || !!payload.comment;
    var item = {
      nickname: payload.nickname || payload.user_name || '热心观众',
      avatar: payload.avatar || payload.avatar_url || '',
      gift_name: payload.gift_name || payload.gift || '礼物',
      comment: payload.comment || '',
      boost_type: payload.boost_type || (isTargeted ? '互动应援' : '送礼打出'),
      target_name: payload.target_name || payload.target_player || '',
      target_color: payload.target_color || '',
      is_targeted: isTargeted
    };
    if (this._liveBoostTimer) {
      clearTimeout(this._liveBoostTimer);
      this._liveBoostTimer = null;
    }
    this.setData({
      liveBoostItem: item,
      liveBoostVisible: true
    });
    this._liveBoostTimer = setTimeout(function () {
      self.setData({
        liveBoostVisible: false
      });
      setTimeout(function () {
        self.setData({
          liveBoostItem: null
        });
      }, 400);
    }, 4000);
  },

  /**
   * 展开/收起雷达送礼特效接入面板。
   */
  onRadarBoostPanelToggle: function () {
    if (!this.data.autoSyncWhitelisted) return;
    var lastRoomId = '';
    try {
      lastRoomId = String(wx.getStorageSync('radar_boost_room_id') || '');
    } catch (e) {}
    this.setData({
      radarBoostPanelOpen: !this.data.radarBoostPanelOpen,
      radarBoostRoomId: lastRoomId || this.data.radarBoostRoomId || ''
    });
  },

  /**
   * 关闭雷达送礼特效接入面板。
   */
  onRadarBoostPanelClose: function () {
    this.setData({
      radarBoostPanelOpen: false
    });
  },

  /**
   * 雷达 6 位直播房间号输入绑定。
   */
  onRadarBoostRoomIdInput: function (e) {
    var val = String((e.detail && e.detail.value) || '').replace(/\D/g, '').slice(0, 6);
    this.setData({
      radarBoostRoomId: val
    });
  },

  /**
   * 执行连入雷达送礼特效房间。
   */
  onRadarBoostConnectRun: function () {
    if (!this.data.autoSyncWhitelisted || this.data.radarBoostBusy) return;
    var roomId = String(this.data.radarBoostRoomId || '').replace(/\D/g, '').slice(0, 6);
    if (roomId.length !== 6) {
      wx.showToast({
        title: '请输入 6 位房间号',
        icon: 'none'
      });
      return;
    }
    var self = this;
    this._liveWsEnsureClient();
    this.setData({
      radarBoostBusy: true,
      radarBoostStatusText: '连接中…'
    });
    try {
      wx.setStorageSync('radar_boost_room_id', roomId);
    } catch (e) {}
    this._liveWsClient.connect(roomId);
    this.setData({
      radarBoostConnected: true,
      radarBoostBusy: false,
      radarBoostStatusText: '已连接',
      radarBoostPanelOpen: false
    });
    wx.showToast({
      title: '已连入雷达房间',
      icon: 'success'
    });
  },

  /**
   * 断开雷达送礼特效房间。
   */
  onRadarBoostDisconnectTap: function () {
    if (!this.data.autoSyncWhitelisted) return;
    if (this._liveWsClient) {
      this._liveWsClient.disconnect(true);
    }
    this.setData({
      radarBoostConnected: false,
      radarBoostBusy: false,
      radarBoostStatusText: '已断开'
    });
    wx.showToast({
      title: '已断开雷达房间',
      icon: 'none'
    });
  }
}
});
