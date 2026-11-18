'use strict';

/*
 * Iteration 6, G2: observers.
 *
 *   G2a  an observer without the observe grant is refused (/events and /runtime-state are closed, 1008, before
 *        anything is sent); with it, the observer receives the hello and node events
 *   G2b  user events reach an observer without the presence grant with no user ids (nor names, nor User URLs), and
 *        with them when it holds the presence grant (the read grant that names the User resources); every observer
 *        sees every revision
 *   G2c  every path that shows people shows them only under the presence grant: GET /fabric/presence,
 *        GET /debug/state, GET /wow/user/{userId} (403 insufficient_scope without the grant), the users list of the
 *        /events hello, the /runtime-state stream (and the World resource's list of people)
 *   G2d  the token travels as the stream's first message and in the Authorization header, from the Lab's own web
 *        client and agent (web/wow-observe.mjs, web/wow-handshake.mjs): no token appears in any URL or Referer the
 *        world receives, and a URL that carries a token is refused (400 invalid_request)
 */

const { run } = require('../arch-i1/lib');
const lab = require('./lab');

/** The people of G2: a player registered in presence and a visitor who joined, each named so a leak is found by text. */
const PERSON = Object.freeze({ player_id: 'p-secret-7f3', display_name: 'Secret Person 7f3', avatar_id: 'avatar-secret-7f3' });
const OBSERVERS = [
  ...lab.grantsFor('plain', ['read', 'observe']),
  ...lab.grantsFor('presence', ['read', 'observe'], { users: true }),
  ...lab.grantsFor('reader', ['read']),
  ...lab.grantsFor('player', ['read', 'enter', 'observe']),
  ...lab.grantsFor('writer', ['read', 'write']),
];

/** The identifying texts a reader must not see without the presence grant; `ids` the User ids of the people present. */
function leaks(text, ids) {
  const found = [];
  for (const s of [PERSON.player_id, PERSON.display_name, lab.WALLET.claims.display_name]) if (text.includes(s)) found.push(JSON.stringify(s));
  for (const id of ids) if (new RegExp('wow/user/' + id + '(?!\\d)').test(text)) found.push('wow/user/' + id);
  return found;
}

/** A world with one player in presence and one visitor joined; returns { B, ids, agent }. */
async function peopledWorld(ports, edits, agent) {
  const B = await lab.authWorld('b', ports.next(), { base: '/w/b', grants: OBSERVERS, edits });
  const reg = await B.register(await B.token('player'), PERSON);
  if (reg.status !== 201) throw new Error('presence register answered ' + reg.status + ' ' + reg.body.slice(0, 160));
  const entered = await agent.enterWorld(B.base, { wallet: lab.WALLET, token: await B.token('player') });
  const joined = /^wow\/user\/(\d+)$/.exec((entered.answer && entered.answer.user) || '');
  if (entered.status !== 201 || !joined) throw new Error('the join answered ' + entered.status + ' ' + JSON.stringify(entered.answer).slice(0, 160));
  const presenceUser = (B.built.runtime.getWowEventsHello().users || []).find((u) => u.player_id === PERSON.player_id);
  return { B, ids: [Number(joined[1]), presenceUser ? presenceUser.id : -1] };
}

