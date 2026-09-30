/**
 * 太阳、月亮与八大行星。
 *
 * 位置一律用 astronomy-engine 的 `Equator(body, date, observer, ofdate=true, aberration=true)`：
 * - `observer` 传入后返回的是**站心**坐标，月亮的周日视差（最大约 1°）会被正确扣除；
 * - `ofdate=true` 得到真赤道 of date 坐标，与 `Rotation_EQD_HOR` 配套；
 * - `aberration=true` 计入光行差。
 *
 * 星等、相位来自 `Illumination()`；视直径由物理半径与地心距算得。
 */

import { Body, Equator, Illumination, type Observer } from 'astronomy-engine';
import { AU_IN_KM, DEG, RAD } from './constants';
import { azAltToHorizon, horizonToAzAlt, ofDateToHorizonMatrix } from './coordinates';
import { mat3Apply, normalize, type Vec3 } from './vec3';

export type SolarSystemKind = 'sun' | 'moon' | 'planet';

export interface SolarSystemBodyDef {
  key: string;
  nameZh: string;
  nameEn: string;
  kind: SolarSystemKind;
  body: Body;
  /** 物理半径（km），用于算视直径 */
  radiusKm: number;
  /** 渲染用基础颜色（0xRRGGBB，sRGB 编码） */
  color: number;
}

/**
 * 八大行星 + 太阳 + 月亮。
 * 冥王星按 IAU 2006 的定义不算行星，故不列入。
 */
export const SOLAR_SYSTEM_BODIES: readonly SolarSystemBodyDef[] = Object.freeze([
  { key: 'sun', nameZh: '太阳', nameEn: 'Sun', kind: 'sun', body: Body.Sun, radiusKm: 696000, color: 0xfff4e0 },
  { key: 'moon', nameZh: '月亮', nameEn: 'Moon', kind: 'moon', body: Body.Moon, radiusKm: 1737.4, color: 0xdedad2 },
  { key: 'mercury', nameZh: '水星', nameEn: 'Mercury', kind: 'planet', body: Body.Mercury, radiusKm: 2439.7, color: 0xbfb6ab },
  { key: 'venus', nameZh: '金星', nameEn: 'Venus', kind: 'planet', body: Body.Venus, radiusKm: 6051.8, color: 0xf6e7c0 },
  { key: 'mars', nameZh: '火星', nameEn: 'Mars', kind: 'planet', body: Body.Mars, radiusKm: 3389.5, color: 0xe07a4a },
  { key: 'jupiter', nameZh: '木星', nameEn: 'Jupiter', kind: 'planet', body: Body.Jupiter, radiusKm: 69911, color: 0xe8cfa0 },
  { key: 'saturn', nameZh: '土星', nameEn: 'Saturn', kind: 'planet', body: Body.Saturn, radiusKm: 58232, color: 0xf0dfae },
  { key: 'uranus', nameZh: '天王星', nameEn: 'Uranus', kind: 'planet', body: Body.Uranus, radiusKm: 25362, color: 0xa8e0e8 },
  { key: 'neptune', nameZh: '海王星', nameEn: 'Neptune', kind: 'planet', body: Body.Neptune, radiusKm: 24622, color: 0x6f8fe8 },
] as const);

export interface SolarSystemPosition extends SolarSystemBodyDef {
  /** 真赤道 of date 的赤经（度） */
  raDeg: number;
  /** 真赤道 of date 的赤纬（度） */
  decDeg: number;
  /** 站心地心距（AU） */
  distanceAu: number;
  /** 视星等 */
  magnitude: number;
  /** 视直径（度） */
  angularDiameterDeg: number;
  /** 被照亮比例 0..1（太阳恒为 1） */
  illumination: number;
  /** 相位角（度） */
  phaseAngleDeg: number;
  /** 地平单位向量（x=北, y=西, z=天顶） */
  horizon: Vec3;
  /** 高度角（度） */
  altitudeDeg: number;
  /** 方位角（度，从北起向东为正） */
  azimuthDeg: number;
}

/**
 * 计算全部太阳系天体的位置。
 *
 * @param date     观测时刻
 * @param observer 观测者（站心坐标）
 */
export function computeSolarSystem(date: Date, observer: Observer): SolarSystemPosition[] {
  const toHorizon = ofDateToHorizonMatrix(date, observer);

  return SOLAR_SYSTEM_BODIES.map((def) => {
    const eq = Equator(def.body, date, observer, true, true);
    const raDeg = eq.ra * 15;
    const decDeg = eq.dec;
    const distanceAu = eq.dist;

    const illum = Illumination(def.body, date);

    // 视直径 = 2·atan(R / d)
    const distanceKm = Math.max(distanceAu * AU_IN_KM, 1);
    const angularDiameterDeg = 2 * Math.atan(def.radiusKm / distanceKm) * RAD;

    const horizon = normalize(mat3Apply(toHorizon, raDecVector(raDeg, decDeg)));
    const { azimuthDeg, altitudeDeg } = horizonToAzAlt(horizon);

    const illumination = def.kind === 'sun' ? 1 : illum.phase_fraction;

    return {
      ...def,
      raDeg,
      decDeg,
      distanceAu,
      magnitude: illum.mag,
      angularDiameterDeg,
      illumination,
      phaseAngleDeg: illum.phase_angle,
      horizon,
      altitudeDeg,
      azimuthDeg,
    };
  });
}

function raDecVector(raDeg: number, decDeg: number): Vec3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const cosDec = Math.cos(dec);
  return { x: cosDec * Math.cos(ra), y: cosDec * Math.sin(ra), z: Math.sin(dec) };
}

/**
 * 月亮「亮边」在地平坐标系中的方向单位向量。
 *
 * 用于片元着色器绘制月相：把太阳方向投影到以月亮为中心的切平面上。
 * 返回 null 表示太阳与月亮几乎重合（此时相位退化）。
 */
export function moonBrightLimbDirection(
  moonDir: Vec3,
  sunDir: Vec3,
): { east: number; north: number } | null {
  const m = normalize(moonDir);
  const s = normalize(sunDir);
  const dotMS = m.x * s.x + m.y * s.y + m.z * s.z;
  // 投影到切平面
  const proj = {
    x: s.x - dotMS * m.x,
    y: s.y - dotMS * m.y,
    z: s.z - dotMS * m.z,
  };
  const len = Math.hypot(proj.x, proj.y, proj.z);
  if (len < 1e-6) return null;
  const u = { x: proj.x / len, y: proj.y / len, z: proj.z / len };

  // 切平面基：东 = -西方向
  const east = { x: 0, y: -1, z: 0 };
  const north = { x: 1, y: 0, z: 0 };
  // 把 (east, north) 投影到与 m 正交的平面
  const eDot = east.x * m.x + east.y * m.y + east.z * m.z;
  const eProj = normalize({
    x: east.x - eDot * m.x,
    y: east.y - eDot * m.y,
    z: east.z - eDot * m.z,
  });
  const nProj = normalize({
    x: north.x - (north.x * m.x + north.y * m.y + north.z * m.z) * m.x,
    y: north.y - (north.x * m.x + north.y * m.y + north.z * m.z) * m.y,
    z: north.z - (north.x * m.x + north.y * m.y + north.z * m.z) * m.z,
  });

  return {
    east: u.x * eProj.x + u.y * eProj.y + u.z * eProj.z,
    north: u.x * nProj.x + u.y * nProj.y + u.z * nProj.z,
  };
}

/** 由方位角/高度角求地平向量，供 UI 使用 */
export { azAltToHorizon };
