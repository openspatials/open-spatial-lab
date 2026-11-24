// body-details.mjs: measure a rigged body. Reads a glTF scene (loaded by three.js) and its role map, and returns the body
// details: rig structure, roles, rest pose, bone lengths, height, the hollow of each closed hand in each grip pose,
// feet, head and torso volumes. The fields, their units and frames are in BODY-AND-ITEM-DETAILS.md.
//
// Public API
//   measureBody({ id, scene, gltfJson, roleMap, height, sourceRig, packClips, grips })
//       scene: the loaded scene at rest (it is posed and put back). sourceRig: the rig the clips were made on
//       (rig.mjs). packClips: name -> AnimationClip. grips: [{ clip, time, hand, stances? }], the grip poses to measure.
//       Returns the details (plain JSON). Throws when no role table covers the rig.
//   measureHollow({ triangles, axisA, axisF, palmDir, wrist, handLength, palmPoint, knuckleCentre, seed })
//       the cavity of the closed hand nearest the fingers' curl (method in the function's comment). Exported for its checks.
//   measureHollowSteps(same), triangleTreeSteps(tris), trianglesOfSteps(sets, inv, capture), captureSkinning(meshes),
//   finishSteps(steps)
//       the same measurements as generators that yield between bounded pieces of work (a yield's value is the piece's
//       weight, about one hollow-grid distance); finishSteps runs one to its end. captureSkinning copies the pose a later
//       trianglesOfSteps reads. Used to spread a hand-contact measurement over several frames (web/avatar/equipment.mjs).
//   curlCentre({ fingers, axisA, axisF, palmDir, knuckleCentre, handLength })   the centre of the fingers' curl
//   DEFAULT_GRIP                     the pose whose hollow is "the" hollow of each hand
//   measureFaceBack(model, body)     { back_surface_z_m, face } on the rest mesh (model's world frame = the body's frame):
//       back_surface_z_m: the most rearward skin over a back panel's footprint, in the back anchor's frame (holds.mjs
//       fitBack); face: { eye_y_m, eye_source } (the eyeballs' centre height above the head joint) or null when the mesh
//       has no eyeball pair (then tools/measure-body.mjs --eye-y declares it). measureBody adds both
//
// No DOM use: browser and Node.

import * as THREE from 'three';
import { detectRig, ROLE_AIM, SIDES, sideName, HAND_SET, FOOT_SET, fingerRoles, TORSO_ROLES } from '../rig/roles.mjs';
import { wrapFit, describeRig, boneIndex, strongestBoneVertices } from '../rig/rig.mjs';
import { buildRigMap, mapPoseAt } from '../clips/map-clips.mjs';
import { gripFrameFromJoints, gripKey, backAnchor } from '../items/holds.mjs';
import { eachVertex, trianglesOf, finishSteps, sub, dot, cross, pointTriangleDistance, triangleTreeSteps, nearestTriangleDistance, rayHits, add3 } from '../mesh/mesh-math.mjs';
export { trianglesOf, finishSteps, captureSkinning, trianglesOfSteps, pointTriangleDistance, triangleTreeSteps, nearestTriangleDistance, rayHits } from '../mesh/mesh-math.mjs';

export const DEFAULT_GRIP = { l: { clip: 'idle_shield_loop', time: 0 }, r: { clip: 'sword_idle', time: 0 } };

const r6 = (a) => a.map((x) => Math.round(x * 1e6) / 1e6);
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// For a joint outside its skin, qualify one closed interval on the anatomical palm line.
// Callers supply hand-influenced skin only. Open, layered or oppositely wound surfaces are unavailable.
export function palmSurfaceOnLine(origin, direction, triangles) {
  if (!triangles.length) return null;
  const o = origin.toArray(), d = direction.toArray();
  let far = -Infinity;
  for (const triangle of triangles) for (const p of triangle) far = Math.max(far, dot(sub(p, o), d));
  const start = add3(o, d, far + 1e-6), back = d.map(v => -v), hits = [];
  for (const triangle of triangles) {
    const hit = rayHits(start, back, [triangle]);
    if (!Number.isFinite(hit.nearest)) continue;
    const normal = cross(sub(triangle[1], triangle[0]), sub(triangle[2], triangle[0]));
    hits.push({ distance: hit.nearest, normal: dot(normal, d) / Math.sqrt(dot(normal, normal)) });
  }
  hits.sort((a, b) => a.distance - b.distance);
  const unique = hits.filter((h, i) => !i || h.distance - hits[i - 1].distance > 1e-7);
  if (unique.length !== 2 || !(unique[0].normal > 1e-8) || !(unique[1].normal < -1e-8)) return null;
  return { position_m: add3(start, back, unique[0].distance), thickness_m: unique[1].distance - unique[0].distance,
    method: 'oriented-hand-skin-interval', normal_dot_palm: [unique[0].normal, unique[1].normal] };
}

// Share of 16 rays, in the plane across the grip axis, that meet the hand within reach.
function enclosure(p, A, F, tris, reach) {
  const N = [A[1] * F[2] - A[2] * F[1], A[2] * F[0] - A[0] * F[2], A[0] * F[1] - A[1] * F[0]];
  let hit = 0;
  for (let i = 0; i < 16; i++) {
    const t = (i / 16) * 2 * Math.PI, c = Math.cos(t), s = Math.sin(t);
    const d = [F[0] * c + N[0] * s, F[1] * c + N[1] * s, F[2] * c + N[2] * s];
    if (rayHits(p, d, tris, reach).n > 0) hit++;
  }
  return hit / 16;
}

