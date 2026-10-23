'use strict';

/*
 * Iteration 2 proof: including a graph from another world.   Run: npm run arch-i2-proof
 *
 *   I1-I3    the content link, placement and ownership      (tools/arch-i2/checks-link.js)
 *   I4, I4b  conditional reads and lost updates             (tools/arch-i2/checks-reads.js)
 *   I5-I8b   unreachable, refused, cycles, depth and budget  (tools/arch-i2/checks-failures.js)
 *   I9, I10  a whole world, and frames                      (tools/arch-i2/checks-world.js)
 *   I12      the included world's environment               (tools/arch-i2/checks-world.js)
 *   I11      a cross-origin browser read (load-gated)       (tools/arch-i2/checks-browser.js)
 *   O1, O2   the proposed Web of Worlds edits                (tools/arch-i2/checks-overlay.js)
 *
 * Headless, in Node, except I11. World A and world B are lab world servers on two local origins,
 * with B at the path prefix /w/b/, on isolated ports from 21000 up (set OSL_ARCH_I2_PORT_A to change
 * the first), clear of the demo's ports and the other proofs' ports. Every check also runs against planted faults, which must turn it
 * red. Python 3 is required: the reference numbers for I2 and I9 come from a Python script.
 */

const { finish, line } = require('../arch-i1/lib');

async function main() {
  line('Iteration 2 proof: including a graph from another world');
  const base = Number(process.env.OSL_ARCH_I2_PORT_A) || 21000;
  let used = 0;
  const ports = { next: () => base + used++ };

  await require('./checks-link').linkChecks(ports);
  await require('./checks-reads').readChecks(ports);
  await require('./checks-failures').failureChecks(ports);
  await require('./checks-world').worldChecks(ports);
  await require('./checks-browser').browserChecks(ports);
  await require('./checks-overlay').overlayChecks(ports);
  finish('arch-i2.json', 'iteration 2 proof');
  process.exit(process.exitCode || 0);
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write('\n');
  process.exit(1);
});
