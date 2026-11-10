/** Renderer-free projection of the existing canonical world and authored graph. */
export const CANONICAL_LIGHTS = Object.freeze([
  Object.freeze({ kind: "ambient", color: 0xffffff, intensity: 0.75, name: "canonical-world-ambient" }),
  Object.freeze({ kind: "directional", color: 0xffffff, intensity: 0.9, position: [4, 8, 6], name: "canonical-world-key" }),
]);
export const AUTHORED_STAGE_LIGHTS = Object.freeze([
  Object.freeze({ kind: "ambient", color: 0xffffff, intensity: 0.6 }),
  Object.freeze({ kind: "directional", color: 0xffffff, intensity: 0.85, position: [5, 9, 6] }),
  Object.freeze({ kind: "directional", color: 0x88aaff, intensity: 0.4, position: [-6, 5, -7] }),
]);

/** `osl-light:directional?intensity=0.9&color=ffffff` -> plain light fields. */
export function parseOslLight(uri) {
  const match = /^osl-light:(ambient|directional)(?:\?(.*))?$/i.exec(String(uri || ""));
  if (!match) return null;
  const params = new URLSearchParams(match[2] || "");
  const intensity = Number(params.get("intensity"));
  const color = /^[0-9a-f]{6}$/i.test(params.get("color") || "") ? parseInt(params.get("color"), 16) : 0xffffff;
  return { kind: match[1].toLowerCase(), intensity: Number.isFinite(intensity) && intensity >= 0 ? intensity : 1, color };
}

export function describeScene({ world = null, graph = null, avatar = null, phase = null } = {}) {
  const { nodes: normalized } = normalizeGraph(graph);
  const nodes = [...normalized.entries()].map(([id, node]) => ({ ...node, id }));
  const authoredLights = nodes.some(node => /^osl-light:/i.test(String(node?.spatialAssetURI || "")));
  return {
    world, graph, avatar, phase, rooms: world?.rooms || [], objects: world?.objects || [],
    destinations: world?.portals || (world?.portal ? [world.portal] : []),
    nodes: nodes.map(node => ({ id: node.id, label: String(node.label ?? node.id), light: parseOslLight(node.spatialAssetURI) })),
    lighting: {
      source: graph ? authoredLights ? "authored-nodes" : "authored-stage" : "canonical-world",
      lights: graph ? authoredLights ? [] : AUTHORED_STAGE_LIGHTS : CANONICAL_LIGHTS,
      environment: null,
    },
  };
}

export function normalizeGraph(graph) {
  const spatialID = (graph && (graph.spatialID || graph.spatial_id)) || null;
  const nodes = new Map();
  const raw = graph && graph.nodes;
  if (Array.isArray(raw)) {
    for (const n of raw) if (n && n.id != null) nodes.set(Number(n.id), n);
  } else if (raw && typeof raw === "object") {
    for (const k of Object.keys(raw)) {
      const n = raw[k];
      const id = n && n.id != null ? Number(n.id) : Number(k);
      if (Number.isFinite(id)) nodes.set(id, n);
    }
  }
  // A canonical Node embeds its children. The builder walks ids, so each embedded child becomes a node
  // of its own and its parent lists the child's id.
  const flattened = flattenEmbeddedChildren(nodes);
  nodes.clear();
  for (const [id, n] of flattened) nodes.set(id, n);
  let rootId =
    graph && graph.root != null
      ? Number(graph.root)
      : graph && graph.rootId != null
      ? Number(graph.rootId)
      : null;
  if (rootId == null || !nodes.has(rootId)) {
    // infer: a node with no parent, else the smallest id present.
    let inferred = null;
    for (const [id, n] of nodes) {
      if (!n || n.parent == null) {
        inferred = id;
        break;
      }
    }
    if (inferred == null) {
      const ids = [...nodes.keys()];
      inferred = ids.length ? Math.min(...ids) : null;
    }
    rootId = inferred;
  }
  return { spatialID, rootId, nodes };
}

// Reading a Web of Worlds graph: the canonical Node embeds its children, and the scene builder and
// the live adapter work on a flat map of nodes whose children are ids. This turns one into the other.
//
// Pure: no DOM, no fetch, no three. Node-safe, so a headless proof can use the same code.

const DEFAULT_LIMIT = 20000;

/**
 * Walk a canonical Node (children embedded) and return `{ rootId, nodes, count, truncated }`,
 * where `nodes` is `{ [id]: node }` and every node's `children` is the list of its children's ids.
 * Each entry is a shallow copy; the input is not changed. Iterative, so a very deep tree from a
 * hostile server cannot exhaust the stack, and capped at `limit` nodes.
 */
export function flattenCanonicalNode(root, { limit = DEFAULT_LIMIT } = {}) {
  const nodes = {};
  let count = 0;
  let truncated = false;
  const stack = root && typeof root === "object" && root.id != null ? [root] : [];
  while (stack.length) {
    const node = stack.pop();
    if (count >= limit) { truncated = true; break; }
    const children = Array.isArray(node.children) ? node.children : [];
    nodes[Number(node.id)] = Object.assign({}, node, {
      children: children.map((child) => (child && typeof child === "object" ? child.id : child)),
    });
    count += 1;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child && typeof child === "object" && child.id != null) stack.push(child);
    }
  }
  return { rootId: root && root.id != null ? Number(root.id) : null, nodes, count, truncated };
}

/** True when a node has at least one child that is an embedded object, not an id. */
export function hasEmbeddedChildren(node) {
  return Boolean(node && Array.isArray(node.children) && node.children.some((c) => c && typeof c === "object"));
}

/**
 * Flatten every node of a Map<number, node> whose children are embedded objects, registering each
 * embedded child as a node of its own. A node already in the map keeps its own entry. Returns a new
 * Map; the input is not changed.
 */
export function flattenEmbeddedChildren(nodesById) {
  const out = new Map(nodesById);
  for (const node of nodesById.values()) {
    if (!hasEmbeddedChildren(node)) continue;
    const flat = flattenCanonicalNode(node);
    for (const [id, copy] of Object.entries(flat.nodes)) {
      const key = Number(id);
      if (key === Number(node.id) || !out.has(key)) out.set(key, copy);
    }
  }
  return out;
}
