'use strict';

/*
 * Iteration 1, transforms: T1 (one meaning for a node's matrix) and T2 (matrices that cannot be a
 * placement are refused).
 */

const path = require('path');
const { ROOT, run } = require('./lib');
const { boot } = require('./harness');
const { graphApi, GRAPH_IDS, IDENTITY, translation } = require('./api');

const close = (a, b, tol) => Math.abs(a - b) <= tol;

// Translate (1, 2, 3) and rotate 90 degrees about Y, column-major.
const PARENT = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 2, 3, 1];
const transpose = (m) => [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15].map((i) => m[i]);
// Plain double-precision reference: column-major matrix times a point.
const apply = (m, p) => [0, 1, 2].map((row) => m[row] * p[0] + m[4 + row] * p[1] + m[8 + row] * p[2] + m[12 + row]);

async function transformChecks(ports) {
  const THREE = await import('three');
  const { buildWowScene } = await import(path.join(ROOT, 'web', 'wow-scene.mjs'));

  // ---- T1. One asymmetric fixture, read the same way by the server, the scene and the reference ----
  await run('T1', 'a parent translated (1,2,3) and turned 90 degrees about Y places the child point (1,0,0) at (1,2,2) in the scene, as the reference does', async (impl) => {
    const s = await boot('a', ports.next());
    try {
      const api = graphApi(s.port, GRAPH_IDS.a);
      const parent = await api.make(0, 't1-parent', PARENT);
      const child = await api.make(parent, 't1-child', translation(1, 0, 0));
      const { nodes, problems } = await api.walk(0);
      const stored = nodes.get(parent);
      const graph = {
        spatialID: GRAPH_IDS.a,
        root: 0,
        nodes: [...nodes.values()].map((n) => Object.assign({}, n, { localTransform: impl.read(n.localTransform) })),
      };
      const built = buildWowScene(graph, THREE, {});
      built.scene.updateMatrixWorld(true);
      const obj = built.scene.getObjectByName('wow:t1-child');
      const world = obj.getWorldPosition(new THREE.Vector3());
      const reference = apply(PARENT, apply(translation(1, 0, 0), [0, 0, 0]));
      const want = [1, 2, 2];
      const scene = [world.x, world.y, world.z];
      const worst = Math.max(...scene.map((v, i) => Math.abs(v - reference[i])));
      const storedSame = stored && stored.localTransform.every((v, i) => v === PARENT[i]);
      return {
        ok: !problems.length && storedSame && worst < 1e-9 && reference.every((v, i) => close(v, want[i], 1e-12)),
        detail: `child at (${scene.map((v) => v.toFixed(6)).join(', ')}); the reference gives (${reference.join(', ')}); the server stored the matrix unchanged: ${Boolean(storedSame)}`,
      };
    } finally { await s.close(); }
  }, { read: (m) => m }, [{ name: 'a reader that takes the matrix as row-major', impl: { read: transpose } }]);

  // ---- T2. Matrices that cannot be a placement are refused with 422 and a reason ------------------
  const lastRowBad = IDENTITY.slice(); lastRowBad[15] = 2;
  const lastRowSlanted = IDENTITY.slice(); lastRowSlanted[3] = 0.1;
  const sheared = [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const zeroScale = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const zeroScaleSheared = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1]; // x scale 0, y and z still sheared
  const body = (m) => [{ label: 't2', localTransform: m }];
  const rawBody = (m) => '[{"label":"t2","localTransform":[' + m + ']}]';
  const turned = [0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 5, 6, 7, 1]; // scale 2, rotate 90 degrees about Y: valid
  const cases = [
    { name: 'length 15', send: (api) => api.create(0, body(IDENTITY.slice(0, 15))), status: 422, reason: 'wrong_length' },
    { name: 'length 17', send: (api) => api.create(0, body(IDENTITY.concat([0]))), status: 422, reason: 'wrong_length' },
    { name: 'last row (0,0,0,2)', send: (api) => api.create(0, body(lastRowBad)), status: 422, reason: 'last_row_not_0001' },
    { name: 'last row slanted', send: (api) => api.create(0, body(lastRowSlanted)), status: 422, reason: 'last_row_not_0001' },
    { name: 'overflowing literal 1e999', send: (api) => api.create(0, rawBody('1,0,0,0,0,1,0,0,0,0,1,0,1e999,0,0,1')), status: 422, reason: 'not_a_finite_number' },
    { name: 'shear', send: (api) => api.create(0, body(sheared)), status: 422, reason: 'shear' },
    { name: 'zero x scale with y-z shear', send: (api) => api.create(0, body(zeroScaleSheared)), status: 422, reason: 'shear' },
    { name: 'NaN literal (not JSON)', send: (api) => api.create(0, rawBody('1,0,0,0,0,1,0,0,0,0,1,0,NaN,0,0,1')), status: 400, reason: null },
    { name: 'PUT with shear', send: async (api, target) => api.update(target, { localTransform: sheared }), status: 422, reason: 'shear' },
    { name: 'PUT with length 15', send: async (api, target) => api.update(target, { localTransform: IDENTITY.slice(0, 15) }), status: 422, reason: 'wrong_length' },
  ];
  await run('T2', 'a matrix that is not 16 numbers, has a last row other than (0,0,0,1), overflows or has shear is refused with 422 and a reason; NaN is 400; zero scale, which glTF allows, is accepted', async (impl) => {
    const s = await boot('a', ports.next(), { edits: impl.edits });
    try {
      const api = graphApi(s.port, GRAPH_IDS.a);
      const target = await api.make(0, 't2-target', translation(1, 1, 1));
      const before = (await api.walk(0)).nodes.size;
      const failures = [];
      for (const c of cases) {
        const r = await c.send(api, target);
        const reason = r.json && (r.json.reason || r.json.details || r.json.error);
        if (r.status !== c.status) failures.push(`${c.name}: status ${r.status}, wanted ${c.status}`);
        else if (c.reason && reason !== c.reason) failures.push(`${c.name}: reason ${reason}, wanted ${c.reason}`);
        else if (c.status === 422 && !reason) failures.push(`${c.name}: no reason given`);
      }
      const unchanged = (await api.node(target)).json.localTransform.every((v, i) => v === translation(1, 1, 1)[i]);
      const after = (await api.walk(0)).nodes.size;
      const okTurn = await api.create(0, body(turned));
      const okZero = await api.create(0, body(zeroScale));
      const zeroTarget = await api.make(0, 't2-zero-target', translation(1, 1, 1));
      const okZeroPut = await api.update(zeroTarget, { localTransform: zeroScale });
      if (!unchanged) failures.push('a refused PUT changed the node');
      if (after !== before) failures.push('a refused POST stored a node');
      if (okTurn.status !== 200) failures.push('a valid rotation with scale 2 was refused: ' + okTurn.status + ' ' + okTurn.body.slice(0, 100));
      if (okZero.status !== 200) failures.push('zero scale was refused on POST: ' + okZero.status + ' ' + okZero.body.slice(0, 100));
      if (okZeroPut.status !== 200) failures.push('zero scale was refused on PUT: ' + okZeroPut.status + ' ' + okZeroPut.body.slice(0, 100));
      else if (!(await api.node(zeroTarget)).json.localTransform.every((v, i) => v === zeroScale[i])) failures.push('zero scale was not stored as sent');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `${cases.length} refusals with their reasons; nothing stored; a rotation with scale 2 and zero scale (POST and PUT) are accepted` };
    } finally { await s.close(); }
  }, { edits: null }, [{
    name: 'transform checks removed',
    impl: { edits: { store: [['    let refusal = null;\n    function visit(raw, at, depth)', '    return null;\n    let refusal = null;\n    function visit(raw, at, depth)']] } },
  }, {
    name: 'a server that still refuses zero scale',
    impl: { edits: { store: [['            const bad = checkLocalTransform(raw.localTransform);', '            const bad = checkLocalTransform(raw.localTransform) || (Array.isArray(raw.localTransform) && [0, 4, 8].some((k) => Math.hypot(raw.localTransform[k], raw.localTransform[k + 1], raw.localTransform[k + 2]) < 1e-12) ? { reason : \'zero_scale\', message : \'zero scale\' } : null);']] } },
  }]);
}

module.exports = { transformChecks };
