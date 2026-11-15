'use strict';

/*
 * Iteration 4, the contribution to the Web of Worlds files.
 *
 *   W1  the iteration 4 patch applies to the World API at main after iterations 1 to 3, and the patched
 *       World API passes the OpenAPI 3.0 schema, declares every path parameter and resolves every $ref;
 *       on both GeoPose forms of iteration 1
 *   W2  the text offered, the lab's contract (wow-spec/schema.yaml) and what the world server does on the
 *       wire say the same thing, `required` lists and World.preview's alternatives included; the offered text on
 *       both GeoPose forms; on the wire the portal, the user, the view and the World carry what the served schemas
 *       require, and a served preview (with an arrival node, and with an image only) meets one alternative; a lab
 *       world configured with both forms serves a preview with node, radius_m, url and image that validates against
 *       the served World.preview; the
 *       portal_activate event (its paragraph and the PortalActivate schema) offered = served, and on the wire a crossing
 *       intent sends one that carries what the served PortalActivate requires (its own list and the Event's)
 *   W3  the conformance vocabulary of iteration 4: the World API after iteration 4 still carries the BCP 14
 *       paragraph once; each normative sentence iteration 4 adds (Portal.destination, Portal.node, User.node,
 *       View.node, World.preview and the portals paragraph: a derived geoPose equals the node's placement, crossing
 *       works as plain navigation, the seamless crossing is optional; the portal_activate paragraph) uses a key word; World keeps no required member,
 *       Portal, User and View keep iteration 1's [id], and World.preview, the one object iteration 4 adds, carries its
 *       two alternatives as required lists (the arrival node, radius and preview URL; or the image); the offer on both
 *       GeoPose forms, the served contract and its build say the same; every document that uses key words (the World
 *       API and this overlay's README.md) carries the BCP 14 paragraph exactly once
 */

const path = require('path');
const { ROOT, run } = require('../arch-i1/lib');
const up = require('../arch-i1/upstream');
const words = require('../arch-i1/conformance-words');
const { openApiValidator, eachForm, swap } = require('../arch-i2/checks-overlay');
const { loadIteration3 } = require('../arch-i3/checks-overlay');
const Ajv = require('ajv');
const lab = require('./lab');
const wire = require('../wow-conformance/wire-checks');

const OVERLAY_4 = path.join(ROOT, 'wow-spec', 'overlays', 'iteration-4');
const PARAGRAPHS = ['Portals.', 'Portal events.'];

/**
 * The World API with iterations 1 to 4 applied, on the GeoPose form `form` of iteration 1 (with, the default, or
 * without); `edits` may change the iteration 4 patch first, and `edits.three` the earlier ones as loadIteration3 takes them.
 */
function loadIteration4(edits, form) {
  edits = edits || {};
  const three = loadIteration3(edits.three || null, form);
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
    portalActivate: canon(schemas.PortalActivate || null),
    paragraphs: PARAGRAPHS.map((start) => paragraphs.find((p) => p.startsWith(start)) || null),
    required: Object.keys(REQUIRED_I4).map((name) => [name, ((schemas[name] || {}).required || null)]),
    previewAlternatives: previewAlternatives(doc),
  };
}

