'use strict';

/*
 * Helpers for the iteration 6 proof (permissions): worlds that require a token (cfg.auth "required"), real or
 * with planted faults, each with its own authorization server and grant records; two worlds on one origin at
 * /w/b and /w/bb; a log of every request URL, Referer and stream URL a world receives; tokens and event streams.
 *
 * A planted fault is an exact edit of the real code (tools/arch-i1/lib.js loadMutant): of the authorization
 * server (runtime/world-server/src/world-auth.js), of the policy of scopes and people
 * (runtime/world-server/src/world-auth-policy.js), of server.js, or of the web client and agent
 * (web/wow-observe.mjs, web/wow-handshake.mjs). An edit that no longer matches exactly once is a harness error.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, loadMutant, makeTempDir, staleEdit, httpReq } = require('../arch-i1/lib');
const { openEventStream, sleep } = require('../wow-conformance/wire-checks');
const i5 = require('../arch-i5/lab');

const SRC = path.join('runtime', 'world-server', 'src');
const WOW = 'application/wow+json';
/** A fixed signing seed, shared where two worlds stand behind one authorization server (a fixture, not a real key). */
const SHARED_SEED = '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb';
const SCOPES = ['read', 'observe', 'write', 'enter'];
const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/** The claims of a JWT, read without checking it (the proof reads what a world issued). */
function claimsOf(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch (e) { return null; }
}
/** The actors of an `act` claim chain, the current actor first (RFC 8693 §4.1). */
function actorsOf(claims) {
  const out = [];
  for (let a = claims && claims.act; a && typeof a === 'object'; a = a.act) out.push(a.sub);
  return out;
}

/** Grant records for a subject: one per scope; `users` adds the presence grant (read on the world's User resources). */
function grantsFor(subject, scopes, opts) {
  const out = scopes.map((scope) => ({ subject, scope, resource: 'world' }));
  if (opts && opts.users) out.push({ subject, scope: 'read', resource: 'users' });
  return out;
}

/**
 * The server module, real or with edits: { auth (world-auth.js), policy (world-auth-policy.js), server (server.js),
 * handshake (runtime-handshake.js) } are arrays of [from, to].
 */
function serverModule(edits) {
  edits = edits || {};
  if (!edits.auth && !edits.policy && !edits.server && !edits.handshake) return require(path.join(ROOT, SRC, 'server.js'));
  const policy = edits.policy ? loadMutant(path.join(SRC, 'world-auth-policy.js'), edits.policy) : require(path.join(ROOT, SRC, 'world-auth-policy.js'));
  const auth = edits.auth || edits.policy ? loadMutant(path.join(SRC, 'world-auth.js'), edits.auth || [], { './world-auth-policy': policy }) : require(path.join(ROOT, SRC, 'world-auth.js'));
  const overrides = { './world-auth': auth, './world-auth-policy': policy };
  if (edits.handshake) overrides['./runtime-handshake'] = loadMutant(path.join(SRC, 'runtime-handshake.js'), edits.handshake);
  return loadMutant(path.join(SRC, 'server.js'), edits.server || [], overrides);
}

/** Build one world (not listening). options: base, port (for its base URL), origin, grants, clients, issuer, seed, trusted (subject-token issuers), edits, auth, claims. */
function buildWorld(role, port, options) {
  options = options || {};
  const prefix = options.base || '';
  const origin = options.origin || 'http://127.0.0.1:' + port;
  const base = origin + prefix + '/';
  const config = {
    http_port: port,
    auth: options.auth === undefined ? 'required' : options.auth,
    auth_server: {
      resource: base,
      ...(options.issuer ? { issuer: options.issuer } : {}),
      ...(options.seed ? { signing_seed: options.seed } : {}),
      clients: (options.clients || []).map((c) => Object.assign({}, c)),
      grants: (options.grants || []).map((g) => Object.assign({}, g)),
      ...(options.trusted ? { trusted_issuers: options.trusted.map((t) => Object.assign({}, t)) } : {}),
    },
    handshake: { base, label: options.label || ('World ' + role), claims: (options.claims || i5.B_CLAIMS).map((c) => Object.assign({}, c)), issues: [] },
  };
  if (prefix) config.base_path = prefix;
  const dir = makeTempDir('i6-' + role);
  const saved = process.env.OSL_WOW_SPATIAL_DIR;
  process.env.OSL_WOW_SPATIAL_DIR = dir;
  try {
    return { built: serverModule(options.edits).createServer(role, config), base, prefix, origin };
  } finally {
    if (saved === undefined) delete process.env.OSL_WOW_SPATIAL_DIR;
    else process.env.OSL_WOW_SPATIAL_DIR = saved;
  }
}

