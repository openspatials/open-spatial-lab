// The lists behind tools/run-checks.mjs: which checks exist, which need a browser, which ports each takes from
// its base, and which are known to be red.
//
// A step is { file, nodeArgs, args, groups, browser, lab, timeoutS, ports }. The groups "test" and "test-fast" are not
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
  "src/wow-inclusion-lifecycle-check.mjs",
  "src/live-adapter-crossing-manifest-check.mjs",
  "src/live-adapter-navigation-check.mjs",
  "src/live-adapter-lifecycle-check.mjs",
  "src/live-adapter-picker-fixture-check.mjs",
  "src/live-adapter-world-reader-check.mjs",
  "src/application-core-check.mjs",
  "src/application-state-check.mjs",
  "src/application-boundary-check.mjs",
  "src/scene-lifecycle-check.mjs",
  "src/application-debug-check.mjs",
  "src/own-x3d-integration-check.mjs",
  "src/live-adapter-diagnostics-check.mjs",
  "src/application-status-check.mjs",
  "src/application-boot-check.mjs",
  "src/application-assembly-check.mjs",
  "src/peer-avatar-presentation-check.mjs",
  "src/live-viewport-check.mjs",
  "src/avatar-resources-check.mjs",
  "src/portal-traversal-lifecycle-check.mjs",
  "src/render-adapter-contract-check.mjs",
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
  "src/live-adapter-movement-check.mjs",
  "src/crossing-camera-validation-check.mjs",
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
  "src/self-identity-push-departure-check.mjs",
  "src/semantic-destinations-check.mjs",
  "src/server-camera-footer-check.mjs",
  "src/wow-url-grammar-check.mjs",
  "src/extension-host-check.mjs",
  "src/wow-extension-discovery-check.mjs",
];

// The port variables that client proofs read; the rest take none.
const CLIENT_PORTS = {
  "src/p3-exit-pose-parity-proof.mjs": fourWorlds("OSL_EXIT_POSE_PORT"),
  "src/p4-both-sides-perimeter-proof.mjs": fourWorlds("OSL_PERIMETER_PORT"),
  "src/portal-live-landing-counterpart-proof.mjs": fourWorlds("OSL_PORTAL_LANDING_PORT"),
  "src/portal-movement-orientation-continuity-proof.mjs": fourWorlds("OSL_PEER_AVATAR_PORT"),
};

// Client proofs that carry planted faults behind a --faults flag.
const WITH_FAULTS = new Set(["src/self-identity-push-departure-check.mjs", "src/extension-host-check.mjs", "src/extension-host-browser-check.mjs",
  "src/wow-extension-discovery-check.mjs", "src/wow-extension-mount-browser-check.mjs", "src/wow-extension-page-browser-check.mjs"]);
const NODE_ARGS = {
  "src/live-adapter-movement-check.mjs": ["--experimental-vm-modules"], "src/live-adapter-lifecycle-check.mjs": ["--experimental-vm-modules"], "src/live-adapter-navigation-check.mjs": ["--experimental-vm-modules"], "src/live-adapter-crossing-manifest-check.mjs": ["--experimental-vm-modules"], "src/avatar-resources-check.mjs": ["--loader", "./tools/renderer/node-fixture-loader.mjs"] };
// Group steps that need longer than the default step timeout: the extension host check runs its 37 planted faults
// (each a full run of the check in a copy of the code) whenever every check passes.
const STEP_TIMEOUT_S = { "src/extension-host-check.mjs": 900 };
const groupStep = (group, file) => ({ file, nodeArgs: NODE_ARGS[file], groups: [group], ports: CLIENT_PORTS[file], ...(WITH_FAULTS.has(file) ? { faultsFlag: true } : {}), ...(STEP_TIMEOUT_S[file] ? { timeoutS: STEP_TIMEOUT_S[file] } : {}) });

// Steps outside the three older groups. Each runs on its own as `node <file> <args>`.
const MORE = [
  { file: "src/server-runtime-owners-check.mjs", groups: ["server"] },
  { file: "src/server-runtime-projections-check.mjs", groups: ["server"] },
  { file: "src/server-runtime-composition-check.mjs", groups: ["server"] },
  { file: "tools/verify-release.mjs" },
  { file: "tools/trace-check.mjs" },
  { file: "src/importer-kit-check.mjs" },
  { file: "src/engine-boundary-check.mjs" },
  { file: "src/scene-view-kit-check.mjs" },
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
  { file: "src/x3d-route-check.mjs", ports: (p) => ({ OSL_TEST_PORT_BASE: p(0) }), browser: true, timeoutS: 1800, faultsFlag: true, faultsTimeoutS: 3600 },
  { file: "src/x3d-portal-optics-check.mjs", ports: (p) => ({ OSL_TEST_PORT_BASE: p(0) }), browser: true, timeoutS: 1800, faultsFlag: true, faultsTimeoutS: 3600 },
  { file: "tools/check-worlds.mjs", lab: true },
];

export const STEPS = [
  ...IDENTITY.map((file) => groupStep("identity", file)),
  ...CLIENT.map((file) => groupStep("client", file)),
  { file: "src/frosted-floating-chrome-e2e.mjs", groups: ["browser"], browser: true, ports: one("OSL_FROSTED_CHROME_PORT"), timeoutS: 600 },
  { file: "src/extension-host-browser-check.mjs", groups: ["browser"], browser: true, ports: one("OSL_EXTENSION_HOST_BROWSER_PORT"), timeoutS: 900, faultsFlag: WITH_FAULTS.has("src/extension-host-browser-check.mjs") },
  { file: "src/wow-extension-mount-browser-check.mjs", groups: ["browser"], browser: true, ports: one("OSL_UE_MOUNT_BROWSER_PORT"), timeoutS: 2700, faultsFlag: WITH_FAULTS.has("src/wow-extension-mount-browser-check.mjs") },
  { file: "src/wow-extension-page-browser-check.mjs", groups: ["browser"], browser: true, ports: one("OSL_UE_PAGE_BROWSER_PORT"), timeoutS: 1200, faultsFlag: WITH_FAULTS.has("src/wow-extension-page-browser-check.mjs") },
  { file: "tools/extension-leak-check.mjs", groups: ["browser"], browser: true, ports: one("OSL_UE_LEAK_BROWSER_PORT"), timeoutS: 600, faultsFlag: true },
  ...MORE,
];

// Steps that are red today and are not repaired here, keyed by file. Each entry names why and which phase of the
// refactor takes it. A step on this list that passes is reported as FAIL, so the list cannot go stale. Empty now.
export const KNOWN_RED = {};
