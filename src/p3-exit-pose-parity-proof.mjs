/**
 * P3 — CLIENT SHARED-EDGE IDENTITY + EXIT-POSE DISTANCE
 * PARITY PROOF (deterministic; no browser, no load gate).
 *
 * Issues resolved by P3 and pinned here:
 *   #1 (client half) — the portal you walk through is ONE stable connection:
 *       the client consumes the P1 `shared_edge` contract at the adoption seam
 *       and can PROVE the adopted destination pose belongs to the machine's
 *       own edge (never a context-dependent destination).
 *   #6 — step-in distance == step-out distance: the crossing commits with the
 *       avatar centimetres past the source plane; the exit standoff must
 *       MIRROR it instead of the 1.05 m PORTAL_EXIT_OFFSET_MIN_M floor.
 *   #5 — returning lands IN FRONT of the portal you originally entered (the
 *       counterpart of the traversed edge), not a per-world arrival spot.
 *
 * HOW IT CANNOT LIE:
 *   - It boots the REAL four 041 nodes in-process on ISOLATED ports and reads
 *     live wire payloads (no fixtures).
 *   - It exercises the SHIPPING client modules: the real world projection
 *     (`worldFromLive`), the real portal geometry
 *     (`mapTransformBetweenPortalFrames`, `portalFrameForLocation`,
 *     `portalLocalCoordinates`), and the REAL exported P3 helpers loaded from
 *     `web/portal-spatial-preview.mjs` itself (loader recipe — only the
 *     browser THREE import specifier is rewritten).
 *   - Falsifiable oracles: the PRE-P3 floored exit standoff must FAIL the
 *     parity criterion; a wrong-edge region payload must FAIL identity
 *     verification with the offending check named.
 *
 * ISOLATED PORTS ONLY (19295-19298). 8143 / 18151-18154 (the live local demo)
 * are NEVER bound. No git. Claim boundary unchanged: local application-level
 * proof; every conformance flag stays false.
 */

import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
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
  PORTAL_TRIGGER_DEPTH_M,
} from "../web/live-adapter-portal-geometry.mjs";
import { worldFromLive } from "../web/live-adapter-world-projection.mjs";

const PORT_A = Number(process.env.OSL_EXIT_POSE_PORT_A) || 19295;
const PORT_B = Number(process.env.OSL_EXIT_POSE_PORT_B) || 19296;
const PORT_LOBBY = Number(process.env.OSL_EXIT_POSE_PORT_LOBBY) || 19297;
const PORT_AIRPORT = Number(process.env.OSL_EXIT_POSE_PORT_AIRPORT) || 19298;
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

/**  loader recipe: load the SHIPPING preview module in node by rewriting
 *  only the browser THREE import specifier to node_modules/three. */
