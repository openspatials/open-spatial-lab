// mesh-math.mjs: triangles of a skinned mesh in a pose, and distances and rays against them. Plain numbers, no scene.
// The mesh maths of the avatars build's fitting/body-details.mjs (its lines 37 to 392), byte for byte, with `export` added to
// eachVertex, sub, dot, cross and add3 so body measuring can import them when it moves here. Item placement's face fit
// (process/items/placement.mjs faceFit) casts its rays with rayHits on trianglesOf.
//
// Public API
//   eachVertex(sets, inv, fn)                  world positions of the kept vertices in the current pose, through a frame
//   trianglesOf(sets, inv)                     [[a, b, c], ...] of the kept triangles (sets: [{ mesh, keep }]), through inv
//   finishSteps(steps)                         runs a measurement given in steps (a generator) to its end
//   captureSkinning(meshes)                    the pose a later trianglesOfSteps reads, copied now
//   trianglesOfSteps(sets, inv, capture)       trianglesOf in steps
//   pointTriangleDistance(p, tri)              metres from a point to a triangle
//   triangleTreeSteps(tris)                    the box tree nearestTriangleDistance and rayHits use, built in steps
//   nearestTriangleDistance(p, tris)           metres from a point to the nearest triangle
//   rayHits(o, d, tris, maxT, unique)          { n, nearest }: how many triangles a ray crosses and the nearest t
//   sub, dot, cross, add3                      3-vector helpers on arrays
//
// No DOM use: browser and Node.

import * as THREE from 'three';

// World positions of the kept vertices in the current pose, through a frame.
export function eachVertex(sets, inv, fn) {
  const v = new THREE.Vector3();
  for (const { mesh, keep } of sets) {
    for (let i = 0; i < keep.length; i++) {
      if (!keep[i]) continue;
      mesh.getVertexPosition(i, v);
      v.applyMatrix4(mesh.matrixWorld).applyMatrix4(inv);
      fn(v, i, mesh);
    }
  }
}

export function trianglesOf(sets, inv) {
  return finishSteps(trianglesOfSteps(sets, inv, captureSkinning(sets.map((s) => s.mesh))));
}

// Runs a measurement given in steps (a generator) to its end and returns its result.
export function finishSteps(steps) {
  for (;;) { const r = steps.next(); if (r.done) return r.value; }
}

// The pose a later trianglesOfSteps reads, copied now: per mesh its world matrix, bind matrix and inverse bind matrix, and per
// bone the product bone.matrixWorld x boneInverse that three r186's SkinnedMesh.applyBoneTransform forms for every vertex. A
// mesh whose skinning this cannot repeat exactly (another three revision, an overridden method, active morph targets, not a
// SkinnedMesh) has every vertex read through mesh.getVertexPosition now.
export function captureSkinning(meshes) {
  const capture = new Map();
  for (const mesh of meshes) {
    if (capture.has(mesh)) continue;
    const g = mesh.geometry, S = THREE.SkinnedMesh.prototype;
    const exact = THREE.REVISION === '186' && mesh.isSkinnedMesh && mesh.getVertexPosition === S.getVertexPosition
      && mesh.applyBoneTransform === S.applyBoneTransform && !(g.morphAttributes.position && mesh.morphTargetInfluences);
    if (exact) {
      const { bones, boneInverses } = mesh.skeleton;
      capture.set(mesh, { world: mesh.matrixWorld.clone(), bind: mesh.bindMatrix.clone(), bindInverse: mesh.bindMatrixInverse.clone(),
        bones: bones.map((b, i) => (b && boneInverses[i] ? new THREE.Matrix4().multiplyMatrices(b.matrixWorld, boneInverses[i]) : null)) });
    } else {
      const positions = [], v = new THREE.Vector3();
      for (let i = 0; i < g.attributes.position.count; i++) positions.push(mesh.getVertexPosition(i, v).clone());
      capture.set(mesh, { world: mesh.matrixWorld.clone(), positions });
    }
  }
  return capture;
}

