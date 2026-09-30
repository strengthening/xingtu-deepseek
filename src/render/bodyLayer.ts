/**
 * 太阳系天体渲染层。
 *
 * 只有 9 个天体，所以位置每帧在 CPU 上重算再写进属性缓冲，不进着色器算。
 * 片元着色器会把圆盘还原成球面法线，再和太阳方向做点积，
 * 因此**月相（以及金星的相位）是真正算出来的**，不是贴图。
 */

import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Points,
  ShaderMaterial,
  type IUniform,
} from 'three';

import { RAD } from '../astro/constants';
import { hexToLinearRgb } from './color';
import { writeGlslMat3 } from './glslUniforms';
import { BODY_FRAGMENT, BODY_VERTEX } from './shaders';
import type { Mat3, Vec3 } from '../astro/vec3';

export interface BodyRenderInput {
  key: string;
  colorHex: number;
  horizon: Vec3;
  /** 视直径（度） */
  angularDiameterDeg: number;
  /** 相位角（度）：太阳-天体-观测者 的夹角 */
  phaseAngleDeg: number;
  /** 亮边在地平切平面上的方向（东分量、北分量），已归一 */
  limbEast: number;
  limbNorth: number;
  /** 天体是否在地平线以上 */
  aboveHorizon: boolean;
  /** 视星等，用于调整亮度（很暗的行星会显得小一些） */
  magnitude: number;
}

export interface BodyUniforms {
  uHorizToCam: IUniform;
  uFovHalfTan: IUniform;
  uAspect: IUniform;
  uPixelRatio: IUniform;
}

const MAX_BODIES = 16;

export class BodyLayer {
  readonly group = new Group();
  readonly points: Points;

  private geometry: BufferGeometry;
  private material: ShaderMaterial;
  private uniforms: BodyUniforms;

  private positions = new Float32Array(MAX_BODIES * 3);
  private colors = new Float32Array(MAX_BODIES * 3);
  private sizes = new Float32Array(MAX_BODIES);
  private phases = new Float32Array(MAX_BODIES);
  private limbs = new Float32Array(MAX_BODIES * 2);

  /** 上一帧每个天体在屏幕上的像素半径，供标签避让使用 */
  private screenRadii = new Map<string, number>();

  constructor(pixelRatio: number) {
    this.uniforms = {
      uHorizToCam: { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
      uFovHalfTan: { value: 0.5 },
      uAspect: { value: 1 },
      uPixelRatio: { value: pixelRatio },
    };

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aBodyColor', new BufferAttribute(this.colors, 3));
    this.geometry.setAttribute('aBodySizePx', new BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('aPhaseAngle', new BufferAttribute(this.phases, 1));
    this.geometry.setAttribute('aLimbDir', new BufferAttribute(this.limbs, 2));
    this.geometry.setDrawRange(0, 0);

    this.material = new ShaderMaterial({
      vertexShader: BODY_VERTEX,
      fragmentShader: BODY_FRAGMENT,
      uniforms: this.uniforms as unknown as Record<string, IUniform>,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });

    this.points = new Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.group.add(this.points);
    this.group.renderOrder = 5;
  }

  setPixelRatio(ratio: number): void {
    this.uniforms.uPixelRatio.value = ratio;
  }

  /**
   * 更新天体几何。
   *
   * @param bodies        天体列表
   * @param pixelsPerUnit 立体投影平面单位 → 屏幕像素的换算系数
   * @param minSizePx     最小像素直径（保证行星可点选）
   */
  update(bodies: readonly BodyRenderInput[], pixelsPerUnit: number, minSizePx = 5): void {
    let n = 0;
    this.screenRadii.clear();

    for (const body of bodies) {
      if (n >= MAX_BODIES) break;

      const i = n++;
      this.positions[i * 3] = body.horizon.x;
      this.positions[i * 3 + 1] = body.horizon.y;
      this.positions[i * 3 + 2] = body.horizon.z;

      const [r, g, b] = hexToLinearRgb(body.colorHex);
      // 暗天体压暗一点，亮天体保留本色
      const gain = body.magnitude > 6 ? 0.75 : 1;
      this.colors[i * 3] = r * gain;
      this.colors[i * 3 + 1] = g * gain;
      this.colors[i * 3 + 2] = b * gain;

      const angularRad = body.angularDiameterDeg / RAD;
      const sizePx = Math.max(angularRad * pixelsPerUnit, minSizePx);
      this.sizes[i] = sizePx;
      this.screenRadii.set(body.key, sizePx / 2);

      this.phases[i] = body.phaseAngleDeg / RAD;
      this.limbs[i * 2] = body.limbEast;
      this.limbs[i * 2 + 1] = body.limbNorth;
    }

    this.geometry.setDrawRange(0, n);
    (this.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aBodyColor') as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aBodySizePx') as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aPhaseAngle') as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('aLimbDir') as BufferAttribute).needsUpdate = true;
  }

  screenRadiusOf(key: string): number {
    return this.screenRadii.get(key) ?? 0;
  }

  updateUniforms(horizToCam: Mat3, fovHalfTan: number, aspect: number): void {
    writeGlslMat3(this.uniforms.uHorizToCam.value as Float32Array, horizToCam);
    this.uniforms.uFovHalfTan.value = fovHalfTan;
    this.uniforms.uAspect.value = aspect;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
