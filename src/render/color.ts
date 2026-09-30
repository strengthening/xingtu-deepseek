/**
 * 颜色工具。
 *
 * 场景是**线性光照**的（见 `shaders.ts` 顶部关于颜色空间的说明），
 * 所以 UI 里惯用的十六进制颜色（sRGB 编码）在送进着色器前必须解码成线性值。
 */

/** sRGB 分量（0..1）→ 线性分量 */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 线性分量 → sRGB 分量（0..1） */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** 0xRRGGBB（sRGB 编码）→ 线性 RGB 三元组 */
export function hexToLinearRgb(hex: number): [number, number, number] {
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

/** 0xRRGGBB → 线性 RGB，并乘以一个强度 */
export function hexToLinearRgbScaled(hex: number, scale: number): [number, number, number] {
  const [r, g, b] = hexToLinearRgb(hex);
  return [r * scale, g * scale, b * scale];
}

/** 0xRRGGBB → `#rrggbb` */
export function hexToCss(hex: number): string {
  return `#${(hex & 0xffffff).toString(16).padStart(6, '0')}`;
}
