import assert from "node:assert/strict";
import { ThreeRenderAdapter } from "../runtime/scene-core/public/render-adapter/three-render-adapter.mjs";
import { readEvaluatedAvatarPose } from "../web/evaluated-avatar-pose.mjs";

// Use the browser's bundled engine for matrix/light semantics. The renderer
// below records contract effects; rendered output has a separate browser check.
const THREE = await import(new URL("../runtime/scene-core/public/vendor/three/three.module.js", import.meta.url).href);
class Renderer {
  constructor() { this.domElement = { style: {} }; this.shadowMap = {}; this.draws = 0; this.target = null; this.color = new THREE.Color(0); }
  getContext() { return {}; }
  setPixelRatio() {}
  setSize() {}
  render(scene, camera) { this.draws++; this.calls.push({scene, camera, target:this.target}); this.onRender?.(scene); }
  dispose() { this.disposed = true; }
  getRenderTarget() { return this.target; }
  setRenderTarget(target) { this.target = target; }
  getClearColor(color) { return color.copy(this.color); }
  getClearAlpha() { return 1; }
  setClearColor(color) { this.color.copy(color); }
}
const mount = { clientWidth: 320, clientHeight: 200, children: [], appendChild(node) { this.children.push(node); node.parentNode = this; }, removeChild(node) { this.children.splice(this.children.indexOf(node), 1); node.parentNode = null; } };
const adapter = new ThreeRenderAdapter({ ...THREE, WebGLRenderer: Renderer });
adapter.mount(mount, { frameLoop: false });
await adapter.ready();
const renderer = adapter.renderer;
renderer.calls = [];
adapter.setLighting({ key: { color: "#ffffff", intensity: 2, direction: [0, -1, 0] }, fill: { color: "#aabbcc", intensity: .3 }, exposure: .8, shadows: { enabled: true, mapSize: 512, bias: -.001 } });
const key = adapter.sceneRoot.children.find(light => light.isDirectionalLight);
assert.equal(key.intensity, 2);
assert.ok(key.position.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-12);
assert.equal(key.shadow.mapSize.x, 512);
assert.equal(key.shadow.bias, -.001);
assert.equal(renderer.shadowMap.enabled, true);
assert.equal(renderer.toneMappingExposure, .8);
const environment = adapter.setLighting({ environment: { asset: "/assets/environment.hdr", intensity: .5 } });
assert.deepEqual(environment.unsupported.map(entry => entry.setting), ["environment.asset", "environment.intensity"]);
assert.equal(environment.status, "limited");
assert.throws(() => adapter.setLighting({ environment: new THREE.Texture() }), /neutral asset/);

const holder = new THREE.Group();
const joint = new THREE.Bone(); joint.name = "joint"; holder.add(joint);
joint.position.set(.2, 1, .1); holder.updateMatrixWorld(true);
const original = joint.matrix.toArray();
const pose = readEvaluatedAvatarPose({ instance: { holder, bones: { joint } } });
assert.deepEqual(joint.matrix.toArray(), original, "sampling does not alter the evaluator");
const clone = holder.clone(true);
const binding = adapter.bindSkin(clone, pose);
clone.children[0].position.set(8, 9, 10);
adapter.setSkinPose(binding, pose.jointLocalMatrices);
assert.deepEqual(clone.children[0].matrix.toArray(), original, "draw graph consumes the completed pose");
pose.jointLocalMatrices[0][12] = 99;
assert.deepEqual(joint.matrix.toArray(), original, "snapshot arrays do not alias evaluator matrices");
assert.throws(() => adapter.setSkinPose(binding, [[NaN]]), /finite/);
assert.equal(adapter.bindSkin(clone, { jointIds: ["absent"] }).supported, false);

const world = new THREE.Group(), rig = new THREE.Group(), evaluated = new THREE.Group();
const armature = new THREE.Group(), hip = new THREE.Bone(), spacer = new THREE.Group(), hand = new THREE.Bone(), item = new THREE.Group();
hip.name = "hip"; hand.name = "hand";
world.position.set(10, 2, -3); world.rotation.y = .4; world.scale.set(1.1, .8, 1.3);
rig.position.set(2, 0, 1); rig.rotation.x = .2; evaluated.scale.set(.7, .9, 1.2);
armature.position.set(3, 1, 0); armature.rotation.z = .3;
hip.position.set(0, 1, 0); hip.rotation.y = -.2;
spacer.position.set(.2, .4, 0); spacer.rotation.z = -.5; spacer.scale.set(.8, 1.2, .9);
hand.position.set(.3, .2, .1); hand.rotation.x = .6; item.position.set(.1, .2, .3);
world.add(rig); rig.add(evaluated); evaluated.add(armature); armature.add(hip); hip.add(spacer); spacer.add(hand); hand.add(item);
world.updateMatrixWorld(true);
const holderInverse = evaluated.matrixWorld.clone().invert();
const attachment = {frame:"avatar-holder", units:"metres", matrixOrder:"column-major", itemMatrix:holderInverse.clone().multiply(item.matrixWorld).toArray(), parentMatrix:holderInverse.clone().multiply(hand.matrixWorld).toArray()};
const mapped = readEvaluatedAvatarPose({instance:{holder:evaluated,bones:{hand,hip}},equipment:{attachmentPoses:()=>[attachment]}});
assert.deepEqual(mapped.parentJointIds,["hip",null]);
const reconstruct = id => {
  const index = mapped.jointIds.indexOf(id);
  const parent = mapped.parentJointIds[index];
  return (parent ? reconstruct(parent) : new THREE.Matrix4().fromArray(mapped.rootMatrix)).multiply(new THREE.Matrix4().fromArray(mapped.jointLocalMatrices[index]));
};
const near = (a,b) => a.elements.every((value,index)=>Math.abs(value-b.elements[index])<1e-9);
assert(near(reconstruct("hip"),hip.matrixWorld),"non-bone armature transform is preserved");
assert(near(reconstruct("hand"),hand.matrixWorld),"intermediate non-bone transform is preserved");
assert(near(new THREE.Matrix4().fromArray(mapped.rootMatrix).multiply(new THREE.Matrix4().fromArray(mapped.attachments[0].itemMatrix)),item.matrixWorld),"holder-relative item reconstructs its world matrix");
const drawWorld = world.clone(true), drawRoot = drawWorld.children[0].children[0];
const mappedBinding = adapter.bindSkin(drawRoot,mapped);
drawRoot.getObjectByName("hip").position.x += 4;
drawRoot.getObjectByName("hand").rotation.z += .7;
adapter.setSkinPose(mappedBinding,mapped.jointLocalMatrices);
assert(near(drawRoot.getObjectByName("hip").matrixWorld,hip.matrixWorld));
assert(near(drawRoot.getObjectByName("hand").matrixWorld,hand.matrixWorld));
const sharedBinding = adapter.bindSkin(evaluated,mapped);
adapter.setSkinPose(sharedBinding,mapped.jointLocalMatrices);
assert(hip.matrixAutoUpdate && hand.matrixAutoUpdate,"sampling/applying the already-evaluated graph does not take its animation ownership");
spacer.rotation.y += .4; armature.position.x += 2;
world.updateMatrixWorld(true);
const changedParentPose = readEvaluatedAvatarPose({instance:{holder:evaluated,bones:{hand,hip}}});
const completedHand = hand.matrixWorld.clone();
adapter.setSkinPose(sharedBinding,changedParentPose.jointLocalMatrices);
assert(near(hand.matrixWorld,completedHand) && hand.matrixAutoUpdate && hip.matrixAutoUpdate,"animated non-bone parents retain evaluator ownership");

