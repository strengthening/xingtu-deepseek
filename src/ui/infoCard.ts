/**
 * 天体信息卡。
 *
 * 点选天空里的星或行星后，右下角弹出这张卡片。
 * 数据来源：恒星来自二进制分块（位置、星等、颜色、自行）
 * 加上星名表（专名 / 拜耳 / 弗兰斯蒂德 / HIP / HD / HR / 光谱型）；
 * 太阳系天体直接用 astronomy-engine 算出来的那一份。
 */

import { RAD } from '../astro/constants';
import { horizonToAzAlt, vectorToRaDec } from '../astro/coordinates';
import { bvToHex } from '../astro/starColor';
import { formatAngle, formatRa } from '../astro/time';
import { mat3Apply, type Vec3 } from '../astro/vec3';
import { formatDesignation } from '../data/constellationNames';
import type { StarCatalog } from '../data/starCatalog';
import type { BodyPick, StarPick } from '../render/picking';
import { hexToCss } from '../render/color';
import type { SkyContext } from '../skyContext';
import { formatDistance, formatMagnitude, formatZonedDateTime } from './format';

/** B-V 编码 0 表示「星表里没有色指数」，见 scripts/build-stars.ts */
const BV_UNKNOWN_CODE = 0;

export interface StarCardExtras {
  /** 中文星名（HIP → 中文名），可选 */
  chineseNames?: Map<number, string> | null;
}

function row(label: string, value: string, mono = true): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'info-row';
  const l = document.createElement('span');
  l.className = 'info-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = mono ? 'info-value info-value--mono' : 'info-value';
  v.textContent = value;
  wrap.append(l, v);
  return wrap;
}

export class InfoCard {
  readonly element: HTMLElement;

  private titleEl: HTMLElement;
  private subtitleEl: HTMLElement;
  private swatchEl: HTMLElement;
  private bodyEl: HTMLElement;
  private footerEl: HTMLElement;

  private onClose: (() => void) | null = null;

  constructor() {
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'info-title';

    this.subtitleEl = document.createElement('div');
    this.subtitleEl.className = 'info-subtitle';

    this.swatchEl = document.createElement('span');
    this.swatchEl.className = 'info-swatch';

    const heading = document.createElement('div');
    heading.className = 'info-heading';
    heading.append(this.swatchEl, this.titleEl);

    const close = document.createElement('button');
    close.className = 'info-close';
    close.type = 'button';
    close.textContent = '×';
    close.title = '关闭';
    close.addEventListener('click', () => {
      this.hide();
      this.onClose?.();
    });

    const header = document.createElement('div');
    header.className = 'info-header';
    header.append(heading, close);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'info-body';

    this.footerEl = document.createElement('div');
    this.footerEl.className = 'info-footer';

    this.element = document.createElement('div');
    this.element.className = 'panel info-card';
    this.element.style.display = 'none';
    this.element.append(header, this.subtitleEl, this.bodyEl, this.footerEl);
  }

  setOnClose(fn: (() => void) | null): void {
    this.onClose = fn;
  }

  get visible(): boolean {
    return this.element.style.display !== 'none';
  }

  hide(): void {
    this.element.style.display = 'none';
  }

