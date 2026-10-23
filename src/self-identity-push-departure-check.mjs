import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as THREE from "three";

const require = createRequire(import.meta.url);
const { applySourceMutation } = require("./source-mutations.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const previewModuleRoot = mkdtempSync(path.join(tmpdir(), "runtime-preview-module-"));
let SpatialPortalPreviewManager;
let portalAwarenessVolume;
try {
  const tempPreviewPath = path.join(previewModuleRoot, "portal-spatial-preview.mjs");
  const tempGeometryPath = path.join(
    previewModuleRoot,
    "live-adapter-portal-geometry.mjs",
  );
  const tempThreeDirectory = path.join(
    previewModuleRoot,
    "vendor/scene-core",
    "vendor",
    "three",
  );
  mkdirSync(tempThreeDirectory, { recursive: true });
  copyFileSync(
    path.join(ROOT, "web", "portal-spatial-preview.mjs"),
    tempPreviewPath,
  );
  symlinkSync(
    path.join(ROOT, "web", "live-adapter-portal-geometry.mjs"),
    tempGeometryPath,
  );
  symlinkSync(
    path.join(ROOT, "node_modules", "three", "build", "three.module.js"),
    path.join(tempThreeDirectory, "three.module.js"),
  );
  ({ SpatialPortalPreviewManager, portalAwarenessVolume } = await import(
    pathToFileURL(tempPreviewPath).href,
  ));
} finally {
  rmSync(previewModuleRoot, { recursive: true, force: true });
}
const SELF = "player-controlled-140";
const OTHER = "player-real-peer-140";
const GUARD = "player-real-peer-guard-140";
const sharedProfile = {
  avatar_id: "avatar-local-001",
  continuity_id: "continuity-local-001",
  display_name: "Shared hosted avatar",
};

const checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
  process.stdout.write(`PASS ${name}\n`);
}

function avatar(playerId, position) {
  return { player_id: playerId, ...sharedProfile, position, rotation_y: 0 };
}

function manager(playerId, options = {}) {
  return new SpatialPortalPreviewManager({ controlledPlayerId: () => playerId, ...options });
}

const snapshotMachine = {
  region: {
    avatars: {
      avatars: [avatar(SELF, [0, 0, 0]), avatar(OTHER, [0.5, 0, 0])],
    },
  },
  presence: { occupancy: null },
};

check("snapshot fallback suppresses only the controlled player_id", () => {
  const selected = manager(SELF)._destinationAvatars(snapshotMachine);
  assert.deepEqual(selected.map((entry) => entry.player_id), [OTHER]);
  assert.equal(selected[0].inside_destination_circle, false);
  assert.equal(selected[0].destination_circle_valid, false);
});

const liveMachine = {
  region: {
    avatars: {
      circle: { center: [0, 0, 0], radius_m: 2 },
      avatars: [avatar(SELF, [0, 0, 0]), avatar(OTHER, [0.5, 0, 0])],
    },
  },
  presence: {
    occupancy: {
      avatars: [avatar(SELF, [0.1, 0, 0]), avatar(OTHER, [0.6, 0, 0])],
    },
  },
};

check("live occupancy suppresses self and preserves a profile-identical real peer", () => {
  const preview = manager(SELF);
  const selected = preview._destinationAvatars(liveMachine);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].player_id, OTHER);
  assert.equal(selected[0].avatar_id, sharedProfile.avatar_id);
  assert.equal(selected[0].continuity_id, sharedProfile.continuity_id);
  assert.equal(selected[0].display_name, sharedProfile.display_name);
  const filter = preview._identityFilterByMachine.get(liveMachine);
  assert.deepEqual(filter.input_player_ids, [SELF, OTHER]);
  assert.deepEqual(filter.suppressed_player_ids, [SELF]);
  assert.deepEqual(filter.rendered_player_ids, [OTHER]);
});

check("negative self-filter mutation makes the same fixture render both identities", () => {
  const selected = manager(null)._destinationAvatars(liveMachine);
  assert.deepEqual(selected.map((entry) => entry.player_id), [SELF, OTHER]);
});

