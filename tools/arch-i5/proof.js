'use strict';

/*
 * Iteration 5 proof: carried identity.   Run: npm run arch-i5-proof
 *
 * Stage A, the identity handshake (built first; stage B, digital you, is not built yet):
 *   ID6, ID5, ID1, ID9, ID10, ID2,  the handshake against lab world servers, in Node        (checks-handshake.js);
 *   ID4, ID7                        ID9 is preferences without a height, reported back member by member;
 *                                   ID10 the pilot statement (User.pilot), hybrid shown as an agent
 *   V1                              the ID1 after view, in a browser                        (checks-browser.js)
 *   SE1, SE2                        following (SE1, in a browser, in the main demo) and      (checks-session.js)
 *                                   departing (SE2, in Node), beside the join
 *   SE3, SE4, SE5                   one User id allocator per world for handshake and         (checks-session.js)
 *                                   presence users (SE3), handshake users in active_user_count
 *                                   (SE4), following in the ?wow= viewer (SE5, in a browser)
 *   W1-W4                           the proposed Web of Worlds edits (World API overlay);   (checks-overlay.js)
 *                                   W2 also the follow and depart text, User.pilot, and user_joined, user_left and
 *                                   GET /wow/user/{id} with its pilot on the wire,
 *                                   W3 their conformance vocabulary, W4 neutral wording on every overlay
 *
 * The worlds are lab world servers on isolated ports 26000 to 26029 (set OSL_ARCH_I5_PORT_A to change the
 * first): clear of the demo's ports, iterations 1 to 4 (18860, 21000, 22000, 24000 and up), the round trip
 * (18971), the presence proof (19715) and live conformance (18991). Every check also runs against planted
 * faults, each an exact edit of the real code, which must turn it red. A planted fault whose edit no longer
 * applies is a harness error that fails the proof (tools/arch-i1/lib.js).
 */

const { finish, line } = require('../arch-i1/lib');

async function main() {
  line('Iteration 5 proof: carried identity');
  line('stages run: A (the identity handshake: ID1, ID2, ID4, ID5, ID6, ID7, ID9 (preferences without a height), ID10 (the pilot statement, User.pilot), the ID1 after view, following and departing (SE1, SE2), one user id per world (SE3), handshake users counted (SE4), following in the ?wow= viewer (SE5), and the World API overlay); stage B (digital you: ID3, ID8, ID6 again) is not built yet');
  const base = Number(process.env.OSL_ARCH_I5_PORT_A) || 26000;
  // At most a few worlds are open at once and each closes before its check ends, so the proof cycles through
  // 30 ports (base to base + 29) instead of taking a new one for every world.
  const SPAN = 30;
  let used = 0;
  const ports = { next: () => base + (used++ % SPAN) };

  await require('./checks-handshake').handshakeChecks(ports);
  if (process.env.OSL_ARCH_I5_SKIP_BROWSER !== '1') await require('./checks-browser').browserChecks(ports);
  else line('  (V1 not run: OSL_ARCH_I5_SKIP_BROWSER=1; the proof does not pass without it)');
  await require('./checks-session').sessionChecks(ports, { browser: process.env.OSL_ARCH_I5_SKIP_BROWSER !== '1' });
  await require('./checks-overlay').overlayChecks(ports);
  line('ports used: ' + base + ' to ' + (base + Math.min(used, SPAN) - 1) + ' (' + used + ' worlds and frontends opened)');
  finish('arch-i5.json', 'iteration 5 proof (stage A)');
  if (process.env.OSL_ARCH_I5_SKIP_BROWSER === '1') { line('FAIL: V1, SE1 and SE5 were not run'); process.exitCode = 1; }
  process.exit(process.exitCode || 0);
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write('\n');
  process.exit(1);
});
