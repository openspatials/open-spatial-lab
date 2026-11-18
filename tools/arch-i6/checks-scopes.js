'use strict';

/*
 * Iteration 6, G1: scopes and audience.
 *
 *   G1a  read, observe, write and enter are each enforced: a token whose holder lacks the one grant gets 403 with
 *        error="insufficient_scope" (a stream: closed, nothing sent), the holder of all four gets through; a write also
 *        still needs the local-only conditions (local-only.js). One planted fault per scope.
 *   G1b  no token: 401 with WWW-Authenticate: Bearer and no error code; an expired token, or a token for another
 *        world, 401 with error="invalid_token" in the WWW-Authenticate header (RFC 6750 §3 and §3.1)
 *   G1c  two worlds on one origin, at /w/b and /w/bb (one prefix starts with the other), behind one authorization
 *        server, refuse each other's tokens (RFC 8707 §3)
 *   G1d  protected resource metadata at {origin}/.well-known/oauth-protected-resource{path prefix}, whose resource
 *        equals the base URL (RFC 9728 §3 and §3.3), names an authorization server whose token endpoint issues a
 *        token that works; the 401 answer carries no resource_metadata
 *   G1e  the iteration 5 join answer names exactly the scopes granted, equal to the grant records the world holds
 *        for that visitor, read from the world itself
 */

const { run } = require('../arch-i1/lib');
const lab = require('./lab');

const ALL = lab.SCOPES;
const lacking = (scope) => 'lacks-' + scope;
/** Every subject G1a needs: one that holds all four grants, and one per scope that holds the other three. */
function g1aGrants() {
  const out = lab.grantsFor('all-four', ALL);
  for (const s of ALL) out.push(...lab.grantsFor(lacking(s), ALL.filter((x) => x !== s)));
  return out;
}

/** The outcome of one scope's request, for the holder of `token`: { ok (got through), status, error }. */
async function attempt(world, scope, token, agent) {
  if (scope === 'read') {
    const r = await world.req('GET', 'wow/world', null, token);
    return { ok: r.status === 200, status: r.status, error: lab.challengeParam(r.headers['www-authenticate'], 'error') };
  }
  if (scope === 'write') {
    const r = await world.addNode(token, 'g1a node');
    return { ok: r.status === 200, status: r.status, error: lab.challengeParam(r.headers['www-authenticate'], 'error') };
  }
  if (scope === 'enter') {
    const entered = await agent.enterWorld(world.base, { wallet: lab.WALLET, token });
    return { ok: entered.status === 201, status: entered.status, error: entered.answer && entered.answer.error };
  }
  const s = await world.stream('events', token);
  try {
    const hello = await lab.settle(s, 'hello', 2500);
    return { ok: !!hello && !s.closedAt, status: hello ? 'hello' : 'closed ' + (s.closeCode || ''), error: hello ? null : (s.closeCode === 1008 ? 'closed 1008' : null) };
  } finally { s.close(); }
}

