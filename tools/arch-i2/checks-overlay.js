'use strict';

/*
 * Iteration 2, the contribution to the Web of Worlds API descriptions.
 *
 *   O1  the iteration 2 patches apply to the Web of Worlds files at main (after iteration 1's), and the
 *       patched World API passes the OpenAPI 3.0 schema, declares every path parameter and resolves
 *       every $ref; on both GeoPose forms of iteration 1 (with and without the two rotation sentences). The
 *       without-form takes its own World patch (iteration-2/without-rotation-sentences/, made by
 *       tools/arch-i1/gen-without-form.js), which differs from the with-form patch only in hunk 1's Frames lines
 *   O2  the text offered upstream, the contract the lab serves (wow-spec/schema.yaml) and what the world
 *       server does on the wire say the same thing, `required` lists included; the offered text on both GeoPose forms;
 *       both carry the rule for verifying an included part (read from its own world, revalidated by its entity tag,
 *       never a relayed or embedded copy, a placeholder when unreachable), which I13 holds on the wire
 *   O3  the conformance vocabulary of iteration 2: the World API after iteration 2 still carries the BCP 14
 *       paragraph, each normative sentence iteration 2 adds (inclusion, media type, entity tags, cross-origin
 *       access, and the README's base-URL rule) uses a key word, the schemas iteration 2 touches keep their
 *       `required` lists, and the served contract and its build say the same; on both GeoPose forms. World keeps
 *       no required member: World.spatials says a reader MUST treat an absent `spatials` as an empty list (offered,
 *       served and built), the README patch carries the BCP 14 paragraph once, this overlay's own README.md, which
 *       uses key words, carries it exactly once, word for word, and the lab's World reader
 *       (web/wow-inclusion.mjs) treats a World without `spatials` as one with an empty list and does not fail
 *   O4  the scope statement: the README after iteration 2 carries the scope paragraph (rendering, physics
 *       simulation, spatial audio and input-device mapping are outside this API) exactly once, on both GeoPose forms
 *
 * WoWAPI `main` is d39a1a0, the vendored copy (checked against GitHub when these patches were written).
 */

const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { ROOT, run, staleEdit } = require('../arch-i1/lib');
const up = require('../arch-i1/upstream');
const words = require('../arch-i1/conformance-words');
const w = require('./worlds');
const { o2Wire } = require('../wow-conformance/wire-checks');

const OVERLAY_2 = path.join(ROOT, 'wow-spec', 'overlays', 'iteration-2');
const OAS = path.join(ROOT, 'wow-spec', 'upstream', 'openapi-3.0');
const README = 'specification/OpenSpatialWorld/README.md';
const WOW = 'application/wow+json';

/** The GeoPose forms of iteration 1 that every later iteration must apply on: with and without the rotation sentences. */
const FORMS = Object.keys(up.FORMS);

/**
 * The iteration 2 World patch of each form. Its hunk 1 removes and re-adds iteration 1's Frames line (that line
 * closes info.description), so the without-form has its own copy, generated, never hand-edited.
 */
const WORLD_PATCH = {
  with: path.join(OVERLAY_2, 'OpenSpatialWorld.API.yaml.patch'),
  without: path.join(OVERLAY_2, 'without-rotation-sentences', 'OpenSpatialWorld.API.yaml.patch'),
};

/** The one sentence the without-form leaves out of the Frames line. */
const AXES_SENTENCE = ': at zero angles +X is east, +Y up and +Z south';

/**
 * How the without-form World patch differs from the with-form one, beyond hunk 1's two Frames lines (the removed
 * and the re-added one), each of which must differ only by the axes sentence. Empty when that is all.
 */
function variantProblems(withText, withoutText) {
  const a = withText.split('\n');
  const b = withoutText.split('\n');
  if (a.length !== b.length) return ['the without-form iteration 2 World patch has ' + b.length + ' lines, the with-form ' + a.length];
  const hunks = a.map((l, i) => (l.startsWith('@@') ? i : -1)).filter((i) => i >= 0);
  const end = hunks.length > 1 ? hunks[1] : a.length;
  const frames = new Set();
  for (let i = hunks[0] + 1; i < end; i += 1) if (/^[-+] {4}Frames\. /.test(a[i])) frames.add(i);
  const problems = [];
  if (frames.size !== 2) problems.push('hunk 1 of the with-form iteration 2 World patch has ' + frames.size + ' Frames lines, expected 2 (removed and re-added)');
  for (let i = 0; i < a.length; i += 1) {
    if (frames.has(i)) {
      if (a[i].split(AXES_SENTENCE).length !== 2) problems.push('line ' + (i + 1) + ' of the with-form patch does not carry the axes sentence once');
      else if (b[i] !== a[i].replace(AXES_SENTENCE, '')) problems.push('line ' + (i + 1) + ' (a Frames line) differs by more than the axes sentence');
    } else if (a[i] !== b[i]) problems.push('line ' + (i + 1) + ' differs between the forms and is not a hunk 1 Frames line');
  }
  return problems;
}

