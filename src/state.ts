/**
 * 应用状态与观测地点预设。
 *
 * 这里只放「数据」，不放 Three.js 对象；渲染层订阅状态变化并做出反应。
 */

export type Hemisphere = 'north' | 'south';

export interface LocationPreset {
  id: string;
  /** 中文名 */
  name: string;
  /** 英文名，用于 URL 与信息卡 */
  nameEn: string;
  hemisphere: Hemisphere;
  latitudeDeg: number;
  longitudeDeg: number;
  heightM: number;
  /** IANA 时区名，用于把观测时刻换算成当地时间（自动处理夏令时） */
  timeZone: string;
}

/**
 * 预设观测地点。
 *
 * 按要求只分「北半球」与「南半球」两组：
 * - 中国城市精简到 6 个有代表性的，上海为默认；
 * - 南半球给足城市 —— 南天的星空和北天完全不同，值得多列。
 */
export const LOCATION_PRESETS: readonly LocationPreset[] = Object.freeze([
  // ---------------- 北半球 ----------------
  { id: 'shanghai', name: '上海', nameEn: 'Shanghai', hemisphere: 'north', latitudeDeg: 31.2304, longitudeDeg: 121.4737, heightM: 4, timeZone: 'Asia/Shanghai' },
  { id: 'beijing', name: '北京', nameEn: 'Beijing', hemisphere: 'north', latitudeDeg: 39.9042, longitudeDeg: 116.4074, heightM: 44, timeZone: 'Asia/Shanghai' },
  { id: 'guangzhou', name: '广州', nameEn: 'Guangzhou', hemisphere: 'north', latitudeDeg: 23.1291, longitudeDeg: 113.2644, heightM: 21, timeZone: 'Asia/Shanghai' },
  { id: 'urumqi', name: '乌鲁木齐', nameEn: 'Ürümqi', hemisphere: 'north', latitudeDeg: 43.8256, longitudeDeg: 87.6168, heightM: 800, timeZone: 'Asia/Shanghai' },
  { id: 'lhasa', name: '拉萨', nameEn: 'Lhasa', hemisphere: 'north', latitudeDeg: 29.652, longitudeDeg: 91.1721, heightM: 3650, timeZone: 'Asia/Shanghai' },
  { id: 'harbin', name: '哈尔滨', nameEn: 'Harbin', hemisphere: 'north', latitudeDeg: 45.8038, longitudeDeg: 126.5349, heightM: 150, timeZone: 'Asia/Shanghai' },
  { id: 'tokyo', name: '东京', nameEn: 'Tokyo', hemisphere: 'north', latitudeDeg: 35.6762, longitudeDeg: 139.6503, heightM: 40, timeZone: 'Asia/Tokyo' },
  { id: 'seoul', name: '首尔', nameEn: 'Seoul', hemisphere: 'north', latitudeDeg: 37.5665, longitudeDeg: 126.978, heightM: 38, timeZone: 'Asia/Seoul' },
  { id: 'singapore', name: '新加坡', nameEn: 'Singapore', hemisphere: 'north', latitudeDeg: 1.3521, longitudeDeg: 103.8198, heightM: 15, timeZone: 'Asia/Singapore' },
  { id: 'newdelhi', name: '新德里', nameEn: 'New Delhi', hemisphere: 'north', latitudeDeg: 28.6139, longitudeDeg: 77.209, heightM: 216, timeZone: 'Asia/Kolkata' },
  { id: 'dubai', name: '迪拜', nameEn: 'Dubai', hemisphere: 'north', latitudeDeg: 25.2048, longitudeDeg: 55.2708, heightM: 5, timeZone: 'Asia/Dubai' },
  { id: 'moscow', name: '莫斯科', nameEn: 'Moscow', hemisphere: 'north', latitudeDeg: 55.7558, longitudeDeg: 37.6173, heightM: 156, timeZone: 'Europe/Moscow' },
  { id: 'london', name: '伦敦', nameEn: 'London', hemisphere: 'north', latitudeDeg: 51.5074, longitudeDeg: -0.1278, heightM: 11, timeZone: 'Europe/London' },
  { id: 'paris', name: '巴黎', nameEn: 'Paris', hemisphere: 'north', latitudeDeg: 48.8566, longitudeDeg: 2.3522, heightM: 35, timeZone: 'Europe/Paris' },
  { id: 'berlin', name: '柏林', nameEn: 'Berlin', hemisphere: 'north', latitudeDeg: 52.52, longitudeDeg: 13.405, heightM: 34, timeZone: 'Europe/Berlin' },
  { id: 'rome', name: '罗马', nameEn: 'Rome', hemisphere: 'north', latitudeDeg: 41.9028, longitudeDeg: 12.4964, heightM: 21, timeZone: 'Europe/Rome' },
  { id: 'cairo', name: '开罗', nameEn: 'Cairo', hemisphere: 'north', latitudeDeg: 30.0444, longitudeDeg: 31.2357, heightM: 23, timeZone: 'Africa/Cairo' },
  { id: 'newyork', name: '纽约', nameEn: 'New York', hemisphere: 'north', latitudeDeg: 40.7128, longitudeDeg: -74.006, heightM: 10, timeZone: 'America/New_York' },
  { id: 'losangeles', name: '洛杉矶', nameEn: 'Los Angeles', hemisphere: 'north', latitudeDeg: 34.0522, longitudeDeg: -118.2437, heightM: 71, timeZone: 'America/Los_Angeles' },
  { id: 'vancouver', name: '温哥华', nameEn: 'Vancouver', hemisphere: 'north', latitudeDeg: 49.2827, longitudeDeg: -123.1207, heightM: 2, timeZone: 'America/Vancouver' },
  { id: 'honolulu', name: '火奴鲁鲁', nameEn: 'Honolulu', hemisphere: 'north', latitudeDeg: 21.3069, longitudeDeg: -157.8583, heightM: 5, timeZone: 'Pacific/Honolulu' },

  // ---------------- 南半球 ----------------
  { id: 'sydney', name: '悉尼', nameEn: 'Sydney', hemisphere: 'south', latitudeDeg: -33.8688, longitudeDeg: 151.2093, heightM: 58, timeZone: 'Australia/Sydney' },
  { id: 'melbourne', name: '墨尔本', nameEn: 'Melbourne', hemisphere: 'south', latitudeDeg: -37.8136, longitudeDeg: 144.9631, heightM: 31, timeZone: 'Australia/Melbourne' },
  { id: 'brisbane', name: '布里斯班', nameEn: 'Brisbane', hemisphere: 'south', latitudeDeg: -27.4698, longitudeDeg: 153.0251, heightM: 28, timeZone: 'Australia/Brisbane' },
  { id: 'perth', name: '珀斯', nameEn: 'Perth', hemisphere: 'south', latitudeDeg: -31.9505, longitudeDeg: 115.8605, heightM: 46, timeZone: 'Australia/Perth' },
  { id: 'adelaide', name: '阿德莱德', nameEn: 'Adelaide', hemisphere: 'south', latitudeDeg: -34.9285, longitudeDeg: 138.6007, heightM: 50, timeZone: 'Australia/Adelaide' },
  { id: 'darwin', name: '达尔文', nameEn: 'Darwin', hemisphere: 'south', latitudeDeg: -12.4634, longitudeDeg: 130.8456, heightM: 30, timeZone: 'Australia/Darwin' },
  { id: 'auckland', name: '奥克兰', nameEn: 'Auckland', hemisphere: 'south', latitudeDeg: -36.8485, longitudeDeg: 174.7633, heightM: 40, timeZone: 'Pacific/Auckland' },
  { id: 'christchurch', name: '基督城', nameEn: 'Christchurch', hemisphere: 'south', latitudeDeg: -43.5321, longitudeDeg: 172.6362, heightM: 20, timeZone: 'Pacific/Auckland' },
  { id: 'jakarta', name: '雅加达', nameEn: 'Jakarta', hemisphere: 'south', latitudeDeg: -6.2088, longitudeDeg: 106.8456, heightM: 8, timeZone: 'Asia/Jakarta' },
  { id: 'quito', name: '基多', nameEn: 'Quito', hemisphere: 'south', latitudeDeg: -0.1807, longitudeDeg: -78.4678, heightM: 2850, timeZone: 'America/Guayaquil' },
  { id: 'lima', name: '利马', nameEn: 'Lima', hemisphere: 'south', latitudeDeg: -12.0464, longitudeDeg: -77.0428, heightM: 154, timeZone: 'America/Lima' },
  { id: 'saopaulo', name: '圣保罗', nameEn: 'São Paulo', hemisphere: 'south', latitudeDeg: -23.5505, longitudeDeg: -46.6333, heightM: 760, timeZone: 'America/Sao_Paulo' },
  { id: 'rio', name: '里约热内卢', nameEn: 'Rio de Janeiro', hemisphere: 'south', latitudeDeg: -22.9068, longitudeDeg: -43.1729, heightM: 11, timeZone: 'America/Sao_Paulo' },
  { id: 'buenosaires', name: '布宜诺斯艾利斯', nameEn: 'Buenos Aires', hemisphere: 'south', latitudeDeg: -34.6037, longitudeDeg: -58.3816, heightM: 25, timeZone: 'America/Argentina/Buenos_Aires' },
  { id: 'montevideo', name: '蒙得维的亚', nameEn: 'Montevideo', hemisphere: 'south', latitudeDeg: -34.9011, longitudeDeg: -56.1645, heightM: 43, timeZone: 'America/Montevideo' },
  { id: 'santiago', name: '圣地亚哥', nameEn: 'Santiago', hemisphere: 'south', latitudeDeg: -33.4489, longitudeDeg: -70.6693, heightM: 570, timeZone: 'America/Santiago' },
  { id: 'capetown', name: '开普敦', nameEn: 'Cape Town', hemisphere: 'south', latitudeDeg: -33.9249, longitudeDeg: 18.4241, heightM: 25, timeZone: 'Africa/Johannesburg' },
  { id: 'johannesburg', name: '约翰内斯堡', nameEn: 'Johannesburg', hemisphere: 'south', latitudeDeg: -26.2041, longitudeDeg: 28.0473, heightM: 1753, timeZone: 'Africa/Johannesburg' },
  { id: 'nairobi', name: '内罗毕', nameEn: 'Nairobi', hemisphere: 'south', latitudeDeg: -1.2921, longitudeDeg: 36.8219, heightM: 1795, timeZone: 'Africa/Nairobi' },
  { id: 'antananarivo', name: '塔那那利佛', nameEn: 'Antananarivo', hemisphere: 'south', latitudeDeg: -18.8792, longitudeDeg: 47.5079, heightM: 1280, timeZone: 'Indian/Antananarivo' },
  { id: 'maputo', name: '马普托', nameEn: 'Maputo', hemisphere: 'south', latitudeDeg: -25.9692, longitudeDeg: 32.5732, heightM: 47, timeZone: 'Africa/Maputo' },
  { id: 'harare', name: '哈拉雷', nameEn: 'Harare', hemisphere: 'south', latitudeDeg: -17.8252, longitudeDeg: 31.0335, heightM: 1483, timeZone: 'Africa/Harare' },
]);

