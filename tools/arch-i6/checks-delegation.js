'use strict';

/*
 * Iteration 6, part b: delegation (G4), hosts (G5) and per-resource grants (G6).
 *
 *   G4a  agent G gets an exchanged token at world B (RFC 8693: V's token as the subject, G's own token as the actor)
 *        only because V allows it through a grant record at B; with it, G writes a node "as agent for V"; B logs
 *        both identities; G's own token cannot make that write, and an agent with no grant record from V is
 *        refused the exchange (400 invalid_request)
 *   G4b  a chain: helper H acts for G, which acts for V. The token carries the whole `act` chain (H, then G); B logs
 *        the whole chain, and decides on the current actor (H) and its grant record: once H's record is withdrawn,
 *        H's next write is refused (403), though V and G still hold theirs
 *   G5   worlds A and B run separate authorization servers. Host A cannot write into B as itself; it can with a token
 *        B's authorization server issued by exchange (the viewer's token from A's issuer, which B trusts, as the
 *        subject; A, named by its base URL, as the actor). A subject token from an issuer B does not trust, and the
 *        same exchange after B stops trusting A's issuer, are refused with 400 invalid_request (RFC 8693 §2.2.2)
 *   G6   a token granted write on node n is refused with 403 on another node of the same world; a write grant names
 *        one node (or the whole world), observe and enter grants cover a world and cannot name a node
 */

const { run } = require('../arch-i1/lib');
const lab = require('./lab');

const authEdit = (from, to) => ({ edits: { auth: [[from, to]] } });
const policyEdit = (from, to) => ({ edits: { policy: [[from, to]] } });
const errOf = (r) => lab.challengeParam(r.headers['www-authenticate'], 'error');
const nodeRef = (id) => 'wow/spatial/1/node/' + id;
const P = lab.i5.placed;

/** The root node of world W, read with an operator token. */
async function rootOf(W) {
  return W.rootOf(await W.token('operator'));
}

/** Create one child node under `parent`, with `token`: { status, id, error }. */
async function addUnder(W, parent, token, label) {
  const r = await W.req('POST', nodeRef(parent), [{ label, localTransform: P(0, 0, 0) }], token);
  return { status: r.status, id: r.status === 200 && Array.isArray(r.json) && r.json[0] ? r.json[0].id : null, error: errOf(r), label: r.status === 200 && r.json && r.json[0] ? r.json[0].label : null };
}

/** The decision log entries of B for one path and method (the newest last). */
function logged(W, method, p) {
  const want = W.prefix + '/' + p;
  return W.auth.decisions().filter((d) => d.method === method && (d.path === '/' + p || d.path === want));
}

