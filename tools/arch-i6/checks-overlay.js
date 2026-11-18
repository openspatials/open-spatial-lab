'use strict';

/*
 * Iteration 6, the contribution to the Web of Worlds files (permissions, parts a and b).
 *
 *   W1  the iteration 6 patches apply: the World API after iterations 1 to 5, the Asset API after iteration 1, and the
 *       User Manifest API as vendored, on both GeoPose forms of iteration 1; each patched file passes the OpenAPI 3.0
 *       schema with every path parameter declared and every $ref resolving, states openapi 3.0.4 (the Asset and User
 *       Manifest files move from 3.0.3), carries components.securitySchemes with an oauth2 scheme whose token URL is
 *       relative, and gives every operation of the resources a scope and a 401 answer (the World API a 403 as well)
 *   W2  the offer equals the served contract (wow-spec/schema.yaml): the security scheme, the scope and the 401 and
 *       403 answers of each World operation, JoinAnswer.scope and the Authorization paragraph with its token-exchange
 *       profile (part b); and the G1 wire half (tools/wow-conformance/wire-checks.js authWire, with its token-exchange
 *       part: an exchange from an issuer the world does not trust answers 400 invalid_request) passes against a lab
 *       world that requires a token
 *   W3  the conformance vocabulary: each normative sentence iteration 6 adds uses a key word, offered on both forms
 *       and served; the World API and this overlay's README.md each carry the BCP 14 paragraph once; the files
 *       whose added lines use no key word need none
 *   W4  neutral wording: no added line of any overlay of iterations 1 to 6, in either GeoPose form, names the Universal
 *       Manifest, OpenSpatials, the Lab, an x-osl label, a person, or an outside identity format
 */

const fs = require('fs');
const path = require('path');
const { ROOT, run, staleEdit, loadMutant } = require('../arch-i1/lib');
const up = require('../arch-i1/upstream');
const words = require('../arch-i1/conformance-words');
const { openApiValidator, eachForm, swap } = require('../arch-i2/checks-overlay');
const { loadIteration5 } = require('../arch-i5/checks-overlay');
const lab = require('./lab');

const OVERLAY_6 = path.join(ROOT, 'wow-spec', 'overlays', 'iteration-6');
const FILES = { world: 'OpenSpatialWorld.API.yaml.patch', asset: 'OpenSpatialAsset.API.yaml.patch', manifest: 'OpenUserManifest.API.yaml.patch' };
const UM = path.join(ROOT, 'wow-spec', 'upstream', 'wowapi-d39a1a0', 'specification', 'OpenUserManifest', 'API.yaml');
const PARAGRAPH = 'Authorization.';
const METHODS = ['get', 'put', 'post', 'delete', 'head', 'patch', 'options'];

/** The patch text of one iteration 6 file, with a planted edit when given. */
function patchOf(name, edits) {
  let p = up.read(path.join(OVERLAY_6, FILES[name]));
  if (edits && edits[name]) p = edits[name](p);
  return p;
}
function patchEdit(name, from, to) {
  return { [name]: (p) => { const count = p.split(from).length - 1; if (count !== 1) throw staleEdit('wow-spec/overlays/iteration-6/' + FILES[name], from, count); return p.replace(from, () => to); } };
}

/** The three API files with iterations 1 to 6 applied, on GeoPose form `form`. */
function loadIteration6(edits, form) {
  edits = edits || {};
  const five = loadIteration5(null, form);
  const worldText = up.applyUnifiedDiff(five.worldText, patchOf('world', edits));
  const assetText = up.applyUnifiedDiff(up.loadPatched(null, form).asset.text, patchOf('asset', edits));
  const manifestText = up.applyUnifiedDiff(up.read(UM), patchOf('manifest', edits));
  return { world: up.yaml.load(worldText), worldText, asset: up.yaml.load(assetText), assetText, manifest: up.yaml.load(manifestText), manifestText };
}