async function overlayChecks(ports) {
  const staleContext = { edits: { 'OpenSpatialWorld.API.yaml.patch': (p) => p.replace('-    Data points. A data point is a resource URL', '-    Data points. A data point is the resource URL') } };
  const badType = { edits: { 'OpenSpatialWorld.API.yaml.patch': (p) => p.replace('+        destination:\n+          type: string\n', '+        destination:\n+          type: url\n') } };
  await run('W1', 'the iteration 4 patch applies to the World API at main after iterations 1 to 3, and the patched World API passes the OpenAPI 3.0 schema with every path parameter declared and every $ref resolving', async (impl) => {
    const failures = [];
    eachForm(failures, (form) => {
      const out = loadIteration4(impl.edits, form);
      const validate = openApiValidator();
      if (!validate(out.world)) failures.push(form + '-form: OpenAPI 3.0 schema: ' + validate.errors.slice(0, 2).map((e) => e.instancePath + ' ' + e.message).join('; '));
      const params = up.pathParameterProblems(out.world);
      if (params.length) failures.push(form + '-form: ' + params[0]);
      const refs = up.refProblems(out.world);
      if (refs.length) failures.push(form + '-form: ' + refs[0]);
      const text = iteration4Text(out.world);
      for (const [key, value] of Object.entries(text)) if (!value || (Array.isArray(value) && value.some((x) => !x))) failures.push(form + '-form: ' + key + ' is missing');
    });
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'the patch applies after iterations 1 to 3, on both GeoPose forms of iteration 1; the World API passes the OpenAPI 3.0 schema with no path parameter or $ref problem; Portal.destination, Portal.node, User.node, View.node, World.preview and the portals paragraph are there' };
  }, {}, [
    { name: 'a patch whose context no longer matches iteration 3\'s text', impl: staleContext },
    { name: 'a patch that is not valid OpenAPI (type: url)', impl: badType },
  ]);

  const offerDrifts = { edits: { 'OpenSpatialWorld.API.yaml.patch': (p) => p.replace('+            world\'s nodes within the radius of the arrival node, each relative to it, and only those the', '+            world\'s nodes within the radius of the arrival node, and only those the') } };
  const imageElsewhere = { serverEdits: { 'portal-standard.js': [['            if (d.image) out.image = d.image;', '            if (d.image) out.picture = d.image;']] } };
  const activateWithoutPortal = { serverEdits: { 'runtime-handoff.js': [["type : 'portal_activate', portalId : wowId, ", "type : 'portal_activate', "]] } };
  const previewWithNeither = { previewEdits: { 'portal-standard.js': [["            if (store) Object.assign(out, { node : nodeRef(store, d.node_id), radius_m : d.radius_m, url : 'wow/preview' });", '            if (store) Object.assign(out, { radius_m : d.radius_m });'], ['            if (d.image) out.image = d.image;', '']] } };
  const viewWithoutNode = { serverEdits: { 'runtime-view-projection.js': [['        id : WOW_PLAYER_VIEW_ID, // number, per WoW View schema\n        ...(placed != null ? { node : node } : {}),', '        id : WOW_PLAYER_VIEW_ID, // number, per WoW View schema']] } };
  await run('W2', 'the offered text and the lab\'s contract agree on Portal.destination, Portal.node, User.node, View.node, World.preview and the portals paragraph; on the wire a portal carries destination and node, the user and the view carry node, the World declares its preview, and the preview URL returns a Node tree', async (impl) => {
    const failures = [];
    const osl = up.yaml.load(up.read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    const b = iteration4Text(osl);
    eachForm(failures, (form) => {
      const a = iteration4Text(loadIteration4(impl.edits, form).world);
      for (const key of Object.keys(a)) if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) failures.push(form + '-form: ' + key + ' differs between the offer and the lab contract');
    });
    // On the wire (the wire half is shared with the conformance corpus: tools/wow-conformance/wire-checks.js placementWire).
    const A = await lab.w.world('a', ports.next(), { edits: impl.serverEdits });
    try {
      const [np] = await A.add(1, await A.rootOf(1), [{ label: 'N_P', localTransform: lab.placed(1, 0, 1) }]);
      const added = A.server.built.runtime.addPortal({ node_id: np, destination: 'http://127.0.0.1:1/w/x/#join=node.3', label: 'P' });
      A.server.built.runtime.setPreview({ node_id: np, radius_m: 10 });
      const served = osl.components.schemas;
      // A crossing intent through the added portal, watched on A's event stream.
      const crossing = async () => {
        await wire.labJoin(A.base, 'w2-visitor');
        await wire.labExitIntent(A.base, added.id, 'w2-visitor');
      };
      const r = await wire.placementWire(A.base, { portalId: added.id, portalNode: 'wow/spatial/1/node/' + np, preview: { node: 'wow/spatial/1/node/' + np, radius_m: 10 }, previewId: np, schemas: served, crossing, eventsUrl: A.base + '/events' });
      failures.push(...r.problems);
      // A preview with an arrival node and one with an image only, each against World.preview's alternatives.
      A.server.built.runtime.setPreview({ image: 'preview.png' });
      const imageOnly = (await lab.worldDoc(A)).preview;
      failures.push(...wire.previewAlternativeProblems(served, [['with an arrival node', r.world.preview], ['with an image only', imageOnly]]));
    } finally {
      await A.close();
    }
    // A lab world whose configuration gives its preview both forms: on the wire it carries the arrival node, the
    // radius and the preview URL, and the image, and it validates against the served World.preview.
    const validPreview = new Ajv({ strict: false, allErrors: true }).compile(((osl.components.schemas.World || {}).properties || {}).preview || {});
    if (validPreview({ radius_m: 10 })) failures.push('the served World.preview accepts a preview with neither form');
    const Both = await lab.w.world('a', ports.next(), { edits: impl.previewEdits, config: lab.BOTH_FORMS_WORLD });
    try {
      const both = (await lab.worldDoc(Both)).preview;
      failures.push(...wire.previewProblems(both, validPreview, { label: 'the configured preview of both forms', forms: ['node', 'radius_m', 'url', 'image'] }));
    } finally {
      await Both.close();
    }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'offer = lab contract on ' + Object.keys(b).length + ' points (' + Object.keys(b).join(', ') + '), on both GeoPose forms; on the wire: the portal\'s destination and node, the user\'s and the view\'s node, World.preview, and a Node tree at the preview URL; the portal, the user, the view and the World carry what the served schemas require; a preview with an arrival node and one with an image only each meet an alternative of World.preview; a lab world configured with both forms serves a preview with node, radius_m, url and image that validates against the served World.preview; a crossing intent sends one portal_activate with what the served PortalActivate requires' };
  }, {}, [
    { name: 'an offer whose preview text drifted from the contract', impl: offerDrifts },
    { name: 'a server whose View names no node', impl: viewWithoutNode },
    { name: 'a server whose image-only preview names its image under another member', impl: imageElsewhere },
    { name: 'a server whose portal_activate carries no portal id', impl: activateWithoutPortal },
    { name: 'a server whose configured preview carries neither form', impl: previewWithNeither },
  ]);

  await vocabularyCheck();
}

