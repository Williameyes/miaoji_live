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
  let aPos = -1;
  let aUv = -1;
  let uTex = null;

  /**
   * @param {Object} opts
   * @param {Object} opts.canvasNode offscreen 或 wxml canvas node
   * @returns {Promise<void>}
   */
  function init(opts) {
    const canvasNode = opts && opts.canvasNode;
    if (!canvasNode) {
      return Promise.reject(new Error('canvasNode required'));
    }
    try {
      gl = canvasNode.getContext('webgl', {
        antialias: false,
        depth: false,
        stencil: false,
        alpha: false,
        preserveDrawingBuffer: false
      });
    } catch (eCtx) {
      return Promise.reject(eCtx);
    }
    if (!gl) {
      return Promise.reject(new Error('webgl unavailable'));
    }
    program = createProgram(gl, VERTEX_SRC, FRAGMENT_SRC);
    if (!program) {
      return Promise.reject(new Error('shader program failed'));
    }
    aPos = gl.getAttribLocation(program, 'aPos');
    aUv = gl.getAttribLocation(program, 'aUv');
    uTex = gl.getUniformLocation(program, 'uTex');
    const data = new Float32Array([
      -1, -1, 0, 1,
      1, -1, 1, 1,
      -1, 1, 0, 0,
      1, 1, 1, 0
    ]);
    vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    return Promise.resolve();
  }

  /**
   * @param {{ data: ArrayBuffer, width: number, height: number }} frame
   * @returns {void}
   */
  function drawRgba(frame) {
    if (!gl || !program || !frame || !frame.data) return;
    const w = Math.max(1, Number(frame.width) || 1);
    const h = Math.max(1, Number(frame.height) || 1);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (texW !== w || texH !== h) {
      texW = w;
      texH = h;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(frame.data));
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(frame.data));
    }
    gl.uniform1i(uTex, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * @returns {void}
   */
  function destroy() {
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
  }

  return {
    init,
    drawRgba,
    destroy
  };
}

module.exports = {
  createCameraBlitRenderer
};
