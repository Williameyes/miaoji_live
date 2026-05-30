/**
 * @fileoverview 采集端审计日志模块（RingBuffer + NDJSON 自动落盘，纯观测层）
 */

/** 环形缓冲容量：保留最近 5000 条审计日志 */
var AUDIT_BUFFER_CAPACITY = 5000;

/** 审计日志落盘 Storage Key（export 时可选用） */
var COLLECTOR_AUDIT_STORAGE_KEY = 'SYNC_LAB_COLLECTOR_AUDIT_V1';

/** NDJSON 主日志文件名 */
var AUDIT_NDJSON_NAME = 'collector-audit.ndjson';

/** NDJSON 轮转备份文件名 */
var AUDIT_NDJSON_OLD_NAME = 'collector-audit-old.ndjson';

/** 比赛结束快照文件名 */
var AUDIT_FINAL_NAME = 'collector-audit-final.json';

/** 待写入行数达到该阈值时立即 flush */
var AUDIT_FLUSH_LINE_THRESHOLD = 20;

/** 待写入行超过该毫秒未 flush 则触发 flush */
var AUDIT_FLUSH_INTERVAL_MS = 5000;

/** NDJSON 主文件超过该字节数时轮转 */
var AUDIT_ROTATE_MAX_BYTES = 5 * 1024 * 1024;

/**
 * 固定容量环形缓冲区。
 * @constructor
 * @param {number} capacity 最大条目数
 */
function RingBuffer(capacity) {
  /** @type {number} */
  this.capacity = Math.max(1, Number(capacity) || 1);
  /** @type {Array<*>} */
  this.items = [];
  /** @type {number} */
  this.head = 0;
  /** @type {number} */
  this.size = 0;
}

/**
 * 追加一条记录；超出容量时覆盖最旧条目。
 * @param {*} item 待写入条目
 * @returns {void}
 */
RingBuffer.prototype.push = function (item) {
  if (this.size < this.capacity) {
    this.items.push(item);
    this.size += 1;
    return;
  }
  this.items[this.head] = item;
  this.head = (this.head + 1) % this.capacity;
};

/**
 * 按时间顺序返回缓冲区内全部条目（最旧 → 最新）。
 * @returns {Array<*>}
 */
RingBuffer.prototype.toArray = function () {
  if (this.size < this.capacity) {
    return this.items.slice();
  }
  return this.items.slice(this.head).concat(this.items.slice(0, this.head));
};

/** @type {RingBuffer} */
var _auditBuffer = new RingBuffer(AUDIT_BUFFER_CAPACITY);

/** 上次 clock_state 快照键，用于去重 */
var _lastClockStateKey = '';

/** @type {Record<string, string>} */
var _auditDevice = {};

/** @type {boolean} */
var _auditDeviceInitialized = false;

/** @type {string[]} 待 appendFile 的 NDJSON 行缓存 */
var pendingAuditLines = [];

/** @type {number} flush 定时器 id */
var _auditFlushTimer = 0;

/** 振荡检测窗口（毫秒） */
var OSCILLATION_WINDOW_MS = 10000;

/** 振荡最少交替次数 */
var OSCILLATION_MIN_ALTERNATIONS = 3;

/** @type {{ source: string, reason: string, functionName: string } | null} */
var _clockSourceContext = null;

/** @type {Array<{ t: number, sec: number }>} */
var _clockSecOscHistory = [];

/** @type {Array<{ t: number, mode: string }>} */
var _modeOscHistory = [];

/** @type {Record<string, number>} */
var _clockSourceCounts = {};

/** @type {number} */
var _modeChangeCount = 0;

/** @type {number} */
var _runningChangeCount = 0;

/** @type {number} */
var _clockOscillationCount = 0;

/** @type {number} */
var _modeOscillationCount = 0;

/** @type {string} */
var _lastClockOscillationKey = '';

/** @type {string} */
var _lastModeOscillationKey = '';