async function observerChecks(ports) {
  const agent = await lab.webModule('wow-handshake.mjs');
  const authEdit = (from, to) => ({ edits: { auth: [[from, to]] } });
  const serverEdit = (from, to) => ({ edits: { server: [[from, to]] } });
  const policyEdit = (from, to) => ({ edits: { policy: [[from, to]] } });

  // ---- G2a ----------------------------------------------------------------------------------------------
  await run('G2a', 'an observer without the observe grant is refused on /events and /runtime-state (closed 1008, nothing sent); with it, the observer receives the hello and a node event', async (impl) => {
    const failures = [];
    const seen = [];
    const B = await lab.authWorld('b', ports.next(), { base: '/w/b', grants: OBSERVERS, edits: impl.edits });
    try {
      for (const name of ['events', 'runtime-state']) {
        const s = await B.stream(name, await B.token('reader'));
        await lab.settle(s, 'never', 2500);
        if (!s.closedAt || s.closeCode !== 1008 || s.messages.length) failures.push(name + ' without observe: ' + (s.closedAt ? 'closed ' + s.closeCode : 'open') + ' after ' + s.messages.length + ' message(s)');
        seen.push(name + ' without observe: closed ' + s.closeCode + ', ' + s.messages.length + ' messages');
        s.close();
      }
      const s = await B.stream('events', await B.token('plain'));
      try {
        const hello = await lab.settle(s, 'hello', 3000);
        const made = await B.addNode(await B.token('writer'), 'g2a node');
        const created = await lab.settle(s, 'node_created', 3000);
        if (!hello) failures.push('the observer with observe got no hello');
        if (made.status !== 200) failures.push('the node write answered ' + made.status);
        else if (!created) failures.push('the observer with observe got no node_created');
        seen.push('with observe: hello and node_created revision ' + (created && created.revision));
        const st = await B.stream('runtime-state', await B.token('plain'));
        const state = await lab.settle(st, 'state', 3000);
        if (!state) failures.push('the observer with observe got no /runtime-state snapshot');
        st.close();
      } finally { s.close(); }
    } finally { await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : seen.join('; ') };
  }, {}, [
    { name: 'a stream that checks the token but not the observe grant', impl: authEdit("        if (!covers(verified, policy.STREAM_NEED)) return { ok : false, reason : 'insufficient_scope: no observe grant of this world' };\n", '') },
  ]);

  // ---- G2b ----------------------------------------------------------------------------------------------
  await run('G2b', 'user events reach an observer without the presence grant with no user ids, names or User URLs, and with them under the presence grant; both observers see every revision, in order', async (impl) => {
    const failures = [];
    const B = await lab.authWorld('b', ports.next(), { base: '/w/b', grants: OBSERVERS, edits: impl.edits });
    const plain = await B.stream('events', await B.token('plain'));
    const pres = await B.stream('events', await B.token('presence'));
    let detail = '';
    try {
      await lab.settle(plain, 'hello', 3000);
      await lab.settle(pres, 'hello', 3000);
      const reg = await B.register(await B.token('player'), PERSON);
      const entered = await agent.enterWorld(B.base, { wallet: lab.WALLET, token: await B.token('player') });
      const joined = /^wow\/user\/(\d+)$/.exec((entered.answer && entered.answer.user) || '');
      await B.addNode(await B.token('writer'), 'g2b node');
      if (joined) await B.req('DELETE', 'wow/user/' + joined[1], null, await B.token('player'));
      if (reg.status !== 201 || !joined) failures.push('setup: register ' + reg.status + ', join ' + entered.status);
      await lab.sleep(600);
      const presenceUser = (B.built.runtime.getWowEventsHello().users || []).find((u) => u.player_id === PERSON.player_id);
      const ids = [joined ? Number(joined[1]) : -1, presenceUser ? presenceUser.id : -1];
      const revs = (s) => s.messages.filter((m) => m && Number.isInteger(m.revision) && m.type !== 'hello').map((m) => m.revision);
      const users = (s) => s.messages.filter((m) => m && /^user_/.test(m.type));
      const rp = revs(plain);
      const rq = revs(pres);
      if (!rp.length || JSON.stringify(rp) !== JSON.stringify(rq)) failures.push('revisions differ: without presence ' + JSON.stringify(rp) + ', with ' + JSON.stringify(rq));
      for (let i = 1; i < rp.length; i++) if (rp[i] !== rp[i - 1] + 1) { failures.push('the observer without presence missed a revision: ' + JSON.stringify(rp)); break; }
      const up = users(plain);
      const uq = users(pres);
      if (up.length < 3) failures.push('the observer without presence got ' + up.length + ' user events, wanted 3 (two joins and a leave)');
      const leaked = leaks(JSON.stringify(up), ids);
      if (up.some((m) => m.user || m.userId !== undefined)) failures.push('a user event to the observer without presence carries a user or userId');
      if (leaked.length) failures.push('the user events to the observer without presence name ' + leaked.join(', '));
      if (!uq.some((m) => m.user && Number(m.user.id) === ids[0]) || !uq.some((m) => m.user && m.user.player_id === PERSON.player_id)) failures.push('the observer with the presence grant got no user ids: ' + JSON.stringify(uq).slice(0, 200));
      detail = 'revisions ' + JSON.stringify(rp) + ' to both; ' + up.length + ' user events without ids (types ' + up.map((m) => m.type).join(', ') + ') to the observer without presence, and with ids ' + JSON.stringify(uq.map((m) => (m.user ? m.user.id : m.userId))) + ' under the presence grant';
    } finally { plain.close(); pres.close(); await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : detail };
  }, {}, [
    { name: 'user events sent as they are to every observer', impl: serverEdit('unsubscribe = runtime.subscribeEvents(evt => sendFrame(view.event(evt)));', 'unsubscribe = runtime.subscribeEvents(evt => sendFrame(evt));') },
    { name: 'user events withheld from an observer without presence (revisions lost)', impl: policyEdit('    return withoutPeople(evt);', '    return /^user_/.test(String(evt && evt.type)) ? null : withoutPeople(evt);') },
    { name: 'an observer with the presence grant shown no user ids either', impl: authEdit('            event : (evt) => (presenceOf(verified) ? evt : policy.anonymousEvent(evt)),', '            event : (evt) => policy.anonymousEvent(evt),') },
  ]);

  // ---- G2c ----------------------------------------------------------------------------------------------
  await run('G2c', 'every path that shows people shows them only under the presence grant: GET /fabric/presence, GET /debug/state, GET /wow/user/{userId} (403 insufficient_scope without it), the /events hello\'s users, the /runtime-state stream, and the World\'s list of people', async (impl) => {
    const failures = [];
    const seen = [];
    const { B, ids } = await peopledWorld(ports, impl.edits, agent);
    try {
      const tokens = { plain: await B.token('plain'), presence: await B.token('presence') };
      const views = {};
      for (const who of ['plain', 'presence']) {
        const t = tokens[who];
        const v = {};
        for (const p of ['fabric/presence', 'debug/state', 'wow/world']) {
          const r = await B.req('GET', p, null, t);
          v[p] = r.status === 200 ? r.body : 'HTTP ' + r.status;
        }
        const u = await B.req('GET', 'wow/user/' + ids[0], null, t);
        v.user = { status: u.status, error: lab.challengeParam(u.headers['www-authenticate'], 'error'), body: u.body };
        const ev = await B.stream('events', t);
        const hello = await lab.settle(ev, 'hello', 3000);
        v.hello = hello ? JSON.stringify(hello.users || []) : 'no hello';
        ev.close();
        const st = await B.stream('runtime-state', t);
        const state = await lab.settle(st, 'state', 3000);
        v.state = state ? JSON.stringify(state) : 'no state';
        st.close();
        views[who] = v;
      }
      const plainV = views.plain;
      const presV = views.presence;
      for (const key of ['fabric/presence', 'debug/state', 'wow/world', 'hello', 'state']) {
        const l = leaks(plainV[key], ids);
        if (/^(HTTP|no )/.test(plainV[key])) failures.push(key + ' without presence: ' + plainV[key]);
        else if (l.length) failures.push(key + ' without the presence grant shows ' + l.join(', '));
        if (key !== 'wow/world' && !leaks(presV[key], ids).length) failures.push(key + ' with the presence grant shows nobody: ' + String(presV[key]).slice(0, 120));
      }
      if (!(plainV.user.status === 403 && plainV.user.error === 'insufficient_scope')) failures.push('GET /wow/user/' + ids[0] + ' without the presence grant answered ' + plainV.user.status + ' error=' + plainV.user.error);
      if (presV.user.status !== 200) failures.push('GET /wow/user/' + ids[0] + ' with the presence grant answered ' + presV.user.status);
      seen.push('without the presence grant: no person on /fabric/presence, /debug/state, the World, the hello or /runtime-state, and GET /wow/user/' + ids[0] + ' ' + plainV.user.status + ' ' + plainV.user.error + '; with it: people on each, and GET /wow/user/' + ids[0] + ' ' + presV.user.status);
    } finally { await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : seen.join('; ') };
  }, {}, [
    { name: '/fabric/presence shown with people', impl: serverEdit('return sendJson(res, 200, peopleFor(req, runtime.getFabricPresence()));', 'return sendJson(res, 200, runtime.getFabricPresence());') },
    { name: '/debug/state shown with people', impl: serverEdit('return sendJson(res, 200, peopleFor(req, runtime.getDebugState()));', 'return sendJson(res, 200, runtime.getDebugState());') },
    { name: 'GET /wow/user/{userId} under a read grant for the world', impl: policyEdit("if (USER_PATH.test(p)) return { scope : 'read', resource : 'users' };", "if (USER_PATH.test(p)) return { scope : 'read', resource : 'world' };") },
    { name: 'the /events hello shown with its users', impl: serverEdit('sendFrame(view.event(runtime.getWowEventsHello()));', 'sendFrame(runtime.getWowEventsHello());') },
    { name: 'the /runtime-state stream shown with people', impl: serverEdit("sendFrame({ type : 'state', state : view.state(snapshot) })", "sendFrame({ type : 'state', state : snapshot })") },
  ]);

  // ---- G2d ----------------------------------------------------------------------------------------------
  await run('G2d', 'the Lab\'s web client and agent send the token as the stream\'s first message and in the Authorization header: an observer reads a data point and follows the stream, an agent joins; no token appears in any URL or Referer the world receives; a URL carrying a token is refused with 400 invalid_request', async (impl) => {
    const failures = [];
    const web = impl.web || {};
    const observe = await lab.webModule('wow-observe.mjs', web.observe);
    const hs = await lab.webModule('wow-handshake.mjs', web.handshake);
    const B = await lab.authWorld('b', ports.next(), { base: '/w/b', grants: OBSERVERS, edits: impl.edits });
    const tokens = [];
    let detail = '';
    try {
      const t = await B.token('player');
      tokens.push(t);
      const observer = observe.createObserver({ fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, token: t, reconnect: false, reconnectMs: 60000 });
      const point = await observer.watch(B.url('wow/world#/users/active_user_count'));
      const end = Date.now() + 3000;
      const stream = () => [...observer.streams.values()][0];
      while (Date.now() < end && !(stream() && stream().state.status === 'live')) await lab.sleep(25);
      const live = stream() && stream().state.status === 'live';
      const entered = await hs.enterWorld(B.base, { wallet: lab.WALLET, token: t });
      observer.close();
      if (point.status !== 'ok') failures.push('the observer read the data point as ' + point.status);
      if (!live) failures.push('the observer\'s stream did not go live (the token as the first message)');
      if (entered.status !== 201) failures.push('the agent\'s join answered ' + entered.status + ' ' + JSON.stringify(entered.answer).slice(0, 120));
      // A URL that carries a token (a stand-in, never a token this world issued) is refused.
      const inUrl = await B.req('GET', 'wow/world?access_token=stand-in-not-a-token');
      if (!(inUrl.status === 400 && lab.challengeParam(inUrl.headers['www-authenticate'], 'error') === 'invalid_request')) failures.push('a URL carrying a token answered ' + inUrl.status + ', not 400 invalid_request');
      await lab.sleep(200);
      const all = B.log;
      for (const e of all) for (const tok of tokens) {
        if (String(e.url).includes(tok.slice(0, 40)) || String(e.url).includes(encodeURIComponent(tok).slice(0, 40))) failures.push('a token in the URL ' + e.method + ' ' + String(e.url).slice(0, 80));
        if (e.referer && String(e.referer).includes(tok.slice(0, 40))) failures.push('a token in the Referer of ' + e.url);
      }
      const streams = all.filter((e) => e.kind === 'stream');
      const withHeader = all.filter((e) => e.kind === 'http' && e.authorization && /^Bearer /.test(e.authorization));
      detail = all.length + ' requests and streams recorded (' + streams.length + ' stream(s), ' + withHeader.length + ' with the token in Authorization, ' + all.filter((e) => e.referer).length + ' with a Referer), no token in any URL or Referer; the data point read ' + point.value + ', the stream went live on the token as its first message, the agent joined (' + entered.status + '); a URL with a token answered 400 invalid_request';
    } finally { await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : detail };
  }, {}, [
    { name: 'a web client that puts the token in the stream URL', impl: { web: { observe: [['const socket = new WS(url);', 'const socket = new WS(url + (opts.token ? (url.includes("?") ? "&" : "?") + "access_token=" + encodeURIComponent(opts.token) : ""));']] } } },
    { name: 'an agent that sends no Authorization header with its join', impl: { web: { handshake: [['  f = authorizedFetch(f, token);\n', '']] } } },
    { name: 'a world that does not refuse a token in a URL', impl: authEdit("        if (tokenInUrl(url)) return refuse(req, res, 400, 'invalid_request', null, 'a token is never accepted in a URL; send it in the Authorization header');\n", '') },
  ]);
}

module.exports = { observerChecks, PERSON, leaks };
