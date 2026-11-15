'use strict';

/*
 * Iteration 2, the content link.
 *
 *   I1  the client tells another world's content from a model by the media type of the answer alone
 *   I2  the included node keeps its own transform under the including node, and true size holds
 *   I3  every included node keeps its URL at its owner; the registry lists those URLs, not copies
 *   I13 world C relays an altered copy of B's node n, embedded under its own root and claiming n's URL at B;
 *       the host shows n as B serves it now, read from B's own URL and revalidated by its entity tag, and
 *       never the copy; in a browser, the `?wow=` player mounts B's current n where C embeds it, under C's
 *       root, and mounts nothing of the copy
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');

const { ROOT, run, httpReq, python, staleEdit } = require('../arch-i1/lib');
const w = require('./worlds');
const { baseScene, inclusionAt, placementsVia, reference } = require('./scenario');

const close = (a, b, tol) => Math.abs(a - b) <= tol;
const sameMatrix = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1e-12);

/**
 * World C, a world that relays: at start it reads B's node n from B, alters the copy (label, transform and
 * the cube's model) and embeds it under its own root, its ids set to n's and the cube's URLs at B, so the
 * copy claims to be B's node. It serves its graph as application/wow+json with entity tags, as any world does.
 */
async function relayWorld(port, nUrl, models) {
  const taken = await (await fetch(nUrl, { headers: { Accept: w.WOW } })).json();
  const nodeUrlAtB = (id) => new URL(String(id), nUrl).href;
  const copy = {
    id: nUrl,
    label: 'node n (relayed by C)',
    localTransform: w.translation(9, 9, 9),
    children: (taken.children || []).filter((c) => c && typeof c === 'object').map((c) => ({
      id: nodeUrlAtB(c.id), label: 'reference cube (relayed by C)', localTransform: w.scaled(5, 0, 0, 0), spatialAssetURI: models.url('/models/environment.gltf'), children: [],
    })),
  };
  const resources = {
    '/wow/spatial/1': { id: 1, rootNodeID: 1 },
    '/wow/spatial/1/node/1': { id: 1, label: 'C root', localTransform: w.IDENTITY, children: [{ id: 2, label: 'C own node', localTransform: w.translation(0, 1, 0), children: [] }, copy] },
    '/wow/spatial/1/node/2': { id: 2, label: 'C own node', localTransform: w.translation(0, 1, 0), children: [] },
  };
  // Cross-origin headers, as a lab world sends them, so the `?wow=` player in a browser can read C too.
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag' };
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, Object.assign({ 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Allow-Headers': 'Accept, If-None-Match' }, cors)); res.end(); return; }
    const resource = resources[new URL(req.url, 'http://x').pathname];
    if (!resource) { res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain' }, cors)); res.end('not found'); return; }
    const body = JSON.stringify(resource);
    const etag = '"' + crypto.createHash('sha256').update(body).digest('hex').slice(0, 32) + '"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, Object.assign({ ETag: etag }, cors)); res.end(); return; }
    res.writeHead(200, Object.assign({ 'Content-Type': w.WOW, 'Content-Length': Buffer.byteLength(body), ETag: etag }, cors));
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + port;
  return { base, spatialUrl: () => base + '/wow/spatial/1', rootUrl: base + '/wow/spatial/1/node/1', copy, close: () => new Promise((r) => server.close(r)) };
}

/** A fetch that records each request's If-None-Match. */
function taggingFetch() {
  const seen = [];
  const f = async (url, init) => {
    const headers = (init && init.headers) || {};
    seen.push({ url, ifNoneMatch: headers['If-None-Match'] || null });
    return fetch(url, init);
  };
  f.seen = seen;
  return f;
}

/**
 * The lab's `?wow=` player in a browser (Chrome, as I11 finds it), on world A's graph. `playerEdits`
 * ({ 'wow-inclusion.mjs': [[from, to]], ... }) plants a fault in the web modules the page loads; each
 * planted module must be requested by the page, or the fault tested nothing (a harness error).
 * Returns what the player mounted under each node named in `under`, read from the player's own scene
 * (window.__wow.renderIdentity()._impl.scene): every object named `wow:` or `wow-included:`, with its
 * parent's name and its matrices.
 */
async function playerScene(state, ports, hostSpatialUrl, playerEdits) {
  if (!state.browser) {
    const { findBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools', 'find-browser.mjs')).href);
    const chrome = findBrowser();
    if (!chrome) return { error: 'no Chrome found: set PUPPETEER_EXECUTABLE_PATH to run I13\'s player step' };
    const puppeteer = require(require.resolve('puppeteer-core', { paths: [ROOT] }));
    state.browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1280, height: 800 } });
  }
  const frontendPort = ports.next();
  // The page needs only the lab's static files and these worlds; it must never reach the demo's backends.
  const frontend = await require(path.join(ROOT, 'src', 'serve.js')).createFrontendServer(frontendPort, { backendPorts: { a: 1, b: 1, lobby: 1, airport: 1 } });
  const page = await state.browser.newPage();
  const planted = Object.keys(playerEdits || {});
  const served = new Set();
  const consoleLines = [];
  page.on('console', (msg) => consoleLines.push(String(msg.text()).slice(0, 240)));
  page.on('pageerror', (error) => consoleLines.push('pageerror: ' + String(error && error.message || error).slice(0, 240)));
  try {
    if (planted.length) {
      const sources = {};
      for (const name of planted) {
        let source = fs.readFileSync(path.join(ROOT, 'web', name), 'utf8');
        for (const [from, to] of playerEdits[name]) {
          const count = source.split(from).length - 1;
          if (count !== 1) throw staleEdit('web/' + name, from, count);
          source = source.replace(from, () => to);
        }
        sources[name] = source;
      }
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const name = path.basename(new URL(req.url()).pathname);
        if (req.url().startsWith('http://127.0.0.1:' + frontendPort + '/') && sources[name] !== undefined) {
          served.add(name);
          req.respond({ status: 200, contentType: 'text/javascript; charset=utf-8', body: sources[name] });
          return;
        }
        req.continue();
      });
    }
    await page.goto(`http://127.0.0.1:${frontendPort}/index.html?role=source&intro=bypass&wow=${encodeURIComponent(hostSpatialUrl)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.body.dataset.wowInclusionsReady, { timeout: 180000 });
    for (const name of planted) if (!served.has(name)) throw staleEdit('the player page', name + ' (never requested, so the planted fault was never loaded)', 0);
    const objects = await page.evaluate(() => {
      const runtime = window.__wow && window.__wow.renderIdentity && window.__wow.renderIdentity();
      const scene = runtime && runtime._impl && runtime._impl.scene;
      if (!scene) return null;
      scene.updateMatrixWorld(true);
      const out = [];
      scene.traverse((o) => {
        if (!/^wow(-included)?:/.test(o.name)) return;
        out.push({ name: o.name, parent: o.parent ? o.parent.name : null, grandparent: o.parent && o.parent.parent ? o.parent.parent.name : null, local: o.matrix.elements.slice(), world: o.matrixWorld.elements.slice(), children: o.children.map((c) => c.name) });
      });
      return out;
    });
    const inclusions = await page.evaluate(() => (window.__wowInclusions ? window.__wowInclusions.summary : null));
    if (!objects) return { error: 'the player exposes no scene (window.__wow.renderIdentity()._impl.scene)', log: consoleLines.slice(-8) };
    return { objects, inclusions, log: consoleLines };
  } finally {
    await page.close();
    await new Promise((resolve) => frontend.close(resolve));
  }
}

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

  // The fault: the host walks an embedded node claiming another world's URL as if it were the embedding world's own.
  const takesRelayedCopy = { clientEdits: [[
    '      if (graphPrefixOf(childUrl) !== graphPrefixOf(parentUrl)) {',
    '      if (false) {',
  ]] };
  // The player's faults, planted in the modules the page loads only (the composition in Node stays real):
  // a player that mounts the relayed copy, and one that drops the included part.
  const playerMountsCopy = { playerEdits: { 'wow-inclusion.mjs': takesRelayedCopy.clientEdits } };
  const playerDropsPart = { playerEdits: { 'wow-inclusion-mount.mjs': [['        mountRelayed(inner, subGroups.get(bundle.idOf.get(inner.url)));\n', '']] } };
  const browserState = { browser: null };
  await run('I13', 'world C relays an altered copy of B\'s node n (embedded under C\'s root, its ids set to n\'s and the cube\'s URLs at B); A includes C and B: every placement of n and of the cube shows B\'s current data, read from B\'s own URL, the relay position included; after B changes n again, a read with If-None-Match carrying B\'s entity tag answers 200 and the host shows the change; nothing of the copy is shown', async (impl) => {
    const s = await baseScene(impl, ports);
    const C = await relayWorld(ports.next(), s.urls.n, s.models);
    try {
      const failures = [];
      // B changes n after C took its copy, so the copy is stale as well as altered.
      const change = async (label, transform) => {
        const now = await s.B.node(1, s.ids.n);
        const body = Object.assign({}, now.json, { label, localTransform: transform });
        delete body.children;
        const put = await s.B.put(1, s.ids.n, body);
        if (put.status !== 200) throw new Error('B could not change n: ' + put.status);
        return s.B.node(1, s.ids.n);
      };
      await s.A.add(1, s.ids.aRoot, [{ label: 'Z', localTransform: w.translation(0, 0, -8), spatialAssetURI: C.spatialUrl() }]);
      const atB1 = await change('node n (current at B)', w.translation(2.5, 0, 0));
      const tagged = taggingFetch();
      const reader = s.inc.createWowReader({ fetch: tagged });

      const shows = (c, atB, when) => {
        const n = c.registry.get(s.urls.n) || [];
        const viaC = n.filter((r) => c.graphs.some((g) => g.instance === r.instance && g.via !== s.urls.X && g.via !== s.urls.Y));
        if (!viaC.length) failures.push(when + ': at the place where C relays n, the host does not show B\'s node n');
        for (const r of n) {
          if (r.label !== atB.json.label || !sameMatrix(r.local, atB.json.localTransform)) failures.push(when + ': a placement of n shows "' + r.label + '" at x = ' + r.local[12] + ', not B\'s "' + atB.json.label + '" at x = ' + atB.json.localTransform[12]);
        }
        for (const r of c.registry.get(s.urls.cube) || []) {
          if (r.label !== 'reference cube' || r.spatialAssetURI !== s.models.url('/models/cube.gltf') || !sameMatrix(r.local, w.IDENTITY)) failures.push(when + ': a placement of the cube shows "' + r.label + '" with ' + r.spatialAssetURI);
        }
        const relayed = c.nodes.filter((r) => / \(relayed by C\)$/.test(r.label));
        if (relayed.length) failures.push(when + ': ' + relayed.length + ' node(s) of C\'s copy are shown (' + relayed.map((r) => r.url).join(', ') + ')');
        if (c.assets.some((a) => a.uri === s.models.url('/models/environment.gltf'))) failures.push(when + ': the model C put in its copy is loaded');
        if (!(c.registry.get(new URL('2', C.rootUrl).href) || []).length) failures.push(when + ': C\'s own node is not shown');
        return viaC.length;
      };

      const c1 = await s.compose({ reader });
      const relayPlaces1 = shows(c1, atB1, 'first read');

      // The `?wow=` player in a browser, on A, while B serves n as "node n (current at B)": under C's root
      // (C's graph mounted under Z) it mounts B's n, read from n's URL at B, with B's label and transform, and
      // B's cube inside it; nothing of C's copy is drawn.
      const player = await playerScene(browserState, ports, s.A.spatialUrl(1), impl.playerEdits);
      let playerSaw = 'no player result';
      if (player.error) failures.push('player: ' + player.error);
      else {
        const objs = player.objects;
        const cSpatial = 'wow-included:' + C.spatialUrl();
        const zAt = [0, 0, -8];
        const mounts = objs.filter((o) => o.name === 'wow-included:' + s.urls.n && o.parent === 'wow:C root');
        const cRoot = objs.filter((o) => o.name === 'wow:C root');
        if (!cRoot.length || cRoot.some((o) => o.parent !== cSpatial || o.grandparent !== 'wow:Z')) failures.push('player: C\'s root is not mounted under Z (' + cRoot.map((o) => o.parent + ' < ' + o.grandparent).join(', ') + ')');
        if (mounts.length !== 1) failures.push('player: ' + mounts.length + ' mount(s) of n\'s URL at B under C\'s root, wanted 1 (the including node); under C\'s root: ' + (cRoot[0] ? cRoot[0].children.join(', ') : 'nothing'));
        const nUnderC = objs.filter((o) => o.parent === 'wow-included:' + s.urls.n && mounts.length && o.grandparent === 'wow:C root');
        const want = 'wow:' + atB1.json.label;
        const wantAt = [atB1.json.localTransform[12] + zAt[0], atB1.json.localTransform[13] + zAt[1], atB1.json.localTransform[14] + zAt[2]];
        if (mounts.length) {
          if (nUnderC.length !== 1 || nUnderC[0].name !== want) failures.push('player: under C\'s root the mounted part shows ' + (nUnderC.map((o) => '"' + o.name.slice(4) + '"').join(', ') || 'nothing') + ', not B\'s "' + atB1.json.label + '"');
          else {
            const n = nUnderC[0];
            if (!sameMatrix(n.local, atB1.json.localTransform)) failures.push('player: the mounted n has local x = ' + n.local[12] + ', not B\'s x = ' + atB1.json.localTransform[12]);
            const at = [n.world[12], n.world[13], n.world[14]];
            if (at.some((v, i) => !close(v, wantAt[i], 1e-6))) failures.push('player: the mounted n is at (' + at.join(', ') + '), not at the including node plus B\'s transform (' + wantAt.join(', ') + ')');
            if (!n.children.includes('wow:reference cube')) failures.push('player: the mounted n has no "reference cube" inside (' + n.children.join(', ') + ')');
          }
        }
        const copyDrawn = objs.filter((o) => / \(relayed by C\)$/.test(o.name));
        if (copyDrawn.length) failures.push('player: ' + copyDrawn.length + ' object(s) of C\'s copy are drawn (' + copyDrawn.map((o) => '"' + o.name.slice(4) + '" under ' + o.parent).join(', ') + ')');
        playerSaw = mounts.length === 1 && nUnderC.length === 1 ? `the ?wow= player mounts ${s.urls.n} under C's root as "${nUnderC[0].name.slice(4)}" at (${nUnderC[0].world.slice(12, 15).join(', ')})` : 'the ?wow= player mounts no part under C\'s root';
      }

      const readAtB = tagged.seen.filter((e) => e.url === s.urls.n);
      if (!readAtB.length) failures.push('the host never read n from B\'s own URL');
      if (!reader.cache.get(s.urls.n) || reader.cache.get(s.urls.n).etag !== atB1.headers.etag) failures.push('the host does not keep B\'s entity tag for n');

      const atB2 = await change('node n (changed at B again)', w.translation(3.5, 0, 0));
      const from = tagged.seen.length;
      const logFrom = reader.log.length;
      const c2 = await s.compose({ reader, revalidate: true });
      // n is read once per place it is shown: the first read carries the tag of B's earlier answer and gets
      // 200; each later read in the same composition carries the new tag and gets 304.
      const again = tagged.seen.slice(from).filter((e) => e.url === s.urls.n);
      const answers = reader.log.slice(logFrom).filter((e) => e.url === s.urls.n);
      if (!again.length || again[0].ifNoneMatch !== atB1.headers.etag) failures.push('after B\'s change, the first read of n at B did not carry B\'s earlier entity tag ' + atB1.headers.etag + ' (sent: ' + again.map((e) => e.ifNoneMatch).join(', ') + ')');
      if (again.slice(1).some((e) => e.ifNoneMatch !== atB2.headers.etag)) failures.push('a later read of n did not carry B\'s new entity tag ' + atB2.headers.etag);
      if (!answers.length || answers[0].status !== 200 || answers.slice(1).some((e) => e.status !== 304)) failures.push('after B\'s change, the revalidated reads of n answered ' + answers.map((e) => e.status).join(', '));
      const relayPlaces2 = shows(c2, atB2, 'after B\'s change');
      return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 5).join('; ') : `C relays a copy labelled "${C.copy.label}"; the host shows B's "${atB1.json.label}" at ${relayPlaces1} relay place(s) and under Y and X, read from ${s.urls.n}; after B's change the first read carried If-None-Match ${atB1.headers.etag} and answered 200 (reads of n: ${answers.map((e) => e.status).join(', ')}), and all ${(c2.registry.get(s.urls.n) || []).length} placements (${relayPlaces2} at the relay) show "${atB2.json.label}"; nothing of the copy is shown; ${playerSaw}, nothing of the copy drawn` };
    } finally { await C.close(); await s.close(); }
  }, {}, [
    { name: 'a host that takes the relayed copy', impl: takesRelayedCopy },
    { name: 'a ?wow= player that mounts the relayed copy', impl: playerMountsCopy },
    { name: 'a ?wow= player that drops the included part', impl: playerDropsPart },
  ]).finally(async () => { if (browserState.browser) await browserState.browser.close(); });
}

module.exports = { linkChecks };
