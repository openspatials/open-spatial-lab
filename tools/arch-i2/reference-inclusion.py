#!/usr/bin/env python3
"""Reference values for the iteration 2 proof (rule 3: two independent computations agree).

Plain Python 3, standard library only, all arithmetic in doubles. It shares no code with the lab's
JavaScript: the matrices are written out here, and the geodesy is the roadmap appendix's (EPSG method
9837 on WGS-84).

I2: world A's node Y (scale 0.01, at (0, 0, 5)) includes node n of world B; n has its own translation
(2, 0, 0) and holds B's 1 m reference cube. X (scale 1, 10 m east) includes B's whole graph 1.
I9: graph 2 of world B, anchored 200 m east of graph 1 at the same latitude and height.
"""
import math

A = 6378137.0
F = 1 / 298.257223563
E2 = F * (2 - F)


def ecef(lat, lon, h):
    p, l = math.radians(lat), math.radians(lon)
    n = A / math.sqrt(1 - E2 * math.sin(p) ** 2)
    return ((n + h) * math.cos(p) * math.cos(l), (n + h) * math.cos(p) * math.sin(l), (n * (1 - E2) + h) * math.sin(p))


def enu_axes(lat, lon):
    p, l = math.radians(lat), math.radians(lon)
    east = (-math.sin(l), math.cos(l), 0.0)
    north = (-math.sin(p) * math.cos(l), -math.sin(p) * math.sin(l), math.cos(p))
    up = (math.cos(p) * math.cos(l), math.cos(p) * math.sin(l), math.sin(p))
    return east, north, up


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def position(origin, point):
    """The WoW frame of a graph anchored at origin, zero angles: +X east, +Y up, +Z south."""
    x0, x = ecef(*origin), ecef(*point)
    v = [x[i] - x0[i] for i in range(3)]
    e, n, u = enu_axes(origin[0], origin[1])
    return dot(e, v), dot(u, v), -dot(n, v)


def mat(s, t):
    """A row-major 4x4: uniform scale s, then translation t."""
    return [[s, 0, 0, t[0]], [0, s, 0, t[1]], [0, 0, s, t[2]], [0, 0, 0, 1]]


def mul(a, b):
    return [[sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def apply(m, p):
    return [m[r][0] * p[0] + m[r][1] * p[1] + m[r][2] * p[2] + m[r][3] for r in range(3)]


X = mat(1.0, (10.0, 0.0, 0.0))
Y = mat(0.01, (0.0, 0.0, 5.0))
N = mat(1.0, (2.0, 0.0, 0.0))      # node n's own transform in B
CUBE = mat(1.0, (0.0, 0.0, 0.0))   # the cube node under n


def edge(m):
    a, b = apply(m, (-0.5, 0, 0)), apply(m, (0.5, 0, 0))
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


# Under X, the whole graph: root (identity) -> n -> cube. Under Y, n itself stands under Y.
cube_under_x = mul(mul(X, N), CUBE)
cube_under_y = mul(mul(Y, N), CUBE)
n_under_y = apply(mul(Y, N), (0, 0, 0))
y_origin = apply(Y, (0, 0, 0))
print('I2  n_from_Y_x %.12f m' % (n_under_y[0] - y_origin[0]))
print('I2  cube_edge_X %.12f m' % edge(cube_under_x))
print('I2  cube_edge_Y %.12f m' % edge(cube_under_y))

G1 = (47.7, -122.3, 11.5)
x, y, z = position(G1, (47.7, -122.2973353623, 11.5))
print('I9  x %.10f m  y %.10f m  z %.10f m' % (x, y, z))
