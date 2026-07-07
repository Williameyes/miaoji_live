/**
 * @fileoverview 投篮训练 letterbox 预处理 Worker（主线程仅做推理，避免 UI 卡顿）。
 */

/** @type {number} */
var inputSize = 640;
/** @type {number} */
var padValue = 114 / 255;

/**
 * letterbox 预处理。
 * @param {Uint8Array} rgba
 * @param {number} fw
 * @param {number} fh
 * @returns {{tensor:Float32Array,meta:Object}}
 */
function letterbox(rgba, fw, fh) {
  var planeSize = inputSize * inputSize;
  var out = new Float32Array(3 * planeSize);
  out.fill(padValue);

  var scale = Math.min(inputSize / fw, inputSize / fh);
  var newW = Math.max(1, Math.round(fw * scale));
  var newH = Math.max(1, Math.round(fh * scale));
  var padX = Math.floor((inputSize - newW) * 0.5);
  var padY = Math.floor((inputSize - newH) * 0.5);
  var p1 = planeSize;
  var p2 = planeSize * 2;
  var invScaleX = fw / newW;
  var invScaleY = fh / newH;
  var step = 2;
  var sy;
  var sx;
  var fy;
  var fx;
  var srcIdx;
  var dstIdx;
  var dy;
  var dx;

  for (sy = 0; sy < newH; sy += step) {
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
  }

  return {
    tensor: out,
    meta: { scale: scale, padX: padX, padY: padY, newW: newW, newH: newH }
  };
}

worker.onMessage(function (msg) {
  if (!msg || msg.cmd !== 'letterbox') return;
  try {
    inputSize = msg.inputSize || 640;
    padValue = typeof msg.pad === 'number' ? msg.pad : padValue;
    var rgba = new Uint8Array(msg.rgba);
    var prep = letterbox(rgba, msg.fw, msg.fh);
    worker.postMessage({
      cmd: 'letterbox',
      id: msg.id,
      tensor: prep.tensor.buffer,
      meta: prep.meta
    }, [prep.tensor.buffer]);
  } catch (err) {
    worker.postMessage({
      cmd: 'letterbox',
      id: msg.id,
      error: String(err)
    });
  }
});
