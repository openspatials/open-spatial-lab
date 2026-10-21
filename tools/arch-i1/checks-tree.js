'use strict';

/*
 * Iteration 1, the node tree: N1 (moves), N2 (children are derived), N3 (ids are never reused) and
 * N5 (every node URL resolves and is its own). Each check boots its own world server on a fresh
 * folder, real or mutated, so the checks cannot leak state into one another.
 */

const { run } = require('./lib');
const { boot } = require('./harness');
const { graphApi, GRAPH_IDS, IDENTITY, translation } = require('./api');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function treeChecks(ports) {
  const server = (impl, role) => boot(role || 'a', ports.next(), { edits: impl && impl.edits ? impl.edits : null });

  // ---- N1. Moves ------------------------------------------------------------------------------------
  const ignoresParent = { store: [["const move = 'parent' in r ? planMove(id, existing, r.parent) : { ok : true, to : null };", 'const move = { ok : true, to : null };']] };
  const allowsCycles = { store: [['            if (cursor === id)\n                return { ok : false, status : 422, error : \'parent_would_create_cycle\',', '            if (false)\n                return { ok : false, status : 422, error : \'parent_would_create_cycle\',']] };
  const keepsOldLink = { store: [['                oldParent.children = oldParent.children.filter(c => c !== id);\n            const newParent', '                void 0;\n            const newParent']] };
  await run('N1', 'a PUT of parent moves a node with its subtree and keeps its id; a cycle, a missing parent and moving the root are 422; the root cannot be deleted', async (impl) => {
    const s = await server(impl);
    try {
      const api = graphApi(s.port, GRAPH_IDS.a);
      const p = await api.make(0, 'n1-p');
      const q = await api.make(0, 'n1-q');
      const c = await api.make(p, 'n1-c', translation(1, 0, 0));
      const d = await api.make(c, 'n1-d', translation(0, 2, 0));
      const failures = [];
      const moved = await api.update(c, { parent: q });
      if (moved.status !== 200 || moved.json.parent !== q || moved.json.id !== c) failures.push('move: ' + moved.status + ' ' + moved.body.slice(0, 100));
      const [pAfter, qAfter, cAfter, dAfter] = await Promise.all([p, q, c, d].map((id) => api.node(id)));
      if (pAfter.json.children.includes(c)) failures.push('the old parent still lists the node');
      if (!qAfter.json.children.includes(c)) failures.push('the new parent does not list the node');
      if (cAfter.json.parent !== q || !same(cAfter.json.children, [d]) || dAfter.json.parent !== c) failures.push('the node or its subtree changed');
      if (!same(cAfter.json.localTransform, translation(1, 0, 0))) failures.push('the local transform changed');
      const refusals = [
        ['under itself', () => api.update(c, { parent: c })],
        ['under its own descendant', () => api.update(c, { parent: d })],
        ['to a parent that does not exist', () => api.update(c, { parent: 99999 })],
        ['to a parent that is not an integer', () => api.update(c, { parent: 'q' })],
        ['the root', () => api.update(0, { parent: q })],
      ];
      for (const [name, send] of refusals) {
        const r = await send();
        if (r.status !== 422) failures.push(name + ': status ' + r.status + ', wanted 422');
      }
      const still = await api.node(c);
      if (still.json.parent !== q) failures.push('a refused move changed the node');
      const del = await api.remove(0);
      if (del.status !== 400 || !del.json || del.json.error !== 'cannot_delete_root') failures.push('delete root: ' + del.status);
      const echo = await api.update(c, { parent: q, label: 'n1-c-renamed' });
      if (echo.status !== 200 || echo.json.label !== 'n1-c-renamed') failures.push('a PUT that repeats the parent: ' + echo.status);
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'moved with its subtree; 5 refusals; the root stays' };
    } finally { await s.close(); }
  }, { edits: null }, [
    { name: 'a store whose PUT ignores parent (today\'s behaviour)', impl: { edits: ignoresParent } },
    { name: 'a store that allows a node under its own descendant', impl: { edits: allowsCycles } },
    { name: 'a move that leaves the node listed under its old parent', impl: { edits: keepsOldLink } },
  ]);

  // ---- N2. Children are derived -------------------------------------------------------------------
  const appliesChildren = { store: [['            if (!echo)\n            {\n                if (c.embedded.length)', '            if (false)\n            {\n                if (c.embedded.length)']] };
  await run('N2', 'a PUT without children leaves them unchanged, a PUT that repeats them is accepted, and a PUT whose children differ is 422', async (impl) => {
    const s = await server(impl);
    try {
      const api = graphApi(s.port, GRAPH_IDS.a);
      const p = await api.make(0, 'n2-p');
      const a = await api.make(p, 'n2-a');
      const b = await api.make(p, 'n2-b');
      const failures = [];
      const label = await api.update(p, { label: 'n2-p-renamed' });
      if (label.status !== 200 || !same(label.json.children, [a, b])) failures.push('a PUT without children changed them: ' + label.status);
      const echo = await api.update(p, { label: 'n2-p-again', children: [a, b] });
      if (echo.status !== 200) failures.push('a PUT that repeats children: ' + echo.status);
      const differing = [
        ['fewer children', [a]],
        ['reordered children', [b, a]],
        ['an added child', [a, b, 99999]],
        ['no children', []],
      ];
      for (const [name, children] of differing) {
        const r = await api.update(p, { children });
        if (r.status !== 422) failures.push(name + ': status ' + r.status + ', wanted 422');
      }
      const after = await api.node(p);
      if (!same(after.json.children, [a, b])) failures.push('a refused PUT changed the children: ' + JSON.stringify(after.json.children));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'unchanged without children; repeated children accepted; 4 differing bodies refused' };
    } finally { await s.close(); }
  }, { edits: null }, [{ name: 'a store that lets a PUT through with different children', impl: { edits: appliesChildren } }]);

  // ---- N3. Ids are never reused -------------------------------------------------------------------
  const resetsCounter = { store: [
    ['const id = Math.max(nextId, highWater + 1);', 'const id = nextId;'],
    ['        nextId = highWater + 1;\n    }', '        nextId = seedId + 1;\n    }'],
  ] };
  await run('N3', 'a deleted id answers 404 and is never issued again: not after other creates, not after POST /reset, not after a restart', async (impl) => {
    const first = await server(impl);
    const dir = first.dir;
    const failures = [];
    const everIssued = [];
    let api = graphApi(first.port, GRAPH_IDS.a);
    let second = null;
    try {
      const a = await api.make(0, 'n3-a');
      const b = await api.make(0, 'n3-b');
      const c = await api.make(b, 'n3-c');
      everIssued.push(a, b, c);
      const del = await api.remove(b); // removes b and its child c
      if (del.status !== 200) failures.push('delete: ' + del.status);
      for (const id of [b, c]) if ((await api.node(id)).status !== 404) failures.push('deleted node ' + id + ' still resolves');
      const d = await api.make(0, 'n3-d');
      if (everIssued.includes(d) || d <= Math.max(...everIssued)) failures.push('create after delete reused or went below an earlier id: ' + d);
      everIssued.push(d);

      const reset = await api.reset();
      if (reset.status !== 200) failures.push('reset: ' + reset.status);
      for (const id of everIssued) if ((await api.node(id)).status !== 404) failures.push('node ' + id + ' survived POST /reset');
      const e = await api.make(0, 'n3-e');
      if (everIssued.includes(e) || e <= Math.max(...everIssued)) failures.push('create after reset reused or went below an earlier id: ' + e);
      everIssued.push(e);

      await first.close();
      second = await boot('a', ports.next(), { edits: impl && impl.edits, dir });
      api = graphApi(second.port, GRAPH_IDS.a);
      for (const id of everIssued) if ((await api.node(id)).status !== 404) failures.push('node ' + id + ' came back after a restart');
      const f = await api.make(0, 'n3-f');
      if (everIssued.includes(f) || f <= Math.max(...everIssued)) failures.push('create after restart reused or went below an earlier id: ' + f);
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `ids ${everIssued.join(', ')} then ${f}: none came back after delete, reset or restart` };
    } finally {
      await first.close();
      if (second) await second.close();
    }
  }, { edits: null }, [{ name: 'a store whose id counter starts over on reset and restart (today\'s behaviour)', impl: { edits: resetsCounter } }]);

  // ---- N5. Every node URL resolves, and no two nodes share one ----------------------------------------
  await run('N5', 'walking the graph by node URL reaches every node once, each URL returns its own node, and parent links agree with children lists', async (impl) => {
    const s = await server(impl);
    try {
      const api = graphApi(s.port, GRAPH_IDS.a);
      const p = await api.make(0, 'n5-p');
      const q = await api.make(0, 'n5-q');
      const c = await api.make(p, 'n5-c');
      await api.make(c, 'n5-d');
      await api.update(c, { parent: q }); // a move must not break the tree
      const { nodes, problems } = await api.walk(0);
      const ids = [...nodes.keys()];
      const failures = problems.slice();
      if (new Set(ids).size !== ids.length) failures.push('duplicate ids');
      const world = await require('./lib').httpReq('GET', s.port, '/wow/world');
      const expected = (await require('./lib').httpReq('GET', s.port, '/demo/scene-objects')).json.objects.length + world.json.portals.portal_count + 1 + 4;
      if (nodes.size !== expected) failures.push('the walk found ' + nodes.size + ' nodes; the graph holds ' + expected);
      return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 4).join('; ') : `${nodes.size} nodes, each reached once through its own URL` };
    } finally { await s.close(); }
  }, { edits: null }, [{ name: 'a move that leaves the node listed under its old parent', impl: { edits: keepsOldLink } }]);
}

module.exports = { treeChecks };
