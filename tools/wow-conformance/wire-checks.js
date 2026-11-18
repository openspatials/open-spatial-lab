'use strict';

/*
 * tools/wow-conformance/wire-checks.js — the wire halves of the overlay checks, as one suite against a base URL.
 *
 * Each overlay check of tools/arch-i1 to tools/arch-i5 has a text half (the offered text against the Lab's
 * contract) and a wire half (HTTP and event-stream assertions against a running world). The wire halves live
 * here, each a function that takes the world's base URL, so that the arch-iN checks and the corpus
 * (run.js --base <url>) run the same assertions:
 *
 *   u3Wire              i1 U3   every response validates with the required lists (a node write, if allowed)
 *   o2Wire              i2 O2   media type, entity tags, World.spatials, cross-origin reads and the preflight
 *   eventsWire          i3 W2   World.revision, services.events, the context, and node_updated on a data point
 *   placementWire       i4 W2   Portal, User and View nodes, World.preview, the preview URL, portal_activate
 *   portalActivateWire  i4 P10  one portal_activate per crossing, before navigation and before the departure
 *   joinWire            i5 W2   identity, claims and issues; POST /wow/user (201 and 403); user_joined, user_left; pilot;
 *                               a join without a pilot statement proceeds and its User reads pilot "unstated"
 *   departWire          i5 SE2  DELETE /wow/user/{id}: the User answers 404, one user_left, the join record stays
 *   authWire            i6 G1   protected resource metadata at the derived address with resource = the base URL; 401 with
 *                               WWW-Authenticate: Bearer and no error code (no resource_metadata); 401 invalid_token; no
 *                               token taken from a URL; with a client: a token from the metadata's authorization server
 *                               works, and a request outside its grants answers 403 insufficient_scope. Run by arch-i6 W2,
 *                               and by runWireSuite (i6:G1) on a world that serves protected resource metadata; N/A on
 *                               a world that serves none (iteration 6 authorization is opt-in)
 *
 * runWireSuite runs them all against one world, as the corpus does. It reads only, with two exceptions: node
 * writes, sent only when the caller asks for them (--writes), and a join with its DELETE, sent only when the
 * World resource says the world takes joins (identity and claims). A write that is not sent is reported as a
 * skip, by name, and a skip is never a pass. A crossing can only be started through the Lab's own extension
 * endpoints (the World API defines no crossing operation), so portal_activate is driven only on request
 * (--lab-crossing).
 */

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { missingRequired } = require('../arch-i1/conformance-words');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WOW = 'application/wow+json';
const IDENTITY = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];

const trim = (base) => String(base).replace(/\/+$/, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until fn() is truthy, or throw after `ms`. */
async function until(fn, ms, what)
{
    const end = Date.now() + ms;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > end) throw new Error('timed out waiting for ' + (what || 'a condition'));
        await sleep(25);
    }
}

/** One HTTP request to a full URL: { status, headers, json, body }. */
function request(method, url, body, extraHeaders)
{
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = body !== undefined && body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
        const headers = Object.assign({ Accept: 'application/json' }, extraHeaders || {});
        if (data !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.request({ host: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
            let out = '';
            res.on('data', (chunk) => { out += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = out ? JSON.parse(out) : null; } catch (error) { /* leave null */ }
                resolve({ status: res.statusCode, headers: res.headers, json, body: out });
            });
        });
        req.on('error', reject);
        if (data !== null) req.write(data);
        req.end();
    });
}

/**
 * A raw RFC 6455 client for a world's event stream, at a full URL (http, ws, https or wss), for what a browser
 * client cannot do (choose its Origin header) and to time a close. Returns { status, messages, closedAt, send(text), close() }.
 */
function openEventStream(url, headers)
{
    return new Promise((resolve) => {
        const u = new URL(url);
        const secure = u.protocol === 'https:' || u.protocol === 'wss:';
        const port = Number(u.port) || (secure ? 443 : 80);
        const socket = secure ? tls.connect(port, u.hostname, { servername: u.hostname }) : net.connect(port, u.hostname);
        const key = crypto.randomBytes(16).toString('base64');
        const out = { status: null, messages: [], closed: false, closedAt: null, openedAt: Date.now(), socket };
        let buffer = Buffer.alloc(0);
        let upgraded = false;
        out.send = (text) => {
            const payload = Buffer.from(text, 'utf8');
            const mask = crypto.randomBytes(4);
            const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
            const header = payload.length < 126 ? Buffer.from([ 0x81, 0x80 | payload.length ]) : Buffer.from([ 0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff ]);
            socket.write(Buffer.concat([ header, mask, masked ]));
        };
        out.close = () => { try { socket.destroy(); } catch (e) { /* gone */ } };
        socket.on(secure ? 'secureConnect' : 'connect', () => {
            const extra = Object.entries(headers || {}).map(([ k, v ]) => k + ': ' + v + '\r\n').join('');
            socket.write('GET ' + u.pathname + u.search + ' HTTP/1.1\r\nHost: ' + u.host + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n' + extra + '\r\n');
        });
        socket.on('data', (chunk) => {
            buffer = Buffer.concat([ buffer, chunk ]);
            if (!upgraded) {
                const end = buffer.indexOf('\r\n\r\n');
                if (end === -1) return;
                out.status = Number(/^HTTP\/1\.1 (\d+)/.exec(buffer.slice(0, end).toString())[1]);
                buffer = buffer.slice(end + 4);
                upgraded = true;
                resolve(out);
            }
            while (buffer.length >= 2) {
                const opcode = buffer[0] & 0x0f;
                let len = buffer[1] & 0x7f;
                let at = 2;
                if (len === 126) { if (buffer.length < 4) return; len = buffer.readUInt16BE(2); at = 4; }
                else if (len === 127) { if (buffer.length < 10) return; len = Number(buffer.readBigUInt64BE(2)); at = 10; }
                if (buffer.length < at + len) return;
                const payload = buffer.slice(at, at + len);
                buffer = buffer.slice(at + len);
                if (opcode === 0x8) { out.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : null; out.closedAt = out.closedAt || Date.now(); }
                if (opcode === 0x1) { try { out.messages.push(JSON.parse(payload.toString('utf8'))); } catch (e) { /* not JSON */ } }
            }
        });
        socket.on('close', () => { out.closed = true; out.closedAt = out.closedAt || Date.now(); if (!upgraded) resolve(out); });
        socket.on('error', () => { out.closed = true; if (!upgraded) resolve(out); });
    });
}

/** The members a schema requires, its own and those of every allOf part ($ref within components.schemas followed). */
function requiredOf(schema, schemas)
{
    if (!schema) return null;
    const out = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const part of schema.allOf || []) {
        const ref = /^#\/components\/schemas\/(\w+)$/.exec((part && part.$ref) || '');
        for (const key of requiredOf(ref ? schemas[ref[1]] : part, schemas) || []) out.add(key);
    }
    return [ ...out ];
}

