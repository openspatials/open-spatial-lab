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
