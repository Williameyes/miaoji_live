/**
 * @fileoverview 投篮训练页环形日志缓冲，供真机屏显与复制导出。
 */

var MAX_LINES = 100;
var lines = [];

/**
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * @returns {string}
 */
function formatTime() {
  var d = new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/**
 * 写入一条日志（同时 console.log）。
 * @param {string} tag
 * @param {string} msg
 * @returns {string}
 */
function log(tag, msg) {
  var line = '[' + formatTime() + '][' + tag + '] ' + msg;
  lines.push(line);
  if (lines.length > MAX_LINES) {
    lines.shift();
  }
  try {
    console.log('[ShootingTraining][' + tag + ']', msg);
  } catch (e) {}
  return line;
}

/**
 * @returns {string}
 */
function dump() {
  return lines.join('\n');
}

/**
 * @returns {void}
 */
function clear() {
  lines = [];
}

/**
 * @returns {string[]}
 */
function getLines() {
  return lines.slice();
}

/**
 * @param {number} [n]
 * @returns {string[]}
 */
function getTailLines(n) {
  n = n || 4;
  if (lines.length <= n) return lines.slice();
  return lines.slice(lines.length - n);
}

module.exports = {
  log: log,
  dump: dump,
  clear: clear,
  getLines: getLines,
  getTailLines: getTailLines
};
