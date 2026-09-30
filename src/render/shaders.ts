/**
 * 全部 GLSL 着色器。
 *
 * ## 渲染管线
 *
 * 整个天空**不用 Three.js 的透视相机**，而是自己在顶点着色器里算
 * `gl_Position`：相机固定在球心，投影方式是 Stellarium 默认的**立体投影**。
 *
 * ```
 * 立体投影：R = 2·tan(θ/2)
 *   正向（方向 → 屏幕）：p = u.xy · 2 / (1 + u.z)
 *   反向（屏幕 → 方向）：R² = p.x² + p.y²
 *                        dir = (4p.x, 4p.y, 4−R²) / (4+R²)
 * ```
 *
 * 其中 `u` 是相机空间里的单位方向（z 轴朝视线中心）。
 * 屏幕半高对应的平面半径是 `R_v = 2·tan(fov/4)`，于是
 * `ndc = (p.x / (R_v·aspect), p.y / R_v)`。
 *
 * ## 颜色空间
 *
 * 所有图层都渲染到一张 **HalfFloat 线性** 的 RenderTarget，
 * 最后再由 `PRESENT` 一遍做色调映射 + 线性→sRGB 编码。
 * 这样星点之间的加法混合发生在物理线性的亮度上，叠加出来的
 * 星芒亮度才是对的（直接在 sRGB 缓冲上加法混合会偏亮）。
 */

/** 各着色器共用的工具函数 */
export const GLSL_COMMON = /* glsl */ `
const float PI = 3.141592653589793;
const float MAS_TO_RAD = 4.84813681109536e-9;

/** 线性 sRGB → 带伽马的 sRGB（0..1） */
vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

/** 色调映射：指数式，高光柔和压缩，不会硬切 */
vec3 tonemap(vec3 c) {
  c = max(c, vec3(0.0));
  return 1.0 - exp(-c);
}

/** 赤道 J2000 方向 → 地平高度角（弧度）。三个坐标系约定：HOR 为 x=北, y=西, z=天顶 */
float altitudeOf(vec3 hor) {
  return asin(clamp(hor.z, -1.0, 1.0));
}
`;

// ---------------------------------------------------------------------------
// 星点
// ---------------------------------------------------------------------------

