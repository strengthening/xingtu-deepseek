/**
 * 星点渲染层。
 *
 * 每个已加载的二进制分块对应一个 `THREE.Points` 对象，共用同一个
 * `ShaderMaterial`。分块增删时增量地建 / 拆几何体，不整场重建。
 *
 * 顶点着色器里自己做立体投影，所以不参与 Three.js 的视锥剔除
 * （`frustumCulled = false`）—— 剔除由着色器里的地平线判断和
 * NDC 裁剪完成。
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Group,
  Points,
  ShaderMaterial,
  type IUniform,
} from 'three';

import type { StarChunk } from '../data/starCatalog';
import { STAR_FRAGMENT, STAR_VERTEX } from './shaders';

export interface StarFieldUniforms {
  uEquToHoriz: IUniform;
  uHorizToCam: IUniform;
  uDeltaYears: IUniform;
  uAberration: IUniform;
  uFovHalfTan: IUniform;
  uAspect: IUniform;
  uMagLimit: IUniform;
  uMagZero: IUniform;
  uSizeScale: IUniform;
  uMinSizePx: IUniform;
  uMaxSizePx: IUniform;
  uPixelRatio: IUniform;
  uHorizonFadeDeg: IUniform;
}

export class StarField {
  readonly group = new Group();

  private material: ShaderMaterial;
  private objects = new Map<string, Points>();
  private uniforms: StarFieldUniforms;

  constructor(pixelRatio: number) {
    this.uniforms = {
      uEquToHoriz: { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
      uHorizToCam: { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
      uDeltaYears: { value: 0 },
      uAberration: { value: new Float32Array([0, 0, 0]) },
      uFovHalfTan: { value: 0.5 },
      uAspect: { value: 1 },
      uMagLimit: { value: 8 },
      uMagZero: { value: 7 },
      uSizeScale: { value: 2.6 },
      uMinSizePx: { value: 0.9 },
      uMaxSizePx: { value: 26 },
      uPixelRatio: { value: pixelRatio },
      uHorizonFadeDeg: { value: 0.35 },
    };

    this.material = new ShaderMaterial({
      vertexShader: STAR_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      uniforms: this.uniforms as unknown as Record<string, IUniform>,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    this.group.renderOrder = 2;
    this.group.frustumCulled = false;
  }

  get materialUniforms(): StarFieldUniforms {
    return this.uniforms;
  }

  setPixelRatio(ratio: number): void {
    this.uniforms.uPixelRatio.value = ratio;
  }

  /** 让驻留分块与渲染对象对齐（增删都走这里） */
  sync(chunks: readonly StarChunk[]): void {
    const wanted = new Set<string>();

    for (const chunk of chunks) {
      wanted.add(chunk.key);
      if (this.objects.has(chunk.key)) continue;

      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(chunk.positions, 3));
      geometry.setAttribute('aMag', new BufferAttribute(chunk.magnitudes, 1));
      geometry.setAttribute('aColor', new BufferAttribute(chunk.colors, 4, true));
      geometry.setAttribute('aPM', new BufferAttribute(chunk.properMotion, 2));
      geometry.boundingSphere = null;

      const points = new Points(geometry, this.material);
      points.frustumCulled = false;
      points.renderOrder = 2;
      // 让 Three.js 的排序结果稳定：同一档内按天区号排
      points.name = chunk.key;

      this.objects.set(chunk.key, points);
      this.group.add(points);
    }

    for (const [key, points] of [...this.objects]) {
      if (wanted.has(key)) continue;
      this.group.remove(points);
      points.geometry.dispose();
      this.objects.delete(key);
    }
  }

  /** 当前渲染的星点总数 */
  get starCount(): number {
    let n = 0;
    for (const points of this.objects.values()) {
      const attr = points.geometry.getAttribute('position');
      n += attr.count;
    }
    return n;
  }

  get chunkCount(): number {
    return this.objects.size;
  }

  dispose(): void {
    for (const points of this.objects.values()) {
      this.group.remove(points);
      points.geometry.dispose();
    }
    this.objects.clear();
    this.material.dispose();
  }
}
