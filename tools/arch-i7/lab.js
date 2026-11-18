'use strict';

/*
 * Helpers for the iteration 7 proof (a running world inside a world).
 *
 * The scene, all real lab world servers in this process on isolated loopback ports:
 *
 *   world B ({B} = http://127.0.0.1:<port>/w/b/), auth "required", its own authorization server, and the game of
 *     runtime/world-server/src/runtime-game.js (cfg.game): a ball that moves under B's server logic, a button whose
 *     presses toggle a light. B trusts A's issuer for subject tokens and knows host A as a client (its id is A's base
 *     URL). B's own visitor holds B's tokens directly. B includes world D at its node "window to D".
 *   world A, auth "required", its own authorization server. Its graph:
 *     root -> "table" at (4, 0, 3) -> "B on the table" at (0, 0.75, 0), scale 0.1, links {B}/wow/world (1:10)
 *          -> "B at the distant site" at (3,000,000.37, 0, 0), scale 1, links {B}/wow/world (part b's W5 uses it)
 *   world D, a public world (auth "off"), with one node "d marker".
 *
 * A viewer of A holds its own token from A, and a token B issued by exchange: "host A acts for V" (RFC 8693, the
 * iteration 6 profile). B's grant records for acting decide what each viewer may do through A: V1 reads, observes,
 * presses the button (write on that one node) and holds the presence grant; V2 the same without the presence grant;
 * V3 reads and observes only. A viewer's client is web/wow-inclusion.mjs observeComposition, real or with a planted
 * fault, with a token for each world it reads.
 *
 * impl: serverEdits (B's server, by src file name), clientEdits (web/wow-inclusion.mjs), observeEdits
 * (web/wow-observe.mjs, with the inclusion client imported beside it).
 */

const path = require('path');
const { boot } = require('../arch-i1/harness');
const { httpReq, makeTempDir } = require('../arch-i1/lib');
const i3 = require('../arch-i3/lab');
const i6 = require('../arch-i6/lab');

const WOW = 'application/wow+json';
/** Fixed signing seeds, so B's tokens still verify after B's server restarts (fixtures, not real keys). */
const SEED_A = '9a1f3c5e7b2d4f6a8c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a';
const SEED_B = '2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a3c5e7b9d2f4a6c8e0b1d3f5a7c9e2b4d';
const HOST_SECRET = 'host-a-secret-not-real';
const DISTANT_X = 3000000.37;
const VIEWERS = Object.freeze(['viewer-v1', 'viewer-v2', 'viewer-v3']);
const VISITOR = Object.freeze({ player_id: 'visitor-b-7c1', display_name: 'Bee Visitor 7c1', avatar_id: 'proof-avatar' });

const translation = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const scaled = (s, x, y, z) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, y, z, 1];
const nodeRef = (id) => 'wow/spatial/1/node/' + id;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = i3.until;

