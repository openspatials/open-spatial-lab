'use strict';

/*
 * Helpers for the iteration 4 proof: the portal client (real or with a planted fault), the plain
 * double-precision reference, and node reads. Worlds, presence and request logs come from iteration 3's
 * helpers.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const i3 = require('../arch-i3/lab');
const { httpReq } = require('../arch-i1/lib');

const { w } = i3;

/** The portal client (web/wow-portal.mjs), real or with exact string edits. */
const portalClient = (edits) => i3.webModule('wow-portal.mjs', edits);

/** Run reference-placement.py on `input` (see its header) and return its answer. */
function reference(input) {
  const result = spawnSync('python3', [path.join(__dirname, 'reference-placement.py')], { input: JSON.stringify(input), encoding: 'utf8' });
  if (result.error) throw new Error('python3 is required for the reference: ' + result.error.message);
  if (result.status !== 0) throw new Error('reference-placement.py exited ' + result.status + ': ' + result.stderr);
  return JSON.parse(result.stdout);
}

/** A node as served in the flat form (parent as an id). */
async function flatNode(world, graph, id) {
  const r = await httpReq('GET', world.port, (world.prefix || '') + `/wow/spatial/${graph}/node/${id}?nodeForm=flat`, null, { Accept: w.WOW });
  return r.status === 200 ? r.json : null;
}

/** The localTransforms from a node's graph root down to the node, read one node at a time. */
async function chainOf(world, graph, id) {
  const chain = [];
  for (let at = await flatNode(world, graph, id), guard = 0; at && guard < 64; guard += 1) {
    chain.unshift(at.localTransform);
    at = Number.isInteger(at.parent) ? await flatNode(world, graph, at.parent) : null;
  }
  return chain;
}

/** Every node of a graph, read from its root down: [{ id, parent, chain }]. */
async function allNodes(world, graph) {
  const spatial = await httpReq('GET', world.port, (world.prefix || '') + `/wow/spatial/${graph}`, null, { Accept: w.WOW });
  const out = [];
  const walk = async (id, chain) => {
    const node = await flatNode(world, graph, id);
    if (!node) return;
    const here = chain.concat([node.localTransform]);
    out.push({ id: node.id, parent: node.parent, label: node.label, chain: here });
    for (const child of node.children || []) await walk(typeof child === 'object' ? child.id : child, here);
  };
  await walk(spatial.json.rootNodeID, []);
  return out;
}

async function getWow(world, p) {
  const r = await httpReq('GET', world.port, (world.prefix || '') + p, null, { Accept: w.WOW });
  return r;
}

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The ids of a graph's nodes within `radius` of node `n`, from every node's chain, by the plain reference. */
async function withinRadius(world, graph, n, radius) {
  const nodes = await allNodes(world, graph);
  const ref = reference({ chains: Object.fromEntries(nodes.map((x) => [String(x.id), x.chain])) }).positions;
  return nodes.filter((x) => distance(ref[String(x.id)], ref[String(n)]) <= radius).map((x) => x.id).sort((a, b) => a - b);
}

// A turn about +Y by `deg` degrees, a uniform scale, then a move to (x, y, z): a node's localTransform.
function placed(x, y, z, deg = 0, scale = 1) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r) * scale, s = Math.sin(r) * scale;
  return [c, 0, -s, 0, 0, scale, 0, 0, s, 0, c, 0, x, y, z, 1];
}

module.exports = { ...i3, portalClient, reference, flatNode, chainOf, allNodes, withinRadius, getWow, distance, placed };
