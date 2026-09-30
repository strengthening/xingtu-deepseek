/**
 * 大气模型：消光 + 天光（暮光与月光）。
 *
 * ## 消光
 * 用 Kasten & Young (1989) 的空气质量公式（在地平附近比 sec z 准确得多）：
 * ```
 * X(z) = 1 / (cos z + 0.50572·(96.07995 − z[°])^(−1.6364))
 * ```
 * 消光造成的星等变暗为 `Δm = k·X`，通量衰减因子 `10^(−0.4·Δm)`。
 * 海平面 V 波段典型 `k₀ ≈ 0.20 mag/airmass`，海拔越高越小。
 *
 * ## 天光
 * 分三部分相加（在线性通量域相加，最后转回 mag/arcsec²）：
 * - **暗夜天光**：约 21.9 mag/arcsec²（无月、无暮光的暗站）
 * - **暮光**：由太阳高度角经验插值（0° ≈ 8，−6° ≈ 13，−12° ≈ 17.5，−18° ≈ 21）
 * - **月光**：角分布沿用 Krisciunas & Schaefer (1991) 的散射函数形式，
 *   归一化常数按「满月在天顶、目标距月 90° 时约 18.0 mag/arcsec²」标定。
 *   该模型不是 K&S 的原始标定（原始公式的单位换算在文献中常被误引），
 *   这里的数值经过与常见观测值对齐，用于视觉呈现。
 *
 * 所有效果都乘以「大气浓度」`density ∈ [0,1]`：0 表示完全无大气（太空视角），
 * 1 表示完整的大气效果。默认取一个偏小的值，避免天光把星星淹没。
 */

import { clamp } from './vec3';

/** 海平面 V 波段天顶消光系数（mag/airmass） */
export const ZENITH_EXTINCTION_SEA_LEVEL = 0.2;

/** 暗夜天光亮度（mag/arcsec²） */
export const DARK_SKY_BRIGHTNESS = 21.9;

/** 默认大气浓度。偏小一些，保证星空清晰可辨。 */
export const DEFAULT_ATMOSPHERE_DENSITY = 0.35;

/** 标尺高度（米），用于按海拔衰减消光系数 */
const SCALE_HEIGHT_M = 8000;

/**
 * 空气质量（airmass），Kasten & Young (1989)。
 *
 * @param altitudeDeg 高度角（度）。地平线以下返回一个很大的值。
 */
export function airmass(altitudeDeg: number): number {
  if (altitudeDeg >= 90) return 1;
  if (altitudeDeg <= -5) return 40;
  const z = 90 - altitudeDeg;
  const cosZ = Math.cos(z * (Math.PI / 180));
  const denom = cosZ + 0.50572 * Math.pow(96.07995 - z, -1.6364);
  return denom <= 0 ? 40 : 1 / denom;
}

/**
 * 由海拔修正后的天顶消光系数。
 * 大气标高约 8 km，海拔 h 处的气压约为海平面的 exp(-h/8000)。
 */
export function extinctionCoefficient(heightM: number): number {
  return ZENITH_EXTINCTION_SEA_LEVEL * Math.exp(-Math.max(0, heightM) / SCALE_HEIGHT_M);
}

/** 消光造成的星等变暗量 Δm */
export function extinctionMagnitudes(altitudeDeg: number, heightM: number): number {
  return extinctionCoefficient(heightM) * airmass(altitudeDeg);
}

/** 大气透过率（0..1） */
export function transmission(altitudeDeg: number, heightM: number): number {
  const dm = extinctionMagnitudes(altitudeDeg, heightM);
  return Math.pow(10, -0.4 * dm);
}

// ---------------------------------------------------------------------------
// 天光
// ---------------------------------------------------------------------------

/**
 * Krisciunas & Schaefer (1991) 的月光散射角分布 f(ρ)。
 * ρ 为观测目标与月亮的角距离（度）。仅取形状，绝对标定见下方 `moonSkyBrightness`。
 */
export function moonScatteringFunction(rhoDeg: number): number {
  const rho = clamp(rhoDeg, 0.25, 180);
  const rhoRad = rho * (Math.PI / 180);
  const cosRho = Math.cos(rhoRad);
  return 1e5 * (1.06 + cosRho * cosRho) + Math.pow(10, 6.15 - rho / 40);
}

/** 暮光天光亮度（mag/arcsec²），由太阳高度角插值 */
export function twilightSkyBrightness(sunAltitudeDeg: number): number {
  const a = sunAltitudeDeg;
  if (a >= 0) {
    // 白天：极亮，压到显示范围之外
    return clamp(6.0 - a * 0.35, -6, 6.0);
  }
  if (a >= -6) return 6.0 + (-a / 6) * 7.0; // 6 → 13
  if (a >= -12) return 13.0 + ((-a - 6) / 6) * 4.5; // 13 → 17.5
  if (a >= -18) return 17.5 + ((-a - 12) / 6) * 3.5; // 17.5 → 21.0
  return 21.0 + clamp((-a - 18) / 10, 0, 1) * 0.9; // → 21.9
}

