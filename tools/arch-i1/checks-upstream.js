'use strict';

/*
 * Iteration 1, the contribution to the Web of Worlds API descriptions.
 *
 *   U1  the overlay patches apply to the vendored upstream files, and the result is a consistent API
 *       description with no undeclared path parameter (the errata D5 and RES-14)
 *   U2  the text we offer upstream and the contract we serve and prove are the same text, `required` lists included
 *   U3  the conformance vocabulary: both APIs carry the BCP 14 paragraph, each normative sentence uses a key
 *       word, each schema iteration 1 touches has its `required` list, the served contract and its build say
 *       the same, and what every Lab world serves validates with those lists
 *   U4  readOnly and required (OpenAPI 3.0.3): a readOnly member in a required list is required in responses
 *       only; a create body without Node.id is accepted, a Node response without id fails
 *   E1  the errata of iteration 1 in normative words
 *   U5  both GeoPose forms: the overlay with the two rotation sentences and the overlay without them
 *       (wow-spec/overlays/iteration-1/without-rotation-sentences/) both apply, differ in exactly those two
 *       sentences, both pass U1 and U3, and each equals the served contract (the without-form with the two
 *       sentences taken out of it)
 *
 * U1 and U3 run on both forms. U2 and E1 compare the with-form, the text the served contract carries.
 *
 * The patches are the offer. U2 is what stops the offer and the proven contract drifting apart.
 */

const path = require('path');
const { ROOT, run, httpReq, staleEdit } = require('./lib');
const { UPSTREAM, read, sha256, patchText, loadPatched, pathParameterProblems, refProblems, withoutLabels, squash, yaml } = require('./upstream');
const words = require('./conformance-words');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const FRAMES = 'Frames. All coordinates MUST be in meters, right-handed, +Y up. A Spatial\'s GeoPose anchors its origin: at zero angles +X is east, +Y up and +Z south. All other positions are local to their parent.';
const NODE_PATH = '/wow/spatial/{spatialID}/node/{nodeId}';

/** The two GeoPose forms (tools/arch-i1/upstream.js FORMS). The without-form's frame paragraph ends at "anchors its origin." */
const FORM_NAMES = ['with', 'without'];
const FRAMES_WITHOUT = 'Frames. All coordinates MUST be in meters, right-handed, +Y up. A Spatial\'s GeoPose anchors its origin. All other positions are local to their parent.';
const FORM_FRAMES = { with: FRAMES, without: FRAMES_WITHOUT };
/** A failure of the with-form keeps the message it always had; one of the without-form names its form. */
const formLabel = (form) => (form === 'with' ? '' : 'without-rotation-sentences form: ');
/**
 * The two rotation sentences, as the with-form says them and as the without-form says them instead.
 * `files` names the patches that carry the sentence.
 */
const ROTATION_SENTENCES = [
  { name: 'the rotation order', with: 'applied about the local axes z, y and x in that order', without: 'as OGC GeoPose 1.0 Basic-YPR defines them', files: ['world', 'asset'] },
  { name: 'the axes at zero angles', with: ': at zero angles +X is east, +Y up and +Z south', without: '', files: ['world'] },
];
/** A text with the two rotation sentences taken out, the way the without-form takes them out. */
const dropRotationSentences = (text) => ROTATION_SENTENCES.reduce((t, r) => t.split(r.with).join(r.without), squash(text));

/** A schema with OSL's labels removed and every description's whitespace collapsed, so a line wrap is not a difference. */
function canon(node) {
  node = withoutLabels(node);
  return (function walk(n) {
    if (Array.isArray(n)) return n.map(walk);
    if (n && typeof n === 'object') return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, k === 'description' && typeof v === 'string' ? squash(v) : walk(v)]));
    return n;
  })(node);
}

const pathParams = (doc, method) => (((doc.paths || {})[NODE_PATH] || {})[method] || {}).parameters
  ? doc.paths[NODE_PATH][method].parameters.filter((p) => p.in === 'path').map((p) => ({ name: p.name, in: p.in, required: p.required, type: p.schema && p.schema.type }))
  : [];

const SPATIAL_PARAM = '+        - name: spatialID\n+          in: path\n+          description: ID of the graph the node belongs to\n+          required: true\n+          schema:\n+            type: integer\n';

/** U1 on one form's patched text: the path parameters, the $refs, the one GeoPose, the transform limits and that form's frame paragraph. */
function u1FormProblems(patched, form) {
  const failures = [];
  const { world, asset } = patched;

  // Without the patch the rule finds the five defects (four missing spatialID, nodeId missing and nodeid left over).
  const before = pathParameterProblems(world.originalDoc);
  if (before.length !== 6) failures.push('the unpatched upstream shows ' + before.length + ' path parameter problems; the known count is 6');
  const after = pathParameterProblems(world.doc);
  if (after.length) failures.push('patched World API: ' + after.slice(0, 2).join('; '));
  for (const [name, p] of [['World', world], ['Asset', asset]]) {
    const bad = refProblems(p.doc);
    if (bad.length) failures.push(name + ' API: ' + bad[0]);
  }

  // One GeoPose, used by every geoPose. Longitude is lon; lan, the earlier spelling, stays valid and deprecated.
  const schemas = world.doc.components.schemas;
  const position = (schemas.GeoPose && schemas.GeoPose.properties && schemas.GeoPose.properties.position) || {};
  const props = position.properties || {};
  const required = position.required || [];
  const alternatives = (position.anyOf || []).map((x) => JSON.stringify(x.required || []));
  if (!props.lon || props.lon.minimum !== -180 || props.lon.maximum !== 180) failures.push('GeoPose.position does not spell longitude lon, from -180 to 180');
  if (!required.includes('lat') || !required.includes('h') || required.includes('lon') || required.includes('lan')) failures.push('GeoPose.position does not require lat and h, with longitude left to anyOf');
  if (!alternatives.includes('["lon"]') || !alternatives.includes('["lan"]')) failures.push('GeoPose.position does not accept either lon or lan');
  if (!props.lan || props.lan.deprecated !== true || props.lan.minimum !== -180 || props.lan.maximum !== 180) failures.push('GeoPose.position does not carry lan as deprecated, with the range of lon');
  const usesGeoPose = (schema) => schema && (schema.$ref === '#/components/schemas/GeoPose' || (schema.allOf || []).some((x) => x.$ref === '#/components/schemas/GeoPose'));
  for (const name of ['World', 'User', 'View', 'Portal', 'Spatial']) {
    if (!usesGeoPose(schemas[name].properties.geoPose)) failures.push(name + '.geoPose is not the shared GeoPose');
  }
  if (!usesGeoPose(asset.doc.components.schemas.Asset.properties.geoPose)) failures.push('Asset.geoPose is not the shared GeoPose');
  if (!same(canon(asset.doc.components.schemas.GeoPose), canon(schemas.GeoPose))) failures.push('the Asset API and the World API define GeoPose differently');

  // The transform limits and the frame paragraph.
  const transform = schemas.Node.properties.localTransform;
  if (transform.minItems !== 16 || transform.maxItems !== 16) failures.push('Node.localTransform is not limited to 16 items');
  if (!squash(world.doc.info.description).includes(squash(FORM_FRAMES[form]))) failures.push('info.description does not carry the frame paragraph');

  return { failures, before: before.length };
}

