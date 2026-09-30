/**
 * 星表预处理脚本：AT-HYG v3.2 → 前端二进制分块。
 *
 * 运行：`pnpm run data:stars`
 * 输入：`data/raw/athyg_v32-1.csv.gz`、`data/raw/athyg_v32-2.csv.gz`
 * 输出：`public/data/stars/`
 *
 * ## 数据源事实（都已实测核对，别照抄网上说法）
 *
 * 1. **`ra` 的单位是「小时」，不是度**。`ra_deg = ra × 15`。
 *    核对：Sirius `ra=6.7525694` → `101.2885°`，与 J2000 的 `101.2872°` 相符。
 * 2. **位置历元是 J1991.25**，不是 J2000。99.93% 的行 `pos_src='T'`（来自 Tycho-2）。
 *    核对：对 Sirius / Vega / Betelgeuse / Polaris 施加 `+8.75 年 × 自行` 后，
 *    与公认 J2000 坐标的差 < 0.11″；不施加则差到 10″ 量级。
 *    所以这里**先推算到 J2000 再存**，运行时只需从 J2000 起算，链路更干净。
 * 3. **第二个文件没有表头**，必须显式补上列名。
 * 4. 第 1 行 `id=1` 是 **Sol**（`proper='Sol'`），按要求过滤掉。
 * 5. 极少数行的 `spect` 字段用双引号包裹且内部含逗号（全库共 47 行），
 *    所以需要一个能处理引号的 CSV 切分器。
 *
 * ## 输出格式
 *
 * 每个分块是一个独立二进制文件，**SoA（结构体数组 → 数组结构体）布局**，
 * 各段起始地址都对齐到 4 字节，可以直接建 `Float32Array` / `Uint8Array` 视图：
 *
 * ```
 * 偏移            内容                     类型
 * 0               文件头 32 字节           见下方 ChunkHeader
 * 32              positions   count×3      float32   赤道 J2000 单位向量 xyz
 * 32+12n          magnitudes  count        float32   视星等
 * 32+16n          rgba        count×4      uint8     rgb = 线性 sRGB 颜色（最大分量归一为 1）
 *                                                    a   = B-V 编码：round((bv+0.5)×50)
 * 32+20n          properMotion count×2     float32   μ_α*、μ_δ，mas/yr
 * 32+28n          starIds      count       uint32    AT-HYG 行 id（用于查星名/星表编号）
 * ```
 * 单颗星 32 字节，全部 4 字节对齐。
 */

import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';

import { raDecToVector } from '../src/astro/coordinates';
import { applyProperMotion } from '../src/astro/properMotion';
import { bvToLinearRgbBytes, DEFAULT_BV } from '../src/astro/starColor';
import { ang2pixNest, nsideToNpix } from '../src/data/healpix';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RAW_DIR = join(ROOT, 'data', 'raw');
const OUT_DIR = join(ROOT, 'public', 'data', 'stars');

/** AT-HYG 位置历元 J1991.25 到 J2000.0 的儒略年差 */
const AT_HYG_EPOCH_DELTA_YEARS = 8.75;

const CSV_COLUMNS = [
  'id', 'tyc', 'gaia', 'hyg', 'hip', 'hd', 'hr', 'gl', 'bayer', 'flam',
  'con', 'proper', 'ra', 'dec', 'pos_src', 'dist', 'x0', 'y0', 'z0', 'dist_src',
  'mag', 'absmag', 'ci', 'mag_src', 'rv', 'rv_src', 'pm_ra', 'pm_dec', 'pm_src',
  'vx', 'vy', 'vz', 'spect', 'spect_src',
] as const;

const COL = Object.fromEntries(CSV_COLUMNS.map((name, i) => [name, i])) as Record<
  (typeof CSV_COLUMNS)[number],
  number
>;

const CHUNK_MAGIC = 0x31545358; // "XST1"
const CHUNK_HEADER_BYTES = 32;
const STAR_BYTES = 32;

interface TierConfig {
  id: string;
  label: string;
  magMin: number;
  /** 上界，不含 */
  magMax: number;
  /** 0 表示全天单文件；否则为该层级的 HEALPix nside */
  nside: number;
}

const TIERS: readonly TierConfig[] = [
  { id: 'A', label: '全天整体加载 · mag < 6.5（肉眼可见）', magMin: -Infinity, magMax: 6.5, nside: 0 },
  { id: 'B', label: '全天整体加载 · 6.5 ≤ mag < 8.5', magMin: 6.5, magMax: 8.5, nside: 0 },
  { id: 'C', label: 'HEALPix nside=8 切片 · 8.5 ≤ mag < 10.5', magMin: 8.5, magMax: 10.5, nside: 8 },
  { id: 'D', label: 'HEALPix nside=16 切片 · mag ≥ 10.5', magMin: 10.5, magMax: Infinity, nside: 16 },
];

