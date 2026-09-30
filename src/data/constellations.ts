/**
 * 星座连线的加载。
 *
 * 数据由 `scripts/build-constellations.ts` 生成：每个星座/星官是一组折线，
 * 每条折线是**扁平的单位向量数组**（赤道 J2000），每 3 个数一个顶点。
 * 这样运行时不需要再做 HIP 查表，直接丢给 `LineLayer` 即可。
 */

import type { Polyline } from '../render/lineLayer';
import type { Vec3 } from '../astro/vec3';

export interface ConstellationLicense {
  name: string;
  url: string;
  credit: string;
}

export interface ConstellationFigure {
  id: string;
  name?: string;
  nameZh?: string;
  /** 每条折线是扁平的单位向量数组：[x1,y1,z1, x2,y2,z2, ...] */
  lines: number[][];
}

export interface ConstellationGroup {
  id: string;
  label: string;
  license: ConstellationLicense;
  figures: ConstellationFigure[];
}

interface ManifestGroup {
  id: string;
  label: string;
  file: string;
  figureCount: number;
  segmentCount: number;
  bytes: number;
  license: ConstellationLicense;
}

interface Manifest {
  generator: string;
  generatedAt: string;
  groups: ManifestGroup[];
}

export interface LoadedConstellationGroup extends ConstellationGroup {
  /** 已经转成折线，可以直接喂给 LineLayer */
  polylines: Polyline[];
  segmentCount: number;
}

function toPolylines(figures: readonly ConstellationFigure[]): Polyline[] {
  const out: Polyline[] = [];
  for (const figure of figures) {
    for (const flat of figure.lines) {
      if (flat.length < 6) continue; // 少于两个点不成线
      const points: Vec3[] = [];
      for (let i = 0; i + 2 < flat.length; i += 3) {
        const x = flat[i]!;
        const y = flat[i + 1]!;
        const z = flat[i + 2]!;
        // 数据在预处理阶段已经归一化，这里只做一次廉价防御
        const len = Math.hypot(x, y, z);
        if (len < 1e-6) continue;
        points.push({ x: x / len, y: y / len, z: z / len });
      }
      if (points.length >= 2) out.push({ points });
    }
  }
  return out;
}

/**
 * 加载全部星座分组。
 *
 * 缺文件不是致命错误（比如用户只想跑星表），所以单个分组失败会被跳过，
 * 由调用方根据返回的数组决定怎么提示。
 */
export async function loadConstellations(baseUrl = 'data/constellations/'): Promise<{
  groups: LoadedConstellationGroup[];
  errors: string[];
}> {
  const groups: LoadedConstellationGroup[] = [];
  const errors: string[] = [];

  let manifest: Manifest;
  try {
    const res = await fetch(`${baseUrl}manifest.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    manifest = (await res.json()) as Manifest;
  } catch (err) {
    return {
      groups: [],
      errors: [`未找到星座连线数据（${baseUrl}manifest.json）：${err instanceof Error ? err.message : String(err)}`],
    };
  }

  for (const entry of manifest.groups) {
    try {
      const res = await fetch(`${baseUrl}${entry.file}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as {
        id: string;
        label: string;
        license: ConstellationLicense;
        figures: ConstellationFigure[];
      };
      groups.push({
        id: raw.id ?? entry.id,
        label: raw.label ?? entry.label,
        license: raw.license ?? entry.license,
        figures: raw.figures ?? [],
        polylines: toPolylines(raw.figures ?? []),
        segmentCount: entry.segmentCount,
      });
    } catch (err) {
      errors.push(
        `${entry.label} 加载失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { groups, errors };
}

/** 统计一个分组里的折线总数 */
export function countPolylines(group: LoadedConstellationGroup): number {
  return group.polylines.length;
}
