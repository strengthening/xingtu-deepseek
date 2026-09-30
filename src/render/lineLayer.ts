/**
 * 线段渲染层。
 *
 * 星座连线、赤道网格、地平网格、地平线都走这一层：几何都是一串
 * 球面折线，按**大圆**细分后变成线段对，投影方式与星点完全一致。
 *
 * 折线必须先细分：直接把两个端点连成三维直线会穿进球体内部，
 * 在立体投影下看起来是「抄近路」的弦，而不是贴在天球上的弧。
 */

import {
  BufferAttribute,
  BufferGeometry,
  Group,
  LineSegments,
  NormalBlending,
  ShaderMaterial,
  type IUniform,
} from 'three';

import { clamp, dot, normalize, type Mat3, type Vec3 } from '../astro/vec3';
import { hexToLinearRgb } from './color';
import { IDENTITY_MAT3, writeGlslMat3 } from './glslUniforms';
import { LINE_FRAGMENT, LINE_VERTEX } from './shaders';

export interface Polyline {
  points: readonly Vec3[];
  closed?: boolean;
}

/** 折线的坐标属于哪个参考系 */
export type LineSourceFrame = 'eqj' | 'hor';

/** 球面线性插值 */
function slerp(a: Vec3, b: Vec3, t: number): Vec3 {
  const d = clamp(dot(a, b), -1, 1);
  const theta = Math.acos(d);
  if (theta < 1e-6) return a;
  const sinTheta = Math.sin(theta);
  const w1 = Math.sin((1 - t) * theta) / sinTheta;
  const w2 = Math.sin(t * theta) / sinTheta;
  return normalize({
    x: a.x * w1 + b.x * w2,
    y: a.y * w1 + b.y * w2,
    z: a.z * w1 + b.z * w2,
  });
}

/**
 * 把球面折线展开成 `LineSegments` 需要的顶点对。
 *
 * @param maxStepRad 单段最大角长（弧度）。越小越贴合大圆，顶点也越多。
 */
export function buildLineSegmentPositions(
  polylines: readonly Polyline[],
  maxStepRad = 0.018,
): Float32Array {
  const out: number[] = [];

  for (const line of polylines) {
    const pts = line.points;
    const n = pts.length;
    if (n < 2) continue;
    const segmentCount = line.closed ? n : n - 1;

    for (let i = 0; i < segmentCount; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % n]!;
      const angle = Math.acos(clamp(dot(a, b), -1, 1));
      if (angle < 1e-7) continue;
      const steps = Math.max(1, Math.ceil(angle / maxStepRad));

      let prevX = a.x;
      let prevY = a.y;
      let prevZ = a.z;
      for (let s = 1; s <= steps; s++) {
        const cur = s === steps ? b : slerp(a, b, s / steps);
        out.push(prevX, prevY, prevZ, cur.x, cur.y, cur.z);
        prevX = cur.x;
        prevY = cur.y;
        prevZ = cur.z;
      }
    }
  }

  return new Float32Array(out);
}

/** 生成一条等高度角圆（地平线、方位刻度圈等） */
export function altitudeCircle(altitudeDeg: number, steps = 360): Polyline {
  const alt = (altitudeDeg * Math.PI) / 180;
  const cosAlt = Math.cos(alt);
  const sinAlt = Math.sin(alt);
  const points: Vec3[] = [];
  for (let i = 0; i < steps; i++) {
    const az = (i / steps) * Math.PI * 2;
    // HOR：x=北, y=西, z=天顶
    points.push({ x: cosAlt * Math.cos(az), y: -cosAlt * Math.sin(az), z: sinAlt });
  }
  return { points, closed: true };
}

interface LayerEntry {
  object: LineSegments;
  material: ShaderMaterial;
  frame: LineSourceFrame;
}

export interface AddLayerOptions {
  color: number;
  opacity: number;
  frame: LineSourceFrame;
  renderOrder?: number;
  visible?: boolean;
}

export class LineLayer {
  readonly group = new Group();

  private entries = new Map<string, LayerEntry>();

  constructor() {
    this.group.renderOrder = 3;
    this.group.frustumCulled = false;
  }

  /** 新增 / 替换一个图层 */
  setLayer(id: string, polylines: readonly Polyline[], options: AddLayerOptions): void {
    this.removeLayer(id);

    const positions = buildLineSegmentPositions(polylines);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));

    const [r, g, b] = hexToLinearRgb(options.color);
    const material = new ShaderMaterial({
      vertexShader: LINE_VERTEX,
      fragmentShader: LINE_FRAGMENT,
      uniforms: {
        uEquToHoriz: { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
        uHorizToCam: { value: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
        uFovHalfTan: { value: 0.5 },
        uAspect: { value: 1 },
        uHorizonFadeDeg: { value: 0.4 },
        uColor: { value: new Float32Array([r, g, b]) },
        uOpacity: { value: options.opacity },
      } as unknown as Record<string, IUniform>,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: NormalBlending,
    });

    const object = new LineSegments(geometry, material);
    object.frustumCulled = false;
    object.renderOrder = options.renderOrder ?? 3;
    object.visible = options.visible ?? true;
    object.name = id;

    this.group.add(object);
    this.entries.set(id, { object, material, frame: options.frame });
  }

  removeLayer(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.group.remove(entry.object);
    entry.object.geometry.dispose();
    entry.material.dispose();
    this.entries.delete(id);
  }

  hasLayer(id: string): boolean {
    return this.entries.has(id);
  }

  setVisible(id: string, visible: boolean): void {
    const entry = this.entries.get(id);
    if (entry) entry.object.visible = visible;
  }

  setOpacity(id: string, opacity: number): void {
    const entry = this.entries.get(id);
    if (entry) entry.material.uniforms.uOpacity!.value = opacity;
  }

  /** 当前显示的线段数（顶点数 / 2） */
  visibleSegmentCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) {
      if (!entry.object.visible) continue;
      n += entry.object.geometry.getAttribute('position').count / 2;
    }
    return n;
  }

  /**
   * 每帧刷新共享 uniform。
   *
   * `eqj` 来源的图层要乘上赤道→地平矩阵，跟着星空一起转；
   * `hor` 来源的图层（地平网格、地平线）固定在地平系里，用单位矩阵。
   */
  updateUniforms(equToHoriz: Mat3, horizToCam: Mat3, fovHalfTan: number, aspect: number): void {
    for (const entry of this.entries.values()) {
      const u = entry.material.uniforms;
      // `hor` 来源的图层固定在地平系里，用单位矩阵；`eqj` 来源的跟着星空转
      writeGlslMat3(
        u.uEquToHoriz!.value as Float32Array,
        entry.frame === 'eqj' ? equToHoriz : IDENTITY_MAT3,
      );
      writeGlslMat3(u.uHorizToCam!.value as Float32Array, horizToCam);
      u.uFovHalfTan!.value = fovHalfTan;
      u.uAspect!.value = aspect;
    }
  }

  dispose(): void {
    for (const id of [...this.entries.keys()]) this.removeLayer(id);
  }
}
