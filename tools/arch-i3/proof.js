'use strict';

/*
 * Iteration 3 proof: live state and observation with no session.   Run: npm run arch-i3-proof
 *
 *   O1-O3    changes with nobody present, observers that are not users, conditional reads  (checks-live.js)
 *   O4-O5    resume, resync across a restart, deletion                                     (checks-resume.js)
 *   O6-O10   mirroring, no loops, live inclusion, stream budget, environment by type       (checks-coupling.js)
 *   O11      stream authentication with fixture tokens                                      (checks-auth.js)
 *   O8       the dashboard in a browser (load-gated)                                        (checks-browser.js)
 *   W1, W2   the proposed Web of Worlds edits                                               (checks-overlay.js)
 *
 * Headless, in Node, except O8. World A and world B are lab world servers on two local origins, with B
 * at the path prefix /w/b/, on isolated ports from 22000 up (set OSL_ARCH_I3_PORT_A to change the
 * first): clear of the demo's ports, iteration 2's proof (21000 and up), the round trip (18971) and live
 * conformance (18991). O1 runs B's simulator for its full 120 seconds. Every check also runs against
 * planted faults, which must turn it red.
 */

const { finish, line } = require('../arch-i1/lib');

async function main() {
  line('Iteration 3 proof: live state and observation with no session');
  const base = Number(process.env.OSL_ARCH_I3_PORT_A) || 22000;
  let used = 0;
  const ports = { next: () => base + used++ };

  await require('./checks-live').liveChecks(ports);
  await require('./checks-resume').resumeChecks(ports);
  await require('./checks-coupling').couplingChecks(ports);
  await require('./checks-auth').authChecks(ports);
  await require('./checks-browser').browserChecks(ports);
  await require('./checks-overlay').overlayChecks(ports);
  finish('arch-i3.json', 'iteration 3 proof');
  process.exit(process.exitCode || 0);
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write('\n');
  process.exit(1);
});
