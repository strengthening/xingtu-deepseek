/**
 * 星表加载与 LOD 选块。
 *
 * 预处理脚本把 255 万颗星按视星等切成 4 档（见 `scripts/build-stars.ts`）：
 * - 档 A / B：全天单文件，直接整体加载；
 * - 档 C / D：按 HEALPix 天区切片，只加载视野覆盖到的天区。
 *
 * 这里负责三件事：
 * 1. 解析二进制块（32 字节头 + SoA 数据段）；
 * 2. 根据当前视线方向与视场角决定需要哪些天区块；
 * 3. 带并发上限与 LRU 淘汰地加载 / 释放。
 */

import {
  ang2pixNest,
  nestedPixelToVector,
  nsideToNpix,
  pixelRadiusRad,
  queryDiscNest,
} from './healpix';
import { clamp, mat3Apply, type Mat3, type Vec3 } from '../astro/vec3';

export const CHUNK_MAGIC = 0x31545358; // "XST1"
export const CHUNK_HEADER_BYTES = 32;
export const STAR_BYTES = 32;

/** 有「身份」的恒星记录：`[专名, 拜耳, 弗兰斯蒂德, 星座, HIP, HD, HR, 光谱型]` */
export type StarNameTuple = (string | number | null)[];

export const STAR_NAME_FIELDS = [
  'name',
  'bayer',
  'flam',
  'con',
  'hip',
  'hd',
  'hr',
  'spect',
] as const;

export type StarNameField = (typeof STAR_NAME_FIELDS)[number];

export interface StarIdentity {
  name?: string;
  bayer?: string;
  flam?: string;
  con?: string;
  hip?: number;
  hd?: number;
  hr?: number;
  spect?: string;
}

export interface StarChunkHeader {
  magic: number;
  version: number;
  count: number;
  magMin: number;
  magMax: number;
  tier: string;
  nside: number;
}

export interface StarChunk {
  key: string;
  tierId: string;
  /** HEALPix NESTED 天区号；全天档为 -1 */
  pix: number;
  header: StarChunkHeader;
  /** 赤道 J2000 单位向量，长度 count×3 */
  positions: Float32Array;
  magnitudes: Float32Array;
  /** 每颗星 4 字节：rgb = 线性 sRGB 颜色，a = B-V 编码 */
  colors: Uint8Array;
  /** μ_α*、μ_δ，mas/yr */
  properMotion: Float32Array;
  /** AT-HYG 行 id */
  ids: Uint32Array;
  byteLength: number;
}

export interface TierManifestEntry {
  id: string;
  label: string;
  layout: 'allsky' | 'healpix';
  nside: number;
  count: number;
  bytes: number;
  pathTemplate: string;
  /** `[天区号, 星数]`；全天档为 null */
  tiles: [number, number][] | null;
}

export interface StarManifest {
  version: number;
  generator: string;
  generatedAt: string;
  recordBytes: number;
  headerBytes: number;
  epoch: string;
  sourceEpoch: string;
  frame: string;
  totalStars: number;
  reference: {
    name: string;
    author: string;
    license: string;
    url: string;
    upstream: string;
  };
  names: {
    file: string;
    bytes: number;
    count: number;
    fields: string[];
    magLimit: number;
  };
  tiers: TierManifestEntry[];
}

/**
 * 每一档在什么视场角以下才需要加载。
 *
 * 阈值由「该档最亮的星是否已经比当前星等限暗得多」决定 —— 如果一档里
 * 最亮的星都还没到显示门槛，加载它纯属浪费。具体视场角由
 * `state.ts` 的 `magnitudeLimitForFov()` 反推得到。
 */
export interface TierLoadPolicy {
  tierId: string;
  /** 视场角小于等于该值时就加载这一档 */
  loadBelowFovDeg: number;
}

export const DEFAULT_TIER_POLICY: readonly TierLoadPolicy[] = [
  { tierId: 'A', loadBelowFovDeg: Number.POSITIVE_INFINITY },
  { tierId: 'B', loadBelowFovDeg: 100 },
  { tierId: 'C', loadBelowFovDeg: 52 },
  { tierId: 'D', loadBelowFovDeg: 27 },
];

