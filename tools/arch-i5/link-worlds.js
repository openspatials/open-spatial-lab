'use strict';

/*
 * The ID1 after view, served for a person to open: the lab's frontend and the two worlds of the crossing.
 *
 *   node tools/arch-i5/link-worlds.js <frontend-port> <world-a-port> <world-b-port> [out.json]
 *
 * World A asks only for the display name (optional) and holds a portal to World B. World B asks for the
 * avatar and the preferences (required) and the display name (optional). Open the printed link: the
 * visitor enters A, crosses the portal (a click on it), and enters B with the avatar and the preferred
 * height B asked for. A panel shows what was asked, what was sent and the outcome B recorded.
 * Runs until stopped. Each world logs every request it receives to stdout (method, URL, Referer).
 */

const fs = require('fs');
const path = require('path');
const { ROOT } = require('../arch-i1/lib');
const lab = require('./lab');

async function main() {
  const [frontPort, aPort, bPort, out] = process.argv.slice(2).map((v, i) => (i < 3 ? Number(v) : v));
  if (!frontPort || !aPort || !bPort) throw new Error('usage: link-worlds.js <frontend-port> <world-a-port> <world-b-port> [out.json]');
  const frontend = await require(path.join(ROOT, 'src', 'serve.js')).createFrontendServer(frontPort, { backendPorts: { a: 1, b: 1, lobby: 1, airport: 1 } });
  const FRONT = 'http://127.0.0.1:' + frontPort;
  // Building the worlds writes nodes and portals: those writes are opt-in (runtime/world-server/src/local-only.js), so
  // they are turned on only while the worlds are built, and put back as they were.
  const saved = process.env.OSL_PLACEMENT_WRITES;
  process.env.OSL_PLACEMENT_WRITES = '1';
  let built;
  try { built = await lab.crossingWorlds({ frontend: FRONT, ports: { a: aPort, b: bPort } }); } finally {
    if (saved === undefined) delete process.env.OSL_PLACEMENT_WRITES;
    else process.env.OSL_PLACEMENT_WRITES = saved;
  }
  const { A, B, arrival, player } = built;
  for (const [name, world] of [['A', A], ['B', B]]) {
    world.built.server.on('request', (req) => {
      process.stdout.write(`${new Date().toISOString()} world ${name} ${req.method} ${req.url} referer=${req.headers.referer || '-'}\n`);
    });
  }
  const info = {
    link: player(A),
    world_b_direct: player(B, arrival),
    world_a: A.base,
    world_b: B.base,
    frontend: FRONT,
    started_at: new Date().toISOString(),
    pid: process.pid,
  };
  if (out) fs.writeFileSync(out, JSON.stringify(info, null, 2) + '\n');
  process.stdout.write('ready ' + JSON.stringify(info) + '\n');
  const stop = () => { frontend.close(); A.close(); B.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error) => { process.stderr.write((error && error.stack) || String(error)); process.stderr.write('\n'); process.exit(1); });
