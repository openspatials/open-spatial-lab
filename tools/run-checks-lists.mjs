// The lists behind tools/run-checks.mjs: which checks exist, which need a browser, which ports each takes from
// its base, and which are known to be red.
//
// A step is { file, args, groups, browser, lab, timeoutS, ports }. The groups "test" and "test-fast" are not
// tagged here: "test" is every step below plus the files named tools/behavior/*.check.mjs, and "test-fast" is the
// steps that need neither a browser nor a running lab.

const same = (names) => (p) => Object.fromEntries(names.map((name, i) => [name, p(i)]));
const demoPorts = same(["OSL_FRONTEND_PORT", "OSL_BACKEND_A_PORT", "OSL_BACKEND_B_PORT", "OSL_BACKEND_LOBBY_PORT", "OSL_BACKEND_AIRPORT_PORT"]);
const fourWorlds = (prefix) => same(["A", "B", "LOBBY", "AIRPORT"].map((name) => `${prefix}_${name}`));
const one = (name) => same([name]);

const IDENTITY = [
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
  "web/signing/verify-vectors.mjs",
];

const CLIENT = [
  "src/airport-boarding-check.mjs",
  "src/airport-hud-lifecycle-check.mjs",
  "src/airport-lobby-portal-phase1-check.mjs",
  "src/airport-refresh-check.mjs",
  "src/airport-seamless-backend-check.mjs",
  "src/airport-shopping-check.mjs",
  "src/automatic-reciprocal-portals-check.mjs",
  "src/avatar-selector-controller-check.mjs",
  "src/check-equipment-schema.js",
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
  "src/wow-url-grammar-check.mjs",
];

// The port variables that client proofs read; the rest take none.
const CLIENT_PORTS = {
  "src/p3-exit-pose-parity-proof.mjs": fourWorlds("OSL_EXIT_POSE_PORT"),
  "src/p4-both-sides-perimeter-proof.mjs": fourWorlds("OSL_PERIMETER_PORT"),
  "src/portal-live-landing-counterpart-proof.mjs": fourWorlds("OSL_PORTAL_LANDING_PORT"),
  "src/portal-movement-orientation-continuity-proof.mjs": fourWorlds("OSL_PEER_AVATAR_PORT"),
};

const groupStep = (group, file) => ({ file, groups: [group], ports: CLIENT_PORTS[file] });

// Steps outside the three older groups. Each runs on its own as `node <file> <args>`.
const MORE = [
  { file: "tools/verify-release.mjs" },
  { file: "tools/trace-check.mjs" },
  { file: "tools/check-request-target.js", ports: one("OSL_REQUEST_TARGET_PORT") },
  { file: "tools/wow-conformance/run.js", ports: one("OSL_WOW_CONFORMANCE_PORT") },
  { file: "wow-spec/conformance-fixtures/run.mjs" },
  { file: "tools/wow-conformance/crossing-proof.js", ports: same(["OSL_CROSSING_PROOF_PORT_A", "OSL_CROSSING_PROOF_PORT_B"]) },
  { file: "tools/wow-conformance/portal-proof.js", ports: same(["OSL_PORTAL_PROOF_PORT_A", "OSL_PORTAL_PROOF_PORT_B"]) },
  { file: "tools/verify-wowapi-smoke.mjs", ports: demoPorts },
  { file: "runtime/world-server/test/spatial-graph-proof.js", ports: same(["OSL_SPATIAL_GRAPH_PORT_A", "OSL_SPATIAL_GRAPH_PORT_B"]) },
  { file: "runtime/world-server/test/contract-enforcement-proof.js", ports: one("OSL_CONTRACT_PROOF_PORT") },
  { file: "runtime/world-server/test/ws-events-presence-proof.js", ports: one("PROOF_PORT") },
  { file: "runtime/world-server/test/acceptance.test.js", ports: same(["WORLD_SERVER_ACCEPTANCE_A_PORT", "WORLD_SERVER_ACCEPTANCE_B_PORT"]) },
  { file: "runtime/world-server/test/airport-backend-proof.js" },
  { file: "runtime/world-server/test/p1-shared-edge-portal-identity-proof.js", ports: fourWorlds("OSL_SHARED_EDGE_PORT") },
  { file: "wow-spec/proof/roundtrip.js", ports: one("OSL_WOW_PROOF_PORT") },
  { file: "tools/arch-i1/proof.js", ports: one("OSL_ARCH_I1_PORT_A") },
  { file: "tools/arch-i2/proof.js", ports: one("OSL_ARCH_I2_PORT_A"), browser: true },
  { file: "tools/arch-i3/proof.js", ports: one("OSL_ARCH_I3_PORT_A"), browser: true, timeoutS: 900 },
  { file: "tools/arch-i4/proof.js", ports: one("OSL_ARCH_I4_PORT_A"), browser: true, timeoutS: 900 },
  { file: "tools/arch-i4/main-demo/proof.mjs", args: ["--no-faults"], ports: one("OSL_ARCH_I4_MAIN_PORT"), browser: true, timeoutS: 1500 },
  { file: "tools/verify-demo.mjs", ports: demoPorts, browser: true, timeoutS: 900 },
  { file: "tools/placement/check-world-list.mjs", ports: one("OSL_WORLD_LIST_PORT"), browser: true, timeoutS: 600 },
  { file: "tools/placement/run.mjs", ports: one("OSL_PLACEMENT_PORT"), browser: true, timeoutS: 900 },
  { file: "tools/placement/check-local-only.mjs", ports: one("OSL_LOCAL_ONLY_PORT"), browser: true, timeoutS: 900 },
  { file: "src/clean-webgl-ui-smoke.mjs", ports: one("OSL_CLEAN_WEBGL_PORT"), browser: true, timeoutS: 600 },
  { file: "src/header-navigation-e2e.mjs", ports: one("OSL_HEADER_NAV_PORT"), browser: true, timeoutS: 600 },
  { file: "src/homepage-scroll-e2e.mjs", ports: one("OSL_HOMEPAGE_SCROLL_PORT"), browser: true, timeoutS: 600 },
  { file: "tools/check-worlds.mjs", lab: true },
];

export const STEPS = [
  ...IDENTITY.map((file) => groupStep("identity", file)),
  ...CLIENT.map((file) => groupStep("client", file)),
  { file: "src/frosted-floating-chrome-e2e.mjs", groups: ["browser"], browser: true, ports: one("OSL_FROSTED_CHROME_PORT"), timeoutS: 600 },
  ...MORE,
];

// Steps that are red today and are not repaired here. Each names why and which phase of the refactor takes it.
// A step on this list that passes is reported as FAIL, so the list cannot go stale.
export const KNOWN_RED = {
  "wow-spec/proof/roundtrip.js": {
    reason: "its fabric section imports web/wow-fabric-transform.mjs and web/wow-fabric-backend.mjs, which are not in the repository; the dead .msf path they belonged to goes in the removal phase",
    phase: "phase 2",
  },
};