// ---------------------------------------------------------------------------
// 可增长的 SoA 缓冲
// ---------------------------------------------------------------------------

/**
 * 一个分块的累积器。
 *
 * 星表是流式读的，事先不知道每个天区有多少颗星，所以用倍增扩容。
 * 用类型化数组而不是普通数组：255 万颗星如果用 JS 数组装，
 * 装箱开销会到几百 MB；类型化数组只有 32 字节/星。
 */
class ChunkAccumulator {
  private capacity: number;
  private length = 0;

  pos: Float32Array;
  mag: Float32Array;
  rgba: Uint8Array;
  pm: Float32Array;
  ids: Uint32Array;

  magMin = Infinity;
  magMax = -Infinity;

  constructor(initialCapacity = 1024) {
    this.capacity = initialCapacity;
    this.pos = new Float32Array(initialCapacity * 3);
    this.mag = new Float32Array(initialCapacity);
    this.rgba = new Uint8Array(initialCapacity * 4);
    this.pm = new Float32Array(initialCapacity * 2);
    this.ids = new Uint32Array(initialCapacity);
  }

  get count(): number {
    return this.length;
  }

  private grow(): void {
    const next = this.capacity * 2;
    const pos = new Float32Array(next * 3);
    pos.set(this.pos);
    this.pos = pos;

    const mag = new Float32Array(next);
    mag.set(this.mag);
    this.mag = mag;

    const rgba = new Uint8Array(next * 4);
    rgba.set(this.rgba);
    this.rgba = rgba;

    const pm = new Float32Array(next * 2);
    pm.set(this.pm);
    this.pm = pm;

    const ids = new Uint32Array(next);
    ids.set(this.ids);
    this.ids = ids;

    this.capacity = next;
  }

  push(
    x: number,
    y: number,
    z: number,
    magnitude: number,
    r: number,
    g: number,
    b: number,
    bvCode: number,
    pmRa: number,
    pmDec: number,
    id: number,
  ): void {
    if (this.length >= this.capacity) this.grow();
    const i = this.length;

    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.mag[i] = magnitude;
    this.rgba[i * 4] = r;
    this.rgba[i * 4 + 1] = g;
    this.rgba[i * 4 + 2] = b;
    this.rgba[i * 4 + 3] = bvCode;
    this.pm[i * 2] = pmRa;
    this.pm[i * 2 + 1] = pmDec;
    this.ids[i] = id;

    if (magnitude < this.magMin) this.magMin = magnitude;
    if (magnitude > this.magMax) this.magMax = magnitude;

    this.length++;
  }

