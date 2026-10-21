'use strict';

/*
 * Iteration 1, the canonical form: N4 (one canonical node form, flat only on request, and the
 * client reads embedded children) and N6 (the Spatial resource, with integer graph ids).
 *
 * Both measure what a world server puts on the wire against the contract's own schemas, with ajv,
 * and not against a header the server writes about itself.
 */

const path = require('path');
const { ROOT, run, httpReq, loadEsmMutant } = require('./lib');
const { boot } = require('./harness');
const { graphApi, IDENTITY } = require('./api');

const { createValidator } = require(path.join(ROOT, 'wow-spec', 'validate'));
const validator = createValidator();

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const GET = (port, p, headers) => httpReq('GET', port, p, undefined, headers);
const ROOT_PATH = '/wow/spatial/1/node/0';

/** Every node of an embedded tree, once each, parents first. Returns { nodes, repeated }. */
function embeddedNodes(root) {
  const nodes = [];
  const seen = new Set();
  let repeated = 0;
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (seen.has(node.id)) { repeated += 1; continue; }
    seen.add(node.id);
    nodes.push(node);
    for (const child of node.children || []) if (child && typeof child === 'object') stack.push(child);
  }
  return { nodes, repeated };
}

/** The client's reader (web/wow-scene.mjs normalizeGraph), real or mutated. */
async function clientReader(impl) {
  if (impl && impl.clientEdits) {
    return (await loadEsmMutant('web/wow-scene.mjs', impl.clientEdits, ['wow-graph.mjs'])).default.normalizeGraph;
  }
  return (await import(require('url').pathToFileURL(path.join(ROOT, 'web', 'wow-scene.mjs')).href)).default.normalizeGraph;
}

