/**
 * @fileoverview 高光片段与副机拍摄文件名生成与设备特征提取工具
 */

/**
 * 清理文件名中不可用或非法字符，限制最大长度。
 * @param {string} text 原始字符串
 * @param {number} [maxLen] 最大字符数（默认 12）
 * @returns {string}
 */
function sanitizeFileNamePart(text, maxLen) {
  var limit = typeof maxLen === 'number' && maxLen > 0 ? maxLen : 12;
  return String(text || '')
    .replace(/[\u202e\u202d\u200b-\u200f\ufeff]/g, '')
    .replace(/[/\\?%*:|"<>#\r\n\t\s]/g, '')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9_-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, limit);
}

/**
 * 格式化当前系统时间为 YYYYMMDD_HHmmss
 * @param {Date} [date]
 * @returns {string}
 */
function formatTimestamp(date) {
  var d = date instanceof Date ? date : new Date();
  var pad = function (n) { return n < 10 ? '0' + n : String(n); };
  var yyyy = d.getFullYear();
  var mm = pad(d.getMonth() + 1);
  var dd = pad(d.getDate());
  var hh = pad(d.getHours());
  var min = pad(d.getMinutes());
  var ss = pad(d.getSeconds());
  return yyyy + mm + dd + '_' + hh + min + ss;
}

/**
 * 获取简化的本机设备特征标识（副机设备号）。
 * 例如: IP14Pro-8A2F / Mi12-3B1C
 * @returns {string}
 */
function getSlaveDeviceId() {
  var STORAGE_KEY = 'rec_slave_device_code_v1';
  var cachedCode = '';
  try {
    if (typeof wx !== 'undefined' && typeof wx.getStorageSync === 'function') {
      cachedCode = wx.getStorageSync(STORAGE_KEY) || '';
    }
  } catch (e) {}

  if (!cachedCode) {
    var rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    cachedCode = rand;
    try {
      if (typeof wx !== 'undefined' && typeof wx.setStorageSync === 'function') {
        wx.setStorageSync(STORAGE_KEY, cachedCode);
      }
    } catch (e) {}
  }

  var modelName = 'sub';
  try {
    if (typeof wx !== 'undefined') {
      var info = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : (typeof wx.getSystemInfoSync === 'function' ? wx.getSystemInfoSync() : null);
      if (info && info.model) {
        var rawModel = String(info.model);
        if (/iphone/i.test(rawModel)) {
          var m = rawModel.match(/iPhone\s*(\d+\s*(?:Pro(?:\s*Max)?|Mini|Plus)?)/i);
          if (m && m[1]) {
            modelName = 'IP' + m[1].replace(/\s+/g, '');
          } else {
            modelName = 'iPhone';
          }
        } else if (/ipad/i.test(rawModel)) {
          modelName = 'iPad';
        } else if (info.brand) {
          modelName = sanitizeFileNamePart(info.brand, 6) || 'Android';
        }
      }
    }
  } catch (e) {}

  var cleanModel = sanitizeFileNamePart(modelName, 10) || 'sub';
  return cleanModel + '-' + cachedCode;
}

function resolveMetaDate(data) {
  if (data.date instanceof Date) return data.date;
  var ts = data.clickTime || data.createdAt || data.triggerTime || data.timestamp;
  if (typeof ts === 'number' && ts > 0) {
    return new Date(ts);
  }
  return new Date();
}

/**
 * 构造直播设备高光文件名：live + (主队)vs(客队) + (节次) + 时间
 * 格式：live_主队vs客队_第1节_20260801_130200.mp4
 * @param {{ teamA?: string, teamB?: string, periodText?: string, date?: Date, clickTime?: number, createdAt?: number, triggerTime?: number }} meta
 * @returns {string}
 */
function buildLiveHighlightFileName(meta) {
  var data = meta && typeof meta === 'object' ? meta : {};
  var teamA = sanitizeFileNamePart(data.teamA || '主队', 10) || '主队';
  var teamB = sanitizeFileNamePart(data.teamB || '客队', 10) || '客队';
  var period = sanitizeFileNamePart(data.periodText || '第1节', 8) || '第1节';
  var timeStr = formatTimestamp(resolveMetaDate(data));

  return 'live_' + teamA + 'vs' + teamB + '_' + period + '_' + timeStr + '.mp4';
}

/**
 * 构造副机拍摄高光文件名：副机设备号 + (主队)vs(客队) + (节次) + 时间
 * 格式：IP14Pro-8A2F_主队vs客队_第1节_20260801_130200.mp4
 * @param {{ teamA?: string, teamB?: string, periodText?: string, date?: Date, clickTime?: number, createdAt?: number, triggerTime?: number }} meta
 * @param {string} [deviceId] 可选指定设备号
 * @returns {string}
 */
function buildSlaveHighlightFileName(meta, deviceId) {
  var data = meta && typeof meta === 'object' ? meta : {};
  var slaveId = sanitizeFileNamePart(deviceId || getSlaveDeviceId(), 14) || 'sub';
  var teamA = sanitizeFileNamePart(data.teamA || '主队', 10) || '主队';
  var teamB = sanitizeFileNamePart(data.teamB || '客队', 10) || '客队';
  var period = sanitizeFileNamePart(data.periodText || '第1节', 8) || '第1节';
  var timeStr = formatTimestamp(resolveMetaDate(data));

  return slaveId + '_' + teamA + 'vs' + teamB + '_' + period + '_' + timeStr + '.mp4';
}

module.exports = {
  sanitizeFileNamePart: sanitizeFileNamePart,
  formatTimestamp: formatTimestamp,
  getSlaveDeviceId: getSlaveDeviceId,
  buildLiveHighlightFileName: buildLiveHighlightFileName,
  buildSlaveHighlightFileName: buildSlaveHighlightFileName
};
