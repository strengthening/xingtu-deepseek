/**
 * 星座连线预处理脚本：Stellarium skyculture + AT-HYG 星表 → 运行时 JSON。
 *
 * 运行：`pnpm run data:constellations`
 *   （等价于 `node node_modules/tsx/dist/cli.mjs scripts/build-constellations.ts`，
 *    必须用系统 node —— DSH 自带的 node 加载原生模块会有签名问题）
 *
 * 输入：
 *   `data/raw/constellations/Stellarium_modern.index.json`      西方 88 星座
 *   `data/raw/constellations/Stellarium_chinese.index.json`     中国星官 312 个
 *   `data/raw/constellations/Stellarium_chinese.star_names.zh_CN.fab`
 *   `data/raw/athyg_v32-1.csv.gz`、`data/raw/athyg_v32-2.csv.gz`
 *
 * 输出：
 *   `public/data/constellations/manifest.json`
 *   `public/data/constellations/western.json`
 *   `public/data/constellations/chinese.json`
 *   `public/data/constellations/chinese-star-names.json`
 *
 * ## 为什么连线要绕一圈经过 AT-HYG
 *
 * Stellarium 的 `constellations[].lines` 里**只有 HIP 编号，没有坐标**
 * （这是好事：不用做坐标最近邻，也就没有历元不一致的坑）。
 * 而运行时渲染一条线要的是单位向量，且后面还要按观测时刻推算自行，
 * 所以必须把 HIP 换成星表里的位置 + 自行。本项目唯一的星表是 AT-HYG v3.2，
 * 于是链路是：`HIP → AT-HYG 行 → J1991.25 位置 → +8.75 年自行 → J2000 单位向量`。
 *
 * ## 数据源事实（与 `data/raw/constellations/REPORT.md` 一致，已实测）
 *
 * 1. **AT-HYG 的 `ra` 单位是「小时」**，`ra_deg = ra × 15`（否则整个星空会错位）。
 * 2. **AT-HYG 的位置历元是 J1991.25**（Tycho-2 / Hipparcos 目录位置），
 *    必须先用自行推算 8.75 年才得到 J2000。这一步不能省：
 *    巴纳德星这类目标 8.75 年能走 1.5 角分，肉眼可见的亮星也有 10″ 量级。
 *    本脚本输出的就是**改正后的 J2000 单位向量**，运行时从 J2000 起算即可。
 * 3. **`athyg_v32-2.csv.gz` 没有表头**，必须按内容判断（`line.startsWith('id,')`）。
 * 4. CSV 里极少数行的 `spect` 字段有双引号包裹的逗号，所以切片器要能处理引号
 *    （`splitCsvLine` 与 `scripts/build-stars.ts` 一致，全库只有 47 行走慢路径）。
 * 5. **`lines` 里混有非 HIP 的标识符**：Gaia DR3 source_id 字符串
 *    （如 `"5350358584482202880"`）和 `DSO:NGC2632` 这类天体标识符。
 *    必须用 `typeof v === 'number' && Number.isInteger(v)` 过滤掉。
 * 6. **`lines` 是数组的数组**，每个子数组是一条**独立折线**，必须逐条断开处理；
 *    展平会画出根本不存在的跨段连线。
 * 7. **3 个 HIP 在 AT-HYG v3.2 里查不到**：`55203`(ξ UMa)、`78727`(ξ Sco)、
 *    `115125`(94 Aqr B)。都是多星系统里的非主星分量，AT-HYG v3.x 有意省略。
 *    处理方式：该 HIP 相关的线段整条丢弃（不是把顶点删掉接起来——那会拉出一条假线），
 *    折线因此从缺口中断开，脚本统计丢弃数量。
 * 8. **许可证**：Stellarium skyculture 与 AT-HYG 都是 **CC BY-SA 4.0**，
 *    所以这些派生 JSON 也按 CC BY-SA 4.0 分发，manifest 里带上署名。
 *
 * ## 折线的「闭合」与「重复顶点」
 *
 * 原始数据里有若干折线的**首尾是同一个 HIP**（西方 24 条、中国 72 条），
 * 还有相邻两个顶点是同一个 HIP 的（中国 58 处，即零长度线段）。
 * 项目里折线一律当**开放折线**处理（闭合与否由运行时判断），
 * 所以这里把重复顶点都去掉，并把删掉的数量打进统计。
 * 因此输出线段数**小于**报告里的源线段数（695 / 1153），差额就是这些重复顶点。
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';

import { raDecToVector } from '../src/astro/coordinates';
import { applyProperMotion } from '../src/astro/properMotion';
import { MAS_TO_RAD, RAD } from '../src/astro/constants';
import { CONSTELLATION_NAMES } from '../src/data/constellationNames';
import type { Vec3 } from '../src/astro/vec3';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RAW_DIR = join(ROOT, 'data', 'raw');
const SKY_DIR = join(RAW_DIR, 'constellations');
const OUT_DIR = join(ROOT, 'public', 'data', 'constellations');
// 中文星名和星座连线同源（都来自 Stellarium skyculture，同为 CC BY-SA 4.0），
// 所以放在同一个输出目录。
//
// ⚠️ 不要写进 public/data/stars/：`scripts/build-stars.ts` 开头会
// `rmSync(public/data/stars)` 清空该目录重来，单独重跑 `pnpm run data:stars`
// 会把它删掉。放在 constellations 目录下就没有这个顺序耦合。

/** AT-HYG 位置历元 J1991.25 到 J2000.0 的儒略年差（与 `scripts/build-stars.ts` 保持一致） */
const AT_HYG_EPOCH_DELTA_YEARS = 8.75;