async function canonicalChecks(ports) {
  const server = (impl) => boot('a', ports.next(), { edits: impl && impl.edits ? impl.edits : null });

  // ---- N4. One canonical form ---------------------------------------------------------------------------
  const flatByDefault = { server: [["return raw === 'flat' ? 'flat' : 'canonical';", "return raw === 'canonical' ? 'canonical' : 'flat';"]] };
  const refusesEmbedded = { server: [['{ flattenEmbedded : !flat });', '{ flattenEmbedded : false });']] };
  const ignoresFlatRequest = { server: [["return raw === 'flat' ? 'flat' : 'canonical';", "return 'canonical';"]] };
  const clientIgnoresEmbedded = [['  const flattened = flattenEmbeddedChildren(nodes);', '  const flattened = nodes;']];
  await run('N4', 'nodes are read and written as the canonical Node with embedded children; the flat form comes only on request; the client reads embedded children', async (impl) => {
    const s = await server(impl);
    try {
      const failures = [];
      const api = graphApi(s.port, 1);

      // 1. A read with no form is the canonical Node.
      const read = await GET(s.port, ROOT_PATH);
      if (read.status !== 200 || !read.json) throw new Error('GET ' + ROOT_PATH + ': ' + read.status);
      const canonical = validator.validateResponse('node', read.json);
      if (!canonical.valid) failures.push('the default read is not a valid Node: ' + String(canonical.errorsText).slice(0, 140));
      if (read.headers['x-osl-wow-node-form'] !== 'canonical') failures.push('the default read says its form is ' + read.headers['x-osl-wow-node-form']);
      const kids = read.json.children || [];
      if (!kids.length || !kids.every((child) => child && typeof child === 'object')) failures.push('the default read does not embed its children');
      const tree = embeddedNodes(read.json);
      if (tree.repeated) failures.push(tree.repeated + ' node(s) appear more than once in the embedded tree');

      // 2. A canonical POST with embedded children is stored whole, with every id assigned.
      const body = [{ label: 'n4-a', localTransform: IDENTITY, children: [
        { label: 'n4-aa', localTransform: IDENTITY, children: [ { label: 'n4-aaa', localTransform: IDENTITY } ] },
        { label: 'n4-ab', localTransform: IDENTITY },
      ] }];
      const post = await httpReq('POST', s.port, ROOT_PATH, body);
      if (post.status !== 200 || !Array.isArray(post.json)) {
        failures.push('POST of embedded children: ' + post.status + ' ' + String(post.body).slice(0, 120));
      } else {
        const created = embeddedNodes(post.json[0]);
        if (post.json.length !== 1 || created.nodes.length !== 4) failures.push('POST stored ' + created.nodes.length + ' nodes in ' + post.json.length + ' tree(s); wanted 4 in 1');
        if (!validator.validateRequest('Node[]', post.json).valid) failures.push('the POST response is not a valid Node[]');
        if (post.headers['x-osl-wow-nodes-stored'] !== '4/1') failures.push('nodes stored header: ' + post.headers['x-osl-wow-nodes-stored']);
        for (const node of created.nodes) {
          const again = await GET(s.port, '/wow/spatial/1/node/' + node.id);
          if (again.status !== 200 || !same(again.json, node)) failures.push('node ' + node.id + ' read back differs from what POST returned');
        }
        const parent = await GET(s.port, ROOT_PATH);
        const listed = (parent.json.children || []).find((child) => child.id === post.json[0].id);
        if (!listed || !same(listed, post.json[0])) failures.push('the parent does not embed the created subtree');
      }

      // 3. The flat form is OSL's labeled extension, served on request, by query or by header.
      for (const [how, flatRead] of [
        ['?nodeForm=flat', await GET(s.port, ROOT_PATH + '?nodeForm=flat')],
        ['X-OSL-WoW-Node-Form: flat', await GET(s.port, ROOT_PATH, { 'X-OSL-WoW-Node-Form': 'flat' })],
      ]) {
        if (flatRead.status !== 200 || !flatRead.json) { failures.push(how + ': ' + flatRead.status); continue; }
        if (!validator.validateResponse('flatNode', flatRead.json).valid) failures.push(how + ': not a valid OSLFlatNode');
        if (validator.validateCanonical('node', flatRead.json).valid) failures.push(how + ': a flat node with children validates as a canonical Node');
        if (!(flatRead.json.children || []).every(Number.isInteger)) failures.push(how + ': children are not integer ids');
        if (flatRead.headers['x-osl-wow-node-form'] !== 'flat') failures.push(how + ': form header ' + flatRead.headers['x-osl-wow-node-form']);
      }

      // 4. In the flat form an embedded body is refused, and nothing is stored.
      const before = (await GET(s.port, ROOT_PATH + '?nodeForm=flat')).json.children.length;
      const refused = await httpReq('POST', s.port, ROOT_PATH + '?nodeForm=flat', [{ label: 'n4-x', localTransform: IDENTITY, children: [ { label: 'n4-xa', localTransform: IDENTITY } ] }]);
      const after = (await GET(s.port, ROOT_PATH + '?nodeForm=flat')).json.children.length;
      if (refused.status !== 422 || !refused.json || refused.json.error !== 'embedded_children_not_supported') failures.push('flat POST with embedded children: ' + refused.status + ' ' + String(refused.body).slice(0, 80));
      if (after !== before) failures.push('a refused flat POST stored something (' + before + ' -> ' + after + ' children)');
      const flatLeaf = await httpReq('POST', s.port, ROOT_PATH + '?nodeForm=flat', [{ label: 'n4-leaf', localTransform: IDENTITY }]);
      if (flatLeaf.status !== 200 || !Array.isArray(flatLeaf.json) || flatLeaf.json[0].children === undefined || !validator.validateRequest('OSLFlatNode[]', flatLeaf.json).valid) failures.push('flat POST of a leaf: ' + flatLeaf.status);

      // 5. The client reads the embedded form: the same nodes as a walk by node URL, children as ids.
      const normalizeGraph = await clientReader(impl);
      const fresh = await GET(s.port, ROOT_PATH);
      const walk = await api.walk(0);
      const graph = normalizeGraph({ spatialID: '1', root: 0, nodes: [fresh.json] });
      const clientIds = [...graph.nodes.keys()].sort((x, y) => x - y);
      const walkedIds = [...walk.nodes.keys()].sort((x, y) => x - y);
      if (!same(clientIds, walkedIds)) failures.push('the client read ' + clientIds.length + ' nodes; a walk by URL found ' + walkedIds.length);
      for (const [id, node] of graph.nodes) {
        if (!(node.children || []).every(Number.isInteger)) { failures.push('the client left embedded children on node ' + id); break; }
        const served = walk.nodes.get(id);
        if (served && !same(node.children, served.children)) { failures.push('the client read different children for node ' + id); break; }
      }
      return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 4).join('; ') : `${tree.nodes.length} nodes embedded on read; 4 stored from one POST; flat on request by query and by header; the client read ${clientIds.length} nodes` };
    } finally { await s.close(); }
  }, { edits: null }, [
    { name: 'a server that answers a default request in the flat form (the old default)', impl: { edits: flatByDefault } },
    { name: 'a server that refuses embedded children on a canonical POST (the old D7)', impl: { edits: refusesEmbedded } },
    { name: 'a server that ignores a request for the flat form', impl: { edits: ignoresFlatRequest } },
    { name: 'a client that does not flatten embedded children', impl: { clientEdits: clientIgnoresEmbedded } },
  ]);

  // ---- N6. The Spatial resource -------------------------------------------------------------------------
  const idAsString = { runtime: [['            id : store.graphId,', '            id : String(store.graphId),']] };
  const returnsRootNode = { server: [["                if (spatialForm === 'node')\n                {", "                if (true)\n                {"]] };
  const wrongRoot = { runtime: [['            rootNodeID : rootNodeID,', '            rootNodeID : rootNodeID + 1,']] };
  const contractTypesIdAsString = (doc) => {
    const param = doc.paths['/wow/spatial/{spatialID}'].get.parameters.find((p) => p.name === 'spatialID');
    param.schema = { type: 'string' };
  };
  await run('N6', 'GET /wow/spatial/{id} returns the Spatial resource {id, rootNodeID, geoPose} with integer ids; the root node is at /node/{rootNodeID}; the contract types the id as an integer', async (impl) => {
    const s = await server(impl);
    try {
      const failures = [];
      const spatial = await GET(s.port, '/wow/spatial/1');
      if (spatial.status !== 200 || !spatial.json) throw new Error('GET /wow/spatial/1: ' + spatial.status);
      const verdict = validator.validateResponse('spatial', spatial.json);
      if (!verdict.valid) failures.push('not a valid Spatial: ' + String(verdict.errorsText).slice(0, 140));
      if (!Number.isInteger(spatial.json.id)) failures.push('id is ' + JSON.stringify(spatial.json.id) + ', not an integer');
      if (!Number.isInteger(spatial.json.rootNodeID)) failures.push('rootNodeID is ' + JSON.stringify(spatial.json.rootNodeID) + ', not an integer');
      if (!spatial.json.geoPose || !spatial.json.geoPose.position) failures.push('no geoPose');
      if (spatial.json.children !== undefined || spatial.json.localTransform !== undefined) failures.push('the response is a node, not the Spatial resource');

      // The root node it points at.
      const rootNode = await GET(s.port, '/wow/spatial/1/node/' + spatial.json.rootNodeID);
      if (rootNode.status !== 200 || !rootNode.json || rootNode.json.id !== spatial.json.rootNodeID) failures.push('the root node at /node/' + spatial.json.rootNodeID + ': ' + rootNode.status);
      else if (rootNode.json.parent !== undefined && rootNode.json.parent !== null) failures.push('the root node has a parent: ' + rootNode.json.parent);
      // ...and the OSL convenience that returns that same node from the graph path.
      const asNode = await GET(s.port, '/wow/spatial/1?form=node');
      if (rootNode.json && !same(asNode.json, rootNode.json)) failures.push('?form=node does not return the root node');

      // A graph id that is not a graph of this world.
      for (const missing of ['2', '0', '-1', '1.5']) {
        const r = await GET(s.port, '/wow/spatial/' + missing);
        if (r.status !== 404) failures.push('graph ' + missing + ': status ' + r.status + ', wanted 404');
      }

      // The contract types the graph id as the API does.
      const doc = JSON.parse(JSON.stringify(validator.doc));
      if (impl && impl.mutateDoc) impl.mutateDoc(doc);
      const params = [
        ['/wow/spatial/{spatialID}', 'get'],
        ['/wow/spatial/{spatialID}/node/{nodeId}', 'get'],
        ['/wow/spatial/{spatialID}/node/{nodeId}', 'post'],
        ['/wow/spatial/{spatialID}/node/{nodeId}', 'put'],
        ['/wow/spatial/{spatialID}/node/{nodeId}', 'delete'],
      ];
      for (const [route, method] of params) {
        const param = ((doc.paths[route] || {})[method] || {}).parameters || [];
        const found = param.find((p) => p.name === 'spatialID');
        if (!found || !found.schema || found.schema.type !== 'integer') failures.push(method.toUpperCase() + ' ' + route + ': spatialID is ' + JSON.stringify(found && found.schema));
      }
      const idType = doc.components.schemas.Spatial.properties.id.type;
      if (idType !== 'integer') failures.push('Spatial.id is typed ' + idType);
      return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 4).join('; ') : `Spatial {id ${spatial.json.id}, rootNodeID ${spatial.json.rootNodeID}}; root node resolves; 4 unknown ids are 404; 5 operations type spatialID as an integer` };
    } finally { await s.close(); }
  }, { edits: null }, [
    { name: 'a server whose Spatial id is a string', impl: { edits: idAsString } },
    { name: 'a server that answers the graph path with the root node (the old default)', impl: { edits: returnsRootNode } },
    { name: 'a Spatial whose rootNodeID points at no root', impl: { edits: wrongRoot } },
    { name: 'a contract that types spatialID as a string (the old D4)', impl: { mutateDoc: contractTypesIdAsString } },
  ]);
}

module.exports = { canonicalChecks };
