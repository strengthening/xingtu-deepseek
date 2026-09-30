/**
 * HEALPix（Hierarchical Equal Area isoLatitude Pixelisation）实现。
 *
 * 采用 **NESTED** 排序 —— 这是 HiPS（Hierarchical Progressive Survey）标准使用的排序，
 * 也是 IVOA 推荐的瓦片索引方式。12 个基础像素（base pixel）各自是一棵四叉树，
 * 像素索引 = `bighp · nside² + 交错位(x, y)`。
 *
 * 本文件是 astrometry.net `healpix.c`（BSD-3-Clause，亦被 astropy-healpix 采用）
 * 的逐行移植，并用编译出的 C 参考实现生成测试向量做了逐像素比对
 * （见 `healpix.test.ts`）。坐标系约定与全文一致：
 * **θ 为极角（自北天极起，0..π），φ 为方位角（0..2π）**。
 *
 * 与 C 版的差别只有一处：C 版内部用 `hp_t {bighp, x, y}` 结构，这里直接返回三元组，
 * 计算顺序、边界处理、取整方式完全一致。
 */

const TWO_THIRDS = 2 / 3;
const FOUR_THIRDS = 4 / 3;
const HALF_PI = Math.PI / 2;
const ROOT3 = Math.sqrt(3);

/** nside 对应的全天像素总数 */
export function nsideToNpix(nside: number): number {
  return 12 * nside * nside;
}

/** 判断是否 2 的幂（NESTED 排序要求） */
export function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

/** nside → 层级（nside = 2^level） */
export function nsideToLevel(nside: number): number {
  return Math.round(Math.log2(nside));
}

/** 层级 → nside */
export function levelToNside(level: number): number {
  return 2 ** level;
}

