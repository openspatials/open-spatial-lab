'use strict';

/*
 * Iteration 2, what can go wrong when one world includes another.
 *
 *   I5   B offline: X and Y show placeholders marked "unreachable"; A's own nodes are unaffected
 *   I6   B refuses node n (403): Y shows a placeholder marked "forbidden"
 *   I7   A includes B and B includes A: the cycle is found at depth 2, with no fetch loop
 *   I8   with a nesting limit of 3, the fourth level is refused
 *   I8b  13 worlds and 84 inclusions: repeats are not cycles; a budget of 16 shows 16 graphs, the
 *        rest "over budget", the same 16 on every run however the answers arrive
 */

const { run } = require('../arch-i1/lib');
const w = require('./worlds');
const { baseScene, inclusionAt } = require('./scenario');

const sameMatrix = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1e-12);

/** Boot worlds by role and port; returns them in order. */
async function worlds(count, ports, impl) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(await w.world(i % 2 ? 'b' : 'a', ports.next(), { edits: impl && impl.serverEdits }));
  return out;
}
const closeAll = async (list) => { for (const x of list) await x.close(); };

async function failureChecks(ports) {
  // ---- I5 ---------------------------------------------------------------------------------------------
  const throwsWhenUnreachable = { clientEdits: [[
    '      log.push({ url, status: 0, error: String((error && error.message) || error) });\n      return { url, status: 0, error: String((error && error.message) || error) };',
    '      throw error;',
  ]] };
  await run('I5', 'with B offline, X and Y show placeholders marked "unreachable", and every one of A\'s own nodes is shown where it was', async (impl) => {
    const s = await baseScene(impl, ports);
    try {
      const online = await s.compose();
      await s.B.close();
      const offline = await s.compose();
      const failures = [];
      for (const [name, url] of [['X', s.urls.X], ['Y', s.urls.Y]]) {
        const i = inclusionAt(offline, url);
        if (!i || i.status !== 'unreachable') failures.push(name + ': ' + (i ? i.status : 'no link met'));
      }
      const own = (c) => c.nodes.filter((r) => r.depth === 0);
      const a1 = own(online);
      const a2 = own(offline);
      if (a1.length !== a2.length) failures.push(`A shows ${a2.length} of its ${a1.length} own nodes`);
      for (const r of a1) {
        const again = a2.find((x) => x.url === r.url);
        if (!again || !sameMatrix(again.world, r.world)) failures.push(r.url + ' moved or vanished');
      }
      if (offline.nodes.some((r) => r.included)) failures.push('included content is still shown');
      return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 4).join('; ') : `X and Y unreachable; all ${a1.length} of A's own nodes unchanged` };
    } finally { await s.close(); }
  }, {}, [{ name: 'a client that stops composing when a world does not answer', impl: throwsWhenUnreachable }]);

  // ---- I6 ---------------------------------------------------------------------------------------------
  const treats403AsUnreachable = { clientEdits: [[
    '  if (answer.status === 403 || answer.status === 401) return INCLUSION_STATUS.FORBIDDEN;',
    '  if (answer.status === 403 || answer.status === 401) return INCLUSION_STATUS.UNREACHABLE;',
  ]] };
  const ignoresReadPolicy = { serverEdits: { server: [[
    '                if (refusesRead(graphIdOf(spatialID), nodeId))\n                    return sendJson(res, 403',
    '                if (false)\n                    return sendJson(res, 403',
  ]] } };
  await run('I6', 'B answers 403 for node n, so Y shows a placeholder marked "forbidden"; X still shows B\'s graph, without n', async (impl) => {
    const policy = { refused: new Set(), refusesNode(graphId, nodeId) { return this.refused.has(graphId + ':' + nodeId); } };
    const s = await baseScene(impl, ports, { bConfig: { read_policy: policy } });
    try {
      policy.refused.add('1:' + s.ids.n);
      const c = await s.compose();
      const failures = [];
      const y = inclusionAt(c, s.urls.Y);
      const x = inclusionAt(c, s.urls.X);
      if (!y || y.status !== 'forbidden') failures.push('Y: ' + (y ? y.status : 'no link met'));
      if (!x || x.status !== 'included') failures.push('X: ' + (x ? x.status : 'no link met'));
      if (c.registry.has(s.urls.n)) failures.push('n is shown although B refuses it');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'Y forbidden; X included without n' };
    } finally { await s.close(); }
  }, {}, [
    { name: 'a client that reports a refusal as unreachable', impl: treats403AsUnreachable },
    { name: 'a B that serves node n to everyone', impl: ignoresReadPolicy },
  ]);

  // ---- I7 ---------------------------------------------------------------------------------------------
  const noCycleCheck = { clientEdits: [['    if (ctx.path.includes(target)) blocked = INCLUSION_STATUS.CYCLE;', '    if (false) blocked = INCLUSION_STATUS.CYCLE;']] };
  await run('I7', 'A includes B and B includes A: the cycle is detected at depth 2 and reported, A\'s Spatial is fetched once, and nothing loops', async (impl) => {
    const [A, B] = await worlds(2, ports, impl);
    try {
      await A.add(1, await A.rootOf(1), [{ label: 'to B', localTransform: w.translation(4, 0, 0), spatialAssetURI: B.spatialUrl(1) }]);
      await B.add(1, await B.rootOf(1), [{ label: 'back to A', localTransform: w.translation(-4, 0, 0), spatialAssetURI: A.spatialUrl(1) }]);
      const inc = await w.client(impl.clientEdits);
      const counted = w.countingFetch();
      const c = await inc.composeInclusions(A.spatialUrl(1), { fetch: counted });
      const failures = [];
      const cycle = c.cycles[0];
      if (c.cycles.length !== 1 || !cycle || cycle.depth !== 2 || cycle.target !== A.spatialUrl(1)) failures.push('cycles reported: ' + JSON.stringify(c.cycles.map((x) => ({ depth: x.depth, target: x.target }))));
      if ((counted.counts.get(A.spatialUrl(1)) || 0) !== 1) failures.push(`A's Spatial was fetched ${counted.counts.get(A.spatialUrl(1)) || 0} times`);
      const total = [...counted.counts.values()].reduce((x, y) => x + y, 0);
      if (total > 4) failures.push(`${total} requests (A's Spatial and root, B's Spatial and root are 4)`);
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `cycle at depth 2 back to ${cycle.target}; ${total} requests in all` };
    } finally { await closeAll([A, B]); }
  }, {}, [{ name: 'a client with no cycle check', impl: noCycleCheck }]);

  // ---- I8 ---------------------------------------------------------------------------------------------
  const offByOne = { clientEdits: [['    else if (depth > nestingLimit) blocked', '    else if (depth > nestingLimit + 1) blocked']] };
  await run('I8', 'with A\'s nesting limit set to 3, a chain A -> W1 -> W2 -> W3 -> W4 shows W1, W2 and W3, and the fourth level is refused', async (impl) => {
    const chain = await worlds(5, ports, impl);
    try {
      for (let i = 0; i < 4; i += 1) {
        await chain[i].add(1, await chain[i].rootOf(1), [{ label: 'to W' + (i + 1), localTransform: w.translation(3, 0, 0), spatialAssetURI: chain[i + 1].spatialUrl(1) }]);
      }
      const inc = await w.client(impl.clientEdits);
      const c = await inc.composeInclusions(chain[0].spatialUrl(1), { fetch, nestingLimit: 3 });
      const shown = c.graphs.filter((g) => !g.host).map((g) => g.depth);
      const refused = c.inclusions.filter((i) => i.status === 'nesting limit');
      const failures = [];
      if (shown.join(',') !== '1,2,3') failures.push('levels shown: ' + shown.join(','));
      if (refused.length !== 1 || refused[0].depth !== 4 || refused[0].target !== chain[4].spatialUrl(1)) failures.push('refused: ' + JSON.stringify(refused.map((i) => i.depth)));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'levels 1, 2 and 3 shown; level 4 refused (nesting limit)' };
    } finally { await closeAll(chain); }
  }, {}, [{ name: 'a client whose limit lets one more level through', impl: offByOne }]);

  // ---- I8b --------------------------------------------------------------------------------------------
  const repeatsAreCycles = { clientEdits: [['    if (ctx.path.includes(target)) blocked = INCLUSION_STATUS.CYCLE;', '    if (out.inclusions.some((i) => i.target === target && i.status === "included")) blocked = INCLUSION_STATUS.CYCLE;']] };
  const noBudget = { clientEdits: [
    ['    else if (out.graphsUsed >= budget) blocked = INCLUSION_STATUS.OVER_BUDGET;', '    else if (false) blocked = INCLUSION_STATUS.OVER_BUDGET;'],
    ['  function takePlace(inclusion) {\n    if (out.graphsUsed >= budget) {', '  function takePlace(inclusion) {\n    if (false) {'],
  ] };
  const budgetBlocksModels = { clientEdits: [[
    '      const label = await reader.head(target);\n      if (!label || !isModelMediaType(label.type)) return refuse(inclusion, blocked, depth);',
    '      const label = null;\n      if (!label || !isModelMediaType(label.type)) return refuse(inclusion, blocked, depth);',
  ]] };
  const arrivalOrder = { clientEdits: [[
    '    for (const child of Array.isArray(node.children) ? node.children : []) {\n      if (!child || typeof child !== "object") continue; // the canonical Node embeds its children\n      await walk(child, new URL(String(child.id), url).href, record.world, record.graphLocal, ctx, url);\n    }',
    '    await Promise.all((Array.isArray(node.children) ? node.children : []).filter((child) => child && typeof child === "object").map((child) => walk(child, new URL(String(child.id), url).href, record.world, record.graphLocal, ctx, url)));',
  ]] };
  await run('I8b', 'A includes B1-B4, each of those C1-C4, each of those D1-D4 (13 worlds, 84 inclusions): no repeat is a cycle; with a budget of 16, A shows 16 graphs and marks the rest "over budget", the same 16 in three runs whose answers arrive in different orders; a model inside a shown graph still loads, since only graphs take places', async (impl) => {
    const models = await w.modelHost(ports.next());
    const all = await worlds(13, ports, impl);
    const [A, ...rest] = all;
    const Bs = rest.slice(0, 4);
    const Cs = rest.slice(4, 8);
    const Ds = rest.slice(8, 12);
    try {
      const link = async (from, targets, prefix) => from.add(1, await from.rootOf(1), targets.map((t, i) => ({
        label: prefix + (i + 1), localTransform: w.scaled(0.25, i * 2 - 3, 0, 6), spatialAssetURI: t.spatialUrl(1),
      })));
      await link(A, Bs, 'B');
      for (const b of Bs) await link(b, Cs, 'C');
      for (const c of Cs) await link(c, Ds, 'D');
      for (const d of Ds) await d.add(1, await d.rootOf(1), [{ label: 'cube', localTransform: w.IDENTITY, spatialAssetURI: models.url('/models/cube.gltf') }]);
      const inc = await w.client(impl.clientEdits);
      const failures = [];

      const full = await inc.composeInclusions(A.spatialUrl(1), { fetch, budget: 1000, nestingLimit: 3 });
      const worldsSeen = new Set([A.spatialUrl(1), ...full.graphs.map((g) => g.url)]);
      const graphLinks = (c) => c.inclusions.filter((i) => i.status !== 'model');
      if (graphLinks(full).length !== 84) failures.push(`with no budget, ${graphLinks(full).length} inclusions were met (84 expected)`);
      if (worldsSeen.size !== 13) failures.push(`${worldsSeen.size} worlds seen (13 expected)`);
      if (full.cycles.length) failures.push(`${full.cycles.length} repeats reported as cycles`);

      const shownIn = [];
      for (const seed of [1, 2, 3]) {
        const c = await inc.composeInclusions(A.spatialUrl(1), { fetch: w.jitteryFetch(seed, 25), budget: 16, nestingLimit: 3 });
        const shown = c.graphs.filter((g) => !g.host).map((g) => g.via + ' -> ' + g.url);
        const over = c.inclusions.filter((i) => i.status === 'over budget');
        if (shown.length !== 16) failures.push(`run ${seed}: ${shown.length} graphs shown`);
        if (!over.length) failures.push(`run ${seed}: nothing marked over budget`);
        if (c.inclusions.some((i) => !['included', 'over budget', 'model'].includes(i.status))) failures.push(`run ${seed}: other statuses met`);
        // Every model link inside a shown graph loads as a model, the last shown graph's included.
        const shownDs = c.graphs.filter((g) => Ds.some((d) => d.spatialUrl(1) === g.url)).length;
        const modelLinks = c.inclusions.filter((i) => i.status === 'model').length;
        if (modelLinks !== shownDs) failures.push(`run ${seed}: ${modelLinks} of the ${shownDs} shown D graphs' models load`);
        shownIn.push(shown.join('\n'));
        if (seed === 1) shownIn.overCount = over.length;
      }
      if (new Set(shownIn).size !== 1) failures.push('the 16 graphs shown differ between runs');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `84 inclusions over 13 worlds, 0 cycles; budget 16: 16 shown and ${shownIn.overCount} marked over budget, identical in 3 runs` };
    } finally { await closeAll(all); await models.close(); }
  }, {}, [
    { name: 'a client that reports a world seen before as a cycle', impl: repeatsAreCycles },
    { name: 'a client with no budget', impl: noBudget },
    { name: 'a client whose nesting limit and budget also stop models', impl: budgetBlocksModels },
    { name: 'a client that hands out places as answers arrive', impl: arrivalOrder },
  ]);
}

module.exports = { failureChecks };