/**
 * HIP 编号上界。Hipparcos 星表实际到 120404。
 * 这里放宽到 200000 只是兜底：万一某天上游把 Gaia source_id 写成 JSON **数字**
 * （而不是现在的字符串），`Number.isInteger(5.35e18)` 也会是 true，
 * 光靠 `Number.isInteger` 挡不住。
 */
const HIP_MAX = 200000;

/** 报告里已经核实过、AT-HYG v3.2 缺失的那 3 个 HIP，用于跑完之后的交叉核对 */
const KNOWN_MISSING_HIPS: readonly number[] = [55203, 78727, 115125];

/**
 * `REPORT.md` 里实测的**源数据线段数**，用于跑完之后的交叉核对。
 * 输出线段数会比它少：闭合折线的收尾重复顶点、相邻重复顶点、
 * 以及端点缺失造成的断口都要扣掉（见文件头说明）。
 */
const REPORT_SOURCE_SEGMENTS: Readonly<Record<string, number>> = { western: 695, chinese: 1153 };

/** Stellarium skyculture 数据 + AT-HYG 星表都是 CC BY-SA 4.0 */
const LICENSE = Object.freeze({
  name: 'CC BY-SA 4.0',
  url: 'https://creativecommons.org/licenses/by-sa/4.0/',
  credit: 'Sky culture data from Stellarium (https://stellarium.org)',
});

interface GroupConfig {
  id: string;
  label: string;
  /** 原始 Stellarium skyculture 文件（在 `data/raw/constellations/` 下） */
  source: string;
  /** 输出的分组文件 */
  file: string;
  /** Stellarium 里星座 id 的前缀，剥掉后作为对外 id（`CON modern Ori` → `Ori`） */
  idPrefix: string;
  /** 该 skyculture 的 `common_name.native` 是不是中文（西方是拉丁名，中国是中文名） */
  nativeIsChinese: boolean;
}

const GROUPS: readonly GroupConfig[] = [
  {
    id: 'western',
    label: '西方 88 星座',
    source: 'Stellarium_modern.index.json',
    file: 'western.json',
    idPrefix: 'CON modern ',
    nativeIsChinese: false,
  },
  {
    id: 'chinese',
    label: '中国星官（三垣二十八宿）',
    source: 'Stellarium_chinese.index.json',
    file: 'chinese.json',
    idPrefix: 'CON chinese ',
    nativeIsChinese: true,
  },
];

/** 中文星名来源（加分项，解析失败不影响主流程） */
const STAR_NAME_FAB = 'Stellarium_chinese.star_names.zh_CN.fab';
const STAR_NAME_OUT = 'chinese-star-names.json';

/**
 * AT-HYG 的列序，与 `scripts/build-stars.ts` 的 `CSV_COLUMNS` 完全一致。
 * 这里只列出本脚本用得上的列，避免抄一份 34 列的清单过来。
 */
const COL = {
  hip: 4,
  ra: 12,
  dec: 13,
  pmRa: 26,
  pmDec: 27,
} as const;

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

