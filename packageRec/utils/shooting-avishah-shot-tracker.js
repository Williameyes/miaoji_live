/**
 * @fileoverview 投篮计分：移植 avishah3 shot_detector.py + utils.py 逻辑。
 *
 * 使用 YOLO 检测的篮球/篮筐框中心，配合 clean_ball_pos、detect_up/down、score 判定进球。
 * 真机推理帧率低于 Python 视频逐帧时，辅以轨迹历史兜底触发投篮。
 */

/** 篮球历史保留帧数上限（稀疏推理需更长窗口） */
var BALL_HISTORY_MAX_AGE = 60;
/** 篮筐历史最大长度 */
var HOOP_HISTORY_MAX = 25;
/** 判定投篮周期 */
var SHOT_CHECK_INTERVAL = 3;
/** 参与轨迹的最低篮球置信度 */
var TRACK_BALL_CONF = 0.08;
/** 一次投篮弧线在推理帧上的最大跨度（稀疏帧需放宽，~17s@80ms） */
var MAX_SHOT_ARC_FRAMES = 220;
/** 弧线上下点最少间隔帧 */
var MIN_SHOT_ARC_FRAMES = 2;
/** sparse 模式上下点最少间隔帧数（避免 upF=871 downF=872 噪点误触发） */
var SPARSE_MIN_FRAME_GAP = 4;
/** 参与轨迹的最低篮筐置信度（对齐 Python 0.5） */
var TRACK_HOOP_CONF = 0.5;
/** 触发投篮判定的最少轨迹点数 */
var MIN_BALL_TRAIL_FOR_SHOT = 2;
/** 进球判定水平容差（像素，对齐 Python hoop_rebound_zone=10） */
var SCORE_REBOUND_PX = 12;
/** 回归 predX 相对筐中心最大合理偏移（倍筐宽） */
var SCORE_PREDX_MAX_HW = 2.5;
/** clean_ball_pos 跳点容忍：推理帧间隔大时放宽 */
var CLEAN_BALL_MAX_FRAME_GAP = 30;
/** 投篮冷却（ms） */
var SHOT_COOLDOWN_MS = 320;

/**
 * @typedef {Object} TrackPoint
 * @property {number} x 视口 X
 * @property {number} y 视口 Y
 * @property {number} frame 帧序号
 * @property {number} w 视口宽
 * @property {number} h 视口高
 * @property {number} conf 置信度
 */

/**
 * 两点线性拟合 y = m*x + b。
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {{m:number,b:number}|null}
 */
function lineFit2(x1, y1, x2, y2) {
  if (x1 === x2) return null;
  var m = (y2 - y1) / (x2 - x1);
  return { m: m, b: y1 - m * x1 };
}

/**
 * 计分用轨迹：仅保留篮筐水平方向附近的点，避免稀疏噪点拉偏回归。
 * @param {TrackPoint[]} ballPos
 * @param {TrackPoint} hoop
 * @returns {TrackPoint[]}
 */
function filterScoreTrail(ballPos, hoop) {
  var x1 = hoop.x - 3 * hoop.w;
  var x2 = hoop.x + 3 * hoop.w;
  var filtered = [];
  var i;
  for (i = 0; i < ballPos.length; i++) {
    if (ballPos[i].x >= x1 && ballPos[i].x <= x2) {
      filtered.push(ballPos[i]);
    }
  }
  return filtered.length >= 2 ? filtered : ballPos;
}

/**
 * 解析本帧用于计分/FSM 的篮筐（优先用户校准 ROI，YOLO 筐位在日志中常偏移）。
 * @param {{calibratedHoop:Object|null,hoop:Object|null}} detection
 * @param {TrackPoint[]} hoopPos
 * @param {number} frameCount
 * @returns {TrackPoint[]}
 */
function resolveHoopTrack(detection, hoopPos, frameCount) {
  if (detection.calibratedHoop) {
    var c = detection.calibratedHoop;
    return [{
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      frame: frameCount,
      conf: 1
    }];
  }
  return hoopPos.length ? hoopPos : [];
}