// SkinnedMesh.getVertexPosition of three r186 (Mesh.getVertexPosition without morphs, then applyBoneTransform), with the
// captured matrices in place of the live ones: the same operations in the same order.
const _skinIndex = new THREE.Vector4(), _skinWeight = new THREE.Vector4(), _base = new THREE.Vector4(), _bone = new THREE.Vector4();
function capturedVertex(mesh, c, i, target) {
  const g = mesh.geometry;
  target.fromBufferAttribute(g.attributes.position, i);
  if (c.positions) return target.copy(c.positions[i]);
  _skinIndex.fromBufferAttribute(g.attributes.skinIndex, i);
  _skinWeight.fromBufferAttribute(g.attributes.skinWeight, i);
  _base.set(target.x, target.y, target.z, 1);
  target.set(0, 0, 0);
  _base.applyMatrix4(c.bind);
  for (let k = 0; k < 4; k++) {
    const weight = _skinWeight.getComponent(k);
    if (weight !== 0) target.addScaledVector(_bone.copy(_base).applyMatrix4(c.bones[_skinIndex.getComponent(k)]), weight);
  }
  return target.applyMatrix4(c.bindInverse);
}

// trianglesOf(sets, inv) of the pose in capture, in steps: it yields after every 16 vertices and every 512 triangles read.
export function* trianglesOfSteps(sets, inv, capture) {
  const tris = [];
  const v = new THREE.Vector3();
  let vertices = 0, read = 0;
  for (const { mesh, keep } of sets) {
    const c = capture.get(mesh);
    if (!c) throw new Error('trianglesOfSteps: mesh pose not captured');
    const index = mesh.geometry.index;
    const count = index ? index.count : mesh.geometry.attributes.position.count;
    const at = (k) => (index ? index.getX(k) : k);
    const pos = new Map();
    const p = (i) => {
      if (!pos.has(i)) {
        capturedVertex(mesh, c, i, v);
        v.applyMatrix4(c.world).applyMatrix4(inv);
        pos.set(i, [v.x, v.y, v.z]);
        vertices++;
      }
      return pos.get(i);
    };
    for (let k = 0; k + 2 < count; k += 3) {
      const a = at(k), b = at(k + 1), c3 = at(k + 2);
      if (keep[a] && keep[b] && keep[c3]) tris.push([p(a), p(b), p(c3)]);
      if (vertices >= 16 || ++read >= 512) { vertices = 0; read = 0; yield 2; }
    }
  }
  trianglesFrom.set(tris, sets);
  return tris;
}

// ---------- geometry ----------
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Closest point on the triangle (Ericson's regions), then its distance. Written on scalars: the same operations in the same
// order as the vector form (sub, dot and the region formulas), so the same number, without the short-lived arrays.
export function pointTriangleDistance(p, [a, b, c]) {
  const p0 = p[0], p1 = p[1], p2 = p[2], a0 = a[0], a1 = a[1], a2 = a[2];
  const ab0 = b[0] - a0, ab1 = b[1] - a1, ab2 = b[2] - a2, ac0 = c[0] - a0, ac1 = c[1] - a1, ac2 = c[2] - a2;
  const ap0 = p0 - a0, ap1 = p1 - a1, ap2 = p2 - a2;
  const d1 = ab0 * ap0 + ab1 * ap1 + ab2 * ap2, d2 = ac0 * ap0 + ac1 * ap1 + ac2 * ap2;
  let q0, q1, q2;
  if (d1 <= 0 && d2 <= 0) { q0 = a0; q1 = a1; q2 = a2; }
  else {
    const bp0 = p0 - b[0], bp1 = p1 - b[1], bp2 = p2 - b[2];
    const d3 = ab0 * bp0 + ab1 * bp1 + ab2 * bp2, d4 = ac0 * bp0 + ac1 * bp1 + ac2 * bp2;
    if (d3 >= 0 && d4 <= d3) { q0 = b[0]; q1 = b[1]; q2 = b[2]; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const t = d1 / (d1 - d3); q0 = a0 + ab0 * t; q1 = a1 + ab1 * t; q2 = a2 + ab2 * t; } else {
        const cp0 = p0 - c[0], cp1 = p1 - c[1], cp2 = p2 - c[2];
        const d5 = ab0 * cp0 + ab1 * cp1 + ab2 * cp2, d6 = ac0 * cp0 + ac1 * cp1 + ac2 * cp2;
        if (d6 >= 0 && d5 <= d6) { q0 = c[0]; q1 = c[1]; q2 = c[2]; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const t = d2 / (d2 - d6); q0 = a0 + ac0 * t; q1 = a1 + ac1 * t; q2 = a2 + ac2 * t; } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const t = (d4 - d3) / (d4 - d3 + (d5 - d6));
              q0 = b[0] + (c[0] - b[0]) * t; q1 = b[1] + (c[1] - b[1]) * t; q2 = b[2] + (c[2] - b[2]) * t;
            } else {
              const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
              q0 = a0 + ab0 * v + ac0 * w; q1 = a1 + ab1 * v + ac1 * w; q2 = a2 + ab2 * v + ac2 * w;
            }
          }
        }
      }
    }
  }
  const e0 = p0 - q0, e1 = p1 - q1, e2 = p2 - q2;
  return Math.sqrt(e0 * e0 + e1 * e1 + e2 * e2);
}