check("destination-circle classification is exact at the radius and remains fail-closed", () => {
  const preview = manager(SELF);
  const machine = {
    region: {
      avatars: {
        circle: { center: [0, 0, 0], radius_m: 2 },
        avatars: [avatar(OTHER, [2, 0, 0]), avatar(GUARD, [2.0001, 0, 0])],
      },
    },
    presence: {
      occupancy: {
        avatars: [avatar(OTHER, [2, 0, 0]), avatar(GUARD, [2.0001, 0, 0])],
      },
    },
  };
  const selected = preview._destinationAvatars(machine);
  assert.equal(selected.find((entry) => entry.player_id === OTHER).inside_destination_circle, true);
  assert.equal(selected.find((entry) => entry.player_id === GUARD).inside_destination_circle, false);
  machine.region.avatars.circle = null;
  assert.equal(
    preview._destinationAvatars(machine).every((entry) => entry.inside_destination_circle === false),
    true,
  );
});

class FakePortalAvatarLayer {
  constructor(_mount, _role, _world, options) {
    this.scene = options.host.scene;
    this.avatarRig = new THREE.Group();
    this.scene.add(this.avatarRig);
    this.status = {
      renderer: "webgl",
      settled: true,
      avatar_variant: "readyplayerme-cyberpunk",
      avatar_render_source: "rigged-glb",
      attached_item_count: 0,
      current_animation_state: "idle",
      locomotion_movement_mode: "idle",
      avatar_grounded: true,
      avatar_jump_height_m: 0,
    };
    this.ready = new Promise(() => {});
    this.disposed = false;
  }

  setAvatar(next) {
    this.avatar = next;
    this.avatarRig.visible = next && (!next.transition_visual || next.transition_visual.visible !== false);
    const p = next && next.position ? next.position : [0, 0, 0];
    this.avatarRig.position.set(p[0], p[1], p[2]);
    this.avatarRig.rotation.y = next ? next.rotation_y : 0;
    this.status.locomotion_movement_mode = next && next.locomotion
      ? next.locomotion.movement_mode
      : "idle";
  }

  isSettled() { return this.status.settled; }
  debugState() { return { attached_item_count: 0 }; }
  dispose() {
    this.disposed = true;
    if (this.avatarRig.parent) this.avatarRig.parent.remove(this.avatarRig);
  }
}

function representationFixture(avatarFault = null) {
  const nowMs = 10_000;
  const preview = manager(SELF, {
    AvatarLayerClass: FakePortalAvatarLayer,
    getMount: () => ({ clientWidth: 960, clientHeight: 540 }),
    nowMs: () => nowMs,
    avatarFault,
  });
  const peer = {
    ...avatar(OTHER, [1.5, 0, 0]),
    location_id: "location-b",
    avatar_variant: "readyplayerme-cyberpunk",
    equippedItems: [],
    locomotion: { moving: false, movement_mode: "idle", grounded: true },
    transition_visual: { visible: true, scale: 1 },
    seq: 4,
    last_seen_ms: 10,
  };
  preview.setPeerPlayers([peer]);
  const machine = {
    region: {
      avatars: {
        circle: { center: [0, 0, 0], radius_m: 2 },
        avatars: [avatar(OTHER, [1.5, 0, 0])],
      },
    },
    presence: { occupancy: { avatars: [avatar(OTHER, [1.5, 0, 0])] } },
  };
  const portalEntry = {
    target_location_id: "location-b",
    target_frame: { position: [0, 0, 0], forward: [0, 0, 1], pose_source: "fixture" },
  };
  const rec = {
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(),
    clipPlane: null,
    clipPlanes: [],
    awarenessVolume: portalAwarenessVolume(machine, portalEntry),
    avatarRepresentations: new Map(),
    avatarProxies: [],
  };
  return { machine, peer, portalEntry, preview, rec };
}

check("eligible high-frequency pose swaps atomically to one keyed full avatar", () => {
  const fixture = representationFixture();
  fixture.preview._reconcileAvatarRepresentations(fixture.rec, fixture.machine, fixture.portalEntry);
  const representation = fixture.rec.avatarRepresentations.get(OTHER);
  assert.equal(representation.state, "full");
  assert.equal(representation.proxy, null);
  assert.equal(representation.layer.avatarRig.visible, true);
  assert.equal(representation.layer.avatarRig.position.x, fixture.peer.position[0]);
  assert.equal(representation.pose_samples.length, 1);
});

