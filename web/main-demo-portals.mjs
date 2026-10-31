/*
 * Standard portals in the main demo. Everything here comes from the worlds' Web of Worlds data:
 *
 *   - a portal is its resource (GET {base}wow/portal/{id}: `destination`, `node`), and it stands where its placing
 *     node says. The browser holds no copy of any portal.
 *   - a portal's see-through view shows only what its destination's World resource declares (web/wow-portal.mjs,
 *     previewOf): the preview URL's nodes within its radius, else its image, else a plain colour.
 *   - a crossing first checks that the destination answers (R4.2), and arrives at the node `#join=node.{n}` names.
 *
 * Pure: no DOM and no three.js; fetch is passed in.
 */

import { parseDestination, previewOf, crossPortal, arrivalAt, REFUSAL, PREVIEW_COLOR } from "./wow-portal.mjs";
import { multiply } from "./wow-inclusion.mjs";
import { portalFrameForLocation, normalizeVec3, PORTAL_FRAME_CENTER_Y } from "./live-adapter-portal-geometry.mjs";
import { WORLDS } from "./worlds-list.mjs";

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const NODE_REF = /wow\/spatial\/(\d+)\/node\/(\d+)$/;
// A crossing lands this far in front of the plane it comes through (the trigger depth plus clearance): the plane is
// what the see-through window and the camera are glued to.
export const ARRIVAL_STAND_OFF_M = 1.05;
const LOCAL_MATRIX_LENGTH = 16;

function localMatrix(node) {
  const t = node && node.localTransform;
  return Array.isArray(t) && t.length === LOCAL_MATRIX_LENGTH ? t.map(Number) : IDENTITY.slice();
}

/** Where a column-major matrix stands: its position, and its +Z on the floor. */
export function poseOfMatrix(m) {
  const forward = normalizeVec3([m[8], 0, m[10]], [0, 0, 1]);
  return { position: [m[12], m[13], m[14]], forward, yaw: Math.atan2(forward[0], forward[2]) };
}