// ---------------------------------------------------------------------------------------------------
// The overlay README describes portal_activate: when it is sent, its members, and that it comes before user_left.
const PORTAL_EVENT_README_TERMS = ['`portal_activate`', '`portalId`', '`userId`', '`type`', '`revision`', '`time`', '`urls`', 'before the visitor navigates', '`user_left`'];
function portalEventReadmeProblems(readme) {
  const item = (readme.split(/\n(?=\d+\. \*\*)/).find((part) => /\*\*Portal events\.\*\*/.test(part)) || '').replace(/\s+/g, ' ');
  if (!item) return ['the iteration 4 overlay README.md does not describe portal_activate (no Portal events item)'];
  const missing = PORTAL_EVENT_README_TERMS.filter((term) => !item.includes(term));
  return missing.length ? ['the iteration 4 overlay README.md does not describe portal_activate fully: missing ' + missing.join(', ')] : [];
}

// W3, the conformance vocabulary of iteration 4.

/**
 * The `required` list of each schema iteration 4 touches. World keeps no required member. Portal, User and View
 * keep iteration 1's [id]: destination and node stay optional (a portal without a destination leads nowhere, and
 * a geoPose may place a portal, a user or a view without a node).
 */
const REQUIRED_I4 = { World: [], Portal: ['id'], User: ['id'], View: ['id'] };
/**
 * World.preview, the one object iteration 4 adds: "an arrival node, a radius and a preview URL, or an image URL, or
 * both". No member is in every preview, so it has no flat list; its anyOf holds the two alternatives as required lists.
 */
