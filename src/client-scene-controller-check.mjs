import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONTROLLER_PATH = join(ROOT, "web/live-adapter-client-scene-controller.mjs");
const ADAPTER_PATH = join(ROOT, "web/live-adapter.js");
const MUTATION = process.env.feature_P15_MUTATION || "";
let controllerSource = readFileSync(CONTROLLER_PATH, "utf8");
let adapterSource = readFileSync(ADAPTER_PATH, "utf8");

const reciprocalDiagnosticMutations = {
  "reciprocal-diagnostic-missing": [
    '    activeRecord.reciprocal = installed.reciprocal || {\n      portal: null,\n      synthesized: false,\n      reason: "automatic_reciprocal_unavailable",\n    };',
    "    void installed.reciprocal;",
  ],
  "reciprocal-diagnostic-falsely-synthesized": [
    "      synthesized: false,",
    "      synthesized: true,",
  ],
  "reciprocal-diagnostic-non-null-portal": [
    "      portal: null,",
    '      portal: { string_portal_id: "phantom-reciprocal" },',
  ],
  "reciprocal-diagnostic-misleading-reason": [
    '      reason: "automatic_reciprocal_unavailable",',
    '      reason: "automatic_reciprocal_synthesized",',
  ],
};

function replaceOnce(source, before, after) {
  assert.equal(source.includes(before), true, `mutation anchor missing: ${before}`);
  return source.replace(before, after);
}

