/**
 * 恒星颜色：色指数 B-V → 色温 → 线性 sRGB。
 *
 * 链路：
 * 1. **B-V → 有效温度**：Ballesteros (2012) 的双黑体近似公式，
 *    `T = 4600·(1/(0.92·BV+1.7) + 1/(0.92·BV+0.62))`，在 3000–20000 K 内误差约 1–2%。
 * 2. **温度 → CIE 1931 色度**：Kim et al. (2002) 对普朗克轨迹的三次多项式拟合。
 * 3. **xy → XYZ → 线性 sRGB**：标准 sRGB 矩阵。
 * 4. 归一化到最大分量为 1，**只保留色度**；亮度由视星等单独控制。
 *
 * 颜色在预处理阶段算好并量化成 uint8 存进二进制块，
 * 这样 GPU 顶点着色器不用为每颗星做 pow/log（250 万颗星的顶点着色器很敏感）。
 */

import { clamp } from './vec3';

/** 缺省色指数（取太阳的值），用于星表里 B-V 缺失的恒星 */
export const DEFAULT_BV = 0.65;

/**
 * B-V 色指数 → 有效温度（K）。
 * Ballesteros 2012, EPL 97, 34008。
 */
export function bvToTeff(bv: number): number {
  const x = 0.92 * bv;
  const denomA = x + 1.7;
  const denomB = x + 0.62;
  // denomB 在 bv < -0.674 时变号，属于物理上不存在的输入，做保护
  if (denomB <= 1e-3) return 42000;
  const t = 4600 * (1 / denomA + 1 / denomB);
  return clamp(t, 1200, 42000);
}

/** 有效温度 → CIE 1931 (x, y) 色度，普朗克轨迹近似（Kim et al. 2002） */
export function teffToChromaticity(teff: number): { x: number; y: number } {
  const t = clamp(teff, 1667, 25000);

  let x: number;
  if (t <= 4000) {
    x = -0.2661239e9 / (t * t * t) - 0.2343589e6 / (t * t) + 0.8776956e3 / t + 0.17991;
  } else {
    x = -3.0258469e9 / (t * t * t) + 2.1070379e6 / (t * t) + 0.2226347e3 / t + 0.24039;
  }

  let y: number;
  if (t <= 2222) {
    y = -1.1063814 * x * x * x - 1.3481102 * x * x + 2.18555832 * x - 0.20219683;
  } else if (t <= 4000) {
    y = -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867;
  } else {
    y = 3.081758 * x * x * x - 5.8733867 * x * x + 3.75112997 * x - 0.37001483;
  }

  return { x, y };
}

/** CIE xy（Y 归一为 1）→ 线性 sRGB，可能含负值，调用方需截断 */
export function chromaticityToLinearRgb(c: { x: number; y: number }): {
  r: number;
  g: number;
  b: number;
} {
  const yy = Math.max(c.y, 1e-6);
  const bigX = c.x / yy;
  const bigY = 1;
  const bigZ = (1 - c.x - c.y) / yy;

  return {
    r: 3.2404542 * bigX - 1.5371385 * bigY - 0.4985314 * bigZ,
    g: -0.969266 * bigX + 1.8760108 * bigY + 0.041556 * bigZ,
    b: 0.0556434 * bigX - 0.2040259 * bigY + 1.0572252 * bigZ,
  };
}

export interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

/**
 * B-V → 线性 sRGB（最大分量为 1）。
 *
 * @param bv         色指数
 * @param saturation 饱和度，1 = 纯黑体色；<1 向白色靠拢，观感更接近人眼
 */
export function bvToLinearRgb(bv: number, saturation = 0.85): LinearRgb {
  const teff = bvToTeff(bv);
  const rgb = chromaticityToLinearRgb(teffToChromaticity(teff));

  let r = Math.max(0, rgb.r);
  let g = Math.max(0, rgb.g);
  let b = Math.max(0, rgb.b);

  const max = Math.max(r, g, b);
  if (max <= 0) return { r: 1, g: 1, b: 1 };
  r /= max;
  g /= max;
  b /= max;

  const s = clamp(saturation, 0, 1);
  return {
    r: 1 - (1 - r) * s,
    g: 1 - (1 - g) * s,
    b: 1 - (1 - b) * s,
  };
}

/** B-V → 打包成 uint8 的线性 RGB，供二进制块直接写入 */
export function bvToLinearRgbBytes(bv: number, saturation = 0.85): [number, number, number] {
  const { r, g, b } = bvToLinearRgb(bv, saturation);
  return [
    Math.round(clamp(r, 0, 1) * 255),
    Math.round(clamp(g, 0, 1) * 255),
    Math.round(clamp(b, 0, 1) * 255),
  ];
}

/** 色温 → 十六进制颜色（给 UI / 信息卡用，含 sRGB 伽马编码） */
export function bvToHex(bv: number): number {
  const { r, g, b } = bvToLinearRgb(bv, 0.85);
  const enc = (v: number): number => {
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(clamp(s, 0, 1) * 255);
  };
  return (enc(r) << 16) | (enc(g) << 8) | enc(b);
}

/** 色温 → 近似光谱型字母（星表没有 spect 字段时的兜底显示） */
export function teffToSpectralClass(teff: number): string {
  if (teff >= 30000) return 'O';
  if (teff >= 10000) return 'B';
  if (teff >= 7500) return 'A';
  if (teff >= 6000) return 'F';
  if (teff >= 5200) return 'G';
  if (teff >= 3700) return 'K';
  return 'M';
}
