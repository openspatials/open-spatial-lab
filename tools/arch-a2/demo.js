'use strict';

/*
 * Live data layers demo: both layers on one local address.   Run: npm run arch-a2-demo
 *
 * It boots the weather layer's world and the game layer's world on loopback ports, puts them and the
 * page behind one address (port 23900, or OSL_ARCH_A2_DEMO_PORT), starts the stand-in weather source
 * (one change every 2 s, a curve that crosses 0 °C), and prints the address. Ctrl-C ends it.
 */

const lab = require('./lab');

async function main() {
  const base = Number(process.env.OSL_ARCH_A2_DEMO_PORT) || 23900;
  let used = 0;
  const ports = { next: () => base + used++ };
  // The two worlds are this demo's own; node creation over HTTP is opt-in, so it is on only while they are set up.
  const saved = process.env.OSL_PLACEMENT_WRITES;
  process.env.OSL_PLACEMENT_WRITES = '1';
  let p;
  try {
    p = await lab.place(ports, { staleAfterSeconds: 5 });
  } finally {
    if (saved === undefined) delete process.env.OSL_PLACEMENT_WRITES;
    else process.env.OSL_PLACEMENT_WRITES = saved;
  }
  const source = p.startWeather({ interval_ms: Number(process.env.OSL_ARCH_A2_DEMO_INTERVAL_MS) || 2000 });
  process.stdout.write('A2 live data layers: open ' + p.pageUrl + '\n');
  process.stdout.write('  weather layer: ' + p.weatherPoint + '\n');
  process.stdout.write('  game layer:    ' + p.gamePoint + '\n');
  process.stdout.write('Ctrl-C ends the demo.\n');
  const end = async () => { source.stop(); await p.close(); process.exit(0); };
  process.on('SIGINT', end);
  process.on('SIGTERM', end);
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write('\n');
  process.exit(1);
});