// ---- small clients for one world, by base URL ---------------------------------------------------------------

const getWow = (base, p) => request('GET', trim(base) + p, null, { Accept: WOW });
async function worldDoc(base) { return (await getWow(base, '/wow/world')).json; }
async function rootOf(base, graph)
{
    const r = await getWow(base, '/wow/spatial/' + graph);
    if (r.status !== 200) throw new Error('GET spatial ' + graph + ': ' + r.status);
    return r.json.rootNodeID;
}
/** Create nodes under a parent; returns their ids in order. */
async function addNodes(base, graph, parentId, nodes)
{
    const r = await request('POST', trim(base) + '/wow/spatial/' + graph + '/node/' + parentId, nodes, { Accept: WOW });
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error('create under ' + parentId + ': ' + r.status + ' ' + r.body.slice(0, 160));
    return r.json.map((n) => n.id);
}
/** The Lab's presence extension (outside the World API): a player joins by registering. */
async function labJoin(base, playerId)
{
    const r = await request('POST', trim(base) + '/fabric/presence/register', { player_id: playerId, display_name: playerId, avatar_id: 'proof-avatar' });
    if (r.status !== 201) throw new Error('register ' + playerId + ': ' + r.status + ' ' + r.body.slice(0, 120));
    return r.json;
}
/** The Lab's crossing intent (outside the World API): the player crosses the portal. */
const labExitIntent = (base, portalId, playerId) => request('POST', trim(base) + '/portal/exit-intent', { portal_id: String(portalId), player_id: playerId });

/**
 * The server's own validation verdict for a response (X-OSL-WoW-Validation), or, when the world sends none and a
 * validator is given, this suite's own verdict on the body. Returns { pass, text }.
 */
function verdictOf(res, name, opts)
{
    const header = res.headers['x-osl-wow-validation'];
    if (opts.requireValidationHeader || header !== undefined || !opts.validator) return { pass: header === 'pass:' + name, text: header };
    const v = opts.validator.validate(name, res.json);
    return { pass: v.valid, text: (v.valid ? 'pass:' : 'fail:') + name + ' (checked by this suite; the world sends no X-OSL-WoW-Validation)' + (v.valid ? '' : ' ' + String(v.errorsText).slice(0, 120)) };
}

// ---- i1 U3 ------------------------------------------------------------------------------------------------

const U3_READS = [ [ '/wow/world', 'World' ], [ '/wow/user/1', 'User' ], [ '/wow/view/1', 'View' ], [ '/wow/portal/1', 'Portal' ], [ '/wow/spatial/1', 'Spatial' ] ];

/**
 * i1 U3 on the wire: what the world serves validates with the required lists (`schemas`, the build the server
 * loads) and against `validator`; with opts.writes, a node it creates does too. Every problem starts with opts.label.
 */
async function u3Wire(base, opts)
{
    base = trim(base);
    const { label, validator, schemas } = opts;
    const problems = [];
    const skipped = [];
    let measured = 0;
    const measure = (where, name, value) => {
        measured += 1;
        const missing = missingRequired(schemas[name], value);
        if (missing.length) problems.push(label + ' ' + where + ': missing required member ' + missing.join(', ') + ' of ' + name);
        const v = validator.validate(name, value);
        if (!v.valid) problems.push(label + ' ' + where + ': not a valid ' + name + ': ' + String(v.errorsText).slice(0, 100));
    };
    const nodes = (where, root) => {
        const stack = [ root ];
        while (stack.length) {
            const n = stack.pop();
            measure(where + ' node ' + (n && n.id), 'Node', n);
            for (const child of (n && n.children) || []) if (child && typeof child === 'object') stack.push(child);
        }
    };
    let rootId = 0;
    for (const [ route, name ] of U3_READS) {
        const r = await request('GET', base + route);
        if (r.status !== 200 || !r.json) { problems.push(label + ' GET ' + route + ': ' + r.status); continue; }
        measure('GET ' + route, name, r.json);
        if (name === 'Spatial' && Number.isInteger(r.json.rootNodeID)) rootId = r.json.rootNodeID;
    }
    const tree = await request('GET', base + '/wow/spatial/1/node/' + rootId);
    if (tree.status !== 200 || !tree.json) problems.push(label + ' GET the root node: ' + tree.status);
    else nodes('GET the root node:', tree.json);
    if (opts.writes) {
        const made = await request('POST', base + '/wow/spatial/1/node/' + rootId, [ { label: 'u3-' + label, localTransform: IDENTITY } ]);
        if (made.status !== 200 || !Array.isArray(made.json)) problems.push(label + ' POST a node: ' + made.status + ' ' + String(made.body).slice(0, 120));
        else {
            for (const n of made.json) nodes('POST a node:', n);
            if (opts.cleanup) for (const n of made.json) if (n && Number.isInteger(n.id)) await request('DELETE', base + '/wow/spatial/1/node/' + n.id);
        }
    } else skipped.push('POST a node (a write): ' + (opts.writesReason || 'node writes were not requested'));
    return { problems, measured, skipped };
}

// ---- i2 O2 ------------------------------------------------------------------------------------------------

/** i2 O2 on the wire: the media type, application/json by negotiation, entity tags, World.spatials, ETag exposed, the preflight. */
async function o2Wire(base)
{
    base = trim(base);
    const problems = [];
    const got = await request('GET', base + '/wow/world', null, { Accept: WOW, Origin: 'http://elsewhere.example' });
    const json = await request('GET', base + '/wow/world', null, { Accept: 'application/json' });
    const pre = await request('OPTIONS', base + '/wow/spatial/1/node/0', null, { Origin: 'http://elsewhere.example', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'if-match' });
    if (got.headers['content-type'] !== WOW) problems.push('GET /wow/world answers ' + got.headers['content-type']);
    if (json.headers['content-type'] !== 'application/json') problems.push('application/json is not available by negotiation');
    if (!got.headers.etag || !got.headers['last-modified']) problems.push('GET /wow/world has no ETag or Last-Modified');
    if (!Array.isArray(got.json && got.json.spatials)) problems.push('the World has no spatials');
    if (!/\bETag\b/.test(got.headers['access-control-expose-headers'] || '')) problems.push('ETag is not exposed to other origins');
    const allowed = String(pre.headers['access-control-allow-headers'] || '');
    for (const h of [ 'Authorization', 'If-None-Match', 'If-Match' ]) if (!allowed.includes(h)) problems.push('the preflight does not allow ' + h);
    return { problems, skipped: [] };
}

// ---- i3 W2 ------------------------------------------------------------------------------------------------

