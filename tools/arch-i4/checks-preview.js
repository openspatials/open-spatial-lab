'use strict';

/*
 * Iteration 4, previews: the destination decides what a portal shows.
 *
 *   P3  B declares a preview (arrival node n, 10 m, a preview URL); the preview URL holds only B's nodes
 *       within 10 m of n (a plain reference picks the same set); A's portal shows exactly those, and
 *       fetches no other node of B
 *   P4  a portal inside the preview shows closed, and its destination is never read
 *   P5  a declared preview image is shown; with no declaration, a plain colour
 *   P6  previewing creates no user in B
 */

const { run } = require('../arch-i1/lib');
const lab = require('./lab');

const { w } = lab;

/** Worlds A, B and C: A's portal leads to B at node n; B declares a preview; B's own portal (near n) leads to C. */
async function previewScene(ports, impl) {
  const A = await w.world('a', ports.next(), { edits: impl.serverEdits });
  const B = await w.world('b', ports.next(), { base: '/w/b', edits: impl.serverEdits });
  const C = await w.world('b', ports.next(), { base: '/w/c' });
  const [hall, outside] = await B.add(1, await B.rootOf(1), [
    { label: 'hall', localTransform: lab.placed(60, 0, 20, 90) },
    { label: 'outside, 60 m away', localTransform: lab.placed(0, 0, 20) },
  ]);
  const [n] = await B.add(1, hall, [{ label: 'arrival n', localTransform: lab.placed(2, 0, 1, 45) }]);
  // Distances from n: 3 m, 9.5 m, 10.5 m (outside), and a child of a node outside the radius that is itself inside.
  const [near, edge, beyond] = await B.add(1, n, [
    { label: 'near (3 m)', localTransform: lab.placed(3, 0, 0) },
    { label: 'edge (9.5 m)', localTransform: lab.placed(0, 0, 9.5) },
    { label: 'beyond (10.5 m)', localTransform: lab.placed(-10.5, 0, 0) },
  ]);
  const [back] = await B.add(1, beyond, [{ label: 'back inside (child of beyond, 2.5 m from n)', localTransform: lab.placed(8, 0, 0) }]);
  const [innerPortalNode] = await B.add(1, n, [{ label: 'B portal (4 m)', localTransform: lab.placed(0, 0, -4) }]);
  B.server.built.runtime.addPortal({ node_id: innerPortalNode, destination: C.base + '/', label: 'B to C' });
  B.server.built.runtime.setPreview({ node_id: n, radius_m: 10 });
  const [np] = await A.add(1, await A.rootOf(1), [{ label: 'N_P', localTransform: lab.placed(1, 0, 1) }]);
  const added = A.server.built.runtime.addPortal({ node_id: np, destination: B.base + '/#join=node.' + n, label: 'to B' });
  const portal = (await lab.getWow(A, '/wow/portal/' + added.id)).json;
  return { A, B, C, n, ids: { hall, outside, near, edge, beyond, back, innerPortalNode }, portal, async close() { await A.close(); await B.close(); await C.close(); } };
}