const canon = (n) => (n === undefined ? null : JSON.parse(JSON.stringify(up.withoutLabels(n), (k, v) => (k === 'description' && typeof v === 'string' ? up.squash(v) : v))));
const paragraphOf = (doc, start) => String((doc.info || {}).description || '').split(/\n\s*\n/).map(up.squash).find((p) => p.startsWith(start)) || null;

/** The operations a document secures: [{ key: 'METHOD path', scopes, has401, has403 }]. */
function securedOps(doc) {
  const out = [];
  for (const [p, item] of Object.entries(doc.paths || {})) {
    for (const m of METHODS) {
      const op = item && item[m];
      if (!op || !op.security) continue;
      const scopes = (op.security || []).flatMap((req) => Object.entries(req).map(([scheme, list]) => scheme + ':' + list.join(',')));
      const codes = Object.keys(op.responses || {});
      out.push({ key: m.toUpperCase() + ' ' + p, scopes: scopes.sort().join(' '), has401: codes.includes('401'), has403: codes.includes('403') });
    }
  }
  return out;
}

/** What iteration 6 says in the World API, read from one API description. */
function iteration6Text(doc) {
  const schemes = (doc.components || {}).securitySchemes;
  const join = (((doc.components || {}).schemas || {}).JoinAnswer || {}).properties || {};
  return {
    securitySchemes: canon(schemes),
    joinAnswerScope: canon(join.scope),
    paragraph: paragraphOf(doc, PARAGRAPH),
  };
}

/** The problems of one patched file: valid OpenAPI 3.0, 3.0.4, an oauth2 scheme with a relative token URL, every operation secured. */
function fileProblems(doc, label, opts) {
  const problems = [];
  const validate = openApiValidator();
  if (!validate(doc)) problems.push(label + ': OpenAPI 3.0 schema: ' + validate.errors.slice(0, 2).map((e) => e.instancePath + ' ' + e.message).join('; '));
  const params = up.pathParameterProblems(doc);
  if (params.length) problems.push(label + ': ' + params[0]);
  const refs = up.refProblems(doc);
  if (refs.length) problems.push(label + ': ' + refs[0]);
  if (doc.openapi !== '3.0.4') problems.push(label + ': openapi ' + doc.openapi + ', not 3.0.4');
  const schemes = Object.values(((doc.components || {}).securitySchemes) || {});
  const oauth = schemes.find((s) => s && s.type === 'oauth2');
  if (!oauth) problems.push(label + ': no oauth2 security scheme');
  else for (const [flow, f] of Object.entries(oauth.flows || {})) for (const key of ['tokenUrl', 'authorizationUrl', 'refreshUrl']) if (f[key] && /^[a-z][a-z0-9+.-]*:/i.test(f[key])) problems.push(label + ': the ' + flow + ' ' + key + ' is absolute (' + f[key] + '), not relative');
  for (const [p, item] of Object.entries(doc.paths || {})) {
    if (opts.open && opts.open.includes(p)) continue;
    for (const m of METHODS) {
      const op = item && item[m];
      if (!op) continue;
      const codes = Object.keys(op.responses || {});
      if (!op.security) problems.push(label + ': ' + m.toUpperCase() + ' ' + p + ' names no scope');
      if (!codes.includes('401')) problems.push(label + ': ' + m.toUpperCase() + ' ' + p + ' has no 401');
      if (opts.need403 && !codes.includes('403')) problems.push(label + ': ' + m.toUpperCase() + ' ' + p + ' has no 403');
    }
  }
  return problems;
}

/** The scope each World operation needs (the roadmap's list), checked against the offer. */
const WORLD_SCOPES = {
  'GET /wow/world': 'read', 'GET /wow/user/{userId}': 'read', 'DELETE /wow/user/{userId}': 'enter', 'POST /wow/user': 'enter',
  'GET /wow/view/{viewId}': 'read', 'GET /wow/portal/{portalId}': 'read', 'GET /wow/spatial/{spatialID}': 'read',
  'POST /wow/spatial/{spatialID}/node/{nodeId}': 'write', 'GET /wow/spatial/{spatialID}/node/{nodeId}': 'read',
  'PUT /wow/spatial/{spatialID}/node/{nodeId}': 'write', 'DELETE /wow/spatial/{spatialID}/node/{nodeId}': 'write',
};

