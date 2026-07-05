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

/**
 * 竖屏窗口内最大内接 9:16 预览区（宽:高 = 9:16），与竖屏短视频画幅一致。
 *
 * @param {number} winW 窗口宽度（px）
 * @param {number} winH 窗口高度（px）
 * @returns {{ w: number, h: number }}
 */
function computePreviewStage9x16SizePx(winW, winH) {
  var ww = Math.max(1, winW);
  var wh = Math.max(1, winH);
  var ar = 9 / 16;
  if (ww / wh > ar) {
    var h1 = wh;
    return { w: h1 * ar, h: h1 };
  }
  var w0 = ww;
  return { w: w0, h: w0 / ar };
}

/**
 * 9:16 预览区在窗口中的位置（px，左上为原点）。
 *
 * @param {number} winW 窗口宽度（px）
 * @param {number} winH 窗口高度（px）
 * @returns {{ w: number, h: number, left: number, top: number }}
 */
function computePreviewStage9x16RectPx(winW, winH) {
  var box = computePreviewStage9x16SizePx(winW, winH);
  return {
    w: box.w,
    h: box.h,
    left: (winW - box.w) / 2,
    top: (winH - box.h) / 2
  };
}

Page({
  data: {
    statusBarHeight: 0,
    /** 9:16 预览取景区 inline style */
    previewStageStyle: '',
    /** 中心对准框 inline style（相对取景区 9:16） */
    alignFrameStyle: '',
    /** 相机预览/编码档位（由 highlight-rec-profile 注入，长时监看控温） */
    cameraResolution: 'medium',
    cameraFrameSize: 'medium',
    perfTierLabel: '',
    /** 录制清晰度：720p / 1080p */
    use1080p: false,
    canUse1080p: true,
    qualityLabel: '720p',
    /** 篮球追拍：连续 AF + 短快门优先 */
    actionMode: false,
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
    zoomStops: [
      { label: '特写', zoom: 4.0 },
      { label: '标准', zoom: 2.0 },
      { label: '广角', zoom: 1.0 }
    ],
    controlsCollapsed: false // 是否折叠控制面板
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

  onLoad: function (options) {
    this._unloaded = false;
    var sys = wx.getSystemInfoSync();
    var use1080pStored = !!wx.getStorageSync(STORAGE_KEY_USE_1080P);
    var actionModeStored = !!wx.getStorageSync(STORAGE_KEY_ACTION_MODE);
    highlightRecProfile.resetHighlightRecProfileCache();
    var perf = highlightRecProfile.getHighlightRecProfile({
      use1080p: use1080pStored,
      actionMode: actionModeStored
    });
    var canUse1080p = perf.tier !== '480p';
    var use1080p = canUse1080p && use1080pStored;
    var actionMode = perf.actionMode;
    if (!canUse1080p && use1080pStored) {
      wx.removeStorageSync(STORAGE_KEY_USE_1080P);
    }
    this._recPerfProfile = perf;
    this._highlightPipeline = createHighlightRecPipeline(this, perf);
    this.setData({
      statusBarHeight: sys.statusBarHeight || 20,
      roomId: wx.getStorageSync('rec_sync_room_id') || '',
      cameraResolution: perf.cameraResolution,
      cameraFrameSize: perf.cameraFrameSize,
      use1080p: use1080p,
      canUse1080p: canUse1080p,
      actionMode: actionMode,
      qualityLabel: perf.qualityLabel || '720p',
      perfTierLabel: this._buildPerfTierLabel(perf)
    });
    this._updatePreviewStageLayout(sys.windowWidth, sys.windowHeight);
    this._bindWindowResize();

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
    this.disconnectWs();
    this.stopRecorder();
  },

  onUnload: function () {
    this._unloaded = true;
    this._clearBufferStatusTimer();
    this._clearZoomApplyTimer();
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
   * 将相机预览限制为 9:16 内接矩形；录制仍走原生 cameraContext，不受预览黑边影响。
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
    var box = computePreviewStage9x16SizePx(sysW, sysH);
    var stageStyle = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
      'width:' + box.w + 'px;height:' + box.h + 'px;';
    var frameW = Math.round(box.w * 0.52);
    var frameH = Math.round(frameW * 16 / 9);
    var alignFrameStyle = 'width:' + frameW + 'px;height:' + frameH + 'px;';
    this.setData({
      previewStageStyle: stageStyle,
      alignFrameStyle: alignFrameStyle
    });
  },

  /* =========================================================================
   * 相机生命周期与录制控制
   * ========================================================================= */

  onCameraInit: function () {
    console.log('[HighlightRec] Camera mounted successfully');
    if (!this._cameraCtx) {
      this._cameraCtx = wx.createCameraContext();
    }
    this.data.cameraContext = this._cameraCtx;
    this._applyCameraCaptureTuning(this._recPerfProfile);
  },

  /**
   * 构建 HUD 档位文案。
   *
   * @param {Object} perf
   * @returns {string}
   */
  _buildPerfTierLabel: function (perf) {
    if (!perf) return '720p · 视录分离';
    var parts = [perf.qualityLabel || '720p'];
    if (perf.actionMode) parts.push('追拍');
    parts.push('视录分离');
    return parts.join(' · ');
  },

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
      perfTierLabel: this._buildPerfTierLabel(perf)
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
    return pipeline.start().then(function () {
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
    var self = this;
    return pipeline.stop().then(function () {
      self.setData({
        isRecording: false,
        pipelineReady: false,
        bufferCoverageText: '0s / 90s'
      });
    }).catch(function () {
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
    this.setData({
      controlsCollapsed: !this.data.controlsCollapsed
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
        actionMode: self.data.actionMode
      });
    }, function (perf) {
      self.setData({
        use1080p: want1080,
        qualityLabel: perf.qualityLabel || (want1080 ? '1080p' : '720p')
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
        actionMode: wantAction
      });
    }, function (perf) {
      self.setData({
        actionMode: wantAction,
        qualityLabel: perf.qualityLabel || self.data.qualityLabel
      });
      wx.showToast({
        title: wantAction ? '已开启追拍模式' : '已切换标准模式',
        icon: 'none'
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

    pipeline.triggerExport(Date.now())
      .then(function (trimmedPath) {
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

    // 将视频存入相册
    wx.saveVideoToPhotosAlbum({
      filePath: filePath,
      success: function () {
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
  }
});
