/**
 * 机型能力评估：判定本机是否进入「增强渲染」白名单。
 *
 * 设计口径（保守优先；宁可漏开，不可误开）：
 *  - iOS：解析 `model` 中 `iPhone N` 主版本号；N >= 12 通过（A14 起）。
 *         例外：`iPhone SE (3rd generation)` 使用 A15，同步通过。
 *         iPad：仅 `iPad Pro` / `iPad Air` 且 iOS >= 14 通过。
 *  - Android：`benchmarkLevel >= 25` 且 Android 主版本 >= 10。
 *             benchmarkLevel 是微信给出的性能基准（非分数，越高越好），
 *             25 档约对应 2020 年旗舰（骁龙 865 级别）。
 *  - 任意解析异常 / 未知 platform → 不通过，保持原生链路。
 *
 * 所有判定基于 `wx.getSystemInfoSync()`；调用成本低，但建议 onLaunch 里只调一次。
 */

/**
 * @typedef {Object} EnhanceWhitelistDecision
 * @property {boolean} enabled       是否通过白名单
 * @property {'lite'|'standard'|'strong'} initialMode 首个目标档位（通过时）
 * @property {string} reason         判定原因，写入诊断日志（如 'ios_iphone_12_pass' / 'android_bench_low'）
 * @property {string} deviceTag      机型短标签，便于日志聚合（如 'iPhone 14 Pro' / 'Mi 11 / Android 13 / bench=28'）
 */

/**
 * 从 `iPhone 12 Pro` / `iPhone15,3` / `iPhone SE (3rd generation)` 等 model 串解析主代号。
 * 返回 -1 表示不是 iPhone 或无法识别。
 * @param {string} model
 * @returns {number}
 */
function parseIphoneMajor(model) {
  if (!model || typeof model !== 'string') return -1;
  var m = model;
  // "iPhone SE (3rd generation)" → A15 芯片，同 iPhone 13 等级
  if (/iPhone\s*SE.*3(rd|ird)/i.test(m)) return 12;
  // "iPhone SE (2nd generation)" → A13，保守不通过
  if (/iPhone\s*SE.*2(nd|ond)/i.test(m)) return 11;
  // 官方展示串："iPhone 14 Pro" / "iPhone 13 mini"
  var humanMatch = m.match(/iPhone\s+(\d+)\b/i);
  if (humanMatch) return parseInt(humanMatch[1], 10);
  // 机器串："iPhone15,3" —— iPhone14 Pro = iPhone15,2/3；iPhone13 = iPhone14,5 etc.
  // 简化映射：iPhone<X>,<Y> 的 X 与「代数」不直接对齐，保守用内部编号：
  //   >=14 → 12 及以上代；>=15 → 14 代
  var codeMatch = m.match(/iPhone(\d+),\d+/i);
  if (codeMatch) {
    var code = parseInt(codeMatch[1], 10);
    if (code >= 14) return 13;   // iPhone14,x = iPhone 13 系列
    if (code >= 13) return 12;   // iPhone13,x = iPhone 12 系列
    return 0;
  }
  return -1;
}

/**
 * 从 `Android 12` / `Android 10.0` 串解析主版本号；-1 表示失败。
 * @param {string} system
 * @returns {number}
 */
function parseAndroidMajor(system) {
  if (!system || typeof system !== 'string') return -1;
  var m = system.match(/Android\s+(\d+)/i);
  if (!m) return -1;
  return parseInt(m[1], 10);
}

/**
 * 评估当前机型是否进入增强渲染白名单。
 * @returns {EnhanceWhitelistDecision}
 */
function evaluateEnhanceRenderWhitelist() {
  var fallback = {
    enabled: false,
    initialMode: 'standard',
    reason: 'eval_init',
    deviceTag: 'unknown'
  };
  var si = null;
  try {
    si = wx.getSystemInfoSync();
  } catch (e) {
    fallback.reason = 'systeminfo_fail';
    return fallback;
  }
  if (!si || typeof si !== 'object') {
    fallback.reason = 'systeminfo_empty';
    return fallback;
  }
  var platform = (si.platform || '').toLowerCase();
  var model = si.model || '';
  var system = si.system || '';
  var benchmarkLevel = (typeof si.benchmarkLevel === 'number') ? si.benchmarkLevel : -1;
  var tag = model + ' / ' + system + ' / bench=' + benchmarkLevel;

  // ---------------- iOS 分支 ----------------
  if (platform === 'ios') {
    // iPad：只要是 iPad Pro / iPad Air 且 iOS >= 14 则通过
    if (/iPad/i.test(model)) {
      var iosMatch = system.match(/iOS\s+(\d+)/i);
      var iosMajor = iosMatch ? parseInt(iosMatch[1], 10) : 0;
      if (iosMajor >= 14 && /iPad\s*(Pro|Air)/i.test(model)) {
        return { enabled: true, initialMode: 'standard', reason: 'ios_ipad_pass', deviceTag: tag };
      }
      return { enabled: false, initialMode: 'standard', reason: 'ios_ipad_reject', deviceTag: tag };
    }
    var major = parseIphoneMajor(model);
    if (major >= 12) {
      // 14+ 可放开到 'strong' 起手；12/13 保守 'standard'
      var initial = (major >= 14) ? 'standard' : 'standard';
      return { enabled: true, initialMode: initial, reason: 'ios_iphone_' + major + '_pass', deviceTag: tag };
    }
    return { enabled: false, initialMode: 'standard', reason: 'ios_iphone_below_12', deviceTag: tag };
  }

  // ---------------- Android 分支 ----------------
  if (platform === 'android') {
    var androidMajor = parseAndroidMajor(system);
    if (androidMajor < 10) {
      return { enabled: false, initialMode: 'standard', reason: 'android_os_low', deviceTag: tag };
    }
    if (benchmarkLevel < 0) {
      // 无法获得 benchmarkLevel（部分旧基础库返回 -1 或未提供），保守关闭
      return { enabled: false, initialMode: 'standard', reason: 'android_bench_unknown', deviceTag: tag };
    }
    if (benchmarkLevel < 25) {
      return { enabled: false, initialMode: 'standard', reason: 'android_bench_low', deviceTag: tag };
    }
    // benchmark 40+ 的旗舰再放开 standard；25~39 使用 lite 起手更稳妥
    var androidInitial = (benchmarkLevel >= 40) ? 'standard' : 'lite';
    return {
      enabled: true,
      initialMode: androidInitial,
      reason: 'android_bench_pass_' + benchmarkLevel,
      deviceTag: tag
    };
  }

  // devtools / mac / windows —— 开发环境
  if (platform === 'devtools') {
    return { enabled: true, initialMode: 'standard', reason: 'devtools', deviceTag: tag };
  }

  return { enabled: false, initialMode: 'standard', reason: 'unknown_platform_' + platform, deviceTag: tag };
}