// Inside the hand's skin: an odd number of crossings along most of six directions.
export function insideSkin(p, A, F, tris) {
  const N = [A[1] * F[2] - A[2] * F[1], A[2] * F[0] - A[0] * F[2], A[0] * F[1] - A[1] * F[0]];
  let odd = 0;
  for (const d of [A, F, N, A.map((x) => -x), F.map((x) => -x), N.map((x) => -x)]) if (rayHits(p, d, tris).n % 2) odd++;
  return odd >= 4;
}

// A conservative solid torso core, distinct from the outer weighted-vertex envelope (coat/backpack included).
// Each ball is centred on a torso joint or halfway to the next one. Its radius is the nearest actual torso triangle,
// so an outward protrusion cannot enlarge it past another surface. This does not reconstruct anatomy under clothing.
// Values are in the origin joint's rest-aligned metre frame, as the existing head/torso volumes are.
export function measureTorsoCore(model, roles) {
  model.parent?.updateWorldMatrix(true, false);
  model.updateMatrixWorld(true); // also refresh SkinnedMesh.bindMatrixInverse (updateWorldMatrix alone does not)
  const bones = boneIndex(model), skin = [];
  model.traverse(mesh => { if (mesh.isSkinnedMesh) skin.push({ mesh, keep: new Uint8Array(mesh.geometry.attributes.position.count).fill(1) }); });
  const surfaces = skin.map(set => trianglesOf([set], new THREE.Matrix4())), tris = surfaces.flat();
  // Positive-octant rays alone accepted an open-bottom cube. Require each ray and its opposite to agree.
  const directions = [[1, .37, .19], [.21, 1, .43], [.33, .17, 1]].flatMap(d => [d, d.map(x => -x)])
    .map(d => new THREE.Vector3().fromArray(d).normalize().toArray());
  const out = [];
  const chain = [...TORSO_ROLES, 'neck'].filter(r => bones.has(roles[r]));
  for (let i = 0; i + 1 < chain.length; i++) {
    const role = chain[i], origin = bones.get(roles[role]).getWorldPosition(new THREE.Vector3());
    const end = bones.get(roles[chain[i + 1]]).getWorldPosition(new THREE.Vector3());
    for (const fraction of [0, 0.5]) {
      const p = origin.clone().lerp(end, fraction);
      const crossings = [tris, ...surfaces].map(surface => directions.map(d => rayHits(p.toArray(), d, surface, Infinity, true).n));
      const inside = crossings.some(counts => counts.every(n => n % 2 === 1));
      let radius = Infinity;
      for (const tri of tris) radius = Math.min(radius, pointTriangleDistance(p.toArray(), tri));
      if (Number.isFinite(radius) && radius > 0) out.push({ origin_role: role, frame: 'rest-aligned',
        center_m: p.sub(origin).toArray(), radius_m: radius, method: 'joint-centred-inscribed-sphere', inside,
        qualification: { crossings, predicate: 'three antipodal ray pairs agree on interior; shared triangle edges counted once',
          ...(inside ? {} : { excluded: 'exterior or ambiguous centre' }) } });
    }
  }
  return out;
}

// The centre of the fingers' curl, in the hand frame, in the plane across the knuckle line through the knuckles' centre:
// the mean of the circles through each finger's three joints. Fingers too straight to name a circle (radius over the hand's
// length) do not count; with none left, a quarter of the hand's length off the knuckles on the palm's side.
export function curlCentre({ fingers, axisA, axisF, palmDir, knuckleCentre, handLength }) {
  const N = new THREE.Vector3().crossVectors(axisA, axisF);
  const uv = (p) => [p.dot(axisF), p.dot(N)];
  let su = 0, sv = 0, n = 0;
  for (const [a, b, c] of fingers) {
    const [ax, ay] = uv(a), [bx, by] = uv(b), [cx, cy] = uv(c);
    const den = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(den) < 1e-9) continue;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / den;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / den;
    if (Math.hypot(ux - ax, uy - ay) > handLength) continue;
    su += ux; sv += uy; n++;
  }
  const middle = knuckleCentre.dot(axisA);
  if (!n) return { point: knuckleCentre.clone().addScaledVector(palmDir, 0.25 * handLength), curled: false };
  return { point: axisA.clone().multiplyScalar(middle).addScaledVector(axisF, su / n).addScaledVector(N, sv / n), curled: true };
}

// The hollow. A handle runs along the knuckle line and its middle sits in the middle of the fist, so the search is in the one
// plane across that line through the knuckles' centre. On a grid in that plane (1.5% of the hand's length, in the grip frame from
// the wrist, so a hand on another rig or at another size gets the same grid) the distance to the hand's skin is taken; each local
// furthest point outside the skin, that the hand at least half encloses (8 of 16 rays across the grip axis meet the hand
// within a hand's length), within a fifth of the hand's length of the curl's centre, is a cavity. The hollow is the cavity nearest the centre of the fingers' curl, refined on a
// grid a quarter of the step (method 'curl-cavity'). A hand with no such cavity gets the curl's centre itself (method
// 'curl-centre'); one whose fingers do not curl gets a point 5% of the hand's length off the palm's skin (method 'palm-offset').
// The grid's distances are taken when first read (dist.get): the search reads only the points that can still be a cavity
// (forward of the wrist's tenth and within the fifth of the seed, the same tests on the same numbers) and their eight
// neighbours, so its cavities are those of the whole grid; every point is still there to read. measureHollowSteps is the
// same measurement in steps: it yields after every distance (weight 1), ray test (20) and enclosure (40). A yield's value is
// its piece's weight, in about one grid distance of work (no value: 1).
export function measureHollow(args) {
  return finishSteps(measureHollowSteps(args));
}

