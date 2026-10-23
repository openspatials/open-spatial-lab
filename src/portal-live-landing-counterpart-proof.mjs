/**
 * PORTAL LIVE-LANDING COUNTERPART PROOF
 * (deterministic; no browser, no load gate).
 *
 * The defect: the live composition crossing landed the
 * player at the PROMOTED FABRIC'S FIRST portal-attachment node instead of the
 * TRAVERSED EDGE's counterpart portal. Concretely: walking lobby -> A landed at
 * the A<->B portal [2.8,0,-2.8] — 5.6 m from location-a-portal-lobby
 * [-2.8,0,-2.8], the counterpart of the edge actually walked — even though the
 * through-ring RENDER was correct. Cause: `_fabricDerivedExitPose`
 * (web/live-adapter.js) anchored on `findFabricPortalAttachmentNode(root)`,
 * which returns whichever attachment node comes FIRST in the destination
 * fabric; post-P1 an endpoint world hosts TWO (its A<->B edge AND its
 * lobby edge).
 *
 * The fix: the live crossing destination resolves to the frame
 * mapping's `mapped_exit_transform` — the counterpart pose built from the
 * crossing portal's `target_frame` (P1's shared_edge counterpart; the SAME pose
 * the through-ring renders and P3 parity re-measures against).
 *
 * HOW IT CANNOT LIE:
 *   - Boots the REAL four 041 nodes in-process on ISOLATED ports; reads live
 *     wire payloads (no fixtures) and the REAL served fabric.json manifests.
 *   - Exercises the SHIPPING geometry (`mapTransformBetweenPortalFrames`,
 *     `portalFrameForLocation`, `portalLocalCoordinates`), the REAL world
 *     projection (`worldFromLive`), and the REAL P3 parity helper loaded from
 *     `web/portal-spatial-preview.mjs` (loader recipe).
 *   - Falsifiable ORACLE TEETH (E3): the RETIRED fabric-first-node derivation,
 *     reconstructed from the actual served manifest + centroid, lands 5.6 m from
 *     the counterpart — so a revert to that anchor FAILS the counterpart
 *     criterion. E6 is a source tripwire: removing the fix breaks it.
 *
 * ISOLATED PORTS ONLY (19341-19344). 8143 / 18151-18154 (the live local demo)
 * are NEVER bound. No git. Claim boundary unchanged: local application-level
 * proof; every conformance flag stays false.
 */

import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const require_ = createRequire(import.meta.url);

const { start } = require_(resolve(repoRoot, "runtime/world-server/src/server.js"));
const { makeConfig } = require_(resolve(repoRoot, "runtime/world-server/src/config.js"));
const { get } = require_(resolve(repoRoot, "runtime/world-server/src/http-client.js"));

import {
  mapTransformBetweenPortalFrames,
  portalFrameForLocation,
  portalLocalCoordinates,
  PORTAL_EXIT_OFFSET_MIN_M,
  PORTAL_EXIT_OFFSET_MAX_M,
} from "../web/live-adapter-portal-geometry.mjs";
import { worldFromLive } from "../web/live-adapter-world-projection.mjs";

const PORT_A = Number(process.env.OSL_PORTAL_LANDING_PORT_A) || 19341;
const PORT_B = Number(process.env.OSL_PORTAL_LANDING_PORT_B) || 19342;
const PORT_LOBBY = Number(process.env.OSL_PORTAL_LANDING_PORT_LOBBY) || 19343;
const PORT_AIRPORT = Number(process.env.OSL_PORTAL_LANDING_PORT_AIRPORT) || 19344;
const FORBIDDEN = new Set([8143, 18151, 18152, 18153, 18154]);
for (const p of [PORT_A, PORT_B, PORT_LOBBY, PORT_AIRPORT]) {
  if (FORBIDDEN.has(p)) {
    console.error(`REFUSING protected live-demo port ${p}`);
    process.exit(2);
  }
}
const PORT_BY_LOCATION = {
  "location-a": PORT_A,
  "location-b": PORT_B,
  "location-lobby": PORT_LOBBY,
  "location-airport": PORT_AIRPORT,
};

