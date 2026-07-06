/**
 * 极简 WebGL 贴图：将 onCameraFrame RGBA 缓冲绘制到 canvas（无滤镜、无缩放运算）。
 * 供视录分离后台 MediaRecorder 取帧。
 */

/**
 * @param {WebGLRenderingContext} gl
 * @param {string} vertexSrc
 * @param {string} fragmentSrc
 * @returns {WebGLProgram|null}
 */
function createProgram(gl, vertexSrc, fragmentSrc) {
  function compile(type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      try { gl.deleteShader(shader); } catch (e) { }
      return null;
    }
    return shader;
  }
  const vs = compile(gl.VERTEX_SHADER, vertexSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fragmentSrc);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    try { gl.deleteProgram(program); } catch (e2) { }
    return null;
  }
  return program;
}

const VERTEX_SRC = [
  'attribute vec2 aPos;',
  'attribute vec2 aUv;',
  'varying vec2 vUv;',
  'void main(){',
  '  vUv = aUv;',
  '  gl_Position = vec4(aPos, 0.0, 1.0);',
  '}'
].join('\n');

const FRAGMENT_SRC = [
  'precision mediump float;',
  'varying vec2 vUv;',
  'uniform sampler2D uTex;',
  'void main(){',
  '  gl_FragColor = texture2D(uTex, vUv);',
  '}'
].join('\n');

/**
 * 计算 object-fit:cover 纹理 UV（居中裁切，不变形）。
 *
 * @param {number} frameW
 * @param {number} frameH
 * @param {number} outW
 * @param {number} outH
 * @returns {{ u0: number, v0: number, u1: number, v1: number }}
 */
function computeCoverUvRect(frameW, frameH, outW, outH) {
  const fw = Math.max(1, Number(frameW) || 1);
  const fh = Math.max(1, Number(frameH) || 1);
  const ow = Math.max(1, Number(outW) || 1);
  const oh = Math.max(1, Number(outH) || 1);
  const frameAspect = fw / fh;
  const outAspect = ow / oh;
  let u0 = 0;
  let v0 = 0;
  let u1 = 1;
  let v1 = 1;
  if (frameAspect > outAspect) {
    const visibleU = outAspect / frameAspect;
    u0 = (1 - visibleU) * 0.5;
    u1 = u0 + visibleU;
  } else if (frameAspect < outAspect) {
    const visibleV = frameAspect / outAspect;
    v0 = (1 - visibleV) * 0.5;
    v1 = v0 + visibleV;
  }
  return { u0, v0, u1, v1 };
}

/**
 * 创建贴图渲染器。
 * @returns {{
 *   init: function(Object): Promise<void>,
 *   drawRgba: function(Object): void,
 *   destroy: function(): void
 * }}
 */
