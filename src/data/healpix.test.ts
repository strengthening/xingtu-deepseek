import { describe, expect, it } from 'vitest';
import {
  ang2pixNest,
  isPowerOfTwo,
  levelToNside,
  nestedPixelToVector,
  nsideToLevel,
  nsideToNpix,
  pix2angNest,
  pix2radecDeg,
  queryDiscNest,
  radecDegToPix,
} from './healpix';
import { PIXEL_TO_RADEC, RADEC_TO_PIXEL } from './__fixtures__/healpixReference';

describe('HEALPix 基础属性', () => {
  it('像素总数 = 12·nside²', () => {
    expect(nsideToNpix(1)).toBe(12);
    expect(nsideToNpix(2)).toBe(48);
    expect(nsideToNpix(16)).toBe(3072);
    expect(nsideToNpix(64)).toBe(49152);
  });

  it('nside ↔ level 互转一致', () => {
    for (const level of [0, 1, 2, 4, 8, 12]) {
      expect(nsideToLevel(levelToNside(level))).toBe(level);
    }
  });

  it('isPowerOfTwo 判定正确', () => {
    expect(isPowerOfTwo(1)).toBe(true);
    expect(isPowerOfTwo(64)).toBe(true);
    expect(isPowerOfTwo(48)).toBe(false);
    expect(isPowerOfTwo(0)).toBe(false);
  });
});

describe('HEALPix 对照 astrometry.net 参考实现', () => {
  it('pix2radecDeg 与 C 参考实现逐条一致', () => {
    let worst = 0;
    for (const v of PIXEL_TO_RADEC) {
      const got = pix2radecDeg(v.nside, v.pixel);
      // 赤经在 0/360 附近要按环形差值比较
      let dRa = Math.abs(got.raDeg - v.raDeg);
      if (dRa > 180) dRa = 360 - dRa;
      const dDec = Math.abs(got.decDeg - v.decDeg);
      worst = Math.max(worst, dRa, dDec);
    }
    // 参考值以 12 位小数导出，双精度链路应远优于 1e-9 度
    expect(worst).toBeLessThan(1e-9);
  });

  it('radecDegToPix 与 C 参考实现逐条一致', () => {
    for (const v of RADEC_TO_PIXEL) {
      expect(radecDegToPix(v.nside, v.raDeg, v.decDeg)).toBe(v.pixel);
    }
  });
});

describe('HEALPix 自洽性', () => {
  const nsides = [1, 2, 4, 8, 16, 64];

  it('ang2pix / pix2ang 往返后落在同一像素内', () => {
    let seed = 12345;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };

    for (const nside of nsides) {
      const radiusDeg = (Math.sqrt((4 * Math.PI) / (12 * nside * nside)) * 180) / Math.PI;
      for (let i = 0; i < 400; i++) {
        const theta = Math.acos(1 - 2 * rand());
        const phi = rand() * 2 * Math.PI;
        const pix = ang2pixNest(nside, theta, phi);
        expect(pix).toBeGreaterThanOrEqual(0);
        expect(pix).toBeLessThan(nsideToNpix(nside));

        const back = pix2angNest(nside, pix);
        // 返回的像素中心与原始方向应在像素尺度内
        const v1 = { x: Math.sin(theta) * Math.cos(phi), y: Math.sin(theta) * Math.sin(phi), z: Math.cos(theta) };
        const v2 = nestedPixelToVector(pix, nside);
        const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
        const sepDeg = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
        expect(sepDeg).toBeLessThan(radiusDeg * 1.6 + 1e-6);

        // 再转回去必须得到同一个像素
        expect(ang2pixNest(nside, back.theta, back.phi)).toBe(pix);
      }
    }
  });

  it('每个像素都会被均匀采样到（面积相等）', () => {
    const nside = 8;
    const npix = nsideToNpix(nside);
    const hit = new Uint8Array(npix);

    // 用像素中心反查，必须命中自身
    for (let i = 0; i < npix; i++) {
      const { theta, phi } = pix2angNest(nside, i);
      hit[ang2pixNest(nside, theta, phi)] = 1;
    }
    expect(hit.every((v) => v === 1)).toBe(true);
  });

  it('queryDiscNest 覆盖圆盘内的所有像素中心', () => {
    const nside = 16;
    const theta = Math.acos(0.3);
    const phi = 1.2;
    const radius = 0.12;

    const got = new Set(queryDiscNest(nside, theta, phi, radius));
    const npix = nsideToNpix(nside);
    const center = {
      x: Math.sin(theta) * Math.cos(phi),
      y: Math.sin(theta) * Math.sin(phi),
      z: Math.cos(theta),
    };

    for (let i = 0; i < npix; i++) {
      const v = nestedPixelToVector(i, nside);
      const dot = v.x * center.x + v.y * center.y + v.z * center.z;
      const sep = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (sep < radius) {
        expect(got.has(i)).toBe(true);
      }
    }

    // 圆盘中心所在像素一定被选中
    expect(got.has(ang2pixNest(nside, theta, phi))).toBe(true);
  });
});
