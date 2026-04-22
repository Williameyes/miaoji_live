/**
 * Shader 分级库：锐化为主，抗直播二次压缩造成的纹理糊化。
 *
 * 三档，刻意保持运算极简以控发热：
 *  - LITE     ：十字 Unsharp（5 采样）；中低端机 / 过热降级目标。
 *  - STANDARD ：3x3 高斯差分 USM（9 采样）；默认档位。
 *  - STRONG   ：3x3 USM + 窄带边缘补强 + S 型对比度（运动员高速运动下锐度更强）。
 *
 * 通用约束：
 *  - 不用循环 / 数组 uniform，避免低端 GPU 编译耗时过长。
 *  - 所有偏移以 uTexel = (1/width, 1/height) 为单位，与实际摄像头分辨率解耦。
 *  - 颜色在 sRGB 直接线性混合（非物理正确，但帧耗时更低；对观感收益为正）。
 */

/**
 * 顶点阶段把「全屏四边形」的 aUv 映射到纹理子矩形，等价 CSS object-fit: cover，
 * 避免画布宽高比与相机帧不一致时把画面非均匀拉伸（常见观感：全场「变扁」）。
 */
var VERTEX = [
  'attribute vec2 aPos;',
  'attribute vec2 aUv;',
  'uniform vec2 uUvScale;',
  'uniform vec2 uUvOffset;',
  'varying vec2 vUv;',
  'void main() {',
  '  vUv = aUv * uUvScale + uUvOffset;',
  '  gl_Position = vec4(aPos, 0.0, 1.0);',
  '}'
].join('\n');

/** 轻量 USM：十字 4 邻域 + 中心。 */
var FRAGMENT_LITE = [
  'precision mediump float;',
  'varying vec2 vUv;',
  'uniform sampler2D uTex;',
  'uniform vec2 uTexel;',
  'uniform float uAmount;',
  'void main() {',
  '  vec3 c = texture2D(uTex, vUv).rgb;',
  '  vec3 l = texture2D(uTex, vUv + vec2(-uTexel.x, 0.0)).rgb;',
  '  vec3 r = texture2D(uTex, vUv + vec2( uTexel.x, 0.0)).rgb;',
  '  vec3 u = texture2D(uTex, vUv + vec2(0.0, -uTexel.y)).rgb;',
  '  vec3 d = texture2D(uTex, vUv + vec2(0.0,  uTexel.y)).rgb;',
  '  vec3 blur = (l + r + u + d) * 0.25;',
  '  vec3 o = c + (c - blur) * uAmount;',
  '  gl_FragColor = vec4(clamp(o, 0.0, 1.0), 1.0);',
  '}'
].join('\n');

/** 标准 USM：3x3 高斯差分。 */
var FRAGMENT_STANDARD = [
  'precision mediump float;',
  'varying vec2 vUv;',
  'uniform sampler2D uTex;',
  'uniform vec2 uTexel;',
  'uniform float uAmount;',
  'void main() {',
  '  vec2 o = uTexel;',
  '  vec3 c  = texture2D(uTex, vUv).rgb;',
  '  vec3 n  = texture2D(uTex, vUv + vec2(0.0, -o.y)).rgb;',
  '  vec3 s  = texture2D(uTex, vUv + vec2(0.0,  o.y)).rgb;',
  '  vec3 e  = texture2D(uTex, vUv + vec2( o.x, 0.0)).rgb;',
  '  vec3 w  = texture2D(uTex, vUv + vec2(-o.x, 0.0)).rgb;',
  '  vec3 ne = texture2D(uTex, vUv + vec2( o.x,-o.y)).rgb;',
  '  vec3 nw = texture2D(uTex, vUv + vec2(-o.x,-o.y)).rgb;',
  '  vec3 se = texture2D(uTex, vUv + vec2( o.x, o.y)).rgb;',
  '  vec3 sw = texture2D(uTex, vUv + vec2(-o.x, o.y)).rgb;',
  '  vec3 blur = (ne + nw + se + sw) * 0.0625',
  '            + (n + s + e + w) * 0.125',
  '            + c * 0.25;',
  '  vec3 col = c + (c - blur) * uAmount;',
  '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
  '}'
].join('\n');