/** 解析一个分块二进制 */
export function parseChunk(buffer: ArrayBuffer, key: string, tierId: string, pix: number): StarChunk {
  if (buffer.byteLength < CHUNK_HEADER_BYTES) {
    throw new Error(`分块 ${key} 太小（${buffer.byteLength} 字节）`);
  }
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== CHUNK_MAGIC) {
    throw new Error(`分块 ${key} 魔数不匹配：0x${magic.toString(16)}`);
  }
  const version = view.getUint32(4, true);
  const count = view.getUint32(8, true);
  const header: StarChunkHeader = {
    magic,
    version,
    count,
    magMin: view.getFloat32(12, true),
    magMax: view.getFloat32(16, true),
    tier: String.fromCharCode(view.getUint32(20, true)),
    nside: view.getUint32(24, true),
    };

  const expected = CHUNK_HEADER_BYTES + STAR_BYTES * count;
  if (buffer.byteLength !== expected) {
    throw new Error(`分块 ${key} 长度不符：期望 ${expected}，实际 ${buffer.byteLength}`);
  }

  const posOff = CHUNK_HEADER_BYTES;
  const magOff = posOff + count * 12;
  const rgbaOff = magOff + count * 4;
  const pmOff = rgbaOff + count * 4;
  const idOff = pmOff + count * 8;

  return {
    key,
    tierId,
    pix,
    header,
    positions: new Float32Array(buffer, posOff, count * 3),
    magnitudes: new Float32Array(buffer, magOff, count),
    colors: new Uint8Array(buffer, rgbaOff, count * 4),
    properMotion: new Float32Array(buffer, pmOff, count * 2),
    ids: new Uint32Array(buffer, idOff, count),
    byteLength: buffer.byteLength,
  };
}

export interface ViewQuery {
  /** 视线中心在赤道 J2000 中的单位向量 */
  centerEqj: Vec3;
  /** 垂直视场角（度） */
  fovDeg: number;
  /** 画面宽高比 */
  aspect: number;
}

export interface ChunkPlan {
  /** 需要驻留的分块 key 集合 */
  required: Set<string>;
  /** key → `[tierId, pix, url]` */
  descriptors: Map<string, { tierId: string; pix: number; url: string }>;
}

/**
 * 立体投影下，屏幕四角离视线中心的最大角距离（弧度）。
 *
 * 立体投影里平面半径 `R = 2·tan(θ/2)`，所以反解是 `θ = 2·atan(R/2)`。
 * 屏幕半高对应的平面半径是 `R_v = 2·tan(fov/4)`，
 * 半对角线是 `R_v·√(1+aspect²)`。
 */
export function viewConeRadiusRad(fovDeg: number, aspect: number): number {
  const halfHeight = 2 * Math.tan((fovDeg * Math.PI) / 180 / 4);
  const halfDiagonal = halfHeight * Math.sqrt(1 + aspect * aspect);
  return 2 * Math.atan(halfDiagonal / 2);
}

export class StarCatalog {
  private manifest: StarManifest | null = null;
  private names: Map<number, StarNameTuple> | null = null;
  private tilesByTier = new Map<string, Map<number, number>>();
  private chunks = new Map<string, StarChunk>();
  /** 最近一次被请求的帧序号，用于 LRU 淘汰 */
  private lastUsed = new Map<string, number>();
  private pending = new Set<string>();
  private failed = new Map<string, string>();
  private tick = 0;
  private aborter = new AbortController();

  /** 常驻分块上限。档 A/B 之外的切片按天区大小约 15–100 KB。 */
  maxResidentChunks = 320;
  maxConcurrentFetches = 8;

  private inFlight = 0;
  private queue: string[] = [];

  /** 分块加载完成或淘汰时触发，渲染层据此重建 GPU 缓冲 */
  onChunksChanged: (() => void) | null = null;

  constructor(private readonly baseUrl = 'data/stars/') {}

  get isReady(): boolean {
    return this.manifest !== null;
  }

  get totalStars(): number {
    return this.manifest?.totalStars ?? 0;
  }

  get reference(): StarManifest['reference'] | null {
    return this.manifest?.reference ?? null;
  }

  get loadedChunkCount(): number {
    return this.chunks.size;
  }

  get loadedStarCount(): number {
    let n = 0;
    for (const chunk of this.chunks.values()) n += chunk.header.count;
    return n;
  }

  get failedChunks(): ReadonlyMap<string, string> {
    return this.failed;
  }

