'use strict';

const { createServer } = require('../runtime/world-server/src/server.js');
const { makeConfig } = require('../runtime/world-server/src/config.js');

const PORTS = Object.freeze({
  a: Number(process.env.BACKEND_A_PORT) || 18151,
  b: Number(process.env.BACKEND_B_PORT) || 18152,
  lobby: Number(process.env.BACKEND_LOBBY_PORT) || 18153,
  airport: Number(process.env.BACKEND_AIRPORT_PORT) || 18154,
});

function startWorld(role, portByLocation) {
  const base = makeConfig(role);
  const portals = base.portals.map((portal) => {
    const targetPort = portByLocation[portal.target_location_id];
    return targetPort ? { ...portal, target_base_url: `http://127.0.0.1:${targetPort}` } : { ...portal };
  });
  const built = createServer(role, { ...base, http_port: PORTS[role], portals });
  return new Promise((resolve, reject) => {
    const onError = (error) => built.closeAll().finally(() => reject(error));
    built.server.once('error', onError);
    built.server.listen(PORTS[role], '127.0.0.1', () => {
      built.server.removeListener('error', onError);
      console.log(`[world:${role}] listening on http://127.0.0.1:${PORTS[role]}`);
      resolve(built);
    });
  });
}

async function main() {
  if ((process.argv[2] || 'serve-backends') !== 'serve-backends') {
    throw new Error('usage: node src/orchestrator.js serve-backends');
  }
  const portByLocation = {
    'location-a': PORTS.a,
    'location-b': PORTS.b,
    'location-lobby': PORTS.lobby,
    'location-airport': PORTS.airport,
  };
  const worlds = [];
  for (const role of ['a', 'b', 'lobby', 'airport']) worlds.push(await startWorld(role, portByLocation));

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await Promise.allSettled(worlds.map((world) => world.closeAll()));
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log('[orchestrator] Location A, Location B, lobby, and Denver Skyport are ready.');
}

main().catch((error) => {
  console.error(`Open Spatial Lab world servers failed: ${error.message}`);
  process.exit(1);
});