export const STAR_VERTEX = /* glsl */ `
${GLSL_COMMON}

attribute float aMag;
attribute vec4 aColor;   // rgb = 线性 sRGB 颜色，a = B-V 编码（片元着色器不用）
attribute vec2 aPM;      // μ_α*、μ_δ（mas/yr）

uniform mat3 uEquToHoriz;   // 赤道 J2000 → 地平
uniform mat3 uHorizToCam;   // 地平 → 相机
uniform float uDeltaYears;  // 距 J2000 的儒略年数
uniform vec3 uAberration;   // 观测者速度 / 光速（赤道 J2000 系）
uniform float uFovHalfTan;  // R_v = 2·tan(fov/4)
uniform float uAspect;
uniform float uMagLimit;    // 暗于此星等的星直接剔除
uniform float uMagZero;     // 亮度/尺寸的参考星等
uniform float uSizeScale;   // 参考星等处的点径（像素）
uniform float uMinSizePx;
uniform float uMaxSizePx;
uniform float uPixelRatio;
uniform float uHorizonFadeDeg;

varying vec3 vColor;
varying float vIntensity;

void main() {
  vec3 p = normalize(position);

  // ---- 自行：沿大圆做精确旋转 ----
  if (uDeltaYears != 0.0 && (aPM.x != 0.0 || aPM.y != 0.0)) {
    vec3 eA = cross(vec3(0.0, 0.0, 1.0), p);
    float la = length(eA);
    if (la < 1e-6) {
      eA = cross(vec3(1.0, 0.0, 0.0), p);
      la = length(eA);
    }
    eA = la > 0.0 ? eA / la : vec3(1.0, 0.0, 0.0);
    vec3 eD = cross(p, eA);
    vec3 t = aPM.x * eA + aPM.y * eD;
    float tl = length(t);
    if (tl > 0.0) {
      float theta = tl * MAS_TO_RAD * uDeltaYears;
      vec3 d = t / tl;
      p = normalize(p * cos(theta) + d * sin(theta));
    }
  }

  // ---- 周年 + 周日光行差 ----
  p = normalize(p + uAberration);

  // ---- 赤道 → 地平 ----
  vec3 hor = uEquToHoriz * p;
  float altDeg = degrees(altitudeOf(hor));

  // ---- 地平线以下：剔除 ----
  // 用一个平滑带而不是硬切，视觉上更像有地形起伏的地平
  float above = smoothstep(-uHorizonFadeDeg, uHorizonFadeDeg * 0.35, altDeg);
  if (above <= 0.001 || aMag > uMagLimit) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vIntensity = 0.0;
    return;
  }

  // ---- 相机变换 + 立体投影 ----
  vec3 cam = uHorizToCam * hor;
  float denom = 1.0 + cam.z;
  if (denom < 1e-4) {
    // 落在投影奇点（视线正后方）附近
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vColor = vec3(0.0);
    vIntensity = 0.0;
    return;
  }
  vec2 plane = cam.xy * (2.0 / denom);
  vec2 ndc = vec2(plane.x / (uFovHalfTan * uAspect), plane.y / uFovHalfTan);
  gl_Position = vec4(ndc, 0.0, 1.0);

  // ---- 点径：随星等非线性收缩 ----
  float dm = aMag - uMagZero;
  float sizePx = clamp(uSizeScale * pow(10.0, -0.11 * dm), uMinSizePx, uMaxSizePx);
  gl_PointSize = sizePx * uPixelRatio;

  // ---- 亮度：flux ∝ 10^(−0.4·Δm)，再用幂次把 10 个量级的动态范围压到可显示 ----
  float flux = pow(10.0, -0.4 * dm);
  vIntensity = pow(clamp(flux, 0.0, 1.0e6), 0.42) * above;
  vColor = aColor.rgb;
}
`;

export const STAR_FRAGMENT = /* glsl */ `
${GLSL_COMMON}

varying vec3 vColor;
varying float vIntensity;

void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;

  // 点扩散函数：紧致核心 + 宽而弱的halo，模拟亮星的光晕
  float core = exp(-r2 * 5.0);
  float halo = exp(-r2 * 1.1) * 0.16;
  float psf = core + halo;

  gl_FragColor = vec4(vColor * vIntensity * psf, 1.0);
}
`;

// ---------------------------------------------------------------------------
// 线（星座连线 / 赤道网格 / 地平网格 / 地平线）
// ---------------------------------------------------------------------------

export const LINE_VERTEX = /* glsl */ `
${GLSL_COMMON}

uniform mat3 uEquToHoriz;
uniform mat3 uHorizToCam;
uniform float uFovHalfTan;
uniform float uAspect;
uniform float uHorizonFadeDeg;

varying float vFade;

void main() {
  vec3 hor = uEquToHoriz * position;
  float altDeg = degrees(altitudeOf(hor));

  // 地平线以下**不剔除顶点**，只把透明度插值到 0。
  //
  // 如果像星点那样把顶点丢到屏幕外，线段会被裁剪成一条横穿画面的假线
  // （一端在画面内、另一端在屏幕外，裁剪后仍有一段落在视口里）。
  // 用透明度过渡既没有假线，又能得到「线在地平线处淡出」的正确观感。
  vFade = smoothstep(-uHorizonFadeDeg * 3.0, 0.0, altDeg);

  vec3 cam = uHorizToCam * hor;
  // 立体投影的奇点在视线正后方（cam.z = −1）。夹住分母避免除零，
  // 得到的巨大坐标由 GPU 裁剪掉 —— 这正是立体投影对该区域的正确表现。
  float denom = max(1.0 + cam.z, 0.0015);
  vec2 plane = cam.xy * (2.0 / denom);
  vec2 ndc = vec2(plane.x / (uFovHalfTan * uAspect), plane.y / uFovHalfTan);

  gl_Position = vec4(ndc, 0.0, 1.0);
}
`;

