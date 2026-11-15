'use strict';

/*
 * Iteration 3, the contribution to the Web of Worlds files.
 *
 *   W1  the iteration 3 patches apply to the Web of Worlds files at main after iterations 1 and 2 (World
 *       API, README, and a new context.jsonld), and the patched World API passes the OpenAPI 3.0 schema,
 *       declares every path parameter and resolves every $ref; on both GeoPose forms of iteration 1
 *   W2  the text offered, the lab's contract (wow-spec/schema.yaml and its served context) and what the
 *       world server does on the wire say the same thing, `required` lists and the Event schema included; the
 *       offered text on both GeoPose forms; every event on the wire carries what the served Event schema requires
 *   W3  the conformance vocabulary of iteration 3: the World API after iteration 3 still carries the BCP 14
 *       paragraph once; each normative sentence iteration 3 adds (the event stream, what each event carries,
 *       revisions across restarts, the no-op write, resume and resync, stream authentication, data points, and the
 *       README's preview and no-user lines) uses a key word; the schemas iteration 3 adds or touches have their
 *       `required` lists (World keeps none; Node [id]; the new Event its own), and the offer on both GeoPose forms,
 *       the served contract and its build say the same; every document that uses key words (the World API, the World
 *       README and this overlay's README.md) carries the BCP 14 paragraph exactly once; the events path: the served
 *       contract states the offer's rule (the stream listed under services.events) and, like the contract note on
 *       the events path (wow-spec/OSL-WOW-CONTRACT.md), never calls it non-canonical or outside the contract
 */

const fs = require('fs');
const path = require('path');
const { ROOT, run } = require('../arch-i1/lib');
const up = require('../arch-i1/upstream');
const words = require('../arch-i1/conformance-words');
const { loadIteration2, openApiValidator, eachForm, swap } = require('../arch-i2/checks-overlay');
const lab = require('./lab');
const { eventsWire } = require('../wow-conformance/wire-checks');

const OVERLAY_3 = path.join(ROOT, 'wow-spec', 'overlays', 'iteration-3');
const PARAGRAPHS = ['Events.', 'Stream authentication.', 'Data points.'];

/**
 * Iterations 1 to 3 on the GeoPose form `form` of iteration 1 (with, the default, or without); `edits` swaps iteration 3
 * patch text by file name, and `edits.two` swaps iteration 2 patch text as loadIteration2 takes it.
 */
function loadIteration3(edits, form) {
  edits = edits || {};
  const two = loadIteration2(edits.two || null, form);
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
    event: canon(doc.components.schemas.Event || null),
    paragraphs: PARAGRAPHS.map((start) => paragraphs.find((p) => p.startsWith(start)) || null),
    required: Object.keys(REQUIRED_I3).map((name) => [name, ((doc.components.schemas[name] || {}).required || null)]),
  };
}

