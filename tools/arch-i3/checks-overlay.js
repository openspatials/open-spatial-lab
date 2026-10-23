'use strict';

/*
 * Iteration 3, the contribution to the Web of Worlds files.
 *
 *   W1  the iteration 3 patches apply to the Web of Worlds files at main after iterations 1 and 2 (World
 *       API, README, and a new context.jsonld), and the patched World API passes the OpenAPI 3.0 schema,
 *       declares every path parameter and resolves every $ref
 *   W2  the text offered, the lab's contract (wow-spec/schema.yaml and its served context) and what the
 *       world server does on the wire say the same thing
 */

const fs = require('fs');
const path = require('path');
const { ROOT, run } = require('../arch-i1/lib');
const up = require('../arch-i1/upstream');
const { loadIteration2, openApiValidator } = require('../arch-i2/checks-overlay');
const lab = require('./lab');

const OVERLAY_3 = path.join(ROOT, 'wow-spec', 'overlays', 'iteration-3');
const PARAGRAPHS = ['Events.', 'Stream authentication.', 'Data points.'];

function loadIteration3(edits) {
  edits = edits || {};
  const two = loadIteration2();
  const patch = (name, original) => {
    let text = up.read(path.join(OVERLAY_3, name));
    if (edits[name]) text = edits[name](text);
    return up.applyUnifiedDiff(original, text);
  };
  const worldText = patch('OpenSpatialWorld.API.yaml.patch', two.worldText);
  return {
    world: up.yaml.load(worldText),
    worldText,
    readme: patch('OpenSpatialWorld.README.md.patch', two.readme),
    context: JSON.parse(patch('OpenSpatialWorld.context.jsonld.patch', '')),
  };
}

/** What iteration 3 says, read from one API description. */
function iteration3Text(doc) {
  const canon = (n) => JSON.parse(JSON.stringify(up.withoutLabels(n), (k, v) => (k === 'description' && typeof v === 'string' ? up.squash(v) : v)));
  // A paragraph ends at a blank line, so paragraphs a later iteration adds after these are not part of them.
  const paragraphs = String((doc.info || {}).description || '').split(/\n\s*\n/).map(up.squash);
  return {
    revision: canon(doc.components.schemas.World.properties.revision),
    services: canon(doc.components.schemas.World.properties.services),
    properties: canon(doc.components.schemas.Node.properties.properties),
    paragraphs: PARAGRAPHS.map((start) => paragraphs.find((p) => p.startsWith(start)) || null),
  };
}