check("legacy portal-avatar fault arms cannot restore a visible proxy representation", () => {
  const capsule = representationFixture("capsule_only");
  capsule.preview._reconcileAvatarRepresentations(capsule.rec, capsule.machine, capsule.portalEntry);
  assert.equal(capsule.rec.avatarRepresentations.has(OTHER), false);

  const coarse = representationFixture("coarse_pose");
  coarse.preview._reconcileAvatarRepresentations(coarse.rec, coarse.machine, coarse.portalEntry);
  assert.equal(coarse.rec.avatarRepresentations.has(OTHER), false);

  const widened = representationFixture("widen_circle");
  widened.machine.region.avatars.avatars[0].position = [2.5, 0, 0];
  widened.machine.presence.occupancy.avatars[0].position = [2.5, 0, 0];
  widened.peer.position = [2.5, 0, 0];
  widened.preview.setPeerPlayers([widened.peer]);
  widened.preview._reconcileAvatarRepresentations(widened.rec, widened.machine, widened.portalEntry);
  assert.equal(widened.rec.avatarRepresentations.has(OTHER), false);

  const dual = representationFixture("dual_representation");
  dual.preview._reconcileAvatarRepresentations(dual.rec, dual.machine, dual.portalEntry);
  const dualRepresentation = dual.rec.avatarRepresentations.get(OTHER);
  assert.equal(dualRepresentation.state, "full");
  assert.equal(dualRepresentation.proxy, null);
  assert.equal(dualRepresentation.layer.avatarRig.visible, true);
});

check("pose and departure preserve canonical scene identity while keyed reconcile removes the peer", () => {
  const fixture = representationFixture();
  const before = fixture.preview._signature(fixture.machine, fixture.portalEntry);
  fixture.machine.presence.occupancy.avatars[0].position = [1.6, 0, 0];
  const afterPose = fixture.preview._signature(fixture.machine, fixture.portalEntry);
  assert.equal(afterPose, before);
  fixture.machine.presence.occupancy.avatars = [];
  fixture.machine.region.avatars.avatars = [];
  assert.equal(fixture.preview._signature(fixture.machine, fixture.portalEntry), before);
  fixture.preview._reconcileAvatarRepresentations(fixture.rec, fixture.machine, fixture.portalEntry);
  assert.equal(fixture.rec.avatarRepresentations.has(OTHER), false);
});

check("a targeted departure preserves canonical content identity while preserving the real-peer guard", () => {
  const preview = manager(SELF);
  const machine = {
    region: {
      entities: [],
      region: { radius_m: 2 },
      avatars: {
        circle: { center: [0, 0, 0], radius_m: 2 },
        avatars: [avatar(SELF, [0, 0, 0]), avatar(OTHER, [0.5, 0, 0]), avatar(GUARD, [0.8, 0, 0])],
      },
    },
    presence: {
      occupancy: {
        avatars: [avatar(SELF, [0.1, 0, 0]), avatar(OTHER, [0.6, 0, 0]), avatar(GUARD, [0.9, 0, 0])],
      },
    },
  };
  const portalEntry = {
    target_location_id: "location-b",
    target_frame: { position: [0, 0, 0], forward: [0, 0, 1], pose_source: "fixture" },
  };
  const before = preview._signature(machine, portalEntry);
  machine.presence.occupancy.avatars = machine.presence.occupancy.avatars.filter(
    (entry) => entry.player_id !== OTHER
  );
  machine.region.avatars.avatars = machine.region.avatars.avatars.filter(
    (entry) => entry.player_id !== OTHER
  );
  const after = preview._signature(machine, portalEntry);
  assert.equal(after, before);
  assert.deepEqual(preview._destinationAvatars(machine).map((entry) => entry.player_id), [GUARD]);
});

const SELF_FILTER_SOURCE_ANCHOR =
  "    isHandoffInFlight: () => adapter._portalTraversalController?.inFlight?.() === true,\n" +
  "    controlledPlayerId: () => adapter.controlledIdentity().player_id,\n";
