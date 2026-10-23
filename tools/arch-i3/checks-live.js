'use strict';

/*
 * Iteration 3, a world that changes with nobody present, watched by observers that are not users.
 *
 *   O1   the observer process, given only two data-point URLs, receives all of B's simulator changes:
 *        revisions one apart, values and times equal to the simulator's log, 95% delivered in 500 ms
 *   O2   active_user_count stays 0 in both worlds while only observers are connected
 *   O2b  a user joins A: the observer's count reads 1 from the user_joined event, and 0 after the user
 *        leaves
 *   O3   iteration 2's conditional reads while the simulator writes: 304 between changes, 200 with a new
 *        entity tag after one
 */

const { run } = require('../arch-i1/lib');
const lab = require('./lab');

const { w } = lab;

async function twoWorlds(ports, impl) {
  const A = await w.world('a', ports.next(), { edits: impl.serverEdits });
  const B = await w.world('b', ports.next(), { base: '/w/b', edits: impl.serverEdits });
  const [n] = await B.add(1, await B.rootOf(1), [{ label: 'node n', localTransform: w.IDENTITY, properties: { temperature: 20 } }]);
  return { A, B, n, point: B.nodeUrl(1, n) + '#/properties/temperature', users: A.worldUrl() + '#/users/active_user_count', close: async () => { await A.close(); await B.close(); } };
}

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : NaN;
}