  /** 显示一颗恒星 */
  showStar(
    pick: StarPick,
    ctx: SkyContext,
    catalog: StarCatalog,
    extras: StarCardExtras = {},
  ): void {
    const { chunk, index } = pick;
    const id = chunk.ids[index]!;
    const identity = catalog.identityOf(id);
    const chinese =
      identity?.hip !== undefined ? extras.chineseNames?.get(identity.hip) : undefined;

    const magnitude = chunk.magnitudes[index]!;
    const bvCode = chunk.colors[index * 4 + 3]!;
    const hasBv = bvCode !== BV_UNKNOWN_CODE;
    const bv = bvCode / 50 - 0.5;

    const con = identity?.con;
    // 拜耳编号 → 希腊字母，再拼上星座中文名，例如「α 牧夫座」
    const designation = formatDesignation(identity?.bayer, identity?.flam, con);

    // 标题：优先中文名，其次专名，再次编号
    const title = chinese ?? identity?.name ?? designation ?? `AT-HYG ${id}`;

    this.titleEl.textContent = title;
    const subtitleParts: string[] = [];
    if (chinese && identity?.name) subtitleParts.push(identity.name);
    if (designation) subtitleParts.push(designation);
    subtitleParts.push('恒星');
    this.subtitleEl.textContent = subtitleParts.join(' · ');

    this.swatchEl.style.background = hasBv ? hexToCss(bvToHex(bv)) : '#9fb0cd';
    this.swatchEl.style.display = '';

    const dir: Vec3 = {
      x: chunk.positions[index * 3]!,
      y: chunk.positions[index * 3 + 1]!,
      z: chunk.positions[index * 3 + 2]!,
    };
    const { raDeg, decDeg } = vectorToRaDec(dir);
    const hor = mat3Apply(ctx.equToHoriz, dir);
    const { azimuthDeg, altitudeDeg } = horizonToAzAlt(hor);
    const pmRa = chunk.properMotion[index * 2]!;
    const pmDec = chunk.properMotion[index * 2 + 1]!;

    this.bodyEl.replaceChildren(
      row('视星等', formatMagnitude(magnitude)),
      row('色指数 B−V', hasBv ? bv.toFixed(3) : '—（星表未收录）'),
      row('光谱型', identity?.spect ?? '—'),
      row('赤经 (J2000)', formatRa(raDeg)),
      row('赤纬 (J2000)', formatAngle(decDeg)),
      row('地平高度', `${altitudeDeg.toFixed(2)}°${altitudeDeg < 0 ? '（地平线下）' : ''}`),
      row('方位角', `${azimuthDeg.toFixed(2)}°`),
      row('自行 μ_α*, μ_δ', `${pmRa.toFixed(1)}, ${pmDec.toFixed(1)} mas/yr`),
      row(
        '星表编号',
        [
          identity?.hip !== undefined ? `HIP ${identity.hip}` : null,
          identity?.hd !== undefined ? `HD ${identity.hd}` : null,
          identity?.hr !== undefined ? `HR ${identity.hr}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || '—',
      ),
      row('AT-HYG', String(id)),
    );

    this.footerEl.textContent =
      `坐标已按 ${ctx.deltaYears >= 0 ? '+' : ''}${ctx.deltaYears.toFixed(2)} 年自行推算 ` +
      `并计入周年/周日光行差`;
    this.element.style.display = '';
  }

  /** 显示一个太阳系天体 */
  showBody(pick: BodyPick, ctx: SkyContext): void {
    const body = pick.body;
    const separation = (pick.separationRad * RAD).toFixed(3);

    this.titleEl.textContent = body.nameZh;
    this.subtitleEl.textContent = `${body.nameEn} · ${
      body.kind === 'sun' ? '恒星' : body.kind === 'moon' ? '天然卫星' : '行星'
    }`;
    this.swatchEl.style.background = hexToCss(body.color);
    this.swatchEl.style.display = '';

    const phasePercent = `${(body.illumination * 100).toFixed(1)}%`;
    const angular =
      body.angularDiameterDeg >= 0.01
        ? `${(body.angularDiameterDeg * 60).toFixed(2)}′`
        : `${(body.angularDiameterDeg * 3600).toFixed(1)}″`;

    const rows: HTMLElement[] = [
      row('视星等', formatMagnitude(body.magnitude)),
      row('地心距', formatDistance(body.distanceAu)),
      row('被照亮比例', phasePercent),
      row('相位角', `${body.phaseAngleDeg.toFixed(1)}°`),
      row('视直径', angular),
      row('赤经 (of date)', formatRa(body.raDeg)),
      row('赤纬 (of date)', formatAngle(body.decDeg)),
      row('地平高度', `${body.altitudeDeg.toFixed(2)}°${body.altitudeDeg < 0 ? '（地平线下）' : ''}`),
      row('方位角', `${body.azimuthDeg.toFixed(2)}°`),
    ];

    if (body.key === 'moon') {
      rows.push(row('月相', describeMoonPhase(body.phaseAngleDeg, body.illumination)));
    }
    if (body.key !== 'sun') {
      rows.push(row('与观测者角距', `${separation}°`));
    }

    this.bodyEl.replaceChildren(...rows);
    this.footerEl.textContent = `观测时刻（世界时）：${ctx.date.toISOString().slice(0, 19)} UTC`;
    this.element.style.display = '';
  }

  /** 观测地点的当地时间信息（HUD 用） */
  static localTimeLabel(ctx: SkyContext, timeZone: string): string {
    return `${formatZonedDateTime(ctx.date, timeZone)}`;
  }
}

/** 由相位角粗略描述月相 */
export function describeMoonPhase(phaseAngleDeg: number, illumination: number): string {
  if (illumination < 0.02) return '新月';
  if (illumination > 0.98) return '满月';
  const waxing = phaseAngleDeg > 180;
  if (illumination < 0.45) return waxing ? '娥眉月' : '残月';
  return waxing ? '盈凸月' : '亏凸月';
}
