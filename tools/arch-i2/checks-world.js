'use strict';

/*
 * Iteration 2, whole worlds.
 *
 *   I9   linking {B}/wow/world shows B's default graph at X and B's other anchored graph where the
 *        GeoPoses put it (EPSG 9837, against the Python reference); a graph with no anchor is not shown;
 *        node ids stay unique across B's graphs
 *   I10  positions of B's content relative to B's graph origin match the composed scene, so a client
 *        can re-root into B
 *   I12  the included world's environment does not apply to the host: under X the point light is
 *        present and the directional light and the camera are not
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, run, python, makeTempDir } = require('../arch-i1/lib');
const w = require('./worlds');
const { reference } = require('./scenario');

const G2_LON = -122.2973353623;

/** World B with three graphs: 1 anchored at G1, 2 anchored 200 m east, 3 with no anchor; a marker node in each. */
async function threeGraphWorld(impl, port) {
  const B = await w.world('b', port, {
    base: '/w/b',
    edits: impl.serverEdits,
    config: { spatial_anchors: { graphs: [{ id: 1, geoPose: w.pose(w.G1) }, { id: 2, geoPose: w.pose({ lat: 47.7, lon: G2_LON, h: 11.5 }) }, { id: 3 }] } },
  });
  const markers = {};
  for (const g of [1, 2, 3]) {
    const [m] = await B.add(g, await B.rootOf(g), [{ label: 'marker ' + g, localTransform: w.translation(0, 0, 0) }]);
    const [child] = await B.add(g, m, [{ label: 'child of marker ' + g, localTransform: w.yawScaled(15, 1, 1, 0.5, -1) }]);
    markers[g] = { marker: m, child };
  }
  return { B, markers };
}

/** Every node id in one of B's graphs, walked by node URL in the flat form. */
async function idsOf(B, graph) {
  const ids = [];
  const queue = [await B.rootOf(graph)];
  while (queue.length) {
    const id = queue.shift();
    const r = await fetch(B.nodeUrl(graph, id) + '?nodeForm=flat', { headers: { Accept: w.WOW } });
    const node = await r.json();
    ids.push(node.id);
    queue.push(...(node.children || []));
  }
  return ids;
}

// A plain column-major multiply, written here so I10 does not lean on the client's own.
function mul(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) for (let k = 0; k < 4; k += 1) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));

/** The mount module with a planted fault in the client module it imports. */
async function mountModule(edits) {
  if (!edits || !edits.length) return import(pathToFileURL(path.join(ROOT, 'web', 'wow-inclusion-mount.mjs')).href);
  const dir = makeTempDir('i12');
  let source = fs.readFileSync(path.join(ROOT, 'web', 'wow-inclusion.mjs'), 'utf8');
  for (const [from, to] of edits) {
    if (source.split(from).length !== 2) throw new Error('mutant edit does not match once: ' + from.slice(0, 60));
    source = source.replace(from, () => to);
  }
  fs.writeFileSync(path.join(dir, 'wow-inclusion.mjs'), source);
  for (const sibling of ['wow-inclusion-mount.mjs', 'wow-geopose.mjs', 'wow-geopose.js']) fs.copyFileSync(path.join(ROOT, 'web', sibling), path.join(dir, sibling));
  return import(pathToFileURL(path.join(dir, 'wow-inclusion-mount.mjs')).href);
}