function applyMutation(name) {
  if (reciprocalDiagnosticMutations[name]) {
    controllerSource = replaceOnce(controllerSource, ...reciprocalDiagnosticMutations[name]);
    return;
  }
  switch (name) {
    case "resolve-validation-off":
      controllerSource = replaceOnce(
        controllerSource,
        '    if (!target || typeof target.graph_endpoint !== "string" || !target.graph_endpoint) {',
        "    if (false) {",
      );
      break;
    case "client-target-validation-off":
      controllerSource = replaceOnce(
        controllerSource,
        '    if (!target || target.transition !== "client_scene_load") {',
        "    if (!target) {",
      );
      break;
    case "claim-boundary-allow":
      controllerSource = replaceOnce(
        controllerSource,
        "      contract.proof_boundary.application_level_handoff !== false ||",
        "      false ||",
      );
      controllerSource = replaceOnce(
        controllerSource,
        "      contract.proof_boundary.standards_conformance !== false",
        "      false",
      );
      break;
    case "snapshot-after-depart":
      controllerSource = replaceOnce(
        controllerSource,
        '    await presence.departPresence({ base: host.base, reason: "client_scene_load" });',
        '    await presence.departPresence({ base: host.base, reason: "client_scene_load" });\n' +
          "    const postDepartureHost = readHostState();\n" +
          "    Object.assign(origin, { world: postDepartureHost.world });",
      );
      break;
    case "depart-not-awaited":
      controllerSource = replaceOnce(
        controllerSource,
        '    await presence.departPresence({ base: host.base, reason: "client_scene_load" });',
        '    void presence.departPresence({ base: host.base, reason: "client_scene_load" });',
      );
      break;
    case "heartbeat-stop-removed":
      controllerSource = replaceOnce(controllerSource, "    presence.stopHeartbeat();", "    void presence.stopHeartbeat;");
      break;
    case "registration-clear-removed":
      controllerSource = replaceOnce(controllerSource, "    presence.clearRegistration();", "    void presence.clearRegistration;");
      break;
    case "runtime-close-removed":
      controllerSource = replaceOnce(controllerSource, "    runtimeStreams.closeRuntimeStream();", "    void runtimeStreams.closeRuntimeStream;");
      break;
    case "peer-clear-removed":
      controllerSource = replaceOnce(controllerSource, "    peers.clear();", "    void peers.clear;");
      break;
    case "entry-prefetch-reset-removed":
      controllerSource = replaceOnce(
        controllerSource,
        '    prefetch.reset({\n      reason: "client_scene_load",\n      world: installed.world,\n      clientMode: host.clientMode,\n    });',
        "    void installed.world;",
      );
      break;
    case "entry-emit-before-adoption":
      controllerSource = replaceOnce(
        controllerSource,
        "    const installed = installClientSceneState({",
        "    emitState();\n    const installed = installClientSceneState({",
      );
      controllerSource = replaceOnce(
        controllerSource,
        "    updatePortalStatus();\n    emitState();\n\n    return {",
        "    updatePortalStatus();\n\n    return {",
      );
      break;
    case "peer-reference-restore-removed":
      controllerSource = replaceOnce(
        controllerSource,
        "    peers.restore(restoring.origin.peerPresence);",
        "    peers.restore({ peerPlayerPoses: { ...restoring.origin.peerPresence.peerPlayerPoses }, livePlayerPose: restoring.origin.peerPresence.livePlayerPose ? { ...restoring.origin.peerPresence.livePlayerPose } : null });",
      );
      break;
    case "active-clear-after-register":
      controllerSource = replaceOnce(controllerSource, "    activeRecord = null;", "    void activeRecord;");
      controllerSource = replaceOnce(
        controllerSource,
        '    await presence.registerPresence({ spawnReason: "return_from_client_scene_load" });',
        '    await presence.registerPresence({ spawnReason: "return_from_client_scene_load" });\n    activeRecord = null;',
      );
      break;
    case "return-prefetch-reset-removed":
      controllerSource = replaceOnce(
        controllerSource,
        '    prefetch.reset({\n      reason: "return_from_client_scene_load",\n      world: restored.world,\n      clientMode: current.clientMode,\n    });',
        "    void restored.world;",
      );
      break;
    case "runtime-reconnect-removed":
      controllerSource = replaceOnce(
        controllerSource,
        "    runtimeStreams.connectRuntimeStream(restored.activeEndpointKey);",
        "    void restored.activeEndpointKey;",
      );
      break;
    case "register-not-awaited":
      controllerSource = replaceOnce(
        controllerSource,
        '    await presence.registerPresence({ spawnReason: "return_from_client_scene_load" });',
        '    void presence.registerPresence({ spawnReason: "return_from_client_scene_load" });',
      );
      break;
    case "forced-pose-before-register":
      controllerSource = replaceOnce(
        controllerSource,
        '    await presence.registerPresence({ spawnReason: "return_from_client_scene_load" });\n    peers.broadcastPlayerPose({ force: true });',
        '    peers.broadcastPlayerPose({ force: true });\n    await presence.registerPresence({ spawnReason: "return_from_client_scene_load" });',
      );
      break;
    case "state-emit-before-register":
      controllerSource = replaceOnce(
        controllerSource,
        '    await presence.registerPresence({ spawnReason: "return_from_client_scene_load" });\n    peers.broadcastPlayerPose({ force: true });\n    emitState();',
        '    emitState();\n    await presence.registerPresence({ spawnReason: "return_from_client_scene_load" });\n    peers.broadcastPlayerPose({ force: true });',
      );
      break;
    case "return-event-removed":
      controllerSource = replaceOnce(controllerSource, "    dispatchCrossing(detail);", "    void detail;");
      break;
    case "return-event-duplicated":
      controllerSource = replaceOnce(controllerSource, "    dispatchCrossing(detail);", "    dispatchCrossing(detail);\n    dispatchCrossing(detail);");
      break;
    case "return-kind-drift":
      controllerSource = replaceOnce(controllerSource, '      kind: "return_to_lobby",', '      kind: "lobby_return",');
      break;
    case "debug-shape-drift":
      controllerSource = replaceOnce(controllerSource, '          transition: "client_scene_load",', '          transition: "scene_load",');
      break;
    case "rollback-active-marker-removed":
      controllerSource = replaceOnce(controllerSource, "    activeRecord = {\n      origin,", "    const pendingActiveRecord = {\n      origin,");
      controllerSource = replaceOnce(
        controllerSource,
        "      avatar: host.avatar,\n    });\n    peers.clear();",
        "      avatar: host.avatar,\n    });\n    activeRecord = pendingActiveRecord;\n    peers.clear();",
      );
      break;
    case "avatar-cloned":
      adapterSource = replaceOnce(adapterSource, "      this.state.avatar = avatar;", "      this.state.avatar = { ...avatar };");
      break;
    case "equipment-cloned":
      adapterSource = replaceOnce(adapterSource, "        avatar.equippedItems = equippedItems;", "        avatar.equippedItems = [...equippedItems];");
      break;
    case "equipment-status-rebuilt":
      adapterSource = replaceOnce(
        adapterSource,
        "      this.state.avatar = avatar;",
        "      this.state.equipment_status = { ...this.state.equipment_status };\n      this.state.avatar = avatar;",
      );
      break;
    case "endpoint-switched-on-entry":
      adapterSource = replaceOnce(adapterSource, "      this._wowResolved = resolved;", "      this.endpoint = target;\n      this._wowResolved = resolved;");
      break;
    case "lobby-world-restore-removed":
      adapterSource = replaceOnce(adapterSource, "      this.world = origin.world;", "      void origin.world;");
      break;
    case "facade-bypass":
      adapterSource = replaceOnce(
        adapterSource,
        "    return this._clientSceneController.enter({ target, contract, resolved, bounds });",
        "    return resolved;",
      );
      break;
    case "":
      break;
    default:
      throw new Error(`unknown mutation: ${name}`);
  }
}

applyMutation(MUTATION);