/** One world: boot it (real or with B's planted fault), log what it receives, and give requests, tokens and exchanges. */
async function world(role, port, options) {
  options = options || {};
  const prefix = options.base || '';
  const base = 'http://127.0.0.1:' + port + prefix + '/';
  const config = Object.assign({}, options.config || {});
  if (prefix) config.base_path = prefix;
  if (options.auth) {
    config.auth = 'required';
    config.auth_server = Object.assign({ resource: base, token_ttl_s: 900 }, options.auth);
  }
  if (options.game) config.game = options.game;
  const saved = process.env.OSL_WOW_SPATIAL_PERSIST;
  if (options.persist) process.env.OSL_WOW_SPATIAL_PERSIST = '1';
  let server;
  try { server = await boot(role, port, { edits: options.edits, config, dir: options.dir }); } finally {
    if (saved === undefined) delete process.env.OSL_WOW_SPATIAL_PERSIST; else process.env.OSL_WOW_SPATIAL_PERSIST = saved;
  }
  const log = [];
  server.built.server.on('request', (req) => log.push({ method: req.method, url: req.url, ifMatch: req.headers['if-match'] || null, authorization: req.headers.authorization || null }));
  server.built.server.on('upgrade', (req) => log.push({ method: 'STREAM', url: req.url, ifMatch: null, authorization: req.headers.authorization || null }));
  const W = {
    role, port, base, prefix, dir: server.dir, log, server, built: server.built,
    auth: server.built.auth, game: server.built.game || null, runtime: server.built.runtime,
    url: (p) => base + String(p).replace(/^\//, ''),
    worldUrl: () => base + 'wow/world',
    spatialUrl: () => base + 'wow/spatial/1',
    nodeUrl: (id) => base + nodeRef(id),
    token: (subject, opts) => server.built.auth.issueToken(subject, opts || {}),
    req: (method, p, body, token, headers) => httpReq(method, port, prefix + '/' + String(p).replace(/^\//, ''), body, Object.assign({ Accept: WOW }, token ? { Authorization: 'Bearer ' + token } : {}, headers || {})),
    async rootOf(token) {
      const r = await W.req('GET', 'wow/spatial/1', null, token);
      if (r.status !== 200) throw new Error(role + ': GET wow/spatial/1 answered ' + r.status + ' ' + r.body.slice(0, 120));
      return r.json.rootNodeID;
    },
    async add(parent, nodes, token) {
      const r = await W.req('POST', nodeRef(parent), nodes, token);
      if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(role + ': create under ' + parent + ' answered ' + r.status + ' ' + r.body.slice(0, 160));
      return r.json.map((n) => n.id);
    },
    /** POST {base}oauth/token with a form; HTTP Basic for `client` (RFC 6749 §2.3.1: id and secret form-urlencoded first). */
    tokenRequest(fields, client) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (client) headers.Authorization = 'Basic ' + Buffer.from(encodeURIComponent(client.client_id) + ':' + encodeURIComponent(client.client_secret)).toString('base64');
      return httpReq('POST', port, prefix + '/oauth/token', form.toString(), headers);
    },
    close: () => server.close(),
  };
  return W;
}

/** World D: a public world with one node, "d marker". */
async function worldD(port) {
  const D = await world('lobby', port, {});
  const root = await D.rootOf(null);
  [D.marker] = await D.add(root, [{ label: 'd marker', localTransform: translation(1.25, 0.5, -0.75) }]);
  return D;
}

/** B's grant records for acting, which name the game's button: added after each start of B's server. */
function grantHost(B, A) {
  const iss = A.auth.issuer;
  const acting = (viewer, scope, resource) => B.auth.grants.add({ subject: A.base, scope, resource, acting_for: viewer, subject_issuer: iss });
  for (const v of VIEWERS) { acting(v, 'read', 'world'); acting(v, 'observe', 'world'); }
  acting('viewer-v1', 'write', nodeRef(B.game.ids.button));
  acting('viewer-v2', 'write', nodeRef(B.game.ids.button));
  acting('viewer-v1', 'read', 'users');
}

/** World B, with its game; `again` restarts it on the same port and folder. */
async function worldB(port, A, impl, options) {
  options = options || {};
  const dir = options.dir || makeTempDir('i7-b');
  const B = await world('b', port, {
    base: '/w/b', dir, persist: true, edits: impl.serverEdits,
    game: { interval_ms: options.interval_ms || 200 },
    auth: {
      signing_seed: SEED_B,
      clients: [{ client_id: A.base, client_secret: HOST_SECRET }],
      grants: [
        ...i6.grantsFor('operator', ['read', 'observe', 'write', 'enter'], { users: true }),
        ...i6.grantsFor(VISITOR.player_id, ['read', 'observe', 'enter'], { users: true }),
        ...i6.grantsFor(A.base, ['read']),
      ],
      trusted_issuers: [{ issuer: A.auth.issuer, public_key: await A.auth.publicKey() }],
    },
  });
  if (!B.game) { await B.close(); throw new Error('world B runs no game: its server did not start cfg.game'); }
  grantHost(B, A);
  B.again = () => worldB(port, A, impl, Object.assign({}, options, { dir }));
  return B;
}

/** The whole scene: A, B with its game, D; B includes D; A includes B twice. */
async function scene(impl, ports, options) {
  impl = impl || {};
  options = options || {};
  const D = await worldD(ports.next());
  const A = await world('a', ports.next(), {
    auth: { signing_seed: SEED_A, grants: [...i6.grantsFor('operator', ['read', 'write', 'observe']), ...VIEWERS.flatMap((v) => i6.grantsFor(v, ['read', 'observe']))] },
  });
  const bPort = ports.next();
  let B = null;
  try {
    B = await worldB(bPort, A, impl, options);
    const opB = await B.token('operator');
    const bRoot = await B.rootOf(opB);
    const [windowToD] = await B.add(bRoot, [{ label: 'window to D', localTransform: scaled(0.5, -2, 0, 1.5), spatialAssetURI: D.worldUrl() }], opB);
    const opA = await A.token('operator');
    const aRoot = await A.rootOf(opA);
    const [table, distant] = await A.add(aRoot, [
      { label: 'table', localTransform: translation(4, 0, 3) },
      { label: 'B at the distant site', localTransform: translation(DISTANT_X, 0, 0), spatialAssetURI: B.worldUrl() },
    ], opA);
    const [onTable] = await A.add(table, [{ label: 'B on the table', localTransform: scaled(0.1, 0, 0.75, 0), spatialAssetURI: B.worldUrl() }], opA);
    const s = {
      A, B, D, impl, bPort,
      ids: { aRoot, table, onTable, distant, bRoot, windowToD },
      urls: { onTable: A.nodeUrl(onTable), distant: A.nodeUrl(distant), table: A.nodeUrl(table), button: B.nodeUrl(B.game.ids.button), light: B.nodeUrl(B.game.ids.light), ball: B.nodeUrl(B.game.ids.ball), marker: D.nodeUrl(D.marker) },
      tokens: { opA, opB },
      clients: [],
      async close() {
        for (const c of s.clients) { try { c.close(); } catch (e) { /* closed */ } }
        if (s.visitor) { try { s.visitor.close(); } catch (e) { /* closed */ } }
        await s.B.close(); await A.close(); await D.close();
      },
    };
    return s;
  } catch (error) {
    if (B) await B.close();
    await A.close(); await D.close();
    throw error;
  }
}

/** Host A's own token at B (client credentials: A by its base URL), and the token B issues by exchange for a viewer. */
async function hostToken(s, viewer) {
  const { A, B } = s;
  const own = await B.tokenRequest({ grant_type: 'client_credentials', resource: B.base }, { client_id: A.base, client_secret: HOST_SECRET });
  if (own.status !== 200) throw new Error('host A\'s client credentials at B answered ' + own.status + ' ' + own.body.slice(0, 120));
  const subject = await A.token(viewer);
  const ex = await B.tokenRequest({
    grant_type: i6.TOKEN_EXCHANGE,
    subject_token: subject, subject_token_type: i6.ACCESS_TOKEN_TYPE,
    actor_token: own.json.access_token, actor_token_type: i6.ACCESS_TOKEN_TYPE,
    resource: B.base,
  });
  if (ex.status !== 200) throw new Error('the exchange at B for ' + viewer + ' answered ' + ex.status + ' ' + ex.body.slice(0, 160));
  return { a: subject, b: ex.json.access_token, scope: ex.json.scope };
}

/** The inclusion client module: real, or with a planted fault in it or in the observer beside it. */
async function clientModule(impl) {
  if (impl && impl.observeEdits) return (await i3.inclusionWithObserver(impl.observeEdits)).module;
  return (await i3.inclusion(impl && impl.clientEdits)).module;
}

/**
 * A viewer of A: its client composes A with everything A includes and keeps it live. Returns { live, updates,
 * requests, tokens, viewer }. `updates` records each update with the ball's placements in A and B's game revision.
 */
async function viewer(s, name, options) {
  options = options || {};
  const tokens = await hostToken(s, name);
  const inc = await clientModule(s.impl);
  const updates = [];
  const requests = [];
  const tokenFor = (base) => (base === s.A.base ? tokens.a : base === s.B.base ? tokens.b : null);
  const live = await inc.observeComposition(s.A.spatialUrl(), {
    fetch,
    token: tokenFor,
    reconnectMs: options.reconnectMs || 300,
    nestingLimit: options.nestingLimit,
    onRequest: (url) => requests.push({ url, at: Date.now() }),
    onUpdate: (composition, evt) => {
      updates.push({ at: Date.now(), cause: evt && evt.type, gameLog: s.B.game ? s.B.game.log().length : null, balls: ballPlacements(composition, s) });
    },
  });
  const v = { name, live, updates, requests, tokens, inc, close: () => live.close() };
  s.clients.push(v);
  await until(() => [...live.streams.values()].every((st) => st.state.status === 'live'), 8000, name + '\'s streams');
  return v;
}

/** The ball as a composition shows it: its world positions in A, by the A node that includes B. */
function ballPlacements(composition, s) {
  const out = {};
  for (const r of composition.nodes.filter((n) => n.url === s.urls.ball)) {
    const via = viaOf(composition, r);
    out[via] = [r.world[12], r.world[13], r.world[14]];
  }
  return out;
}

/** The A node an included record shows through (the inclusion of its graph instance). */
function viaOf(composition, record) {
  const graph = composition.graphs.find((g) => g.instance === record.instance);
  return graph ? graph.via : null;
}

/** The records of one node URL in a composition, by the A node they show through. */
function recordsOf(composition, url) {
  const out = {};
  for (const r of composition.nodes.filter((n) => n.url === url)) out[viaOf(composition, r)] = r;
  return out;
}

/** The matrix of a node of world W in W's graph 1, from W's server state (the chain of localTransforms from the root). */
function matrixOf(W, nodeId, multiply) {
  const chain = [];
  for (let id = nodeId; id !== null && id !== undefined;) {
    const n = W.runtime.getSpatialNode('1', id, { form: 'flat' });
    if (!n) break;
    chain.unshift(n.localTransform);
    id = Number.isInteger(n.parent) ? n.parent : null;
  }
  return chain.reduce((m, t) => multiply(m, t), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

/** B's visitor: a client of B with B's own token, registered in B's presence, watching the light. */
async function visitorOfB(s) {
  const token = await s.B.token(VISITOR.player_id);
  const reg = await s.B.req('POST', 'fabric/presence/register', Object.assign({ ttl_ms: 60000 }, VISITOR), token);
  if (reg.status !== 201) throw new Error('B\'s visitor could not register: ' + reg.status + ' ' + reg.body.slice(0, 120));
  const { module: obs } = await i3.observe();
  const observer = obs.createObserver({ token: (base) => (base === s.B.base ? token : null) });
  const light = await observer.watch(s.urls.light + '#/properties/on');
  await until(() => [...observer.streams.values()].every((st) => st.state.status === 'live'), 5000, 'the visitor\'s stream');
  s.visitor = { token, observer, light, registered: reg.json, close: () => observer.close() };
  return s.visitor;
}

/** Wait until every viewer's queue of re-compositions has settled. */
async function settle(viewers, ms) {
  await sleep(ms || 400);
  for (const v of viewers) await v.live.idle();
}

const near = (a, b, tol) => a && b && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= (tol || 1e-6));

module.exports = {
  WOW, VIEWERS, VISITOR, DISTANT_X, translation, scaled, nodeRef, sleep, until, near,
  world, worldB, scene, hostToken, viewer, visitorOfB, settle, ballPlacements, recordsOf, viaOf, matrixOf, clientModule, i3, i6,
};
