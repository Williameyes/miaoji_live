/** @const {string} 合并导出诊断日志 Storage 键 */
const MERGE_EXPORT_DIAG_KEY = 'MERGE_EXPORT_DIAG_V1';

/** @const {number} 最多保留条数 */
const MERGE_EXPORT_DIAG_MAX = 40;

/**
 * 追加一条合并导出诊断日志（持久化到 Storage，便于真机无调试器时排查）。
 * @param {string} event 事件名
 * @param {Record<string, unknown>} [detail]
 * @returns {void}
 */
function appendMergeExportDiag(event, detail) {
  if (typeof wx === 'undefined' || typeof wx.getStorageSync !== 'function') return;
  const name = typeof event === 'string' ? event : 'unknown';
  const item = {
    t: Date.now(),
    event: name,
    detail: detail && typeof detail === 'object' ? detail : {}
  };
  try {
    const raw = wx.getStorageSync(MERGE_EXPORT_DIAG_KEY);
    const list = Array.isArray(raw) ? raw.slice() : [];
    list.push(item);
    if (list.length > MERGE_EXPORT_DIAG_MAX) {
      list.splice(0, list.length - MERGE_EXPORT_DIAG_MAX);
    }
    wx.setStorageSync(MERGE_EXPORT_DIAG_KEY, list);
  } catch (e) {
    // 存储满时忽略
  }
  try {
    console.warn('[merge-export]', name, item.detail);
  } catch (eLog) {
    // ignore
  }
}

/**
 * 读取合并导出诊断日志。
 * @returns {Array<{ t: number, event: string, detail: Record<string, unknown> }>}
 */
function readMergeExportDiag() {
  try {
    const raw = wx.getStorageSync(MERGE_EXPORT_DIAG_KEY);
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

/**
 * 生成可复制的诊断摘要文本。
 * @returns {string}
 */
function buildMergeExportDiagText() {
  const logs = readMergeExportDiag();
  if (!logs.length) return '（暂无合并导出诊断记录）';
  let sys = {};
  try {
    sys = wx.getSystemInfoSync();
  } catch (e) {}
  const head = [
    `设备: ${sys.model || '?'} / ${sys.system || '?'} / 微信 ${sys.version || '?'}`,
    `基础库: ${sys.SDKVersion || '?'}`,
    `时间: ${new Date().toISOString()}`,
    `条数: ${logs.length}`,
    '---'
  ].join('\n');
  const body = logs.slice(-15).map((it) => {
    const ts = new Date(it.t).toISOString().slice(11, 19);
    let detailStr = '';
    try {
      detailStr = JSON.stringify(it.detail || {});
    } catch (e) {
      detailStr = '{}';
    }
    if (detailStr.length > 420) detailStr = `${detailStr.slice(0, 420)}…`;
    return `[${ts}] ${it.event} ${detailStr}`;
  }).join('\n');
  return `${head}\n${body}`;
}

/**
 * 清空合并导出诊断日志。
 * @returns {void}
 */
function clearMergeExportDiag() {
  try {
    wx.removeStorageSync(MERGE_EXPORT_DIAG_KEY);
  } catch (e) {}
}

module.exports = {
  MERGE_EXPORT_DIAG_KEY,
  appendMergeExportDiag,
  readMergeExportDiag,
  buildMergeExportDiagText,
  clearMergeExportDiag
};