/** The listed world (web/worlds-list.mjs) at a world's base URL, or null. */
export function listedWorldAt(base, worlds = WORLDS) {
  const wanted = String(base || "").replace(/\/*$/, "/");
  return worlds.find((world) => String(world.address).replace(/\/*$/, "/") === wanted) || null;
}

/** A destination URL read: { entry, base, join, world }, or null when there is none or it is not a URL. */
export function destinationOf(destination, worlds = WORLDS) {
  if (typeof destination !== "string" || !destination) return null;
  try {
    const parsed = parseDestination(destination);
    return { ...parsed, world: listedWorldAt(parsed.base, worlds) };
  } catch {
    return null;
  }
}

/**
 * The portals of a world, read through `getJson` at `base`: each resource with `osl_placement`, the pose of the node
 * that places it, composed from the graph's root down. A portal with no readable node has no place, so it is left out
 * and reported through `onSkip`. Own-world reads only: the graph is the world the visitor is in.
 */
export async function readPortalResources({ getJson, base, wowWorld, onSkip }) {
  const count = Number(wowWorld && wowWorld.portals && wowWorld.portals.portal_count) || 0;
  const graphs = new Map();
  const composed = async (graph) => {
    if (graphs.has(graph)) return graphs.get(graph);
    const placements = new Map();
    const spatial = await getJson(`${base}/wow/spatial/${graph}`);
    const tree = await getJson(`${base}/wow/spatial/${graph}/node/${spatial.rootNodeID}`);
    const walk = (node, parent) => {
      if (!node || typeof node !== "object") return;
      const matrix = multiply(parent, localMatrix(node));
      placements.set(Number(node.id), matrix);
      for (const child of node.children || []) walk(child, matrix);
    };
    walk(tree, IDENTITY);
    graphs.set(graph, placements);
    return placements;
  };
  const out = [];
  for (let id = 1; id <= count; id += 1) {
    let resource;
    try {
      resource = await getJson(`${base}/wow/portal/${id}`);
    } catch {
      continue; // a single unreadable portal must not sink the world load
    }
    if (!resource) continue;
    const ref = NODE_REF.exec(String(resource.node || ""));
    const placements = ref ? await composed(Number(ref[1])).catch(() => null) : null;
    const matrix = placements ? placements.get(Number(ref[2])) : null;
    if (!matrix) {
      if (onSkip) onSkip(resource, ref ? "its node could not be read" : "it names no node");
      continue;
    }
    out.push({ ...resource, osl_placement: { node_id: Number(ref[2]), graph: Number(ref[1]), ...poseOfMatrix(matrix) } });
  }
  return out;
}

/**
 * What decides whether a visitor already here must be shown the portals again: each portal's id, where it leads, and
 * the pose of the node that places it (to the millimetre), its label and its active radius.
 */
export function portalSignature(resources) {
  const mm = (values) => values.map((value) => Math.round(Number(value) * 1000));
  return JSON.stringify((resources || []).map((resource) => {
    const placement = resource.osl_placement;
    return [resource.id, resource.destination || null, resource.label || null, resource.active_radius_m || null,
      placement ? [placement.node_id, mm(placement.position), mm(placement.forward)] : null];
  }));
}

/**
 * The frame a portal's window and its crossing are glued to: a plane ARRIVAL_STAND_OFF_M behind the place a visitor
 * arrives at, facing the way they arrive. For a portal's own arrival node, that plane is the portal.
 */
export function arrivalFrame({ position, forward, locationId = null, portalId = null, linkedPortalId = null }) {
  const f = normalizeVec3(forward, [0, 0, 1]);
  const frame = portalFrameForLocation({
    portalId,
    locationId,
    triggerPosition: [position[0] - f[0] * ARRIVAL_STAND_OFF_M, 0, position[2] - f[2] * ARRIVAL_STAND_OFF_M],
    forward: f,
    targetLocationId: null,
  });
  return { ...frame, position: [frame.position[0], PORTAL_FRAME_CENTER_Y + Number(position[1] || 0), frame.position[2]], target_world_id: null, target_base_url: null, linked_target_portal_id: linkedPortalId, pose_source: "wow_arrival_node" };
}

/** Nothing clips a flat preview (an image or a colour): it fills the opening. */
const FLAT_AWARENESS = Object.freeze({
  valid: true, flat: true, center: [0, 0, 0], plane_point: [0, 0, -1e6], forward: [0, 0, 1], radius_m: 1e6,
  radius_source: "flat_preview", half_space: "target_frame_forward", plane_setback_m: 0,
});

/**
 * What a portal shows, as far as its destination allows, ready for the window to draw (web/main-demo-preview.mjs,
 * composeBoundedPreview). Reads only the destination's World resource, its preview URL and its portal resources
 * (to close the portals inside). Reads no other node of the destination, and creates no user there.
 */
export async function resolveBoundedPreview(portalEntry, io = {}) {
  const resource = (portalEntry && portalEntry.wow_resource) || { destination: portalEntry && portalEntry.destination };
  const destination = destinationOf(resource.destination, io.worlds);
  const preview = await previewOf(resource, { fetch: io.fetch, onRequest: io.onRequest }).catch((error) => ({
    kind: "unreachable", color: PREVIEW_COLOR, reason: `${REFUSAL.OFFLINE}: ${String((error && error.message) || error)}`,
  }));
  const content = {
    kind: "wow_bounded_preview",
    preview_kind: preview.kind,
    reason: preview.reason || null,
    location_id: portalEntry ? portalEntry.target_location_id || null : null,
    world_id: portalEntry ? portalEntry.target_world_id || null : null,
    destination: resource.destination || null,
    base: destination ? destination.base : null,
    listed: !!(destination && destination.world),
    revision: `${resource.destination || "nowhere"}:${preview.kind}:${preview.nodes ? preview.nodes.length : 0}`,
    window_frame: arrivalFrame({ position: [0, 0, 0], forward: [0, 0, 1], locationId: portalEntry ? portalEntry.target_location_id : null }),
    awareness: FLAT_AWARENESS,
    world_frame_known: false,
  };
  if (preview.kind === "image") return { ...content, image: preview.image };
  if (preview.kind !== "nodes") return { ...content, color: preview.color || null };
  const world = preview.world_transform || IDENTITY.slice();
  const join = destination ? destination.join : null;
  const joined = join === null ? null : preview.nodes.find((node) => Number(node.id) === join);
  // Without an arrival inside what the preview shows, the visitor sees the place the world's preview is seen from.
  const arrival = poseOfMatrix(multiply(world, joined ? joined.matrix : IDENTITY));
  const frame = arrivalFrame({ ...arrival, locationId: content.location_id });
  return {
    ...content,
    nodes: preview.nodes,
    radius_m: preview.radius_m,
    arrival: preview.arrival,
    world_transform: world,
    closed_count: preview.nodes.filter((node) => node.closed).length,
    join_in_preview: !!joined,
    window_frame: frame,
    world_frame_known: !!preview.world_transform,
    awareness: {
      valid: true,
      center: [world[12], world[13], world[14]],
      plane_point: frame.position.slice(0, 3),
      forward: frame.forward.slice(0, 3),
      radius_m: preview.radius_m,
      radius_source: "World.preview.radius_m",
      half_space: "target_frame_forward",
      plane_setback_m: 0.1,
    },
  };
}

/**
 * The check before leaving (R4.2, R4.3). Answers one of:
 *   { ok: false, reason, kind }      refused: no destination, offline, or the arrival node is not there;
 *   { ok: true, mode: "navigate", url }             a plain web navigation (a world this lab does not list);
 *   { ok: true, mode: "seamless", arrival, frame }  the seamless crossing, with where it lands.
 */
export async function checkCrossing(portal, io = {}) {
  const resource = (portal && portal.wow_resource) || { destination: portal && portal.destination };
  const asleep = io.asleepReason ? io.asleepReason(portal) : null;
  if (asleep) return { ok: false, kind: "asleep", reason: asleep };
  const checked = await crossPortal(resource, { fetch: io.fetch, timeoutMs: io.timeoutMs || 3000 });
  if (!checked.crossed) {
    const kind = !resource.destination ? "no_destination" : /not found/.test(checked.reason) ? "no_arrival" : "offline";
    return { ok: false, kind, reason: checked.reason };
  }
  const destination = destinationOf(resource.destination, io.worlds);
  if (!destination || !destination.world || io.plain) return { ok: true, mode: "navigate", url: plainNavigationUrl(resource.destination, io) };
  let arrival = checked.arrival;
  if (!arrival) arrival = await defaultArrival(destination.base, io);
  if (!arrival) return { ok: false, kind: "no_arrival", reason: `${REFUSAL.NO_ARRIVAL}: ${destination.base} declares no place to arrive` };
  const pose = arrival.matrix ? poseOfMatrix(arrival.matrix) : arrival;
  return {
    ok: true,
    mode: "seamless",
    arrival: { position: pose.position.slice(0, 3), forward: pose.forward.slice(0, 3), yaw: pose.yaw, node: arrival.node || null },
    frame: arrivalFrame({ ...pose, locationId: portal ? portal.target_location_id : null, portalId: arrival.node || null, linkedPortalId: portal && portal.frame ? portal.frame.portal_id : null }),
  };
}

/** A destination with no `#join`: the place its World resource says it is previewed from, else its entry spawn. */
async function defaultArrival(base, io) {
  const fetchImpl = io.fetch || globalThis.fetch;
  const read = async (path) => {
    const r = await fetchImpl(new URL(path, base).href, { headers: { Accept: "application/wow+json, application/json;q=0.9" }, cache: "no-store" });
    return r.ok ? r.json() : null;
  };
  const world = await read("wow/world").catch(() => null);
  const ref = NODE_REF.exec(String((world && world.preview && world.preview.node) || ""));
  if (ref) {
    const arrival = await arrivalAt(base, Number(ref[2]), { fetch: fetchImpl }).catch(() => null);
    if (arrival) return arrival;
  }
  const location = await read("wow/location").catch(() => null);
  const spawn = location && location.entry_spawn;
  if (!spawn || !Array.isArray(spawn.position)) return null;
  const yaw = Number(spawn.rotation_y) || 0;
  return { position: spawn.position, forward: [Math.sin(yaw), 0, Math.cos(yaw)], yaw, node: null };
}

/**
 * The page a browser opens to cross by plain navigation. A destination that is a listed world opens at that world's
 * own page on this frontend, `/w/{key}/`, with its `#join`, and this page's query; any other is opened as it is.
 */
export function plainNavigationUrl(destination, io = {}) {
  const parsed = destinationOf(destination, io.worlds);
  if (!parsed || !parsed.world || !io.pageUrl) return destination;
  const page = new URL(io.pageUrl);
  const target = new URL(`w/${parsed.world.key}/`, io.frontBase || page.origin + "/");
  const search = new URLSearchParams(page.search);
  for (const name of ["active", "place", "role"]) search.delete(name);
  target.search = search.toString();
  target.hash = new URL(parsed.entry).hash;
  return target.href;
}

/** A sentence for a person, from a refusal. `name` is what the portal or its destination is called. */
export function refusalSentence(refusal, name) {
  if (refusal.kind === "no_destination") return `No destination: this portal leads nowhere. You are still here.`;
  if (refusal.kind === "asleep") return `${refusal.reason.charAt(0).toUpperCase()}${refusal.reason.slice(1)}.`;
  if (refusal.kind === "no_arrival") return `${name || "The destination"} has no such place to arrive at (${refusal.reason}). You are still here.`;
  const how = /no connection/.test(refusal.reason) ? "no connection" : (/\(([^)]*)\)/.exec(refusal.reason) || [])[1] || "no answer";
  return `Destination offline: ${name || "the destination"} did not answer (${how}). You are still here.`;
}