/**
 * @typedef {Object} VkSupportDecision
 * @property {boolean} supported
 * @property {string} reason
 * @property {string} deviceTag
 * @property {number} evaluatedAt
 */

/** Storage key；同时记录评估时间，7 天后重新评估（机型不会变，但基础库/微信 App 会升级）。 */
var VK_SUPPORT_CACHE_KEY = 'VK_SUPPORT_LEVEL';
var VK_SUPPORT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 判定本机是否支持 VKSession v2 独立管线。
 * 比"增强渲染白名单"更严格：因为 VK 模式要求零容忍崩溃与较高 GPU 预算。
 *
 * 通过口径：
 *  - `typeof wx.createVKSession === 'function'`（基础库 2.20.0+）
 *  - iOS：iPhone 13+（A15 起）或系统 iOS 15+
 *  - Android：benchmarkLevel >= 30 且 Android >= 11
 *
 * @returns {VkSupportDecision}
 */
function evaluateVkSupport() {
  var now = Date.now();
  var fallback = { supported: false, reason: 'init', deviceTag: 'unknown', evaluatedAt: now };

  if (typeof wx.createVKSession !== 'function') {
    fallback.reason = 'vk_api_missing';
    return fallback;
  }

  var si = null;
  try { si = wx.getSystemInfoSync(); } catch (e) { fallback.reason = 'systeminfo_fail'; return fallback; }
  if (!si) { fallback.reason = 'systeminfo_empty'; return fallback; }

  var platform = (si.platform || '').toLowerCase();
  var model = si.model || '';
  var system = si.system || '';
  var bench = (typeof si.benchmarkLevel === 'number') ? si.benchmarkLevel : -1;
  var tag = model + ' / ' + system + ' / bench=' + bench;

  if (platform === 'ios') {
    if (/iPad/i.test(model)) {
      var iosMajor0 = 0;
      var m0 = system.match(/iOS\s+(\d+)/i);
      if (m0) iosMajor0 = parseInt(m0[1], 10);
      if (iosMajor0 >= 15 && /iPad\s*(Pro|Air)/i.test(model)) {
        return { supported: true, reason: 'vk_ipad_pass', deviceTag: tag, evaluatedAt: now };
      }
      return { supported: false, reason: 'vk_ipad_reject', deviceTag: tag, evaluatedAt: now };
    }
    var major = parseIphoneMajor(model);
    if (major >= 13) {
      return { supported: true, reason: 'vk_iphone_' + major + '_pass', deviceTag: tag, evaluatedAt: now };
    }
    return { supported: false, reason: 'vk_iphone_' + major + '_reject', deviceTag: tag, evaluatedAt: now };
  }

  if (platform === 'android') {
    var aMajor = parseAndroidMajor(system);
    if (aMajor < 11) {
      return { supported: false, reason: 'vk_android_os_low_' + aMajor, deviceTag: tag, evaluatedAt: now };
    }
    if (bench < 30) {
      return { supported: false, reason: 'vk_android_bench_low_' + bench, deviceTag: tag, evaluatedAt: now };
    }
    return { supported: true, reason: 'vk_android_pass_' + bench, deviceTag: tag, evaluatedAt: now };
  }

  if (platform === 'devtools') {
    return { supported: true, reason: 'vk_devtools', deviceTag: tag, evaluatedAt: now };
  }
  return { supported: false, reason: 'vk_unknown_platform_' + platform, deviceTag: tag, evaluatedAt: now };
}

/**
 * 带缓存的 VK 支持判定：7 天内读 Storage，过期 / 无效时重新评估并写回。
 * 写 Storage 使用同步接口（cache 体积极小 ~80 字节），失败吞掉不影响主流程。
 *
 * @returns {VkSupportDecision}
 */
function evaluateVkSupportCached() {
  var cached = null;
  try { cached = wx.getStorageSync(VK_SUPPORT_CACHE_KEY); } catch (eGet) {}
  if (cached && typeof cached === 'object' && typeof cached.supported === 'boolean') {
    var age = Date.now() - (cached.evaluatedAt || 0);
    if (age >= 0 && age < VK_SUPPORT_CACHE_TTL_MS) {
      cached.reason = (cached.reason || '') + '(cached)';
      return cached;
    }
  }
  var fresh = evaluateVkSupport();
  try { wx.setStorageSync(VK_SUPPORT_CACHE_KEY, fresh); } catch (eSet) {}
  return fresh;
}

module.exports = {
  evaluateEnhanceRenderWhitelist: evaluateEnhanceRenderWhitelist,
  evaluateVkSupport: evaluateVkSupport,
  evaluateVkSupportCached: evaluateVkSupportCached
};
