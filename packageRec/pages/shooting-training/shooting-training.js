/**
 * @fileoverview 投篮训练实验功能页面
 *
 * 技术路线：
 *   1. 首次进入按需下载 E-BARD YOLOv8n ONNX（篮球专用检测）
 *   2. avishah3 best.pt ONNX + detect_up/down/score 计分（对齐 Python 工程）
 *   3. onCameraFrame 限流推理（iOS 80ms / Android 50ms），避免占满 JS 线程
 *   4. 开发者工具下触控模拟验证 FSM
 */

var checkSyncLabWhitelist = require('../../../utils/sync-lab-whitelist.js').checkSyncLabWhitelist;
var stDebug = require('../../utils/shooting-training-debug.js');
var stExport = require('../../utils/shooting-training-export.js');
var avishahTrackerMod = require('../../utils/shooting-avishah-shot-tracker.js');
var ballModelLoader = require('../../utils/shooting-ball-model-loader.js');
var ballDetectorMod = require('../../utils/shooting-ball-detector.js');
var ballModelConfig = require('../../constants/shooting-ball-model-config.js');

/** bindinitdone 超时（ms） */
var CAMERA_INIT_TIMEOUT_MS = 8000;
/** 相机 remount 间隔（ms） */
var CAMERA_REMOUNT_DELAY_MS = 350;
/** 球标记 UI 刷新间隔（ms） */
var BALL_UI_INTERVAL_MS = 100;
/** 轨迹 UI 刷新间隔（ms），降低 setData 频率避免卡 UI */
var TRAIL_UI_INTERVAL_MS = 200;
/**
 * iOS 帧处理最小间隔（ms）。真正的处理节奏由单帧推理耗时（_inferBusy 串行）
 * 决定，这里只是一个保底下限——letterbox 优化后单帧总耗时已经降到 60~80ms
 * 量级，不再需要用这个值人为限速，调低到接近 0 让流水线尽量吃满相机出帧率。
 */
var FRAME_INTERVAL_IOS_MS = 10;
/** Android 帧处理最小间隔（ms），同上 */
var FRAME_INTERVAL_ANDROID_MS = 10;
/** 校准框默认宽度占屏宽比例（默认给小一点，避免强制贴近拍摄） */
var DEFAULT_HOOP_WIDTH_RATIO = 0.36;
/** 校准框默认高宽比 */
var DEFAULT_HOOP_ASPECT = 0.67;
/** 校准框可拖拽缩放的最小边长（px） */
var HOOP_BOX_MIN_SIZE = 60;

