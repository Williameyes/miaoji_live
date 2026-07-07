/**
 * @fileoverview 投篮训练：抛物线轨迹 FSM（检测由 YOLO 模块提供框中心）。
 *
 * 设计要点：
 *  - feedDetection 接收 ML 检测框中心 + 置信度
 *  - 用多帧上升/下落计数代替单帧 dy 抖动判定
 *  - 轨迹点不足或间隔过长时重置，但保留较宽间隙以适配 ML 推理帧率
 */

/** FSM 状态 */
var STATE_IDLE = 'IDLE';
var STATE_RISING = 'RISING';
var STATE_APEX = 'APEX';
var STATE_FALLING = 'FALLING';
var STATE_COOLDOWN = 'COOLDOWN';

/** 轨迹队列上限 */
var TRAJECTORY_MAX_LEN = 24;
/** 冷却 ms */
var COOLDOWN_MS = 1200;
/** 连续检测帧数门槛（ML 检测稀疏，单帧即可进轨迹） */
var CONFIRM_STREAK = 1;
/** 进入轨迹的最低置信度 */
var MIN_CONFIDENCE = 0.22;
/** 无检测超时重置 ms */
var GAP_RESET_MS = 520;

/**
 * 判断点是否在篮筐排除区内（含护框余量，用于屏蔽篮网静止假阳性）。
 * @param {number} x
 * @param {number} y
 * @param {Object} hoop
 * @param {number} padRatio
 * @returns {boolean}
 */
function isInsideHoopZone(x, y, hoop, padRatio) {
  var w = hoop.right - hoop.left;
  var h = hoop.bottom - hoop.top;
  var padX = w * (padRatio || 0.12);
  var padY = h * (padRatio || 0.12);
  return x >= hoop.left - padX && x <= hoop.right + padX &&
    y >= hoop.top - padY && y <= hoop.bottom + padY;
}

/**
 * 校验是否为真实投篮轨迹（排除篮网抖动等假阳性）。
 * @param {{x:number,y:number,t:number}[]} q
 * @param {Object} hoop
 * @param {{width:number,height:number}} layout
 * @returns {boolean}
 */
function validateShotTrajectory(q, hoop, layout) {
  if (!q || q.length < 8 || !hoop || !layout) return false;

  var len = q.length;
  var start = q[0];
  var apexY = queueMinY(q);
  var arcHeight = queueMaxY(q) - apexY;
  var minArc = layout.height * 0.07;
  var duration = q[len - 1].t - q[0].t;

  if (duration < 380 || duration > 3000) return false;
  if (arcHeight < minArc) return false;
  if (start.y < hoop.top - layout.height * 0.04) return false;
  if (apexY > hoop.top - layout.height * 0.025) return false;

  var insideHoop = 0;
  var i;
  for (i = 0; i < len; i++) {
    if (isInsideHoopZone(q[i].x, q[i].y, hoop, 0.08)) insideHoop++;
  }
  if (insideHoop / len > 0.55) return false;

  var rf = countRiseFall(q, Math.max(2, layout.height * 0.0025));
  if (rf.rise < 2 || rf.fall < 2) return false;

  return true;
}

/**
 * @param {{x:number,y:number,t:number}[]} q
 * @returns {number}
 */
function queueMinY(q) {
  var m = q[0].y;
  for (var i = 1; i < q.length; i++) {
    if (q[i].y < m) m = q[i].y;
  }
  return m;
}

/**
 * @param {{x:number,y:number,t:number}[]} q
 * @returns {number}
 */
function queueMaxY(q) {
  var m = q[0].y;
  for (var i = 1; i < q.length; i++) {
    if (q[i].y > m) m = q[i].y;
  }
  return m;
}

/**
 * @param {{x:number,y:number,t:number}[]} q
 * @param {number} minDy
 * @returns {{rise: number, fall: number}}
 */
function countRiseFall(q, minDy) {
  var rise = 0;
  var fall = 0;
  for (var i = 1; i < q.length; i++) {
    var dy = q[i].y - q[i - 1].y;
    if (dy < -minDy) rise++;
    if (dy > minDy) fall++;
  }
  return { rise: rise, fall: fall };
}

/**
 * 投篮轨迹追踪器（仅 FSM，不含检测）。
 * @param {Object} [opts]
 * @param {function():{width:number,height:number}|null} [opts.getLayout]
 * @param {function():Object|null} [opts.getHoopROI]
 * @param {function():Object|null} [opts.getTrackingROI]
 * @param {function(string, string):void} [opts.onLog]
 */
