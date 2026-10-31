#!/usr/bin/env python3
"""Reference values for the iteration 4 checks. Plain Python 3, standard library only, all arithmetic in doubles.

Reads JSON from stdin:
  {"anchor": {"lat", "lon", "h"} | null,
   "chains": {name: [m_root, ..., m_node]},          column-major 4x4 transforms from a graph's root down
   "geoposes": {name: {"lat", "lon", "h"}}}          GeoPoses a server derived
Writes JSON to stdout:
  {"positions": {name: [x, y, z]},                    each chain's composed position
   "back": {name: [x, y, z]}}                         each GeoPose turned back into the anchor's graph frame
The second uses EPSG method 9837 on WGS-84, for an anchor with zero angles (+X east, +Y up, +Z south)."""
import json
import math
import sys

A = 6378137.0                 # WGS-84 semi-major axis, metres
F = 1 / 298.257223563         # WGS-84 flattening
E2 = F * (2 - F)


def multiply(a, b):
    """a times b, both column-major 4x4."""
    out = [0.0] * 16
    for column in range(4):
        for row in range(4):
            out[column * 4 + row] = sum(a[k * 4 + row] * b[column * 4 + k] for k in range(4))
    return out


def composed_position(chain):
    m = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]
    for local in chain:
        m = multiply(m, [float(v) for v in local])
    return [m[12], m[13], m[14]]


def ecef(lat, lon, h):
    p, l = math.radians(lat), math.radians(lon)
    n = A / math.sqrt(1 - E2 * math.sin(p) ** 2)
    return ((n + h) * math.cos(p) * math.cos(l), (n + h) * math.cos(p) * math.sin(l), (n * (1 - E2) + h) * math.sin(p))


def to_graph(origin, point):
    """EPSG 9837: point relative to origin, in the frame of a graph anchored at origin with zero angles."""
    x0, x = ecef(*origin), ecef(*point)
    d = [x[i] - x0[i] for i in range(3)]
    p, l = math.radians(origin[0]), math.radians(origin[1])
    east = (-math.sin(l), math.cos(l), 0.0)
    north = (-math.sin(p) * math.cos(l), -math.sin(p) * math.sin(l), math.cos(p))
    up = (math.cos(p) * math.cos(l), math.cos(p) * math.sin(l), math.sin(p))
    dot = lambda u, v: sum(a * b for a, b in zip(u, v))
    return [dot(east, d), dot(up, d), -dot(north, d)]


data = json.load(sys.stdin)
out = {"positions": {k: composed_position(v) for k, v in (data.get("chains") or {}).items()}, "back": {}}
anchor = data.get("anchor")
if anchor:
    origin = (anchor["lat"], anchor["lon"], anchor["h"])
    for k, g in (data.get("geoposes") or {}).items():
        out["back"][k] = to_graph(origin, (g["lat"], g.get("lon", g.get("lan")), g["h"]))
json.dump(out, sys.stdout)