const appSource = readFileSync(path.join(ROOT, "web", "app.js"), "utf8");
const adapterSource = readFileSync(path.join(ROOT, "web", "live-adapter.js"), "utf8");
const runtimeStreamSource = readFileSync(
  path.join(ROOT, "web", "live-adapter-runtime-stream-controller.mjs"),
  "utf8",
);
const peerPresenceSource = readFileSync(
  path.join(ROOT, "web", "live-adapter-peer-presence-reducer.mjs"),
  "utf8",
);

check("production app wires the adapter's stable player_id into proxy creation", () => {
  assert.match(appSource, /controlledPlayerId:\s*\(\) => adapter\.controlledIdentity\(\)\.player_id/);
  assert.match(adapterSource, /controlled_identity:\s*this\.controlledIdentity\(\)/);
  assert.match(adapterSource, /player_id:\s*this\.controlledIdentity\(\)\.player_id/);
});

check("production browser consumes user_left and exposes targeted push diagnostics", () => {
  assert.match(runtimeStreamSource, /message\.type === "user_left"/);
  assert.match(runtimeStreamSource, /onPresenceDeparture\(endpointKey, message\)/);
  assert.match(peerPresenceSource, /function removeDepartedPlayer\(input = \{\}\)/);
  assert.match(adapterSource, /this\._peers\.removeDepartedPlayer/);
  assert.match(adapterSource, /presence_user_left_push/);
  assert.match(adapterSource, /presence_push:\s*this\._presencePushDebug\(\)/);
});

check("source mutation arms apply and the self-filter anchor fails closed", () => {
  const prior = process.env.OSL_SOURCE_MUTATION;
  try {
    assert.equal(appSource.split(SELF_FILTER_SOURCE_ANCHOR).length - 1, 1);
    process.env.OSL_SOURCE_MUTATION = "runtime-self-filter-off";
    const selfMutated = applySourceMutation("app.js", Buffer.from(appSource)).toString("utf8");
    assert.match(selfMutated, /controlledPlayerId:\s*\(\) => null/);
    assert.doesNotMatch(
      selfMutated,
      /controlledPlayerId:\s*\(\) => adapter\.controlledIdentity\(\)\.player_id/,
    );
    assert.match(
      selfMutated,
      /isHandoffInFlight:\s*\(\) => adapter\._portalTraversalController\?\.inFlight\?\.\(\) === true/,
    );
    assert.throws(
      () => applySourceMutation(
        "app.js",
        Buffer.from(appSource.replace(SELF_FILTER_SOURCE_ANCHOR, "")),
      ),
      /anchor NOT FOUND/,
    );
    assert.throws(
      () => applySourceMutation(
        "app.js",
        Buffer.from(`${appSource}\n${SELF_FILTER_SOURCE_ANCHOR}`),
      ),
      /anchor AMBIGUOUS/,
    );
    process.env.OSL_SOURCE_MUTATION = "runtime-event-consumer-off";
    const eventMutated = applySourceMutation(
      "live-adapter-peer-presence-reducer.mjs",
      Buffer.from(peerPresenceSource),
    ).toString("utf8");
    assert.match(eventMutated, /invalidation_skipped:\s*true/);
  } finally {
    if (prior == null) delete process.env.OSL_SOURCE_MUTATION;
    else process.env.OSL_SOURCE_MUTATION = prior;
  }
});

const manifest = {
  version_id: "runtime",
  captured_at: new Date().toISOString(),
  result: "PASS",
  checks,
  identity: {
    controlled_player_id: SELF,
    preserved_real_peer_player_id: OTHER,
    preserved_real_peer_guard_player_id: GUARD,
    deliberately_shared_profile: sharedProfile,
  },
  negative_arms: ["runtime-self-filter-off", "runtime-event-consumer-off"],
  claim_boundary:
    "local application-level browser validation; browser-session player_id, not account authentication or standards conformance",
};
writeFileSync(
  path.join(ROOT, "diagnostics", "runtime-deterministic-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`
);
process.stdout.write(`runtime DETERMINISTIC CHECK PASS ${checks.length}/${checks.length}\n`);