export function* measureHollowSteps({ triangles, axisA, axisF, palmDir, wrist, handLength, palmPoint, knuckleCentre, seed, seedIsCurl = true, allCandidates = false, adjacentPlanes = true }) {
  const A = axisA.toArray(), F = axisF.toArray(), P = palmDir.toArray(), W = wrist.toArray(), K = knuckleCentre.toArray(), S = seed.toArray();
  const N = cross(A, F);
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const t of triangles) for (const v of t) {
    const rel = sub(v, W), c = [dot(rel, F), dot(rel, N)];
    for (let k = 0; k < 2; k++) { if (c[k] < lo[k]) lo[k] = c[k]; if (c[k] > hi[k]) hi[k] = c[k]; }
  }
  const reach = handLength;
  const step = handLength * 0.015;
  const middle = dot(sub(K, W), A);
  const at = (j, k) => [W[0] + A[0] * middle + F[0] * j + N[0] * k, W[1] + A[1] * middle + F[1] * j + N[1] * k, W[2] + A[2] * middle + F[2] * j + N[2] * k];
  const skinDistance = (p) => nearestTriangleDistance(p, triangles);
  const skinMargin = 0.015 * handLength;
  const jLo = Math.floor(lo[0] / step), jHi = Math.ceil(hi[0] / step), kLo = Math.floor(lo[1] / step), kHi = Math.ceil(hi[1] / step);
  const key = (j, k) => `${j},${k}`;
  const taken = new Map(), width = kHi - kLo + 1, inGrid = (j, k) => triangles.length > 0 && j >= jLo && j <= jHi && k >= kLo && k <= kHi;
  const fresh = (j, k) => inGrid(j, k) && !taken.has((j - jLo) * width + (k - kLo));
  const read = (j, k) => {
    if (!inGrid(j, k)) return undefined;
    const id = (j - jLo) * width + (k - kLo);
    let d = taken.get(id);
    if (d === undefined) { d = skinDistance(at(j * step, k * step)); taken.set(id, d); }
    return d;
  };
  const dist = {
    get(id) { const [j, k] = id.split(',').map(Number); return read(j, k); },
    get size() { return triangles.length ? (jHi - jLo + 1) * (kHi - kLo + 1) : 0; },
  };
  if (triangles.length >= 32 && [...W, ...A, ...F].every(Number.isFinite)) yield* triangleTreeSteps(triangles);
  const cavities = [];
  for (let j = jLo + 1; j < jHi; j++) for (let k = kLo + 1; k < kHi; k++) {
    const p = at(j * step, k * step);
    const rel = sub(p, W);
    if (dot(rel, F) < 0.1 * handLength) continue; // past the wrist
    const off = sub(p, S);
    const from_seed = Math.sqrt(dot(off, off));
    if (from_seed > 0.2 * handLength) continue; // open air above a tight fist is no hollow
    const first = fresh(j, k), d = read(j, k);
    if (first) yield;
    if (d < skinMargin) continue;
    let top = true;
    for (let u = -1; u <= 1 && top; u++) for (let v = -1; v <= 1; v++) {
      if (!(u || v)) continue;
      const near = fresh(j + u, k + v), e = read(j + u, k + v);
      if (near) yield;
      if (e > d) { top = false; break; }
    }
    if (!top) continue;
    const inside = insideSkin(p, A, F, triangles);
    yield 20;
    if (inside) continue;
    const enclosed = enclosure(p, A, F, triangles, reach);
    yield 40;
    if (enclosed < 0.5) continue;
    cavities.push({ p, d, from_seed });
  }
  cavities.sort((x, y) => x.from_seed - y.from_seed);
  if (cavities.length) {
    const refined = [];
    const fine = step / 4;
    for (const cavity of allCandidates ? cavities : cavities.slice(0, 1)) {
      let best = cavity;
      const start = best.p;
      for (let j = -4; j <= 4; j++) for (let k = -4; k <= 4; k++) {
        const p = [start[0] + (F[0] * j + N[0] * k) * fine, start[1] + (F[1] * j + N[1] * k) * fine, start[2] + (F[2] * j + N[2] * k) * fine];
        const d = skinDistance(p), off = sub(p, S);
        yield;
        // Refinement must retain every qualification used to admit the coarse cavity.
        if (d > best.d && dot(sub(p, W), F) >= 0.1 * handLength && Math.hypot(...off) <= 0.2 * handLength) {
          const inside = insideSkin(p, A, F, triangles);
          yield 20;
          if (!inside) {
            const enclosed = enclosure(p, A, F, triangles, reach);
            yield 40;
            if (enclosed >= 0.5) best = { ...best, p, d };
          }
        }
      }
      refined.push(best);
    }
    const best = refined[0];
    const enclosures = [];
    for (const c of allCandidates ? refined : [best]) { enclosures.push(enclosure(c.p, A, F, triangles, reach)); yield 40; }
    return { position_m: r6(best.p), radius_m: r4(best.d), enclosure: r4(enclosures[0]), cavities: cavities.length, method: 'curl-cavity', qualified: true,
      ...(allCandidates ? { candidates: refined.map((c, i) => ({ position_m: r6(c.p), radius_m: r4(c.d), enclosure: r4(enclosures[i]) })) } : {}) };
  }
  // No cavity. A hand that curls: the curl's centre. A hand that does not: off the palm's skin.
  const radius = 0.05 * handLength;
  const p = seedIsCurl ? S : add3(palmPoint.toArray(), P, radius);
  const distance = triangles.length ? skinDistance(p) : 0, enclosed = enclosure(p, A, F, triangles, reach);
  yield 40;
  const qualified = triangles.length > 0 && distance >= skinMargin && enclosed >= 0.5 && !insideSkin(p, A, F, triangles)
    && dot(sub(p, W), F) >= 0.1 * handLength && Math.hypot(...sub(p, S)) <= 0.2 * handLength;
  const central = { position_m: r6(p), radius_m: r4(seedIsCurl ? distance : radius), enclosure: r4(enclosed), cavities: 0,
    method: seedIsCurl ? 'curl-centre' : 'palm-offset', qualified };
  if (qualified || !adjacentPlanes || !triangles.length) return central;
  // A single anatomical slice can miss a narrow void. Only a failed central result expands by one original step;
  // recursive calls use the identical search/refinement and cannot expand again or admit nonmax fallback points.
  const candidates = [];
  for (const offset of [-step, step]) {
    const measured = yield* measureHollowSteps({ triangles, axisA, axisF, palmDir, wrist, handLength, palmPoint,
      knuckleCentre: knuckleCentre.clone().addScaledVector(axisA, offset), seed, seedIsCurl,
      allCandidates: true, adjacentPlanes: false });
    if (measured.qualified && measured.method === 'curl-cavity') {
      for (const candidate of measured.candidates) candidates.push({ ...candidate, plane_offset_m: offset });
    }
  }
  candidates.sort((a, b) => new THREE.Vector3().fromArray(a.position_m).distanceToSquared(seed)
    - new THREE.Vector3().fromArray(b.position_m).distanceToSquared(seed));
  if (!candidates.length) return central;
  return { ...candidates[0], cavities: candidates.length, method: 'curl-cavity', qualified: true,
    ...(allCandidates ? { candidates } : {}) };
}

