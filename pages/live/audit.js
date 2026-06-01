/**
 * @fileoverview 直播端审计日志模块（RingBuffer + NDJSON 自动落盘，纯观测层）
 */

/** 环形缓冲容量：保留最近 5000 条审计日志 */
var AUDIT_BUFFER_CAPACITY = 5000;

/** NDJSON 主日志文件名 */
var AUDIT_NDJSON_NAME = 'live-audit.ndjson';

/** NDJSON 轮转备份文件名 */
var AUDIT_NDJSON_OLD_NAME = 'live-audit-old.ndjson';

/** 页面卸载快照文件名 */
var AUDIT_FINAL_NAME = 'live-audit-final.json';

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

/** @type {Record<string, string>} */
var _auditDevice = {};

/** @type {boolean} */
var _auditDeviceInitialized = false;

/** @type {string[]} 待 appendFile 的 NDJSON 行缓存 */
var pendingAuditLines = [];

/** @type {number} flush 定时器 id */
var _auditFlushTimer = 0;

/** @type {Record<string, number>} 高光相关事件计数 */
var _highlightEventCounts = {};

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
 * 返回页面卸载快照绝对路径。
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
      var fileExists = false;
      try {
        fs.accessSync(filePath);
        fileExists = true;
      } catch (eAccess) { /* 首次写入 */ }
      if (fileExists) {
        fs.appendFileSync(filePath, payload, 'utf8');
      } else {
        fs.writeFileSync(filePath, payload, 'utf8');
      }
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
 * 清空内存缓冲、计数器与磁盘 NDJSON，开启新的直播页审计会话。
 * 每次 onLoad 调用，避免跨场次/多次进入 live 页累加旧日志。
 * @returns {void}
 */
function resetAuditSession() {
  if (_auditFlushTimer) {
    clearTimeout(_auditFlushTimer);
    _auditFlushTimer = 0;
  }
  pendingAuditLines = [];
  _highlightEventCounts = {};
  _auditBuffer = new RingBuffer(AUDIT_BUFFER_CAPACITY);

  var fs = getAuditFs();
  if (!fs) return;
  var paths = [
    getAuditNdjsonPath(),
    getAuditNdjsonOldPath(),
    getAuditFinalPath()
  ];
  for (var i = 0; i < paths.length; i++) {
    var p = paths[i];
    if (!p) continue;
    try {
      fs.unlinkSync(p);
    } catch (eUnlink) { /* 文件可能尚不存在 */ }
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
  var evt = String(event || '?');
  var entry = {
    t: Date.now(),
    e: evt,
    d: detail && typeof detail === 'object' ? detail : {}
  };
  _auditBuffer.push(entry);
  appendAuditFile(entry);
  if (evt.indexOf('highlight_') === 0) {
    _highlightEventCounts[evt] = (_highlightEventCounts[evt] || 0) + 1;
  }
}

/**
 * 记录高光保存链路事件。
 * @param {string} phase 阶段标识
 * @param {Record<string, unknown>} [detail] 附加字段
 * @returns {void}
 */
function auditHighlight(phase, detail) {
  var payload = { phase: String(phase || 'unknown') };
  if (detail && typeof detail === 'object') {
    var keys = Object.keys(detail).slice(0, 40);
    for (var i = 0; i < keys.length; i++) {
      payload[keys[i]] = detail[keys[i]];
    }
  }
  appendAuditLog('highlight_' + String(phase || 'unknown'), payload);
}

/**
 * 记录高光裁剪诊断（与 health log highlight_trim_diagnostic 对齐）。
 * @param {string} phase click|seek|materialize|replay
 * @param {Record<string, unknown>} [detail]
 * @returns {void}
 */
function auditTrimDiagnostic(phase, detail) {
  var payload = { phase: String(phase || 'unknown') };
  if (detail && typeof detail === 'object') {
    var keys = Object.keys(detail).slice(0, 40);
    for (var i = 0; i < keys.length; i++) {
      payload[keys[i]] = detail[keys[i]];
    }
  }
  appendAuditLog('highlight_trim_diagnostic', payload);
}

/**
 * 记录 rolling / 分段录制事件。
 * @param {string} event 事件名
 * @param {Record<string, unknown>} [detail]
 * @returns {void}
 */
function auditRolling(event, detail) {
  appendAuditLog('rolling_' + String(event || 'unknown'), detail || {});
}

/**
 * 记录管线健康 / 恢复事件。
 * @param {string} event 事件名
 * @param {Record<string, unknown>} [detail]
 * @returns {void}
 */
function auditPipeline(event, detail) {
  appendAuditLog('pipeline_' + String(event || 'unknown'), detail || {});
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
    highlightEventCounts: Object.assign({}, _highlightEventCounts),
    firstTs: logs.length ? logs[0].t : 0,
    lastTs: logs.length ? logs[logs.length - 1].t : 0,
    ndjsonPath: getAuditNdjsonPath(),
    ndjsonOldPath: getAuditNdjsonOldPath(),
    pendingLines: pendingAuditLines.length,
    rotateMaxBytes: AUDIT_ROTATE_MAX_BYTES
  };
}

/**
 * 返回内存中全部审计日志快照。
 * @returns {{ at: number, count: number, capacity: number, logs: Array<{t:number,e:string,d:Object}> }}
 */
function dumpLiveAudit() {
  var logs = _auditBuffer.toArray();
  return {
    at: Date.now(),
    count: logs.length,
    capacity: AUDIT_BUFFER_CAPACITY,
    logs: logs
  };
}

/**
 * 页面卸载导出：flush 待写行 + 写入 live-audit-final.json。
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
    if (typeof val === 'string') {
      if (val.indexOf('wxfile://') === 0) {
        val = val.slice(-96);
      } else if (val.length > 240) {
        val = val.slice(-240);
      }
    }
    out[key] = val;
  }
  return out;
}

/**
 * 生成带时间戳的审计导出文件，供分享或保存到手机。
 * @param {Record<string, unknown>} [extra] 附加顶层字段（如 healthLogs、diag）
 * @returns {{
 *   ok: boolean,
 *   path: string,
 *   fileName: string,
 *   size: number,
 *   summary: Record<string, unknown>,
 *   error?: string
 * }}
 */
function exportAuditToFile(extra) {
  var summary = buildAuditSummary();
  try {
    flushAuditFileLines();
    initAuditDeviceInfo();
    var dump = dumpLiveAudit();
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
    var fileName = 'live-audit-' + ts + '.json';
    var filePath = root + '/' + fileName;
    var payload = {
      exportedAt: ts,
      device: _auditDevice,
      summary: summary,
      ndjsonPath: getAuditNdjsonPath(),
      ndjsonOldPath: getAuditNdjsonOldPath(),
      logs: dump.logs.map(function (it) {
        return { t: it.t, e: it.e, d: compactAuditDetail(it.d) };
      })
    };
    if (extra && typeof extra === 'object') {
      payload.extra = extra;
    }
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

module.exports = {
  appendAuditLog: appendAuditLog,
  auditHighlight: auditHighlight,
  auditTrimDiagnostic: auditTrimDiagnostic,
  auditRolling: auditRolling,
  auditPipeline: auditPipeline,
  dumpLiveAudit: dumpLiveAudit,
  exportAuditSnapshot: exportAuditSnapshot,
  exportAuditToFile: exportAuditToFile,
  getAuditNdjsonPath: getAuditNdjsonPath,
  buildAuditSummary: buildAuditSummary,
  flushAuditFileLines: flushAuditFileLines,
  compactAuditDetail: compactAuditDetail,
  resetAuditSession: resetAuditSession
};