export interface SkyBrightnessInput {
  /** 观测方向的高度角（度） */
  targetAltitudeDeg: number;
  /** 太阳高度角（度） */
  sunAltitudeDeg: number;
  /** 月亮高度角（度） */
  moonAltitudeDeg: number;
  /** 月亮被照亮比例 0..1 */
  moonIllumination: number;
  /** 观测方向与月亮的角距离（度） */
  moonSeparationDeg: number;
  /** 观测者海拔（米） */
  heightM: number;
  /** 大气浓度 0..1 */
  density: number;
}

/** 月光造成的天光亮度（mag/arcsec²）。返回 `Infinity` 表示月光可忽略。 */
export function moonSkyBrightness(input: SkyBrightnessInput): number {
  const { moonAltitudeDeg, moonIllumination, moonSeparationDeg, heightM, density } = input;
  if (density <= 0) return Infinity;
  if (moonAltitudeDeg < -4) return Infinity;
  if (moonIllumination < 0.004) return Infinity;

  const k = extinctionCoefficient(heightM);

  // 相位：满月 = 1；用 1.6 次幂让娥眉月迅速变暗
  const phase = Math.pow(clamp(moonIllumination, 0, 1), 1.6);

  // 角分布，归一到 ρ = 90°
  const scatter = moonScatteringFunction(moonSeparationDeg) / moonScatteringFunction(90);

  // 月光穿过大气到达观测者的透过率：月亮越低，注入天光越少
  const moonTrans = Math.pow(10, -0.4 * k * airmass(Math.max(moonAltitudeDeg, 0)));

  // 视线方向上的散射体总量：越靠近地平，路径越长，天光越亮
  const targetFactor = Math.pow(airmass(clamp(input.targetAltitudeDeg, -3, 90)), 0.6);

  // 参考标定：满月在天顶、目标距月 90°、目标在天顶 → 约 18.0 mag/arcsec²
  return 18.0 - 2.5 * Math.log10(phase * scatter * moonTrans * targetFactor);
}

/** 太阳系天体本身在大气中的消光（用于月亮/行星亮度） */
export function bodyExtinctionFactor(
  altitudeDeg: number,
  heightM: number,
  density: number,
): number {
  if (density <= 0) return 1;
  const dm = extinctionMagnitudes(altitudeDeg, heightM) * density;
  return Math.pow(10, -0.4 * dm);
}

/** mag/arcsec² → 线性相对亮度（以暗夜天光为 1） */
export function brightnessToRelativeFlux(brightnessMagArcsec2: number): number {
  if (!Number.isFinite(brightnessMagArcsec2)) return 0;
  return Math.pow(10, -0.4 * (brightnessMagArcsec2 - DARK_SKY_BRIGHTNESS));
}

export interface SkyGlow {
  /** 合成的天光亮度（mag/arcsec²） */
  brightnessMagArcsec2: number;
  /** 相对暗夜天光的线性亮度（1 = 暗夜） */
  relativeFlux: number;
  /** 月光贡献占比 0..1，用于调整色调 */
  moonFraction: number;
  /** 暮光贡献占比 0..1 */
  twilightFraction: number;
}

/**
 * 合成天光：暗夜 + 暮光 + 月光，在线性通量域相加。
 */
export function computeSkyGlow(input: SkyBrightnessInput): SkyGlow {
  const density = clamp(input.density, 0, 1);
  if (density <= 0) {
    return {
      brightnessMagArcsec2: Infinity,
      relativeFlux: 0,
      moonFraction: 0,
      twilightFraction: 0,
    };
  }

  const darkFlux = brightnessToRelativeFlux(DARK_SKY_BRIGHTNESS);
  const twilightMag = twilightSkyBrightness(input.sunAltitudeDeg);
  const twilightFlux = brightnessToRelativeFlux(twilightMag) * density;

  const moonMag = moonSkyBrightness(input);
  const moonFlux = Number.isFinite(moonMag) ? brightnessToRelativeFlux(moonMag) * density : 0;

  // 暗夜天光本身也受大气浓度调制（浓度低 = 天光弱）
  const totalFlux = darkFlux * density + twilightFlux + moonFlux;
  if (totalFlux <= 0) {
    return {
      brightnessMagArcsec2: Infinity,
      relativeFlux: 0,
      moonFraction: 0,
      twilightFraction: 0,
    };
  }

  return {
    brightnessMagArcsec2: DARK_SKY_BRIGHTNESS - 2.5 * Math.log10(totalFlux),
    relativeFlux: totalFlux,
    moonFraction: moonFlux / totalFlux,
    twilightFraction: twilightFlux / totalFlux,
  };
}
