/**
 * @fileoverview 高光素材机实验页面逻辑控制器。
 */

const recSync = require('../../../services/rec-sync-ws-client.js');
const { createNativeRollingRecorder } = require('../../utils/native-rolling-recorder/index.js');

Page({
  data: {
    statusBarHeight: 0,
    zoom: 1.0,
    zoomDisplay: '1.0',
    cameraReady: false,
    wsConnected: false,
    isRecording: false,
    roomId: '',
    bufferCoverageText: '0s / 45s',
    trackAActive: false,
    trackBActive: false,
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

  _recorder: null,
  _wsClient: null,
  _touchDistance: 0,
  _startZoom: 1.0,
  _unloaded: false,

  onLoad: function (options) {
    this._unloaded = false;
    var sys = wx.getSystemInfoSync();
    this.setData({
      statusBarHeight: sys.statusBarHeight || 20,
      roomId: wx.getStorageSync('rec_sync_room_id') || ''
    });

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

    // 默认以 60s 档位启动 (单段录像 28秒)
    this._staggerMs = 10000;
    this._actualSegmentMs = 28000;
    this.setData({
      segmentMs: 60000
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

    // 自动回连 WebSocket
    if (this.data.roomId.length === 6) {
      this.connectWs();
    }
  },

  onHide: function () {
    this.disconnectWs();
    this.stopRecorder();
  },

  onUnload: function () {
    this._unloaded = true;
    this.disconnectWs();
    this.stopRecorder();
  },

  /* =========================================================================
   * 相机生命周期与录制控制
   * ========================================================================= */

  onCameraInit: function () {
    console.log('[HighlightRec] Camera mounted successfully');
    this.startRecorder();
  },

  onCameraError: function (e) {
    console.error('[HighlightRec] Camera failed to init:', e);
    wx.showToast({
      title: '相机启动失败',
      icon: 'none'
    });
  },

  startRecorder: function () {
    if (this._recorder && this._recorder.isActive()) return;

    var cameraCtx = wx.createCameraContext();
    var self = this;

    this._recorder = createNativeRollingRecorder(cameraCtx, {
      segmentMs: this._actualSegmentMs,
      onTrackActive: function (trackId) {
        self.setData({
          trackAActive: trackId === 'A',
          trackBActive: trackId === 'B'
        });
      },
      onSegmentComplete: function (seg) {
        self.updateBufferStatus();
        self.checkDiskSpace();
      },
      onError: function (err) {
        wx.showToast({
          title: '相机录制出错: ' + (err.errMsg || '未知错误'),
          icon: 'none'
        });
      }
    });

    try {
      this._recorder.start();
      this.setData({
        isRecording: true
      });
      this.updateBufferStatus();
    } catch (e) {
      console.error('[HighlightRec] Failed to start recorder:', e);
    }
  },

  stopRecorder: function () {
    if (this._recorder) {
      try {
        this._recorder.stop();
      } catch (e) {}
      this._recorder = null;
    }
    this.setData({
      isRecording: false,
      trackAActive: false,
      trackBActive: false,
      bufferCoverageText: '0s / 45s'
    });
  },

  updateBufferStatus: function () {
    if (!this._recorder) return;
    var segs = this._recorder.getSegments();
    var totalSec = 0;
    
    // 估算当前环内段的总覆盖时长
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.stop > s.start) {
        totalSec += Math.round((s.stop - s.start) / 1000);
      }
    }

    // 累加当前活动段的时间
    var curr = this._recorder.getCurrentSegment();
    if (curr && curr.start > 0) {
      totalSec += Math.round((Date.now() - curr.start) / 1000);
    }

    var targetMax = this.data.segmentMs === 45000 ? 45 : (this.data.segmentMs === 60000 ? 60 : 90);
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
    var segment = Number(dataset.segment); // 45, 60, 90
    var stagger = Number(dataset.stagger); // 8, 10, 12

    this._staggerMs = stagger * 1000;
    // 微信 startRecord 硬件最长为 30 秒限制，单分段不得大于 28 秒以留足缓冲余地
    this._actualSegmentMs = segment === 45 ? 24000 : 28000;

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

  /* =========================================================================
   * 变焦缩放与触摸手势
   * ========================================================================= */

  onZoomSliderChange: function (e) {
    var val = Number(e.detail.value);
    this.updateZoom(val);
  },

  onQuickZoomStopTap: function (e) {
    var idx = Number(e.currentTarget.dataset.index);
    var stops = this.data.zoomStops;
    if (stops && stops[idx]) {
      this.updateZoom(stops[idx].zoom);
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
      
      // 触发触觉反馈
      if (typeof wx.vibrateShort === 'function') {
        wx.vibrateShort({ type: 'medium' });
      }

      wx.showToast({
        title: '已保存 ' + currentZoom.toFixed(1) + 'x 至“' + stops[idx].label + '”',
        icon: 'success'
      });
    }
  },

  updateZoom: function (zoomVal) {
    var rounded = Math.round(zoomVal * 10) / 10;
    var finalZoom = Math.min(5.0, Math.max(1.0, rounded));

    this.setData({
      zoom: finalZoom,
      zoomDisplay: finalZoom.toFixed(1)
    });

    var cameraCtx = wx.createCameraContext();
    if (cameraCtx && typeof cameraCtx.setZoom === 'function') {
      cameraCtx.setZoom({
        zoom: finalZoom,
        success: function () {
          console.log('[HighlightRec] Camera zoom set to:', finalZoom);
        },
        fail: function (err) {
          console.warn('[HighlightRec] Camera setZoom failed:', err);
        }
      });
    }
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
    if (!this._recorder || !this._recorder.isActive()) {
      wx.showToast({
        title: '录制未就绪',
        icon: 'none'
      });
      return;
    }

    var self = this;
    // 增加后台保存任务计数 (取代阻塞屏幕的 wx.showLoading)
    this.setData({
      savingCount: this.data.savingCount + 1
    });

    this._recorder.triggerExport()
      .then(function (trimmedPath) {
        self.saveVideoToPhotos(trimmedPath, isLocal);
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
        wx.showModal({
          title: '导出失败',
          content: err.message || '裁切高光时发生错误，请重试',
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