  /** 序列化成最终的分块二进制（含 32 字节头，各段 4 字节对齐） */
  serialize(tier: TierConfig, nside: number): Uint8Array {
    const n = this.length;
    const total = CHUNK_HEADER_BYTES + STAR_BYTES * n;
    const buf = new ArrayBuffer(total);
    const view = new DataView(buf);
    const u8 = new Uint8Array(buf);

    view.setUint32(0, CHUNK_MAGIC, true);
    view.setUint32(4, 1, true);
    view.setUint32(8, n, true);
    view.setFloat32(12, Number.isFinite(this.magMin) ? this.magMin : 0, true);
    view.setFloat32(16, Number.isFinite(this.magMax) ? this.magMax : 0, true);
    view.setUint32(20, tier.id.charCodeAt(0), true);
    view.setUint32(24, nside, true);
    view.setUint32(28, 0, true);

    const posOff = CHUNK_HEADER_BYTES;
    const magOff = posOff + n * 12;
    const rgbaOff = magOff + n * 4;
    const pmOff = rgbaOff + n * 4;
    const idOff = pmOff + n * 8;

    u8.set(new Uint8Array(this.pos.buffer, 0, n * 3), posOff);
    u8.set(new Uint8Array(this.mag.buffer, 0, n * 4), magOff);
    u8.set(this.rgba.subarray(0, n * 4), rgbaOff);
    u8.set(new Uint8Array(this.pm.buffer, 0, n * 8), pmOff);
    u8.set(new Uint8Array(this.ids.buffer, 0, n * 4), idOff);

    return u8;
  }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** 只有极少数行（全库 47 行）用了引号，走快路径 split 更快 */
function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function toNumber(value: string | undefined): number {
  if (value === undefined || value === '') return NaN;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 有「身份」的恒星记录。
 *
 * 用紧凑数组而不是对象，是因为对象里重复的键名会显著膨胀 JSON：
 * 同一个字段在 4 万条记录里就要写 4 万遍 `"hip":`。
 *
 * 字段顺序（末尾的空值会被裁掉，消费方按固定下标读）：
 * `[专名, 拜耳字母, 弗兰斯蒂德号, 星座缩写, HIP, HD, HR, 光谱型]`
 */
type NamedStarTuple = (string | number | null)[];

/** 上面的字段顺序，会写进 manifest 供运行时对照 */
const NAMED_STAR_FIELDS = [
  'name',
  'bayer',
  'flam',
  'con',
  'hip',
  'hd',
  'hr',
  'spect',
] as const;

/** 只有 mag 亮于这个值的无名字星才保留星表编号，控制 JSON 体积 */
const CATALOG_META_MAG_LIMIT = 8.0;

interface TileStat {
  file: string;
  bytes: number;
  count: number;
  pix: number;
}

interface TierStat {
  id: string;
  label: string;
  layout: 'allsky' | 'healpix';
  nside: number;
  count: number;
  bytes: number;
  files: TileStat[];
}

function bvCode(bv: number | null): number {
  const v = bv === null ? DEFAULT_BV : bv;
  return Math.max(0, Math.min(255, Math.round((v + 0.5) * 50)));
}

async function* readCatalogLines(): AsyncGenerator<{ line: string; index: number }> {
  const files = ['athyg_v32-1.csv.gz', 'athyg_v32-2.csv.gz'];
  for (const file of files) {
    const path = join(RAW_DIR, file);
    if (!existsSync(path)) {
      throw new Error(`缺少原始数据 ${relative(ROOT, path)}，请先按 README 下载。`);
    }
    const stream = createReadStream(path).pipe(createGunzip());
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let first = true;
    let index = 0;
    for await (const line of rl) {
      if (line.length === 0) continue;
      if (first) {
        first = false;
        // 文件 1 有表头，文件 2 没有 —— 用内容判断，不要靠文件名
        if (line.startsWith('id,')) continue;
      }
      yield { line, index: index++ };
    }
  }
}

async function main(): Promise<void> {
  const t0 = performance.now();
  process.stdout.write('星表预处理开始\n');

  if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true, force: true });

  /** tierId → (tileKey → 累积器) */
  const buckets = new Map<string, Map<number, ChunkAccumulator>>();
  for (const tier of TIERS) buckets.set(tier.id, new Map());

  const namedStars = new Map<number, NamedStarTuple>();

  let totalRows = 0;
  let skippedSol = 0;
  let missingCi = 0;
  let missingPm = 0;
  let withProperName = 0;
  let withBayerOrFlamsteed = 0;

