/**
 * 相机基向量。
 *
 * 相机固定在单位天球的球心，视线方向由「方位角 + 高度角」给出，
 * 投影在顶点着色器里用立体投影自行完成，所以不经过 Three.js 的相机矩阵。
 *
 * 地平坐标系约定（全文一致）：**x = 北，y = 西，z = 天顶**。
 */

import { azAltToHorizon } from '../astro/coordinates';
import { cross, normalize, type Mat3, type Vec3 } from '../astro/vec3';

export interface CameraBasis {
  /** 视线中心方向（地平单位向量） */
  forward: Vec3;
  /** 屏幕向右 */
  right: Vec3;
  /** 屏幕向上 */
  up: Vec3;
  /** 地平 → 相机（行主序 3×3），`dCam = horizToCam · dHor` */
  horizToCam: Mat3;
  /** 相机 → 地平，即 horizToCam 的转置 */
  camToHoriz: Mat3;
}

const ZENITH: Vec3 = { x: 0, y: 0, z: 1 };

/**
 * 由方位角 / 高度角构造相机基。
 *
 * - `right = normalize(forward × zenith)`，这样「向右」是东；
 * - `up = right × forward`，这样抬头时上方是天顶。
 *
 * 视线接近天顶 / 天底时 `forward × zenith` 退化，此时用「东」作为基准。
 */
export function computeCameraBasis(azimuthDeg: number, altitudeDeg: number): CameraBasis {
  const forward = azAltToHorizon(azimuthDeg, altitudeDeg);

  let right = cross(forward, ZENITH);
  if (Math.hypot(right.x, right.y, right.z) < 1e-6) {
    // 垂直向上/向下看：固定一个朝向，避免万向节锁
    right = { x: 0, y: -1, z: 0 };
  }
  right = normalize(right);
  const up = cross(right, forward);

  // 列向量分别是 right / up / forward
  const horizToCam = new Float64Array([
    right.x,
    right.y,
    right.z,
    up.x,
    up.y,
    up.z,
    forward.x,
    forward.y,
    forward.z,
  ]);
  const camToHoriz = new Float64Array([
    right.x,
    up.x,
    forward.x,
    right.y,
    up.y,
    forward.y,
    right.z,
    up.z,
    forward.z,
  ]);

  return { forward, right, up, horizToCam, camToHoriz };
}

/** 立体投影的半高平面半径 `R_v = 2·tan(fov/4)` */
export function fovHalfTan(fovDeg: number): number {
  return 2 * Math.tan((fovDeg * Math.PI) / 180 / 4);
}

/**
 * 把地平单位方向投影到 NDC。
 *
 * 供 CPU 侧使用（比如把标签定位到屏幕上），与顶点着色器里的公式一致。
 */
export function projectToNdc(
  dirHoriz: Vec3,
  basis: CameraBasis,
  fovDeg: number,
  aspect: number,
): { x: number; y: number; visible: boolean } {
  const cam = {
    x:
      basis.horizToCam[0]! * dirHoriz.x +
      basis.horizToCam[1]! * dirHoriz.y +
      basis.horizToCam[2]! * dirHoriz.z,
    y:
      basis.horizToCam[3]! * dirHoriz.x +
      basis.horizToCam[4]! * dirHoriz.y +
      basis.horizToCam[5]! * dirHoriz.z,
    z:
      basis.horizToCam[6]! * dirHoriz.x +
      basis.horizToCam[7]! * dirHoriz.y +
      basis.horizToCam[8]! * dirHoriz.z,
  };
  const rv = fovHalfTan(fovDeg);
  const denom = 1 + cam.z;
  if (denom < 1e-4) return { x: 0, y: 0, visible: false };
  const plane = { x: cam.x * (2 / denom), y: cam.y * (2 / denom) };
  return {
    x: plane.x / (rv * aspect),
    y: plane.y / rv,
    visible: true,
  };
}

/**
 * 屏幕 NDC → 地平单位方向（立体投影反解）。
 * 与背景片元着色器里的公式一致。
 */
export function unprojectFromNdc(
  ndcX: number,
  ndcY: number,
  basis: CameraBasis,
  fovDeg: number,
  aspect: number,
): Vec3 {
  const rv = fovHalfTan(fovDeg);
  const px = ndcX * rv * aspect;
  const py = ndcY * rv;
  const r2 = px * px + py * py;
  const inv = 1 / (4 + r2);
  const cam = { x: 4 * px * inv, y: 4 * py * inv, z: (4 - r2) * inv };
  return {
    x: basis.camToHoriz[0]! * cam.x + basis.camToHoriz[1]! * cam.y + basis.camToHoriz[2]! * cam.z,
    y: basis.camToHoriz[3]! * cam.x + basis.camToHoriz[4]! * cam.y + basis.camToHoriz[5]! * cam.z,
    z: basis.camToHoriz[6]! * cam.x + basis.camToHoriz[7]! * cam.y + basis.camToHoriz[8]! * cam.z,
  };
}

/**
 * 鼠标拖拽的像素位移 → 视线中心的方位角/高度角变化。
 *
 * 直觉是「抓住天空往哪儿拖」：向右拖，星空右移，视线中心左移。
 * 灵敏度按视场角缩放，这样放大后拖拽精度自动变高。
 */
export function dragToAngles(
  dxPx: number,
  dyPx: number,
  viewportHeightPx: number,
  fovDeg: number,
  currentAltitudeDeg: number,
): { deltaAzimuthDeg: number; deltaAltitudeDeg: number } {
  // 屏幕高度对应 fov，1 像素对应的角度
  const degPerPx = fovDeg / Math.max(viewportHeightPx, 1);
  const deltaAzimuthDeg = -dxPx * degPerPx;
  // 靠近天顶/天底时方位角的实际角距离被压缩，除以 cos(alt) 补偿
  const cosAlt = Math.max(Math.cos((currentAltitudeDeg * Math.PI) / 180), 0.12);
  return {
    deltaAzimuthDeg: deltaAzimuthDeg / cosAlt,
    deltaAltitudeDeg: dyPx * degPerPx,
  };
}

/** 把高度角夹在 [-90, 90]，方位角归一化到 [0, 360) */
export function normalizeViewAngles(
  azimuthDeg: number,
  altitudeDeg: number,
): {
  azimuthDeg: number;
  altitudeDeg: number;
} {
  const alt = Math.max(-90, Math.min(90, altitudeDeg));
  // 越过天顶时方位角翻转 180°，操作手感才连续
  let az = azimuthDeg;
  if (altitudeDeg > 90) az += 180;
  if (altitudeDeg < -90) az += 180;
  return { azimuthDeg: ((az % 360) + 360) % 360, altitudeDeg: alt };
}