export const DEFAULT_LOCATION_ID = 'shanghai';

export function findPreset(id: string): LocationPreset {
  return (
    LOCATION_PRESETS.find((p) => p.id === id) ??
    LOCATION_PRESETS.find((p) => p.id === DEFAULT_LOCATION_ID)!
  );
}

export function presetsOf(hemisphere: Hemisphere): readonly LocationPreset[] {
  return LOCATION_PRESETS.filter((p) => p.hemisphere === hemisphere);
}

// ---------------------------------------------------------------------------

export interface ObserverSettings {
  locationId: string;
  locationName: string;
  latitudeDeg: number;
  longitudeDeg: number;
  heightM: number;
  timeZone: string;
}

export interface ViewSettings {
  /** 视线中心方位角（度，从北起向东为正） */
  azimuthDeg: number;
  /** 视线中心高度角（度） */
  altitudeDeg: number;
  /** 垂直视场角（度） */
  fovDeg: number;
}

export interface TimeSettings {
  /** 观测时刻，UTC 毫秒 */
  epochMs: number;
  /** 时间流速倍率，1 = 实时 */
  rate: number;
  paused: boolean;
}

export interface DisplaySettings {
  /** 大气浓度 0..1 */
  atmosphereDensity: number;
  showAtmosphere: boolean;
  showEquatorialGrid: boolean;
  showHorizontalGrid: boolean;
  showWesternConstellations: boolean;
  showChineseConstellations: boolean;
  showMilkyWay: boolean;
  showSolarSystem: boolean;
  showStarLabels: boolean;
  showHorizon: boolean;
}