async function delegationChecks(ports) {
  // ---- G4a ----------------------------------------------------------------------------------------------
  await run('G4a', 'agent G gets an exchanged token for visitor V only through V\'s grant record at B, writes "as agent for V" with it, and B logs both identities; G\'s own token cannot write, and an agent with no grant record from V is refused the exchange (400 invalid_request)', async (impl) => {
    const failures = [];
    const seen = [];
    const grants = [
      ...lab.grantsFor('operator', ['read', 'write']),
      ...lab.grantsFor('visitor-v', ['read']),
      ...lab.grantsFor('agent-g', ['read']),
      ...lab.grantsFor('agent-g2', ['read']),
    ];
    const B = await lab.authWorld('b', ports.next(), { base: '/w/b', grants, edits: impl.edits });
    try {
      const root = await rootOf(B);
      B.auth.grants.add({ subject: 'agent-g', scope: 'write', resource: nodeRef(root), acting_for: 'visitor-v' });
      const tV = await B.token('visitor-v');
      const tG = await B.token('agent-g');
      const ex = await B.exchange(tV, tG);
      const token = ex.json && ex.json.access_token;
      if (ex.status !== 200 || !token) { failures.push('the exchange answered ' + ex.status + ' ' + ex.body.slice(0, 160)); return { ok: false, detail: failures.join('; ') }; }
      const c = lab.claimsOf(token);
      if (!(c && c.sub === 'visitor-v' && JSON.stringify(lab.actorsOf(c)) === JSON.stringify(['agent-g']))) failures.push('the exchanged token names sub ' + (c && c.sub) + ' and actors ' + JSON.stringify(lab.actorsOf(c)) + ', not visitor-v acted for by agent-g');
      if (ex.json.issued_token_type !== lab.ACCESS_TOKEN_TYPE) failures.push('issued_token_type ' + ex.json.issued_token_type);
      seen.push('exchange 200: sub ' + c.sub + ', act ' + JSON.stringify(c.act) + ', scope ' + ex.json.scope);
      const own = await addUnder(B, root, tG, 'as itself');
      if (!(own.status === 403 && own.error === 'insufficient_scope')) failures.push('G\'s own token wrote: ' + own.status + ' ' + own.error);
      const as = await addUnder(B, root, token, 'as agent for V');
      if (as.status !== 200 || as.label !== 'as agent for V') failures.push('the write as agent for V answered ' + as.status + ' ' + as.error);
      seen.push('G as itself ' + own.status + ' ' + own.error + '; G as agent for V ' + as.status + ' (node ' + as.id + ' "' + as.label + '")');
      const entry = logged(B, 'POST', nodeRef(root)).filter((d) => d.decision === 'allowed').pop();
      if (!entry || entry.subject !== 'visitor-v' || JSON.stringify(entry.actors) !== JSON.stringify(['agent-g'])) failures.push('B\'s log of that write: ' + JSON.stringify(entry || null));
      else seen.push('B logged subject ' + entry.subject + ' and actor ' + entry.actors.join(', '));
      const tG2 = await B.token('agent-g2');
      const no = await B.exchange(tV, tG2);
      if (!(no.status === 400 && no.json && no.json.error === 'invalid_request')) failures.push('an agent with no grant record from V: exchange ' + no.status + ' ' + no.body.slice(0, 120));
      seen.push('an agent with no grant record from V: exchange ' + no.status + ' ' + (no.json && no.json.error));
    } finally { await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : seen.join('; ') };
  }, {}, [
    { name: 'an exchange that reads the actor\'s own grants, not V\'s grant record', impl: authEdit('const allowed = grantedScopesFor(actor, principal);', 'const allowed = grantedScopes(actor);') },
    { name: 'B logs only the subject, not the actor', impl: authEdit('actors : verified.actors.map((a) => a.sub),', 'actors : [],') },
  ]);

  // ---- G4b ----------------------------------------------------------------------------------------------
  await run('G4b', 'a chain: helper H acts for agent G, which acts for visitor V; the token carries act H then G; B logs the whole chain and decides on the current actor H and its grant record (H\'s next write after its record is withdrawn answers 403, though V and G still hold theirs)', async (impl) => {
    const failures = [];
    const seen = [];
    const grants = [
      ...lab.grantsFor('operator', ['read', 'write']),
      ...lab.grantsFor('visitor-v', ['read', 'write']),
      ...lab.grantsFor('agent-g', ['read']),
      ...lab.grantsFor('helper-h', ['read']),
    ];
    const B = await lab.authWorld('b', ports.next(), { base: '/w/b', grants, edits: impl.edits });
    try {
      const root = await rootOf(B);
      B.auth.grants.add({ subject: 'agent-g', scope: 'write', resource: nodeRef(root), acting_for: 'visitor-v' });
      const hRecord = B.auth.grants.add({ subject: 'helper-h', scope: 'write', resource: nodeRef(root), acting_for: 'agent-g' });
      const ex1 = await B.exchange(await B.token('visitor-v'), await B.token('agent-g'));
      const tGV = ex1.json && ex1.json.access_token;
      const ex2 = tGV ? await B.exchange(tGV, await B.token('helper-h')) : { status: 0, body: '', json: null };
      const tHGV = ex2.json && ex2.json.access_token;
      if (!tHGV) { failures.push('the exchanges answered ' + ex1.status + ' and ' + ex2.status + ' ' + String(ex2.body).slice(0, 160)); return { ok: false, detail: failures.join('; ') }; }
      const c = lab.claimsOf(tHGV);
      const chain = lab.actorsOf(c);
      if (c.sub !== 'visitor-v' || JSON.stringify(chain) !== JSON.stringify(['helper-h', 'agent-g'])) failures.push('the chained token names sub ' + c.sub + ' and actors ' + JSON.stringify(chain) + ', not visitor-v with helper-h then agent-g');
      seen.push('chained token: sub ' + c.sub + ', act ' + JSON.stringify(c.act));
      const w = await addUnder(B, root, tHGV, 'as helper for G for V');
      if (w.status !== 200) failures.push('H\'s write for G for V answered ' + w.status + ' ' + w.error);
      const entry = logged(B, 'POST', nodeRef(root)).filter((d) => d.decision === 'allowed').pop();
      if (!entry || entry.subject !== 'visitor-v' || JSON.stringify(entry.actors) !== JSON.stringify(['helper-h', 'agent-g'])) failures.push('B\'s log of H\'s write: ' + JSON.stringify(entry || null) + ', not the whole chain');
      else seen.push('write ' + w.status + ', logged subject ' + entry.subject + ' with actors ' + entry.actors.join(' then '));
      B.auth.grants.withdraw(hRecord.id);
      const after = await addUnder(B, root, tHGV, 'after H\'s record was withdrawn');
      if (!(after.status === 403 && after.error === 'insufficient_scope')) failures.push('after H\'s grant record was withdrawn H\'s write answered ' + after.status + ' ' + after.error + ' (V and G still hold theirs)');
      const gStill = await addUnder(B, root, tGV, 'G for V, still granted');
      if (gStill.status !== 200) failures.push('G\'s own exchanged token, its record still held, answered ' + gStill.status);
      const refused = logged(B, 'POST', nodeRef(root)).filter((d) => d.decision === 'refused').pop();
      if (!refused || JSON.stringify(refused.actors) !== JSON.stringify(['helper-h', 'agent-g'])) failures.push('B\'s log of the refused write: ' + JSON.stringify(refused || null));
      seen.push('H\'s record withdrawn: H\'s next write ' + after.status + ' ' + after.error + ' (logged ' + (refused ? refused.decision + ' with actors ' + refused.actors.join(' then ') : 'nothing') + '); G for V still ' + gStill.status);
    } finally { await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : seen.join('; ') };
  }, {}, [
    { name: 'B decides on the subject instead of the current actor', impl: authEdit('grants.holdsFor(actor.sub, principal, need.scope, need.resource)', 'grants.holds(verified.claims.sub, need.scope, need.resource)') },
    { name: 'B logs only the last actor', impl: authEdit('actors : verified.actors.map((a) => a.sub),', 'actors : verified.actors.slice(0, 1).map((a) => a.sub),') },
  ]);

  // ---- G5 -----------------------------------------------------------------------------------------------
  await run('G5', 'worlds A and B run separate authorization servers; host A cannot write into B as itself, and can with a token B issued by exchange (the viewer\'s token from A\'s issuer, which B trusts, as the subject; A by its base URL as the actor); a subject token from an issuer B does not trust, and the exchange after B stops trusting A\'s issuer, answer 400 invalid_request', async (impl) => {
    const failures = [];
    const seen = [];
    const A = await lab.authWorld('a', ports.next(), { grants: lab.grantsFor('viewer-v', ['read', 'write']), edits: impl.edits });
    const C = await lab.authWorld('a', ports.next(), { grants: lab.grantsFor('viewer-v', ['read', 'write']), edits: impl.edits });
    let B = null;
    try {
      const hostClient = { client_id: A.base, client_secret: 'host-a-secret-not-real' };
      B = await lab.authWorld('b', ports.next(), {
        base: '/w/b',
        clients: [hostClient],
        grants: [...lab.grantsFor('operator', ['read', 'write']), ...lab.grantsFor(A.base, ['read'])],
        trusted: [{ issuer: A.auth.issuer, public_key: await A.auth.publicKey() }],
        edits: impl.edits,
      });
      if (A.auth.issuer === B.auth.issuer || (await A.auth.publicKey()) === (await B.auth.publicKey())) failures.push('A and B share an authorization server (issuer or key)');
      const root = await rootOf(B);
      B.auth.grants.add({ subject: A.base, scope: 'write', resource: nodeRef(root), acting_for: 'viewer-v', subject_issuer: A.auth.issuer });
      const own = await B.tokenRequest({ grant_type: 'client_credentials', resource: B.base }, hostClient);
      const tA = own.json && own.json.access_token;
      if (!tA) { failures.push('A\'s client credentials at B answered ' + own.status + ' ' + own.body.slice(0, 120)); return { ok: false, detail: failures.join('; ') }; }
      const asItself = await addUnder(B, root, tA, 'host A as itself');
      if (!(asItself.status === 403 && asItself.error === 'insufficient_scope')) failures.push('host A wrote into B as itself: ' + asItself.status + ' ' + asItself.error);
      const tV = await A.token('viewer-v');
      const ex = await B.exchange(tV, tA);
      const token = ex.json && ex.json.access_token;
      if (ex.status !== 200 || !token) failures.push('the exchange at B (viewer token from A\'s issuer, A as actor) answered ' + ex.status + ' ' + ex.body.slice(0, 160));
      else {
        const c = lab.claimsOf(token);
        if (c.iss !== B.auth.issuer || c.aud !== B.base || c.sub !== 'viewer-v' || JSON.stringify(lab.actorsOf(c)) !== JSON.stringify([A.base])) failures.push('the exchanged token: ' + JSON.stringify({ iss: c.iss, aud: c.aud, sub: c.sub, act: c.act }));
        const w = await addUnder(B, root, token, 'host A for the viewer');
        if (w.status !== 200) failures.push('host A\'s write with the exchanged token answered ' + w.status + ' ' + w.error);
        seen.push('A as itself ' + asItself.status + ' ' + asItself.error + '; exchange 200 (iss ' + c.iss + ', sub ' + c.sub + ' of ' + c.sub_iss + ', act ' + JSON.stringify(c.act) + '); write ' + w.status);
      }
      const untrusted = await B.exchange(await C.token('viewer-v'), tA);
      if (!(untrusted.status === 400 && untrusted.json && untrusted.json.error === 'invalid_request')) failures.push('a subject token from an issuer B never trusted: ' + untrusted.status + ' ' + untrusted.body.slice(0, 120));
      B.auth.trust.withdraw(A.auth.issuer);
      const after = await B.exchange(await A.token('viewer-v'), tA);
      if (!(after.status === 400 && after.json && after.json.error === 'invalid_request')) failures.push('after B stopped trusting A\'s issuer the exchange answered ' + after.status + ' ' + after.body.slice(0, 120));
      seen.push('a never-trusted issuer: ' + untrusted.status + ' ' + (untrusted.json && untrusted.json.error) + '; after B stopped trusting A\'s issuer: ' + after.status + ' ' + (after.json && after.json.error));
    } finally { await A.close(); await C.close(); if (B) await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : seen.join('; ') };
  }, {}, [
    { name: 'B accepts a subject token from an issuer it no longer trusts', impl: authEdit('return entries.find((e) => e.issuer === issuer && !e.withdrawn_at) || null;', 'return entries.find((e) => e.issuer === issuer) || null;') },
    { name: 'B accepts A\'s own token for a write to B (a grant record for acting counted as A\'s own, in its token and its check)', impl: { edits: { auth: [
      ['r.subject === subject && !r.acting_for && r.scope === scope', 'r.subject === subject && r.scope === scope'],
      ['records.filter((r) => r.subject === subject && !r.acting_for && isActive(r, at))', 'records.filter((r) => r.subject === subject && isActive(r, at))'],
    ] } } },
  ]);

  // ---- G6 -----------------------------------------------------------------------------------------------
  await run('G6', 'a token granted write on node n is refused with 403 insufficient_scope on another node of the same world; write grants name one node; observe and enter grants cover a world and cannot name a node', async (impl) => {
    const failures = [];
    const seen = [];
    const B = await lab.authWorld('b', ports.next(), { base: '/w/b', grants: [...lab.grantsFor('operator', ['read', 'write']), ...lab.grantsFor('writer', ['read', 'observe'])], edits: impl.edits });
    try {
      const op = await B.token('operator');
      const root = await B.rootOf(op);
      const n = await addUnder(B, root, op, 'node n');
      const m = await addUnder(B, root, op, 'node m');
      if (n.status !== 200 || m.status !== 200) { failures.push('the operator could not create two nodes: ' + n.status + ', ' + m.status); return { ok: false, detail: failures.join('; ') }; }
      B.auth.grants.add({ subject: 'writer', scope: 'write', resource: nodeRef(n.id) });
      const t = await B.token('writer');
      const onN = await addUnder(B, n.id, t, 'child of n');
      const onM = await addUnder(B, m.id, t, 'child of m');
      const onRoot = await addUnder(B, root, t, 'child of root');
      const putM = await B.req('PUT', nodeRef(m.id), { label: 'm renamed', localTransform: P(1, 0, 0) }, t);
      const delM = await B.req('DELETE', nodeRef(m.id), null, t);
      if (onN.status !== 200) failures.push('write on n with the grant on n answered ' + onN.status + ' ' + onN.error);
      for (const [label, r] of [['POST under m', onM], ['POST under the root', onRoot], ['PUT m', { status: putM.status, error: errOf(putM) }], ['DELETE m', { status: delM.status, error: errOf(delM) }]]) {
        if (!(r.status === 403 && r.error === 'insufficient_scope')) failures.push(label + ' with a write grant on n answered ' + r.status + ' ' + r.error);
      }
      seen.push('write grant on node ' + n.id + ': POST under n ' + onN.status + '; POST under m ' + onM.status + ' ' + onM.error + ', under the root ' + onRoot.status + ', PUT m ' + putM.status + ', DELETE m ' + delM.status);
      const refusedGrants = [];
      for (const scope of ['observe', 'enter']) {
        try { B.auth.grants.add({ subject: 'writer', scope, resource: nodeRef(n.id) }); failures.push('the world took an ' + scope + ' grant that names a node'); } catch (e) { refusedGrants.push(scope); }
      }
      const s = await B.stream('events', t);
      const hello = await lab.settle(s, 'hello', 2500);
      s.close();
      if (!hello) failures.push('the observe grant (the world) did not open the event stream');
      seen.push('observe and enter grants naming a node refused (' + refusedGrants.join(', ') + '); the observe grant on the world opens the stream');
    } finally { await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : seen.join('; ') };
  }, {}, [
    { name: 'a node write grant that covers the world', impl: policyEdit("    return granted === 'world' && isNode(needed);", "    return (granted === 'world' || isNode(granted)) && isNode(needed);") },
  ]);
}

module.exports = { delegationChecks };