const para6 = (doc) => paragraphOf(doc, PARAGRAPH) || '';
const joinScopeText = (doc) => ((((doc.components || {}).schemas || {}).JoinAnswer || {}).properties || {}).scope.description;
/** The normative sentences iteration 6 adds to the World API. */
const SENTENCES_I6 = [
  { where: 'Authorization (a world may require a token)', text: para6, anchor: 'require a token for its requests' },
  { where: 'Authorization (protected resource metadata at the derived address)', text: para6, anchor: 'protected resource metadata' },
  { where: 'Authorization (a token bound to one world, exact audience)', text: para6, anchor: 'bound to one world' },
  { where: 'Authorization (the world keeps its own grant records)', text: para6, anchor: 'keep its own grant records' },
  { where: 'Authorization (grants expire or are withdrawn)', text: para6, anchor: 'expire or be withdrawn' },
  { where: 'Authorization (the token and the grant records cover the request)', text: para6, anchor: 'allow a request only when' },
  { where: 'Authorization (GET /wow/user/{userId} needs the User grant)', text: para6, anchor: 'names the world\'s User resources' },
  { where: 'Authorization (no people without that grant)', text: para6, anchor: 'show people' },
  { where: 'Authorization (no token: 401 with no error code)', text: para6, anchor: 'no error code' },
  { where: 'Authorization (invalid_token)', text: para6, anchor: 'token for another world' },
  { where: 'Authorization (insufficient_scope)', text: para6, anchor: 'do not cover the request' },
  { where: 'Authorization (the error code in the header)', text: para6, anchor: 'not only in a body' },
  { where: 'Authorization (no resource_metadata in the 401)', text: para6, anchor: 'carry resource_metadata' },
  { where: 'Authorization (the join answer names the scopes)', text: para6, anchor: 'name the scopes granted' },
  { where: 'Authorization (the token is the stream\'s first message)', text: para6, anchor: 'the first message' },
  { where: 'Authorization (a stream closed within 5 seconds)', text: para6, anchor: 'within 5 seconds' },
  { where: 'Authorization (no token in a URL)', text: para6, anchor: 'appear in a URL' },
  { where: 'Authorization (HTTPS outside test environments)', text: para6, anchor: 'HTTPS' },
  { where: 'JoinAnswer.scope (equal to the grant records)', text: joinScopeText, anchor: 'equal the grant records' },
  // Part b: per-resource grants and the token-exchange profile.
  { where: 'Authorization (a write grant names one node)', text: para6, anchor: 'name one node' },
  { where: 'Authorization (token exchange, RFC 8693)', text: para6, anchor: 'token exchange (RFC 8693)' },
  { where: 'Authorization (exchange only under a grant record for acting)', text: para6, anchor: 'lets the acting party act for' },
  { where: 'Authorization (the act claim chain)', text: para6, anchor: 'current actor outermost' },
  { where: 'Authorization (decided on the current actor, the chain logged)', text: para6, anchor: 'grant records of the current actor' },
  { where: 'Authorization (a host acts only with an exchanged token)', text: para6, anchor: 'with its own token' },
  { where: 'Authorization (whose tokens a world accepts as the subject)', text: para6, anchor: 'as a subject token only' },
];
/** Part b's sentences: the token-exchange profile (who may act, and whose tokens a world accepts as the subject). */
const PART_B = SENTENCES_I6.slice(SENTENCES_I6.findIndex((e) => e.anchor === 'name one node'));
const GENERATED = path.join(ROOT, 'wow-spec', 'generated', 'schema.json');
const README_6 = path.join(OVERLAY_6, 'README.md');
const bcp14Count = (text) => up.squash(text || '').split(up.squash(words.BCP14)).length - 1;
function paragraphProblems(text, label, paragraphText) {
  const used = words.keywordCount(text);
  const n = bcp14Count(paragraphText === undefined ? text : paragraphText);
  return used && n !== 1 ? [label + ': ' + used + ' key words and the BCP 14 paragraph ' + n + ' times, wanted once'] : [];
}