interface FacePixel {
  bighp: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/**
 * 单位向量 → 基础像素号 + 面内整数坐标 (x, y) + 面内小数偏移。
 * 对应 C 的 `xyztohp()`。
 */
function vectorToFacePixel(
  vx: number,
  vy: number,
  vz: number,
  nside: number,
): FacePixel {
  let phi = Math.atan2(vy, vx);
  if (phi < 0) phi += 2 * Math.PI;
  const phiT = phi % HALF_PI;

  let basehp: number;
  let x: number;
  let y: number;
  let dx: number;
  let dy: number;

  const sector = (phi - phiT) / HALF_PI;
  let offset = Math.round(sector);
  offset = ((offset % 4) + 4) % 4;

  if (vz >= TWO_THIRDS || vz <= -TWO_THIRDS) {
    // ---- 极区 ----
    const north = vz >= TWO_THIRDS;
    const absZ = north ? vz : -vz;
    // C 版此处 coz 由调用方传 0，随后用 hypot(vx, vy) 现算
    const coz = Math.hypot(vx, vy);

    const kx = (coz / Math.sqrt(1 + absZ)) * ROOT3 * Math.abs((nside * (2 * phiT - Math.PI)) / Math.PI);
    const ky = (coz / Math.sqrt(1 + absZ)) * ROOT3 * ((nside * 2 * phiT) / Math.PI);

    let xx: number;
    let yy: number;
    if (north) {
      xx = nside - kx;
      yy = nside - ky;
    } else {
      xx = ky;
      yy = kx;
    }

    dx = xx - Math.floor(xx);
    dy = yy - Math.floor(yy);
    x = clampIndex(Math.floor(xx), nside);
    y = clampIndex(Math.floor(yy), nside);

    basehp = north ? offset : 8 + offset;
  } else {
    // ---- 赤道区 ----
    const zunits = (vz + TWO_THIRDS) / FOUR_THIRDS;
    const phiunits = phiT / HALF_PI;
    const u1 = zunits + phiunits;
    const u2 = zunits - phiunits + 1;

    let xx = u1 * nside;
    let yy = u2 * nside;

    if (xx >= nside) {
      xx -= nside;
      if (yy >= nside) {
        yy -= nside;
        basehp = offset; // 北极区
      } else {
        basehp = ((offset + 1) % 4) + 4; // 右侧赤道区
      }
    } else {
      if (yy >= nside) {
        yy -= nside;
        basehp = offset + 4; // 左侧赤道区
      } else {
        basehp = 8 + offset; // 南极区
      }
    }

    dx = xx - Math.floor(xx);
    dy = yy - Math.floor(yy);
    x = clampIndex(Math.floor(xx), nside);
    y = clampIndex(Math.floor(yy), nside);
  }

  return { bighp: basehp, x, y, dx, dy };
}

function clampIndex(v: number, nside: number): number {
  return v < 0 ? 0 : v > nside - 1 ? nside - 1 : v;
}

/**
 * 基础像素号 + 面内坐标 → 单位向量。
 * 对应 C 的 `hp_to_xyz()`。
 */
function facePixelToVector(p: FacePixel, nside: number): { x: number; y: number; z: number } {
  let chp = p.bighp;
  const xn = p.x + p.dx;
  const yn = p.y + p.dy;

  let equatorial = true;
  let zfactor = 1;

  const isNorthPolar = chp <= 3;
  const isSouthPolar = chp >= 8;

  if (isNorthPolar && xn + yn > nside) {
    equatorial = false;
    zfactor = 1;
  }
  if (isSouthPolar && xn + yn < nside) {
    equatorial = false;
    zfactor = -1;
  }

  let phi: number;
  let z: number;
  let rad: number;

  if (equatorial) {
    const x = xn / nside;
    const y = yn / nside;
    let zoff = 0;
    let phioff = 0;

    if (chp <= 3) {
      phioff = 1;
    } else if (chp <= 7) {
      zoff = -1;
      chp -= 4;
    } else {
      phioff = 1;
      zoff = -2;
      chp -= 8;
    }

    z = TWO_THIRDS * (x + y + zoff);
    phi = (Math.PI / 4) * (x - y + phioff + 2 * chp);
    rad = Math.sqrt(Math.max(0, 1 - z * z));
  } else {
    let x = xn;
    let y = yn;

    if (zfactor === -1) {
      const t = x;
      x = y;
      y = t;
      x = nside - x;
      y = nside - y;
    }

    let phiT: number;
    if (y === nside && x === nside) phiT = 0;
    else phiT = (Math.PI * (nside - y)) / (2 * (nside - x + (nside - y)));

    let vv: number;
    if (phiT < Math.PI / 4) {
      vv = Math.abs((Math.PI * (nside - x)) / ((2 * phiT - Math.PI) * nside) / ROOT3);
    } else {
      vv = Math.abs((Math.PI * (nside - y)) / (2 * phiT * nside) / ROOT3);
    }

    z = (1 - vv) * (1 + vv);
    rad = Math.sqrt(Math.max(0, 1 + z)) * vv;
    z *= zfactor;

    phi = isSouthPolar ? (Math.PI / 2) * (chp - 8) + phiT : (Math.PI / 2) * chp + phiT;
  }

  if (phi < 0) phi += 2 * Math.PI;

  return { x: rad * Math.cos(phi), y: rad * Math.sin(phi), z };
}

/** 面内 (x, y) → NESTED 面内索引（位交错） */
function xyToNestedIndex(x: number, y: number): number {
  let index = 0;
  let xx = x;
  let yy = y;
  for (let i = 0; i < 16; i++) {
    index += (((yy & 1) << 1) | (xx & 1)) * 2 ** (i * 2);
    yy = Math.floor(yy / 2);
    xx = Math.floor(xx / 2);
    if (xx === 0 && yy === 0) break;
  }
  return index;
}

/** NESTED 面内索引 → 面内 (x, y) */
function nestedIndexToXy(index: number): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let rest = index;
  for (let i = 0; i < 16; i++) {
    x += (rest & 1) * 2 ** i;
    rest = Math.floor(rest / 2);
    y += (rest & 1) * 2 ** i;
    rest = Math.floor(rest / 2);
    if (rest === 0) break;
  }
  return { x, y };
}

/** 单位向量 → NESTED 像素号 */
export function vectorToNestedPixel(vx: number, vy: number, vz: number, nside: number): number {
  const fp = vectorToFacePixel(vx, vy, vz, nside);
  return fp.bighp * nside * nside + xyToNestedIndex(fp.x, fp.y);
}

/** 单位向量 + 面内小数偏移 → NESTED 像素号与偏移（供双线性插值使用） */
export function vectorToNestedPixelOffset(
  vx: number,
  vy: number,
  vz: number,
  nside: number,
): { pix: number; dx: number; dy: number } {
  const fp = vectorToFacePixel(vx, vy, vz, nside);
  return { pix: fp.bighp * nside * nside + xyToNestedIndex(fp.x, fp.y), dx: fp.dx, dy: fp.dy };
}

/** NESTED 像素号 → 单位向量（像素中心：dx = dy = 0.5） */
export function nestedPixelToVector(
  ipix: number,
  nside: number,
): { x: number; y: number; z: number } {
  const ns2 = nside * nside;
  const bighp = Math.floor(ipix / ns2);
  const index = ipix - bighp * ns2;
  const { x, y } = nestedIndexToXy(index);
  return facePixelToVector({ bighp, x, y, dx: 0.5, dy: 0.5 }, nside);
}