export interface AppStateShape {
  observer: ObserverSettings;
  view: ViewSettings;
  time: TimeSettings;
  display: DisplaySettings;
}

export const MIN_FOV_DEG = 0.15;
export const MAX_FOV_DEG = 140;

export function createInitialState(): AppStateShape {
  const preset = findPreset(DEFAULT_LOCATION_ID);
  return {
    observer: {
      locationId: preset.id,
      locationName: preset.name,
      latitudeDeg: preset.latitudeDeg,
      longitudeDeg: preset.longitudeDeg,
      heightM: preset.heightM,
      timeZone: preset.timeZone,
    },
    view: {
      // 默认朝南、抬头 40° —— 中纬度观测者最常看的方向
      azimuthDeg: 180,
      altitudeDeg: 40,
      fovDeg: 70,
    },
    time: {
      epochMs: Date.now(),
      rate: 1,
      paused: false,
    },
    display: {
      atmosphereDensity: 0.35,
      showAtmosphere: true,
      showEquatorialGrid: false,
      showHorizontalGrid: false,
      showWesternConstellations: true,
      showChineseConstellations: false,
      showMilkyWay: true,
      showSolarSystem: true,
      showStarLabels: true,
      showHorizon: true,
    },
  };
}

type Listener = (state: AppStateShape) => void;

