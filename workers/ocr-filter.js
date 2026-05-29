/**
 * @fileoverview OCR 视觉门禁 Worker（V5 Sparse Grid Diff）
 *
 * 职责：Transferable 接收帧 → ROI 稀疏特征提取 → 低频 diff → 异动判定 → baseline 管理
 * 禁止：OCR、大图回传、重型视觉算法
 */

/** 稀疏网格尺寸（6×6 = 36 维结构特征） */
var GRID_SIZE = 6;

/** 降帧检测：每 N 帧处理 1 次（30fps → 10fps） */
var FRAME_SKIP = 3;

/** baseline 更新前需连续稳定的帧数 */
var BASELINE_STABLE_FRAMES = 5;

/** 单格灰度均值差阈值 */
var CELL_DIFF_THRESHOLD = 10;

/** 判定 ROI 结构变化的最少格数 */
var CHANGED_CELLS_MIN = 2;

/** @type {Array<{ x: number, y: number, w: number, h: number }>} */
var rois = [];

/** @type {Array<Float32Array|null>} 各 ROI baseline 特征 */
var baselines = [null, null, null];

/** @type {Array<Float32Array|null>} 待确认 baseline 目标特征 */
var baselineTargets = [null, null, null];

/** @type {number[]} 各 ROI baseline 稳定计数 */
var stableCounters = [0, 0, 0];

/** @type {boolean[]} 各 ROI 是否处于 baseline 待确认状态 */
var baselinePending = [false, false, false];

/** @type {boolean[]} OCR 已触发、等待 baseline 确认期间抑制重复触发 */
var awaitingBaseline = [false, false, false];

/** @type {number} 帧序号 */
var frameSeq = 0;

/**
 * 计算归一化 ROI 在帧上的像素矩形。
 * @param {{ x: number, y: number, w: number, h: number }} roi 归一化 ROI
 * @param {number} frameW 帧宽
 * @param {number} frameH 帧高
 * @returns {{ x0: number, y0: number, w: number, h: number }}
 */
function roiToPixelRect(roi, frameW, frameH) {
  var x0 = Math.max(0, Math.floor(roi.x * frameW));
  var y0 = Math.max(0, Math.floor(roi.y * frameH));
  var w = Math.max(1, Math.floor(roi.w * frameW));
  var h = Math.max(1, Math.floor(roi.h * frameH));
  if (x0 + w > frameW) w = frameW - x0;
  if (y0 + h > frameH) h = frameH - y0;
  return { x0: x0, y0: y0, w: w, h: h };
}

/**
 * 提取单个 ROI 的 6×6 稀疏网格灰度均值特征。
 * @param {Uint8Array} rgba RGBA 帧数据
 * @param {number} frameW 帧宽
 * @param {number} frameH 帧高
 * @param {{ x: number, y: number, w: number, h: number }} roi 归一化 ROI
 * @returns {Float32Array} 36 维特征向量
 */
function extractSparseGridFeature(rgba, frameW, frameH, roi) {
  var rect = roiToPixelRect(roi, frameW, frameH);
  var features = new Float32Array(GRID_SIZE * GRID_SIZE);
  var cellW = rect.w / GRID_SIZE;
  var cellH = rect.h / GRID_SIZE;

  for (var gy = 0; gy < GRID_SIZE; gy++) {
    for (var gx = 0; gx < GRID_SIZE; gx++) {
      var startX = rect.x0 + Math.floor(gx * cellW);
      var startY = rect.y0 + Math.floor(gy * cellH);
      var endX = rect.x0 + Math.floor((gx + 1) * cellW);
      var endY = rect.y0 + Math.floor((gy + 1) * cellH);
      if (endX <= startX) endX = startX + 1;
      if (endY <= startY) endY = startY + 1;
      var sum = 0;
      var count = 0;
      for (var y = startY; y < endY; y++) {
        var rowBase = y * frameW * 4;
        for (var x = startX; x < endX; x++) {
          var idx = rowBase + x * 4;
          sum += rgba[idx] * 0.299 + rgba[idx + 1] * 0.587 + rgba[idx + 2] * 0.114;
          count++;
        }
      }
      features[gy * GRID_SIZE + gx] = count > 0 ? sum / count : 0;
    }
  }
  return features;
}

/**
 * 比较两组稀疏特征，判断是否发生结构变化。
 * @param {Float32Array} current 当前特征
 * @param {Float32Array} baseline 基线特征
 * @param {number} roiIndex ROI 索引（时间 ROI 秒位变化更细，阈值更低）
 * @returns {boolean} 是否变化
 */
function isFeatureChanged(current, baseline, roiIndex) {
  if (!baseline || baseline.length !== current.length) return true;
  var minCells = roiIndex === 2 ? 1 : CHANGED_CELLS_MIN;
  var changedCells = 0;
  for (var i = 0; i < current.length; i++) {
    if (Math.abs(current[i] - baseline[i]) > CELL_DIFF_THRESHOLD) {
      changedCells++;
      if (changedCells >= minCells) return true;
    }
  }
  return false;
}

/**
 * 比较两组特征是否足够相似（用于 baseline 稳定确认）。
 * @param {Float32Array} a 特征 A
 * @param {Float32Array} b 特征 B
 * @returns {boolean} 是否相似
 */
