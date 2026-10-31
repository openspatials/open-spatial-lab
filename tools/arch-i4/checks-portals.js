'use strict';

/*
 * Iteration 4, going through a portal, and what places a portal, a user and a view.
 *
 *   P1  portal P, placed by node N_P in A, leads to {B}/#join=node.{n}; crossing navigates there and the
 *       client arrives at node n's pose within 1 cm of a plain double-precision reference
 *   P2  with B offline the crossing is refused with the reason, and the visitor stays in A
 *   P7  GET /wow/portal/{id} returns destination and node; User and View return node; each derived
 *       GeoPose, turned back into the graph's frame, is within 1 mm of the node's composed position
 *   P8  a portal with no destination does nothing and says why
 */

const { run } = require('../arch-i1/lib');
const lab = require('./lab');

const { w } = lab;

async function portalChecks(ports) {
  const noParents = { clientEdits: [['      matrix = multiply(localTransformOf(above), matrix);', '      void above;']] };
  const wrongOrder = { clientEdits: [['      matrix = multiply(localTransformOf(above), matrix);', '      matrix = multiply(matrix, localTransformOf(above));']] };
  await run('P1', 'portal P is placed by node N_P in A and leads to {B}/#join=node.{n}; crossing navigates there, and the client arrives at node n\'s pose within 1 cm of a plain double-precision reference', async (impl) => {
    const A = await w.world('a', ports.next());
    const B = await w.world('b', ports.next(), { base: '/w/b' });
    try {
      const { module: portal } = await lab.portalClient(impl.clientEdits);
      const [hall] = await B.add(1, await B.rootOf(1), [{ label: 'hall (turned, scaled, moved)', localTransform: lab.placed(40, 2, -15, 63, 1.5) }]);
      const [n] = await B.add(1, hall, [{ label: 'arrival n', localTransform: lab.placed(3.2, 0, 7.7, -120) }]);
      const [np] = await A.add(1, await A.rootOf(1), [{ label: 'N_P', localTransform: lab.placed(4, 0, -2, 30) }]);
      const destination = B.base + '/#join=node.' + n;
      const added = A.server.built.runtime.addPortal({ node_id: np, destination, label: 'P' });
      const portalUrl = A.base + '/wow/portal/' + added.id;
      const navigated = [];
      const result = await portal.crossPortal(portalUrl, { navigate: (url) => navigated.push(url) });
      const ref = lab.reference({ chains: { n: await lab.chainOf(B, 1, n) } }).positions.n;
      const failures = [];
      if (!result.crossed) failures.push('refused: ' + result.reason);
      if (navigated.length !== 1 || navigated[0] !== destination) failures.push('navigated to ' + JSON.stringify(navigated));
      const at = result.arrival && result.arrival.position;
      const off = at ? lab.distance(at, ref) : Infinity;
      if (!(off <= 0.01)) failures.push(`arrived at ${JSON.stringify(at && at.map((v) => +v.toFixed(4)))}, the reference is ${JSON.stringify(ref.map((v) => +v.toFixed(4)))} (${(off * 1000).toFixed(1)} mm off)`);
      if (result.arrival && result.arrival.node !== B.nodeUrl(1, n)) failures.push('arrived at ' + result.arrival.node);
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `navigated to ${destination}; arrived at node ${n} (${ref.map((v) => v.toFixed(3)).join(', ')}), ${(off * 1000).toFixed(6)} mm from the reference` };
    } finally {
      await A.close();
      await B.close();
    }
  }, {}, [
    { name: 'a client that leaves out the arrival node\'s parents', impl: noParents },
    { name: 'a client that multiplies the parents in the wrong order', impl: wrongOrder },
  ]);

  const noCheck = { clientEdits: [['  try {\n    await readJson(new URL("wow/world", destination.base).href, opts);\n  } catch (error) {', '  try {\n    void 0;\n  } catch (error) {']] };
  await run('P2', 'with B offline, crossing A\'s portal to B is refused with the reason, nothing navigates, and the visitor stays in A', async (impl) => {
    const A = await w.world('a', ports.next());
    const B = await w.world('b', ports.next(), { base: '/w/b' });
    const bBase = B.base + '/';
    try {
      const { module: portal } = await lab.portalClient(impl.clientEdits);
      const [np] = await A.add(1, await A.rootOf(1), [{ label: 'N_P', localTransform: lab.placed(1, 0, 1) }]);
      const added = A.server.built.runtime.addPortal({ node_id: np, destination: bBase, label: 'to B' });
      await B.close();
      const navigated = [];
      const result = await portal.crossPortal(A.base + '/wow/portal/' + added.id, { navigate: (url) => navigated.push(url) });
      const failures = [];
      if (result.crossed) failures.push('the crossing went ahead');
      if (navigated.length) failures.push('navigated to ' + navigated[0]);
      if (!/destination offline/.test(result.reason || '')) failures.push('reason given: ' + JSON.stringify(result.reason));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `refused, no navigation; reason: "${result.reason}"` };
    } finally {
      await A.close();
    }
  }, {}, [{ name: 'a client that navigates without checking that the destination answers', impl: noCheck }]);

  const ownTransformOnly = { serverEdits: { portalStandard: [['        m = m ? multiplyMatrices(local, m) : local.slice();', '        m = m || local.slice();']] } };
  const userWithoutNode = { serverEdits: { runtime: [['                // the node that places the user, and the GeoPose derived from it\n                ...(placed != null ? { node : nodeRef(spatialStore, placed) } : {}),', '']] } };
  const portalWithoutDestination = { serverEdits: { portalStandard: [['                ...(added.destination ? { destination : added.destination } : {}),', '']] } };
  await run('P7', 'GET /wow/portal/{id} returns destination and node; User and View return node too; in an anchored graph each derived GeoPose, turned back by EPSG 9837, lies within 1 mm of its node\'s composed position (plain double-precision reference)', async (impl) => {
    const A = await w.world('a', ports.next(), { edits: impl.serverEdits });
    try {
      const failures = [];
      const [frame] = await A.add(1, await A.rootOf(1), [{ label: 'frame (turned, moved)', localTransform: lab.placed(-12, 1, 30, 145, 2) }]);
      const [np] = await A.add(1, frame, [{ label: 'N_P', localTransform: lab.placed(6, 0, -4, 20) }]);
      const destination = 'http://127.0.0.1:1/somewhere/#join=node.7';
      const added = A.server.built.runtime.addPortal({ node_id: np, destination, label: 'placed portal' });
      await lab.join(A, 'p7-visitor');
      const visitor = await lab.getWow(A, '/wow/user/p7-visitor');
      const resources = {
        'portal (added)': (await lab.getWow(A, '/wow/portal/' + added.id)).json,
        'portal 1 (demo)': (await lab.getWow(A, '/wow/portal/1')).json,
        'user 1': (await lab.getWow(A, '/wow/user/1')).json,
        'view 1': (await lab.getWow(A, '/wow/view/1')).json,
      };
      if (visitor.status === 200) resources[`user ${visitor.json.id} (presence)`] = visitor.json;
      else failures.push('the joined visitor has no User resource (' + visitor.status + ')');
      const added_ = resources['portal (added)'];
      if (added_.destination !== destination) failures.push('the portal\'s destination is ' + JSON.stringify(added_.destination));
      if (added_.node !== 'wow/spatial/1/node/' + np) failures.push('the portal\'s node is ' + JSON.stringify(added_.node));
      const anchor = (await lab.getWow(A, '/wow/spatial/1')).json.geoPose;
      if (!anchor || anchor.angles.yaw || anchor.angles.pitch || anchor.angles.roll) failures.push('graph 1\'s anchor has angles; the reference handles zero angles only');
      const chains = {};
      const geoposes = {};
      for (const [name, resource] of Object.entries(resources)) {
        const match = /^wow\/spatial\/(\d+)\/node\/(\d+)$/.exec(resource && resource.node || '');
        if (!match) { failures.push(`${name} names no node (${JSON.stringify(resource && resource.node)})`); continue; }
        if (!resource.geoPose) { failures.push(`${name} has no GeoPose`); continue; }
        chains[name] = await lab.chainOf(A, Number(match[1]), Number(match[2]));
        geoposes[name] = resource.geoPose.position;
      }
      const ref = lab.reference({ anchor: anchor && anchor.position, chains, geoposes });
      const worst = { name: null, mm: 0 };
      for (const name of Object.keys(chains)) {
        const mm = lab.distance(ref.positions[name], ref.back[name]) * 1000;
        if (mm > worst.mm) Object.assign(worst, { name, mm });
        if (!(mm <= 1)) failures.push(`${name}: its GeoPose is ${mm.toFixed(3)} mm from its node's position`);
      }
      await lab.leave(A, 'p7-visitor');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `${Object.keys(chains).length} resources name their node (${Object.keys(chains).join(', ')}); largest GeoPose offset ${worst.mm.toFixed(4)} mm (${worst.name})` };
    } finally {
      await A.close();
    }
  }, {}, [
    { name: 'a server that derives a GeoPose from the node\'s own transform, not its placement', impl: ownTransformOnly },
    { name: 'a server whose User names no node', impl: userWithoutNode },
    { name: 'a server whose added portal loses its destination', impl: portalWithoutDestination },
  ]);

  const crossesAnyway = { clientEdits: [['    return { crossed: false, reason: REFUSAL.NO_DESTINATION };\n  }\n  let destination;', '    if (opts.navigate) opts.navigate("");\n    return { crossed: true };\n  }\n  let destination;']] };
  await run('P8', 'a portal with no destination does nothing: crossing it navigates nowhere and says why, its preview says why, and nothing is requested beyond A', async (impl) => {
    const A = await w.world('a', ports.next());
    try {
      const { module: portal } = await lab.portalClient(impl.clientEdits);
      const [np] = await A.add(1, await A.rootOf(1), [{ label: 'N_P', localTransform: lab.placed(1, 0, 1) }]);
      const added = A.server.built.runtime.addPortal({ node_id: np, label: 'nowhere' });
      const resource = (await lab.getWow(A, '/wow/portal/' + added.id)).json;
      const asked = [];
      const navigated = [];
      const result = await portal.crossPortal(resource, { navigate: (url) => navigated.push(url), onRequest: (url) => asked.push(url) });
      const preview = await portal.previewOf(resource, { onRequest: (url) => asked.push(url) });
      const failures = [];
      if ('destination' in resource) failures.push('the resource has a destination: ' + JSON.stringify(resource.destination));
      if (result.crossed || navigated.length) failures.push('it crossed (navigated to ' + JSON.stringify(navigated) + ')');
      if (!/no destination/.test(result.reason || '')) failures.push('reason given: ' + JSON.stringify(result.reason));
      if (preview.kind !== 'none' || !/no destination/.test(preview.reason || '')) failures.push('preview: ' + JSON.stringify(preview));
      if (asked.length) failures.push('requested ' + asked.join(', '));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `no navigation, no request; reason: "${result.reason}"; preview: none` };
    } finally {
      await A.close();
    }
  }, {}, [{ name: 'a client that crosses a portal with no destination', impl: crossesAnyway }]);
}

module.exports = { portalChecks };