const destination = new THREE.Scene(), destinationCamera = new THREE.PerspectiveCamera();
const texture = adapter.createRenderedTexture({width:16,height:16});
adapter.bindRenderedTextureScene(texture,destination,destinationCamera);
const outerTarget = {name:"outer"}; renderer.setRenderTarget(outerTarget);
adapter.setRenderedTextureUpdate(texture,"NONE"); adapter.requestRender(1);
assert.equal(renderer.calls.filter(call=>call.scene===destination).length,0,"NONE is a negative rendering control");
adapter.setRenderedTextureUpdate(texture,"NEXT_FRAME_ONLY"); adapter.requestRender(2); adapter.requestRender(3);
assert.equal(renderer.calls.filter(call=>call.scene===destination).length,1,"one-shot draws once");
assert.equal(renderer.calls.find(call=>call.scene===destination).target,texture.target);
assert.equal(renderer.target,outerTarget,"preview restores the caller's render target");
adapter.setRenderedTextureUpdate(texture,"ALWAYS"); adapter.requestRender(4); adapter.requestRender(5);
assert.equal(renderer.calls.filter(call=>call.scene===destination).length,3,"ALWAYS redraws each requested frame");
assert.throws(()=>adapter.setRenderedTextureUpdate(texture,"sometimes"),/Unknown/);
adapter.disposeRenderedTexture(texture); adapter.requestRender(6);
assert.equal(adapter.setRenderedTextureUpdate(texture,"ALWAYS"),false);
assert.equal(renderer.calls.filter(call=>call.scene===destination).length,3,"retired textures never redraw");
renderer.draws = 0;
const adoptedScene = new THREE.Scene(), adoptedCamera = new THREE.PerspectiveCamera();
adapter.useScene(adoptedScene, adoptedCamera);
adapter.requestRender(8);
assert.equal(renderer.calls.at(-1).scene, adoptedScene, "ready graph adoption changes the actual draw root");
assert.equal(renderer.calls.at(-1).camera, adoptedCamera, "ready graph adoption changes the actual draw camera");
renderer.draws = 0;

let finishLoad;
const load = adapter.createInlineAsset("fixture.glb", { loadGltf: () => new Promise(resolve => { finishLoad = resolve; }) });
await Promise.resolve();
const preview = adapter.createRenderedTexture({width:32,height:32});
let previewDisposals = 0;
preview.target.addEventListener("dispose", () => previewDisposals++);
adapter.onEnterFrame(() => adapter.dispose());
assert.equal(adapter.requestRender(16), false);
assert.equal(renderer.draws, 0, "disposal in a frame callback revokes drawing");
finishLoad(holder);
await assert.rejects(load.ready, error => error.name === "AbortError");
assert.equal(load.node.children.length, 0, "retired loads cannot attach");
assert.equal(previewDisposals, 1);
assert.equal(mount.children.length, 0);
adapter.dispose();
assert.equal(previewDisposals, 1, "dispose is idempotent");
for (let i = 0; i < 3; i++) { adapter.mount(mount,{frameLoop:false}); await adapter.ready(); adapter.dispose(); assert.equal(mount.children.length,0); }
adapter.mount(mount,{frameLoop:false});
adapter.renderer.calls = [];
const retiring = adapter.createRenderedTexture();
adapter.bindRenderedTextureScene(retiring,destination,destinationCamera);
const retiringRenderer = adapter.renderer;
retiringRenderer.onRender = () => adapter.dispose();
assert.equal(adapter.requestRender(7),false);
assert.equal(retiringRenderer.draws,1,"disposal during preview prevents the main draw");
console.log(`render adapter contract: bundled r${THREE.REVISION}, lighting/pose/stale-load/frame-disposal/remount checks passed`);