/**
 * i3 W2 on the wire: the World reports its revision and events service, the context is application/ld+json, and,
 * with opts.writes, an observer of a data point sees one node_updated, carrying revision, time and urls, for one
 * change and one write that changes nothing; every event carries what opts.eventSchema requires.
 * opts.observe: the observer module (web/wow-observe.mjs by default).
 */
async function eventsWire(base, opts)
{
    base = trim(base);
    opts = opts || {};
    const problems = [];
    const skipped = [];
    const events = [];
    let observer = null;
    let n = null;
    try {
        if (opts.writes) {
            const obs = opts.observe || await import(pathToFileURL(path.join(REPO_ROOT, 'web', 'wow-observe.mjs')).href);
            observer = obs.createObserver({ onEvent: (b, evt) => events.push(evt) });
            [ n ] = await addNodes(base, 1, await rootOf(base, 1), [ { label: 'node n', localTransform: IDENTITY, properties: { temperature: 20 } } ]);
            await observer.watch(base + '/wow/spatial/1/node/' + n + '#/properties/temperature');
            await until(() => [ ...observer.streams.values() ].every((s) => s.state.status === 'live'), 5000, 'the stream');
            const body = (await getWow(base, '/wow/spatial/1/node/' + n)).json;
            delete body.children;
            body.properties = { temperature: 21 };
            await request('PUT', base + '/wow/spatial/1/node/' + n, body, { Accept: WOW });
            await request('PUT', base + '/wow/spatial/1/node/' + n, body, { Accept: WOW });
            await sleep(400);
        } else skipped.push('node_updated on a data point (a node create and two PUTs): ' + (opts.writesReason || 'node writes were not requested'));
        const world = await worldDoc(base);
        const contextAnswer = await fetch(base + '/wow/context.jsonld');
        if (contextAnswer.headers.get('content-type') !== 'application/ld+json') problems.push('the context is served as ' + contextAnswer.headers.get('content-type'));
        await contextAnswer.text();
        if (!Number.isInteger(world.revision) || !world.services || world.services.events !== 'events') problems.push('the World lacks revision or services.events');
        if (opts.writes) {
            const updates = events.filter((e) => e.type === 'node_updated');
            if (updates.length !== 1) problems.push(`${updates.length} node_updated events for one change and one write that changed nothing`);
            const e = updates[0] || {};
            if (!Number.isInteger(e.revision) || !e.time || !/^\d{4}-\d\d-\d\dT/.test(e.time) || !Array.isArray(e.urls) || !e.urls.includes('wow/spatial/1/node/' + n)) problems.push('an event lacks revision, time or urls: ' + JSON.stringify(e).slice(0, 160));
        }
        const eventSchema = opts.eventSchema;
        if (!eventSchema || !Array.isArray(eventSchema.required)) problems.push('the served contract has no Event schema with a required list');
        for (const evt of events) {
            const missing = missingRequired(eventSchema, evt);
            if (missing.length) problems.push('a ' + evt.type + ' event on the wire lacks ' + missing.join(', ') + ', which the served Event schema requires');
        }
    } finally {
        if (observer) observer.close();
        if (opts.cleanup && n !== null) await request('DELETE', base + '/wow/spatial/1/node/' + n).catch(() => {});
    }
    return { problems, skipped, events };
}

// ---- i4 W2 ------------------------------------------------------------------------------------------------

/**
 * i4 W2 on the wire. Reads the portal opts.portalId, the user and the view 1, the World and its preview URL; with
 * opts.crossing (a function that makes one crossing through that portal), watches the event stream (opts.eventsUrl,
 * or services.events) for portal_activate. opts.portalNode and opts.preview ({ node, radius_m }) and opts.previewId
 * are what the caller placed, when it placed them; without them the shapes are checked. opts.schemas: the served
 * schemas. Returns { problems, skipped, world }.
 */
async function placementWire(base, opts)
{
    base = trim(base);
    const problems = [];
    const skipped = [];
    const portal = (await getWow(base, '/wow/portal/' + opts.portalId)).json;
    const user = (await getWow(base, '/wow/user/1')).json;
    const view = (await getWow(base, '/wow/view/1')).json;
    const world = await worldDoc(base);
    const declared = !!(world && world.preview);
    const preview = opts.preview || (declared && world.preview.url) ? await getWow(base, '/' + (world.preview && world.preview.url)) : null;
    let activations = [];
    if (opts.crossing) {
        const stream = await openEventStream(opts.eventsUrl || base + '/' + ((world.services && world.services.events) || 'events'));
        try {
            await opts.crossing();
            await sleep(300);
            activations = stream.messages.filter((m) => m.type === 'portal_activate');
        } finally {
            stream.close();
        }
    }
    if (opts.portalNode !== undefined && opts.portalNode !== null) {
        if (typeof portal.destination !== 'string' || portal.node !== opts.portalNode) problems.push('the portal: ' + JSON.stringify({ destination: portal.destination, node: portal.node }));
    } else if (!portal || typeof portal.destination !== 'string' || typeof portal.node !== 'string') problems.push('the portal: ' + JSON.stringify({ destination: portal && portal.destination, node: portal && portal.node }));
    if (typeof user.node !== 'string') problems.push('the user has no node');
    if (typeof view.node !== 'string') problems.push('the view has no node');
    if (opts.preview) {
        if (!world.preview || world.preview.node !== opts.preview.node || world.preview.radius_m !== opts.preview.radius_m) problems.push('the World declares ' + JSON.stringify(world.preview));
    } else if (!declared) skipped.push('World.preview and the preview URL: this World declares no preview (World.preview is optional)');
    if (preview) {
        const id = opts.previewId !== undefined && opts.previewId !== null ? opts.previewId : Number((/\/node\/(\d+)$/.exec(String(world.preview.node || '')) || [])[1]);
        if (preview.status !== 200 || preview.json.id !== id || !Array.isArray(preview.json.children)) problems.push('the preview URL answered ' + preview.status);
    } else if (declared && !opts.preview) skipped.push('the preview URL: this World\'s preview has no url (an image-only preview)');
    // What the served schemas require, on the wire: the portal, the user, the view and the World.
    const served = opts.schemas;
    for (const [ name, value ] of [ [ 'Portal', portal ], [ 'User', user ], [ 'View', view ], [ 'World', world ] ]) {
        const missing = missingRequired(served[name], value);
        if (missing.length) problems.push('the served ' + name + ' lacks ' + missing.join(', ') + ', which the served ' + name + ' schema requires');
    }
    const activateRequired = requiredOf(served.PortalActivate, served);
    if (!activateRequired || !activateRequired.includes('portalId') || !activateRequired.includes('revision')) problems.push('the served contract has no PortalActivate requiring its own members and the Event\'s: ' + JSON.stringify(activateRequired));
    if (opts.crossing) {
        if (activations.length !== 1) problems.push(activations.length + ' portal_activate events for one crossing intent');
        for (const evt of activations) {
            const missing = missingRequired({ required: activateRequired || [] }, evt);
            if (missing.length) problems.push('a portal_activate on the wire lacks ' + missing.join(', ') + ', which the served PortalActivate requires');
            if (String(evt.portalId) !== String(opts.portalId)) problems.push('a portal_activate names portal ' + JSON.stringify(evt.portalId) + ', not ' + opts.portalId);
        }
    } else skipped.push('portal_activate for one crossing: ' + (opts.crossingReason || 'no crossing was driven'));
    return { problems, skipped, world };
}

