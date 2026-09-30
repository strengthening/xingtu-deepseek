#!/usr/bin/env python3
"""生成地平坐标参考值。

用 Skyfield + JPL DE421 计算若干亮星在上海的几何地平坐标（不含大气折射），
输出 TypeScript 字面量，供 `src/astro/coordinates.test.ts` 作为参考基准。

用法：
    python3 -m venv /tmp/skyvenv
    /tmp/skyvenv/bin/pip install skyfield
    /tmp/skyvenv/bin/python scripts/reference/skyfield_horizon.py

首次运行会自动下载 de421.bsp（约 17 MB）到工作目录。
详细说明见 docs/precision-reference.md。
"""

import os
import sys

os.environ.setdefault("SKYFIELD_DATA", os.path.join(os.getcwd(), ".skyfield-data"))

try:
    import skyfield
    from skyfield.api import Star, load, wgs84
except ImportError:  # pragma: no cover
    sys.exit("需要先安装 skyfield：pip install skyfield")

# 上海
LATITUDE, LONGITUDE, ELEVATION_M = 31.2304, 121.4737, 4.0

# Hipparcos / IAU 的 J2000 位置与自行。ra_mas_per_year 是 μα* = μα·cosδ 约定，
# 这一点由 skyfield 的 Star._observe_from_bcrs 里的速度公式确认：
#     pmr = ra_mas_per_year / (parallax * 365.25)
#     v_x = -pmr*sin(ra) - pmd*sin(dec)*cos(ra) + ...
# 与 d/dt(cosδ·cosα) 对照可知 pmr 对应 cosδ·μα。
STARS = {
    "Sirius": dict(
        ra_hours=6.752476888666667, dec_degrees=-16.71611586,
        ra_mas_per_year=-546.01, dec_mas_per_year=-1223.07,
        parallax_mas=379.21, radial_km_per_s=-5.5,
    ),
    "Vega": dict(
        ra_hours=18.615649053888889, dec_degrees=38.78368896,
        ra_mas_per_year=200.94, dec_mas_per_year=286.23,
        parallax_mas=130.23, radial_km_per_s=-13.9,
    ),
    "Betelgeuse": dict(
        ra_hours=5.919529244166667, dec_degrees=7.40706400,
        ra_mas_per_year=27.54, dec_mas_per_year=11.30,
        parallax_mas=6.55, radial_km_per_s=21.91,
    ),
    "Polaris": dict(
        ra_hours=2.530301045833333, dec_degrees=89.26410897,
        ra_mas_per_year=44.22, dec_mas_per_year=-11.74,
        parallax_mas=7.54, radial_km_per_s=-17.4,
    ),
}

TIMES_ISO = [
    "2025-01-01T16:00:00Z",
    "2025-06-15T14:30:00Z",
    "2024-03-20T12:00:00Z",
]


def main() -> None:
    ts = load.timescale()
    earth = load("de421.bsp")["earth"]
    site = earth + wgs84.latlon(LATITUDE, LONGITUDE, elevation_m=ELEVATION_M)

    print(f"// Skyfield {skyfield.__version__} + JPL DE421")
    print(f"// 观测点：上海 {LATITUDE}N, {LONGITUDE}E, {ELEVATION_M} m；几何地平坐标（无折射）")
    print("export const SKYFIELD_REFERENCE = [")
    for iso in TIMES_ISO:
        t = ts.utc(*[int(x) for x in iso.replace("Z", "").replace("T", "-").replace(":", "-").split("-")])
        for name, kwargs in STARS.items():
            alt, az, _ = site.at(t).observe(Star(**kwargs)).apparent().altaz()
            print(
                f"  {{ time: '{iso}', star: '{name}', "
                f"azimuthDeg: {az.degrees:.12f}, altitudeDeg: {alt.degrees:.12f} }},"
            )
    print("];")


if __name__ == "__main__":
    main()
