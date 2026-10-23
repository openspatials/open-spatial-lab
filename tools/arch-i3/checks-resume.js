'use strict';

/*
 * Iteration 3, what an observer misses and how it catches up.
 *
 *   O4   the observer drops for five changes, reconnects with since=<revision>, and ends identical to an
 *        observer that never dropped
 *   O4b  the observer misses more changes than B keeps, across a restart of B's server: B sends resync
 *        with its current revision, the observer re-reads and ends identical to a fresh one; revisions
 *        after the restart continue from those before it
 *   O5   node n is deleted: the observer gets node_deleted, the data point then answers 404, and the id is
 *        never issued again
 */

const { run, makeTempDir } = require('../arch-i1/lib');
const lab = require('./lab');

const { w } = lab;
const pointState = (p) => JSON.stringify([p.value, p.revision, p.status]);

async function resumeChecks(ports) {
  // ---- O4 ---------------------------------------------------------------------------------------------
  const noRevisions = { serverEdits: { runtime: [['        evt.revision = wowRevision;\n', '']] } };
  await run('O4', 'an observer drops while the last five of ten changes happen and reconnects with since=<revision>: it ends identical to an observer that never dropped, having replayed the five', async (impl) => {
    const B = await w.world('b', ports.next(), { base: '/w/b', edits: impl.serverEdits });
    const { module: obs } = await lab.observe();
    const requested = [];
    const steady = obs.createObserver({});
    const dropping = obs.createObserver({ reconnectMs: 2600, onRequest: (u) => requested.push(u) });
    try {
      const [n] = await B.add(1, await B.rootOf(1), [{ label: 'node n', localTransform: w.IDENTITY, properties: { temperature: 20 } }]);
      const url = B.nodeUrl(1, n) + '#/properties/temperature';
      const a = await steady.watch(url);
      const b = await dropping.watch(url);
      await lab.until(() => [...steady.streams.values(), ...dropping.streams.values()].every((s) => s.state.status === 'live'), 5000, 'both streams');
      const sim = B.server.built.runtime.startSimulator({ node_id: n, interval_ms: 300, count: 10 });
      await lab.until(() => sim.log.length >= 5, 10000, 'five changes');
      const droppedAt = b.revision;
      for (const s of dropping.streams.values()) s.drop();
      await sim.done;
      await lab.sleep(3200);
      await steady.idle();
      await dropping.idle();
      const resumed = requested.filter((u) => /since=\d+/.test(u));
      const failures = [];
      if (pointState(a) !== pointState(b)) failures.push(`ended ${pointState(b)}, the steady observer ${pointState(a)}`);
      if (!resumed.length) failures.push('the observer never reconnected with since');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `dropped at revision ${droppedAt}, resumed with ${resumed[0].split('?')[1]}; both end at revision ${a.revision}, value ${a.value}` };
    } finally {
      steady.close();
      dropping.close();
      await B.close();
    }
  }, {}, [{ name: 'a server whose events carry no revision', impl: noRevisions }]);

  // ---- O4b --------------------------------------------------------------------------------------------
  const revisionNotKept = { serverEdits: { runtime: [['        if (!revisionFile) return;\n', '        return;\n']] } };
  const neverResyncs = { serverEdits: { runtime: [['        if (since + 1 < first) return { resync : true, revision : wowRevision };\n', '        if (since + 1 < first) return { events : [] };\n']] } };
  await run('O4b', 'B keeps 3 events; the observer misses 6 changes and B\'s server restarts meanwhile: B answers resync with its current revision, the observer re-reads and ends identical to a fresh observer, and the next change after the restart is one revision above the last before it', async (impl) => {
    const dir = makeTempDir('o4b');
    const port = ports.next();
    const boot = async () => {
      const saved = process.env.OSL_WOW_SPATIAL_PERSIST;
      process.env.OSL_WOW_SPATIAL_PERSIST = '1';
      try { return await w.world('b', port, { base: '/w/b', edits: impl.serverEdits, dir, config: { event_replay_limit: 3 } }); }
      finally { if (saved === undefined) delete process.env.OSL_WOW_SPATIAL_PERSIST; else process.env.OSL_WOW_SPATIAL_PERSIST = saved; }
    };
    let B = await boot();
    const { module: obs } = await lab.observe();
    const resyncs = [];
    const observer = obs.createObserver({ reconnectMs: 4000, onResync: (base, evt) => resyncs.push(evt) });
    let fresh = null;
    try {
      const [n] = await B.add(1, await B.rootOf(1), [{ label: 'node n', localTransform: w.IDENTITY, properties: { temperature: 20 } }]);
      const url = B.nodeUrl(1, n) + '#/properties/temperature';
      const p = await observer.watch(url);
      await lab.until(() => [...observer.streams.values()].every((s) => s.state.status === 'live'), 5000, 'the stream');
      for (const s of observer.streams.values()) s.drop();
      await B.server.built.runtime.startSimulator({ node_id: n, interval_ms: 100, count: 6 }).done;
      const before = (await lab.worldDoc(B)).revision;
      await B.close();
      B = await boot();
      const afterRestart = (await lab.worldDoc(B)).revision;
      await lab.sleep(4600);
      await observer.idle();
      const one = await B.server.built.runtime.startSimulator({ node_id: n, interval_ms: 50, count: 1 }).done;
      fresh = obs.createObserver({});
      const q = await fresh.watch(url);
      await lab.sleep(600);
      await observer.idle();
      const failures = [];
      if (!resyncs.length || resyncs[0].revision !== before) failures.push('resync: ' + JSON.stringify(resyncs.map((r) => r.revision)) + `, B's revision was ${before}`);
      if (afterRestart !== before) failures.push(`B restarted at revision ${afterRestart}, before the restart it was ${before}`);
      if (one[0].revision !== before + 1) failures.push(`the first change after the restart is revision ${one[0].revision}, not ${before + 1}`);
      if (p.value !== q.value || p.status !== 'ok') failures.push(`the observer ended at ${p.value} (${p.status}), a fresh observer reads ${q.value}`);
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `resync at revision ${before} after the restart; the observer re-read and matches a fresh one (${p.value}); next revision ${one[0].revision}` };
    } finally {
      observer.close();
      if (fresh) fresh.close();
      await B.close();
    }
  }, {}, [
    { name: 'a server that forgets its revision on restart', impl: revisionNotKept },
    { name: 'a server that never sends resync', impl: neverResyncs },
  ]);

  // ---- O5 ---------------------------------------------------------------------------------------------
  const deletionNotNamed = { serverEdits: { runtime: [["                emitWowEvent(wowNodeEvent('node_deleted', store.spatialId, { id : id }, [ 'wow/spatial/' + store.graphId + '/node/' + id ].concat(above)));", "                emitWowEvent(wowNodeEvent('node_deleted', store.spatialId, { id : id }, above));"]] } };
  await run('O5', 'node n is deleted: the observer receives node_deleted and marks the data point gone, the data point answers 404, and the next node created gets a new id', async (impl) => {
    const B = await w.world('b', ports.next(), { base: '/w/b', edits: impl.serverEdits });
    const { module: obs } = await lab.observe();
    const events = [];
    const observer = obs.createObserver({ onEvent: (base, evt) => events.push(evt) });
    try {
      const [n] = await B.add(1, await B.rootOf(1), [{ label: 'node n', localTransform: w.IDENTITY, properties: { temperature: 20 } }]);
      const p = await observer.watch(B.nodeUrl(1, n) + '#/properties/temperature');
      await lab.until(() => [...observer.streams.values()].every((s) => s.state.status === 'live'), 5000, 'the stream');
      await lab.httpReq('DELETE', B.port, '/w/b/wow/spatial/1/node/' + n);
      await lab.sleep(400);
      await observer.idle();
      const direct = await fetch(B.nodeUrl(1, n), { headers: { Accept: w.WOW } });
      const [next] = await B.add(1, await B.rootOf(1), [{ label: 'after', localTransform: w.IDENTITY }]);
      const failures = [];
      if (!events.some((e) => e.type === 'node_deleted' && e.node && e.node.id === n)) failures.push('no node_deleted for n');
      if (p.status !== 'gone') failures.push('the observer still has the point as ' + p.status);
      if (direct.status !== 404) failures.push('the deleted node answers ' + direct.status);
      if (next === n) failures.push('the id was issued again');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `node_deleted received; point gone; 404; the next node is ${next}, not ${n}` };
    } finally {
      observer.close();
      await B.close();
    }
  }, {}, [{ name: 'a server whose node_deleted does not name the node', impl: deletionNotNamed }]);
}

module.exports = { resumeChecks };
