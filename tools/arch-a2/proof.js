'use strict';

/*
 * Roadmap A2 proof: live data layers on one place, one reading the other.   Run: npm run arch-a2-proof
 *
 *   L1  the reading: the game layer reads the weather value through the O6/O6b mirror rule  (checks-layers.js)
 *   L3  the description: each layer validates against iteration 3's JSON-LD context        (checks-layers.js)
 *   L2  the age: each value shows its age; a stale value is marked stale (in a browser)     (checks-browser.js)
 *   L4  the reaction follows a weather change within one update, with screenshots (browser) (checks-browser.js)
 *
 * The weather layer's data come from a stand-in source on 127.0.0.1 (runtime/world-server/src/
 * live-data-weather.js); nothing outside the machine is read. Ports from 23000 up (set
 * OSL_ARCH_A2_PORT to change the first): clear of the demo's ports and of iterations 1 to 5's proofs.
 * Every check also runs against planted faults, which must turn it red. Screenshots go to
 * diagnostics/arch-a2/screens/, the results to diagnostics/arch-a2.json.
 */

const { finish, line } = require('../arch-i1/lib');

async function main() {
  line('A2 proof: live data layers on one place');
  const base = Number(process.env.OSL_ARCH_A2_PORT) || 23000;
  let used = 0;
  const ports = { next: () => base + used++ };

  await require('./checks-layers').layerChecks(ports);
  await require('./checks-browser').browserChecks(ports);
  finish('arch-a2.json', 'A2 proof');
  process.exit(process.exitCode || 0);
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write('\n');
  process.exit(1);
});