function isolatedPortals(role) {
  return makeConfig(role).portals.map((portal) => ({
    ...portal,
    target_base_url: `http://127.0.0.1:${PORT_BY_LOCATION[portal.target_location_id] || PORT_A}`,
  }));
}

/**  loader recipe: load the SHIPPING preview module (for the REAL P3
 *  parity helper) under node by rewriting only the browser THREE specifier. */
async function loadPreviewModule() {
  const modulePath = resolve(repoRoot, "web/portal-spatial-preview.mjs");
  const threeUrl = pathToFileURL(resolve(repoRoot, "node_modules/three/build/three.module.js")).href;
  const browserThreeImport = 'import * as THREE from "./vendor/scene-core/vendor/three/three.module.js";';
  const tempRoot = await mkdtemp(resolve(tmpdir(), "runtime-counterpart-"));
  let source = await readFile(modulePath, "utf8");
  if (!source.includes(browserThreeImport)) {
    throw new Error("production Three.js import seam not found in portal-spatial-preview.mjs");
  }
  source = source.replace(browserThreeImport, `import * as THREE from ${JSON.stringify(threeUrl)};`);
  const tempModulePath = resolve(tempRoot, "portal-spatial-preview-production.mjs");
  await writeFile(tempModulePath, source);
  await copyFile(
    resolve(repoRoot, "web/live-adapter-portal-geometry.mjs"),
    resolve(tempRoot, "live-adapter-portal-geometry.mjs"),
  );
  const mod = await import(pathToFileURL(tempModulePath).href);
  return { mod, cleanup: () => rm(tempRoot, { recursive: true, force: true }) };
}

let passed = 0;
let failed = 0;
const results = [];
async function check(id, desc, fn) {
  try {
    await fn();
    passed += 1;
    results.push({ id, desc, status: "PASS" });
    console.log(`PASS  ${id}  ${desc}`);
  } catch (err) {
    failed += 1;
    results.push({ id, desc, status: "FAIL", error: err.message });
    console.log(`FAIL  ${id}  ${desc}  -> ${err.message}`);
  }
}
function assertOk(cond, msg) {
  if (!cond) throw new Error(msg);
}
function close(a, b, tol, label) {
  assertOk(Math.abs(a - b) <= tol, `${label}: |${a} - ${b}| > ${tol}`);
}
function planar(a, b) {
  return Math.hypot(a[0] - b[0], a[2] - b[2]);
}
function normalize2(v) {
  const len = Math.hypot(v[0], v[2]) || 1;
  return [v[0] / len, 0, v[2] / len];
}

async function getJson(url) {
  const r = await get(url);
  assertOk(r.status === 200, `${url} -> ${r.status}`);
  return r.json;
}

async function fetchWorldProjection(base, role) {
  const wowWorld = await getJson(`${base}/wow/world`);
  const listed =
    wowWorld.webofworlds_extension && Array.isArray(wowWorld.webofworlds_extension.portals)
      ? wowWorld.webofworlds_extension.portals
      : [];
  const wowPortals = [];
  for (const entry of listed) {
    wowPortals.push(await getJson(`${base}/wow/portal/${entry.id}`));
  }
  return { wowWorld, wowPortals, world: worldFromLive(role, wowWorld, wowPortals, null) };
}

async function regionForEntry(entry) {
  const addr = entry.spatial_fabric_address;
  assertOk(addr && addr.anchor && addr.anchor.portal_id, `portal ${entry.string_portal_id} has no fabric address anchor`);
  const url =
    `${entry.target_base_url}${addr.discovery.region_endpoint}` +
    `?anchor_portal_id=${encodeURIComponent(addr.anchor.portal_id)}` +
    `&radius_m=${encodeURIComponent(addr.roi_hint.radius_m)}`;
  return getJson(url);
}

