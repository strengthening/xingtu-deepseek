/**
 * 天空背景层：银河 + 天光 + 地面。
 *
 * 用一个**全屏三角形**覆盖整个画面，片元着色器按立体投影的**反解**
 * 逐像素算出该像素对应的天球方向，然后合成：
 *
 * 1. 银河：按赤道 J2000 方向采样等距圆柱贴图（贴图本身就是赤道系的，
 *    见 `scripts/build-hips.ts`）；
 * 2. 天光：暗夜 + 暮光 + 月光三项，月光项带「越靠近月亮越亮」的散射角分布；
 * 3. 地面：地平线以下填地面色，接缝处做软过渡。
 */

import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  NoColorSpace,
  ShaderMaterial,
  Texture,
  TextureLoader,
  type IUniform,
} from 'three';

import { BACKGROUND_FRAGMENT, BACKGROUND_VERTEX } from './shaders';

export interface BackgroundUniforms {
  uFovHalfTan: IUniform;
  uAspect: IUniform;
  uCamToHoriz: IUniform;
  uCamToEqu: IUniform;
  uMilkyWay: IUniform;
  uHasMilkyWay: IUniform;
  uMilkyWayStrength: IUniform;
  uMilkyWayUv: IUniform;
  uNightColor: IUniform;
  uTwilightColor: IUniform;
  uMoonColor: IUniform;
  uSkyNight: IUniform;
  uSkyTwilight: IUniform;
  uSkyMoon: IUniform;
  uMoonDirHoriz: IUniform;
  uGroundColor: IUniform;
  uGroundGlowColor: IUniform;
  uShowGround: IUniform;
}

function fullscreenTriangle(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  return geometry;
}

export class BackgroundLayer {
  readonly mesh: Mesh;
  private material: ShaderMaterial;
  private uniforms: BackgroundUniforms;
  private milkyWayTexture: Texture | null = null;

  constructor() {
    this.uniforms = {
      uFovHalfTan: { value: 0.5 },
      uAspect: { value: 1 },
      uCamToHoriz: { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
      uCamToEqu: { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
      uMilkyWay: { value: null },
      uHasMilkyWay: { value: 0 },
      uMilkyWayStrength: { value: 0.85 },
      uMilkyWayUv: { value: new Float32Array([0.5, -1]) },
      uNightColor: { value: new Float32Array([0.3, 0.42, 0.68]) },
      uTwilightColor: { value: new Float32Array([0.55, 0.58, 0.85]) },
      uMoonColor: { value: new Float32Array([0.72, 0.8, 0.98]) },
      uSkyNight: { value: 0.02 },
      uSkyTwilight: { value: 0 },
      uSkyMoon: { value: 0 },
      uMoonDirHoriz: { value: new Float32Array([0, 0, 0]) },
      // 地面：接近纯黑，带一点冷色，靠近地平线略亮
      uGroundColor: { value: new Float32Array([0.012, 0.014, 0.02]) },
      uGroundGlowColor: { value: new Float32Array([0.03, 0.034, 0.048]) },
      uShowGround: { value: 1 },
    };

    this.material = new ShaderMaterial({
      vertexShader: BACKGROUND_VERTEX,
      fragmentShader: BACKGROUND_FRAGMENT,
      uniforms: this.uniforms as unknown as Record<string, IUniform>,
      depthTest: false,
      depthWrite: false,
    });

    this.mesh = new Mesh(fullscreenTriangle(), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 0;
  }

  get materialUniforms(): BackgroundUniforms {
    return this.uniforms;
  }

  /**
   * 加载银河贴图；失败时静默降级为「没有银河」，不影响其它功能。
   *
   * ⚠️ 贴图在经度方向是**环绕**的（u 从 0 到 1 接回 0），而等距圆柱贴图
   * 的左右边缘在真实天空里是同一条经线。如果直接用 `RepeatWrapping`，
   * 生成 mipmap 时会把左右边缘当成不相关的像素去做平均，结果在接缝处
   * 留下一条明显的竖直亮线/暗线。
   *
   * 解决办法是**给贴图左右各补一圈来自对侧的像素**，然后改用
   * `ClampToEdgeWrapping`，并把 u 的映射压缩回中间那段。
   */
  async loadMilkyWay(url: string, uv: readonly [number, number]): Promise<boolean> {
    try {
      const loaded = await new TextureLoader().loadAsync(url);
      const source = loaded.image as CanvasImageSource & { width?: number; height?: number };

      const width = Number(source.width ?? 0);
      const height = Number(source.height ?? 0);
      let texture: Texture = loaded;
      let offset = uv[0];
      let sign = uv[1];

      if (width > 0 && height > 0) {
        const pad = Math.max(8, Math.round(width / 32));
        const canvas = document.createElement('canvas');
        canvas.width = width + pad * 2;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          // 左侧补丁 = 原图最右一列，右侧补丁 = 原图最左一列
          ctx.drawImage(source, width - pad, 0, pad, height, 0, 0, pad, height);
          ctx.drawImage(source, 0, 0, width, height, pad, 0, width, height);
          ctx.drawImage(source, 0, 0, pad, height, pad + width, 0, pad, height);

          const padded = new Texture(canvas);
          padded.needsUpdate = true;
          texture = padded;

          // u 原值域 [0,1] 现在只对应 [pad, pad+width] 这一段
          const scale = width / (width + pad * 2);
          const shift = pad / (width + pad * 2);
          offset = uv[0] * scale + shift;
          sign = uv[1] * scale;
        }
        loaded.dispose();
      }

      texture.colorSpace = NoColorSpace; // 着色器里自己按 sRGB 解码
      texture.wrapS = ClampToEdgeWrapping; // 已经补过边，不需要环绕了
      texture.wrapT = ClampToEdgeWrapping;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.magFilter = LinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = 4;
      texture.needsUpdate = true;

      this.milkyWayTexture?.dispose();
      this.milkyWayTexture = texture;
      this.uniforms.uMilkyWay.value = texture;
      this.uniforms.uHasMilkyWay.value = 1;
      (this.uniforms.uMilkyWayUv.value as Float32Array)[0] = offset;
      (this.uniforms.uMilkyWayUv.value as Float32Array)[1] = sign;
      return true;
    } catch {
      this.uniforms.uHasMilkyWay.value = 0;
      return false;
    }
  }

  setMilkyWayEnabled(enabled: boolean): void {
    this.uniforms.uHasMilkyWay.value = enabled && this.milkyWayTexture ? 1 : 0;
  }

  get hasMilkyWay(): boolean {
    return this.milkyWayTexture !== null;
  }

  setShowGround(show: boolean): void {
    this.uniforms.uShowGround.value = show ? 1 : 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.milkyWayTexture?.dispose();
  }
}
