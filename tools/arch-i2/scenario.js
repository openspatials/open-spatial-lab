'use strict';

/*
 * The base scene of the iteration 2 proof, built through the Web of Worlds node API:
 *
 *   world B ({B} = http://127.0.0.1:<port>/w/b), graph 1:
 *     root -> n "node n", own translation (2, 0, 0)
 *               -> "reference cube", a 1 m cube model
 *   world A, graph 1:
 *     root -> X, 10 m east, scale 1, links {B}/wow/spatial/1
 *          -> Y, at (0, 0, 5), scale 0.01, links {B}/wow/spatial/1/node/{n}
 *          -> M, at (-6, 0, 0), links a model whose address looks like a Web of Worlds address
 *
 * impl.serverEdits plants a fault in world B's server; impl.clientEdits plants one in the client.
 */

const w = require('./worlds');

async function baseScene(impl, ports, options) {
  options = options || {};
  impl = impl || {};
  const models = await w.modelHost(ports.next());
  const B = await w.world('b', ports.next(), { base: '/w/b', edits: impl.serverEdits, config: options.bConfig });
  const A = await w.world('a', ports.next(), { edits: impl.hostEdits });
  try {
    const bRoot = await B.rootOf(1);
    const [n] = await B.add(1, bRoot, [{ label: 'node n', localTransform: w.translation(2, 0, 0) }]);
    const [cube] = await B.add(1, n, [{ label: 'reference cube', localTransform: w.IDENTITY, spatialAssetURI: models.url('/models/cube.gltf') }]);
    if (options.extraB) await options.extraB(B, { bRoot, n, cube, models });
    const aRoot = await A.rootOf(1);
    const [X, Y, M] = await A.add(1, aRoot, [
      { label: 'X', localTransform: w.translation(10, 0, 0), spatialAssetURI: B.spatialUrl(1) },
      { label: 'Y', localTransform: w.scaled(0.01, 0, 0, 5), spatialAssetURI: B.nodeUrl(1, n) },
      { label: 'M', localTransform: w.translation(-6, 0, 0), spatialAssetURI: models.url('/wow/spatial/1/node/model.gltf') },
    ]);
    const inc = await w.client(impl.clientEdits);
    return {
      A, B, models, inc,
      ids: { bRoot, n, cube, aRoot, X, Y, M },
      urls: { X: A.nodeUrl(1, X), Y: A.nodeUrl(1, Y), M: A.nodeUrl(1, M), n: B.nodeUrl(1, n), cube: B.nodeUrl(1, cube) },
      compose: (opts) => inc.composeInclusions(A.spatialUrl(1), Object.assign({ fetch }, opts || {})),
      async close() { await A.close(); await B.close(); await models.close(); },
    };
  } catch (error) {
    await A.close(); await B.close(); await models.close();
    throw error;
  }
}

/** The inclusion met at a node URL. */
const inclusionAt = (composition, nodeUrl) => composition.inclusions.find((i) => i.node === nodeUrl) || null;

/** The placements of a node URL inside the graph instances included through `viaUrl`. */
function placementsVia(composition, nodeUrl, viaUrl) {
  const instances = new Set(composition.graphs.filter((g) => g.via === viaUrl).map((g) => g.instance));
  return (composition.registry.get(nodeUrl) || []).filter((r) => instances.has(r.instance));
}

/** The reference script's numbers, by label. */
function reference(python) {
  const out = {};
  for (const line of python('../arch-i2/reference-inclusion.py').split('\n')) {
    const m = /^(I\d+)\s+(.*)$/.exec(line.trim());
    if (!m) continue;
    const parts = m[2].split(/\s+/);
    for (let i = 0; i + 1 < parts.length; i += 1) {
      if (/^-?\d/.test(parts[i + 1]) && !/^-?\d/.test(parts[i])) out[m[1] + '.' + parts[i]] = Number(parts[i + 1]);
    }
  }
  return out;
}

module.exports = { baseScene, inclusionAt, placementsVia, reference };
