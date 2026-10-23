'use strict';

/*
 * Iteration 3, who may open a world's event stream.
 *
 *   O11  B requires a token for its stream and allows one origin. A stream whose first message carries no
 *        valid token is closed within 5 seconds; a stream from an origin B does not allow is refused; an
 *        observer with the token follows B, and no token appears in any URL the proof records. The tokens
 *        are fixture tokens: what they mean comes with iteration 6.
 */

const { run } = require('../arch-i1/lib');
const lab = require('./lab');

const { w } = lab;
const TOKEN = 'fixture-observer-token-7f3a';
const ALLOWED = 'http://allowed.example';

async function authChecks(ports) {
  const noTokenCheck = { serverEdits: { server: [['            if (EVENT_AUTH)\n            {\n                const timer', '            if (false)\n            {\n                const timer']] } };
  const noOriginCheck = { serverEdits: { server: [["        if (wsPath === '/events' && !originAllowed(req.headers.origin))", "        if (false && wsPath === '/events' && !originAllowed(req.headers.origin))"]] } };
  const tokenInUrl = { observeEdits: [['    if (state.revision !== null) url += (url.includes("?") ? "&" : "?") + "since=" + state.revision;', '    if (state.revision !== null) url += (url.includes("?") ? "&" : "?") + "since=" + state.revision;\n    if (opts.token) url += (url.includes("?") ? "&" : "?") + "access_token=" + encodeURIComponent(opts.token);']] };
  await run('O11', 'B requires a token and allows one origin: a stream with no token, or a wrong one, is closed within 5 s; a stream from another origin is refused; an observer that sends the token as its first message follows B, and no URL it requests carries the token', async (impl) => {
    const B = await w.world('b', ports.next(), { base: '/w/b', edits: impl.serverEdits, config: { event_auth: { tokens: [TOKEN] }, cors_allowed_origins: [ALLOWED] } });
    const { module: obs } = await lab.observe(impl.observeEdits);
    const requested = [];
    const observer = obs.createObserver({ token: TOKEN, onRequest: (u) => requested.push(u) });
    const raws = [];
    try {
      const [n] = await B.add(1, await B.rootOf(1), [{ label: 'node n', localTransform: w.IDENTITY, properties: { temperature: 20 } }]);
      const silent = await lab.rawStream(B.port, '/w/b/events', { Origin: ALLOWED });
      const wrong = await lab.rawStream(B.port, '/w/b/events', { Origin: ALLOWED });
      wrong.send(JSON.stringify({ type: 'auth', token: 'not-the-token' }));
      const foreign = await lab.rawStream(B.port, '/w/b/events', { Origin: 'http://elsewhere.example' });
      raws.push(silent, wrong, foreign);
      const p = await observer.watch(B.nodeUrl(1, n) + '#/properties/temperature');
      await lab.until(() => [...observer.streams.values()].every((s) => s.state.status === 'live'), 5000, 'the observer\'s stream');
      await B.server.built.runtime.startSimulator({ node_id: n, interval_ms: 150, count: 3 }).done;
      const latest = (await lab.worldDoc(B)).revision;
      await lab.sleep(5600);
      await observer.idle();
      const failures = [];
      const closedIn = (s) => (s.closedAt ? s.closedAt - s.openedAt : null);
      if (silent.status !== 101 || closedIn(silent) === null || closedIn(silent) > 5000) failures.push(`no token: ${silent.status}, closed after ${closedIn(silent)} ms`);
      if (silent.messages.some((m) => m.type === 'hello' || m.type === 'node_updated')) failures.push('the stream without a token received events');
      if (closedIn(wrong) === null || wrong.messages.some((m) => m.type === 'node_updated')) failures.push('the stream with a wrong token stayed open or received events');
      if (foreign.status !== 403) failures.push(`a stream from another origin got ${foreign.status}`);
      if (p.revision !== latest) failures.push(`the observer with the token is at revision ${p.revision}, B at ${latest}`);
      const leaked = requested.filter((u) => u.includes(TOKEN) || u.includes(encodeURIComponent(TOKEN)));
      if (leaked.length) failures.push(`${leaked.length} recorded URLs carry the token`);
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `no token: closed after ${closedIn(silent)} ms; wrong token: closed after ${closedIn(wrong)} ms; other origin: 403; the observer followed B to revision ${p.revision}; ${requested.length} recorded URLs, none with the token` };
    } finally {
      observer.close();
      for (const r of raws) r.close();
      await B.close();
    }
  }, {}, [
    { name: 'a server that does not wait for a token', impl: noTokenCheck },
    { name: 'a server that does not check the Origin', impl: noOriginCheck },
    { name: 'an observer that puts the token in the URL', impl: tokenInUrl },
  ]);
}

module.exports = { authChecks };