/**
 * 获取文件系统管理器；不可用则返回 null。
 * @returns {WechatMiniprogram.FileSystemManager | null}
 */
function getAuditFs() {
  try {
    if (typeof wx === 'undefined' || typeof wx.getFileSystemManager !== 'function') {
      return null;
    }
    return wx.getFileSystemManager();
  } catch (eFs) {
    return null;
  }
}

/**
 * 返回 NDJSON 主日志绝对路径。
 * @returns {string}
 */
function getAuditNdjsonPath() {
  try {
    if (typeof wx !== 'undefined' && wx.env && wx.env.USER_DATA_PATH) {
      return wx.env.USER_DATA_PATH + '/' + AUDIT_NDJSON_NAME;
    }
  } catch (ePath) { /* ignore */ }
  return '';
}

/**
 * 返回 NDJSON 轮转备份绝对路径。
 * @returns {string}
 */
function getAuditNdjsonOldPath() {
  try {
    if (typeof wx !== 'undefined' && wx.env && wx.env.USER_DATA_PATH) {
      return wx.env.USER_DATA_PATH + '/' + AUDIT_NDJSON_OLD_NAME;
    }
  } catch (eOld) { /* ignore */ }
  return '';
}

/**
 * 返回比赛结束快照绝对路径。
 * @returns {string}
 */
function getAuditFinalPath() {
  try {
    if (typeof wx !== 'undefined' && wx.env && wx.env.USER_DATA_PATH) {
      return wx.env.USER_DATA_PATH + '/' + AUDIT_FINAL_NAME;
    }
  } catch (eFinal) { /* ignore */ }
  return '';
}

/**
 * 记录文件 IO 异常（仅 RingBuffer，不再写文件，避免循环）。
 * @param {*} err 错误对象
 * @param {string} context 上下文标识
 * @returns {void}
 */
function logAuditFileError(err, context) {
  try {
    _auditBuffer.push({
      t: Date.now(),
      e: 'audit_file_error',
      d: {
        context: String(context || '?'),
        msg: err && err.message ? String(err.message) : String(err)
      }
    });
  } catch (eIgnore) { /* ignore */ }
}

/**
 * 主 NDJSON 超过 5MB 时轮转：rename 为 old，重新创建空主文件。
 * @param {WechatMiniprogram.FileSystemManager} fs 文件系统
 * @param {string} filePath 主日志路径
 * @returns {void}
 */
function maybeRotateAuditFile(fs, filePath) {
  if (!fs || !filePath) return;
  try {
    var stat = fs.statSync(filePath);
    if (!stat || stat.size <= AUDIT_ROTATE_MAX_BYTES) return;
    var oldPath = getAuditNdjsonOldPath();
    if (oldPath) {
      try {
        fs.unlinkSync(oldPath);
      } catch (eUnlink) { /* ignore */ }
      fs.renameSync(filePath, oldPath);
    }
  } catch (eStat) {
    /* 文件尚不存在，无需轮转 */
  }
}

/**
 * 将 pendingAuditLines 一次性 appendFile 写入 NDJSON 主文件。
 * @returns {void}
 */
function flushAuditFileLines() {
  if (_auditFlushTimer) {
    clearTimeout(_auditFlushTimer);
    _auditFlushTimer = 0;
  }
  if (!pendingAuditLines.length) return;

  var batch = pendingAuditLines.slice();
  pendingAuditLines = [];
  var fs = getAuditFs();
  var filePath = getAuditNdjsonPath();
  if (!fs || !filePath) {
    logAuditFileError('fs_unavailable', 'flush');
    return;
  }

  try {
    maybeRotateAuditFile(fs, filePath);
    var payload = batch.join('\n') + '\n';
    if (typeof fs.appendFileSync === 'function') {
      fs.appendFileSync(filePath, payload, 'utf8');
    } else {
      fs.appendFile({
        filePath: filePath,
        data: payload,
        encoding: 'utf8',
        success: function () { /* ok */ },
        fail: function (eFail) {
          logAuditFileError(eFail, 'flush_async');
        }
      });
    }
  } catch (eFlush) {
    logAuditFileError(eFlush, 'flush');
  }
}