/** Each served preview, [[which, value]], meets an alternative of the served World.preview (its anyOf of required lists). */
function previewAlternativeProblems(served, previews)
{
    const problems = [];
    const alternatives = (((served.World || {}).properties || {}).preview || {}).anyOf;
    if (!Array.isArray(alternatives) || !alternatives.length) problems.push('the served contract gives World.preview no alternatives');
    for (const [ which, value ] of previews) {
        if (Array.isArray(alternatives) && !alternatives.some((alt) => !missingRequired(alt, value).length)) problems.push('a served preview ' + which + ' meets no alternative of World.preview: ' + JSON.stringify(value));
    }
    return problems;
}

/** A served preview carries opts.forms (when given) and validates against the served World.preview (`validPreview`, compiled). */
function previewProblems(preview, validPreview, opts)
{
    const problems = [];
    if (opts.forms) {
        const forms = preview && typeof preview === 'object' ? opts.forms.filter((key) => preview[key] === undefined || preview[key] === null) : opts.forms.slice();
        if (forms.length) problems.push(opts.label + ' lacks ' + forms.join(', ') + ': ' + JSON.stringify(preview));
    }
    if (!validPreview(preview)) problems.push(opts.label + ' does not validate against the served World.preview: ' + JSON.stringify(preview) + ' ' + JSON.stringify((validPreview.errors || []).map((e) => e.instancePath + ' ' + e.message)));
    return problems;
}

// ---- i4 P10 -----------------------------------------------------------------------------------------------

/**
 * i4 P10 on the wire: for each of opts.visitors, a player joins (the Lab's presence extension), and crosses the
 * portal opts.portalId (the Lab's crossing intent); opts.afterIntent(visitor), when given, completes the crossing
 * as a client does and returns { navigatedAt, problem }. An observer on the event stream (opts.eventsUrl, or the
 * World's services.events) must see exactly one portal_activate per crossing, before navigation and before the
 * user's departure, carrying the portal id, the user, revision, time and urls.
 * Returns { problems, activations, crossings, fatal } (fatal: the stream did not open; nothing else was measured).
 */
async function portalActivateWire(base, opts)
{
    base = trim(base);
    let eventsUrl = opts.eventsUrl;
    if (!eventsUrl) {
        const world = await worldDoc(base);
        eventsUrl = base + '/' + ((world && world.services && world.services.events) || 'events');
    }
    const stream = await openEventStream(eventsUrl);
    const problems = [];
    try {
        if (stream.status !== 101) return { problems: [ (opts.worldName || 'the world\'s') + ' event stream answered ' + stream.status ], activations: [], crossings: [], fatal: true };
        const crossings = [];
        for (const visitor of opts.visitors) {
            await labJoin(base, visitor);
            const joined = await until(() => stream.messages.find((m) => m.type === 'user_joined' && m.user && m.user.player_id === visitor), 5000, 'user_joined of ' + visitor);
            const intent = await labExitIntent(base, opts.portalId, visitor);
            if (intent.status !== 201) problems.push(visitor + ': the crossing intent answered ' + intent.status);
            let navigatedAt = null;
            if (opts.afterIntent) {
                const after = await opts.afterIntent(visitor);
                navigatedAt = after.navigatedAt;
                if (after.problem) problems.push(after.problem);
            }
            crossings.push({ visitor, userId: joined.user.id, navigatedAt });
        }
        await sleep(400);
        const activations = stream.messages.filter((m) => m.type === 'portal_activate');
        if (activations.length !== crossings.length) problems.push(`${activations.length} portal_activate events for ${crossings.length} crossings`);
        let lastRevision = -Infinity;
        for (const c of crossings) {
            const mine = activations.filter((e) => String(e.userId) === String(c.userId));
            if (mine.length !== 1) { problems.push(`${mine.length} portal_activate events name ${c.visitor}'s user ${c.userId}`); continue; }
            const e = mine[0];
            if (String(e.portalId) !== String(opts.portalId)) problems.push(c.visitor + ': portalId ' + JSON.stringify(e.portalId) + ', the portal is ' + opts.portalId);
            if (!Number.isInteger(e.revision) || e.revision <= lastRevision) problems.push(c.visitor + ': revision ' + JSON.stringify(e.revision));
            lastRevision = Number.isInteger(e.revision) ? e.revision : lastRevision;
            if (typeof e.time !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(e.time)) problems.push(c.visitor + ': time ' + JSON.stringify(e.time));
            if (!Array.isArray(e.urls) || !e.urls.includes('wow/world')) problems.push(c.visitor + ': urls ' + JSON.stringify(e.urls));
            if (c.navigatedAt !== null && Date.parse(e.time) > c.navigatedAt) problems.push(c.visitor + ': sent at ' + e.time + ', after navigation at ' + new Date(c.navigatedAt).toISOString());
            const left = stream.messages.findIndex((m) => m.type === 'user_left' && String(m.userId) === String(c.userId));
            if (left !== -1 && left < stream.messages.indexOf(e)) problems.push(c.visitor + ': portal_activate came after the user\'s user_left');
        }
        return { problems, activations, crossings, fatal: false };
    } finally {
        stream.close();
    }
}

// ---- i5 W2 ------------------------------------------------------------------------------------------------

/**
 * i5 W2 on the wire. The event stream (opts.eventsUrl, or services.events) is opened first. The World states
 * identity, claims and issues and validates; with opts.wallet ({ claims }), one join per entry of opts.withholds
 * (each a list of claim names kept back), posted with opts.agent (web/wow-handshake.mjs), answers with a JoinAnswer
 * that validates; the statuses are opts.expectStatuses (e.g. '201,403'); the proceeding join's User carries the
 * pilot it stated; the proceeding join sends one user_joined and the others none; DELETE of that User sends one
 * user_left. Then a join with every wallet claim and no pilot member (as a client that predates the pilot statement
 * sends it) MUST proceed (201), and GET /wow/user/{id} of its User MUST read pilot "unstated" (never "human"); that
 * User is then deleted. opts.requireValidationHeader: judge only by the server's X-OSL-WoW-Validation; otherwise, when the
 * world sends none, this suite validates the body with opts.validator.
 * Returns { problems, skipped, statuses, wire }.
 */
