/**
 * 坐标系转换。
 *
 * ## 坐标系约定
 *
 * - **EQJ / ICRS（赤道 J2000）**：x → 春分点，y → 赤经 6h，z → 北天极。
 *   星表里存的单位向量就是这个坐标系。
 * - **EQD（真赤道、真春分点，of date）**：含岁差 + 章动。
 *   用 `Rotation_EQJ_EQD` 得到，用 GAST（视恒星时）配套。
 * - **HOR（地平）**：**x = 北，y = 西，z = 天顶**。
 *   这个约定与 astronomy-engine 的 `Rotation_EQD_HOR` 完全一致，
 *   因此可以用它直接做交叉验证。方位角 = atan2(-y, x)（从北起、向东为正）。
 *
 * ## 为什么必须做岁差
 *
 * 岁差约 50″/年，J2000 到现在已积累约 0.3°，远大于「亚角秒」的目标。
 * 所以链路是：自行 →（J2000 单位向量）→ 岁差章动 → 光行差 → 地平。
 */

import {
  Observer,
  Rotation_EQD_HOR,
  Rotation_EQJ_EQD,
  type RotationMatrix,
} from 'astronomy-engine';
import { DEG, RAD } from './constants';
import { localSiderealTime } from './time';
import { clamp, cross, mat3Multiply, normalize, type Mat3, type Vec3 } from './vec3';

/** 赤经赤纬（度）→ 单位向量（赤道坐标系） */
export function raDecToVector(raDeg: number, decDeg: number): Vec3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const cosDec = Math.cos(dec);
  return { x: cosDec * Math.cos(ra), y: cosDec * Math.sin(ra), z: Math.sin(dec) };
}

/** 单位向量（赤道坐标系）→ 赤经赤纬（度，ra ∈ [0,360)，dec ∈ [-90,90]） */
export function vectorToRaDec(v: Vec3): { raDeg: number; decDeg: number } {
  const n = normalize(v);
  const ra = Math.atan2(n.y, n.x) * RAD;
  return {
    raDeg: ((ra % 360) + 360) % 360,
    decDeg: Math.asin(clamp(n.z, -1, 1)) * RAD,
  };
}

/**
 * 赤道 of date（EQD）→ 地平（HOR）的旋转矩阵，本文件自行实现，用于单测交叉验证。
 *
 * 矩阵的三行分别是「北、西、天顶」三个单位向量在 EQD 中的表达式：
 * ```
 * N̂ = (-sinφ·cosL, -sinφ·sinL,  cosφ)
 * Ŵ = ( sinL,      -cosL,        0   )
 * Ẑ = ( cosφ·cosL,  cosφ·sinL,  sinφ)
 * ```
 *
 * @param latitudeDeg 观测者地理纬度（度）
 * @param lstHours    地方视恒星时（小时）
 */
export function equToHorMatrix(latitudeDeg: number, lstHours: number): Mat3 {
  const lat = latitudeDeg * DEG;
  const lst = lstHours * DEG * 15;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const sinL = Math.sin(lst);
  const cosL = Math.cos(lst);

  return new Float64Array([
    // 北
    -sinLat * cosL,
    -sinLat * sinL,
    cosLat,
    // 西
    sinL,
    -cosL,
    0,
    // 天顶
    cosLat * cosL,
    cosLat * sinL,
    sinLat,
  ]);
}

/**
 * 把 astronomy-engine 的 `RotationMatrix` 转成标准行主序 3×3 矩阵（约定 `v' = M·v`）。
 *
 * ⚠️ **这里有个容易踩的坑**：`RotationMatrix.rot[i][j]` **不是** `M[i][j]`。
 * astronomy-engine 内部用 `RotateVector()` 做变换，而它的实现是
 * ```
 * v'ᵢ = Σⱼ rot[j][i] · vⱼ
 * ```
 * 也就是说 `rot` 存的是实际矩阵的**转置**。直接按行主序用 `rot` 会得到反向旋转，
 * 表现为方位角整体镜像/倒转。这里按 `M[i][j] = rot[j][i]` 读取，
 * 并由 `coordinates.test.ts` 里一条「用 `RotateVector` 对三个基向量做探针」的
 * 单测来交叉验证。
 */