  for await (const { line } of readCatalogLines()) {
    totalRows++;
    const f = splitCsvLine(line);

    const id = toNumber(f[COL.id]);
    if (!Number.isFinite(id)) continue;
    // 过滤太阳
    if (id === 1 || f[COL.proper] === 'Sol') {
      skippedSol++;
      continue;
    }

    const raHours = toNumber(f[COL.ra]);
    const decDeg = toNumber(f[COL.dec]);
    const mag = toNumber(f[COL.mag]);
    if (!Number.isFinite(raHours) || !Number.isFinite(decDeg) || !Number.isFinite(mag)) continue;

    // 星表给出的是 J1991.25 历元的位置，先推算到 J2000
    const raDeg = raHours * 15;
    const base = raDecToVector(raDeg, decDeg);

    const pmRa = toNumber(f[COL.pm_ra]);
    const pmDec = toNumber(f[COL.pm_dec]);
    const hasPm = Number.isFinite(pmRa) && Number.isFinite(pmDec);
    if (!hasPm) missingPm++;

    const pmRaMas = hasPm ? pmRa : 0;
    const pmDecMas = hasPm ? pmDec : 0;
    const p = applyProperMotion(base, pmRaMas, pmDecMas, AT_HYG_EPOCH_DELTA_YEARS);

    const ci = toNumber(f[COL.ci]);
    const hasCi = Number.isFinite(ci);
    if (!hasCi) missingCi++;
    const bv = hasCi ? ci : null;
    const [r, g, b] = bvToLinearRgbBytes(bv === null ? DEFAULT_BV : bv, 0.85);

    // 选档
    let tier: TierConfig | undefined;
    for (const t of TIERS) {
      if (mag >= t.magMin && mag < t.magMax) {
        tier = t;
        break;
      }
    }
    if (!tier) continue;

    const tileMap = buckets.get(tier.id)!;
    let pix = 0;
    if (tier.nside > 0) {
      const theta = Math.acos(Math.max(-1, Math.min(1, p.z)));
      const phi = Math.atan2(p.y, p.x);
      pix = ang2pixNest(tier.nside, theta, phi < 0 ? phi + 2 * Math.PI : phi);
    }

    let acc = tileMap.get(pix);
    if (!acc) {
      acc = new ChunkAccumulator(tier.nside === 0 ? 16384 : 512);
      tileMap.set(pix, acc);
    }
    acc.push(p.x, p.y, p.z, mag, r, g, b, bvCode(bv), pmRaMas, pmDecMas, id);

    // 收集有「身份」的恒星，供标签与信息卡使用
    const proper = f[COL.proper];
    const bayer = f[COL.bayer];
    const flam = f[COL.flam];
    if (proper) withProperName++;
    if (bayer || flam) withBayerOrFlamsteed++;

    const designated = Boolean(proper || bayer || flam);
    if (designated || mag < CATALOG_META_MAG_LIMIT) {
      const hip = toNumber(f[COL.hip]);
      const hd = toNumber(f[COL.hd]);
      const hr = toNumber(f[COL.hr]);
      const con = f[COL.con];
      const spect = f[COL.spect];
      const tuple: NamedStarTuple = [
        proper || null,
        bayer || null,
        flam || null,
        con || null,
        Number.isFinite(hip) ? hip : null,
        Number.isFinite(hd) ? hd : null,
        Number.isFinite(hr) ? hr : null,
        // 光谱型字符串最长，只给真正有名字/编号的星保留
        designated && spect ? spect : null,
      ];
      while (tuple.length > 0 && tuple[tuple.length - 1] === null) tuple.pop();
      namedStars.set(id, tuple);
    }

    if (totalRows % 250000 === 0) {
      process.stdout.write(`  已读 ${totalRows.toLocaleString()} 行…\n`);
    }
  }

  const readSeconds = (performance.now() - t0) / 1000;
  process.stdout.write(`读取完毕：${totalRows.toLocaleString()} 行，用时 ${readSeconds.toFixed(1)}s\n`);

  // ---- 落盘 ----
  mkdirSync(OUT_DIR, { recursive: true });

  const tierStats: TierStat[] = [];
  let grandTotal = 0;
  let grandBytes = 0;

