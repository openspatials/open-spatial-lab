// What the proof reads straight from a world's Web of Worlds API, with its own plain arithmetic, to compare against
// what the page shows. Nothing here is shared with the browser code.

const ACCEPT = { Accept: "application/wow+json, application/json;q=0.9" };

export async function getJson(url) {
  const r = await fetch(url, { headers: ACCEPT, cache: "no-store" });
  return { status: r.status, json: await r.json().catch(() => null) };
}

async function must(url) {
  const r = await getJson(url);
  if (r.status !== 200) throw new Error(`GET ${url} answered ${r.status}`);
  return r.json;
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
    }
  }
  return out;
}

/** A node's pose in its graph, composed by reading it and each parent one at a time. */
export async function nodePose(address, graph, id) {
  let matrix = null;
  for (let at = id, guard = 0; at !== null && at !== undefined && guard < 64; guard += 1) {
    const node = await must(`${address}wow/spatial/${graph}/node/${at}?nodeForm=flat`);
    matrix = matrix ? multiply(node.localTransform, matrix) : node.localTransform.slice();
    at = Number.isInteger(node.parent) ? node.parent : null;
  }
  const length = Math.hypot(matrix[8], matrix[10]) || 1;
  return { position: [matrix[12], matrix[13], matrix[14]], forward: [matrix[8] / length, 0, matrix[10] / length] };
}

export async function worldPortals(address) {
  const world = await must(`${address}wow/world`);
  const out = [];
  for (let id = 1; id <= world.portals.portal_count; id += 1) {
    const resource = await must(`${address}wow/portal/${id}`);
    const ref = /wow\/spatial\/(\d+)\/node\/(\d+)$/.exec(resource.node || "");
    out.push({ id, resource, graph: ref ? Number(ref[1]) : null, nodeId: ref ? Number(ref[2]) : null, pose: ref ? await nodePose(address, Number(ref[1]), Number(ref[2])) : null });
  }
  return out;
}

/** Where a destination URL arrives: its base and the pose of the node `#join=node.{n}` names. */
export async function arrivalOf(destination) {
  const u = new URL(destination);
  const join = /^#join=node[./](\d+)$/.exec(u.hash);
  u.hash = "";
  const base = u.href;
  return { base, node: join ? Number(join[1]) : null, pose: join ? await nodePose(base, 1, Number(join[1])) : null };
}

/** Every node of a graph with its composed position, from the root down. */
export async function allNodes(address, graph) {
  const spatial = await must(`${address}wow/spatial/${graph}`);
  const tree = await must(`${address}wow/spatial/${graph}/node/${spatial.rootNodeID}`);
  const out = [];
  const walk = (node, parent) => {
    const matrix = parent ? multiply(parent, node.localTransform) : node.localTransform;
    out.push({ id: node.id, label: node.label, position: [matrix[12], matrix[13], matrix[14]] });
    for (const child of node.children || []) walk(child, matrix);
  };
  walk(tree, null);
  return out;
}

export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Place a portal through the world's API: a node under the root, facing the middle of the world, then the portal. */
export async function placeByApi(address, { x, z, label, destination = null, active_radius_m = null }) {
  const spatial = await must(`${address}wow/spatial/1`);
  const yaw = Math.atan2(-x, -z);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const nodeAnswer = await fetch(`${address}wow/spatial/1/node/${spatial.rootNodeID}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/wow+json" },
    body: JSON.stringify([{ label: `${label} (portal placement)`, localTransform: [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x, 0, z, 1] }]),
  });
  if (!nodeAnswer.ok) throw new Error(`placing a node on ${address} answered ${nodeAnswer.status}`);
  const [node] = await nodeAnswer.json();
  const portalAnswer = await fetch(`${address}wow/portal`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/wow+json" },
    body: JSON.stringify({ node: `wow/spatial/1/node/${node.id}`, label, destination, active_radius_m }),
  });
  if (!portalAnswer.ok) throw new Error(`placing a portal on ${address} answered ${portalAnswer.status}`);
  return { node, portal: await portalAnswer.json(), inward: [Math.sin(yaw), 0, Math.cos(yaw)], yaw };
}