async function joinWire(base, opts)
{
    base = trim(base);
    const problems = [];
    const skipped = [];
    const statuses = [];
    let wire = 'no wire events read';
    const stream = await openEventStream(opts.eventsUrl || base + '/events');
    try {
        const worldRes = await request('GET', base + '/wow/world', null, { Accept: WOW });
        const world = worldRes.json;
        if (!world.identity || typeof world.identity.base !== 'string' || !Array.isArray(world.claims) || !Array.isArray(world.issues)) problems.push('the World: ' + JSON.stringify({ identity: world.identity, claims: world.claims, issues: world.issues }));
        const worldVerdict = verdictOf(worldRes, 'OSLWorldResponse', opts);
        if (!worldVerdict.pass) problems.push('the World validates as ' + worldVerdict.text);
        if (!opts.wallet) {
            skipped.push('POST /wow/user, user_joined, user_left and pilot (a join and its DELETE): ' + (opts.joinReason || 'no join was made'));
            return { problems, skipped, statuses, wire };
        }
        const hs = opts.agent;
        const pilot = opts.pilot || 'agent';
        const answers = [];
        for (const withhold of opts.withholds) {
            const key = await hs.visitKey();
            const values = {};
            for (const n of Object.keys(opts.wallet.claims)) if (!withhold.includes(n)) values[n] = opts.wallet.claims[n];
            const r = await request('POST', base + '/wow/user', await hs.presentation({ values, key, audience: base + '/', pilot }), { Accept: WOW });
            statuses.push(r.status + ' ' + r.headers['x-osl-wow-validation']);
            answers.push(r.json || {});
            const v = verdictOf(r, 'OSLJoinAnswer', opts);
            if (!v.pass) problems.push('POST /wow/user ' + r.status + ' validates as ' + v.text);
        }
        if (statuses.map((s) => s.split(' ')[0]).join(',') !== opts.expectStatuses) problems.push('the joins answered ' + statuses.join(', '));
        for (const s of opts.alsoSkipped || []) skipped.push(s);
        // On the wire: the event stream carries user_joined for the User the proceeding join made, and user_left when it departs.
        const joined = /^wow\/user\/(\d+)$/.exec(answers[0].user || '');
        if (stream.status !== 101) problems.push('the event stream answered ' + stream.status);
        else if (!joined) problems.push('the proceeding join named no User: ' + JSON.stringify(answers[0].user));
        else {
            const id = Number(joined[1]);
            // On the wire: the User the proceeding join made carries the pilot statement the join stated.
            const userRes = await request('GET', base + '/wow/user/' + id, null, { Accept: WOW });
            const userVerdict = verdictOf(userRes, 'OSLUserResponse', opts);
            if (userRes.status !== 200 || !userRes.json || userRes.json.pilot !== pilot) problems.push('GET /wow/user/' + id + ' answered ' + userRes.status + ' with pilot ' + JSON.stringify(userRes.json && userRes.json.pilot) + ', not "' + pilot + '"');
            else if (!userVerdict.pass) problems.push('GET /wow/user/' + id + ' validates as ' + userVerdict.text);
            const of = (type) => stream.messages.filter((m) => m && m.type === type && (Number(m.userId) === id || (m.user && Number(m.user.id) === id)));
            const settle = async (type) => { const end = Date.now() + 3000; while (!of(type).length && Date.now() < end) await sleep(50); await sleep(300); };
            await settle('user_joined');
            const ups = of('user_joined');
            const allJoined = stream.messages.filter((m) => m && m.type === 'user_joined').length;
            if (ups.length !== 1) problems.push(ups.length + ' user_joined event(s) for user ' + id + ' on the stream, not 1');
            else if (!ups[0].user || Number(ups[0].user.id) !== id) problems.push('user_joined carries no user ' + id + ': ' + JSON.stringify(ups[0]).slice(0, 160));
            if (allJoined !== ups.length) problems.push('the denied join sent ' + (allJoined - ups.length) + ' user_joined event(s)');
            const del = await request('DELETE', base + '/wow/user/' + id, null, { Accept: WOW });
            if (del.status !== 200) problems.push('DELETE /wow/user/' + id + ' answered ' + del.status);
            await settle('user_left');
            const downs = of('user_left');
            if (downs.length !== 1) problems.push(downs.length + ' user_left event(s) for user ' + id + ' on the stream, not 1');
            else if (Number(downs[0].userId) !== id) problems.push('user_left carries userId ' + downs[0].userId + ', not ' + id);
            wire = 'GET /wow/user/' + id + ' with pilot "' + (userRes.json && userRes.json.pilot) + '" (' + userVerdict.text + '), user_joined for user ' + id + ' (revision ' + (ups[0] && ups[0].revision) + '), none for the deny, and user_left for ' + id + ' after DELETE (revision ' + (downs[0] && downs[0].revision) + ')';
        }
        // A join without a pilot statement (a client that predates it): it proceeds, and its User reads pilot "unstated".
        {
            const body = await hs.presentation({ values: Object.assign({}, opts.wallet.claims), key: await hs.visitKey(), audience: base + '/', pilot });
            delete body.pilot;
            const r = await request('POST', base + '/wow/user', body, { Accept: WOW });
            const a = r.json || {};
            const made = /^wow\/user\/(\d+)$/.exec(a.user || '');
            if (r.status !== 201 || !made) problems.push('a join without a pilot statement answered ' + r.status + ' ' + a.outcome + ' "' + (a.reason || '') + '", not 201 with a User');
            else {
                const uid = Number(made[1]);
                const u = await request('GET', base + '/wow/user/' + uid, null, { Accept: WOW });
                const uv = verdictOf(u, 'OSLUserResponse', opts);
                if (u.status !== 200 || !u.json || u.json.pilot !== 'unstated') problems.push('a join without a pilot statement: GET /wow/user/' + uid + ' answered ' + u.status + ' with pilot ' + JSON.stringify(u.json && u.json.pilot) + ', not "unstated"');
                else if (!uv.pass) problems.push('a join without a pilot statement: GET /wow/user/' + uid + ' validates as ' + uv.text);
                else wire += '; a join without a pilot statement: 201, GET /wow/user/' + uid + ' with pilot "unstated" (' + uv.text + ')';
                await request('DELETE', base + '/wow/user/' + uid, null, { Accept: WOW });
            }
        }
        return { problems, skipped, statuses, wire };
    } finally {
        stream.close();
    }
}

// ---- i5 SE2 -----------------------------------------------------------------------------------------------

