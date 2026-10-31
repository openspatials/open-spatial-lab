/*
 * The browser's one list of worlds. It comes from the frontend's GET /worlds.json, which reads the worlds
 * configuration (worlds.json, or the file named by OSL_WORLDS). Everything in web/ that needs to know which worlds
 * exist, what they are called or which port they use reads this list, so a world added to that file appears with no
 * edit here. See ADD-A-WORLD-CHECKLIST.md.
 *
 * A module check that imports these browser modules under Node reads the same configuration file directly.
 */

import { withBase } from "./base-path.mjs";

const RUNS_IN_NODE = typeof process !== "undefined" && !!process.versions?.node;

function say(message) {
  if (typeof document === "undefined" || !document.body) return;
  document.body.setAttribute("data-worlds-list", "error");
  const note = document.createElement("div");
  note.setAttribute("role", "alert");
  note.textContent = message;
  Object.assign(note.style, {
    position: "fixed", left: "16px", right: "16px", top: "16px", zIndex: "99999", padding: "12px 16px",
    borderRadius: "8px", background: "#3a1414", color: "#ffe9e9", font: "14px/1.4 system-ui, sans-serif",
  });
  document.body.append(note);
}

async function readWorldList() {
  if (RUNS_IN_NODE) {
    const { createRequire } = await import("node:module");
    const { loadWorlds, publicWorlds } = createRequire(import.meta.url)("../src/worlds-config.js");
    return publicWorlds(loadWorlds());
  }
  const url = withBase("/worlds.json");
  let response;
  try {
    response = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
  } catch (error) {
    say(`The lab could not read its list of worlds at ${url}: ${error.message}. Check that the lab is running, then reload.`);
    throw error;
  }
  if (!response.ok) {
    const message = `The lab could not read its list of worlds at ${url} (it answered ${response.status}). This frontend may be older than this page: restart the lab, then reload.`;
    say(message);
    throw new Error(message);
  }
  return response.json();
}

const list = await readWorldList();

/** Every listed world, in the file's order: { key, name, port, address, built_in, location_id, world_id, session_id, portal_id, portal_ring }. */
export const WORLDS = Object.freeze(list.worlds.map((world) => Object.freeze({ ...world })));

/** Portals that only the X3D paths show (`x3d_portals` in the worlds file). Nothing on the three.js path reads this. */
export const X3D_PORTALS = Object.freeze((list.x3d_portals || []).map((portal) => Object.freeze({ ...portal })));

const DEFAULT_RING = Object.freeze({ color: 0x66e0ff, fill: 0x2bd4ff });
const hexNumber = (hex) => parseInt(String(hex).slice(1), 16);

/** The colours of a portal ring that belongs to the world at `locationId`: its `portal_ring` in the list, else the default. */
export function ringColorsOf(locationId, worlds = WORLDS) {
  const ring = (worlds.find((world) => world.location_id === locationId) || {}).portal_ring;
  return ring ? { color: hexNumber(ring.color), fill: hexNumber(ring.fill) } : DEFAULT_RING;
}

/** The live adapter's endpoint table, one entry per listed world. */
export function worldEndpoints(worlds = WORLDS) {
  return Object.freeze(Object.fromEntries(worlds.map((world) => [world.key, {
    endpoint_key: world.key,
    proxy_base: withBase(`/api/${world.key}`),
    backend_base_url: world.address.replace(/\/$/, ""),
    location_id: world.location_id,
    world_id: world.world_id,
    session_id: world.session_id,
    portal_id: world.portal_id,
  }])));
}

export default { WORLDS, worldEndpoints, ringColorsOf };
