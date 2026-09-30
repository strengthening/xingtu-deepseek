/**
 * 银河背景预处理脚本。
 *
 * 运行：`pnpm run data:hips`
 * 输出：`public/data/milkyway/`
 *
 * ## 做法
 *
 * 数据源是 CDS 的 HiPS（Hierarchical Progressive Survey）survey
 * **`CDS/P/Mellinger/color`** —— Axel Mellinger 的 648 兆像素全天彩色银河全景。
 *
 * 我们没有在运行时实现 HiPS 瓦片金字塔客户端，而是在**构建期**用 CDS 官方的
 * `hips2fits` 服务把它重投影成一张**赤道系等距圆柱（CAR）全天贴图**：
 *
 * ```
 * GET /hips-image-services/hips2fits
 *     ?hips=CDS/P/Mellinger/color
 *     &width=4096&height=2048
 *     &fov=360                 # 全天
 *     &projection=CAR          # 等距圆柱 = 等经纬
 *     &coordsys=icrs           # 输出用赤道系，运行时省掉一次银道→赤道旋转
 *     &ra=0&dec=0              # 投影中心
 *     &format=jpg
 * ```
 *
 * 返回的 JPEG 在注释段里带 WCS，脚本会解析出来并写进 `meta.json`，
 * 运行时的着色器按同一套映射采样（见 `src/render/shaders/background.ts`）。
 * 这样即使 CDS 以后改了默认参数，只要 WCS 解析正确，贴图依然对得上。
 *
 * ## 坐标映射（由 WCS 推出，实测校验过银心位置）
 *
 * 对 4096×2048、`CRVAL=(0,0)`、`CRPIX=(2048,1024)`、`CDELT1=-0.0879`、`CDELT2=+0.0879`：
 * - 图像第 0 行是**南天极**（FITS 的 `CDELT2 > 0` 表示赤纬向下增大）
 * - 赤经向**左**增大（`CDELT1 < 0`）
 *
 * ```
 * u = 0.5 - ra / 360        (ra ∈ [-180, 180))
 * v = (dec + 90) / 180      (v = 0 在图像顶部 = 南天极)
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = join(ROOT, 'public', 'data', 'milkyway');

const HIPS_ID = 'CDS/P/Mellinger/color';
const WIDTH = 4096;
const HEIGHT = 2048;
const SERVICE = 'https://alasky.cds.unistra.fr/hips-image-services/hips2fits';

const FILENAME = `mellinger-equirect-${WIDTH}x${HEIGHT}.jpg`;

interface WcsKeys {
  crpix1: number;
  crpix2: number;
  crval1: number;
  crval2: number;
  cdelt1: number;
  cdelt2: number;
  ctype1: string;
  ctype2: string;
  lonpole: number;
}

/** 从 JPEG 注释段里把 WCS 关键字抠出来 */
export function parseJpegWcs(comment: string): WcsKeys {
  const get = (key: string): string | null => {
    const m = new RegExp(`${key}\\s*=\\s*([^/\\s]+)`).exec(comment);
    return m?.[1] ?? null;
  };
  const num = (key: string): number => {
    const raw = get(key);
    if (raw === null) throw new Error(`WCS 里缺少 ${key}`);
    const v = Number(raw.replace(/'/g, ''));
    if (!Number.isFinite(v)) throw new Error(`WCS 的 ${key} 不是数字：${raw}`);
    return v;
  };
  return {
    crpix1: num('CRPIX1'),
    crpix2: num('CRPIX2'),
    crval1: num('CRVAL1'),
    crval2: num('CRVAL2'),
    cdelt1: num('CDELT1'),
    cdelt2: num('CDELT2'),
    ctype1: (get('CTYPE1') ?? '').replace(/'/g, ''),
    ctype2: (get('CTYPE2') ?? '').replace(/'/g, ''),
    lonpole: num('LONPOLE'),
  };
}

/** 从 JPEG 字节流里提取 COM（0xFFFE）段 */
export function extractJpegComment(buf: Uint8Array): string | null {
  let i = 2; // 跳过 SOI
  while (i < buf.length - 3) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (buf[i + 2]! << 8) | buf[i + 3]!;
    if (marker === 0xfe) {
      const start = i + 4;
      const end = Math.min(i + 2 + len, buf.length);
      let text = '';
      for (let k = start; k < end; k++) text += String.fromCharCode(buf[k]!);
      return text;
    }
    if (marker === 0xda) break; // 进入压缩数据，后面不会再有 COM
    i += 2 + len;
  }
  return null;
}

function buildUrl(): string {
  const params = new URLSearchParams({
    hips: HIPS_ID,
    width: String(WIDTH),
    height: String(HEIGHT),
    fov: '360',
    projection: 'CAR',
    coordsys: 'icrs',
    ra: '0',
    dec: '0',
    format: 'jpg',
  });
  return `${SERVICE}?${params.toString()}`;
}

async function fetchWithRetry(url: string, attempts = 5): Promise<Uint8Array> {
  let lastError: unknown = null;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength < 10_000) {
        throw new Error(`返回内容只有 ${buf.byteLength} 字节，疑似出错`);
      }
      return buf;
    } catch (err) {
      lastError = err;
      process.stdout.write(`  第 ${i} 次尝试失败：${err instanceof Error ? err.message : String(err)}\n`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw lastError;
}

async function main(): Promise<void> {
  process.stdout.write('银河背景预处理开始\n');
  process.stdout.write(`  HiPS survey : ${HIPS_ID}\n`);
  process.stdout.write(`  输出尺寸    : ${WIDTH} × ${HEIGHT}（全天等距圆柱）\n`);

  const url = buildUrl();
  process.stdout.write(`  请求        : ${url}\n`);

  const buf = await fetchWithRetry(url);
  const comment = extractJpegComment(buf);
  if (!comment) throw new Error('返回的 JPEG 里没有 WCS 注释段，无法确定坐标映射');

  const wcs = parseJpegWcs(comment);
  if (!wcs.ctype1.startsWith('RA') && !wcs.ctype1.startsWith('GLON')) {
    throw new Error(`CTYPE1 = ${wcs.ctype1}，不是预期的 RA/GLON-CAR`);
  }
  if (!wcs.ctype1.endsWith('CAR') || !wcs.ctype2.endsWith('CAR')) {
    throw new Error(`CTYPE = ${wcs.ctype1}/${wcs.ctype2}，不是 CAR（等距圆柱）投影`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const abs = join(OUT_DIR, FILENAME);
  writeFileSync(abs, buf);

  // 由 WCS 推出运行时用的贴图映射
  const isEquatorial = wcs.ctype1.startsWith('RA');
  const meta = {
    generator: 'scripts/build-hips.ts',
    generatedAt: new Date().toISOString(),
    hips: {
      id: HIPS_ID,
      service: SERVICE,
      frame: isEquatorial ? 'icrs' : 'galactic',
      projection: 'CAR',
      note: '构建期通过 CDS hips2fits 重投影，运行时不依赖 HiPS 瓦片服务',
    },
    image: {
      file: FILENAME,
      width: WIDTH,
      height: HEIGHT,
      bytes: buf.byteLength,
    },
    /** 运行时着色器按这组系数把方向映射到 UV */
    mapping: {
      /**
       * u = uOffset + uSign · lon / 360
       * v = (lat + 90) / 180
       *
       * 其中 lon 是赤经或银经（度）；由 WCS 的 CDELT 符号决定 uSign。
       */
      uOffset: isEquatorial ? 0.5 : 0,
      uSign: wcs.cdelt1 < 0 ? -1 : 1,
      vFlipped: wcs.cdelt2 > 0,
      lonAtU0: wcs.crval1,
      latAtV0: wcs.crval2,
    },
    wcs,
    license: {
      copyright: 'Copyright 2000-2017 Axel Mellinger. All rights reserved.',
      url: 'http://www.milkywaysky.com/',
      credit: 'Axel Mellinger, 2009 PASP 121, 1180',
      upstream: 'CDS HiPS CDS/P/Mellinger/color (https://alasky.cds.unistra.fr/MellingerRGB/)',
      note: '仅供非商业的教育 / 演示用途，使用时必须保留署名。与代码的 MIT 许可证不同。',
    },
  };
  writeFileSync(join(OUT_DIR, 'meta.json'), JSON.stringify(meta, null, 2));

  const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(2)} MB`;
  process.stdout.write('\n================ 汇总 ================\n');
  process.stdout.write(`  贴图文件  : ${relative(ROOT, abs)}\n`);
  process.stdout.write(`  大小      : ${mb(buf.byteLength)}\n`);
  process.stdout.write(`  WCS       : CTYPE = ${wcs.ctype1} / ${wcs.ctype2}\n`);
  process.stdout.write(`              CRPIX = (${wcs.crpix1}, ${wcs.crpix2})  CRVAL = (${wcs.crval1}, ${wcs.crval2})\n`);
  process.stdout.write(`              CDELT = (${wcs.cdelt1}, ${wcs.cdelt2})  LONPOLE = ${wcs.lonpole}\n`);
  process.stdout.write(`  UV 映射   : u = ${meta.mapping.uOffset} ${meta.mapping.uSign < 0 ? '-' : '+'} lon/360, v = (lat+90)/180\n`);
  process.stdout.write(`  版权      : ${meta.license.copyright}\n`);
  process.stdout.write(`  ⚠️  该贴图非 MIT，仅限非商业用途，详见 README\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`预处理失败：${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exitCode = 1;
});