async function overlayChecks(ports) {
  // ---- W1 ---------------------------------------------------------------------------------------------
  const staleContext = { edits: { 'OpenSpatialWorld.API.yaml.patch': (p) => p.replace('Preflight responses allow Authorization, If-None-Match and If-Match."\n', 'Preflight responses allow If-Match."\n') } };
  const badType = { edits: { 'OpenSpatialWorld.API.yaml.patch': (p) => p.replace('+        properties:\n+          type: object\n', '+        properties:\n+          type: dictionary\n') } };
  await run('W1', 'the iteration 3 patches apply to the Web of Worlds files at main after iterations 1 and 2; the patched World API passes the OpenAPI 3.0 schema with every path parameter declared and every $ref resolving; the README completes the preview line and says observing creates no user; context.jsonld is new and names the provisional terms', async (impl) => {
    const failures = [];
    const out = loadIteration3(impl.edits);
    const validate = openApiValidator();
    if (!validate(out.world)) failures.push('OpenAPI 3.0 schema: ' + validate.errors.slice(0, 2).map((e) => e.instancePath + ' ' + e.message).join('; '));
    const params = up.pathParameterProblems(out.world);
    if (params.length) failures.push(params[0]);
    const refs = up.refProblems(out.world);
    if (refs.length) failures.push(refs[0]);
    if (!/no additional user created, but user-based authorization needed/.test(out.readme)) failures.push('the README\'s preview line is still cut off');
    if (!/create no user/.test(out.readme)) failures.push('the README does not say observing creates no user');
    const terms = out.context['@context'] || {};
    if (terms.Environment !== 'wow:Environment' || !terms.temperature) failures.push('the context lacks its terms');
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'the three patches apply; the World API passes the OpenAPI 3.0 schema with no path parameter or $ref problem; the README and the new context.jsonld carry the iteration 3 text' };
  }, {}, [
    { name: 'a patch whose context no longer matches iteration 2\'s text', impl: staleContext },
    { name: 'a patch that is not valid OpenAPI (type: dictionary)', impl: badType },
  ]);

  // ---- W2 ---------------------------------------------------------------------------------------------
  const offerDrifts = { edits: { 'OpenSpatialWorld.API.yaml.patch': (p) => p.replace('This world\'s current revision, the count of its changes; each event carries the revision it made.', 'This world\'s current revision.') } };
  const noTime = { serverEdits: { runtime: [['        evt.time = lastChangeTime;\n', '']] } };
  await run('W2', 'the offered text and the lab\'s contract agree on World.revision, World.services, Node.properties and the events, stream-authentication and data-point paragraphs; the served context holds the offered terms; on the wire the World reports its revision and events service, an event carries revision, time and urls, and a write that changes nothing makes no event', async (impl) => {
    const failures = [];
    const offered = loadIteration3(impl.edits);
    const a = iteration3Text(offered.world);
    const b = iteration3Text(up.yaml.load(up.read(path.join(ROOT, 'wow-spec', 'schema.yaml'))));
    for (const key of Object.keys(a)) if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) failures.push(key + ' differs between the offer and the lab contract');
    if (a.paragraphs.some((p) => !p)) failures.push('a paragraph is missing from the offer');
    const served = JSON.parse(fs.readFileSync(path.join(ROOT, 'wow-spec', 'context', 'wow.context.jsonld'), 'utf8'))['@context'];
    for (const [term, def] of Object.entries(offered.context['@context'])) if (JSON.stringify(served[term]) !== JSON.stringify(def)) failures.push('the served context differs on ' + term);
    const B = await lab.w.world('b', ports.next(), { base: '/w/b', edits: impl.serverEdits });
    const { module: obs } = await lab.observe();
    const events = [];
    const observer = obs.createObserver({ onEvent: (base, evt) => events.push(evt) });
    try {
      const [n] = await B.add(1, await B.rootOf(1), [{ label: 'node n', localTransform: lab.w.IDENTITY, properties: { temperature: 20 } }]);
      await observer.watch(B.nodeUrl(1, n) + '#/properties/temperature');
      await lab.until(() => [...observer.streams.values()].every((s) => s.state.status === 'live'), 5000, 'the stream');
      const body = (await B.node(1, n)).json;
      delete body.children;
      body.properties = { temperature: 21 };
      await B.put(1, n, body);
      await B.put(1, n, body);
      await lab.sleep(400);
      const world = await lab.worldDoc(B);
      const contextAnswer = await fetch(B.base + '/wow/context.jsonld');
      if (contextAnswer.headers.get('content-type') !== 'application/ld+json') failures.push('the context is served as ' + contextAnswer.headers.get('content-type'));
      await contextAnswer.text();
      if (!Number.isInteger(world.revision) || !world.services || world.services.events !== 'events') failures.push('the World lacks revision or services.events');
      const updates = events.filter((e) => e.type === 'node_updated');
      if (updates.length !== 1) failures.push(`${updates.length} node_updated events for one change and one write that changed nothing`);
      const e = updates[0] || {};
      if (!Number.isInteger(e.revision) || !e.time || !/^\d{4}-\d\d-\d\dT/.test(e.time) || !Array.isArray(e.urls) || !e.urls.includes('wow/spatial/1/node/' + n)) failures.push('an event lacks revision, time or urls: ' + JSON.stringify(e).slice(0, 160));
    } finally {
      observer.close();
      await B.close();
    }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'offer = lab contract on 6 points; served context holds the offered terms; on the wire: revision and services.events on the World, revision, time and urls on the event, no event for a write that changed nothing' };
  }, {}, [
    { name: 'an offer whose World.revision text drifted from the contract', impl: offerDrifts },
    { name: 'a server whose events carry no time', impl: noTime },
  ]);
}

module.exports = { overlayChecks, loadIteration3 };
