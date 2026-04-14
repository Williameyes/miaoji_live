/**
 * @fileoverview 裂变邀请：待上报邀请人 ID 的持久化、权益到期快照（用于邀请奖励提示）。
 */

/** @const {string} 登录前暂存的邀请人 openid（与产品文档一致） */
const STORAGE_PENDING_REFERRER_KEY = 'pending_referrer';

/** @const {string} 上次已知的权益到期时间戳（毫秒），用于对比 check-status 是否延长 */
const STORAGE_VIP_EXPIRE_SNAPSHOT_MS_KEY = 'vip_expire_snapshot_ms';

/**
 * 从启动 query 中解析邀请人 ID（兼容 from_id / referrerId / referrer_id）。
 * @param {Record<string, string | undefined> | null | undefined} query
 * @returns {string}
 */
function pickReferrerIdFromQuery(query) {
  if (!query || typeof query !== 'object') {
    return '';
  }
  const q = /** @type {Record<string, unknown>} */ (query);
  const keys = ['from_id', 'fromId', 'referrerId', 'referrer_id'];
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i];
    const v = q[k];
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.length > 0) {
        return t;
      }
    }
  }
  return '';
}

/**
 * 若 query 含邀请参数则写入本地，避免用户未登录即关闭小程序导致丢失。
 * @param {Record<string, string | undefined> | null | undefined} query
 * @returns {void}
 */
function persistPendingReferrerFromQuery(query) {
  const id = pickReferrerIdFromQuery(query);
  if (!id) {
    return;
  }
  try {
    wx.setStorageSync(STORAGE_PENDING_REFERRER_KEY, id);
  } catch (e) {
    // 忽略写入异常
  }
}

/**
 * 读取待上报的邀请人 ID。
 * @returns {string}
 */
function readPendingReferrer() {
  try {
    const v = wx.getStorageSync(STORAGE_PENDING_REFERRER_KEY);
    return typeof v === 'string' ? v.trim() : '';
  } catch (e) {
    return '';
  }
}

/**
 * 登录成功后清除待上报邀请人，防止重复绑定。
 * @returns {void}
 */
function clearPendingReferrer() {
  try {
    wx.removeStorageSync(STORAGE_PENDING_REFERRER_KEY);
  } catch (e) {
    try {
      wx.setStorageSync(STORAGE_PENDING_REFERRER_KEY, '');
    } catch (e2) {
      // 忽略
    }
  }
}

/**
 * 将后端 expireAt 规范为毫秒时间戳（支持 ISO 字符串、秒/毫秒数字）。
 * @param {unknown} v
 * @returns {number} 无法解析时为 NaN
 */
function parseExpireAtToMs(v) {
  if (v == null) {
    return NaN;
  }
  if (typeof v === 'number' && !Number.isNaN(v)) {
    return v < 1e12 ? v * 1000 : v;
  }
  if (typeof v === 'string' && v.length > 0) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? NaN : t;
  }
  return NaN;
}

/**
 * 从用户信息对象中取出 expireAt（兼容蛇形命名）。
 * @param {Record<string, unknown> | null | undefined} user
 * @returns {unknown}
 */
function pickExpireAtFromUser(user) {
  if (!user || typeof user !== 'object') {
    return null;
  }
  const u = /** @type {Record<string, unknown>} */ (user);
  if (u.expireAt !== undefined && u.expireAt !== null) {
    return u.expireAt;
  }
  if (u.expire_at !== undefined && u.expire_at !== null) {
    return u.expire_at;
  }
  return null;
}

/**
 * 写入权益到期快照（毫秒），用于与下次 check-status 对比。
 * @param {unknown} expireAt
 * @returns {void}
 */
function writeVipExpireSnapshotMs(expireAt) {
  const ms = parseExpireAtToMs(expireAt);
  if (Number.isNaN(ms)) {
    return;
  }
  try {
    wx.setStorageSync(STORAGE_VIP_EXPIRE_SNAPSHOT_MS_KEY, ms);
  } catch (e) {
    // 忽略
  }
}

/**
 * 读取上次记录的权益到期毫秒时间戳。
 * @returns {number | null}
 */
function readVipExpireSnapshotMs() {
  try {
    const v = wx.getStorageSync(STORAGE_VIP_EXPIRE_SNAPSHOT_MS_KEY);
    if (typeof v === 'number' && !Number.isNaN(v)) {
      return v;
    }
    if (typeof v === 'string' && v.length > 0) {
      const n = Number(v);
      return Number.isNaN(n) ? null : n;
    }
  } catch (e) {
    return null;
  }
  return null;
}

/**
 * 若新到期时间比快照晚超过阈值，视为获得续期（如邀请奖励），并刷新快照。
 * @param {boolean} isVip
 * @param {unknown} expireAt
 * @param {number} minDeltaMs 判定为「明显续期」的最小间隔，默认约 3 天
 * @returns {boolean} 是否应展示续期庆祝提示
 */
function consumeVipExtensionCelebrationIfNeeded(isVip, expireAt, minDeltaMs) {
  const threshold = typeof minDeltaMs === 'number' && minDeltaMs > 0 ? minDeltaMs : 3 * 24 * 60 * 60 * 1000;
  const prev = readVipExpireSnapshotMs();
  const next = parseExpireAtToMs(expireAt);
  if (!isVip || Number.isNaN(next)) {
    writeVipExpireSnapshotMs(expireAt);
    return false;
  }
  if (prev == null) {
    writeVipExpireSnapshotMs(expireAt);
    return false;
  }
  if (next > prev + threshold) {
    writeVipExpireSnapshotMs(expireAt);
    return true;
  }
  writeVipExpireSnapshotMs(expireAt);
  return false;
}

module.exports = {
  STORAGE_PENDING_REFERRER_KEY,
  STORAGE_VIP_EXPIRE_SNAPSHOT_MS_KEY,
  pickReferrerIdFromQuery,
  persistPendingReferrerFromQuery,
  readPendingReferrer,
  clearPendingReferrer,
  parseExpireAtToMs,
  pickExpireAtFromUser,
  writeVipExpireSnapshotMs,
  readVipExpireSnapshotMs,
  consumeVipExtensionCelebrationIfNeeded
};