/**
 * 安排 5 秒后 flush（若尚未安排）。
 * @returns {void}
 */
function scheduleAuditFlushTimer() {
  if (_auditFlushTimer) return;
  _auditFlushTimer = setTimeout(function () {
    _auditFlushTimer = 0;
    flushAuditFileLines();
  }, AUDIT_FLUSH_INTERVAL_MS);
}

/**
 * 追加一条 NDJSON 行到内存缓存；达阈值或超时后批量 appendFile。
 * @param {{ t: number, e: string, d: Object }} event 审计条目
 * @returns {void}
 */
function appendAuditFile(event) {
  try {
    var line = JSON.stringify(event);
    pendingAuditLines.push(line);
    if (pendingAuditLines.length >= AUDIT_FLUSH_LINE_THRESHOLD) {
      flushAuditFileLines();
      return;
    }
    scheduleAuditFlushTimer();
  } catch (eLine) {
    logAuditFileError(eLine, 'append_line');
  }
}

/**
 * 初始化设备信息（export 时附带）。
 * @returns {void}
 */
function initAuditDeviceInfo() {
  if (_auditDeviceInitialized) return;
  _auditDeviceInitialized = true;
  try {
    var sys = wx.getSystemInfoSync();
    _auditDevice = {
      model: String(sys.model || ''),
      brand: String(sys.brand || ''),
      platform: String(sys.platform || ''),
      wxVersion: String(sys.version || ''),
      system: String(sys.system || ''),
      libVersion: String(sys.SDKVersion || '')
    };
  } catch (eDev) {
    _auditDevice = {};
  }
}

/**
 * 写入一条审计日志（RingBuffer + NDJSON 缓存）。
 * @param {string} event 事件名
 * @param {Record<string, unknown>} [detail] 附加字段
 * @returns {void}
 */
function appendAuditLog(event, detail) {
  var entry = {
    t: Date.now(),
    e: String(event || '?'),
    d: detail && typeof detail === 'object' ? detail : {}
  };
  _auditBuffer.push(entry);
  appendAuditFile(entry);
}

/**
 * 记录比赛时钟 UI 变更（分钟/秒）。
 * @param {Record<string, unknown>} detail
 * @returns {void}
 */
function auditClockChange(detail) {
  appendAuditLog('clock_change', detail);
}

/**
 * 记录比分 UI 变更（主/客）。
 * @param {Record<string, unknown>} detail
 * @returns {void}
 */
function auditScoreChange(detail) {
  appendAuditLog('score_change', detail);
}

/**
 * 记录时钟状态机快照（mode/state/running）。
 * @param {Record<string, unknown>} detail
 * @returns {void}
 */
function auditClockState(detail) {
  var key = '';
  try {
    key = JSON.stringify(detail || {});
  } catch (eKey) {
    key = String(Date.now());
  }
  if (key === _lastClockStateKey) return;
  _lastClockStateKey = key;
  appendAuditLog('clock_state', detail);
}

/**
 * 记录 OCR 时间跳变（SYNC 观察室入口）。
 * @param {Record<string, unknown>} detail
 * @returns {void}
 */
function auditOcrJump(detail) {
  appendAuditLog('ocr_jump', detail);
}

/**
 * 记录 Worker 统计摘要。
 * @param {Record<string, unknown>} detail
 * @returns {void}
 */
function auditWorkerStats(detail) {
  appendAuditLog('worker_stats', detail);
}

/**
 * 记录 OCR 请求队列变更。
 * @param {Record<string, unknown>} detail
 * @returns {void}
 */
function auditOcrQueue(detail) {
  appendAuditLog('ocr_queue', detail);
}

/**
 * 设置下一次 _commitLocalState 时间写入的 clock_source 上下文。
 * @param {{ source: string, reason: string, functionName: string }} ctx
 * @returns {void}
 */
