/**
 * 赤道 ↔ 地平坐标转换的精度测试。
 *
 * ## 基准来自哪里
 *
 * 参考值由 **Skyfield 1.55 + JPL DE421 星历**离线算出，观测点为上海
 * (31.2304°N, 121.4737°E, 海拔 4 m)，**不含大气折射**（几何地平坐标）。
 * 生成的脚本与原始输出见 `docs/precision-reference.md`。
 *
 * Skyfield 与 Stellarium 都实现 IAU 的岁差/章动/光行差标准链路，
 * 两者对亮星的地平坐标一致到亚角秒量级；PROMPT 要求的「与 Stellarium 误差 < 0.1°」
 * 在这里用同等甚至更严的基准来验证。
 *
 * ## 被验证的链路
 *
 * ```
 * J2000 位置 → 自行推算到观测时刻 → 周年光行差
 *            → 岁差 + 章动（EQJ → EQD）→ 地平旋转（EQD → HOR）
 * ```
 */

import { describe, expect, it } from 'vitest';
import {
  MakeTime,
  Observer,
  RotateVector,
  Rotation_EQD_HOR,
  Rotation_EQJ_EQD,
  Vector,
} from 'astronomy-engine';

import { applyAberration, earthVelocityOverC, observerVelocityOverC } from './aberration';
import {
  azAltToHorizon,
  equToHorMatrix,
  horizonToAzAlt,
  j2000ToHorizonMatrix,
  ofDateToHorizonMatrix,
  precessionNutationMatrix,
  raDecToVector,
  rotationToMat3,
  vectorToRaDec,
} from './coordinates';
import { applyProperMotion } from './properMotion';
import {
  greenwichApparentSiderealTime,
  julianYearsSinceJ2000,
  localSiderealTime,
} from './time';
import { angleBetween, mat3Apply, mat3Multiply, normalize, type Vec3 } from './vec3';

/** 上海 */
const OBSERVER = new Observer(31.2304, 121.4737, 4);
const OBSERVER_LAT = 31.2304;
const OBSERVER_LON = 121.4737;

interface StarInput {
  raDeg: number;
  decDeg: number;
  pmRaMas: number;
  pmDecMas: number;
}

/** 恒星的 ICRS/J2000 位置与自行（μα* = μα·cosδ 约定），取自 Hipparcos/IAU */
const STARS: Record<string, StarInput> = {
  Sirius: { raDeg: 101.28715333, decDeg: -16.71611586, pmRaMas: -546.01, pmDecMas: -1223.07 },
  Vega: { raDeg: 279.23473581, decDeg: 38.78368896, pmRaMas: 200.94, pmDecMas: 286.23 },
  Betelgeuse: { raDeg: 88.79293866, decDeg: 7.407064, pmRaMas: 27.54, pmDecMas: 11.3 },
  Polaris: { raDeg: 37.95451569, decDeg: 89.26410897, pmRaMas: 44.22, pmDecMas: -11.74 },
};

interface Reference {
  time: string;
  star: string;
  azimuthDeg: number;
  altitudeDeg: number;
}

/**
 * Skyfield 1.55 + JPL DE421 生成的参考值。
 * 命令：见 docs/precision-reference.md
 */