/**
 * 收集筐水平线附近的轨迹点（用于回归计分）。
 * @param {TrackPoint[]} trail
 * @param {number} rimHeight
 * @param {TrackPoint} hoop
 * @returns {TrackPoint[]}
 */
function collectRimApproachPoints(trail, rimHeight, hoop) {
  var margin = hoop.h * 0.4;
  var x1 = hoop.x - 2.2 * hoop.w;
  var x2 = hoop.x + 2.2 * hoop.w;
  var out = [];
  var i;
  for (i = 0; i < trail.length; i++) {
    var p = trail[i];
    if (p.x >= x1 && p.x <= x2 && p.y < rimHeight + margin) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 轨迹是否曾有球心穿过筐口水平带（回归失真时的兜底）。
 * @param {TrackPoint[]} trail
 * @param {TrackPoint} hoop
 * @param {number} rimHeight
 * @returns {boolean}
 */
function hasBallThroughRimBand(trail, hoop, rimHeight) {
  var rimX1 = hoop.x - 0.45 * hoop.w;
  var rimX2 = hoop.x + 0.45 * hoop.w;
  var yLo = rimHeight - hoop.h * 0.25;
  var yHi = rimHeight + hoop.h * 0.55;
  var i;
  for (i = 0; i < trail.length; i++) {
    var p = trail[i];
    if (p.y >= yLo && p.y <= yHi && p.x > rimX1 && p.x < rimX2) {
      return true;
    }
  }
  return false;
}

/**
 * 是否进球（线性回归穿框；校准筐 + 穿筐带兜底）。
 * @param {TrackPoint[]} ballPos
 * @param {TrackPoint[]} hoopPos
 * @returns {boolean}
 */
function scoreShot(ballPos, hoopPos) {
  if (!ballPos.length || !hoopPos.length) return false;
  var hoop = hoopPos[hoopPos.length - 1];
  var trail = filterScoreTrail(ballPos, hoop);
  var rimHeight = hoop.y - 0.5 * hoop.h;

  if (hasBallThroughRimBand(trail, hoop, rimHeight)) {
    return true;
  }
  var rimPoints = collectRimApproachPoints(trail, rimHeight, hoop);
  var rebound = SCORE_REBOUND_PX;
  var x = [];
  var y = [];
  var i;

  if (rimPoints.length >= 2) {
    x.push(rimPoints[0].x);
    y.push(rimPoints[0].y);
    x.push(rimPoints[rimPoints.length - 1].x);
    y.push(rimPoints[rimPoints.length - 1].y);
  } else {
    for (i = trail.length - 1; i >= 0; i--) {
      if (trail[i].y < rimHeight) {
        x.push(trail[i].x);
        y.push(trail[i].y);
        if (i + 1 < trail.length) {
          x.push(trail[i + 1].x);
          y.push(trail[i + 1].y);
        }
        break;
      }
    }
  }

  if (x.length < 2) {
    return hasBallThroughRimBand(trail, hoop, rimHeight);
  }

  var fit = lineFit2(x[0], y[0], x[1], y[1]);
  if (!fit || Math.abs(fit.m) < 1e-6) {
    return hasBallThroughRimBand(trail, hoop, rimHeight);
  }

  var predictedX = (rimHeight - fit.b) / fit.m;
  var rimX1 = hoop.x - 0.4 * hoop.w;
  var rimX2 = hoop.x + 0.4 * hoop.w;
  var maxOff = SCORE_PREDX_MAX_HW * hoop.w;

  if (Math.abs(predictedX - hoop.x) > maxOff) {
    return hasBallThroughRimBand(trail, hoop, rimHeight);
  }

  if (rimX1 < predictedX && predictedX < rimX2) return true;
  if (rimX1 - rebound < predictedX && predictedX < rimX2 + rebound) return true;
  return false;
}

/**
 * 球是否在篮筐下方区域（detect_down，对齐 Python 末点）。
 * @param {TrackPoint[]} ballPos
 * @param {TrackPoint[]} hoopPos
 * @returns {boolean}
 */
function detectDown(ballPos, hoopPos) {
  if (!ballPos.length || !hoopPos.length) return false;
  var hoop = hoopPos[hoopPos.length - 1];
  var yLine = hoop.y + 0.5 * hoop.h;
  return ballPos[ballPos.length - 1].y > yLine;
}

/**
 * 球是否在篮筐上方/backboard 区域（detect_up，对齐 Python 末点）。
 * @param {TrackPoint[]} ballPos
 * @param {TrackPoint[]} hoopPos
 * @returns {boolean}
 */
function detectUp(ballPos, hoopPos) {
  if (!ballPos.length || !hoopPos.length) return false;
  var hoop = hoopPos[hoopPos.length - 1];
  var ball = ballPos[ballPos.length - 1];
  var x1 = hoop.x - 4 * hoop.w;
  var x2 = hoop.x + 4 * hoop.w;
  var y1 = hoop.y - 2 * hoop.h;
  var y2 = hoop.y - 0.5 * hoop.h;
  return ball.x > x1 && ball.x < x2 && ball.y > y1 && ball.y < y2;
}

/**
 * 轨迹中是否曾在篮筐上方（稀疏帧：筐上方即可，不要求篮板大区域）。
 * @param {TrackPoint[]} ballPos
 * @param {TrackPoint[]} hoopPos
 * @returns {boolean}
 */
function detectUpFromHistory(ballPos, hoopPos) {
  if (!ballPos.length || !hoopPos.length) return false;
  var hoop = hoopPos[hoopPos.length - 1];
  var rimY = hoop.y - 0.5 * hoop.h;
  var x1 = hoop.x - 3.5 * hoop.w;
  var x2 = hoop.x + 3.5 * hoop.w;
  var i;
  for (i = 0; i < ballPos.length; i++) {
    var b = ballPos[i];
    if (b.x > x1 && b.x < x2 && b.y < rimY + hoop.h * 0.45) {
      return true;
    }
  }
  return false;
}

/**
 * 轨迹中是否曾在篮筐下方（稀疏帧兜底）。
 * @param {TrackPoint[]} ballPos
 * @param {TrackPoint[]} hoopPos
 * @returns {boolean}
 */
function detectDownFromHistory(ballPos, hoopPos) {
  if (!ballPos.length || !hoopPos.length) return false;
  var hoop = hoopPos[hoopPos.length - 1];
  var belowY = hoop.y + 0.5 * hoop.h;
  var i;
  for (i = 0; i < ballPos.length; i++) {
    if (ballPos[i].y > belowY) {
      return true;
    }
  }
  return false;
}

/**
 * 轨迹中 up 点最早帧号。
 * @param {TrackPoint[]} ballPos
 * @param {TrackPoint[]} hoopPos
 * @returns {number}
 */
function findUpFrame(ballPos, hoopPos) {
  var hoop = hoopPos[hoopPos.length - 1];
  var rimY = hoop.y - 0.5 * hoop.h;
  var x1 = hoop.x - 3.5 * hoop.w;
  var x2 = hoop.x + 3.5 * hoop.w;
  var i;
  for (i = 0; i < ballPos.length; i++) {
    var b = ballPos[i];
    if (b.x > x1 && b.x < x2 && b.y < rimY + hoop.h * 0.45) {
      return b.frame;
    }
  }
  return 0;
}

/**
 * 轨迹是否穿过篮筐水平线（下落方向，真机常见：只在筐附近才检出球）。
 * @param {TrackPoint[]} ballPos
 * @param {TrackPoint[]} hoopPos
 * @returns {{cross:boolean,crossFrame:number}}
 */
function detectRimCross(ballPos, hoopPos) {
  if (ballPos.length < 2 || !hoopPos.length) {
    return { cross: false, crossFrame: 0 };
  }
  var hoop = hoopPos[hoopPos.length - 1];
  var rimY = hoop.y - 0.5 * hoop.h;
  var x1 = hoop.x - 2.8 * hoop.w;
  var x2 = hoop.x + 2.8 * hoop.w;
  var i;
  for (i = 1; i < ballPos.length; i++) {
    var a = ballPos[i - 1];
    var b = ballPos[i];
    if (a.x < x1 || a.x > x2 || b.x < x1 || b.x > x2) {
      continue;
    }
    if (a.y < rimY && b.y >= rimY - hoop.h * 0.2) {
      return { cross: true, crossFrame: b.frame };
    }
  }
  return { cross: false, crossFrame: 0 };
}

/**
 * 移动端投篮周期：筐上→筐下 或 穿筐线。
 * @param {TrackPoint[]} ballPos
 * @param {TrackPoint[]} hoopPos
 * @returns {{ok:boolean,mode:string,upF:number,downF:number}}
 */
function detectMobileShotCycle(ballPos, hoopPos) {
  if (ballPos.length < MIN_BALL_TRAIL_FOR_SHOT || !hoopPos.length) {
    return { ok: false, mode: '', upF: 0, downF: 0 };
  }
  var hoop = hoopPos[hoopPos.length - 1];
  var rimY = hoop.y - 0.5 * hoop.h;
  var belowY = hoop.y + 0.4 * hoop.h;
  var x1 = hoop.x - 3.5 * hoop.w;
  var x2 = hoop.x + 3.5 * hoop.w;
  var rimCross = detectRimCross(ballPos, hoopPos);
  var downF;
  var upF;
  var gap;
  var i;

  if (rimCross.cross) {
    downF = findDownFrame(ballPos, hoopPos);
    upF = findUpFrame(ballPos, hoopPos) || rimCross.crossFrame;
    if (downF > 0 && upF > 0 && downF >= upF) {
      gap = downF - upF;
      if (gap <= MAX_SHOT_ARC_FRAMES) {
        return { ok: true, mode: 'cross', upF: upF, downF: downF };
      }
    }
  }

  upF = 0;
  downF = 0;
  for (i = 0; i < ballPos.length; i++) {
    var p = ballPos[i];
    if (!upF && p.x > x1 && p.x < x2 && p.y < rimY + hoop.h * 0.55) {
      upF = p.frame;
    }
    if (upF && p.frame >= upF && p.y > belowY) {
      downF = p.frame;
      break;
    }
  }
  if (upF > 0 && downF > 0 && downF > upF) {
    gap = downF - upF;
    if (gap >= MIN_SHOT_ARC_FRAMES && gap <= MAX_SHOT_ARC_FRAMES) {
      return { ok: true, mode: 'arc', upF: upF, downF: downF };
    }
  }
  return { ok: false, mode: '', upF: upF, downF: downF };
}

/**
 * 轨迹中 down 点最早帧号。
 * @param {TrackPoint[]} ballPos
 * @param {TrackPoint[]} hoopPos
 * @returns {number}
 */
function findDownFrame(ballPos, hoopPos) {
  var hoop = hoopPos[hoopPos.length - 1];
  var belowY = hoop.y + 0.5 * hoop.h;
  var i;
  for (i = 0; i < ballPos.length; i++) {
    if (ballPos[i].y > belowY) {
      return ballPos[i].frame;
    }
  }
  return 0;
}

/**
 * 清洗篮球轨迹点（移植 utils.clean_ball_pos）。
 * @param {TrackPoint[]} ballPos
 * @param {number} frameCount
 * @returns {TrackPoint[]}
 */
function cleanBallPos(ballPos, frameCount) {
  if (ballPos.length > 1) {
    var p1 = ballPos[ballPos.length - 2];
    var p2 = ballPos[ballPos.length - 1];
    var fDif = p2.frame - p1.frame;
    var dx = p2.x - p1.x;
    var dy = p2.y - p1.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var maxDist = 5 * Math.sqrt(p1.w * p1.w + p1.h * p1.h);
    if (dist > maxDist && fDif < CLEAN_BALL_MAX_FRAME_GAP) {
      ballPos.pop();
    } else if (p2.w * 1.6 < p2.h || p2.h * 1.6 < p2.w) {
      ballPos.pop();
    }
  }
  if (ballPos.length > 0 && frameCount - ballPos[0].frame > BALL_HISTORY_MAX_AGE) {
    ballPos.shift();
  }
  return ballPos;
}

/**
 * 剔除长时间静止的伪球轨迹（低置信度背景噪点）。
 * @param {TrackPoint[]} ballPos
 * @returns {TrackPoint[]}
 */
function removeStationaryNoise(ballPos) {
  if (ballPos.length < 5) return ballPos;
  var tail = ballPos.length > 8 ? ballPos.slice(ballPos.length - 8) : ballPos;
  var anchor = tail[tail.length - 1];
  var still = 0;
  var i;
  for (i = 0; i < tail.length; i++) {
    var dx = tail[i].x - anchor.x;
    var dy = tail[i].y - anchor.y;
    if (dx * dx + dy * dy < 24 * 24) still++;
  }
  if (still >= 8 && anchor.conf < 0.11) {
    return [];
  }
  return ballPos;
}

/**
 * 清洗篮筐轨迹点（移植 utils.clean_hoop_pos）。
 * @param {TrackPoint[]} hoopPos
 * @returns {TrackPoint[]}
 */
function cleanHoopPos(hoopPos) {
  if (hoopPos.length > 1) {
    var p1 = hoopPos[hoopPos.length - 2];
    var p2 = hoopPos[hoopPos.length - 1];
    var fDif = p2.frame - p1.frame;
    var dx = p2.x - p1.x;
    var dy = p2.y - p1.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var maxDist = 0.5 * Math.sqrt(p1.w * p1.w + p1.h * p1.h);
    if (dist > maxDist && fDif < 5) {
      hoopPos.pop();
    } else if (p2.w * 1.3 < p2.h || p2.h * 1.3 < p2.w) {
      hoopPos.pop();
    }
  }
  if (hoopPos.length > HOOP_HISTORY_MAX) {
    hoopPos.shift();
  }
  return hoopPos;
}

/**
 * 创建 avishah 投篮追踪器。
 * @param {Object} [opts]
 * @param {function(string,string):void} [opts.onLog]
 * @returns {Object}
 */
function createAvishahShotTracker(opts) {
  opts = opts || {};
  /** @type {TrackPoint[]} */
  var ballPos = [];
  /** @type {TrackPoint[]} */
  var hoopPos = [];
  var frameCount = 0;
  var up = false;
  var down = false;
  var upFrame = 0;
  var downFrame = 0;
  var makes = 0;
  var attempts = 0;
  var cooldownUntil = 0;

  /**
   * @param {string} tag
   * @param {string} msg
   * @returns {void}
   */
  function log(tag, msg) {
    if (typeof opts.onLog === 'function') opts.onLog(tag, msg);
  }

  /**
   * @returns {string}
   */
  function fsmLabel() {
    if (Date.now() < cooldownUntil) return 'COOLDOWN';
    if (up && down) return 'FALLING';
    if (up) return 'RISING';
    return 'IDLE';
  }

  /**
   * @returns {{x:number,y:number}[]}
   */
  function trailSnapshot() {
    return ballPos.map(function (p) { return { x: p.x, y: p.y }; });
  }

  /**
   * 每帧喂入检测结果。
   * @param {{ball:Object|null,ballTrack:Object|null,hoop:Object|null}} detection
   * @param {number} now
   * @returns {{event:string,ballX:number|null,ballY:number|null,trail:Array,state:string}}
   */
  function onFrame(detection, now) {
    frameCount++;
    detection = detection || {};

    if (!detection.calibratedHoop && detection.hoop && detection.hoop.confidence >= TRACK_HOOP_CONF) {
      hoopPos.push({
        x: detection.hoop.x,
        y: detection.hoop.y,
        frame: frameCount,
        w: detection.hoop.w,
        h: detection.hoop.h,
        conf: detection.hoop.confidence
      });
    }

    var trackBall = detection.ballTrack || detection.ball;
    if (trackBall && trackBall.confidence >= TRACK_BALL_CONF) {
      ballPos.push({
        x: trackBall.x,
        y: trackBall.y,
        frame: frameCount,
        w: trackBall.w,
        h: trackBall.h,
        conf: trackBall.confidence
      });
    }

    ballPos = cleanBallPos(ballPos, frameCount);
    ballPos = removeStationaryNoise(ballPos);
    if (hoopPos.length > 1 && !detection.calibratedHoop) {
      hoopPos = cleanHoopPos(hoopPos);
    }

    var hoopActive = resolveHoopTrack(detection, hoopPos, frameCount);

    var ballX = ballPos.length ? ballPos[ballPos.length - 1].x : null;
    var ballY = ballPos.length ? ballPos[ballPos.length - 1].y : null;
    var event = 'none';

    if (now < cooldownUntil) {
      return { event: 'none', ballX: null, ballY: null, trail: trailSnapshot(), state: 'COOLDOWN' };
    }

    if (hoopActive.length > 0 && ballPos.length >= MIN_BALL_TRAIL_FOR_SHOT) {
      if (frameCount % SHOT_CHECK_INTERVAL === 0) {
        var cycle = detectMobileShotCycle(ballPos, hoopActive);
        if (cycle.ok) {
          attempts++;
          var made = scoreShot(ballPos, hoopActive);
          var hoop = hoopActive[hoopActive.length - 1];
          var dbg = made ? 'MADE' : 'MISS';
          var rimH = hoop.y - 0.5 * hoop.h;
          var scoreTrail = filterScoreTrail(ballPos, hoop);
          var rimPts = collectRimApproachPoints(scoreTrail, rimH, hoop);
          if (!made && scoreTrail.length >= 2) {
            var pA = rimPts.length >= 2 ? rimPts[0] : scoreTrail[scoreTrail.length - 2];
            var pB = rimPts.length >= 2 ? rimPts[rimPts.length - 1] : scoreTrail[scoreTrail.length - 1];
            var fit = lineFit2(pA.x, pA.y, pB.x, pB.y);
            var predX = fit ? ((rimH - fit.b) / fit.m).toFixed(0) : '?';
            dbg += ' predX=' + predX + ' rim=' +
              Math.round(hoop.x - 0.4 * hoop.w) + '~' + Math.round(hoop.x + 0.4 * hoop.w);
          } else if (made) {
            dbg += ' rim=' + Math.round(hoop.x - 0.4 * hoop.w) + '~' +
              Math.round(hoop.x + 0.4 * hoop.w);
          }
          log('SHOT', dbg + ' att=' + attempts + ' mode=' + cycle.mode +
            ' trail=' + ballPos.length + ' upF=' + cycle.upF + ' downF=' + cycle.downF +
            (detection.calibratedHoop ? ' hoop=cal' : ' hoop=ml'));
          up = false;
          down = false;
          upFrame = 0;
          downFrame = 0;
          ballPos = [];
          event = made ? 'made' : 'missed';
          if (made) makes++;
          cooldownUntil = now + SHOT_COOLDOWN_MS;
        }
      }
    }

    return {
      event: event,
      ballX: ballX,
      ballY: ballY,
      trail: trailSnapshot(),
      state: fsmLabel()
    };
  }

  return {
    onFrame: onFrame,
    reset: function () {
      ballPos = [];
      hoopPos = [];
      frameCount = 0;
      up = false;
      down = false;
      upFrame = 0;
      downFrame = 0;
      makes = 0;
      attempts = 0;
      cooldownUntil = 0;
    },
    getStats: function () {
      return {
        frameCount: frameCount,
        ballPosLen: ballPos.length,
        hoopPosLen: hoopPos.length,
        up: up,
        down: down,
        makes: makes,
        attempts: attempts,
        state: fsmLabel()
      };
    },
    getMakesAttempts: function () {
      return { makes: makes, attempts: attempts };
    }
  };
}

module.exports = {
  createAvishahShotTracker: createAvishahShotTracker
};