  /** 加载 manifest 与星名表 */
  async load(onProgress?: (message: string, fraction: number) => void): Promise<void> {
    onProgress?.('读取星表清单…', 0);
    const manifestRes = await fetch(`${this.baseUrl}manifest.json`);
    if (!manifestRes.ok) {
      throw new Error(
        `找不到 ${this.baseUrl}manifest.json（HTTP ${manifestRes.status}）。` +
          `请先运行 pnpm run data:stars 生成星表数据。`,
      );
    }
    this.manifest = (await manifestRes.json()) as StarManifest;

    this.tilesByTier.clear();
    for (const tier of this.manifest.tiers) {
      const map = new Map<number, number>();
      if (tier.tiles) for (const [pix, count] of tier.tiles) map.set(pix, count);
      this.tilesByTier.set(tier.id, map);
    }

    onProgress?.('读取星名表…', 0.4);
    const namesRes = await fetch(`${this.baseUrl}${this.manifest.names.file}`);
    if (!namesRes.ok) throw new Error(`找不到星名表（HTTP ${namesRes.status}）`);
    const raw = (await namesRes.json()) as Record<string, StarNameTuple>;
    this.names = new Map();
    for (const [id, tuple] of Object.entries(raw)) this.names.set(Number(id), tuple);

    onProgress?.('完成', 1);
  }

  /** 取某颗星的身份信息（专名 / 星表编号 / 光谱型） */
  identityOf(id: number): StarIdentity | null {
    const tuple = this.names?.get(id);
    if (!tuple) return null;
    const out: StarIdentity = {};
    STAR_NAME_FIELDS.forEach((field, i) => {
      const value = tuple[i];
      if (value === null || value === undefined) return;
      if (field === 'hip' || field === 'hd' || field === 'hr') {
        out[field] = typeof value === 'number' ? value : Number(value);
      } else {
        out[field] = String(value);
      }
    });
    return out;
  }

  /** 星名表里是否有这颗星 */
  hasIdentity(id: number): boolean {
    return this.names?.has(id) ?? false;
  }

  /**
   * 按当前视野计算需要哪些分块。
   *
   * 视线中心与视野圆盘都要换算到**赤道 J2000** 坐标系，
   * 因为分块的 HEALPix 天区号是按存储的 J2000 单位向量算出来的。
   *
   * @param query      视野查询参数（赤道 J2000 下的中心方向 + 视场角）
   * @param equToHoriz 赤道 J2000 → 地平 的矩阵，用于把「地平线以下」的天区剔除
   * @param policy     分档加载策略
   */
  plan(
    query: ViewQuery,
    equToHoriz: Mat3,
    policy: readonly TierLoadPolicy[] = DEFAULT_TIER_POLICY,
  ): ChunkPlan {
    const required = new Set<string>();
    const descriptors = new Map<string, { tierId: string; pix: number; url: string }>();
    if (!this.manifest) return { required, descriptors };

    const radius = viewConeRadiusRad(query.fovDeg, query.aspect);
    const center = query.centerEqj;
    const theta = Math.acos(Math.max(-1, Math.min(1, center.z)));
    let phi = Math.atan2(center.y, center.x);
    if (phi < 0) phi += 2 * Math.PI;

    for (const tier of this.manifest.tiers) {
      const rule = policy.find((p) => p.tierId === tier.id);
      const threshold = rule?.loadBelowFovDeg ?? Number.POSITIVE_INFINITY;
      if (query.fovDeg > threshold) continue;

      if (tier.layout === 'allsky') {
        const key = `${tier.id}:allsky`;
        required.add(key);
        descriptors.set(key, { tierId: tier.id, pix: -1, url: `${this.baseUrl}${tier.pathTemplate}` });
        continue;
      }

      const pixels = queryDiscNest(tier.nside, theta, phi, radius);
      const counts = this.tilesByTier.get(tier.id);
      const tileRadius = pixelRadiusRad(tier.nside);
      for (const pix of pixels) {
        if (!counts?.has(pix)) continue; // 该天区没有星

        // 整个天区都在地平线以下就跳过。用天区中心 + 外接圆半径保守判断，
        // 只可能多留、不会漏掉——但抬头看天顶时能省掉近一半的请求。
        const tileHor = mat3Apply(equToHoriz, nestedPixelToVector(pix, tier.nside));
        const tileAlt = Math.asin(clamp(tileHor.z, -1, 1));
        if (tileAlt + tileRadius < -0.02) continue;

        const key = `${tier.id}:${pix}`;
        required.add(key);
        descriptors.set(key, {
          tierId: tier.id,
          pix,
          url: `${this.baseUrl}${tier.pathTemplate.replace('{pix}', String(pix))}`,
        });
      }
    }

    return { required, descriptors };
  }