/**
 * The World API after iteration 1 and iteration 2, and the World README after iteration 2. `edits` swaps patch text.
 * `form` is the GeoPose form of iteration 1 underneath (with, the default, or without), and picks that form's World
 * patch; `edits.variant` swaps the without-form World patch text only; `baseEdits` swaps the iteration 1 patch text
 * of that form, as up.loadPatched takes it.
 */
function loadIteration2(edits, form, baseEdits) {
  edits = edits || {};
  const afterOne = up.loadPatched(baseEdits || null, form).world.text;
  let worldPatch = up.read(WORLD_PATCH[form || 'with']);
  if (form === 'without' && edits.variant) worldPatch = edits.variant(worldPatch);
  if (edits.world) worldPatch = edits.world(worldPatch);
  const worldText = up.applyUnifiedDiff(afterOne, worldPatch);
  const readmeOriginal = up.read(path.join(up.UPSTREAM, README));
  let readmePatch = up.read(path.join(OVERLAY_2, 'OpenSpatialWorld.README.md.patch'));
  if (edits.readme) readmePatch = edits.readme(readmePatch);
  return { world: up.yaml.load(worldText), worldText, readme: up.applyUnifiedDiff(readmeOriginal, readmePatch) };
}

/** The OpenAPI 3.0 schema (2021-09-28, draft-04), read with ajv: its one draft-04 construct is restated. */
let oasValidator = null;
function openApiValidator() {
  if (oasValidator) return oasValidator;
  const manifest = JSON.parse(up.read(path.join(OAS, 'SOURCE.json')));
  const file = Object.keys(manifest.files)[0];
  const text = up.read(path.join(OAS, file));
  if (up.sha256(text) !== manifest.files[file]) throw new Error('the vendored OpenAPI 3.0 schema is not the pinned file');
  const schema = JSON.parse(text);
  (function walk(n) {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      if (n.exclusiveMinimum === true) { n.exclusiveMinimum = n.minimum; delete n.minimum; }
      if (n.exclusiveMaximum === true) { n.exclusiveMaximum = n.maximum; delete n.maximum; }
      Object.values(n).forEach(walk);
    }
    return undefined;
  })(schema);
  schema.$id = schema.id;
  delete schema.id;
  delete schema.$schema;
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  oasValidator = ajv.compile(schema);
  return oasValidator;
}

const NODE_PATH = '/wow/spatial/{spatialID}/node/{nodeId}';
const OPS = [['/wow/world', 'get'], ['/wow/user/{userId}', 'get'], ['/wow/view/{viewId}', 'get'], ['/wow/portal/{portalId}', 'get'], ['/wow/spatial/{spatialID}', 'get'], [NODE_PATH, 'get'], [NODE_PATH, 'post'], [NODE_PATH, 'put']];
const CONDITIONAL_GETS = [['/wow/world', 'get'], ['/wow/spatial/{spatialID}', 'get'], [NODE_PATH, 'get']];
const GUARDED_WRITES = [[NODE_PATH, 'put'], [NODE_PATH, 'delete']];
const PARAGRAPHS = ['Media type.', 'Entity tags.', 'Cross-origin access.'];
/** The schemas whose `required` lists the offer and the served contract must share (O2) and iteration 2 touches or keeps (O3). */
const REQUIRED_COMPARED = ['GeoPose', 'Spatial', 'Node', 'User', 'View', 'Portal', 'World'];

/** The paragraph of info.description that starts with `start` (a paragraph ends at a blank line), or ''. */
function paragraph(doc, start) {
  return String((doc.info || {}).description || '').split(/\n\s*\n/).map(up.squash).find((p) => p.startsWith(start)) || '';
}

