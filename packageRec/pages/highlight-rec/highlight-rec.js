/**
 * @fileoverview 高光素材机实验页面逻辑控制器。
 */

const recSync = require('../../../services/rec-sync-ws-client.js');
const { createHighlightRecPipeline } = require('../../utils/highlight-rec-pipeline.js');
const highlightRecProfile = require('../../utils/highlight-rec-profile.js');

/** 本地存储：是否启用 1080p 录制 */
var STORAGE_KEY_USE_1080P = 'highlight_rec_use_1080p_v1';
/** 本地存储：篮球追拍模式 */
var STORAGE_KEY_ACTION_MODE = 'highlight_rec_action_mode_v1';
/** 本地存储：画幅模式 portrait | landscape */
var STORAGE_KEY_ASPECT_MODE = 'highlight_rec_aspect_mode_v1';
/** 本地存储：录制方式 native | preview_record */
var STORAGE_KEY_REC_MODE = 'highlight_rec_mode_v1';

/**
 * 窗口内最大内接预览区（按画幅宽高比）。
 *
 * @param {number} winW 窗口宽度（px）
 * @param {number} winH 窗口高度（px）
 * @param {'portrait'|'portrait_4_3'|'landscape'|'landscape_4_3'} aspectMode
 * @returns {{ w: number, h: number }}
 */
function computePreviewStageSizePx(winW, winH, aspectMode) {
  var ww = Math.max(1, winW);
  var wh = Math.max(1, winH);
  var ar;
  if (aspectMode === highlightRecProfile.ASPECT_LANDSCAPE) {
    ar = 16 / 9;
  } else if (aspectMode === highlightRecProfile.ASPECT_LANDSCAPE_4_3) {
    ar = 4 / 3;
  } else if (aspectMode === highlightRecProfile.ASPECT_PORTRAIT_4_3) {
    ar = 3 / 4;
  } else {
    ar = 9 / 16;
  }
  if (ww / wh > ar) {
    var h1 = wh;
    return { w: h1 * ar, h: h1 };
  }
  var w0 = ww;
  return { w: w0, h: w0 / ar };
}

