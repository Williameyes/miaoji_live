/**
 * WebGL 锐化渲染器：消费 { data(RGBA), width, height } 帧，按当前档位 Shader 输出到
 * <canvas type="webgl">。
 *
 * VKSession v2 路径：iOS 上 frame.getCameraBuffer() 往往不可用，须用
 * frame.getCameraTexture(gl, 'yuv') + getDisplayTransform()；本模块用「YUV→FBO RGBA」再跑现有
 * VK 锐化 fragment，与原生 onCameraFrame 单纹理路径共用同一套 USM/Gamma/Saturation。
 *
 * 关键设计：
 *  - GL 资源（program / texture / buffer）在 destroy() 时显式释放，避免页面反复 init 累积内存。
 *  - setShaderLevel 热切：仅重建 program，保留纹理 / VBO，<2ms 完成，视觉近乎无感。
 *  - 纹理尺寸懒分配：同一分辨率只分配一次，后续走 texSubImage2D 仅传像素；降低 GC 与上传耗时。
 *  - 默认 preserveDrawingBuffer:false 减压；VK 家族需 true，否则 canvasToTempFilePath 读到已交换清空的缓冲→封面全黑。
 *  - 所有 GL 调用放在 try/catch 的薄封装里；上游（pipeline）发现 draw 抛错即触发降级。
 */

var shaderLib = require('./shader-library.js');

/**
 * @typedef {'lite'|'standard'|'strong'|'vk'} ShaderLevel
 */

/**
 * 创建一个渲染器实例。
 * @returns {{
 *   init: (opts:{component:Object,selector:string,level?:ShaderLevel}) => Promise<void>,
 *   resizeCanvas: (cssWidth:number, cssHeight:number) => void,
 *   drawFrame: (frame:{data:ArrayBuffer,width:number,height:number}) => number,
 *   setShaderLevel: (level:ShaderLevel) => void,
 *   getShaderLevel: () => ShaderLevel,
 *   destroy: () => void
 * }}
 */
