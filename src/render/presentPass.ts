/**
 * 最终呈现通道。
 *
 * 前面所有图层都渲染到一张 **HalfFloat 线性** 的 RenderTarget 上，
 * 这里做两件事：
 * 1. 色调映射（指数式 `1 − e^(−x·exposure)`），把 HDR 亮度压到 [0,1]；
 * 2. 线性 → sRGB 编码，写进画布。
 *
 * 之所以不在 sRGB 缓冲上直接加法混合星点：那样重叠的星芒会偏亮，
 * 亮度关系不再是物理的。
 */

import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  NoColorSpace,
  ShaderMaterial,
  type IUniform,
  type WebGLRenderTarget,
} from 'three';

import { PRESENT_FRAGMENT, PRESENT_VERTEX } from './shaders';

export interface PresentUniforms {
  uScene: IUniform;
  uExposure: IUniform;
}

function fullscreenQuad(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
  );
  geometry.setAttribute(
    'uv',
    new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2),
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

export class PresentPass {
  readonly mesh: Mesh;
  private material: ShaderMaterial;
  private uniforms: PresentUniforms;

  constructor() {
    this.uniforms = {
      uScene: { value: null },
      uExposure: { value: 1.0 },
    };
    this.material = new ShaderMaterial({
      vertexShader: PRESENT_VERTEX,
      fragmentShader: PRESENT_FRAGMENT,
      uniforms: this.uniforms as unknown as Record<string, IUniform>,
      depthTest: false,
      depthWrite: false,
      transparent: false,
    });
    this.mesh = new Mesh(fullscreenQuad(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1000;
  }

  setSource(target: WebGLRenderTarget): void {
    const texture = target.texture;
    texture.colorSpace = NoColorSpace; // 线性数据，编码交给这个通道
    this.uniforms.uScene.value = texture;
  }

  get exposure(): number {
    return this.uniforms.uExposure.value as number;
  }

  set exposure(value: number) {
    this.uniforms.uExposure.value = value;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