  /** 应用计划：加载缺失的、淘汰多余的 */
  apply(plan: ChunkPlan): void {
    const frame = ++this.tick;

    for (const key of plan.required) {
      if (this.chunks.has(key)) {
        this.lastUsed.set(key, frame);
        continue;
      }
      if (this.pending.has(key) || this.failed.has(key)) continue;
      const desc = plan.descriptors.get(key);
      if (!desc) continue;
      this.enqueue(key, desc);
    }

    // 淘汰：不在需求里且驻留数超限时，按最久未用优先释放
    if (this.chunks.size > this.maxResidentChunks) {
      const candidates = [...this.chunks.keys()]
        .filter((k) => !plan.required.has(k))
        .sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0));
      let changed = false;
      for (const key of candidates) {
        if (this.chunks.size <= this.maxResidentChunks) break;
        this.chunks.delete(key);
        this.lastUsed.delete(key);
        changed = true;
      }
      if (changed) this.onChunksChanged?.();
    }
  }

  private enqueue(
    key: string,
    desc: { tierId: string; pix: number; url: string },
  ): void {
    this.pending.add(key);
    this.queue.push(key);
    this.pumpQueue();
    // 记下描述，出队时用
    this.descriptors.set(key, desc);
  }

  private descriptors = new Map<string, { tierId: string; pix: number; url: string }>();

  private pumpQueue(): void {
    while (this.inFlight < this.maxConcurrentFetches && this.queue.length > 0) {
      const key = this.queue.shift()!;
      const desc = this.descriptors.get(key);
      if (!desc) {
        this.pending.delete(key);
        continue;
      }
      this.inFlight++;
      void this.fetchChunk(key, desc)
        .catch((err: unknown) => {
          this.failed.set(key, err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          this.inFlight--;
          this.pending.delete(key);
          this.descriptors.delete(key);
          this.pumpQueue();
        });
    }
  }

  private async fetchChunk(
    key: string,
    desc: { tierId: string; pix: number; url: string },
  ): Promise<void> {
    const res = await fetch(desc.url, { signal: this.aborter.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buffer = await res.arrayBuffer();
    const chunk = parseChunk(buffer, key, desc.tierId, desc.pix);
    this.chunks.set(key, chunk);
    this.lastUsed.set(key, this.tick);
    this.onChunksChanged?.();
  }

  /** 当前驻留的分块（渲染层用来建 GPU 缓冲） */
  residentChunks(): StarChunk[] {
    return [...this.chunks.values()];
  }

  /** 只取渲染需要的那些分块，按档排序保证绘制顺序稳定 */
  residentChunksByTier(order: readonly string[]): StarChunk[] {
    const rank = new Map(order.map((id, i) => [id, i]));
    return [...this.chunks.values()].sort((a, b) => {
      const ra = rank.get(a.tierId) ?? 99;
      const rb = rank.get(b.tierId) ?? 99;
      if (ra !== rb) return ra - rb;
      return a.pix - b.pix;
    });
  }

  /** 估算某个视场角下大概会加载多少颗星，用于 UI 显示 */
  estimateLoadedStars(fovDeg: number, policy: readonly TierLoadPolicy[] = DEFAULT_TIER_POLICY): number {
    if (!this.manifest) return 0;
    let total = 0;
    for (const tier of this.manifest.tiers) {
      const rule = policy.find((p) => p.tierId === tier.id);
      const threshold = rule?.loadBelowFovDeg ?? Number.POSITIVE_INFINITY;
      if (fovDeg > threshold) continue;
      if (tier.layout === 'allsky') {
        total += tier.count;
      } else {
        total += tier.count / nsideToNpix(tier.nside) * 4;
      }
    }
    return Math.round(total);
  }

  /** 由地平向量反推赤道 J2000 向量（用于选块与调试） */
  static horizontalToEquatorial(horizonToEquJ: Mat3, dirHorizon: Vec3): Vec3 {
    return mat3Apply(horizonToEquJ, dirHorizon);
  }

  /** 把赤道 J2000 向量换成 NESTED 天区号 */
  static pixelOf(v: Vec3, nside: number): number {
    const theta = Math.acos(Math.max(-1, Math.min(1, v.z)));
    let phi = Math.atan2(v.y, v.x);
    if (phi < 0) phi += 2 * Math.PI;
    return ang2pixNest(nside, theta, phi);
  }

  dispose(): void {
    this.aborter.abort();
    this.chunks.clear();
    this.pending.clear();
    this.queue.length = 0;
  }
}