export function rotationToMat3(rotation: RotationMatrix): Mat3 {
  const rows = rotation.rot;
  const at = (r: number, c: number): number => {
    const row = rows[r];
    if (!row) throw new Error(`rotationToMat3: 缺少第 ${r} 行`);
    const value = row[c];
    if (typeof value !== 'number') throw new Error(`rotationToMat3: rot[${r}][${c}] 不是数字`);
    return value;
  };
  return new Float64Array([
    at(0, 0),
    at(1, 0),
    at(2, 0),
    at(0, 1),
    at(1, 1),
    at(2, 1),
    at(0, 2),
    at(1, 2),
    at(2, 2),
  ]);
}

/** 由 astronomy-engine 给出 EQJ(J2000) → EQD(of date) 的岁差 + 章动矩阵 */
export function precessionNutationMatrix(date: Date): Mat3 {
  return rotationToMat3(Rotation_EQJ_EQD(date));
}

/** 由 astronomy-engine 给出 EQD(of date) → HOR 的旋转矩阵 */
export function ofDateToHorizonMatrix(date: Date, observer: Observer): Mat3 {
  return rotationToMat3(Rotation_EQD_HOR(date, observer));
}

/**
 * 完整链路：赤道 J2000 单位向量 → 地平单位向量（x=北, y=西, z=天顶）。
 *
 * 内部用 astronomy-engine 的岁差章动 + 地平旋转，精度优于 1″。
 * 光行差需要调用方另行施加（见 `applyAberration`）。
 */
export function j2000ToHorizonMatrix(observer: Observer, date: Date): Mat3 {
  return mat3Multiply(ofDateToHorizonMatrix(date, observer), precessionNutationMatrix(date));
}

/** 只做岁差章动、不加光行差的版本（自行已在别处处理） */
export function j2000ToOfDateMatrix(date: Date): Mat3 {
  return precessionNutationMatrix(date);
}

/** 地平单位向量（x=北, y=西, z=天顶）→ 方位角/高度角（度） */
export function horizonToAzAlt(v: Vec3): { azimuthDeg: number; altitudeDeg: number } {
  const n = normalize(v);
  const azimuth = Math.atan2(-n.y, n.x) * RAD;
  return {
    azimuthDeg: ((azimuth % 360) + 360) % 360,
    altitudeDeg: Math.asin(clamp(n.z, -1, 1)) * RAD,
  };
}

/** 方位角/高度角（度）→ 地平单位向量（x=北, y=西, z=天顶） */
export function azAltToHorizon(azimuthDeg: number, altitudeDeg: number): Vec3 {
  const az = azimuthDeg * DEG;
  const alt = altitudeDeg * DEG;
  const cosAlt = Math.cos(alt);
  return {
    x: cosAlt * Math.cos(az),
    y: -cosAlt * Math.sin(az),
    z: Math.sin(alt),
  };
}

/** 方位角（度）→ 中文方位名 */
export function azimuthToCompass(azimuthDeg: number): string {
  const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  const idx = Math.round((((azimuthDeg % 360) + 360) % 360) / 45) % 8;
  return names[idx] ?? '北';
}

/**
 * 由 A 指向 B 的大圆方位角（度，从北起向东为正）。
 * 用于「指向天体」这类功能。
 */
export function bearingBetween(from: Vec3, to: Vec3): number {
  const nf = normalize(from);
  const nt = normalize(to);
  // 以 nf 为「天顶」、nf×ẑ 为「东」构造局部切平面
  let east = cross({ x: 0, y: 0, z: 1 }, nf);
  const eastLen = Math.hypot(east.x, east.y, east.z);
  if (eastLen < 1e-12) {
    east = { x: 1, y: 0, z: 0 };
  } else {
    east = { x: east.x / eastLen, y: east.y / eastLen, z: east.z / eastLen };
  }
  const north = cross(nf, east);
  const bearing = Math.atan2(
    nt.x * east.x + nt.y * east.y + nt.z * east.z,
    nt.x * north.x + nt.y * north.y + nt.z * north.z,
  );
  return (((bearing * RAD) % 360) + 360) % 360;
}

/** 便捷封装：给定经纬度与时间，返回 J2000 → 地平 的矩阵 */
export function j2000ToHorizonMatrixAt(
  date: Date,
  latitudeDeg: number,
  longitudeDeg: number,
  heightM = 0,
): Mat3 {
  return j2000ToHorizonMatrix(new Observer(latitudeDeg, longitudeDeg, heightM), date);
}

/** 便捷封装：本地恒星时 + 纬度 的纯公式版矩阵（单测用） */
export function equToHorMatrixAt(date: Date, latitudeDeg: number, longitudeDeg: number): Mat3 {
  return equToHorMatrix(latitudeDeg, localSiderealTime(date, longitudeDeg));
}
