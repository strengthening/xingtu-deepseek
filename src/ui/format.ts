/**
 * 时间与时区格式化。
 *
 * 观测地点的「当地时间」必须按该地点自己的时区算 —— 用浏览器本地时区
 * 会让「上海 20:00 的星空」在别的时区打开时变成另一个时刻。
 * 用 `Intl` 携带 IANA 时区名，夏令时也自动正确。
 */

const PART_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = PART_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PART_FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // hour12:false 时午夜可能给出 24，归一化一下
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** 某个时刻在指定时区的 UTC 偏移（毫秒） */
export function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 指定时区下的 `YYYY-MM-DDTHH:mm`（给 `<input type="datetime-local">` 用） */
export function toDateTimeLocalValue(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/**
 * `YYYY-MM-DDTHH:mm`（按指定时区解释）→ UTC 毫秒。
 *
 * 时区偏移本身依赖具体时刻（夏令时），所以先按「当作 UTC」算一版，
 * 用它的偏移修正一次，再迭代一次收敛。两次足够，因为偏移只在切换瞬间跳变。
 */
export function fromDateTimeLocalValue(value: string, timeZone: string): number {
  const [datePart = '1970-01-01', timePart = '00:00'] = value.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi] = timePart.split(':').map(Number);
  const asUtc = Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);

  let guess = asUtc;
  for (let i = 0; i < 2; i++) {
    guess = asUtc - timeZoneOffsetMs(new Date(guess), timeZone);
  }
  return guess;
}

/** 人类可读的当地时间 */
export function formatZonedDateTime(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** 只取时分秒 */
export function formatZonedTime(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** UTC 偏移的展示形式，例如 `UTC+08:00` */
export function formatUtcOffset(date: Date, timeZone: string): string {
  const offsetMinutes = Math.round(timeZoneOffsetMs(date, timeZone) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 时间流速 → 可读文本 */
export function formatRate(rate: number): string {
  if (rate === 0) return '暂停';
  if (rate === 1) return '实时';
  if (rate < 60) return `${rate}×`;
  if (rate < 3600) return `${Math.round(rate / 60)} 分/秒`;
  if (rate < 86400) return `${Math.round(rate / 3600)} 时/秒`;
  if (rate < 86400 * 30) return `${Math.round(rate / 86400)} 天/秒`;
  if (rate < 86400 * 365) return `${(rate / 86400 / 30).toFixed(1)} 月/秒`;
  return `${(rate / 86400 / 365).toFixed(1)} 年/秒`;
}

/** 星等 → 可读文本 */
export function formatMagnitude(mag: number): string {
  return `${mag >= 0 ? '' : '−'}${Math.abs(mag).toFixed(2)} 等`;
}

/** 度 → `12.34°` */
export function formatDegree(value: number, digits = 2): string {
  return `${value.toFixed(digits)}°`;
}

/** 距离 → 可读文本（AU / 光年） */
export function formatDistance(au: number): string {
  if (!Number.isFinite(au) || au <= 0) return '—';
  if (au < 0.01) return `${(au * 149597870.7).toFixed(0)} km`;
  if (au < 1000) return `${au.toFixed(3)} AU`;
  return `${(au * 0.0000158125).toFixed(1)} 光年`;
}