/**
 * U2's comparison of one form's offered text with a served contract: GeoPose, the transform, the tree rules, the
 * Spatial ids and extent, the path parameters, the frame paragraph `frames` and the `required` lists.
 */
function contractDiffs(world, asset, osl, frames) {
  const failures = [];
  const offered = world.doc.components.schemas;
  const served = osl.components.schemas;
  let compared = 0;
  const compare = (label, a, b) => { compared += 1; if (!same(canon(a), canon(b))) failures.push(label + ' differs'); };

  compare('GeoPose', offered.GeoPose, served.GeoPose);
  compare('Asset GeoPose', asset.doc.components.schemas.GeoPose, served.GeoPose);
  for (const key of ['id', 'parent', 'children', 'localTransform']) compare('Node.' + key, offered.Node.properties[key], served.Node.properties[key]);
  for (const key of ['id', 'rootNodeID']) compare('Spatial.' + key, offered.Spatial.properties[key], served.Spatial.properties[key]);
  // Spatial.extent (X1): offered and served both carry it, and say the same.
  for (const [name, doc] of [['offered', offered], ['served', served]]) if (!doc.Spatial.properties.extent) failures.push('the ' + name + ' Spatial has no extent');
  compare('Spatial.extent', offered.Spatial.properties.extent, served.Spatial.properties.extent);
  for (const name of ['World', 'User', 'View', 'Portal', 'Spatial']) compare(name + '.geoPose', offered[name].properties.geoPose, served[name].properties.geoPose);
  for (const method of ['get', 'post', 'put', 'delete']) {
    const a = pathParams(world.doc, method);
    const b = pathParams(osl, method);
    compared += 1;
    if (!same(a, b)) failures.push(method.toUpperCase() + ' ' + NODE_PATH + ' path parameters differ: ' + JSON.stringify(a) + ' against ' + JSON.stringify(b));
  }
  for (const [name, doc] of [['offered', world.doc], ['served', osl]]) {
    compared += 1;
    if (!squash(doc.info.description).includes(squash(frames))) failures.push('the ' + name + ' description lacks the frame paragraph');
  }
  if (!/MUST NOT override a placement/.test(squash(asset.doc.components.schemas.Asset.properties.geoPose.description || ''))) failures.push('the Asset geoPose does not say it MUST NOT override a placement');
  // The `required` lists: the offered World API against the served contract, and the Asset API's GeoPose too.
  for (const diff of words.requiredDiffs(offered, served, REQUIRED_NAMES)) failures.push('required differs: ' + diff);
  for (const diff of words.requiredDiffs({ GeoPose: asset.doc.components.schemas.GeoPose }, served, ['GeoPose'])) failures.push('required differs: Asset ' + diff);
  compared += REQUIRED_NAMES.length + 1;
  return { failures, compared };
}

async function upstreamChecks(ports) {
  const lacksOneSpatialId = { world: (p) => p.replace(SPATIAL_PARAM, '') };
  const keepsNodeid = { world: (p) => p.replace('+        - name: nodeId\n           in: path\n           description: node id to delete', '+        - name: nodeid\n           in: path\n           description: node id to delete') };
  const dropsLon = { world: (p) => p.replace('+            lon:\n+              type: number\n+              minimum: -180\n+              maximum: 180\n', '') };
  const onlyLan = { world: (p) => p.replace('+            - required: [lon]\n', '') };
  const noItemLimits = { world: (p) => p.replace('+          minItems: 16\n+          maxItems: 16\n', '') };
  const assetKeepsInline = { asset: (p) => p.replace('+          allOf:\n+            - $ref: \'#/components/schemas/GeoPose\'\n', '+          type: object\n') };
  await run('U1', 'the overlay patches apply to the vendored upstream files; the patched World API has every path parameter declared, every $ref resolving, one GeoPose, and the transform limits; both GeoPose forms, each with its frame paragraph', async (impl) => {
    const failures = [];
    const manifest = JSON.parse(read(path.join(UPSTREAM, 'SOURCE.json')));
    for (const [rel, hash] of Object.entries(manifest.files)) {
      if (sha256(read(path.join(UPSTREAM, rel))) !== hash) failures.push(rel + ' is not the pinned upstream file');
    }
    // Each form: a patch that does not apply is a failure that names it.
    let before = null;
    for (const form of FORM_NAMES) {
      let patched;
      try { patched = loadPatched(impl.edits, form); } catch (error) { failures.push(formLabel(form) + 'a patch does not apply: ' + error.message); continue; }
      const r = u1FormProblems(patched, form);
      failures.push(...r.failures.map((f) => formLabel(form) + f));
      if (form === 'with') before = r.before;
    }

    return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 4).join('; ') : `${before} path parameter problems before the patch, 0 after; both files resolve every $ref; 6 geoPose members share one GeoPose; the transform is 16 items; both GeoPose forms (with and without the rotation sentences), each with its frame paragraph` };
  }, { edits: null }, [
    { name: 'a patch that leaves one operation without spatialID', impl: { edits: lacksOneSpatialId } },
    { name: 'a patch that keeps the misspelt nodeid', impl: { edits: keepsNodeid } },
    { name: 'a patch whose GeoPose drops lon', impl: { edits: dropsLon } },
    { name: 'a patch whose GeoPose accepts only lan', impl: { edits: onlyLan } },
    { name: 'a patch with no limit on localTransform', impl: { edits: noItemLimits } },
    { name: 'a patch that leaves the Asset geoPose without the shared definition', impl: { edits: assetKeepsInline } },
  ]);

  const oslDriftsTransform = (osl) => { osl.components.schemas.Node.properties.localTransform.maxItems = 12; };
  const oslDriftsGeoPose = (osl) => { osl.components.schemas.GeoPose.properties.position.properties.lon.minimum = -90; };
  const oslDropsWorldNote = (osl) => { delete osl.components.schemas.World.properties.geoPose.description; };
  const oslDropsParam = (osl) => { osl.paths[NODE_PATH].put.parameters = osl.paths[NODE_PATH].put.parameters.filter((p) => p.name !== 'spatialID'); };
  const patchDriftsTransform = { world: (p) => p.replace('+          minItems: 16\n', '+          minItems: 12\n') };
  const oslDriftsRequired = (osl) => { osl.components.schemas.Node.required = ['id', 'localTransform']; };
  const oslDriftsExtent = (osl) => { osl.components.schemas.Spatial.properties.extent.properties.min.maxItems = 4; };
  await run('U2', 'the text offered upstream and the contract OSL serves and proves say the same thing: GeoPose, the transform, the tree rules, the Spatial ids and extent, the path parameters and the frame paragraph', async (impl) => {
    const { world, asset } = loadPatched(impl.edits);
    const osl = yaml.load(read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    if (impl.mutateOsl) impl.mutateOsl(osl);
    const { failures, compared } = contractDiffs(world, asset, osl, FRAMES);
    if (impl.expect) return { ok: !failures.some((f) => impl.expect.test(f)), detail: failures.slice(0, 4).join('; ') || 'no failure' };
    return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 4).join('; ') : compared + ' members compared, each equal once OSL labels and line wraps are set aside, `required` lists included' };
  }, { edits: null }, [
    { name: 'a contract that limits localTransform to 12 items', impl: { mutateOsl: oslDriftsTransform } },
    { name: 'a contract whose longitude bound differs', impl: { mutateOsl: oslDriftsGeoPose } },
    { name: 'a contract without the World geoPose note', impl: { mutateOsl: oslDropsWorldNote } },
    { name: 'a contract that drops spatialID from one operation', impl: { mutateOsl: oslDropsParam } },
    { name: 'a patch that offers a different transform limit', impl: { edits: patchDriftsTransform } },
    { name: 'a contract whose Node requires a different list (caught as: required differs)', impl: { mutateOsl: oslDriftsRequired, expect: /^required differs: Node / } },
    { name: 'a contract whose Spatial.extent min allows 4 numbers (caught as: Spatial.extent differs)', impl: { mutateOsl: oslDriftsExtent, expect: /^Spatial\.extent differs$/ } },
  ]);

  await vocabularyCheck(ports);
  await readOnlyCheck(ports);
  await errataCheck(ports);
  await formsCheck();
}