async function previewChecks(ports) {
  const everyNode = { serverEdits: { portalStandard: [['                if (distance > d.radius_m) continue;\n', '']] } };
  const readsTheGraph = { clientEdits: [['    const tree = await readJson(new URL(declared.url, destination.base).href, opts);', '    await readJson(new URL("wow/spatial/1/node/" + /node\\/(\\d+)/.exec(declared.node)[1], destination.base).href, opts);\n    const tree = await readJson(new URL(declared.url, destination.base).href, opts);']] };
  await run('P3', 'B\'s World declares a preview (arrival node n, 10 m, a preview URL); the preview URL returns only B\'s nodes within 10 m of n, the set a plain reference picks; A\'s portal shows exactly those nodes and fetches no other node of B', async (impl) => {
    const s = await previewScene(ports, impl);
    try {
      const { module: portal } = await lab.portalClient(impl.clientEdits);
      const failures = [];
      const declared = (await lab.worldDoc(s.B)).preview || {};
      if (declared.node !== 'wow/spatial/1/node/' + s.n || declared.radius_m !== 10 || !declared.url) failures.push('B declares ' + JSON.stringify(declared));
      const expected = await lab.withinRadius(s.B, 1, s.n, 10);
      const served = (await lab.getWow(s.B, '/wow/preview')).json;
      const servedIds = [served.id, ...(served.children || []).map((c) => c.id)].sort((a, b) => a - b);
      if (JSON.stringify(servedIds) !== JSON.stringify(expected)) failures.push(`the preview URL holds ${JSON.stringify(servedIds)}, the reference ${JSON.stringify(expected)}`);
      const log = lab.requestLog(s.B);
      const shown = await portal.previewOf(s.portal);
      log.stop();
      const shownIds = (shown.nodes || []).map((x) => x.id).sort((a, b) => a - b);
      if (shown.kind !== 'nodes' || JSON.stringify(shownIds) !== JSON.stringify(expected)) failures.push(`A shows ${shown.kind} ${JSON.stringify(shownIds)}`);
      const nodeReads = log.log.filter((r) => /\/node\//.test(r.url));
      if (nodeReads.length) failures.push('A read B\'s nodes: ' + nodeReads.map((r) => r.url).join(', '));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `${expected.length} of ${(await lab.allNodes(s.B, 1)).length} nodes of B lie within 10 m of n (among them one at 9.5 m and a child of a node outside the radius; not the one at 10.5 m); A showed exactly those after ${log.log.length} requests to B, none to a node` };
    } finally {
      await s.close();
    }
  }, {}, [
    { name: 'a preview URL that returns every node of the graph', impl: everyNode },
    { name: 'a client that reads B\'s graph instead of only its preview', impl: readsTheGraph },
  ]);

  const opensInnerPortals = { clientEdits: [['      closed: closedIds.has(Number(n.id)),', '      closed: false,']] };
  await run('P4', 'a portal inside the preview shows closed, and the preview reads nothing of the world it leads to', async (impl) => {
    const s = await previewScene(ports, impl);
    try {
      const { module: portal } = await lab.portalClient(impl.clientEdits);
      const logC = lab.requestLog(s.C);
      const shown = await portal.previewOf(s.portal);
      logC.stop();
      const inner = (shown.nodes || []).find((x) => x.id === s.ids.innerPortalNode);
      const others = (shown.nodes || []).filter((x) => x.id !== s.ids.innerPortalNode && x.closed);
      const failures = [];
      if (!inner) failures.push('the inner portal is not in the preview');
      else if (inner.closed !== true) failures.push('the inner portal shows open');
      if (others.length) failures.push('closed: ' + others.map((x) => x.label).join(', '));
      if (logC.log.length) failures.push('C was asked: ' + logC.log.map((r) => r.url).join(', '));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `B's portal (node ${s.ids.innerPortalNode}) shows closed; no other node closed; C received no request` };
    } finally {
      await s.close();
    }
  }, {}, [{ name: 'a client that shows portals inside a preview open', impl: opensInnerPortals }]);

  const ignoresImage = { clientEdits: [['  if (declared && declared.image) return', '  if (false && declared && declared.image) return']] };
  await run('P5', 'a destination that declares a preview image shows that image; one that declares no preview shows a plain colour', async (impl) => {
    const A = await w.world('a', ports.next());
    const withImage = await w.world('b', ports.next(), { base: '/w/b' });
    const plain = await w.world('b', ports.next(), { base: '/w/p' });
    try {
      const { module: portal } = await lab.portalClient(impl.clientEdits);
      withImage.server.built.runtime.setPreview({ image: 'images/preview.jpg' });
      const failures = [];
      if ((await lab.worldDoc(withImage)).preview?.image !== 'images/preview.jpg') failures.push('the image is not declared');
      if ((await lab.worldDoc(plain)).preview !== undefined) failures.push('the plain world declares a preview');
      const image = await portal.previewOf({ destination: withImage.base + '/' });
      const color = await portal.previewOf({ destination: plain.base + '/' });
      const imageUrl = withImage.base + '/images/preview.jpg';
      if (image.kind !== 'image' || image.image !== imageUrl) failures.push('with an image: ' + JSON.stringify(image));
      if (color.kind !== 'color' || !/^#[0-9a-f]{6}$/i.test(color.color || '')) failures.push('with nothing: ' + JSON.stringify(color));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `image ${image.image}; plain colour ${color.color}` };
    } finally {
      await A.close();
      await withImage.close();
      await plain.close();
    }
  }, {}, [{ name: 'a client that ignores the preview image', impl: ignoresImage }]);

  const joinsToPreview = { clientEdits: [['  let world;\n  try { world = await readJson(new URL("wow/world", destination.base).href, opts); } catch (error) {\n    return { kind: "unreachable"', '  await (opts.fetch || globalThis.fetch)(new URL("fabric/presence/register", destination.base).href, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player_id: "previewer", display_name: "previewer", avatar_id: "previewer" }) });\n  let world;\n  try { world = await readJson(new URL("wow/world", destination.base).href, opts); } catch (error) {\n    return { kind: "unreachable"']] };
  await run('P6', 'previewing B creates no user in B: the user counts stay as they were and B announces no user_joined', async (impl) => {
    const s = await previewScene(ports, impl);
    const stream = await lab.rawStream(s.B.port, '/w/b/events');
    try {
      const { module: portal } = await lab.portalClient(impl.clientEdits);
      await lab.until(() => stream.messages.some((f) => f.type === 'hello'), 5000, 'B\'s stream');
      const before = (await lab.worldDoc(s.B)).users;
      for (let i = 0; i < 3; i += 1) await portal.previewOf(s.portal);
      await lab.sleep(300);
      const after = (await lab.worldDoc(s.B)).users;
      const joined = stream.messages.filter((f) => f.type === 'user_joined');
      const failures = [];
      if (after.active_user_count !== before.active_user_count || after.total_user_count !== before.total_user_count) failures.push(`users went from ${JSON.stringify(before)} to ${JSON.stringify(after)}`);
      if (joined.length) failures.push(joined.length + ' user_joined events');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `three previews: active users ${after.active_user_count}, total ${after.total_user_count}, as before; no user_joined` };
    } finally {
      stream.close();
      await s.close();
    }
  }, {}, [{ name: 'a client that joins the destination to preview it', impl: joinsToPreview }]);
}

module.exports = { previewChecks };
