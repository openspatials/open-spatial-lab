'use strict';

/*
 * Iteration 6 proof: permissions (scopes, observers, withdrawal, delegation, hosts, per-resource grants).   Run: npm run arch-i6-proof
 *
 * Decision 5, option 1: OAuth 2.0 bearer tokens, each bound to one world (its base URL is the audience, RFC 8707);
 * each world keeps its own grant records; the four scopes read, observe, write and enter; discovery through
 * protected resource metadata (RFC 9728); errors in WWW-Authenticate (RFC 6750 §3 and §3.1).
 *
 *   G1a-G1e   scopes and audience: each scope enforced, 401 and 403 with their error codes, two worlds on    (checks-scopes.js)
 *             one origin at /w/b and /w/bb, protected resource metadata, the join answer's scopes
 *   G2a-G2d   observers: the observe grant, people only under the presence grant on every path, every       (checks-observers.js)
 *             revision to every observer, the token as the stream's first message and never in a URL
 *   G3a-G3b   withdrawal: the next request refused, the stream closed within 5 seconds; expired tokens      (checks-withdrawal.js)
 *   G4a-G4b   delegation: an exchanged token (RFC 8693) for an agent acting for a visitor, under the       (checks-delegation.js)
 *             visitor's grant record; a chain of actors, decided on the current actor, logged whole
 *   G5        hosts: two worlds with separate authorization servers; a host writes into an included world only
 *             with a token that world issued by exchange, from a subject token of an issuer it trusts
 *   G6        per-resource grants: a write grant names one node
 *   W1-W4     the proposed Web of Worlds edits: the World, Asset and User Manifest patches, the offer         (checks-overlay.js)
 *             against the served contract and the G1 wire half, the key words, neutral wording
 *
 * The worlds are lab world servers with auth "required", in this process, on isolated ports 27000 to 27029 (set
 * OSL_ARCH_I6_PORT_A to change the first): clear of the demo's ports and of iterations 1 to 5, arch-a2 and the
 * overlay proof. No browser starts. Every check also runs against planted faults, each an exact edit of the real
 * code, which must turn it red; a planted fault whose edit no longer applies is a harness error that fails the
 * proof (tools/arch-i1/lib.js).
 */

const { finish, line } = require('../arch-i1/lib');

async function main() {
  line('Iteration 6 proof: permissions (scopes and audience, observers, withdrawal, delegation, hosts, per-resource grants)');
  const base = Number(process.env.OSL_ARCH_I6_PORT_A) || 27000;
  const SPAN = 30;
  let used = 0;
  const ports = { next: () => base + (used++ % SPAN) };
  line('G1, scopes and audience');
  await require('./checks-scopes').scopeChecks(ports);
  line('G2, observers');
  await require('./checks-observers').observerChecks(ports);
  line('G3, withdrawal');
  await require('./checks-withdrawal').withdrawalChecks(ports);
  line('G4 to G6, delegation, hosts and per-resource grants');
  await require('./checks-delegation').delegationChecks(ports);
  line('The Web of Worlds edits');
  await require('./checks-overlay').overlayChecks(ports);
  line('ports used: ' + base + ' to ' + (base + Math.min(used, SPAN) - 1) + ' (' + used + ' worlds opened)');
  finish('arch-i6.json', 'iteration 6 proof');
  process.exit(process.exitCode || 0);
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write('\n');
  process.exit(1);
});
