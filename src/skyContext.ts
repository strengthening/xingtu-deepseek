/**
 * 每帧的天文上下文。
 *
 * 把「状态（观测者 / 时间 / 视角）」翻译成渲染层需要的矩阵与数值。
 * 这一层是 UI 与渲染之间唯一的耦合点，`astro/` 保持纯净。
 */

import { MakeTime, Observer } from 'astronomy-engine';

import { observerVelocityOverC } from './astro/aberration';
import { computeSkyGlow, type SkyGlow } from './astro/atmosphere';
import { azAltToHorizon, j2000ToHorizonMatrix } from './astro/coordinates';
import { mat3Apply, mat3Transpose, normalize, type Mat3, type Vec3 } from './astro/vec3';
import {
  computeSolarSystem,
  moonBrightLimbDirection,
  type SolarSystemPosition,
} from './astro/solarSystem';
import { julianYearsSinceJ2000, localSiderealTime } from './astro/time';
import { computeCameraBasis, fovHalfTan, type CameraBasis } from './render/viewCamera';
import type { AppStateShape } from './state';

export interface Viewport {
  width: number;
  height: number;
  pixelRatio: number;
}

export interface SkyContext {
  date: Date;
  observer: Observer;
  /** 地方视恒星时（小时） */
  lstHours: number;
  /** 距 J2000 的儒略年数 */
  deltaYears: number;
  /** 赤道 J2000 → 地平 */
  equToHoriz: Mat3;
  /** 地平 → 赤道 J2000 */
  horizToEqu: Mat3;
  /** 观测者总速度 / 光速（赤道 J2000 系） */
  velocityOverC: Vec3;
  /** 视线中心在地平系中的方向 */
  centerHorizon: Vec3;
  camera: CameraBasis;
  fovDeg: number;
  fovHalfTan: number;
  aspect: number;
  viewport: Viewport;
  /** 太阳系天体（已按地平坐标算好） */
  bodies: SolarSystemPosition[];
  sun: SolarSystemPosition;
  moon: SolarSystemPosition;
  /** 视线中心方向的天光状态 */
  skyGlow: SkyGlow;
  /** 星空单位的换算：1 个立体投影平面单位 = 多少屏幕像素 */
  pixelsPerProjectionUnit: number;
}

export function computeSkyContext(state: AppStateShape, viewport: Viewport): SkyContext {
  const date = new Date(state.time.epochMs);
  const observer = new Observer(
    state.observer.latitudeDeg,
    state.observer.longitudeDeg,
    state.observer.heightM,
  );

  const lstHours = localSiderealTime(date, state.observer.longitudeDeg);
  const deltaYears = julianYearsSinceJ2000(date);
  const equToHoriz = j2000ToHorizonMatrix(observer, date);
  const horizToEqu = mat3Transpose(equToHoriz);
  const velocityOverC = observerVelocityOverC(date, observer);

  const fovDeg = state.view.fovDeg;
  const aspect = viewport.width / Math.max(viewport.height, 1);
  const camera = computeCameraBasis(state.view.azimuthDeg, state.view.altitudeDeg);

  const bodies = computeSolarSystem(date, observer);
  const sun = bodies.find((b) => b.key === 'sun')!;
  const moon = bodies.find((b) => b.key === 'moon')!;

  const centerHorizon = azAltToHorizon(state.view.azimuthDeg, state.view.altitudeDeg);
  const centerAltitudeDeg = state.view.altitudeDeg;
  // 月亮与**视线中心**的角距离，用来估计这一屏的天光强度
  const moonSeparationDeg =
    (Math.acos(
      Math.max(
        -1,
        Math.min(
          1,
          centerHorizon.x * moon.horizon.x +
            centerHorizon.y * moon.horizon.y +
            centerHorizon.z * moon.horizon.z,
        ),
      ),
    ) *
      180) /
    Math.PI;

  const skyGlow = computeSkyGlow({
    targetAltitudeDeg: centerAltitudeDeg,
    sunAltitudeDeg: sun.altitudeDeg,
    moonAltitudeDeg: moon.altitudeDeg,
    moonIllumination: moon.illumination,
    moonSeparationDeg,
    heightM: state.observer.heightM,
    density: state.display.showAtmosphere ? state.display.atmosphereDensity : 0,
  });

  const rv = fovHalfTan(fovDeg);
  // 屏幕半高对应 2·R_v 个平面单位，所以每平面单位 = H / (2·R_v) 像素
  const pixelsPerProjectionUnit = viewport.height / (2 * rv);

  return {
    date,
    observer,
    lstHours,
    deltaYears,
    equToHoriz,
    horizToEqu,
    velocityOverC,
    centerHorizon,
    camera,
    fovDeg,
    fovHalfTan: rv,
    aspect,
    viewport,
    bodies,
    sun,
    moon,
    skyGlow,
    pixelsPerProjectionUnit,
  };
}

/** 天体「亮边」方向在地平切平面上的分量，供月相着色器使用 */
export function limbDirectionOf(
  body: SolarSystemPosition,
  sun: SolarSystemPosition,
): {
  east: number;
  north: number;
} {
  return moonBrightLimbDirection(body.horizon, sun.horizon) ?? { east: 1, north: 0 };
}

/** 把赤道 J2000 方向换算到地平（渲染层偶尔需要） */
export function equatorialToHorizon(ctx: SkyContext, dirEqu: Vec3): Vec3 {
  return mat3Apply(ctx.equToHoriz, dirEqu);
}

/** 把地平方向换算到赤道 J2000（选块用） */
export function horizonToEquatorial(ctx: SkyContext, dirHor: Vec3): Vec3 {
  return normalize(mat3Apply(ctx.horizToEqu, dirHor));
}

/** 便于外部拿到 AstroTime */
export function astroTimeOf(ctx: SkyContext) {
  return MakeTime(ctx.date);
}
