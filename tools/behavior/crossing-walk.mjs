// What the crossing checks share: the limits they measure against and the walk through a portal.
import { expect, walkThrough } from "./kit.mjs";

export const AT_THE_NODE_M = 0.05;
export const FACING_RAD = 0.35;
export const CROSS_LIMIT_MS = 90000; // at two frames a second, 1.4 m takes 30 s

export const lobbyUrl = (lab) => `${lab.front}/index.html?role=player&intro=bypass`;
export const yawOf = (forward) => Math.atan2(forward[0], forward[2]);

export function portalNamed(portals, label) {
  const found = portals.find((p) => p.resource.label === label);
  expect(found, `no portal named ${label}: ${portals.map((p) => p.resource.label).join(", ")}`);
  return found;
}

/** Walk through the middle of a portal, from 1.4 m in front of it. */
export async function walkInto(page, portal, location) {
  const [x, , z] = portal.pose.position;
  const [fx, , fz] = portal.pose.forward;
  const seen = await walkThrough(page, { from: [x + fx * 1.4, z + fz * 1.4], yaw: Math.atan2(-fx, -fz), expect: location, timeoutMs: CROSS_LIMIT_MS });
  expect(seen.location_id === location, `the walk did not cross: still in ${seen.location_id} at ${seen.position} (timed out after ${CROSS_LIMIT_MS / 1000} s)`);
  return seen;
}
