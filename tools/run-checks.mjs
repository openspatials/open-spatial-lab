// Runs a group of the lab's checks, one after another, and fails if any of them fails.
// Usage: node tools/run-checks.mjs <identity|client|browser|all>
//
//   identity  the Universal Manifest, RP1 and trust modules' attack-vector tests, and the signing
//             test vectors (RFC 8032, RFC 8785, DID, the UM signature profile)
//   client    checks of the browser client's controllers and scene code, run in Node
//   browser   checks that drive Chrome; set PUPPETEER_EXECUTABLE_PATH if Chrome is not found
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GROUPS = {
  "identity": [
    "web/manifest/bilateral-chain-attack-vectors.mjs",
    "web/manifest/entity-personhood-verify.mjs",
    "web/manifest/holder-binding-attack-vectors.mjs",
    "web/manifest/jwe-sealed-facets-attack-vectors.mjs",
    "web/manifest/receipt-hub-attack-vectors.mjs",
    "web/manifest/rp1-model-attack-vectors.mjs",
    "web/manifest/som-branch-auth-attack-vectors.mjs",
    "web/manifest/statusref-resolution-attack-vectors.mjs",
    "web/manifest/trust-tier-attack-vectors.mjs",
    "web/signing/attack-vectors.mjs",
    "web/signing/crosscheck-um-harness.mjs",
    "web/signing/verify-vectors.mjs"
  ],
  "client": [
    "src/airport-boarding-check.mjs",
    "src/airport-hud-lifecycle-check.mjs",
    "src/airport-lobby-portal-phase1-check.mjs",
    "src/airport-refresh-check.mjs",
    "src/airport-seamless-backend-check.mjs",
    "src/airport-shopping-check.mjs",
    "src/automatic-reciprocal-portals-check.mjs",
    "src/avatar-selector-controller-check.mjs",
    "src/check-equipment-schema.js",
    "src/client-portal-c-recovery-check.mjs",
    "src/client-scene-controller-check.mjs",
    "src/demo-trajectory-recorder-check.mjs",
    "src/fabric-prefetch-controller-check.mjs",
    "src/header-navigation-check.mjs",
    "src/homepage-scroll-check.mjs",
    "src/lazy-avatar-selector-check.mjs",
    "src/live-adapter-transport-check.mjs",
    "src/live-lobby-portals-check.mjs",
    "src/meeting-critical-visuals-check.mjs",
    "src/movement-camera-controller-check.mjs",
    "src/no-equipment-modal-contract-check.mjs",
    "src/notification-toast-controller-check.mjs",
    "src/p3-exit-pose-parity-proof.mjs",
    "src/p4-both-sides-perimeter-proof.mjs",
    "src/p5-still-image-legible-both-sides-proof.mjs",
    "src/peer-avatar-variant-first-frame-proof.mjs",
    "src/player-first-frame-check.mjs",
    "src/player-session-record-check.mjs",
    "src/portal-live-landing-counterpart-proof.mjs",
    "src/portal-movement-orientation-continuity-proof.mjs",
    "src/presence-runtime-stream-check.mjs",
    "src/presentation-json-viewer-check.mjs",
    "src/proof-contract-repair-check.mjs",
    "src/randomize-starting-avatar-check.mjs",
    "src/runtime-tweak-toolbar-check.mjs",
    "src/self-identity-push-departure-check.mjs",
    "src/semantic-destinations-check.mjs",
    "src/server-camera-footer-check.mjs",
    "src/wow-url-grammar-check.mjs"
  ],
  "browser": [
    "src/frosted-floating-chrome-e2e.mjs"
  ]
};

const group = process.argv[2];
const list = group === "all" ? Object.values(GROUPS).flat() : GROUPS[group];
if (!list) {
  console.error(`usage: node tools/run-checks.mjs <${Object.keys(GROUPS).join("|")}|all>`);
  process.exit(2);
}
const failed = [];
for (const file of list) {
  const started = Date.now();
  const result = spawnSync(process.execPath, [file], { cwd: ROOT, encoding: "utf8", timeout: 300000 });
  const ok = result.status === 0;
  console.log(`${ok ? "PASS" : "FAIL"}  ${file}  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  if (!ok) {
    failed.push(file);
    console.log(String(result.stdout || "").split("\n").slice(-8).join("\n"));
    console.log(String(result.stderr || "").split("\n").slice(-8).join("\n"));
  }
}
console.log(`\n${list.length - failed.length}/${list.length} checks pass`);
process.exit(failed.length ? 1 : 0);