function createCameraBlitRenderer() {
  let gl = null;
  let program = null;
  let texture = null;
  let vbo = null;
  let texW = 0;
  let texH = 0;
  let lastCropKey = '';
  let aPos = -1;
  let aUv = -1;
  let uTex = null;
  let canvasNode = null;
  let contextLost = false;
  let consecutiveFailures = 0;
  let onFatalCallback = null;

  const handleContextLost = (e) => {
    if (e && typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    contextLost = true;
    try {
      console.warn('[WebGL] Context lost detected on offscreen canvas');
    } catch (_) {}
  };

  const handleContextRestored = () => {
    try {
      console.info('[WebGL] Context restored, reinitializing resources...');
      contextLost = false;
      setupWebGL();
    } catch (err) {
      console.error('[WebGL] Failed to reinitialize resources after context restore', err);
    }
  };

  function setupWebGL() {
    if (!gl) return false;
    try {
      program = createProgram(gl, VERTEX_SRC, FRAGMENT_SRC);
      if (!program) return false;
      aPos = gl.getAttribLocation(program, 'aPos');
      aUv = gl.getAttribLocation(program, 'aUv');
      uTex = gl.getUniformLocation(program, 'uTex');
      vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, 64, gl.DYNAMIC_DRAW);
      texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 1);
      texW = 0;
      texH = 0;
      lastCropKey = '';
      return true;
    } catch (e) {
      return false;
    }
  }

  function triggerFatal() {
    consecutiveFailures = 0;
    if (typeof onFatalCallback === 'function') {
      try {
        onFatalCallback(new Error('WEBGL_CONTEXT_FATAL'));
      } catch (_) {}
    }
  }

  /**
   * @param {Object} opts
   * @param {Object} opts.canvasNode offscreen 或 wxml canvas node
   * @param {boolean} [opts.preserveDrawingBuffer] MediaRecorder 采帧须 true，否则 Android 易录黑屏
   * @param {Function} [opts.onFatal] WebGL 发生致命 context 丢失时的回调
   * @returns {Promise<void>}
   */
  function init(opts) {
    canvasNode = opts && opts.canvasNode;
    onFatalCallback = opts && opts.onFatal;
    if (!canvasNode) {
      return Promise.reject(new Error('canvasNode required'));
    }
    const preserveDrawingBuffer = !opts || opts.preserveDrawingBuffer !== false;
    try {
      gl = canvasNode.getContext('webgl', {
        antialias: false,
        depth: false,
        stencil: false,
        alpha: false,
        preserveDrawingBuffer: preserveDrawingBuffer
      });
    } catch (eCtx) {
      return Promise.reject(eCtx);
    }
    if (!gl) {
      return Promise.reject(new Error('webgl unavailable'));
    }

    if (typeof canvasNode.addEventListener === 'function') {
      canvasNode.addEventListener('webglcontextlost', handleContextLost, false);
      canvasNode.addEventListener('webglcontextrestored', handleContextRestored, false);
    } else {
      canvasNode.onwebglcontextlost = handleContextLost;
      canvasNode.onwebglcontextrestored = handleContextRestored;
    }

    if (gl.isContextLost && gl.isContextLost()) {
      contextLost = true;
      return Promise.reject(new Error('webgl context lost at init'));
    }

    if (!setupWebGL()) {
      return Promise.reject(new Error('shader program failed'));
    }
    return Promise.resolve();
  }

  /**
   * @param {{ data: ArrayBuffer, width: number, height: number }} frame
   * @returns {void}
   */
  function drawRgba(frame) {
    if (!gl || !frame || !frame.data) {
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        triggerFatal();
      }
      return;
    }

    const isLost = gl.isContextLost && gl.isContextLost();
    const needsSetup = !program || !texture || !vbo;

    if (isLost || needsSetup) {
      if (isLost) {
        contextLost = true;
      }
      const success = setupWebGL();
      if (!success || (gl.isContextLost && gl.isContextLost())) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          triggerFatal();
        }
        return;
      }
      contextLost = false;
    }

    const w = Math.max(1, Number(frame.width) || 1);
    const h = Math.max(1, Number(frame.height) || 1);
    const pixelBytes = w * h * 4;
    let rgba = null;
    try {
      rgba = frame.data.byteLength >= pixelBytes
        ? new Uint8Array(frame.data, 0, pixelBytes)
        : new Uint8Array(frame.data);
    } catch (copyErr) {
      try {
        rgba = new Uint8Array(frame.data);
      } catch (copyErr2) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          triggerFatal();
        }
        return;
      }
    }

    try {
      const outW = gl.drawingBufferWidth;
      const outH = gl.drawingBufferHeight;
      const crop = computeCoverUvRect(w, h, outW, outH);
      const cropKey = w + 'x' + h + '@' + outW + 'x' + outH + ':' + crop.u0.toFixed(4);
      if (cropKey !== lastCropKey) {
        lastCropKey = cropKey;
        const verts = new Float32Array([
          -1, -1, crop.u0, crop.v1,
          1, -1, crop.u1, crop.v1,
          -1, 1, crop.u0, crop.v0,
          1, 1, crop.u1, crop.v0
        ]);
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts);
      }
      gl.viewport(0, 0, outW, outH);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      if (texW !== w || texH !== h) {
        texW = w;
        texH = h;
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      }
      gl.uniform1i(uTex, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(aUv);
      gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      if (typeof gl.finish === 'function') {
        gl.finish();
      }
      if (typeof gl.getError === 'function') {
        const errCode = gl.getError();
        if (errCode === 0x0507 || (gl.CONTEXT_LOST_WEBGL && errCode === gl.CONTEXT_LOST_WEBGL)) {
          throw new Error('CONTEXT_LOST_WEBGL');
        }
      }
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures++;
      if (consecutiveFailures >= 3) {
        triggerFatal();
      }
    }
  }

  /**
   * @returns {void}
   */
  function destroy() {
    if (canvasNode) {
      if (typeof canvasNode.removeEventListener === 'function') {
        canvasNode.removeEventListener('webglcontextlost', handleContextLost, false);
        canvasNode.removeEventListener('webglcontextrestored', handleContextRestored, false);
      } else {
        canvasNode.onwebglcontextlost = null;
        canvasNode.onwebglcontextrestored = null;
      }
    }
    if (gl && texture) {
      try { gl.deleteTexture(texture); } catch (e) { }
    }
    if (gl && vbo) {
      try { gl.deleteBuffer(vbo); } catch (e2) { }
    }
    if (gl && program) {
      try { gl.deleteProgram(program); } catch (e3) { }
    }
    gl = null;
    program = null;
    texture = null;
    vbo = null;
    texW = 0;
    texH = 0;
    canvasNode = null;
    onFatalCallback = null;
  }

  return {
    init,
    drawRgba,
    destroy
  };
}

module.exports = {
  createCameraBlitRenderer,
  computeCoverUvRect
};
