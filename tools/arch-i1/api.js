'use strict';

/* Small client for one world server's spatial graph, used by the iteration 1 checks. */

const { httpReq } = require('./lib');

const GRAPH_IDS = { a: 'demo-room-a', b: 'demo-room-b', lobby: 'demo-lobby', airport: 'world-airport-terminal' };
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translation = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

function graphApi(port, graphId) {
  const base = '/wow/spatial/' + encodeURIComponent(graphId);
  const api = {
    port,
    graphId,
    node: (id) => httpReq('GET', port, base + '/node/' + id + '?nodeForm=flat'),
    create: (parentId, nodes, headers) => httpReq('POST', port, base + '/node/' + parentId, nodes, headers),
    update: (id, body) => httpReq('PUT', port, base + '/node/' + id + '?nodeForm=flat', body),
    remove: (id) => httpReq('DELETE', port, base + '/node/' + id),
    reset: () => httpReq('POST', port, '/reset', {}),
    /** Create one node under a parent and return its id. */
    async make(parentId, label, transform) {
      const r = await api.create(parentId, [{ label, localTransform: transform || IDENTITY }]);
      if (r.status !== 200 || !r.json || !r.json[0]) throw new Error('could not create ' + label + ': ' + r.status + ' ' + r.body.slice(0, 120));
      return r.json[0].id;
    },
    /**
     * Walk the graph from its root by node URL. Returns the nodes by id and every problem found:
     * a URL that does not resolve, a node whose id differs from its URL, a node reached twice, a
     * parent link that disagrees with the parent's children, a cycle.
     */
    async walk(rootId) {
      const nodes = new Map();
      const problems = [];
      const queue = [{ id: rootId === undefined ? 0 : rootId, from: null }];
      let steps = 0;
      while (queue.length && steps < 5000) {
        steps += 1;
        const { id, from } = queue.shift();
        const r = await api.node(id);
        if (r.status !== 200 || !r.json) { problems.push('node ' + id + ' does not resolve (' + r.status + ')'); continue; }
        const node = r.json;
        if (node.id !== id) problems.push('node URL ' + id + ' returned node ' + node.id);
        if (nodes.has(id)) { problems.push('node ' + id + ' is reached twice'); continue; }
        if (from !== null && node.parent !== from) problems.push('node ' + id + ' lists parent ' + node.parent + ' but is a child of ' + from);
        nodes.set(id, node);
        for (const child of node.children || []) queue.push({ id: child, from: id });
      }
      return { nodes, problems };
    },
  };
  return api;
}

module.exports = { graphApi, GRAPH_IDS, IDENTITY, translation };
