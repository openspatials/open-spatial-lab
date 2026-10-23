'use strict';

/*
 * Iteration 2, the contribution to the Web of Worlds API descriptions.
 *
 *   O1  the iteration 2 patches apply to the Web of Worlds files at main (after iteration 1's), and the
 *       patched World API passes the OpenAPI 3.0 schema, declares every path parameter and resolves
 *       every $ref
 *   O2  the text offered upstream, the contract the lab serves (wow-spec/schema.yaml) and what the world
 *       server does on the wire say the same thing
 *
 * WoWAPI `main` is d39a1a0, the vendored copy (checked against GitHub when these patches were written).
 */

const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { ROOT, run, httpReq } = require('../arch-i1/lib');
const up = require('../arch-i1/upstream');
const w = require('./worlds');

const OVERLAY_2 = path.join(ROOT, 'wow-spec', 'overlays', 'iteration-2');
const OAS = path.join(ROOT, 'wow-spec', 'upstream', 'openapi-3.0');
const README = 'specification/OpenSpatialWorld/README.md';
const WOW = 'application/wow+json';

/** The World API after iteration 1 and iteration 2, and the World README after iteration 2. `edits` swaps patch text. */
function loadIteration2(edits) {
  edits = edits || {};
  const afterOne = up.loadPatched().world.text;
  let worldPatch = up.read(path.join(OVERLAY_2, 'OpenSpatialWorld.API.yaml.patch'));
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
const PARAGRAPHS = ['Media type.', 'Entity tags.', 'Cross-origin reads.'];

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
  };
}

async function overlayChecks(ports) {
  // ---- O1 ---------------------------------------------------------------------------------------------
  const hunkDoesNotApply = { edits: { world: (p) => p.replace('       operationId: getWorldStatus\n', '       operationId: getWorld\n') } };
  const danglingRef = { edits: { world: (p) => p.replace("+          $ref: '#/components/responses/PreconditionFailed'\n         '422':", "+          $ref: '#/components/responses/PreconditionFail'\n         '422':") } };
  const notOpenApi = { edits: { world: (p) => p.replace('+      name: If-Match\n+      in: header\n', '+      name: If-Match\n+      in: body\n') } };
  await run('O1', 'the iteration 2 patches apply to the Web of Worlds files at main after iteration 1\'s; the patched World API passes the OpenAPI 3.0 schema, declares every path parameter and resolves every $ref; the README gains the base-URL rule', async (impl) => {
    const failures = [];
    const manifest = JSON.parse(up.read(path.join(up.UPSTREAM, 'SOURCE.json')));
    for (const [rel, hash] of Object.entries(manifest.files)) if (up.sha256(up.read(path.join(up.UPSTREAM, rel))) !== hash) failures.push(rel + ' is not the pinned upstream file');
    const out = loadIteration2(impl.edits);
    const validate = openApiValidator();
    if (!validate(out.world)) failures.push('OpenAPI 3.0 schema: ' + validate.errors.slice(0, 2).map((e) => e.instancePath + ' ' + e.message).join('; '));
    const params = up.pathParameterProblems(out.world);
    if (params.length) failures.push(params[0]);
    const refs = up.refProblems(out.world);
    if (refs.length) failures.push(refs[0]);
    if (!/its resource URLs are the base plus wow\//.test(out.readme)) failures.push('the README lacks the base-URL rule');
    if (!/Any readable Spatial or Node may be included by another world/.test(out.readme)) failures.push('the README still says "Expose parts of scene"');
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'both patches apply; the World API passes the OpenAPI 3.0 schema with no path parameter or $ref problem; the README carries the base-URL and inclusion lines' };
  }, {}, [
    { name: 'a patch whose context no longer matches main', impl: hunkDoesNotApply },
    { name: 'a patch with a $ref that resolves to nothing', impl: danglingRef },
    { name: 'a patch that is not valid OpenAPI (a parameter in: body)', impl: notOpenApi },
  ]);

  // ---- O2 ---------------------------------------------------------------------------------------------
  const offerDrifts = { edits: { world: (p) => p.replace("+          description: The ids of the world's graphs (Spatial resources), the default graph first.", "+          description: The ids of the world's graphs.") } };
  const preflightLacksIfMatch = { serverEdits: { server: [["'Authorization, Content-Type, Accept, If-None-Match, If-Match, X-OSL-WoW-Node-Form, X-OSL-WoW-Spatial-Form'", "'Authorization, Content-Type, Accept, If-None-Match, X-OSL-WoW-Node-Form, X-OSL-WoW-Spatial-Form'"]] } };
  await run('O2', 'the offered text and the contract the lab serves say the same thing about inclusion, World.spatials, the media type, entity tags and cross-origin reads, and the world server does it on the wire', async (impl) => {
    const failures = [];
    const offered = iteration2Text(loadIteration2(impl.edits).world);
    const served = iteration2Text(up.yaml.load(up.read(path.join(ROOT, 'wow-spec', 'schema.yaml'))));
    for (const key of Object.keys(offered)) {
      if (JSON.stringify(offered[key]) !== JSON.stringify(served[key])) failures.push(key + ' differs between the offer and the lab contract');
    }
    if (offered.paragraphs.some((p) => !p)) failures.push('a paragraph is missing from the offer');
    // On the wire.
    const port = ports.next();
    const B = await w.world('b', port, { base: '/w/b', edits: impl.serverEdits });
    try {
      const got = await httpReq('GET', port, '/w/b/wow/world', null, { Accept: WOW, Origin: 'http://elsewhere.example' });
      const json = await httpReq('GET', port, '/w/b/wow/world', null, { Accept: 'application/json' });
      const pre = await httpReq('OPTIONS', port, '/w/b/wow/spatial/1/node/0', null, { Origin: 'http://elsewhere.example', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'if-match' });
      if (got.headers['content-type'] !== WOW) failures.push('GET /wow/world answers ' + got.headers['content-type']);
      if (json.headers['content-type'] !== 'application/json') failures.push('application/json is not available by negotiation');
      if (!got.headers.etag || !got.headers['last-modified']) failures.push('GET /wow/world has no ETag or Last-Modified');
      if (!Array.isArray(got.json && got.json.spatials)) failures.push('the World has no spatials');
      if (!/\bETag\b/.test(got.headers['access-control-expose-headers'] || '')) failures.push('ETag is not exposed to other origins');
      const allowed = String(pre.headers['access-control-allow-headers'] || '');
      for (const h of ['Authorization', 'If-None-Match', 'If-Match']) if (!allowed.includes(h)) failures.push('the preflight does not allow ' + h);
    } finally { await B.close(); }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'offer = lab contract on 9 points; on the wire: application/wow+json (application/json on request), ETag and Last-Modified, spatials, ETag exposed, preflight allows Authorization, If-None-Match, If-Match' };
  }, {}, [
    { name: 'an offer whose World.spatials text drifted from the contract', impl: offerDrifts },
    { name: 'a world server whose preflight does not allow If-Match', impl: preflightLacksIfMatch },
  ]);
}

module.exports = { overlayChecks, loadIteration2, openApiValidator };
