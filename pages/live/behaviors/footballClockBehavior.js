const liveHelpers = require('./live-helpers.js');
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
    /** 足球上下半场文案 */
footballHalfLabel: '上半场',
    footballHalfLabelBase: '上半场',
    footballHalfStoppageText: '',
    /** 足球走表是否暂停（UI） */
footballClockPaused: true,
    /** 足球时间/场次操作面板 */
footballOpsPanelOpen: false,
    footballOpsPanelStyle: '',
    /** 足球本地正计时显示（手动模式 / 无云端时钟时） */
footballTimeText: '00:00',
    /** 足球界面最终展示时间（优先云端，否则本地） */
footballDisplayTime: '00:00'
  },
  methods: {
    /**
 * 根据落盘数据计算足球当前累计秒数（含异常退出后的墙钟补偿）。
 * @param {object} [mc]
 * @returns {number}
 */
_computeFootballElapsedFromStored: function (mc) {
  mc = mc || this.data.matchConfig || {};
  var fs = normalizeFootballState(mc.footballState);
  var base = Math.max(0, Math.floor(Number(mc.footballElapsedSec) || 0));
  if (fs.clockPaused) return base;
  var wallMs = Number(fs.clockWallMs) || 0;
  if (wallMs <= 0) return base;
  return base + Math.max(0, Math.floor((Date.now() - wallMs) / 1000));
},
    /**
 * 将运行中足球计时同步写入 matchConfig（含墙钟锚点）。
 * @returns {void}
 */
_syncFootballClockToConfig: function () {
  if (normalizeSportType(this.data.sportType) !== SPORT_FOOTBALL) return;
  var mc = this.data.matchConfig || {};
  var fs = normalizeFootballState(mc.footballState);
  var elapsed;
  if (this._footballLocalClockTimer) {
    var base = this._footballClockBaseSec || 0;
    var anchor = this._footballClockAnchorMs || Date.now();
    elapsed = base + Math.floor((Date.now() - anchor) / 1000);
  } else {
    elapsed = this._computeFootballElapsedFromStored(mc);
  }
  elapsed = Math.max(0, Math.floor(elapsed));
  this._footballLiveElapsedSec = elapsed;
  var patch = {
    'matchConfig.footballElapsedSec': elapsed
  };
  if (!fs.clockPaused) {
    patch['matchConfig.footballState.clockWallMs'] = Date.now();
  }
  this.setData(patch);
},
    /**
 * 启动足球本地正计时（进入 live / 切换场次后调用；暂停态不启动 interval）。
 * @returns {void}
 */
_startFootballLocalClock: function () {
  if (normalizeSportType(this.data.sportType) !== SPORT_FOOTBALL) return;
  this._stopFootballLocalClock(false);
  var mc = this.data.matchConfig || {};
  var fs = normalizeFootballState(mc.footballState);
  var elapsed = this._computeFootballElapsedFromStored(mc);
  this._footballClockBaseSec = elapsed;
  this._footballLiveElapsedSec = elapsed;
  this._footballClockAnchorMs = Date.now();
  var patch = {
    footballClockPaused: fs.clockPaused,
    footballTimeText: formatWxsMainText(elapsed),
    footballDisplayTime: this._resolveFootballDisplayTime(formatWxsMainText(elapsed))
  };
  if (!fs.clockPaused) {
    patch['matchConfig.footballElapsedSec'] = elapsed;
    patch['matchConfig.footballState.clockWallMs'] = Date.now();
  }
  this.setData(patch);
  if (!fs.clockPaused) {
    var selfClock = this;
    this._footballLocalClockTimer = setInterval(function () {
      selfClock._tickFootballLocalClock();
    }, 1000);
  }
},
    /**
 * 停止足球本地正计时。
 * @param {boolean} [persist] 是否落盘当前秒数，默认 true
 * @returns {void}
 */
_stopFootballLocalClock: function (persist) {
  if (persist !== false) {
    this._syncFootballClockToConfig();
  }
  if (this._footballLocalClockTimer) {
    clearInterval(this._footballLocalClockTimer);
    this._footballLocalClockTimer = null;
  }
},
    /**
 * 刷新足球本地正计时显示。
 * @returns {void}
 */
_tickFootballLocalClock: function () {
  var fs = normalizeFootballState(this.data.matchConfig && this.data.matchConfig.footballState);
  if (fs.clockPaused) return;
  var base = this._footballClockBaseSec || 0;
  var anchor = this._footballClockAnchorMs || Date.now();
  var elapsed = base + Math.floor((Date.now() - anchor) / 1000);
  this._footballLiveElapsedSec = elapsed;
  var text = formatWxsMainText(elapsed);
  var display = this._resolveFootballDisplayTime(text);
  var patch = {};
  if (text !== this.data.footballTimeText) patch.footballTimeText = text;
  if (display !== this.data.footballDisplayTime) patch.footballDisplayTime = display;
  if (Object.keys(patch).length) {
    this.setData(patch);
  }
},
    /**
 * 将当前足球累计秒数写入 matchConfig。
 * @returns {void}
 */
_persistFootballClock: function () {
  this._syncFootballClockToConfig();
},
    /**
 * 走表：启动 interval 并写入墙钟锚点。
 * @returns {void}
 */
_resumeFootballClock: function () {
  var mc = this.data.matchConfig || {};
  var elapsed = Math.max(0, Math.floor(Number(mc.footballElapsedSec) || 0));
  this._footballClockBaseSec = elapsed;
  this._footballClockAnchorMs = Date.now();
  this._footballLiveElapsedSec = elapsed;
  var selfResume = this;
  this.setData({
    'matchConfig.footballState.clockPaused': false,
    'matchConfig.footballState.clockWallMs': Date.now(),
    footballClockPaused: false,
    footballTimeText: formatWxsMainText(elapsed),
    footballDisplayTime: this._resolveFootballDisplayTime(formatWxsMainText(elapsed))
  }, function () {
    if (!selfResume._footballLocalClockTimer) {
      selfResume._footballLocalClockTimer = setInterval(function () {
        selfResume._tickFootballLocalClock();
      }, 1000);
    }
  });
},
    /**
 * 停表：冻结当前秒数并清除墙钟锚点。
 * @returns {void}
 */
_pauseFootballClock: function () {
  this._syncFootballClockToConfig();
  var frozen = Math.max(0, Math.floor(this._footballLiveElapsedSec || 0));
  if (this._footballLocalClockTimer) {
    clearInterval(this._footballLocalClockTimer);
    this._footballLocalClockTimer = null;
  }
  this.setData({
    'matchConfig.footballElapsedSec': frozen,
    'matchConfig.footballState.clockPaused': true,
    'matchConfig.footballState.clockWallMs': 0,
    footballClockPaused: true,
    footballTimeText: formatWxsMainText(frozen),
    footballDisplayTime: formatWxsMainText(frozen)
  });
},
    /**
 * 点击时间/场次区域：在取景区右缘弹出操作面板。
 * @returns {void}
 */
onFootballMetaTap: function () {
  if (normalizeSportType(this.data.sportType) !== SPORT_FOOTBALL) return;
  if (this.data.isAutoMode) return;
  if (this.data.footballOpsPanelOpen) {
    this.setData({
      footballOpsPanelOpen: false
    });
    return;
  }
  this.setData({
    footballOpsPanelOpen: true,
    footballOpsPanelStyle: ''
  });
  this.vibrate('light');
},
    /**
 * 计算足球操作面板 fixed 定位（右缘、避让胶囊）。
 * @param {function(string): void} cb
 * @returns {void}
 */
_computeFootballOpsPanelStyle: function (cb) {
  var fallback = 'left:8px;top:56px;';
  try {
    var sys = wx.getSystemInfoSync();
    var sysW = Math.max(1, Number(sys.windowWidth) || 375);
    var panelW = Math.max(120, Math.round(240 * sysW / 750));
    var panelH = Math.max(140, Math.round(280 * sysW / 750));
    wx.createSelectorQuery().in(this).select('#liveStage').boundingClientRect().select('.pro-football-meta-col').boundingClientRect().exec(function (res) {
      var stage = res && res[0];
      var meta = res && res[1];
      var top = 56;
      var left = sysW - panelW - 10;
      if (meta && meta.width) {
        top = meta.bottom + 10;
        left = meta.right - panelW;
      } else if (stage && stage.width) {
        left = stage.left + stage.width - panelW - 10;
        top = stage.top + 10;
      }
      if (stage && stage.width) {
        left = Math.max(stage.left + 6, Math.min(left, stage.left + stage.width - panelW - 6));
        if (top + panelH > stage.bottom - 6) {
          top = Math.max(stage.top + 6, meta && meta.top ? meta.top : stage.top + 6);
        }
      }
      try {
        if (wx.getMenuButtonBoundingClientRect) {
          var menu = wx.getMenuButtonBoundingClientRect();
          if (menu && typeof menu.bottom === 'number') {
            var minTop = menu.bottom + 8;
            if (top < minTop && meta && meta.bottom) {
              top = meta.bottom + 10;
            }
            if (typeof menu.left === 'number' && left + panelW > menu.left - 6) {
              left = Math.max(6, menu.left - panelW - 10);
            }
          }
        }
      } catch (eMenu) {}
      if (typeof cb === 'function') {
        cb('left:' + Math.round(left) + 'px;top:' + Math.round(top) + 'px;width:' + panelW + 'px;');
      }
    });
  } catch (e) {
    if (typeof cb === 'function') cb(fallback);
  }
},
    /** 关闭足球操作面板 */
onFootballOpsPanelBackdropTap: function () {
  this.setData({
    footballOpsPanelOpen: false
  });
},
    /** 操作面板：走表 / 停表 */
onFootballClockToggleTap: function () {
  if (this.data.footballClockPaused) {
    this._resumeFootballClock();
  } else {
    this._pauseFootballClock();
  }
  this.persistConfig();
  this.vibrate('light');
},
    /**
 * 操作面板：切换场次。
 * @param {WechatMiniprogram.BaseEvent} e
 * @returns {void}
 */
onFootballPeriodSelectTap: function (e) {
  var target = Math.min(5, Math.max(1, Math.floor(Number(e.currentTarget.dataset.period) || 1)));
  this._applyFootballPeriodFromPanel(target);
  this.vibrate('light');
},
    /** 操作面板：设置当前场次补时 */
onFootballStoppageTap: function () {
  var p = Math.min(3, Math.max(1, Math.floor(Number(this.data.matchConfig && this.data.matchConfig.period) || 1)));
  this._promptFootballStoppageMinutes(p);
  this.setData({
    footballOpsPanelOpen: false
  });
  this.vibrate('light');
},
    /**
 * 从操作面板切换足球场次。
 * @param {1|2|3|4|5} targetPeriod
 * @returns {void}
 */
_applyFootballPeriodFromPanel: function (targetPeriod) {
  var target = Math.min(5, Math.max(1, Math.floor(Number(targetPeriod) || 1)));
  var resetSec = null;
  var autoStart = false;
  if (target === 1) {
    resetSec = 0;
    autoStart = true;
  } else if (target === 2) {
    resetSec = FOOTBALL_HALF2_START_SEC;
    autoStart = true;
  } else if (target === 3) {
    resetSec = FOOTBALL_EXTRA_START_SEC;
    autoStart = true;
  } else if (target === 4) {
    resetSec = 0;
    autoStart = false;
  } else if (target === 5) {
    resetSec = 0;
    autoStart = false;
  }
  this._stopFootballLocalClock(false);
  var mc = this.data.matchConfig || {};
  var fs = normalizeFootballState(mc.footballState);
  fs.clockPaused = !autoStart;
  fs.clockWallMs = autoStart ? Date.now() : 0;
  // 切换场次时，清空目标场次的补时
  if (target === 1) {
    fs.extraMinutesHalf1 = 0;
  } else if (target === 2) {
    fs.extraMinutesHalf2 = 0;
  } else if (target === 3) {
    fs.extraMinutesExtra = 0;
  }
  if (resetSec !== null) {
    this._footballClockBaseSec = resetSec;
    this._footballLiveElapsedSec = resetSec;
    this._footballClockAnchorMs = Date.now();
  } else {
    resetSec = Math.max(0, Math.floor(Number(mc.footballElapsedSec) || 0));
  }
  var text = formatWxsMainText(resetSec);
  var display = this._resolveFootballDisplayTime(text);
  var nextMc = {
    ...mc,
    period: target,
    footballElapsedSec: resetSec,
    footballState: fs
  };
  var sportUi = this.buildSportUiPatch(nextMc, this.data.sportType);
  var patch = {
    matchConfig: nextMc,
    footballClockPaused: !autoStart,
    footballTimeText: text,
    footballDisplayTime: display,
    footballOpsPanelOpen: false,
    ...sportUi
  };
  var self = this;
  this.setData(patch, function () {
    self.persistConfig();
    if (autoStart) {
      if (!self._footballLocalClockTimer) {
        self._footballLocalClockTimer = setInterval(function () {
          self._tickFootballLocalClock();
        }, 1000);
      }
    }
  });
},
    /**
 * 弹出补时分钟输入框。
 * @param {1|2|3} periodIndex
 * @returns {void}
 */
_promptFootballStoppageMinutes: function (periodIndex) {
  var idx = Math.min(3, Math.max(1, Math.floor(Number(periodIndex) || 1)));
  var key = idx === 3 ? 'extraMinutesExtra' : idx === 2 ? 'extraMinutesHalf2' : 'extraMinutesHalf1';
  var title = idx === 3 ? '加时赛补时（分钟）' : idx === 2 ? '下半场补时（分钟）' : '上半场补时（分钟）';
  var fs = normalizeFootballState(this.data.matchConfig && this.data.matchConfig.footballState);
  var current = Math.max(0, Math.floor(Number(fs[key]) || 0));
  var self = this;
  wx.showModal({
    title: title,
    editable: true,
    placeholderText: '例如 2',
    content: current > 0 ? String(current) : '',
    success: function (res) {
      if (!res.confirm) return;
      var minutes = Math.max(0, Math.floor(Number(String(res.content || '').trim()) || 0));
      var patch = {};
      patch['matchConfig.footballState.' + key] = minutes;
      self.setData(patch, function () {
        self.refreshSportUiMeta();
        self.persistConfig();
      });
    }
  });
},
    /**
 * 重置足球走表到指定秒数（节次切换用，保留暂停态）。
 * @param {number} sec
 * @returns {void}
 */
_resetFootballClockTo: function (sec) {
  var s = Math.max(0, Math.floor(Number(sec) || 0));
  var fs = normalizeFootballState(this.data.matchConfig && this.data.matchConfig.footballState);
  this._footballClockBaseSec = s;
  this._footballLiveElapsedSec = s;
  this._footballClockAnchorMs = Date.now();
  var text = formatWxsMainText(s);
  var patch = {
    'matchConfig.footballElapsedSec': s,
    footballTimeText: text,
    footballDisplayTime: this._resolveFootballDisplayTime(text)
  };
  if (!fs.clockPaused) {
    patch['matchConfig.footballState.clockWallMs'] = Date.now();
  }
  this.setData(patch);
  if (!fs.clockPaused && !this._footballLocalClockTimer) {
    var selfReset = this;
    this._footballLocalClockTimer = setInterval(function () {
      selfReset._tickFootballLocalClock();
    }, 1000);
  }
},
    /**
 * 解析足球界面展示时间：云端自动计时优先，否则本地正计时。
 * @param {string} [localText]
 * @returns {string}
 */
_resolveFootballDisplayTime: function (localText) {
  var local = localText || this.data.footballTimeText || '00:00';
  if (this.data.isAutoMode && this.data.wxsClockBundle && this.data.wxsClockBundle.mainRunning && this.data.wxsClockMainText) {
    return this.data.wxsClockMainText;
  }
  return local;
}
  }
});