/**
 * VK 独立管线专用：USM（3x3 高斯差分 + 边缘补强） + Gamma 校正 + HSV 饱和度补益。
 *
 * 相对 STRONG 的增量：
 *  - Gamma：提亮中间调（uGamma < 1.0 更亮，> 1.0 更暗）；村 BA 场地偏灰环境强相关收益。
 *  - Saturation：在亮度不变的前提下拉高色彩饱和度（uSaturation > 1.0），让红蓝队服在抖音二压后仍鲜明。
 *  - 全部放在锐化之后（先"补清晰"再"补色彩"）；避免放大噪点。
 *  - uVkZoom：仅 ≥1 的中心裁切放大（与页面约定一致）；采样 UV clamp 到 [0,1] 减轻边缘 USM 与纹理 repeat 伪影。
 *  - 所有 uniform 都有 0 相当于 no-op 的默认值，便于手动调参时连续滑动不闪断。
 *
 * 注意：此档位只在 VKSession v2 独立管线下使用；标准/高性能档（onCameraFrame overlay 路径）不走这里。
 */
var FRAGMENT_VK = [
  'precision mediump float;',
  'varying vec2 vUv;',
  'uniform sampler2D uTex;',
  'uniform vec2 uTexel;',
  'uniform float uVkZoom;',
  'uniform float uAmount;',
  'uniform float uContrast;',
  'uniform float uGamma;',
  'uniform float uSaturation;',
  'void main() {',
  '  float zDiv = max(uVkZoom, 1.0);',
  '  vec2 zUv = 0.5 + (vUv - 0.5) / zDiv;',
  '  vec2 o = uTexel;',
  '  vec3 c  = texture2D(uTex, clamp(zUv, vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 n  = texture2D(uTex, clamp(zUv + vec2(0.0, -o.y), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 s  = texture2D(uTex, clamp(zUv + vec2(0.0,  o.y), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 e  = texture2D(uTex, clamp(zUv + vec2( o.x, 0.0), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 w  = texture2D(uTex, clamp(zUv + vec2(-o.x, 0.0), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 ne = texture2D(uTex, clamp(zUv + vec2( o.x,-o.y), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 nw = texture2D(uTex, clamp(zUv + vec2(-o.x,-o.y), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 se = texture2D(uTex, clamp(zUv + vec2( o.x, o.y), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 sw = texture2D(uTex, clamp(zUv + vec2(-o.x, o.y), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 blur = (ne + nw + se + sw) * 0.0625',
  '            + (n + s + e + w) * 0.125',
  '            + c * 0.25;',
  '  vec3 edge = c - blur;',
  '  vec3 col = c + edge * uAmount;',
  '  float em = max(max(abs(edge.r), abs(edge.g)), abs(edge.b));',
  '  col += edge * step(0.08, em) * 0.35;',
  '  col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);',
  '  col = clamp(col, 0.0, 1.0);',
  // Gamma（分通道）：pow(col, 1/uGamma)；uGamma=1 时无变化
  '  col = pow(col, vec3(1.0 / max(uGamma, 0.01)));',
  // 饱和度：沿灰度轴拉伸；luma 采用 Rec.709 权重
  '  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));',
  '  col = mix(vec3(luma), col, uSaturation);',
  '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
  '}'
].join('\n');

