/**
 * 渲染器总装。
 *
 * 一帧的流程：
 * ```
 * 背景（全屏三角形：银河 + 天光 + 地面）      renderOrder 0
 *   ↓ 同一个 RenderTarget（HalfFloat，线性）
 * 星点（每档每区块一个 Points）                renderOrder 2
 * 线段（星座 / 网格 / 地平线）                  renderOrder 3
 * 太阳系天体（带月相）                          renderOrder 5
 *   ↓
 * 最终呈现：色调映射 + 线性→sRGB                renderOrder 1000
 * ```
 *
 * 天空的投影由着色器自己完成（立体投影），所以这里的相机只是个
 * 覆盖 NDC 的正交相机，不参与几何变换。
 */

import {
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  NoColorSpace,
  OrthographicCamera,
  Scene,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';

import type { StarChunk } from '../data/starCatalog';
import type { AppStateShape } from '../state';
import { BackgroundLayer } from './backgroundLayer';
import { BodyLayer, type BodyRenderInput } from './bodyLayer';
import { LineLayer } from './lineLayer';
import { PresentPass } from './presentPass';
import { StarField } from './starField';
import { limbDirectionOf, type SkyContext } from '../skyContext';
import { writeGlslMat3 } from './glslUniforms';

/**
 * 天光从「物理相对通量」换到 HDR 缓冲里的曝光系数。
 * 暗夜天光（相对通量 1）映射到 0.010，屏幕上接近纯黑但保留一点夜色的层次。
 */
const SKY_EXPOSURE = 0.01;

/** HDR 缓冲里的天光上限。HalfFloat 上限 65504，这里远低于它，留足余量。 */
const SKY_HDR_LIMIT = 30;

export interface RendererStats {
  chunks: number;
  stars: number;
  segments: number;
  bodies: number;
  drawCalls: number;
}

export class SkyRenderer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();

  private camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private target: WebGLRenderTarget;
  private present: PresentPass;
  private background: BackgroundLayer;
  private starField: StarField;
  private lines: LineLayer;
  private bodyLayer: BodyLayer;

  private pixelRatio = 1;
  /** 复用缓冲，避免每帧分配 */
  private camToEquScratch = new Float64Array(9);

  private exposureValue = 1.0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.autoClear = true;

    this.target = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      colorSpace: NoColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
    });

    this.background = new BackgroundLayer();
    this.starField = new StarField(this.pixelRatio);
    this.lines = new LineLayer();
    this.bodyLayer = new BodyLayer(this.pixelRatio);
    this.present = new PresentPass();
    this.present.setSource(this.target);

    this.scene.add(this.background.mesh);
    this.scene.add(this.starField.group);
    this.scene.add(this.lines.group);
    this.scene.add(this.bodyLayer.group);
    this.scene.add(this.present.mesh);
  }

  get exposure(): number {
    return this.exposureValue;
  }

  set exposure(value: number) {
    this.exposureValue = value;
    this.present.exposure = value;
  }

  get milkyWayLoaded(): boolean {
    return this.background.hasMilkyWay;
  }

  async loadMilkyWay(url: string, uv: readonly [number, number]): Promise<boolean> {
    return this.background.loadMilkyWay(url, uv);
  }

  setMilkyWayEnabled(enabled: boolean): void {
    this.background.setMilkyWayEnabled(enabled);
  }

  setShowGround(show: boolean): void {
    this.background.setShowGround(show);
  }

  /** 更新绘图缓冲尺寸 */
  resize(width: number, height: number, pixelRatio: number): void {
    this.pixelRatio = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);

    const bufferWidth = Math.max(1, Math.floor(width * pixelRatio));
    const bufferHeight = Math.max(1, Math.floor(height * pixelRatio));
    this.target.setSize(bufferWidth, bufferHeight);

    this.starField.setPixelRatio(pixelRatio);
    this.bodyLayer.setPixelRatio(pixelRatio);
  }

  /** 与星表驻留分块对齐 */
  syncStars(chunks: readonly StarChunk[]): void {
    this.starField.sync(chunks);
  }

  get linesLayer(): LineLayer {
    return this.lines;
  }

  /** 渲染一帧 */
  render(ctx: SkyContext, state: AppStateShape): RendererStats {
    this.updateBackground(ctx, state);
    this.updateStarUniforms(ctx, state);
    this.updateLineUniforms(ctx);
    const bodyCount = this.updateBodies(ctx, state);

    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);

    const info = this.renderer.info;
    return {
      chunks: this.starField.chunkCount,
      stars: this.starField.starCount,
      segments: this.lines.visibleSegmentCount(),
      bodies: bodyCount,
      drawCalls: info.render.calls,
    };
  }

  private updateBackground(ctx: SkyContext, state: AppStateShape): void {
    const u = this.background.materialUniforms;
    u.uFovHalfTan.value = ctx.fovHalfTan;
    u.uAspect.value = ctx.aspect;
    writeGlslMat3(u.uCamToHoriz.value as Float32Array, ctx.camera.camToHoriz);
    // 相机 → 赤道 J2000 = (赤道→地平)ᵀ · (相机→地平)
    multiplyTransposeHoriz(ctx, this.camToEquScratch);
    writeGlslMat3(u.uCamToEqu.value as Float32Array, this.camToEquScratch);

    // ---- 天光三要素 ----
    // CPU 侧算的是「视线中心方向」的亮度（以暗夜天光为 1），
    // 着色器再叠加方向性（靠近月亮更亮、靠近地平线更亮）。
    const glow = ctx.skyGlow;
    const density = state.display.showAtmosphere ? state.display.atmosphereDensity : 0;
    const relative = Number.isFinite(glow.relativeFlux) ? glow.relativeFlux : 0;

    (u.uMoonDirHoriz.value as Float32Array).set([
      ctx.moon.horizon.x,
      ctx.moon.horizon.y,
      ctx.moon.horizon.z,
    ]);

    if (density <= 0) {
      // 大气浓度为 0 等价于太空视角：没有天光，也没有消光
      u.uSkyNight.value = 0;
      u.uSkyTwilight.value = 0;
      u.uSkyMoon.value = 0;
    } else {
      // ⚠️ 这里必须钳制，不能把物理亮度直接写进缓冲。
      //
      // 天光的动态范围极其夸张：暗夜天光约 21.9 mag/arcsec²，正午约 −6，
      // 相对通量差到 10^11 量级；而渲染目标是 HalfFloat，上限只有 65504。
      // 直接写进去会溢出成 Inf，再经色调映射变成 NaN，整片天空渲染成黑色
      // （而不是亮的），非常难从现象反推原因。
      //
      // 用「以暗夜天光为基准的比例 × 固定曝光」再夹到上限：
      // 暗夜 ≈ 0.010（屏幕上接近黑），满月 ≈ 0.36（灰蓝），
      // 暮光与白天迅速顶到上限，经色调映射后成为明亮的天空。
      u.uSkyNight.value = Math.min(relative, 3) * SKY_EXPOSURE;
      u.uSkyTwilight.value = Math.min(
        (glow.twilightFraction * relative) * SKY_EXPOSURE,
        SKY_HDR_LIMIT,
      );
      u.uSkyMoon.value = Math.min(
        (glow.moonFraction * relative) * SKY_EXPOSURE,
        SKY_HDR_LIMIT,
      );
    }

    this.background.setMilkyWayEnabled(state.display.showMilkyWay);
    this.background.setShowGround(state.display.showHorizon);
  }

  private updateStarUniforms(ctx: SkyContext, state: AppStateShape): void {
    const u = this.starField.materialUniforms;
    writeGlslMat3(u.uEquToHoriz.value as Float32Array, ctx.equToHoriz);
    writeGlslMat3(u.uHorizToCam.value as Float32Array, ctx.camera.horizToCam);
    (u.uAberration.value as Float32Array).set([
      ctx.velocityOverC.x,
      ctx.velocityOverC.y,
      ctx.velocityOverC.z,
    ]);
    u.uDeltaYears.value = ctx.deltaYears;
    u.uFovHalfTan.value = ctx.fovHalfTan;
    u.uAspect.value = ctx.aspect;

    const magLimit = state.display.showStarLabels
      ? // 标签开启时星等限由 UI 决定，这里交给调用方设置
        (u.uMagLimit.value as number)
      : (u.uMagLimit.value as number);
    u.uMagLimit.value = magLimit;

    // 视场越小星点越大（但增长有上限，避免放大后糊成一团光斑）
    const zoomGrowth = Math.min(Math.max(70 / Math.max(ctx.fovDeg, 0.05), 1), 4);
    u.uSizeScale.value = 2.4 * Math.pow(zoomGrowth, 0.55);
    u.uMinSizePx.value = 0.85;
    u.uMaxSizePx.value = 30;

    // 地平线以下的淡出带：有大气时更软一点，像有雾
    const density = state.display.showAtmosphere ? state.display.atmosphereDensity : 0;
    u.uHorizonFadeDeg.value = 0.25 + density * 1.2;
  }

  private updateLineUniforms(ctx: SkyContext): void {
    this.lines.updateUniforms(ctx.equToHoriz, ctx.camera.horizToCam, ctx.fovHalfTan, ctx.aspect);
  }

  private updateBodies(ctx: SkyContext, state: AppStateShape): number {
    this.bodyLayer.setVisible(state.display.showSolarSystem);
    if (!state.display.showSolarSystem) return 0;

    const inputs: BodyRenderInput[] = [];
    for (const body of ctx.bodies) {
      const limb = limbDirectionOf(body, ctx.sun);
      inputs.push({
        key: body.key,
        colorHex: body.color,
        horizon: body.horizon,
        angularDiameterDeg: body.angularDiameterDeg,
        phaseAngleDeg: body.phaseAngleDeg,
        limbEast: limb.east,
        limbNorth: limb.north,
        aboveHorizon: body.altitudeDeg > -2,
        magnitude: body.magnitude,
      });
    }
    this.bodyLayer.update(inputs, ctx.pixelsPerProjectionUnit, state.display.showSolarSystem ? 5 : 4);
    this.bodyLayer.updateUniforms(ctx.camera.horizToCam, ctx.fovHalfTan, ctx.aspect);
    return inputs.length;
  }

  /** 手动设置星等限（由 LOD 逻辑决定） */
  setMagnitudeLimit(limit: number): void {
    this.starField.materialUniforms.uMagLimit.value = limit;
  }

  dispose(): void {
    this.background.dispose();
    this.starField.dispose();
    this.lines.dispose();
    this.bodyLayer.dispose();
    this.present.dispose();
    this.target.dispose();
    this.renderer.dispose();
  }
}

/**
 * 相机 → 赤道 J2000 = (赤道→地平)ᵀ · (相机→地平)。
 *
 * 两项都是行主序，结果也按行主序写进 `out`。
 */
function multiplyTransposeHoriz(ctx: SkyContext, out: Float64Array): void {
  const e = ctx.equToHoriz;
  const c = ctx.camera.camToHoriz;
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) {
        // et[r][k] = e[k][r]
        sum += e[k * 3 + r]! * c[k * 3 + col]!;
      }
      out[r * 3 + col] = sum;
    }
  }
}
