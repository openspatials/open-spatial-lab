/**
 * PORTAL MOVEMENT-ORIENTATION CONTINUITY PROOF
 * (deterministic; no browser, no load gate).
 *
 * THE REPORTED DEFECT: walking through a portal with forward (W) held, the
 * player sometimes emerges mis-oriented — held-forward walks them straight
 * back through the portal (~180°) or into the portal's side (~90°) whenever
 * the two sides of an edge face different world directions.
 *
 * moves the correction to its canonical source: the packet's
 * exact traversed frame pair now owns exit pose, camera, heading, and movement
 * basis before dispatch. The historical consumer recomputes expected
 * values as a fail-closed no-op validator. A reconstructed portals[0] mapping
 * and a missing mapping remain explicit controlled RED fixtures.
 *
 * HOW IT CANNOT LIE:
 *   - Boots the REAL four 041 nodes in-process on ISOLATED ports; worlds are
 *     the REAL `worldFromLive` projections of live wire payloads; target
 *     frames are ADOPTED from the REAL /fabric/region wire pose (the
 *     seam), exactly as the shipping client does.
 *   - Runs the REAL shipping `movement-camera-controller.mjs` (the module the
 *     browser executes), driving its real crossing handler and reading the
 *     REAL `movementBasisYaw()` plus the `camera_yaw` it hands the adapter on
 *     the first post-crossing movement tick.
 *   - The held-forward world vector uses the adapter's own basis formula,
 *     SOURCE-PINNED against web/live-adapter.js (E-pins fail if it drifts).
 *   - CONTROLLED RED (oracle teeth): the SHIPPED pre-fix pipeline — the
 *     portals[0] camera mapping reconstructed byte-for-byte from the pinned
 *     `_completePlayerCrossing` recipe, and the stale-basis null-mapping case
 *     REPRODUCES the 90° and 180° signatures and FAILS the
 *     continuity criterion. Running with feature_DISABLE_REMAP=1 disables the
 *     fix in the pipeline and makes this proof exit RED.
 *
 * ISOLATED PORTS ONLY (19351-19354). 8143 / 18151-18154 (the live local demo)
 * are NEVER bound. No git. Claim boundary unchanged: local application-level
 * proof; no TeleportXR/production/standards claim.
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

import {
  mapCameraAcrossCrossing,
  mapTransformBetweenPortalFrames,
  portalFrameForLocation,
  portalLocalCoordinates,
  yawFromVector,
} from "../web/live-adapter-portal-geometry.mjs";
import { worldFromLive } from "../web/live-adapter-world-projection.mjs";
import {
  createMovementCameraController,
  crossingYawDeltaRad,
  normalizeYawRad,
  reframeCrossingCameraMapping,
} from "../web/movement-camera-controller.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const evidenceRoot = process.env.OSL_PEER_AVATAR_DIAGNOSTICS_ROOT
  ? resolve(process.env.OSL_PEER_AVATAR_DIAGNOSTICS_ROOT)
  : resolve(repoRoot, "diagnostics");
const require_ = createRequire(import.meta.url);

const { start } = require_(resolve(repoRoot, "runtime/world-server/src/server.js"));
const { makeConfig } = require_(resolve(repoRoot, "runtime/world-server/src/config.js"));
const { get } = require_(resolve(repoRoot, "runtime/world-server/src/http-client.js"));

const PORT_A = Number(process.env.OSL_PEER_AVATAR_PORT_A) || 19351;
const PORT_B = Number(process.env.OSL_PEER_AVATAR_PORT_B) || 19352;
const PORT_LOBBY = Number(process.env.OSL_PEER_AVATAR_PORT_LOBBY) || 19353;
const PORT_AIRPORT = Number(process.env.OSL_PEER_AVATAR_PORT_AIRPORT) || 19354;
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

/** Compatibility switch: bypass only consumer validation. Source mapping must
 * remain sufficient for heading and held-forward continuity. */
const DISABLE_REMAP = process.env.feature_DISABLE_REMAP === "1";

