// The movement and camera controller, run in Node with fakes for the window, the document and the scene runtime. The
// controller is the real module; what it is given records what it does, so a check reads that record.
import assert from "node:assert/strict";
import * as THREE from "three";
import { createMovementCameraController } from "../../web/movement-camera-controller.mjs";

export { THREE };

export class FakeTarget {
  constructor(id = "") {
    this.id = id;
    this.style = {};
    this.hidden = false;
    this.title = "";
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type, init = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() {}, ...init };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
  listenerCount(type) { return this.listeners.get(type)?.size || 0; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(child) { child.parentNode = this; this.children.push(child); }
  removeChild(child) { this.children = this.children.filter((value) => value !== child); child.parentNode = null; }
}

/** A body that is a box 1 m high, centred on the rig's floor: its feet start 0.5 m under it. */
export function bodyBelowFloor() {
  const model = new THREE.Group();
  model.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 1, 0.4), new THREE.MeshBasicMaterial()));
  return model;
}

function frameQueue() {
  const frames = new Map();
  const cancelled = [];
  let next = 1;
  return {
    frames, cancelled,
    request: (callback) => { const id = next++; frames.set(id, callback); return id; },
    cancel: (id) => { cancelled.push(id); frames.delete(id); },
    run(timestamp) {
      const [id, callback] = frames.entries().next().value || [];
      assert.ok(callback, "expected one queued frame");
      frames.delete(id);
      callback(timestamp);
    },
  };
}

function fakeRuntime(trace, stepped, forced, onStep) {
  const state = {
    avatar: { avatar_id: "avatar", position: [0, 0, 0], rotation_y: 0 },
    controls: { grounded: true },
    preview: { source_type: "fixture" },
  };
  const runtime = {
    state,
    world: { location_id: "location-a" },
    stepAvatar(input, dt) { trace.push("step"); stepped.push({ input: { ...input }, dt }); if (onStep) onStep(); },
    debugState: () => ({ avatar: state.avatar, controls: state.controls }),
    shouldAutoHandoff: () => false,
    markAutoHandoffObserved: () => trace.push("auto-observed"),
    broadcastPlayerPose: (options) => { trace.push("pose"); forced.push(options); },
  };
  return { state, runtime };
}

function fakeDocument() {
  const documentTarget = new FakeTarget("document");
  documentTarget.body = new FakeTarget("body");
  documentTarget.createElement = (tag) => new FakeTarget(tag);
  return { windowTarget: new FakeTarget("window"), documentTarget, mount: new FakeTarget("scene-mount") };
}

/** The camera, the avatar's rig and the scene that holds it; `model` is the body, if the check needs one. */
function fakeScene(model) {
  const scene = { host: new THREE.Scene(), sceneCamera: new THREE.PerspectiveCamera(), localCamera: new THREE.PerspectiveCamera(), avatarRig: new THREE.Group() };
  scene.host.add(scene.avatarRig);
  scene.localLayer = { camera: scene.localCamera, avatarRig: scene.avatarRig };
  if (model) {
    scene.avatarRig.add(model);
    Object.assign(scene.localLayer, { _avatarModel: model, avatar: { locomotion: {} }, status: { avatar_grounded: true } });
  }
  return scene;
}

export function createHarness({
  isPlayer = true,
  sceneLoadTarget = null,
  mountClientSceneLoad = async () => ({ ok: true }),
  isTypingTarget = () => false,
  elements = {},
  model = null,
  onStep = null,
} = {}) {
  const trace = [];
  const stepped = [];
  const forced = [];
  const queue = frameQueue();
  let clock = 0;
  const { windowTarget, documentTarget, mount } = fakeDocument();
  let currentMount = mount;
  const { state, runtime } = fakeRuntime(trace, stepped, forced, onStep);
  const scene = fakeScene(model);
  const sceneRuntime = {
    avatarHost: () => ({ scene: scene.host, camera: scene.sceneCamera, renderer: {} }),
    mountClientSceneLoad,
    renderChildFabricPreview: () => trace.push("child"),
    renderPortalPreviews: () => trace.push("portal"),
  };
  const controller = createMovementCameraController({
    THREE, isPlayer, role: isPlayer ? "player" : "source", windowTarget, documentTarget,
    lookup: (id) => (id === "scene-mount" ? currentMount : elements[id] || null),
    requestFrame: queue.request, cancelFrame: queue.cancel, now: () => clock,
    getRuntime: () => runtime, sceneRuntime,
    getAvatarLayers: () => ({ local: scene.localLayer, peers: [] }),
    resolveClientSceneLoadTraversal: () => { trace.push("handoff"); return sceneLoadTarget; },
    persistPlayerSession: () => trace.push("persist"),
    refreshViewMatch: () => trace.push("verify"),
    renderOrientation: () => trace.push("orientation"),
    refreshDebugProjection: () => trace.push("debug"),
    updateMovementProjection: () => trace.push("movement-debug"),
    applyPortalOcclusion: () => { trace.push("camera"); return { active: false }; },
    logLine: () => {},
    showToast: () => trace.push("toast"),
    isTypingTarget,
  });
  return {
    controller, trace, frames: queue.frames, cancelled: queue.cancelled, windowTarget, documentTarget, mount, state,
    stepped, forced, sceneCamera: scene.sceneCamera, localCamera: scene.localCamera, avatarRig: scene.avatarRig, model,
    setMount(nextMount) { currentMount = nextMount; },
    rehostAvatar(nextScene = new THREE.Scene()) {
      scene.host = nextScene;
      nextScene.add(scene.avatarRig);
      return nextScene;
    },
    runNextFrame: queue.run,
  };
}