/** Rebuild the adopted target frame exactly the way the adapter's
 *  `_adoptDestinationPortalPoseForMachine` does: the REAL
 *  `portalFrameForLocation` over the region's destination portal pose. */
function adoptedTargetFrame(entry, regionPortal) {
  const trigger = [...regionPortal.trigger_position];
  trigger[1] = 0;
  return {
    ...portalFrameForLocation({
      portalId: entry.target_frame.portal_id,
      locationId: entry.target_location_id,
      triggerPosition: trigger,
      triggerRadius: Number(regionPortal.trigger_radius_m) || 1.25,
      targetLocationId: entry.source_location_id,
    }),
    pose_source: "destination_region_portal_pose",
  };
}

/** Simulate the committed walk (avatar one step past the source plane), then run
 *  the REAL crossing mapping + the REAL P3 parity helper — the exact pair the
 *  shipping crossing uses: `_fabricDerivedExitPose` now returns
 *  `mapping.mapped_exit_transform`, app.js then applies `computeExitPoseParity`. */
function crossingFor(preview, entry, targetFrame, entryOvershootM, lateralM = 0) {
  const frame = entry.frame;
  const right = frame.right;
  const entryPosition = [
    frame.ground_center[0] + frame.forward[0] * -entryOvershootM + right[0] * lateralM,
    0,
    frame.ground_center[2] + frame.forward[2] * -entryOvershootM + right[2] * lateralM,
  ];
  const entryLocal = portalLocalCoordinates(frame, entryPosition);
  const mapping = mapTransformBetweenPortalFrames({
    sourceFrame: frame,
    targetFrame,
    entryTransform: { position: entryPosition, rotation_y: 0, scale: [1, 1, 1] },
    entryLocal,
  });
  const parity = preview.computeExitPoseParity({
    entrySignedPlaneDistanceM: entryLocal.signed_plane_distance_m,
    targetFrame,
    appliedExitPosition: mapping.mapped_exit_transform.position,
  });
  return { entryPosition, entryLocal, mapping, parity };
}

/** The RETIRED derivation, reconstructed faithfully from the served manifest:
 *  anchor = the FIRST bSubtype-255 attachment node in the destination fabric
 *  (what `findFabricPortalAttachmentNode(root)` returned); dir = toward the
 *  primary camera (centroid); offset/lateral from the traversed edge's frame
 *  mapping (the exact inputs the old branch consumed). */
function retiredFabricNodeExit(firstNodePos, cam, mapping) {
  const anchor = [firstNodePos[0], 0, firstNodePos[2]];
  const dir = normalize2([cam[0] - anchor[0], 0, cam[2] - anchor[2]]);
  const right = [dir[2], 0, -dir[0]];
  const exitOffset = Math.min(
    PORTAL_EXIT_OFFSET_MAX_M,
    Math.max(PORTAL_EXIT_OFFSET_MIN_M, Number(mapping.exit_offset_m) || PORTAL_EXIT_OFFSET_MIN_M),
  );
  const lateral = Number(mapping.mapped_lateral_offset_m) || 0;
  return [
    anchor[0] + dir[0] * exitOffset + right[0] * lateral,
    0,
    anchor[2] + dir[2] * exitOffset + right[2] * lateral,
  ];
}

function firstAttachmentNode(fabricJson) {
  const children = fabricJson && fabricJson.data && Array.isArray(fabricJson.data.Children) ? fabricJson.data.Children : [];
  const nodes = children.filter((n) => n && n.Type && Number(n.Type.bSubtype) === 255);
  return { nodes, first: nodes[0] || null };
}