async function overlayChecks(ports) {
  const staleContext = { edits: { 'OpenSpatialWorld.API.yaml.patch': (p) => p.replace('the request headers Authorization, Content-Type, If-None-Match and If-Match."\n', 'the request headers If-Match."\n') } };
  const badType = { edits: { 'OpenSpatialWorld.API.yaml.patch': (p) => p.replace('+        properties:\n+          type: object\n', '+        properties:\n+          type: dictionary\n') } };
  await run('W1', 'the iteration 3 patches apply to the Web of Worlds files at main after iterations 1 and 2; the patched World API passes the OpenAPI 3.0 schema with every path parameter declared and every $ref resolving; the README completes the preview line and says observing creates no user; context.jsonld is new and names the provisional terms', async (impl) => {
    const failures = [];
    eachForm(failures, (form) => {
      const out = loadIteration3(impl.edits, form);
      const validate = openApiValidator();
      if (!validate(out.world)) failures.push(form + '-form: OpenAPI 3.0 schema: ' + validate.errors.slice(0, 2).map((e) => e.instancePath + ' ' + e.message).join('; '));
      const params = up.pathParameterProblems(out.world);
      if (params.length) failures.push(form + '-form: ' + params[0]);
      const refs = up.refProblems(out.world);
      if (refs.length) failures.push(form + '-form: ' + refs[0]);
      if (!/experience the world without joining it: a preview MUST NOT create an additional user, but user-based authorization still applies/.test(out.readme)) failures.push(form + '-form: the README\'s preview line is still cut off');
      if (!/subscribing to a world's events MUST NOT create a user/.test(out.readme)) failures.push(form + '-form: the README does not say observing creates no user');
      const terms = out.context['@context'] || {};
      if (terms.Environment !== 'wow:Environment' || !terms.temperature) failures.push(form + '-form: the context lacks its terms');
    });
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'the three patches apply on both GeoPose forms of iteration 1; the World API passes the OpenAPI 3.0 schema with no path parameter or $ref problem; the README and the new context.jsonld carry the iteration 3 text' };
  }, {}, [
    { name: 'a patch whose context no longer matches iteration 2\'s text', impl: staleContext },
    { name: 'a patch that is not valid OpenAPI (type: dictionary)', impl: badType },
  ]);

  const offerDrifts = { edits: { 'OpenSpatialWorld.API.yaml.patch': (p) => p.replace('This world\'s current revision, the count of its changes; each event carries the revision it made.', 'This world\'s current revision.') } };
  const noTime = { serverEdits: { 'runtime-events.js': [['        event.time = this.time;\n', '']] } };
  await run('W2', 'the offered text and the lab\'s contract agree on World.revision, World.services, Node.properties and the events, stream-authentication and data-point paragraphs; the served context holds the offered terms; on the wire the World reports its revision and events service, an event carries revision, time and urls, and a write that changes nothing makes no event', async (impl) => {
    const failures = [];
    const osl = up.yaml.load(up.read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    const b = iteration3Text(osl);
    const served = JSON.parse(fs.readFileSync(path.join(ROOT, 'wow-spec', 'context', 'wow.context.jsonld'), 'utf8'))['@context'];
    eachForm(failures, (form) => {
      const offered = loadIteration3(impl.edits, form);
      const a = iteration3Text(offered.world);
      for (const key of Object.keys(a)) if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) failures.push(form + '-form: ' + key + ' differs between the offer and the lab contract');
      if (a.paragraphs.some((p) => !p)) failures.push(form + '-form: a paragraph is missing from the offer');
      for (const [term, def] of Object.entries(offered.context['@context'])) if (JSON.stringify(served[term]) !== JSON.stringify(def)) failures.push(form + '-form: the served context differs on ' + term);
    });
    // On the wire (the wire half is shared with the conformance corpus: tools/wow-conformance/wire-checks.js eventsWire).
    const B = await lab.w.world('b', ports.next(), { base: '/w/b', edits: impl.serverEdits });
    const { module: obs } = await lab.observe();
    try {
      failures.push(...(await eventsWire(B.base, { eventSchema: osl.components.schemas.Event, writes: true, observe: obs })).problems);
    } finally {
      await B.close();
    }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'offer = lab contract on ' + Object.keys(b).length + ' points (' + Object.keys(b).join(', ') + '), on both GeoPose forms; served context holds the offered terms; on the wire: revision and services.events on the World, revision, time and urls on the event, every event carries what the served Event schema requires, no event for a write that changed nothing' };
  }, {}, [
    { name: 'an offer whose World.revision text drifted from the contract', impl: offerDrifts },
    { name: 'a server whose events carry no time', impl: noTime },
  ]);

  await vocabularyCheck();
}

// ---------------------------------------------------------------------------------------------------
// W3, the conformance vocabulary of iteration 3.

/**
 * The `required` list of each schema iteration 3 adds or touches. World keeps no required member, so a world
 * without a graph, an event stream or a revision is valid: World.revision and World.services stay optional, and the
 * members of services are strings, which carry no list. Node keeps iteration 1's [id] (iteration 3 adds properties).
 * Event, the payload of a change event on the stream, is new: type, revision, time and urls are on every event.
 */
const REQUIRED_I3 = { World: [], Node: ['id'], Event: ['type', 'revision', 'time', 'urls'] };

