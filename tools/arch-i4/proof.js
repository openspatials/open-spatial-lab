'use strict';

/*
 * Iteration 4 proof: portals and previews.   Run: npm run arch-i4-proof
 *
 *   P1, P2, P7, P8  crossing by navigation, an offline destination, placement by node, no destination  (checks-portals.js)
 *   P3-P6           the bounded preview, closed portals inside it, the image and colour, no users      (checks-preview.js)
 *   P9              the seamless crossing as an optional profile: OSL's crossing proof, reported apart  (checks-crossing.js)
 *   R1              rendering in a browser (in a browser)                                                  (checks-browser.js)
 *   W1, W2          the proposed Web of Worlds edits                                                     (checks-overlay.js)
 *
 * Headless, in Node, except R1. The worlds are lab world servers on local origins, some at a path prefix,
 * on isolated ports from 24000 up (set OSL_ARCH_I4_PORT_A to change the first): clear of the demo's ports,
 * iteration 2's proof (21000 and up), iteration 3's (22000 and up), the round trip (18971) and live
 * conformance (18991). Where a number is claimed, a plain double-precision reference (reference-placement.py)
 * agrees with the lab's runtime path. Every check also runs against planted faults, which must turn it red.
 */

const { finish, line } = require('../arch-i1/lib');

async function main() {
  line('Iteration 4 proof: portals and previews');
  const base = Number(process.env.OSL_ARCH_I4_PORT_A) || 24000;
  let used = 0;
  const ports = { next: () => base + used++ };

  await require('./checks-portals').portalChecks(ports);
  await require('./checks-preview').previewChecks(ports);
  await require('./checks-crossing').crossingChecks(ports);
  await require('./checks-browser').browserChecks(ports);
  await require('./checks-overlay').overlayChecks(ports);
  finish('arch-i4.json', 'iteration 4 proof');
  process.exit(process.exitCode || 0);
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write('\n');
  process.exit(1);
});