/** 强化：USM + 边缘补强 + S 型对比度。边缘补强仅在 edge 能量 >= 0.08 时触发。 */
var FRAGMENT_STRONG = [
  'precision mediump float;',
  'varying vec2 vUv;',
  'uniform sampler2D uTex;',
  'uniform vec2 uTexel;',
  'uniform float uAmount;',
  'uniform float uContrast;',
  'void main() {',
  '  vec2 o = uTexel;',
  '  vec3 c  = texture2D(uTex, vUv).rgb;',
  '  vec3 n  = texture2D(uTex, vUv + vec2(0.0, -o.y)).rgb;',
  '  vec3 s  = texture2D(uTex, vUv + vec2(0.0,  o.y)).rgb;',
  '  vec3 e  = texture2D(uTex, vUv + vec2( o.x, 0.0)).rgb;',
  '  vec3 w  = texture2D(uTex, vUv + vec2(-o.x, 0.0)).rgb;',
  '  vec3 ne = texture2D(uTex, vUv + vec2( o.x,-o.y)).rgb;',
  '  vec3 nw = texture2D(uTex, vUv + vec2(-o.x,-o.y)).rgb;',
  '  vec3 se = texture2D(uTex, vUv + vec2( o.x, o.y)).rgb;',
  '  vec3 sw = texture2D(uTex, vUv + vec2(-o.x, o.y)).rgb;',
  '  vec3 blur = (ne + nw + se + sw) * 0.0625',
  '            + (n + s + e + w) * 0.125',
  '            + c * 0.25;',
  '  vec3 edge = c - blur;',
  '  vec3 col = c + edge * uAmount;',
  '  float em = max(max(abs(edge.r), abs(edge.g)), abs(edge.b));',
  '  col += edge * step(0.08, em) * 0.3;',
  '  col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);',
  '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
  '}'
].join('\n');

/**
 * 档位配置：fragment 源码 + 默认 uniform。
 * 上游可在 setShaderLevel 时覆盖 uniforms 以做运行时调参。
 */
/**
 * VKSession 相机背景专用顶点：应用 getDisplayTransform()，与微信 VisionKit 文档一致。
 * @type {string}
 */
var VERTEX_VK_YUV = [
  'attribute vec2 aPos;',
  'attribute vec2 aUv;',
  'uniform mat3 uDisplayTransform;',
  'varying vec2 vUv;',
  'void main() {',
  '  vec3 p = uDisplayTransform * vec3(aPos, 0.0);',
  '  gl_Position = vec4(p, 1.0);',
  '  vUv = aUv;',
  '}'
].join('\n');

/**
 * NV12/Y 平面 + UV 半平面采样转 RGB，供 VK getCameraTexture(gl,\'yuv\') 首 pass 写入 FBO。
 * @type {string}
 */
var FRAGMENT_VK_YUV = [
  'precision mediump float;',
  'varying vec2 vUv;',
  'uniform sampler2D uYTex;',
  'uniform sampler2D uUvTex;',
  'void main() {',
  '  vec4 y_color = texture2D(uYTex, vUv);',
  '  vec4 uv_color = texture2D(uUvTex, vUv);',
  '  float Y = y_color.r;',
  '  float U = uv_color.r - 0.5;',
  '  float V = uv_color.a - 0.5;',
  '  float R = Y + 1.402 * V;',
  '  float G = Y - 0.344 * U - 0.714 * V;',
  '  float B = Y + 1.772 * U;',
  '  gl_FragColor = vec4(R, G, B, 1.0);',
  '}'
].join('\n');

module.exports = {
  VERTEX: VERTEX,
  /** @type {string} */
  VERTEX_VK_YUV: VERTEX_VK_YUV,
  /** @type {string} */
  FRAGMENT_VK_YUV: FRAGMENT_VK_YUV,
  LITE: { fragment: FRAGMENT_LITE, uniforms: { uAmount: 0.45 } },
  STANDARD: { fragment: FRAGMENT_STANDARD, uniforms: { uAmount: 0.75 } },
  STRONG: { fragment: FRAGMENT_STRONG, uniforms: { uAmount: 1.10, uContrast: 0.08 } },
  /**
   * VK 档参数经验值（村 BA 实拍场景）：
   *  - uAmount=1.25：比 STRONG 更凶；VK 零拷贝路径省下的预算全押在锐化上
   *  - uContrast=0.10：S 型轻微拉开明暗
   *  - uGamma=0.92：微提亮（灰场环境）
   *  - uSaturation=1.18：补色，让红蓝球衣在抖音二压后仍识别度高
   */
  VK: {
    fragment: FRAGMENT_VK,
    uniforms: {
      uAmount: 1.25,
      uContrast: 0.10,
      uGamma: 0.92,
      uSaturation: 1.18,
      uVkZoom: 1.0
    }
  }
};
