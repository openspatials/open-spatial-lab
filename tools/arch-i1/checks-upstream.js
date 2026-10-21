'use strict';

/*
 * Iteration 1, the contribution to the Web of Worlds API descriptions.
 *
 *   U1  the overlay patches apply to the vendored upstream files, and the result is a consistent API
 *       description with no undeclared path parameter (the errata D5 and RES-14)
 *   U2  the text we offer upstream and the contract we serve and prove are the same text
 *
 * The patches are the offer. U2 is what stops the offer and the proven contract drifting apart.
 */

const path = require('path');
const { ROOT, run } = require('./lib');
const { UPSTREAM, read, sha256, loadPatched, pathParameterProblems, refProblems, withoutLabels, squash, yaml } = require('./upstream');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const FRAMES = 'Frames. All coordinates are in metres, right-handed, +Y up. A Spatial\'s GeoPose anchors its origin: at zero angles +X is east, +Y up and +Z south. All other positions are local to their parent.';
const NODE_PATH = '/wow/spatial/{spatialID}/node/{nodeId}';

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

async function upstreamChecks() {
  // ---- U1. The patches apply, and the result is a consistent API description ---------------------------
  const lacksOneSpatialId = { world: (p) => p.replace(SPATIAL_PARAM, '') };
  const keepsNodeid = { world: (p) => p.replace('+        - name: nodeId\n           in: path\n           description: node id to delete', '+        - name: nodeid\n           in: path\n           description: node id to delete') };
  const spellsLan = { world: (p) => p.replace('+            lon:\n', '+            lan:\n') };
  const noItemLimits = { world: (p) => p.replace('+          minItems: 16\n+          maxItems: 16\n', '') };
  const assetKeepsInline = { asset: (p) => p.replace('+          allOf:\n+            - $ref: \'#/components/schemas/GeoPose\'\n', '+          type: object\n') };
  await run('U1', 'the overlay patches apply to the vendored upstream files; the patched World API has every path parameter declared, every $ref resolving, one GeoPose, and the transform limits', async (impl) => {
    const failures = [];
    const manifest = JSON.parse(read(path.join(UPSTREAM, 'SOURCE.json')));
    for (const [rel, hash] of Object.entries(manifest.files)) {
      if (sha256(read(path.join(UPSTREAM, rel))) !== hash) failures.push(rel + ' is not the pinned upstream file');
    }
    const patched = loadPatched(impl.edits); // a patch that does not apply throws, and the check fails with its name
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

    // One GeoPose, spelled lon, used by every geoPose.
    const schemas = world.doc.components.schemas;
    const position = (schemas.GeoPose && schemas.GeoPose.properties && schemas.GeoPose.properties.position) || {};
    if (!position.properties || !position.properties.lon || (position.required || []).includes('lan')) failures.push('GeoPose.position does not spell longitude lon');
    if (!position.properties || !position.properties.lan || position.properties.lan.deprecated !== true) failures.push('GeoPose.position does not carry lan as deprecated');
    const usesGeoPose = (schema) => schema && (schema.$ref === '#/components/schemas/GeoPose' || (schema.allOf || []).some((x) => x.$ref === '#/components/schemas/GeoPose'));
    for (const name of ['World', 'User', 'View', 'Portal', 'Spatial']) {
      if (!usesGeoPose(schemas[name].properties.geoPose)) failures.push(name + '.geoPose is not the shared GeoPose');
    }
    if (!usesGeoPose(asset.doc.components.schemas.Asset.properties.geoPose)) failures.push('Asset.geoPose is not the shared GeoPose');
    if (!same(canon(asset.doc.components.schemas.GeoPose), canon(schemas.GeoPose))) failures.push('the Asset API and the World API define GeoPose differently');

    // The transform limits and the frame paragraph.
    const transform = schemas.Node.properties.localTransform;
    if (transform.minItems !== 16 || transform.maxItems !== 16) failures.push('Node.localTransform is not limited to 16 items');
    if (!squash(world.doc.info.description).includes(squash(FRAMES))) failures.push('info.description does not carry the frame paragraph');

    return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 4).join('; ') : `${before.length} path parameter problems before the patch, 0 after; both files resolve every $ref; 6 geoPose members share one GeoPose; the transform is 16 items` };
  }, { edits: null }, [
    { name: 'a patch that leaves one operation without spatialID', impl: { edits: lacksOneSpatialId } },
    { name: 'a patch that keeps the misspelt nodeid', impl: { edits: keepsNodeid } },
    { name: 'a patch whose GeoPose spells longitude lan', impl: { edits: spellsLan } },
    { name: 'a patch with no limit on localTransform', impl: { edits: noItemLimits } },
    { name: 'a patch that leaves the Asset geoPose without the shared definition', impl: { edits: assetKeepsInline } },
  ]);

  // ---- U2. The offered text is the proven text ---------------------------------------------------------
  const oslDriftsTransform = (osl) => { osl.components.schemas.Node.properties.localTransform.maxItems = 12; };
  const oslDriftsGeoPose = (osl) => { osl.components.schemas.GeoPose.properties.position.properties.lon.minimum = -90; };
  const oslDropsWorldNote = (osl) => { delete osl.components.schemas.World.properties.geoPose.description; };
  const oslDropsParam = (osl) => { osl.paths[NODE_PATH].put.parameters = osl.paths[NODE_PATH].put.parameters.filter((p) => p.name !== 'spatialID'); };
  const patchDriftsTransform = { world: (p) => p.replace('+          minItems: 16\n', '+          minItems: 12\n') };
  await run('U2', 'the text offered upstream and the contract OSL serves and proves say the same thing: GeoPose, the transform, the tree rules, the Spatial ids, the path parameters and the frame paragraph', async (impl) => {
    const failures = [];
    const { world, asset } = loadPatched(impl.edits);
    const osl = yaml.load(read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    if (impl.mutateOsl) impl.mutateOsl(osl);
    const offered = world.doc.components.schemas;
    const served = osl.components.schemas;
    let compared = 0;
    const compare = (label, a, b) => { compared += 1; if (!same(canon(a), canon(b))) failures.push(label + ' differs'); };

    compare('GeoPose', offered.GeoPose, served.GeoPose);
    compare('Asset GeoPose', asset.doc.components.schemas.GeoPose, served.GeoPose);
    for (const key of ['id', 'parent', 'children', 'localTransform']) compare('Node.' + key, offered.Node.properties[key], served.Node.properties[key]);
    for (const key of ['id', 'rootNodeID']) compare('Spatial.' + key, offered.Spatial.properties[key], served.Spatial.properties[key]);
    for (const name of ['World', 'User', 'View', 'Portal', 'Spatial']) compare(name + '.geoPose', offered[name].properties.geoPose, served[name].properties.geoPose);
    for (const method of ['get', 'post', 'put', 'delete']) {
      const a = pathParams(world.doc, method);
      const b = pathParams(osl, method);
      compared += 1;
      if (!same(a, b)) failures.push(method.toUpperCase() + ' ' + NODE_PATH + ' path parameters differ: ' + JSON.stringify(a) + ' against ' + JSON.stringify(b));
    }
    for (const [name, doc] of [['offered', world.doc], ['served', osl]]) {
      compared += 1;
      if (!squash(doc.info.description).includes(squash(FRAMES))) failures.push('the ' + name + ' description lacks the frame paragraph');
    }
    if (!/never overrides/.test(squash(asset.doc.components.schemas.Asset.properties.geoPose.description || ''))) failures.push('the Asset geoPose does not say it never overrides a placement');
    return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 4).join('; ') : compared + ' members compared, each equal once OSL labels and line wraps are set aside' };
  }, { edits: null }, [
    { name: 'a contract that limits localTransform to 12 items', impl: { mutateOsl: oslDriftsTransform } },
    { name: 'a contract whose longitude bound differs', impl: { mutateOsl: oslDriftsGeoPose } },
    { name: 'a contract without the World geoPose note', impl: { mutateOsl: oslDropsWorldNote } },
    { name: 'a contract that drops spatialID from one operation', impl: { mutateOsl: oslDropsParam } },
    { name: 'a patch that offers a different transform limit', impl: { edits: patchDriftsTransform } },
  ]);
}

module.exports = { upstreamChecks };
