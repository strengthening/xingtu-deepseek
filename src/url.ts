/**
 * 用 URL 分享视角与时间。
 *
 * 序列化进 query string，键名尽量短（分享链接要好念好贴）：
 * ```
 * ?loc=shanghai&t=1767225600000&az=180&alt=40&fov=70&d=11101101&atm=0.35
 * ```
 * - `loc` 地点 id
 * - `t`   观测时刻（UTC 毫秒）
 * - `az` / `alt` / `fov` 视角
 * - `d`   显示开关位掩码（顺序固定，见 `DISPLAY_FLAGS`）
 * - `atm` 大气浓度
 */

import {
  clampFov,
  createInitialState,
  findPreset,
  LOCATION_PRESETS,
  type AppStateShape,
} from './state';

/** 位掩码里各开关的顺序。改动顺序会破坏旧链接的兼容性，所以只往后加。 */
const DISPLAY_FLAGS = [
  'showWesternConstellations',
  'showChineseConstellations',
  'showEquatorialGrid',
  'showHorizontalGrid',
  'showMilkyWay',
  'showSolarSystem',
  'showStarLabels',
  'showHorizon',
] as const satisfies readonly (keyof AppStateShape['display'])[];

function encodeDisplay(state: AppStateShape): string {
  return DISPLAY_FLAGS.map((key) => (state.display[key] ? '1' : '0')).join('');
}

function decodeDisplay(bits: string, into: AppStateShape['display']): void {
  for (let i = 0; i < DISPLAY_FLAGS.length && i < bits.length; i++) {
    const key = DISPLAY_FLAGS[i]!;
    const value = bits[i] === '1';
    (into as unknown as Record<string, boolean>)[key] = value;
  }
}

/** 读取一个数值参数；参数不存在或不是数字时返回 null */
function readNumber(params: URLSearchParams, key: string): number | null {
  if (!params.has(key)) return null;
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** 从当前地址读状态；没有参数的字段沿用默认值 */
export function readStateFromUrl(search: string): AppStateShape {
  const state = createInitialState();
  const params = new URLSearchParams(search);

  const loc = params.get('loc');
  if (loc && LOCATION_PRESETS.some((p) => p.id === loc)) {
    const preset = findPreset(loc);
    state.observer = {
      locationId: preset.id,
      locationName: preset.name,
      latitudeDeg: preset.latitudeDeg,
      longitudeDeg: preset.longitudeDeg,
      heightM: preset.heightM,
      timeZone: preset.timeZone,
    };
  }

  // 注意：必须先用 has() 判断参数是否存在。
  // `Number(null)` 是 0 而且 `Number.isFinite(0)` 为真，
  // 直接 `Number(params.get('az'))` 会把「没传参数」误判成「传了 0」。
  const t = readNumber(params, 't');
  if (t !== null && t > 0) state.time.epochMs = t;

  const az = readNumber(params, 'az');
  if (az !== null) state.view.azimuthDeg = ((az % 360) + 360) % 360;

  const alt = readNumber(params, 'alt');
  if (alt !== null) state.view.altitudeDeg = Math.max(-90, Math.min(90, alt));

  const fov = readNumber(params, 'fov');
  if (fov !== null && fov > 0) state.view.fovDeg = clampFov(fov);

  const atm = readNumber(params, 'atm');
  if (atm !== null) {
    state.display.atmosphereDensity = Math.max(0, Math.min(1, atm));
  }

  const bits = params.get('d');
  if (bits) decodeDisplay(bits, state.display);

  return state;
}

/** 生成分享链接（不含 origin，调用方自行补） */
export function writeStateToUrl(state: AppStateShape): string {
  const params = new URLSearchParams();
  params.set('loc', state.observer.locationId);
  params.set('t', String(Math.round(state.time.epochMs)));
  params.set('az', state.view.azimuthDeg.toFixed(2));
  params.set('alt', state.view.altitudeDeg.toFixed(2));
  params.set('fov', state.view.fovDeg.toFixed(3));
  params.set('d', encodeDisplay(state));
  params.set('atm', state.display.atmosphereDensity.toFixed(2));

  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}?${params.toString()}`;
}

/**
 * 把状态同步进地址栏（不产生新的历史记录）。
 * 视角拖拽时每帧都调用会很吵，所以调用方要自己节流。
 */
export function syncUrl(state: AppStateShape): void {
  const url = writeStateToUrl(state);
  window.history.replaceState(null, '', url);
}

/** 复制分享链接到剪贴板，返回是否成功 */
export async function copyShareLink(state: AppStateShape): Promise<boolean> {
  const url = writeStateToUrl(state);
  try {
    await navigator.clipboard.writeText(url);
    return true;
  } catch {
    // 剪贴板 API 在非安全上下文或没有权限时会失败，退回到 prompt
    window.prompt('复制这个链接分享当前视角与时间：', url);
    return false;
  }
}
