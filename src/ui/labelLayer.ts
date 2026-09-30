/**
 * HTML 标签层。
 *
 * 亮星名称、方位标记、太阳系天体名称都用 DOM 元素画在 canvas 之上。
 * 相比在 WebGL 里做文字，DOM 的好处是：字体渲染质量与系统一致、
 * 不需要打包字体图集、支持中文、还能直接用 CSS 做描边与背景。
 *
 * 代价是每帧要做一次屏幕投影与布局，所以：
 * - 只给**有名字的星**建标签（星名表里只有约 4 万条，其中真正有专名/编号的约 3700 条）；
 * - 星点标签的刷新频率压到 ~8 Hz；
 * - 用矩形重叠检测做贪心避让，避免糊成一团。
 */

import { mat3Apply, type Vec3 } from '../astro/vec3';
import type { StarCatalog, StarChunk } from '../data/starCatalog';
import { projectToNdc } from '../render/viewCamera';
import { COMPASS_LABEL_ALTITUDE_DEG, COMPASS_POINTS } from '../render/grids';
import { azAltToHorizon } from '../astro/coordinates';
import { formatBayer } from '../data/constellationNames';
import type { SkyContext } from '../skyContext';
import type { AppStateShape } from '../state';

interface LabelStar {
  id: number;
  mag: number;
  /** 赤道 J2000 单位向量 */
  dir: Vec3;
  text: string;
  /** 副标题（星座缩写之类的补充信息） */
  sub?: string;
}

interface Slot {
  element: HTMLDivElement;
  used: boolean;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const LABEL_REFRESH_MS = 125;

/**
 * 由视场角决定标签的星等上限。
 *
 * PROMPT 要求「默认只显示 mag<2 的，缩放后显示更多」，
 * 所以基准视场角（70°）对应 2 等，之后按 log 增长。
 */
export function labelMagnitudeLimit(fovDeg: number): number {
  const limit = 2 + 1.6 * Math.log2(70 / Math.max(fovDeg, 0.02));
  return Math.min(12, Math.max(1.5, limit));
}

export class LabelLayer {
  private root: HTMLElement;
  private pool: Slot[] = [];
  private usedCount = 0;
  private lastUpdate = 0;

  /** 有名字的星，静态索引，星表分块变化时重建 */
  private namedStars: LabelStar[] = [];
  private namedStarsDirty = true;
  private builtFromChunkCount = -1;

  /** 中文星名（HIP → 中文名），可选 */
  private chineseNames: Map<number, string> | null = null;

  /** 是否显示星名标签（由状态控制） */
  showStarLabels = true;

  constructor(container: HTMLElement) {
    this.root = container;
  }

  setChineseNames(map: Map<number, string> | null): void {
    this.chineseNames = map;
    this.namedStarsDirty = true;
  }

  /** 星表分块变化后调用，下一帧重建标签索引 */
  invalidate(): void {
    this.namedStarsDirty = true;
  }

  clear(): void {
    for (const slot of this.pool) slot.used = false;
    this.usedCount = 0;
    this.root.replaceChildren();
    this.pool = [];
  }

  private acquire(): HTMLDivElement | null {
    if (this.usedCount >= this.pool.length) {
      if (this.pool.length >= 220) return null;
      const element = document.createElement('div');
      element.className = 'sky-label';
      this.root.appendChild(element);
      this.pool.push({ element, used: false });
    }
    const slot = this.pool[this.usedCount]!;
    slot.used = true;
    this.usedCount++;
    return slot.element;
  }

  private hideUnused(): void {
    for (let i = this.usedCount; i < this.pool.length; i++) {
      const slot = this.pool[i]!;
      if (slot.used) {
        slot.element.style.display = 'none';
        slot.used = false;
      }
    }
  }

  /**
   * 重建「有名字的星」索引。
   *
   * 只扫亮档（A/B/C），暗档里几乎没有带名字的星，
   * 扫 200 万颗星不值得。
   */
  private rebuildIndex(chunks: readonly StarChunk[], catalog: StarCatalog): void {
    const found: LabelStar[] = [];

    for (const chunk of chunks) {
      // 档 D 里基本没有专名，跳过以省时间
      if (chunk.tierId === 'D') continue;

      for (let i = 0; i < chunk.header.count; i++) {
        const id = chunk.ids[i]!;
        const identity = catalog.identityOf(id);
        if (!identity) continue;

        const bayer = identity.bayer;
        const flam = identity.flam;
        const proper = identity.name;
        // 只给有专名或拜耳/弗兰斯蒂德编号的星做标签
        if (!proper && !bayer && !flam) continue;

        const chinese =
          identity.hip !== undefined ? this.chineseNames?.get(identity.hip) : undefined;
        const greekBayer = formatBayer(bayer);
        const primary = chinese ?? proper ?? greekBayer ?? flam ?? '';
        if (!primary) continue;

        const sub = chinese && proper ? proper : undefined;

        found.push({
          id,
          mag: chunk.magnitudes[i]!,
          dir: {
            x: chunk.positions[i * 3]!,
            y: chunk.positions[i * 3 + 1]!,
            z: chunk.positions[i * 3 + 2]!,
          },
          text: primary,
          ...(sub ? { sub } : {}),
        });
      }
    }

    // 去重（同一颗星可能同时出现在不同档，理论上不会，但保险）
    const seen = new Set<number>();
    const unique: LabelStar[] = [];
    for (const star of found) {
      if (seen.has(star.id)) continue;
      seen.add(star.id);
      unique.push(star);
    }
    unique.sort((a, b) => a.mag - b.mag);

    this.namedStars = unique;
    this.namedStarsDirty = false;
  }