function createWebglSharpenRenderer() {
  var gl = null;
  var canvasNode = null;
  var vbo = null;
  var texture = null;
  var program = null;
  /** @type {ShaderLevel} */
  var currentLevel = 'standard';
  var currentUniforms = null;
  var attribLocs = { aPos: -1, aUv: -1 };
  /**
   * 所有可能被用到的 uniform 的 location 缓存；未被当前 program 使用时对应 location 为 null，
   * 绑定阶段以 null 检查进行 skip。新增 uGamma / uSaturation 用于 VK 档的色彩补偿。
   */
  var uniformLocs = {
    uTex: null, uTexel: null,
    uInvTexel: null,
    uAmount: null, uContrast: null,
    uGamma: null, uSaturation: null,
    uVkZoom: null,
    uMotion: null,
    uUvScale: null,
    uUvOffset: null
  };
  /** VK 数字变焦（中心裁切放大，倍率 ≥1）；与页面 zoom 同步。 */
  var vkZoomVal = 1;
  /** 每帧由 render-pipeline 写入 [0,1]，驱动 fragment 中 motion 锐化包络；VK 无 CPU 像素路径时为 0。 */
  var motionUniform = 0;
  var texW = 0;
  var texH = 0;
  var pixelRatio = 1;
  /** VK YUV 首 pass program；懒编译。 */
  var yuvProgram = null;
  /** YUV program 的 attribute / uniform 缓存。 */
  var yuvLocs = {
    aPos: -1,
    aUv: -1,
    uDisplayTransform: null,
    uYTex: null,
    uUvTex: null
  };
  /** 中间 RGBA FBO：YUV decode 输出，再作为 uTex 进锐化 pass。 */
  var fboRgb = null;
  var fboRgbTex = null;
  var fboRgbW = 0;
  var fboRgbH = 0;
  /** 列主序 3x3 单位矩阵，getDisplayTransform 缺失时兜底。 */
  var MAT3_IDENTITY = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  /**
   * 编译单个 shader。失败抛错由上层捕获并走降级。
   * @param {number} type
   * @param {string} src
   * @returns {WebGLShader}
   */
  function compileShader(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var info = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader compile fail: ' + info);
    }
    return sh;
  }

  /**
   * 编译并链接 program。内部 delete 中间 shader，避免泄漏。
   * @param {string} fragSrc
   * @returns {WebGLProgram}
   */
  function buildProgram(fragSrc) {
    var vs = compileShader(gl.VERTEX_SHADER, shaderLib.VERTEX);
    var fs = compileShader(gl.FRAGMENT_SHADER, fragSrc);
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var info = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('program link fail: ' + info);
    }
    return p;
  }

  /** 将当前 program 的 attribute / uniform location 缓存，避免每帧查询。 */
  function bindProgramLocations() {
    attribLocs.aPos = gl.getAttribLocation(program, 'aPos');
    attribLocs.aUv = gl.getAttribLocation(program, 'aUv');
    uniformLocs.uTex = gl.getUniformLocation(program, 'uTex');
    uniformLocs.uTexel = gl.getUniformLocation(program, 'uTexel');
    uniformLocs.uInvTexel = gl.getUniformLocation(program, 'uInvTexel');
    uniformLocs.uAmount = gl.getUniformLocation(program, 'uAmount');
    uniformLocs.uContrast = gl.getUniformLocation(program, 'uContrast');
    uniformLocs.uGamma = gl.getUniformLocation(program, 'uGamma');
    uniformLocs.uSaturation = gl.getUniformLocation(program, 'uSaturation');
    uniformLocs.uVkZoom = gl.getUniformLocation(program, 'uVkZoom');
    uniformLocs.uMotion = gl.getUniformLocation(program, 'uMotion');
    uniformLocs.uUvScale = gl.getUniformLocation(program, 'uUvScale');
    uniformLocs.uUvOffset = gl.getUniformLocation(program, 'uUvOffset');
  }

  /**
   * 横屏预览时若帧缓冲为竖幅尺寸（tw<th），则交换宽高参与 cover 计算，贴近系统预览比例。
   *
   * @param {number} viewW
   * @param {number} viewH
   * @param {number} texW
   * @param {number} texH
   * @returns {{ tw: number, th: number }}
   */
  function orientTexDimsForView(viewW, viewH, texW, texH) {
    var tw = Math.max(1, texW);
    var th = Math.max(1, texH);
    var cw = Math.max(1, viewW);
    var ch = Math.max(1, viewH);
    if (cw > ch && tw < th) {
      return { tw: th, th: tw };
    }
    if (cw < ch && tw > th) {
      return { tw: th, th: tw };
    }
    return { tw: tw, th: th };
  }

  /**
   * object-fit: cover：在纹理空间取居中子矩形，使映射到画布后无几何拉伸。
   *
   * @param {number} viewW 画布后备像素宽
   * @param {number} viewH 画布后备像素高
   * @param {number} texW 纹理像素宽
   * @param {number} texH 纹理像素高
   * @returns {{ su: number, sv: number, u0: number, v0: number }}
   */
  /**
   * 与片元着色器解耦的视口尺寸：须用 gl.drawingBuffer 与光栅一致，避免与 canvas 属性舍入不一致导致 cover 二次畸变。
   * @returns {{ w: number, h: number }}
   */
  function getGlDrawBufferSize() {
    if (!gl) {
      return { w: 2, h: 2 };
    }
    var dw = gl.drawingBufferWidth;
    var dh = gl.drawingBufferHeight;
    if (dw > 0 && dh > 0) {
      return { w: Math.max(2, dw), h: Math.max(2, dh) };
    }
    if (canvasNode) {
      return {
        w: Math.max(2, canvasNode.width),
        h: Math.max(2, canvasNode.height)
      };
    }
    return { w: 2, h: 2 };
  }

  function computeCoverUvScaleOffset(viewW, viewH, texW, texH) {
    var o = orientTexDimsForView(viewW, viewH, texW, texH);
    var tw = o.tw;
    var th = o.th;
    var cw = Math.max(1, viewW);
    var ch = Math.max(1, viewH);
    var texAsp = tw / th;
    var viewAsp = cw / ch;
    var su;
    var sv;
    var u0;
    var v0;
    if (texAsp > viewAsp * 1.00001) {
      su = viewAsp / texAsp;
      sv = 1;
      u0 = (1 - su) * 0.5;
      v0 = 0;
    } else {
      su = 1;
      sv = texAsp / viewAsp;
      u0 = 0;
      v0 = (1 - sv) * 0.5;
    }
    return { su: su, sv: sv, u0: u0, v0: v0 };
  }

  /**
   * object-fit: contain：整幅纹理可见，视口不足处为边带；与页面 16:9 框 + CSS contain 一致，减轻 cover 强裁边引起的边缘「挤拧」。
   * vUv 在边带外可超出 [0,1]，片元置黑。
   *
   * @param {number} viewW
   * @param {number} viewH
   * @param {number} texW
   * @param {number} texH
   * @returns {{ su: number, sv: number, u0: number, v0: number }}
   */
  function computeContainUvScaleOffset(viewW, viewH, texW, texH) {
    var o = orientTexDimsForView(viewW, viewH, texW, texH);
    var tw = o.tw;
    var th = o.th;
    var cw = Math.max(1, viewW);
    var ch = Math.max(1, viewH);
    var viewAsp = cw / ch;
    var texAsp = tw / th;
    var su;
    var sv;
    var u0;
    var v0;
    if (Math.abs(viewAsp - texAsp) < 0.0001) {
      return { su: 1, sv: 1, u0: 0, v0: 0 };
    }
    if (viewAsp > texAsp) {
      var span = texAsp / viewAsp;
      var g = (1 - span) * 0.5;
      su = 1 / span;
      u0 = -g / span;
      sv = 1;
      v0 = 0;
    } else {
      var spanV = viewAsp / texAsp;
      var g2 = (1 - spanV) * 0.5;
      su = 1;
      u0 = 0;
      sv = 1 / spanV;
      v0 = -g2 / spanV;
    }
    return { su: su, sv: sv, u0: u0, v0: v0 };
  }

  /**
   * 为当前锐化 program 设置顶点 UV：onCameraFrame 纹理按 contain 映射到画布（保留作对照）。
   *
   * @param {number} frameTexW
   * @param {number} frameTexH
   * @returns {void}
   */
  function setSharpenProgramUvContainForCameraFrame(frameTexW, frameTexH) {
    if (!gl || !program) return;
    if (uniformLocs.uUvScale == null || uniformLocs.uUvOffset == null) return;
    if (!canvasNode) return;
    var db = getGlDrawBufferSize();
    var cw = db.w;
    var ch = db.h;
    var c = computeContainUvScaleOffset(cw, ch, frameTexW, frameTexH);
    gl.uniform2f(uniformLocs.uUvScale, c.su, c.sv);
    gl.uniform2f(uniformLocs.uUvOffset, c.u0, c.v0);
  }

  /**
   * 为当前锐化 program 设置顶点 UV 变换（cover）。
   *
   * @param {number} frameTexW
   * @param {number} frameTexH
   * @returns {void}
   */
  function setSharpenProgramUvCoverForCameraFrame(frameTexW, frameTexH) {
    if (!gl || !program) return;
    if (uniformLocs.uUvScale == null || uniformLocs.uUvOffset == null) return;
    if (!canvasNode) return;
    var db = getGlDrawBufferSize();
    var cw = db.w;
    var ch = db.h;
    var c = computeCoverUvScaleOffset(cw, ch, frameTexW, frameTexH);
    gl.uniform2f(uniformLocs.uUvScale, c.su, c.sv);
    gl.uniform2f(uniformLocs.uUvOffset, c.u0, c.v0);
  }

  /**
   * 第二遍采样 FBO（与画布同尺寸）时使用恒等 UV，避免二次 cover。
   * @returns {void}
   */
  function setSharpenProgramUvIdentity() {
    if (!gl || !program) return;
    if (uniformLocs.uUvScale == null || uniformLocs.uUvOffset == null) return;
    gl.uniform2f(uniformLocs.uUvScale, 1, 1);
    gl.uniform2f(uniformLocs.uUvOffset, 0, 0);
  }

  /**
   * 创建一个覆盖全屏的 TRIANGLE_STRIP，aUv 采用左上翻转以匹配 onCameraFrame 上下朝向。
   * 若出现上下颠倒，可改为非翻转 UV。
   */
  function uploadQuad() {
    var data = new Float32Array([
      // aPos     aUv
      -1, -1,    0, 1,
       1, -1,    1, 1,
      -1,  1,    0, 0,
       1,  1,    1, 0
    ]);
    vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  }

  /** 创建纹理（延后到首帧 ensureTextureSize 才分配像素）。 */
  function allocTexture() {
    texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /**
   * 绑定 <canvas type="webgl">。必须在页面渲染完成后（onReady / nextTick）调用。
   * @param {Object} opts
   * @param {string} opts.selector      Node 查询字符串，如 '#enhanceCanvas'
   * @param {Object} opts.component     Page 实例（用于 createSelectorQuery）
   * @param {ShaderLevel} [opts.level]  初始档位
   * @param {boolean} [opts.preserveDrawingBuffer] 为 true 时保留后备缓冲供 toTempFilePath / 截屏（VK 封面必选）
   * @returns {Promise<void>}
   */
  function init(opts) {
    currentLevel = opts.level || 'standard';
    var preserveBuf = opts.preserveDrawingBuffer === true;
    pixelRatio = 1;
    try {
      var si = wx.getSystemInfoSync();
      pixelRatio = si.pixelRatio || 1;
    } catch (e) {}
    return new Promise(function(resolve, reject) {
      opts.component.createSelectorQuery()
        .select(opts.selector)
        .node()
        .exec(function(res) {
          if (!res || !res[0] || !res[0].node) {
            reject(new Error('canvas node not found: ' + opts.selector));
            return;
          }
          canvasNode = res[0].node;
          try {
            gl = canvasNode.getContext('webgl', {
              antialias: false,
              depth: false,
              stencil: false,
              alpha: false,
              preserveDrawingBuffer: preserveBuf
            });
            if (!gl) { reject(new Error('webgl unavailable')); return; }
            var cfg = shaderLib[currentLevel.toUpperCase()];
            program = buildProgram(cfg.fragment);
            currentUniforms = cfg.uniforms;
            bindProgramLocations();
            allocTexture();
            uploadQuad();
            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);
            gl.clearColor(0, 0, 0, 1);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
    });
  }

  /**
   * 设置 canvas 后备缓冲尺寸（CSS 尺寸 * pixelRatio）。在 init 后一次；屏幕旋转时重调。
   * @param {number} cssWidth
   * @param {number} cssHeight
   */
  function resizeCanvas(cssWidth, cssHeight) {
    if (!canvasNode || !gl) return;
    var w = Math.max(1, Math.floor(cssWidth * pixelRatio));
    var h = Math.max(1, Math.floor(cssHeight * pixelRatio));
    canvasNode.width = w;
    canvasNode.height = h;
    gl.viewport(0, 0, w, h);
    fboRgbW = 0;
    fboRgbH = 0;
  }

  /**
   * 供 VKSession 创建时绑定同一 WebGL 上下文（官方 wx.createVKSession 可选参数 gl）。
   * @returns {WebGLRenderingContext|null}
   */
  function getGl() {
    return gl;
  }

  /**
   * 当前 canvas 后备缓冲像素尺寸；须与 session.getVKFrame(w,h) 一致，否则 iOS 常返回空帧。
   * @returns {{ width: number, height: number }}
   */
  function getBackingSize() {
    if (gl) {
      var db = getGlDrawBufferSize();
      return { width: db.w, height: db.h };
    }
    if (!canvasNode) return { width: 1280, height: 720 };
    return {
      width: Math.max(2, canvasNode.width),
      height: Math.max(2, canvasNode.height)
    };
  }

  /**
   * 供 VK 高光录制取 wx.createMediaRecorder 所需的 canvas node。
   * @returns {Object|null}
   */
  function getCanvasNode() {
    return canvasNode;
  }

  /**
   * 设置 VK 预览数字变焦倍率（≥1；VKSession 无官方变焦 API）。
   * @param {number} z
   * @returns {void}
   */
  function setVkZoom(z) {
    var n = Number(z);
    if (!isFinite(n) || n < 1) n = 1;
    if (n > 64) n = 64;
    vkZoomVal = n;
  }

  /**
   * 设置帧间运动强度，传入 sharpen fragment 的 uMotion；与「中心块平均 luma 差分」同量纲 [0,1]。
   * @param {number} v
   * @returns {void}
   */
  function setMotionLevel(v) {
    var n = Number(v);
    if (!isFinite(n)) n = 0;
    if (n < 0) n = 0;
    if (n > 1) n = 1;
    motionUniform = n;
  }

  /**
   * 分配/重建 YUV→RGBA 用的 FBO（尺寸与 canvas 后备缓冲一致）。
   * @param {number} w
   * @param {number} h
   * @returns {void}
   */
  function ensureFboRgb(w, h) {
    if (!gl) return;
    if (fboRgb && fboRgbTex && fboRgbW === w && fboRgbH === h) return;
    if (fboRgbTex) {
      try { gl.deleteTexture(fboRgbTex); } catch (e) {}
      fboRgbTex = null;
    }
    if (fboRgb) {
      try { gl.deleteFramebuffer(fboRgb); } catch (e2) {}
      fboRgb = null;
    }
    fboRgb = gl.createFramebuffer();
    fboRgbTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, fboRgbTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboRgb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboRgbTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    fboRgbW = w;
    fboRgbH = h;
  }

  /**
   * 懒编译 YUV 解码 program（与主锐化 program 分离，避免污染 uniform）。
   * @returns {void}
   */
  function ensureYuvProgram() {
    if (yuvProgram || !gl) return;
    var vs = compileShader(gl.VERTEX_SHADER, shaderLib.VERTEX_VK_YUV);
    var fs = compileShader(gl.FRAGMENT_SHADER, shaderLib.FRAGMENT_VK_YUV);
    var p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var info = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('yuv program link fail: ' + info);
    }
    yuvProgram = p;
    yuvLocs.aPos = gl.getAttribLocation(yuvProgram, 'aPos');
    yuvLocs.aUv = gl.getAttribLocation(yuvProgram, 'aUv');
    yuvLocs.uDisplayTransform = gl.getUniformLocation(yuvProgram, 'uDisplayTransform');
    yuvLocs.uYTex = gl.getUniformLocation(yuvProgram, 'uYTex');
    yuvLocs.uUvTex = gl.getUniformLocation(yuvProgram, 'uUvTex');
  }

  /**
   * 绘制一帧 VKSession：getCameraTexture(yuv) → FBO RGBA → 现有 VK 锐化 shader 上屏。
   * @param {Object} vkFrame  session.getVKFrame 返回值
   * @returns {number} 本帧耗时 ms；失败返回 999
   */
  function drawVkCameraFrame(vkFrame) {
    if (!gl || !program || !vkFrame || !vbo || !canvasNode) return 999;
    var t0 = Date.now();
    var dbVk = getGlDrawBufferSize();
    var w = dbVk.w;
    var h = dbVk.h;
    try {
      var cam = vkFrame.getCameraTexture(gl, 'yuv');
      if (!cam) return 999;
      var yTex = cam.yTexture || cam.ytexture;
      var uvTex = cam.uvTexture || cam.uvtexture;
      if (!yTex || !uvTex) return 999;
      ensureYuvProgram();
      ensureFboRgb(w, h);
      var dt = vkFrame.getDisplayTransform && vkFrame.getDisplayTransform();
      var dtArr = MAT3_IDENTITY;
      if (dt && (dt.length === 9 || (typeof dt.byteLength === 'number' && dt.byteLength >= 36))) {
        dtArr = dt;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboRgb);
      gl.viewport(0, 0, w, h);
      gl.useProgram(yuvProgram);
      gl.uniformMatrix3fv(yuvLocs.uDisplayTransform, false, dtArr);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, yTex);
      gl.uniform1i(yuvLocs.uYTex, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, uvTex);
      gl.uniform1i(yuvLocs.uUvTex, 2);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(yuvLocs.aPos);
      gl.vertexAttribPointer(yuvLocs.aPos, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(yuvLocs.aUv);
      gl.vertexAttribPointer(yuvLocs.aUv, 2, gl.FLOAT, false, 16, 8);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(program);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, fboRgbTex);
      gl.uniform1i(uniformLocs.uTex, 0);
      gl.uniform2f(uniformLocs.uTexel, 1 / w, 1 / h);
      if (uniformLocs.uAmount && typeof currentUniforms.uAmount === 'number') {
        gl.uniform1f(uniformLocs.uAmount, currentUniforms.uAmount);
      }
      if (uniformLocs.uMotion) {
        gl.uniform1f(uniformLocs.uMotion, motionUniform);
      }
      if (uniformLocs.uContrast && typeof currentUniforms.uContrast === 'number') {
        gl.uniform1f(uniformLocs.uContrast, currentUniforms.uContrast);
      }
      if (uniformLocs.uGamma && typeof currentUniforms.uGamma === 'number') {
        gl.uniform1f(uniformLocs.uGamma, currentUniforms.uGamma);
      }
      if (uniformLocs.uSaturation && typeof currentUniforms.uSaturation === 'number') {
        gl.uniform1f(uniformLocs.uSaturation, currentUniforms.uSaturation);
      }
      if (uniformLocs.uVkZoom) {
        gl.uniform1f(uniformLocs.uVkZoom, vkZoomVal);
      }
      setSharpenProgramUvIdentity();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(attribLocs.aPos);
      gl.vertexAttribPointer(attribLocs.aPos, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(attribLocs.aUv);
      gl.vertexAttribPointer(attribLocs.aUv, 2, gl.FLOAT, false, 16, 8);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.activeTexture(gl.TEXTURE0);
    } catch (e) {
      return 999;
    }
    return Date.now() - t0;
  }

  /**
   * 分辨率变化时重新分配纹理存储；尺寸一致时直接返回，保证首帧后走 texSubImage2D 快速上传。
   * @param {number} w
   * @param {number} h
   */
  function ensureTextureSize(w, h) {
    if (w === texW && h === texH) return;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    texW = w;
    texH = h;
  }

  /**
   * 上传并渲染一帧。返回本帧 CPU 墙钟耗时（ms），供 PerfMonitor 统计。
   * @param {{data: ArrayBuffer, width: number, height: number}} frame
   * @returns {number}
   */
  function drawFrame(frame) {
    if (!gl || !program || !frame || !frame.data) return 0;
    var t0 = Date.now();
    var w = frame.width;
    var h = frame.height;
    try {
      ensureTextureSize(w, h);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0, w, h,
        gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(frame.data)
      );
      gl.useProgram(program);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.enableVertexAttribArray(attribLocs.aPos);
      gl.vertexAttribPointer(attribLocs.aPos, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(attribLocs.aUv);
      gl.vertexAttribPointer(attribLocs.aUv, 2, gl.FLOAT, false, 16, 8);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform1i(uniformLocs.uTex, 0);
      if (uniformLocs.uTexel) {
        gl.uniform2f(uniformLocs.uTexel, 1 / w, 1 / h);
      }
      if (uniformLocs.uInvTexel) {
        gl.uniform2f(uniformLocs.uInvTexel, 1 / w, 1 / h);
      }
      if (uniformLocs.uAmount && typeof currentUniforms.uAmount === 'number') {
        gl.uniform1f(uniformLocs.uAmount, currentUniforms.uAmount);
      }
      if (uniformLocs.uMotion) {
        gl.uniform1f(uniformLocs.uMotion, motionUniform);
      }
      if (uniformLocs.uContrast && typeof currentUniforms.uContrast === 'number') {
        gl.uniform1f(uniformLocs.uContrast, currentUniforms.uContrast);
      }
      if (uniformLocs.uGamma && typeof currentUniforms.uGamma === 'number') {
        gl.uniform1f(uniformLocs.uGamma, currentUniforms.uGamma);
      }
      if (uniformLocs.uSaturation && typeof currentUniforms.uSaturation === 'number') {
        gl.uniform1f(uniformLocs.uSaturation, currentUniforms.uSaturation);
      }
      if (uniformLocs.uVkZoom) {
        gl.uniform1f(uniformLocs.uVkZoom, vkZoomVal);
      }
      /**
       * 原生增强路径改为 cover：与关闭模式（原生 camera 裁切）以及 VK 视觉口径一致，
       * 避免在部分 Android 机型（如小米10s）上因帧宽高与 16:9 画布不一致出现上下黑边。
       */
      setSharpenProgramUvCoverForCameraFrame(w, h);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } catch (e) {
      // 渲染链路异常：返回一个明显过大的耗时，让 PerfMonitor 迅速进入降级路径
      return 999;
    }
    return Date.now() - t0;
  }

  /**
   * 热切 shader 档位；保留纹理 / VBO，仅重建 program。
   * @param {ShaderLevel} level
   */
  function setShaderLevel(level) {
    if (!gl) return;
    if (level === currentLevel) return;
    /**
     * VK 档用 uVkZoom 做中心裁切；切回原生 onCameraFrame 路径时必须回到 1，
     * 否则残留倍率会让画面像「边缘被拉伸/视野不对」。
     */
    if (level !== 'vk') {
      vkZoomVal = 1;
    }
    var cfg = shaderLib[level.toUpperCase()];
    if (!cfg) return;
    var old = program;
    try {
      program = buildProgram(cfg.fragment);
    } catch (e) {
      program = old;
      return;
    }
    if (old) gl.deleteProgram(old);
    bindProgramLocations();
    currentUniforms = cfg.uniforms;
    currentLevel = level;
  }

  function getShaderLevel() { return currentLevel; }

  /**
   * 释放所有 GL 资源。切到 off 或 onHide / onUnload 必须调用。
   */
  function destroy() {
    try {
      if (gl) {
        if (yuvProgram) { gl.deleteProgram(yuvProgram); yuvProgram = null; }
        if (fboRgbTex) { gl.deleteTexture(fboRgbTex); fboRgbTex = null; }
        if (fboRgb) { gl.deleteFramebuffer(fboRgb); fboRgb = null; }
        fboRgbW = 0;
        fboRgbH = 0;
        yuvLocs = {
          aPos: -1,
          aUv: -1,
          uDisplayTransform: null,
          uYTex: null,
          uUvTex: null
        };
        if (program) { gl.deleteProgram(program); program = null; }
        if (texture) { gl.deleteTexture(texture); texture = null; }
        if (vbo) { gl.deleteBuffer(vbo); vbo = null; }
        var lose = gl.getExtension('WEBGL_lose_context');
        if (lose && lose.loseContext) lose.loseContext();
      }
    } catch (e) {}
    gl = null;
    canvasNode = null;
    texW = 0;
    texH = 0;
    attribLocs = { aPos: -1, aUv: -1 };
    uniformLocs = {
      uTex: null, uTexel: null,
      uInvTexel: null,
      uAmount: null, uContrast: null,
      uGamma: null, uSaturation: null,
      uVkZoom: null,
      uMotion: null,
      uUvScale: null,
      uUvOffset: null
    };
    vkZoomVal = 1;
    motionUniform = 0;
  }

  return {
    init: init,
    resizeCanvas: resizeCanvas,
    drawFrame: drawFrame,
    drawVkCameraFrame: drawVkCameraFrame,
    getGl: getGl,
    getBackingSize: getBackingSize,
    getCanvasNode: getCanvasNode,
    setVkZoom: setVkZoom,
    setMotionLevel: setMotionLevel,
    setShaderLevel: setShaderLevel,
    getShaderLevel: getShaderLevel,
    destroy: destroy
  };
}

module.exports = { createWebglSharpenRenderer: createWebglSharpenRenderer };
