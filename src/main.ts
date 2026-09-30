/**
 * 应用入口：装配状态、数据、渲染器、UI 与交互。
 *
 * 这里只做「编排」：具体天文计算在 `astro/`、数据解析在 `data/`、
 * 绘制在 `render/`、控件在 `ui/`。
 */

import './styles.css';

import { loadConstellations, type LoadedConstellationGroup } from './data/constellations';
import { StarCatalog } from './data/starCatalog';
import { SkyRenderer } from './render/skyRenderer';
import {
  buildCompassTicks,
  buildEquatorialGrid,
  buildHorizonLine,
  buildHorizontalGrid,
} from './render/grids';
import { pickObjects } from './render/picking';
import { dragToAngles, normalizeViewAngles, unprojectFromNdc } from './render/viewCamera';
import {
  computeSkyContext,
  horizonToEquatorial,
  type SkyContext,
  type Viewport,
} from './skyContext';
import { ControlPanel } from './ui/controls';
import { formatMagnitude, formatRate, formatZonedDateTime } from './ui/format';
import { InfoCard } from './ui/infoCard';
import { LabelLayer } from './ui/labelLayer';
import { copyShareLink, readStateFromUrl, syncUrl } from './url';
import {
  AppState,
  clampFov,
  createInitialState,
  findPreset,
  magnitudeLimitForFov,
  type AppStateShape,
} from './state';

const canvasElement = document.getElementById('sky-canvas');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingStatus = document.getElementById('loading-status');
const loadingBar = document.getElementById('loading-bar-fill');
const labelLayerElement = document.getElementById('label-layer');
const uiRoot = document.getElementById('ui-root');

if (!(canvasElement instanceof HTMLCanvasElement)) throw new Error('找不到 #sky-canvas');
if (!labelLayerElement || !uiRoot) throw new Error('缺少 UI 容器');
const canvas: HTMLCanvasElement = canvasElement;
// 收窄成非空常量，闭包里才好用
const labelRoot: HTMLElement = labelLayerElement;
const overlayRoot: HTMLElement = uiRoot;

function setLoading(message: string, fraction?: number): void {
  if (loadingStatus) loadingStatus.textContent = message;
  if (loadingBar && fraction !== undefined) {
    loadingBar.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
  }
}

function hideLoading(): void {
  if (!loadingOverlay) return;
  loadingOverlay.classList.add('is-hidden');
  window.setTimeout(() => loadingOverlay.remove(), 600);
}

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

interface Hud {
  element: HTMLElement;
  location: HTMLElement;
  time: HTMLElement;
  stats: HTMLElement;
  notice: HTMLElement;
}

function buildHud(): Hud {
  const location = el('div', { class: 'hud-line hud-line--strong' });
  const time = el('div', { class: 'hud-line' });
  const stats = el('div', { class: 'hud-line hud-line--dim' });
  const notice = el('div', { class: 'hud-notice' });
  notice.style.display = 'none';
  const element = el('div', { class: 'panel hud' }, [location, time, stats, notice]);
  return { element, location, time, stats, notice };
}