// ---------------------------------------------------------------------------------------------------
// U3, the conformance vocabulary of iteration 1.

/** The `required` list of each schema iteration 1 touches. An empty list: the schema has no required member. */
const REQUIRED_WORLD = {
  GeoPose: ['position', 'angles'],
  Spatial: ['id', 'rootNodeID'],
  // Node.id is readOnly and required. OpenAPI 3.0.3: a readOnly member in a required list is required in
  // responses only, so a create body without id is valid; U4 proves the served contract checks it so.
  // localTransform stays optional: a PUT is a partial update, and a canonical PUT {label} is valid.
  Node: ['id'],
  User: ['id'],
  View: ['id'],
  Portal: ['id'],
  World: [],
};
const REQUIRED_ASSET = { GeoPose: ['position', 'angles'], Asset: [] };
const REQUIRED_NAMES = Object.keys(REQUIRED_WORLD);
/** Server-set members: readOnly, so a request body need not carry them. */
const READ_ONLY = [['Node', 'id']];

const schemaText = (name, prop) => (doc) => (prop ? doc.components.schemas[name].properties[prop] : doc.components.schemas[name]).description;
/** The normative sentences of the iteration 1 text. Each anchor is a phrase of the sentence, found before and after the key words. */
const SENTENCES_WORLD = [
  { where: 'info.description (frames)', text: (doc) => doc.info.description, anchor: 'right-handed' },
  { where: 'GeoPose (the writer)', text: schemaText('GeoPose'), anchor: 'A writer' },
  { where: 'GeoPose (the reader)', text: schemaText('GeoPose'), anchor: 'A reader' },
  { where: 'World.geoPose', text: schemaText('World', 'geoPose'), anchor: 'not a placement' },
  { where: 'Node.id', text: schemaText('Node', 'id'), anchor: 'within the world' },
  { where: 'Node.parent (one parent)', text: schemaText('Node', 'parent'), anchor: 'one parent' },
  { where: 'Node.parent (a move)', text: schemaText('Node', 'parent'), anchor: 'A PUT of `parent`' },
  { where: 'Node.children (a PUT)', text: schemaText('Node', 'children'), anchor: 'them out' },
  { where: 'Node.children (a refusal)', text: schemaText('Node', 'children'), anchor: 'children differ' },
  { where: 'Node.localTransform (16 numbers)', text: schemaText('Node', 'localTransform'), anchor: '4×4 matrix' },
  { where: 'Node.localTransform (no shear)', text: schemaText('Node', 'localTransform'), anchor: 'decompose' },
];
const SENTENCES_ASSET = [
  { where: 'Asset.geoPose (a host)', text: schemaText('Asset', 'geoPose'), anchor: 'choose a placement' },
  { where: 'Asset.geoPose (no override)', text: schemaText('Asset', 'geoPose'), anchor: 'override' },
];

/** The Lab worlds whose responses are measured on the wire, and what each GET returns. */
const ROLES = ['a', 'b', 'lobby', 'airport'];
const READS = [['/wow/world', 'World'], ['/wow/user/1', 'User'], ['/wow/view/1', 'View'], ['/wow/portal/1', 'Portal'], ['/wow/spatial/1', 'Spatial']];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const GENERATED = path.join(ROOT, 'wow-spec', 'generated', 'schema.json');

/** An exact edit of patch text; an edit that does not match exactly once is a stale planted fault. */
function swap(text, from, to, where) {
  const count = text.split(from).length - 1;
  if (count !== 1) throw staleEdit(where, from, count);
  return text.replace(from, () => to);
}
/** Drop the one added patch line that contains `needle`. */
function dropAdded(text, needle, where) {
  const lines = text.split('\n');
  const hits = lines.filter((l) => l.startsWith('+') && l.includes(needle)).length;
  if (hits !== 1) throw staleEdit(where, needle, hits);
  return lines.filter((l) => !(l.startsWith('+') && l.includes(needle))).join('\n');
}

/**
 * What one world serves for the iteration 1 resources, each measured against the canonical schema and its `required` list.
 * The wire half itself is shared with the conformance corpus (tools/wow-conformance/wire-checks.js u3Wire).
 */
async function wireProblems(role, port, impl, validator, schemas) {
  const { boot } = require('./harness');
  const { u3Wire } = require('../wow-conformance/wire-checks');
  const s = await boot(role, port, { edits: impl.edits || null });
  try {
    const r = await u3Wire('http://127.0.0.1:' + s.port, { label: role, validator, schemas, writes: true });
    return { problems: r.problems, measured: r.measured };
  } finally { await s.close(); }
}

/** The offered text of one form, as U3 labels it: the with-form is "offered", the text it always measured. */
const offeredLabel = (form) => (form === 'with' ? 'offered' : 'without-rotation-sentences form offered');

/**
 * U3 on one form's offered World and Asset APIs: the BCP 14 paragraph, key words, each normative sentence with
 * a key word, the required lists, readOnly, and the same required lists as the served contract `osl`.
 */
function u3OfferedProblems(world, asset, osl, label) {
  const failures = [];
  for (const [l, doc] of [[label + ' World API', world.doc], [label + ' Asset API', asset.doc]]) {
    if (!words.hasBcp14((doc.info || {}).description)) failures.push(l + ': no BCP 14 paragraph citing RFC 2119 and RFC 8174 in info.description');
  }
  const counts = { world: words.keywordCount(JSON.stringify(world.doc)), asset: words.keywordCount(JSON.stringify(asset.doc)) };
  if (!counts.world) failures.push(label + ' World API: no key word at all');
  if (!counts.asset) failures.push(label + ' Asset API: no key word at all');
  failures.push(...words.sentenceProblems(world.doc, SENTENCES_WORLD, label + ' World API'));
  failures.push(...words.sentenceProblems(asset.doc, SENTENCES_ASSET, label + ' Asset API'));
  failures.push(...words.requiredProblems(world.doc.components.schemas, REQUIRED_WORLD, label + ' World API'));
  failures.push(...words.requiredProblems(asset.doc.components.schemas, REQUIRED_ASSET, label + ' Asset API'));
  const schemas = world.doc.components.schemas;
  for (const [name, prop] of READ_ONLY) if (((schemas[name] || {}).properties || {})[prop] && schemas[name].properties[prop].readOnly !== true) failures.push(label + ' World API ' + name + '.' + prop + ' is not readOnly');
  for (const diff of words.requiredDiffs(schemas, osl.components.schemas, REQUIRED_NAMES)) failures.push('served and ' + label + ' differ: ' + diff);
  return { failures, counts };
}