function setClockSourceContext(ctx) {
  _clockSourceContext = ctx && typeof ctx === 'object' ? ctx : null;
}

/**
 * 是否已有待消费的 clock_source 上下文。
 * @returns {boolean}
 */
function hasClockSourceContext() {
  return !!_clockSourceContext;
}

/**
 * 取出并清空 clock_source 上下文。
 * @returns {{ source: string, reason: string, functionName: string }}
 */
function takeClockSourceContext() {
  var ctx = _clockSourceContext || { source: 'unknown', reason: '', functionName: '' };
  _clockSourceContext = null;
  return ctx;
}

/**
 * 记录比赛时间写入来源。
 * @param {Record<string, unknown>} detail
 * @returns {void}
 */
function auditClockSource(detail) {
  var source = String(detail.source || 'unknown');
  _clockSourceCounts[source] = (_clockSourceCounts[source] || 0) + 1;
  appendAuditLog('clock_source', detail);
  var next = detail.next;
  if (next && typeof next === 'object' && typeof next.totalSec === 'number') {
    detectClockOscillation(next.totalSec);
  }
}

/**
 * 记录 clockMode 变更。
 * @param {Record<string, unknown>} detail
 * @returns {void}
 */
function auditModeChange(detail) {
  _modeChangeCount += 1;
  appendAuditLog('mode_change', detail);
  detectModeOscillation(String(detail.prevMode || ''), String(detail.nextMode || ''));
}

/**
 * 记录 clockRunning 变更。
 * @param {Record<string, unknown>} detail
 * @returns {void}
 */
function auditRunningChange(detail) {
  _runningChangeCount += 1;
  appendAuditLog('running_change', detail);
}

/**
 * 检测最近 10 秒内比赛时钟 A↔B 振荡。
 * @param {number} totalSec 本次写入的总秒数
 * @returns {void}
 */
function detectClockOscillation(totalSec) {
  if (!isFinite(totalSec)) return;
  var now = Date.now();
  _clockSecOscHistory.push({ t: now, sec: totalSec });
  while (_clockSecOscHistory.length && now - _clockSecOscHistory[0].t > OSCILLATION_WINDOW_MS) {
    _clockSecOscHistory.shift();
  }
  if (_clockSecOscHistory.length < 4) return;
  var alternations = 0;
  var i;
  for (i = 2; i < _clockSecOscHistory.length; i++) {
    var a = _clockSecOscHistory[i - 2].sec;
    var b = _clockSecOscHistory[i - 1].sec;
    var c = _clockSecOscHistory[i].sec;
    if (a === c && a !== b) alternations += 1;
  }
  if (alternations < OSCILLATION_MIN_ALTERNATIONS) return;
  var valueA = _clockSecOscHistory[_clockSecOscHistory.length - 2].sec;
  var valueB = _clockSecOscHistory[_clockSecOscHistory.length - 1].sec;
  var oscKey = valueA + '|' + valueB + '|' + alternations;
  if (oscKey === _lastClockOscillationKey) return;
  _lastClockOscillationKey = oscKey;
  _clockOscillationCount += 1;
  appendAuditLog('clock_oscillation', {
    valueA: valueA,
    valueB: valueB,
    count: alternations
  });
}

/**
 * 检测最近 10 秒内 running↔paused 模式振荡。
 * @param {string} prevMode 变更前模式
 * @param {string} nextMode 变更后模式
 * @returns {void}
 */
