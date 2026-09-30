/**
 * 极简三维向量/矩阵工具。
 *
 * 这里刻意不依赖 Three.js：`astro/` 目录要求是「纯计算」，可以在 Node 里直接跑单测。
 * 向量用对象表示（而不是数组），避免 `noUncheckedIndexedAccess` 带来的下标类型噪音。
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 3x3 矩阵，长度 9 的行主序数组 */
export type Mat3 = Float64Array;

export const VEC_ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });

/** 天球极轴（赤道坐标系 z 轴，指向北天极） */
export const EQ_NORTH_POLE: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 1 });

/** 赤道坐标系 x 轴（指向春分点） */
export const EQ_X_AXIS: Readonly<Vec3> = Object.freeze({ x: 1, y: 0, z: 0 });

export function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function normalize(a: Vec3): Vec3 {
  const len = Math.hypot(a.x, a.y, a.z);
  if (len === 0) {
    throw new Error('normalize() 收到零向量');
  }
  return { x: a.x / len, y: a.y / len, z: a.z / len };
}

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/** 两个单位向量之间的夹角（弧度） */
export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(clamp(dot(a, b), -1, 1));
}

// ---------------------------------------------------------------------------
// 矩阵
// ---------------------------------------------------------------------------

export function mat3Identity(): Mat3 {
  return new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
}

/** 行主序 3x3 矩阵乘向量 */
export function mat3Apply(m: Mat3, v: Vec3): Vec3 {
  return {
    x: m[0]! * v.x + m[1]! * v.y + m[2]! * v.z,
    y: m[3]! * v.x + m[4]! * v.y + m[5]! * v.z,
    z: m[6]! * v.x + m[7]! * v.y + m[8]! * v.z,
  };
}

/** 行主序 3x3 矩阵相乘：返回 a·b */
export function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3 + 0]! * b[0 * 3 + c]! +
        a[r * 3 + 1]! * b[1 * 3 + c]! +
        a[r * 3 + 2]! * b[2 * 3 + c]!;
    }
  }
  return out;
}

/** 转置。正交旋转矩阵的转置即逆矩阵。 */
export function mat3Transpose(m: Mat3): Mat3 {
  return new Float64Array([m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!]);
}

/** 从嵌套数组（astronomy-engine 的 RotationMatrix.rot）转换过来 */
export function mat3FromNested(rot: readonly (readonly number[])[]): Mat3 {
  const out = new Float64Array(9);
  for (let r = 0; r < 3; r++) {
    const row = rot[r];
    if (!row) throw new Error(`mat3FromNested: 缺少第 ${r} 行`);
    for (let c = 0; c < 3; c++) {
      const value = row[c];
      if (typeof value !== 'number') {
        throw new Error(`mat3FromNested: 第 ${r} 行第 ${c} 列不是数字`);
      }
      out[r * 3 + c] = value;
    }
  }
  return out;
}
