/**
 * 时间与恒星时。
 *
 * 时间尺度的分工：
 * - 恒星时、岁差章动、行星位置都交给 astronomy-engine，它内部处理 UT/TT/ΔT 的差异；
 * - 自行需要的是「相对 J2000 过了多少儒略年」，用 UT 近似 TT 完全够用（差 < 2 ms）。
 */

import { MakeTime, SiderealTime } from 'astronomy-engine';
import { DAYS_PER_JULIAN_YEAR, J2000_JULIAN_DATE } from './constants';

/** 儒略日（UT 近似） */
export function julianDate(date: Date): number {
  return J2000_JULIAN_DATE + MakeTime(date).ut;
}

/** 相对 J2000.0 的天数（UT） */
export function daysSinceJ2000(date: Date): number {
  return MakeTime(date).ut;
}

/**
 * 相对 J2000.0 的儒略年数。
 * 恒星的自行单位是 mas/yr、位置历元是 J2000，所以推算位置时要用这个量。
 */
export function julianYearsSinceJ2000(date: Date): number {
  return MakeTime(date).ut / DAYS_PER_JULIAN_YEAR;
}

/**
 * 格林尼治视恒星时（GAST），单位小时，范围 [0, 24)。
 *
 * 注意是「视」恒星时（含章动），与 `Rotation_EQJ_EQD`（真赤道/真春分点）
 * 配套使用，两者不能混用平恒星时。
 */
export function greenwichApparentSiderealTime(date: Date): number {
  const hours = SiderealTime(date);
  return ((hours % 24) + 24) % 24;
}

/**
 * 地方视恒星时（LAST），单位小时，范围 [0, 24)。
 *
 * @param longitudeDeg 地理经度，东经为正
 */
export function localSiderealTime(date: Date, longitudeDeg: number): number {
  const lst = greenwichApparentSiderealTime(date) + longitudeDeg / 15;
  return ((lst % 24) + 24) % 24;
}

/** 把小时数格式化成 `12h34m56s` 形式 */
export function formatHourAngle(hours: number): string {
  const total = ((hours % 24) + 24) % 24;
  const h = Math.floor(total);
  const m = Math.floor((total - h) * 60);
  const s = Math.floor(((total - h) * 60 - m) * 60);
  return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
}

/** 把角度格式化成 `+31°13′48″` 形式 */
export function formatAngle(deg: number): string {
  const sign = deg < 0 ? '-' : '+';
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = ((abs - d) * 60 - m) * 60;
  return `${sign}${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″`;
}

/** 把赤经（度）格式化成 `06h45m09s` 形式 */
export function formatRa(raDeg: number): string {
  return formatHourAngle(raDeg / 15);
}