export const LINE_FRAGMENT = /* glsl */ `
${GLSL_COMMON}

uniform vec3 uColor;
uniform float uOpacity;

varying float vFade;

void main() {
  float a = uOpacity * vFade;
  if (a <= 0.002) discard;
  gl_FragColor = vec4(uColor * a, a);
}
`;

// ---------------------------------------------------------------------------
// 太阳系天体（太阳 / 月亮 / 行星），带月相
// ---------------------------------------------------------------------------

export const BODY_VERTEX = /* glsl */ `
${GLSL_COMMON}

attribute vec3 aBodyColor;
attribute float aBodySizePx;
attribute float aPhaseAngle;   // 太阳-天体-观测者 夹角（弧度）
attribute vec2 aLimbDir;       // 亮边在切平面上的方向 (东, 北)

uniform mat3 uHorizToCam;
uniform float uFovHalfTan;
uniform float uAspect;
uniform float uPixelRatio;

varying vec3 vColor;
varying float vPhaseAngle;
varying vec2 vLimbDir;
varying float vVisible;

void main() {
  // 位置直接就是地平单位向量，逐帧在 CPU 上重算（只有 9 个天体）
  vec3 hor = position;
  vec3 cam = uHorizToCam * hor;
  float denom = 1.0 + cam.z;
  if (denom < 1e-3 || hor.z < -0.02) {
    vVisible = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }
  vec2 plane = cam.xy * (2.0 / denom);
  vec2 ndc = vec2(plane.x / (uFovHalfTan * uAspect), plane.y / uFovHalfTan);
  gl_Position = vec4(ndc, 0.0, 1.0);

  vVisible = 1.0;
  vColor = aBodyColor;
  vPhaseAngle = aPhaseAngle;
  vLimbDir = aLimbDir;
  gl_PointSize = max(aBodySizePx * uPixelRatio, 3.0 * uPixelRatio);
}
`;

export const BODY_FRAGMENT = /* glsl */ `
${GLSL_COMMON}

varying vec3 vColor;
varying float vPhaseAngle;
varying vec2 vLimbDir;
varying float vVisible;

void main() {
  if (vVisible < 0.5) discard;

  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;

  // 把屏幕上的圆盘还原成球面法线（局部系：x=东, y=北, z=指向观测者）
  float nz = sqrt(max(0.0, 1.0 - r2));
  vec3 n = vec3(d.x, d.y, nz);

  // 太阳在同一个局部系里的方向
  float sa = sin(vPhaseAngle);
  float ca = cos(vPhaseAngle);
  vec3 sun = vec3(vLimbDir.x * sa, vLimbDir.y * sa, ca);

  float lambert = max(0.0, dot(n, sun));

  // 边缘昏暗（月亮与行星都有，太阳除外）
  float limb = 0.55 + 0.45 * nz;
  float shade = lambert * limb;

  // 未照亮的部分给一点点地照/地球反照，避免死黑
  float earthshine = 0.02;

  gl_FragColor = vec4(vColor * (shade + earthshine), 1.0);
}
`;

// ---------------------------------------------------------------------------
// 背景（银河 + 天光 + 地面）
// ---------------------------------------------------------------------------

export const BACKGROUND_VERTEX = /* glsl */ `
varying vec2 vNdc;
void main() {
  // 全屏三角形：顶点已经就是 NDC，不做任何变换
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const BACKGROUND_FRAGMENT = /* glsl */ `
${GLSL_COMMON}

varying vec2 vNdc;

uniform float uFovHalfTan;
uniform float uAspect;
uniform mat3 uCamToHoriz;   // 相机 → 地平
uniform mat3 uCamToEqu;     // 相机 → 赤道 J2000

uniform sampler2D uMilkyWay;
uniform float uHasMilkyWay;
uniform float uMilkyWayStrength;
uniform vec2 uMilkyWayUv;   // (uOffset, uSign)