/**
 * i5 SE2 on the wire: a visitor joins with opts.agent's enterWorld and opts.wallet; DELETE /wow/user/{id} ends the
 * visit (the User then answers 404), sends exactly one user_left for that user on the event stream (opts.eventsUrl,
 * or base/events), and the record of the join (JoinAnswer.record) stays readable with the same outcome.
 * opts.requireRecord: a join answer without a record is a failure (otherwise the record parts are a named skip).
 * Returns { problems, skipped, fatal, detail }.
 */
async function departWire(base, opts)
{
    base = trim(base);
    const problems = [];
    const skipped = [];
    const stream = await openEventStream(opts.eventsUrl || base + '/events');
    try {
        if (stream.status !== 101) return { problems, skipped, fatal: 'the event stream answered ' + stream.status };
        const entered = await opts.agent.enterWorld(base + '/', { wallet: opts.wallet });
        const answer = entered.answer || {};
        const userId = /^wow\/user\/(\d+)$/.exec(answer.user || '');
        if (entered.status !== 201 || !userId || (opts.requireRecord && !answer.record)) return { problems, skipped, fatal: 'the join answered ' + entered.status + ' ' + JSON.stringify({ outcome: answer.outcome, user: answer.user, record: answer.record }) };
        const id = Number(userId[1]);
        const recordUrl = answer.record ? base + '/' + answer.record : null;
        if (!recordUrl) skipped.push('the record of the join stays readable: the join answer names no record');
        const before = await request('GET', base + '/wow/user/' + id, null, { Accept: WOW });
        const recordBefore = recordUrl ? await request('GET', recordUrl, null) : null;
        if (before.status !== 200) problems.push('before the depart the User answered ' + before.status);
        if (recordBefore && recordBefore.status !== 200) problems.push('before the depart the record answered ' + recordBefore.status);
        const del = await request('DELETE', base + '/wow/user/' + id, null, { Accept: WOW });
        if (del.status !== 200) problems.push('DELETE /wow/user/' + id + ' answered ' + del.status + ' ' + del.body.slice(0, 120));
        const leftFor = () => stream.messages.filter((m) => m && m.type === 'user_left' && (Number(m.userId) === id || (m.user && Number(m.user.id) === id)));
        const end = Date.now() + 3000;
        while (!leftFor().length && Date.now() < end) await sleep(50);
        await sleep(400); // a second user_left would arrive here
        const left = leftFor();
        if (left.length !== 1) problems.push(left.length + ' user_left event(s) for user ' + id + ' on the stream, not 1');
        else if (!Number.isInteger(left[0].revision) || typeof left[0].time !== 'string') problems.push('the user_left event carries no revision or time: ' + JSON.stringify(left[0]).slice(0, 160));
        const after = await request('GET', base + '/wow/user/' + id, null, { Accept: WOW });
        if (after.status !== 404) problems.push('after the depart the User still answers ' + after.status + ' (still present)');
        let recordAfter = null;
        if (recordUrl) {
            recordAfter = await request('GET', recordUrl, null);
            if (recordAfter.status !== 200) problems.push('after the depart the record of the join answers ' + recordAfter.status);
            else if (!recordBefore.json || recordAfter.json.outcome !== recordBefore.json.outcome || recordAfter.json.user !== recordBefore.json.user) problems.push('after the depart the record changed: ' + JSON.stringify(recordAfter.json).slice(0, 160));
        }
        const detail = `user ${id} joined (proceed), DELETE answered 200, the User then answers 404, one user_left for ${id} on the stream (revision ${left[0] && left[0].revision}), and ` + (recordUrl ? `${answer.record} still reads ${recordAfter && recordAfter.json && recordAfter.json.outcome}` : 'no record was named');
        return { problems, skipped, fatal: null, detail };
    } finally {
        stream.close();
    }
}

// ---- i6 G1 ------------------------------------------------------------------------------------------------

const TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/** Where a world's protected resource metadata is (RFC 9728 §3.1): {origin}/.well-known/oauth-protected-resource{path prefix}. */
function resourceMetadataUrl(base)
{
    const u = new URL(trim(base) + '/');
    return u.origin + '/.well-known/oauth-protected-resource' + u.pathname.replace(/\/+$/, '');
}

/** One parameter of a WWW-Authenticate challenge, or null. */
function challengeParam(header, name)
{
    const m = new RegExp('(?:^|[\\s,])' + name + '="([^"]*)"').exec(String(header || ''));
    return m ? m[1] : null;
}

/**
 * i6 G1 on the wire, against a world that requires a token: its protected resource metadata, at the address derived
 * from its base URL, names the base URL as its resource and an authorization server; a request with no token answers
 * 401 with WWW-Authenticate: Bearer, no error code and no resource_metadata; a token that is not one of its own answers
 * 401 with error="invalid_token" in WWW-Authenticate; a token in a URL is not accepted. With opts.client
 * ({ client_id, client_secret }, a client the world knows), a token from the metadata's authorization server (client
 * credentials, with the base URL as resource) reads the World, and a request that needs opts.deniedScope (write, a
 * scope the client is not granted) answers 403 with error="insufficient_scope". When the authorization server's
 * metadata lists token exchange (RFC 8693), an exchange whose subject token comes from an issuer the world does not
 * trust, with the client's token as the actor token, answers 400 with error="invalid_request" (RFC 8693 §2.2.2).
 * Returns { problems, skipped, detail }.
 */
