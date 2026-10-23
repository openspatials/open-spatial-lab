#!/usr/bin/env node
/**
 * P4 — BIDIRECTIONAL BOTH-SIDES RENDER (#2 render half)
 * + PERIMETER SUBSCRIPTION GATE (#7) — deterministic proof.
 *
 * What is pinned here, against the SHIPPING modules (no lookalike logic):
 *
 *  #7 perimeter gate (SECTION 1) — drives the REAL FabricPrefetchController
 *  (injected clock/timers/fetch counter) against the REAL 041 nodes booted
 *  in-process on isolated ports, feeding its own machine projections into the
 *  REAL portalPerimeterLiveGate / machineRenderable:
 *   - the live-vs-image verdict flips EXACTLY on the controller's perimeter
 *     circle (enter at radius_m, leave at radius_m x hysteresis), walking in
 *     AND walking out — never at a region-TTL moment (the pre-P4 arbitrary
 *     flip). Exactly ONE live->image transition in the whole walk-away, at
 *     the boundary tick.
 *   - ORACLE TEETH: at the first outside tick the machine is cooling with a
 *     FRESH payload — the pre-P4 status-only rule says LIVE, the shipped rule
 *     says IMAGE. A revert cannot pass.
 *   - leaving the circle also STOPS the server subscription (region pipeline
 *     cancelled/cooling recorded; the presence refresher only serves warm
 *     machines): zero new fetches after the exit tick.
 *   - a zone-less synthetic always-warm machine (the retired
 *     serverBApertureMachine shape) can NEVER be live, and app.js no longer
 *     substitutes it for lobby-portal-b.
 *
 *  #2 both-sides render (SECTION 2) — drives the REAL
 *  SpatialPortalPreviewManager (loader recipe; stub GL renderer — all
 *  geometry/clip/camera math is the shipping code, only the final GPU draw is
 *  a no-op) with the controller's own warm machine projection:
 *   - FRONT viewer: arms + maps exactly as pre-P4 (glued camera equals the
 *     canonical glueCameraThroughFrames output; clip plane constant equals
 *     the pre-P4 construction; destination FRONT half-space kept).
 *   - BACK viewer of a bidirectional portal: NOW arms and maps with the SAME
 *     proper 180° isometry (pre-P4 refused it — asserted as teeth), the clip
 *     plane FLIPS to keep the destination BACK half-space, and the
 *     destination ring at the plane stays visible from both faces.
 *   - window == crossing continuity, BOTH directions of the reciprocal edge:
 *     the half-space each face shows is the half-space the REAL crossing
 *     mapping (mapTransformBetweenPortalFrames + P3 exit-pose parity) leaves
 *     the avatar looking into, and both entries exit on the destination's
 *     front side — the correct opposite side of the connection.
 *   - one-way portals still refuse their blocked side (portal-direction
 *     battery's client rule, unchanged).
 *   - the manager's own perimeter seam: the SAME machine with zone.inside
 *     false is refused with `outside_portal_perimeter` and the armed record
 *     deactivates — the live->image flip at the render surface.
 *
 * Never touches 8143/18151-18154 (protected live demo).
 * Claim boundary: local application-level proof; perimeter_gate/spatial
 * render carry *_standard_conformance:false; no TeleportXR/production claim.
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
  fabricPortalKey,
  glueCameraThroughFrames,
  mapTransformBetweenPortalFrames,
  normalizePortalTraversal,
  portalEntrySideAllowed,
  portalFrameForLocation,
  portalLocalCoordinates,
} from "../web/live-adapter-portal-geometry.mjs";
import { worldFromLive } from "../web/live-adapter-world-projection.mjs";
import { FabricPrefetchController } from "../web/live-adapter-fabric-prefetch-controller.mjs";

const PORT_A = Number(process.env.OSL_PERIMETER_PORT_A) || 19305;
const PORT_B = Number(process.env.OSL_PERIMETER_PORT_B) || 19306;
const PORT_LOBBY = Number(process.env.OSL_PERIMETER_PORT_LOBBY) || 19307;
const PORT_AIRPORT = Number(process.env.OSL_PERIMETER_PORT_AIRPORT) || 19308;
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
  const tempRoot = await mkdtemp(resolve(tmpdir(), "runtime-p4-render-"));
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
  const THREE = await import(threeUrl);
  return { mod, THREE, cleanup: () => rm(tempRoot, { recursive: true, force: true }) };
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJsonHttp(url) {
  const r = await get(url);
  assertOk(r.status === 200, `${url} -> ${r.status}`);
  return r.json;
}

async function fetchWorldProjection(base, role) {
  const wowWorld = await getJsonHttp(`${base}/wow/world`);
  const listed =
    wowWorld.webofworlds_extension && Array.isArray(wowWorld.webofworlds_extension.portals)
      ? wowWorld.webofworlds_extension.portals
      : [];
  const wowPortals = [];
  for (const entry of listed) {
    wowPortals.push(await getJsonHttp(`${base}/wow/portal/${entry.id}`));
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
  return getJsonHttp(url);
}

/** The adoption seam recipe (what _adoptDestinationPortalPoseForMachine
 *  produces): the REAL portalFrameForLocation over the region's destination
 *  portal pose. */
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