// The nearest triangle's distance, exactly as the plain loop `if (e < d) d = e` over every triangle gives it, found through a
// box tree built once per triangles array. Every candidate goes through the unchanged pointTriangleDistance, and the minimum of
// the same values does not depend on the order. A box is skipped only when its distance exceeds the best value by a margin far
// above rounding; thin triangles, whose rounded closest point could stray from their box, are always measured, and points far
// outside the tree take the plain loop.
const triangleTrees = new WeakMap();
// Splits of earlier trees, by the kept-triangle selection a triangles array was read from (trianglesOfSteps records it). The
// same selection in another pose has the same triangle list; when every triangle also falls on the same side of the thin-triangle
// test, its tree keeps the earlier splits (which triangles each node holds) and only the boxes are taken again, from the
// leaves up. Any boxes that hold their triangles give the same distances and ray hits (the pruning tests above and below are
// valid for every such tree), so this changes only the time.
const trianglesFrom = new WeakMap();
const treeSplits = new WeakMap();
function triangleTree(tris) {
  const cached = triangleTrees.get(tris);
  if (cached && cached.count === tris.length) return cached;
  return finishSteps(triangleTreeSteps(tris));
}

// The same tree in steps (it yields every 32 to 64 triangles read and every 128 triangle visits while it splits); measureHollowSteps
// builds it this way before the first distance, where nearestTriangleDistance would build it at once.
export function* triangleTreeSteps(tris) {
  const cached = triangleTrees.get(tris);
  if (cached && cached.count === tris.length) return cached;
  const n = tris.length, box = new Float64Array(6 * n), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const [a, b, c] = tris[i];
    for (let k = 0; k < 3; k++) {
      const min = Math.min(a[k], b[k], c[k]), max = Math.max(a[k], b[k], c[k]);
      box[6 * i + k] = min; box[6 * i + 3 + k] = max;
      if (min < lo[k]) lo[k] = min; if (max > hi[k]) hi[k] = max;
    }
    if (i % 64 === 63) yield 2;
  }
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const margin = 1e-6 * (1 + diag + Math.max(...lo.map(Math.abs), ...hi.map(Math.abs)));
  const always = [], order = [], l1 = (v) => Math.abs(v[0]) + Math.abs(v[1]) + Math.abs(v[2]);
  let edge = 0, reach = 0; // rayHits: the largest |b - a|, |c - a| and vertex, 1-norm, over the tree's triangles
  // The vector form (sub, cross, dot, l1) on scalars: the same operations in the same order.
  const fin = Number.isFinite;
  for (let i = 0; i < n; i++) {
    const [a, b, c] = tris[i], a0 = a[0], a1 = a[1], a2 = a[2], b0 = b[0], b1 = b[1], b2 = b[2], c0 = c[0], c1 = c[1], c2 = c[2];
    const ab0 = b0 - a0, ab1 = b1 - a1, ab2 = b2 - a2, ac0 = c0 - a0, ac1 = c1 - a1, ac2 = c2 - a2, bc0 = c0 - b0, bc1 = c1 - b1, bc2 = c2 - b2;
    const m0 = ab1 * ac2 - ab2 * ac1, m1 = ab2 * ac0 - ab0 * ac2, m2 = ab0 * ac1 - ab1 * ac0, n2 = m0 * m0 + m1 * m1 + m2 * m2;
    const L = Math.sqrt(Math.max(ab0 * ab0 + ab1 * ab1 + ab2 * ab2, ac0 * ac0 + ac1 * ac1 + ac2 * ac2, bc0 * bc0 + bc1 * bc1 + bc2 * bc2));
    const finite = fin(a0) && fin(a1) && fin(a2) && fin(b0) && fin(b1) && fin(b2) && fin(c0) && fin(c1) && fin(c2);
    if (finite && n2 > 0 && 32e3 * Number.EPSILON * L ** 3 * diag * diag < margin * n2) {
      order.push(i);
      edge = Math.max(edge, Math.abs(ab0) + Math.abs(ab1) + Math.abs(ab2), Math.abs(ac0) + Math.abs(ac1) + Math.abs(ac2));
      reach = Math.max(reach, Math.abs(a0) + Math.abs(a1) + Math.abs(a2), Math.abs(b0) + Math.abs(b1) + Math.abs(b2), Math.abs(c0) + Math.abs(c1) + Math.abs(c2));
    } else always.push(i);
    if (i % 32 === 31) yield 2;
  }
  const source = trianglesFrom.get(tris), prior = source && treeSplits.get(source);
  if (prior && prior.n === n && prior.order.length === order.length && order.every((v, i) => v === prior.order[i])) {
    const { ids, starts, ends, lefts, rights } = prior, m = starts.length, nodes = new Array(m);
    let visits = 0;
    for (let x = m - 1; x >= 0; x--) {
      const nd = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], start: starts[x], end: ends[x], left: null, right: null };
      if (lefts[x] < 0) {
        for (let k = 0; k < 3; k++) {
          let lo = Infinity, hi = -Infinity;
          for (let s = nd.start; s < nd.end; s++) { const i = ids[s], min = box[6 * i + k], max = box[6 * i + 3 + k]; if (min < lo) lo = min; if (max > hi) hi = max; }
          nd.min[k] = lo; nd.max[k] = hi;
        }
        visits += nd.end - nd.start;
      } else {
        nd.left = nodes[lefts[x]]; nd.right = nodes[rights[x]];
        for (let k = 0; k < 3; k++) {
          nd.min[k] = nd.right.min[k] < nd.left.min[k] ? nd.right.min[k] : nd.left.min[k];
          nd.max[k] = nd.right.max[k] > nd.left.max[k] ? nd.right.max[k] : nd.left.max[k];
        }
        visits += 2;
      }
      nd.centre = [0, 1, 2].map((k) => (nd.min[k] + nd.max[k]) / 2);
      nd.radius = Math.hypot(nd.max[0] - nd.min[0], nd.max[1] - nd.min[1], nd.max[2] - nd.min[2]) / 2;
      nodes[x] = nd;
      if (visits >= 256) { visits = 0; yield 2; }
    }
    const tree = { count: n, always, ids, root: m ? nodes[0] : null, lo, hi, diag, margin, edge, reach, hint: -1 };
    triangleTrees.set(tris, tree);
    return tree;
  }
  const ids = Int32Array.from(order);
  // Each node: its box over its triangles, then (above 6 triangles) its range split at the middle of the widest spread of
  // triangle centres. A range is split only within itself, so building the nodes from a stack gives the recursive build's tree.
  let visits = 0;
  const node = (start, end) => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], start, end, left: null, right: null });
  const root = ids.length ? node(0, ids.length) : null, stack = root ? [root] : [];
  while (stack.length) {
    const nd = stack.pop(), { start, end } = nd;
    const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 3; k++) {
      let lo = Infinity, hi = -Infinity, clo = Infinity, chi = -Infinity;
      for (let s = start; s < end; s++) {
        const i = ids[s], min = box[6 * i + k], max = box[6 * i + 3 + k], mid = (min + max) / 2;
        if (min < lo) lo = min; if (max > hi) hi = max;
        if (mid < clo) clo = mid; if (mid > chi) chi = mid;
      }
      nd.min[k] = lo; nd.max[k] = hi; cmin[k] = clo; cmax[k] = chi;
    }
    nd.centre = [0, 1, 2].map((k) => (nd.min[k] + nd.max[k]) / 2);
    nd.radius = Math.hypot(nd.max[0] - nd.min[0], nd.max[1] - nd.min[1], nd.max[2] - nd.min[2]) / 2;
    visits += end - start;
    if (visits >= 128) { visits = 0; yield 2; }
    if (end - start <= 6) continue;
    let axis = 0;
    for (let k = 1; k < 3; k++) if (cmax[k] - cmin[k] > cmax[axis] - cmin[axis]) axis = k;
    const split = (cmin[axis] + cmax[axis]) / 2;
    let i = start, j = end - 1;
    while (i <= j) {
      const t = ids[i];
      if ((box[6 * t + axis] + box[6 * t + 3 + axis]) / 2 < split) i++; else { ids[i] = ids[j]; ids[j--] = t; }
    }
    if (i === start || i === end) i = (start + end) >> 1;
    nd.left = node(start, i); nd.right = node(i, end);
    stack.push(nd.right, nd.left);
  }
  const tree = { count: n, always, ids, root, lo, hi, diag, margin, edge, reach, hint: -1 };
  triangleTrees.set(tris, tree);
  if (source) {
    // The splits, nodes in pre-order (a node before its children).
    const list = [], at = new Map();
    for (const st = root ? [root] : []; st.length;) { const nd = st.pop(); at.set(nd, list.length); list.push(nd); if (nd.left) st.push(nd.right, nd.left); }
    treeSplits.set(source, { n, order: Int32Array.from(order), ids, starts: Int32Array.from(list, (x) => x.start), ends: Int32Array.from(list, (x) => x.end),
      lefts: Int32Array.from(list, (x) => (x.left ? at.get(x.left) : -1)), rights: Int32Array.from(list, (x) => (x.right ? at.get(x.right) : -1)) });
  }
  return tree;
}

