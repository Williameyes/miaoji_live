/**
 * @fileoverview 比赛加分事件流水轻量本地存储服务。
 * 遵循高性能设计原则：
 * 1. 独立 Key 分桶存储：`MIAOXIE_SCORE_EVENTS_${matchId}`，不污染比赛主列表；
 * 2. 内存优先：内存挂载，不调用 setData；
 * 3. LRU 自动清理：限制最多存储最近 30 场比赛流水，单场仅 5~8KB，杜绝空间堆积。
 */

const STORAGE_PREFIX = 'MIAOXIE_SCORE_EVENTS_';
const STORAGE_INDEX_KEY = 'MIAOXIE_SCORE_EVENTS_INDEX';
const MAX_STORED_MATCHES = 30;

/**
 * 获取已存储比赛事件流的 matchId 索引列表 (按使用时间倒序)
 * @returns {string[]}
 */
function getStoredMatchIndex() {
  try {
    const raw = wx.getStorageSync(STORAGE_INDEX_KEY);
    if (Array.isArray(raw)) {
      return raw.map(String);
    }
  } catch (e) {}
  return [];
}

/**
 * 更新索引并执行 LRU 淘汰
 * @param {string} matchId
 */
function touchMatchIndex(matchId) {
  if (!matchId) return;
  const strId = String(matchId);
  let index = getStoredMatchIndex().filter((id) => id !== strId);
  index.unshift(strId);

  // 超过最大保留数量时，清理最旧的场次事件
  if (index.length > MAX_STORED_MATCHES) {
    const toRemove = index.slice(MAX_STORED_MATCHES);
    index = index.slice(0, MAX_STORED_MATCHES);
    toRemove.forEach((oldId) => {
      try {
        wx.removeStorageSync(STORAGE_PREFIX + oldId);
      } catch (e) {}
    });
  }

  try {
    wx.setStorageSync(STORAGE_INDEX_KEY, index);
  } catch (e) {}
}

/**
 * 记录单笔得分事件
 * @param {Object} event
 * @param {string|number} event.matchId 比赛 ID
 * @param {number} [event.period] 节次 (1~4, 5+加时)
 * @param {string} [event.gameClock] 比赛时间/倒计时
 * @param {'teamA'|'teamB'|'A'|'B'} event.team 得分方
 * @param {number} event.delta 分值变动 (+1, +2, +3, -1)
 * @param {number} event.scoreA 变动后主队总分
 * @param {number} event.scoreB 变动后客队总分
 * @param {number} [event.timestamp] 事件时间戳
 */
function recordScoreEvent(event) {
  if (!event || !event.matchId) return;
  const matchId = String(event.matchId);
  const key = STORAGE_PREFIX + matchId;

  const item = {
    t: event.timestamp || Math.floor(Date.now() / 1000),
    p: Number(event.period) || 1,
    c: String(event.gameClock || ''),
    tm: (event.team === 'teamA' || event.team === 'A') ? 'A' : 'B',
    d: Number(event.delta) || 0,
    a: Number(event.scoreA) || 0,
    b: Number(event.scoreB) || 0
  };

  try {
    let list = wx.getStorageSync(key);
    if (!Array.isArray(list)) list = [];
    list.push(item);
    wx.setStorageSync(key, list);
    touchMatchIndex(matchId);
  } catch (e) {
    console.warn('[ScoreEventsStorage] recordScoreEvent error:', e);
  }
}

/**
 * 获取指定场次的全部加分事件流水
 * @param {string|number} matchId
 * @returns {Array<Object>}
 */
function getScoreEvents(matchId) {
  if (!matchId) return [];
  const key = STORAGE_PREFIX + String(matchId);
  try {
    const list = wx.getStorageSync(key);
    if (Array.isArray(list)) {
      touchMatchIndex(String(matchId));
      return list;
    }
  } catch (e) {}
  return [];
}

/**
 * 清除指定场次的事件流水 (如已同步到云端后)
 * @param {string|number} matchId
 */
function clearScoreEvents(matchId) {
  if (!matchId) return;
  const strId = String(matchId);
  try {
    wx.removeStorageSync(STORAGE_PREFIX + strId);
    let index = getStoredMatchIndex().filter((id) => id !== strId);
    wx.setStorageSync(STORAGE_INDEX_KEY, index);
  } catch (e) {}
}

module.exports = {
  recordScoreEvent,
  getScoreEvents,
  clearScoreEvents
};
