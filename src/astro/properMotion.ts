/**
 * 自行（proper motion）推算。
 *
 * 星表给的是历元 J2000 的位置与自行 μ_α* = μ_α·cosδ、μ_δ（mas/yr）。
 * 观测时刻与 J2000 的差可以到几十年，Barnard 星这类高自行天体位移可达角分级，
 * 所以必须推算。
 *
 * 实现上走**大圆上的精确旋转**，而不是切平面线性外推：
 * 线性外推的误差量级是 θ²/2（θ 为总位移角），对 θ = 300″ 约 0.0002″，
 * 两者都远优于亚角秒；选精确解只是为了让 GPU 与 CPU 用同一套公式、便于对照。
 */

import { MAS_TO_RAD } from './constants';
import { cross, dot, normalize, type Vec3 } from './vec3';
import { EQ_NORTH_POLE, EQ_X_AXIS } from './vec3';

/** 赤道上「赤经增大方向」的单位切向量 ê_α = (-sinα, cosα, 0) */
export function eastTangent(p: Vec3): Vec3 {
  const n = normalize(p);
  let e = cross(EQ_NORTH_POLE, n);
  const len = Math.hypot(e.x, e.y, e.z);
  if (len < 1e-9) {
    // 恒星几乎正落在天极上：ê_α 退化，换一根参考轴，保证不产生 NaN。
    // 这个位置上 μ_α* = μ_α·cosδ 本身趋近 0，对结果没有可见影响。
    e = cross(EQ_X_AXIS, n);
    const len2 = Math.hypot(e.x, e.y, e.z);
    if (len2 < 1e-9) return { x: 1, y: 0, z: 0 };
    return { x: e.x / len2, y: e.y / len2, z: e.z / len2 };
  }
  return { x: e.x / len, y: e.y / len, z: e.z / len };
}

/** 赤道上「赤纬增大方向」的单位切向量 ê_δ = (-sinδcosα, -sinδsinα, cosδ) */
export function northTangent(p: Vec3): Vec3 {
  const n = normalize(p);
  return cross(n, eastTangent(n));
}

/**
 * 把 J2000 的单位向量按自行推算 `deltaYears` 年。
 *
 * @param p           J2000 位置单位向量
 * @param pmRaMas     μ_α* = μ_α·cosδ，单位 mas/yr
 * @param pmDecMas    μ_δ，单位 mas/yr
 * @param deltaYears  相对 J2000 的年数
 */
export function applyProperMotion(
  p: Vec3,
  pmRaMas: number,
  pmDecMas: number,
  deltaYears: number,
): Vec3 {
  if (!Number.isFinite(pmRaMas) || !Number.isFinite(pmDecMas)) return normalize(p);
  if (pmRaMas === 0 && pmDecMas === 0) return normalize(p);

  const n = normalize(p);
  const eA = eastTangent(n);
  const eD = northTangent(n);

  // 切平面上的位移速度矢量（mas/yr）
  const tx = pmRaMas * eA.x + pmDecMas * eD.x;
  const ty = pmRaMas * eA.y + pmDecMas * eD.y;
  const tz = pmRaMas * eA.z + pmDecMas * eD.z;
  const tLen = Math.hypot(tx, ty, tz);
  if (tLen === 0) return n;

  // 总位移角（弧度）
  const theta = tLen * MAS_TO_RAD * deltaYears;
  if (theta === 0) return n;

  // 沿大圆旋转 theta：p·cosθ + d·sinθ
  const dx = tx / tLen;
  const dy = ty / tLen;
  const dz = tz / tLen;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  return normalize({
    x: n.x * cosT + dx * sinT,
    y: n.y * cosT + dy * sinT,
    z: n.z * cosT + dz * sinT,
  });
}

/**
 * 自行引起的切线方向单位向量（mas/yr 归一化），
 * 供 GPU 顶点着色器用同样的公式复现。
 */
export function properMotionTangent(p: Vec3, pmRaMas: number, pmDecMas: number): Vec3 {
  const n = normalize(p);
  const eA = eastTangent(n);
  const eD = northTangent(n);
  const t = {
    x: pmRaMas * eA.x + pmDecMas * eD.x,
    y: pmRaMas * eA.y + pmDecMas * eD.y,
    z: pmRaMas * eA.z + pmDecMas * eD.z,
  };
  const len = Math.hypot(t.x, t.y, t.z);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: t.x / len, y: t.y / len, z: t.z / len };
}

/** 两点之间的角距离（度） */
export function angularSeparationDeg(a: Vec3, b: Vec3): number {
  const c = Math.max(-1, Math.min(1, dot(normalize(a), normalize(b))));
  return (Math.acos(c) * 180) / Math.PI;
}