  /** 每帧（或节流后）更新标签 */
  update(
    ctx: SkyContext,
    state: AppStateShape,
    chunks: readonly StarChunk[],
    catalog: StarCatalog,
    now: number,
    force = false,
  ): void {
    if (!force && now - this.lastUpdate < LABEL_REFRESH_MS) return;
    this.lastUpdate = now;

    if (this.namedStarsDirty || this.builtFromChunkCount !== chunks.length) {
      this.rebuildIndex(chunks, catalog);
      this.builtFromChunkCount = chunks.length;
    }

    this.usedCount = 0;

    const occupied: Rect[] = [];
    const width = ctx.viewport.width;
    const height = ctx.viewport.height;

    // 天体标签优先（数量少、信息重要）
    if (state.display.showSolarSystem) {
      for (const body of ctx.bodies) {
        if (body.altitudeDeg < -1) continue;
        const ndc = projectToNdc(body.horizon, ctx.camera, ctx.fovDeg, ctx.aspect);
        if (!ndc.visible || Math.abs(ndc.x) > 1.15 || Math.abs(ndc.y) > 1.15) continue;
        const x = (ndc.x * 0.5 + 0.5) * width;
        const y = (1 - (ndc.y * 0.5 + 0.5)) * height;
        const radius = Math.max(
          8,
          ctx.pixelsPerProjectionUnit * (body.angularDiameterDeg / 57.29578) * 0.5,
        );
        this.place(`body-${body.key}`, body.nameZh, x, y + radius + 8, occupied, 'body');
      }
    }

    // 方位标记
    if (state.display.showHorizon) {
      for (const point of COMPASS_POINTS) {
        const dir = azAltToHorizon(point.azimuthDeg, COMPASS_LABEL_ALTITUDE_DEG);
        const ndc = projectToNdc(dir, ctx.camera, ctx.fovDeg, ctx.aspect);
        if (!ndc.visible || Math.abs(ndc.x) > 1.05 || Math.abs(ndc.y) > 1.05) continue;
        const x = (ndc.x * 0.5 + 0.5) * width;
        const y = (1 - (ndc.y * 0.5 + 0.5)) * height;
        this.place(`compass-${point.label}`, point.label, x, y, occupied, 'compass');
      }
    }

    // 亮星名称
    const labelLimit = labelMagnitudeLimit(ctx.fovDeg);
    this.showStarLabels = state.display.showStarLabels;
    if (this.showStarLabels) {
      const cullCos = Math.cos((Math.max(ctx.fovDeg, 1) * 0.75 * Math.PI) / 180);
      let placed = 0;
      for (const star of this.namedStars) {
        if (star.mag > labelLimit) continue;
        if (placed >= 90) break;

        const hor = mat3Apply(ctx.equToHoriz, star.dir);
        if (hor.z < 0.02) continue; // 地平线以下不标

        // 先做一次粗略的角距离剔除，省掉大部分投影运算
        const dot =
          hor.x * ctx.centerHorizon.x + hor.y * ctx.centerHorizon.y + hor.z * ctx.centerHorizon.z;
        if (dot < cullCos) continue;

        const ndc = projectToNdc(hor, ctx.camera, ctx.fovDeg, ctx.aspect);
        if (!ndc.visible || Math.abs(ndc.x) > 0.98 || Math.abs(ndc.y) > 0.98) continue;

        const x = (ndc.x * 0.5 + 0.5) * width;
        const y = (1 - (ndc.y * 0.5 + 0.5)) * height;
        if (this.place(`star-${star.id}`, star.text, x, y, occupied, 'star', star.sub)) placed++;
      }
    }

    this.hideUnused();
  }

  /** 贪心放置：与已占矩形重叠就跳过 */
  private place(
    key: string,
    text: string,
    x: number,
    y: number,
    occupied: Rect[],
    kind: 'star' | 'compass' | 'body',
    sub?: string,
  ): boolean {
    const element = this.acquire();
    if (!element) return false;

    const halfWidth = Math.max(22, text.length * (kind === 'compass' ? 9 : 7.5));
    const halfHeight = kind === 'star' ? 9 : 11;
    const rect: Rect = {
      x0: x - halfWidth,
      y0: y - halfHeight,
      x1: x + halfWidth,
      y1: y + halfHeight,
    };

    for (const other of occupied) {
      if (rect.x0 < other.x1 && rect.x1 > other.x0 && rect.y0 < other.y1 && rect.y1 > other.y0) {
        element.style.display = 'none';
        return false;
      }
    }
    occupied.push(rect);

    element.style.display = 'block';
    element.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    element.className = `sky-label sky-label--${kind}`;
    element.dataset['key'] = key;

    if (sub) {
      element.textContent = '';
      const main = document.createElement('span');
      main.className = 'sky-label-main';
      main.textContent = text;
      const minor = document.createElement('span');
      minor.className = 'sky-label-sub';
      minor.textContent = sub;
      element.append(main, minor);
    } else {
      element.textContent = text;
    }
    return true;
  }
}
