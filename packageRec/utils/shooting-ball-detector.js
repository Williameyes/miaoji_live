/**
 * @fileoverview 投篮训练：YOLOv8 ONNX 篮球+篮筐检测（avishah3 best.pt）。
 */

var modelConfig = require('../constants/shooting-ball-model-config.js');

/** YOLO letterbox 灰底填充值（0~1） */
var LETTERBOX_PAD = 114 / 255;
/** 进入 NMS 的最低分数（尽量多保留候选） */
var PARSE_MIN_SCORE = 0.04;
/** 篮球置信度 */
var BALL_CONF = modelConfig.CONF_THRESHOLD;
/** 篮筐附近篮球置信度 */
var BALL_CONF_NEAR_HOOP = modelConfig.CONF_THRESHOLD_NEAR_HOOP;
/** 弱检出 UI 阈值 */
var BALL_CONF_PEEK = modelConfig.CONF_THRESHOLD_PEEK || 0.06;
/** 篮筐置信度（对齐 shot_detector.py） */
var HOOP_CONF = modelConfig.HOOP_CONF_THRESHOLD || 0.5;
/** 推理超时（ms） */
var INFER_TIMEOUT_MS = 6000;
/** 是否已记录输出张量 shape */
var outputShapeLogged = false;
/** letterbox Worker 单例 */
var letterboxWorker = null;
/** Worker 是否可用 */
var letterboxWorkerReady = false;
/** @type {Object<number, {resolve:Function,reject:Function}>} */
var letterboxWorkerPending = {};
/** Worker 请求序号 */
var letterboxWorkerReqId = 0;
/** Worker 连续失败次数，超过则回退主线程 */
var letterboxWorkerFailCount = 0;
/** 是否启用 Worker 预处理（真机传 buffer 有开销，默认关） */
var USE_LETTERBOX_WORKER = false;

/**
 * 创建篮球+篮筐检测器。
 * @param {Object} opts
 * @param {WechatMiniprogram.InferenceSession} opts.session
 * @param {function(number, number, number, number):{x:number,y:number}} opts.mapFrameToViewport
 * @param {function(string, string):void} [opts.onLog]
 * @returns {{ detect: function, getStats: function, resetStats: function }}
 */
