'use strict';

/*
 * Iteration 7, the API finding: what a host and its viewers need of an included live world is already in the
 * kernel of iterations 2 to 6.
 *
 *   API  in one run of the scene (three viewers of A follow B, B's visitor joins, V1 and V2 press the button, V3's
 *        press is refused), every request B receives through A (a token whose current actor is host A) is a GET of
 *        the World, a Spatial or a Node, a PUT of a Node, or B's event stream: paths of the Web of Worlds contract
 *        (wow-spec/generated/schema.json) and `services.events`. Host A asks B's authorization server for tokens
 *        (client credentials and the token exchange of iteration 6). The client sends no request header beyond
 *        Accept, Authorization, If-Match, If-None-Match and Content-Type. There is no overlay for iteration 7.
 *        Every answer B gave was checked against the contract as it was served (a [wow-validate] line fails the run).
 */

const fs = require('fs');
const path = require('path');
const { run, ROOT } = require('../arch-i1/lib');
const lab = require('./lab');

const CLIENT_HEADERS = new Set(['accept', 'authorization', 'if-match', 'if-none-match', 'content-type']);
/** A request path of B (below its base) as a contract path template, or null. */
function templateOf(p, templates) {
  const clean = p.split('?')[0];
  if (clean === '/events' || clean === '/wow/events') return 'services.events';
  for (const t of templates) {
    const re = new RegExp('^' + t.replace(/\{[^}]+\}/g, '[^/]+') + '$');
    if (re.test(clean)) return t;
  }
  return null;
}

async function apiChecks(ports) {
  await run('API', 'every request B receives through host A is a contract path (World, Spatial, Node GET, Node PUT) or B\'s event stream, with no request header beyond Accept, Authorization, If-Match, If-None-Match and Content-Type; host A uses only B\'s token endpoint; there is no iteration 7 overlay', async (impl) => {
    const s = await lab.scene(impl, ports);
    const headersSeen = new Set();
    const onRequest = (req) => {
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const c = bearer ? lab.i6.claimsOf(bearer) : null;
      if (c && lab.i6.actorsOf(c)[0] === s.A.base) for (const h of Object.keys(req.headers)) headersSeen.add(h.toLowerCase());
    };
    s.B.built.server.on('request', onRequest);
    try {
      const v1 = await lab.viewer(s, 'viewer-v1');
      const v2 = await lab.viewer(s, 'viewer-v2');
      const v3 = await lab.viewer(s, 'viewer-v3');
      await lab.visitorOfB(s);
      const press = (node) => ({ properties: Object.assign({}, node.properties, { presses: (node.properties.presses || 0) + 1 }) });
      await Promise.all([v1.live.write(s.urls.button, press), v2.live.write(s.urls.button, press)]);
      await v3.live.write(s.urls.button, press);
      await lab.settle([v1, v2, v3], 600);
      const failures = [];
      const contract = JSON.parse(fs.readFileSync(path.join(ROOT, 'wow-spec', 'generated', 'schema.json'), 'utf8'));
      const templates = Object.keys(contract.paths || {});
      const viaA = (r) => { const t = r.authorization && r.authorization.replace(/^Bearer\s+/i, ''); const c = t ? lab.i6.claimsOf(t) : null; return !!(c && lab.i6.actorsOf(c)[0] === s.A.base); };
      const byKind = new Map();
      const streams = s.B.log.filter((r) => r.method === 'STREAM');
      for (const r of s.B.log.filter(viaA)) {
        const p = r.url.slice(s.B.prefix.length);
        const t = templateOf(p, templates);
        const ok = t && ((r.method === 'GET' && t !== 'services.events') || (r.method === 'PUT' && t === '/wow/spatial/{spatialID}/node/{nodeId}'));
        const key = r.method + ' ' + (t || p);
        byKind.set(key, (byKind.get(key) || 0) + 1);
        if (!ok) failures.push('B received ' + r.method + ' ' + p + ' through A');
      }
      for (const r of streams) if (!templateOf(r.url.slice(s.B.prefix.length), templates)) failures.push('a stream to ' + r.url);
      const tokenCalls = s.B.log.filter((r) => r.method === 'POST' && r.url === s.B.prefix + '/oauth/token').length;
      const other = s.B.log.filter((r) => !viaA(r) && r.method !== 'STREAM' && !(r.method === 'POST' && r.url === s.B.prefix + '/oauth/token') && !/^Bearer /.test(r.authorization || ''));
      if (other.length) failures.push('B received ' + other.length + ' request(s) with no token: ' + other.slice(0, 3).map((r) => r.method + ' ' + r.url).join(', '));
      const extra = [...headersSeen].filter((h) => !CLIENT_HEADERS.has(h) && !['host', 'connection', 'content-length', 'user-agent', 'accept-encoding', 'accept-language', 'sec-fetch-mode', 'cache-control', 'pragma'].includes(h));
      if (extra.length) failures.push('the client sent the request header(s) ' + extra.join(', '));
      const overlay = path.join(ROOT, 'wow-spec', 'overlays', 'iteration-7');
      if (fs.existsSync(overlay)) failures.push('there is an iteration 7 overlay: ' + overlay);
      const detail = 'through host A, B received ' + [...byKind.entries()].map(([k, n]) => k + ' x' + n).join(', ') + '; ' + streams.length + ' event stream(s); ' + tokenCalls + ' token request(s) (client credentials and exchange); request headers ' + [...headersSeen].filter((h) => CLIENT_HEADERS.has(h)).sort().join(', ') + '; no iteration 7 overlay';
      return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 5).join('; ') : detail };
    } finally { s.B.built.server.off('request', onRequest); await s.close(); }
  }, {}, [
    { name: 'a client that asks B for its people on the Lab\'s presence route', impl: { clientEdits: [['    live.people[base] = live.people[base] || [];\n', '    live.people[base] = live.people[base] || [];\n    if (!live.asked) { live.asked = true; reader.get(new URL("fabric/presence", base).href); }\n']] } },
  ]);
}

module.exports = { apiChecks };
