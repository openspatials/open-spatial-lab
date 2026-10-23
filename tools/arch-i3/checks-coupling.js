'use strict';

/*
 * Iteration 3, worlds that follow other worlds.
 *
 *   O6   a node in A holds B's data-point URL; A's server observes it and mirrors the temperature into its
 *        own node while nobody is in B; A writes only to itself
 *   O6b  A and B mirror one value both ways: after one change in B both worlds settle within two events
 *        and stay quiet
 *   O7   iteration 2's inclusion of B updates within one event of each change, without polling
 *   O9   with I8b's worlds live and a stream budget of 8, A holds at most 8 event streams; inclusions from
 *        the other worlds show "over budget"
 *   O10  a node of B typed as environment through the JSON-LD context is not shown in A
 */

const { run } = require('../arch-i1/lib');
const lab = require('./lab');

const { w } = lab;
const maxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const nonReads = (log) => log.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method));

async function couplingChecks(ports) {
  // ---- O6 ---------------------------------------------------------------------------------------------
  const mirrorReadsOnce = { serverEdits: { mirrors: [['                onChange : (point) => apply(point),', '                onChange : () => {},']] } };
  await run('O6', 'a node in A holds B\'s data-point URL under properties.mirror; while B has nobody in it and its simulator changes the temperature, A\'s server mirrors every value into A\'s own node, and sends B no write', async (impl) => {
    const B = await w.world('b', ports.next(), { base: '/w/b' });
    const A = await w.world('a', ports.next(), { edits: impl.serverEdits });
    const { module: obs } = await lab.observe();
    const seen = [];
    const observer = obs.createObserver({ onChange: (p) => seen.push(p.value) });
    try {
      const [n] = await B.add(1, await B.rootOf(1), [{ label: 'node n', localTransform: w.IDENTITY, properties: { temperature: 20 } }]);
      const [m] = await A.add(1, await A.rootOf(1), [{ label: 'mirror of B', localTransform: w.IDENTITY, properties: { temperature: 0, mirror: { temperature: B.nodeUrl(1, n) + '#/properties/temperature' } } }]);
      await observer.watch(A.nodeUrl(1, m) + '#/properties/temperature');
      await lab.until(async () => (await A.node(1, m)).json.properties.temperature === 20, 5000, 'A\'s first mirrored value');
      const writes = lab.requestLog(B);
      const log = await B.server.built.runtime.startSimulator({ node_id: n, interval_ms: 300, count: 5 }).done;
      await lab.sleep(800);
      await observer.idle();
      writes.stop();
      const failures = [];
      const missing = log.filter((e) => !seen.includes(e.temperature));
      if (missing.length) failures.push(`A never showed ${missing.map((e) => e.temperature).join(', ')}`);
      const final = (await A.node(1, m)).json.properties.temperature;
      if (final !== log[log.length - 1].temperature) failures.push(`A ends at ${final}`);
      if (nonReads(writes.log).length) failures.push(`B received ${nonReads(writes.log).length} writes`);
      if ((await lab.worldDoc(B)).users.active_user_count !== 0) failures.push('B has a user');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `A mirrored all ${log.length} values (last ${final}); B received only reads (${writes.log.length} requests) and has no user` };
    } finally {
      observer.close();
      await A.close();
      await B.close();
    }
  }, {}, [{ name: 'a mirror that reads once and never follows', impl: mirrorReadsOnce }]);

  // ---- O6b --------------------------------------------------------------------------------------------
  const noOpCreatesEvent = { serverEdits: { runtime: [["            if (JSON.stringify(before) === JSON.stringify(store.getNode(nodeId, { form : 'flat' }))) return Object.assign(r, { unchanged : true });\n", '']] } };
  await run('O6b', 'A and B mirror one value both ways; after one change in B, both worlds settle within two events and then stay quiet, because a write that changes nothing creates no event', async (impl) => {
    const A = await w.world('a', ports.next(), { edits: impl.serverEdits });
    const B = await w.world('b', ports.next(), { base: '/w/b', edits: impl.serverEdits });
    try {
      const [bn] = await B.add(1, await B.rootOf(1), [{ label: 'shared in B', localTransform: w.IDENTITY, properties: { temperature: 20 } }]);
      const [an] = await A.add(1, await A.rootOf(1), [{ label: 'shared in A', localTransform: w.IDENTITY, properties: { temperature: 20, mirror: { temperature: B.nodeUrl(1, bn) + '#/properties/temperature' } } }]);
      const current = (await B.node(1, bn)).json;
      delete current.children;
      current.properties = Object.assign({}, current.properties, { mirror: { temperature: A.nodeUrl(1, an) + '#/properties/temperature' } });
      await B.put(1, bn, current);
      await lab.sleep(1500);
      const rev = async () => [(await lab.worldDoc(A)).revision, (await lab.worldDoc(B)).revision];
      const [a0, b0] = await rev();
      current.properties = Object.assign({}, current.properties, { temperature: 25 });
      await B.put(1, bn, current);
      await lab.sleep(2000);
      const [a1, b1] = await rev();
      await lab.sleep(1000);
      const [a2, b2] = await rev();
      const values = [(await A.node(1, an)).json.properties.temperature, (await B.node(1, bn)).json.properties.temperature];
      const events = (a1 - a0) + (b1 - b0);
      const failures = [];
      if (events > 2) failures.push(`${events} events after one change (A ${a1 - a0}, B ${b1 - b0})`);
      if (a2 !== a1 || b2 !== b1) failures.push(`not quiet: ${a2 - a1} more in A, ${b2 - b1} more in B`);
      if (values[0] !== 25 || values[1] !== 25) failures.push(`values ${values.join(', ')}`);
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `one change in B: ${b1 - b0} event in B, ${a1 - a0} in A, then quiet; both read 25` };
    } finally {
      await A.close();
      await B.close();
    }
  }, {}, [{ name: 'a server where a write that changes nothing still creates an event', impl: noOpCreatesEvent }]);

  // ---- O7 ---------------------------------------------------------------------------------------------
  const ignoresEvents = { inclusionEdits: [['          if (named.some((u) => reader.cache.has(u))) return recompose(evt);', '          if (false) return recompose(evt);']] };
  await run('O7', 'A includes B\'s graph at X; while B\'s simulator moves node n, A\'s composition updates from the event of each change (n under X follows each logged transform exactly), and reads nothing between events', async (impl) => {
    const B = await w.world('b', ports.next(), { base: '/w/b' });
    const A = await w.world('a', ports.next());
    const { module: inc } = await lab.inclusion(impl.inclusionEdits);
    let live = null;
    try {
      const [n] = await B.add(1, await B.rootOf(1), [{ label: 'node n', localTransform: w.IDENTITY, properties: { temperature: 20 } }]);
      const [X] = await A.add(1, await A.rootOf(1), [{ label: 'X', localTransform: w.translation(10, 0, 0), spatialAssetURI: B.spatialUrl(1) }]);
      const updates = [];
      const nUrl = B.nodeUrl(1, n);
      live = await inc.observeComposition(A.spatialUrl(1), {
        fetch,
        onUpdate: (c, evt) => { const r = (c.registry.get(nUrl) || [])[0]; updates.push({ revision: evt && evt.revision, world: r && r.world }); },
      });
      await lab.until(() => [...live.streams.values()].every((s) => s.state.status === 'live'), 5000, 'the streams');
      const log = await B.server.built.runtime.startSimulator({ node_id: n, interval_ms: 400, count: 8 }).done;
      await lab.sleep(600);
      await live.idle();
      const requestsAfter = live.composition.stats.requests;
      await lab.sleep(1500);
      const quietRequests = live.composition.stats.requests - requestsAfter;
      const xWorld = live.composition.registry.get(A.nodeUrl(1, X))[0].world;
      const failures = [];
      for (const entry of log) {
        const u = updates.find((x) => x.revision === entry.revision);
        if (!u || !u.world) { failures.push(`no update for revision ${entry.revision}`); continue; }
        const want = multiplyColumnMajor(xWorld, entry.localTransform);
        if (maxDiff(u.world, want) > 1e-12) failures.push(`revision ${entry.revision}: n is not where the log puts it`);
      }
      if (quietRequests) failures.push(`${quietRequests} reads with no event`);
      return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 3).join('; ') : `${log.length} changes, each shown from its own event (${updates.length} updates); no read between events` };
    } finally {
      if (live) live.close();
      await A.close();
      await B.close();
    }
  }, {}, [{ name: 'a client that ignores events', impl: ignoresEvents }]);

  // ---- O9 ---------------------------------------------------------------------------------------------
  const noStreamBudget = { inclusionEdits: [['    if (out.streams.length >= streamBudget) return false;\n', '']] };
  await run('O9', 'with I8b\'s 13 worlds live and a stream budget of 8, A holds 8 event streams, its own among them, handed out in tree order; inclusions from the other worlds show "over budget"', async (impl) => {
    const all = [];
    for (let i = 0; i < 13; i += 1) all.push(await w.world(i % 2 ? 'b' : 'a', ports.next()));
    const [A, ...rest] = all;
    const Bs = rest.slice(0, 4);
    const Cs = rest.slice(4, 8);
    const Ds = rest.slice(8, 12);
    const { module: inc } = await lab.inclusion(impl.inclusionEdits);
    let live = null;
    try {
      const link = async (from, targets) => from.add(1, await from.rootOf(1), targets.map((t, i) => ({ label: 'to ' + i, localTransform: w.scaled(0.25, i * 2 - 3, 0, 6), spatialAssetURI: t.spatialUrl(1) })));
      await link(A, Bs);
      for (const b of Bs) await link(b, Cs);
      for (const c of Cs) await link(c, Ds);
      live = await inc.observeComposition(A.spatialUrl(1), { fetch, budget: 16, nestingLimit: 3, streamBudget: 8 });
      await lab.sleep(500);
      const c = live.composition;
      const baseOf = (u) => u.slice(0, u.indexOf('/wow/') + 1);
      const outside = c.inclusions.filter((i) => !c.streams.includes(baseOf(i.target)));
      const failures = [];
      if (live.streams.size > 8) failures.push(`${live.streams.size} streams`);
      if (live.streams.size !== 8) failures.push(`${live.streams.size} streams, not 8`);
      if (!outside.length || outside.some((i) => i.status !== 'over budget')) failures.push('inclusions outside the 8 worlds: ' + JSON.stringify(outside.map((i) => i.status)));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `${live.streams.size} streams; ${outside.length} inclusions from other worlds marked over budget` };
    } finally {
      if (live) live.close();
      for (const x of all) await x.close();
    }
  }, {}, [{ name: 'a client with no stream budget', impl: noStreamBudget }]);

  // ---- O10 --------------------------------------------------------------------------------------------
  const literalType = { inclusionEdits: [['    return [].concat(properties["@type"]).some((t) => expand(t, 0) === ENVIRONMENT_IRI);', '    return [].concat(properties["@type"]).includes("Environment");']] };
  await run('O10', 'B\'s nodes typed as environment through the JSON-LD context (the served context, and an inline one with another term) are not shown in A, with their subtrees; a node whose "Environment" term means something else is shown, and A\'s own environment node stays', async (impl) => {
    const B = await w.world('b', ports.next(), { base: '/w/b' });
    const A = await w.world('a', ports.next());
    const { module: inc } = await lab.inclusion(impl.inclusionEdits);
    try {
      const context = B.base + '/wow/context.jsonld';
      const [sky, dome, statue] = await B.add(1, await B.rootOf(1), [
        { label: 'sky', localTransform: w.IDENTITY, properties: { '@context': context, '@type': 'Environment' } },
        { label: 'dome', localTransform: w.IDENTITY, properties: { '@context': { wow: 'urn:webofworlds:term:', Sky: 'wow:Environment' }, '@type': 'Sky' } },
        { label: 'statue', localTransform: w.IDENTITY, properties: { '@context': { Environment: 'urn:example:statue-kind' }, '@type': 'Environment' } },
      ]);
      const [sun] = await B.add(1, sky, [{ label: 'sun under the sky', localTransform: w.IDENTITY }]);
      const [, aSky] = await A.add(1, await A.rootOf(1), [
        { label: 'X', localTransform: w.translation(10, 0, 0), spatialAssetURI: B.spatialUrl(1) },
        { label: 'A\'s own sky', localTransform: w.IDENTITY, properties: { '@context': A.base + '/wow/context.jsonld', '@type': 'Environment' } },
      ]);
      const c = await inc.composeInclusions(A.spatialUrl(1), { fetch });
      const shown = (id, world) => c.registry.has(world.nodeUrl(1, id));
      const failures = [];
      if (shown(sky, B) || shown(sun, B)) failures.push('the sky (or its subtree) is shown');
      if (shown(dome, B)) failures.push('the dome (Sky, mapped to wow:Environment) is shown');
      if (!shown(statue, B)) failures.push('the statue (Environment meaning something else) is hidden');
      if (!shown(aSky, A)) failures.push('A\'s own sky is hidden');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `left out: ${c.environment.length} environment nodes of B (sky with its subtree, dome); shown: the statue and A's own sky` };
    } finally {
      await A.close();
      await B.close();
    }
  }, {}, [{ name: 'a client that matches the word "Environment" instead of the type it names', impl: literalType }]);
}

/** Column-major product, written here so O7 does not lean on the client's own. */
function multiplyColumnMajor(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) for (let r = 0; r < 4; r += 1) for (let k = 0; k < 4; k += 1) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

module.exports = { couplingChecks };
