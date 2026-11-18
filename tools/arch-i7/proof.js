'use strict';

/*
 * Iteration 7 proof, part a: a running world inside a world.   Run: npm run arch-i7-proof
 *
 * World B is a small live game on its own server (runtime/world-server/src/runtime-game.js, run when B's config
 * asks for it): a ball moves under B's server logic, a button toggles a light, and B has its own visitor. B requires
 * a token (auth "required") and runs its own authorization server. World A includes {B}/wow/world twice: at 1:10 on a
 * table, and at full size 3,000,000.37 m from A's origin. B includes world D. A viewer's client is
 * web/wow-inclusion.mjs (observeComposition), with a token for each world: its own from A, and B's token for "host A
 * acts for this viewer" (the iteration 6 exchange).
 *
 *   W1        live: the ball's position in A equals B's server state through the including node, within one step (checks-live.js)
 *   W2, W2b   acting: a press goes to the button's URL at B with If-Match and the exchanged token; two presses at
 *             the same moment both count (one 412, read again, retry)
 *   W3        refused: without B's write grant the press answers 403, and the client state shows the refusal
 *   W4        B's visitors: user ids only under B's presence grant for host A; A's viewers never appear in B   (checks-people.js)
 *   W6        B offline: a placeholder, A keeps running, and the client resumes from its last revision         (checks-offline.js)
 *   W7        depth 2: D through B within A's nesting limit; past the limit, refused and shown
 *   API       the API finding: every request B receives through A is a contract path or B's event stream     (checks-api.js)
 *
 * Part b covers W5 (precision with a moved render origin), W8 (the window fallback) and the load-gated browser check.
 *
 * The worlds are lab world servers in this process, on isolated ports 28000 to 28029 (set OSL_ARCH_I7_PORT_A to
 * change the first): clear of the demo's ports and of iterations 1 to 6, arch-a2 and the overlay proof. No browser
 * starts. Every check also runs against planted faults, each an exact edit of the real code, which must turn it red;
 * a planted fault whose edit no longer applies is a harness error that fails the proof (tools/arch-i1/lib.js).
 */

const { finish, line } = require('../arch-i1/lib');

async function main() {
  line('Iteration 7 proof, part a: a running world inside a world (live, acting, refused, visitors, offline, depth 2)');
  const base = Number(process.env.OSL_ARCH_I7_PORT_A) || 28000;
  const SPAN = 30;
  let used = 0;
  const ports = { next: () => base + (used++ % SPAN) };
  line('W1 to W3, B\'s game live in A, and acting on it');
  await require('./checks-live').liveChecks(ports);
  line('W4, B\'s visitors');
  await require('./checks-people').peopleChecks(ports);
  line('W6 and W7, B offline and depth 2');
  await require('./checks-offline').offlineChecks(ports);
  line('The API finding');
  await require('./checks-api').apiChecks(ports);
  line('ports used: ' + base + ' to ' + (base + Math.min(used, SPAN) - 1) + ' (' + used + ' worlds opened)');
  finish('arch-i7.json', 'iteration 7 proof (part a)');
  process.exit(process.exitCode || 0);
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write('\n');
  process.exit(1);
});