function isFeatureSimilar(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  var changedCells = 0;
  for (var i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > CELL_DIFF_THRESHOLD) {
      changedCells++;
      if (changedCells >= CHANGED_CELLS_MIN) return false;
    }
  }
  return true;
}

/**
 * 重置 Worker 内部状态。
 * @returns {void}
 */
function resetState() {
  rois = [];
  baselines = [null, null, null];
  baselineTargets = [null, null, null];
  stableCounters = [0, 0, 0];
  baselinePending = [false, false, false];
  awaitingBaseline = [false, false, false];
  frameSeq = 0;
}

/**
 * 初始化 ROI 与 baseline。
 * @param {Array<{ x: number, y: number, w: number, h: number }>} nextRois ROI 列表
 * @returns {void}
 */
function initRois(nextRois) {
  rois = nextRois || [];
  baselines = [null, null, null];
  baselineTargets = [null, null, null];
  stableCounters = [0, 0, 0];
  baselinePending = [false, false, false];
  awaitingBaseline = [false, false, false];
  frameSeq = 0;
}

/**
 * 处理单帧：提取特征、diff、返回 OCR_TRIGGER。
 * @param {ArrayBuffer} buffer 帧 buffer
 * @param {number} width 帧宽
 * @param {number} height 帧高
 * @param {number} seq 帧序号
 * @returns {void}
 */
function handleFrame(buffer, width, height, seq) {
  if (!buffer || !buffer.byteLength || width <= 0 || height <= 0 || !rois.length) return;

  frameSeq = typeof seq === 'number' ? seq : frameSeq + 1;
  if (frameSeq % FRAME_SKIP !== 0) return;

  var rgba = new Uint8Array(buffer);
  var changedRois = [];

  for (var i = 0; i < rois.length && i < 3; i++) {
    var roi = rois[i];
    if (!roi || roi.w <= 0 || roi.h <= 0) continue;

    var feature = extractSparseGridFeature(rgba, width, height, roi);

    if (baselinePending[i]) {
      if (!baselineTargets[i]) {
        baselineTargets[i] = feature;
        stableCounters[i] = 1;
      } else if (isFeatureSimilar(feature, baselineTargets[i])) {
        stableCounters[i] += 1;
      } else {
        baselineTargets[i] = feature;
        stableCounters[i] = 1;
      }
      if (stableCounters[i] >= BASELINE_STABLE_FRAMES) {
        baselines[i] = baselineTargets[i];
        baselinePending[i] = false;
        awaitingBaseline[i] = false;
        baselineTargets[i] = null;
        stableCounters[i] = 0;
        worker.postMessage({
          type: 'BASELINE_UPDATED',
          roiIndex: i,
          seq: frameSeq
        });
      }
      continue;
    }

    if (awaitingBaseline[i]) {
      continue;
    }

    if (!baselines[i]) {
      baselines[i] = feature;
      continue;
    }

    if (isFeatureChanged(feature, baselines[i], i)) {
      changedRois.push(i);
    }
  }

  if (changedRois.length > 0) {
    for (var ti = 0; ti < changedRois.length; ti++) {
      awaitingBaseline[changedRois[ti]] = true;
    }
    worker.postMessage({
      type: 'OCR_TRIGGER',
      changedRois: changedRois,
      seq: frameSeq
    });
  }
}

/**
 * 标记 ROI baseline 进入稳定确认流程（OCR 成功后由主线程触发）。
 * 下一帧起采集新特征作为 target，连续稳定 N 帧后才替换 baseline。
 * @param {number[]} roiIndices ROI 索引列表
 * @returns {void}
 */
function scheduleBaselineUpdate(roiIndices) {
  if (!roiIndices || !roiIndices.length) return;
  for (var i = 0; i < roiIndices.length; i++) {
    var idx = roiIndices[i];
    if (idx < 0 || idx > 2) continue;
    awaitingBaseline[idx] = false;
    baselinePending[idx] = true;
    baselineTargets[idx] = null;
    stableCounters[idx] = 0;
  }
}

/**
 * OCR 失败时清除 awaiting 抑制，允许重新触发。
 * @param {number[]} roiIndices ROI 索引列表
 * @returns {void}
 */
function clearAwaitingBaseline(roiIndices) {
  if (!roiIndices || !roiIndices.length) return;
  for (var i = 0; i < roiIndices.length; i++) {
    var idx = roiIndices[i];
    if (idx >= 0 && idx <= 2) awaitingBaseline[idx] = false;
  }
}

worker.onMessage(function (res) {
  var msg = res || {};
  var type = msg.type;

  if (type === 'INIT' || type === 'UPDATE_ROIS') {
    initRois(msg.rois || []);
    worker.postMessage({ type: 'READY', roiCount: rois.length });
    return;
  }

  if (type === 'RESET') {
    resetState();
    worker.postMessage({ type: 'READY', roiCount: 0 });
    return;
  }

  if (type === 'FRAME') {
    handleFrame(msg.buffer, msg.width, msg.height, msg.seq);
    return;
  }

  if (type === 'UPDATE_BASELINE') {
    scheduleBaselineUpdate(msg.roiIndices || []);
    return;
  }

  if (type === 'CLEAR_AWAITING') {
    clearAwaitingBaseline(msg.roiIndices || []);
  }
});