function boxDistance(p, min, max) {
  let s = 0;
  for (let k = 0; k < 3; k++) { const e = p[k] < min[k] ? min[k] - p[k] : p[k] > max[k] ? p[k] - max[k] : 0; s += e * e; }
  return Math.sqrt(s);
}

export function nearestTriangleDistance(p, tris) {
  let d = Infinity;
  const tree = tris.length >= 32 && p.every(Number.isFinite) ? triangleTree(tris) : null;
  if (!tree || !(boxDistance(p, tree.lo, tree.hi) <= tree.diag)) {
    for (const t of tris) { const e = pointTriangleDistance(p, t); if (e < d) d = e; }
    return d;
  }
  // The previous query's nearest triangle first: it is one of the same values, so it only tightens the pruning sooner.
  let best = tree.hint;
  if (best >= 0) { const e = pointTriangleDistance(p, tris[best]); if (e < d) d = e; }
  for (const i of tree.always) { const e = pointTriangleDistance(p, tris[i]); if (e < d) { d = e; best = i; } }
  const stack = tree.root ? [tree.root] : [];
  while (stack.length) {
    const node = stack.pop();
    if (boxDistance(p, node.min, node.max) > d + tree.margin) continue;
    if (!node.left) {
      for (let s = node.start; s < node.end; s++) { const e = pointTriangleDistance(p, tris[tree.ids[s]]); if (e < d) { d = e; best = tree.ids[s]; } }
      continue;
    }
    const l = boxDistance(p, node.left.min, node.left.max), r = boxDistance(p, node.right.min, node.right.max);
    if (l < r) stack.push(node.right, node.left); else stack.push(node.left, node.right);
  }
  tree.hint = best;
  return d;
}

