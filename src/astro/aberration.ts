/**
 * 周年光行差与地球速度。
 *
 * 地球绕日公转速度约 29.8 km/s，对应 v/c ≈ 9.94×10⁻⁵，
 * 造成的视位置偏移最大约 20.5″，必须计入才能达到亚角秒精度。
 *
 * 另外还有**周日光行差**：观测者随地球自转的线速度，
 * 赤道上最大 465 m/s（v/c ≈ 1.55×10⁻⁶，约 0.32″），
 * 量级虽小，但它是「亚角秒」与「角秒」的分界，所以一并计入。
 *
 * 采用标准的一阶矢量公式：
 * ```
 * n' = normalize(n + v/c)
 * ```
 * 与严格相对论公式的差别是 O((v/c)²) ≈ 1×10⁻⁸ rad ≈ 0.002″，可忽略。
 */

import { Body, HelioVector, MakeTime, type AstroTime, type Observer } from 'astronomy-engine';
import {
  DEG,
  EARTH_ROTATION_RATE,
  SPEED_OF_LIGHT_AU_PER_DAY,
  SPEED_OF_LIGHT_M_PER_S,
  WGS84_EQUATORIAL_RADIUS_M,
} from './constants';
import { precessionNutationMatrix } from './coordinates';
import { localSiderealTime } from './time';
import { mat3Apply, mat3Transpose, normalize, type Vec3 } from './vec3';

/** 差分步长（天）。太小会被浮点误差吃掉，太大引入曲率误差；0.02 天是稳妥值。 */
const VELOCITY_STEP_DAYS = 0.02;

/**
 * 地球的日心速度矢量，单位 AU/天，参考系 EQJ（赤道 J2000）。
 *
 * astronomy-engine 没有直接给「地球速度」，用日心位置做中心差分即可。
 */
export function earthHeliocentricVelocity(time: AstroTime): Vec3 {
  const ahead: Vec3 = HelioVector(Body.Earth, time.AddDays(VELOCITY_STEP_DAYS));
  const behind: Vec3 = HelioVector(Body.Earth, time.AddDays(-VELOCITY_STEP_DAYS));
  const inv = 1 / (2 * VELOCITY_STEP_DAYS);
  return {
    x: (ahead.x - behind.x) * inv,
    y: (ahead.y - behind.y) * inv,
    z: (ahead.z - behind.z) * inv,
  };
}

/** 地球公转速度除以光速（无量纲矢量），在 EQJ 参考系中 */
export function earthVelocityOverC(time: AstroTime): Vec3 {
  const v = earthHeliocentricVelocity(time);
  return {
    x: v.x / SPEED_OF_LIGHT_AU_PER_DAY,
    y: v.y / SPEED_OF_LIGHT_AU_PER_DAY,
    z: v.z / SPEED_OF_LIGHT_AU_PER_DAY,
  };
}

/**
 * 观测者随地球自转的线速度（m/s），在 EQD（真赤道 of date）参考系中。
 *
 * 用球坐标近似（把地球当正球，半径取 WGS84 赤道半径 + 海拔）。
 * 纬度用大地纬度代替地心纬度，两者差最大 0.19°，对 0.3″ 量级的速度方向
 * 影响可忽略。
 */
export function earthRotationVelocityEqd(date: Date, observer: Observer): Vec3 {
  const theta = localSiderealTime(date, observer.longitude) * 15 * DEG;
  const lat = observer.latitude * DEG;
  const radius = WGS84_EQUATORIAL_RADIUS_M + Math.max(0, observer.height);
  const speed = EARTH_ROTATION_RATE * radius * Math.cos(lat);
  return { x: -speed * Math.sin(theta), y: speed * Math.cos(theta), z: 0 };
}

/**
 * 观测者的总速度除以光速（公转 + 自转），在 EQJ 参考系中。
 *
 * 这是施加光行差时应该用的矢量：光行差取决于观测者相对太阳系质心的速度，
 * 只算公转会让残差停在 0.3″ 量级。
 *
 * @param date     观测时刻
 * @param observer 观测者位置
 */
export function observerVelocityOverC(date: Date, observer: Observer): Vec3 {
  const time = MakeTime(date);
  const helio = earthHeliocentricVelocity(time);

  // 自转速度先在 EQD 里算，再转回 EQJ
  const rotEqd = earthRotationVelocityEqd(date, observer);
  const eqdToEqj = mat3Transpose(precessionNutationMatrix(date));
  const rotEqj = mat3Apply(eqdToEqj, rotEqd);

  return {
    x: helio.x / SPEED_OF_LIGHT_AU_PER_DAY + rotEqj.x / SPEED_OF_LIGHT_M_PER_S,
    y: helio.y / SPEED_OF_LIGHT_AU_PER_DAY + rotEqj.y / SPEED_OF_LIGHT_M_PER_S,
    z: helio.z / SPEED_OF_LIGHT_AU_PER_DAY + rotEqj.z / SPEED_OF_LIGHT_M_PER_S,
  };
}

/**
 * 对单位方向向量施加周年光行差。
 *
 * @param p      J2000 单位向量（自行已推算过）
 * @param vOverC 地球速度 / 光速，必须与 p 在同一参考系（EQJ）
 */
export function applyAberration(p: Vec3, vOverC: Vec3): Vec3 {
  return normalize({
    x: p.x + vOverC.x,
    y: p.y + vOverC.y,
    z: p.z + vOverC.z,
  });
}

/** 光行差造成的偏移角（角秒），用于诊断显示 */
export function aberrationMagnitudeArcsec(vOverC: Vec3): number {
  const v = Math.hypot(vOverC.x, vOverC.y, vOverC.z);
  return (v * 180 * 3600) / Math.PI;
}