/** NESTED 像素号 → (θ, φ) */
export function pix2angNest(nside: number, ipix: number): { theta: number; phi: number } {
  const v = nestedPixelToVector(ipix, nside);
  const theta = Math.acos(Math.max(-1, Math.min(1, v.z)));
  let phi = Math.atan2(v.y, v.x);
  if (phi < 0) phi += 2 * Math.PI;
  return { theta, phi };
}

/** (θ, φ) → NESTED 像素号 */
export function ang2pixNest(nside: number, theta: number, phi: number): number {
  const st = Math.sin(theta);
  return vectorToNestedPixel(st * Math.cos(phi), st * Math.sin(phi), Math.cos(theta), nside);
}

/** NESTED 像素号 → 赤经/赤纬（度）。θ 自北天极起，故 dec = 90° − θ。 */
export function pix2radecDeg(nside: number, ipix: number): { raDeg: number; decDeg: number } {
  const { theta, phi } = pix2angNest(nside, ipix);
  return {
    raDeg: ((phi * 180) / Math.PI + 360) % 360,
    decDeg: 90 - (theta * 180) / Math.PI,
  };
}

/** 赤经/赤纬（度）→ NESTED 像素号 */
export function radecDegToPix(nside: number, raDeg: number, decDeg: number): number {
  const ra = (raDeg * Math.PI) / 180;
  const theta = ((90 - decDeg) * Math.PI) / 180;
  return ang2pixNest(nside, theta, ra);
}

/** 像素中心之间的角距离（度），用于粗筛 */
export function pixelSeparationDeg(nside: number, a: number, b: number): number {
  const va = nestedPixelToVector(a, nside);
  const vb = nestedPixelToVector(b, nside);
  const dot = va.x * vb.x + va.y * vb.y + va.z * vb.z;
  return (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
}

/**
 * 一个像素在外接圆上的近似角半径（弧度）。
 * 面积 = 4π/(12·nside²)，等效圆的角半径 ≈ sqrt(面积/π)；
 * 像素是正方形的外接圆，再乘 √2 作为半径。
 */
export function pixelRadiusRad(nside: number): number {
  const area = (4 * Math.PI) / (12 * nside * nside);
  return Math.sqrt(area / Math.PI) * Math.SQRT2;
}

let cachedNside = -1;
let cachedCenters: Float64Array = new Float64Array(0);

function pixelCenters(nside: number): Float64Array {
  if (cachedNside === nside) return cachedCenters;
  const npix = nsideToNpix(nside);
  const out = new Float64Array(npix * 3);
  for (let i = 0; i < npix; i++) {
    const v = nestedPixelToVector(i, nside);
    out[i * 3] = v.x;
    out[i * 3 + 1] = v.y;
    out[i * 3 + 2] = v.z;
  }
  cachedNside = nside;
  cachedCenters = out;
  return out;
}

/**
 * 查询与给定圆盘相交的 NESTED 像素。
 *
 * 判定方式是「像素中心到圆盘中心 ≤ 圆盘半径 + 像素外接圆半径」。
 * 对 LOD 选块来说这个近似足够：个别边界多载入一两个块没有代价。
 * 由于本项目的瓦片 nside ≤ 16（最多 3072 个像素），暴力扫描完全够快，
 * 中心向量还有缓存，不需要走四叉树剪枝。
 */
export function queryDiscNest(
  nside: number,
  thetaCenter: number,
  phiCenter: number,
  radiusRad: number,
): number[] {
  const centers = pixelCenters(nside);
  const npix = nsideToNpix(nside);
  const st = Math.sin(thetaCenter);
  const cx = st * Math.cos(phiCenter);
  const cy = st * Math.sin(phiCenter);
  const cz = Math.cos(thetaCenter);

  const limit = Math.cos(Math.min(Math.PI, radiusRad + pixelRadiusRad(nside)));
  const out: number[] = [];
  for (let i = 0; i < npix; i++) {
    const d = centers[i * 3]! * cx + centers[i * 3 + 1]! * cy + centers[i * 3 + 2]! * cz;
    if (d >= limit) out.push(i);
  }
  return out;
}

/** 把粗层级的 NESTED 像素映射到细层级的子像素范围 */
export function childrenOfNest(nside: number, ipix: number, childNside: number): number[] {
  const ratio = childNside / nside;
  if (!Number.isInteger(ratio) || ratio < 1) {
    throw new Error(`childrenOfNest: childNside/nside 必须是正整数，收到 ${ratio}`);
  }
  const k = Math.round(Math.log2(ratio));
  const first = ipix * 4 ** k;
  const count = 4 ** k;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(first + i);
  return out;
}

/** 细层级 NESTED 像素的父像素 */
export function parentOfNest(ipix: number, levelDelta: number): number {
  return Math.floor(ipix / 4 ** levelDelta);
}
