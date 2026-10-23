'use strict';

/*
 * Iteration 2, the content link.
 *
 *   I1  the client tells another world's content from a model by the media type of the answer alone
 *   I2  the included node keeps its own transform under the including node, and true size holds
 *   I3  every included node keeps its URL at its owner; the registry lists those URLs, not copies
 */

const { run, httpReq, python } = require('../arch-i1/lib');
const w = require('./worlds');
const { baseScene, inclusionAt, placementsVia, reference } = require('./scenario');

const close = (a, b, tol) => Math.abs(a - b) <= tol;

/** The size of a loaded model's box after the composed matrix moves its eight corners. */
async function measuredSize(inc, model, matrix) {
  const { THREE } = await w.three();
  const box = new THREE.Box3().setFromObject(model);
  const corners = [];
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) corners.push(inc.transformPoint(matrix, [x, y, z]));
  const span = (axis) => Math.max(...corners.map((c) => c[axis])) - Math.min(...corners.map((c) => c[axis]));
  return [span(0), span(1), span(2)];
}

async function linkChecks(ports) {
  // ---- I1 ---------------------------------------------------------------------------------------------
  const serverAnswersPlainJson = { serverEdits: { server: [["const WOW_MEDIA_TYPE = 'application/wow+json';", "const WOW_MEDIA_TYPE = 'application/json';"]] } };
  const clientGuessesFromAddress = { clientEdits: [[
    '    if (!isWowMediaType(answer.type)) {\n      if (isModelMediaType(answer.type)) {',
    '    if (!/\\/wow\\//.test(target)) {\n      if (isModelMediaType(answer.type)) {',
  ]] };
  await run('I1', 'a node\'s spatialAssetURI links B\'s Spatial (X) and B\'s node n (Y); B serves both as application/wow+json and the client includes them, while a glTF model, even at an address that looks like a Web of Worlds one, loads as a model', async (impl) => {
    const s = await baseScene(impl, ports);
    try {
      const c = await s.compose();
      const failures = [];
      const x = inclusionAt(c, s.urls.X);
      const y = inclusionAt(c, s.urls.Y);
      const m = inclusionAt(c, s.urls.M);
      if (!x || x.status !== 'included' || x.kind !== 'spatial') failures.push('X: ' + (x ? x.status + ' ' + x.kind : 'no link met'));
      if (!y || y.status !== 'included' || y.kind !== 'node') failures.push('Y: ' + (y ? y.status + ' ' + y.kind : 'no link met'));
      if (!m || m.status !== 'model') failures.push('M (a model at a Web of Worlds-looking address): ' + (m ? m.status : 'no link met'));
      const cubeAsset = c.assets.find((a) => a.node === s.urls.cube && a.included);
      if (!cubeAsset || cubeAsset.type !== 'model/gltf+json') failures.push('the cube inside B is not loaded as a model/gltf+json model');
      // What B said, read on the wire: the type the decision rests on.
      const onWire = await httpReq('GET', s.B.port, '/w/b/wow/spatial/1', null, { Accept: 'application/wow+json' });
      const typeSeen = String(onWire.headers['content-type'] || '');
      if (typeSeen !== 'application/wow+json') failures.push('B answers a request for the WoW type with ' + typeSeen);
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `X included (Spatial), Y included (Node), M loaded as ${m.status} (model/gltf+json); B labels its answers ${typeSeen}` };
    } finally { await s.close(); }
  }, {}, [
    { name: 'B answers a request for the WoW type with plain application/json', impl: serverAnswersPlainJson },
    { name: 'a client that guesses from the address (/wow/ in the URL)', impl: clientGuessesFromAddress },
  ]);

  // ---- I2 ---------------------------------------------------------------------------------------------
  const dropsOwnTransform = { clientEdits: [[
    'await walk(answer.body, target, record.world, IDENTITY.slice(), { depth, path, graph }, null);',
    'await walk(Object.assign({}, answer.body, { localTransform: IDENTITY.slice() }), target, record.world, IDENTITY.slice(), { depth, path, graph }, null);',
  ]] };
  await run('I2', 'under Y, node n sits 0.02 m along Y\'s x axis (Y stands in for n\'s parent); B\'s 1 m reference cube measures 1.000000 m under X and 0.010000 m under Y, as the double-precision reference says', async (impl) => {
    const ref = reference(python);
    const s = await baseScene(impl, ports);
    try {
      const c = await s.compose();
      const failures = [];
      const [nUnderY] = placementsVia(c, s.urls.n, s.urls.Y);
      const yRecord = (c.registry.get(s.urls.Y) || [])[0];
      if (!nUnderY || !yRecord) return { ok: false, detail: 'node n is not shown under Y' };
      const along = s.inc.transformPoint(nUnderY.world, [0, 0, 0])[0] - s.inc.transformPoint(yRecord.world, [0, 0, 0])[0];
      if (!close(along, ref['I2.n_from_Y_x'], 1e-12)) failures.push(`n is ${along} m from Y's origin along x; the reference says ${ref['I2.n_from_Y_x']}`);
      const [cubeX] = placementsVia(c, s.urls.cube, s.urls.X);
      const [cubeY] = placementsVia(c, s.urls.cube, s.urls.Y);
      if (!cubeX || !cubeY) return { ok: false, detail: 'the reference cube is not shown under both X and Y' };
      const model = await w.loadGltf(s.models.gltf('/models/cube.gltf'));
      const underX = await measuredSize(s.inc, model, cubeX.world);
      const underY = await measuredSize(s.inc, model, cubeY.world);
      if (!underX.every((v) => close(v, ref['I2.cube_edge_X'], 1e-6))) failures.push('under X the cube measures ' + underX.map((v) => v.toFixed(7)).join(' x '));
      if (!underY.every((v) => close(v, ref['I2.cube_edge_Y'], 1e-8))) failures.push('under Y the cube measures ' + underY.map((v) => v.toFixed(9)).join(' x '));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `n at ${along.toFixed(6)} m along Y's x; the loaded cube model measures ${underX[0].toFixed(6)} m under X and ${underY[0].toFixed(6)} m under Y; reference agrees` };
    } finally { await s.close(); }
  }, {}, [{ name: 'a client that drops node n\'s own transform', impl: dropsOwnTransform }]);

  // ---- I3 ---------------------------------------------------------------------------------------------
  const keepsCopies = { clientEdits: [[
    '    if (!out.registry.has(url)) out.registry.set(url, []);\n    out.registry.get(url).push(record);',
    '    const key = ctx.depth > 0 ? hostUrl + "#copy-" + node.id : url;\n    if (!out.registry.has(key)) out.registry.set(key, []);\n    out.registry.get(key).push(record);',
  ]] };
  await run('I3', 'every included node keeps its URL at B, and that URL answers with that node; the client\'s registry lists B\'s URLs and no copies', async (impl) => {
    const s = await baseScene(impl, ports);
    try {
      const c = await s.compose();
      const failures = [];
      const included = c.nodes.filter((r) => r.included);
      if (!included.length) return { ok: false, detail: 'nothing was included' };
      for (const r of included) {
        if (!r.url.startsWith(s.B.base + '/wow/spatial/')) failures.push(r.url + ' is not a URL at B');
        const keyed = c.registry.get(r.url);
        if (!keyed || !keyed.includes(r)) failures.push(r.url + ' is not listed in the registry under its URL at B');
      }
      for (const key of c.registry.keys()) {
        if (!key.startsWith(s.B.base) && !key.startsWith(s.A.base + '/wow/spatial/')) failures.push('the registry lists ' + key);
        if (key.includes('#')) failures.push('the registry lists a copy: ' + key);
      }
      // Each URL answers at B with the node it stands for.
      const unique = [...new Set(included.map((r) => r.url))];
      for (const url of unique) {
        const r = await fetch(url, { headers: { Accept: 'application/wow+json' } });
        const body = r.ok ? await r.json() : null;
        const placed = c.registry.get(url) && c.registry.get(url)[0];
        if (!body || !placed || body.id !== placed.id || String(body.label) !== placed.label) failures.push(url + ' does not answer with the node shown');
      }
      return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 4).join('; ') : `${included.length} included placements of ${unique.length} nodes, each listed and answering at B` };
    } finally { await s.close(); }
  }, {}, [{ name: 'a client whose registry keeps copies under A\'s URL', impl: keepsCopies }]);
}

module.exports = { linkChecks };
