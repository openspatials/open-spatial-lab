'use strict';

/*
 * Iteration 1 proof: frames, GeoPose and a clean node tree.   Run: npm run arch-i1-proof
 *
 *   F1-F5   geodesy and GeoPose anchors     (tools/arch-i1/checks-frames.js, checks-anchors.js)
 *   T1-T2   transforms                      (tools/arch-i1/checks-transform.js)
 *   N1-N6   the node tree                   (tools/arch-i1/checks-tree.js, checks-canonical.js)
 *   U1-U2   the proposed upstream edits      (tools/arch-i1/checks-upstream.js)
 *
 * Headless, in Node. The server checks start their own world servers on isolated ports from 18860 up
 * (set OSL_ARCH_I1_PORT_A to change the first), never the demo's ports.
 * Python 3 is required: the references for F1, F2, F3, F3b and F5 are Python scripts, and a missing
 * interpreter fails the proof.
 */

const { finish, line } = require('./lib');

async function main() {
  line('Iteration 1 proof: frames, GeoPose and a clean node tree');
  const base = Number(process.env.OSL_ARCH_I1_PORT_A) || 18860;
  let used = 0;
  const ports = { next: () => base + used++ };

  const frames = require('./checks-frames');
  const { real } = await frames.frameChecks();
  await frames.readerChecks(real);
  await require('./checks-anchors').anchorChecks(ports);
  await require('./checks-transform').transformChecks(ports);
  await require('./checks-tree').treeChecks(ports);
  await require('./checks-canonical').canonicalChecks(ports);
  await require('./checks-upstream').upstreamChecks();
  finish('arch-i1.json');
  process.exit(process.exitCode || 0);
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write('\n');
  process.exit(1);
});