async function boot(): Promise<void> {
  // URL 参数优先，其余用默认值
  const initial = { ...createInitialState(), ...readStateFromUrl(window.location.search) };
  const state = new AppState(initial);

  let renderer: SkyRenderer;
  try {
    renderer = new SkyRenderer(canvas);
  } catch (err) {
    setLoading(
      `无法初始化 WebGL：${err instanceof Error ? err.message : String(err)}。请确认浏览器已启用硬件加速。`,
    );
    return;
  }

  // -------------------------------------------------------------------------
  // 数据加载
  // -------------------------------------------------------------------------

  const catalog = new StarCatalog('data/stars/');
  setLoading('读取星表清单…', 0.05);
  await catalog.load((message, fraction) => setLoading(message, 0.05 + fraction * 0.4));

  setLoading('读取银河背景…', 0.5);
  try {
    const metaRes = await fetch('data/milkyway/meta.json');
    if (metaRes.ok) {
      const meta = (await metaRes.json()) as {
        image: { file: string };
        mapping: { uOffset: number; uSign: number };
      };
      await renderer.loadMilkyWay(`data/milkyway/${meta.image.file}`, [
        meta.mapping.uOffset,
        meta.mapping.uSign,
      ]);
    }
  } catch {
    /* 银河贴图是可选的 */
  }

  setLoading('读取星座连线…', 0.65);
  let constellationGroups: LoadedConstellationGroup[] = [];
  let constellationErrors: string[] = [];
  try {
    const result = await loadConstellations('data/constellations/');
    constellationGroups = result.groups;
    constellationErrors = result.errors;
  } catch (err) {
    constellationErrors = [err instanceof Error ? err.message : String(err)];
  }

  // 中文星名（可选）
  let chineseNames: Map<number, string> | null = null;
  try {
    const res = await fetch('data/constellations/chinese-star-names.json');
    if (res.ok) {
      const raw = (await res.json()) as Record<string, string>;
      chineseNames = new Map(Object.entries(raw).map(([k, v]) => [Number(k), v]));
    }
  } catch {
    chineseNames = null;
  }

  // -------------------------------------------------------------------------
  // 线图层
  // -------------------------------------------------------------------------

  const lines = renderer.linesLayer;
  lines.setLayer('eq-grid', buildEquatorialGrid(15, 15), {
    color: 0x3f6f9f,
    opacity: 0.34,
    frame: 'eqj',
    renderOrder: 3,
    visible: initial.display.showEquatorialGrid,
  });
  lines.setLayer('hor-grid', buildHorizontalGrid(10, 15), {
    color: 0x4f8f7f,
    opacity: 0.3,
    frame: 'hor',
    renderOrder: 3,
    visible: initial.display.showHorizontalGrid,
  });
  lines.setLayer('horizon', buildHorizonLine(), {
    color: 0x9fbfe0,
    opacity: 0.65,
    frame: 'hor',
    renderOrder: 4,
    visible: initial.display.showHorizon,
  });
  lines.setLayer('compass-ticks', buildCompassTicks(), {
    color: 0x7fa8d0,
    opacity: 0.5,
    frame: 'hor',
    renderOrder: 4,
    visible: initial.display.showHorizon,
  });

  for (const group of constellationGroups) {
    const isWestern = group.id === 'western';
    lines.setLayer(`constellation-${group.id}`, group.polylines, {
      color: isWestern ? 0x5f7fa8 : 0xc79a5f,
      opacity: isWestern ? 0.55 : 0.5,
      frame: 'eqj',
      renderOrder: 3,
      visible: isWestern
        ? initial.display.showWesternConstellations
        : initial.display.showChineseConstellations,
    });
  }

  // -------------------------------------------------------------------------
  // 视口与选块调度
  // -------------------------------------------------------------------------

  let viewport: Viewport = { width: 1, height: 1, pixelRatio: 1 };

  function measure(): void {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    viewport = { width, height, pixelRatio };
    renderer.resize(width, height, pixelRatio);
  }

  measure();

  const labels = new LabelLayer(labelRoot);
  labels.setChineseNames(chineseNames);

  let needsPlan = true;
  let lastPlanAt = 0;
  let currentCtx: SkyContext = computeSkyContext(state.value, viewport);

  function refreshPlan(force = false): void {
    const now = performance.now();
    if (!force && now - lastPlanAt < 150) return;
    lastPlanAt = now;

    currentCtx = computeSkyContext(state.value, viewport);
    const centerEqj = horizonToEquatorial(currentCtx, currentCtx.centerHorizon);
    const plan = catalog.plan(
      { centerEqj, fovDeg: currentCtx.fovDeg, aspect: currentCtx.aspect },
      currentCtx.equToHoriz,
    );
    catalog.apply(plan);
    renderer.setMagnitudeLimit(magnitudeLimitForFov(state.value.view.fovDeg));
  }

  catalog.onChunksChanged = () => {
    renderer.syncStars(catalog.residentChunksByTier(['A', 'B', 'C', 'D']));
    labels.invalidate();
  };

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------

  const infoCard = new InfoCard();
  const hud = buildHud();

  let urlTimer = 0;
  function scheduleUrlSync(): void {
    window.clearTimeout(urlTimer);
    urlTimer = window.setTimeout(() => syncUrl(state.value), 400);
  }

  let noticeTimer = 0;
  function showNotice(text: string, durationMs = 3200): void {
    hud.notice.textContent = text;
    hud.notice.style.display = '';
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      hud.notice.style.display = 'none';
    }, durationMs);
  }

  const controlPanel = new ControlPanel(state, {
    onLocationChange: (locationId) => {
      const preset = findPreset(locationId);
      state.update({
        observer: {
          locationId: preset.id,
          locationName: preset.name,
          latitudeDeg: preset.latitudeDeg,
          longitudeDeg: preset.longitudeDeg,
          heightM: preset.heightM,
          timeZone: preset.timeZone,
        },
      });
      needsPlan = true;
      scheduleUrlSync();
    },
    onTimeChange: (epochMs) => {
      state.update({ time: { epochMs } });
      needsPlan = true;
      scheduleUrlSync();
    },
    onNow: () => {
      state.update({ time: { epochMs: Date.now() } });
      needsPlan = true;
      scheduleUrlSync();
    },
    onResetView: () => {
      state.update({ view: { azimuthDeg: 180, altitudeDeg: 40, fovDeg: 70 } });
      needsPlan = true;
      scheduleUrlSync();
    },
    onShare: () => {
      void copyShareLink(state.value).then((ok) => {
        showNotice(ok ? '分享链接已复制到剪贴板' : '已弹出分享链接');
      });
    },
  });

  overlayRoot.append(controlPanel.element, hud.element, infoCard.element);
  overlayRoot.appendChild(
    el('div', { class: 'hint-bar' }, [
      el('span', {}, ['拖拽转视角 · 滚轮缩放 · 单击天体查看信息 · 空格暂停时间 · N 回到现在']),
    ]),
  );

  // 数据署名：PROMPT 要求在网页页脚注明各数据来源与许可证。
  // 星表与星座连线都是 CC BY-SA 4.0（署名 + 相同方式共享），
  // 银河全景是 All rights reserved（署名 + 仅限非商业用途），
  // 所以这块不是装饰，是许可证义务。默认收起，避免遮挡星空。
  const footerDetails = el('div', { class: 'data-footer-details' }, [
    el('div', { class: 'data-footer-row' }, [
      el('span', { class: 'data-footer-key' }, ['恒星与自行']),
      el('span', {}, [
        'AT-HYG v3.2 © David Nash，CC BY-SA 4.0（上游：Tycho-2 / Hipparcos-2 / Gaia DR3）',
      ]),
    ]),
    el('div', { class: 'data-footer-row' }, [
      el('span', { class: 'data-footer-key' }, ['星座与星名']),
      el('span', {}, ['Stellarium skycultures，CC BY-SA 4.0']),
    ]),
    el('div', { class: 'data-footer-row' }, [
      el('span', { class: 'data-footer-key' }, ['银河全景']),
      el('span', {}, [
        '© 2000-2017 Axel Mellinger，All rights reserved；经 CDS HiPS CDS/P/Mellinger/color 重投影，仅限非商业教育 / 演示用途',
      ]),
    ]),
    el('div', { class: 'data-footer-row' }, [
      el('span', { class: 'data-footer-key' }, ['其他']),
      el('span', {}, ['astronomy-engine (MIT) · Three.js (MIT) · 本项目代码 MIT']),
    ]),
  ]);
  footerDetails.style.display = 'none';

  const footerToggle = el('button', { class: 'data-footer-toggle', type: 'button' }, [
    '数据来源与许可证',
  ]);
  const dataFooter = el('div', { class: 'data-footer' }, [footerToggle, footerDetails]);
  footerToggle.addEventListener('click', () => {
    const open = footerDetails.style.display !== 'none';
    footerDetails.style.display = open ? 'none' : '';
    dataFooter.classList.toggle('is-open', !open);
  });
  overlayRoot.appendChild(dataFooter);

  if (constellationErrors.length > 0) {
    showNotice(`星座连线未加载：${constellationErrors[0]}`, 9000);
  }

  // 默认观测时刻是「当前时间」（PROMPT 要求）。如果此刻正好是白天，
  // 打开后会看到一片明亮的天空 —— 这是正确的物理结果，但很容易被误认为
  // 「星星没渲染出来」。所以白天启动时主动提示一句怎么看到星空。
  window.setTimeout(() => {
    const sunAltitude = currentCtx.sun.altitudeDeg;
    if (sunAltitude > -2) {
      showNotice(
        `现在是白天，太阳高度 ${sunAltitude.toFixed(0)}°，天空被天光盖住了。` +
          `把「时间流速」调到 1 时/秒，或直接改观测时刻，就能看到星空。`,
        11000,
      );
    }
  }, 1400);

  // 状态 → 图层可见性
  state.subscribe((next) => {
    lines.setVisible('eq-grid', next.display.showEquatorialGrid);
    lines.setVisible('hor-grid', next.display.showHorizontalGrid);
    lines.setVisible('horizon', next.display.showHorizon);
    lines.setVisible('compass-ticks', next.display.showHorizon);
    lines.setVisible('constellation-western', next.display.showWesternConstellations);
    lines.setVisible('constellation-chinese', next.display.showChineseConstellations);
  });

  // -------------------------------------------------------------------------
  // 交互
  // -------------------------------------------------------------------------

  let dragging = false;
  let dragMoved = 0;
  let lastX = 0;
  let lastY = 0;
  const activePointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;

  canvas.addEventListener('pointerdown', (event) => {
    // 合成事件（自动化测试）可能带一个不存在的 pointerId，捕获会抛异常
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* 忽略：非真实指针事件 */
    }
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size === 1) {
      dragging = true;
      dragMoved = 0;
      lastX = event.clientX;
      lastY = event.clientY;
    } else if (activePointers.size === 2) {
      dragging = false;
      pinchDistance = pointerDistance();
    }
    canvas.classList.add('is-dragging');
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!activePointers.has(event.pointerId)) return;
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointers.size >= 2) {
      const dist = pointerDistance();
      if (pinchDistance > 0 && dist > 0) {
        state.update({
          view: { fovDeg: clampFov(state.value.view.fovDeg * (pinchDistance / dist)) },
        });
        needsPlan = true;
        scheduleUrlSync();
      }
      pinchDistance = dist;
      return;
    }

    if (!dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    dragMoved += Math.hypot(dx, dy);

    const { azimuthDeg, altitudeDeg } = state.value.view;
    const delta = dragToAngles(dx, dy, viewport.height, state.value.view.fovDeg, altitudeDeg);
    const next = normalizeViewAngles(
      azimuthDeg + delta.deltaAzimuthDeg,
      altitudeDeg + delta.deltaAltitudeDeg,
    );
    state.update({ view: { azimuthDeg: next.azimuthDeg, altitudeDeg: next.altitudeDeg } });
    needsPlan = true;
    scheduleUrlSync();
  });

  function pointerDistance(): number {
    const pts = [...activePointers.values()];
    if (pts.length < 2) return 0;
    const a = pts[0]!;
    const b = pts[1]!;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function endPointer(event: PointerEvent): void {
    activePointers.delete(event.pointerId);
    if (activePointers.size === 0) {
      canvas.classList.remove('is-dragging');
      // 位移很小才算点击，避免拖完视角后误触发点选
      if (dragging && dragMoved < 5) handleClick(event.clientX, event.clientY);
      dragging = false;
    } else if (activePointers.size === 1) {
      const remaining = [...activePointers.values()][0]!;
      dragging = true;
      lastX = remaining.x;
      lastY = remaining.y;
    }
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', (event) => {
    activePointers.delete(event.pointerId);
    if (activePointers.size === 0) {
      dragging = false;
      canvas.classList.remove('is-dragging');
    }
  });

  function handleClick(clientX: number, clientY: number): void {
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;

    const dirHorizon = unprojectFromNdc(
      ndcX,
      ndcY,
      currentCtx.camera,
      currentCtx.fovDeg,
      currentCtx.aspect,
    );
    if (dirHorizon.z < -0.02) {
      infoCard.hide();
      return;
    }
    const dirEqj = horizonToEquatorial(currentCtx, dirHorizon);

    const { pick } = pickObjects(
      catalog.residentChunksByTier(['A', 'B', 'C', 'D']),
      currentCtx.bodies,
      dirEqj,
      dirHorizon,
      currentCtx.fovDeg,
      catalog,
    );

    if (!pick) {
      infoCard.hide();
      return;
    }
    if (pick.kind === 'body') infoCard.showBody(pick, currentCtx);
    else infoCard.showStar(pick, currentCtx, catalog, { chineseNames });
  }

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const factor = Math.exp(event.deltaY * 0.0012);
      state.update({ view: { fovDeg: clampFov(state.value.view.fovDeg * factor) } });
      needsPlan = true;
      scheduleUrlSync();
    },
    { passive: false },
  );

  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;

    switch (event.key) {
      case ' ':
        event.preventDefault();
        state.update({ time: { paused: !state.value.time.paused } });
        break;
      case 'Escape':
        infoCard.hide();
        break;
      case 'n':
      case 'N':
        state.update({ time: { epochMs: Date.now() } });
        needsPlan = true;
        break;
      case 'c':
      case 'C':
        state.update({
          display: { showWesternConstellations: !state.value.display.showWesternConstellations },
        });
        break;
      case 'g':
      case 'G':
        state.update({ display: { showEquatorialGrid: !state.value.display.showEquatorialGrid } });
        break;
      case 'h':
      case 'H':
        state.update({ display: { showHorizontalGrid: !state.value.display.showHorizontalGrid } });
        break;
      case 'l':
      case 'L':
        state.update({ display: { showStarLabels: !state.value.display.showStarLabels } });
        break;
      default:
        break;
    }
  });

  window.addEventListener('resize', () => {
    measure();
    needsPlan = true;
  });

  // -------------------------------------------------------------------------
  // 主循环
  // -------------------------------------------------------------------------

  let lastFrameAt = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fps = 0;

  function frame(now: number): void {
    const dtMs = Math.min(now - lastFrameAt, 250);
    lastFrameAt = now;

    const current = state.value;
    if (!current.time.paused && current.time.rate !== 0) {
      state.update({ time: { epochMs: current.time.epochMs + dtMs * current.time.rate } });
      // 时间快速流动时天球会转，选块需要跟着更新
      if (Math.abs(current.time.rate) > 3600) needsPlan = true;
    }

    refreshPlan(needsPlan);
    needsPlan = false;

    currentCtx = computeSkyContext(state.value, viewport);
    const chunks = catalog.residentChunksByTier(['A', 'B', 'C', 'D']);
    const stats = renderer.render(currentCtx, state.value);

    labels.update(currentCtx, state.value, chunks, catalog, now);

    fpsAccum += dtMs;
    fpsFrames++;
    if (fpsAccum >= 500) {
      fps = (fpsFrames * 1000) / fpsAccum;
      fpsAccum = 0;
      fpsFrames = 0;
    }

    const preset = findPreset(state.value.observer.locationId);
    hud.location.textContent = `${preset.name} · ${preset.latitudeDeg.toFixed(2)}°, ${preset.longitudeDeg.toFixed(2)}°`;
    hud.time.textContent =
      `${formatZonedDateTime(currentCtx.date, preset.timeZone)}` +
      `${state.value.time.paused ? ' · 已暂停' : ` · ${formatRate(state.value.time.rate)}`}`;
    hud.stats.textContent =
      `视场 ${state.value.view.fovDeg < 10 ? state.value.view.fovDeg.toFixed(2) : state.value.view.fovDeg.toFixed(1)}°` +
      ` · 显示至 ${formatMagnitude(magnitudeLimitForFov(state.value.view.fovDeg))}` +
      ` · 已载入 ${stats.stars.toLocaleString()} / ${catalog.totalStars.toLocaleString()} 颗` +
      ` · ${stats.chunks} 块 · ${fps.toFixed(0)} FPS`;

    requestAnimationFrame(frame);
  }

  setLoading('完成', 1);
  hideLoading();
  requestAnimationFrame(frame);

  Object.assign(window as unknown as Record<string, unknown>, {
    __xingtu: { state, renderer, catalog, lines, labels, infoCard, ctx: () => currentCtx },
  });
}

boot().catch((err: unknown) => {
  setLoading(`启动失败：${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
});

/** 让类型检查确认导出被引用（供将来的模块使用） */
export type { AppStateShape };