const para3 = (start) => (doc) => String((doc.info || {}).description || '').split(/\n\s*\n/).map(up.squash).find((p) => p.startsWith(start)) || '';
/** The normative sentences iteration 3 adds to the World API. Each anchor is a phrase of the sentence, found before and after the key words. */
const SENTENCES_I3 = [
  { where: 'info.description (the event stream in services.events)', text: para3('Events.'), anchor: 'under services.events' },
  { where: 'info.description (what each event carries)', text: para3('Events.'), anchor: 'Each event' },
  { where: 'info.description (revisions survive restarts)', text: para3('Events.'), anchor: 'restarts' },
  { where: 'info.description (a write that changes nothing)', text: para3('Events.'), anchor: 'changes nothing' },
  { where: 'info.description (resume with since)', text: para3('Events.'), anchor: 'since=<revision>' },
  { where: 'info.description (resync)', text: para3('Events.'), anchor: 'resync' },
  { where: 'info.description (the token is the first message)', text: para3('Stream authentication.'), anchor: 'first message' },
  { where: 'info.description (no token in a URL)', text: para3('Stream authentication.'), anchor: 'in a URL' },
  { where: 'info.description (closed within 5 seconds)', text: para3('Stream authentication.'), anchor: 'within 5 seconds' },
  { where: 'info.description (an origin the policy does not allow)', text: para3('Stream authentication.'), anchor: 'origin its policy' },
  { where: 'info.description (the pointer and children)', text: para3('Data points.'), anchor: 'through children' },
  { where: 'info.description (reading and subscribing create no user)', text: para3('Data points.'), anchor: 'conditional reading and subscribing' },
];
/**
 * The normative sentences iteration 3 adds to the World README: the preview row of its table, and the no-user line.
 * Each is read from its own line: the table rows have no full stop, so a sentence would otherwise run across them.
 */
const lineStarting = (start) => (t) => String(t || '').split('\n').find((l) => l.startsWith(start)) || '';
const SENTENCES_README_I3 = [
  { where: 'README (the preview row)', text: lineStarting('| Preview world'), anchor: 'without joining it' },
  { where: 'README (subscribing creates no user)', text: lineStarting('Reading, conditional reading and subscribing'), anchor: 'subscribing to a world\'s events' },
];
const GENERATED = path.join(ROOT, 'wow-spec', 'generated', 'schema.json');
const CONTRACT_NOTE = path.join(ROOT, 'wow-spec', 'OSL-WOW-CONTRACT.md');
/** A sentence about the events path, and wording that puts it outside the contract. */
const EVENTS_PATH = /WS \/events|event stream|services\.events|\/events\b/;
const OUTSIDE_CONTRACT = /non-?canonical|not in this HTTP contract|out of the OpenAPI HTTP contract|outside the (OpenAPI )?HTTP contract/i;
/**
 * Served = offered on the events path. The offer states it as a rule (a world that offers an event stream MUST list it
 * under services.events); the served contract must carry that same sentence and must not call the events path
 * non-canonical anywhere in its description, and the contract note's section on the events path must name
 * services.events and must not call it non-canonical either.
 */
