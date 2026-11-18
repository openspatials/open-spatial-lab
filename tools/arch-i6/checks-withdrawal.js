'use strict';

/*
 * Iteration 6, G3: withdrawal.
 *
 *   G3a  after a grant is withdrawn, the holder's next request is refused with 403 insufficient_scope (its token is
 *        still valid: the world reads its own grant records at each request), and when the observe grant is
 *        withdrawn, the holder's open event stream is closed within 5 seconds
 *   G3b  an expired token is refused with 401 invalid_token, on a request and as a stream's first message
 */

const { run } = require('../arch-i1/lib');
const lab = require('./lab');

async function withdrawalChecks(ports) {
  const authEdit = (from, to) => ({ edits: { auth: [[from, to]] } });
  const serverEdit = (from, to) => ({ edits: { server: [[from, to]] } });

  // ---- G3a ----------------------------------------------------------------------------------------------
  await run('G3a', 'after a grant is withdrawn the holder\'s next request answers 403 insufficient_scope, though its token has not expired; after the observe grant is withdrawn its open event stream closes within 5 seconds', async (impl) => {
    const failures = [];
    let detail = '';
    const B = await lab.authWorld('b', ports.next(), { base: '/w/b', grants: lab.grantsFor('holder', ['read', 'observe']), edits: impl.edits });
    try {
      const t = await B.token('holder');
      const before = await B.req('GET', 'wow/world', null, t);
      const s = await B.stream('events', t);
      const hello = await lab.settle(s, 'hello', 3000);
      if (before.status !== 200 || !hello) failures.push('before the withdrawal: GET ' + before.status + ', hello ' + !!hello);
      const record = (scope) => B.auth.grants.records().find((r) => r.subject === 'holder' && r.scope === scope);
      B.auth.grants.withdraw(record('read').id);
      const after = await B.req('GET', 'wow/world', null, t);
      const err = lab.challengeParam(after.headers['www-authenticate'], 'error');
      if (!(after.status === 403 && err === 'insufficient_scope')) failures.push('the next request after the read grant was withdrawn answered ' + after.status + ' error=' + err);
      const at = Date.now();
      B.auth.grants.withdraw(record('observe').id);
      const end = at + 5500;
      while (!s.closedAt && Date.now() < end) await lab.sleep(25);
      const took = s.closedAt ? s.closedAt - at : null;
      if (took === null || took > 5000) failures.push('the event stream ' + (took === null ? 'was still open 5.5 s after the observe grant was withdrawn' : 'closed ' + took + ' ms after the withdrawal'));
      s.close();
      detail = 'before: GET 200 and a hello; read withdrawn: the next GET ' + after.status + ' ' + err + '; observe withdrawn: the stream closed (' + s.closeCode + ') ' + took + ' ms later';
    } finally { await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : detail };
  }, {}, [
    { name: 'a world that trusts the token\'s scopes and does not read its grant records', impl: authEdit('        return verified.scopes.includes(need.scope) && grants.holds(verified.claims.sub, need.scope, need.resource);', '        return verified.scopes.includes(need.scope);') },
    { name: 'a world that does not close an open stream on withdrawal', impl: serverEdit('stopWatch = auth.watchStream(granted.verified, (why) => { unsubscribe(); closeStream(1008, why); });', 'stopWatch = () => {};') },
  ]);

  // ---- G3b ----------------------------------------------------------------------------------------------
  await run('G3b', 'an expired token is refused with 401 invalid_token on a request, and a stream whose first message carries it is closed (1008) with nothing sent', async (impl) => {
    const failures = [];
    let detail = '';
    const B = await lab.authWorld('b', ports.next(), { base: '/w/b', grants: lab.grantsFor('holder', ['read', 'observe']), edits: impl.edits });
    try {
      const expired = await B.token('holder', { ttl_s: 0 });
      const live = await B.token('holder', { ttl_s: 60 });
      const r = await B.req('GET', 'wow/world', null, expired);
      const err = lab.challengeParam(r.headers['www-authenticate'], 'error');
      if (!(r.status === 401 && err === 'invalid_token')) failures.push('an expired token answered ' + r.status + ' error=' + err);
      const ok = await B.req('GET', 'wow/world', null, live);
      if (ok.status !== 200) failures.push('a token within its life answered ' + ok.status);
      const s = await B.stream('events', expired);
      await lab.settle(s, 'never', 2500);
      if (!s.closedAt || s.closeCode !== 1008 || s.messages.length) failures.push('a stream with an expired token: ' + (s.closedAt ? 'closed ' + s.closeCode : 'open') + ' after ' + s.messages.length + ' message(s)');
      s.close();
      detail = 'expired: GET ' + r.status + ' ' + err + ', stream closed ' + s.closeCode + ' with nothing sent; within its life: GET ' + ok.status;
    } finally { await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : detail };
  }, {}, [
    { name: 'expiry not checked', impl: authEdit("        if (!(Number.isFinite(claims.exp) && now() / 1000 < claims.exp)) return { ok : false, reason : 'the token has expired' };\n", '') },
  ]);
}

module.exports = { withdrawalChecks };
