/*
 * Portals and previews (iteration 4). Pure: no DOM and no three.js; fetch is passed in, so the same code
 * runs in the browser and in the Node proof.
 *
 * A portal resource (GET {base}wow/portal/{id}) names:
 *   destination  the entry URL of the world it leads to, with an optional `#join=node.{n}` arrival point;
 *   node         the node that places the portal, relative to its world's base URL.
 *
 * Crossing is plain navigation to `destination`. Before navigating, the client checks that the
 * destination answers, so an offline world refuses the crossing with a reason and the visitor stays.
 * After navigating, the destination's page arrives at node n's pose: arrivalAt() composes the node's
 * transform from its graph's root down.
 *
 * A preview shows the destination only as far as the destination allows. Its World resource declares
 * `preview`: an arrival node, a radius and a preview URL that returns only the nodes within the radius,
 * or an image URL. With neither, the portal shows a plain colour. A portal inside a preview shows
 * closed: its own destination is never read.
 */

import { WOW_MEDIA_TYPE, multiply } from "./wow-inclusion.mjs";
import { worldBaseOf } from "./wow-observe.mjs";

export const PREVIEW_COLOR = "#28344f";

export const REFUSAL = Object.freeze({
  NO_DESTINATION: "no destination: this portal leads nowhere",
  OFFLINE: "destination offline",
  NO_ARRIVAL: "arrival node not found",
});

const ACCEPT = `${WOW_MEDIA_TYPE}, application/json;q=0.9`;
const JOIN_NODE = /^join=node[./](\d+)$/;

/**
 * A world's base URL from an entry URL. A lab player URL names its world in the `wow` query
 * parameter; any other entry URL is its own base (the base-URL rule: the base is the URL up to its
 * last `/`).
 */
export function entryBase(entryUrl) {
  const u = new URL(entryUrl);
  const named = u.searchParams.get("wow");
  if (named) return worldBaseOf(new URL(named, u).href);
  u.hash = "";
  u.search = "";
  u.pathname = u.pathname.replace(/[^/]*$/, "");
  return u.href;
}

/** A destination: the entry URL, its world's base URL, and the node id named by `#join=node.{n}`, if any. */
export function parseDestination(destination) {
  const u = new URL(destination);
  const match = JOIN_NODE.exec(decodeURIComponent(u.hash.slice(1)));
  return { entry: u.href, base: entryBase(u.href), join: match ? Number(match[1]) : null };
}

/**
 * GET a JSON resource. A world that is slow to answer is not offline: a request is given 10 s, and one that
 * runs out of time is tried once more, before the caller hears that the world did not answer.
 */
async function readJson(url, opts) {
  try {
    return await readJsonOnce(url, opts);
  } catch (error) {
    if (!error || error.name !== "AbortError") throw error;
    return readJsonOnce(url, opts);
  }
}