// ---------- the measurer ----------
function axisName(v) {
  const abs = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
  const k = abs.indexOf(Math.max(...abs));
  const sign = [v.x, v.y, v.z][k] >= 0 ? '+' : '-';
  return { along: sign + 'xyz'[k], off_deg: Math.round(Math.acos(Math.min(1, abs[k])) * (180 / Math.PI) * 100) / 100 };
}

const restAligned = (pos) => new THREE.Matrix4().makeTranslation(-pos.x, -pos.y, -pos.z);

function boxOf(sets, inv) {
  const box = new THREE.Box3();
  let n = 0;
  eachVertex(sets, inv, (v) => { box.expandByPoint(v); n++; });
  return n ? { min_m: r6(box.min.toArray()), max_m: r6(box.max.toArray()), vertices: n } : { min_m: null, max_m: null, vertices: 0 };
}

export function measureBody({ id, scene, gltfJson = null, roleMap = null, height = 1.75, sourceRig, packClips, grips = [], facingYaw = null, scale = null }) {
  const names = [];
  scene.traverse((o) => { if (o.isBone) names.push(o.name); });
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) throw new Error(`bone names repeat: ${[...new Set(dupes)].join(', ')}`);
  const rig = detectRig(names, { gltfJson, roleMap });
  if (!rig) throw new Error(`no role table covers this rig (${names.length} bones)`);
  const { roles } = rig;
  const fitted = wrapFit(scene, roles, { height, facingYaw, scale });
  const { fit } = fitted;
  const idx = boneIndex(fit);
  const described = describeRig(fit, roles, { structure: rig.structure });
  const node = (role) => (roles[role] ? described.nodes[roles[role]] : null);
  const P = (role) => new THREE.Vector3().fromArray(node(role).position_m);
  const Rq = (role) => new THREE.Quaternion().fromArray(node(role).rotation);
  const has = (role) => !!roles[role];
  const dist = (a, b) => P(a).distanceTo(P(b));

  // Bone lengths and axes.
  const bone_lengths_m = {};
  const bone_axes = {};
  for (const role of Object.keys(roles)) {
    const aim = ROLE_AIM[role];
    if (!aim || !has(aim)) continue;
    const seg = P(aim).sub(P(role));
    bone_lengths_m[role] = r4(seg.length());
    if (seg.length() > 1e-4) bone_axes[role] = axisName(seg.normalize().applyQuaternion(Rq(role).invert()));
  }

  // Rest pose kind, from the arms and legs.
  const droop = (s) => {
    const n = sideName(s);
    const d = P(`${n}LowerArm`).sub(P(`${n}UpperArm`)).normalize();
    return Math.asin(-d.y) * (180 / Math.PI);
  };
  const bend = (a, b, c) => {
    const u = P(b).sub(P(a)).normalize(), v = P(c).sub(P(b)).normalize();
    return Math.acos(Math.min(1, u.dot(v))) * (180 / Math.PI);
  };
  const arm_droop_deg = Object.fromEntries(SIDES.map((s) => [s, r4(droop(s))]));
  const elbow_bend_deg = Object.fromEntries(SIDES.map((s) => { const n = sideName(s); return [s, r4(bend(`${n}UpperArm`, `${n}LowerArm`, `${n}Hand`))]; }));
  const leg_splay_deg = Object.fromEntries(SIDES.map((s) => { const n = sideName(s); const d = P(`${n}LowerLeg`).sub(P(`${n}UpperLeg`)).normalize(); return [s, r4(Math.acos(Math.min(1, -d.y)) * (180 / Math.PI))]; }));
  const meanDroop = (arm_droop_deg.l + arm_droop_deg.r) / 2;

  // Volumes (rest-aligned frames: origin at the role's joint, the avatar's axes).
  const namesOf = (rs) => rs.map((r) => roles[r]).filter(Boolean);
  const volume = (rs, originRole) => ({ origin_role: originRole, frame: 'rest-aligned', ...boxOf(strongestBoneVertices(fit, namesOf(rs)), restAligned(P(originRole))) });
  const head = volume(['head', 'headTip'], 'head');
  const torso = volume(TORSO_ROLES, 'hips');
  const torso_parts = Object.fromEntries(TORSO_ROLES.filter(has).map((r) => [r, volume([r], r)]));

  // Feet.
  const footOf = (s) => {
    const n = sideName(s);
    const sets = strongestBoneVertices(fit, namesOf(FOOT_SET(s)));
    const ankle = P(`${n}Foot`);
    const toe = has(`${n}Toes`) ? P(`${n}Toes`) : null;
    let fwd = toe ? toe.clone().sub(ankle) : new THREE.Vector3(0, 0, 1);
    fwd.y = 0;
    if (fwd.length() < 1e-4) fwd = new THREE.Vector3(0, 0, 1);
    fwd.normalize();
    const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd);
    let lo = Infinity, hi = -Infinity, sl = Infinity, sh = -Infinity, bottom = Infinity, n_v = 0;
    const id4 = new THREE.Matrix4();
    let heel = null, tip = null;
    eachVertex(sets, id4, (v) => {
      const a = v.clone().sub(ankle);
      const u = a.dot(fwd), w = a.dot(side);
      if (u < lo) { lo = u; heel = v.clone(); }
      if (u > hi) { hi = u; tip = v.clone(); }
      if (w < sl) sl = w;
      if (w > sh) sh = w;
      if (v.y < bottom) bottom = v.y;
      n_v++;
    });
    const footQ = Rq(`${n}Foot`).invert();
    const inFoot = (v) => r6(v.clone().sub(ankle).applyQuaternion(footQ).toArray());
    return {
      length_m: r4(hi - lo), width_m: r4(sh - sl), sole_height_m: r4(ankle.y - bottom),
      ball_height_m: toe ? r4(toe.y - bottom) : null,
      heel_m: inFoot(heel), toe_tip_m: inFoot(tip), lowest_y_m: r4(bottom), vertices: n_v,
      sole_points_m: solePoints(s, ankle, toe),
    };
  };
  // The sole: the vertices furthest in every direction of the lower half (straight down, then 30 and 60 degrees off it
  // at twelve headings), per bone, in that bone's axes from its joint. A foot pitched by its clip rests on one of them.
  function solePoints(s, ankle, toe) {
    const n = sideName(s);
    const dirs = [new THREE.Vector3(0, -1, 0)];
    for (const tilt of [30, 60]) for (let k = 0; k < 12; k++) {
      const a = (k / 12) * 2 * Math.PI, t = (tilt * Math.PI) / 180;
      dirs.push(new THREE.Vector3(Math.sin(t) * Math.cos(a), -Math.cos(t), Math.sin(t) * Math.sin(a)));
    }
    const part = (rs, joint, q) => {
      const best = dirs.map(() => ({ d: -Infinity, v: null }));
      eachVertex(strongestBoneVertices(fit, namesOf(rs)), new THREE.Matrix4(), (v) => {
        dirs.forEach((dir, i) => { const x = v.dot(dir); if (x > best[i].d) best[i] = { d: x, v: v.clone() }; });
      });
      const seen = new Set();
      const out = [];
      for (const b of best) {
        if (!b.v) continue;
        const key = b.v.toArray().join();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r6(b.v.clone().sub(joint).applyQuaternion(q).toArray()));
      }
      return out;
    };
    return {
      foot: part([`${n}Foot`], ankle, Rq(`${n}Foot`).invert()),
      toes: toe ? part([`${n}Toes`, `${n}ToeTip`], toe, Rq(`${n}Toes`).invert()) : [],
    };
  }
  const feet = { l: footOf('l'), r: footOf('r') };

  // Hands: the grip frame from the rest joints, then one hollow per grip pose.
  const map = buildRigMap(sourceRig, described);
  const handOf = (s) => {
    const n = sideName(s);
    const wrist = P(`${n}Hand`);
    const qInv = Rq(`${n}Hand`).invert();
    const inHand = (role) => P(role).sub(wrist).applyQuaternion(qInv);
    const { a, f } = gripFrameFromJoints(inHand(`${n}IndexProximal`), inHand(`${n}LittleProximal`), inHand(`${n}MiddleProximal`));
    const normal = new THREE.Vector3().crossVectors(a, f);
    // The palm faces a x f on the right hand, the opposite on the left (a right-handed basis on mirrored hands).
    const palmDir = s === 'r' ? normal.clone() : normal.clone().negate();
    const knuckleDist = inHand(`${n}MiddleProximal`).length();
    let fingerReach = knuckleDist;
    // To the last joint, not the tip: many rigs have no tip bone.
    for (const seg of ['MiddleProximal', 'MiddleIntermediate']) {
      const aim = ROLE_AIM[n + seg];
      if (has(n + seg) && has(aim)) fingerReach += dist(n + seg, aim);
    }
    const knuckleCentre = ['Index', 'Middle', 'Ring', 'Little'].reduce((acc, f) => acc.add(inHand(`${n}${f}Proximal`)), new THREE.Vector3()).multiplyScalar(0.25);
    let sets = strongestBoneVertices(fit, namesOf(HAND_SET(s)));
    const toHandFrame = new THREE.Matrix4().compose(wrist, Rq(`${n}Hand`), new THREE.Vector3(1, 1, 1)).invert();
    // Palm: from the middle of the wrist-to-knuckle line, along the palm direction, to the skin at rest.
    let restTris = trianglesOf(sets, toHandFrame);
    const mid = inHand(`${n}MiddleProximal`).multiplyScalar(0.5);
    const out = rayHits(mid.toArray(), palmDir.toArray(), restTris);
    const back = rayHits(mid.toArray(), palmDir.clone().negate().toArray(), restTris);
    let interval = null;
    // No skin behind the line's middle: the joint line lies outside the hand (game-doozy's right hand, 1.5 mm off its
    // back), so the first hit ahead is the back of the hand entered from outside, not the palm. Qualify the interval.
    if (!Number.isFinite(out.nearest) || !Number.isFinite(back.nearest)) {
      const shared = strongestBoneVertices(fit, namesOf(HAND_SET(s)), { includeShared: true });
      const sharedTris = trianglesOf(shared, toHandFrame);
      interval = palmSurfaceOnLine(mid, palmDir, sharedTris);
      if (interval) { sets = shared; restTris = sharedTris; }
    }
    const palm = interval ? new THREE.Vector3().fromArray(interval.position_m)
      : mid.clone().addScaledVector(palmDir, Number.isFinite(out.nearest) ? out.nearest : 0);
    // Finger bones keep their rest rotations to go back to.
    const fingerBones = fingerRoles(s).filter(has).map((r) => idx.get(roles[r]));
    const rest = fingerBones.map((b) => b.quaternion.clone());
    const poseBones = [...new Set(Object.values(roles))].map(name => idx.get(name)).filter(Boolean);
    const poseRest = poseBones.map(b => b.quaternion.clone());
    const hollows = {};
    for (const g of grips.filter((x) => x.hand === s)) {
      const clip = packClips[g.clip];
      if (!clip) throw new Error(`grip clip ${g.clip} not in the pack`);
      const pose = mapPoseAt(clip, map, fingerRoles(s).filter(has), g.time);
      for (const b of fingerBones) if (pose[b.name]) b.quaternion.copy(pose[b.name]);
      fit.updateMatrixWorld(true);
      const tris = trianglesOf(sets, toHandFrame);
      const jointNow = (r) => (has(r) ? idx.get(roles[r]).getWorldPosition(new THREE.Vector3()).applyMatrix4(toHandFrame) : null);
      const fingers = ['Index', 'Middle', 'Ring', 'Little'].map((fi) => ['Proximal', 'Intermediate', 'Distal'].map((j) => jointNow(n + fi + j))).filter((x) => x.every(Boolean));
      const curl = curlCentre({ fingers, axisA: a, axisF: f, palmDir, knuckleCentre, handLength: fingerReach });
      const measured = measureHollow({ triangles: tris, axisA: a, axisF: f, palmDir, wrist: new THREE.Vector3(), handLength: fingerReach,
        palmPoint: palm, knuckleCentre, seed: curl.point, seedIsCurl: curl.curled, allCandidates: true });
      const { candidates, ...hollow } = measured;
      // A fixed finger grip can deform differently in the catalog's arm stances. Prefer the measured rest cavity
      // whose location survives those source poses; no runtime observer or item contact is an input here.
      if (candidates?.length > 1 && g.stances?.length) {
        const scores = candidates.map(() => 0), samples = [];
        for (const stanceName of g.stances) {
          const stance = packClips[stanceName];
          if (!stance) throw new Error(`stance clip ${stanceName} not in the pack`);
          for (const time of [0, stance.duration / 3, 2 * stance.duration / 3]) {
            const stancePose = mapPoseAt(stance, map, Object.keys(roles), time);
            poseBones.forEach((b, i) => b.quaternion.copy(stancePose[b.name] ?? poseRest[i]));
            for (const b of fingerBones) if (pose[b.name]) b.quaternion.copy(pose[b.name]);
            fit.updateMatrixWorld(true);
            const handBone = idx.get(roles[n + 'Hand']);
            const toPose = new THREE.Matrix4().compose(handBone.getWorldPosition(new THREE.Vector3()),
              handBone.getWorldQuaternion(new THREE.Quaternion()), new THREE.Vector3(1, 1, 1)).invert();
            const posedTris = trianglesOf(sets, toPose);
            const posedFingers = ['Index', 'Middle', 'Ring', 'Little'].map(fi => ['Proximal', 'Intermediate', 'Distal'].map(seg =>
              idx.get(roles[n + fi + seg]).getWorldPosition(new THREE.Vector3()).applyMatrix4(toPose)));
            const posedCurl = curlCentre({ fingers: posedFingers, axisA: a, axisF: f, palmDir, knuckleCentre, handLength: fingerReach });
            const observed = measureHollow({ triangles: posedTris, axisA: a, axisF: f, palmDir, wrist: new THREE.Vector3(), handLength: fingerReach,
              palmPoint: palm, knuckleCentre, seed: posedCurl.point, seedIsCurl: posedCurl.curled, allCandidates: true });
            const alternatives = observed.qualified ? observed.candidates ?? [observed] : [];
            candidates.forEach((candidate, i) => {
              const p = new THREE.Vector3().fromArray(candidate.position_m);
              scores[i] = Math.max(scores[i], Math.min(...alternatives.map(c => p.distanceTo(new THREE.Vector3().fromArray(c.position_m)))));
            });
            samples.push({ clip: stanceName, time, qualified: observed.qualified });
          }
        }
        const best = scores.indexOf(Math.min(...scores));
        if (Number.isFinite(scores[best])) Object.assign(hollow, candidates[best], {
          stance_selection: { samples, maximum_cavity_distance_m: scores[best] } });
        poseBones.forEach((b, i) => b.quaternion.copy(poseRest[i]));
      }
      hollows[gripKey(g)] = { ...hollow, curl_centre_m: r6(curl.point.toArray()) };
      fingerBones.forEach((b, i) => b.quaternion.copy(rest[i]));
    }
    fit.updateMatrixWorld(true);
    const key = gripKey(DEFAULT_GRIP[s]);
    return {
      frame: 'hand bone axes, metres, origin at the wrist joint',
      grip_frame: { knuckle_axis: r6(a.toArray()), forward_axis: r6(f.toArray()), palm_direction: r6(palmDir.toArray()) },
      palm_m: r6(palm.toArray()),
      palm_thickness_m: interval ? r4(interval.thickness_m)
        : Number.isFinite(out.nearest) && Number.isFinite(back.nearest) ? r4(out.nearest + back.nearest) : null,
      hand_length_m: r4(fingerReach),
      triangles: restTris.length,
      hollow: hollows[key] ? { grip: key, ...hollows[key] } : null,
      hollows,
    };
  };
  const hands = { l: handOf('l'), r: handOf('r') };

  const lowerToe = Math.min(...SIDES.map((s) => (has(`${sideName(s)}Toes`) ? P(`${sideName(s)}Toes`).y : P(`${sideName(s)}Foot`).y)));
  const hb = (v, k) => (v.max_m ? v.max_m[k] - v.min_m[k] : null);
  // The forearm's thickness: the 90th percentile of its vertices' distance from the elbow-to-wrist line.
  const forearmRadius = () => {
    const ds = [];
    for (const side of SIDES) {
      const n = sideName(side);
      const a = P(`${n}LowerArm`), b = P(`${n}Hand`);
      const u = b.clone().sub(a);
      const L = u.length();
      if (L < 1e-4) continue;
      u.multiplyScalar(1 / L);
      eachVertex(strongestBoneVertices(fit, namesOf([`${n}LowerArm`])), new THREE.Matrix4(), (v) => {
        const w = v.clone().sub(a);
        const t = Math.max(0, Math.min(L, w.dot(u)));
        ds.push(w.distanceTo(u.clone().multiplyScalar(t)));
      });
    }
    ds.sort((x, y) => x - y);
    return ds.length ? r4(ds[Math.floor(0.9 * (ds.length - 1))]) : null;
  };
  const measures = {
    forearm_radius_m: forearmRadius(),
    height_m: r4(fitted.height_m),
    hips_height_m: r4(P('hips').y - lowerToe),
    standing_hips_height_m: r4(map.target_hips_height_m),
    leg_length_m: r4((dist('leftUpperLeg', 'leftLowerLeg') + dist('leftLowerLeg', 'leftFoot') + dist('rightUpperLeg', 'rightLowerLeg') + dist('rightLowerLeg', 'rightFoot')) / 2),
    arm_length_m: r4((dist('leftUpperArm', 'leftLowerArm') + dist('leftLowerArm', 'leftHand') + dist('rightUpperArm', 'rightLowerArm') + dist('rightLowerArm', 'rightHand')) / 2),
    shoulder_width_m: r4(dist('leftUpperArm', 'rightUpperArm')),
    hip_width_m: r4(dist('leftUpperLeg', 'rightUpperLeg')),
    torso_height_m: has('neck') ? r4(dist('hips', 'neck')) : r4(dist('hips', 'head')),
    torso_width_m: r4(hb(torso, 0)),
    torso_depth_m: r4(hb(torso, 2)),
    head_height_m: r4(hb(head, 1)),
    head_width_m: r4(hb(head, 0)),
    head_depth_m: r4(hb(head, 2)),
  };

  const body = {
    schema: 'osl-fitting-body/1',
    id,
    units: 'metres and unit quaternions [x, y, z, w]; avatar frame: +X the avatar\'s left, +Y up, +Z forward',
    rig: {
      structure: rig.structure,
      role_source: rig.source,
      bones: names.length,
      facing_yaw_rad: fitted.facing_yaw_rad,
      drawn_scale: fitted.scale,
      natural_height_m: fitted.natural_height_m,
      missing_roles: rig.missing,
      rest_pose_kind: Math.abs(meanDroop) < 20 ? 'T' : 'A',
      arm_droop_deg, elbow_bend_deg, leg_splay_deg,
    },
    roles,
    measures,
    bone_lengths_m,
    bone_axes,
    hands,
    feet,
    volumes: { head, torso, torso_parts },
    rest_pose: described.nodes,
  };
  const { back_surface_z_m, face } = measureFaceBack(fit, body);
  body.measures.back_surface_z_m = back_surface_z_m;
  body.face = face;
  return body;
}