function detectModeOscillation(prevMode, nextMode) {
  if (!nextMode || prevMode === nextMode) return;
  if (nextMode !== 'running' && nextMode !== 'paused') return;
  var now = Date.now();
  _modeOscHistory.push({ t: now, mode: nextMode });
  while (_modeOscHistory.length && now - _modeOscHistory[0].t > OSCILLATION_WINDOW_MS) {
    _modeOscHistory.shift();
  }
  var flips = 0;
  var j;
  for (j = 1; j < _modeOscHistory.length; j++) {
    var prev = _modeOscHistory[j - 1].mode;
    var next = _modeOscHistory[j].mode;
    if (
      (prev === 'running' && next === 'paused') ||
      (prev === 'paused' && next === 'running')
    ) {
      flips += 1;
    }
  }
  if (flips < OSCILLATION_MIN_ALTERNATIONS) return;
  var modeKey = flips + '|' + nextMode;
  if (modeKey === _lastModeOscillationKey) return;
  _lastModeOscillationKey = modeKey;
  _modeOscillationCount += 1;
  appendAuditLog('mode_oscillation', {
    flips: flips,
    lastMode: nextMode
  });
}

/**
 * 构建审计 summary 统计信息。
 * @returns {Record<string, unknown>}
 */
function buildAuditSummary() {
  var logs = _auditBuffer.toArray();
  var eventCounts = {};
  var i;
  for (i = 0; i < logs.length; i++) {
    var evt = logs[i].e || '?';
    eventCounts[evt] = (eventCounts[evt] || 0) + 1;
  }
  return {
    at: Date.now(),
    total: logs.length,
    capacity: AUDIT_BUFFER_CAPACITY,
    eventCounts: eventCounts,
    clockSourceCounts: Object.assign({}, _clockSourceCounts),
    modeChangeCount: _modeChangeCount,
    runningChangeCount: _runningChangeCount,
    oscillationCount: _clockOscillationCount + _modeOscillationCount,
    clockOscillationCount: _clockOscillationCount,
    modeOscillationCount: _modeOscillationCount,
    firstTs: logs.length ? logs[0].t : 0,
    lastTs: logs.length ? logs[logs.length - 1].t : 0,
    ndjsonPath: getAuditNdjsonPath(),
    ndjsonOldPath: getAuditNdjsonOldPath(),
    pendingLines: pendingAuditLines.length,
    rotateMaxBytes: AUDIT_ROTATE_MAX_BYTES
  };
}

/**
 * 返回内存中全部审计日志快照（供调试/排障）。
 * @returns {{ at: number, count: number, capacity: number, logs: Array<{t:number,e:string,d:Object}> }}
 */
function dumpCollectorAudit() {
  var logs = _auditBuffer.toArray();
  return {
    at: Date.now(),
    count: logs.length,
    capacity: AUDIT_BUFFER_CAPACITY,
    logs: logs
  };
}

/**
 * 比赛结束导出：flush 待写行 + 写入 collector-audit-final.json。
 * @returns {{ ok: boolean, path: string, summary: Record<string, unknown>, error?: string }}
 */
function exportAuditSnapshot() {
  var summary = buildAuditSummary();
  try {
    flushAuditFileLines();
    var logs = _auditBuffer.toArray();
    var payload = {
      summary: summary,
      logs: logs
    };
    var fs = getAuditFs();
    var finalPath = getAuditFinalPath();
    if (!fs || !finalPath) {
      logAuditFileError('fs_unavailable', 'export_snapshot');
      return { ok: false, path: '', summary: summary, error: 'fs_unavailable' };
    }
    fs.writeFileSync(finalPath, JSON.stringify(payload), 'utf8');
    return { ok: true, path: finalPath, summary: summary };
  } catch (eSnap) {
    logAuditFileError(eSnap, 'export_snapshot');
    return { ok: false, path: '', summary: summary, error: 'export_fail' };
  }
}

/**
 * 生成带时间戳的审计导出文件，供分享或保存到手机。
 * @returns {{
 *   ok: boolean,
 *   path: string,
 *   fileName: string,
 *   size: number,
 *   summary: Record<string, unknown>,
 *   error?: string
 * }}
 */