/** Avatar position on the given side of a portal frame at planar distance d. */
function positionOnSide(frame, side, distanceM, lateralM = 0) {
  const sgn = side === "back" ? -1 : 1;
  return [
    frame.position[0] + frame.forward[0] * sgn * distanceM + frame.right[0] * lateralM,
    0,
    frame.position[2] + frame.forward[2] * sgn * distanceM + frame.right[2] * lateralM,
  ];
}

async function main() {
  const diagnostics = {
    wo: "runtime",
    title: "bidirectional both-sides render (#2) + perimeter subscription gate (#7)",
    started_at: new Date().toISOString(),
    ports: { a: PORT_A, b: PORT_B, lobby: PORT_LOBBY, airport: PORT_AIRPORT },
    claim_boundary:
      "local application-level validation; perimeter gate and spatial render carry " +
      "*_standard_conformance:false; no TeleportXR/production/standards claim",
    checks: null,
  };

  const servers = [];
  const { mod: preview, THREE, cleanup } = await loadPreviewModule();
  try {
    servers.push(await start("a", { bind_port: PORT_A, portals: isolatedPortals("a") }));
    servers.push(await start("b", { bind_port: PORT_B, portals: isolatedPortals("b") }));
    servers.push(await start("lobby", { bind_port: PORT_LOBBY, portals: isolatedPortals("lobby") }));
    servers.push(await start("airport", { bind_port: PORT_AIRPORT, portals: isolatedPortals("airport") }));

    const baseLobby = `http://127.0.0.1:${PORT_LOBBY}`;
    const baseA = `http://127.0.0.1:${PORT_A}`;

    const lobby = await fetchWorldProjection(baseLobby, "player");
    const a = await fetchWorldProjection(baseA, "player");

    // ================= SECTION 1 — the REAL prefetch controller ============
    // Injected clock + captured intervals + counted fetches; everything else
    // is the shipping controller against the shipping 041 responses.
    let nowMsValue = 1_000_000;
    const intervals = [];
    const fetchLog = [];
    const controller = new FabricPrefetchController({
      getJson: async (url) => {
        fetchLog.push({ url, at_ms: nowMsValue });
        return getJsonHttp(url);
      },
      nowMs: () => nowMsValue,
      nowIso: () => new Date(nowMsValue).toISOString(),
      setIntervalFn: (fn, ms) => {
        const handle = { fn, ms, cleared: false };
        intervals.push(handle);
        return handle;
      },
      clearIntervalFn: (handle) => {
        if (handle) handle.cleared = true;
      },
      // Real (compressed) timeouts so the async pipeline actually runs.
      setTimeoutFn: (fn, ms) => setTimeout(fn, Math.min(Number(ms) || 0, 5)),
      resolveProxyBase: (address) =>
        address && address.uri && address.uri.includes("location-a")
          ? baseA
          : address && address.uri
            ? `http://127.0.0.1:${PORT_BY_LOCATION[
                Object.keys(PORT_BY_LOCATION).find((loc) => address.uri.includes(loc))
              ] || PORT_A}`
            : null,
      portalKey: fabricPortalKey,
      normalizeTraversal: normalizePortalTraversal,
      portalEntrySideAllowed,
      getAvatarPose: () => ({ position: avatarPos.slice() }),
    });

    const focusEntry = lobby.world.portals.find((p) => p.string_portal_id === "lobby-portal-a");
    assertOk(focusEntry, "lobby world has no lobby-portal-a");
    const focusKey = fabricPortalKey(focusEntry);
    const radius = Number(focusEntry.zones && focusEntry.zones.prefetch && focusEntry.zones.prefetch.radius_m);
    const hysteresis =
      Number(focusEntry.zones && focusEntry.zones.prefetch && focusEntry.zones.prefetch.hysteresis_ratio) || 1.15;
    const exitRadius = radius * hysteresis;
    let avatarPos = positionOnSide(focusEntry.frame, "front", radius + 3);

    controller.reset({ reason: "init", world: lobby.world, clientMode: "player" });

    const tick = (distanceM, side = "front") => {
      avatarPos = positionOnSide(focusEntry.frame, side, distanceM);
      controller.update({
        avatar: { position: avatarPos.slice() },
        evaluations: lobby.world.portals.map((portal) => ({
          portal,
          portal_key: fabricPortalKey(portal),
          portalCenter: portal.frame.position,
          local: portalLocalCoordinates(portal.frame, avatarPos),
          traversal: normalizePortalTraversal(portal.traversal),
        })),
        focusPortalId: focusKey,
        world: lobby.world,
        clientMode: "player",
      });
      const machine = controller.debug({ focusPortalId: focusKey }).keyed.machines[focusKey];
      return {
        distance_m: distanceM,
        machine,
        gate: preview.portalPerimeterLiveGate(machine),
        renderable: preview.SpatialPortalPreviewManager.machineRenderable(machine),
      };
    };

    await check("E0", `lobby-portal-a machine is supported with a real perimeter (radius ${radius} m)`, () => {
      const t = tick(radius + 3);
      assertOk(t.machine && t.machine.supported === true, "machine unsupported");
      assertOk(Number.isFinite(radius) && radius > 0, `no zones.prefetch.radius_m (${radius})`);
      assertOk(t.gate.live === false && t.gate.reason === "outside_portal_perimeter", JSON.stringify(t.gate));
      assertOk(t.gate.radius_m === radius && Math.abs(t.gate.exit_radius_m - exitRadius) < 1e-6,
        `gate radii ${t.gate.radius_m}/${t.gate.exit_radius_m} != ${radius}/${exitRadius}`);
    });

    await check("E1a", "walking IN: the gate flips image->live-eligible exactly at radius_m (not before)", () => {
      const seq = [radius + 1, radius + 0.05, radius - 0.05, radius - 0.5].map((d) => tick(d));
      const insides = seq.map((t) => t.gate.inside);
      assertOk(String(insides) === "false,false,true,true",
        `inside sequence ${insides} across distances ${seq.map((t) => t.distance_m)}`);
      // eligibility (perimeter term) flips exactly with zone.inside
      assertOk(seq.every((t) => (t.gate.live === (t.gate.inside === true))), "gate.live != zone.inside");
    });

    // Let the REAL pipeline warm the machine from the REAL region endpoint.
    let warmMachine = null;
    for (let i = 0; i < 100; i += 1) {
      const m = controller.debug({ focusPortalId: focusKey }).keyed.machines[focusKey];
      if (m && m.status === "warm") { warmMachine = m; break; }
      await sleep(100);
    }

    await check("E1b", "inside the circle the machine warms from the real 041 region and is LIVE-renderable", () => {
      assertOk(warmMachine, "machine never warmed inside the circle");
      assertOk(warmMachine.zone.inside === true, "warm machine not inside its zone");
      const gate = preview.portalPerimeterLiveGate(warmMachine);
      assertOk(gate.live === true && gate.reason === "inside_portal_perimeter", JSON.stringify(gate));
      assertOk(preview.SpatialPortalPreviewManager.machineRenderable(warmMachine) === true,
        "warm inside machine must be renderable");
    });

    // Presence subscription runs for WARM machines when the refresh interval
    // fires (we fire the captured interval by hand — deterministic).
    const presenceFetchCount = () => fetchLog.filter((f) => f.url.includes("/fabric/presence")).length;
    const machineFetchCount = () => fetchLog.length;
    let presenceWhileWarm = 0;
    await check("E1c", "while INSIDE, the presence subscription refreshes (the live feed is real)", async () => {
      const before = presenceFetchCount();
      const presenceTimer = intervals.find((h) => !h.cleared && h.ms === controller.FABRIC_PREFETCH_PRESENCE_REFRESH_MS);
      assertOk(presenceTimer, "no presence refresh interval registered while warm");
      nowMsValue += controller.FABRIC_PREFETCH_PRESENCE_REFRESH_MS + 1;
      presenceTimer.fn();
      await sleep(250);
      presenceWhileWarm = presenceFetchCount();
      assertOk(presenceWhileWarm > before, `presence fetches ${before} -> ${presenceWhileWarm} (no refresh)`);
    });

    let walkAway = null;
    await check("E1d", "walking OUT: ONE live->image flip, exactly at radius x hysteresis (no TTL involvement)", () => {
      const seq = [
        radius - 0.5,
        exitRadius - 0.2,
        exitRadius - 0.01,
        exitRadius + 0.01,
        exitRadius + 1,
        exitRadius + 3,
      ].map((d) => tick(d));
      walkAway = seq;
      const verdicts = seq.map((t) => (t.gate.live ? "live" : "image"));
      const transitions = [];
      for (let i = 1; i < verdicts.length; i += 1) {
        if (verdicts[i] !== verdicts[i - 1]) transitions.push({ index: i, from: verdicts[i - 1], to: verdicts[i] });
      }
      assertOk(
        JSON.stringify(verdicts) === JSON.stringify(["live", "live", "live", "image", "image", "image"]),
        `verdicts ${verdicts} across distances ${seq.map((t) => t.distance_m)}`
      );
      assertOk(transitions.length === 1 && transitions[0].index === 3,
        `expected exactly one flip at the boundary tick, got ${JSON.stringify(transitions)}`);
      // hysteresis honored: still inside at exitRadius - 0.01 (already past radius_m)
      assertOk(seq[2].gate.inside === true, "hysteresis band collapsed — flip would flicker on the line");
      // the machine cooled in the same tick the perimeter was left
      assertOk(seq[3].machine.status === "cooling", `first outside tick status ${seq[3].machine.status}`);
      diagnostics.walk_away = seq.map((t) => ({
        distance_m: t.distance_m,
        inside: t.gate.inside,
        verdict: t.gate.live ? "live" : "image",
        status: t.machine.status,
        renderable: t.renderable,
      }));
    });

    await check("E1e", "runtime override: subscription closes outside, but canonical portal rendering remains eligible (no still-image substitution)", () => {
      const outside = walkAway[3].machine;
      assertOk(outside.zone.inside === false, "harness error: tick not outside");
      const hasContent = !!(outside.region && Array.isArray(outside.region.entities) && outside.region.entities.length);
      // The pre-P4 machineRenderable body (status + content, no perimeter term):
      const preP4Renderable =
        !!outside.supported &&
        (outside.status === "warm" || outside.status === "cooling" ||
          (outside.status === "loading" && outside.region && outside.region.streaming)) &&
        hasContent;
      assertOk(preP4Renderable === true,
        "oracle baseline broken: the outside machine no longer satisfies the OLD rule (payload not fresh?)");
      assertOk(preview.SpatialPortalPreviewManager.machineRenderable(outside) === true,
        "canonical portal rendering was incorrectly coupled back to the subscription perimeter");
    });

    await check("E1f", "leaving the circle STOPS the subscription: zero new fetches, cancel/cooling recorded", async () => {
      await sleep(300); // let any in-flight pipeline work settle
      const snapshot = machineFetchCount();
      // more outside ticks + presence interval fired by hand + TTL passing
      tick(exitRadius + 4);
      tick(exitRadius + 6);
      const presenceTimer = intervals.find((h) => !h.cleared && h.ms === controller.FABRIC_PREFETCH_PRESENCE_REFRESH_MS);
      if (presenceTimer) presenceTimer.fn(); // warm-filter is empty -> must not fetch
      nowMsValue += 60_000; // a full minute passes far outside
      tick(exitRadius + 8);
      await sleep(300);
      assertOk(machineFetchCount() === snapshot,
        `subscription continued outside the perimeter: ${machineFetchCount() - snapshot} new fetches`);
      const events = (controller.debug({ focusPortalId: focusKey }).keyed.machines[focusKey].events || []).map((e) => e.event);
      assertOk(events.includes("prefetch_cooling") || events.includes("fabric_prefetch_cancelled"),
        `no cooling/cancel event recorded: ${events}`);
      assertOk(events.includes("prefetch_zone_exited"), `no zone-exit event recorded: ${events}`);
    });

    await check("E1g", "TTL expiry far outside changes payload state but NOT the (already image) verdict — no arbitrary late flip", () => {
      const t = tick(exitRadius + 8); // after the +60s clock jump the payload is stale
      assertOk(t.machine.status === "idle", `expected idle after TTL expiry outside, got ${t.machine.status}`);
      assertOk(t.gate.live === false, "verdict changed at TTL expiry");
      assertOk(t.renderable === true, "canonical renderability was incorrectly coupled to region TTL expiry");
    });

    await check("E1h", "a zone-less machine cannot claim live region subscription, but canonical loading/rendering remains eligible", () => {
      const synthetic = {
        supported: true,
        status: "warm",
        target_location_id: "location-b",
        region: { entities: [{ object_id: "x", position: [0, 0, 0] }], destination_portal: null },
      };
      const gate = preview.portalPerimeterLiveGate(synthetic);
      assertOk(gate.live === false && gate.reason === "perimeter_zone_unavailable", JSON.stringify(gate));
      assertOk(preview.SpatialPortalPreviewManager.machineRenderable(synthetic) === true,
        "canonical loading/rendering should remain eligible without invented region content");
    });

    await check("E1i", "app.js no longer substitutes serverBApertureMachine for lobby-portal-b's aperture machine", async () => {
      const appSource = await readFile(resolve(repoRoot, "web/app.js"), "utf8");
      assertOk(!/\?\s*serverBApertureMachine/.test(appSource),
        "the serverBApertureMachine substitution ternary is back");
      assertOk(/RETIRED as an\s*\n?\/\/ aperture machine/.test(appSource) || appSource.includes("RETIRED as an"),
        "retirement documentation missing");
      assertOk(appSource.includes("data-server-b-aperture-entities"),
        "the boot-time reachability probe was removed (only the machine substitution should be retired)");
    });

    // ================= SECTION 2 — the REAL preview manager ================
    // Warm the machine again (walk back inside) and feed the controller's own
    // projection into the real manager with a stub GL renderer.
    tick(radius - 0.5);
    let warmAgain = null;
    for (let i = 0; i < 100; i += 1) {
      const m = controller.debug({ focusPortalId: focusKey }).keyed.machines[focusKey];
      if (m && m.status === "warm") { warmAgain = m; break; }
      await sleep(100);
    }
    assertOk(warmAgain, "machine never re-warmed for the render section");

    const regionLobbyA = await regionForEntry(focusEntry);
    const entry = { ...focusEntry, target_frame: adoptedTargetFrame(focusEntry, regionLobbyA.portal) };
    const tf = entry.target_frame;
    const fwd = tf.forward;
    const frontProbe = new THREE.Vector3(
      tf.position[0] + fwd[0] * 1.0, tf.position[1], tf.position[2] + fwd[2] * 1.0);
    const backProbe = new THREE.Vector3(
      tf.position[0] - fwd[0] * 1.0, tf.position[1], tf.position[2] - fwd[2] * 1.0);
    const ringProbe = new THREE.Vector3(tf.position[0], tf.position[1], tf.position[2]);

    const renderCalls = [];
    const stubRenderer = {
      localClippingEnabled: false,
      getSize: (v) => v.set(1280, 800),
      getRenderTarget: () => null,
      setRenderTarget() {},
      clear() {},
      render(scene, camera) {
        renderCalls.push({ at: Date.now() });
      },
      readRenderTargetPixels() { throw new Error("no GPU in this harness"); },
    };
    const mainCamera = new THREE.PerspectiveCamera(60, 1280 / 800, 0.05, 80);
    const manager = new preview.SpatialPortalPreviewManager({
      nowMs: () => Date.now(),
      resolveDestinationContent: async () => ({
        kind: "legacy_world",
        revision: "p4-validation",
        world: { location_id: "location-a", color: "#3aa0ff" },
      }),
      composeDestinationContent: () => {
        const scene = new THREE.Scene();
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshBasicMaterial({ color: 0xffffff }),
        );
        mesh.position.set(tf.position[0], tf.position[1], tf.position[2] + 1);
        mesh.name = "canonical-p4-validation-object";
        scene.add(mesh);
        return { scene, source: "p4-validation-canonical", semantic_inventory: [mesh.name] };
      },
    });
    manager.bindScene(stubRenderer, mainCamera, new THREE.Scene());

    const placeCamera = (side, distanceM) => {
      const p = positionOnSide(entry.frame, side, distanceM);
      mainCamera.position.set(p[0], 1.5, p[2]);
      // look at the portal plane center from either side
      mainCamera.lookAt(entry.frame.position[0], entry.frame.position[1], entry.frame.position[2]);
      mainCamera.updateMatrixWorld(true);
    };

    let frontSurface = null;
    await check("E2a", "FRONT viewer arms + maps; canonical awareness keeps the target-frame-forward half-space", async () => {
      placeCamera("front", 2.0);
      frontSurface = manager.surfaceForPortal(focusKey, warmAgain, entry);
      assertOk(frontSurface && frontSurface.record, `front surface refused: ${JSON.stringify(manager.lastSurfaceAttempt)}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      manager.renderActive();
      const rec = frontSurface.record;
      assertOk(rec.active === true && rec.cameraMapped === true, "front record not active/mapped");
      assertOk(rec.viewerSide === "front" && rec.clipPlaneSide === "target_frame_forward",
        `front sides ${rec.viewerSide}/${rec.clipPlaneSide}`);
      // the glued camera equals the canonical glue (manager adds nothing)
      const camPos = [mainCamera.position.x, mainCamera.position.y, mainCamera.position.z];
      const camFwd = new THREE.Vector3();
      mainCamera.getWorldDirection(camFwd);
      const direct = glueCameraThroughFrames(entry.frame, entry.target_frame, camPos, [camFwd.x, camFwd.y, camFwd.z]);
      close(rec.lastCameraTransform.position[0], direct.position[0], 1e-9, "glued x");
      close(rec.lastCameraTransform.position[2], direct.position[2], 1e-9, "glued z");
      // front glued camera sits BEHIND the destination plane (z_t < 0)
      const gluedLocal = portalLocalCoordinates(entry.target_frame, direct.position);
      assertOk(gluedLocal.signed_plane_distance_m < 0, `front glued camera z_t ${gluedLocal.signed_plane_distance_m}`);
      // three.js retains the non-negative side: front kept, back clipped, ring kept (setback)
      assertOk(rec.clipPlane.distanceToPoint(frontProbe) > 0, "front content clipped on the front view");
      assertOk(rec.clipPlane.distanceToPoint(backProbe) < 0, "back content NOT clipped on the front view");
      assertOk(rec.clipPlane.distanceToPoint(ringProbe) > 0, "destination ring clipped on the front view");
      const n = rec.clipBasis.normal;
      close(rec.clipPlane.constant, -n.dot(new THREE.Vector3(...tf.position)) + 0.1, 1e-9,
        "target-forward clip constant");
    });

    await check("E2b", "BACK viewer arms + maps with the same isometry; destination awareness remains target-frame-forward", () => {
      placeCamera("back", 2.0);
      // pre-P4 oracle: the old gate refused any camera at source-local z < -0.1
      const camPos = [mainCamera.position.x, mainCamera.position.y, mainCamera.position.z];
      const zLocal =
        (camPos[0] - entry.frame.position[0]) * entry.frame.forward[0] +
        (camPos[1] - entry.frame.position[1]) * entry.frame.forward[1] +
        (camPos[2] - entry.frame.position[2]) * entry.frame.forward[2];
      assertOk(zLocal < -0.1, `harness error: back camera z ${zLocal}`);
      const surface = manager.surfaceForPortal(focusKey, warmAgain, entry);
      assertOk(surface && surface.record,
        `REVERT DETECTED (pre-P4 front-only gate): back side refused: ${JSON.stringify(manager.lastSurfaceAttempt)}`);
      manager.renderActive();
      const rec = surface.record;
      assertOk(rec.cameraMapped === true, "back view did not map");
      assertOk(rec.viewerSide === "back" && rec.clipPlaneSide === "target_frame_forward",
        `back sides ${rec.viewerSide}/${rec.clipPlaneSide}`);
      // the glued camera stands IN FRONT of the destination portal, looking back
      const gluedLocal = portalLocalCoordinates(entry.target_frame, rec.lastCameraTransform.position);
      assertOk(gluedLocal.signed_plane_distance_m > 0, `back glued camera z_t ${gluedLocal.signed_plane_distance_m}`);
      // Stable destination contract: source viewer side never flips eligibility.
      assertOk(rec.clipPlane.distanceToPoint(backProbe) < 0, "back half-space unexpectedly became eligible");
      assertOk(rec.clipPlane.distanceToPoint(frontProbe) > 0, "front half-space was lost on the back source view");
      assertOk(rec.clipPlane.distanceToPoint(ringProbe) > 0, "destination ring clipped on the back view");
      // gate ledger records the armed back view
      const gateRec = manager.surfaceGates.get(focusKey);
      assertOk(gateRec && gateRec.live === true && gateRec.viewer_side === "back", JSON.stringify(gateRec));
      // window identity probe holds for the back face too (same proper isometry)
      const probe = manager._recordDebug(rec).ring_alignment;
      assertOk(probe && probe.max_ndc_delta <= 0.02, `back-face ring alignment ${probe && probe.max_ndc_delta}`);
    });

    await check("E2c", "window == crossing continuity BOTH directions of the reciprocal edge: each face shows the half-space the crossing leaves you looking into; both entries exit the destination FRONT (P3 parity intact)", async () => {
      // lobby->A through lobby-portal-a, and A->lobby through location-a-portal-lobby
      const returnEntryRaw = a.world.portals.find((p) => p.string_portal_id === "location-a-portal-lobby");
      assertOk(returnEntryRaw, "A world has no location-a-portal-lobby (P1 reciprocity broken?)");
      const regionReturn = await regionForEntry(returnEntryRaw);
      const legs = [
        { label: "lobby->A", entry },
        { label: "A->lobby", entry: { ...returnEntryRaw, target_frame: adoptedTargetFrame(returnEntryRaw, regionReturn.portal) } },
      ];
      for (const leg of legs) {
        const frame = leg.entry.frame;
        const targetFrame = leg.entry.target_frame;
        for (const entrySide of ["front", "back"]) {
          // the walker faces THROUGH the plane: front entries move along -forward,
          // back entries along +forward; commit sample just past the plane.
          const facing = entrySide === "front" ? -1 : 1;
          const commitPos = positionOnSide(frame, entrySide === "front" ? "back" : "front", 0.03);
          const entryLocal = portalLocalCoordinates(frame, commitPos);
          const rotationY = Math.atan2(facing * frame.forward[0], facing * frame.forward[2]);
          const mapping = mapTransformBetweenPortalFrames({
            sourceFrame: frame,
            targetFrame,
            entryTransform: { position: commitPos, rotation_y: rotationY, scale: [1, 1, 1] },
            entryLocal,
          });
          const exitLocal = portalLocalCoordinates(targetFrame, mapping.mapped_exit_transform.position);
          assertOk(exitLocal.signed_plane_distance_m > 0,
            `${leg.label} ${entrySide} entry exits z_t ${exitLocal.signed_plane_distance_m} (not the destination front)`);
          // P3 parity still applies on top of the adapter landing (front exits only)
          const parity = preview.computeExitPoseParity({
            entrySignedPlaneDistanceM: entryLocal.signed_plane_distance_m,
            targetFrame,
            appliedExitPosition: mapping.mapped_exit_transform.position,
          });
          assertOk(parity.supported === true, `${leg.label} ${entrySide}: parity refused: ${parity.reason}`);
          close(parity.parity_standoff_m, Math.max(0.05, Math.abs(entryLocal.signed_plane_distance_m)), 1e-6,
            `${leg.label} ${entrySide} parity standoff`);
          assertOk(targetFrame.forward.length === 3,
            `${leg.label} ${entrySide}: target frame lost its authored into-destination normal`);
        }
      }
    });

    await check("E2d", "one-way portals still refuse their blocked side (client rule unchanged)", () => {
      // Use a real entry; the traversal rule object is the canonical normalized
      // one-way shape the 041 config uses for the classic B portal.
      const oneWayEntry = {
        ...entry,
        traversal: normalizePortalTraversal({ mode: "one_way", allowed_entry_side: "front" }),
      };
      placeCamera("back", 2.0);
      const refused = manager.surfaceForPortal(focusKey, warmAgain, oneWayEntry);
      assertOk(refused === null, "blocked side armed the spatial rung");
      assertOk(manager.lastSurfaceAttempt.reason === "camera_on_blocked_side",
        `blocked-side reason ${manager.lastSurfaceAttempt.reason}`);
      placeCamera("front", 2.0);
      const allowed = manager.surfaceForPortal(focusKey, warmAgain, oneWayEntry);
      assertOk(allowed && allowed.record, "one-way ALLOWED side refused");
    });

    await check("E2e", "runtime manager override: zone.inside=false keeps the canonical window active while subscription truth remains outside", () => {
      placeCamera("front", 2.0);
      const armed = manager.surfaceForPortal(focusKey, warmAgain, entry);
      assertOk(armed && armed.record && armed.record.active === true, "arming precondition failed");
      const outsideMachine = { ...warmAgain, zone: { ...warmAgain.zone, inside: false, distance_m: exitRadius + 1 } };
      const outsideSurface = manager.surfaceForPortal(focusKey, outsideMachine, entry);
      assertOk(outsideSurface && outsideSurface.record === armed.record,
        "outside perimeter incorrectly substituted an image/stale surface");
      assertOk(armed.record.active === true, "canonical record deactivated at subscription boundary");
      const gateRec = manager.surfaceGates.get(focusKey);
      assertOk(gateRec.live === true && gateRec.surface === "live_spatial_render", JSON.stringify(gateRec));
      assertOk(gateRec.perimeter && gateRec.perimeter.reason === "outside_portal_perimeter", "ledger lacks the perimeter verdict");
    });

    await check("E2f", "takeover can engage from the BACK side once armed (warm back-side crossings get the atomic cover too)", () => {
      placeCamera("back", 2.0);
      const surface = manager.surfaceForPortal(focusKey, warmAgain, entry);
      assertOk(surface && surface.record, "back side did not arm for takeover");
      manager.renderActive();
      assertOk(manager.engageTakeover(focusKey) === true,
        `takeover refused on the back side: ${JSON.stringify(manager.takeover.last_attempt)}`);
      manager.disengageTakeover();
    });

    await check("E2g", "debug surfaces carry the P4 diagnostics (viewer_side, clip_plane_side, perimeter_gate, surface_gates)", () => {
      const dbg = manager.debug();
      const rec = dbg.records[focusKey];
      assertOk(rec, "no record debug for the focus portal");
      assertOk(["front", "back"].includes(rec.viewer_side), `viewer_side ${rec.viewer_side}`);
      assertOk(rec.clip_plane_side === "target_frame_forward", `clip_plane_side ${rec.clip_plane_side}`);
      assertOk(rec.perimeter_gate && rec.perimeter_gate.validation &&
        rec.perimeter_gate.validation.perimeter_gate_standard_conformance === false,
        "perimeter gate missing its non-conformance label");
      assertOk(dbg.surface_gates && dbg.surface_gates[focusKey], "surface_gates missing from debug()");
      assertOk(typeof rec.both_sides_render === "string" && rec.both_sides_render.includes("180deg"),
        "both-sides contract note missing");
    });

    diagnostics.finished_at = new Date().toISOString();
  } finally {
    for (const server of servers) {
      try { await server.stop(); } catch (e) { /* already down */ }
    }
    await cleanup();
  }

  diagnostics.checks = results;
  diagnostics.passed = passed;
  diagnostics.failed = failed;
  const evidenceDir = resolve(repoRoot, "diagnostics");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    resolve(evidenceDir, "runtime-p4-both-sides-perimeter.json"),
    `${JSON.stringify(diagnostics, null, 2)}\n`,
  );
  console.log(`\n${passed}/${passed + failed} PASS -> diagnostics/p4-both-sides-perimeter.json`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("validation harness failed:", err);
  process.exit(1);
});