/**
 * 极简状态容器。
 *
 * 变更走 `update()`，订阅者拿到的是同一份（浅拷贝过的）状态快照。
 * 结构刻意保持简单：没有中间件、没有不可变库，够用即可。
 */
export class AppState {
  private current: AppStateShape;
  private listeners = new Set<Listener>();
  /** 批量更新时抑制重复通知 */
  private depth = 0;
  private dirty = false;

  constructor(initial: AppStateShape = createInitialState()) {
    this.current = initial;
  }

  get value(): AppStateShape {
    return this.current;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 合并式更新；传函数可以基于当前值计算 */
  update(patch: DeepPartial<AppStateShape>): void {
    this.current = {
      observer: { ...this.current.observer, ...patch.observer },
      view: { ...this.current.view, ...patch.view },
      time: { ...this.current.time, ...patch.time },
      display: { ...this.current.display, ...patch.display },
    };
    this.notify();
  }

  replace(next: AppStateShape): void {
    this.current = next;
    this.notify();
  }

  /** 批量更新期间只通知一次 */
  batch(fn: () => void): void {
    this.depth++;
    try {
      fn();
    } finally {
      this.depth--;
      if (this.depth === 0 && this.dirty) {
        this.dirty = false;
        this.emit();
      }
    }
  }

  private notify(): void {
    if (this.depth > 0) {
      this.dirty = true;
      return;
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.current);
  }
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K];
};

/** 把视场角夹到允许范围 */
export function clampFov(fovDeg: number): number {
  return Math.min(MAX_FOV_DEG, Math.max(MIN_FOV_DEG, fovDeg));
}

/**
 * 由视场角推断当前应该显示到多暗的星等。
 *
 * 视野越小，能塞下的星越多，就显示越暗的星。经验公式，
 * 保证整个天空视图下星点密度不至于糊成一片。
 */
export function magnitudeLimitForFov(fovDeg: number): number {
  const reference = 70;
  const limit = 6.6 + 2.1 * Math.log2(Math.max(reference / Math.max(fovDeg, 0.01), 1));
  return Math.min(20, Math.max(4.5, limit));
}