function isolatedPortals(role) {
  return makeConfig(role).portals.map((portal) => ({
    ...portal,
    target_base_url: `http://127.0.0.1:${PORT_BY_LOCATION[portal.target_location_id] || PORT_A}`,
  }));
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
function deg(rad) {
  return Number(((rad * 180) / Math.PI).toFixed(2));
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

/** The adoption seam, reconstructed with the REAL portalFrameForLocation
 *  over the REAL region wire pose (only the POSITION is adopted; the rotation
 *  stays the location preset — exactly `_adoptDestinationPortalPoseForMachine`). */
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

/* ------------------------------------------------------------------------- *
 * REAL movement-camera-controller harness (the FakeTarget recipe): the
 * SHIPPING module runs with fake DOM targets, a real THREE, and a recording
 * stepAvatar so the camera_yaw handed to the adapter on the first
 * post-crossing tick is measured, not inferred.
 * ------------------------------------------------------------------------- */
class FakeTarget {
  constructor(id = "") {
    this.id = id;
    this.style = {};
    this.hidden = false;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
  dispatch(type, init = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...init };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) || null;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
  }
  removeChild(child) {
    this.children = this.children.filter((value) => value !== child);
    child.parentNode = null;
  }
}

function createControllerHarness({ avatarPosition }) {
  const windowTarget = new FakeTarget("window");
  const documentTarget = new FakeTarget("document");
  documentTarget.body = new FakeTarget("body");
  documentTarget.createElement = (tag) => new FakeTarget(tag);
  const mount = new FakeTarget("scene-mount");
  const frames = [];
  let clock = 0;
  const state = {
    avatar: { avatar_id: "avatar", position: avatarPosition.slice(0, 3), rotation_y: 0 },
    controls: { grounded: true },
    preview: null,
  };
  const stepped = [];
  const capabilities = {
    state,
    world: null,
    debugState: () => ({ avatar: state.avatar, controls: state.controls }),
    stepAvatar: (input) => {
      stepped.push({ ...input });
    },
    broadcastPlayerPose: () => {},
    shouldAutoHandoff: () => false,
    markAutoHandoffObserved: () => {},
  };
  const controller = createMovementCameraController({
    THREE,
    isPlayer: true,
    role: "player",
    windowTarget,
    documentTarget,
    lookup: () => mount,
    requestFrame: (cb) => {
      frames.push(cb);
      return frames.length;
    },
    cancelFrame: () => {},
    now: () => clock,
    getRuntime: () => capabilities,
    sceneRuntime: {
      avatarHost: () => null,
      mountClientSceneLoad: async () => ({ ok: true }),
      renderChildFabricPreview: () => {},
      renderPortalPreviews: () => {},
    },
    getAvatarLayers: () => ({ local: null, peers: [] }),
    resolveClientSceneLoadTraversal: () => null,
    persistPlayerSession: () => {},
    logLine: () => {},
    showToast: () => {},
    isTypingTarget: () => false,
  });
  controller.start();
  return {
    controller,
    state,
    stepped,
    pressForward: () => windowTarget.dispatch("keydown", { code: "KeyW" }),
    tick: () => {
      const cb = frames.pop();
      assertOk(typeof cb === "function", "controller frame loop is not scheduled");
      clock += 16;
      cb(clock);
    },
    dispose: () => controller.dispose(),
  };
}

/**
 * Drive the REAL controller through one crossing and measure the emergence
 * heading + movement basis. `detail` is the crossing record the app listener
 * would receive; `entryAzimuth` is the pre-crossing orbit azimuth (the camera
 * sits behind the avatar walking in).
 */
function runControllerCrossing({ detail, entryAzimuth, entryPosition, exitPosition }) {
  const harness = createControllerHarness({ avatarPosition: entryPosition });
  const { controller, state, stepped } = harness;
  controller.seedOrbitCamera({
    azimuth: entryAzimuth,
    polar: 0.22,
    distance: 3.5,
    avatarPosition: entryPosition,
  });
  const basisBefore = controller.movementBasisYaw();
  // The adapter applies the exit pose before the crossing dispatch reaches the
  // listener — mirror that: the avatar stands at the
  // exit when handleCrossing runs.
  state.avatar.position = exitPosition.slice(0, 3);
  const remapped = controller.handleCrossing(detail);
  const basisAfter = controller.movementBasisYaw();
  const cameraDebug = controller.updatePlayerCamera({ avatar: { position: exitPosition } });
  // First post-crossing movement tick with W held: the camera_yaw recorded here
  // is the basis the adapter's stepAvatar would rotate the input by.
  harness.pressForward();
  harness.tick();
  const firstTick = stepped[stepped.length - 1] || null;
  harness.dispose();
  return {
    remapped,
    basis_before: basisBefore,
    basis_after: basisAfter,
    camera_yaw_after: cameraDebug ? Number(cameraDebug.rotation_y) : null,
    first_tick_camera_yaw: firstTick && Number.isFinite(Number(firstTick.camera_yaw))
      ? Number(firstTick.camera_yaw)
      : null,
    first_tick_forward: firstTick ? firstTick.forward === true : false,
  };
}

/** The adapter's held-forward world direction for a basis yaw (f=1, s=0) —
 *  formula source-pinned against web/live-adapter.js in E-pins. */
function heldForwardWorld(basisYaw) {
  return [Math.sin(basisYaw), 0, Math.cos(basisYaw)];
}
function dotIntoRoom(basisYaw, intoRoomForward) {
  const dir = heldForwardWorld(basisYaw);
  return dir[0] * intoRoomForward[0] + dir[2] * intoRoomForward[2];
}

/** Build one leg's crossing exactly the way the shipping client does. */
function buildLeg({ legId, sourceProjection, destProjection, targetLocationId, adoptedFrames }) {
  const world = sourceProjection.world;
  const traversed = world.portals.find((p) => p.target_location_id === targetLocationId);
  assertOk(traversed, `${legId}: source world has no portal to ${targetLocationId}`);
  const isFirstPortal = world.portals[0] === traversed;
  const traversedTargetFrame = adoptedFrames.get(traversed.string_portal_id || traversed.portal_id);
  assertOk(traversedTargetFrame, `${legId}: no adopted target frame for the traversed portal`);

  // Entry: the avatar walked straight in through the FRONT (0.033 m past the
  // plane — P3's committed-walk figure), 0.06 m lateral, heading -forward.
  const frame = traversed.frame;
  const entryYaw = normalizeYawRad(yawFromVector(frame.forward, 0) + Math.PI);
  const entryPosition = [
    frame.ground_center[0] + frame.forward[0] * -0.033 + frame.right[0] * 0.06,
    0,
    frame.ground_center[2] + frame.forward[2] * -0.033 + frame.right[2] * 0.06,
  ];
  const entryLocal = portalLocalCoordinates(frame, entryPosition);
  const entryTransform = { position: entryPosition, rotation_y: entryYaw, scale: [1, 1, 1] };

  // The REAL third-person orbit camera behind the walking avatar: the orbit
  // azimuth points from the focus to the camera — opposite the walk direction.
  const entryAzimuth = normalizeYawRad(entryYaw + Math.PI);
  const polar = 0.22;
  const distance = 3.5;
  const focus = [entryPosition[0], entryPosition[1] + 1.35, entryPosition[2]];
  const cameraPosition = [
    focus[0] + Math.sin(entryAzimuth) * Math.cos(polar) * distance,
    focus[1] + Math.sin(polar) * distance,
    focus[2] + Math.cos(entryAzimuth) * Math.cos(polar) * distance,
  ];
  const cameraTransform = {
    position: cameraPosition.map((v) => Number(v.toFixed(4))),
    target: focus.map((v) => Number(v.toFixed(4))),
    rotation_y: entryYaw,
  };

  // The TRAVERSED edge's frame mapping — what beginTransition arms and the
  // exit pose consumes (source-pinned in E-pins).
  const frameMapping = mapTransformBetweenPortalFrames({
    sourceFrame: frame,
    targetFrame: traversedTargetFrame,
    entryTransform,
    entryLocal,
  });
  assertOk(frameMapping && frameMapping.mapped_exit_transform, `${legId}: no frame mapping`);
  const exitPose = {
    position: frameMapping.mapped_exit_transform.position.slice(0, 3),
    rotation_y: frameMapping.mapped_exit_transform.rotation_y,
    source: "traversed_edge_counterpart_frame_mapping",
  };

  // source-owned mapping: the same traversed frame pair owns the exit
  // pose, camera, heading, and movement basis before dispatch.
  const sourceMapping = mapCameraAcrossCrossing({
    sourceFrame: frame,
    targetFrame: traversedTargetFrame,
    cameraTransform,
    avatarEntryPosition: entryPosition,
    avatarEntryYaw: entryYaw,
    avatarExitPosition: exitPose.position,
    avatarExitYaw: exitPose.rotation_y,
  });
  assertOk(sourceMapping, `${legId}: source camera mapping did not compute`);
  const shippedMapping = {
    ...sourceMapping,
    frame_source: "packet.avatar_context.portal_frame_transform",
    source_portal_id: frame.portal_id || null,
    target_portal_id: traversedTargetFrame.portal_id || null,
    crossing_yaw_delta_rad: Number(crossingYawDeltaRad(frame, traversedTargetFrame).toFixed(6)),
    movement_basis_forward: sourceMapping.forward.slice(0, 3),
  };

  // Controlled historical RED: reconstruct the retired first-portal path.
  const firstPortal = world.portals[0];
  const firstTargetFrame =
    adoptedFrames.get(firstPortal.string_portal_id || firstPortal.portal_id) || firstPortal.target_frame;
  const legacyFirstPortalMapping = mapCameraAcrossCrossing({
    sourceFrame: firstPortal.frame,
    targetFrame: firstTargetFrame,
    cameraTransform,
    avatarEntryPosition: entryPosition,
    avatarEntryYaw: entryYaw,
    avatarExitPosition: exitPose.position,
    avatarExitYaw: exitPose.rotation_y,
  });
  assertOk(legacyFirstPortalMapping, `${legId}: legacy first-portal mapping did not compute`);

  // The destination's OWN counterpart portal (its own served projection) gives
  // the independent into-room normal: the landing sits on that portal's FRONT
  // side, so "away from the portal, deeper into the room" is +frame.forward.
  const sourceLocationId = world.location_id;
  const counterpart = destProjection.world.portals.find(
    (p) => p.target_location_id === sourceLocationId,
  );
  assertOk(counterpart, `${legId}: destination world has no portal back to ${sourceLocationId}`);
  const intoRoom = counterpart.frame.forward;

  const deltaYaw = crossingYawDeltaRad(frame, traversedTargetFrame);
  const intendedYaw = normalizeYawRad(entryYaw + deltaYaw);

  return {
    legId,
    isFirstPortal,
    traversed,
    traversedTargetFrame,
    frameMapping,
    entryTransform,
    entryYaw,
    entryAzimuth,
    entryPosition,
    cameraTransform,
    exitPose,
    shippedMapping,
    legacyFirstPortalMapping,
    counterpart,
    intoRoom,
    deltaYaw,
    intendedYaw,
  };
}

/** The app.js listener seam, mirrored: reframe (unless disabled) then feed the
 *  controller. The reframe call is the REAL shipping export. */
function crossingDetailFor(leg, { withCamera = true, reframe = true } = {}) {
  const detail = {
    kind: "world_navigator_composition_crossing",
    handoff_id: `runtime-${leg.legId}`,
    exit_pose: { ...leg.exitPose, position: leg.exitPose.position.slice(0, 3) },
    camera_mapping: withCamera ? JSON.parse(JSON.stringify(leg.shippedMapping)) : null,
    traversed_edge: {
      source: "packet.avatar_context.portal_frame_transform",
      source_portal_id: leg.frameMapping.source_portal_frame.portal_id || null,
      target_portal_id: leg.frameMapping.target_portal_frame.portal_id || null,
    },
    heading_continuity: {
      source_portal_id: leg.frameMapping.source_portal_frame.portal_id || null,
      target_portal_id: leg.frameMapping.target_portal_frame.portal_id || null,
      crossing_yaw_delta_rad: Number(leg.deltaYaw.toFixed(6)),
      target_into_room_forward: leg.frameMapping.target_portal_frame.forward.slice(0, 3),
      frames_source: "packet.avatar_context.portal_frame_transform",
    },
    from: { location_id: leg.traversed.source_location_id || null },
    to: { location_id: leg.traversed.target_location_id || null },
  };
  let record = null;
  if (reframe && !DISABLE_REMAP) {
    record = reframeCrossingCameraMapping({
      detail,
      frameMapping: {
        source_portal_frame: leg.frameMapping.source_portal_frame,
        target_portal_frame: leg.frameMapping.target_portal_frame,
      },
      entryTransform: leg.entryTransform,
      cameraTransform: withCamera ? leg.cameraTransform : null,
    });
  }
  return { detail, record };
}

async function main() {
  const diagnostics = {
    wo: "runtime",
    title:
      "movement-orientation continuity through portals — held-forward emerges INTO the destination room on every edge",
    started_at: new Date().toISOString(),
    remap_disabled: DISABLE_REMAP,
    ports: { a: PORT_A, b: PORT_B, lobby: PORT_LOBBY, airport: PORT_AIRPORT },
    claim_boundary:
      "local application-level validation; heading/basis continuity across the composition crossing; no TeleportXR/production/standards claim",
    checks: null,
    legs: {},
  };
  if (DISABLE_REMAP) console.log("feature_DISABLE_REMAP=1 — source mapping remains authoritative; consumer validation bypassed");

  const servers = [];
  try {
    servers.push(await start("a", { bind_port: PORT_A, portals: isolatedPortals("a") }));
    servers.push(await start("b", { bind_port: PORT_B, portals: isolatedPortals("b") }));
    servers.push(await start("lobby", { bind_port: PORT_LOBBY, portals: isolatedPortals("lobby") }));
    servers.push(await start("airport", { bind_port: PORT_AIRPORT, portals: isolatedPortals("airport") }));

    const projections = {
      "location-a": await fetchWorldProjection(`http://127.0.0.1:${PORT_A}`, "source"),
      "location-b": await fetchWorldProjection(`http://127.0.0.1:${PORT_B}`, "source"),
      "location-lobby": await fetchWorldProjection(`http://127.0.0.1:${PORT_LOBBY}`, "player"),
    };

    // Adopt every reachable portal's destination pose from the REAL region wire
    // (skip the airport edge: its endpoint serves a client-scene lane, not a
    // composition crossing).
    const adoptedFrames = new Map();
    for (const projection of Object.values(projections)) {
      for (const entry of projection.world.portals) {
        if (!PORT_BY_LOCATION[entry.target_location_id]) continue;
        if (entry.target_location_id === "location-airport") continue;
        const region = await regionForEntry(entry);
        adoptedFrames.set(
          entry.string_portal_id || entry.portal_id,
          adoptedTargetFrame(entry, region.portal),
        );
      }
    }

    // The five legs: BOTH directions of the lobby<->A reciprocal edge, BOTH
    // directions of the differently-oriented A<->B edge (A faces +Z, B faces
    // -X), and lobby->B (differently-oriented AND a non-first-portal walk).
    const legs = [
      buildLeg({ legId: "lobby-to-a", sourceProjection: projections["location-lobby"], destProjection: projections["location-a"], targetLocationId: "location-a", adoptedFrames }),
      buildLeg({ legId: "a-to-lobby", sourceProjection: projections["location-a"], destProjection: projections["location-lobby"], targetLocationId: "location-lobby", adoptedFrames }),
      buildLeg({ legId: "a-to-b", sourceProjection: projections["location-a"], destProjection: projections["location-b"], targetLocationId: "location-b", adoptedFrames }),
      buildLeg({ legId: "b-to-a", sourceProjection: projections["location-b"], destProjection: projections["location-a"], targetLocationId: "location-a", adoptedFrames }),
      buildLeg({ legId: "lobby-to-b", sourceProjection: projections["location-lobby"], destProjection: projections["location-b"], targetLocationId: "location-b", adoptedFrames }),
    ];

    await check("E0", "topology grounds the defect: A->lobby and lobby->B traverse a NON-FIRST portal; A<->B faces different world directions", () => {
      const byId = Object.fromEntries(legs.map((leg) => [leg.legId, leg]));
      assertOk(!byId["a-to-lobby"].isFirstPortal, "a-to-lobby unexpectedly walks portals[0]");
      assertOk(!byId["lobby-to-b"].isFirstPortal, "lobby-to-b unexpectedly walks portals[0]");
      assertOk(byId["a-to-b"].isFirstPortal && byId["b-to-a"].isFirstPortal && byId["lobby-to-a"].isFirstPortal,
        "expected lobby-to-a / a-to-b / b-to-a to walk portals[0] (the coincidentally-correct legs)");
      const aFwd = yawFromVector(byId["a-to-b"].traversed.frame.forward, 0);
      const bFwd = yawFromVector(byId["b-to-a"].traversed.frame.forward, 0);
      close(Math.abs(normalizeYawRad(aFwd - bFwd)), Math.PI / 2, 1e-6, "A and B portal frames must face 90°-different world directions");
    });

    for (const leg of legs) {
      const legEvidence = {
        first_portal: leg.isFirstPortal,
        traversed_portal: leg.traversed.string_portal_id || leg.traversed.portal_id,
        counterpart_portal: leg.counterpart.string_portal_id || leg.counterpart.portal_id,
        entry_yaw_deg: deg(leg.entryYaw),
        crossing_yaw_delta_deg: deg(leg.deltaYaw),
        intended_emergence_yaw_deg: deg(leg.intendedYaw),
        into_room_forward: leg.intoRoom.slice(0, 3),
      };
      diagnostics.legs[leg.legId] = legEvidence;

      // Sanity: the exit pose really lands in front of the destination's OWN
      // counterpart portal (so intoRoom is measured at the right portal), and
      // the traversed edge's exit yaw equals entry∘crossing-rotation.
      await check(`${leg.legId}-S`, `${leg.legId}: exit lands at the destination's own counterpart; exit yaw == entry ∘ crossing rotation`, () => {
        const gap = planar(leg.exitPose.position, leg.counterpart.trigger.position);
        legEvidence.exit_to_counterpart_m = Number(gap.toFixed(4));
        assertOk(gap <= 1.5, `exit ${gap.toFixed(3)} m from the destination's counterpart portal (must be <= 1.5)`);
        close(normalizeYawRad(leg.frameMapping.exit_yaw_radians - leg.intendedYaw), 0, 2e-3,
          "frame mapping exit yaw vs entry+delta");
      });

      // FIXED pipeline (acceptance 1+2): reframe -> REAL controller -> measure.
      await check(`${leg.legId}-F`, `${leg.legId}: FIXED — held-forward emerges INTO the room (dot ~1); movementBasisYaw == remapped camera yaw at the emergence frame`, () => {
        const { detail, record } = crossingDetailFor(leg, { withCamera: true, reframe: true });
        const run = runControllerCrossing({
          detail,
          entryAzimuth: leg.entryAzimuth,
          entryPosition: leg.entryPosition,
          exitPosition: leg.exitPose.position,
        });
        const dot = dotIntoRoom(run.basis_after, leg.intoRoom);
        const headingError = Math.abs(normalizeYawRad(run.basis_after - leg.intendedYaw));
        legEvidence.fixed = {
          remapped: run.remapped === true ? "camera_mapping" : run.remapped,
          reframe_applied: record ? record.applied : null,
          source_mapping_validated: record ? record.validated : null,
          reframe_changed: record ? record.changed : null,
          consumer_position_correction_m: record ? record.position_correction_m : null,
          consumer_forward_correction_deg: record ? record.forward_correction_deg : null,
          basis_yaw_deg: deg(run.basis_after),
          camera_yaw_deg: run.camera_yaw_after === null ? null : deg(run.camera_yaw_after),
          first_tick_camera_yaw_deg: run.first_tick_camera_yaw === null ? null : deg(run.first_tick_camera_yaw),
          held_forward_dot_into_room: Number(dot.toFixed(4)),
          emergence_heading_error_deg: deg(headingError),
        };
        if (!DISABLE_REMAP) {
          assertOk(record && record.validated, `source mapping did not validate: ${record && record.reason}`);
          assertOk(record.changed === false, "consumer guard remained load-bearing");
          close(record.position_correction_m, 0, 1e-6, "consumer position correction");
          close(record.focus_correction_m, 0, 1e-6, "consumer focus correction");
          close(record.forward_correction_deg, 0, 1e-6, "consumer forward correction");
          close(record.movement_basis_correction_deg, 0, 1e-6, "consumer movement-basis correction");
        }
        assertOk(run.remapped === true, `controller did not apply the camera mapping (got ${run.remapped})`);
        // Acceptance 2 — measured, not eyeballed: the basis equals the applied
        // camera yaw AND the camera_yaw handed to the adapter on the FIRST
        // post-crossing movement tick. No stale-basis window.
        close(run.basis_after, run.camera_yaw_after, 2e-3, "movementBasisYaw vs applied camera yaw");
        assertOk(run.first_tick_forward, "first tick did not carry the held W key");
        close(run.first_tick_camera_yaw, run.basis_after, 1e-9, "first-tick camera_yaw vs movementBasisYaw");
        // Acceptance 1: held-forward carries the avatar AWAY from the portal,
        // INTO the destination room; emergence heading error ~ 0.
        assertOk(dot >= 0.999, `held-forward dot into-room ${dot.toFixed(4)} (must be >= 0.999)`);
        assertOk(headingError <= 2e-3, `emergence heading error ${headingError.toFixed(5)} rad (must be <= 0.002)`);
      });

      // CONTROLLED RED 1 (acceptance 3): the SHIPPED pre-fix mapping. On the
      // non-first-portal legs held-forward goes ~90° into the portal's side —
      // the second signature — and the continuity criterion FAILS.
      await check(`${leg.legId}-R1`, `${leg.legId}: RED — the shipped portals[0] mapping ${leg.isFirstPortal ? "was coincidentally correct (documents why e2e stayed green)" : "sends held-forward into the portal's side (~90° — the reported bug)"}`, () => {
        const { detail } = crossingDetailFor(leg, { withCamera: true, reframe: false });
        detail.camera_mapping = JSON.parse(JSON.stringify(leg.legacyFirstPortalMapping));
        const run = runControllerCrossing({
          detail,
          entryAzimuth: leg.entryAzimuth,
          entryPosition: leg.entryPosition,
          exitPosition: leg.exitPose.position,
        });
        const dot = dotIntoRoom(run.basis_after, leg.intoRoom);
        legEvidence.red_shipped_mapping = {
          basis_yaw_deg: deg(run.basis_after),
          held_forward_dot_into_room: Number(dot.toFixed(4)),
          heading_error_deg: deg(Math.abs(normalizeYawRad(run.basis_after - leg.intendedYaw))),
        };
        if (leg.isFirstPortal) {
          assertOk(dot >= 0.999, `first-portal leg should have been correct pre-fix (dot ${dot.toFixed(4)})`);
        } else {
          assertOk(Math.abs(dot) <= 0.35,
            `pre-fix run should reproduce the ~90° side-walk (|dot| <= 0.35), got dot ${dot.toFixed(4)} — the RED case no longer reproduces`);
        }
      });

      // CONTROLLED RED 2: NO camera mapping at all, pre-fix — the basis stays
      // STALE (points the pre-crossing way). On lobby->A that is the
      // 180° (held-forward walks straight back through); on lobby->B the 90°.
      await check(`${leg.legId}-R2`, `${leg.legId}: RED — with no camera mapping the pre-fix basis is STALE (${Math.abs(Math.round(deg(normalizeYawRad(leg.entryYaw - leg.intendedYaw))))}° off; walks ${Math.abs(Math.abs(deg(normalizeYawRad(leg.entryYaw - leg.intendedYaw))) - 180) < 1 ? "straight back through" : "off-heading"})`, () => {
        const { detail } = crossingDetailFor(leg, { withCamera: false, reframe: false });
        detail.heading_continuity = null;
        const run = runControllerCrossing({
          detail,
          entryAzimuth: leg.entryAzimuth,
          entryPosition: leg.entryPosition,
          exitPosition: leg.exitPose.position,
        });
        const dot = dotIntoRoom(run.basis_after, leg.intoRoom);
        legEvidence.red_stale_basis = {
          remapped: run.remapped,
          basis_yaw_deg: deg(run.basis_after),
          held_forward_dot_into_room: Number(dot.toFixed(4)),
        };
        assertOk(run.remapped === false, `pre-fix null-mapping crossing should leave the basis untouched (got ${run.remapped})`);
        close(run.basis_after, leg.entryYaw, 1e-6, "stale basis must equal the pre-crossing heading");
        const staleDot = dotIntoRoom(leg.entryYaw, leg.intoRoom);
        // The stale basis reproduces the signatures wherever the edge
        // rotates: 180°-related edges walk STRAIGHT BACK THROUGH (dot ~ -1),
        // 90°-related edges walk into the side (dot ~ 0).
        if (staleDot <= -0.999) {
          assertOk(dot <= -0.999, `expected the 180° walk-back-through (dot <= -0.999), got ${dot.toFixed(4)}`);
        } else {
          assertOk(Math.abs(dot) <= 0.35, `expected the ~90° side-walk (|dot| <= 0.35), got ${dot.toFixed(4)}`);
        }
      });

      // FIXED null-camera arm: heading_continuity alone rotates heading+basis
      // atomically — the stale-basis window is closed even with no camera.
      await check(`${leg.legId}-FN`, `${leg.legId}: FIXED (no camera mapping) — heading_continuity rotates the basis atomically; held-forward still goes INTO the room`, () => {
        const { detail, record } = crossingDetailFor(leg, { withCamera: false, reframe: true });
        const run = runControllerCrossing({
          detail,
          entryAzimuth: leg.entryAzimuth,
          entryPosition: leg.entryPosition,
          exitPosition: leg.exitPose.position,
        });
        const dot = dotIntoRoom(run.basis_after, leg.intoRoom);
        legEvidence.fixed_no_camera = {
          remapped: run.remapped,
          basis_yaw_deg: deg(run.basis_after),
          held_forward_dot_into_room: Number(dot.toFixed(4)),
        };
        if (!DISABLE_REMAP) {
          assertOk(record && !record.validated, "missing source mapping escaped the consumer guard");
          assertOk(record.reason === "no_entry_camera_transform", `unexpected missing-mapping reason ${record.reason}`);
          assertOk(run.remapped === "heading_delta", `expected the heading_delta fallback (got ${run.remapped})`);
        }
        assertOk(dot >= 0.999, `held-forward dot into-room ${dot.toFixed(4)} (must be >= 0.999)`);
        close(Math.abs(normalizeYawRad(run.basis_after - leg.intendedYaw)), 0, 2e-3, "emergence heading error");
        close(run.first_tick_camera_yaw, run.basis_after, 1e-9, "first-tick camera_yaw vs movementBasisYaw");
      });
    }

    // ---- E-pins: the seams this proof mirrors must stay what it mirrors ----
    await check("E-pins", "source pins: traversed-edge source ownership, consumer validation order, and adapter basis formula", () => {
      const controllerSrc = readFileSync(resolve(repoRoot, "web/live-adapter-portal-traversal-controller.mjs"), "utf8");
      assertOk(!controllerSrc.includes("const crossingPortal = fromWorld.portal || null;"),
        "traversal controller restored the retired first-portal camera owner");
      assertOk(controllerSrc.includes("sourceFrame: traversedSourceFrame,") && controllerSrc.includes("targetFrame: traversedTargetFrame,"),
        "traversal controller no longer maps the camera from the packet traversed edge");
      assertOk(controllerSrc.includes('frame_source: "packet.avatar_context.portal_frame_transform"'),
        "source mapping does not name its packet frame owner");
      const adapterSrc = readFileSync(resolve(repoRoot, "web/live-adapter.js"), "utf8");
      assertOk(adapterSrc.includes("const basisYaw = Number.isFinite(Number(controls.camera_yaw))"),
        "adapter movement basis source changed");
      assertOk(adapterSrc.includes("dx = (f * sinB - s * cosB)") && adapterSrc.includes("dz = (f * cosB + s * sinB)"),
        "adapter held-key basis formula changed — update heldForwardWorld");
      const appSrc = readFileSync(resolve(repoRoot, "web/app.js"), "utf8");
      const reframeAt = appSrc.indexOf("reframeAdapterCrossingHeading(detail)");
      const parityAt = appSrc.indexOf("applyExitPoseParity(detail);", reframeAt);
      const remapAt = appSrc.indexOf("movementCameraController.handleCrossing(detail)", reframeAt);
      assertOk(reframeAt > 0 && parityAt > reframeAt && remapAt > parityAt,
        "app.js crossing listener must run reframe -> parity -> camera remap in that order");
      assertOk(appSrc.includes("source_portal_frame: portalInfo.source_portal_frame"),
        "app.js reframe must consume the profile's traversed-edge frames");
      const mccSrc = readFileSync(resolve(repoRoot, "web/movement-camera-controller.mjs"), "utf8");
      assertOk(mccSrc.includes("return applyCrossingHeadingDelta(detail);"),
        "controller no-mapping path must fall back to the atomic heading delta");
      assertOk(mccSrc.includes("source_mapping_validated") && !mccSrc.includes("mapping.position = remapped.position"),
        "runtime consumer must validate without rewriting source mapping values");
    });
  } finally {
    for (const server of servers) {
      try {
        await server.closeAll();
      } catch (e) {
        /* best effort */
      }
    }
  }

  diagnostics.checks = results;
  diagnostics.finished_at = new Date().toISOString();
  diagnostics.passed = passed;
  diagnostics.failed = failed;
  diagnostics.verdict = failed === 0 ? "PASS" : "FAIL";
  const evidencePath = resolve(
    evidenceRoot,
    DISABLE_REMAP
      ? "runtime-portal-movement-orientation-continuity-red.json"
      : "runtime-portal-movement-orientation-continuity.json",
  );
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(diagnostics, null, 2)}\n`);
  console.log(`\n${diagnostics.verdict}: ${passed} passed, ${failed} failed${DISABLE_REMAP ? " (consumer validation bypassed)" : ""}`);
  console.log(`diagnostics: ${evidencePath}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`runtime validation crashed: ${err.stack || err.message}`);
  process.exit(1);
});
