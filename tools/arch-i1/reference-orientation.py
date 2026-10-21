#!/usr/bin/env python3
"""Reference values for checks F3 and F3b of the iteration 1 proof: the axes of a graph that is turned by
yaw, pitch and roll, in the frame of another graph. Plain Python 3, standard library only, doubles.

It computes with quaternions, where the runtime (web/wow-geopose.js) multiplies 3x3 matrices, so
the two paths share only the stated assumption: yaw about up, then pitch about north, then roll
about east, each turn right-handed. The proof cannot detect a wrong assumption.
"""
import math

A = 6378137.0
F = 1 / 298.257223563
E2 = F * (2 - F)


def ecef(lat, lon, h):
    p, l = math.radians(lat), math.radians(lon)
    n = A / math.sqrt(1 - E2 * math.sin(p) ** 2)
    return ((n + h) * math.cos(p) * math.cos(l), (n + h) * math.cos(p) * math.sin(l), (n * (1 - E2) + h) * math.sin(p))


def enu(lat, lon):
    p, l = math.radians(lat), math.radians(lon)
    east = (-math.sin(l), math.cos(l), 0.0)
    north = (-math.sin(p) * math.cos(l), -math.sin(p) * math.sin(l), math.cos(p))
    up = (math.cos(p) * math.cos(l), math.cos(p) * math.sin(l), math.sin(p))
    return east, north, up


def qmul(a, b):
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz)


def qaxis(axis, degrees):
    t = math.radians(degrees)
    s = math.sin(t / 2)
    return tuple(s if i == axis else 0.0 for i in range(3)) + (math.cos(t / 2),)


def rotate(q, v):
    qv = (v[0], v[1], v[2], 0.0)
    conj = (-q[0], -q[1], -q[2], q[3])
    r = qmul(qmul(q, qv), conj)
    return r[:3]


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


G1 = (47.7, -122.3, 11.5)
G2 = (47.7, -122.2986676811, 11.5)


def axes_of_g2_in_g1(yaw, pitch, roll):
    """G2's +X, +Y and +Z, written along G1's axes (X east, Y up, Z south, at zero angles)."""
    e1, n1, u1 = enu(G1[0], G1[1])
    e2, n2, u2 = enu(G2[0], G2[1])
    # Yaw about east-north-up z (up), then pitch about y (north), then roll about x (east).
    q = qmul(qmul(qaxis(2, yaw), qaxis(1, pitch)), qaxis(0, roll))
    out = []
    for enu_vec in ((1, 0, 0), (0, 0, 1), (0, -1, 0)):  # zero-angle X, Y, Z: east, up, south
        r = rotate(q, enu_vec)
        v = tuple(r[0] * e2[i] + r[1] * n2[i] + r[2] * u2[i] for i in range(3))
        out.append((dot(e1, v), dot(u1, v), -dot(n1, v)))
    return out


for check, name, angles in (("F3", "yaw90", (90.0, 0.0, 0.0)), ("F3b", "pitch10", (0.0, 10.0, 0.0)),
                            ("F3b", "mixed", (30.0, 10.0, 5.0))):
    axes = axes_of_g2_in_g1(*angles)
    print(check + " " + name + " " + " ".join("%.15e" % c for axis in axes for c in axis))