// The ray's t on one triangle, or NaN when the test above t rejects it.
function rayTriangle(o, d, [a, b, c]) {
  // The same operations as the vector form (sub, cross, dot), on scalars.
  const e10 = b[0] - a[0], e11 = b[1] - a[1], e12 = b[2] - a[2], e20 = c[0] - a[0], e21 = c[1] - a[1], e22 = c[2] - a[2];
  const h0 = d[1] * e22 - d[2] * e21, h1 = d[2] * e20 - d[0] * e22, h2 = d[0] * e21 - d[1] * e20;
  const det = e10 * h0 + e11 * h1 + e12 * h2;
  if (Math.abs(det) < 1e-12) return NaN;
  const f = 1 / det, s0 = o[0] - a[0], s1 = o[1] - a[1], s2 = o[2] - a[2], u = f * (s0 * h0 + s1 * h1 + s2 * h2);
  if (u < 0 || u > 1) return NaN;
  const q0 = s1 * e12 - s2 * e11, q1 = s2 * e10 - s0 * e12, q2 = s0 * e11 - s1 * e10, v = f * (d[0] * q0 + d[1] * q1 + d[2] * q2);
  if (v < 0 || u + v > 1) return NaN;
  return f * (e20 * q0 + e21 * q1 + e22 * q2);
}