function exportAuditToFile() {
  var summary = buildAuditSummary();
  try {
    flushAuditFileLines();
    initAuditDeviceInfo();
    var dump = dumpCollectorAudit();
    if (!dump.count) {
      return { ok: false, path: '', fileName: '', size: 0, summary: summary, error: 'empty' };
    }
    var fs = getAuditFs();
    var root = '';
    try {
      root = wx.env.USER_DATA_PATH;
    } catch (eRoot) {
      root = '';
    }
    if (!fs || !root) {
      logAuditFileError('fs_unavailable', 'export_file');
      return { ok: false, path: '', fileName: '', size: 0, summary: summary, error: 'fs_unavailable' };
    }
    var ts = Date.now();
    var fileName = 'collector-audit-' + ts + '.json';
    var filePath = root + '/' + fileName;
    var payload = {
      exportedAt: ts,
      device: _auditDevice,
      summary: summary,
      ndjsonPath: getAuditNdjsonPath(),
      ndjsonOldPath: getAuditNdjsonOldPath(),
      logs: dump.logs
    };
    var content = JSON.stringify(payload);
    fs.writeFileSync(filePath, content, 'utf8');
    return {
      ok: true,
      path: filePath,
      fileName: fileName,
      size: content.length,
      summary: summary
    };
  } catch (eFile) {
    logAuditFileError(eFile, 'export_file');
    return { ok: false, path: '', fileName: '', size: 0, summary: summary, error: 'export_fail' };
  }
}

/**
 * 压缩 detail 字段，避免 export 体积过大。
 * @param {Record<string, unknown>} detail
 * @returns {Record<string, unknown>}
 */
function compactAuditDetail(detail) {
  if (!detail || typeof detail !== 'object') return {};
  var out = {};
  var keys = Object.keys(detail).slice(0, 32);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var val = detail[key];
    if (typeof val === 'string' && val.length > 240) {
      val = val.slice(-240);
    }
    out[key] = val;
  }
  return out;
}

/**
 * 导出审计日志为 JSON 字符串（供剪贴板/回传）。
 * @param {Record<string, unknown>} [extra] 附加顶层字段（如 ws 快照）
 * @returns {string}
 */
function exportCollectorAudit(extra) {
  initAuditDeviceInfo();
  var dump = dumpCollectorAudit();
  var summary = buildAuditSummary();
  var payload = {
    at: dump.at,
    device: _auditDevice,
    count: dump.count,
    capacity: dump.capacity,
    summary: summary,
    ndjsonPath: getAuditNdjsonPath(),
    logs: dump.logs.map(function (it) {
      return { t: it.t, e: it.e, d: compactAuditDetail(it.d) };
    })
  };
  if (extra && typeof extra === 'object') {
    payload.extra = extra;
  }
  try {
    var text = JSON.stringify(payload);
    if (text.length > 900000) {
      payload.logs = payload.logs.slice(-2000);
      text = JSON.stringify(payload);
    }
    return text;
  } catch (eJson) {
    return JSON.stringify({ at: Date.now(), error: 'audit_serialize_fail' });
  }
}

module.exports = {
  auditClockChange: auditClockChange,
  auditScoreChange: auditScoreChange,
  auditClockState: auditClockState,
  auditOcrJump: auditOcrJump,
  auditWorkerStats: auditWorkerStats,
  auditOcrQueue: auditOcrQueue,
  auditClockSource: auditClockSource,
  auditModeChange: auditModeChange,
  auditRunningChange: auditRunningChange,
  setClockSourceContext: setClockSourceContext,
  hasClockSourceContext: hasClockSourceContext,
  takeClockSourceContext: takeClockSourceContext,
  detectClockOscillation: detectClockOscillation,
  detectModeOscillation: detectModeOscillation,
  dumpCollectorAudit: dumpCollectorAudit,
  exportCollectorAudit: exportCollectorAudit,
  exportAuditSnapshot: exportAuditSnapshot,
  exportAuditToFile: exportAuditToFile,
  getAuditNdjsonPath: getAuditNdjsonPath,
  buildAuditSummary: buildAuditSummary,
  flushAuditFileLines: flushAuditFileLines
};