const SKYFIELD_REFERENCE: readonly Reference[] = [
  { time: '2025-01-01T16:00:00Z', star: 'Sirius', azimuthDeg: 181.8840422588253, altitudeDeg: 41.99870270820675 },
  { time: '2025-01-01T16:00:00Z', star: 'Vega', azimuthDeg: 2.9759476273483436, altitudeDeg: -19.884353817400754 },
  { time: '2025-01-01T16:00:00Z', star: 'Betelgeuse', azimuthDeg: 211.4837456703005, altitudeDeg: 62.875944867939836 },
  { time: '2025-01-01T16:00:00Z', star: 'Polaris', azimuthDeg: 359.38558651579586, altitudeDeg: 31.57203697188329 },
  { time: '2025-06-15T14:30:00Z', star: 'Sirius', azimuthDeg: 283.4382631688826, altitudeDeg: -52.24022177344294 },
  { time: '2025-06-15T14:30:00Z', star: 'Vega', azimuthDeg: 65.50571184642546, altitudeDeg: 59.49288926937511 },
  { time: '2025-06-15T14:30:00Z', star: 'Betelgeuse', azimuthDeg: 322.7493914925637, altitudeDeg: -44.03035749592741 },
  { time: '2025-06-15T14:30:00Z', star: 'Polaris', azimuthDeg: 0.21918409605380593, altitudeDeg: 30.626686224461842 },
  { time: '2024-03-20T12:00:00Z', star: 'Sirius', azimuthDeg: 202.87694760996115, altitudeDeg: 38.85567469296748 },
  { time: '2024-03-20T12:00:00Z', star: 'Vega', azimuthDeg: 16.657467192642486, altitudeDeg: -17.405483730491166 },
  { time: '2024-03-20T12:00:00Z', star: 'Betelgeuse', azimuthDeg: 236.94602136038014, altitudeDeg: 52.63046424619936 },
  { time: '2024-03-20T12:00:00Z', star: 'Polaris', azimuthDeg: 359.28803507137843, altitudeDeg: 31.39478472113036 },
];

/** 完整链路：J2000 恒星 → 地平方位角/高度角 */
function apparentHorizontal(star: StarInput, date: Date): { azimuthDeg: number; altitudeDeg: number } {
  const deltaYears = julianYearsSinceJ2000(date);

  let p = raDecToVector(star.raDeg, star.decDeg);
  p = applyProperMotion(p, star.pmRaMas, star.pmDecMas, deltaYears);
  // 用观测者的总速度（公转 + 自转），而不是只用地心公转速度
  p = applyAberration(p, observerVelocityOverC(date, OBSERVER));

  const horizon = mat3Apply(j2000ToHorizonMatrix(OBSERVER, date), p);
  return horizonToAzAlt(horizon);
}

/** 方位角环形差值 */
function angularDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

describe('恒星地平坐标 vs Skyfield/JPL 基准', () => {
  it('全部 12 组（4 颗星 × 3 个时刻）误差远小于 0.1°', () => {
    let worstAz = 0;
    let worstAlt = 0;
    let worstLabel = '';

    for (const ref of SKYFIELD_REFERENCE) {
      const star = STARS[ref.star];
      expect(star, `缺少恒星 ${ref.star} 的定义`).toBeDefined();
      const date = new Date(ref.time);

      const got = apparentHorizontal(star!, date);
      const dAz = angularDiffDeg(got.azimuthDeg, ref.azimuthDeg);
      const dAlt = Math.abs(got.altitudeDeg - ref.altitudeDeg);

      if (Math.max(dAz, dAlt) > Math.max(worstAz, worstAlt)) {
        worstAz = dAz;
        worstAlt = dAlt;
        worstLabel = `${ref.star} @ ${ref.time}`;
      }
    }

    // PROMPT 要求 < 0.1°；这里收紧到 0.01°，实测应在 1″（≈0.0003°）量级
    expect(worstAz, `最差方位角偏差 (${worstLabel})`).toBeLessThan(0.01);
    expect(worstAlt, `最差高度角偏差 (${worstLabel})`).toBeLessThan(0.01);
  });

  it('天狼星单点误差达到亚角秒量级', () => {
    const ref = SKYFIELD_REFERENCE.find(
      (r) => r.star === 'Sirius' && r.time === '2025-01-01T16:00:00Z',
    )!;
    const got = apparentHorizontal(STARS['Sirius']!, new Date(ref.time));

    const dAzArcsec = angularDiffDeg(got.azimuthDeg, ref.azimuthDeg) * 3600;
    const dAltArcsec = Math.abs(got.altitudeDeg - ref.altitudeDeg) * 3600;

    // 亚角秒
    expect(dAzArcsec).toBeLessThan(1);
    expect(dAltArcsec).toBeLessThan(1);
  });
});