async function worldChecks(ports) {
  // ---- I9 ---------------------------------------------------------------------------------------------
  const flatEarth = { clientEdits: [['  const origin = ecefToLocal(base, other.origin);', '  const origin = [(other.geo.lon - base.geo.lon) * 111320 * Math.cos((base.geo.lat * Math.PI) / 180), 0, 0];']] };
  const showsUnanchored = { clientEdits: [[
    '        } else {\n          inclusion.graphs.push({ url, shown: false, reason: "no anchor" });\n        }',
    '        } else {\n          graphs.push({ url, spatial: spatial.body, placement: IDENTITY.slice() });\n        }',
  ]] };
  const ownIdSpaces = { serverEdits: { runtime: [['            ids : spatialStore.ids,', '            ids : undefined,']] } };
  await run('I9', 'X links {B}/wow/world: graph 1 is shown at X, graph 2 at (199.9999991 m, -3.1300 mm, -3.4398 mm) from graph 1 within 0.05 mm, as the Python reference puts it; graph 3 has no anchor and is not shown; node ids are unique across the three graphs', async (impl) => {
    const ref = reference(python);
    const { B } = await threeGraphWorld(impl, ports.next());
    const A = await w.world('a', ports.next());
    try {
      const [X] = await A.add(1, await A.rootOf(1), [{ label: 'X', localTransform: w.translation(10, 0, 0), spatialAssetURI: B.worldUrl() }]);
      const inc = await w.client(impl.clientEdits);
      const c = await inc.composeInclusions(A.spatialUrl(1), { fetch });
      const failures = [];
      const xUrl = A.nodeUrl(1, X);
      const inclusion = c.inclusions.find((i) => i.node === xUrl);
      if (!inclusion || inclusion.status !== 'included' || inclusion.kind !== 'world') return { ok: false, detail: 'X: ' + (inclusion ? inclusion.status + ' ' + inclusion.kind : 'no link met') };
      const shown = c.graphs.filter((g) => g.via === xUrl);
      const g1 = shown.find((g) => g.url === B.spatialUrl(1));
      const g2 = shown.find((g) => g.url === B.spatialUrl(2));
      if (shown.some((g) => g.url === B.spatialUrl(3))) failures.push('graph 3, which has no anchor, is shown');
      if (!g1 || !g2) return { ok: false, detail: 'shown: ' + shown.map((g) => g.url).join(', ') };
      const origin = (g) => inc.transformPoint(c.registry.get(g.rootUrl).find((r) => r.instance === g.instance).world, [0, 0, 0]);
      const o1 = origin(g1);
      const o2 = origin(g2);
      const xAt = inc.transformPoint(c.registry.get(xUrl)[0].world, [0, 0, 0]);
      if (Math.max(...o1.map((v, i) => Math.abs(v - xAt[i]))) > 1e-12) failures.push('graph 1 is not at X');
      const d = [o2[0] - o1[0], o2[1] - o1[1], o2[2] - o1[2]];
      const expected = [ref['I9.x'], ref['I9.y'], ref['I9.z']];
      if (Math.max(...d.map((v, i) => Math.abs(v - expected[i]))) > 0.00005) failures.push(`graph 2 is at (${d.map((v) => v.toFixed(7)).join(', ')}) from graph 1; the reference says (${expected.map((v) => v.toFixed(7)).join(', ')})`);
      const ids = [...(await idsOf(B, 1)), ...(await idsOf(B, 2)), ...(await idsOf(B, 3))];
      if (new Set(ids).size !== ids.length) failures.push('node ids repeat across B\'s graphs: ' + ids.join(','));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `graph 2 at (${d[0].toFixed(7)} m, ${(d[1] * 1e3).toFixed(4)} mm, ${(d[2] * 1e3).toFixed(4)} mm) from graph 1; graph 3 not shown; ${ids.length} node ids, all distinct` };
    } finally { await A.close(); await B.close(); }
  }, {}, [
    { name: 'a client that places graph 2 with a flat 111,320 m per degree', impl: flatEarth },
    { name: 'a client that shows the graph with no anchor at X', impl: showsUnanchored },
    { name: 'a B whose graphs each issue their own node ids', impl: ownIdSpaces },
  ]);

  // ---- I10 --------------------------------------------------------------------------------------------
  const wrongOrder = { clientEdits: [['      world: multiply(parentWorld, local),', '      world: multiply(local, parentWorld),']] };
  await run('I10', 'Z (turned 30 degrees, scale 2) links {B}/wow/world: every included node\'s position relative to B\'s graph origin, computed from B\'s own nodes, matches the composed scene, and taking Z away from a composed position gives it back (re-rooting into B)', async (impl) => {
    const { B, markers } = await threeGraphWorld(impl, ports.next());
    const A = await w.world('a', ports.next());
    try {
      const zTransform = w.yawScaled(30, 2, 0, 0, -20);
      const [Z] = await A.add(1, await A.rootOf(1), [{ label: 'Z', localTransform: zTransform, spatialAssetURI: B.worldUrl() }]);
      const inc = await w.client(impl.clientEdits);
      const c = await inc.composeInclusions(A.spatialUrl(1), { fetch });
      const zUrl = A.nodeUrl(1, Z);
      const zWorld = c.registry.get(zUrl)[0].world;
      const zInverse = inc.invertAffine(zWorld);
      const failures = [];
      const included = c.nodes.filter((r) => c.graphs.some((g) => g.via === zUrl && g.instance === r.instance));
      if (!included.length) return { ok: false, detail: 'nothing included under Z' };
      let worst = 0;
      for (const r of included) {
        worst = Math.max(worst, maxDiff(mul(zWorld, r.graphLocal), r.world), maxDiff(mul(zInverse, r.world), r.graphLocal));
      }
      if (worst > 1e-9) failures.push('composed and graph-relative positions differ by ' + worst.toExponential(2));
      // Graph 1's nodes, from B's own data with this check's own multiply: root, marker, its child.
      const flat = async (id) => (await (await fetch(B.nodeUrl(1, id) + '?nodeForm=flat', { headers: { Accept: w.WOW } })).json()).localTransform;
      const rootT = await flat(await B.rootOf(1));
      const childLocal = mul(mul(rootT, await flat(markers[1].marker)), await flat(markers[1].child));
      const childPlaced = included.find((r) => r.url === B.nodeUrl(1, markers[1].child));
      if (!childPlaced) failures.push('marker 1\'s child is not shown');
      else if (maxDiff(childPlaced.graphLocal, childLocal) > 1e-12) failures.push('marker 1\'s child is not where B\'s own nodes put it');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `${included.length} included nodes: composed = Z x graph-relative to ${worst.toExponential(1)}; marker 1's child matches B's own nodes` };
    } finally { await A.close(); await B.close(); }
  }, {}, [{ name: 'a client that multiplies child and parent in the wrong order', impl: wrongOrder }]);

  // ---- I12 --------------------------------------------------------------------------------------------
  const keepsEnvironment = { clientEdits: [['    if (child.isDirectionalLight || child.isHemisphereLight || child.isAmbientLight || child.isCamera) doomed.push(child);', '    if (false) doomed.push(child);']] };
  const dropsAllLights = { clientEdits: [['    if (child.isDirectionalLight || child.isHemisphereLight || child.isAmbientLight || child.isCamera) doomed.push(child);', '    if (child.isLight || child.isCamera) doomed.push(child);']] };
  await run('I12', 'B\'s graph holds a glTF with a directional light, a point light (KHR_lights_punctual) and a camera; in A\'s composed scene the point light is present under X and the directional light and the camera are not, while A\'s own copy of the same model keeps all three', async (impl) => {
    const models = await w.modelHost(ports.next());
    const B = await w.world('b', ports.next(), { base: '/w/b' });
    const A = await w.world('a', ports.next());
    try {
      await B.add(1, await B.rootOf(1), [{ label: 'lamp stand', localTransform: w.translation(1, 0, 0), spatialAssetURI: models.url('/models/environment.gltf') }]);
      const [, H] = await A.add(1, await A.rootOf(1), [
        { label: 'X', localTransform: w.translation(10, 0, 0), spatialAssetURI: B.spatialUrl(1) },
        { label: 'A\'s own lamp', localTransform: w.translation(-4, 0, 0), spatialAssetURI: models.url('/models/environment.gltf') },
      ]);
      const inc = await w.client();
      const mount = await mountModule(impl.clientEdits);
      const c = await inc.composeInclusions(A.spatialUrl(1), { fetch });
      const failures = [];
      const included = c.assets.find((a) => a.included && a.uri.endsWith('/models/environment.gltf'));
      const own = c.assets.find((a) => !a.included && a.node === A.nodeUrl(1, H));
      if (!included || !own) return { ok: false, detail: 'the model was not met under X and in A' };
      // The browser player's own clone step (web/wow-inclusion-mount.mjs), on the model as three.js loads it.
      const template = await w.loadGltf(models.gltf('/models/environment.gltf'));
      const clone = mount.environmentAwareClone((scene) => scene.clone(true));
      const types = (o) => { const out = []; o.traverse((x) => out.push(x.type)); return out; };
      const underX = types(clone(template, { included: true }));
      const inA = types(clone(template, { included: false }));
      if (!underX.includes('PointLight')) failures.push('under X the point light is gone');
      if (underX.includes('DirectionalLight')) failures.push('under X the directional light is present');
      if (underX.includes('PerspectiveCamera')) failures.push('under X the camera is present');
      if (!inA.includes('DirectionalLight') || !inA.includes('PerspectiveCamera') || !inA.includes('PointLight')) failures.push('A\'s own model lost part of its environment');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'under X: point light present, no directional light, no camera; A\'s own copy keeps all three' };
    } finally { await A.close(); await B.close(); await models.close(); }
  }, {}, [
    { name: 'a client that keeps the included world\'s environment', impl: keepsEnvironment },
    { name: 'a client that also drops the point light', impl: dropsAllLights },
  ]);
}

module.exports = { worldChecks };