/** What iteration 2 says, read from one API description, so the offered and the served text can be compared. */
function iteration2Text(doc) {
  const canon = (n) => JSON.parse(JSON.stringify(up.withoutLabels(n), (k, v) => (k === 'description' && typeof v === 'string' ? up.squash(v) : v)));
  const op = (p, m) => (doc.paths[p] || {})[m] || {};
  const refs = (list) => (list || []).filter((x) => x && x.$ref).map((x) => x.$ref).sort();
  // A paragraph ends at a blank line, so paragraphs a later iteration adds after these are not part of them.
  const paragraphs = String((doc.info || {}).description || '').split(/\n\s*\n/).map(up.squash);
  return {
    spatials: canon(doc.components.schemas.World.properties.spatials),
    spatialAssetURI: canon(doc.components.schemas.Node.properties.spatialAssetURI),
    parameters: canon({ IfNoneMatch: doc.components.parameters.IfNoneMatch, IfMatch: doc.components.parameters.IfMatch }),
    headers: canon(doc.components.headers),
    responses: canon(doc.components.responses),
    mediaTypes: OPS.map(([p, m]) => {
      const o = op(p, m);
      const ok = (o.responses || {})['200'] || {};
      return [m + ' ' + p, Object.keys(ok.content || {}).slice(0, 2), Object.keys((o.requestBody || {}).content || {}).slice(0, 2)];
    }),
    conditional: CONDITIONAL_GETS.map(([p, m]) => {
      const o = op(p, m);
      const ok = (o.responses || {})['200'] || {};
      return [m + ' ' + p, refs(o.parameters), Object.keys(ok.headers || {}).filter((h) => h === 'ETag' || h === 'Last-Modified').sort(), ((o.responses || {})['304'] || {}).$ref || null];
    }),
    guarded: GUARDED_WRITES.map(([p, m]) => {
      const o = op(p, m);
      return [m + ' ' + p, refs(o.parameters), ((o.responses || {})['412'] || {}).$ref || null];
    }),
    paragraphs: PARAGRAPHS.map((start) => paragraphs.find((p) => p.startsWith(start)) || null),
    required: REQUIRED_COMPARED.map((name) => [name, ((doc.components.schemas[name] || {}).required || null)]),
  };
}

/** Run `fn(form)` on every GeoPose form; a throw (a patch that does not apply) is a failure that names the form. */
function eachForm(failures, fn) {
  for (const form of FORMS) {
    try { fn(form); } catch (error) {
      if (error && error.staleEdit) throw error;
      failures.push(form + '-form: ' + String((error && error.message) || error).slice(0, 200));
    }
  }
}

/** An exact edit of patch text; an edit that does not match exactly once is a stale planted fault. */
function swap(text, from, to, where) {
  const count = text.split(from).length - 1;
  if (count !== 1) throw staleEdit(where, from, count);
  return text.replace(from, () => to);
}