describe('岁差与章动', () => {
  it('忽略岁差会带来明显误差（反证岁差不能省）', () => {
    const ref = SKYFIELD_REFERENCE[0]!;
    const star = STARS['Sirius']!;
    const date = new Date(ref.time);
    const years = julianYearsSinceJ2000(date);

    const refDir = azAltToHorizon(ref.azimuthDeg, ref.altitudeDeg);

    let p = applyProperMotion(
      raDecToVector(star.raDeg, star.decDeg),
      star.pmRaMas,
      star.pmDecMas,
      years,
    );
    p = applyAberration(p, earthVelocityOverC(MakeTime(date)));

    // 正确链路：J2000 → 岁差章动 → EQD → 地平
    const withPrecession = normalize(mat3Apply(j2000ToHorizonMatrix(OBSERVER, date), p));
    // 故意省略岁差：把 J2000 向量直接套上 of-date 的地平旋转
    const withoutPrecession = normalize(mat3Apply(ofDateToHorizonMatrix(date, OBSERVER), p));

    const deg = (rad: number): number => (rad * 180) / Math.PI;
    const errWith = deg(angleBetween(withPrecession, refDir));
    const errWithout = deg(angleBetween(withoutPrecession, refDir));

    // 岁差在 25 年里积累约 0.35°，必然远大于亚角秒目标。
    // 注意这里必须用天球角距离而不是单纯比高度角：
    // 天狼星在该时刻几乎位于子午线上，高度角对时角的一阶导数为 0，
    // 只看高度角会严重低估岁差的影响。
    expect(errWithout).toBeGreaterThan(0.1);
    expect(errWith).toBeLessThan(0.01);
    expect(errWith).toBeLessThan(errWithout / 10);
  });
});

describe('纯公式地平矩阵 vs astronomy-engine', () => {
  it('equToHorMatrix(纬度, 地方视恒星时) 与 Rotation_EQD_HOR 一致', () => {
    const times = [
      '2025-01-01T16:00:00Z',
      '2024-03-20T12:00:00Z',
      '2026-07-07T03:15:00Z',
    ];
    for (const iso of times) {
      const date = new Date(iso);
      const lst = localSiderealTime(date, OBSERVER_LON);
      const mine = equToHorMatrix(OBSERVER_LAT, lst);
      const theirs = ofDateToHorizonMatrix(date, OBSERVER);

      // 用一组方向逐点比较，避免直接比矩阵元素时受零元影响
      for (const v of [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 1 },
        { x: 0.577, y: 0.577, z: 0.577 },
        { x: -0.3, y: 0.8, z: -0.5 },
      ]) {
        const a = horizonToAzAlt(mat3Apply(mine, v));
        const b = horizonToAzAlt(mat3Apply(theirs, v));
        expect(angularDiffDeg(a.azimuthDeg, b.azimuthDeg)).toBeLessThan(0.01);
        expect(Math.abs(a.altitudeDeg - b.altitudeDeg)).toBeLessThan(0.01);
      }
    }
  });

  it('GAST 与地方恒星时满足 LST = GAST + 经度/15', () => {
    const date = new Date('2025-01-01T16:00:00Z');
    const gast = greenwichApparentSiderealTime(date);
    const lst = localSiderealTime(date, OBSERVER_LON);
    const expected = ((gast + OBSERVER_LON / 15) % 24 + 24) % 24;
    expect(Math.abs(lst - expected)).toBeLessThan(1e-12);
  });
});