uniform vec3 uNightColor;
uniform vec3 uTwilightColor;
uniform vec3 uMoonColor;
uniform float uSkyNight;
uniform float uSkyTwilight;
uniform float uSkyMoon;
uniform vec3 uMoonDirHoriz;

uniform vec3 uGroundColor;
uniform vec3 uGroundGlowColor;
uniform float uShowGround;

/** 立体投影的反解：屏幕 NDC → 相机空间单位方向 */
vec3 directionFromNdc(vec2 ndc) {
  vec2 p = vec2(ndc.x * uFovHalfTan * uAspect, ndc.y * uFovHalfTan);
  float r2 = dot(p, p);
  return vec3(4.0 * p.x, 4.0 * p.y, 4.0 - r2) / (4.0 + r2);
}

void main() {
  vec3 dirCam = directionFromNdc(vNdc);
  vec3 hor = uCamToHoriz * dirCam;
  vec3 equ = uCamToEqu * dirCam;

  float altRad = altitudeOf(hor);
  float altDeg = degrees(altRad);

  // 地平线附近的软过渡：既表现大气折射，也避免地面边缘是一条硬线
  float groundMask = uShowGround * smoothstep(0.6, -0.4, altDeg);

  // ---- 视线方向上的大气厚度：近地平线更厚，散射更强 ----
  float airmassish = 1.0 / (max(sin(altRad), 0.02) + 0.06);
  float horizonBoost = clamp(airmassish * 0.30, 0.0, 2.4);

  // ---- 月光散射的角分布：越靠近月亮越亮 ----
  float moonCos = max(dot(hor, uMoonDirHoriz), 0.0);
  float moonProx = pow(moonCos, 10.0);

  float night = uSkyNight * (0.55 + 0.45 * horizonBoost);
  float twilight = uSkyTwilight * horizonBoost;
  float moon = uSkyMoon * (0.22 + 1.4 * moonProx) * (0.7 + 0.3 * horizonBoost);

  vec3 sky = uNightColor * night + uTwilightColor * twilight + uMoonColor * moon;

  // ---- 银河 ----
  if (uHasMilkyWay > 0.5) {
    float ra = atan(equ.y, equ.x);
    float dec = asin(clamp(equ.z, -1.0, 1.0));
    vec2 uv = vec2(uMilkyWayUv.x + uMilkyWayUv.y * ra / (2.0 * PI), (dec + PI * 0.5) / PI);
    vec3 srgb = texture2D(uMilkyWay, uv).rgb;
    // JPEG 里存的是 sRGB 编码值，解码回线性再叠加
    vec3 lin = pow(max(srgb, vec3(0.0)), vec3(2.2));
    // 让银河也受大气消光影响：越靠近地平越暗
    float extinction = exp(-horizonBoost * 0.85);
    sky += lin * uMilkyWayStrength * extinction * (1.0 - groundMask);
  }

  // ---- 地面 ----
  float depth = clamp(-altDeg / 90.0, 0.0, 1.0);
  vec3 ground = mix(uGroundGlowColor, uGroundColor, smoothstep(0.0, 0.35, depth));

  vec3 color = mix(sky, ground, groundMask);
  gl_FragColor = vec4(color, 1.0);
}
`;

// ---------------------------------------------------------------------------
// 最终呈现（色调映射 + sRGB 编码）
// ---------------------------------------------------------------------------

export const PRESENT_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const PRESENT_FRAGMENT = /* glsl */ `
${GLSL_COMMON}

uniform sampler2D uScene;
uniform float uExposure;

varying vec2 vUv;

void main() {
  vec3 linear = texture2D(uScene, vUv).rgb * uExposure;
  // 防御性钳制：任何 Inf / 超大值都会让色调映射产出 NaN，最后渲染成黑色，
  // 而现象看起来更像是「什么都没画」，很难反查。
  linear = clamp(linear, vec3(0.0), vec3(60000.0));
  gl_FragColor = vec4(linearToSrgb(tonemap(linear)), 1.0);
}
`;
