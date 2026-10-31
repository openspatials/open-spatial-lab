'use strict';

/*
 * Iteration 4, the contribution to the Web of Worlds files.
 *
 *   W1  the iteration 4 patch applies to the World API at main after iterations 1 to 3, and the patched
 *       World API passes the OpenAPI 3.0 schema, declares every path parameter and resolves every $ref
 *   W2  the text offered, the lab's contract (wow-spec/schema.yaml) and what the world server does on the
 *       wire say the same thing
 */

const path = require('path');
const { ROOT, run } = require('../arch-i1/lib');
const up = require('../arch-i1/upstream');
const { openApiValidator } = require('../arch-i2/checks-overlay');
const { loadIteration3 } = require('../arch-i3/checks-overlay');
const lab = require('./lab');

const OVERLAY_4 = path.join(ROOT, 'wow-spec', 'overlays', 'iteration-4');
const PARAGRAPHS = ['Portals.'];

/** The World API with iterations 1 to 4 applied; `edits` may change the iteration 4 patch first. */
function loadIteration4(edits) {
  edits = edits || {};
  const three = loadIteration3();
  let patch = up.read(path.join(OVERLAY_4, 'OpenSpatialWorld.API.yaml.patch'));
  if (edits['OpenSpatialWorld.API.yaml.patch']) patch = edits['OpenSpatialWorld.API.yaml.patch'](patch);
  const worldText = up.applyUnifiedDiff(three.worldText, patch);
  return { world: up.yaml.load(worldText), worldText };
}

/** What iteration 4 says, read from one API description. */
function iteration4Text(doc) {
  const canon = (n) => JSON.parse(JSON.stringify(up.withoutLabels(n), (k, v) => (k === 'description' && typeof v === 'string' ? up.squash(v) : v)));
  const schemas = doc.components.schemas;
  const paragraphs = String((doc.info || {}).description || '').split(/\n\s*\n/).map(up.squash);
  return {
    portalDestination: canon(schemas.Portal.properties.destination),
    portalNode: canon(schemas.Portal.properties.node),
    userNode: canon(schemas.User.properties.node),
    viewNode: canon(schemas.View.properties.node),
    worldPreview: canon(schemas.World.properties.preview),
    paragraphs: PARAGRAPHS.map((start) => paragraphs.find((p) => p.startsWith(start)) || null),
  };
}

async function overlayChecks(ports) {
  const staleContext = { edits: { 'OpenSpatialWorld.API.yaml.patch': (p) => p.replace('-    Data points. A data point is a resource URL', '-    Data points. A data point is the resource URL') } };
  const badType = { edits: { 'OpenSpatialWorld.API.yaml.patch': (p) => p.replace('+        destination:\n+          type: string\n', '+        destination:\n+          type: url\n') } };
  await run('W1', 'the iteration 4 patch applies to the World API at main after iterations 1 to 3, and the patched World API passes the OpenAPI 3.0 schema with every path parameter declared and every $ref resolving', async (impl) => {
    const failures = [];
    const out = loadIteration4(impl.edits);
    const validate = openApiValidator();
    if (!validate(out.world)) failures.push('OpenAPI 3.0 schema: ' + validate.errors.slice(0, 2).map((e) => e.instancePath + ' ' + e.message).join('; '));
    const params = up.pathParameterProblems(out.world);
    if (params.length) failures.push(params[0]);
    const refs = up.refProblems(out.world);
    if (refs.length) failures.push(refs[0]);
    const text = iteration4Text(out.world);
    for (const [key, value] of Object.entries(text)) if (!value || (Array.isArray(value) && value.some((x) => !x))) failures.push(key + ' is missing');
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'the patch applies after iterations 1 to 3; the World API passes the OpenAPI 3.0 schema with no path parameter or $ref problem; Portal.destination, Portal.node, User.node, View.node, World.preview and the portals paragraph are there' };
  }, {}, [
    { name: 'a patch whose context no longer matches iteration 3\'s text', impl: staleContext },
    { name: 'a patch that is not valid OpenAPI (type: url)', impl: badType },
  ]);

  const offerDrifts = { edits: { 'OpenSpatialWorld.API.yaml.patch': (p) => p.replace('+            world\'s nodes within the radius of the arrival node, each relative to it, and only those the', '+            world\'s nodes within the radius of the arrival node, and only those the') } };
  const viewWithoutNode = { serverEdits: { runtime: [['            id : WOW_PLAYER_VIEW_ID, // number, per WoW View schema\n            ...(placed != null ? { node : nodeRef(spatialStore, placed) } : {}),', '            id : WOW_PLAYER_VIEW_ID, // number, per WoW View schema']] } };
  await run('W2', 'the offered text and the lab\'s contract agree on Portal.destination, Portal.node, User.node, View.node, World.preview and the portals paragraph; on the wire a portal carries destination and node, the user and the view carry node, the World declares its preview, and the preview URL returns a Node tree', async (impl) => {
    const failures = [];
    const a = iteration4Text(loadIteration4(impl.edits).world);
    const b = iteration4Text(up.yaml.load(up.read(path.join(ROOT, 'wow-spec', 'schema.yaml'))));
    for (const key of Object.keys(a)) if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) failures.push(key + ' differs between the offer and the lab contract');
    const A = await lab.w.world('a', ports.next(), { edits: impl.serverEdits });
    try {
      const [np] = await A.add(1, await A.rootOf(1), [{ label: 'N_P', localTransform: lab.placed(1, 0, 1) }]);
      const added = A.server.built.runtime.addPortal({ node_id: np, destination: 'http://127.0.0.1:1/w/x/#join=node.3', label: 'P' });
      A.server.built.runtime.setPreview({ node_id: np, radius_m: 10 });
      const portal = (await lab.getWow(A, '/wow/portal/' + added.id)).json;
      const user = (await lab.getWow(A, '/wow/user/1')).json;
      const view = (await lab.getWow(A, '/wow/view/1')).json;
      const world = await lab.worldDoc(A);
      const preview = await lab.getWow(A, '/' + (world.preview && world.preview.url));
      if (typeof portal.destination !== 'string' || portal.node !== 'wow/spatial/1/node/' + np) failures.push('the portal: ' + JSON.stringify({ destination: portal.destination, node: portal.node }));
      if (typeof user.node !== 'string') failures.push('the user has no node');
      if (typeof view.node !== 'string') failures.push('the view has no node');
      if (!world.preview || world.preview.node !== 'wow/spatial/1/node/' + np || world.preview.radius_m !== 10) failures.push('the World declares ' + JSON.stringify(world.preview));
      if (preview.status !== 200 || preview.json.id !== np || !Array.isArray(preview.json.children)) failures.push('the preview URL answered ' + preview.status);
    } finally {
      await A.close();
    }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'offer = lab contract on 6 points; on the wire: the portal\'s destination and node, the user\'s and the view\'s node, World.preview, and a Node tree at the preview URL' };
  }, {}, [
    { name: 'an offer whose preview text drifted from the contract', impl: offerDrifts },
    { name: 'a server whose View names no node', impl: viewWithoutNode },
  ]);
}

module.exports = { overlayChecks, loadIteration4 };