// The back panel's footprint around the back anchor (airport items review, rule B: the backpack's flat panel at scale 1).
export const BACK_PANEL = { x: [-0.10, 0.10], y: [-0.22, 0.12], step: 0.01 };

// Rest-mesh measures for worn face and back items (holds.mjs fitFace, fitBack). model: the avatar at rest, its world frame the
// body's frame (measureBody's fit, or a prepared avatar library's template).
export function measureFaceBack(model, body) {
  model.updateMatrixWorld(true);
  const sets = [];
  model.traverse((o) => { if (o.isSkinnedMesh) sets.push({ mesh: o, keep: new Uint8Array(o.geometry.attributes.position.count).fill(1) }); });
  const tris = trianglesOf(sets, new THREE.Matrix4());
  // Back: rays along +Z from behind the body over the panel footprint; the first skin hit nearest the back is the plane.
  const a = body.rest_pose[body.roles[backAnchor(body)]].position_m;
  let back = Infinity;
  for (let x = BACK_PANEL.x[0]; x <= BACK_PANEL.x[1] + 1e-9; x += BACK_PANEL.step) {
    for (let y = BACK_PANEL.y[0]; y <= BACK_PANEL.y[1] + 1e-9; y += BACK_PANEL.step) {
      const h = rayHits([a[0] + x, a[1] + y, a[2] - 3], [0, 0, 1], tris);
      if (Number.isFinite(h.nearest)) back = Math.min(back, h.nearest - 3);
    }
  }
  return { back_surface_z_m: Number.isFinite(back) ? r4(back) : null, face: eyePair(sets, body) };
}