  for (const tier of TIERS) {
    const tileMap = buckets.get(tier.id)!;
    const files: TileStat[] = [];
    let tierCount = 0;
    let tierBytes = 0;

    const pixKeys = [...tileMap.keys()].sort((a, b) => a - b);
    for (const pix of pixKeys) {
      const acc = tileMap.get(pix)!;
      if (acc.count === 0) continue;
      const bytes = acc.serialize(tier, tier.nside);
      const rel =
        tier.nside === 0
          ? `tier-${tier.id.toLowerCase()}.bin`
          : join(`tier-${tier.id.toLowerCase()}`, `nside${tier.nside}`, `Npix${pix}.bin`);
      const abs = join(OUT_DIR, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
      files.push({ file: rel.split('\\').join('/'), bytes: bytes.byteLength, count: acc.count, pix });
      tierCount += acc.count;
      tierBytes += bytes.byteLength;
    }

    tierStats.push({
      id: tier.id,
      label: tier.label,
      layout: tier.nside === 0 ? 'allsky' : 'healpix',
      nside: tier.nside,
      count: tierCount,
      bytes: tierBytes,
      files,
    });
    grandTotal += tierCount;
    grandBytes += tierBytes;
  }

  // ---- 星名 / 星表编号 ----
  const namesObj: Record<string, NamedStarTuple> = {};
  for (const [id, tuple] of namedStars) namesObj[String(id)] = tuple;
  const namesJson = JSON.stringify(namesObj);
  writeFileSync(join(OUT_DIR, 'star-names.json'), namesJson);

  // ---- manifest ----
  const manifest = {
    version: 1,
    generator: 'scripts/build-stars.ts',
    generatedAt: new Date().toISOString(),
    recordBytes: STAR_BYTES,
    headerBytes: CHUNK_HEADER_BYTES,
    epoch: 'J2000.0',
    sourceEpoch: 'J1991.25',
    frame: 'ICRS / 赤道 J2000',
    totalStars: grandTotal,
    reference: {
      name: 'AT-HYG v3.2 (Augmented Tycho — HYG)',
      author: 'David Nash',
      license: 'CC BY-SA 4.0',
      url: 'https://codeberg.org/astronexus/athyg',
      upstream: 'Tycho-2 (ESA 2000) + Hipparcos-2 + Gaia DR3 位置/自行',
    },
    names: {
      file: 'star-names.json',
      bytes: Buffer.byteLength(namesJson),
      count: namedStars.size,
      /** 每条记录的字段顺序 */
      fields: NAMED_STAR_FIELDS,
      /** 无名字的星只保留 mag 亮于此值的那些 */
      magLimit: CATALOG_META_MAG_LIMIT,
    },
    tiers: tierStats.map((t) => ({
      id: t.id,
      label: t.label,
      layout: t.layout,
      nside: t.nside,
      count: t.count,
      bytes: t.bytes,
      /**
       * 文件路径模板，`{pix}` 换成天区号。
       * 全天档只有一个文件，此时为空字符串。
       */
      pathTemplate:
        t.nside === 0 ? `tier-${t.id.toLowerCase()}.bin` : `tier-${t.id.toLowerCase()}/nside${t.nside}/Npix{pix}.bin`,
      /**
       * HEALPix 天区清单：`[天区号, 星数]`。
       * 用数组而不是对象，3072 个天区能省下几十万字符。
       * 字节数可由 `32 × 星数 + 32` 推出，不重复存储。
       */
      tiles: t.nside === 0 ? null : t.files.map((f) => [f.pix, f.count]),
    })),
  };
  const manifestJson = JSON.stringify(manifest, null, 2);
  writeFileSync(join(OUT_DIR, 'manifest.json'), manifestJson);

  // ---- 统计输出 ----
  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(2)} MB`;
  process.stdout.write('\n================ 分块统计 ================\n');
  for (const t of tierStats) {
    process.stdout.write(`\n档 ${t.id}：${t.label}\n`);
    process.stdout.write(`  ${t.count.toLocaleString()} 颗星，${t.files.length} 个文件，合计 ${mb(t.bytes)}\n`);
    if (t.nside === 0) {
      for (const f of t.files) {
        process.stdout.write(`    ${f.file.padEnd(28)} ${f.count.toLocaleString().padStart(10)} 颗  ${mb(f.bytes)}\n`);
      }
    } else {
      const sorted = [...t.files].sort((a, b) => b.count - a.count);
      const sizes = t.files.map((f) => f.bytes).sort((a, b) => a - b);
      const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
      process.stdout.write(
        `    每个天区块：中位 ${median.toLocaleString()} B，最小 ${(sizes[0] ?? 0).toLocaleString()} B，最大 ${(sizes[sizes.length - 1] ?? 0).toLocaleString()} B\n`,
      );
      process.stdout.write(`    最大的 3 个天区：\n`);
      for (const f of sorted.slice(0, 3)) {
        process.stdout.write(`      Npix${String(f.pix).padStart(6)}  ${f.count.toLocaleString().padStart(7)} 颗  ${mb(f.bytes)}\n`);
      }
      process.stdout.write(`    空天区（无星）：${nsideToNpix(t.nside) - t.files.length} 个\n`);
    }
  }

  process.stdout.write('\n================ 汇总 ================\n');
  process.stdout.write(`  星表总星数        : ${grandTotal.toLocaleString()}\n`);
  process.stdout.write(`  过滤掉的 Sol      : ${skippedSol}\n`);
  process.stdout.write(`  缺 B-V 的星        : ${missingCi.toLocaleString()}（用太阳色 0.65 兜底）\n`);
  process.stdout.write(`  缺自行的星         : ${missingPm.toLocaleString()}\n`);
  process.stdout.write(`  有专名的星         : ${withProperName.toLocaleString()}\n`);
  process.stdout.write(`  有拜耳/弗兰斯蒂德号: ${withBayerOrFlamsteed.toLocaleString()}\n`);
  process.stdout.write(`  star-names.json   : ${namedStars.size.toLocaleString()} 条，${mb(Buffer.byteLength(namesJson))}\n`);
  process.stdout.write(`  manifest.json     : ${mb(Buffer.byteLength(manifestJson))}\n`);
  process.stdout.write(`  数据总大小        : ${mb(grandBytes)}（另有 star-names.json + manifest.json）\n`);
  process.stdout.write(`  输出目录          : ${relative(ROOT, OUT_DIR)}\n`);
  process.stdout.write(`  总用时            : ${((performance.now() - t0) / 1000).toFixed(1)}s\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`预处理失败：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
