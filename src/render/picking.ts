/**
 * 天球点选。
 *
 * 把屏幕上的点击位置反投影成天球方向，再到星表分块里找角距离最近的天体。
 * 阈值随视场角缩放：放大后要求点得更准，全天视图下放宽。
 */

import type { StarCatalog, StarChunk } from '../data/starCatalog';
import { dot, normalize, type Vec3 } from '../astro/vec3';
import type { SolarSystemPosition } from '../astro/solarSystem';

export interface StarPick {
  kind: 'star';
  chunk: StarChunk;
  index: number;
  /** 角距离（弧度） */
  separationRad: number;
  /** 赤道 J2000 单位向量 */
  direction: Vec3;
}

export interface BodyPick {
  kind: 'body';
  body: SolarSystemPosition;
  separationRad: number;
}

export type PickResult = StarPick | BodyPick;

/** 点选阈值：视场角的 2%，并夹在 [0.05°, 3°] 之间 */
export function pickToleranceRad(fovDeg: number): number {
  const rad = (fovDeg * 0.02 * Math.PI) / 180;
  const min = (0.04 * Math.PI) / 180;
  const max = (3 * Math.PI) / 180;
  return Math.min(max, Math.max(min, rad));
}

/**
 * 在驻留分块里找离 `dirEqj` 最近的星。
 *
 * 用点积而不是 `acos`：`acos` 在接近 1 的地方数值分辨率差，
 * 而我们只关心「谁最近」，点积单调且更便宜。
 */
export function pickStar(
  chunks: readonly StarChunk[],
  dirEqj: Vec3,
  toleranceRad: number,
): StarPick | null {
  const target = normalize(dirEqj);
  const limit = Math.cos(toleranceRad);
  let best: StarPick | null = null;
  let bestDot = limit;

  for (const chunk of chunks) {
    const count = chunk.header.count;
    const pos = chunk.positions;
    for (let i = 0; i < count; i++) {
      const x = pos[i * 3]!;
      const y = pos[i * 3 + 1]!;
      const z = pos[i * 3 + 2]!;
      const d = x * target.x + y * target.y + z * target.z;
      if (d > bestDot) {
        bestDot = d;
        best = {
          kind: 'star',
          chunk,
          index: i,
          separationRad: Math.acos(Math.min(1, d)),
          direction: { x, y, z },
        };
      }
    }
  }
  return best;
}

/**
 * 太阳系天体的点选阈值要按视直径放大 ——
 * 月亮在屏幕上可能占几十个像素，点在月面上就应该选中月亮。
 */
export function pickBody(
  bodies: readonly SolarSystemPosition[],
  dirHorizon: Vec3,
  toleranceRad: number,
): BodyPick | null {
  const target = normalize(dirHorizon);
  let best: BodyPick | null = null;

  for (const body of bodies) {
    if (body.altitudeDeg < -1) continue;
    const cosSep = dot(target, body.horizon);
    const sep = Math.acos(Math.max(-1, Math.min(1, cosSep)));
    // 月亮/太阳的视半径约 0.25°，行星更小；再加一点余量
    const allowance = toleranceRad + (body.angularDiameterDeg * Math.PI) / 180 / 2 + 0.004;
    if (sep <= allowance && (!best || sep < best.separationRad)) {
      best = { kind: 'body', body, separationRad: sep };
    }
  }
  return best;
}

/** 天体优先于恒星：月面上的点击不应该选到背景星 */
export function pickObjects(
  chunks: readonly StarChunk[],
  bodies: readonly SolarSystemPosition[],
  dirEqj: Vec3,
  dirHorizon: Vec3,
  fovDeg: number,
  catalog: StarCatalog,
): { pick: PickResult | null; label: string | null } {
  const tolerance = pickToleranceRad(fovDeg);

  const body = pickBody(bodies, dirHorizon, tolerance);
  if (body) return { pick: body, label: body.body.nameZh };

  const star = pickStar(chunks, dirEqj, tolerance);
  if (star) {
    const identity = catalog.identityOf(star.chunk.ids[star.index]!);
    const label =
      identity?.name ?? identity?.bayer ?? identity?.flam ?? `AT-HYG ${star.chunk.ids[star.index]}`;
    return { pick: star, label };
  }
  return { pick: null, label: null };
}