Page({
  data: {
    statusBarHeight: 0,
    hudTopPx: 68,
    /** 9:16 预览取景区 inline style */
    previewStageStyle: '',
    /** 中心对准框 inline style（相对取景区 9:16） */
    alignFrameStyle: '',
    /** 相机预览/编码档位（由 highlight-rec-profile 注入，长时监看控温） */
    cameraResolution: 'medium',
    cameraFrameSize: 'medium',
    perfTierLabel: '',
    compactStatusLabel: '原生·9:16·720p',
    /** 录制方式：native 原生相机 / preview_record 视录分离 */
    recMode: 'native',
    /** 设置弹窗是否打开 */
    settingsModalOpen: false,
    /** 录制清晰度：720p / 1080p */
    use1080p: false,
    canUse1080p: true,
    qualityLabel: '720p',
    /** 篮球追拍：连续 AF + 短快门优先 */
    actionMode: false,
    /** 画幅：portrait=9:16 / landscape=16:9 */
    aspectMode: 'portrait',
    aspectLabel: '9:16',
    zoom: 1.0,
    zoomDisplay: '1.0',
    cameraReady: false,
    wsConnected: false,
    isRecording: false,
    roomId: '',
    bufferCoverageText: '0s / 90s',
    pipelineReady: false,
    segmentMs: 45000, // 默认配置
    diskWarning: false,
    savedLogs: [],
    highlightCount: 0,
    savingCount: 0,
    auditFileReady: false,
    auditFileName: '',
    zoomStops: [
      { label: '特写', zoom: 4.0 },
      { label: '标准', zoom: 2.0 },
      { label: '广角', zoom: 1.0 }
    ],
    controlsCollapsed: true // 已废弃，保留兼容
  },

  _highlightPipeline: null,
  _bufferStatusTimer: null,
  _wsClient: null,
  _cameraCtx: null,
  _zoomApplyTimer: 0,
  _pendingZoom: null,
  _touchDistance: 0,
  _startZoom: 1.0,
  _focusLockedAtCenter: false,
  _unloaded: false,
  /** 用户是否希望保持监看（切后台恢复、切换设置后重启） */
  _monitoringRequested: false,
  _runtimeLogs: null,
  _pendingAuditFile: null,

  onLoad: function (options) {
    this._unloaded = false;
    var sys = wx.getSystemInfoSync();
    var use1080pStored = !!wx.getStorageSync(STORAGE_KEY_USE_1080P);
    var actionModeStored = !!wx.getStorageSync(STORAGE_KEY_ACTION_MODE);
    var aspectModeStored = highlightRecProfile.normalizeAspectMode(
      wx.getStorageSync(STORAGE_KEY_ASPECT_MODE)
    );
    var recModeStored = highlightRecProfile.normalizeRecMode(
      wx.getStorageSync(STORAGE_KEY_REC_MODE)
    );
    highlightRecProfile.resetHighlightRecProfileCache();
    var perf = highlightRecProfile.getHighlightRecProfile({
      use1080p: use1080pStored,
      actionMode: actionModeStored,
      aspectMode: aspectModeStored,
      recMode: recModeStored
    });
    var canUse1080p = perf.tier !== '480p';
    var use1080p = canUse1080p && use1080pStored;
    var actionMode = perf.actionMode;
    if (!canUse1080p && use1080pStored) {
      wx.removeStorageSync(STORAGE_KEY_USE_1080P);
    }
    this._recPerfProfile = perf;
    this._highlightPipeline = createHighlightRecPipeline(this, perf);
    this._dlog('INIT', 'Page loaded', { recMode: perf.recMode, aspectMode: perf.aspectMode, use1080p: use1080p, actionMode: actionMode });
    this.setData({
      statusBarHeight: sys.statusBarHeight || 20,
      roomId: wx.getStorageSync('rec_sync_room_id') || '',
      cameraResolution: perf.cameraResolution,
      cameraFrameSize: perf.cameraFrameSize,
      recMode: perf.recMode,
      use1080p: use1080p,
      canUse1080p: canUse1080p,
      actionMode: actionMode,
      aspectMode: perf.aspectMode,
      aspectLabel: perf.aspectLabel || '9:16',
      qualityLabel: perf.qualityLabel || '720p',
      perfTierLabel: this._buildPerfTierLabel(perf),
      compactStatusLabel: this._buildCompactStatusLabel(perf)
    });
    this._updatePreviewStageLayout(sys.windowWidth, sys.windowHeight);
    this._bindWindowResize();
    this._applyPageOrientation(perf.aspectMode);

    // 读取或初始化自定义快捷变焦档位
    var savedStops = wx.getStorageSync('rec_zoom_stops');
    if (savedStops && savedStops.length === 3) {
      this.setData({ zoomStops: savedStops });
    } else {
      var defaults = [
        { label: '特写', zoom: 4.0 },
        { label: '标准', zoom: 2.0 },
        { label: '广角', zoom: 1.0 }
      ];
      this.setData({ zoomStops: defaults });
      wx.setStorageSync('rec_zoom_stops', defaults);
    }

    // 滚动缓冲目标 90s（50s × 2 段 + 重叠）
    this.setData({
      segmentMs: 90000
    });
  },

  onReady: function () {
    var self = this;
    // 请求相机和麦克风权限，微信 startRecord 要求同时具备这两个权限
    wx.getSetting({
      success: function (res) {
        var auths = res.authSetting;
        var hasCamera = auths['scope.camera'];
        var hasRecord = auths['scope.record'];

        if (!hasCamera || !hasRecord) {
          wx.authorize({
            scope: 'scope.camera',
            success: function () {
              wx.authorize({
                scope: 'scope.record',
                success: function () {
                  self.setData({ cameraReady: true });
                },
                fail: function () {
                  self.showPermissionModal();
                }
              });
            },
            fail: function () {
              self.showPermissionModal();
            }
          });
        } else {
          self.setData({ cameraReady: true });
        }
      }
    });
  },

  showPermissionModal: function () {
    wx.showModal({
      title: '权限申请',
      content: '需要相机和麦克风权限，以用于高光的有声画面录制。请在设置中开启。',
      showCancel: false,
      success: function (res) {
        if (res.confirm) {
          wx.openSetting();
        }
      }
    });
  },

  onShow: function () {
    wx.setKeepScreenOn({
      keepScreenOn: true
    });
    this._applyPageOrientation(this.data.aspectMode || highlightRecProfile.ASPECT_PORTRAIT);
    this._updatePreviewStageLayout();
    this._livePageVisible = true;

    if (this._monitoringRequested && this.data.cameraReady && this._highlightPipeline
      && !this._highlightPipeline.isActive()) {
      this.startRecorder();
    }

    // 自动回连 WebSocket
    if (this.data.roomId.length === 6) {
      this.connectWs();
    }
  },

  onHide: function () {
    this._livePageVisible = false;
    this._clearBufferStatusTimer();
    if (this._orientationResizeTimer) {
      clearTimeout(this._orientationResizeTimer);
      this._orientationResizeTimer = null;
    }
    this.disconnectWs();
    this.stopRecorder();
  },

  onUnload: function () {
    this._unloaded = true;
    this._clearBufferStatusTimer();
    this._clearZoomApplyTimer();
    if (this._orientationResizeTimer) {
      clearTimeout(this._orientationResizeTimer);
      this._orientationResizeTimer = null;
    }
    this._applyPageOrientation(highlightRecProfile.ASPECT_PORTRAIT);
    this._cameraCtx = null;
    if (this._highlightPipeline) {
      this._highlightPipeline.destroy();
      this._highlightPipeline = null;
    }
    this._unbindWindowResize();
    this.disconnectWs();
    this.stopRecorder();
  },

  /**
   * 监听窗口尺寸变化，同步 9:16 预览布局。
   * @returns {void}
   */
  _bindWindowResize: function () {
    var self = this;
    if (typeof wx.onWindowResize !== 'function') return;
    this._onWindowResizeHandler = function (res) {
      var size = res && res.size ? res.size : {};
      self._updatePreviewStageLayout(size.windowWidth, size.windowHeight);
      if (self._orientationResizeTimer) {
        clearTimeout(self._orientationResizeTimer);
      }
      self._orientationResizeTimer = setTimeout(function () {
        self._orientationResizeTimer = null;
        if (!self._unloaded && self.data.cameraReady) {
          self._updatePreviewStageLayout();
        }
      }, 200);
    };
    wx.onWindowResize(this._onWindowResizeHandler);
  },

  /**
   * 取消窗口尺寸监听。
   * @returns {void}
   */
  _unbindWindowResize: function () {
    if (this._onWindowResizeHandler && typeof wx.offWindowResize === 'function') {
      wx.offWindowResize(this._onWindowResizeHandler);
    }
    this._onWindowResizeHandler = null;
  },

  /**
   * 将相机预览限制为当前画幅内接矩形；录制走离屏 canvas，不含预览黑边。
   *
   * @param {number} [winW] 窗口宽度（px）
   * @param {number} [winH] 窗口高度（px）
   * @returns {void}
   */
  _updatePreviewStageLayout: function (winW, winH) {
    var sysW = winW;
    var sysH = winH;
    if (!sysW || !sysH) {
      try {
        var si = wx.getSystemInfoSync();
        sysW = si.windowWidth || 375;
        sysH = si.windowHeight || 667;
      } catch (e) {
        sysW = 375;
        sysH = 667;
      }
    }
    var aspectMode = this.data.aspectMode || highlightRecProfile.ASPECT_PORTRAIT;
    var box = computePreviewStageSizePx(sysW, sysH, aspectMode);
    var stageStyle = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
      'width:' + box.w + 'px;height:' + box.h + 'px;';
    var frameW;
    var frameH;
    if (aspectMode === highlightRecProfile.ASPECT_LANDSCAPE) {
      frameW = Math.round(box.w * 0.38);
      frameH = Math.round(frameW * 9 / 16);
    } else if (aspectMode === highlightRecProfile.ASPECT_LANDSCAPE_4_3) {
      frameW = Math.round(box.w * 0.38);
      frameH = Math.round(frameW * 3 / 4);
    } else if (aspectMode === highlightRecProfile.ASPECT_PORTRAIT_4_3) {
      frameW = Math.round(box.w * 0.52);
      frameH = Math.round(frameW * 4 / 3);
    } else {
      frameW = Math.round(box.w * 0.52);
      frameH = Math.round(frameW * 16 / 9);
    }
    var alignFrameStyle = 'width:' + frameW + 'px;height:' + frameH + 'px;';
    var isLandscape = String(aspectMode || '').indexOf('landscape') === 0;
    var hudTopPx = (this.data.statusBarHeight || 20)
      + (isLandscape ? 28 : 48);
    this.setData({
      previewStageStyle: stageStyle,
      alignFrameStyle: alignFrameStyle,
      hudTopPx: hudTopPx
    });
  },

  /* =========================================================================
   * 相机生命周期与录制控制
   * ========================================================================= */

  onCameraInit: function () {
    console.log('[HighlightRec] Camera mounted successfully');
    this._dlog('CAM', 'Camera mounted successfully');
    if (!this._cameraCtx) {
      this._cameraCtx = wx.createCameraContext();
    }
    this.data.cameraContext = this._cameraCtx;
    this._applyCameraCaptureTuning(this._recPerfProfile);
  },

  /**
   * 按画幅切换页面方向（横屏模式须物理横置手机）。
   *
   * @param {string} aspectMode
   * @returns {void}
   */
  _applyPageOrientation: function (aspectMode) {
    if (!wx.setPageOrientation) return;
    var isLandscape = String(aspectMode || '').indexOf('landscape') === 0;
    var want = isLandscape ? 'landscape' : 'portrait';
    try {
      wx.setPageOrientation({ orientation: want });
    } catch (e) {
      console.warn('[HighlightRec] setPageOrientation failed:', e);
    }
  },

  /**
   * 方向变化后重建 camera 组件，避免预览与编码帧方向不一致。
   *
   * @returns {void}
   */
  _remountCameraAfterOrientation: function () {
    var self = this;
    this._cameraCtx = null;
    this.data.cameraContext = null;
    this.setData({ cameraReady: false }, function () {
      setTimeout(function () {
        if (!self._unloaded) {
          self.setData({ cameraReady: true });
        }
      }, 350);
    });
  },

  /**
   * 构建 HUD 档位文案。
   *
   * @param {Object} perf
   * @returns {string}
   */
  _buildPerfTierLabel: function (perf) {
    if (!perf) return '原生·9:16·720p';
    var modeTag = perf.recMode === 'preview_record' ? '视录分离' : '原生相机';
    var parts = [(perf.aspectLabel || '9:16') + ' ' + (perf.qualityLabel || '720p')];
    if (perf.actionMode) parts.push('追拍');
    parts.push(modeTag);
    return parts.join(' · ');
  },

  /**
   * 顶部状态条精简文案（横屏下避免过长）。
   *
   * @param {Object} perf
   * @returns {string}
   */
  _buildCompactStatusLabel: function (perf) {
    if (!perf) return '原生·9:16·720p';
    var modeTag = perf.recMode === 'preview_record' ? '视录' : '原生';
    var parts = [modeTag, perf.aspectLabel || '9:16', perf.qualityLabel || '720p'];
    if (perf.actionMode) parts.push('追拍');
    return parts.join('·');
  },

  /**
   * 打开设置弹窗。
   * @returns {void}
   */
  openSettingsModal: function () {
    this.setData({ settingsModalOpen: true });
  },

  /**
   * 关闭设置弹窗。
   * @returns {void}
   */
  closeSettingsModal: function () {
    this.setData({ settingsModalOpen: false });
  },

  /** 阻止弹窗内点击冒泡到遮罩 */
  stopModalBubbling: function () {},

  /** 阻止遮罩下层滚动 */
  preventTouchMove: function () {},

  /**
   * 按档位应用相机采集策略（对焦 / 曝光）。
   *
   * @param {Object} [perf]
   * @returns {void}
   */
  _applyCameraCaptureTuning: function (perf) {
    var profile = perf || this._recPerfProfile || {};
    if (profile.lockCenterFocus) {
      this._lockCameraFocusAtCenter();
    } else {
      this._focusLockedAtCenter = false;
    }
    this._applyExposureCompensation(profile.exposureCompensationEv || 0);
  },

  /**
   * 设置硬件曝光补偿（缩短快门、减轻运动拖影）。
   *
   * @param {number} ev
   * @returns {void}
   */
  _applyExposureCompensation: function (ev) {
    var value = Number(ev);
    if (!Number.isFinite(value)) {
      value = 0;
    }
    var ctx = this._getCameraContext();
    if (!ctx) return;
    if (typeof ctx.setExposureCompensation === 'function') {
      try {
        ctx.setExposureCompensation({ value: value });
      } catch (e) {}
      return;
    }
    if (typeof ctx.setEV === 'function') {
      try {
        ctx.setEV({ ev: value });
      } catch (e) {}
      return;
    }
    if (typeof ctx.setExposureOffset === 'function') {
      try {
        ctx.setExposureOffset({ offset: value });
      } catch (e) {}
    }
  },

  /**
   * 切换档位后重建录制管线。
   *
   * @param {Object} perf
   * @param {{ autoStart?: boolean }} [options]
   * @returns {void}
   */
  _rebuildHighlightPipeline: function (perf, options) {
    var opts = options || {};
    if (this._highlightPipeline) {
      this._highlightPipeline.destroy();
    }
    this._recPerfProfile = perf;
    this._highlightPipeline = createHighlightRecPipeline(this, perf);
    this.setData({
      cameraResolution: perf.cameraResolution,
      perfTierLabel: this._buildPerfTierLabel(perf),
      compactStatusLabel: this._buildCompactStatusLabel(perf)
    });
    this._applyCameraCaptureTuning(perf);
    if (opts.autoStart && this.data.cameraReady && this.data.cameraContext) {
      this.startRecorder();
    }
  },

  /**
   * 监看中切换参数：先停再重建，按需自动恢复监看。
   *
   * @param {function(): Object} buildPerf
   * @param {function(Object): void} onApplied
   * @returns {void}
   */
  _switchProfileWithRestart: function (buildPerf, onApplied) {
    var self = this;
    var wasRecording = this.data.isRecording;

    var apply = function () {
      var perf = buildPerf();
      return self.stopRecorder().then(function () {
        self._rebuildHighlightPipeline(perf, {
          autoStart: wasRecording && self._monitoringRequested
        });
        if (typeof onApplied === 'function') {
          onApplied(perf);
        }
      });
    };

    if (wasRecording) {
      wx.showModal({
        title: '切换设置',
        content: '将重启监看，缓冲会重新累积约 90 秒，是否继续？',
        confirmText: '继续',
        cancelText: '取消',
        success: function (res) {
          if (res.confirm) {
            apply();
          }
        }
      });
      return;
    }

    apply();
  },

  /**
   * 锁定对焦点在画面中心，禁用自动对焦反复评估（机位固定场景）。
   * 变焦时不重新对焦，避免 ISP 持续 AF  hunt 带来发热与画面抖动。
   *
   * @returns {void}
   */
  _lockCameraFocusAtCenter: function () {
    var ctx = this._cameraCtx;
    if (!ctx || typeof ctx.setTargetFocus !== 'function') {
      this._focusLockedAtCenter = false;
      return;
    }
    try {
      ctx.setTargetFocus({ x: 0.5, y: 0.5 });
      this._focusLockedAtCenter = true;
      console.log('[HighlightRec] Focus locked at center (auto-focus disabled)');
    } catch (e) {
      this._focusLockedAtCenter = false;
      console.warn('[HighlightRec] setTargetFocus unavailable:', e);
    }
  },

  /**
   * 获取复用的相机上下文。
   *
   * @returns {WechatMiniprogram.CameraContext}
   */
  _getCameraContext: function () {
    if (!this._cameraCtx) {
      this._cameraCtx = wx.createCameraContext();
    }
    return this._cameraCtx;
  },

  onCameraError: function (e) {
    console.error('[HighlightRec] Camera failed to init:', e);
    wx.showToast({
      title: '相机启动失败',
      icon: 'none'
    });
  },

  /**
   * 清除缓冲状态轮询。
   * @returns {void}
   */
  _clearBufferStatusTimer: function () {
    if (this._bufferStatusTimer) {
      clearInterval(this._bufferStatusTimer);
      this._bufferStatusTimer = null;
    }
  },

  startRecorder: function () {
    var pipeline = this._highlightPipeline;
    if (!pipeline) return Promise.resolve();
    if (pipeline.isActive()) return Promise.resolve();

    if (!pipeline.isSupported()) {
      wx.showModal({
        title: '设备不支持',
        content: '当前微信基础库不支持视录分离（MediaRecorder/离屏 Canvas）。请升级微信后重试。',
        showCancel: false
      });
      return Promise.reject(new Error('preview_record_unsupported'));
    }

    var self = this;
    this._monitoringRequested = true;
    this._dlog('REC', 'startRecorder initiated, recMode: ' + this.data.recMode);
    return pipeline.start().then(function () {
      self._dlog('REC', 'startRecorder success, pipeline active');
      self.setData({
        isRecording: true,
        pipelineReady: true
      });
      self.updateBufferStatus();
      self._clearBufferStatusTimer();
      self._bufferStatusTimer = setInterval(function () {
        if (!self._unloaded) {
          self.updateBufferStatus();
        }
      }, 5000);
    }).catch(function (err) {
      self._monitoringRequested = false;
      self._dlog('REC', 'startRecorder failed', err);
      console.error('[HighlightRec] Pipeline start failed:', err);
      wx.showToast({
        title: '监看启动失败',
        icon: 'none'
      });
      throw err;
    });
  },

  stopRecorder: function () {
    var pipeline = this._highlightPipeline;
    if (!pipeline) return Promise.resolve();
    if (!pipeline.isActive()) {
      this._clearBufferStatusTimer();
      this.setData({
        isRecording: false,
        pipelineReady: false,
        bufferCoverageText: '0s / 90s'
      });
      return Promise.resolve();
    }
    this._clearBufferStatusTimer();
    this._dlog('REC', 'stopRecorder initiated');
    var self = this;
    return pipeline.stop().then(function () {
      self._dlog('REC', 'stopRecorder completed');
      self.setData({
        isRecording: false,
        pipelineReady: false,
        bufferCoverageText: '0s / 90s'
      });
    }).catch(function () {
      self._dlog('REC', 'stopRecorder finished with catch');
      self.setData({
        isRecording: false,
        pipelineReady: false,
        bufferCoverageText: '0s / 90s'
      });
    });
  },

  /**
   * 开始 / 停止滚动缓冲监看。
   *
   * @returns {void}
   */
  onMonitorToggle: function () {
    if (this.data.isRecording) {
      this._monitoringRequested = false;
      this.stopRecorder();
      wx.showToast({
        title: '已停止监看，可调整设置',
        icon: 'none'
      });
      return;
    }
    if (!this.data.cameraReady) {
      wx.showToast({
        title: '相机未就绪',
        icon: 'none'
      });
      return;
    }
    var self = this;
    this.startRecorder().then(function () {
      wx.showToast({
        title: '监看已开启',
        icon: 'none'
      });
    }).catch(function () {});
  },

  updateBufferStatus: function () {
    var pipeline = this._highlightPipeline;
    if (!pipeline || !pipeline.isActive()) return;
    if (this.data.recMode === 'native') {
      var segs = pipeline.getVideoSegments ? pipeline.getVideoSegments() : [];
      var start = 0;
      if (segs && segs.length > 0) {
        start = segs[segs.length - 1].start;
      }
      var elapsedSec = start ? Math.max(0, Math.floor((Date.now() - start) / 1000)) : 0;
      var m = Math.floor(elapsedSec / 60);
      var s = elapsedSec % 60;
      var timeStr = m > 0 ? (m + 'm ' + s + 's') : (s + 's');
      this.setData({
        bufferCoverageText: 'REC 8s (' + timeStr + ')'
      });
      return;
    }
    var totalSec = pipeline.estimateBufferCoverageSec();
    var targetMax = Math.round((this._recPerfProfile && this._recPerfProfile.bufferTargetMs
      ? this._recPerfProfile.bufferTargetMs
      : this.data.segmentMs) / 1000);
    this.setData({
      bufferCoverageText: Math.min(targetMax, totalSec) + 's / ' + targetMax + 's'
    });
  },

  checkDiskSpace: function () {
    var self = this;
    if (typeof wx.getStorageInfo === 'function') {
      wx.getStorageInfo({
        success: function (res) {
          // 如果当前小程序本地存储占用率超过 85%，触发预警
          var isTight = res.currentSize > res.limitSize * 0.85;
          self.setData({ diskWarning: isTight });
        }
      });
    }
  },

  changeConfig: function (e) {
    if (this.data.isRecording) {
      wx.showToast({
        title: '录制中不可调整参数',
        icon: 'none'
      });
      return;
    }

    var dataset = e.currentTarget.dataset;
    var segment = Number(dataset.segment);

    this.setData({
      segmentMs: segment * 1000
    });

    wx.showToast({
      title: '参数已更新',
      icon: 'none'
    });
  },

  toggleHudCollapse: function () {
    this.openSettingsModal();
  },

  /**
   * 切换录制方式（native 原生相机 / preview_record 视录分离）。
   *
   * @param {Object} e
   * @returns {void}
   */
  onRecModeToggle: function (e) {
    var wantMode = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.mode;
    var nextMode = highlightRecProfile.normalizeRecMode(wantMode);
    if (nextMode === this.data.recMode) return;

    var self = this;
    this._switchProfileWithRestart(function () {
      wx.setStorageSync(STORAGE_KEY_REC_MODE, nextMode);
      highlightRecProfile.resetHighlightRecProfileCache();
      return highlightRecProfile.getHighlightRecProfile({
        use1080p: self.data.use1080p,
        actionMode: self.data.actionMode,
        aspectMode: self.data.aspectMode,
        recMode: nextMode
      });
    }, function (perf) {
      self.setData({
        recMode: perf.recMode,
        perfTierLabel: self._buildPerfTierLabel(perf),
        compactStatusLabel: self._buildCompactStatusLabel(perf)
      });
      wx.showToast({
        title: nextMode === 'native' ? '已切至原生相机(推荐·控温)' : '已切至视录分离(双录)',
        icon: 'none'
      });
    });
  },

  /**
   * 切换录制清晰度（720p / 1080p）。
   *
   * @param {Object} e
   * @returns {void}
   */
  onQualityToggle: function (e) {
    var want1080 = !!(e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.hd);
    if (want1080 === this.data.use1080p) return;
    if (want1080 && this.data.actionMode) {
      wx.showToast({
        title: '追拍模式建议 720p',
        icon: 'none'
      });
    }

    var self = this;
    this._switchProfileWithRestart(function () {
      wx.setStorageSync(STORAGE_KEY_USE_1080P, want1080);
      highlightRecProfile.resetHighlightRecProfileCache();
      return highlightRecProfile.getHighlightRecProfile({
        use1080p: want1080,
        actionMode: self.data.actionMode,
        aspectMode: self.data.aspectMode,
        recMode: self.data.recMode
      });
    }, function (perf) {
      self.setData({
        use1080p: want1080,
        qualityLabel: perf.qualityLabel || (want1080 ? '1080p' : '720p'),
        perfTierLabel: self._buildPerfTierLabel(perf),
        compactStatusLabel: self._buildCompactStatusLabel(perf)
      });
      wx.showToast({
        title: want1080 ? '已切换 1080p 高清' : '已切换 720p 均衡',
        icon: 'none'
      });
    });
  },

  /**
   * 切换篮球追拍模式。
   *
   * @param {Object} e
   * @returns {void}
   */
  onActionModeToggle: function (e) {
    var wantAction = !!(e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.action);
    if (wantAction === this.data.actionMode) return;

    var self = this;
    this._switchProfileWithRestart(function () {
      wx.setStorageSync(STORAGE_KEY_ACTION_MODE, wantAction);
      highlightRecProfile.resetHighlightRecProfileCache();
      return highlightRecProfile.getHighlightRecProfile({
        use1080p: self.data.use1080p,
        actionMode: wantAction,
        aspectMode: self.data.aspectMode,
        recMode: self.data.recMode
      });
    }, function (perf) {
      self.setData({
        actionMode: wantAction,
        qualityLabel: perf.qualityLabel || self.data.qualityLabel,
        perfTierLabel: self._buildPerfTierLabel(perf),
        compactStatusLabel: self._buildCompactStatusLabel(perf)
      });
      wx.showToast({
        title: wantAction ? '已开启追拍模式' : '已切换标准模式',
        icon: 'none'
      });
    });
  },

  /**
   * 切换画幅（竖持 9:16 / 3:4 ，横置 16:9 / 4:3）。
   *
   * @param {Object} e
   * @returns {void}
   */
  onAspectModeToggle: function (e) {
    var wantAspect = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.aspect;
    if (!wantAspect && e && e.currentTarget && e.currentTarget.dataset && typeof e.currentTarget.dataset.landscape !== 'undefined') {
      wantAspect = e.currentTarget.dataset.landscape ? highlightRecProfile.ASPECT_LANDSCAPE : highlightRecProfile.ASPECT_PORTRAIT;
    }
    var nextMode = highlightRecProfile.normalizeAspectMode(wantAspect);
    if (nextMode === this.data.aspectMode) return;

    var self = this;
    this._switchProfileWithRestart(function () {
      wx.setStorageSync(STORAGE_KEY_ASPECT_MODE, nextMode);
      highlightRecProfile.resetHighlightRecProfileCache();
      return highlightRecProfile.getHighlightRecProfile({
        use1080p: self.data.use1080p,
        actionMode: self.data.actionMode,
        aspectMode: nextMode,
        recMode: self.data.recMode
      });
    }, function (perf) {
      self._applyPageOrientation(perf.aspectMode);
      self.setData({
        aspectMode: perf.aspectMode,
        aspectLabel: perf.aspectLabel || '9:16',
        perfTierLabel: self._buildPerfTierLabel(perf),
        compactStatusLabel: self._buildCompactStatusLabel(perf)
      });
      self._updatePreviewStageLayout();
      self._remountCameraAfterOrientation();
      var isLand = nextMode.indexOf('landscape') === 0;
      wx.showToast({
        title: isLand ? ('请横置手机拍摄 ' + perf.aspectLabel) : ('已切换竖持 ' + perf.aspectLabel),
        icon: 'none',
        duration: 2500
      });
    });
  },

  /* =========================================================================
   * 变焦缩放与触摸手势（保留变焦；不触发自动对焦）
   * ========================================================================= */

  onZoomSliderChange: function (e) {
    var val = Number(e.detail.value);
    this.updateZoom(val, { immediate: true });
  },

  onQuickZoomStopTap: function (e) {
    var idx = Number(e.currentTarget.dataset.index);
    var stops = this.data.zoomStops;
    if (stops && stops[idx]) {
      this.updateZoom(stops[idx].zoom, { immediate: true });
    }
  },

  onQuickZoomStopLongPress: function (e) {
    var idx = Number(e.currentTarget.dataset.index);
    var stops = this.data.zoomStops;
    if (stops && stops[idx]) {
      var currentZoom = this.data.zoom;
      stops[idx].zoom = currentZoom;
      this.setData({ zoomStops: stops });
      wx.setStorageSync('rec_zoom_stops', stops);

      if (typeof wx.vibrateShort === 'function') {
        wx.vibrateShort({ type: 'medium' });
      }

      wx.showToast({
        title: '已保存 ' + currentZoom.toFixed(1) + 'x 至“' + stops[idx].label + '”',
        icon: 'success'
      });
    }
  },

  /**
   * 清除变焦节流定时器。
   * @returns {void}
   */
  _clearZoomApplyTimer: function () {
    if (this._zoomApplyTimer) {
      clearTimeout(this._zoomApplyTimer);
      this._zoomApplyTimer = 0;
    }
  },

  /**
   * 节流应用变焦；刻意不调用 setTargetFocus，避免变焦后自动重新对焦。
   *
   * @param {number} zoomVal
   * @param {{ immediate?: boolean }} [options]
   * @returns {void}
   */
  updateZoom: function (zoomVal, options) {
    var self = this;
    var opts = options || {};
    var rounded = Math.round(zoomVal * 10) / 10;
    var finalZoom = Math.min(5.0, Math.max(1.0, rounded));
    this._pendingZoom = finalZoom;

    var apply = function () {
      var target = self._pendingZoom;
      if (target == null) return;
      self._pendingZoom = null;
      self.setData({
        zoom: target,
        zoomDisplay: target.toFixed(1)
      });
      var cameraCtx = self._getCameraContext();
      if (cameraCtx && typeof cameraCtx.setZoom === 'function') {
        cameraCtx.setZoom({
          zoom: target,
          fail: function (err) {
            console.warn('[HighlightRec] Camera setZoom failed:', err);
          }
        });
      }
    };

    if (opts.immediate) {
      this._clearZoomApplyTimer();
      apply();
      return;
    }
    if (this._zoomApplyTimer) return;
    this._zoomApplyTimer = setTimeout(function () {
      self._zoomApplyTimer = 0;
      apply();
    }, 80);
  },

  onTouchStart: function (e) {
    if (e.touches.length === 2) {
      this._touchDistance = this.getTouchDistance(e);
      this._startZoom = this.data.zoom;
    }
  },

  onTouchMove: function (e) {
    if (e.touches.length === 2 && this._touchDistance) {
      var curDist = this.getTouchDistance(e);
      var ratio = curDist / this._touchDistance;
      var nextZoom = Math.min(5.0, Math.max(1.0, this._startZoom * ratio));
      this.updateZoom(nextZoom);
    }
  },

  getTouchDistance: function (e) {
    var x = e.touches[0].clientX - e.touches[1].clientX;
    var y = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(x * x + y * y);
  },

  /* =========================================================================
   * WebSocket 信令同步
   * ========================================================================= */

  onRoomIdInput: function (e) {
    var val = String(e.detail.value || '').replace(/\D/g, '').slice(0, 6);
    this.setData({ roomId: val });
    wx.setStorageSync('rec_sync_room_id', val);
  },

  toggleConnection: function () {
    if (this.data.wsConnected) {
      this.disconnectWs();
    } else {
      if (this.data.roomId.length !== 6) {
        wx.showToast({
          title: '请输入6位房间号',
          icon: 'none'
        });
        return;
      }
      this.connectWs();
    }
  },

  connectWs: function () {
    this.disconnectWs();

    var self = this;
    var roomId = this.data.roomId;

    this._wsClient = recSync.createRecSyncWsClient({
      onOpen: function () {
        self.setData({ wsConnected: true });
        wx.showToast({ title: '已连接同步房间', icon: 'success' });
      },
      onClose: function () {
        self.setData({ wsConnected: false });
      },
      onError: function (err) {
        self.setData({ wsConnected: false });
        wx.showToast({ title: '连接错误', icon: 'none' });
      },
      onTrigger: function (payload) {
        console.log('[HighlightRec] Received sync REC trigger from server, triggerId:', payload.triggerId);
        var now = Date.now();
        if (self._lastWsRecTime && now - self._lastWsRecTime < 4000) {
          console.log('[HighlightRec] Remote sync trigger ignored: too frequent');
          return;
        }
        self._lastWsRecTime = now;
        self.doExportHighlight(false);
      }
    });

    this._wsClient.connect(roomId, 'recorder');
  },

  disconnectWs: function () {
    if (this._wsClient) {
      try {
        this._wsClient.destroy();
      } catch (e) {}
      this._wsClient = null;
    }
    this.setData({ wsConnected: false });
  },

  /* =========================================================================
   * 高光导出与落盘
   * ========================================================================= */

  _lastManualRecTime: 0,
  _lastWsRecTime: 0,

  triggerManualRec: function () {
    var now = Date.now();
    if (this._lastManualRecTime && now - this._lastManualRecTime < 4000) {
      wx.showToast({
        title: '点击太频繁，请稍后再试',
        icon: 'none'
      });
      return;
    }
    this._lastManualRecTime = now;
    this.doExportHighlight(true);
  },

  doExportHighlight: function (isLocal) {
    var pipeline = this._highlightPipeline;
    if (!pipeline || !pipeline.isActive()) {
      wx.showToast({
        title: '请先开启监看',
        icon: 'none'
      });
      return;
    }

    var self = this;
    this.setData({
      savingCount: this.data.savingCount + 1
    });

    this._dlog('EXPORT', 'doExportHighlight triggered', { isLocal: !!isLocal });
    pipeline.triggerExport(Date.now())
      .then(function (trimmedPath) {
        self._dlog('EXPORT', 'triggerExport success', { path: trimmedPath });
        self.saveVideoToPhotos(trimmedPath, isLocal);
        self.updateBufferStatus();
        self.checkDiskSpace();
      })
      .catch(function (err) {
        self.setData({
          savingCount: Math.max(0, self.data.savingCount - 1)
        });
        if (self._unloaded) return;
        if (err && err.message === 'recorder_stopped') {
          return; // 页面切出或销毁时，正常释放挂起的 promise，无需报错弹窗
        }
        self._dlog('EXPORT', 'triggerExport failed', err);
        console.error('[HighlightRec] Export highlight failed:', err);
        var errMsg = (err && err.message) ? err.message : '裁切高光时发生错误，请重试';
        if (errMsg.indexOf('audio_mux_failed') >= 0) {
          errMsg = '视频已就绪但合成声音失败，请确认已授权麦克风并重试';
        }
        wx.showModal({
          title: '导出失败',
          content: errMsg,
          showCancel: false
        });
      });
  },

  saveVideoToPhotos: function (filePath, isLocal) {
    var self = this;
    this._dlog('ALBUM', 'saveVideoToPhotosAlbum start', { path: filePath });

    // 将视频存入相册
    wx.saveVideoToPhotosAlbum({
      filePath: filePath,
      success: function () {
        self._dlog('ALBUM', 'saveVideoToPhotosAlbum success', { path: filePath });
        self.setData({
          savingCount: Math.max(0, self.data.savingCount - 1)
        });
        wx.showToast({
          title: '高光已存入相册',
          icon: 'success'
        });

        // 记入日志展示
        var now = new Date();
        var timeStr = (now.getHours() < 10 ? '0' : '') + now.getHours() + ':' +
                      (now.getMinutes() < 10 ? '0' : '') + now.getMinutes() + ':' +
                      (now.getSeconds() < 10 ? '0' : '') + now.getSeconds();

        var logs = self.data.savedLogs.slice();
        logs.unshift({
          time: timeStr,
          isLocal: !!isLocal
        });

        self.setData({
          savedLogs: logs.slice(0, 30), // 最大展示最近 30 条
          highlightCount: self.data.highlightCount + 1
        });

        // 裁切完成后的临时视频物理删除，释放沙盒空间
        try {
          wx.getFileSystemManager().unlink({
            filePath: filePath,
            fail: function () {}
          });
        } catch (e) {}
      },
      fail: function (err) {
        self._dlog('ALBUM', 'saveVideoToPhotosAlbum failed', err);
        self.setData({
          savingCount: Math.max(0, self.data.savingCount - 1)
        });
        console.error('[HighlightRec] Save to album failed:', err);
        
        // 如果是权限被拒，引导授权
        if (err.errMsg && (err.errMsg.indexOf('auth') >= 0 || err.errMsg.indexOf('deny') >= 0)) {
          wx.showModal({
            title: '需要保存相册权限',
            content: '高光片段无法存入系统相册。请在设置中开启保存到相册权限。',
            success: function (res) {
              if (res.confirm) {
                wx.openSetting();
              }
            }
          });
        } else {
          wx.showToast({
            title: '保存相册失败',
            icon: 'none'
          });
        }
      }
    });
  },

  onBackTap: function () {
    wx.navigateBack({
      fail: function () {
        wx.switchTab({
          url: '/pages/index/index'
        });
      }
    });
  },

  /* =========================================================================
   * 运行审计日志收集与微信分享
   * ========================================================================= */

  _dlog: function (tag, msg, extra) {
    if (!this._runtimeLogs) this._runtimeLogs = [];
    var now = new Date();
    var pad = function (n, len) {
      var s = String(n);
      while (s.length < (len || 2)) s = '0' + s;
      return s;
    };
    var timeStr = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' +
                  pad(now.getSeconds()) + '.' + pad(now.getMilliseconds(), 3);
    var entry = '[' + timeStr + '] [' + tag + '] ' + (typeof msg === 'object' ? JSON.stringify(msg) : String(msg));
    if (extra !== undefined) {
      try { entry += ' | ' + (typeof extra === 'object' ? JSON.stringify(extra) : String(extra)); } catch (e) {}
    }
    this._runtimeLogs.push(entry);
    if (this._runtimeLogs.length > 500) this._runtimeLogs.shift();
    console.log('[HighlightRecAudit]', entry);
  },

  _prepareAuditFile: function () {
    var sys = {};
    try { sys = wx.getSystemInfoSync(); } catch (e) {}
    var storage = {};
    try { storage = wx.getStorageInfoSync(); } catch (e) {}

    var lines = [];
    lines.push('==================================================');
    lines.push('       Miaoji Live 高光素材机 运行审计日志');
    lines.push('==================================================');
    lines.push('导出时间: ' + new Date().toLocaleString());
    lines.push('设备型号: ' + (sys.model || 'Unknown') + ' (' + (sys.brand || '') + ')');
    lines.push('操作系统: ' + (sys.system || 'Unknown') + ' / SDK ' + (sys.SDKVersion || ''));
    lines.push('屏幕尺寸: ' + (sys.windowWidth || 0) + 'x' + (sys.windowHeight || 0));
    lines.push('--------------------------------------------------');
    lines.push('【录制配置与状态】');
    lines.push('录制模式: ' + this.data.recMode + ' (' + (this.data.recMode === 'native' ? '原生相机' : '视录分离') + ')');
    lines.push('画幅模式: ' + this.data.aspectMode + ' (' + this.data.aspectLabel + ')');
    lines.push('清晰度: ' + (this.data.use1080p ? '1080p' : '720p'));
    lines.push('追拍模式: ' + (this.data.actionMode ? '开启' : '关闭'));
    lines.push('监看状态: ' + (this.data.isRecording ? '录制/监看中' : '未开启'));
    lines.push('相册保存计数: ' + this.data.highlightCount + ' (处理中: ' + this.data.savingCount + ')');
    lines.push('存储空间: ' + (storage.currentSize || 0) + ' KB / ' + (storage.limitSize || 0) + ' KB');
    if (this._recPerfProfile) {
      lines.push('性能 Profile: ' + JSON.stringify(this._recPerfProfile));
    }
    lines.push('--------------------------------------------------');
    lines.push('【近 500 条运行日志轨迹】');
    var logs = this._runtimeLogs || [];
    if (logs.length === 0) {
      lines.push('(暂无运行日志)');
    } else {
      lines = lines.concat(logs);
    }
    lines.push('==================================================');

    var content = lines.join('\n');
    var fs = wx.getFileSystemManager();
    var fileName = 'highlight_audit_' + Date.now() + '.txt';
    var filePath = (wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH : '') + '/' + fileName;

    try {
      fs.writeFileSync(filePath, content, 'utf8');
      var stat = fs.statSync(filePath);
      var size = stat ? stat.size : content.length;
      return {
        ok: true,
        path: filePath,
        fileName: fileName,
        sizeKb: Math.max(1, Math.round(size / 1024))
      };
    } catch (err) {
      console.error('[HighlightRec] Write audit file failed:', err);
      return { ok: false, error: err };
    }
  },

  onPrepareAuditLog: function () {
    var fileResult = this._prepareAuditFile();
    if (!fileResult.ok || !fileResult.path) {
      wx.showToast({ title: '生成日志失败', icon: 'none' });
      return;
    }
    this._pendingAuditFile = fileResult;
    this.setData({
      auditFileReady: true,
      auditFileName: fileResult.fileName
    });
    if (typeof wx.vibrateShort === 'function') {
      wx.vibrateShort({ type: 'medium' });
    }
    wx.showToast({
      title: '日志就绪！点击「发送日志」分享',
      icon: 'none',
      duration: 3000
    });
    this._dlog('AUDIT', 'Audit file generated:', fileResult.fileName);
  },

  onShareAuditFile: function () {
    var self = this;
    var pending = this._pendingAuditFile;
    if (!pending || !pending.path) {
      var res = this._prepareAuditFile();
      if (res.ok && res.path) {
        pending = res;
        this._pendingAuditFile = res;
      } else {
        wx.showToast({ title: '生成日志失败', icon: 'none' });
        return;
      }
    }

    this._dlog('AUDIT', 'Sharing audit file via wx.shareFileMessage:', pending.fileName);

    if (typeof wx.shareFileMessage === 'function') {
      wx.shareFileMessage({
        filePath: pending.path,
        fileName: pending.fileName,
        success: function () {
          wx.showToast({ title: '已发送日志文件', icon: 'success' });
          self.setData({ auditFileReady: false });
          self._pendingAuditFile = null;
        },
        fail: function (err) {
          console.warn('[HighlightRec] shareFileMessage failed:', err);
          self._fallbackShareAuditFile(pending);
        }
      });
      return;
    }

    this._fallbackShareAuditFile(pending);
  },

  _fallbackShareAuditFile: function (pending) {
    if (typeof wx.openDocument === 'function') {
      wx.openDocument({
        filePath: pending.path,
        showMenu: true,
        success: function () {
          wx.showToast({ title: '可通过右上角...菜单发送', icon: 'none' });
        },
        fail: function () {
          wx.showModal({
            title: '日志文件已就绪',
            content: '文件路径:\n' + pending.path + '\n可使用微信开发者工具或调试器导出。',
            showCancel: false
          });
        }
      });
      return;
    }
    wx.showModal({
      title: '日志文件已就绪',
      content: '文件已生成，请在微信调试器中导出。',
      showCancel: false
    });
  }
});