Page({
  data: {
    statusBarHeight: 0,
    hudTopPx: 50,
    navRightPadding: 16,
    /** 页面状态: loading | modelLoading | permissionDenied | ready | training | error */
    status: 'loading',
    errorMessage: '',
    /** 模型下载进度 0~100 */
    modelProgress: 0,
    modelProgressText: '',
    modelLoaded: false,
    /** 控制 <camera> 组件是否挂载 */
    cameraReady: false,
    /** 相机预览档位 */
    cameraResolution: 'medium',
    /**
     * onCameraFrame 抽帧档位：投篮训练是独立页面，不像 live 页需要顾及直播编码发热，
     * 用 large 换取更大原始帧（篮球这类小目标裁剪缩放到 640 输入后细节更多），
     * 不影响 live 页（那边是完全独立的模块级常量，与本页 data 无关）。
     */
    cameraFrameSize: 'large',

    // 看板
    shotsMade: 0,
    shotsTotal: 0,
    streak: 0,
    /** 命中率展示（cover-view 不支持 wxs，由 JS 计算） */
    hitRateText: '0%',

    // UI
    ballX: null,
    ballY: null,
    hoopStyle: { left: 100, top: 300, width: 180, height: 120 },
    feedbackState: '',
    /** 轨迹尾迹点（调试用可视化，不遮挡主画面） */
    trailPoints: [],
    fsmState: 'IDLE',
    /** ML 诊断：检出/推理次数与峰值置信度（cover-view 展示） */
    mlDebugText: 'ML: --',
    /** 屏上日志尾（可截图，不依赖导出） */
    debugTail: '等待启动…',
    /** 弱检出（黄点） */
    ballPeek: false,
    /** 是否暂停 ML 推理（默认暂停，用户手动开启，避免占满主线程） */
    mlPaused: true
  },

  // ==================== 生命周期 ====================

  /**
   * @returns {void}
   */
  onLoad: function () {
    stDebug.clear();
    var whitelisted = checkSyncLabWhitelist();
    this._dlog('BOOT', 'whitelist=' + whitelisted);
    if (!whitelisted) {
      this._dlog('BOOT', 'blocked: not in sync-lab whitelist');
      wx.showToast({ title: '暂无使用权限', icon: 'none', duration: 2000 });
      setTimeout(function () { wx.navigateBack(); }, 2000);
      return;
    }

    var sys = wx.getSystemInfoSync();
    var navRightPadding = 16;
    try {
      if (wx.getMenuButtonBoundingClientRect) {
        var menu = wx.getMenuButtonBoundingClientRect();
        if (menu && typeof menu.left === 'number') {
          navRightPadding = Math.max(16, sys.windowWidth - menu.left + 10);
        }
      }
    } catch (eMenu) {}
    this.setData({
      statusBarHeight: sys.statusBarHeight || 0,
      hudTopPx: (sys.statusBarHeight || 0) + 50,
      navRightPadding: navRightPadding,
      cameraFrameSize: 'large'
    });

    this._unloaded = false;
    this._shotTracker = null;
    this._ballDetector = null;
    this._inferSession = null;
    this._inferMeta = null;
    this._modelPath = null;
    this._detectorOpts = null;
    this._npuTrialDone = false;
    this._npuSampleCount = 0;
    this._npuAbnormalCount = 0;
    this._npuFallbackInFlight = false;
    this._inferBusy = false;
    this._modelLoaded = false;
    this._frameRxCount = 0;
    this._frameProcCount = 0;
    this._ballDetectCount = 0;
    this._lastFrameSize = '-';
    this._pageReady = false;
    this._permissionGranted = false;
    this._cameraInitDone = false;
    this._cameraInitRetried = false;
    this._previewLayout = null;
    this._hoopROI = null;
    this._trackingROI = null;
    this._hoopDrag = null;
    this._cameraInitTimeout = null;
    this._cameraCtx = null;
    this._frameListener = null;
    this._lastFrameProcessAt = 0;
    this._lastBallUiAt = 0;
    this._lastTrailUiAt = 0;
    this._frameProcessIntervalMs = sys.platform === 'ios'
      ? FRAME_INTERVAL_IOS_MS
      : FRAME_INTERVAL_ANDROID_MS;
    this._pendingDebugExport = null;
    this._mlPaused = true;
    this._inferScheduled = false;
    this._latestFrameRef = null;
    this._isSimulationMode = sys.platform === 'devtools';
    this._dlog('BOOT', 'frameInterval=' + this._frameProcessIntervalMs + 'ms platform=' + sys.platform);
    this._initShotTracker();

    this._dlog('BOOT', 'platform=' + sys.platform + ' model=' + (sys.model || '?'));
    this._dlog('BOOT', 'sdk=' + (sys.SDKVersion || '?') + ' wechat=' + (sys.version || '?'));
    if (this._isSimulationMode) {
      this._dlog('BOOT', 'simulation mode (devtools)');
      this._checkCameraPermission();
      return;
    }

    this._loadBallModel();
  },

  /**
   * 初始化 avishah 投篮计分追踪器。
   * @returns {void}
   */
  _initShotTracker: function () {
    var self = this;
    this._shotTracker = avishahTrackerMod.createAvishahShotTracker({
      onLog: function (tag, msg) {
        self._dlog(tag, msg);
      }
    });
  },

  /**
   * 初始化 YOLO 篮球检测器。
   * @returns {void}
   */
  _initBallDetector: function () {
    var self = this;
    // 保留 opts 对象引用：NPU 自检回退时可直接改写 session 字段，detector 内部按引用读取，无需重建 detector
    this._detectorOpts = {
      session: this._inferSession,
      mapFrameToViewport: function (fx, fy, fw, fh) {
        return self._mapFrameToViewport(fx, fy, fw, fh);
      },
      shouldAbort: function () {
        return !!self._mlPaused;
      },
      onLog: function (tag, msg) {
        self._dlog(tag, msg);
      }
    };
    this._ballDetector = ballDetectorMod.createBallDetector(this._detectorOpts);
  },

  /**
   * 按需下载并加载 ONNX 。
   * @returns {void}
   */
  _loadBallModel: function () {
    var self = this;
    this.setData({
      status: 'modelLoading',
      modelProgress: 0,
      modelProgressText: '准备下载相机插件…',
      errorMessage: ''
    });
    this._dlog('ML', 'load start url=' + ballModelConfig.MODEL_DOWNLOAD_URL);

    ballModelLoader.loadModel(function (loaded, total) {
      if (self._unloaded) return;
      var pct = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
      var mb = total > 0 ? (total / 1024 / 1024).toFixed(1) : '?';
      self.setData({
        modelProgress: pct,
        modelProgressText: '下载相机插件 ' + pct + '%（约 ' + mb + ' MB）'
      });
    }, {
      onStatus: function (text) {
        if (self._unloaded) return;
        self.setData({ modelProgressText: text });
      }
    }).then(function (result) {
      if (self._unloaded) return;
      self._inferSession = result.session;
      self._inferMeta = result.inferenceMeta || null;
      self._modelPath = result.modelPath;
      self._modelLoaded = true;
      self._initBallDetector();
      self._dlog('ML', 'session ready path=' + result.modelPath +
        ' npu=' + (self._inferMeta ? self._inferMeta.allowNpu : '?') +
        ' prec=' + (self._inferMeta ? self._inferMeta.precisionLevel : '?'));
      self.setData({
        modelProgress: 100,
        modelProgressText: '模型加载完成',
        modelLoaded: true,
        status: 'loading'
      });
      self._checkCameraPermission();
    }).catch(function (err) {
      if (self._unloaded) return;
      var msg = err && err.message ? err.message : String(err);
      var friendly = msg;
      if (ballModelLoader.isStorageLimitError(msg) || msg.indexOf('STORAGE_FULL:') === 0) {
        friendly = '手机本地存储已满（小程序约 200MB 上限）。\n\n' +
          '请先返回首页：删除旧高光片段，或使用「下载至相册并清空」。\n\n' +
          '清理后回到本页，点「重新下载相机插件」。';
      }
      self._dlog('ML', 'load fail: ' + msg);
      self.setData({
        status: 'error',
        modelLoaded: false,
        errorMessage: friendly
      });
    });
  },

  /**
   * @returns {void}
   */
  onReady: function () {
    this._pageReady = true;
    this._dlog('LIFE', 'onReady');
    this._measureLayout(null);
    this._tryMountCamera();
  },

  /**
   * @returns {void}
   */
  onShow: function () {
    wx.setKeepScreenOn({ keepScreenOn: true });
    this._dlog('LIFE', 'onShow status=' + this.data.status);
    if (this._isSimulationMode || this._unloaded) return;
    if (!this._permissionGranted) return;
    if (this.data.status === 'permissionDenied' || this.data.status === 'error') return;

    if (!this.data.cameraReady) {
      this._tryMountCamera();
      return;
    }
    if (this._cameraInitDone && !this._frameListener) {
      this._startFrameListener();
    }
  },

  /**
   * @returns {void}
   */
  onHide: function () {
    wx.setKeepScreenOn({ keepScreenOn: false });
    this._dlog('LIFE', 'onHide');
    this._pauseMl('hide');
    this._stopDebugHudTimer();
    this._clearCameraInitTimeout();
  },

  /**
   * @returns {void}
   */
  onUnload: function () {
    this._unloaded = true;
    this._dlog('LIFE', 'onUnload');
    wx.setKeepScreenOn({ keepScreenOn: false });
    this._stopFrameListener();
    this._clearAllTimers();
    this.setData({ cameraReady: false });
    this._cameraCtx = null;
    ballModelLoader.destroySession(this._inferSession);
    this._inferSession = null;
    this._inferMeta = null;
    this._ballDetector = null;
    this._modelLoaded = false;
    if (this._shotTracker) this._shotTracker.reset();
  },

  // ==================== 诊断日志（后台缓冲，不遮挡画面） ====================

  /**
   * 写日志到内存缓冲（不刷新 UI）。
   * @param {string} tag
   * @param {string} msg
   * @returns {void}
   */
  _dlog: function (tag, msg) {
    stDebug.log(tag, msg);
  },

  /**
   * 刷新屏上诊断 HUD（不依赖导出/剪贴板）。
   * @returns {void}
   */
  _refreshDebugHud: function () {
    if (this._mlPaused) {
      this.setData({ mlDebugText: '⏸ 检测已暂停（点下方恢复）' });
      return;
    }
    var ml = this._ballDetector ? this._ballDetector.getStats() : null;
    var top = ml && typeof ml.lastTopScore === 'number' ? ml.lastTopScore : 0;
    var infer = ml ? ml.inferCount : 0;
    var hit = ml ? ml.hitCount : 0;
    var ms = ml ? ml.lastInferMs : 0;
    var tail = stDebug.getTailLines(3).join(' | ');
    if (tail.length > 180) tail = tail.slice(-180);
    this.setData({
      mlDebugText: '帧' + this._frameRxCount + '/' + this._frameProcCount +
        ' ML' + hit + '/' + infer + ' top=' + top.toFixed(2) + ' ms=' + ms,
      debugTail: tail || '暂无日志'
    });
  },

  /**
   * 启动屏上诊断定时刷新。
   * @returns {void}
   */
  _startDebugHudTimer: function () {
    var self = this;
    this._stopDebugHudTimer();
    this._refreshDebugHud();
    this._debugHudTimer = setInterval(function () {
      if (self._unloaded) return;
      if (self._mlPaused) {
        self._refreshDebugHud();
      }
    }, 2500);
  },

  /**
   * @returns {void}
   */
  _stopDebugHudTimer: function () {
    if (this._debugHudTimer) {
      clearInterval(this._debugHudTimer);
      this._debugHudTimer = null;
    }
  },

  /**
   * 生成紧凑诊断文本（点击手势内同步复制，避免 iOS 异步失效）。
   * @returns {string}
   */
  _buildCompactDebugText: function () {
    var snap = this._buildDebugSnapshot();
    var lines = [
      '=== shooting-training ===',
      'time: ' + snap.time,
      'platform: ' + snap.platform + ' model: ' + snap.model,
      'status: ' + snap.status + ' camera: ' + snap.cameraReady + ' mlPaused: ' + !!this._mlPaused,
      'frames rx/proc: ' + snap.frameRx + '/' + snap.frameProc + ' ballDetect: ' + snap.ballDetect,
      'lastFrame: ' + snap.lastFrame + ' view: ' + snap.viewW + 'x' + snap.viewH,
      'ml: ' + JSON.stringify(snap.ml || {}),
      'tracker: ' + JSON.stringify(snap.tracker || {}),
      '--- logs ---',
      stDebug.dump()
    ];
    var body = lines.join('\n');
    if (body.length > 120000) body = body.slice(0, 120000) + '\n...(truncated)';
    return body;
  },

  /**
   * 暂停 ML 帧推理（停止 listener，释放主线程给导出/设置）。
   * @param {string} [reason]
   * @returns {void}
   */
  /**
   * 同步中断 ML：首行设置标志并停帧，不等待推理结束（推理结果会被丢弃）。
   * @param {string} [reason]
   * @returns {void}
   */
  _haltMlImmediately: function (reason) {
    this._mlPaused = true;
    this._inferBusy = false;
    this._inferScheduled = false;
    this._latestFrameRef = null;
    this._stopFrameListener();
    this._dlog('ML', 'halted' + (reason ? ' reason=' + reason : ''));
    this.setData({
      mlPaused: true,
      mlDebugText: '⏸ 检测已暂停',
      ballX: null,
      ballY: null,
      ballPeek: false,
      trailPoints: []
    });
  },

  /**
   * @param {string} [reason]
   * @returns {void}
   */
  _pauseMl: function (reason) {
    this._haltMlImmediately(reason);
  },

  /**
   * 恢复 ML 帧推理。
   * @returns {void}
   */
  _resumeMl: function () {
    if (!this._mlPaused || this._unloaded) return;
    this._mlPaused = false;
    this._dlog('ML', 'resumed');
    this.setData({ mlPaused: false });
    this._refreshDebugHud();
    if (this.data.status === 'ready' || this.data.status === 'training') {
      this._startFrameListener();
    }
  },

  /**
   * 切换暂停/恢复 AI 检测。
   * @returns {void}
   */
  onTapToggleMlPause: function () {
    if (!this._mlPaused) {
      this._haltMlImmediately('user');
      wx.showToast({ title: '已暂停', icon: 'none', duration: 1500 });
      return;
    }
    this._resumeMl();
    wx.showToast({ title: '已开始检测', icon: 'none', duration: 1500 });
  },

  /**
   * 顶部紧急停止（最高优先级，首行即中断推理）。
   * @returns {void}
   */
  onTapEmergencyStop: function () {
    this._haltMlImmediately('emergency');
    wx.showToast({ title: 'AI 已立即停止', icon: 'none', duration: 1500 });
  },

  /**
   * 导出前准备：暂停检测并丢弃进行中的推理结果。
   * @returns {void}
   */
  _prepareForExport: function () {
    this._pauseMl('export');
  },

  /**
   * 同步写文件并尝试微信转发（须在 tap 回调内立即调用，不能 setTimeout）。
   * @returns {void}
   */
  onTapShareDebugLog: function () {
    this._haltMlImmediately('export');
    this._dlog('EXPORT', 'tap share-debug');

    var body = this._buildCompactDebugText();
    var self = this;
    wx.setClipboardData({
      data: body,
      success: function () {
        wx.showToast({ title: '日志已复制', icon: 'success', duration: 2500 });
      },
      fail: function () {
        wx.showToast({ title: '复制失败', icon: 'none', duration: 2000 });
      }
    });

    try {
      var fileResult = stExport.exportDebugToFile(
        this._buildDebugSnapshot(),
        stDebug.getLines()
      );
      if (fileResult.ok && fileResult.path && typeof wx.shareFileMessage === 'function') {
        wx.shareFileMessage({
          filePath: fileResult.path,
          fileName: fileResult.fileName,
          success: function () {
            wx.showToast({ title: '请选择好友发送', icon: 'none', duration: 2500 });
          },
          fail: function (err) {
            var msg = (err && err.errMsg) ? err.errMsg : 'share_fail';
            self._dlog('EXPORT', 'share fail: ' + msg);
          }
        });
      }
    } catch (eFile) {
      this._dlog('EXPORT', 'file err: ' + String(eFile));
    }
  },

  /**
   * 点击「复制日志」。
   * @returns {void}
   */
  onTapCopyDebugLog: function () {
    this._haltMlImmediately('export');
    this._dlog('EXPORT', 'tap copy-debug');
    this._copyDebugWithToast('已复制，请粘贴发送');
  },

  /**
   * 复制诊断文本并用 Toast 提示（iOS 上 Modal 可能被相机层挡住）。
   * @param {string} toastTitle
   * @returns {void}
   */
  _copyDebugWithToast: function (toastTitle) {
    var body = this._buildCompactDebugText();
    var self = this;
    wx.setClipboardData({
      data: body,
      success: function () {
        wx.showToast({
          title: toastTitle || '已复制',
          icon: 'none',
          duration: 3000
        });
      },
      fail: function (err) {
        var hint = (err && err.errMsg) ? err.errMsg : 'unknown';
        self._dlog('EXPORT', 'clipboard fail: ' + hint);
        wx.showToast({ title: '复制失败，请截屏底部诊断条', icon: 'none', duration: 3000 });
      }
    });
  },

  /**
   * 创建相机上下文（分包页须传 this）。
   * @returns {WechatMiniprogram.CameraContext|null}
   */
  _createCameraContext: function () {
    if (this._cameraCtx) return this._cameraCtx;
    try {
      this._cameraCtx = wx.createCameraContext(this);
      this._dlog('CAM', 'createCameraContext(this) ok');
    } catch (e1) {
      this._dlog('CAM', 'createCameraContext(this) fail: ' + String(e1));
      try {
        this._cameraCtx = wx.createCameraContext();
        this._dlog('CAM', 'createCameraContext() fallback ok');
      } catch (e2) {
        this._dlog('CAM', 'createCameraContext() fail: ' + String(e2));
        this._cameraCtx = null;
      }
    }
    return this._cameraCtx;
  },

  /**
   * 构造当前运行快照（导出/分享用）。
   * @returns {Record<string, unknown>}
   */
  _buildDebugSnapshot: function () {
    var sys = {};
    try { sys = wx.getSystemInfoSync(); } catch (e) {}
    var layout = this._previewLayout || {};
    return {
      time: new Date().toISOString(),
      status: this.data.status,
      cameraReady: this.data.cameraReady,
      cameraInitDone: this._cameraInitDone,
      permissionGranted: this._permissionGranted,
      pageReady: this._pageReady,
      frameRx: this._frameRxCount,
      frameProc: this._frameProcCount,
      ballDetect: this._ballDetectCount,
      lastFrame: this._lastFrameSize,
      modelLoaded: this._modelLoaded,
      modelVersion: ballModelConfig.MODEL_VERSION,
      inference: this._inferMeta,
      npuTrial: { done: this._npuTrialDone, samples: this._npuSampleCount, abnormal: this._npuAbnormalCount },
      ml: this._ballDetector ? this._ballDetector.getStats() : null,
      mlPaused: !!this._mlPaused,
      inferBusy: !!this._inferBusy,
      fsm: this._shotTracker ? this._shotTracker.getStats().state : '-',
      tracker: this._shotTracker ? this._shotTracker.getStats() : null,
      viewW: layout.width || 0,
      viewH: layout.height || 0,
      hoopROI: this._hoopROI,
      trackingROI: this._trackingROI,
      platform: sys.platform || '-',
      model: sys.model || '-',
      sdk: sys.SDKVersion || '-',
      wechat: sys.version || '-'
    };
  },

  /**
   * 生成诊断 JSON 文件。
   * @returns {{ ok: boolean, path?: string, fileName?: string, size?: number, error?: string }}
   */
  _prepareDebugExportFile: function () {
    return stExport.exportDebugToFile(this._buildDebugSnapshot(), stDebug.getLines());
  },

  /**
   * 在 tap 手势内分享诊断文件（对齐 Live「发送审计」）。
   * @param {{ path: string, fileName: string }} pending
   * @returns {void}
   */
  _shareDebugFileNow: function (pending) {
    if (!pending || !pending.path) return;
    var self = this;
    var showFallback = function (hint) {
      wx.showModal({
        title: '日志文件已生成',
        content: [pending.fileName, hint || '', '也可点「复制日志」粘贴文字'].filter(Boolean).join('\n'),
        showCancel: false
      });
    };
    if (typeof wx.shareFileMessage !== 'function') {
      if (typeof wx.saveFileToDisk === 'function') {
        wx.saveFileToDisk({
          filePath: pending.path,
          success: function () {
            wx.showToast({ title: '已保存到手机', icon: 'success' });
          },
          fail: function () { showFallback('当前环境不支持分享'); }
        });
        return;
      }
      showFallback('当前环境不支持分享');
      return;
    }
    wx.shareFileMessage({
      filePath: pending.path,
      fileName: pending.fileName,
      success: function () {
        wx.showToast({ title: '请选择好友发送', icon: 'none' });
        self._pendingDebugExport = null;
      },
      fail: function () {
        if (typeof wx.saveFileToDisk === 'function') {
          wx.saveFileToDisk({
            filePath: pending.path,
            success: function () {
              wx.showToast({ title: '已保存到手机', icon: 'success' });
            },
            fail: function () { showFallback('分享失败，请复制日志'); }
          });
          return;
        }
        showFallback('分享失败，请复制日志');
      }
    });
  },


  // ==================== 权限 ====================

  /**
   * @returns {void}
   */
  _checkCameraPermission: function () {
    var self = this;
    this._dlog('PERM', 'checking scope.camera');
    wx.getSetting({
      success: function (res) {
        if (res.authSetting['scope.camera']) {
          self._dlog('PERM', 'already granted');
          self._onPermissionGranted();
        } else {
          wx.authorize({
            scope: 'scope.camera',
            success: function () {
              self._dlog('PERM', 'authorize ok');
              self._onPermissionGranted();
            },
            fail: function () {
              self._dlog('PERM', 'authorize denied');
              self.setData({ status: 'permissionDenied' });
            }
          });
        }
      },
      fail: function (err) {
        self._dlog('PERM', 'getSetting fail: ' + JSON.stringify(err));
        self.setData({ status: 'permissionDenied' });
      }
    });
  },

  /**
   * @returns {void}
   */
  openSetting: function () {
    var self = this;
    wx.openSetting({
      success: function (res) {
        if (res.authSetting['scope.camera']) {
          self.setData({ status: 'loading' });
          self._onPermissionGranted();
        }
      }
    });
  },

  /**
   * 相机权限就绪后尝试挂载相机（须等 onReady）。
   * @returns {void}
   */
  _onPermissionGranted: function () {
    this._permissionGranted = true;
    this._dlog('PERM', 'granted, pageReady=' + this._pageReady);

    if (this._isSimulationMode) {
      var self = this;
      this._measureLayout(function () {
        self.setData({ status: 'ready' });
        self._dlog('BOOT', 'simulation ready');
        wx.showToast({ title: '模拟模式：触控滑动测试', icon: 'none', duration: 2000 });
      });
      return;
    }

    this._tryMountCamera();
  },

  /**
   * onReady + 权限双就绪后挂载 <camera>。
   * @returns {void}
   */
  _tryMountCamera: function () {
    if (!this._permissionGranted || this._isSimulationMode || this._unloaded) {
      this._dlog('CAM', 'skip mount: perm=' + this._permissionGranted + ' sim=' + this._isSimulationMode);
      return;
    }
    if (!this._pageReady) {
      this._dlog('CAM', 'skip mount: page not ready');
      return;
    }
    if (this.data.cameraReady && this._cameraInitDone) return;

    if (!this.data.cameraReady) {
      this._cameraInitDone = false;
      this._cameraInitRetried = false;
      this._dlog('CAM', 'mount camera component');
      this.setData({ cameraReady: true, status: 'loading' });
      this._armCameraInitTimeout();
    }
  },

  /**
   * 卸载并延迟 remount 相机（init 超时或异常恢复）。
   * @param {Function} [done]
   * @returns {void}
   */
  _remountCamera: function (done) {
    var self = this;
    this._dlog('CAM', 'remount scheduled');
    this._stopFrameListener();
    this._cameraCtx = null;
    this._cameraInitDone = false;
    this.setData({ cameraReady: false }, function () {
      setTimeout(function () {
        if (self._unloaded) return;
        self.setData({ cameraReady: true, status: 'loading' }, function () {
          self._dlog('CAM', 'remount camera component');
          self._armCameraInitTimeout();
          if (typeof done === 'function') done();
        });
      }, CAMERA_REMOUNT_DELAY_MS);
    });
  },

  /**
   * 启动 bindinitdone 看门狗：超时 remount 一次，仍失败则强制进入 ready。
   * @returns {void}
   */
  _armCameraInitTimeout: function () {
    var self = this;
    this._clearCameraInitTimeout();
    this._cameraInitTimeout = setTimeout(function () {
      self._cameraInitTimeout = null;
      if (self._cameraInitDone || self._unloaded) return;
      self._dlog('CAM', 'init timeout, retried=' + self._cameraInitRetried);
      if (!self._cameraInitRetried) {
        self._cameraInitRetried = true;
        self._remountCamera();
        return;
      }
      self._enterReadyState('相机初始化较慢，预览已开启');
    }, CAMERA_INIT_TIMEOUT_MS);
  },

  /**
   * @returns {void}
   */
  _clearCameraInitTimeout: function () {
    if (this._cameraInitTimeout) {
      clearTimeout(this._cameraInitTimeout);
      this._cameraInitTimeout = null;
    }
  },

  /**
   * 进入 ready 并启动帧监听。
   * @param {string} [toastMsg]
   * @returns {void}
   */
  _enterReadyState: function (toastMsg) {
    var self = this;
    this._clearCameraInitTimeout();
    this._dlog('CAM', 'enter ready initDone=' + this._cameraInitDone);
    this._measureLayout(function () {
      self.setData({ status: 'ready', mlPaused: true });
      self._mlPaused = true;
      self._startDebugHudTimer();
      self._refreshDebugHud();
      wx.showToast({
        title: '请先点下方「开始检测」',
        icon: 'none',
        duration: 3500
      });
      if (toastMsg) {
        setTimeout(function () {
          wx.showToast({ title: toastMsg, icon: 'none', duration: 2500 });
        }, 500);
      }
    });
  },

  /**
   * @param {Function} [callback]
   * @returns {void}
   */
  _measureLayout: function (callback) {
    var self = this;
    setTimeout(function () {
      var query = wx.createSelectorQuery();
      query.select('.container').boundingClientRect(function (rect) {
        if (!rect || rect.width === 0) {
          setTimeout(function () { self._measureLayout(callback); }, 200);
          return;
        }
        self._previewLayout = { width: rect.width, height: rect.height };
        self._dlog('LAYOUT', 'container ' + Math.round(rect.width) + 'x' + Math.round(rect.height));

        self.setData({
          hoopStyle: self._defaultHoopStyle(self._previewLayout)
        }, function () {
          self._recalculateHoopROI();
          if (callback) callback();
        });
      }).exec();
    }, 100);
  },

  /**
   * 校准框默认位置/尺寸（居中偏下，宽度为屏宽的固定比例）。
   * @param {{width:number,height:number}} layout
   * @returns {{left:number,top:number,width:number,height:number}}
   */
  _defaultHoopStyle: function (layout) {
    var hoopW = Math.round(layout.width * DEFAULT_HOOP_WIDTH_RATIO);
    var hoopH = Math.round(hoopW * DEFAULT_HOOP_ASPECT);
    var hoopLeft = Math.round((layout.width - hoopW) / 2);
    var hoopTop = Math.round(layout.height * 0.45);
    return { left: hoopLeft, top: hoopTop, width: hoopW, height: hoopH };
  },

  /**
   * @returns {void}
   */
  _recalculateHoopROI: function () {
    var s = this.data.hoopStyle;
    this._hoopROI = {
      left: s.left,
      top: s.top,
      right: s.left + s.width,
      bottom: s.top + s.height,
      width: s.width,
      height: s.height,
      centerX: s.left + s.width / 2,
      centerY: s.top + s.height / 2
    };
    var layout = this._previewLayout || { width: 375, height: 667 };
    this._trackingROI = {
      left: Math.max(0, this._hoopROI.centerX - s.width * 0.95),
      right: Math.min(layout.width, this._hoopROI.centerX + s.width * 0.95),
      top: Math.max(0, this._hoopROI.top - s.height * 2.4),
      bottom: Math.min(layout.height, this._hoopROI.bottom + s.height * 0.55)
    };
    console.log('[ShootingTraining] HoopROI:', JSON.stringify(this._hoopROI));
    this._dlog('ROI', 'hoop ' + s.width + 'x' + s.height + ' @' + s.left + ',' + s.top);
  },

  // ==================== Camera 回调 ====================

  /**
   * @returns {void}
   */
  onCameraInit: function (e) {
    var detail = (e && e.detail) ? JSON.stringify(e.detail) : '{}';
    this._dlog('CAM', 'bindinitdone ' + detail);
    this._cameraInitDone = true;
    this._clearCameraInitTimeout();
    this._createCameraContext();
    this._enterReadyState();
  },

  /**
   * @param {WechatMiniprogram.CameraError} e
   * @returns {void}
   */
  onCameraError: function (e) {
    var msg = (e.detail && (e.detail.errMsg || e.detail.message)) || 'unknown';
    this._dlog('CAM', 'error: ' + msg);
    this._clearCameraInitTimeout();
    this._stopFrameListener();
    this.setData({
      status: 'error',
      errorMessage: '相机启动失败: ' + msg,
      cameraReady: false
    });
  },

  /**
   * @returns {void}
   */
  onCameraStop: function (e) {
    var msg = (e && e.detail) ? JSON.stringify(e.detail) : '';
    this._dlog('CAM', 'stopped ' + msg);
    this._cameraInitDone = false;
    this._stopFrameListener();
  },

  /**
   * @returns {void}
   */
  onRetryCameraTap: function () {
    if (this._isSimulationMode) return;
    this._dlog('CAM', 'user retry');
    if (!this._modelLoaded) {
      this._loadBallModel();
      return;
    }
    this._cameraInitRetried = false;
    this._frameRxCount = 0;
    this._frameProcCount = 0;
    this._ballDetectCount = 0;
    if (this._ballDetector) this._ballDetector.resetStats();
    this.setData({ status: 'loading', errorMessage: '' });
    this._remountCamera();
  },

  /**
   * 重新下载 相机插件 模型（清除缓存）。
   * @returns {void}
   */
  onRetryModelTap: function () {
    var self = this;
    this._dlog('ML', 'user retry model');
    this._stopFrameListener();
    ballModelLoader.destroySession(this._inferSession);
    this._inferSession = null;
    this._inferMeta = null;
    this._ballDetector = null;
    this._modelLoaded = false;
    this.setData({
      status: 'modelLoading',
      modelProgress: 0,
      modelProgressText: '正在清理缓存…',
      errorMessage: ''
    });
    ballModelLoader.clearCachedModel()
      .then(function () { return ballModelLoader.prepareStorageForModel(); })
      .then(function () {
        self._loadBallModel();
      })
      .catch(function () {
        self._loadBallModel();
      });
  },

  // ==================== 帧监听（真机） ====================

  /**
   * 启动 onCameraFrame 监听。
   * @returns {void}
   */
  _startFrameListener: function () {
    if (this._frameListener || this._isSimulationMode || this._unloaded) return;
    var ctx = this._createCameraContext();
    if (!ctx || typeof ctx.onCameraFrame !== 'function') {
      this._dlog('FRAME', 'onCameraFrame API unavailable');
      return;
    }
    var self = this;
    try {
      this._frameListener = ctx.onCameraFrame(function (frame) {
        self._onCameraFrame(frame);
      });
      this._frameListener.start();
      this._dlog('FRAME', 'listener started');
    } catch (err) {
      this._dlog('FRAME', 'listener start fail: ' + String(err));
    }
  },

  /**
   * @returns {void}
   */
  _stopFrameListener: function () {
    if (this._frameListener) {
      try { this._frameListener.stop(); } catch (e) {}
      this._frameListener = null;
    }
    this._lastFrameProcessAt = 0;
    this._lastBallUiAt = 0;
  },

  /**
   * 用户校准篮筐 ROI → 计分/FSM 用固定筐位（YOLO 筐在日志中常偏移到 rim≈80~150）。
   * @returns {{x:number,y:number,w:number,h:number}|null}
   */
  _getCalibratedHoopForTracker: function () {
    if (!this._hoopROI) return null;
    var r = this._hoopROI;
    return {
      x: r.centerX,
      y: r.centerY,
      w: r.width,
      h: r.height
    };
  },

  /**
   * 为追踪器附加校准篮筐。
   * @param {{ball:Object|null,ballTrack:Object|null,hoop:Object|null}|null} det
   * @returns {Object}
   */
  _enrichDetForTracker: function (det) {
    var payload = det ? Object.assign({}, det) : {};
    payload.calibratedHoop = this._getCalibratedHoopForTracker();
    return payload;
  },

  /**
   * 复制相机帧（buffer 可能被相机组件复用，必须真正拷贝字节而非只建视图）。
   * @param {{data: ArrayBuffer, width: number, height: number}} frame
   * @returns {{data: ArrayBuffer, width: number, height: number}}
   */
  _copyCameraFrame: function (frame) {
    var src = new Uint8Array(frame.data);
    var copy = new Uint8Array(src.length);
    copy.set(src);
    return {
      data: copy.buffer,
      width: frame.width,
      height: frame.height
    };
  },

  /**
   * 仅保留相机帧引用；拷贝推迟到真正推理时（避免 30fps 全量 memcpy 卡死 UI）。
   * @param {{data: ArrayBuffer, width: number, height: number}} frame
   * @returns {void}
   */
  _stashLatestFrame: function (frame) {
    this._latestFrameRef = frame;
  },

  /**
   * 推理裁剪区：以篮筐为中心（比 trackingROI 更紧，球在 640 输入里更大）。
   * @returns {{left:number,top:number,right:number,bottom:number}|null}
   */
  _getInferCropRect: function () {
    if (!this._hoopROI) return this._trackingROI;
    var h = this._hoopROI;
    var s = this.data.hoopStyle || { width: h.width, height: h.height };
    var layout = this._previewLayout || { width: 402, height: 874 };
    return {
      left: Math.max(0, h.centerX - s.width * 1.5),
      right: Math.min(layout.width, h.centerX + s.width * 1.5),
      top: Math.max(0, h.top - s.height * 2.6),
      bottom: Math.min(layout.height, h.bottom + s.height * 1.0)
    };
  },

  /**
   * 按篮筐 ROI 裁剪相机帧再推理。
   * @param {{data:ArrayBuffer,width:number,height:number}} fullFrame
   * @returns {{frame:Object,cropMeta:Object|null}}
   */
  _prepareInferFrame: function (fullFrame) {
    var cropRect = this._getInferCropRect();
    if (!cropRect || !fullFrame || !fullFrame.data) {
      return { frame: fullFrame, cropMeta: null };
    }
    var bounds = this._viewportRectToFrameBounds(
      cropRect,
      fullFrame.width,
      fullFrame.height
    );
    if (!bounds) {
      return { frame: fullFrame, cropMeta: null };
    }
    var cw = bounds.x1 - bounds.x0 + 1;
    var ch = bounds.y1 - bounds.y0 + 1;
    if (cw < 48 || ch < 48) {
      return { frame: fullFrame, cropMeta: null };
    }
    var rgba = new Uint8Array(fullFrame.data);
    var fw = fullFrame.width;
    var cropped = new Uint8Array(cw * ch * 4);
    var y;
    var srcIdx;
    // 按行整段 set()（底层近似 memcpy），而非逐像素单写：cw*ch 次单写改成 ch 次整行拷贝，
    // 裁剪区常见 170k+ 像素/帧时这一步此前是主线程里最重的同步循环之一。
    var rowBytes = cw * 4;
    for (y = 0; y < ch; y++) {
      srcIdx = ((bounds.y0 + y) * fw + bounds.x0) * 4;
      cropped.set(rgba.subarray(srcIdx, srcIdx + rowBytes), y * rowBytes);
    }
    if (this._frameProcCount === 1) {
      this._dlog('ML', 'roi crop ' + cw + 'x' + ch + ' @' + bounds.x0 + ',' + bounds.y0);
    }
    return {
      frame: { data: cropped.buffer, width: cw, height: ch },
      cropMeta: {
        x0: bounds.x0,
        y0: bounds.y0,
        fullFw: fw,
        fullFh: fullFrame.height
      }
    };
  },

  /**
   * 在间隔与 busy 条件允许时消费最新帧。
   * @returns {void}
   */
  /**
   * NPU 自检：连续采样若干帧推理耗时，若绝大多数"异常快"（历史上是 NPU 委托静默失败、
   * 直接吐空结果的信号），自动重建 Session 回退到 CPU，避免用户手动排查。
   * @returns {void}
   */
  _maybeCheckNpuFallback: function () {
    if (this._npuTrialDone || !this._inferMeta || !this._inferMeta.allowNpu || !this._ballDetector) return;
    var stats = this._ballDetector.getStats();
    var ms = stats ? stats.lastInferMs : null;
    if (typeof ms !== 'number') return;

    this._npuSampleCount += 1;
    if (ms <= ballModelConfig.NPU_ABNORMAL_INFER_MS) this._npuAbnormalCount += 1;

    if (this._npuSampleCount < ballModelConfig.NPU_TRIAL_SAMPLE_FRAMES) return;
    this._npuTrialDone = true;

    var ratio = this._npuAbnormalCount / this._npuSampleCount;
    this._dlog('ML', 'NPU self-check samples=' + this._npuSampleCount +
      ' abnormal=' + this._npuAbnormalCount + ' ratio=' + ratio.toFixed(2));
    if (ratio >= ballModelConfig.NPU_ABNORMAL_RATIO_TRIGGER) {
      this._fallbackNpuToCpu();
    }
  },

  /**
   * 重建推理 Session 为 CPU（allowNPU=false），并原地替换 detector 使用的 session 引用。
   * @returns {void}
   */
  _fallbackNpuToCpu: function () {
    var self = this;
    if (this._npuFallbackInFlight || !this._modelPath) return;
    this._npuFallbackInFlight = true;
    this._dlog('ML', 'NPU abnormal (fast+empty) detected, rebuilding session on CPU');
    ballModelLoader.createSession(this._modelPath, false).then(function (session) {
      if (self._unloaded) {
        ballModelLoader.destroySession(session);
        return;
      }
      var oldSession = self._inferSession;
      self._inferSession = session;
      if (self._detectorOpts) self._detectorOpts.session = session;
      if (self._inferMeta) self._inferMeta.allowNpu = false;
      ballModelLoader.destroySession(oldSession);
      self._dlog('ML', 'NPU fallback done, now running on CPU');
    }).catch(function (err) {
      var msg = err && err.message ? err.message : String(err);
      self._dlog('ML', 'NPU fallback failed: ' + msg + ' (keep using NPU session)');
    }).then(function () {
      self._npuFallbackInFlight = false;
    });
  },

  _drainPendingInfer: function () {
    if (this._mlPaused || this._isSimulationMode || this._unloaded ||
      !this._shotTracker || !this._ballDetector || this._inferBusy || !this._latestFrameRef) {
      return;
    }
    if (this.data.status !== 'ready' && this.data.status !== 'training') return;

    var now = Date.now();
    var frameInterval = this._frameProcessIntervalMs || FRAME_INTERVAL_ANDROID_MS;
    if (this._lastFrameProcessAt && now - this._lastFrameProcessAt < frameInterval) {
      return;
    }

    var tCopyStart = Date.now();
    var frameCopy = this._copyCameraFrame(this._latestFrameRef);
    var inferPack = this._prepareInferFrame(frameCopy);
    var copyPrepMs = Date.now() - tCopyStart;
    var prevProcessAt = this._lastFrameProcessAt;
    this._lastFrameProcessAt = now;
    this._frameProcCount += 1;

    var self = this;
    this._inferBusy = true;
    this._ballDetector.detect(inferPack.frame, inferPack.cropMeta).then(function (det) {
      if (self._unloaded || self._mlPaused) return;
      if (det && det.aborted) return;

      if (det && (det.ball || det.ballTrack)) self._ballDetectCount += 1;
      self._maybeCheckNpuFallback();
      if (self._frameProcCount % 40 === 0) {
        var hitRate = self._frameProcCount
          ? Math.round(self._ballDetectCount * 100 / self._frameProcCount)
          : 0;
        self._dlog('ML', 'proc#' + self._frameProcCount + ' ballRate=' + hitRate + '%');
        // 拆解单帧耗时去向：copyPrepMs（相机帧拷贝+ROI裁剪，均为同步）+ detector 内部
        // prepMs（letterbox 预处理）/ inferMs（session.run）/ totalMs（detector.detect 全程），
        // gapMs 是与上一帧处理起点的实际间隔，用于定位"消失的时间"具体在哪一段。
        var mlStats = self._ballDetector.getStats();
        var gapMs = prevProcessAt ? (now - prevProcessAt) : 0;
        self._dlog('ML', 'timing copyPrepMs=' + copyPrepMs +
          ' letterboxMs=' + (mlStats ? mlStats.lastPrepMs : '?') +
          ' inferMs=' + (mlStats ? mlStats.lastInferMs : '?') +
          ' detectTotalMs=' + (mlStats ? mlStats.lastTotalMs : '?') +
          ' frameGapMs=' + gapMs);
        self._refreshDebugHud();
      }
      var result = self._shotTracker.onFrame(self._enrichDetForTracker(det), Date.now());
      self._applyTrackerResult(result, Date.now(), det && det.ball ? det.ball : null);
    }).catch(function () {
      /* 单帧失败不阻断后续 */
    }).then(function () {
      self._inferBusy = false;
      if (!self._mlPaused && !self._unloaded) {
        self._drainPendingInfer();
      }
    });
  },

  /**
   * @param {{data: ArrayBuffer, width: number, height: number}} frame
   * @returns {void}
   */
  _onCameraFrame: function (frame) {
    if (this._mlPaused || this._isSimulationMode || this._unloaded || !this._shotTracker || !this._ballDetector) {
      return;
    }
    this._frameRxCount += 1;
    if (frame && frame.width && frame.height) {
      this._lastFrameSize = frame.width + 'x' + frame.height;
    }
    if (this._frameRxCount === 1) {
      var orient = (frame && frame.width && frame.height)
        ? (this._isSameOrientation(frame.width, frame.height) ? 'portrait-direct' : 'landscape-rotate')
        : '?';
      this._dlog('FRAME', 'first frame ' + this._lastFrameSize + ' map=' + orient);
    }

    this._stashLatestFrame(frame);
    this._drainPendingInfer();
  },

  /**
   * 应用追踪器输出（UI + 进球判定）。
   * @param {{event:string, ballX:number|null, ballY:number|null, trail:Array, state:string}} result
   * @param {number} now
   * @param {{x:number,y:number}|null} [rawBall] 本帧 ML 原始检出（优先用于红点）
   * @returns {void}
   */
  _applyTrackerResult: function (result, now, rawBall) {
    if (!result) return;

    if (result.event === 'made') {
      this._settleShot(true);
      return;
    }
    if (result.event === 'missed') {
      this._settleShot(false);
      return;
    }

    var uiPatch = {};
    if (result.state && result.state !== this.data.fsmState) {
      uiPatch.fsmState = result.state;
    }
    if (result.trail && result.trail.length > 0) {
      if (!this._lastTrailUiAt || now - this._lastTrailUiAt >= TRAIL_UI_INTERVAL_MS) {
        this._lastTrailUiAt = now;
        uiPatch.trailPoints = result.trail.slice(-6);
      }
    } else if (this.data.trailPoints.length > 0 && !rawBall && !result.ballX) {
      uiPatch.trailPoints = [];
    }

    var ballForUi = rawBall || (
      result.ballX !== null && result.ballY !== null
        ? { x: result.ballX, y: result.ballY }
        : null
    );
    if (ballForUi) {
      var layout = this._previewLayout || { width: 375, height: 667 };
      var bx = Math.max(0, Math.min(layout.width, ballForUi.x));
      var by = Math.max(0, Math.min(layout.height, ballForUi.y));
      if (this.data.status !== 'training') uiPatch.status = 'training';
      if (!this._lastBallUiAt || now - this._lastBallUiAt >= BALL_UI_INTERVAL_MS) {
        this._lastBallUiAt = now;
        uiPatch.ballX = bx;
        uiPatch.ballY = by;
        uiPatch.ballPeek = !!rawBall && !!rawBall.peek;
      }
    } else if (this.data.ballX !== null || this.data.ballY !== null) {
      uiPatch.ballX = null;
      uiPatch.ballY = null;
      uiPatch.ballPeek = false;
      if (this.data.status === 'training' && result.state !== 'RISING' && result.state !== 'FALLING') {
        uiPatch.status = 'ready';
      }
    }
    if (Object.keys(uiPatch).length > 0) this.setData(uiPatch);
  },

  /**
   * 帧与视口是否同向（均为竖屏或均为横屏）。
   * @param {number} frameW
   * @param {number} frameH
   * @returns {boolean}
   */
  _isSameOrientation: function (frameW, frameH) {
    if (!this._previewLayout) return frameH >= frameW;
    var viewW = this._previewLayout.width;
    var viewH = this._previewLayout.height;
    return (frameH >= frameW) === (viewH >= viewW);
  },

  /**
   * 将视口矩形映射为帧内采样边界（cover 模式）。
   * @param {{left: number, top: number, right: number, bottom: number}} rect
   * @param {number} frameW
   * @param {number} frameH
   * @returns {{x0: number, y0: number, x1: number, y1: number, mapMode: string}|null}
   */
  _viewportRectToFrameBounds: function (rect, frameW, frameH) {
    var tl = this._mapViewportToFrame(rect.left, rect.top, frameW, frameH);
    var br = this._mapViewportToFrame(rect.right, rect.bottom, frameW, frameH);
    var x0 = Math.max(0, Math.min(tl.x, br.x));
    var x1 = Math.min(frameW - 1, Math.max(tl.x, br.x));
    var y0 = Math.max(0, Math.min(tl.y, br.y));
    var y1 = Math.min(frameH - 1, Math.max(tl.y, br.y));
    if (x1 <= x0 || y1 <= y0) return null;
    return {
      x0: Math.round(x0),
      y0: Math.round(y0),
      x1: Math.round(x1),
      y1: Math.round(y1),
      mapMode: this._isSameOrientation(frameW, frameH) ? 'portrait-direct' : 'landscape-rotate'
    };
  },

  /**
   * 视口坐标 → 帧坐标（自动识别竖屏直映 / 横帧旋转）。
   * @param {number} vx
   * @param {number} vy
   * @param {number} frameW
   * @param {number} frameH
   * @returns {{x: number, y: number}}
   */
  _mapViewportToFrame: function (vx, vy, frameW, frameH) {
    var viewW = this._previewLayout.width;
    var viewH = this._previewLayout.height;

    if (this._isSameOrientation(frameW, frameH)) {
      var scale = Math.max(viewW / frameW, viewH / frameH);
      var dispW = frameW * scale;
      var dispH = frameH * scale;
      var offX = (viewW - dispW) / 2;
      var offY = (viewH - dispH) / 2;
      return {
        x: Math.max(0, Math.min(frameW - 1, (vx - offX) / scale)),
        y: Math.max(0, Math.min(frameH - 1, (vy - offY) / scale))
      };
    }

    var rotScale = Math.max(viewW / frameH, viewH / frameW);
    var rotDispW = frameH * rotScale;
    var rotDispH = frameW * rotScale;
    var rotOffX = (viewW - rotDispW) / 2;
    var rotOffY = (viewH - rotDispH) / 2;
    var dispX = vx - rotOffX;
    var dispY = vy - rotOffY;
    return {
      x: Math.max(0, Math.min(frameW - 1, dispY / rotScale)),
      y: Math.max(0, Math.min(frameH - 1, (rotDispH - dispX) / rotScale))
    };
  },

  /**
   * 帧坐标 → 视口坐标。
   * @param {number} fx
   * @param {number} fy
   * @param {number} frameW
   * @param {number} frameH
   * @returns {{x: number, y: number}}
   */
  _mapFrameToViewport: function (fx, fy, frameW, frameH) {
    var viewW = this._previewLayout.width;
    var viewH = this._previewLayout.height;

    if (this._isSameOrientation(frameW, frameH)) {
      var scale = Math.max(viewW / frameW, viewH / frameH);
      var dispW = frameW * scale;
      var dispH = frameH * scale;
      var offX = (viewW - dispW) / 2;
      var offY = (viewH - dispH) / 2;
      return {
        x: offX + fx * scale,
        y: offY + fy * scale
      };
    }

    var rotScale = Math.max(viewW / frameH, viewH / frameW);
    var rotDispH = frameW * rotScale;
    var rotDispW = frameH * rotScale;
    var rotOffX = (viewW - rotDispW) / 2;
    var rotOffY = (viewH - rotDispH) / 2;
    return {
      x: rotOffX + (rotDispH - fy * rotScale),
      y: rotOffY + fx * rotScale
    };
  },

  // ==================== 模拟模式（DevTools） ====================

  /**
   * 模拟模式：构造假检测（触控作球，校准框作筐）。
   * @param {number} x
   * @param {number} y
   * @returns {{ball:Object,hoop:Object}}
   */
  _simDetection: function (x, y) {
    var s = this.data.hoopStyle;
    return {
      ball: { x: x, y: y, w: 28, h: 28, confidence: 1 },
      hoop: {
        x: s.left + s.width / 2,
        y: s.top + s.height / 2,
        w: s.width,
        h: s.height,
        confidence: 1
      }
    };
  },

  /**
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onTouchStart: function (e) {
    if (!this._isSimulationMode || !this._shotTracker) return;
    if (this.data.status !== 'ready' && this.data.status !== 'training') return;
    this._shotTracker.reset();
    var touch = e.touches[0];
    this.setData({ ballX: touch.clientX, ballY: touch.clientY, status: 'training' });
  },

  /**
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onTouchMove: function (e) {
    if (!this._isSimulationMode || !this._shotTracker) return;
    if (this.data.status !== 'ready' && this.data.status !== 'training') return;
    var touch = e.touches[0];
    var now = Date.now();
    var result = this._shotTracker.onFrame(
      this._simDetection(touch.clientX, touch.clientY),
      now
    );
    this._applyTrackerResult(result, now);
  },

  /**
   * @returns {void}
   */
  onTouchEnd: function () {
    if (!this._isSimulationMode) return;
    this.setData({ ballX: null, ballY: null, status: 'ready' });
  },

  // ==================== 篮筐校准框：拖拽移动 / 拖角缩放 ====================

  /**
   * 开始拖动校准框（整体移动）。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onHoopBoxTouchStart: function (e) {
    var touch = e.touches[0];
    this._hoopDrag = {
      mode: 'move',
      startX: touch.clientX,
      startY: touch.clientY,
      origin: Object.assign({}, this.data.hoopStyle)
    };
  },

  /**
   * 拖动中：整体平移校准框，限制在预览区域内。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onHoopBoxTouchMove: function (e) {
    var drag = this._hoopDrag;
    if (!drag || drag.mode !== 'move') return;
    var touch = e.touches[0];
    var layout = this._previewLayout || { width: 402, height: 874 };
    var dx = touch.clientX - drag.startX;
    var dy = touch.clientY - drag.startY;
    var left = Math.max(0, Math.min(layout.width - drag.origin.width, drag.origin.left + dx));
    var top = Math.max(0, Math.min(layout.height - drag.origin.height, drag.origin.top + dy));
    this.setData({
      hoopStyle: { left: left, top: top, width: drag.origin.width, height: drag.origin.height }
    });
  },

  /**
   * 拖动结束：落盘校准框对应的 ROI（含推理裁剪区）。
   * @returns {void}
   */
  onHoopBoxTouchEnd: function () {
    if (!this._hoopDrag) return;
    this._hoopDrag = null;
    this._recalculateHoopROI();
  },

  /**
   * 开始拖动某个角的缩放手柄。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onHoopHandleTouchStart: function (e) {
    var touch = e.touches[0];
    this._hoopDrag = {
      mode: 'resize',
      corner: e.currentTarget.dataset.corner,
      startX: touch.clientX,
      startY: touch.clientY,
      origin: Object.assign({}, this.data.hoopStyle)
    };
  },

  /**
   * 拖动中：按拖动的角调整校准框宽高，另一角保持不动，限制最小尺寸与预览边界。
   * @param {WechatMiniprogram.TouchEvent} e
   * @returns {void}
   */
  onHoopHandleTouchMove: function (e) {
    var drag = this._hoopDrag;
    if (!drag || drag.mode !== 'resize') return;
    var touch = e.touches[0];
    var layout = this._previewLayout || { width: 402, height: 874 };
    var dx = touch.clientX - drag.startX;
    var dy = touch.clientY - drag.startY;
    var origin = drag.origin;
    var left = origin.left;
    var top = origin.top;
    var right = origin.left + origin.width;
    var bottom = origin.top + origin.height;

    if (drag.corner === 'tl') {
      left += dx;
      top += dy;
    } else if (drag.corner === 'tr') {
      right += dx;
      top += dy;
    } else if (drag.corner === 'bl') {
      left += dx;
      bottom += dy;
    } else if (drag.corner === 'br') {
      right += dx;
      bottom += dy;
    }

    left = Math.max(0, Math.min(left, right - HOOP_BOX_MIN_SIZE));
    top = Math.max(0, Math.min(top, bottom - HOOP_BOX_MIN_SIZE));
    right = Math.min(layout.width, Math.max(right, left + HOOP_BOX_MIN_SIZE));
    bottom = Math.min(layout.height, Math.max(bottom, top + HOOP_BOX_MIN_SIZE));

    this.setData({
      hoopStyle: { left: left, top: top, width: right - left, height: bottom - top }
    });
  },

  /**
   * 缩放结束：落盘校准框对应的 ROI（含推理裁剪区）。
   * @returns {void}
   */
  onHoopHandleTouchEnd: function () {
    if (!this._hoopDrag) return;
    this._hoopDrag = null;
    this._recalculateHoopROI();
  },

  // ==================== 进球反馈 ====================

  /**
   * 计算命中率展示文案。
   * @param {number} made
   * @param {number} total
   * @returns {string}
   */
  _formatHitRate: function (made, total) {
    if (!total) return '0%';
    return Math.round((made / total) * 100) + '%';
  },

  /**
   * @param {boolean} isMade
   * @returns {void}
   */
  _settleShot: function (isMade) {
    this._dlog('FSM', isMade ? 'MADE' : 'MISSED');
    var madeInc = isMade ? 1 : 0;
    var nextMade = this.data.shotsMade + madeInc;
    var nextTotal = this.data.shotsTotal + 1;
    var nextStreak = isMade ? this.data.streak + 1 : 0;
    this.setData({
      shotsMade: nextMade,
      shotsTotal: nextTotal,
      hitRateText: this._formatHitRate(nextMade, nextTotal),
      streak: nextStreak,
      feedbackState: isMade ? 'made' : 'missed',
      ballX: null,
      ballY: null,
      trailPoints: [],
      status: 'ready'
    });
    try { wx.vibrateShort({ type: isMade ? 'medium' : 'light' }); } catch (e) {}

    var self = this;
    setTimeout(function () {
      self.setData({ feedbackState: '' });
    }, 900);
  },

  /**
   * @returns {void}
   */
  onRecalibrateTap: function () {
    try { wx.vibrateShort({ type: 'light' }); } catch (e) {}
    if (this._shotTracker) this._shotTracker.reset();
    var layout = this._previewLayout || { width: 402, height: 874 };
    this.setData({
      shotsMade: 0,
      shotsTotal: 0,
      hitRateText: '0%',
      streak: 0,
      feedbackState: '',
      ballX: null,
      ballY: null,
      trailPoints: [],
      fsmState: 'IDLE',
      status: 'ready',
      hoopStyle: this._defaultHoopStyle(layout)
    });
    this._recalculateHoopROI();
  },

  // ==================== 清理 ====================

  /**
   * @returns {void}
   */
  _clearAllTimers: function () {
    this._clearCameraInitTimeout();
    this._stopDebugHudTimer();
  },

  /**
   * @returns {void}
   */
  onBackTap: function () {
    this._haltMlImmediately('back');
    wx.navigateBack();
  }
});
