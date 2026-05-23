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
 *  - 原生档：顶点用 object-fit:contain（computeContainUvScaleOffset），整幅入画、边带 vUv∉[0,1] 时片元输出黑；
 *    卷积用 uInvTexel。VK 用 uTexel（FBO）。
 *  - 颜色在 sRGB 直接线性混合（非物理正确，但帧耗时更低；对观感收益为正）。
 */

/**
 * 顶点：vUv = aUv * uUvScale + uUvOffset。原生档为 object-fit:contain（与 CSS 一致）；边带外 vUv 可越界，片元填黑。
 * VK 第二遍恒等，FBO 已对齐。
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

var PRECISION = [
  '#ifdef GL_FRAGMENT_PRECISION_HIGH',
  '  precision highp float;',
  '#else',
  '  precision mediump float;',
  '#endif'
].join('\n');

var FRAGMENT_LITE = [
  PRECISION,
  'varying vec2 vUv;',
  'uniform sampler2D uTex;',
  'uniform vec2 uInvTexel;',
  'uniform float uAmount;',
  'uniform float uMotion;',
  'void main() {',
  '  if (vUv.x < -0.0001 || vUv.x > 1.0001 || vUv.y < -0.0001 || vUv.y > 1.0001) {',
  '    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);',
  '    return;',
  '  }',
  '  vec2 px = uInvTexel;',
  '  vec3 c  = texture2D(uTex, vUv).rgb;',
  '  vec3 n  = texture2D(uTex, vUv + vec2(0.0, -px.y)).rgb;',
  '  vec3 s  = texture2D(uTex, vUv + vec2(0.0,  px.y)).rgb;',
  '  vec3 e  = texture2D(uTex, vUv + vec2( px.x, 0.0)).rgb;',
  '  vec3 w  = texture2D(uTex, vUv + vec2(-px.x, 0.0)).rgb;',
  '  vec3 ne = texture2D(uTex, vUv + vec2( px.x,-px.y)).rgb;',
  '  vec3 nw = texture2D(uTex, vUv + vec2(-px.x,-px.y)).rgb;',
  '  vec3 se = texture2D(uTex, vUv + vec2( px.x, px.y)).rgb;',
  '  vec3 sw = texture2D(uTex, vUv + vec2(-px.x, px.y)).rgb;',
  '  vec3 blur = (ne + nw + se + sw) * 0.0625',
  '            + (n + s + e + w) * 0.125',
  '            + c * 0.25;',
  '  float luma = dot(c, vec3(0.299, 0.587, 0.114));',
  '  float amt = uAmount * smoothstep(0.15, 0.65, luma) * mix(0.6, 1.4, smoothstep(0.05, 0.2, uMotion));',
  '  vec3 col = c + (c - blur) * amt;',
  '  float luma709 = dot(col, vec3(0.2126, 0.7152, 0.0722));',
  '  float shadowLift = 1.0 + 0.16 * (1.0 - smoothstep(0.12, 0.42, luma709));',
  '  float highlightRoll = 1.0 - 0.18 * smoothstep(0.68, 0.92, luma709);',
  '  col *= shadowLift * highlightRoll;',
  '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
  '}'
].join('\n');

var FRAGMENT_STANDARD = [
  PRECISION,
  'varying vec2 vUv;',
  'uniform sampler2D uTex;',
  'uniform vec2 uInvTexel;',
  'uniform float uAmount;',
  'uniform float uMotion;',
  'uniform float uContrast;',
  'uniform float uSaturation;',
  'void main() {',
  '  if (vUv.x < -0.0001 || vUv.x > 1.0001 || vUv.y < -0.0001 || vUv.y > 1.0001) {',
  '    gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);',
  '    return;',
  '  }',
  '  vec2 px = uInvTexel * 1.5;',
  '  vec3 c  = texture2D(uTex, vUv).rgb;',
  '  vec3 n  = texture2D(uTex, vUv + vec2(0.0, -px.y)).rgb;',
  '  vec3 s  = texture2D(uTex, vUv + vec2(0.0,  px.y)).rgb;',
  '  vec3 e  = texture2D(uTex, vUv + vec2( px.x, 0.0)).rgb;',
  '  vec3 w  = texture2D(uTex, vUv + vec2(-px.x, 0.0)).rgb;',
  '  vec3 ne = texture2D(uTex, vUv + vec2( px.x,-px.y)).rgb;',
  '  vec3 nw = texture2D(uTex, vUv + vec2(-px.x,-px.y)).rgb;',
  '  vec3 se = texture2D(uTex, vUv + vec2( px.x, px.y)).rgb;',
  '  vec3 sw = texture2D(uTex, vUv + vec2(-px.x, px.y)).rgb;',
  '  vec3 blur = c * 0.25 + (n + s + e + w) * 0.125 + (ne + nw + se + sw) * 0.0625;',
  '  vec3 edge = c - blur;',
  '  float lumaW = dot(c, vec3(0.299, 0.587, 0.114));',
  '  float amt = uAmount * smoothstep(0.15, 0.65, lumaW) * mix(0.6, 1.4, smoothstep(0.05, 0.2, uMotion));',
  '  vec3 abs_edge = abs(edge);',
  '  float edgeAmp = max(max(abs_edge.r, abs_edge.g), abs_edge.b);',
  '  float coring = smoothstep(0.02, 0.05, edgeAmp);',
  '  float darkAtten = mix(0.5, 1.0, smoothstep(0.10, 0.32, lumaW));',
  '  vec3 edge_mask = smoothstep(vec3(0.015), vec3(0.04), abs_edge);',
  '  vec3 col = c + edge * amt * darkAtten * coring * edge_mask;',
  '  col = pow(abs(col), vec3(0.85));',
  '  col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);',
  '  float luma709 = dot(col, vec3(0.2126, 0.7152, 0.0722));',
  '  col = mix(vec3(luma709), col, uSaturation);',
  '  luma709 = dot(col, vec3(0.2126, 0.7152, 0.0722));',
  '  float shadowLift = 1.0 + 0.16 * (1.0 - smoothstep(0.12, 0.42, luma709));',
  '  float highlightRoll = 1.0 - 0.18 * smoothstep(0.68, 0.92, luma709);',
  '  col *= shadowLift * highlightRoll;',
  '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
  '}'
].join('\n');

var FRAGMENT_VK = [
  PRECISION,
  'varying vec2 vUv;',
  'uniform sampler2D uTex;',
  'uniform vec2 uTexel;',
  'uniform float uVkZoom;',
  'uniform float uAmount;',
  'uniform float uMotion;',
  'uniform float uContrast;',
  'uniform float uGamma;',
  'uniform float uSaturation;',
  'void main() {',
  '  float zDiv = max(uVkZoom, 1.0);',
  '  vec2 zUv = 0.5 + (vUv - 0.5) / zDiv;',
  '  vec2 px = uTexel * 1.5;',
  '  vec2 uv = clamp(zUv, vec2(0.0), vec2(1.0));',
  '  vec3 c  = texture2D(uTex, uv).rgb;',
  '  vec3 n  = texture2D(uTex, clamp(uv + vec2(0.0, -px.y), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 s  = texture2D(uTex, clamp(uv + vec2(0.0,  px.y), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 e  = texture2D(uTex, clamp(uv + vec2( px.x, 0.0), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 w  = texture2D(uTex, clamp(uv + vec2(-px.x, 0.0), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 ne = texture2D(uTex, clamp(uv + vec2( px.x,-px.y), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 nw = texture2D(uTex, clamp(uv + vec2(-px.x,-px.y), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 se = texture2D(uTex, clamp(uv + vec2( px.x, px.y), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 sw = texture2D(uTex, clamp(uv + vec2(-px.x, px.y), vec2(0.0), vec2(1.0))).rgb;',
  '  vec3 blur = c * 0.25 + (n + s + e + w) * 0.125 + (ne + nw + se + sw) * 0.0625;',
  '  vec3 edge = c - blur;',
  '  float lumaW = dot(c, vec3(0.299, 0.587, 0.114));',
  '  float baseAmt = uAmount * smoothstep(0.15, 0.65, lumaW) * mix(0.6, 1.4, smoothstep(0.05, 0.2, uMotion));',
  '  vec3 abs_edge = abs(edge);',
  '  float edgeAmp = max(max(abs_edge.r, abs_edge.g), abs_edge.b);',
  '  float coring = smoothstep(0.02, 0.05, edgeAmp);',
  '  float darkAtten = mix(0.5, 1.0, smoothstep(0.10, 0.32, lumaW));',
  '  vec3 edge_mask = smoothstep(vec3(0.015), vec3(0.04), abs_edge);',
  '  vec3 col = c + edge * baseAmt * darkAtten * coring * edge_mask;',
  '  vec3 minCol = min(min(min(n, s), min(e, w)), c);',
  '  vec3 maxCol = max(max(max(n, s), max(e, w)), c);',
  '  col = clamp(col, minCol, maxCol);',
  '  col = pow(abs(col), vec3(uGamma));',
  '  col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);',
  '  float luma709 = dot(col, vec3(0.2126, 0.7152, 0.0722));',
  '  col = mix(vec3(luma709), col, uSaturation);',
  '  luma709 = dot(col, vec3(0.2126, 0.7152, 0.0722));',
  '  float shadowLift = 1.0 + 0.16 * (1.0 - smoothstep(0.12, 0.42, luma709));',
  '  float highlightRoll = 1.0 - 0.18 * smoothstep(0.68, 0.92, luma709);',
  '  col *= shadowLift * highlightRoll;',
  '  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);',
  '}'
].join('\n');

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

var FRAGMENT_VK_YUV = [
  PRECISION,
  'varying vec2 vUv;',
  'uniform sampler2D uYTex;',
  'uniform sampler2D uUvTex;',
  'void main() {',
  '  float Y = texture2D(uYTex, vUv).r;',
  '  vec4 uv_color = texture2D(uUvTex, vUv);',
  '  vec2 UV = vec2(uv_color.r, uv_color.a) - 0.5;',
  '  vec3 rgb = mat3(',
  '    1.0, 1.0, 1.0,',
  '    0.0, -0.18732, 1.8556,',
  '    1.57481, -0.46812, 0.0',
  '  ) * vec3(Y, UV.x, UV.y);',
  '  gl_FragColor = vec4(clamp(rgb, 0.0, 1.0), 1.0);',
  '}'
].join('\n');

module.exports = {
  VERTEX: VERTEX,
  VERTEX_VK_YUV: VERTEX_VK_YUV,
  FRAGMENT_VK_YUV: FRAGMENT_VK_YUV,
  LITE: { fragment: FRAGMENT_LITE, uniforms: { uAmount: 0.35 } },
  STANDARD: { fragment: FRAGMENT_STANDARD, uniforms: { uAmount: 0.50, uContrast: 0.05, uSaturation: 1.10 } },
  STRONG: { fragment: FRAGMENT_STANDARD, uniforms: { uAmount: 0.60, uContrast: 0.10, uSaturation: 1.20 } },
  VK: {
    fragment: FRAGMENT_VK,
    uniforms: {
      uAmount: 0.52,
      uContrast: 0.12,
      uGamma: 0.85,
      uSaturation: 1.25,
      uVkZoom: 1.0
    }
  }
};
