/**
 * 应用入口：装配状态、星表、渲染器与交互。
 */

import './styles.css';

import { StarCatalog } from './data/starCatalog';
import { SkyRenderer } from './render/skyRenderer';
import { dragToAngles, normalizeViewAngles } from './render/viewCamera';
import { computeSkyContext, horizonToEquatorial, type Viewport } from './skyContext';
import {
  AppState,
  clampFov,
  createInitialState,
  magnitudeLimitForFov,
  type AppStateShape,
} from './state';

const canvasElement = document.getElementById('sky-canvas');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingStatus = document.getElementById('loading-status');
const loadingBar = document.getElementById('loading-bar-fill');

if (!(canvasElement instanceof HTMLCanvasElement)) {
  throw new Error('找不到 #sky-canvas');
}
const canvas: HTMLCanvasElement = canvasElement;

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

/** 星等限：由视场角决定，并留一点余量给标签逻辑 */
function currentMagnitudeLimit(state: AppStateShape): number {
  return magnitudeLimitForFov(state.view.fovDeg);
}

async function boot(): Promise<void> {
  const state = new AppState(createInitialState());

  let renderer: SkyRenderer;
  try {
    renderer = new SkyRenderer(canvas);
  } catch (err) {
    setLoading(
      `无法初始化 WebGL：${err instanceof Error ? err.message : String(err)}。` +
        `请确认浏览器已启用硬件加速。`,
    );
    return;
  }

  const catalog = new StarCatalog('data/stars/');
  setLoading('读取星表清单…', 0.05);
  await catalog.load((message, fraction) => setLoading(message, 0.05 + fraction * 0.45));

  // 银河贴图是可选资源：拿不到就退化成没有银河，不影响其它功能
  setLoading('读取银河背景…', 0.55);
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
    /* 忽略：没有银河贴图也能跑 */
  }

  setLoading('准备渲染…', 0.9);

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
  window.addEventListener('resize', () => {
    measure();
    needsPlan = true;
  });

  // -------------------------------------------------------------------------
  // 选块调度
  // -------------------------------------------------------------------------

  let needsPlan = true;
  let lastPlanAt = 0;
  let magnitudeLimit = currentMagnitudeLimit(state.value);

  function refreshPlan(force = false): void {
    const now = performance.now();
    // 选块不必每帧做：视野没变时结果一样
    if (!force && now - lastPlanAt < 180) return;
    lastPlanAt = now;

    const ctx = computeSkyContext(state.value, viewport);
    const centerEqj = horizonToEquatorial(ctx, ctx.centerHorizon);
    const plan = catalog.plan(
      { centerEqj, fovDeg: ctx.fovDeg, aspect: ctx.aspect },
      ctx.equToHoriz,
    );
    catalog.apply(plan);

    magnitudeLimit = currentMagnitudeLimit(state.value);
    renderer.setMagnitudeLimit(magnitudeLimit);
  }

  catalog.onChunksChanged = () => {
    renderer.syncStars(catalog.residentChunksByTier(['A', 'B', 'C', 'D']));
  };

  refreshPlan(true);
  renderer.syncStars(catalog.residentChunksByTier(['A', 'B', 'C', 'D']));

  // -------------------------------------------------------------------------
  // 交互：拖拽转视角、滚轮缩放
  // -------------------------------------------------------------------------

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const activePointers = new Map<number, { x: number; y: number }>();
  let pinchDistance = 0;

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size === 1) {
      dragging = true;
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
        const scale = pinchDistance / dist;
        state.update({ view: { fovDeg: clampFov(state.value.view.fovDeg * scale) } });
        needsPlan = true;
      }
      pinchDistance = dist;
      return;
    }

    if (!dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;

    const { azimuthDeg, altitudeDeg } = state.value.view;
    const delta = dragToAngles(dx, dy, viewport.height, state.value.view.fovDeg, altitudeDeg);
    const next = normalizeViewAngles(azimuthDeg + delta.deltaAzimuthDeg, altitudeDeg + delta.deltaAltitudeDeg);
    state.update({ view: { azimuthDeg: next.azimuthDeg, altitudeDeg: next.altitudeDeg } });
    needsPlan = true;
  });

  function endPointer(event: PointerEvent): void {
    activePointers.delete(event.pointerId);
    if (activePointers.size === 0) {
      dragging = false;
      canvas.classList.remove('is-dragging');
    } else if (activePointers.size === 1) {
      const remaining = [...activePointers.values()][0]!;
      dragging = true;
      lastX = remaining.x;
      lastY = remaining.y;
    }
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  function pointerDistance(): number {
    const pts = [...activePointers.values()];
    if (pts.length < 2) return 0;
    const a = pts[0]!;
    const b = pts[1]!;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  canvas.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      // 向上滚 = 放大（视场角变小）
      const factor = Math.exp(event.deltaY * 0.0012);
      state.update({ view: { fovDeg: clampFov(state.value.view.fovDeg * factor) } });
      needsPlan = true;
    },
    { passive: false },
  );

  window.addEventListener('keydown', (event) => {
    if (event.key === ' ') {
      event.preventDefault();
      state.update({ time: { paused: !state.value.time.paused } });
    }
  });

  // -------------------------------------------------------------------------
  // 主循环
  // -------------------------------------------------------------------------

  let lastFrameAt = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;

  function frame(now: number): void {
    const dtMs = Math.min(now - lastFrameAt, 250);
    lastFrameAt = now;

    const current = state.value;
    if (!current.time.paused && current.time.rate !== 0) {
      state.update({ time: { epochMs: current.time.epochMs + dtMs * current.time.rate } });
    }

    refreshPlan(needsPlan);
    needsPlan = false;

    const ctx = computeSkyContext(state.value, viewport);
    const stats = renderer.render(ctx, state.value);

    fpsAccum += dtMs;
    fpsFrames++;
    if (fpsAccum > 500) {
      const fps = (fpsFrames * 1000) / fpsAccum;
      window.dispatchEvent(new CustomEvent('xingtu:stats', { detail: { ...stats, fps } }));
      fpsAccum = 0;
      fpsFrames = 0;
    }

    requestAnimationFrame(frame);
  }

  setLoading('完成', 1);
  hideLoading();
  requestAnimationFrame(frame);

  // 供调试与后续 UI 使用
  Object.assign(window as unknown as Record<string, unknown>, {
    __xingtu: { state, renderer, catalog },
  });
}

boot().catch((err: unknown) => {
  setLoading(`启动失败：${err instanceof Error ? err.message : String(err)}`);
  console.error(err);
});
