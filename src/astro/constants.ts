/**
 * 天文常量。
 *
 * 角度一律以「度」为对外接口单位，内部计算用弧度；
 * 自行以毫角秒/年（mas/yr）为单位，这是星表的标准约定。
 */

/** 度 → 弧度 */
export const DEG = Math.PI / 180;

/** 弧度 → 度 */
export const RAD = 180 / Math.PI;

/** 角秒 → 弧度 */
export const ARCSEC_TO_RAD = DEG / 3600;

/** 毫角秒 → 弧度 */
export const MAS_TO_RAD = ARCSEC_TO_RAD / 1000;

/** 小时 → 弧度（1h = 15°） */
export const HOURS_TO_RAD = Math.PI / 12;

/** J2000.0 历元的儒略日 */
export const J2000_JULIAN_DATE = 2451545.0;

/** 儒略年长度（天） */
export const DAYS_PER_JULIAN_YEAR = 365.25;

/** 光速，AU/天。用于周年光行差。 */
export const SPEED_OF_LIGHT_AU_PER_DAY = 173.1446326846693;

/** 光速，km/s */
export const SPEED_OF_LIGHT_KM_PER_S = 299792.458;

/** 光速，m/s */
export const SPEED_OF_LIGHT_M_PER_S = 299792458;

/** 地球自转角速度，rad/s（IAU 2000 标称值） */
export const EARTH_ROTATION_RATE = 7.292115e-5;

/** WGS84 赤道半径，米 */
export const WGS84_EQUATORIAL_RADIUS_M = 6378137;

/** 1 天文单位 = 多少 km */
export const AU_IN_KM = 149597870.7;

/**
 * GPU 上 float32 只能精确表示约 7 位十进制有效数字。
 * 天球方向统一归一化到单位球，避免用真实距离导致的精度塌陷。
 */
export const SKY_RADIUS = 1;
