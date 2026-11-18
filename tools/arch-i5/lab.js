'use strict';

/*
 * Helpers for the iteration 5 proof: worlds that state a handshake (real or with a planted fault), the
 * visitor's agent (real or with a planted fault), a log of every request a world server receives, and the
 * two worlds of the ID1 after view.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, loadMutant, makeTempDir, staleEdit, httpReq } = require('../arch-i1/lib');
const w = require('../arch-i2/worlds');

const SRC = path.join('runtime', 'world-server', 'src');
const WOW = w.WOW;

/** World B's handshake in the after view and in ID1: avatar and preferences required, display name optional. */
const B_CLAIMS = Object.freeze([
  { name: 'avatar', required: true },
  { name: 'preferences', required: true },
  { name: 'display_name', required: false },
]);
/** World A's: only the display name, optional. */
const A_CLAIMS = Object.freeze([{ name: 'display_name', required: false }]);
/** The avatar the page starts as in the after view, and the one World B accepts (web/wow-handshake.mjs LAB_WALLET). */
const DEFAULT_VARIANT = 'collection-adam';
const ACCEPTED_VARIANT = 'collection-sophie';

/**
 * The server module, real or with edits: { handshake (runtime-handshake.js), server (server.js), users
 * (runtime-user-projection.js, wired in through runtime-state.js) } are arrays of [from, to].
 */
function serverModule(edits) {
  edits = edits || {};
  if (!edits.handshake && !edits.server && !edits.users) return require(path.join(ROOT, SRC, 'server.js'));
  const handshake = edits.handshake ? loadMutant(path.join(SRC, 'runtime-handshake.js'), edits.handshake) : require(path.join(ROOT, SRC, 'runtime-handshake.js'));
  const overrides = { './runtime-handshake': handshake };
  if (edits.users) {
    const users = loadMutant(path.join(SRC, 'runtime-user-projection.js'), edits.users);
    overrides['./runtime-state'] = loadMutant(path.join(SRC, 'runtime-state.js'), [], { './runtime-user-projection': users });
  }
  return loadMutant(path.join(SRC, 'server.js'), edits.server || [], overrides);
}

/**
 * Boot a world that states a handshake, and log every request it receives (method, URL, Referer, body).
 * options: base (path prefix), claims, issues, statedBase (the base URL its World names; default: its own),
 * label, edits ({ handshake, server }), nodes (fn(world) to add content).
 */
async function handshakeWorld(role, port, options) {
  options = options || {};
  const prefix = options.base || '';
  const ownBase = 'http://127.0.0.1:' + port + prefix + '/';
  const config = {
    base_path: prefix || undefined,
    handshake: {
      base: options.statedBase || ownBase,
      label: options.label,
      claims: (options.claims || B_CLAIMS).map((c) => Object.assign({}, c)),
      issues: (options.issues || []).slice(),
    },
  };
  if (!prefix) delete config.base_path;
  const dir = makeTempDir('i5-' + role);
  const saved = process.env.OSL_WOW_SPATIAL_DIR;
  process.env.OSL_WOW_SPATIAL_DIR = dir;
  let built;
  try {
    built = serverModule(options.edits).createServer(role, Object.assign({ http_port: port }, config));
  } finally {
    if (saved === undefined) delete process.env.OSL_WOW_SPATIAL_DIR;
    else process.env.OSL_WOW_SPATIAL_DIR = saved;
  }
  const log = [];
  built.server.on('request', (req) => {
    const entry = { method: req.method, url: req.url, referer: req.headers.referer || null, body: '' };
    log.push(entry);
    req.on('data', (chunk) => { entry.body += chunk; });
  });
  await new Promise((resolve, reject) => { built.server.once('error', reject); built.server.listen(port, '127.0.0.1', resolve); });
  const world = {
    port, prefix, base: ownBase, built, log,
    server: { built },
    spatialUrl: (id) => 'http://127.0.0.1:' + port + prefix + '/wow/spatial/' + (id === undefined ? 1 : id),
    handshake: () => built.handshake,
    async rootOf(graph) {
      const r = await httpReq('GET', port, prefix + '/wow/spatial/' + graph, null, { Accept: WOW });
      return r.json.rootNodeID;
    },
    async add(graph, parentId, nodes) {
      const r = await httpReq('POST', port, prefix + '/wow/spatial/' + graph + '/node/' + parentId, nodes, { Accept: WOW });
      if (r.status !== 200) throw new Error('create under ' + parentId + ': ' + r.status + ' ' + r.body.slice(0, 160));
      return r.json.map((n) => n.id);
    },
    async clear() {
      const root = await world.rootOf(1);
      const r = await httpReq('GET', port, prefix + `/wow/spatial/1/node/${root}?nodeForm=flat`, null, { Accept: WOW });
      for (const child of r.json.children || []) await httpReq('DELETE', port, prefix + `/wow/spatial/1/node/${child}`, null, { Accept: WOW });
    },
    /** The records this world keeps of handshake outcomes, read from the world itself. */
    records: () => (built.handshake ? built.handshake.records() : null),
    close: async () => { try { await built.closeAll(); } catch (e) { /* closed */ } },
  };
  return world;
}