const PREVIEW_ALTERNATIVES = [['node', 'radius_m', 'url'], ['image']];
/** World.preview's alternatives in a document, each list sorted, or null when it has none. */
function previewAlternatives(doc) {
  const preview = (((((doc || {}).components || {}).schemas || {}).World || {}).properties || {}).preview || {};
  if (!Array.isArray(preview.anyOf)) return null;
  return preview.anyOf.map((alt) => (Array.isArray((alt || {}).required) ? [...alt.required].sort() : null));
}
function previewProblems(doc, label) {
  const have = previewAlternatives(doc);
  const want = PREVIEW_ALTERNATIVES.map((l) => [...l].sort());
  if (!have) return [label + ' World.preview has no alternatives (wanted anyOf ' + JSON.stringify(PREVIEW_ALTERNATIVES) + ')'];
  return JSON.stringify(have) === JSON.stringify(want) ? [] : [label + ' World.preview requires one of ' + JSON.stringify(have) + ', wanted ' + JSON.stringify(want)];
}

const schemaText = (name, prop) => (doc) => doc.components.schemas[name].properties[prop].description;
const para4 = (start) => (doc) => String((doc.info || {}).description || '').split(/\n\s*\n/).map(up.squash).find((p) => p.startsWith(start)) || '';
/** The normative sentences iteration 4 adds to the World API. Each anchor is a phrase of the sentence, found before and after the key words. */
const SENTENCES_I4 = [
  { where: 'info.description (crossing as plain navigation)', text: para4('Portals.'), anchor: 'plain navigation' },
  { where: 'info.description (the destination is checked first)', text: para4('Portals.'), anchor: 'destination answers' },
  { where: 'info.description (the seamless crossing)', text: para4('Portals.'), anchor: 'Seamless crossing' },
  { where: 'info.description (a derived geoPose)', text: para4('Portals.'), anchor: 'geoPose they give' },
  { where: 'info.description (what a portal shows of its destination)', text: para4('Portals.'), anchor: 'preview allows' },
  { where: 'info.description (a portal inside a preview)', text: para4('Portals.'), anchor: 'inside a preview' },
  { where: 'Portal.destination (where a visitor arrives)', text: schemaText('Portal', 'destination'), anchor: 'where a visitor arrives' },
  { where: 'Portal.destination (crossing)', text: schemaText('Portal', 'destination'), anchor: 'navigation to this URL' },
  { where: 'Portal.destination (no destination)', text: schemaText('Portal', 'destination'), anchor: 'without a destination' },
  { where: 'Portal.node (a derived geoPose)', text: schemaText('Portal', 'node'), anchor: 'geoPose given here' },
  { where: 'User.node (a derived geoPose)', text: schemaText('User', 'node'), anchor: 'geoPose given here' },
  { where: 'View.node (a derived geoPose)', text: schemaText('View', 'node'), anchor: 'geoPose given here' },
  { where: 'World.preview (the arrival node, radius and URL together)', text: schemaText('World', 'preview'), anchor: 'come together' },
  { where: 'World.preview (a Node tree)', text: schemaText('World', 'preview'), anchor: 'Node tree' },
  { where: 'World.preview (only nodes within the radius)', text: schemaText('World', 'preview'), anchor: 'within the radius' },
  { where: 'World.preview (reading creates no user)', text: schemaText('World', 'preview'), anchor: 'Reading it' },
  { where: 'info.description (portal_activate, once before navigation)', text: para4('Portal events.'), anchor: 'send portal_activate' },
  { where: 'info.description (what portal_activate carries)', text: para4('Portal events.'), anchor: 'carry portalId' },
];
const GENERATED = path.join(ROOT, 'wow-spec', 'generated', 'schema.json');
const OVERLAY_README = path.join(OVERLAY_4, 'README.md');
/** How many times a text carries the BCP 14 paragraph. */
const bcp14Count = (text) => up.squash(text || '').split(up.squash(words.BCP14)).length - 1;
/**
 * A document that uses key words must carry the BCP 14 paragraph exactly once. `paragraphText` is where the
 * paragraph is counted when it differs from the text (the World API's parsed info.description: its YAML escapes quotes).
 */
function paragraphProblems(text, label, paragraphText) {
  const used = words.keywordCount(text);
  const n = bcp14Count(paragraphText === undefined ? text : paragraphText);
  return used && n !== 1 ? [label + ': ' + used + ' key words and the BCP 14 paragraph ' + n + ' times, wanted once'] : [];
}

