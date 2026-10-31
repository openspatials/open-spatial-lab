'use strict';

const fs = require('fs');
const path = require('path');
const { createServer } = require('../runtime/world-server/src/server.js');
const { makeConfig, NODES } = require('../runtime/world-server/src/config.js');
const { loadWorlds, publicAddress } = require('./worlds-config.js');
const { bindHost } = require('../runtime/world-server/src/local-only.js');
const { linkPortalArrivals } = require('../runtime/world-server/src/portal-standard.js');

// The worlds come from the configuration file (worlds.json, or the file named by OSL_WORLDS): one world
// server per listed world, on its port. Adding a world is an edit to that file, not to this one.
const CONFIG = loadWorlds({ strict: true });

// A live public lab sets OSL_PUBLIC_ORIGIN: each world then says it lives at {origin}/w/{key}. Unset, nothing changes.
const PUBLIC_ORIGIN = (process.env.OSL_PUBLIC_ORIGIN || '').replace(/\/$/, '');
// A plain room world (one with no built-in template) is drawn in this colour unless its entry names one.
const PLAIN_ROOM_COLOR = '#c86bff';
const ZERO_ANGLES = { yaw: 0, pitch: 0, roll: 0 };

/** The world-server configuration of one listed world. */
function worldConfig(world, addressByLocation) {
  const builtIn = world.template !== null && world.template === world.key;
  const base = builtIn
    ? makeConfig(world.key)
    // A new world runs a plain room (Location B's room content) under its own ids, with no configured
    // portals: portals to and from it are placed with the placement tool.
    : makeConfig(world.template || 'b', {
      location_id: world.location_id || 'location-' + world.key,
      world_id: 'world-' + world.key,
      session_id: 'local-session-' + world.key,
      title: world.name,
      node_role: 'world',
      portals: [],
    });
  const portals = base.portals.map((portal) => {
    const address = addressByLocation[portal.target_location_id];
    return address ? { ...portal, target_base_url: address.replace(/\/$/, '') } : { ...portal };
  });
  const roomColor = world.room || (builtIn ? null : PLAIN_ROOM_COLOR);
  // What a portal leading into this world shows (World.preview, iteration 4): a world with a room is previewed
  // from its room view (the room's middle, facing the walls); another from its root.
  const previewRadius = world.preview_radius_m || (roomColor ? 10 : null);
  const preview = previewRadius ? { ...(roomColor ? { node_label: 'Room view' } : { node_id: 0 }), radius_m: previewRadius } : undefined;
  const room = roomColor ? { color: roomColor, size_m: 12, wall_height_m: 5 } : undefined;
  const spatial_anchors = { graphs: [ { id: 1, geoPose: { position: world.anchor, angles: ZERO_ANGLES } } ] };
  return {
    ...base, http_port: world.port, portals, preview, room, spatial_anchors,
    public_base_url: PUBLIC_ORIGIN ? `${PUBLIC_ORIGIN}/w/${world.key}` : undefined,
  };
}

function startWorld(world, addressByLocation) {
  const cfg = worldConfig(world, addressByLocation);
  const built = createServer(world.template === world.key ? world.key : (world.template || 'b'), cfg);
  return new Promise((resolve, reject) => {
    const onError = (error) => built.closeAll().finally(() => reject(new Error(`${world.name} (${world.key}) could not listen on port ${world.port}: ${error.message}`)));
    built.server.once('error', onError);
    // The address comes from OSL_BIND_HOST (default 127.0.0.1). Placement is on only when it is 127.0.0.1
    // AND OSL_PLACEMENT_WRITES=1 is in the environment (runtime/world-server/src/local-only.js): otherwise placed
    // portals are served read-only. This file never sets that opt-in; the caller's environment does.
    const host = bindHost();
    built.server.listen(world.port, host, () => {
      built.server.removeListener('error', onError);
      console.log(`[world:${world.key}] ${world.name} listening on http://${host}:${world.port}`);
      resolve(built);
    });
  });
}

/** Where the launch records the worlds it started, for tools/check-worlds.mjs. */
function writeLaunchRecord(worlds) {
  const dir = process.env.OSL_RUN_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    config: CONFIG.file,
    started_at: new Date().toISOString(),
    pid: process.pid,
    frontend: CONFIG.frontend,
    worlds: worlds.map((w) => ({ key: w.key, name: w.name, port: w.port, address: w.address })),
  };
  fs.writeFileSync(path.join(dir, 'launched-worlds.json'), JSON.stringify(record, null, 2) + '\n');
}

/** Start these worlds and link their portals. A configured portal names its destination by location; the address comes from the list. */
async function startWorlds(worlds) {
  const addressByLocation = {};
  for (const world of worlds) {
    const location = world.template === world.key ? NODES[world.key].location_id : world.location_id;
    addressByLocation[location] = publicAddress(world);
  }
  const servers = [];
  for (const world of worlds) servers.push(await startWorld(world, addressByLocation));
  // A configured portal's destination names where it arrives: the arrival node of its counterpart.
  linkPortalArrivals(servers.map((server) => server.runtime));
  return servers;
}

/** For browser scripts: this list's worlds in this process, with `backendPorts` ({ key: port }) in place of their ports. */
async function startBackends({ backendPorts = {} } = {}) {
  const worlds = CONFIG.worlds.map((world) => {
    const port = backendPorts[world.key];
    return port ? { ...world, port, address: `http://127.0.0.1:${port}/` } : world;
  });
  const servers = await startWorlds(worlds);
  return { stop: async () => { await Promise.allSettled(servers.map((server) => server.closeAll())); } };
}

/** For browser scripts: refuse the ports of the lab's own worlds.json, so a script never takes over a running lab. */
function assertNotLiveDemoPorts(ports) {
  const live = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'worlds.json'), 'utf8'));
  const taken = new Set([live.frontend && live.frontend.port, ...live.worlds.map((world) => world.port)]);
  const clash = Object.entries(ports).filter(([, port]) => taken.has(port));
  if (clash.length) throw new Error(`these ports belong to the lab's own worlds.json: ${clash.map(([key, port]) => `${key} ${port}`).join(', ')}`);
}

async function main() {
  if ((process.argv[2] || 'serve-backends') !== 'serve-backends')
    throw new Error('usage: node src/orchestrator.js serve-backends');
  const servers = await startWorlds(CONFIG.worlds);
  writeLaunchRecord(CONFIG.worlds);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.allSettled(servers.map((server) => server.closeAll()));
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(`[orchestrator] ${CONFIG.worlds.map((w) => w.name).join(', ')} are ready (from ${CONFIG.file}).`);
}

module.exports = { worldConfig, startBackends, assertNotLiveDemoPorts };

if (require.main === module) {
  main().catch((error) => {
    console.error(`Open Spatial Lab world servers failed: ${error.message}`);
    process.exit(1);
  });
}