async function scopeChecks(ports) {
  const agent = await lab.webModule('wow-handshake.mjs');

  // ---- G1a ----------------------------------------------------------------------------------------------
  const policyEdit = (from, to) => ({ edits: { policy: [[from, to]] } });
  await run('G1a', 'read, observe, write and enter are each enforced: the holder of the other three grants is refused (403 insufficient_scope; a stream is closed before anything is sent) and the holder of all four gets through; a write with write still needs the local-only conditions', async (impl) => {
    const failures = [];
    const notes = [];
    const B = await lab.authWorld('b', ports.next(), { base: '/w/b', grants: g1aGrants(), edits: impl.edits });
    try {
      for (const scope of ALL) {
        const full = await attempt(B, scope, await B.token('all-four'), agent);
        const lack = await attempt(B, scope, await B.token(lacking(scope)), agent);
        if (!full.ok) failures.push(scope + ': the holder of all four grants was refused (' + full.status + ')');
        if (lack.ok) failures.push(scope + ': the holder without the ' + scope + ' grant got through (' + lack.status + ')');
        else if (scope !== 'observe' && !(lack.status === 403 && lack.error === 'insufficient_scope')) failures.push(scope + ': the holder without the grant got ' + lack.status + ' error=' + lack.error + ', not 403 insufficient_scope');
        else if (scope === 'observe' && lack.error !== 'closed 1008') failures.push('observe: the stream of the holder without the grant ended as ' + lack.status);
        notes.push(scope + ' ' + full.status + '/' + lack.status);
      }
      // The local-only rule stays: with the write grant, a write on a server started without OSL_PLACEMENT_WRITES=1 is refused.
      const saved = process.env.OSL_PLACEMENT_WRITES;
      delete process.env.OSL_PLACEMENT_WRITES;
      try {
        const r = await B.addNode(await B.token('all-four'), 'g1a local-only');
        if (!(r.status === 403 && r.json && r.json.error === 'placement_local_only')) failures.push('a write with the write grant but without OSL_PLACEMENT_WRITES=1 answered ' + r.status + ' ' + (r.json && r.json.error));
        else notes.push('without the opt-in the write grant alone answers 403 placement_local_only');
      } finally { if (saved !== undefined) process.env.OSL_PLACEMENT_WRITES = saved; }
    } finally { await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'holder of all four / holder without the one: ' + notes.join('; ') };
  }, {}, [
    { name: 'read not enforced (GET answers with no grant)', impl: policyEdit("        return { scope : 'read', resource : 'world' };", '        return null;') },
    { name: 'observe not enforced (the stream asks for read)', impl: policyEdit("const STREAM_NEED = Object.freeze({ scope : 'observe', resource : 'world' });", "const STREAM_NEED = Object.freeze({ scope : 'read', resource : 'world' });") },
    { name: 'write not enforced (a node write asks for read)', impl: policyEdit("    return { scope : 'write', resource : 'world' };", "    return { scope : 'read', resource : 'world' };") },
    { name: 'enter not enforced (a join asks for read)', impl: policyEdit("if (m === 'POST' && ENTER_ROUTES.has(p)) return { scope : 'enter', resource : 'world' };", "if (m === 'POST' && ENTER_ROUTES.has(p)) return { scope : 'read', resource : 'world' };") },
  ]);

  // ---- G1b ----------------------------------------------------------------------------------------------
  const authEdit = (from, to) => ({ edits: { auth: [[from, to]] } });
  await run('G1b', 'no token: 401 with WWW-Authenticate: Bearer and no error code; an expired token and a token for another world: 401 with error="invalid_token" in the WWW-Authenticate header', async (impl) => {
    const failures = [];
    // A and B on two origins behind one authorization server (shared issuer and key), so only the audience tells a token for A from one for B.
    const issuer = 'http://127.0.0.1:1/';
    const grants = lab.grantsFor('reader', ['read']);
    const A = await lab.authWorld('a', ports.next(), { grants, issuer, seed: lab.SHARED_SEED, edits: impl.edits });
    const B = await lab.authWorld('b', ports.next(), { base: '/w/b', grants, issuer, seed: lab.SHARED_SEED, edits: impl.edits });
    const seen = [];
    try {
      const none = await B.req('GET', 'wow/world');
      const h0 = String(none.headers['www-authenticate'] || '');
      if (none.status !== 401 || !/^Bearer\b/.test(h0) || /\berror=/.test(h0)) failures.push('no token: ' + none.status + ' WWW-Authenticate ' + JSON.stringify(h0) + ', not 401 Bearer with no error code');
      seen.push('no token ' + none.status + ' ' + JSON.stringify(h0));
      const expired = await B.req('GET', 'wow/world', null, await B.token('reader', { ttl_s: 0 }));
      const he = expired.headers['www-authenticate'];
      if (expired.status !== 401 || lab.challengeParam(he, 'error') !== 'invalid_token') failures.push('an expired token: ' + expired.status + ' WWW-Authenticate ' + JSON.stringify(he));
      seen.push('expired ' + expired.status + ' error=' + lab.challengeParam(he, 'error'));
      const forA = await A.token('reader');
      const own = await A.req('GET', 'wow/world', null, forA);
      if (own.status !== 200) failures.push('A\'s token at A answered ' + own.status);
      const other = await B.req('GET', 'wow/world', null, forA);
      const ho = other.headers['www-authenticate'];
      if (other.status !== 401 || lab.challengeParam(ho, 'error') !== 'invalid_token') failures.push('a token for A at B: ' + other.status + ' WWW-Authenticate ' + JSON.stringify(ho));
      seen.push('A\'s token at B ' + other.status + ' error=' + lab.challengeParam(ho, 'error'));
    } finally { await A.close(); await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : seen.join('; ') };
  }, {}, [
    { name: 'a 401 for no token that carries error="invalid_token"', impl: authEdit('if (token === \'\') return refuse(req, res, 401, null, need);', 'if (token === \'\') return refuse(req, res, 401, \'invalid_token\', need);') },
    { name: 'expiry not checked', impl: authEdit("        if (!(Number.isFinite(claims.exp) && now() / 1000 < claims.exp)) return { ok : false, reason : 'the token has expired' };\n", '') },
    { name: 'the audience not checked', impl: authEdit("        if (!audienceIsThisWorld(claims.aud)) return { ok : false, reason : 'the token was issued for another world' };\n", '') },
    { name: 'the error code only in the body (not in WWW-Authenticate)', impl: authEdit("        if (error) params.push('error=\"' + error + '\"');\n", '') },
  ]);

  // ---- G1c ----------------------------------------------------------------------------------------------
  await run('G1c', 'two worlds on one origin at /w/b and /w/bb, behind one authorization server (one issuer, one key), refuse each other\'s tokens with 401 invalid_token and each accepts its own', async (impl) => {
    const failures = [];
    const grants = lab.grantsFor('reader', ['read']);
    const pair = await lab.sameOriginWorlds(ports.next(), { edits: impl.edits, b: { grants }, bb: { grants } });
    const seen = [];
    try {
      const tb = await pair.B.token('reader');
      const tbb = await pair.BB.token('reader');
      for (const [label, world, token, want] of [['b\'s token at /w/b', pair.B, tb, 200], ['bb\'s token at /w/bb', pair.BB, tbb, 200], ['b\'s token at /w/bb', pair.BB, tb, 401], ['bb\'s token at /w/b', pair.B, tbb, 401]]) {
        const r = await world.req('GET', 'wow/world', null, token);
        const err = lab.challengeParam(r.headers['www-authenticate'], 'error');
        if (r.status !== want || (want === 401 && err !== 'invalid_token')) failures.push(label + ': ' + r.status + ' error=' + err + ', not ' + want);
        seen.push(label + ' ' + r.status);
      }
    } finally { await pair.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : seen.join('; ') };
  }, {}, [
    { name: 'the audience compared as a prefix', impl: authEdit('        return aud === RESOURCE;', "        return String(RESOURCE).startsWith(String(aud).replace(/\\/+$/, ''));") },
  ]);

  // ---- G1d ----------------------------------------------------------------------------------------------
  await run('G1d', 'protected resource metadata at {origin}/.well-known/oauth-protected-resource{path prefix} for /w/b and /w/bb on one origin (each with its own authorization server), each resource equal to its base URL, naming an authorization server whose token endpoint issues a working token; nothing at the base-relative address; the 401 carries no resource_metadata', async (impl) => {
    const failures = [];
    const seen = [];
    const clients = [{ client_id: 'reader', client_secret: 'reader-secret-not-real' }];
    const grants = lab.grantsFor('reader', ['read']);
    const pair = await lab.sameOriginWorlds(ports.next(), { separate: true, edits: impl.edits, b: { grants, clients }, bb: { grants, clients } });
    try {
      for (const world of [pair.B, pair.BB]) {
        const at = '/.well-known/oauth-protected-resource' + world.prefix;
        const r = await world.raw('GET', at);
        if (r.status !== 200 || !r.json) { failures.push(at + ' answered ' + r.status); continue; }
        if (r.json.resource !== world.base) failures.push(at + ': resource ' + JSON.stringify(r.json.resource) + ', not the base URL ' + world.base);
        if (!Array.isArray(r.json.authorization_servers) || !r.json.authorization_servers.length) failures.push(at + ': no authorization_servers');
        const scopes = r.json.scopes_supported || [];
        if (!lab.SCOPES.every((s) => scopes.includes(s))) failures.push(at + ': scopes_supported ' + JSON.stringify(scopes));
        seen.push(at + ' resource ' + r.json.resource);
        const inside = await world.raw('GET', world.prefix + '/.well-known/oauth-protected-resource');
        if (inside.status === 200 && inside.json && inside.json.resource) failures.push('metadata is also served below the base, at ' + world.prefix + '/.well-known/oauth-protected-resource');
        // The client follows the metadata: authorization server metadata, its token endpoint, a token that works here.
        const as = new URL(r.json.authorization_servers[0] || 'http://invalid/');
        const asMeta = await world.raw('GET', '/.well-known/oauth-authorization-server' + as.pathname.replace(/\/+$/, ''));
        const endpoint = asMeta.json && asMeta.json.token_endpoint;
        if (asMeta.status !== 200 || !endpoint) { failures.push('the authorization server metadata answered ' + asMeta.status); continue; }
        const form = 'grant_type=client_credentials&scope=read&resource=' + encodeURIComponent(world.base);
        const basic = 'Basic ' + Buffer.from('reader:reader-secret-not-real').toString('base64');
        const tok = await world.raw('POST', new URL(endpoint).pathname, form, { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic });
        if (tok.status !== 200 || !tok.json || tok.json.token_type !== 'Bearer') { failures.push('the token endpoint answered ' + tok.status + ' ' + tok.body.slice(0, 100)); continue; }
        const use = await world.req('GET', 'wow/world', null, tok.json.access_token);
        if (use.status !== 200) failures.push('the token from ' + endpoint + ' answered ' + use.status + ' at ' + world.base);
        const wrong = await world.raw('POST', new URL(endpoint).pathname, 'grant_type=client_credentials&resource=' + encodeURIComponent(pair.origin + '/'), { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basic });
        if (wrong.status !== 400 || !wrong.json || wrong.json.error !== 'invalid_target') failures.push('a token asked for another resource answered ' + wrong.status + ' ' + (wrong.json && wrong.json.error));
        const none = await world.req('GET', 'wow/world');
        if (/resource_metadata/.test(String(none.headers['www-authenticate'] || ''))) failures.push('the 401 carries resource_metadata: ' + none.headers['www-authenticate']);
      }
    } finally { await pair.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : seen.join('; ') + '; each names an authorization server whose token endpoint issued a token that works there, and refuses another resource (invalid_target); the 401s carry no resource_metadata' };
  }, {}, [
    { name: 'metadata whose resource drops the base URL\'s final slash', impl: authEdit('            resource : RESOURCE,\n            authorization_servers', "            resource : RESOURCE.replace(/\\/$/, ''),\n            authorization_servers") },
    { name: 'a 401 that carries resource_metadata', impl: authEdit("const params = [ 'realm=\"' + quote(RESOURCE) + '\"' ];", "const params = [ 'realm=\"' + quote(RESOURCE) + '\"', 'resource_metadata=\"' + RESOURCE + '.well-known/oauth-protected-resource\"' ];") },
    { name: 'metadata at the base-relative address ({base}.well-known/...)', impl: authEdit("const PRM_PATH = '/.well-known/oauth-protected-resource' + suffixOf(RESOURCE);", "const PRM_PATH = suffixOf(RESOURCE) + '/.well-known/oauth-protected-resource';") },
  ]);

  // ---- G1e ----------------------------------------------------------------------------------------------
  await run('G1e', 'the join answer (POST /wow/user) names exactly the scopes granted: they equal the grant records the world holds for that visitor, read from the world, before and after a grant is withdrawn', async (impl) => {
    const failures = [];
    const seen = [];
    const B = await lab.authWorld('b', ports.next(), { base: '/w/b', grants: lab.grantsFor('visitor', ['read', 'observe', 'enter']), edits: impl.edits });
    try {
      const recordsSay = () => {
        const held = new Set(B.auth.grants.records().filter((r) => r.subject === 'visitor' && !r.withdrawn_at).map((r) => r.scope));
        return lab.SCOPES.filter((s) => held.has(s));
      };
      for (const round of ['all held', 'observe withdrawn']) {
        if (round === 'observe withdrawn') {
          const rec = B.auth.grants.records().find((r) => r.subject === 'visitor' && r.scope === 'observe');
          B.auth.grants.withdraw(rec.id);
        }
        const entered = await agent.enterWorld(B.base, { wallet: lab.WALLET, token: await B.token('visitor', { scope: 'read enter' }) });
        const answer = entered.answer || {};
        const named = typeof answer.scope === 'string' ? answer.scope.split(' ').filter(Boolean) : null;
        const want = recordsSay();
        if (entered.status !== 201) failures.push(round + ': the join answered ' + entered.status + ' ' + JSON.stringify(answer).slice(0, 120));
        else if (!named) failures.push(round + ': the join answer names no scope: ' + JSON.stringify(answer).slice(0, 160));
        else if (JSON.stringify([...named].sort()) !== JSON.stringify([...want].sort()) || new Set(named).size !== named.length) failures.push(round + ': the answer names ' + JSON.stringify(named) + ', the grant records hold ' + JSON.stringify(want));
        seen.push(round + ': answer "' + (answer.scope || '') + '" = records ' + want.join(' '));
      }
    } finally { await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : seen.join('; ') + ' (the token itself carried only read and enter)' };
  }, {}, [
    { name: 'an answer that names a scope with no grant record (write)', impl: authEdit("        return grantedScopes(subject).join(' ');", "        return grantedScopes(subject).concat(grantedScopes(subject).includes('write') ? [] : [ 'write' ]).join(' ');") },
    { name: 'an answer that omits a granted scope (observe)', impl: authEdit("        return grantedScopes(subject).join(' ');", "        return grantedScopes(subject).filter((s) => s !== 'observe').join(' ');") },
  ]);
}

module.exports = { scopeChecks };