function createBallDetector(opts) {
  opts = opts || {};
  var inferCount = 0;
  var ballHitCount = 0;
  var hoopHitCount = 0;
  var lastInferMs = 0;
  var lastPrepMs = 0;
  var lastTotalMs = 0;
  var lastTopScore = 0;
  var inputBuffer = null;
  var inputSize = modelConfig.INPUT_SIZE;
  var planeSize = inputSize * inputSize;
  var numClasses = modelConfig.NUM_CLASSES || 2;

  /**
   * @param {string} tag
   * @param {string} msg
   * @returns {void}
   */
  function log(tag, msg) {
    if (typeof opts.onLog === 'function') opts.onLog(tag, msg);
  }

  /**
   * 初始化 letterbox Worker（失败则静默回退主线程分片预处理）。
   * @returns {void}
   */
  function initLetterboxWorker() {
    if (!USE_LETTERBOX_WORKER || letterboxWorker || letterboxWorkerFailCount > 2) return;
    if (typeof wx === 'undefined' || typeof wx.createWorker !== 'function') return;
    try {
      letterboxWorker = wx.createWorker('workers/shooting-letterbox-worker.js');
      letterboxWorker.onMessage(function (res) {
        if (!res || res.cmd !== 'letterbox') return;
        var pending = letterboxWorkerPending[res.id];
        if (!pending) return;
        delete letterboxWorkerPending[res.id];
        if (res.error) {
          pending.reject(new Error(res.error));
          return;
        }
        pending.resolve({
          tensor: new Float32Array(res.tensor),
          meta: res.meta
        });
      });
      letterboxWorkerReady = true;
      log('ML', 'letterbox worker ready');
    } catch (eInit) {
      letterboxWorkerFailCount++;
      log('ML', 'letterbox worker init fail: ' + String(eInit));
    }
  }

  /**
   * Worker 或主线程 letterbox。
   * @param {Uint8Array} rgba
   * @param {number} fw
   * @param {number} fh
   * @param {function():boolean} [shouldAbort]
   * @returns {Promise<{tensor:Float32Array,meta:Object}>}
   */
  function preprocessWithWorkerOrMain(rgba, fw, fh, shouldAbort) {
    if (shouldAbort && shouldAbort()) {
      return Promise.reject(new Error('aborted'));
    }
    if (!letterboxWorkerReady || !letterboxWorker) {
      return preprocessLetterboxAsync(rgba, fw, fh, shouldAbort);
    }
    return new Promise(function (resolve, reject) {
      var id = ++letterboxWorkerReqId;
      var rgbaCopy = new Uint8Array(rgba);
      letterboxWorkerPending[id] = { resolve: resolve, reject: reject };
      try {
        letterboxWorker.postMessage({
          cmd: 'letterbox',
          id: id,
          fw: fw,
          fh: fh,
          inputSize: inputSize,
          pad: LETTERBOX_PAD,
          rgba: rgbaCopy.buffer
        }, [rgbaCopy.buffer]);
      } catch (ePost) {
        delete letterboxWorkerPending[id];
        letterboxWorkerFailCount++;
        preprocessLetterboxAsync(rgba, fw, fh, shouldAbort).then(resolve).catch(reject);
        return;
      }
      setTimeout(function () {
        if (!letterboxWorkerPending[id]) return;
        delete letterboxWorkerPending[id];
        letterboxWorkerFailCount++;
        if (letterboxWorkerFailCount > 2) {
          letterboxWorkerReady = false;
        }
        preprocessLetterboxAsync(rgba, fw, fh, shouldAbort).then(resolve).catch(reject);
      }, 4000);
    });
  }

  initLetterboxWorker();

  /**
   * 用常量填充 letterbox 张量（原生 fill，避免百万次 JS 循环卡死 UI）。
   * @param {Float32Array} out
   * @returns {void}
   */
  function fillLetterboxPad(out) {
    out.fill(LETTERBOX_PAD);
  }

  /**
   * 异步 letterbox（分片 yield，让暂停/导航点击有机会执行）。
   * @param {Uint8Array} rgba
   * @param {number} fw
   * @param {number} fh
   * @param {function():boolean} [shouldAbort]
   * @returns {Promise<{tensor:Float32Array,meta:Object}>}
   */
  function preprocessLetterboxAsync(rgba, fw, fh, shouldAbort) {
    if (!inputBuffer || inputBuffer.length !== 3 * planeSize) {
      inputBuffer = new Float32Array(3 * planeSize);
    }
    var out = inputBuffer;
    fillLetterboxPad(out);

    var scale = Math.min(inputSize / fw, inputSize / fh);
    var newW = Math.max(1, Math.round(fw * scale));
    var newH = Math.max(1, Math.round(fh * scale));
    var padX = Math.floor((inputSize - newW) * 0.5);
    var padY = Math.floor((inputSize - newH) * 0.5);
    var meta = { scale: scale, padX: padX, padY: padY, newW: newW, newH: newH };
    var p1 = planeSize;
    var p2 = planeSize * 2;
    var invScaleX = fw / newW;
    var invScaleY = fh / newH;
    var step = (fw * fh < 280000) ? 1 : 2;
    /**
     * 每 tick 处理的行步数：过去固定 12，配合裁剪后常见的 640 行输出要切成
     * 50+ 个 setTimeout(0) tick，每个 tick 的宏任务调度开销（几毫秒）累加起来
     * 反而远超真正的像素搬运耗时，是真机端到端延迟的主要来源。这里按总行数
     * 固定切成约 4 个 tick（仍保留少量 yield 给触摸事件，但不再逐行切片）。
     */
    var totalPasses = Math.ceil(newH / step);
    var rowsPerTick = Math.max(20, Math.ceil(totalPasses / 4));

    return new Promise(function (resolve, reject) {
      var sy = 0;

      /**
       * @returns {void}
       */
      function tick() {
        if (shouldAbort && shouldAbort()) {
          reject(new Error('aborted'));
          return;
        }
        var rowBudget = rowsPerTick;
        var fy;
        var fx;
        var srcIdx;
        var dstIdx;
        var dy;
        var dx;
        var sx;

        while (rowBudget > 0 && sy < newH) {
          fy = Math.min(fh - 1, Math.floor((sy + 0.5) * invScaleY));
          for (sx = 0; sx < newW; sx += step) {
            fx = Math.min(fw - 1, Math.floor((sx + 0.5) * invScaleX));
            srcIdx = (fy * fw + fx) * 4;
            var r = rgba[srcIdx] / 255;
            var g = rgba[srcIdx + 1] / 255;
            var b = rgba[srcIdx + 2] / 255;
            for (dy = 0; dy < step && sy + dy < newH; dy++) {
              for (dx = 0; dx < step && sx + dx < newW; dx++) {
                dstIdx = (padY + sy + dy) * inputSize + (padX + sx + dx);
                out[dstIdx] = r;
                out[p1 + dstIdx] = g;
                out[p2 + dstIdx] = b;
              }
            }
          }
          sy += step;
          rowBudget--;
        }

        if (sy >= newH) {
          resolve({ tensor: out, meta: meta });
        } else {
          setTimeout(tick, 0);
        }
      }

      setTimeout(tick, 0);
    });
  }

  /**
   * @param {number} lx
   * @param {number} ly
   * @param {Object} meta
   * @returns {{x:number,y:number}}
   */
  function letterboxToFrame(lx, ly, meta) {
    return {
      x: (lx - meta.padX) / meta.scale,
      y: (ly - meta.padY) / meta.scale
    };
  }

  /**
   * @param {Object} a
   * @param {Object} b
   * @returns {number}
   */
  function iou(a, b) {
    var ix1 = Math.max(a.x1, b.x1);
    var iy1 = Math.max(a.y1, b.y1);
    var ix2 = Math.min(a.x2, b.x2);
    var iy2 = Math.min(a.y2, b.y2);
    var iw = Math.max(0, ix2 - ix1);
    var ih = Math.max(0, iy2 - iy1);
    var inter = iw * ih;
    var union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
    return union > 0 ? inter / union : 0;
  }

  /**
   * @param {Array} boxes
   * @param {number} iouThr
   * @returns {Array}
   */
  function nms(boxes, iouThr) {
    var sorted = boxes.slice().sort(function (a, b) { return b.score - a.score; });
    var kept = [];
    var i;
    var j;
    for (i = 0; i < sorted.length; i++) {
      var ok = true;
      for (j = 0; j < kept.length; j++) {
        if (iou(sorted[i], kept[j]) > iouThr) {
          ok = false;
          break;
        }
      }
      if (ok) kept.push(sorted[i]);
    }
    return kept;
  }

  /**
   * 解析 ONNX 输出布局（channels×anchors 或 anchors×channels）。
   * @param {number[]} shape
   * @returns {{ layout: string, numAnchors: number, numFeatures: number }}
   */
  function resolveOutputLayout(shape) {
    var numFeatures = 4 + numClasses;
    var numAnchors = 2100;
    var layout = 'cxn';
    if (shape.length >= 3) {
      if (shape[1] === numFeatures) {
        layout = 'cxn';
        numAnchors = shape[2];
      } else if (shape[2] === numFeatures) {
        layout = 'nxc';
        numAnchors = shape[1];
      } else if (shape[1] > shape[2]) {
        layout = 'nxc';
        numAnchors = shape[1];
      } else {
        layout = 'cxn';
        numAnchors = shape[2];
      }
    }
    return { layout: layout, numAnchors: numAnchors, numFeatures: numFeatures };
  }

  /**
   * @param {Float32Array} data
   * @param {number} channel
   * @param {number} anchor
   * @param {string} layout
   * @param {number} numAnchors
   * @param {number} numFeatures
   * @returns {number}
   */
  function readFeat(data, channel, anchor, layout, numAnchors, numFeatures) {
    if (layout === 'nxc') return data[anchor * numFeatures + channel];
    return data[channel * numAnchors + anchor];
  }

  /**
   * @param {Float32Array} data
   * @param {number} numAnchors
   * @param {Object} meta
   * @param {{ layout: string, numFeatures: number }} layoutInfo
   * @returns {{ balls: Array, hoops: Array, topBallScore: number, bestBallRaw: Object|null }}
   */
  function parseByClass(data, numAnchors, meta, layoutInfo) {
    var balls = [];
    var hoops = [];
    var topBallScore = 0;
    var bestBallRaw = null;
    var ballSet = {};
    var hoopSet = {};
    var ci;
    var layout = layoutInfo.layout;
    var numFeatures = layoutInfo.numFeatures;
    for (ci = 0; ci < modelConfig.BALL_CLASS_IDS.length; ci++) {
      ballSet[modelConfig.BALL_CLASS_IDS[ci]] = true;
    }
    for (ci = 0; ci < modelConfig.HOOP_CLASS_IDS.length; ci++) {
      hoopSet[modelConfig.HOOP_CLASS_IDS[ci]] = true;
    }

    var a;
    var c;
    var cx;
    var cy;
    var w;
    var h;
    var bestScore;
    var bestClass;
    var score;
    var tl;
    var br;

    for (a = 0; a < numAnchors; a++) {
      cx = readFeat(data, 0, a, layout, numAnchors, numFeatures);
      cy = readFeat(data, 1, a, layout, numAnchors, numFeatures);
      w = readFeat(data, 2, a, layout, numAnchors, numFeatures);
      h = readFeat(data, 3, a, layout, numAnchors, numFeatures);
      bestScore = 0;
      bestClass = -1;
      for (c = 0; c < numClasses; c++) {
        score = readFeat(data, 4 + c, a, layout, numAnchors, numFeatures);
        if (ballSet[c] && score > topBallScore) {
          topBallScore = score;
        }
        if (score > bestScore) {
          bestScore = score;
          bestClass = c;
        }
      }
      if (bestScore < PARSE_MIN_SCORE) continue;

      tl = letterboxToFrame(cx - w * 0.5, cy - h * 0.5, meta);
      br = letterboxToFrame(cx + w * 0.5, cy + h * 0.5, meta);
      var box = {
        x1: Math.min(tl.x, br.x),
        y1: Math.min(tl.y, br.y),
        x2: Math.max(tl.x, br.x),
        y2: Math.max(tl.y, br.y),
        cx: (Math.min(tl.x, br.x) + Math.max(tl.x, br.x)) * 0.5,
        cy: (Math.min(tl.y, br.y) + Math.max(tl.y, br.y)) * 0.5,
        w: Math.abs(br.x - tl.x),
        h: Math.abs(br.y - tl.y),
        score: bestScore,
        classId: bestClass
      };
      if (ballSet[bestClass] && (!bestBallRaw || bestScore > bestBallRaw.score)) {
        bestBallRaw = box;
      }
      if (hoopSet[bestClass] && bestScore >= HOOP_CONF) {
        hoops.push(box);
      } else if (ballSet[bestClass] && bestScore >= BALL_CONF_NEAR_HOOP) {
        balls.push(box);
      }
    }

    return {
      balls: nms(balls, modelConfig.IOU_THRESHOLD),
      hoops: nms(hoops, modelConfig.IOU_THRESHOLD),
      topBallScore: topBallScore,
      bestBallRaw: bestBallRaw
    };
  }

  /**
   * 篮筐区域判断（移植 utils.in_hoop_region）。
   * @param {{x:number,y:number}} center
   * @param {{x:number,y:number,w:number,h:number}} hoop
   * @returns {boolean}
   */
  function inHoopRegion(center, hoop) {
    if (!hoop) return false;
    var x1 = hoop.x - 1 * hoop.w;
    var x2 = hoop.x + 1 * hoop.w;
    var y1 = hoop.y - 1 * hoop.h;
    var y2 = hoop.y + 0.5 * hoop.h;
    return center.x > x1 && center.x < x2 && center.y > y1 && center.y < y2;
  }

  /**
   * 帧框转视口检测对象（支持 ROI 裁剪坐标还原）。
   * @param {Object} box
   * @param {number} fw crop 宽
   * @param {number} fh crop 高
   * @param {{x0:number,y0:number,fullFw:number,fullFh:number}|null} [cropMeta]
   * @returns {{x:number,y:number,w:number,h:number,confidence:number}}
   */
  function boxToViewport(box, fw, fh, cropMeta) {
    var mapVp = opts.mapFrameToViewport;
    var fullFw = cropMeta ? cropMeta.fullFw : fw;
    var fullFh = cropMeta ? cropMeta.fullFh : fh;
    var ox = cropMeta ? cropMeta.x0 : 0;
    var oy = cropMeta ? cropMeta.y0 : 0;
    var frameCx = box.cx + ox;
    var frameCy = box.cy + oy;
    var frameX2 = box.x2 + ox;
    var frameY2 = box.y2 + oy;
    var c = mapVp(frameCx, frameCy, fullFw, fullFh);
    var r = mapVp(frameX2, frameCy, fullFw, fullFh);
    var b = mapVp(frameCx, frameY2, fullFw, fullFh);
    return {
      x: c.x,
      y: c.y,
      w: Math.max(8, Math.abs(r.x - c.x) * 2),
      h: Math.max(8, Math.abs(b.y - c.y) * 2),
      confidence: box.score
    };
  }

  /**
   * @param {{data: ArrayBuffer, width: number, height: number}} frame
   * @param {{x0:number,y0:number,fullFw:number,fullFh:number}|null} [cropMeta]
   * @returns {Promise<{ball:Object|null,ballTrack:Object|null,hoop:Object|null}>}
   */
  function detect(frame, cropMeta) {
    if (!opts.session || !frame || !frame.data || !opts.mapFrameToViewport) {
      return Promise.resolve({ ball: null, hoop: null });
    }

    var fw = frame.width;
    var fh = frame.height;
    if (!fw || !fh) return Promise.resolve({ ball: null, hoop: null });

    var rgba = new Uint8Array(frame.data);
    var needBytes = fw * fh * 4;
    if (rgba.length < needBytes) {
      if (inferCount === 0) {
        log('ML', 'frame buffer short ' + rgba.length + '<' + needBytes + ' ' + fw + 'x' + fh);
      }
      return Promise.resolve({ ball: null, hoop: null });
    }

    var shouldAbort = typeof opts.shouldAbort === 'function' ? opts.shouldAbort : null;
    var tDetectStart = Date.now();
    var prepPromise = preprocessWithWorkerOrMain(rgba, fw, fh, shouldAbort);

    return prepPromise.then(function (prep) {
      if (shouldAbort && shouldAbort()) {
        return { ball: null, hoop: null, aborted: true };
      }

      var t0 = Date.now();
      lastPrepMs = t0 - tDetectStart;
      var inputCopy = new Float32Array(prep.tensor);

      var feed = {};
      feed[modelConfig.INPUT_TENSOR] = {
        type: 'float32',
        data: inputCopy.buffer,
        shape: [1, 3, inputSize, inputSize]
      };

      var inferPromise = opts.session.run(feed);
      var timeoutPromise = new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('infer_timeout')); }, INFER_TIMEOUT_MS);
      });

      return Promise.race([inferPromise, timeoutPromise]).then(function (res) {
        if (shouldAbort && shouldAbort()) {
          return { ball: null, hoop: null, aborted: true };
        }
        lastInferMs = Date.now() - t0;
      lastTotalMs = Date.now() - tDetectStart;
      inferCount++;
      var outTensor = res[modelConfig.OUTPUT_TENSOR];
      if (!outTensor || !outTensor.data) {
        return { ball: null, hoop: null };
      }

      var shape = outTensor.shape || [];
      var layoutInfo = resolveOutputLayout(shape);
      if (!outputShapeLogged) {
        outputShapeLogged = true;
        log('ML', 'output shape=' + JSON.stringify(shape) +
          ' layout=' + layoutInfo.layout + ' anchors=' + layoutInfo.numAnchors);
      }
      var parsed = parseByClass(
        new Float32Array(outTensor.data),
        layoutInfo.numAnchors,
        prep.meta,
        layoutInfo
      );
      lastTopScore = parsed.topBallScore;

      if (inferCount === 1) {
        log('ML', 'first infer ok top=' + parsed.topBallScore.toFixed(3) +
          ' balls=' + parsed.balls.length + ' hoops=' + parsed.hoops.length + ' ms=' + lastInferMs +
          (cropMeta ? ' crop=' + fw + 'x' + fh : ''));
      } else if (inferCount % 90 === 0) {
        log('ML', 'infer#' + inferCount + ' topBall=' + parsed.topBallScore.toFixed(3) +
          ' ballHits=' + ballHitCount + ' hoopHits=' + hoopHitCount +
          ' prepMs=' + lastPrepMs + ' inferMs=' + lastInferMs + ' totalMs=' + lastTotalMs);
      }

      var bestHoop = parsed.hoops.length ? parsed.hoops[0] : null;
      var hoopVp = bestHoop ? boxToViewport(bestHoop, fw, fh, cropMeta) : null;
      if (hoopVp) hoopHitCount++;

      var bestBall = null;
      var bi;
      for (bi = 0; bi < parsed.balls.length; bi++) {
        var b = parsed.balls[bi];
        var accept = b.score >= BALL_CONF;
        if (!accept && hoopVp) {
          var center = boxToViewport(b, fw, fh, cropMeta);
          if (inHoopRegion(center, hoopVp) && b.score >= BALL_CONF_NEAR_HOOP) {
            accept = true;
          }
        }
        if (accept && (!bestBall || b.score > bestBall.score)) {
          bestBall = b;
        }
      }

      var ballVp = bestBall ? boxToViewport(bestBall, fw, fh, cropMeta) : null;
      var ballTrack = ballVp;
      if (!ballTrack && parsed.bestBallRaw && parsed.topBallScore >= BALL_CONF_NEAR_HOOP) {
        ballTrack = boxToViewport(parsed.bestBallRaw, fw, fh, cropMeta);
      }
      if (!ballVp && ballTrack) {
        ballVp = ballTrack;
      }
      if (!ballVp && parsed.bestBallRaw && parsed.topBallScore >= BALL_CONF_PEEK) {
        ballVp = boxToViewport(parsed.bestBallRaw, fw, fh, cropMeta);
        if (ballVp) ballVp.peek = true;
      }
      if (!ballTrack && ballVp) {
        ballTrack = ballVp;
      }
      if (ballVp) {
        ballHitCount++;
        if (ballHitCount <= 8) {
          log('ML', 'ball#' + ballHitCount + ' conf=' + ballVp.confidence.toFixed(3) +
            ' @' + Math.round(ballVp.x) + ',' + Math.round(ballVp.y));
        }
      }

      return { ball: ballVp, ballTrack: ballTrack, hoop: hoopVp };
      });
    }).catch(function (err) {
      if (err && err.message === 'aborted') {
        return { ball: null, hoop: null, aborted: true };
      }
      log('ML', 'infer fail: ' + String(err));
      return { ball: null, hoop: null };
    });
  }

  return {
    detect: detect,
    getStats: function () {
      return {
        inferCount: inferCount,
        hitCount: ballHitCount,
        hoopHitCount: hoopHitCount,
        lastInferMs: lastInferMs,
        lastPrepMs: lastPrepMs,
        lastTotalMs: lastTotalMs,
        lastTopScore: lastTopScore
      };
    },
    resetStats: function () {
      inferCount = 0;
      ballHitCount = 0;
      hoopHitCount = 0;
      lastInferMs = 0;
      lastPrepMs = 0;
      lastTotalMs = 0;
      lastTopScore = 0;
      outputShapeLogged = false;
    }
  };
}

module.exports = {
  createBallDetector: createBallDetector
};