/** W4's lists, read from iteration 5's check itself (its own module, with the names it keeps private exported). */
const i5Words = loadMutant(path.join('tools', 'arch-i5', 'checks-overlay.js'), [
  ['module.exports = { overlayChecks, loadIteration5, sessionText };', 'module.exports = { overlayChecks, loadIteration5, sessionText, NAMES, addedLines, WITHOUT_FORM_DIRS };'],
]);
/** Outside identity formats an overlay does not name (W4, iteration 6). */
const IDENTITY_FORMATS = [
  ['an outside identity format (Verifiable Credentials)', /verifiable[\s-]*credential/i],
  ['an outside identity format (DID)', /\bdid:[a-z]|\bdecentralized identifier/i],
  ['an outside identity format (OpenID)', /\bopenid\b/i],
  ['an outside identity format (SAML)', /\bSAML\b/],
  ['an outside identity format (mDL or mdoc)', /\bmdoc\b|\bmobile driving licen/i],
];
const ITERATIONS = [1, 2, 3, 4, 5, 6];
const OVERLAYS = path.join(ROOT, 'wow-spec', 'overlays');

function overlayFiles() {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(OVERLAYS, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  for (const n of ITERATIONS) if (fs.existsSync(path.join(OVERLAYS, 'iteration-' + n))) walk('iteration-' + n);
  return out;
}

async function overlayChecks(ports) {
  // ---- W1 -----------------------------------------------------------------------------------------------
  await run('W1', 'the iteration 6 patches apply (World API after iterations 1 to 5, Asset API after iteration 1, User Manifest API as vendored) on both GeoPose forms; each file passes the OpenAPI 3.0 schema, resolves every $ref, states openapi 3.0.4, carries an oauth2 scheme with a relative token URL, and every operation of the resources names a scope and a 401 (the World API a 403 too); each World operation has the scope the roadmap gives it', async (impl) => {
    const failures = [];
    eachForm(failures, (form) => {
      const out = loadIteration6(impl.edits, form);
      failures.push(...fileProblems(out.world, form + '-form World API', { open: ['/'], need403: true }));
      failures.push(...fileProblems(out.asset, form + '-form Asset API', {}));
      failures.push(...fileProblems(out.manifest, form + '-form User Manifest API', {}));
      const ops = Object.fromEntries(securedOps(out.world).map((o) => [o.key, o.scopes]));
      for (const [key, scope] of Object.entries(WORLD_SCOPES)) if (ops[key] !== 'worldAuth:' + scope) failures.push(form + '-form: ' + key + ' names ' + JSON.stringify(ops[key] || null) + ', not ' + scope);
      for (const [key, value] of Object.entries(iteration6Text(out.world))) if (!value) failures.push(form + '-form: ' + key + ' is missing');
    });
    return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 6).join('; ') : 'on both GeoPose forms the three patches apply; the World, Asset and User Manifest APIs pass the OpenAPI 3.0 schema at 3.0.4 with an oauth2 scheme (relative token URL); ' + Object.keys(WORLD_SCOPES).length + ' World operations each name their scope with 401 and 403; the Asset and User Manifest operations name read with 401; JoinAnswer.scope and the Authorization paragraph are there' };
  }, {}, [
    { name: 'a World patch whose context no longer matches iteration 5\'s text', impl: { edits: patchEdit('world', ' components:\n+  securitySchemes:', ' components :\n+  securitySchemes:') } },
    { name: 'a node PUT that names read, not write', impl: { edits: patchEdit('world', "         required: true\n+      security:\n+        - worldAuth: [write]", "         required: true\n+      security:\n+        - worldAuth: [read]") } },
    { name: 'an absolute token URL', impl: { edits: patchEdit('asset', '+          tokenUrl: oauth/token', '+          tokenUrl: https://auth.example/oauth/token') } },
    { name: 'a User Manifest API left at 3.0.3', impl: { edits: patchEdit('manifest', "-openapi: '3.0.3'\n+openapi: '3.0.4'\n", " openapi: '3.0.3'\n") } },
  ]);

  // ---- W2 -----------------------------------------------------------------------------------------------
  await run('W2', 'the offer equals the served contract (the security scheme, each World operation\'s scope and its 401 and 403, JoinAnswer.scope, the Authorization paragraph), on both GeoPose forms; and the G1 wire half passes against a lab world that requires a token', async (impl) => {
    const failures = [];
    const contract = up.yaml.load(up.read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    if (impl.mutateOsl) impl.mutateOsl(contract);
    const served = iteration6Text(contract);
    const servedOps = Object.fromEntries(securedOps(contract).map((o) => [o.key, o]));
    eachForm(failures, (form) => {
      const offered = loadIteration6(impl.edits, form).world;
      const a = iteration6Text(offered);
      for (const key of Object.keys(a)) if (JSON.stringify(a[key]) !== JSON.stringify(served[key])) failures.push(form + '-form: ' + key + ' differs between the offer and the lab contract');
      for (const o of securedOps(offered)) {
        const s = servedOps[o.key];
        if (!s) failures.push(form + '-form: the lab contract does not secure ' + o.key);
        else if (s.scopes !== o.scopes || s.has401 !== o.has401 || s.has403 !== o.has403) failures.push(form + '-form: ' + o.key + ' offered ' + JSON.stringify([o.scopes, o.has401, o.has403]) + ', served ' + JSON.stringify([s.scopes, s.has401, s.has403]));
      }
    });
    // On the wire (the wire half is shared with the conformance corpus: tools/wow-conformance/wire-checks.js authWire).
    const { authWire } = require('../wow-conformance/wire-checks');
    const clients = [{ client_id: 'w2-reader', client_secret: 'w2-secret-not-real' }];
    const B = await lab.authWorld('b', ports.next(), { base: '/w/b', clients, grants: lab.grantsFor('w2-reader', ['read']), edits: impl.server });
    let wire = '';
    try {
      const r = await authWire(B.base, { client: clients[0], deniedScope: 'write' });
      failures.push(...r.problems);
      if (!/token exchange/.test(r.detail)) failures.push('the wire half did not try a token exchange: ' + r.detail);
      wire = r.detail;
    } finally { await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 8).join('; ') : 'offer (both GeoPose forms) = lab contract on the security scheme, ' + Object.keys(WORLD_SCOPES).length + ' operations\' scopes and 401/403, JoinAnswer.scope and the Authorization paragraph; on the wire: ' + wire };
  }, {}, [
    { name: 'an offer whose Authorization paragraph drifted (MAY accept a token in a URL)', impl: { edits: patchEdit('world', 'and a world MUST NOT accept one there.', 'and a world MAY accept one there.') } },
    { name: 'a served contract whose node DELETE names read', impl: { mutateOsl: (osl) => { osl.paths['/wow/spatial/{spatialID}/node/{nodeId}'].delete.security = [{ worldAuth: ['read'] }]; } } },
    { name: 'a server whose metadata names another resource', impl: { server: { auth: [['            resource : RESOURCE,\n            authorization_servers', "            resource : RESOURCE + 'elsewhere/',\n            authorization_servers"]] } } },
    { name: 'an offer whose token-exchange profile drifted (any issuer\'s token accepted as the subject)', impl: { edits: patchEdit('world', 'A world MUST accept as a subject token only a token of its own authorization server, or of an issuer it lists as trusted', 'A world MUST accept as a subject token only a token of its own authorization server, or of any issuer') } },
    { name: 'a served contract whose token-exchange profile decides on the subject', impl: { mutateOsl: (osl) => { osl.info.description = swap(osl.info.description, 'MUST decide on the grant records of the current actor, not those of the subject', 'MUST decide on the grant records of the subject', 'wow-spec/schema.yaml info.description'); } } },
  ]);

  // ---- W3 -----------------------------------------------------------------------------------------------
  await run('W3', 'the conformance vocabulary of iteration 6: each normative sentence it adds (the Authorization paragraph and JoinAnswer.scope) uses a key word, offered on both forms and served; the World API and the overlay README.md each carry the BCP 14 paragraph once; the Asset and User Manifest patches add no key word', async (impl) => {
    const failures = [];
    const osl = up.yaml.load(up.read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    if (impl.mutateOsl) impl.mutateOsl(osl);
    let count = 0;
    eachForm(failures, (form) => {
      const out = loadIteration6(impl.edits, form);
      const label = form + '-form: offered World API after iteration 6';
      failures.push(...paragraphProblems(out.worldText, label, (out.world.info || {}).description));
      failures.push(...words.sentenceProblems(out.world, SENTENCES_I6, label));
      for (const name of ['asset', 'manifest']) {
        const added = patchOf(name, impl.edits).split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
        if (words.keywordCount(added)) failures.push(form + '-form: the ' + name + ' patch adds key words (' + words.keywordCount(added) + ') to a file that carries no rule of its own here');
      }
      if (form === 'with') count = words.keywordCount(SENTENCES_I6.map((e) => { try { return words.sentenceWith(e.text(out.world), e.anchor) || ''; } catch (error) { return ''; } }).join(' '));
    });
    failures.push(...words.sentenceProblems(osl, SENTENCES_I6, 'served contract'));
    let readme = fs.existsSync(README_6) ? up.read(README_6) : '';
    if (impl.readme) readme = impl.readme(readme);
    if (!words.keywordCount(readme)) failures.push('the iteration 6 overlay README.md uses no key word, though the text it describes does');
    failures.push(...paragraphProblems(readme, 'the iteration 6 overlay README.md'));
    const generated = fs.existsSync(GENERATED) ? JSON.parse(up.read(GENERATED)) : {};
    if (JSON.stringify(canon((generated.components || {}).securitySchemes)) !== JSON.stringify(canon((osl.components || {}).securitySchemes))) failures.push('generated schema.json is not the served contract: securitySchemes differ');
    return { ok: failures.length === 0, detail: failures.length ? failures.length + ' problem(s): ' + failures.slice(0, 6).join('; ') : SENTENCES_I6.length + ' normative sentences (' + PART_B.length + ' of them the token-exchange profile and node grants of part b; ' + count + ' key words) each use one, offered on both forms and served; the World API and the overlay README.md carry the BCP 14 paragraph once; the Asset and User Manifest patches add no key word; the build carries the served security scheme' };
  }, {}, [
    { name: 'an Authorization sentence without a key word (no token in a URL)', impl: { edits: patchEdit('world', 'A token MUST NOT appear in a URL, and a world MUST NOT accept one there.', 'A token does not appear in a URL, and a world does not accept one there.') } },
    { name: 'a JoinAnswer.scope sentence without a key word', impl: { edits: patchEdit('world', '+            They MUST equal the grant records', '+            They equal the grant records') } },
    { name: 'an overlay README.md with key words but no BCP 14 paragraph', impl: { readme: (t) => swap(t, words.BCP14, 'Key words are used as defined elsewhere.', 'wow-spec/overlays/iteration-6/README.md') } },
    { name: 'a token-exchange sentence without a key word (the act claim chain)', impl: { edits: patchEdit('world', 'A world MUST issue such a token only when one of its grant records lets the acting party act for that party, and the token MUST carry the act claim', 'A world issues such a token only when one of its grant records lets the acting party act for that party, and the token carries the act claim') } },
    { name: 'a served contract whose subject-token sentence has no key word', impl: { mutateOsl: (osl) => { osl.info.description = swap(swap(osl.info.description, 'A world MUST accept as a subject token only', 'A world accepts as a subject token only', 'wow-spec/schema.yaml info.description'), 'and MUST refuse any other with', 'and refuses any other with', 'wow-spec/schema.yaml info.description'); } } },
    { name: 'a served contract whose Authorization paragraph has no key word for HTTPS', impl: { mutateOsl: (osl) => { osl.info.description = swap(osl.info.description, 'a world MUST be served over HTTPS', 'a world is served over HTTPS', 'wow-spec/schema.yaml info.description'); } } },
  ]);

  // ---- W4 -----------------------------------------------------------------------------------------------
  await run('W4', 'neutral wording: no added line of any overlay of iterations 1 to 6, in either GeoPose form, names the Universal Manifest, OpenSpatials, the Lab, an x-osl label, a person, or an outside identity format', async (impl) => {
    const failures = [];
    const names = i5Words.NAMES.concat(IDENTITY_FORMATS);
    const files = overlayFiles();
    let lines = 0;
    const per = {};
    for (const rel of files) {
      let text = up.read(path.join(OVERLAYS, rel));
      if (impl.files && impl.files[rel]) text = impl.files[rel](text);
      const added = i5Words.addedLines(rel, text);
      lines += added.length;
      per[rel.split('/')[0]] = (per[rel.split('/')[0]] || 0) + added.length;
      for (const { n, t } of added) for (const [label, re] of names) if (re.test(t)) failures.push(rel + ':' + n + ' names ' + label + ': "' + t.trim().slice(0, 90) + '"');
    }
    for (const n of ITERATIONS) if (!per['iteration-' + n]) failures.push('no added line scanned in iteration-' + n);
    if (impl.expect) return { ok: !failures.some((f) => impl.expect.test(f)), detail: failures.slice(0, 4).join('; ') || 'no failure' };
    return { ok: failures.length === 0, detail: failures.length ? failures.length + ' hit(s): ' + failures.slice(0, 6).join('; ') : files.length + ' overlay files of iterations 1 to 6 (' + lines + ' added lines, ' + (per['iteration-6'] || 0) + ' in iteration 6) name none of: ' + names.map(([l]) => l).join(', ') };
  }, {}, [
    { name: 'an iteration 6 line that names the Universal Manifest', impl: { files: { 'iteration-6/OpenSpatialWorld.API.yaml.patch': (t) => swap(t, 'Sender-constrained tokens (DPoP, RFC 9449) are the next step', 'A Universal Manifest presentation and sender-constrained tokens (DPoP, RFC 9449) are the next step', 'iteration-6 World patch') }, expect: /^iteration-6\/OpenSpatialWorld\.API\.yaml\.patch:\d+ names the Universal Manifest/ } },
    { name: 'an iteration 6 line that names an outside identity format (Verifiable Credentials)', impl: { files: { 'iteration-6/OpenSpatialWorld.API.yaml.patch': (t) => swap(t, 'Sender-constrained tokens (DPoP, RFC 9449) are the next step', 'Verifiable Credentials and sender-constrained tokens (DPoP, RFC 9449) are the next step', 'iteration-6 World patch') }, expect: /^iteration-6\/OpenSpatialWorld\.API\.yaml\.patch:\d+ names an outside identity format/ } },
    { name: 'an iteration 6 README.md that names the Lab', impl: { files: { 'iteration-6/README.md': (t) => swap(t, '\nNothing here has been sent upstream.', '\nNothing here has been sent upstream by the Open Spatial Lab.', 'iteration-6 README.md') }, expect: /^iteration-6\/README\.md:\d+ names the Lab/ } },
  ]);
}

module.exports = { overlayChecks, loadIteration6, iteration6Text, securedOps };