/** The log of what one listening server receives: every request (method, URL, Referer, Authorization) and every stream URL. */
function logRequests(server, log) {
  server.on('request', (req) => { log.push({ kind: 'http', method: req.method, url: req.url, referer: req.headers.referer || null, authorization: req.headers.authorization || null }); });
  server.on('upgrade', (req) => { log.push({ kind: 'stream', method: 'GET', url: req.url, referer: req.headers.referer || null, authorization: req.headers.authorization || null }); });
}

/** A world handle: requests with or without a token, tokens, streams, nodes, people. */
function handle(port, w, log, close) {
  const { built, base, prefix } = w;
  const world = {
    port, base, prefix, built, log,
    auth: built.auth,
    url: (p) => base + String(p).replace(/^\//, ''),
    /** A token from this world's authorization server for `subject` (its scopes default to every scope its records grant). */
    token: (subject, opts) => built.auth.issueToken(subject, opts || {}),
    /** One request below the base, with `token` in the Authorization header when given. */
    req: (method, p, body, token, headers) => httpReq(method, port, prefix + '/' + String(p).replace(/^\//, ''), body, Object.assign({ Accept: WOW }, token ? { Authorization: 'Bearer ' + token } : {}, headers || {})),
    /** A request to a path of the origin (outside the base). */
    raw: (method, p, body, headers) => httpReq(method, port, p, body, headers || {}),
    /** An event stream (/events or /runtime-state), sending `token` as the first message when given. */
    async stream(name, token, opts) {
      const s = await openEventStream('http://127.0.0.1:' + port + prefix + '/' + (name || 'events') + ((opts && opts.query) || ''));
      if (opts && opts.first !== undefined) s.send(opts.first);
      if (token) s.send(JSON.stringify({ type: 'auth', token }));
      return s;
    },
    async rootOf(token) {
      const r = await world.req('GET', 'wow/spatial/1', null, token);
      if (r.status !== 200) throw new Error('GET wow/spatial/1: ' + r.status + ' ' + r.body.slice(0, 120));
      return r.json.rootNodeID;
    },
    async addNode(token, label) {
      const root = await world.rootOf(token);
      const r = await world.req('POST', 'wow/spatial/1/node/' + root, [{ label: label || 'proof node', localTransform: i5.placed(0, 0, 0) }], token);
      return r;
    },
    /** POST {base}oauth/token with a form (an object of fields; a field given as an array repeats), and HTTP Basic for `client` when given. */
    tokenRequest(fields, client) {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries(fields)) for (const one of [].concat(v)) form.append(k, one);
      const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      // RFC 6749 §2.3.1: the client id and secret are form-urlencoded before HTTP Basic (a host's id is its base URL, which has a colon).
      if (client) headers.Authorization = 'Basic ' + Buffer.from(encodeURIComponent(client.client_id) + ':' + encodeURIComponent(client.client_secret)).toString('base64');
      return httpReq('POST', port, prefix + '/oauth/token', form.toString(), headers);
    },
    /** An RFC 8693 token exchange at this world: subjectToken as the subject, actorToken as the acting party. */
    exchange(subjectToken, actorToken, extra) {
      return world.tokenRequest(Object.assign({
        grant_type: TOKEN_EXCHANGE,
        subject_token: subjectToken, subject_token_type: ACCESS_TOKEN_TYPE,
        actor_token: actorToken, actor_token_type: ACCESS_TOKEN_TYPE,
        resource: base,
      }, extra || {}));
    },
    /** Register a person in presence (the Lab's presence extension), with a token holding enter. */
    register: (token, person) => world.req('POST', 'fabric/presence/register', person, token),
    close,
  };
  return world;
}

/** A world that requires a token, listening at `port` on 127.0.0.1. */
async function authWorld(role, port, options) {
  const w = buildWorld(role, port, options);
  const log = [];
  logRequests(w.built.server, log);
  await new Promise((resolve, reject) => { w.built.server.once('error', reject); w.built.server.listen(port, '127.0.0.1', resolve); });
  return handle(port, w, log, async () => { try { await w.built.closeAll(); } catch (e) { /* closed */ } });
}

/**
 * Two worlds on one origin, at /w/b and /w/bb (one path prefix starts with the other), behind one front server that
 * hands each request to the world whose base path it falls under, segment by segment. By default they share one
 * authorization server's issuer and signing key, as two worlds of one operator may, so only the audience tells their
 * tokens apart; with options.separate each has its own.
 */
async function sameOriginWorlds(port, options) {
  options = options || {};
  const origin = 'http://127.0.0.1:' + port;
  // options.separate: each world its own authorization server (its own issuer, metadata and key) instead of one shared.
  const common = options.separate ? { origin } : { origin, issuer: origin + '/', seed: SHARED_SEED };
  const b = buildWorld('b', port, Object.assign({}, common, options.b || {}, { base: '/w/b', edits: options.edits }));
  // A world's role picks its fixture (config.js knows a, b, lobby and airport): both are b worlds, at two base paths.
  const bb = buildWorld('b', port, Object.assign({ label: 'World bb' }, common, options.bb || {}, { base: '/w/bb', edits: options.edits }));
  const under = (p, prefix) => p === prefix || p.startsWith(prefix + '/');
  const route = (p) => {
    if (under(p, '/w/bb') || p === '/.well-known/oauth-protected-resource/w/bb' || p === '/.well-known/oauth-authorization-server/w/bb') return bb;
    if (under(p, '/w/b') || p === '/.well-known/oauth-protected-resource/w/b' || p.startsWith('/.well-known/oauth-authorization-server')) return b;
    return null;
  };
  const log = [];
  const front = http.createServer((req, res) => {
    const target = route(new URL(req.url, origin).pathname);
    if (!target) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"no_world_here"}'); return; }
    target.built.server.emit('request', req, res);
  });
  front.on('upgrade', (req, socket, head) => {
    const target = route(new URL(req.url, origin).pathname);
    if (!target) { socket.destroy(); return; }
    target.built.server.emit('upgrade', req, socket, head);
  });
  logRequests(front, log);
  await new Promise((resolve, reject) => { front.once('error', reject); front.listen(port, '127.0.0.1', resolve); });
  const closeWorld = async (w) => { try { await w.built.closeAll(); } catch (e) { /* closed */ } };
  const close = async () => {
    await closeWorld(b);
    await closeWorld(bb);
    await new Promise((resolve) => { front.closeAllConnections && front.closeAllConnections(); front.close(() => resolve()); });
  };
  return { B: handle(port, b, log, close), BB: handle(port, bb, log, close), origin, log, close };
}

/** A web module (web/<name>) with exact string edits, copied beside the real signing folder; no edits: the real one. */
async function webModule(name, edits) {
  const file = path.join(ROOT, 'web', name);
  if (!edits || !edits.length) return import(pathToFileURL(file).href);
  let source = fs.readFileSync(file, 'utf8');
  for (const [from, to] of edits) {
    const count = source.split(from).length - 1;
    if (count !== 1) throw staleEdit('web/' + name, from, count);
    source = source.replace(from, () => to);
  }
  const dir = makeTempDir('i6-web');
  fs.symlinkSync(path.join(ROOT, 'web', 'signing'), path.join(dir, 'signing'), 'dir');
  const out = path.join(dir, name);
  fs.writeFileSync(out, source);
  return import(pathToFileURL(out).href);
}

/** The value of one parameter of a WWW-Authenticate challenge, or null. */
function challengeParam(header, name) {
  const m = new RegExp('(?:^|[\\s,])' + name + '="([^"]*)"').exec(String(header || ''));
  return m ? m[1] : null;
}

/** Wait until a stream holds a message of `type`, or is closed, or `ms` pass. */
async function settle(stream, type, ms) {
  const end = Date.now() + (ms || 3000);
  while (Date.now() < end && !stream.closedAt && !stream.messages.some((m) => m && m.type === type)) await sleep(25);
  return stream.messages.find((m) => m && m.type === type) || null;
}

/** The visitor's wallet for joins (World B's claims: the avatar and the preferences required, the display name optional). */
const WALLET = Object.freeze({ claims: { avatar: { uri: 'http://127.0.0.1:1/a.glb' }, preferences: { preferred_height_m: 1.7 }, display_name: 'Joiner 7f3' }, pilot: 'agent' });

module.exports = { SCOPES, TOKEN_EXCHANGE, ACCESS_TOKEN_TYPE, claimsOf, actorsOf, SHARED_SEED, WOW, WALLET, grantsFor, serverModule, authWorld, sameOriginWorlds, webModule, challengeParam, settle, sleep, i5 };