async function readJsonOnce(url, opts) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (opts.onRequest) opts.onRequest(url);
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), opts.timeoutMs || 10000) : null;
  try {
    const r = await fetchImpl(url, { headers: { Accept: ACCEPT }, cache: "no-store", signal: controller ? controller.signal : undefined });
    if (!r.ok) {
      try { await r.text(); } catch { /* ignore */ }
      const error = new Error(`${url} answered ${r.status}`);
      error.status = r.status;
      throw error;
    }
    return await r.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The portals of the world at `base`, each with its resource and the node that places it. */
export async function readPortals(base, opts = {}) {
  const world = await readJson(new URL("wow/world", base).href, opts);
  const count = Number(world && world.portals && world.portals.portal_count) || 0;
  const out = [];
  for (let id = 1; id <= count; id += 1) {
    const url = new URL(`wow/portal/${id}`, base).href;
    let resource;
    try { resource = await readJson(url, opts); } catch { continue; }
    const nodeUrl = typeof resource.node === "string" ? new URL(resource.node, base).href : null;
    const nodeId = nodeUrl ? Number(/\/node\/(\d+)$/.exec(nodeUrl)?.[1]) : NaN;
    out.push({ id, url, resource, nodeUrl, nodeId: Number.isInteger(nodeId) ? nodeId : null });
  }
  return out;
}

/**
 * Where a visitor arrives at node `nodeId` of the world at `base`: the node's transform composed from
 * its graph's root down, with its position and heading (its +Z axis).
 */
export async function arrivalAt(base, nodeId, opts = {}) {
  const world = await readJson(new URL("wow/world", base).href, opts);
  const graphs = Array.isArray(world.spatials) && world.spatials.length ? world.spatials : [1];
  for (const graph of graphs) {
    const url = new URL(`wow/spatial/${graph}/node/${nodeId}?nodeForm=flat`, base).href;
    let node;
    try { node = await readJson(url, opts); } catch { continue; }
    let matrix = localTransformOf(node);
    let parent = node.parent;
    for (let guard = 0; Number.isInteger(parent) && guard < 256; guard += 1) {
      const above = await readJson(new URL(`wow/spatial/${graph}/node/${parent}?nodeForm=flat`, base).href, opts);
      matrix = multiply(localTransformOf(above), matrix);
      parent = above.parent;
    }
    return {
      node: new URL(`wow/spatial/${graph}/node/${nodeId}`, base).href,
      graph,
      matrix,
      position: [matrix[12], matrix[13], matrix[14]],
      yaw: Math.atan2(matrix[8], matrix[10]),
    };
  }
  return null;
}

/**
 * Cross a portal (its resource, or its URL). Refuses, with a reason and without navigating, when the
 * portal has no destination, when the destination does not answer, or when its arrival node is not
 * there. Otherwise calls opts.navigate(destination) and returns where the visitor arrives.
 */
export async function crossPortal(portal, opts = {}) {
  const resource = typeof portal === "string" ? await readJson(portal, opts) : portal;
  if (!resource || typeof resource.destination !== "string" || !resource.destination) {
    return { crossed: false, reason: REFUSAL.NO_DESTINATION };
  }
  let destination;
  try { destination = parseDestination(resource.destination); } catch {
    return { crossed: false, reason: `${REFUSAL.NO_DESTINATION} (not a URL: ${resource.destination})` };
  }
  try {
    await readJson(new URL("wow/world", destination.base).href, opts);
  } catch (error) {
    return { crossed: false, destination: resource.destination, reason: `${REFUSAL.OFFLINE}: ${destination.base} did not answer (${error.status ? `HTTP ${error.status}` : "no connection"})` };
  }
  let arrival = null;
  if (destination.join !== null) {
    arrival = await arrivalAt(destination.base, destination.join, opts);
    if (!arrival) return { crossed: false, destination: resource.destination, reason: `${REFUSAL.NO_ARRIVAL}: node ${destination.join}` };
  }
  if (opts.navigate) opts.navigate(resource.destination);
  return { crossed: true, destination: resource.destination, base: destination.base, arrival };
}

/**
 * What a portal shows of its destination, as far as the destination allows:
 *   { kind: "nodes", nodes, radius_m, arrival }  from the destination's preview URL, with portals closed;
 *   { kind: "image", image }                      the destination's preview image;
 *   { kind: "color", color }                      no preview declared;
 *   { kind: "none", reason }                      no destination;
 *   { kind: "unreachable", color, reason }        the destination does not answer.
 */
export async function previewOf(portal, opts = {}) {
  if (!portal || typeof portal.destination !== "string" || !portal.destination) return { kind: "none", reason: REFUSAL.NO_DESTINATION };
  let destination;
  try { destination = parseDestination(portal.destination); } catch { return { kind: "none", reason: REFUSAL.NO_DESTINATION }; }
  let world;
  try { world = await readJson(new URL("wow/world", destination.base).href, opts); } catch (error) {
    return { kind: "unreachable", color: PREVIEW_COLOR, reason: `${REFUSAL.OFFLINE}: ${destination.base}`, status: error.status || 0 };
  }
  const declared = world && typeof world.preview === "object" && world.preview ? world.preview : null;
  if (declared && declared.url && declared.node) {
    const tree = await readJson(new URL(declared.url, destination.base).href, opts);
    // Portals inside the preview show closed: the destination's own portals, found by the nodes that
    // place them. Their destinations are never read.
    const inner = await readPortals(destination.base, opts);
    const closedIds = new Set(inner.map((p) => p.nodeId).filter((id) => id !== null));
    const graph = /wow\/spatial\/(\d+)\/node\//.exec(declared.node)?.[1] || "1";
    const shape = (n, isRoot) => ({
      id: n.id,
      url: new URL(`wow/spatial/${graph}/node/${n.id}`, destination.base).href,
      label: n.label,
      matrix: isRoot ? IDENTITY.slice() : localTransformOf(n),
      spatialAssetURI: n.spatialAssetURI || null,
      appearanceURI: n.appearanceURI || null,
      role: (n.webofworlds_extension && n.webofworlds_extension.role) || null,
      names: Array.isArray(n.names) ? n.names : [],
      extension: n.webofworlds_extension || null,
      closed: closedIds.has(Number(n.id)),
    });
    const nodes = [shape(tree, true), ...(tree.children || []).map((n) => shape(n, false))];
    const worldTransform = tree.webofworlds_extension && tree.webofworlds_extension.world_transform;
    return {
      kind: "nodes", nodes, radius_m: Number(declared.radius_m) || 0, arrival: new URL(declared.node, destination.base).href, base: destination.base,
      // where the arrival node stands in its graph, when the world says: the preview is then in the world's own frame
      world_transform: Array.isArray(worldTransform) && worldTransform.length === 16 ? worldTransform.map(Number) : null,
    };
  }
  if (declared && declared.image) return { kind: "image", image: new URL(declared.image, destination.base).href };
  return { kind: "color", color: PREVIEW_COLOR };
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// ---- Placing portals (the placement tool) ---------------------------------------------------------------
//
// A placed portal is two things in the world's Web of Worlds API: a node of its graph that places it
// (POST wow/spatial/{g}/node/{parent}), and the portal that names that node (POST wow/portal), with its
// destination and its active radius: the distance at which it wakes for a visitor and loads its preview.
// Moving it moves its node (PUT the node's localTransform); its destination and radius change with
// PUT wow/portal/{id}.

/** A node in the flat form (its parent an id), or null when it cannot be read. */
export async function readFlatNode(base, graph, nodeId, opts = {}) {
  try { return await readJson(new URL(`wow/spatial/${graph}/node/${nodeId}?nodeForm=flat`, base).href, opts); } catch { return null; }
}

/** Send a JSON body; the answer's JSON, or an error carrying the status and the server's reason. */
async function writeJson(method, url, body, opts) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (opts.onRequest) opts.onRequest(url, method);
  const r = await fetchImpl(url, { method, headers: { Accept: ACCEPT, "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch { /* no JSON */ }
  if (!r.ok) {
    const error = new Error(`${method} ${url} answered ${r.status}${json && json.error ? `: ${json.error}` : ""}${json && json.message ? ` (${json.message})` : ""}`);
    error.status = r.status;
    throw error;
  }
  return json;
}

/**
 * Whether the world at `base` offers placement: GET {base}placement answers { allowed, reason, bound_address }.
 * Placement is on only when the answer says so (a world served from 127.0.0.1). An answer that is missing,
 * unreadable or not "allowed: true" is off, so a world that does not say is read-only here.
 */
export async function readPlacementPolicy(base, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  try {
    const r = await fetchImpl(new URL("placement", base).href, { headers: { Accept: "application/json" }, cache: "no-store" });
    const json = r.ok ? await r.json() : null;
    if (json && json.allowed === true) return { allowed: true, reason: null, bound_address: json.bound_address || null };
    return { allowed: false, reason: (json && json.reason) || `${new URL("placement", base).href} did not offer placement (answered ${r.status})`, bound_address: (json && json.bound_address) || null };
  } catch (error) {
    return { allowed: false, reason: `the world's placement answer could not be read: ${error.message}`, bound_address: null };
  }
}

/**
 * Place a portal in the world at `base`: a node under `spec.parent` (the graph's root when absent) at
 * `spec.localTransform`, then the portal that names it. Returns { node, portal } as the world stored them.
 */
export async function placePortal(base, spec, opts = {}) {
  const graph = spec.graph || 1;
  const parent = spec.parent != null ? spec.parent : (await readJson(new URL(`wow/spatial/${graph}`, base).href, opts)).rootNodeID;
  const label = String(spec.label || "Portal");
  const created = await writeJson("POST", new URL(`wow/spatial/${graph}/node/${parent}`, base).href, [{ label: `${label} (portal placement)`, localTransform: spec.localTransform }], opts);
  const node = Array.isArray(created) ? created[0] : null;
  if (!node || !Number.isInteger(node.id)) throw new Error("the world did not return the placed node");
  const portal = await writeJson("POST", new URL("wow/portal", base).href, {
    node: `wow/spatial/${graph}/node/${node.id}`,
    label,
    destination: spec.destination || null,
    active_radius_m: spec.active_radius_m == null ? null : Number(spec.active_radius_m),
  }, opts);
  return { node, portal };
}

/** Move the node that places a portal: PUT its localTransform. Returns the node as stored. */
export async function moveNode(base, graph, nodeId, localTransform, opts = {}) {
  return writeJson("PUT", new URL(`wow/spatial/${graph}/node/${nodeId}`, base).href, { localTransform }, opts);
}

/** Change a placed portal's label, destination or active radius. Returns the portal as stored. */
export async function changePortal(base, id, fields, opts = {}) {
  return writeJson("PUT", new URL(`wow/portal/${id}`, base).href, fields, opts);
}

function localTransformOf(node) {
  const t = node && node.localTransform;
  return Array.isArray(t) && t.length === 16 && t.every((v) => Number.isFinite(Number(v))) ? t.map(Number) : IDENTITY.slice();
}
