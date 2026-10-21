/**
 * Reconcile renderer-owned HTML without replacing keyed live DOM nodes.
 *
 * A keyed node keeps focus, selection, scroll-linked identity, and any browser-
 * owned state while its text and renderer-owned attributes update. Callers opt
 * in by assigning a stable `data-reconcile-key`.
 */

const RENDERER_OWNED_ATTRIBUTE = /^(class|data-[\w-]+)$/;

function nodeKey(node) {
  if (!node || node.nodeType !== 1) return null;
  const key = node.getAttribute("data-reconcile-key");
  return key ? `K:${key}` : null;
}

function sameNodeShape(live, fresh) {
  return live.nodeType === fresh.nodeType &&
    (live.nodeType !== 1 || live.tagName === fresh.tagName);
}

function syncAttributes(live, fresh) {
  for (const attribute of Array.from(fresh.attributes)) {
    if (live.getAttribute(attribute.name) !== attribute.value) {
      live.setAttribute(attribute.name, attribute.value);
    }
  }
  for (const attribute of Array.from(live.attributes)) {
    if (!RENDERER_OWNED_ATTRIBUTE.test(attribute.name)) continue;
    if (!fresh.hasAttribute(attribute.name)) live.removeAttribute(attribute.name);
  }
}

function syncNode(live, fresh, keyedNodes, claimed) {
  if (live.nodeType !== 1) {
    if (live.nodeValue !== fresh.nodeValue) live.nodeValue = fresh.nodeValue;
    return;
  }
  syncAttributes(live, fresh);
  syncChildren(live, fresh, keyedNodes, claimed);
}

function syncChildren(live, fresh, keyedNodes, claimed = new Set()) {
  let anchor = null;
  for (const next of Array.from(fresh.childNodes)) {
    const key = nodeKey(next);
    const target = anchor ? anchor.nextSibling : live.firstChild;
    let node = key ? keyedNodes.get(key) : null;
    if (node && claimed.has(node)) node = null;
    if (!node && target && !nodeKey(target) && sameNodeShape(target, next) && !claimed.has(target)) {
      node = target;
    }
    if (!node) {
      node = next;
      if (key) keyedNodes.set(key, node);
    } else {
      syncNode(node, next, keyedNodes, claimed);
    }
    if (node !== target) live.insertBefore(node, target);
    claimed.add(node);
    anchor = node;
  }
  for (const stale of Array.from(live.childNodes)) {
    if (!claimed.has(stale)) live.removeChild(stale);
  }
}

export function reconcileKeyedHtml(root, html) {
  if (!root) return;
  const staging = root.ownerDocument.createElement("div");
  staging.innerHTML = html;
  const keyedNodes = new Map();
  root.querySelectorAll("[data-reconcile-key]").forEach((element) => {
    const key = nodeKey(element);
    if (key && !keyedNodes.has(key)) keyedNodes.set(key, element);
  });
  syncChildren(root, staging, keyedNodes);
}