let tempDir = null;
let moduleUrl = pathToFileURL(CONTROLLER_PATH).href;
if (MUTATION && controllerSource !== readFileSync(CONTROLLER_PATH, "utf8")) {
  tempDir = mkdtempSync(join(tmpdir(), "runtime-p15-controller-"));
  const mutatedPath = join(tempDir, "live-adapter-client-scene-controller.mjs");
  writeFileSync(mutatedPath, controllerSource);
  moduleUrl = pathToFileURL(mutatedPath).href;
}
const { createClientSceneLifecycleController } = await import(`${moduleUrl}?mutation=${encodeURIComponent(MUTATION)}-${Date.now()}`);
if (tempDir) {
  process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function endpointDebug(endpoint, world) {
  return {
    endpoint_key: endpoint ? endpoint.key : null,
    location_id: world ? world.location_id : null,
  };
}

function validInput() {
  return {
    target: {
      transition: "client_scene_load",
      portal_id: "lobby-portal-c",
      spatial_id: "denver-airport-terminal",
      graph_endpoint: "/fixtures/airport/spatial.json",
    },
    contract: {
      spatial_id: "denver-airport-terminal",
      entry_spawn: { position: [11, 2, -7, 99], rotation_y: 1.25 },
      proof_boundary: {
        application_level_handoff: false,
        standards_conformance: false,
      },
    },
    resolved: {
      graph: { title: "Denver Skyport" },
      graph_url: "/fixtures/airport/spatial.json",
      spatialID: "denver-airport-terminal",
      node_count: 17,
    },
    bounds: { minX: -20, maxX: 20, minZ: -12, maxZ: 12 },
  };
}

function makeHarness(options = {}) {
  const trace = [];
  const lobbyEndpoint = { key: "lobby", marker: "endpoint-ref" };
  const previewEndpoint = { key: "a", marker: "preview-endpoint-ref" };
  const lobbyWorld = {
    location_id: "lobby",
    session_id: "session-1",
    avatar: { spawn_position: [2, 0, 4], rotation_y: 0.75 },
    marker: "lobby-world-ref",
  };
  const preview = { marker: "preview-ref" };
  const portalPreviews = { c: { marker: "portal-preview-ref" } };
  const wowResolved = { marker: "wow-resolved-ref" };
  const wowSceneSource = { marker: "wow-scene-source-ref" };
  const equipment = [{ itemId: "hat" }];
  const equipmentStatus = { ok: true, marker: "equipment-status-ref" };
  const avatar = {
    avatar_id: "avatar-1",
    continuity_id: "continuity-1",
    display_name: "Player One",
    position: [8, 0, 9],
    rotation_y: 0.2,
    avatar_variant: "robot",
    preferred_height_m: 1.8,
    identity: { player_id: "player-1" },
    equippedItems: equipment,
    locomotion: null,
  };
  const controls = {
    enabled: true,
    moving: true,
    grounded: false,
    nested: { marker: "controls-value" },
    portal_count: 3,
  };
  const movementBounds = { minX: -5, maxX: 5, minZ: -6, maxZ: 6 };
  const boundaryProblems = ["saved-boundary-problem"];
  const peerPlayerPoses = { peer: { player_id: "peer-1" } };
  const livePlayerPose = { player_id: "live-1" };
  let peerState = { peerPlayerPoses, livePlayerPose };
  const browserContext = { marker: "browser-context-ref" };
  const controlledIdentity = { player_id: "player-1", client_id: "client-1" };
  const host = {
    clientMode: options.clientMode || "player",
    activeEndpointKey: "lobby",
    previewEndpointKey: "a",
    endpoint: lobbyEndpoint,
    previewEndpoint,
    base: "/api/lobby",
    portalId: "lobby-portal-a",
    world: lobbyWorld,
    controls,
    preview,
    portalPreviews,
    phase: "crossing",
    arrivalCount: 7,
    movementBounds,
    wowLocalWalk: false,
    wowResolved,
    wowSceneSource,
    boundaryOk: false,
    boundaryProblems,
    avatar: options.missingAvatar ? null : avatar,
    equipmentStatus,
    browserContext,
    controlledIdentity,
  };
  const crossings = [];
  const prefetched = [];
  const registrations = [];
  let capturedOrigin = null;
  let fallbackCalls = 0;
  let controller;
  const departureGate = options.departureGate || null;
  const registrationGate = options.registrationGate || null;

  const readHostState = () => {
    trace.push("readHost");
    return { ...host };
  };
  const installClientSceneState = ({ origin, target, contract, resolved, bounds, spawn, avatar: installedAvatar }) => {
    trace.push(`install:active=${controller.active()}`);
    capturedOrigin = origin;
    host.world = {
      location_id: contract.spatial_id,
      session_id: origin.world ? origin.world.session_id : null,
      title: resolved.graph.title,
      claim_boundary: {
        application_level_handoff: false,
        native_teleportxr_teleport: false,
        first_party_teleportxr_browser_rendering: false,
        standards_conformance: false,
      },
      portal: null,
      portals: [],
      avatar: {
        avatar_id: installedAvatar.avatar_id,
        continuity_id: installedAvatar.continuity_id,
        display_name: installedAvatar.display_name,
        spawn_position: spawn.slice(),
        rotation_y: contract.entry_spawn.rotation_y,
      },
      arrival: { kind: "client_scene_load", position: spawn.slice() },
    };
    host.wowResolved = resolved;
    host.wowSceneSource = { via: "client_scene_load", resolved_from: target.graph_endpoint };
    host.boundaryOk = true;
    host.boundaryProblems = [];
    host.wowLocalWalk = true;
    host.movementBounds = bounds ? { ...bounds } : null;
    installedAvatar.position = spawn;
    installedAvatar.rotation_y = contract.entry_spawn.rotation_y;
    host.phase = "idle";
    host.arrivalCount = 0;
    host.preview = null;
    host.portalPreviews = null;
    host.controls = {
      ...origin.controls,
      enabled: true,
      moving: false,
      grounded: true,
      jump_height_m: 0,
      movement_direction: "none",
      last_planar_delta: [0, 0, 0],
      portal_focus_portal_id: null,
      portal_count: 0,
      portals: [],
    };
    installedAvatar.locomotion = host.controls;
    if (options.installFailure) throw new Error("injected install failure");
    return { activeEndpointKey: host.activeEndpointKey, endpoint: host.endpoint, world: host.world };
  };
  const restoreLobbyState = ({ origin, avatar: restoredAvatar, equippedItems }) => {
    trace.push("restore");
    host.activeEndpointKey = origin.activeEndpointKey;
    host.previewEndpointKey = origin.previewEndpointKey;
    host.endpoint = origin.endpoint;
    host.previewEndpoint = origin.previewEndpoint;
    host.base = origin.base;
    host.portalId = origin.portalId;
    host.world = origin.world;
    host.movementBounds = origin.movementBounds;
    host.wowLocalWalk = origin.wowLocalWalk;
    host.wowResolved = origin.wowResolved;
    host.wowSceneSource = origin.wowSceneSource;
    host.boundaryOk = origin.boundaryOk;
    host.boundaryProblems = origin.boundaryProblems;
    host.controls = JSON.parse(JSON.stringify(origin.controls || {}));
    host.phase = "idle";
    host.arrivalCount = origin.arrivalCount;
    host.preview = origin.preview;
    host.portalPreviews = origin.portalPreviews;
    host.avatar = restoredAvatar;
    if (restoredAvatar) {
      restoredAvatar.position = host.world.avatar.spawn_position.slice();
      restoredAvatar.rotation_y = host.world.avatar.rotation_y;
      restoredAvatar.equippedItems = equippedItems;
      restoredAvatar.locomotion = host.controls;
    }
    return { activeEndpointKey: host.activeEndpointKey, endpoint: host.endpoint, world: host.world };
  };
  controller = createClientSceneLifecycleController({
    nowIso: () => "2026-07-14T23:45:21.000Z",
    resolveClientGraph: async (target) => {
      trace.push(`resolve:${target.graph_endpoint}`);
      if (options.resolveFailure) throw new Error("graph failed");
      return options.resolveValue || validInput().resolved;
    },
    readHostState,
    installClientSceneState,
    restoreLobbyState,
    endpointDebug,
    defaultEquippedItems: () => {
      fallbackCalls += 1;
      return [{ itemId: "fallback" }];
    },
    presence: {
      departPresence: async (input) => {
        trace.push(`depart:start:${input.base}:${input.reason}`);
        if (departureGate) await departureGate.promise;
        trace.push("depart:end");
        return null;
      },
      stopHeartbeat: () => trace.push("heartbeat:stop"),
      clearRegistration: () => trace.push("registration:clear"),
      registerPresence: async (input) => {
        trace.push(`register:start:${input.spawnReason}`);
        registrations.push(input);
        if (registrationGate) await registrationGate.promise;
        trace.push("register:end");
        return options.registrationValue === undefined ? { ok: true } : options.registrationValue;
      },
    },
    runtimeStreams: {
      closeRuntimeStream: () => {
        trace.push(options.containedCloseFailure ? "runtime:close-contained-error" : "runtime:close");
      },
      connectRuntimeStream: (endpointKey) => trace.push(`runtime:connect:${endpointKey}`),
    },
    peers: {
      snapshot: () => {
        trace.push("peers:snapshot");
        return peerState;
      },
      clear: () => {
        trace.push("peers:clear");
        peerState = { peerPlayerPoses: {}, livePlayerPose: null };
      },
      restore: (saved) => {
        trace.push("peers:restore");
        peerState = saved;
      },
      broadcastPlayerPose: ({ force }) => trace.push(`pose:${force}`),
    },
    prefetch: {
      reset: (input) => {
        trace.push(`prefetch:${input.reason}:active=${controller.active()}`);
        prefetched.push(input);
      },
    },
    updatePortalStatus: () => trace.push("portal:status"),
    emitState: () => trace.push("state:emit"),
    dispatchCrossing: (detail) => {
      trace.push(`crossing:${detail.kind}`);
      crossings.push(detail);
    },
  });

  return {
    controller,
    host,
    trace,
    crossings,
    prefetched,
    registrations,
    references: {
      lobbyEndpoint,
      previewEndpoint,
      lobbyWorld,
      preview,
      portalPreviews,
      wowResolved,
      wowSceneSource,
      equipment,
      equipmentStatus,
      avatar,
      controls,
      movementBounds,
      boundaryProblems,
      peerPlayerPoses,
      livePlayerPose,
      browserContext,
      controlledIdentity,
    },
    peerState: () => peerState,
    capturedOrigin: () => capturedOrigin,
    fallbackCalls: () => fallbackCalls,
  };
}

function lifecycleTrace(trace) {
  return trace.filter((item) => !item.startsWith("readHost"));
}

function segmentBetween(source, start, end) {
  const startAt = source.indexOf(start);
  assert.notEqual(startAt, -1, `segment start missing: ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `segment end missing: ${end}`);
  return source.slice(startAt, endAt);
}

function assertTokensInOrder(source, tokens, label) {
  let cursor = -1;
  for (const token of tokens) {
    const next = source.indexOf(token, cursor + 1);
    assert.notEqual(next, -1, `${label}: missing ordered token ${token}`);
    assert.equal(next > cursor, true, `${label}: token out of order ${token}`);
    cursor = next;
  }
}

let checks = 0;
async function check(name, assertion) {
  await assertion();
  checks += 1;
  console.log(`PASS ${String(checks).padStart(2, "0")} ${name}`);
}

await check("controller is one dependency-clean lifecycle owner", async () => {
  assert.equal((controllerSource.match(/export function createClientSceneLifecycleController/g) || []).length, 1);
  assert.doesNotMatch(controllerSource, /from ["']\.\/live-adapter\.js|from ["']\.\/app\.js/);
  assert.doesNotMatch(controllerSource, /\bfetch\s*\(|\bWebSocket\b|setTimeout\s*\(|setInterval\s*\(|document\.|window\.|requestAnimationFrame|BroadcastChannel/);
  assert.doesNotMatch(controllerSource, /handoff_id|exit-intent|portal\/arrival|signManifest|traversal/);
  assert.match(adapterSource, /createClientSceneLifecycleController\(\{/);
  assert.doesNotMatch(adapterSource, /this\._clientSceneLoad/);
});

await check("missing graph endpoint throws before resolver or host work", async () => {
  const h = makeHarness();
  await assert.rejects(() => h.controller.resolve({}), /client scene load requires target\.graph_endpoint/);
  assert.deepEqual(h.trace, []);
});

await check("resolve delegates exactly once without activating or mutating host state", async () => {
  const h = makeHarness();
  const beforeWorld = h.host.world;
  const resolved = await h.controller.resolve({ graph_endpoint: "/graph.json" });
  assert.equal(resolved.spatialID, "denver-airport-terminal");
  assert.deepEqual(h.trace, ["resolve:/graph.json"]);
  assert.equal(h.controller.active(), false);
  assert.equal(h.host.world, beforeWorld);
});

await check("resolve rejection propagates through the injected restored-state leaf", async () => {
  const h = makeHarness({ resolveFailure: true });
  await assert.rejects(() => h.controller.resolve({ graph_endpoint: "/bad.json" }), /graph failed/);
  assert.deepEqual(h.trace, ["resolve:/bad.json"]);
  assert.equal(h.controller.active(), false);
});

await check("all current entry refusals are exact and lifecycle-side-effect free", async () => {
  const input = validInput();
  const cases = [
    [{ clientMode: "observer" }, input, "not_player"],
    [{}, { ...input, target: { ...input.target, transition: "handoff" } }, "invalid_client_scene_load_target"],
    [{}, { ...input, contract: null }, "invalid_client_scene_load_contract"],
    [{}, { ...input, resolved: { ...input.resolved, graph: null } }, "invalid_client_scene_load_contract"],
    [{}, { ...input, contract: { ...input.contract, spatial_id: "other" } }, "invalid_client_scene_load_contract"],
    [{}, { ...input, contract: { ...input.contract, proof_boundary: null } }, "client_scene_load_claim_boundary_mismatch"],
    [{ missingAvatar: true }, input, "missing_avatar"],
  ];
  for (const [options, value, reason] of cases) {
    const h = makeHarness(options);
    assert.deepEqual(await h.controller.enter(value), { ok: false, reason });
    assert.deepEqual(lifecycleTrace(h.trace), []);
  }
  const active = makeHarness();
  assert.equal((await active.controller.enter(input)).ok, true);
  assert.deepEqual(await active.controller.enter(input), { ok: false, reason: "client_scene_load_active" });
});

await check("target, graph, spatial equality, and both false claims remain required", async () => {
  const input = validInput();
  for (const changed of [
    { ...input, target: { ...input.target, transition: "client_scene" } },
    { ...input, resolved: { ...input.resolved, graph: null } },
    { ...input, contract: { ...input.contract, spatial_id: "not-target" } },
    { ...input, contract: { ...input.contract, proof_boundary: { ...input.contract.proof_boundary, application_level_handoff: true } } },
    { ...input, contract: { ...input.contract, proof_boundary: { ...input.contract.proof_boundary, standards_conformance: true } } },
  ]) {
    const h = makeHarness();
    assert.equal((await h.controller.enter(changed)).ok, false);
    assert.deepEqual(lifecycleTrace(h.trace), []);
  }
});

await check("origin snapshot clones values and preserves exact references", async () => {
  const h = makeHarness();
  await h.controller.enter(validInput());
  const origin = h.capturedOrigin();
  assert.notEqual(origin.controls, h.references.controls);
  assert.deepEqual(origin.controls, h.references.controls);
  assert.notEqual(origin.controls.nested, h.references.controls.nested);
  assert.notEqual(origin.movementBounds, h.references.movementBounds);
  assert.deepEqual(origin.movementBounds, h.references.movementBounds);
  assert.notEqual(origin.boundaryProblems, h.references.boundaryProblems);
  assert.deepEqual(origin.boundaryProblems, h.references.boundaryProblems);
  assert.equal(origin.endpoint, h.references.lobbyEndpoint);
  assert.equal(origin.previewEndpoint, h.references.previewEndpoint);
  assert.equal(origin.world, h.references.lobbyWorld);
  assert.equal(origin.preview, h.references.preview);
  assert.equal(origin.portalPreviews, h.references.portalPreviews);
  assert.equal(origin.wowResolved, h.references.wowResolved);
  assert.equal(origin.wowSceneSource, h.references.wowSceneSource);
});

await check("deferred departure blocks every shutdown and adoption side effect", async () => {
  const gate = deferred();
  const h = makeHarness({ departureGate: gate });
  const originalWorld = h.host.world;
  const entering = h.controller.enter(validInput());
  assert.deepEqual(h.trace, ["readHost", "peers:snapshot", "depart:start:/api/lobby:client_scene_load"]);
  assert.equal(h.controller.active(), false);
  h.host.world = { location_id: "post-depart-drift" };
  gate.resolve();
  assert.equal((await entering).ok, true);
  assert.equal(h.capturedOrigin().world, originalWorld);
});

await check("entry trace is snapshot then awaited shutdown then adoption and publish", async () => {
  const h = makeHarness();
  await h.controller.enter(validInput());
  assert.deepEqual(lifecycleTrace(h.trace), [
    "peers:snapshot",
    "depart:start:/api/lobby:client_scene_load",
    "depart:end",
    "heartbeat:stop",
    "registration:clear",
    "runtime:close",
    "install:active=true",
    "peers:clear",
    "prefetch:client_scene_load:active=true",
    "portal:status",
    "state:emit",
  ]);
});

await check("accepted runtime-close failure containment still allows entry", async () => {
  const h = makeHarness({ containedCloseFailure: true });
  const result = await h.controller.enter(validInput());
  assert.equal(result.ok, true);
  assert.equal(h.trace.includes("runtime:close-contained-error"), true);
  assert.equal(h.controller.active(), true);
});

await check("entry installs client-local graph controls bounds and claims without endpoint switch", async () => {
  const h = makeHarness();
  const endpoint = h.host.endpoint;
  const base = h.host.base;
  const identity = h.host.controlledIdentity;
  const browserContext = h.host.browserContext;
  await h.controller.enter(validInput());
  assert.equal(h.host.world.location_id, "denver-airport-terminal");
  assert.deepEqual(h.host.world.portals, []);
  assert.equal(h.host.world.claim_boundary.application_level_handoff, false);
  assert.equal(h.host.world.claim_boundary.standards_conformance, false);
  assert.equal(h.host.endpoint, endpoint);
  assert.equal(h.host.base, base);
  assert.equal(h.host.controlledIdentity, identity);
  assert.equal(h.host.browserContext, browserContext);
  assert.deepEqual(h.host.movementBounds, validInput().bounds);
  assert.equal(h.host.controls.enabled, true);
  assert.equal(h.host.controls.moving, false);
});

await check("avatar equipment and equipment-status identities survive entry", async () => {
  const h = makeHarness();
  const avatar = h.host.avatar;
  const equipment = avatar.equippedItems;
  const equipmentStatus = h.host.equipmentStatus;
  await h.controller.enter(validInput());
  assert.equal(h.host.avatar, avatar);
  assert.equal(h.host.avatar.equippedItems, equipment);
  assert.equal(h.host.equipmentStatus, equipmentStatus);
  assert.deepEqual(avatar.position, [11, 2, -7]);
  assert.equal(avatar.rotation_y, 1.25);
  assert.equal(avatar.locomotion, h.host.controls);
  assert.equal(avatar.avatar_variant, "robot");
  assert.equal(avatar.identity.player_id, "player-1");
});

await check("entry invokes no backend handoff arrival signing navigation or crossing", async () => {
  const h = makeHarness();
  await h.controller.enter(validInput());
  assert.deepEqual(h.crossings, []);
  assert.equal(h.trace.some((item) => /handoff|arrival|sign|navigate|crossing/.test(item)), false);
  assert.doesNotMatch(controllerSource, /exit-intent|portal\/arrival|handoff_id|location\.|history\.|signManifest/);
});

await check("entry receipt and active debug are exact defensive views", async () => {
  const h = makeHarness();
  const result = await h.controller.enter(validInput());
  assert.deepEqual(result, {
    ok: true,
    kind: "client_scene_load",
    portal_id: "lobby-portal-c",
    from: { endpoint_key: "lobby", location_id: "lobby" },
    to: { endpoint_key: "lobby", location_id: "denver-airport-terminal" },
    same_context: true,
    same_player: true,
    no_page_reload: true,
    application_level_handoff: false,
  });
  const first = h.controller.debug();
  assert.deepEqual(first, {
    active: true,
    transition: "client_scene_load",
    target: validInput().target,
    contract: validInput().contract,
    entered_at: "2026-07-14T23:45:21.000Z",
    same_context: true,
    same_player: true,
    no_page_reload: true,
    application_level_handoff: false,
    reciprocal: {
      portal: null,
      synthesized: false,
      reason: "automatic_reciprocal_unavailable",
    },
  });
  first.target.spatial_id = "mutated";
  first.contract.entry_spawn.position[0] = 999;
  assert.equal(h.controller.debug().target.spatial_id, "denver-airport-terminal");
  assert.equal(h.controller.debug().contract.entry_spawn.position[0], 11);
});

await check("entry clears peers and resets Patch 14 exactly once", async () => {
  const h = makeHarness();
  await h.controller.enter(validInput());
  assert.equal(h.trace.filter((item) => item === "peers:clear").length, 1);
  assert.equal(h.prefetched.length, 1);
  assert.equal(h.prefetched[0].reason, "client_scene_load");
  assert.equal(h.prefetched[0].world, h.host.world);
  assert.deepEqual(h.peerState(), { peerPlayerPoses: {}, livePlayerPose: null });
});

await check("inactive return is exact and side-effect free", async () => {
  const h = makeHarness();
  assert.deepEqual(await h.controller.returnToLobby(), {
    ok: false,
    reason: "client_scene_load_not_active",
  });
  assert.deepEqual(h.trace, []);
});

await check("return restores exact lobby references and controls by value at authored spawn", async () => {
  const h = makeHarness();
  await h.controller.enter(validInput());
  const airportControls = h.host.controls;
  await h.controller.returnToLobby();
  assert.equal(h.host.world, h.references.lobbyWorld);
  assert.equal(h.host.endpoint, h.references.lobbyEndpoint);
  assert.equal(h.host.previewEndpoint, h.references.previewEndpoint);
  assert.equal(h.host.preview, h.references.preview);
  assert.equal(h.host.portalPreviews, h.references.portalPreviews);
  assert.equal(h.host.wowResolved, h.references.wowResolved);
  assert.equal(h.host.wowSceneSource, h.references.wowSceneSource);
  assert.notEqual(h.host.controls, h.references.controls);
  assert.notEqual(h.host.controls, airportControls);
  assert.deepEqual(h.host.controls, h.references.controls);
  assert.equal(h.host.phase, "idle");
  assert.deepEqual(h.host.avatar.position, [2, 0, 4]);
  assert.equal(h.host.avatar.rotation_y, 0.75);
  assert.equal(h.host.avatar, h.references.avatar);
  assert.equal(h.peerState().peerPlayerPoses, h.references.peerPlayerPoses);
  assert.equal(h.peerState().livePlayerPose, h.references.livePlayerPose);
});

await check("return preserves current equipment reference and fallback is no-array only", async () => {
  const normal = makeHarness();
  await normal.controller.enter(validInput());
  const airportEquipment = [{ itemId: "airport-change" }];
  normal.host.avatar.equippedItems = airportEquipment;
  await normal.controller.returnToLobby();
  assert.equal(normal.host.avatar.equippedItems, airportEquipment);
  assert.equal(normal.fallbackCalls(), 0);

  const fallback = makeHarness();
  await fallback.controller.enter(validInput());
  delete fallback.host.avatar.equippedItems;
  await fallback.controller.returnToLobby();
  assert.deepEqual(fallback.host.avatar.equippedItems, [{ itemId: "fallback" }]);
  assert.equal(fallback.fallbackCalls(), 1);
});

await check("return trace restores then reconnects then emits one crossing", async () => {
  const h = makeHarness();
  await h.controller.enter(validInput());
  h.trace.length = 0;
  await h.controller.returnToLobby();
  assert.deepEqual(h.trace, [
    "readHost",
    "restore",
    "peers:restore",
    "prefetch:return_from_client_scene_load:active=false",
    "portal:status",
    "runtime:connect:lobby",
    "register:start:return_from_client_scene_load",
    "register:end",
    "pose:true",
    "state:emit",
    "crossing:return_to_lobby",
  ]);
});

await check("deferred registration gates pose emit crossing and success after runtime connect", async () => {
  const gate = deferred();
  const h = makeHarness({ registrationGate: gate });
  await h.controller.enter(validInput());
  h.trace.length = 0;
  const returning = h.controller.returnToLobby();
  assert.deepEqual(h.trace, [
    "readHost",
    "restore",
    "peers:restore",
    "prefetch:return_from_client_scene_load:active=false",
    "portal:status",
    "runtime:connect:lobby",
    "register:start:return_from_client_scene_load",
  ]);
  assert.equal(h.controller.active(), false);
  assert.equal(h.crossings.length, 0);
  gate.resolve();
  assert.equal((await returning).ok, true);
  assert.equal(h.crossings.length, 1);
});

await check("contained null registration still completes pose state and crossing", async () => {
  const h = makeHarness({ registrationValue: null });
  await h.controller.enter(validInput());
  h.trace.length = 0;
  const result = await h.controller.returnToLobby();
  assert.equal(result.ok, true);
  assert.equal(h.trace.includes("pose:true"), true);
  assert.equal(h.trace.includes("state:emit"), true);
  assert.equal(h.crossings.length, 1);
});

await check("active clears before await so concurrent return cannot duplicate crossing", async () => {
  const gate = deferred();
  const h = makeHarness({ registrationGate: gate });
  await h.controller.enter(validInput());
  const first = h.controller.returnToLobby();
  assert.equal(h.controller.active(), false);
  assert.deepEqual(await h.controller.returnToLobby(), {
    ok: false,
    reason: "client_scene_load_not_active",
  });
  gate.resolve();
  assert.equal((await first).kind, "return_to_lobby");
  assert.equal(h.crossings.length, 1);
  assert.equal(h.crossings[0].kind, "return_to_lobby");
});

await check("heartbeat and target-stream transitions stay in accepted Patch 13/14 owners", async () => {
  const h = makeHarness();
  await h.controller.enter(validInput());
  await h.controller.returnToLobby();
  assert.equal(h.trace.filter((item) => item === "heartbeat:stop").length, 1);
  assert.equal(h.registrations.length, 1);
  assert.deepEqual(h.prefetched.map((input) => input.reason), [
    "client_scene_load",
    "return_from_client_scene_load",
  ]);
  assert.doesNotMatch(controllerSource, /syncEventStreams|startHeartbeat|reconnect_timer/);
});

await check("post-adoption failure remains active for public rollback recovery", async () => {
  const h = makeHarness({ installFailure: true });
  await assert.rejects(() => h.controller.enter(validInput()), /injected install failure/);
  assert.equal(h.controller.active(), true);
  assert.equal(h.host.world.location_id, "denver-airport-terminal");
  const returned = await h.controller.returnToLobby();
  assert.equal(returned.ok, true);
  assert.equal(h.host.world, h.references.lobbyWorld);
  assert.equal(h.crossings.length, 1);
});

await check("adapter facades branch debug and suppression route only through the controller", async () => {
  const facadeSource = segmentBetween(adapterSource, "  async resolveClientSceneLoad(target) {", "  async _initPlayerPreview() {");
  assertTokensInOrder(facadeSource, [
    "async resolveClientSceneLoad(target)",
    "this._clientSceneController.resolve(target)",
    "async enterClientSceneLoad({ target, contract, resolved, bounds } = {})",
    "this._clientSceneController.enter({ target, contract, resolved, bounds })",
    "async returnFromClientSceneLoad(options)",
    "if (!options) return this._clientSceneController.returnToLobby()",
    "this._clientSceneController.returnToLobby(options)",
  ], "adapter client-scene facades");
  assert.match(adapterSource, /if \(this\._clientSceneController\.active\(\)\) return this\.returnFromClientSceneLoad\(\);/);
  assert.match(adapterSource, /client_scene_load: this\._clientSceneController\.debug\(\)/);
  assert.match(adapterSource, /if \(this\._clientSceneController\.active\(\) \|\| this\._wowLocalWalk\) return \[\];/);
  const installSource = segmentBetween(adapterSource, "    const installClientSceneState =", "    const restoreLobbyState =");
  const restoreSource = segmentBetween(adapterSource, "    const restoreLobbyState =", "    this._clientSceneController =");
  assert.doesNotMatch(installSource, /this\.endpoint\s*=|this\.base\s*=/);
  assert.doesNotMatch(installSource, /equipment_status\s*=/);
  assert.match(restoreSource, /this\.world = origin\.world;/);
  assert.match(restoreSource, /this\.state\.avatar = avatar;/);
  assert.match(restoreSource, /avatar\.equippedItems = equippedItems;/);
  assert.doesNotMatch(restoreSource, /this\.state\.avatar\s*=\s*\{\s*\.\.\.avatar/);
  assert.doesNotMatch(restoreSource, /equipment_status\s*=/);
});

await check("controller owns no teardown resource or reverse dependency", async () => {
  assert.deepEqual(Object.keys(makeHarness().controller).sort(), ["active", "debug", "enter", "resolve", "returnToLobby"]);
  assert.doesNotMatch(controllerSource, /dispose\s*\(|addEventListener|removeEventListener|\.close\s*\(|\.terminate\s*\(/);
  assert.doesNotMatch(controllerSource, /scene-runtime-controller|movement-camera-controller|airport-lobby-transition|equipment-view|live-adapter-fabric-prefetch-controller/);
});

const mutationArms = [
  "resolve-validation-off",
  "client-target-validation-off",
  "claim-boundary-allow",
  "snapshot-after-depart",
  "depart-not-awaited",
  "heartbeat-stop-removed",
  "registration-clear-removed",
  "runtime-close-removed",
  "avatar-cloned",
  "equipment-cloned",
  "equipment-status-rebuilt",
  "endpoint-switched-on-entry",
  "peer-clear-removed",
  "entry-prefetch-reset-removed",
  "entry-emit-before-adoption",
  "lobby-world-restore-removed",
  "peer-reference-restore-removed",
  "active-clear-after-register",
  "return-prefetch-reset-removed",
  "runtime-reconnect-removed",
  "register-not-awaited",
  "forced-pose-before-register",
  "state-emit-before-register",
  "return-event-removed",
  "return-event-duplicated",
  "return-kind-drift",
  "debug-shape-drift",
  ...Object.keys(reciprocalDiagnosticMutations),
  "facade-bypass",
  "rollback-active-marker-removed",
];

if (!MUTATION) {
  for (const arm of mutationArms) {
    let turnedRed = false;
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
        cwd: ROOT,
        env: { ...process.env, feature_P15_MUTATION: arm },
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (error) {
      turnedRed = Number.isInteger(error.status) && error.status !== 0;
    }
    assert.equal(turnedRed, true, `mutation arm ${arm} must turn the focused check RED`);
    console.log(`RED_CAUGHT ${arm}`);
  }
  console.log(`feature_CLIENT_SCENE_CONTROLLER PASS ${checks}/26 mutations=${mutationArms.length}/${mutationArms.length}`);
}

if (tempDir) rmSync(tempDir, { recursive: true, force: true });