async function main() {
  const diagnostics = {
    wo: "runtime",
    title: "portal live-landing resolves to the traversed edge counterpart (not the fabric back node)",
    started_at: new Date().toISOString(),
    ports: { a: PORT_A, b: PORT_B, lobby: PORT_LOBBY, airport: PORT_AIRPORT },
    claim_boundary:
      "local application-level validation; exit lands at the frame-mapped counterpart pose; no TeleportXR/production/standards claim",
    checks: null,
    measured: {},
  };

  const servers = [];
  const { mod: preview, cleanup } = await loadPreviewModule();
  try {
    servers.push(await start("a", { bind_port: PORT_A, portals: isolatedPortals("a") }));
    servers.push(await start("b", { bind_port: PORT_B, portals: isolatedPortals("b") }));
    servers.push(await start("lobby", { bind_port: PORT_LOBBY, portals: isolatedPortals("lobby") }));
    servers.push(await start("airport", { bind_port: PORT_AIRPORT, portals: isolatedPortals("airport") }));

    const baseA = `http://127.0.0.1:${PORT_A}`;
    const baseB = `http://127.0.0.1:${PORT_B}`;
    const baseLobby = `http://127.0.0.1:${PORT_LOBBY}`;

    const a = await fetchWorldProjection(baseA, "source");
    const b = await fetchWorldProjection(baseB, "source");
    const lobby = await fetchWorldProjection(baseLobby, "player");

    const fabricA = await getJson(`${baseA}/fabric.json`);
    const fabricB = await getJson(`${baseB}/fabric.json`);

    // Canonical anchors, read from the wire.
    const aPortalToB = a.world.portals.find((p) => p.string_portal_id === "location-a-portal"); // A<->B edge in A
    const aPortalToLobby = a.world.portals.find((p) => p.string_portal_id === "location-a-portal-lobby"); // lobby edge in A
    const lobbyPortalA = lobby.world.portals.find((p) => p.string_portal_id === "lobby-portal-a"); // lobby -> A source
    const lobbyPortalB = lobby.world.portals.find((p) => p.string_portal_id === "lobby-portal-b");
    const abTriggerInA = aPortalToB.trigger.position; // ~[2.8,0,-2.8] — the WRONG (back) node
    const lobbyCounterpartTriggerInA = aPortalToLobby.trigger.position; // ~[-2.8,0,-2.8] — the RIGHT counterpart

    // ---- E1: post-P1 A is a TWO-portal world; the lobby-edge counterpart and
    // the A<->B portal are 5.6 m apart (so a wrong pick is a 5.6 m error) ------
    await check("E1", "A hosts 2 attachment nodes; lobby counterpart and A<->B portal are ~5.6 m apart", () => {
      const { nodes } = firstAttachmentNode(fabricA);
      assertOk(nodes.length === 2, `A fabric has ${nodes.length} attachment nodes (expected 2 post-P1)`);
      assertOk(a.world.portals.length === 2, `A projects ${a.world.portals.length} portals`);
      const sep = planar(abTriggerInA, lobbyCounterpartTriggerInA);
      diagnostics.measured.a_portal_separation_m = Number(sep.toFixed(4));
      close(sep, 5.6, 0.2, "A<->B portal vs lobby counterpart separation");
    });

    // ---- E2: THE FIX — the lobby -> A crossing destination is the counterpart
    // portal (location-a-portal-lobby), NOT the fabric back node --------------
    const lobbyRegion = await regionForEntry(lobbyPortalA);
    const lobbyTargetFrame = adoptedTargetFrame(lobbyPortalA, lobbyRegion.portal);
    const lobbyRun = crossingFor(preview, lobbyPortalA, lobbyTargetFrame, 0.033, 0.06);
    await check("E2a", "lobby->A frame-mapped exit lands AT the counterpart (location-a-portal-lobby), not the back node", () => {
      const exit = lobbyRun.mapping.mapped_exit_transform.position; // what _fabricDerivedExitPose now returns
      const toCounterpart = planar(exit, lobbyCounterpartTriggerInA);
      const toBackNode = planar(exit, abTriggerInA);
      diagnostics.measured.lobby_to_A_mapped_exit = exit;
      diagnostics.measured.lobby_exit_to_counterpart_m = Number(toCounterpart.toFixed(4));
      diagnostics.measured.lobby_exit_to_back_node_m = Number(toBackNode.toFixed(4));
      assertOk(toCounterpart <= 1.5, `mapped exit is ${toCounterpart.toFixed(3)} m from the counterpart (must be <= 1.5, a front standoff)`);
      assertOk(toBackNode >= 5.0, `mapped exit is only ${toBackNode.toFixed(3)} m from the A<->B back node (must be >= 5.0 — the defect landed HERE)`);
      // front-side, laterally centred on the counterpart aperture
      const local = portalLocalCoordinates(lobbyTargetFrame, exit);
      assertOk(local.signed_plane_distance_m > 0, "mapped exit must be on the counterpart's FRONT side");
      assertOk(Math.abs(local.x) <= 0.6, `mapped exit lateral ${local.x.toFixed(3)} m off the counterpart centreline (must be <= 0.6)`);
    });
    await check("E2b", "after P3 exit-distance parity the landing STAYS at the counterpart (within parity distance)", () => {
      assertOk(lobbyRun.parity.supported, `parity unsupported: ${lobbyRun.parity.reason}`);
      const landing = lobbyRun.parity.adjusted_position;
      const toCounterpart = planar(landing, lobbyCounterpartTriggerInA);
      const toBackNode = planar(landing, abTriggerInA);
      diagnostics.measured.lobby_to_A_parity_landing = landing;
      diagnostics.measured.lobby_parity_to_counterpart_m = Number(toCounterpart.toFixed(4));
      assertOk(toCounterpart <= 1.5, `parity landing is ${toCounterpart.toFixed(3)} m from the counterpart (must be <= 1.5)`);
      assertOk(toBackNode >= 5.0, `parity landing is only ${toBackNode.toFixed(3)} m from the A<->B back node (must be >= 5.0)`);
      const standoff = portalLocalCoordinates(lobbyTargetFrame, landing).signed_plane_distance_m;
      assertOk(standoff > 0, "parity landing must be on the counterpart FRONT side");
    });

    // ---- E3: ORACLE TEETH — the RETIRED fabric-first-node derivation lands at
    // the WRONG portal (reproduces the 5.6 m defect); a revert FAILS here -----
    await check("E3", "the retired fabric-first-node exit lands ~4.9 m away AT the A<->B portal (defect reproduced; fix is load-bearing)", () => {
      const { first } = firstAttachmentNode(fabricA);
      assertOk(first, "A fabric has no attachment node");
      const firstPos = first.Transform.Position;
      // The FIRST node is the A<->B portal — the wrong one for a lobby->A walk.
      close(planar(firstPos, abTriggerInA), 0, 0.05, "first attachment node is the A<->B portal");
      const cam = fabricA.primary && fabricA.primary.camera ? fabricA.primary.camera.position : [0, 0, 0.4];
      const retired = retiredFabricNodeExit(firstPos, cam, lobbyRun.mapping);
      const retiredToCounterpart = planar(retired, lobbyCounterpartTriggerInA);
      const retiredToBackNode = planar(retired, abTriggerInA);
      const divergence = planar(retired, lobbyRun.mapping.mapped_exit_transform.position);
      diagnostics.measured.retired_exit = retired.map((v) => Number(v.toFixed(4)));
      diagnostics.measured.retired_to_counterpart_m = Number(retiredToCounterpart.toFixed(4));
      diagnostics.measured.retired_to_back_node_m = Number(retiredToBackNode.toFixed(4));
      diagnostics.measured.retired_vs_fix_divergence_m = Number(divergence.toFixed(4));
      // The retired landing sits ~1 m in front of the A<->B (back) node, so it is
      // ~4.9 m from the counterpart the player actually walked to (the defect
      // filing's own "4.8 m from the portal actually traversed"); the two
      // attachment nodes are 5.6 m apart (E1).
      assertOk(retiredToBackNode <= 1.5, `retired exit ${retiredToBackNode.toFixed(3)} m from the A<->B back node (defect lands AT it, <= 1.5)`);
      assertOk(retiredToCounterpart >= 4.5, `retired exit only ${retiredToCounterpart.toFixed(3)} m from counterpart — defect not reproduced (expected the ~4.9 m wrong-portal landing)`);
      assertOk(divergence >= 4.5, `fix and retired path diverge by only ${divergence.toFixed(3)} m (must be >= 4.5 — the wrong-portal distance)`);
    });

    // ---- E4: A->B is PRESERVED (its counterpart already was the first node),
    // and the e2e-driver oracle reconstruction matches the shipping
    // frame-based landing (geometry-verifies the load-deferred battery fix) ---
    const abRegion = await regionForEntry(aPortalToB);
    const abTargetFrame = adoptedTargetFrame(aPortalToB, abRegion.portal); // location-b-portal in B
    const abRun = crossingFor(preview, aPortalToB, abTargetFrame, 0.033, 0.2);
    await check("E4a", "A->B frame-mapped exit lands at location-b-portal's counterpart (unchanged edge stays correct)", () => {
      const exit = abRun.mapping.mapped_exit_transform.position;
      const bCounterpartTrigger = abTargetFrame.ground_center;
      const toCounterpart = planar(exit, bCounterpartTrigger);
      diagnostics.measured.a_to_B_mapped_exit = exit;
      diagnostics.measured.a_to_B_exit_to_counterpart_m = Number(toCounterpart.toFixed(4));
      assertOk(toCounterpart <= 1.5, `A->B exit ${toCounterpart.toFixed(3)} m from its counterpart (must be <= 1.5)`);
    });
    await check("E4b", "e2e-driver oracle (frame_forward reconstruction) == the shipping A->B parity landing (±0.08 m)", () => {
      const { first } = firstAttachmentNode(fabricB);
      assertOk(first, "B fabric has no attachment node");
      // Exactly what the updated e2e-driver oracle computes:
      const bFrame = portalFrameForLocation({ locationId: "location-b", triggerPosition: first.Transform.Position });
      close(planar(bFrame.forward, [-1, 0, 0]), 0, 1e-6, "location-b frame forward is [-1,0,0] (frame-consistent oracle basis)");
      const anchor = bFrame.ground_center;
      const dir = bFrame.forward;
      const right = [dir[2], 0, -dir[0]];
      const standoff = abRun.parity.parity_standoff_m;
      const lateral = Number(abRun.mapping.mapped_lateral_offset_m) || 0;
      const oracleExpected = [
        anchor[0] + dir[0] * standoff + right[0] * lateral,
        0,
        anchor[2] + dir[2] * standoff + right[2] * lateral,
      ];
      const landing = abRun.parity.adjusted_position;
      const gap = planar(oracleExpected, landing);
      diagnostics.measured.ab_oracle_expected = oracleExpected.map((v) => Number(v.toFixed(4)));
      diagnostics.measured.ab_parity_landing = landing.map((v) => Number(v.toFixed(4)));
      diagnostics.measured.ab_oracle_gap_m = Number(gap.toFixed(4));
      assertOk(gap <= 0.08, `oracle reconstruction ${gap.toFixed(4)} m from the shipping landing (e2e tol 0.08 m)`);
    });

    // ---- E5: the RETURN (A -> lobby) lands IN FRONT of the entered portal ---
    await check("E5", "A->lobby return lands in front of lobby-portal-a (the entered portal), not portal-b", async () => {
      const returnRegion = await regionForEntry(aPortalToLobby);
      const returnTargetFrame = adoptedTargetFrame(aPortalToLobby, returnRegion.portal); // lobby-portal-a pose
      const run = crossingFor(preview, aPortalToLobby, returnTargetFrame, 0.033, 0.15);
      assertOk(run.parity.supported, `return parity unsupported: ${run.parity.reason}`);
      const landing = run.parity.adjusted_position;
      const toEntered = planar(landing, lobbyPortalA.trigger.position);
      const toOther = planar(landing, lobbyPortalB.trigger.position);
      const standoff = portalLocalCoordinates(returnTargetFrame, landing).signed_plane_distance_m;
      diagnostics.measured.return_landing = landing.map((v) => Number(v.toFixed(4)));
      diagnostics.measured.return_to_entered_portal_m = Number(toEntered.toFixed(4));
      assertOk(standoff > 0, "return landing must be on lobby-portal-a's FRONT side (in front of the aperture)");
      assertOk(toEntered <= (Number(lobbyPortalA.trigger.radius_m) || 1.25) + 0.6, `return landing ${toEntered.toFixed(3)} m from lobby-portal-a (must be inside its aperture standoff)`);
      assertOk(toOther > 2.0, `return landing only ${toOther.toFixed(3)} m from lobby-portal-b (must be > 2.0 — not the other portal)`);
    });

    // ---- E6: SOURCE TRIPWIRE — the fix is present and the app.js #5 tripwire
    // source string is intact (a revert to fabric-node-primary breaks this) ---
    await check("E6", "live-adapter.js resolves the exit from the frame-mapping counterpart before the fabric-node path; fallback tripwire string intact", () => {
      const src = readFileSync(resolve(repoRoot, "web/live-adapter.js"), "utf8");
      const primaryIdx = src.indexOf("this._counterpartExitPoseFromFrameMapping(frameMapping, mapped, root)");
      const helperIdx = src.indexOf('source: "traversed_edge_counterpart_frame_mapping"');
      const fabricNodeIdx = src.indexOf("const portalBack = root ? findFabricPortalAttachmentNode(root) : null;");
      assertOk(primaryIdx > 0, "primary counterpart branch missing from _fabricDerivedExitPose");
      assertOk(helperIdx > 0, "counterpart exit method does not return the traversed_edge_counterpart_frame_mapping source");
      assertOk(fabricNodeIdx > 0, "fabric-node fallback path unexpectedly absent");
      assertOk(primaryIdx < fabricNodeIdx, "counterpart branch must run BEFORE the fabric-first-node path (else the defect returns)");
      const methodIdx = src.indexOf("_counterpartExitPoseFromFrameMapping(frameMapping, mapped, root) {");
      assertOk(methodIdx > 0, "counterpart exit method definition missing");
      const methodBody = src.slice(methodIdx, methodIdx + 2000);
      assertOk(
        methodBody.includes("mapped.position") && methodBody.includes("target_portal_frame"),
        "counterpart method must derive the exit from the frame mapping's mapped_exit_transform position + target_portal_frame",
      );
      // app.js #5 tripwire keys on this exact fallback source string.
      assertOk(
        src.includes('source: "portal_frame_mapping_fallback"'),
        "the world.arrival fallback source string (app.js exit-arrival-fallback tripwire) must remain intact",
      );
    });
  } finally {
    for (const server of servers) {
      try {
        await server.closeAll();
      } catch (e) {
        /* best effort */
      }
    }
    await cleanup();
  }

  diagnostics.checks = results;
  diagnostics.finished_at = new Date().toISOString();
  diagnostics.passed = passed;
  diagnostics.failed = failed;
  diagnostics.verdict = failed === 0 ? "PASS" : "FAIL";
  const evidencePath = resolve(repoRoot, "diagnostics/portal-live-landing-counterpart.json");
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(diagnostics, null, 2)}\n`);
  console.log(`\n${diagnostics.verdict}: ${passed} passed, ${failed} failed`);
  console.log(`diagnostics: ${evidencePath}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`runtime validation crashed: ${err.stack || err.message}`);
  process.exit(1);
});