// The eyes: two separate mesh pieces, round seen from the front, mirrored across the head's middle, near the face (centre
// ahead of 0.6 of the head's front) and a tenth to a quarter of the head's width off the middle; of several such pairs the
// largest (Adam's beard has small mirrored pieces). Their mean centre height above the head joint, or null. (Hair strands on
// Elizabeth and Sophie are pairs too, at 0.27 to 0.30 of the head's width and further back.)
function eyePair(sets, body) {
  const hp = new THREE.Vector3().fromArray(body.rest_pose[body.roles.head].position_m), hw = body.measures.head_width_m;
  const head = body.volumes.head, v = new THREE.Vector3(), pieces = [];
  for (const { mesh } of sets) {
    const g = mesh.geometry, n = g.attributes.position.count, index = g.index;
    if (!index) continue;
    const parent = Int32Array.from({ length: n }, (_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const join = (i, j) => { const a = find(i), b = find(j); if (a !== b) parent[b] = a; };
    for (let k = 0; k + 2 < index.count; k += 3) { join(index.getX(k), index.getX(k + 1)); join(index.getX(k), index.getX(k + 2)); }
    const at = [], seen = new Map();
    for (let i = 0; i < n; i++) {
      at.push(mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld).sub(hp).clone());
      const key = at[i].toArray().map((x) => Math.round(x * 1e5)).join(','); // split seams are one piece
      if (seen.has(key)) join(seen.get(key), i); else seen.set(key, i);
    }
    const boxes = new Map();
    for (let i = 0; i < n; i++) { const r = find(i); if (!boxes.has(r)) boxes.set(r, new THREE.Box3()); boxes.get(r).expandByPoint(at[i]); }
    for (const b of boxes.values()) {
      const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
      if (s.x < 0.08 * hw || s.x > 0.3 * hw || s.y / s.x < 0.75 || s.y / s.x > 1.33) continue;
      if (c.z < 0.6 * head.max_m[2] || c.y < head.min_m[1] || c.y > head.max_m[1] || Math.abs(c.x) < 0.1 * hw || Math.abs(c.x) > 0.25 * hw) continue;
      pieces.push({ c, s });
    }
  }
  let best = null;
  for (const p of pieces) for (const q of pieces) {
    if (p.c.x <= 0 || q.c.x >= 0 || Math.abs(p.c.x + q.c.x) > 0.006 || Math.abs(p.c.y - q.c.y) > 0.004 || Math.abs(p.c.z - q.c.z) > 0.006) continue;
    if (Math.abs(p.s.x - q.s.x) > 0.2 * p.s.x) continue;
    if (!best || p.s.x > best.size) best = { size: p.s.x, y: (p.c.y + q.c.y) / 2 };
  }
  return best ? { eye_y_m: r4(best.y), eye_source: 'measured: eyeball pair on the rest mesh' } : null;
}
