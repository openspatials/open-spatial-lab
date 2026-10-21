#!/usr/bin/env python3
"""Reference values for the iteration 1 checks: geodesy (EPSG method 9837 on WGS-84) and float32 precision.
Plain Python 3, standard library only, all arithmetic in doubles."""
import math
import random
import statistics
import struct

A = 6378137.0                 # WGS-84 semi-major axis, metres
F = 1 / 298.257223563         # WGS-84 flattening
E2 = F * (2 - F)


def ecef(lat, lon, h):
    """Geographic (degrees, metres above the ellipsoid) to Earth-centred, Earth-fixed metres."""
    p, l = math.radians(lat), math.radians(lon)
    n = A / math.sqrt(1 - E2 * math.sin(p) ** 2)
    return ((n + h) * math.cos(p) * math.cos(l),
            (n + h) * math.cos(p) * math.sin(l),
            (n * (1 - E2) + h) * math.sin(p))


def enu_axes(lat, lon):
    """East, north and up unit vectors at (lat, lon), in Earth-centred coordinates."""
    p, l = math.radians(lat), math.radians(lon)
    east = (-math.sin(l), math.cos(l), 0.0)
    north = (-math.sin(p) * math.cos(l), -math.sin(p) * math.sin(l), math.cos(p))
    up = (math.cos(p) * math.cos(l), math.cos(p) * math.sin(l), math.sin(p))
    return east, north, up


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def to_canonical(origin, v):
    """An Earth-centred vector v in the WoW frame of a graph anchored at origin with zero angles:
    +X east, +Y up, +Z south."""
    e, n, u = enu_axes(origin[0], origin[1])
    return dot(e, v), dot(u, v), -dot(n, v)


def position(origin, point):
    """EPSG 9837: the position of point (lat, lon, h) relative to origin, in the WoW frame."""
    x0, x = ecef(*origin), ecef(*point)
    return to_canonical(origin, [x[i] - x0[i] for i in range(3)])


def f32(v):
    return struct.unpack('f', struct.pack('f', v))[0]


def dms(d, m, s):
    return d + m / 60 + s / 3600


G1 = (47.7, -122.3, 11.5)     # the GeoPose 1.0 standard's example position

# F1. IOGP Guidance Note 7-2, EPSG method 9837 worked example (expected E, N, U).
o, pt = (55.0, 5.0, 200.0), (dms(53, 48, 33.82), dms(2, 7, 46.38), 73.0)
x, y, z = position(o, pt)
print('F1  east %.3f  north %.3f  up %.3f' % (x, -z, y))

# F2. G2 is 100 m east of G1 on the tangent plane, same latitude and height.
g2 = (47.7, -122.2986676811, 11.5)
x, y, z = position(G1, g2)
print('F2  x %.7f m  y %.4f mm  z %.4f mm' % (x, y * 1e3, z * 1e3))
flat_x = (g2[1] - G1[1]) * 111320 * math.cos(math.radians(G1[0]))
print('F2  flat mutant (111,320 m per degree x cos lat): x %.2f m, y 0, z 0' % flat_x)

# I9. Graph 2 of world B, 200 m east of graph 1.
x, y, z = position(G1, (47.7, -122.2973353623, 11.5))
print('I9  x %.7f m  y %.4f mm  z %.4f mm' % (x, y * 1e3, z * 1e3))

# F3. G2 with yaw 90 deg: its +X axis, expressed in G1's frame.
# Assumed sense (to be confirmed with the GeoPose working group): positive yaw turns east toward north.
yaw = math.radians(90.0)
e2, n2, _ = enu_axes(g2[0], g2[1])
axis = [math.cos(yaw) * e2[i] + math.sin(yaw) * n2[i] for i in range(3)]
v = to_canonical(G1, axis)
conv = math.radians(g2[1] - G1[1]) * math.sin(math.radians(G1[0]))
print('F3  +X of G2 in G1: (%.4e, %.4e, %.11f)  convergence %.4e rad' % (v[0], v[1], v[2], conv))

# F5. 1,000 random points within 5 km of G1, as float32 graph-relative and Earth-centred coordinates.
def f5(seed):
    rng = random.Random(seed)
    o = ecef(*G1)
    e, n, u = enu_axes(G1[0], G1[1])
    worst_axis, worst_3d, earth = 0.0, 0.0, []
    while len(earth) < 1000:
        p = [rng.uniform(-5000, 5000) for _ in range(3)]
        if math.sqrt(sum(c * c for c in p)) > 5000:
            continue
        errs = [abs(f32(c) - c) for c in p]
        worst_axis = max(worst_axis, max(errs))
        worst_3d = max(worst_3d, math.sqrt(sum(d * d for d in errs)))
        # p is (x east, y up, z south); place it in Earth-centred coordinates.
        w = [o[i] + p[0] * e[i] + p[1] * u[i] - p[2] * n[i] for i in range(3)]
        earth.append(math.sqrt(sum((f32(c) - c) ** 2 for c in w)))
    return worst_axis, worst_3d, statistics.median(earth), max(earth), sum(d < 0.1 for d in earth) / 1000

a, b, med, mx, frac = f5(1)
print('F5  seed 1: local per-axis max %.4f mm, local 3-D max %.4f mm; Earth-centred median %.3f m, max %.3f m, '
      'share under 0.1 m %.1f%%' % (a * 1e3, b * 1e3, med, mx, frac * 100))
runs = [f5(s) for s in range(1, 201)]
print('F5  200 seeds: per-axis max %.4f mm; 3-D max %.4f mm; median range %.3f-%.3f m; smallest max %.3f m'
      % (max(r[0] for r in runs) * 1e3, max(r[1] for r in runs) * 1e3,
         min(r[2] for r in runs), max(r[2] for r in runs), min(r[3] for r in runs)))

# W5. B's content 3,000,000.37 m from A's origin: float32 error with and without re-rooting.
def w5(seed):
    rng = random.Random(seed)
    off = 3000000.37
    pts = [rng.uniform(-50, 50) for _ in range(1000)]
    return max(abs(f32(off + p) - (off + p)) for p in pts), max(abs(f32(p) - p) for p in pts)

res = [w5(s) for s in range(1, 201)]
print('W5  200 seeds: no re-root, smallest largest-error %.3f m; re-rooted, largest error %.2e m'
      % (min(r[0] for r in res), max(r[1] for r in res)))
print('W5  B origin alone: float32(3000000.37) = %.2f, error %.2f m' % (f32(3000000.37), abs(f32(3000000.37) - 3000000.37)))

# The GeoPose 1.0 example pair (Basic-YPR and Basic-Quaternion at the same position).
def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)

def qaxis(axis, t):
    s = math.sin(t / 2)
    return tuple(s if i == axis else 0.0 for i in range(3)) + (math.cos(t / 2),)

yaw_v, pitch_v = 5.514456741060452, -0.43610515937237904
q_doc = (0.20054473382601948, -0.08111675703887213, 0.3660908114262869, -0.9050852994339209)
def gap(q):
    return min(max(abs(a - b) for a, b in zip(q, q_doc)), max(abs(a + b) for a, b in zip(q, q_doc)))
print('GP  radians, yaw about z then pitch about x: difference %.1e' % gap(qmul(qaxis(2, yaw_v), qaxis(0, pitch_v))))
print('GP  radians, yaw about z then pitch about y: difference %.1e' % gap(qmul(qaxis(2, yaw_v), qaxis(1, pitch_v))))
print('GP  degrees, yaw about z then pitch about y: difference %.1e'
      % gap(qmul(qaxis(2, math.radians(yaw_v)), qaxis(1, math.radians(pitch_v)))))