async function liveChecks(ports) {
  // ---- O1 ---------------------------------------------------------------------------------------------
  const dropsEveryTenth = { count: 20, interval: 150, serverEdits: { runtime: [['        for (const subscriber of eventSubscribers)\n', '        if (wowRevision % 10 === 0) return;\n        for (const subscriber of eventSubscribers)\n']] } };
  const ignoresRelativeUrls = { count: 20, interval: 150, observeEdits: [['        const changed = new Set((evt.urls || []).map((u) => new URL(u, base).href));', '        const changed = new Set(evt.urls || []);']] };
  await run('O1', 'B\'s simulator changes node n every second for 120 seconds with nobody in B; a separate observer process, given only two data-point URLs, receives every change: revisions one apart, values and times equal to the simulator\'s log, and 95% delivered within 500 ms on loopback', async (impl) => {
    const count = impl.count || 120;
    const interval = impl.interval || 1000;
    const s = await twoWorlds(ports, impl);
    let observer = null;
    try {
      const file = impl.observeEdits ? (await lab.observe(impl.observeEdits)).file : null;
      observer = lab.observerProcess([s.point, s.users], file);
      await observer.ready();
      const log = await s.B.server.built.runtime.startSimulator({ node_id: s.n, interval_ms: interval, count }).done;
      await lab.sleep(1500);
      const failures = [];
      const seen = new Map(lab.changesOf(observer.lines, s.point).map((l) => [l.revision, l]));
      const delays = [];
      let missing = 0;
      for (const entry of log) {
        const got = seen.get(entry.revision);
        if (!got) { missing += 1; continue; }
        if (got.value !== entry.temperature) failures.push(`revision ${entry.revision}: value ${got.value}, log ${entry.temperature}`);
        if (got.time !== entry.time) failures.push(`revision ${entry.revision}: time ${got.time}, log ${entry.time}`);
        delays.push(got.received_at - Date.parse(entry.time));
      }
      if (missing) failures.push(`${missing} of ${log.length} changes never reached the observer`);
      const steps = log.slice(1).filter((e, i) => e.revision !== log[i].revision + 1).length;
      if (steps) failures.push(`${steps} revisions are not one above the last`);
      const p95 = percentile(delays, 95);
      if (!(p95 < 500)) failures.push(`95th-percentile delivery ${Math.round(p95)} ms`);
      if (log.length !== count) failures.push(`the simulator made ${log.length} changes`);
      return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 4).join('; ') : `${log.length} changes, revisions ${log[0].revision} to ${log[log.length - 1].revision}, all received with the logged values and times; delivery median ${Math.round(percentile(delays, 50))} ms, 95th percentile ${Math.round(p95)} ms` };
    } finally {
      if (observer) await observer.stop();
      await s.close();
    }
  }, {}, [
    { name: 'a server that drops every tenth event', impl: dropsEveryTenth },
    { name: 'an observer that does not resolve an event\'s URLs against the world\'s base', impl: ignoresRelativeUrls },
  ]);

  // ---- O2 ---------------------------------------------------------------------------------------------
  const observersAreUsers = { serverEdits: { runtime: [['                active_user_count : livePresenceEntries(Date.now()).length,', '                active_user_count : livePresenceEntries(Date.now()).length + eventSubscribers.size,']] } };
  await run('O2', 'with only observers connected (an observer of both worlds and a raw event stream to each), active_user_count stays 0 in both worlds while B changes', async (impl) => {
    const s = await twoWorlds(ports, impl);
    const { module: obs } = await lab.observe();
    const observer = obs.createObserver({});
    const raws = [];
    try {
      await observer.watch(s.point);
      const users = await observer.watch(s.users);
      raws.push(await lab.rawStream(s.A.port, '/events'), await lab.rawStream(s.B.port, '/w/b/events'));
      const counts = [];
      const sample = async () => counts.push([(await lab.worldDoc(s.A)).users.active_user_count, (await lab.worldDoc(s.B)).users.active_user_count, users.value]);
      await sample();
      const sim = s.B.server.built.runtime.startSimulator({ node_id: s.n, interval_ms: 200, count: 5 });
      for (let i = 0; i < 5; i += 1) { await lab.sleep(200); await sample(); }
      await sim.done;
      await lab.sleep(300);
      await sample();
      const nonzero = counts.filter((c) => c.some((v) => v !== 0));
      return { ok: nonzero.length === 0, detail: nonzero.length ? 'counts seen (A, B, observed A): ' + JSON.stringify(nonzero.slice(0, 3)) : `${counts.length} samples during B's changes: 0 users in A, 0 in B, and the observer reads 0` };
    } finally {
      observer.close();
      for (const r of raws) r.close();
      await s.close();
    }
  }, {}, [{ name: 'a server that counts observers as users', impl: observersAreUsers }]);

  // ---- O2b --------------------------------------------------------------------------------------------
  const countNotNamed = { serverEdits: { runtime: [
    ["            urls : [ 'wow/user/' + entry.wow_user_id, 'wow/world' ],", "            urls : [ 'wow/user/' + entry.wow_user_id ],"],
    ["        evt.urls = Array.from(new Set((evt.urls || []).concat([ 'wow/world' ])));", '        evt.urls = Array.from(new Set(evt.urls || []));'],
  ] } };
  await run('O2b', 'a user joins A: the observer\'s active_user_count reads 1 from the user_joined event itself, and 0 again from the user_left event', async (impl) => {
    const s = await twoWorlds(ports, impl);
    const { module: obs } = await lab.observe();
    const history = [];
    const observer = obs.createObserver({ onChange: (p) => { if (p.url === s.users) history.push([p.revision, p.value]); } });
    try {
      await observer.watch(s.users);
      await lab.until(() => [...observer.streams.values()].every((st) => st.state.status === 'live'), 5000, 'the stream');
      await lab.join(s.A, 'proof-player');
      const joinedAt = (await lab.worldDoc(s.A)).revision;
      await lab.sleep(400);
      await lab.leave(s.A, 'proof-player');
      const leftAt = (await lab.worldDoc(s.A)).revision;
      await lab.sleep(400);
      await observer.idle();
      const at = (rev) => history.filter((h) => h[0] === rev).map((h) => h[1]);
      const failures = [];
      if (!at(joinedAt).includes(1)) failures.push(`at the user_joined revision ${joinedAt} the observer read ${JSON.stringify(at(joinedAt))}`);
      if (!at(leftAt).includes(0)) failures.push(`at the user_left revision ${leftAt} the observer read ${JSON.stringify(at(leftAt))}`);
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `1 at revision ${joinedAt} (user_joined), 0 at revision ${leftAt} (user_left)` };
    } finally {
      observer.close();
      await s.close();
    }
  }, {}, [{ name: 'a server whose user events do not name the World', impl: countNotNamed }]);

  // ---- O3 ---------------------------------------------------------------------------------------------
  const tagEveryRead = { serverEdits: { server: [['            const etag = wowEtag(type, body);', '            const etag = wowEtag(type, body + Math.random());']] } };
  await run('O3', 'iteration 2\'s conditional read, repeated every 100 ms while the simulator writes: 304 between changes, and 200 with a new entity tag after each change', async (impl) => {
    const s = await twoWorlds(ports, impl);
    try {
      const url = s.B.nodeUrl(1, s.n);
      const polls = [];
      let etag = null;
      let lastSync = Date.now();
      const sim = s.B.server.built.runtime.startSimulator({ node_id: s.n, interval_ms: 800, count: 10 });
      let finished = false;
      sim.done.then(() => { finished = true; });
      const first = await fetch(url, { headers: { Accept: w.WOW } });
      etag = first.headers.get('etag');
      await first.text();
      while (!finished) {
        const sent = Date.now();
        const r = await fetch(url, { headers: { Accept: w.WOW, 'If-None-Match': etag } });
        const recv = Date.now();
        const tag = r.headers.get('etag');
        await r.text();
        polls.push({ sent, recv, status: r.status, tag, previous: etag, since: lastSync });
        if (r.status === 200) { etag = tag; lastSync = recv; }
        await lab.sleep(100);
      }
      const changes = s.B.server.built.runtime.getSimulatorLog().map((e) => Date.parse(e.time));
      let mismatched = 0;
      let ambiguous = 0;
      let ok200 = 0;
      let ok304 = 0;
      for (const p of polls) {
        if (changes.some((t) => t >= p.sent - 30 && t <= p.recv + 30)) { ambiguous += 1; continue; }
        const expect200 = changes.some((t) => t > p.since && t < p.sent);
        if (expect200 !== (p.status === 200) || (p.status === 200 && p.tag === p.previous)) mismatched += 1;
        else if (p.status === 200) ok200 += 1;
        else ok304 += 1;
      }
      const ok = mismatched === 0 && ok304 >= 5 && ok200 >= 3;
      return { ok, detail: `${polls.length} reads: ${ok304} answered 304 between changes, ${ok200} answered 200 with a new tag after one, ${mismatched} wrong, ${ambiguous} too close to a change to call` };
    } finally {
      await s.close();
    }
  }, {}, [{ name: 'a B whose entity tag changes on every read', impl: tagEveryRead }]);
}

module.exports = { liveChecks };