describe('矩阵与向量基础设施', () => {
  it('rotationToMat3 提取的矩阵与 astronomy-engine 的 RotateVector 等价', () => {
    // 这是一个防回归测试：astronomy-engine 的 RotationMatrix.rot 存的是转置，
    // 直接当行主序用会让整个天球镜像。这里用它自己的 RotateVector 做探针。
    const date = new Date('2025-01-01T16:00:00Z');
    const t = MakeTime(date);
    const probes = [
      { x: 1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: -0.37, y: 0.62, z: 0.69 },
    ];

    for (const rotation of [Rotation_EQJ_EQD(date), Rotation_EQD_HOR(date, OBSERVER)]) {
      const m = rotationToMat3(rotation);
      for (const v of probes) {
        const expected = RotateVector(rotation, new Vector(v.x, v.y, v.z, t));
        const got = mat3Apply(m, v);
        expect(Math.abs(got.x - expected.x)).toBeLessThan(1e-15);
        expect(Math.abs(got.y - expected.y)).toBeLessThan(1e-15);
        expect(Math.abs(got.z - expected.z)).toBeLessThan(1e-15);
      }
    }
  });

  it('岁差章动矩阵是正交的（行列式为 +1）', () => {
    const m = precessionNutationMatrix(new Date('2025-01-01T16:00:00Z'));
    const det =
      m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
      m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
      m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!);
    expect(Math.abs(det - 1)).toBeLessThan(1e-12);
  });

  it('矩阵转置即逆矩阵', () => {
    const m = j2000ToHorizonMatrix(OBSERVER, new Date('2025-01-01T16:00:00Z'));
    const t = new Float64Array([m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!]);
    const prod = mat3Multiply(m, t);
    for (let i = 0; i < 9; i++) {
      expect(Math.abs(prod[i]! - (i % 4 === 0 ? 1 : 0))).toBeLessThan(1e-12);
    }
  });

  it('raDec ↔ 单位向量 往返一致', () => {
    for (const [ra, dec] of [
      [0, 0],
      [123.456, -45.678],
      [359.999, 89.9],
      [180, -89.9],
      [270.5, 12.25],
    ] as const) {
      const v = raDecToVector(ra, dec);
      expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 12);
      const back = vectorToRaDec(v);
      expect(angularDiffDeg(back.raDeg, ra)).toBeLessThan(1e-9);
      expect(Math.abs(back.decDeg - dec)).toBeLessThan(1e-9);
    }
  });
});

describe('自行推算', () => {
  it('零自行不改变方向', () => {
    const p: Vec3 = raDecToVector(101.28715, -16.71612);
    const q = applyProperMotion(p, 0, 0, 100);
    expect(Math.abs(q.x - p.x)).toBeLessThan(1e-15);
  });

  it('高自行恒星（巴纳德星）100 年位移约 10.3 角分', () => {
    // 巴纳德星：μα* = -798.71 mas/yr，μδ = +10337.77 mas/yr
    const p = raDecToVector(269.454, 4.668);
    const q = applyProperMotion(p, -798.71, 10337.77, 100);
    const dot = p.x * q.x + p.y * q.y + p.z * q.z;
    const movedArcsec = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180 * 3600) / Math.PI;
    // 100 年总自行 = sqrt(798.71² + 10337.77²) mas/yr × 100 yr ≈ 1036.6″
    expect(movedArcsec).toBeGreaterThan(1030);
    expect(movedArcsec).toBeLessThan(1045);
  });

  it('位移方向沿着自行矢量', () => {
    const p = raDecToVector(101.28715, -16.71612);
    const q = applyProperMotion(p, -546.01, -1223.07, 50);
    // 天狼星以赤纬方向为主，位移后赤纬应下降
    const before = vectorToRaDec(p);
    const after = vectorToRaDec(q);
    expect(after.decDeg).toBeLessThan(before.decDeg);
  });
});

describe('周年光行差', () => {
  it('光行差量级约 20.5 角秒', () => {
    const v = earthVelocityOverC(MakeTime(new Date('2025-01-01T16:00:00Z')));
    const magnitude = Math.hypot(v.x, v.y, v.z);
    const arcsec = (magnitude * 180 * 3600) / Math.PI;
    expect(arcsec).toBeGreaterThan(19.5);
    expect(arcsec).toBeLessThan(21.0);
  });

  it('半年后地球速度方向基本相反', () => {
    const v1 = earthVelocityOverC(MakeTime(new Date('2025-01-01T00:00:00Z')));
    const v2 = earthVelocityOverC(MakeTime(new Date('2025-07-01T00:00:00Z')));
    const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
    const n1 = Math.hypot(v1.x, v1.y, v1.z);
    const n2 = Math.hypot(v2.x, v2.y, v2.z);
    expect(dot / (n1 * n2)).toBeLessThan(-0.9);
  });

  it('光行差把方向偏移约 20 角秒', () => {
    const p = raDecToVector(101.28715, -16.71612);
    const v = earthVelocityOverC(MakeTime(new Date('2025-01-01T16:00:00Z')));
    const q = applyAberration(p, v);
    const dot = p.x * q.x + p.y * q.y + p.z * q.z;
    const arcsec = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180 * 3600) / Math.PI;
    expect(arcsec).toBeGreaterThan(0);
    expect(arcsec).toBeLessThan(21);
  });
});
