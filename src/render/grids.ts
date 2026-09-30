/**
 * 赤道网格与地平网格的几何生成。
 *
 * 两张网格都是「若干条球面折线」，直接喂给 `LineLayer`。
 * 折线点用单位向量表示，细分工作交给 `buildLineSegmentPositions`。
 */

import { DEG } from '../astro/constants';
import { azAltToHorizon, raDecToVector } from '../astro/coordinates';
import type { Polyline } from './lineLayer';
import type { Vec3 } from '../astro/vec3';

/**
 * 赤道网格：赤经线 + 赤纬线。
 *
 * @param raStepDeg  赤经线间隔（度），24h = 360°
 * @param decStepDeg 赤纬线间隔（度）
 * @param decLimit   赤经线画到多高的赤纬（避免在天极处挤成一团）
 */
export function buildEquatorialGrid(
  raStepDeg = 15,
  decStepDeg = 15,
  decLimit = 85,
): Polyline[] {
  const lines: Polyline[] = [];

  // 赤经线（子午线）：固定赤经，赤纬从南到北
  for (let ra = 0; ra < 360; ra += raStepDeg) {
    const points: Vec3[] = [];
    for (let dec = -decLimit; dec <= decLimit + 1e-6; dec += 2.5) {
      points.push(raDecToVector(ra, dec));
    }
    lines.push({ points });
  }

  // 赤纬线（平行圈）：固定赤纬，赤经绕一圈
  const decStart = Math.ceil(-decLimit / decStepDeg) * decStepDeg;
  for (let dec = decStart; dec <= decLimit + 1e-6; dec += decStepDeg) {
    const points: Vec3[] = [];
    const count = Math.max(24, Math.round(360 / 3));
    for (let i = 0; i < count; i++) {
      points.push(raDecToVector((i / count) * 360, dec));
    }
    lines.push({ points, closed: true });
  }

  return lines;
}

/**
 * 地平网格：等高度圈 + 等方位圈。
 *
 * @param altStepDeg 等高度圈间隔（度）
 * @param azStepDeg  等方位圈间隔（度）
 */
export function buildHorizontalGrid(altStepDeg = 10, azStepDeg = 15): Polyline[] {
  const lines: Polyline[] = [];

  // 等高度圈：固定高度角，方位角绕一圈
  for (let alt = altStepDeg; alt <= 89; alt += altStepDeg) {
    const points: Vec3[] = [];
    const count = Math.max(48, Math.round(360 / 3));
    for (let i = 0; i < count; i++) {
      points.push(azAltToHorizon((i / count) * 360, alt));
    }
    lines.push({ points, closed: true });
  }

  // 等方位圈（卯酉圈）：过天顶的大圆，从一侧地平升到天顶再落到对侧地平
  for (let az = 0; az < 360; az += azStepDeg) {
    const points: Vec3[] = [];
    for (let phi = -88; phi <= 88 + 1e-6; phi += 2) {
      // phi < 0 时落在方位角 +180° 的那一侧，这样折线是连续的
      points.push(phi >= 0 ? azAltToHorizon(az, phi) : azAltToHorizon(az + 180, -phi));
    }
    lines.push({ points });
  }

  return lines;
}

/**
 * 地平线：高度角 0° 的整圈。
 *
 * 单独拿出来是因为它要画得比普通网格亮、粗（虽然 WebGL 的线宽基本恒为 1px）。
 */
export function buildHorizonLine(): Polyline[] {
  const points: Vec3[] = [];
  const count = 720;
  for (let i = 0; i < count; i++) {
    points.push(azAltToHorizon((i / count) * 360, 0));
  }
  return [{ points, closed: true }];
}

/**
 * 方位刻度：在地平线上每 10° 打一个小竖线，30° 处加长。
 * 东（90°）、南（180°）、西（270°）、北（0°）由 HTML 标签另外标出。
 */
export function buildCompassTicks(): Polyline[] {
  const lines: Polyline[] = [];
  for (let az = 0; az < 360; az += 10) {
    const major = az % 30 === 0;
    const heightDeg = major ? 3.2 : 1.6;
    const base = azAltToHorizon(az, 0);
    const top = azAltToHorizon(az, heightDeg);
    lines.push({ points: [base, top] });
    // 刻度下方再补一小段，让它像「立在」地平面上
    const below = azAltToHorizon(az, -heightDeg * 0.45);
    lines.push({ points: [below, base] });
  }
  return lines;
}

/** 方位角 0/90/180/270 对应的地平单位向量，供 HTML 标签定位 */
export const COMPASS_POINTS: readonly { label: string; labelEn: string; azimuthDeg: number }[] = [
  { label: '北', labelEn: 'N', azimuthDeg: 0 },
  { label: '东', labelEn: 'E', azimuthDeg: 90 },
  { label: '南', labelEn: 'S', azimuthDeg: 180 },
  { label: '西', labelEn: 'W', azimuthDeg: 270 },
];

/** 方位标签稍微抬高一点，免得压在地平线上 */
export const COMPASS_LABEL_ALTITUDE_DEG = 4.5;

/** 赤经赤纬网格线的交点方向（给将来的刻度数字标签用） */
export function gridLabelDirections(): Vec3[] {
  const out: Vec3[] = [];
  for (let dec = -75; dec <= 75; dec += 15) {
    for (let ra = 0; ra < 360; ra += 30) {
      out.push(raDecToVector(ra, dec));
    }
  }
  return out;
}

/** 便捷：把度数转成弧度（本文件里少量用到） */
export const DEG_TO_RAD = DEG;