// How far from a hit triangle's box the exact line o + t d can pass, or NaN for the plain loop. A hit needs |det| >= 1e-12
// and the computed u, v inside the triangle. det and the numerators of u and v are sums of products a_i d_j e_k, each
// carrying at most 7 roundings, so each errs by at most 1e-14 times the 1-norm product of its factors (edges <= edge,
// |o - a| <= |o| + reach). The exact u, v then differ from the computed ones by at most `slack`, which moves the point by
// at most slack * (|e1| + |e2|). The last term covers the rounding of the box test itself.
function lineSlack(o, d, tree) {
  const D = Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]), S = Math.abs(o[0]) + Math.abs(o[1]) + Math.abs(o[2]) + tree.reach;
  const eDet = 1e-14 * D * tree.edge * tree.edge, eNum = 1e-14 * D * tree.edge * S;
  if (!(eDet < 5e-13) || !Number.isFinite(eNum + S) || ![...o, ...d].every(Number.isFinite)) return NaN;
  const eps = 3 * (1e-15 + (2 * eDet + eNum) / (1e-12 - eDet)) * tree.edge + 1e-9 * (1 + S);
  return eps < 1e3 * (1 + S) ? eps : NaN;
}

// Every triangle the plain loop would count is visited: the tree skips a box only when the line's distance from the box's
// centre exceeds its half diagonal plus eps. n, nearest and the sorted distances do not depend on the visiting order. The
// tree is used only once nearestTriangleDistance has built it for this array (measureHollow); other callers loop.
export function rayHits(o, d, tris, maxT = Infinity, unique = false) {
  let n = 0, nearest = Infinity;
  const distances = unique ? [] : null;
  const test = (tri) => { const t = rayTriangle(o, d, tri); if (t > 1e-9 && t < maxT) { n++; if (t < nearest) nearest = t; distances?.push(t); } };
  const tree = triangleTrees.get(tris), eps = tree && tree.count === tris.length ? lineSlack(o, d, tree) : NaN;
  if (Number.isNaN(eps)) for (const tri of tris) test(tri);
  else {
    for (const i of tree.always) test(tris[i]);
    const dd = dot(d, d), stack = tree.root ? [tree.root] : [];
    while (stack.length) {
      const node = stack.pop(), w = cross(sub(node.centre, o), d), r = node.radius + eps;
      if (dot(w, w) > r * r * dd) continue;
      if (node.left) { stack.push(node.left, node.right); continue; }
      for (let k = node.start; k < node.end; k++) test(tris[tree.ids[k]]);
    }
  }
  if (distances) {
    distances.sort((a, b) => a - b);
    n = distances.filter((t, i) => !i || t - distances[i - 1] > 1e-7).length;
  }
  return { n, nearest };
}

export const add3 = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
