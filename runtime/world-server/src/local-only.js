'use strict';

/*
 * The local-only switch for placement.
 *
 * Placement mode and the routes it writes through need TWO things, on the server that answers:
 *   1. it is bound to 127.0.0.1 (below), and
 *   2. the explicit opt-in setting OSL_PLACEMENT_WRITES=1 is in its environment. Off by default.
 * The second exists because a public deployment can put a public proxy in front of a loopback listener
 * (a reverse proxy in front of a lab bound to 127.0.0.1, or a container that keeps the world backends on loopback
 * behind a public frontend). There the bind test alone reads "local" and would open the writes to the public.
 * No deploy file may set the opt-in, and tools/placement/check-local-only.mjs fails if one does. Only the exact
 * value "1" counts ("true", "yes", "0" and the empty value do not). It is read from the environment each
 * time a request arrives, as the bound address is.
 *
 * Bound address, first condition: the server that answers is bound to 127.0.0.1. A server bound to any other address (0.0.0.0, a LAN or public address, ::) refuses those
 * routes with a reason, and a player hides placement mode there, so a public lab shows placed portals
 * read-only. Iteration 6's world-issued tokens replace this switch later.
 *
 * How "runs on 127.0.0.1" is judged: by the address the operating system says the listening socket is
 * bound to (`server.address().address`), read when each request arrives. It is not the Host header, not
 * `X-Forwarded-For`, not the peer's address, and not the string a launch script was given: nothing a
 * caller sends can change it. A server that is not listening has no bound address and is not local.
 * Only the exact IPv4 address 127.0.0.1 counts; ::1 and 'localhost' bound to ::1 do not.
 *
 * The write routes it guards (the ones the placement tool writes through):
 *   POST /wow/portal, PUT /wow/portal/{id}              add and change a placed portal
 *   POST, PUT, DELETE /wow/spatial/{graph}/node/{node}  create, move and delete a node of the graph
 * Every other method than GET, HEAD and OPTIONS on those two route families is refused as well, so a
 * route added there later is off by default. The crossing intents (POST /wow/portal/exit and
 * /wow/portal/arrival) are not placement and stay as they are.
 * Two older routes change or erase portals too, so they are guarded the same way:
 *   POST /demo/portal/move   the legacy drag of a configured portal's trigger position
 *   POST /reset              puts the spatial graph back to its seed, which erases every placed portal,
 *                            and puts the configured portals back where they started
 * Not guarded, because they are not portal or graph writes: POST /demo/scene-objects/move (moves a demo
 * scene object), POST /demo/republish-rate, the presence routes and POST /movement.
 */

const LOCAL_ADDRESS = '127.0.0.1';
const READ_METHODS = new Set([ 'GET', 'HEAD', 'OPTIONS' ]);
const OPT_IN_NAME = 'OSL_PLACEMENT_WRITES';

/** True only when the opt-in setting is exactly "1" (surrounding spaces ignored). Off when unset. */
function placementWritesEnabled(env = process.env) {
  return String((env && env[OPT_IN_NAME]) || '').trim() === '1';
}

/** The address a launch binds its servers to: OSL_BIND_HOST, else 127.0.0.1. */
function bindHost(env = process.env) {
  const value = String(env.OSL_BIND_HOST || '').trim();
  return value || LOCAL_ADDRESS;
}

/** What the listening socket is bound to, or null when it is not listening. */
function boundAddress(server) {
  let info = null;
  try { info = server && typeof server.address === 'function' ? server.address() : null; } catch (e) { info = null; }
  return info && typeof info === 'object' && typeof info.address === 'string' ? info.address : null;
}

/**
 * { allowed, bound_local, opt_in, bound_address, reason }: whether this server may offer placement.
 * `bound_local` is the bind condition, `opt_in` the OSL_PLACEMENT_WRITES=1 condition; `allowed` is both.
 * `reason` is null when allowed, else says which condition (or both) is missing.
 */
function placementPolicy(server, env = process.env) {
  const address = boundAddress(server);
  const boundLocal = address === LOCAL_ADDRESS;
  const optIn = placementWritesEnabled(env);
  if (boundLocal && optIn) return { allowed: true, bound_local: true, opt_in: true, bound_address: address, reason: null };
  const missing = [];
  if (!boundLocal) {
    missing.push(address
      ? `it listens on ${address}, not ${LOCAL_ADDRESS}`
      : `it has no bound address, so it is not served from ${LOCAL_ADDRESS}`);
  }
  if (!optIn) {
    missing.push(`${OPT_IN_NAME}=1 is not set on this server (placement writes are opt-in, off by default${boundLocal ? `, even on ${LOCAL_ADDRESS}` : ''})`);
  }
  return {
    allowed: false,
    bound_local: boundLocal,
    opt_in: optIn,
    bound_address: address,
    reason: `Placing and moving portals is off on this server: ${missing.join('; and ')}. `
      + `Placement runs only on a lab served from ${LOCAL_ADDRESS} that is started with ${OPT_IN_NAME}=1; here, placed portals are shown read-only.`,
  };
}

/** True when the request is a write to a route the placement tool writes through. */
function isPlacementWrite(method, pathname) {
  if (READ_METHODS.has(String(method || '').toUpperCase())) return false;
  const path = String(pathname || '').replace(/\/+$/, '');
  if (path === '/wow/portal' || /^\/wow\/portal\/\d+$/.test(path)) return true;
  if (path === '/demo/portal/move' || path === '/reset') return true;
  return path === '/wow/spatial' || path.startsWith('/wow/spatial/');
}

/** The body of the refusal answer (HTTP 403). */
function refusalBody(policy, method, pathname) {
  return { ok: false, error: 'placement_local_only', message: policy.reason, bound_address: policy.bound_address, bound_local: policy.bound_local, opt_in: policy.opt_in, method, path: pathname };
}

module.exports = { LOCAL_ADDRESS, OPT_IN_NAME, placementWritesEnabled, bindHost, boundAddress, placementPolicy, isPlacementWrite, refusalBody };
