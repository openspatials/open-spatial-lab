// The wall a camera would see through is hidden while it blocks the view, and put back exactly as it was.
import assert from "node:assert/strict";
import { THREE, createHarness } from "./controller-harness.mjs";

const materialState = (material) => ({
  transparent: material.transparent, opacity: material.opacity, depthWrite: material.depthWrite, depthTest: material.depthTest,
  side: material.side, color: material.color.getHexString(), emissive: material.emissive.getHexString(),
});

function roomWithTwoWalls() {
  const material = new THREE.MeshStandardMaterial({ color: 0x2a7ac4, side: THREE.DoubleSide });
  const leftWall = new THREE.Mesh(new THREE.PlaneGeometry(12, 5), material);
  leftWall.rotation.y = Math.PI / 2;
  leftWall.position.set(-6, 2.5, 0);
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(12, 5), material);
  backWall.position.set(0, 2.5, -6);
  const scene = new THREE.Scene();
  scene.add(leftWall, backWall);
  const impl = { scene, camera: new THREE.PerspectiveCamera() };
  const options = { impl, candidates: [], wallCandidates: [leftWall, backWall], sceneId: scene.uuid, worldId: "location-a" };
  return { material, leftWall, backWall, impl, options };
}

const BLOCKED = new THREE.Vector3(-8, 1.35, 0);
const CLEAR = new THREE.Vector3(-5, 1.35, 0);
const FOCUS = new THREE.Vector3(0, 1.35, 0);

function hidesTheBlockingWall(harness, room) {
  const { leftWall, backWall, material, options } = room;
  const preimage = materialState(material);
  const update = (camera, mode, extra = {}) => harness.controller.updatePortalOcclusion(camera, FOCUS, mode, { ...options, ...extra });
  update(BLOCKED, "player_third_person");
  let state = harness.controller.cameraWallOcclusionState();
  assert.equal(state.active, true);
  assert.equal(state.hit_wall.uuid, leftWall.uuid);
  assert.equal(state.affected_meshes[0].uuid, leftWall.uuid);
  assert.equal(leftWall.visible, false);
  assert.equal(backWall.visible, true);
  assert.deepEqual(materialState(material), preimage, "shared wall material is never mutated");
  update(CLEAR, "player_third_person");
  assert.equal(leftWall.visible, false, "one-frame clear hysteresis prevents corner flicker");
  update(CLEAR, "player_third_person");
  state = harness.controller.cameraWallOcclusionState();
  assert.equal(state.active, false);
  assert.equal(leftWall.visible, true, "wall restores within two updates");
  assert.deepEqual(state.restored.at(-1).original_state.materials, state.restored.at(-1).restored_state.materials);
  update(BLOCKED, "player_third_person");
  update(BLOCKED, "player_first_person");
  assert.equal(leftWall.visible, true, "first person restores immediately");
}

function faultArmsStayVisible(harness, room) {
  const { leftWall, backWall, options } = room;
  const update = (camera, mode, extra = {}) => harness.controller.updatePortalOcclusion(camera, FOCUS, mode, { ...options, ...extra });
  update(BLOCKED, "player_third_person", { faultArm: "disabled" });
  assert.equal(leftWall.visible, true, "disabled treatment preserves raw-depth wall");
  assert.equal(harness.controller.cameraWallOcclusionState().hit_wall.uuid, leftWall.uuid);
  update(BLOCKED, "player_third_person", { faultArm: "wrong_wall" });
  const state = harness.controller.cameraWallOcclusionState();
  assert.equal(state.hit_wall.uuid, leftWall.uuid);
  assert.equal(state.affected_meshes[0].uuid, backWall.uuid);
  assert.equal(leftWall.visible, true);
  assert.equal(backWall.visible, false);
  update(BLOCKED, "player_first_person");
  update(BLOCKED, "player_third_person");
  update(CLEAR, "player_third_person", { faultArm: "non_restoration" });
  update(CLEAR, "player_third_person", { faultArm: "non_restoration" });
  assert.equal(leftWall.visible, false, "non-restoration fault remains observably wrong");
  update(CLEAR, "player_first_person");
  assert.equal(leftWall.visible, true);
}

function restoresAtTheBoundaries(harness, room) {
  const { leftWall, options } = room;
  const update = (camera, mode, extra = options) => harness.controller.updatePortalOcclusion(camera, FOCUS, mode, extra);
  update(BLOCKED, "player_third_person");
  update(BLOCKED, "player_third_person", {
    impl: { scene: new THREE.Scene(), camera: room.impl.camera }, candidates: [], wallCandidates: [], sceneId: "replacement", worldId: "location-b",
  });
  assert.equal(leftWall.visible, true, "scene replacement restores the stale wall");
  update(BLOCKED, "player_third_person");
  harness.controller.dispose();
  assert.equal(leftWall.visible, true, "controller disposal restores the wall");
}

export function cameraWallTreatment() {
  const harness = createHarness();
  const room = roomWithTwoWalls();
  hidesTheBlockingWall(harness, room);
  faultArmsStayVisible(harness, room);
  restoresAtTheBoundaries(harness, room);
}