async function vocabularyCheck(ports) {
  const base = (Number(process.env.OSL_ARCH_I1_PORT_A) || 18860) + 500; // clear of the ports the proof's other checks take
  let used = 0;
  const port = () => (ports && ports.next ? ports.next() : base + used++);

  const W = 'wow-spec/overlays/iteration-1/OpenSpatialWorld.API.yaml.patch';
  const A = 'wow-spec/overlays/iteration-1/OpenSpatialAsset.API.yaml.patch';
  const worldWithoutParagraph = { edits: null, patch: { world: (p) => dropAdded(p, 'The key words', W) }, expect: /^offered World API: no BCP 14 paragraph/ };
  const assetWithoutParagraph = { edits: null, patch: { asset: (p) => dropAdded(p, 'The key words', A) }, expect: /^offered Asset API: no BCP 14 paragraph/ };
  const sentenceWithoutKeyword = { edits: null, patch: { world: (p) => swap(p, 'All coordinates MUST be in meters', 'All coordinates are in meters', W) }, expect: /^offered World API info\.description \(frames\): .* has no key word/ };
  const schemaWithoutList = { edits: null, patch: { world: (p) => dropAdded(p, 'required: [id, rootNodeID]', W) }, expect: /^offered World API Spatial has no required list/ };
  const servedDiffers = { edits: null, mutateOsl: (osl) => { osl.components.schemas.Node.required = ['id', 'localTransform']; }, expect: /^served contract Node requires \["id","localTransform"\]|^served and offered differ: Node / };
  const buildNotRebuilt = { edits: null, mutateGenerated: (doc) => { delete doc.components.schemas.Spatial.required; }, expect: /^generated schema\.json Spatial has no required list/ };
  const responseLacksMember = { edits: { 'runtime-spatial.js': [['            rootNodeID : rootNodeID,\n', '']] }, expect: /missing required member rootNodeID of Spatial/ };

  await run('U3', 'the conformance vocabulary: the World and Asset APIs carry the BCP 14 paragraph (RFC 2119, RFC 8174), each normative sentence of iteration 1 uses a key word, each schema iteration 1 touches has its required list, served equals offered, and every Lab world\'s responses validate with those lists; the offered text of both GeoPose forms', async (impl) => {
    const failures = [];
    const osl = yaml.load(read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    if (impl.mutateOsl) impl.mutateOsl(osl);
    const generated = JSON.parse(read(GENERATED));
    if (impl.mutateGenerated) impl.mutateGenerated(generated);

    // 1 to 4 for the offered text of each form: the BCP 14 paragraph, the key words, the required lists, readOnly, served equals offered.
    let counts = null;
    for (const form of FORM_NAMES) {
      let patched;
      try { patched = loadPatched(impl.patch || null, form); } catch (error) { failures.push(offeredLabel(form) + ': a patch does not apply: ' + error.message); continue; }
      const r = u3OfferedProblems(patched.world, patched.asset, osl, offeredLabel(form));
      failures.push(...r.failures);
      if (form === 'with') counts = r.counts;
    }
    counts = counts || { world: 0, asset: 0 };

    // 1. The BCP 14 paragraph in the served contract.
    if (!words.hasBcp14((osl.info || {}).description)) failures.push('served contract: no BCP 14 paragraph citing RFC 2119 and RFC 8174 in info.description');
    // 2. Each normative sentence uses a key word in the served contract.
    failures.push(...words.sentenceProblems(osl, SENTENCES_WORLD, 'served contract'));
    // 3. The served contract and its build have their required lists, and a server-set member is readOnly.
    failures.push(...words.requiredProblems(osl.components.schemas, REQUIRED_WORLD, 'served contract'));
    failures.push(...words.requiredProblems(generated.components.schemas, REQUIRED_WORLD, 'generated schema.json'));
    for (const [name, prop] of READ_ONLY) if (((osl.components.schemas[name] || {}).properties || {})[prop] && osl.components.schemas[name].properties[prop].readOnly !== true) failures.push('served contract ' + name + '.' + prop + ' is not readOnly');
    // 4. The build the server loads equals the served contract.
    for (const diff of words.requiredDiffs(osl.components.schemas, generated.components.schemas, REQUIRED_NAMES)) failures.push('generated schema.json is not the served contract: ' + diff);

    // 5. On the wire: what every Lab world serves validates with these lists (the build the server loads).
    let measured = 0;
    if (!failures.length || impl.edits) {
      const { createValidator } = require(path.join(ROOT, 'wow-spec', 'validate'));
      const validator = createValidator({ doc: generated });
      for (const role of ROLES) {
        const r = await wireProblems(role, port(), impl, validator, generated.components.schemas);
        failures.push(...r.problems);
        measured += r.measured;
      }
    }

    if (impl.expect) return { ok: !failures.some((f) => impl.expect.test(f)), detail: failures.slice(0, 4).join('; ') || 'no failure' };
    return {
      ok: failures.length === 0,
      detail: failures.length
        ? failures.length + ' problem(s): ' + failures.slice(0, 6).join('; ')
        : 'both APIs and the served contract carry the BCP 14 paragraph; key words: World API ' + counts.world + ', Asset API ' + counts.asset
          + '; ' + (SENTENCES_WORLD.length + SENTENCES_ASSET.length) + ' normative sentences each use one; required lists as listed for '
          + (REQUIRED_NAMES.length + 1) + ' schemas (' + [...Object.entries(REQUIRED_WORLD), ['Asset', []]].map(([n, l]) => n + (l.length ? ' [' + l.join(', ') + ']' : ' none')).join(', ')
          + '), served = offered = built; both GeoPose forms; ' + measured + ' responses from ' + ROLES.length + ' Lab worlds validate',
    };
  }, { edits: null }, [
    { name: 'a World patch without the BCP 14 paragraph', impl: worldWithoutParagraph },
    { name: 'an Asset patch without the BCP 14 paragraph', impl: assetWithoutParagraph },
    { name: 'a normative sentence without a key word (the frame sentence)', impl: sentenceWithoutKeyword },
    { name: 'a schema without its required list (Spatial)', impl: schemaWithoutList },
    { name: 'a served contract with a different required list (Node)', impl: servedDiffers },
    { name: 'a generated schema.json not rebuilt from the served contract', impl: buildNotRebuilt },
    { name: 'a server response missing a required member (Spatial without rootNodeID)', impl: responseLacksMember },
  ]);
}

// ---------------------------------------------------------------------------------------------------
// U4, readOnly and required (OpenAPI 3.0.3): a property that is readOnly and in a required list is required
// only in responses. The served contract lists Node [id], id readOnly. The enforcer the Lab world serves
// with must accept a create body without id, still refuse a body of the wrong type, and fail a Node
// response without id.

const ENFORCER = 'runtime/world-server/src/wow-contract-enforcer.js';
const ENFORCER_FILE = 'wow-contract-enforcer.js';

async function readOnlyCheck(ports) {
  const base = (Number(process.env.OSL_ARCH_I1_PORT_A) || 18860) + 600; // clear of U3's ports
  let used = 0;
  const port = () => (ports && ports.next ? ports.next() : base + used++);
  const { loadMutant } = require('./lib');
  const { boot } = require('./harness');

  const noExemption = { edits: { [ENFORCER_FILE]: [['runValidate(key, requestForm(entry.schema), entry.name, body, REQUEST_BUNDLE_ID)', 'runValidate(key, entry.schema, entry.name, body)']] }, expect: /^POST a create body without id answered 422/ };
  const exemptResponses = { edits: { [ENFORCER_FILE]: [['        const r = runValidate(key, entry.schema, entry.name, body);\n', '        const r = runValidate(key, requestForm(entry.schema), entry.name, body, REQUEST_BUNDLE_ID);\n']] }, expect: /^a Node response without id passes/ };
  const noRequestCheck = { edits: { [ENFORCER_FILE]: [["        if (!entry) return null;\n        const key = 'req:'", "        return null;\n        const key = 'req:'"]] }, expect: /^POST a body with label of the wrong type was not refused by the contract/ };
  const contractWithoutList = { edits: null, mutateGenerated: (doc) => { delete doc.components.schemas.Node.required; }, expect: /^a Node response without id passes/ };

  await run('U4', 'readOnly and required (OpenAPI 3.0.3): with Node required [id] served, POST /wow/spatial/1/node/0 with a body without id answers 200, a body of the wrong type is still refused, and a Node response without id fails validation', async (impl) => {
    const failures = [];
    const generated = JSON.parse(read(GENERATED));
    if (impl.mutateGenerated) impl.mutateGenerated(generated);
    const node = generated.components.schemas.Node || {};
    const servesList = Array.isArray(node.required) && node.required.includes('id') && ((node.properties || {}).id || {}).readOnly === true;
    if (!servesList && !impl.mutateGenerated) failures.push('the served contract (generated schema.json) does not list Node.id as required and readOnly, so there is nothing to measure');

    // 1. Request bodies, on the wire, from a Lab world (it loads the served contract).
    let made = null;
    const s = await boot('a', port(), { edits: impl.edits || null });
    try {
      made = await httpReq('POST', s.port, '/wow/spatial/1/node/0', [{ label: 'u4-create', localTransform: IDENTITY }]);
      if (made.status !== 200 || !Array.isArray(made.json)) failures.push('POST a create body without id answered ' + made.status + ': ' + String(made.body).slice(0, 140));
      else if (!made.json.every((n) => n && Number.isInteger(n.id))) failures.push('POST a create body without id answered 200 with a node that has no integer id');
      const wrong = await httpReq('POST', s.port, '/wow/spatial/1/node/0', [{ label: 5, localTransform: IDENTITY }]);
      const verdict = String(wrong.headers['x-osl-wow-validation'] || '');
      if (wrong.status !== 422 || !verdict.startsWith('fail:')) failures.push('POST a body with label of the wrong type was not refused by the contract: ' + wrong.status + ', X-OSL-WoW-Validation ' + JSON.stringify(verdict));
    } finally { await s.close(); }

    // 2. Responses, through the same enforcer module, driven by the served contract.
    const edits = (impl.edits || {})[ENFORCER_FILE] || [];
    const { createContractEnforcer } = edits.length ? loadMutant(ENFORCER, edits) : require(path.join(ROOT, ENFORCER));
    const enforcer = createContractEnforcer({ doc: generated });
    const served = made && Array.isArray(made.json) && made.json[0] ? made.json[0] : { id: 7, label: 'u4', localTransform: IDENTITY };
    const withoutId = Object.fromEntries(Object.entries(served).filter(([k]) => k !== 'id'));
    const kept = enforcer.responseVerdict('GET', '/wow/spatial/1/node/' + served.id, 200, served, {});
    if (!kept || kept.valid !== true) failures.push('a Node response with its id does not pass: ' + JSON.stringify(kept && (kept.errorsText || kept.header)));
    const lost = enforcer.responseVerdict('GET', '/wow/spatial/1/node/' + served.id, 200, withoutId, {});
    if (!lost || lost.valid !== false || !/'id'/.test(String(lost.errorsText))) failures.push('a Node response without id passes validation: ' + JSON.stringify(lost && (lost.header + ' ' + (lost.errorsText || ''))));
    const lostInArray = enforcer.responseVerdict('POST', '/wow/spatial/1/node/0', 200, [withoutId], {});
    if (!lostInArray || lostInArray.valid !== false) failures.push('a Node response without id passes validation in a POST array: ' + JSON.stringify(lostInArray && lostInArray.header));

    if (impl.expect) return { ok: !failures.some((f) => impl.expect.test(f)), detail: failures.slice(0, 4).join('; ') || 'no failure' };
    return {
      ok: failures.length === 0,
      detail: failures.length
        ? failures.length + ' problem(s): ' + failures.slice(0, 4).join('; ')
        : 'served Node requires [id], id readOnly; POST /wow/spatial/1/node/0 without id answered 200 (id ' + served.id + ' assigned); a body with label of the wrong type answered 422 with a fail: verdict'
          + '; a Node response without id fails (' + lost.header + ': ' + String(lost.errorsText).slice(0, 60) + '), in a GET and in a POST array',
    };
  }, { edits: null }, [
    { name: 'an enforcer that requires readOnly members in request bodies (caught as: POST without id answered 422)', impl: noExemption },
    { name: 'an enforcer that drops readOnly members from responses too (caught as: a Node response without id passes)', impl: exemptResponses },
    { name: 'an enforcer that skips the request check (caught as: a wrong type not refused by the contract)', impl: noRequestCheck },
    { name: 'a served contract without Node required (caught as: a Node response without id passes)', impl: contractWithoutList },
  ]);
}

// ---------------------------------------------------------------------------------------------------
// E1, the errata of iteration 1 in normative words. One sub-assertion per erratum: its normative
// sentence is present with its key word, and the schema fact it states holds. Each is measured in the
// offered World API, in the offered Asset API where the erratum is there too, and in the served contract.

/** Each sentence: the erratum, where it is, a phrase that finds the sentence, and the normative words it must say. */
const ERRATA_SENTENCES = [
  { erratum: 'lon (the writer)', text: schemaText('GeoPose'), anchor: 'A writer', words: /\bMUST send `lon`/, asset: true },
  { erratum: 'lan (the reader accepts)', text: schemaText('GeoPose'), anchor: 'accept `lan`', words: /\bMUST (?:also )?accept `lan`/, asset: true },
  { erratum: 'lan (the reader refuses a mismatch)', text: schemaText('GeoPose'), anchor: 'differ', words: /\bMUST refuse a position whose `lon` and `lan` differ/, asset: true },
  { erratum: 'lan (a server never emits it)', text: schemaText('GeoPose'), anchor: 'emit `lan`', words: /\bserver MUST NOT emit `lan`/, asset: true },
  { erratum: 'Spatial.id is an integer', text: schemaText('Spatial', 'id'), anchor: 'integer', words: /\bMUST be an integer/ },
  { erratum: 'Spatial.rootNodeID is an integer', text: schemaText('Spatial', 'rootNodeID'), anchor: 'integer', words: /\bMUST be an integer/ },
];
const NODE_METHODS = ['get', 'post', 'put', 'delete'];

/** The erratum sentences of one document that are missing or lack their normative words. */
function errataSentenceProblems(doc, label, assetOnly) {
  const problems = [];
  for (const e of ERRATA_SENTENCES) {
    if (assetOnly && !e.asset) continue;
    let text = null;
    try { text = e.text(doc); } catch (error) { text = null; }
    const sentence = words.sentenceWith(text, e.anchor);
    if (!sentence) problems.push('E1 ' + e.erratum + ': ' + label + ' has no sentence with "' + e.anchor + '"');
    else if (!e.words.test(sentence)) problems.push('E1 ' + e.erratum + ': ' + label + ' says "' + sentence.slice(0, 90) + '", without ' + e.words.source.replace(/\\b/g, ''));
  }
  return problems;
}

/** The schema facts of the errata in one document's GeoPose, Spatial and node operations. */
function errataFactProblems(doc, label, assetOnly) {
  const problems = [];
  const schemas = (doc.components || {}).schemas || {};
  const position = (((schemas.GeoPose || {}).properties || {}).position) || {};
  const props = position.properties || {};
  const alternatives = (position.anyOf || []).map((x) => JSON.stringify(x.required || []));
  if (!props.lon || !alternatives.includes('["lon"]')) problems.push('E1 lon (the writer): ' + label + ' GeoPose.position does not carry lon as one way to give longitude');
  if (!props.lan || !alternatives.includes('["lan"]')) problems.push('E1 lan (the reader accepts): ' + label + ' GeoPose.position does not accept lan');
  if (props.lan && props.lon && (props.lan.minimum !== props.lon.minimum || props.lan.maximum !== props.lon.maximum || props.lan.type !== props.lon.type)) problems.push('E1 lan (the reader refuses a mismatch): ' + label + ' lan and lon have different types or ranges, so they are not one value');
  if (!props.lan || props.lan.deprecated !== true) problems.push('E1 lan (a server never emits it): ' + label + ' GeoPose.position.lan is not deprecated');
  if (assetOnly) return problems;
  for (const key of ['id', 'rootNodeID']) {
    const p = ((schemas.Spatial || {}).properties || {})[key];
    if (!p || p.type !== 'integer') problems.push('E1 Spatial.' + key + ' is an integer: ' + label + ' types it ' + JSON.stringify(p && p.type));
  }
  const ops = (doc.paths || {})[NODE_PATH] || {};
  for (const method of NODE_METHODS) {
    const params = ((ops[method] || {}).parameters || []).filter((p) => p.in === 'path');
    const spatial = params.find((p) => p.name === 'spatialID');
    if (!spatial || spatial.required !== true || !spatial.schema || spatial.schema.type !== 'integer') problems.push('E1 spatialID on the node operations: ' + label + ' ' + method.toUpperCase() + ' ' + NODE_PATH + ' does not declare spatialID as a required integer path parameter');
    if (!params.some((p) => p.name === 'nodeId')) problems.push('E1 nodeId: ' + label + ' ' + method.toUpperCase() + ' ' + NODE_PATH + ' does not declare nodeId');
    if (params.some((p) => p.name === 'nodeid')) problems.push('E1 nodeId: ' + label + ' ' + method.toUpperCase() + ' ' + NODE_PATH + ' still declares nodeid');
  }
  return problems;
}

/**
 * The wire half of "a server MUST NOT emit `lan`": every GeoPose position in what one Lab world serves for the
 * reads the proof already makes (World, User, View, Portal, Spatial, the node tree and a node created by POST).
 * Returns the responses scanned and the positions inspected per resource, and every position that carries `lan`.
 * A Node carries no geoPose in the contract; its responses are scanned all the same, so one that grew a geoPose is measured.
 */
async function lanOnTheWire(role, port, impl) {
  const { boot } = require('./harness');
  const problems = [];
  const inspected = {};
  const scanned = {};
  const s = await boot(role, port, { edits: impl.edits || null });
  const scan = (label, value) => {
    scanned[label] = (scanned[label] || 0) + 1;
    const stack = [[value, '$']];
    while (stack.length) {
      const [v, at] = stack.pop();
      if (!v || typeof v !== 'object') continue;
      if (Array.isArray(v)) { v.forEach((x, i) => stack.push([x, at + '[' + i + ']'])); continue; }
      for (const [k, x] of Object.entries(v)) {
        if (k === 'geoPose' && x && typeof x === 'object' && x.position && typeof x.position === 'object') {
          inspected[label] = (inspected[label] || 0) + 1;
          if (Object.prototype.hasOwnProperty.call(x.position, 'lan')) problems.push('E1 lan (a server never emits it): on the wire, ' + role + ' ' + label + ' emits lan at ' + at + '.geoPose.position: ' + JSON.stringify(x.position).slice(0, 100));
        }
        stack.push([x, at + '.' + k]);
      }
    }
  };
  try {
    let rootId = 0;
    for (const [route, name] of READS) {
      const r = await httpReq('GET', s.port, route);
      if (r.status !== 200 || !r.json) { problems.push('E1 lan (a server never emits it): on the wire, ' + role + ' GET ' + route + ' answered ' + r.status); continue; }
      scan(name, r.json);
      if (name === 'Spatial' && Number.isInteger(r.json.rootNodeID)) rootId = r.json.rootNodeID;
    }
    const tree = await httpReq('GET', s.port, '/wow/spatial/1/node/' + rootId);
    if (tree.status !== 200 || !tree.json) problems.push('E1 lan (a server never emits it): on the wire, ' + role + ' GET the root node answered ' + tree.status);
    else scan('Node', tree.json);
    const made = await httpReq('POST', s.port, '/wow/spatial/1/node/' + rootId, [{ label: 'e1-' + role, localTransform: IDENTITY }]);
    if (made.status !== 200 || !Array.isArray(made.json)) problems.push('E1 lan (a server never emits it): on the wire, ' + role + ' POST a node answered ' + made.status);
    else scan('Node', made.json);
  } finally { await s.close(); }
  return { problems, inspected, scanned };
}

async function errataCheck(ports) {
  const base = (Number(process.env.OSL_ARCH_I1_PORT_A) || 18860) + 700; // clear of U3's and U4's ports
  let used = 0;
  const port = () => (ports && ports.next ? ports.next() : base + used++);
  const W = 'wow-spec/overlays/iteration-1/OpenSpatialWorld.API.yaml.patch';
  const writerSends = { patch: { world: (p) => swap(p, 'A writer MUST send `lon`.', 'A writer sends `lon`.', W) }, expect: /^E1 lon \(the writer\): offered World API says .*without MUST send/ };
  const refusalDropped = { patch: { world: (p) => swap(p, 'spelling, and MUST refuse a position whose `lon` and `lan` differ.', 'spelling.', W) }, expect: /^E1 lan \(the reader refuses a mismatch\): offered World API has no sentence/ };
  const lanNotDeprecated = { patch: { world: (p) => dropAdded(p, 'deprecated: true', W) }, expect: /^E1 lan \(a server never emits it\): offered World API GeoPose\.position\.lan is not deprecated/ };
  const lacksSpatialId = { patch: { world: (p) => swap(p, '       operationId: addNewNodes\n       parameters:\n' + SPATIAL_PARAM, '       operationId: addNewNodes\n       parameters:\n', W) }, expect: /^E1 spatialID on the node operations: offered World API POST / };
  const serverSentenceDropped = { patch: { world: (p) => swap(p, ' A server MUST NOT emit `lan`.', '', W) }, expect: /^E1 lan \(a server never emits it\): offered World API has no sentence/ };
  const keepsNodeidE1 = { patch: { world: (p) => swap(p, '+        - name: nodeId\n           in: path\n           description: node id to delete', '+        - name: nodeid\n           in: path\n           description: node id to delete', W) }, expect: /^E1 nodeId: offered World API DELETE .* still declares nodeid/ };
  const spatialIdNumber = { patch: { world: (p) => swap(p, '         id: \n-          type: number\n+          type: integer\n', '         id: \n           type: number\n', W) }, expect: /^E1 Spatial\.id is an integer: offered World API types it "number"/ };
  const servedWriterSends = { mutateOsl: (osl) => { osl.components.schemas.GeoPose.description = osl.components.schemas.GeoPose.description.replace('A writer MUST send `lon`.', 'A writer sends `lon`.'); }, expect: /^E1 lon \(the writer\): served contract says/ };
  const assetRefusalDropped = { patch: { asset: (p) => swap(p, 'spelling, and MUST refuse a position whose `lon` and `lan` differ.', 'spelling.', 'wow-spec/overlays/iteration-1/OpenSpatialAsset.API.yaml.patch') }, expect: /^E1 lan \(the reader refuses a mismatch\): offered Asset API has no sentence/ };
  const serverEmitsLan = { edits: { 'runtime-view-projection.js': [['position : { lat : round(pose.position.lat, 11), lon : round(pose.position.lon, 11), h : round(pose.position.h, 4) },', 'position : { lat : round(pose.position.lat, 11), lon : round(pose.position.lon, 11), lan : round(pose.position.lon, 11), h : round(pose.position.h, 4) },']] }, expect: /^E1 lan \(a server never emits it\): on the wire, \S+ \S+ emits lan at / };

  await run('E1', 'the errata of iteration 1 in normative words: a writer MUST send lon, a reader MUST accept lan and MUST refuse a lon/lan mismatch, a server MUST NOT emit lan (deprecated, and no GeoPose position any Lab world serves carries it), spatialID on the four node operations, nodeId, and integer Spatial ids; each sentence carries its key word and each schema fact holds, offered and served', async (impl) => {
    const failures = [];
    const { world, asset } = loadPatched(impl.patch || null);
    const osl = yaml.load(read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    if (impl.mutateOsl) impl.mutateOsl(osl);
    for (const [label, doc, assetOnly] of [['offered World API', world.doc, false], ['offered Asset API', asset.doc, true], ['served contract', osl, false]]) {
      failures.push(...errataSentenceProblems(doc, label, assetOnly));
      failures.push(...errataFactProblems(doc, label, assetOnly));
    }
    // On the wire: no GeoPose position any Lab world serves carries `lan`, and the count proves positions were read.
    const inspected = {};
    const scanned = {};
    if (!failures.length || impl.edits) {
      for (const role of ROLES) {
        const r = await lanOnTheWire(role, port(), impl);
        failures.push(...r.problems);
        for (const [name, n] of Object.entries(r.inspected)) inspected[name] = (inspected[name] || 0) + n;
        for (const [name, n] of Object.entries(r.scanned)) scanned[name] = (scanned[name] || 0) + n;
      }
      const total = Object.values(inspected).reduce((a, b) => a + b, 0);
      // The GeoPose-bearing resources of the contract among these reads; each must yield positions, so the check cannot pass empty.
      for (const name of ['Spatial', 'Portal', 'View']) if (!inspected[name]) failures.push('E1 lan (a server never emits it): on the wire, no GeoPose position inspected in any ' + name + ' response, so the absence of lan is not measured there');
      if (!total) failures.push('E1 lan (a server never emits it): on the wire, 0 GeoPose positions inspected');
      if (!scanned.Node) failures.push('E1 lan (a server never emits it): on the wire, no Node response scanned');
    }
    const positions = Object.values(inspected).reduce((a, b) => a + b, 0);
    if (impl.expect) return { ok: !failures.some((f) => impl.expect.test(f)), detail: failures.slice(0, 4).join('; ') || 'no failure' };
    const errata = new Set(failures.map((f) => f.split(':')[0]));
    return {
      ok: failures.length === 0,
      detail: failures.length
        ? failures.length + ' problem(s) in ' + errata.size + ' erratum/errata: ' + failures.slice(0, 6).join('; ')
        : ERRATA_SENTENCES.length + ' erratum sentences each say their key words (World API, served contract; the 4 GeoPose ones in the Asset API too); lon and lan share one range, lan is deprecated and no GeoPose position on the wire carries it (' + positions + ' positions from ' + ROLES.length + ' Lab worlds: ' + Object.entries(inspected).map(([n, c]) => n + ' ' + c).join(', ') + '; ' + (scanned.Node || 0) + ' Node responses scanned too), spatialID is a required integer and nodeId is declared on ' + NODE_METHODS.length + ' node operations, Spatial.id and rootNodeID are integers, offered and served',
    };
  }, { patch: null }, [
    { name: '"A writer sends `lon`" with no key word (caught as: E1 lon, without MUST send)', impl: writerSends },
    { name: 'the refusal of a lon/lan mismatch dropped (caught as: E1 lan mismatch, no sentence)', impl: refusalDropped },
    { name: 'lan not deprecated (caught as: E1 lan never emitted, not deprecated)', impl: lanNotDeprecated },
    { name: 'one operation (POST) without spatialID (caught as: E1 spatialID, POST)', impl: lacksSpatialId },
    { name: 'the sentence "a server MUST NOT emit lan" dropped (caught as: E1 lan never emitted, no sentence)', impl: serverSentenceDropped },
    { name: 'DELETE keeps the misspelt nodeid (caught as: E1 nodeId, still declares nodeid)', impl: keepsNodeidE1 },
    { name: 'Spatial.id left a number (caught as: E1 Spatial.id is an integer)', impl: spatialIdNumber },
    { name: 'a served contract whose writer sentence has no key word (caught as: E1 lon, served contract)', impl: servedWriterSends },
    { name: 'an Asset patch that drops the refusal of a lon/lan mismatch (caught as: E1 lan mismatch, Asset API)', impl: assetRefusalDropped },
    { name: 'a world server whose GeoPose projection emits lan beside lon (caught as: E1 lan never emitted, on the wire, emits lan)', impl: serverEmitsLan },
  ]);
}

// ---------------------------------------------------------------------------------------------------
// U5, both GeoPose forms. The rotation question is not decided, so the Lab carries the overlay with the two
// rotation sentences and the overlay without them. Both must apply, differ in exactly those two sentences, pass
// U1 and U3, and equal the served contract: the with-form as served, the without-form with the two sentences
// taken out of the served contract the same way.

const FILE_LABEL = { world: 'World patch', asset: 'Asset patch' };
/** The lines of a patch other than its added ones (headers, hunk headers, context and removals). */
const keptLines = (text) => text.split('\n').filter((l) => !(l.startsWith('+') && !l.startsWith('+++')));
/** The added lines of a patch, without their `+`, joined and with whitespace collapsed, so a line wrap is not a difference. */
const addedText = (text) => squash(text.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n'));
/** A copy of a document with the two rotation sentences taken out of every description. */
function withoutSentences(doc) {
  let changed = 0;
  const copy = (function walk(n) {
    if (Array.isArray(n)) return n.map(walk);
    if (n && typeof n === 'object') {
      return Object.fromEntries(Object.entries(n).map(([k, v]) => {
        if (k !== 'description' || typeof v !== 'string') return [k, walk(v)];
        const out = dropRotationSentences(v);
        if (out !== squash(v)) changed += 1;
        return [k, out];
      }));
    }
    return n;
  })(doc);
  return { doc: copy, changed };
}

async function formsCheck() {
  const WW = 'wow-spec/overlays/iteration-1/without-rotation-sentences/OpenSpatialWorld.API.yaml.patch';
  const WA = 'wow-spec/overlays/iteration-1/without-rotation-sentences/OpenSpatialAsset.API.yaml.patch';
  const W = 'wow-spec/overlays/iteration-1/OpenSpatialWorld.API.yaml.patch';
  const thirdSentenceDropped = { patch: { without: { world: (p) => swap(p, ' A server MUST NOT emit `lan`.', '', WW) } }, expect: /^U5 World patch: the added lines differ in more than the two rotation sentences/ };
  const withLacksSentence = { patch: { with: { world: (p) => swap(p, ': at zero angles +X is east, +Y up and +Z south.', '.', W) } }, expect: /^U5 with-form World patch lacks the rotation sentence "the axes at zero angles"/ };
  const withoutLacksParagraph = { patch: { without: { asset: (p) => dropAdded(p, 'The key words', WA) } }, expect: /^U5 without-form fails U3: without-rotation-sentences form offered Asset API: no BCP 14 paragraph/ };
  const withoutKeepsOrder = { patch: { without: { world: (p) => swap(p, 'as OGC GeoPose 1.0 Basic-YPR\n+        defines them.', 'applied about the\n+        local axes z, y and x in that order.', WW) } }, expect: /^U5 without-form World patch still says the rotation sentence "the rotation order"/ };

  await run('U5', 'both GeoPose forms: the overlay with the two rotation sentences and the overlay without them apply to d39a1a0, differ in exactly those two sentences, both pass U1 and U3, the with-form equals the served contract and the without-form equals it with the two sentences taken out', async (impl) => {
    const failures = [];
    const edits = impl.patch || {};
    const texts = {};
    const patched = {};
    // 1. Both forms apply to the pinned base, by the proof's applier.
    for (const form of FORM_NAMES) {
      try {
        texts[form] = { world: patchText('world', form, edits[form]), asset: patchText('asset', form, edits[form]) };
        patched[form] = loadPatched(edits[form] || null, form);
      } catch (error) {
        if (error && error.staleEdit) throw error;
        failures.push('U5 ' + form + '-form does not apply to d39a1a0: ' + String(error && error.message).slice(0, 160));
      }
    }
    // 2. The added lines differ in exactly the two rotation sentences; everything else in the patches is the same.
    let differing = 0;
    if (texts.with && texts.without) {
      for (const name of ['world', 'asset']) {
        const keptWith = keptLines(texts.with[name]);
        const keptWithout = keptLines(texts.without[name]);
        const at = keptWith.findIndex((l, i) => l !== keptWithout[i]);
        if (at >= 0 || keptWith.length !== keptWithout.length) failures.push('U5 ' + FILE_LABEL[name] + ': the forms differ outside their added lines, first at kept line ' + (at >= 0 ? at + 1 : Math.min(keptWith.length, keptWithout.length) + 1));
        const a = addedText(texts.with[name]);
        const b = addedText(texts.without[name]);
        for (const r of ROTATION_SENTENCES.filter((x) => x.files.includes(name))) {
          if (!a.includes(squash(r.with))) failures.push('U5 with-form ' + FILE_LABEL[name] + ' lacks the rotation sentence "' + r.name + '"');
          if (b.includes(squash(r.with))) failures.push('U5 without-form ' + FILE_LABEL[name] + ' still says the rotation sentence "' + r.name + '"');
          if (r.without && !b.includes(squash(r.without))) failures.push('U5 without-form ' + FILE_LABEL[name] + ' lacks "' + r.without + '" in place of "' + r.name + '"');
        }
        if (dropRotationSentences(a) !== b) {
          const x = dropRotationSentences(a);
          let i = 0;
          while (i < x.length && x[i] === b[i]) i += 1;
          failures.push('U5 ' + FILE_LABEL[name] + ': the added lines differ in more than the two rotation sentences, first at "' + x.slice(Math.max(0, i - 30), i + 40) + '" against "' + b.slice(Math.max(0, i - 30), i + 40) + '"');
        }
        const la = texts.with[name].split('\n').filter((l) => l.startsWith('+'));
        const lb = texts.without[name].split('\n').filter((l) => l.startsWith('+'));
        differing += la.filter((l, i) => l !== lb[i]).length;
      }
    }
    // 3. Both forms pass U1 and U3 (the offered-text part; the served, built and wire parts do not depend on the form).
    const osl = yaml.load(read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    for (const form of FORM_NAMES) {
      if (!patched[form]) continue;
      for (const f of u1FormProblems(patched[form], form).failures) failures.push('U5 ' + form + '-form fails U1: ' + f);
      for (const f of u3OfferedProblems(patched[form].world, patched[form].asset, osl, offeredLabel(form)).failures) failures.push('U5 ' + form + '-form fails U3: ' + f);
    }
    // 4. The with-form equals the served contract; the without-form equals it with the two sentences taken out.
    let compared = 0;
    const stripped = withoutSentences(osl);
    if (stripped.changed !== 2) failures.push('U5 the served contract has ' + stripped.changed + ' descriptions with a rotation sentence; the known count is 2 (info.description and GeoPose)');
    if (patched.with) {
      const r = contractDiffs(patched.with.world, patched.with.asset, osl, FRAMES);
      compared += r.compared;
      for (const f of r.failures) failures.push('U5 with-form is not the served contract: ' + f);
    }
    if (patched.without) {
      const r = contractDiffs(patched.without.world, patched.without.asset, stripped.doc, FRAMES_WITHOUT);
      compared += r.compared;
      for (const f of r.failures) failures.push('U5 without-form is not the served contract without the two sentences: ' + f);
    }

    if (impl.expect) return { ok: !failures.some((f) => impl.expect.test(f)), detail: failures.slice(0, 4).join('; ') || 'no failure' };
    return {
      ok: failures.length === 0,
      detail: failures.length
        ? failures.length + ' problem(s): ' + failures.slice(0, 6).join('; ')
        : 'both forms apply to d39a1a0; their patches are the same outside the added lines, and ' + differing + ' added lines differ, in exactly the two rotation sentences (the rotation order, in the World and Asset GeoPose; the axes at zero angles, in the frame paragraph); both pass U1 and U3; the with-form equals the served contract and the without-form equals it with the two sentences taken out (' + compared + ' members compared)',
    };
  }, { patch: null }, [
    { name: 'a without-form that also drops a third sentence, "A server MUST NOT emit lan" (caught as: added lines differ in more than the two sentences)', impl: thirdSentenceDropped },
    { name: 'a with-form missing one rotation sentence, the axes at zero angles (caught as: with-form lacks the rotation sentence)', impl: withLacksSentence },
    { name: 'a without-form without the BCP 14 paragraph, Asset patch (caught as: without-form fails U3, no BCP 14 paragraph)', impl: withoutLacksParagraph },
    { name: 'a without-form that keeps the rotation order sentence (caught as: without-form still says the rotation sentence)', impl: withoutKeepsOrder },
  ]);
}

module.exports = { upstreamChecks, canon };