async function authWire(base, opts)
{
    base = trim(base);
    opts = opts || {};
    const problems = [];
    const skipped = [];
    const seen = [];
    const metaUrl = resourceMetadataUrl(base);
    const meta = await request('GET', metaUrl, null);
    if (meta.status !== 200 || !meta.json) return { problems: [ metaUrl + ' answered ' + meta.status ], skipped, detail: '' };
    if (meta.json.resource !== base + '/') problems.push('the metadata\'s resource is ' + JSON.stringify(meta.json.resource) + ', not the base URL ' + base + '/');
    const servers = Array.isArray(meta.json.authorization_servers) ? meta.json.authorization_servers : [];
    if (!servers.length) problems.push('the metadata names no authorization server');
    seen.push('metadata at ' + new URL(metaUrl).pathname + ' with resource ' + meta.json.resource);
    const none = await request('GET', base + '/wow/world', null, { Accept: WOW });
    const h0 = String(none.headers['www-authenticate'] || '');
    if (none.status !== 401 || !/^Bearer\b/.test(h0) || /\berror=/.test(h0)) problems.push('no token: ' + none.status + ' WWW-Authenticate ' + JSON.stringify(h0) + ', not 401 Bearer with no error code');
    if (/resource_metadata/.test(h0)) problems.push('the 401 carries resource_metadata');
    const bad = await request('GET', base + '/wow/world', null, { Accept: WOW, Authorization: 'Bearer eyJhbGciOiJFZERTQSJ9.e30.bm90LWEtc2lnbmF0dXJl' });
    if (bad.status !== 401 || challengeParam(bad.headers['www-authenticate'], 'error') !== 'invalid_token') problems.push('a token that is not the world\'s own: ' + bad.status + ' WWW-Authenticate ' + JSON.stringify(bad.headers['www-authenticate']));
    const inUrl = await request('GET', base + '/wow/world?access_token=stand-in-not-a-token', null, { Accept: WOW });
    if (inUrl.status >= 200 && inUrl.status < 300) problems.push('a token in a URL was accepted (' + inUrl.status + ')');
    seen.push('no token 401 Bearer with no error code; a foreign token 401 invalid_token; a token in a URL ' + inUrl.status);
    if (!opts.client) {
        skipped.push('a token from the authorization server, and a 403 insufficient_scope: no client of this world was given');
        return { problems, skipped, detail: seen.join('; ') };
    }
    const as = new URL(servers[0] || 'http://invalid/');
    const asMeta = await request('GET', as.origin + '/.well-known/oauth-authorization-server' + as.pathname.replace(/\/+$/, ''), null);
    const endpoint = asMeta.json && asMeta.json.token_endpoint;
    if (asMeta.status !== 200 || !endpoint) { problems.push('the authorization server metadata answered ' + asMeta.status); return { problems, skipped, detail: seen.join('; ') }; }
    // RFC 6749 §2.3.1: the client id and secret are form-urlencoded before HTTP Basic.
    const basic = 'Basic ' + Buffer.from(encodeURIComponent(opts.client.client_id) + ':' + encodeURIComponent(opts.client.client_secret)).toString('base64');
    const tok = await request('POST', endpoint, 'grant_type=client_credentials&resource=' + encodeURIComponent(base + '/'), { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic });
    const token = tok.json && tok.json.access_token;
    if (tok.status !== 200 || !token) { problems.push('the token endpoint answered ' + tok.status + ' ' + tok.body.slice(0, 120)); return { problems, skipped, detail: seen.join('; ') }; }
    const ok = await request('GET', base + '/wow/world', null, { Accept: WOW, Authorization: 'Bearer ' + token });
    if (ok.status !== 200) problems.push('the World with the token answered ' + ok.status);
    if (opts.deniedScope === 'write') {
        const w = await request('POST', base + '/wow/spatial/1/node/0', [], { Accept: WOW, Authorization: 'Bearer ' + token });
        if (w.status !== 403 || challengeParam(w.headers['www-authenticate'], 'error') !== 'insufficient_scope') problems.push('a write without the write grant: ' + w.status + ' WWW-Authenticate ' + JSON.stringify(w.headers['www-authenticate']));
        seen.push('a token from ' + endpoint + ' (scope ' + tok.json.scope + ') reads the World (' + ok.status + ') and a write answers ' + w.status + ' ' + challengeParam(w.headers['www-authenticate'], 'error'));
    } else {
        skipped.push('a 403 insufficient_scope: no scope the client lacks was named');
        seen.push('a token from ' + endpoint + ' reads the World (' + ok.status + ')');
    }
    const grantTypes = (asMeta.json && asMeta.json.grant_types_supported) || [];
    if (grantTypes.includes(TOKEN_EXCHANGE)) {
        const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const now = Math.floor(Date.now() / 1000);
        const stranger = b64({ alg: 'EdDSA', typ: 'at+jwt' }) + '.' + b64({ iss: 'https://issuer.invalid/', aud: base + '/', sub: 'stand-in', scope: 'read', iat: now, exp: now + 60 }) + '.' + Buffer.alloc(64).toString('base64url');
        const form = new URLSearchParams({ grant_type: TOKEN_EXCHANGE, subject_token: stranger, subject_token_type: ACCESS_TOKEN_TYPE, actor_token: token, actor_token_type: ACCESS_TOKEN_TYPE, resource: base + '/' });
        const ex = await request('POST', endpoint, form.toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
        if (ex.status !== 400 || !ex.json || ex.json.error !== 'invalid_request') problems.push('a token exchange from an issuer the world does not trust: ' + ex.status + ' ' + String(ex.body).slice(0, 120) + ', not 400 invalid_request');
        seen.push('a token exchange whose subject token comes from an untrusted issuer answers ' + ex.status + ' ' + (ex.json && ex.json.error));
    } else {
        skipped.push('token exchange: the authorization server metadata does not list it');
    }
    return { problems, skipped, detail: seen.join('; ') };
}

// ---- the suite, against one world -------------------------------------------------------------------------

/** The visitor the corpus joins as: a test wallet. Only the claims a world asks for are sent. */
const CORPUS_WALLET = Object.freeze({
    claims: { avatar: { uri: 'http://127.0.0.1:1/assets/actionforge/characters/sophie/sophie.glb', label: 'Sophie' }, display_name: 'Ada', preferences: { preferred_height_m: 1.85 } },
    pilot: 'agent',
});

const SUITE = [
    { id: 'i1:U3', title: 'every response the world serves validates with the required lists of the contract' },
    { id: 'i2:O2', title: 'media type, application/json by negotiation, entity tags, World.spatials, ETag exposed, the preflight' },
    { id: 'i3:W2', title: 'World.revision and services.events, the context, one node_updated with revision, time and urls, none for a write that changes nothing' },
    { id: 'i4:W2', title: 'the portal\'s destination and node, the user\'s and the view\'s node, World.preview and its URL, portal_activate for a crossing' },
    { id: 'i4:P10', title: 'one portal_activate per crossing, before navigation and before the departure' },
    { id: 'i5:W2', title: 'identity, claims and issues; POST /wow/user (201 and 403); user_joined, user_left; the pilot on the User' },
    { id: 'i5:SE2', title: 'DELETE /wow/user/{id} ends the visit: the User answers 404, one user_left, the join record stays' },
    { id: 'i6:G1', title: 'protected resource metadata (resource = the base URL), 401 Bearer with no error code, 401 invalid_token, no token from a URL' },
];

/**
 * The verdict of one check: N/A (not applicable: the check does not apply to this world, entry.reason says why; never
 * a failure, never a pass, and separate from SKIP); FAIL on any problem; PASS only when nothing was skipped; PARTIAL
 * or SKIP otherwise.
 */
function verdict(entry)
{
    if (entry.notApplicable) return 'N/A';
    if (entry.problems.length) return 'FAIL';
    if (!entry.skipped.length) return 'PASS';
    return entry.ran ? 'PARTIAL' : 'SKIP';
}

/**
 * Run every collected wire check against the world at `base`.
 * opts: validator (wow-spec/validate.js), writes (node writes allowed), labCrossing (drive crossings through the
 * Lab's extension endpoints; needs writes). Returns { base, checks: [{ id, title, verdict, problems, skipped, reason? }], ok };
 * reason is set on an N/A check and says why the check does not apply.
 */
async function runWireSuite(base, opts)
{
    base = trim(base);
    const validator = opts.validator;
    const schemas = validator.doc.components.schemas;
    const writesReason = 'node writes were not requested (give --writes for a world that is yours)';
    const checks = [];
    const one = async (id, fn) => {
        const entry = Object.assign({ problems: [], skipped: [], ran: true }, SUITE.find((s) => s.id === id));
        try { await fn(entry); } catch (error) { entry.problems.push('threw: ' + String((error && error.message) || error)); }
        entry.verdict = verdict(entry);
        delete entry.ran;
        delete entry.notApplicable;
        checks.push(entry);
    };
    const take = (entry, r) => { entry.problems.push(...r.problems); entry.skipped.push(...(r.skipped || [])); };
    const notApplicable = (entry, reason) => { entry.notApplicable = true; entry.reason = reason; };

    const world = (await getWow(base, '/wow/world')).json || {};
    const eventsUrl = base + '/' + ((world.services && world.services.events) || 'events');
    const portalOne = await getWow(base, '/wow/portal/1');
    const portalId = portalOne.status === 200 && portalOne.json ? portalOne.json.id : null;
    const crossingReason = !opts.labCrossing
        ? 'the World API defines no operation that starts a crossing; give --lab-crossing (with --writes) to drive one through a Lab world\'s own crossing intent'
        : !opts.writes ? 'a Lab crossing registers a player (a write): give --writes as well'
            : portalId === null ? 'the world serves no portal 1 to cross' : null;
    const crossing = crossingReason ? null : async () => { await labJoin(base, 'corpus-w2-visitor'); await labExitIntent(base, portalId, 'corpus-w2-visitor'); };

    // Iteration 5 is opt-in: its checks run only when the World states an identity. A world that states none gets
    // N/A for each (never FAIL, never PASS). A World that states an identity runs them, so a malformed identity,
    // claims or issues is still a FAIL.
    const iteration5 = world.identity !== undefined && world.identity !== null;
    const i5Reason = 'the World states no identity: iteration 5 joining is opt-in';
    // Joins: the World says the world takes them when it states its identity and its claims.
    const takesJoins = !!(world.identity && typeof world.identity.base === 'string' && Array.isArray(world.claims));
    const asked = takesJoins ? world.claims.filter((c) => c && typeof c.name === 'string') : [];
    const held = (name) => Object.prototype.hasOwnProperty.call(CORPUS_WALLET.claims, name);
    const unheld = asked.filter((c) => c.required === true && !held(c.name)).map((c) => c.name);
    const joinReason = !takesJoins ? 'the World states no identity and claims, so it takes no joins'
        : unheld.length ? 'the world requires claims this suite does not hold: ' + unheld.join(', ') : null;
    const wallet = joinReason ? null : { claims: Object.fromEntries(asked.filter((c) => held(c.name)).map((c) => [ c.name, CORPUS_WALLET.claims[c.name] ])), pilot: CORPUS_WALLET.pilot };
    const agent = joinReason ? null : await import(pathToFileURL(path.join(REPO_ROOT, 'web', 'wow-handshake.mjs')).href);

    await one('i1:U3', async (e) => take(e, await u3Wire(base, { label: 'world', validator, schemas, writes: !!opts.writes, writesReason, cleanup: true })));
    await one('i2:O2', async (e) => take(e, await o2Wire(base)));
    await one('i3:W2', async (e) => take(e, await eventsWire(base, { eventSchema: schemas.Event, writes: !!opts.writes, writesReason, cleanup: true })));
    await one('i4:W2', async (e) => {
        if (portalId === null) { e.ran = true; e.problems.push('GET /wow/portal/1 answered ' + portalOne.status); return; }
        const r = await placementWire(base, { portalId, schemas, crossing, crossingReason, eventsUrl });
        take(e, r);
        if (r.world && r.world.preview) {
            e.problems.push(...previewAlternativeProblems(schemas, [ [ 'as served', r.world.preview ] ]));
            const Ajv = require('ajv');
            const validPreview = new Ajv({ strict: false, allErrors: true }).compile(((schemas.World || {}).properties || {}).preview || {});
            e.problems.push(...previewProblems(r.world.preview, validPreview, { label: 'the served preview' }));
        }
    });
    await one('i4:P10', async (e) => {
        if (crossingReason) { e.ran = false; e.skipped.push('portal_activate per crossing: ' + crossingReason); return; }
        const r = await portalActivateWire(base, { portalId, visitors: [ 'corpus-p10-first', 'corpus-p10-second' ], eventsUrl });
        e.problems.push(...r.problems);
        e.skipped.push('before navigation: this suite is no client and does not navigate, so the time of navigation is not measured');
    });
    await one('i5:W2', async (e) => {
        if (!iteration5) return notApplicable(e, i5Reason);
        const required = asked.filter((c) => c.required === true).map((c) => c.name);
        const deny = required.length ? [ required[0] ] : null;
        const r = await joinWire(base, {
            eventsUrl, validator, agent, wallet, joinReason, pilot: CORPUS_WALLET.pilot,
            withholds: deny ? [ [], deny ] : [ [] ],
            expectStatuses: deny ? '201,403' : '201',
            alsoSkipped: deny ? [] : [ 'the denied join (403): the world requires no claim, so no deny can be made' ],
        });
        take(e, r);
    });
    await one('i5:SE2', async (e) => {
        if (!iteration5) return notApplicable(e, i5Reason);
        if (joinReason) { e.ran = false; e.skipped.push('a join and its DELETE: ' + joinReason); return; }
        const r = await departWire(base, { agent, wallet, eventsUrl });
        if (r.fatal) e.problems.push(r.fatal);
        take(e, r);
    });

    // Iteration 6 is opt-in: its wire half runs only when the world serves protected resource metadata at the address
    // derived from its base URL. A world that serves none gets N/A (never FAIL, never PASS). The suite holds no client of
    // the world, so the token and the 403 parts are skips (PARTIAL at best), never passes.
    await one('i6:G1', async (e) => {
        const meta = await request('GET', resourceMetadataUrl(base), null);
        if (meta.status !== 200) return notApplicable(e, 'the world serves no protected resource metadata: iteration 6 authorization is opt-in');
        take(e, await authWire(base, {}));
    });

    // N/A and SKIP are not failures; only FAIL is.
    return { base, checks, ok: checks.every((c) => c.verdict !== 'FAIL') };
}

module.exports = {
    WOW, IDENTITY, request, openEventStream, requiredOf, until, sleep, worldDoc, getWow, labJoin, labExitIntent,
    u3Wire, o2Wire, eventsWire, placementWire, previewAlternativeProblems, previewProblems, portalActivateWire,
    joinWire, departWire, authWire, resourceMetadataUrl, runWireSuite, SUITE,
};