async function* readCatalogLines(): AsyncGenerator<string> {
  const files = ['athyg_v32-1.csv.gz', 'athyg_v32-2.csv.gz'];
  for (const file of files) {
    const path = join(RAW_DIR, file);
    if (!existsSync(path)) {
      throw new Error(`缺少原始数据 ${relative(ROOT, path)}，请先按 README 下载。`);
    }
    const stream = createReadStream(path).pipe(createGunzip());
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let first = true;
    for await (const line of rl) {
      if (line.length === 0) continue;
      if (first) {
        first = false;
        // 文件 1 有表头，文件 2 没有 —— 用内容判断，不要靠文件名
        if (line.startsWith('id,')) continue;
      }
      yield line;
    }
  }
}

/** 只有极少数行（全库 47 行）用了引号，走快路径 split 更快。与 `scripts/build-stars.ts` 相同。 */
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

/**
 * 判断一个端点是不是可用的 HIP 号。
 *
 * Stellarium 的 `lines` 里混了字符串形式的 Gaia DR3 source_id 与 `DSO:*` 标识符，
 * 所以第一道关是 `typeof v === 'number' && Number.isInteger(v)`；
 * 第二道关是 HIP 的取值区间（防「大到失去精度的整数」被当成 HIP）。
 */
function isHipToken(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= HIP_MAX;
}

/** 计数用的 Map 自增 */
function bump<K>(map: Map<K, number>, key: K, delta = 1): void {
  map.set(key, (map.get(key) ?? 0) + delta);
}