/** The rule for verifying an included part, in Node.spatialAssetURI's description, offered and served (O2). */
const VERIFY_I2 = [
  ['read from the part\'s own world', /A host MUST read an included part from the part's own world, at its URL, and MUST revalidate it by its entity tag\./],
  ['no relayed or embedded copy', /A copy of that part relayed or embedded by any other world MUST NOT be shown as that part\./],
  ['the placeholder when unreachable', /When the part's own world does not answer, the host SHOULD show the placeholder\./],
];
const verifyProblems = (description, where) => VERIFY_I2.filter(([, re]) => !re.test(String(description || ''))).map(([name]) => where + ' lacks the verification rule (' + name + ')');

async function overlayChecks(ports) {
  // The without-form's base, edited in the BCP 14 line that the iteration 2 World patch's first hunk reads as
  // context: only that form changes, so the check is red only if it really applies iteration 2 on the without-form too.
  const WW = 'wow-spec/overlays/iteration-1/without-rotation-sentences/OpenSpatialWorld.API.yaml.patch';
  const withoutBaseMoved = { baseEdits: { world: (p) => swap(p, 'in this document are to be interpreted', 'in this text are to be interpreted', WW) } };
  const hunkDoesNotApply = { edits: { world: (p) => p.replace('       operationId: getWorldStatus\n', '       operationId: getWorld\n') } };
  const danglingRef = { edits: { world: (p) => p.replace("+          $ref: '#/components/responses/PreconditionFailed'\n         '422':", "+          $ref: '#/components/responses/PreconditionFail'\n         '422':") } };
  const notOpenApi = { edits: { world: (p) => p.replace('+      name: If-Match\n+      in: header\n', '+      name: If-Match\n+      in: body\n') } };
  // The without-form World patch with one added line changed: it still applies and is valid, so only the
  // comparison with the with-form patch can see it.
  const WV = 'wow-spec/overlays/iteration-2/without-rotation-sentences/OpenSpatialWorld.API.yaml.patch';
  const variantOtherLine = { edits: { variant: (p) => swap(p, '+    Media type. Resources MUST be served as application/wow+json', '+    Media type. Resources MUST be sent as application/wow+json', WV) } };
  await run('O1', 'the iteration 2 patches apply to the Web of Worlds files at main after iteration 1\'s; the patched World API passes the OpenAPI 3.0 schema, declares every path parameter and resolves every $ref; the README gains the base-URL rule', async (impl) => {
    const failures = [];
    const manifest = JSON.parse(up.read(path.join(up.UPSTREAM, 'SOURCE.json')));
    for (const [rel, hash] of Object.entries(manifest.files)) if (up.sha256(up.read(path.join(up.UPSTREAM, rel))) !== hash) failures.push(rel + ' is not the pinned upstream file');
    try {
      let variant = up.read(WORLD_PATCH.without);
      if (impl.edits && impl.edits.variant) variant = impl.edits.variant(variant);
      failures.push(...variantProblems(up.read(WORLD_PATCH.with), variant).slice(0, 3).map((p) => 'variant: ' + p));
    } catch (error) {
      if (error && error.staleEdit) throw error;
      failures.push('variant: the without-form iteration 2 World patch cannot be read: ' + String((error && error.message) || error).slice(0, 160));
    }
    eachForm(failures, (form) => {
      const out = loadIteration2(impl.edits, form, form === 'without' ? impl.baseEdits : null);
      const validate = openApiValidator();
      if (!validate(out.world)) failures.push(form + '-form: OpenAPI 3.0 schema: ' + validate.errors.slice(0, 2).map((e) => e.instancePath + ' ' + e.message).join('; '));
      const params = up.pathParameterProblems(out.world);
      if (params.length) failures.push(form + '-form: ' + params[0]);
      const refs = up.refProblems(out.world);
      if (refs.length) failures.push(form + '-form: ' + refs[0]);
      if (!/its resource URLs MUST be the base plus wow\//.test(out.readme)) failures.push(form + '-form: the README lacks the base-URL rule');
      if (!/Any readable Spatial or Node may be included by another world/.test(out.readme)) failures.push(form + '-form: the README still says "Expose parts of scene"');
    });
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'both patches apply on both GeoPose forms of iteration 1 (the without-form World patch differs only in hunk 1\'s Frames lines); the World API passes the OpenAPI 3.0 schema with no path parameter or $ref problem; the README carries the base-URL and inclusion lines' };
  }, {}, [
    { name: 'a patch whose context no longer matches main', impl: hunkDoesNotApply },
    { name: 'a without-form base whose text the iteration 2 World patch reads has moved (only the without-form changes)', impl: withoutBaseMoved },
    { name: 'a patch with a $ref that resolves to nothing', impl: danglingRef },
    { name: 'a patch that is not valid OpenAPI (a parameter in: body)', impl: notOpenApi },
    { name: 'a without-form World patch with one other changed line (it still applies)', impl: variantOtherLine },
  ]);

  const offerDrifts = { edits: { world: (p) => p.replace("+          description: The ids of the world's graphs (Spatial resources), the default graph first.", "+          description: The ids of the world's graphs.") } };
  const W2V = 'wow-spec/overlays/iteration-2/OpenSpatialWorld.API.yaml.patch';
  const offerWithoutVerification = { edits: { world: (p) => swap(p, 'any other world MUST NOT be shown as that', 'any other world MAY be shown as that', W2V) } };
  const preflightLacksIfMatch = { serverEdits: { server: [["'Authorization, Content-Type, Accept, If-None-Match, If-Match, X-OSL-WoW-Node-Form, X-OSL-WoW-Spatial-Form'", "'Authorization, Content-Type, Accept, If-None-Match, X-OSL-WoW-Node-Form, X-OSL-WoW-Spatial-Form'"]] } };
  await run('O2', 'the offered text and the contract the lab serves say the same thing about inclusion, World.spatials, the media type, entity tags and cross-origin reads, and the world server does it on the wire', async (impl) => {
    const failures = [];
    const served = iteration2Text(up.yaml.load(up.read(path.join(ROOT, 'wow-spec', 'schema.yaml'))));
    eachForm(failures, (form) => {
      const offered = iteration2Text(loadIteration2(impl.edits, form).world);
      for (const key of Object.keys(offered)) {
        if (JSON.stringify(offered[key]) !== JSON.stringify(served[key])) failures.push(form + '-form: ' + key + ' differs between the offer and the lab contract');
      }
      if (offered.paragraphs.some((p) => !p)) failures.push(form + '-form: a paragraph is missing from the offer');
      failures.push(...verifyProblems(offered.spatialAssetURI.description, form + '-form: the offered Node.spatialAssetURI'));
    });
    failures.push(...verifyProblems(served.spatialAssetURI.description, 'the served Node.spatialAssetURI'));
    // On the wire (the wire half is shared with the conformance corpus: tools/wow-conformance/wire-checks.js o2Wire).
    const port = ports.next();
    const B = await w.world('b', port, { base: '/w/b', edits: impl.serverEdits });
    try {
      failures.push(...(await o2Wire(B.base)).problems);
    } finally { await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'offer = lab contract on ' + Object.keys(served).length + ' points (' + Object.keys(served).join(', ') + '), on both GeoPose forms; on the wire: application/wow+json (application/json on request), ETag and Last-Modified, spatials, ETag exposed, preflight allows Authorization, If-None-Match, If-Match' };
  }, {}, [
    { name: 'an offer whose World.spatials text drifted from the contract', impl: offerDrifts },
    { name: 'an offer whose Node.spatialAssetURI lacks the rule against a relayed copy', impl: offerWithoutVerification },
    { name: 'a world server whose preflight does not allow If-Match', impl: preflightLacksIfMatch },
  ]);

  await vocabularyCheck();
  await scopeCheck();
}

// ---------------------------------------------------------------------------------------------------
// O3, the conformance vocabulary of iteration 2.

/**
 * The `required` list of each schema iteration 2 touches (World gains spatials, Node.spatialAssetURI gains its
 * text). Iteration 2 adds no required member: these are iteration 1's lists, which iteration 2 must keep.
 */
const REQUIRED_I2 = { World: [], Node: ['id'] };

const nodeUri = (doc) => doc.components.schemas.Node.properties.spatialAssetURI.description;
const para = (start) => (doc) => paragraph(doc, start);
/** The normative sentences iteration 2 adds to the World API. Each anchor is a phrase of the sentence, found before and after the key words. */
const SENTENCES_I2 = [
  { where: 'Node.spatialAssetURI (what it may name)', text: nodeUri, anchor: 'Spatial, Node or wow/world resource' },
  { where: 'Node.spatialAssetURI (told apart by the media type)', text: nodeUri, anchor: 'media type of the answer' },
  { where: 'Node.spatialAssetURI (the environment)', text: nodeUri, anchor: 'environment' },
  { where: 'Node.spatialAssetURI (nesting limit and budget)', text: nodeUri, anchor: 'nesting limit' },
  { where: 'Node.spatialAssetURI (cycle refusal)', text: nodeUri, anchor: 'cycle' },
  { where: 'Node.spatialAssetURI (read from the part\'s own world)', text: nodeUri, anchor: 'own world, at its URL' },
  { where: 'Node.spatialAssetURI (no relayed or embedded copy)', text: nodeUri, anchor: 'relayed or embedded' },
  { where: 'info.description (application/wow+json)', text: para('Media type.'), anchor: 'served as application/wow+json' },
  { where: 'info.description (application/json beside it)', text: para('Media type.'), anchor: 'content negotiation' },
  { where: 'info.description (ETag, If-None-Match and 304)', text: para('Entity tags.'), anchor: 'If-None-Match' },
  { where: 'info.description (If-Match and 412)', text: para('Entity tags.'), anchor: '412' },
  { where: 'info.description (cross-origin response headers)', text: para('Cross-origin access.'), anchor: 'Access-Control-Expose-Headers' },
  { where: 'info.description (cross-origin preflight)', text: para('Cross-origin access.'), anchor: 'Preflight responses' },
];
/** The normative sentences iteration 2 adds to the World README (its text is the document). */
const SENTENCES_README = [
  { where: 'README (a path prefix)', text: (t) => t, anchor: 'path prefix' },
  { where: 'README (the base-URL rule)', text: (t) => t, anchor: 'the base plus wow/' },
];
const GENERATED = path.join(ROOT, 'wow-spec', 'generated', 'schema.json');

/** World keeps no required member, so a world without a graph (a flat or page-join world) is valid. */
const SPATIALS_RULE = 'A reader MUST treat an absent `spatials` as an empty list.';
const spatialsText = (doc) => ((((((doc || {}).components || {}).schemas || {}).World || {}).properties || {}).spatials || {}).description;
const spatialsRuleProblems = (doc, label) => (up.squash(spatialsText(doc) || '').includes(SPATIALS_RULE) ? [] : [label + ' World.spatials lacks "' + SPATIALS_RULE + '"']);
/** How many times a text carries the BCP 14 paragraph. */
const bcp14Count = (text) => up.squash(text || '').split(up.squash(words.BCP14)).length - 1;

/**
 * The lab's World reader, given Worlds without `spatials`: each must be read as the World with an empty list
 * (the same kind, status and detail), and the composition must not fail. `clientEdits` plants a fault in it.
 */
async function absentSpatialsProblems(clientEdits) {
  const reader = await w.client(clientEdits);
  const HOST = 'http://host.test/wow/spatial/1';
  const worlds = {
    'an empty list': { content: { label: 'a flat world' }, presence: { navigation: 'page' }, spatials: [] },
    'no spatials': { content: { label: 'a flat world' }, presence: { navigation: 'page' } },
    'no spatials and no content': { presence: { navigation: 'page' }, portals: {} },
  };
  const names = Object.keys(worlds);
  const worldUrl = (i) => 'http://world' + i + '.test/wow/world';
  const bodies = new Map([[HOST, { id: 1, rootNodeID: 0 }], [HOST + '/node/0', { id: 0, children: names.map((n, i) => ({ id: i + 1, label: n, spatialAssetURI: worldUrl(i) })) }]]);
  names.forEach((n, i) => bodies.set(worldUrl(i), worlds[n]));
  const fetchImpl = async (url) => (bodies.has(url)
    ? new Response(JSON.stringify(bodies.get(url)), { status: 200, headers: { 'Content-Type': WOW } })
    : new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } }));
  let composition;
  try { composition = await reader.composeInclusions(HOST, { fetch: fetchImpl }); } catch (error) {
    return ['the lab\'s World reader fails on a World with no spatials: ' + String((error && error.message) || error).slice(0, 120)];
  }
  const seen = (i) => { const x = composition.inclusions.find((inc) => inc.target === worldUrl(i)); return x ? JSON.stringify([x.kind, x.status, x.detail, x.graphs.length]) : 'no inclusion'; };
  const want = seen(0);
  const problems = [];
  names.forEach((n, i) => { if (i && seen(i) !== want) problems.push('the lab\'s World reader reads a World with ' + n + ' as ' + seen(i) + ', not as one with an empty list ' + want); });
  return problems;
}