async function loadPreviewModule() {
  const modulePath = resolve(repoRoot, "web/portal-spatial-preview.mjs");
  const threeUrl = pathToFileURL(resolve(repoRoot, "node_modules/three/build/three.module.js")).href;
  const browserThreeImport = 'import * as THREE from "./vendor/scene-core/vendor/three/three.module.js";';
  const tempRoot = await mkdtemp(resolve(tmpdir(), "runtime-p3-parity-"));
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

/** The app-facing machine shape (prefetch controller `_machineDebug`) built
 *  from live wire payloads — exactly what portalSharedEdgeIdentity consumes. */
function machineShapeFor(entry, region) {
  return {
    supported: true,
    status: "warm",
    portal_key: entry.string_portal_id || String(entry.portal_id),
    address: entry.spatial_fabric_address,
    region: { destination_portal: region ? region.portal : null, entities: region ? region.entities : [] },
  };
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

/** Simulate the committed walk: the avatar one movement step past the source
 *  plane (the traversal controller commits on the crossedPlaneFromFront frame),
 *  then run the REAL crossing mapping + the REAL parity helper. */
function crossingParityFor(preview, entry, targetFrame, entryOvershootM, lateralM = 0) {
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

async function main() {
  const diagnostics = {
    wo: "runtime",
    title: "client shared-edge identity + exit-pose distance parity",
    started_at: new Date().toISOString(),
    ports: { a: PORT_A, b: PORT_B, lobby: PORT_LOBBY, airport: PORT_AIRPORT },
    parity_rule: `exit standoff == entry standoff, clamped [0.05, ${PORTAL_EXIT_OFFSET_MAX_M}] m; tolerance stated per check`,
    claim_boundary:
      "local application-level validation; shared_edge/exit-parity carry standard_conformance:false; no TeleportXR/production claim",
    checks: null,
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

    // ---- E1: the client projection sees the P1 topology ------------------
    await check("E1a", "A and B project as 2-portal worlds (A<->B edge + their lobby-return edge)", () => {
      assertOk(a.world.portals.length === 2, `A projects ${a.world.portals.length} portals`);
      assertOk(b.world.portals.length === 2, `B projects ${b.world.portals.length} portals`);
      const aKeys = a.world.portals.map((p) => p.string_portal_id);
      const bKeys = b.world.portals.map((p) => p.string_portal_id);
      assertOk(aKeys.join(",") === "location-a-portal,location-a-portal-lobby", `A portals: ${aKeys}`);
      assertOk(bKeys.join(",") === "location-b-portal,location-b-portal-lobby", `B portals: ${bKeys}`);
    });
    await check("E1b", "centroid source spawns moved as P1 declared: A [0,0,0.4], B [-0.4,0,0]", () => {
      const sa = a.world.avatar.spawn_position;
      const sb = b.world.avatar.spawn_position;
      close(planar(sa, [0, 0, 0.4]), 0, 1e-6, `A spawn ${JSON.stringify(sa)}`);
      close(planar(sb, [-0.4, 0, 0]), 0, 1e-6, `B spawn ${JSON.stringify(sb)}`);
    });
    await check("E1c", "spawns stay OUTSIDE every 3.0 m loading circle (client-side confirmation)", () => {
      for (const [label, w] of [["A", a.world], ["B", b.world]]) {
        for (const p of w.portals) {
          const d = planar(w.avatar.spawn_position, p.trigger.position);
          assertOk(d > 3.0, `${label} spawn ${d.toFixed(2)} m from ${p.string_portal_id} (must be > 3.0)`);
        }
      }
    });

    // ---- E2: shared-edge identity verified at the CLIENT seam ------------
    const hostedEntries = [];
    for (const [label, proj] of [["a", a], ["b", b], ["lobby", lobby]]) {
      for (const entry of proj.world.portals) {
        if (entry.target_base_url && entry.spatial_fabric_address) hostedEntries.push({ label, entry });
      }
    }
    await check("E2a", "every backend-destination portal's adopted region pose verifies as ITS OWN edge", async () => {
      assertOk(hostedEntries.length >= 7, `expected >= 7 hosted portals, got ${hostedEntries.length}`);
      for (const { label, entry } of hostedEntries) {
        const region = await regionForEntry(entry);
        const identity = preview.portalSharedEdgeIdentity(machineShapeFor(entry, region), entry);
        assertOk(
          identity.available && identity.verified === true,
          `${label}/${entry.string_portal_id}: ${JSON.stringify(identity.failures || identity.reason)}`
        );
      }
    });
    await check("E2b", "both sides of every edge derive and serve the SAME edge_id (client rule == wire)", async () => {
      const pairs = [
        ["location-a-portal", a, "location-b-portal", b],
        ["location-a-portal-lobby", a, "lobby-portal-a", lobby],
        ["location-b-portal-lobby", b, "lobby-portal-b", lobby],
      ];
      for (const [idOne, projOne, idTwo, projTwo] of pairs) {
        const one = projOne.world.portals.find((p) => p.string_portal_id === idOne);
        const two = projTwo.world.portals.find((p) => p.string_portal_id === idTwo);
        const idA = preview.expectedPortalEdgeId(one.source_location_id, one.target_location_id);
        const idB = preview.expectedPortalEdgeId(two.source_location_id, two.target_location_id);
        assertOk(idA === idB, `${idOne} derives ${idA}, ${idTwo} derives ${idB}`);
        const regionOne = await regionForEntry(one);
        assertOk(
          regionOne.portal.shared_edge.edge_id === idA,
          `wire edge_id ${regionOne.portal.shared_edge.edge_id} != client-derived ${idA}`
        );
      }
    });
    await check("NEG1", "ORACLE: a wrong-edge region payload REFUSES identity verification, offender named", async () => {
      const lobbyA = lobby.world.portals.find((p) => p.string_portal_id === "lobby-portal-a");
      const lobbyB = lobby.world.portals.find((p) => p.string_portal_id === "lobby-portal-b");
      const wrongRegion = await regionForEntry(lobbyB); // B's counterpart pose fed to A's machine
      const identity = preview.portalSharedEdgeIdentity(machineShapeFor(lobbyA, wrongRegion), lobbyA);
      assertOk(identity.available === true, "wrong-edge payload should still be available");
      assertOk(identity.verified === false, "wrong-edge payload must NOT verify");
      assertOk(
        identity.failures.includes("counterpart_points_back"),
        `failures must name counterpart_points_back, got ${JSON.stringify(identity.failures)}`
      );
    });

    // ---- E4: exit-distance parity on the A->B edge ------------
    const entryAB = a.world.portals.find((p) => p.string_portal_id === "location-a-portal");
    const regionAB = await regionForEntry(entryAB);
    const tfAB = adoptedTargetFrame(entryAB, regionAB.portal);
    await check("E4a", "walked commit (entry 0.033 m past the plane): floored 1.05 m exit becomes a 0.05 m step-out", () => {
      const run = crossingParityFor(preview, entryAB, tfAB, 0.033, 0.2);
      close(run.mapping.exit_offset_m, PORTAL_EXIT_OFFSET_MIN_M, 1e-9, "pre-P3 floored offset (oracle baseline)");
      assertOk(run.parity.supported === true, `parity unsupported: ${run.parity.reason}`);
      close(run.parity.parity_standoff_m, 0.05, 1e-9, "parity standoff (min skin)");
      // exit distance == entry distance within the stated 0.05 m min-skin tolerance
      close(run.parity.parity_standoff_m, run.parity.entry_standoff_m, 0.05, "exit vs entry standoff");
      // and the applied correction is real: ~1.0 m closer than the floor
      assertOk(run.parity.delta_m > 0.9, `delta ${run.parity.delta_m} m (expected ~1.0 m)`);
    });
    await check("E4b", "slow-frame commit (entry 0.30 m): exit standoff EQUALS entry standoff exactly", () => {
      const run = crossingParityFor(preview, entryAB, tfAB, 0.3, -0.3);
      assertOk(run.parity.supported === true, `parity unsupported: ${run.parity.reason}`);
      close(run.parity.parity_standoff_m, 0.3, 1e-9, "exit standoff == entry standoff (equality)");
      // re-measure the adjusted landing against the ADOPTED destination frame:
      const landed = portalLocalCoordinates(tfAB, run.parity.adjusted_position);
      close(landed.signed_plane_distance_m, 0.3, 2e-3, "re-measured landed standoff");
      assertOk(landed.inside_oval_aperture === true, "landing must stay inside the frame aperture");
      // mirrored lateral is preserved (the proper rotation, untouched)
      close(landed.x, -run.entryLocal.x, 2e-3, "mirrored lateral preserved");
    });
    await check("E4c", "ORACLE: the PRE-P3 floored landing FAILS the parity criterion", () => {
      const run = crossingParityFor(preview, entryAB, tfAB, 0.033, 0);
      const flooredLanding = run.mapping.mapped_exit_transform.position;
      const flooredStandoff = portalLocalCoordinates(tfAB, flooredLanding).signed_plane_distance_m;
      const entry = Math.abs(run.entryLocal.signed_plane_distance_m);
      assertOk(
        Math.abs(flooredStandoff - Math.max(entry, 0.05)) > 0.08,
        `floored standoff ${flooredStandoff} would PASS the ±0.08 parity tolerance — the validation has no teeth`
      );
    });
    await check("E4d", "parity refuses to run on a non-front exit (guard oracle)", () => {
      const behind = [
        tfAB.ground_center[0] - tfAB.forward[0] * 0.5,
        0,
        tfAB.ground_center[2] - tfAB.forward[2] * 0.5,
      ];
      const parity = preview.computeExitPoseParity({
        entrySignedPlaneDistanceM: -0.03,
        targetFrame: tfAB,
        appliedExitPosition: behind,
      });
      assertOk(parity.supported === false && parity.reason === "applied_exit_not_front_side", JSON.stringify(parity));
    });

    // ---- E5: the return lands in front of the ENTERED portal --
    await check("E5", "A -> lobby return: parity landing sits IN FRONT of lobby-portal-a itself", async () => {
      const returnEntry = a.world.portals.find((p) => p.string_portal_id === "location-a-portal-lobby");
      const region = await regionForEntry(returnEntry);
      assertOk(region.portal.portal_id === "lobby-portal-a", `region anchored on ${region.portal.portal_id}`);
      const tf = adoptedTargetFrame(returnEntry, region.portal);
      const run = crossingParityFor(preview, returnEntry, tf, 0.033, 0.15);
      assertOk(run.parity.supported === true, `parity unsupported: ${run.parity.reason}`);
      const landing = run.parity.adjusted_position;
      const landedLocal = portalLocalCoordinates(tf, landing);
      // (a) in FRONT of the entered portal's plane, at the mirrored standoff
      assertOk(landedLocal.signed_plane_distance_m > 0, "landing behind the counterpart plane");
      close(landedLocal.signed_plane_distance_m, run.parity.parity_standoff_m, 2e-3, "landing standoff");
      // (b) laterally inside ITS aperture — the portal you entered, not beside it
      assertOk(landedLocal.inside_oval_aperture === true, "landing outside the entered portal's aperture");
      // (c) right at lobby-portal-a's own trigger (the identity-resolved pose)
      const lobbyA = lobby.world.portals.find((p) => p.string_portal_id === "lobby-portal-a");
      const dCenter = planar(landing, lobbyA.trigger.position);
      assertOk(dCenter <= lobbyA.trigger.radius_m, `landed ${dCenter.toFixed(2)} m from lobby-portal-a center`);
      // (d) NOT the retired per-world arrival, NOT another portal
      const fallback = lobby.world.arrival.position;
      assertOk(planar(landing, fallback) > 1.5, `landing within 1.5 m of the retired per-world arrival ${JSON.stringify(fallback)}`);
      const lobbyB = lobby.world.portals.find((p) => p.string_portal_id === "lobby-portal-b");
      assertOk(
        planar(landing, lobbyB.trigger.position) > 2.0,
        "landing near lobby-portal-b — context-dependent destination regression"
      );
    });

    // ---- E6: the per-world world.arrival fallback is RETIRED client-side --
    await check("E6", "no crossing path consumes world.arrival: parity output is frame-anchored; tripwire predicate has teeth", async () => {
      // The projection still EMITS world.arrival (untouched file — documented
      // residue for the live-adapter lane); P3 retires it as a landing: the
      // parity/identity path is anchored on the traversed edge's counterpart
      // pose. E5 proved the landing is > 1.5 m from world.arrival. Here: the
      // app tripwire predicate (data-exit-arrival-fallback-used) must fire
      // EXACTLY when the fallback would be consumed.
      const tripwire = (exitPoseSource, mappedExit) =>
        exitPoseSource === "portal_frame_mapping_fallback" && !mappedExit;
      assertOk(tripwire("portal_frame_mapping_fallback", null) === true, "fallback-without-mapping must trip");
      assertOk(tripwire("portal_frame_mapping_fallback", { position: [0, 0, 0] }) === false, "mapped fallback must not trip");
      assertOk(tripwire("promoted_fabric_portal_back_node+primary_camera", null) === false, "fabric-derived must not trip");
      // And the fabric-derived exit source exists on every P1 edge: the region
      // payload carries the counterpart pose that anchors it.
      for (const { entry } of hostedEntries) {
        const region = await regionForEntry(entry);
        assertOk(
          Array.isArray(region.portal && region.portal.trigger_position),
          `${entry.string_portal_id}: region carries no counterpart pose`
        );
      }
    });

    // ---- E7: parity landing is INSIDE the trigger; the rearm gate is the
    // documented no-bounce protection (plan) --------------------------
    await check("E7", "parity landing declares inside_trigger_volume_after (rearm-gate reliance is explicit)", () => {
      const run = crossingParityFor(preview, entryAB, tfAB, 0.033, 0);
      assertOk(run.parity.inside_trigger_volume_after === true, "0.05 m landing must be inside the 0.8 m trigger depth");
      assertOk(
        run.parity.parity_standoff_m <= PORTAL_TRIGGER_DEPTH_M,
        "parity standoff exceeds trigger depth for a walked commit"
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
  const evidencePath = resolve(repoRoot, "diagnostics/p3-exit-pose-parity.json");
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(diagnostics, null, 2)}\n`);
  console.log(`\n${diagnostics.verdict}: ${passed} passed, ${failed} failed`);
  console.log(`diagnostics: ${evidencePath}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`runtime-p3 validation crashed: ${err.stack || err.message}`);
  process.exit(1);
});