/** The agent's source (web/wow-handshake.mjs) with exact string edits; an edit that no longer matches once is stale. */
function agentSource(edits) {
  let source = fs.readFileSync(path.join(ROOT, 'web', 'wow-handshake.mjs'), 'utf8');
  for (const [from, to] of edits || []) {
    const count = source.split(from).length - 1;
    if (count !== 1) throw staleEdit('web/wow-handshake.mjs', from, count);
    source = source.replace(from, () => to);
  }
  return source;
}

/** The agent module (web/wow-handshake.mjs), real or with exact string edits. */
async function agent(edits) {
  const file = path.join(ROOT, 'web', 'wow-handshake.mjs');
  if (!edits || !edits.length) return import(pathToFileURL(file).href);
  const source = agentSource(edits);
  const dir = makeTempDir('i5-agent');
  // The agent imports ./signing/index.mjs: link the real signing folder beside the copy.
  fs.symlinkSync(path.join(ROOT, 'web', 'signing'), path.join(dir, 'signing'), 'dir');
  const out = path.join(dir, 'wow-handshake.mjs');
  fs.writeFileSync(out, source);
  return import(pathToFileURL(out).href);
}

/** The bodies of every POST /wow/user a world received, parsed. */
function joinsReceived(world) {
  return world.log.filter((e) => e.method === 'POST' && /\/wow\/user(\?|$)/.test(e.url)).map((e) => {
    let body = null;
    try { body = JSON.parse(e.body); } catch (err) { body = null; }
    return Object.assign({}, e, { json: body });
  });
}

/** The lab issuer of the proof: a fixed did:key (a fixture, not a real issuer). */
async function labIssuer(seedHex) {
  const signing = await import(pathToFileURL(path.join(ROOT, 'web', 'signing', 'index.mjs')).href);
  const seed = signing.hexToBytes(seedHex || '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
  const privateKey = await signing.importPrivateKey(seed);
  const raw = await signing.derivePublicKeyRaw(privateKey);
  return { privateKey, did: signing.publicKeyToDidKey(raw) };
}

const placed = (x, y, z, deg = 0, s = 1) => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r) * s, n = Math.sin(r) * s;
  return [c, 0, -n, 0, 0, s, 0, 0, n, 0, c, 0, x, y, z, 1];
};

/**
 * The two worlds of the ID1 after view, at `ports.a` and `ports.b`, with models from `frontend`:
 * A asks only for the display name (optional) and holds a portal to B; B asks for the avatar and the
 * preferences (required) and the display name (optional). Returns { A, B, arrival, player(world, join, role) }.
 */
async function crossingWorlds({ frontend, ports, edits }) {
  const model = (name) => `${frontend}/assets/worlds/${name}`;
  // The page starts as the avatar pinned here (DEFAULT_VARIANT), not a random one, so that only the handshake can
  // change it.
  const player = (world, join, role) => `${frontend}/index.html?role=${role || 'player'}&intro=bypass&avatar_variant=${DEFAULT_VARIANT}&wow=${encodeURIComponent(world.spatialUrl(1))}${join == null ? '' : `#join=node.${join}`}`;
  const B = await handshakeWorld('b', ports.b, { base: '/w/b', label: 'World B', claims: B_CLAIMS, edits });
  await B.clear();
  const [arrival] = await B.add(1, await B.rootOf(1), [{ label: 'arrival', localTransform: placed(0, 0, 4, 180) }]);
  await B.add(1, arrival, [
    { label: 'duck', localTransform: placed(1.4, 0, 2.5), spatialAssetURI: model('Duck.glb') },
    { label: 'lantern', localTransform: placed(-1.6, 0, 3, 0, 0.2), spatialAssetURI: model('Lantern.glb') },
  ]);
  B.built.runtime.setPreview({ node_id: arrival, radius_m: 10 });
  const A = await handshakeWorld('a', ports.a, { label: 'World A', claims: A_CLAIMS, edits });
  await A.clear();
  // The visitor spawns near the content's near edge, centred on it in x, facing +z: the portal stands 7 m
  // ahead and 2 m to the right, so the visitor's own avatar does not hide it.
  const [portalNode] = await A.add(1, await A.rootOf(1), [{ label: 'portal to B', localTransform: placed(1.5, 0, 2, 180) }]);
  await A.add(1, await A.rootOf(1), [{ label: 'fox', localTransform: placed(-2.5, 0, -2, 0, 0.02), spatialAssetURI: model('Fox.glb') }]);
  A.built.runtime.addPortal({ node_id: portalNode, destination: player(B, arrival), label: 'To World B' });
  const [back] = await B.add(1, arrival, [{ label: 'back to A', localTransform: placed(0, 0, -3) }]);
  B.built.runtime.addPortal({ node_id: back, destination: player(A), label: 'Back to World A' });
  return { A, B, arrival, player };
}

module.exports = { w, WOW, B_CLAIMS, A_CLAIMS, DEFAULT_VARIANT, ACCEPTED_VARIANT, serverModule, handshakeWorld, agent, agentSource, joinsReceived, labIssuer, crossingWorlds, placed, httpReq };