/** `[3, 1]` 这种形式的排行榜，用于打印「出现最多的几个」 */
function topEntries<K>(map: ReadonlyMap<K, number>, limit: number): [K, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

// ---------------------------------------------------------------------------
// 第一步：读 Stellarium skyculture
// ---------------------------------------------------------------------------

interface RawConstellation {
  id?: unknown;
  lines?: unknown;
  common_name?: { english?: unknown; native?: unknown } | undefined;
}

interface SourceFigure {
  id: string;
  name: string | undefined;
  nameZh: string | undefined;
  /** 原始折线，元素可能是 number（HIP）也可能是 string（Gaia / DSO 标识符） */
  lines: unknown[][];
}

function parseSourceGroup(config: GroupConfig): SourceFigure[] {
  const abs = join(SKY_DIR, config.source);
  if (!existsSync(abs)) {
    throw new Error(`缺少原始数据 ${relative(ROOT, abs)}，请先按 REPORT.md 的复现命令下载。`);
  }
  const doc = JSON.parse(readFileSync(abs, 'utf8')) as { constellations?: unknown };
  const rawList = Array.isArray(doc.constellations) ? doc.constellations : [];

  const figures: SourceFigure[] = [];
  for (const item of rawList) {
    if (item === null || typeof item !== 'object') continue;
    const con = item as RawConstellation;
    const rawId = typeof con.id === 'string' ? con.id : '';
    // 剥掉 "CON modern " / "CON chinese " 前缀：西方得到 "Ori"，中国得到 "001"
    const id = rawId.startsWith(config.idPrefix) ? rawId.slice(config.idPrefix.length) : rawId;

    const lines: unknown[][] = [];
    if (Array.isArray(con.lines)) {
      for (const line of con.lines) if (Array.isArray(line)) lines.push(line);
    }

    const cn = con.common_name;
    const native = cn && typeof cn.native === 'string' ? cn.native : undefined;
    const english = cn && typeof cn.english === 'string' ? cn.english : undefined;

    // 西方星座的中文名不在 Stellarium 数据里（`native` 是拉丁名），
    // 复用运行时那份 `src/data/constellationNames.ts`（88 个 IAU 缩写 → 中英名）；
    // 中国星官的 `native` 本身就是中文。
    const nameZh = config.nativeIsChinese ? native : CONSTELLATION_NAMES[id]?.zh;
    const name = config.nativeIsChinese ? (english ?? native) : (native ?? english);

    figures.push({ id, name, nameZh, lines });
  }
  return figures;
}

// ---------------------------------------------------------------------------
// 第二步：读中文星名（*.fab）
// ---------------------------------------------------------------------------

/**
 * `.fab` 的行格式是 `HIP|_("星名") 序号`。
 * 实测两种变体都出现过（序号有 1 也有 2；`*` 可能落在引号内也可能落在引号外）：
 *   `80197|_("天纪增三*") 2`
 *   `56620|_("青丘增三"*) 2`
 * 所以 `*` 前后都要容忍，解析出来的名字把尾部 `*` 去掉。
 */
const FAB_LINE = /^(\d+)\|_\("(.*)"\*?\)\s+(\d+)\s*$/;

interface ChineseStarName {
  hip: number;
  name: string;
}

interface FabParseResult {
  names: ChineseStarName[];
  /** 一个 HIP 有多个别名（互为异名）时，只有第一个进输出 */
  aliasCount: number;
  badLines: string[];
}

function parseStarNameFab(): FabParseResult {
  const abs = join(SKY_DIR, STAR_NAME_FAB);
  const result: FabParseResult = { names: [], aliasCount: 0, badLines: [] };
  if (!existsSync(abs)) return result;

  const seen = new Set<number>();
  for (const rawLine of readFileSync(abs, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const m = FAB_LINE.exec(line);
    if (!m) {
      result.badLines.push(line);
      continue;
    }
    const hip = Number(m[1]!);
    const name = m[2]!.replace(/\*+$/, '').trim();
    if (name.length === 0) continue;
    if (seen.has(hip)) {
      result.aliasCount++;
      continue;
    }
    seen.add(hip);
    result.names.push({ hip, name });
  }
  return result;
}

// ---------------------------------------------------------------------------
// 第三步：扫 AT-HYG，只留被引用到的 HIP
// ---------------------------------------------------------------------------

interface HipPosition {
  /** 已推算到 J2000 的单位向量 */
  pos: Vec3;
  /** 总自行大小，mas/yr（用于统计自行改正的角秒数） */
  pmTotalMas: number;
}

interface HipIndex {
  map: Map<number, HipPosition>;
  rows: number;
  rowsWithHip: number;
  duplicates: number;
  maxPmMas: number;
  seconds: number;
}

/**
 * 只把 `needed` 里的 HIP 读进内存。
 *
 * 全表 255 万行里只有 11.8 万行带 HIP，而本脚本总共只关心 4000 多个；
 * 星座连线只用得到这 4000 多个，没必要为它们留一份全表索引。
 */
async function loadHipIndex(needed: ReadonlySet<number>): Promise<HipIndex> {
  const map = new Map<number, HipPosition>();
  const t0 = performance.now();
  let rows = 0;
  let rowsWithHip = 0;
  let duplicates = 0;
  let maxPmMas = 0;

  for await (const line of readCatalogLines()) {
    rows++;
    const f = splitCsvLine(line);
    const hip = toNumber(f[COL.hip]);
    if (!Number.isInteger(hip)) continue;
    rowsWithHip++;
    if (!needed.has(hip)) continue;

    const raHours = toNumber(f[COL.ra]);
    const decDeg = toNumber(f[COL.dec]);
    if (!Number.isFinite(raHours) || !Number.isFinite(decDeg)) continue;

    // `ra` 的单位是小时不是度；位置历元是 J1991.25，先推到 J2000
    const pmRa = toNumber(f[COL.pmRa]);
    const pmDec = toNumber(f[COL.pmDec]);
    const pmRaMas = Number.isFinite(pmRa) ? pmRa : 0;
    const pmDecMas = Number.isFinite(pmDec) ? pmDec : 0;
    const base = raDecToVector(raHours * 15, decDeg);
    const pos = applyProperMotion(base, pmRaMas, pmDecMas, AT_HYG_EPOCH_DELTA_YEARS);

    const pmTotalMas = Math.hypot(pmRaMas, pmDecMas);
    if (pmTotalMas > maxPmMas) maxPmMas = pmTotalMas;
    if (map.has(hip)) duplicates++;
    map.set(hip, { pos, pmTotalMas });

    if (rows % 500000 === 0) {
      process.stdout.write(`  已读 ${rows.toLocaleString()} 行…（命中 ${map.size} 个 HIP）\n`);
    }
  }

  return {
    map,
    rows,
    rowsWithHip,
    duplicates,
    maxPmMas,
    seconds: (performance.now() - t0) / 1000,
  };
}

// ---------------------------------------------------------------------------
// 第四步：折线清洗（缺 HIP 断开、去重复顶点）
// ---------------------------------------------------------------------------

interface GroupStats {
  sourceFigures: number;
  figures: number;
  figuresWithoutZh: number;
  /**
   * 清洗后一条折线都不剩的条目。
   *
   * Stellarium 把「只有一颗星的星官」写成 `[HIP, HIP]`（中国数据里有 57 个，
   * 如 `天狼 = [32349, 32349]`），3 个深空天体的星官写成 `[DSO:M7, DSO:M7]`。
   * 按「折线不重复首尾」的规则去掉重复顶点后只剩一个点，画不成线，
   * 所以这里如实统计成「无几何」，而不是伪造一条零长度折线。
   */
  figuresWithoutLines: number;
  sourcePolylines: number;
  polylines: number;
  sourceSegments: number;
  segments: number;
  vertices: number;
  /** 首尾重复被去掉的顶点数（即闭合折线的收尾点） */
  closedVerticesRemoved: number;
  /** 相邻重复顶点被去掉的数量（零长度线段） */
  duplicateVerticesRemoved: number;
  /** 因为端点缺失而整条丢弃的线段数 */
  segmentsBrokenByMissingHip: number;
  /** 清洗后不足 2 个顶点的残段（整段丢弃的顶点数） */
  orphanVertices: number;
  missingHips: Map<number, number>;
  nonHipTokens: Map<string, number>;
  outOfRangeIntegers: Map<number, number>;
  /** 输出向量的模长与 1 的最大偏差，用来证明归一化没坏 */
  maxUnitDeviation: number;
}

function emptyStats(): GroupStats {
  return {
    sourceFigures: 0,
    figures: 0,
    figuresWithoutZh: 0,
    figuresWithoutLines: 0,
    sourcePolylines: 0,
    polylines: 0,
    sourceSegments: 0,
    segments: 0,
    vertices: 0,
    closedVerticesRemoved: 0,
    duplicateVerticesRemoved: 0,
    segmentsBrokenByMissingHip: 0,
    orphanVertices: 0,
    missingHips: new Map(),
    nonHipTokens: new Map(),
    outOfRangeIntegers: new Map(),
    maxUnitDeviation: 0,
  };
}

interface EmittedFigure {
  id: string;
  name: string | undefined;
  nameZh: string | undefined;
  lines: number[][];
}

function cleanFigure(
  figure: SourceFigure,
  positions: ReadonlyMap<number, HipPosition>,
  stats: GroupStats,
): EmittedFigure {
  const lines: number[][] = [];

  for (const line of figure.lines) {
    stats.sourcePolylines++;
    stats.sourceSegments += Math.max(0, line.length - 1);

    // 1) 端点解析：非 HIP 的标识符、查不到的 HIP 都记一笔，位置置空
    const resolved: { hip: number; pos: Vec3 | null }[] = [];
    for (const token of line) {
      if (!isHipToken(token)) {
        if (typeof token === 'number' && Number.isInteger(token)) {
          // 是整数但超出 HIP 值域：只可能是坐标/编号混入，不能当 HIP 用
          bump(stats.outOfRangeIntegers, token);
        } else {
          bump(stats.nonHipTokens, String(token));
        }
        resolved.push({ hip: -1, pos: null });
        continue;
      }
      const entry = positions.get(token);
      if (!entry) {
        bump(stats.missingHips, token);
        resolved.push({ hip: token, pos: null });
        continue;
      }
      resolved.push({ hip: token, pos: entry.pos });
    }

    // 2) 统计被丢弃的线段：只要有一端是空，这条线段就不存在。
    //    注意不能把空顶点简单删掉接起来 —— 那会凭空拉出一条跨越缺口的假线。
    for (let i = 0; i + 1 < resolved.length; i++) {
      if (resolved[i]!.pos === null || resolved[i + 1]!.pos === null) {
        stats.segmentsBrokenByMissingHip++;
      }
    }

    // 3) 按空顶点切成若干「连续可用的段」，每段单独成为一条折线
    let run: { hip: number; pos: Vec3 }[] = [];
    const flush = (): void => {
      if (run.length === 0) return;
      // 相邻同一个 HIP（零长度线段）只留一个
      const uniq: { hip: number; pos: Vec3 }[] = [];
      for (const item of run) {
        if (uniq.length > 0 && uniq[uniq.length - 1]!.hip === item.hip) {
          stats.duplicateVerticesRemoved++;
          continue;
        }
        uniq.push(item);
      }
      // 首尾同一个 HIP：去掉末尾那个，闭合交给运行时判断
      if (uniq.length >= 2 && uniq[0]!.hip === uniq[uniq.length - 1]!.hip) {
        uniq.pop();
        stats.closedVerticesRemoved++;
      }
      if (uniq.length >= 2) {
        const flat: number[] = [];
        for (const item of uniq) {
          const { x, y, z } = item.pos;
          const dev = Math.abs(Math.hypot(x, y, z) - 1);
          if (dev > stats.maxUnitDeviation) stats.maxUnitDeviation = dev;
          flat.push(x, y, z);
        }
        lines.push(flat);
        stats.polylines++;
        stats.vertices += uniq.length;
        stats.segments += uniq.length - 1;
      } else {
        stats.orphanVertices += uniq.length;
      }
      run = [];
    };

    for (const item of resolved) {
      if (item.pos === null) flush();
      else run.push({ hip: item.hip, pos: item.pos });
    }
    flush();
  }

  stats.sourceFigures++;
  stats.figures++;
  if (figure.nameZh === undefined) stats.figuresWithoutZh++;
  if (lines.length === 0) stats.figuresWithoutLines++;

  return { id: figure.id, name: figure.name, nameZh: figure.nameZh, lines };
}

// ---------------------------------------------------------------------------
// 第五步：序列化
// ---------------------------------------------------------------------------

/**
 * 手写序列化，而不用 `JSON.stringify(obj, null, 2)`。
 *
 * 原因：带缩进的 `JSON.stringify` 会把 `lines` 里每个数字都单独放一行，
 * 一个 3 个顶点的折线就要占 11 行。这里让**每条折线占一行**（数字之间不加空格），
 * 输出既能 diff 又足够紧凑。
 */
function serializeGroup(config: GroupConfig, figures: readonly EmittedFigure[]): string {
  const licenseText = JSON.stringify(LICENSE, null, 2)
    .split('\n')
    .map((l, i) => (i === 0 ? l : `  ${l}`))
    .join('\n');

  const parts: string[] = [];
  parts.push('{');
  parts.push(`  "id": ${JSON.stringify(config.id)},`);
  parts.push(`  "label": ${JSON.stringify(config.label)},`);
  parts.push(`  "license": ${licenseText},`);
  parts.push('  "figures": [');

  const figureTexts = figures.map((fig) => {
    const out: string[] = [];
    out.push('    {');
    out.push(`      "id": ${JSON.stringify(fig.id)},`);
    if (fig.name !== undefined) out.push(`      "name": ${JSON.stringify(fig.name)},`);
    if (fig.nameZh !== undefined) out.push(`      "nameZh": ${JSON.stringify(fig.nameZh)},`);
    out.push('      "lines": [');
    out.push(fig.lines.map((flat) => `        [${flat.join(',')}]`).join(',\n'));
    out.push('      ]');
    out.push('    }');
    return out.join('\n');
  });

  parts.push(figureTexts.join(',\n'));
  parts.push('  ]');
  parts.push('}');
  return `${parts.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const t0 = performance.now();
  process.stdout.write('星座连线预处理开始\n');

  // ---- 读 Stellarium（先读它才知道需要哪些 HIP）----
  const sources = GROUPS.map((config) => {
    const figures = parseSourceGroup(config);
    process.stdout.write(`  读取 ${config.source}：${figures.length} 个星座/星官\n`);
    return { config, figures };
  });

  const fab = parseStarNameFab();
  process.stdout.write(
    `  读取 ${STAR_NAME_FAB}：${fab.names.length.toLocaleString()} 个 HIP 有中文星名` +
      `${fab.aliasCount > 0 ? `（另有 ${fab.aliasCount} 个别名未收录）` : ''}` +
      `${fab.badLines.length > 0 ? `，${fab.badLines.length} 行没解析出来` : ''}\n`,
  );

  // ---- 汇总所有被引用的 HIP ----
  const needed = new Set<number>();
  for (const { figures } of sources) {
    for (const fig of figures) {
      for (const line of fig.lines) {
        for (const token of line) if (isHipToken(token)) needed.add(token);
      }
    }
  }
  for (const item of fab.names) needed.add(item.hip);
  process.stdout.write(`  共引用 ${needed.size.toLocaleString()} 个不同 HIP，开始扫 AT-HYG…\n`);

  const index = await loadHipIndex(needed);
  process.stdout.write(
    `  星表读取完毕：${index.rows.toLocaleString()} 行，用时 ${index.seconds.toFixed(1)}s\n`,
  );

  const missing = [...needed].filter((hip) => !index.map.has(hip));

  // ---- 清洗 + 落盘 ----
  mkdirSync(OUT_DIR, { recursive: true });

  const results: {
    config: GroupConfig;
    figures: EmittedFigure[];
    stats: GroupStats;
    json: string;
    bytes: number;
  }[] = [];

  for (const { config, figures } of sources) {
    const stats = emptyStats();
    const emitted = figures.map((fig) => cleanFigure(fig, index.map, stats));
    const json = serializeGroup(config, emitted);
    const abs = join(OUT_DIR, config.file);
    writeFileSync(abs, json);
    results.push({ config, figures: emitted, stats, json, bytes: Buffer.byteLength(json) });
  }

  // ---- manifest ----
  const manifest = {
    generator: 'scripts/build-constellations.ts',
    generatedAt: new Date().toISOString(),
    groups: results.map((r) => ({
      id: r.config.id,
      label: r.config.label,
      file: r.config.file,
      figureCount: r.stats.figures,
      segmentCount: r.stats.segments,
      bytes: r.bytes,
      license: LICENSE,
    })),
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(OUT_DIR, 'manifest.json'), manifestJson);

  // ---- 中文星名 ----
  const namesObj: Record<string, string> = {};
  let namesSkipped = 0;
  const sortedNames = [...fab.names].sort((a, b) => a.hip - b.hip);
  for (const item of sortedNames) {
    if (!index.map.has(item.hip)) {
      namesSkipped++;
      continue;
    }
    namesObj[String(item.hip)] = item.name;
  }
  const namesJson = JSON.stringify(namesObj);
  let namesBytes = 0;
  if (sortedNames.length > 0) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, STAR_NAME_OUT), `${namesJson}\n`);
    namesBytes = Buffer.byteLength(namesJson) + 1;
  }

  // ---- 统计输出 ----
  const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
  const arcsec = (mas: number): string =>
    `${(mas * MAS_TO_RAD * AT_HYG_EPOCH_DELTA_YEARS * RAD * 3600).toFixed(2)}″`;

  process.stdout.write('\n================ 分组统计 ================\n');
  for (const r of results) {
    const s = r.stats;
    process.stdout.write(`\n${r.config.id}：${r.config.label}\n`);
    process.stdout.write(`  星座/星官数    : ${s.figures.toLocaleString()}\n`);
    process.stdout.write(
      `  折线数         : ${s.polylines.toLocaleString()}（输出 · 源数据 ${s.sourcePolylines.toLocaleString()}）\n`,
    );
    process.stdout.write(
      `  线段数         : ${s.segments.toLocaleString()}（输出 · 源数据 ${s.sourceSegments.toLocaleString()}）\n`,
    );
    process.stdout.write(`  顶点数         : ${s.vertices.toLocaleString()}\n`);
    const expectedSegments = REPORT_SOURCE_SEGMENTS[r.config.id];
    if (expectedSegments !== undefined) {
      const ok = expectedSegments === s.sourceSegments;
      process.stdout.write(
        `  与报告核对     : 源线段 ${s.sourceSegments.toLocaleString()} vs REPORT.md ${expectedSegments.toLocaleString()} ` +
          `${ok ? '✔ 一致' : '⚠️ 不一致'}\n`,
      );
      const diff = s.sourceSegments - s.segments;
      const accounted =
        s.closedVerticesRemoved + s.duplicateVerticesRemoved + s.segmentsBrokenByMissingHip;
      process.stdout.write(
        `    输出比源少   : ${diff.toLocaleString()} = 闭合收尾 ${s.closedVerticesRemoved.toLocaleString()}` +
          ` + 相邻重复 ${s.duplicateVerticesRemoved.toLocaleString()}` +
          ` + 缺端点断开 ${s.segmentsBrokenByMissingHip.toLocaleString()}` +
          ` ${diff === accounted ? '✔' : `⚠️（对不上，另有 ${diff - accounted} 条）`}\n`,
      );
    }
    process.stdout.write(
      `    首尾重复去掉 : ${s.closedVerticesRemoved.toLocaleString()} 个顶点（闭合折线，运行时不重复画收尾点）\n`,
    );
    process.stdout.write(
      `    相邻重复去掉 : ${s.duplicateVerticesRemoved.toLocaleString()} 个顶点（零长度线段）\n`,
    );
    process.stdout.write(
      `    缺 HIP 断开  : ${s.segmentsBrokenByMissingHip.toLocaleString()} 条线段\n`,
    );
    if (s.orphanVertices > 0) {
      process.stdout.write(`    孤立残点丢弃 : ${s.orphanVertices.toLocaleString()} 个\n`);
    }
    if (s.figuresWithoutLines > 0) {
      process.stdout.write(
        `  无几何的条目   : ${s.figuresWithoutLines.toLocaleString()} 个` +
          `（源数据把「单颗星的星官」写成 [HIP, HIP]，去掉重复顶点后无折线可画）\n`,
      );
    }
    process.stdout.write(
      `  缺失 HIP       : ${s.missingHips.size} 个（${[...s.missingHips.keys()].sort((a, b) => a - b).join(', ') || '无'}）` +
        `${s.missingHips.size > 0 ? `，共涉及 ${[...s.missingHips.values()].reduce((a, b) => a + b, 0)} 处引用` : ''}\n`,
    );
    if (s.nonHipTokens.size > 0) {
      const top = topEntries(s.nonHipTokens, 5);
      process.stdout.write(
        `  非 HIP 端点    : ${s.nonHipTokens.size} 种，共 ${[...s.nonHipTokens.values()].reduce((a, b) => a + b, 0)} 处` +
          `（${top.map(([k, n]) => `${k}×${n}`).join('、')}${s.nonHipTokens.size > top.length ? ' …' : ''}）\n`,
      );
    }
    if (s.outOfRangeIntegers.size > 0) {
      process.stdout.write(
        `  越界整数端点   : ${s.outOfRangeIntegers.size} 种（${topEntries(s.outOfRangeIntegers, 3)
          .map(([k, n]) => `${k}×${n}`)
          .join('、')}）\n`,
      );
    }
    process.stdout.write(
      `  单位向量偏差   : ≤ ${s.maxUnitDeviation.toExponential(2)}（归一化自检）\n`,
    );
    process.stdout.write(`  文件           : ${r.config.file}  ${kb(r.bytes)}\n`);
  }

  process.stdout.write('\n================ 核对与汇总 ================\n');
  process.stdout.write(`  星表总行数          : ${index.rows.toLocaleString()}\n`);
  process.stdout.write(`  带 HIP 的行数       : ${index.rowsWithHip.toLocaleString()}\n`);
  process.stdout.write(`  被引用的 HIP        : ${needed.size.toLocaleString()}\n`);
  process.stdout.write(
    `  在 AT-HYG 中命中    : ${(needed.size - missing.length).toLocaleString()} / ${needed.size.toLocaleString()}\n`,
  );
  process.stdout.write(
    `  缺失的 HIP          : ${missing.length} 个 — ${missing.sort((a, b) => a - b).join(', ') || '无'}\n`,
  );
  if (index.duplicates > 0) {
    process.stdout.write(
      `  ⚠️ 重复 HIP 行       : ${index.duplicates}（报告称 HIP 唯一，出现重复要复查）\n`,
    );
  }
  const expectedMissing = KNOWN_MISSING_HIPS.join(', ');
  const actualMissing = missing.join(', ');
  process.stdout.write(
    `  与报告核对          : ${actualMissing === expectedMissing ? `✔ 与报告一致（${expectedMissing}）` : `⚠️ 报告说是 ${expectedMissing}，实际是 ${actualMissing || '无'}`}\n`,
  );
  process.stdout.write(
    `  最大自行 / 8.75 年  : ${arcsec(index.maxPmMas)}（J1991.25 → J2000 的位置改正量，这一步不能省）\n`,
  );
  for (const r of results) {
    if (r.stats.figuresWithoutZh > 0) {
      process.stdout.write(
        `  ⚠️ 缺中文名的条目   : ${r.config.label} ${r.stats.figuresWithoutZh} 个\n`,
      );
    }
  }
  process.stdout.write(
    `  chinese-star-names  : ${Object.keys(namesObj).length.toLocaleString()} 条` +
      `${namesSkipped > 0 ? `（跳过查不到的 ${namesSkipped} 个 HIP）` : ''}，${kb(namesBytes)}\n`,
  );
  process.stdout.write(`  manifest.json       : ${kb(Buffer.byteLength(manifestJson))}\n`);
  process.stdout.write(`  输出目录            : ${relative(ROOT, OUT_DIR)}\n`);
  if (namesBytes > 0) {
    process.stdout.write(
      `                        ${relative(ROOT, join(OUT_DIR, STAR_NAME_OUT))}\n`,
    );
  }
  process.stdout.write(
    `  总用时              : ${((performance.now() - t0) / 1000).toFixed(1)}s\n`,
  );
  process.stdout.write(
    '  许可证              : CC BY-SA 4.0（Stellarium skyculture + AT-HYG 星表）\n',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `预处理失败：${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exitCode = 1;
});
