// interop-OUT cross-check against the UM REFERENCE implementation.
//
//   node web/signing/crosscheck-um-harness.mjs
//
// verify-vectors.mjs proves interop-IN (this library verifies the UM suite's own
// reference-signed fixture). THIS script proves interop-OUT: the Universal
// Manifest reference implementation (the exact code the conformance adapter uses:
// packages/universal-manifest/dist/index.js -> assertUniversalManifestV02 /
// assertUniversalManifestV02Fresh, node:crypto Ed25519 over its own JCS) accepts a
// manifest signed BY THIS LIBRARY, and rejects a tampered copy.
//
// The UM repo is an EXTERNAL, machine-local dependency, so this check SKIPs
// cleanly (exit 0, clearly labeled) when the repo or its built dist is absent.
// A SKIP is not a pass: the vector-suite claims stand on verify-vectors.mjs alone;
// this script only adds the reference-implementation cross-signature evidence.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { attachSignatureProfileA, hexToBytes } from "./index.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UM_DIST = "local-path";

async function main() {
  let um;
  try {
    await fs.access(UM_DIST);
    um = await import(UM_DIST);
  } catch {
    process.stdout.write(`SKIP  UM reference implementation not found at ${UM_DIST}\n`);
    process.stdout.write("      (external cross-check unavailable on this machine; vector suite still authoritative)\n");
    return;
  }

  const vector = JSON.parse(await fs.readFile(path.join(HERE, "vectors", "um-profile-a.json"), "utf8"));
  let pass = 0;
  let fail = 0;
  const verdict = (id, ok, detail) => {
    process.stdout.write(`${ok ? "PASS" : "FAIL"}  [${id}] ${detail}\n`);
    ok ? pass++ : fail++;
  };

  // X1 — the FROZEN signed manifest (built by this library) passes the reference
  // structural validator, which includes full Ed25519-over-JCS verification.
  try {
    um.assertUniversalManifestV02(vector.signedManifest);
    verdict("X1", true, "UM reference assertUniversalManifestV02 ACCEPTS the frozen manifest signed by this library");
  } catch (e) {
    verdict("X1", false, `UM reference REJECTED our frozen signed manifest: ${e.message}`);
  }

  // X2 — same, fresh mode (adds TTL math over the far-future expiresAt).
  try {
    um.assertUniversalManifestV02Fresh(vector.signedManifest);
    verdict("X2", true, "UM reference assertUniversalManifestV02Fresh ACCEPTS it (TTL window valid)");
  } catch (e) {
    verdict("X2", false, `UM reference fresh-mode rejected: ${e.message}`);
  }

  // X3 — a FRESHLY signed manifest (new sign() call this run) also passes.
  try {
    const fresh = await attachSignatureProfileA(vector.unsignedManifest, hexToBytes(vector.signingSeedHex));
    um.assertUniversalManifestV02(fresh);
    verdict("X3", true, "UM reference ACCEPTS a freshly signed manifest (not just the frozen bytes)");
  } catch (e) {
    verdict("X3", false, `UM reference rejected freshly signed manifest: ${e.message}`);
  }

  // X4 — tamper AFTER our signing -> the reference verifier must REJECT.
  try {
    const tampered = { ...vector.signedManifest, subject: "did:example:mallory" };
    um.assertUniversalManifestV02(tampered);
    verdict("X4", false, "UM reference ACCEPTED a tampered manifest (should be impossible)");
  } catch (e) {
    verdict("X4", /signature/i.test(e.message), `UM reference rejects our manifest when tampered: "${e.message}"`);
  }

  process.stdout.write(`\nCROSS-CHECK TOTAL: ${pass + fail}  PASS: ${pass}  FAIL: ${fail}\n`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  process.stdout.write(`CROSSCHECK ERROR: ${e.stack || e.message}\n`);
  process.exitCode = 1;
});
