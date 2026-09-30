/**
 * 左侧控制面板。
 *
 * 全部控件都用原生 `<select>` / `<input>` / `<button>`：
 * 系统原生控件的可发现性最好（下拉箭头、滑块轨道、按钮的按下态都是用户
 * 一眼就认得的），比自绘控件更符合 PROMPT 里「一眼能看出可以操作、
 * 不要看起来像禁用状态」的要求。
 */

import { findPreset, LOCATION_PRESETS, presetsOf, type AppState, type AppStateShape } from '../state';
import {
  formatRate,
  formatUtcOffset,
  formatZonedDateTime,
  fromDateTimeLocalValue,
  toDateTimeLocalValue,
} from './format';

export interface ControlPanelHandlers {
  onLocationChange(locationId: string): void;
  onTimeChange(epochMs: number): void;
  onNow(): void;
  onResetView(): void;
  onShare(): void;
}

/** 时间流速的预设档位 */
const RATE_PRESETS: readonly { label: string; rate: number }[] = [
  { label: '暂停', rate: 0 },
  { label: '实时', rate: 1 },
  { label: '1 分/秒', rate: 60 },
  { label: '1 时/秒', rate: 3600 },
  { label: '1 天/秒', rate: 86400 },
  { label: '1 月/秒', rate: 86400 * 30 },
  { label: '1 年/秒', rate: 86400 * 365 },
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = String(value);
    else if (key in node) (node as unknown as Record<string, unknown>)[key] = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

interface Field {
  root: HTMLElement;
  label: HTMLElement;
  value: HTMLElement;
}

function makeField(labelText: string, labelFor?: string): Field {
  const value = el('span', { class: 'field-value' });
  const label = el('label', { class: 'field-label' }, [el('span', {}, [labelText]), value]);
  if (labelFor) label.htmlFor = labelFor;
  const root = el('div', { class: 'field' }, [label]);
  return { root, label, value };
}

export class ControlPanel {
  readonly element: HTMLElement;

  private locationSelect: HTMLSelectElement;
  private locationMeta: HTMLElement;
  private timeInput: HTMLInputElement;
  private timeReadout: HTMLElement;
  private rateButtons: HTMLButtonElement[] = [];
  private rateReadout: HTMLElement;
  private fovSlider: HTMLInputElement;
  private fovValue: HTMLElement;
  private viewReadout: HTMLElement;
  private atmosphereSlider: HTMLInputElement;
  private atmosphereValue: HTMLElement;
  private checkboxes = new Map<string, HTMLInputElement>();

  private handlers: ControlPanelHandlers;
  private state: AppState;

  /** 用户正在拖动滑块 / 编辑时间时，不要把状态回写覆盖掉输入 */
  private editing = new Set<string>();

  constructor(state: AppState, handlers: ControlPanelHandlers) {
    this.state = state;
    this.handlers = handlers;

    // ---- 观测地点 ----
    this.locationSelect = el('select', { id: 'loc-select', class: 'control-select' });
    for (const [hemisphere, title] of [
      ['north', '北半球'],
      ['south', '南半球'],
    ] as const) {
      const group = el('optgroup', { label: title });
      for (const preset of presetsOf(hemisphere)) {
        const option = el('option', { value: preset.id }, [preset.name]);
        group.appendChild(option);
      }
      this.locationSelect.appendChild(group);
    }
    this.locationSelect.addEventListener('change', () => {
      this.handlers.onLocationChange(this.locationSelect.value);
    });

    const locField = makeField('观测地点');
    locField.root.appendChild(this.locationSelect);

    this.locationMeta = el('div', { class: 'meta-line' });

    // ---- 时间 ----
    this.timeInput = el('input', {
      id: 'time-input',
      class: 'control-input',
      type: 'datetime-local',
      step: '1',
    });
    this.timeInput.addEventListener('input', () => {
      this.editing.add('time');
    });
    this.timeInput.addEventListener('change', () => {
      this.editing.delete('time');
      const preset = findPreset(this.state.value.observer.locationId);
      const epoch = fromDateTimeLocalValue(this.timeInput.value, preset.timeZone);
      if (Number.isFinite(epoch)) this.handlers.onTimeChange(epoch);
    });

    const nowButton = el('button', { class: 'control-button', type: 'button' }, ['回到现在']);
    nowButton.addEventListener('click', () => this.handlers.onNow());

    const shareButton = el('button', { class: 'control-button', type: 'button' }, ['复制分享链接']);
    shareButton.addEventListener('click', () => this.handlers.onShare());

    this.timeReadout = el('div', { class: 'meta-line' });
    this.rateReadout = el('span', { class: 'field-value' });

    const rateRow = el('div', { class: 'button-row' });
    for (const preset of RATE_PRESETS) {
      const button = el('button', { class: 'control-chip', type: 'button' }, [preset.label]);
      button.addEventListener('click', () => {
        this.state.update({
          time: { rate: preset.rate, paused: preset.rate === 0 ? true : false },
        });
      });
      this.rateButtons.push(button);
      rateRow.appendChild(button);
    }

    // ---- 视角 ----
    this.fovSlider = el('input', {
      id: 'fov-slider',
      class: 'control-range',
      type: 'range',
      min: '0',
      max: '1',
      step: '0.001',
      value: '0.5',
    });
    this.fovSlider.addEventListener('input', () => {
      // 滑块用对数刻度：视野从 0.2° 到 140°，线性刻度在小视野段完全没法用
      const t = Number(this.fovSlider.value);
      const fov = 0.2 * Math.pow(140 / 0.2, t);
      this.state.update({ view: { fovDeg: fov } });
      this.editing.add('fov');
    });
    this.fovSlider.addEventListener('change', () => this.editing.delete('fov'));

    this.fovValue = el('span', { class: 'field-value' });
    const fovField = makeField('视场角（垂直）', 'fov-slider');
    fovField.value.replaceWith(this.fovValue);
    fovField.label.appendChild(this.fovValue);
    fovField.root.appendChild(this.fovSlider);

    this.viewReadout = el('div', { class: 'meta-line' });

    const resetButton = el('button', { class: 'control-button', type: 'button' }, ['重置视角']);
    resetButton.addEventListener('click', () => this.handlers.onResetView());

    // ---- 显示开关 ----
    const toggles: { key: keyof AppStateShape['display']; label: string; hint?: string }[] = [
      { key: 'showWesternConstellations', label: '西方星座连线' },
      { key: 'showChineseConstellations', label: '中国星官（三垣二十八宿）' },
      { key: 'showEquatorialGrid', label: '赤道网格' },
      { key: 'showHorizontalGrid', label: '地平网格' },
      { key: 'showMilkyWay', label: '银河背景（HiPS）' },
      { key: 'showSolarSystem', label: '太阳 / 月亮 / 行星' },
      { key: 'showStarLabels', label: '亮星名称' },
      { key: 'showHorizon', label: '地平线与地面' },
    ];
    const toggleList = el('div', { class: 'toggle-list' });
    for (const toggle of toggles) {
      const input = el('input', { type: 'checkbox', class: 'control-check' });
      const id = `toggle-${toggle.key}`;
      input.id = id;
      input.addEventListener('change', () => {
        this.state.update({ display: { [toggle.key]: input.checked } as never });
      });
      this.checkboxes.set(toggle.key, input);
      toggleList.appendChild(
        el('label', { class: 'toggle-item', htmlFor: id }, [input, el('span', {}, [toggle.label])]),
      );
    }

    // ---- 大气 ----
    this.atmosphereSlider = el('input', {
      id: 'atm-slider',
      class: 'control-range',
      type: 'range',
      min: '0',
      max: '1',
      step: '0.01',
      value: '0.35',
    });
    this.atmosphereValue = el('span', { class: 'field-value' });
    this.atmosphereSlider.addEventListener('input', () => {
      this.state.update({ display: { atmosphereDensity: Number(this.atmosphereSlider.value) } });
      this.editing.add('atm');
    });
    this.atmosphereSlider.addEventListener('change', () => this.editing.delete('atm'));

    const atmField = makeField('大气浓度（0 = 太空视角）', 'atm-slider');
    atmField.label.appendChild(this.atmosphereValue);
    atmField.root.appendChild(this.atmosphereSlider);

    // ---- 组装 ----
    const body = el('div', { class: 'panel-body' }, [
      locField.root,
      this.locationMeta,
      el('div', { class: 'divider' }),
      makeField('观测时刻（当地时间）').root,
      this.timeInput,
      el('div', { class: 'button-row' }, [nowButton, shareButton]),
      this.timeReadout,
      el('div', { class: 'field' }, [
        el('div', { class: 'field-label' }, [el('span', {}, ['时间流速']), this.rateReadout]),
        rateRow,
      ]),
      el('div', { class: 'divider' }),
      fovField.root,
      this.viewReadout,
      el('div', { class: 'button-row' }, [resetButton]),
      el('div', { class: 'divider' }),
      el('div', { class: 'field-label' }, [el('span', {}, ['显示'])]),
      toggleList,
      el('div', { class: 'divider' }),
      atmField.root,
    ]);

    const header = el('div', { class: 'panel-header' }, [
      el('span', { class: 'panel-title' }, ['星图 · 控制台']),
      el('span', { class: 'panel-toggle' }, ['收起']),
    ]);
    header.addEventListener('click', () => {
      this.element.classList.toggle('is-collapsed');
      const toggle = header.querySelector('.panel-toggle');
      if (toggle) toggle.textContent = this.element.classList.contains('is-collapsed') ? '展开' : '收起';
    });

    this.element = el('div', { class: 'panel control-panel' }, [header, body]);

    this.syncFromState(state.value);
    state.subscribe((next) => this.syncFromState(next));
  }

  /** 状态 → 控件（跳过用户正在编辑的字段） */
  syncFromState(state: AppStateShape): void {
    if (this.locationSelect.value !== state.observer.locationId) {
      this.locationSelect.value = state.observer.locationId;
    }

    const preset = findPreset(state.observer.locationId);
    const date = new Date(state.time.epochMs);
    this.locationMeta.textContent =
      `${state.observer.latitudeDeg.toFixed(4)}°, ${state.observer.longitudeDeg.toFixed(4)}° · ` +
      `海拔 ${state.observer.heightM} m · ${formatUtcOffset(date, preset.timeZone)}`;

    if (!this.editing.has('time')) {
      const value = toDateTimeLocalValue(date, preset.timeZone);
      if (this.timeInput.value !== value) this.timeInput.value = value;
    }
    this.timeReadout.textContent =
      `${formatZonedDateTime(date, preset.timeZone)} 当地时间 · ` +
      `UTC ${date.toISOString().slice(11, 19)}`;

    this.rateReadout.textContent = state.time.paused ? '已暂停' : formatRate(state.time.rate);
    for (let i = 0; i < this.rateButtons.length; i++) {
      const preset = RATE_PRESETS[i]!;
      const active = state.time.paused ? preset.rate === 0 : preset.rate === state.time.rate;
      this.rateButtons[i]!.classList.toggle('is-active', active);
    }

    if (!this.editing.has('fov')) {
      const t = Math.log(state.view.fovDeg / 0.2) / Math.log(140 / 0.2);
      const clamped = Math.min(1, Math.max(0, t));
      if (Math.abs(Number(this.fovSlider.value) - clamped) > 1e-4) {
        this.fovSlider.value = String(clamped);
      }
    }
    this.fovValue.textContent =
      state.view.fovDeg >= 10
        ? `${state.view.fovDeg.toFixed(1)}°`
        : `${state.view.fovDeg.toFixed(3)}°`;

    this.viewReadout.textContent =
      `方位 ${state.view.azimuthDeg.toFixed(1)}° · 高度 ${state.view.altitudeDeg.toFixed(1)}° · ` +
      `拖拽转视角，滚轮缩放`;

    for (const [key, input] of this.checkboxes) {
      const value = state.display[key as keyof AppStateShape['display']];
      if (typeof value === 'boolean' && input.checked !== value) input.checked = value;
    }

    if (!this.editing.has('atm')) {
      const value = state.display.atmosphereDensity;
      if (Math.abs(Number(this.atmosphereSlider.value) - value) > 1e-4) {
        this.atmosphereSlider.value = String(value);
      }
    }
    this.atmosphereValue.textContent = `${Math.round(state.display.atmosphereDensity * 100)}%`;
  }
}

/** 地点预设总数，给 UI 显示用 */
export const LOCATION_PRESET_COUNT = LOCATION_PRESETS.length;