function eventsPathProblems(offeredWorld, osl, note) {
  const problems = [];
  const rule = words.sentenceWith(para3('Events.')(offeredWorld), 'under services.events');
  const served = up.squash(String((osl.info || {}).description || ''));
  if (!rule) problems.push('the offer states no events-path rule');
  else if (!served.includes(rule)) problems.push('served contract: the events-path rule differs from the offer');
  for (const s of served.split(/(?<=\.)\s+/)) if (EVENTS_PATH.test(s) && OUTSIDE_CONTRACT.test(s)) problems.push('served contract: the events path is called non-canonical: ' + s.slice(0, 140));
  const heading = String(note || '').split('\n').find((l) => /^## /.test(l) && /\/events|event stream/i.test(l));
  if (!heading) return problems.concat('the contract note has no section on the events path');
  const section = note.slice(note.indexOf(heading)).split(/\n## /)[0];
  if (!/services\.events/.test(section)) problems.push('the contract note on the events path does not name services.events');
  for (const s of up.squash(section).split(/(?<=\.)\s+/)) if (OUTSIDE_CONTRACT.test(s)) problems.push('the contract note calls the events path non-canonical: ' + s.slice(0, 140));
  return problems;
}
const OVERLAY_README = path.join(OVERLAY_3, 'README.md');
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
  const W3P = 'wow-spec/overlays/iteration-3/OpenSpatialWorld.API.yaml.patch';
  const R3P = 'wow-spec/overlays/iteration-3/OpenSpatialWorld.README.md.patch';
  const R2P = 'wow-spec/overlays/iteration-2/OpenSpatialWorld.README.md.patch';
  const W2P = 'wow-spec/overlays/iteration-2/OpenSpatialWorld.API.yaml.patch';
  const API = 'OpenSpatialWorld.API.yaml.patch';
  const sentenceWithoutKeyword = { edits: { [API]: (p) => swap(p, 'A write that changes nothing MUST NOT produce a revision or an event.', 'A write that changes nothing produces no revision and no event.', W3P) }, expect: /^with-form: offered World API after iteration 3 info\.description \(a write that changes nothing\): .* has no key word/ };
  const readmeWithoutKeyword = { edits: { 'OpenSpatialWorld.README.md.patch': (p) => swap(p, 'events MUST NOT create a user.', 'events create no user.', R3P) }, expect: /^with-form: offered World README README \(subscribing creates no user\): .* has no key word/ };
  const schemaWithoutList = { mutateOffered: (doc) => { delete (doc.components.schemas.Event || {}).required; }, expect: /^with-form: offered World API after iteration 3 Event has no required list/ };
  const servedDiffers = { mutateOsl: (osl) => { osl.components.schemas.Event.required = ['type', 'revision']; }, expect: /^served contract Event requires|^with-form: served and offered differ: Event / };
  const servedWithoutKeyword = { mutateOsl: (osl) => { osl.info.description = osl.info.description.replace('MUST NOT create a user', 'create no user'); }, expect: /^served contract info\.description \(reading and subscribing create no user\): .* has no key word/ };
  const buildNotRebuilt = { mutateGenerated: (doc) => { delete doc.components.schemas.Event.required; }, expect: /^generated schema\.json Event has no required list/ };
  const readmeWithoutBcp14 = { edits: { two: { readme: (p) => swap(p, '\n+' + words.BCP14 + '\n', '\n+Key words in this document are used as defined elsewhere.\n', R2P) } }, expect: /^with-form: offered World README after iteration 3: \d+ key words and the BCP 14 paragraph 0 times/ };
  const apiWithoutBcp14 = { edits: { two: { world: (p) => swap(p, '\n     The key words ', '\n-    The key words ', W2P) } }, expect: /^with-form: offered World API after iteration 3: \d+ key words and the BCP 14 paragraph 0 times/ };
  const OLD_EVENTS_NOTE = '* `WS /events` is a LABELED non-canonical realtime convention, documented in the contract note, NOT in this HTTP contract.';
  const servedEventsNonCanonical = { mutateOsl: (osl) => { osl.info.description = osl.info.description.replace('\n\n', '\n' + OLD_EVENTS_NOTE + '\n\n'); }, expect: /^served contract: the events path is called non-canonical/ };
  const noteEventsNonCanonical = { mutateNote: (t) => t.replace(/(\n## [^\n]*\/events[^\n]*\n)/, '$1\nRealtime is a non-canonical convention, out of the OpenAPI HTTP contract.\n'), expect: /^the contract note calls the events path non-canonical/ };
  const overlayReadmeWithoutBcp14 = { overlayReadme: (t) => swap(t, words.BCP14, 'Key words are used as defined elsewhere.', 'wow-spec/overlays/iteration-3/README.md'), expect: /^the iteration 3 overlay README\.md: \d+ key words and the BCP 14 paragraph 0 times/ };

  await run('W3', 'the conformance vocabulary of iteration 3: the World API after iteration 3 carries the BCP 14 paragraph once; each normative sentence iteration 3 adds (the event stream, what each event carries, revisions across restarts, the no-op write, resume and resync, the token as the first message and never in a URL, the 5-second close, the origin refusal, data points, reading and subscribing create no user, the README\'s preview and no-user lines) uses a key word; World keeps no required member, Node [id], Event its list; served equals offered equals built; on both GeoPose forms; every document with key words carries the BCP 14 paragraph once; served equals offered on the events path, which neither the served contract nor the contract note calls non-canonical', async (impl) => {
    const failures = [];
    const osl = up.yaml.load(up.read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    if (impl.mutateOsl) impl.mutateOsl(osl);
    const generated = JSON.parse(up.read(GENERATED));
    if (impl.mutateGenerated) impl.mutateGenerated(generated);
    let counts = null;
    let note = up.read(CONTRACT_NOTE);
    if (impl.mutateNote) note = impl.mutateNote(note);
    eachForm(failures, (form) => {
      const out = loadIteration3(impl.edits, form);
      if (form === 'with') failures.push(...eventsPathProblems(out.world, osl, note));
      if (impl.mutateOffered) impl.mutateOffered(out.world);
      const label = form + '-form: offered World API after iteration 3';
      failures.push(...paragraphProblems(out.worldText, label, (out.world.info || {}).description));
      if (!words.hasBcp14((out.world.info || {}).description)) failures.push(label + ': no BCP 14 paragraph citing RFC 2119 and RFC 8174 in info.description');
      failures.push(...words.sentenceProblems(out.world, SENTENCES_I3, label));
      failures.push(...words.sentenceProblems(out.readme, SENTENCES_README_I3, form + '-form: offered World README'));
      failures.push(...paragraphProblems(out.readme, form + '-form: offered World README after iteration 3'));
      failures.push(...words.requiredProblems(out.world.components.schemas, REQUIRED_I3, label));
      for (const diff of words.requiredDiffs(out.world.components.schemas, osl.components.schemas, Object.keys(REQUIRED_I3))) failures.push(form + '-form: served and offered differ: ' + diff);
      if (form === 'with') {
        const added = SENTENCES_I3.map((e) => words.sentenceWith(e.text(out.world), e.anchor) || '').join(' ');
        counts = { api: words.keywordCount(added), readme: words.keywordCount(SENTENCES_README_I3.map((e) => words.sentenceWith(e.text(out.readme), e.anchor) || '').join(' ')) };
      }
    });
    let overlayReadme = up.read(OVERLAY_README);
    if (impl.overlayReadme) overlayReadme = impl.overlayReadme(overlayReadme);
    failures.push(...paragraphProblems(overlayReadme, 'the iteration 3 overlay README.md'));
    // The served contract carries the same sentences with their key words, and its build the same lists.
    failures.push(...words.sentenceProblems(osl, SENTENCES_I3, 'served contract'));
    failures.push(...words.requiredProblems(osl.components.schemas, REQUIRED_I3, 'served contract'));
    failures.push(...words.requiredProblems(generated.components.schemas, REQUIRED_I3, 'generated schema.json'));
    for (const diff of words.requiredDiffs(osl.components.schemas, generated.components.schemas, Object.keys(REQUIRED_I3))) failures.push('generated schema.json is not the served contract: ' + diff);

    if (impl.expect) return { ok: !failures.some((f) => impl.expect.test(f)), detail: failures.slice(0, 4).join('; ') || 'no failure' };
    counts = counts || { api: 0, readme: 0 };
    return {
      ok: failures.length === 0,
      detail: failures.length
        ? failures.length + ' problem(s): ' + failures.slice(0, 6).join('; ')
        : 'the World API after iteration 3 carries the BCP 14 paragraph once on both forms; ' + SENTENCES_I3.length + ' normative sentences in the World API (' + counts.api + ' key words) and ' + SENTENCES_README_I3.length + ' in the README (' + counts.readme + ') each use one, offered on both forms and served; required lists: ' + Object.entries(REQUIRED_I3).map(([n, l]) => n + (l.length ? ' [' + l.join(', ') + ']' : ' none')).join(', ') + '; served = offered = built; the World API, the World README and the overlay README.md each carry the BCP 14 paragraph once; events path: the served contract carries the offered rule (listed under services.events), and neither it nor the contract note calls the events path non-canonical',
    };
  }, {}, [
    { name: 'a normative sentence without a key word (the no-op write)', impl: sentenceWithoutKeyword },
    { name: 'a README no-user line without a key word', impl: readmeWithoutKeyword },
    { name: 'an offered Event without its required list', impl: schemaWithoutList },
    { name: 'a served contract whose Event required list differs from the offer', impl: servedDiffers },
    { name: 'a served contract whose no-user sentence has no key word', impl: servedWithoutKeyword },
    { name: 'a generated schema.json not rebuilt from the served contract (Event without its list)', impl: buildNotRebuilt },
    { name: 'a World README with key words but no BCP 14 paragraph', impl: readmeWithoutBcp14 },
    { name: 'a World API with key words but no BCP 14 paragraph', impl: apiWithoutBcp14 },
    { name: 'an overlay README.md with key words but no BCP 14 paragraph', impl: overlayReadmeWithoutBcp14 },
    { name: 'a served contract that calls the events path non-canonical', impl: servedEventsNonCanonical },
    { name: 'a contract note that calls the events path non-canonical', impl: noteEventsNonCanonical },
  ]);
}

module.exports = { overlayChecks, loadIteration3 };