async function vocabularyCheck() {
  const W2 = 'wow-spec/overlays/iteration-2/OpenSpatialWorld.API.yaml.patch';
  const R2 = 'wow-spec/overlays/iteration-2/OpenSpatialWorld.README.md.patch';
  // Hunk 1 of the World patch reads iteration 1's BCP 14 line as context; here it removes it (the patch still applies).
  const withoutParagraph = { edits: { world: (p) => swap(p, '\n     The key words ', '\n-    The key words ', W2) }, expect: /^with-form: offered World API after iteration 2: no BCP 14 paragraph/ };
  const sentenceWithoutKeyword = { edits: { world: (p) => swap(p, 'MUST honor If-Match and MUST answer 412', 'honor If-Match and answer 412', W2) }, expect: /^with-form: offered World API after iteration 2 info\.description \(If-Match and 412\): .* has no key word/ };
  const readmeWithoutKeyword = { edits: { readme: (p) => swap(p, 'its resource URLs MUST be the base plus wow/', 'its resource URLs are the base plus wow/', R2) }, expect: /^with-form: offered World README README \(the base-URL rule\): .* has no key word/ };
  const schemaWithoutList = { mutateOffered: (doc) => { delete doc.components.schemas.Node.required; }, expect: /^with-form: offered World API after iteration 2 Node has no required list/ };
  const servedDiffers = { mutateOsl: (osl) => { osl.components.schemas.World.required = ['spatials']; }, expect: /^served contract World has required \["spatials"\]|^with-form: served and offered differ: World / };
  const servedWithoutKeyword = { mutateOsl: (osl) => { osl.info.description = osl.info.description.replace('MUST be served as application/wow+json', 'are served as application/wow+json'); }, expect: /^served contract info\.description \(application\/wow\+json\): .* has no key word/ };
  const buildNotRebuilt = { mutateGenerated: (doc) => { delete doc.components.schemas.Node.required; }, expect: /^generated schema\.json Node has no required list/ };
  const readerFailsOnAbsent = { clientEdits: [['const ids = Array.isArray(answer.body.spatials) ? answer.body.spatials : [];', 'const ids = answer.body.spatials.slice();']], expect: /^the lab's World reader fails on a World with no spatials/ };
  const readmeWithoutBcp14 = { edits: { readme: (p) => swap(p, '\n+' + words.BCP14 + '\n', '\n+Key words in this document are used as defined elsewhere.\n', R2) }, expect: /^with-form: offered World README: the BCP 14 paragraph 0 times/ };
  const overlayReadmeParaphrase = { overlayReadme: (t) => swap(t, words.BCP14, 'The key words MUST, MUST NOT, SHOULD and MAY in this text are to be read as BCP 14 defines them (RFC 2119, RFC 8174).', 'wow-spec/overlays/iteration-2/README.md'), expect: /^the iteration 2 overlay README\.md: \d+ key words and the BCP 14 paragraph 0 times/ };
  const servedWithoutSpatialsRule = { mutateOsl: (osl) => { osl.components.schemas.World.properties.spatials.description = osl.components.schemas.World.properties.spatials.description.replace(' ' + SPATIALS_RULE, ''); }, expect: /^served contract World\.spatials lacks/ };

  await run('O3', 'the conformance vocabulary of iteration 2: the World API after iteration 2 carries the BCP 14 paragraph; each normative sentence iteration 2 adds (what spatialAssetURI may name, the nesting limit, budget and cycle refusal, application/wow+json beside application/json, ETag, If-None-Match and If-Match with 304 and 412, the cross-origin headers, the README\'s base-URL rule) uses a key word; the schemas iteration 2 touches keep their required lists; served equals offered equals built; on both GeoPose forms', async (impl) => {
    const failures = [];
    const osl = up.yaml.load(up.read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    if (impl.mutateOsl) impl.mutateOsl(osl);
    const generated = JSON.parse(up.read(GENERATED));
    if (impl.mutateGenerated) impl.mutateGenerated(generated);
    let counts = null;
    eachForm(failures, (form) => {
      const out = loadIteration2(impl.edits, form);
      if (impl.mutateOffered) impl.mutateOffered(out.world);
      const label = form + '-form: offered World API after iteration 2';
      if (!words.hasBcp14((out.world.info || {}).description)) failures.push(label + ': no BCP 14 paragraph citing RFC 2119 and RFC 8174 in info.description');
      failures.push(...words.sentenceProblems(out.world, SENTENCES_I2, label));
      failures.push(...words.sentenceProblems(out.readme, SENTENCES_README, form + '-form: offered World README'));
      failures.push(...words.requiredProblems(out.world.components.schemas, REQUIRED_I2, label));
      for (const diff of words.requiredDiffs(out.world.components.schemas, osl.components.schemas, Object.keys(REQUIRED_I2))) failures.push(form + '-form: served and offered differ: ' + diff);
      failures.push(...spatialsRuleProblems(out.world, label));
      const inReadme = bcp14Count(out.readme);
      if (inReadme !== 1) failures.push(form + '-form: offered World README: the BCP 14 paragraph ' + inReadme + ' times, wanted once');
      if (form === 'with') {
        const added = SENTENCES_I2.map((e) => words.sentenceWith(e.text(out.world), e.anchor) || '').join(' ');
        counts = { api: words.keywordCount(added), readme: words.keywordCount(SENTENCES_README.map((e) => words.sentenceWith(out.readme, e.anchor) || '').join(' ')) };
      }
    });
    // The served contract carries the same sentences with their key words, and its build the same lists.
    failures.push(...words.sentenceProblems(osl, SENTENCES_I2, 'served contract'));
    failures.push(...words.requiredProblems(osl.components.schemas, REQUIRED_I2, 'served contract'));
    failures.push(...words.requiredProblems(generated.components.schemas, REQUIRED_I2, 'generated schema.json'));
    for (const diff of words.requiredDiffs(osl.components.schemas, generated.components.schemas, Object.keys(REQUIRED_I2))) failures.push('generated schema.json is not the served contract: ' + diff);
    failures.push(...spatialsRuleProblems(osl, 'served contract'));
    failures.push(...spatialsRuleProblems(generated, 'generated schema.json'));
    // This overlay's own README.md uses key words, so it carries the BCP 14 paragraph exactly once, word for word.
    let overlayReadme = up.read(path.join(OVERLAY_2, 'README.md'));
    if (impl.overlayReadme) overlayReadme = impl.overlayReadme(overlayReadme);
    const readmeKeywords = words.keywordCount(overlayReadme);
    const readmeParagraphs = bcp14Count(overlayReadme);
    if (readmeKeywords && readmeParagraphs !== 1) failures.push('the iteration 2 overlay README.md: ' + readmeKeywords + ' key words and the BCP 14 paragraph ' + readmeParagraphs + ' times, wanted once');
    // The lab's World reader on a World without spatials.
    failures.push(...(await absentSpatialsProblems(impl.clientEdits)));

    if (impl.expect) return { ok: !failures.some((f) => impl.expect.test(f)), detail: failures.slice(0, 4).join('; ') || 'no failure' };
    counts = counts || { api: 0, readme: 0 };
    return {
      ok: failures.length === 0,
      detail: failures.length
        ? failures.length + ' problem(s): ' + failures.slice(0, 6).join('; ')
        : 'the World API after iteration 2 carries the BCP 14 paragraph on both forms; ' + SENTENCES_I2.length + ' normative sentences in the World API (' + counts.api + ' key words) and ' + SENTENCES_README.length + ' in the README (' + counts.readme + ') each use one, offered on both forms and served; required lists kept for ' + Object.entries(REQUIRED_I2).map(([n, l]) => n + (l.length ? ' [' + l.join(', ') + ']' : ' none')).join(', ') + '; served = offered = built; World.spatials says an absent spatials is an empty list (offered on both forms, served, built); the README and this overlay\'s README.md each carry the BCP 14 paragraph once; the lab\'s World reader reads a World without spatials as one with an empty list',
    };
  }, {}, [
    { name: 'an iteration 2 World patch that removes the BCP 14 paragraph (it still applies)', impl: withoutParagraph },
    { name: 'a normative sentence without a key word (If-Match and 412)', impl: sentenceWithoutKeyword },
    { name: 'a README base-URL rule without a key word', impl: readmeWithoutKeyword },
    { name: 'a schema without its required list after iteration 2 (Node)', impl: schemaWithoutList },
    { name: 'a served contract with a different required list (World)', impl: servedDiffers },
    { name: 'a served contract whose media-type sentence has no key word', impl: servedWithoutKeyword },
    { name: 'a generated schema.json not rebuilt from the served contract (Node without its list)', impl: buildNotRebuilt },
    { name: 'a World reader that fails on a World with no spatials', impl: readerFailsOnAbsent },
    { name: 'a README patch without the BCP 14 paragraph', impl: readmeWithoutBcp14 },
    { name: 'a served World.spatials without the rule for an absent spatials', impl: servedWithoutSpatialsRule },
    { name: 'an overlay README.md that paraphrases the BCP 14 paragraph', impl: overlayReadmeParaphrase },
  ]);
}

// ---------------------------------------------------------------------------------------------------
// O4, the scope statement in the README.

/** The scope paragraph, word for word as SCRAP Architecture wrote it (2026-11-14). */
const SCOPE_PARAGRAPH = '**Scope.** This API does not define rendering, physics simulation, spatial audio or input-device mapping. Those are matters for each client and engine. A world MAY carry such data in its assets, and this API carries it unchanged.';
const scopeCount = (text) => String(text || '').split(SCOPE_PARAGRAPH).length - 1;

async function scopeCheck() {
  const R2 = 'wow-spec/overlays/iteration-2/OpenSpatialWorld.README.md.patch';
  // The paragraph line is replaced, so the line count and the hunk header stay right and the patch still applies.
  const readmeWithoutScope = { edits: { readme: (p) => swap(p, '\n+' + SCOPE_PARAGRAPH + '\n', '\n+Further scope is decided later.\n', R2) }, expect: /^with-form: offered World README: the scope paragraph 0 times/ };
  await run('O4', 'the scope statement: the README after iteration 2 carries the scope paragraph (rendering, physics simulation, spatial audio and input-device mapping are outside this API) exactly once, on both GeoPose forms', async (impl) => {
    const failures = [];
    eachForm(failures, (form) => {
      const n = scopeCount(loadIteration2(impl.edits, form).readme);
      if (n !== 1) failures.push(form + '-form: offered World README: the scope paragraph ' + n + ' times, wanted once');
    });
    if (impl.expect) return { ok: !failures.some((f) => impl.expect.test(f)), detail: failures.slice(0, 4).join('; ') || 'no failure' };
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'the README after iteration 2 carries the scope paragraph exactly once, word for word, on both GeoPose forms' };
  }, {}, [
    { name: 'a README patch without the scope paragraph', impl: readmeWithoutScope },
  ]);
}

module.exports = { overlayChecks, loadIteration2, openApiValidator, FORMS, eachForm, swap, WORLD_PATCH, variantProblems };