async function vocabularyCheck() {
  const W4P = 'wow-spec/overlays/iteration-4/OpenSpatialWorld.API.yaml.patch';
  const W2P = 'wow-spec/overlays/iteration-2/OpenSpatialWorld.API.yaml.patch';
  const API = 'OpenSpatialWorld.API.yaml.patch';
  const sentenceWithoutKeyword = { edits: { [API]: (p) => swap(p, 'Crossing MUST work as plain navigation to the destination.', 'Crossing is plain navigation to the destination.', W4P) }, expect: /^with-form: offered World API after iteration 4 info\.description \(crossing as plain navigation\): .* has no key word/ };
  const destinationWithoutKeyword = { edits: { [API]: (p) => swap(p, 'a client MUST NOT cross through it.', 'a client does not cross through it.', W4P) }, expect: /^with-form: offered World API after iteration 4 Portal\.destination \(no destination\): .* has no key word/ };
  const schemaWithoutList = { mutateOffered: (doc) => { delete doc.components.schemas.Portal.required; }, expect: /^with-form: offered World API after iteration 4 Portal has no required list/ };
  const previewWithoutAlternatives = { mutateOffered: (doc) => { delete doc.components.schemas.World.properties.preview.anyOf; }, expect: /^with-form: offered World API after iteration 4 World\.preview has no alternatives/ };
  const servedDiffers = { mutateOsl: (osl) => { osl.components.schemas.Portal.required = ['id', 'destination']; }, expect: /^served contract Portal requires|^with-form: served and offered differ: Portal / };
  const servedWithoutKeyword = { mutateOsl: (osl) => { osl.info.description = osl.info.description.replace('A portal inside a preview MUST show closed.', 'A portal inside a preview shows closed.'); }, expect: /^served contract info\.description \(a portal inside a preview\): .* has no key word/ };
  const buildNotRebuilt = { mutateGenerated: (doc) => { delete doc.components.schemas.World.properties.preview.anyOf; }, expect: /^generated schema\.json World\.preview has no alternatives/ };
  const apiWithoutBcp14 = { edits: { three: { two: { world: (p) => swap(p, '\n     The key words ', '\n-    The key words ', W2P) } } }, expect: /^with-form: offered World API after iteration 4: \d+ key words and the BCP 14 paragraph 0 times/ };
  const overlayReadmeWithoutPortalEvent = { overlayReadme: (t) => t.replace(/\n5\. \*\*Portal events\.\*\*[\s\S]*?(?=\n\d+\. \*\*|\n\n|$)/, ''), expect: /^the iteration 4 overlay README\.md does not describe portal_activate/ };
  const overlayReadmeWithoutBcp14 = { overlayReadme: (t) => swap(t, words.BCP14, 'Key words are used as defined elsewhere.', 'wow-spec/overlays/iteration-4/README.md'), expect: /^the iteration 4 overlay README\.md: \d+ key words and the BCP 14 paragraph 0 times/ };

  await run('W3', 'the conformance vocabulary of iteration 4: the World API after iteration 4 carries the BCP 14 paragraph once; each normative sentence iteration 4 adds (crossing as plain navigation, the destination checked first, the optional seamless crossing, a derived geoPose equal to the node\'s placement, what a portal shows of its destination, a portal inside a preview, Portal.destination, Portal.node, User.node, View.node and World.preview) uses a key word; World keeps no required member, Portal, User and View [id], World.preview its two alternatives; served equals offered equals built; on both GeoPose forms; every document with key words carries the BCP 14 paragraph once', async (impl) => {
    const failures = [];
    const osl = up.yaml.load(up.read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    if (impl.mutateOsl) impl.mutateOsl(osl);
    const generated = JSON.parse(up.read(GENERATED));
    if (impl.mutateGenerated) impl.mutateGenerated(generated);
    let count = null;
    eachForm(failures, (form) => {
      const out = loadIteration4(impl.edits, form);
      if (impl.mutateOffered) impl.mutateOffered(out.world);
      const label = form + '-form: offered World API after iteration 4';
      failures.push(...paragraphProblems(out.worldText, label, (out.world.info || {}).description));
      if (!words.hasBcp14((out.world.info || {}).description)) failures.push(label + ': no BCP 14 paragraph citing RFC 2119 and RFC 8174 in info.description');
      failures.push(...words.sentenceProblems(out.world, SENTENCES_I4, label));
      failures.push(...words.requiredProblems(out.world.components.schemas, REQUIRED_I4, label));
      failures.push(...previewProblems(out.world, label));
      for (const diff of words.requiredDiffs(out.world.components.schemas, osl.components.schemas, Object.keys(REQUIRED_I4))) failures.push(form + '-form: served and offered differ: ' + diff);
      if (JSON.stringify(previewAlternatives(out.world)) !== JSON.stringify(previewAlternatives(osl))) failures.push(form + '-form: served and offered differ: World.preview alternatives');
      if (form === 'with') count = words.keywordCount(SENTENCES_I4.map((e) => words.sentenceWith(e.text(out.world), e.anchor) || '').join(' '));
    });
    let overlayReadme = up.read(OVERLAY_README);
    if (impl.overlayReadme) overlayReadme = impl.overlayReadme(overlayReadme);
    failures.push(...paragraphProblems(overlayReadme, 'the iteration 4 overlay README.md'));
    failures.push(...portalEventReadmeProblems(overlayReadme));
    // The served contract carries the same sentences with their key words, and its build the same lists.
    failures.push(...words.sentenceProblems(osl, SENTENCES_I4, 'served contract'));
    failures.push(...words.requiredProblems(osl.components.schemas, REQUIRED_I4, 'served contract'));
    failures.push(...previewProblems(osl, 'served contract'));
    failures.push(...words.requiredProblems(generated.components.schemas, REQUIRED_I4, 'generated schema.json'));
    failures.push(...previewProblems(generated, 'generated schema.json'));
    for (const diff of words.requiredDiffs(osl.components.schemas, generated.components.schemas, Object.keys(REQUIRED_I4))) failures.push('generated schema.json is not the served contract: ' + diff);
    if (JSON.stringify(previewAlternatives(osl)) !== JSON.stringify(previewAlternatives(generated))) failures.push('generated schema.json is not the served contract: World.preview alternatives');

    if (impl.expect) return { ok: !failures.some((f) => impl.expect.test(f)), detail: failures.slice(0, 4).join('; ') || 'no failure' };
    return {
      ok: failures.length === 0,
      detail: failures.length
        ? failures.length + ' problem(s): ' + failures.slice(0, 6).join('; ')
        : 'the World API after iteration 4 carries the BCP 14 paragraph once on both forms; ' + SENTENCES_I4.length + ' normative sentences in the World API (' + (count || 0) + ' key words) each use one, offered on both forms and served; required lists: ' + Object.entries(REQUIRED_I4).map(([n, l]) => n + (l.length ? ' [' + l.join(', ') + ']' : ' none')).join(', ') + ', World.preview one of ' + PREVIEW_ALTERNATIVES.map((l) => '[' + l.join(', ') + ']').join(' or ') + '; served = offered = built; the World API and the overlay README.md each carry the BCP 14 paragraph once',
    };
  }, {}, [
    { name: 'a normative sentence without a key word (crossing as plain navigation)', impl: sentenceWithoutKeyword },
    { name: 'a Portal.destination without a key word (no destination)', impl: destinationWithoutKeyword },
    { name: 'an offered Portal without its required list', impl: schemaWithoutList },
    { name: 'an offered World.preview without its alternatives', impl: previewWithoutAlternatives },
    { name: 'a served contract whose Portal required list differs from the offer', impl: servedDiffers },
    { name: 'a served contract whose closed-portal sentence has no key word', impl: servedWithoutKeyword },
    { name: 'a generated schema.json not rebuilt from the served contract (World.preview without its alternatives)', impl: buildNotRebuilt },
    { name: 'a World API with key words but no BCP 14 paragraph', impl: apiWithoutBcp14 },
    { name: 'an overlay README.md with key words but no BCP 14 paragraph', impl: overlayReadmeWithoutBcp14 },
    { name: 'an overlay README.md without the portal_activate description', impl: overlayReadmeWithoutPortalEvent },
  ]);
}

module.exports = { overlayChecks, loadIteration4 };