function createShotTracker(opts) {
  opts = opts || {};
  var queue = [];
  var state = STATE_IDLE;
  var cooldownUntil = 0;
  var confirmStreak = 0;
  var lastDetectVp = null;
  var lastPointAt = 0;
  var lastConfidence = 0;
  var trackAcceptCount = 0;
  var stateChangeCount = 0;

  /**
   * @param {string} tag
   * @param {string} msg
   * @returns {void}
   */
  function log(tag, msg) {
    if (typeof opts.onLog === 'function') opts.onLog(tag, msg);
  }

  /**
   * @param {string} next
   * @returns {void}
   */
  function setState(next) {
    if (state === next) return;
    log('FSM', state + ' -> ' + next + ' q=' + queue.length);
    state = next;
    stateChangeCount++;
  }

  /**
   * @returns {void}
   */
  function resetTrajectory() {
    queue = [];
    if (state !== STATE_COOLDOWN) setState(STATE_IDLE);
    confirmStreak = 0;
    lastDetectVp = null;
  }

  /**
   * @param {{x:number,y:number,confidence:number}} ball
   * @param {number} now
   * @returns {Object}
   */
  function feedDetection(ball, now) {
    if (state === STATE_COOLDOWN) {
      if (now < cooldownUntil) {
        return { event: 'none', ballX: null, ballY: null, state: state, trail: queueSnapshot() };
      }
      setState(STATE_IDLE);
      resetTrajectory();
    }

    var layout = opts.getLayout ? opts.getLayout() : null;
    var roi = opts.getTrackingROI ? opts.getTrackingROI() : null;
    if (!layout || !roi) {
      return { event: 'none', ballX: null, ballY: null, state: state, trail: [] };
    }

    lastConfidence = ball.confidence;

    if (ball.x < roi.left || ball.x > roi.right || ball.y < roi.top || ball.y > roi.bottom) {
      return handleGap(now);
    }

    if (ball.confidence < MIN_CONFIDENCE) {
      return handleGap(now);
    }

    var hoop = opts.getHoopROI ? opts.getHoopROI() : null;
    if (hoop && isInsideHoopZone(ball.x, ball.y, hoop, 0.1)) {
      var prevInHoop = queue.length > 0 &&
        isInsideHoopZone(queue[queue.length - 1].x, queue[queue.length - 1].y, hoop, 0.1);
      if (queue.length === 0 || prevInHoop) {
        return handleGap(now);
      }
    }

    if (ball.confidence >= 0.98) {
      confirmStreak = CONFIRM_STREAK;
    } else if (lastDetectVp) {
      var ddx = ball.x - lastDetectVp.x;
      var ddy = ball.y - lastDetectVp.y;
      var jump = Math.sqrt(ddx * ddx + ddy * ddy);
      if (jump > layout.height * 0.22) {
        resetTrajectory();
        lastDetectVp = { x: ball.x, y: ball.y };
        confirmStreak = 1;
        return { event: 'none', ballX: ball.x, ballY: ball.y, state: state, trail: queueSnapshot() };
      }
      if (jump < layout.height * 0.14) confirmStreak++;
      else confirmStreak = 1;
    } else {
      confirmStreak = 1;
    }
    lastDetectVp = { x: ball.x, y: ball.y };

    if (confirmStreak < CONFIRM_STREAK) {
      return { event: 'none', ballX: ball.x, ballY: ball.y, state: state, trail: queueSnapshot() };
    }

    if (queue.length > 0) {
      var last = queue[queue.length - 1];
      if (now - last.t > GAP_RESET_MS) {
        queue = [];
        setState(STATE_IDLE);
      }
    }

    queue.push({ x: ball.x, y: ball.y, t: now });
    if (queue.length > TRAJECTORY_MAX_LEN) queue.shift();
    lastPointAt = now;
    trackAcceptCount++;

    var settle = updateFsm(now, layout);
    if (settle) return settle;
    return {
      event: 'none',
      ballX: ball.x,
      ballY: ball.y,
      state: state,
      trail: queueSnapshot()
    };
  }

  /**
   * @returns {{x:number,y:number}[]}
   */
  function queueSnapshot() {
    return queue.map(function (p) { return { x: p.x, y: p.y }; });
  }

  /**
   * @param {number} now
   * @returns {Object}
   */
  function handleGap(now) {
    if (lastPointAt && now - lastPointAt > GAP_RESET_MS) {
      resetTrajectory();
    }
    confirmStreak = Math.max(0, confirmStreak - 1);
    if (confirmStreak === 0) lastDetectVp = null;
    return { event: 'none', ballX: null, ballY: null, state: state, trail: queueSnapshot() };
  }

  /**
   * @param {number} now
   * @param {{width:number,height:number}} layout
   * @returns {Object|null}
   */
  function updateFsm(now, layout) {
    if (queue.length < 4) return null;

    var hoop = opts.getHoopROI ? opts.getHoopROI() : null;
    if (!hoop) return null;

    var len = queue.length;
    var minDy = Math.max(2, layout.height * 0.0022);
    var rf = countRiseFall(queue, minDy);
    var arcHeight = queueMaxY(queue) - queueMinY(queue);
    var minArc = layout.height * 0.055;
    var duration = queue[len - 1].t - queue[0].t;
    var apexY = queueMinY(queue);

    switch (state) {
      case STATE_IDLE:
        if (rf.rise >= 2 && arcHeight >= minArc * 0.28) setState(STATE_RISING);
        break;
      case STATE_RISING:
        if (rf.fall >= 2 && arcHeight >= minArc * 0.42) {
          setState(STATE_FALLING);
        } else if (rf.rise >= 1 && rf.fall === 0 && arcHeight >= minArc * 0.32) {
          setState(STATE_APEX);
        }
        break;
      case STATE_APEX:
        if (rf.fall >= 2 && arcHeight >= minArc * 0.42) setState(STATE_FALLING);
        break;
      case STATE_FALLING:
        if (arcHeight < minArc * 0.85 || duration < 320 || duration > 3200) break;
        if (apexY > hoop.top + (hoop.bottom - hoop.top) * 0.55) break;

        var cur = queue[len - 1];
        var prev = queue[len - 2];
        var nearHoopX = Math.abs(cur.x - hoop.centerX) <= hoop.width * 0.75;

        if (lineIntersectsRect(prev, cur, hoop)) {
          return tryFinishShot(true, now, hoop, layout);
        }
        if (cur.y > hoop.bottom + layout.height * 0.015 && nearHoopX && rf.fall >= 2) {
          return tryFinishShot(false, now, hoop, layout);
        }
        if (cur.y > hoop.bottom + layout.height * 0.18) {
          resetTrajectory();
          setState(STATE_IDLE);
        }
        break;
    }
    return null;
  }

  /**
   * 完成投篮前校验轨迹，拒绝篮网等假阳性。
   * @param {boolean} isMade
   * @param {number} now
   * @param {Object} hoop
   * @param {{width:number,height:number}} layout
   * @returns {Object|null}
   */
  function tryFinishShot(isMade, now, hoop, layout) {
    if (!validateShotTrajectory(queue, hoop, layout)) {
      log('SHOT', 'rejected spurious ' + (isMade ? 'made' : 'miss'));
      resetTrajectory();
      setState(STATE_IDLE);
      return null;
    }
    return finishShot(isMade, now);
  }

  /**
   * @param {boolean} isMade
   * @param {number} now
   * @returns {Object}
   */
  function finishShot(isMade, now) {
    log('SHOT', isMade ? 'MADE q=' + queue.length : 'MISS q=' + queue.length);
    setState(STATE_COOLDOWN);
    cooldownUntil = now + COOLDOWN_MS;
    queue = [];
    confirmStreak = 0;
    lastDetectVp = null;
    lastPointAt = 0;
    return {
      event: isMade ? 'made' : 'missed',
      ballX: null,
      ballY: null,
      state: state,
      trail: []
    };
  }

  /**
   * @param {{x:number,y:number}} p1
   * @param {{x:number,y:number}} p2
   * @param {Object} r
   * @returns {boolean}
   */
  function lineIntersectsRect(p1, p2, r) {
    if (p1.x >= r.left && p1.x <= r.right && p1.y >= r.top && p1.y <= r.bottom) return true;
    if (p2.x >= r.left && p2.x <= r.right && p2.y >= r.top && p2.y <= r.bottom) return true;
    return (
      segIntersect(p1, p2, { x: r.left, y: r.top }, { x: r.right, y: r.top }) ||
      segIntersect(p1, p2, { x: r.right, y: r.top }, { x: r.right, y: r.bottom }) ||
      segIntersect(p1, p2, { x: r.right, y: r.bottom }, { x: r.left, y: r.bottom }) ||
      segIntersect(p1, p2, { x: r.left, y: r.bottom }, { x: r.left, y: r.top })
    );
  }

  /**
   * @param {{x:number,y:number}} a1
   * @param {{x:number,y:number}} a2
   * @param {{x:number,y:number}} b1
   * @param {{x:number,y:number}} b2
   * @returns {boolean}
   */
  function segIntersect(a1, a2, b1, b2) {
    var det = (a2.x - a1.x) * (b2.y - b1.y) - (b2.x - b1.x) * (a2.y - a1.y);
    if (det === 0) return false;
    var lambda = ((b2.y - b1.y) * (b2.x - a1.x) + (b1.x - b2.x) * (b2.y - a1.y)) / det;
    var gamma = ((a1.y - a2.y) * (b2.x - a1.x) + (a2.x - a1.x) * (b2.y - a1.y)) / det;
    return lambda > 0 && lambda < 1 && gamma > 0 && gamma < 1;
  }

  return {
    feedDetection: feedDetection,
    onNoDetection: handleGap,
    reset: function () {
      queue = [];
      state = STATE_IDLE;
      cooldownUntil = 0;
      confirmStreak = 0;
      lastDetectVp = null;
      lastPointAt = 0;
      lastConfidence = 0;
      trackAcceptCount = 0;
      stateChangeCount = 0;
    },
    getState: function () { return state; },
    getStats: function () {
      return {
        state: state,
        queueLen: queue.length,
        confirmStreak: confirmStreak,
        trackAccept: trackAcceptCount,
        stateChanges: stateChangeCount,
        lastConfidence: lastConfidence
      };
    }
  };
}

module.exports = {
  createShotTracker: createShotTracker,
  STATE_COOLDOWN: STATE_COOLDOWN
};
