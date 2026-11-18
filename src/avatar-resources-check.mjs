// Real distributed-input numerical qualification; browser pixels remain a
// separate common-application qualification. No listener or browser is started.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadAvatarLibrary, createAvatarInstance, nodeReadBytes, nodeReadJson } from "../web/avatar/runtime/clip-library.mjs";
import { AvatarMotion } from "../web/avatar/runtime/avatar-motion.mjs";
import { createTuning } from "../web/avatar/runtime/locomotion.mjs";
import { Equipment, loadItemLibrary } from "../web/avatar/runtime/equipment.mjs";
import { SolverStack } from "../web/avatar/runtime/fitting/solvers.mjs";
import { readAvatarBindDescription, readEvaluatedAvatarPose } from "../web/evaluated-avatar-pose.mjs";
import { ThreeRenderAdapter } from "../runtime/scene-core/public/render-adapter/three-render-adapter.mjs";

assert.equal(THREE.REVISION, "186", "use --loader ./tools/renderer/node-fixture-loader.mjs to qualify the actual browser engine");
const decoder = spawnSync(process.env.PYTHON || "python3", ["-c", "from PIL import features; assert features.check('webp'), 'Pillow has no WebP support'"], { encoding: "utf8" });
assert.equal(decoder.status, 0, `Avatar resource check requires Python with Pillow and WebP decoding; set PYTHON to that interpreter. ${decoder.error?.message || decoder.stderr || "decoder prerequisite failed"}`);
globalThis.self = globalThis;
// Pillow decodes the actual embedded WebP bytes for this Node fixture. The
// runtime browser continues to use its native decoder, not this fixture hook.
globalThis.createImageBitmap = async blob => {
  const bytes = Buffer.from(await blob.arrayBuffer());
  const decode = spawnSync(process.env.PYTHON || "python3", ["-c", "from PIL import Image; import sys,io,struct; im=Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGBA'); sys.stdout.buffer.write(struct.pack('<II',*im.size)+im.tobytes())"], { input: bytes, maxBuffer: 32 * 1024 * 1024 });
  if (decode.status !== 0) throw new Error(`WebP fixture decoder: ${decode.stderr}`);
  return { width: decode.stdout.readUInt32LE(0), height: decode.stdout.readUInt32LE(4), data: new Uint8Array(decode.stdout.subarray(8)), close() {} };
};
const parse = GLTFLoader.prototype.parse;
GLTFLoader.prototype.parse = function (...args) {
  this.register(parser => ({ name: "EXT_texture_webp", loadTexture(index) {
    const source = parser.json.textures[index].extensions?.EXT_texture_webp?.source;
    return source == null ? null : parser.loadTextureImage(index, source, parser.textureLoader);
  } }));
  return parse.apply(this, args);
};
const web = new URL("../web/", import.meta.url);
const files = new Map();
const readTracked = path => { const bytes = readFileSync(path); files.set(path, createHash("sha256").update(bytes).digest("hex")); return bytes; };
const readBytes = nodeReadBytes(readTracked), readJson = nodeReadJson(path => readTracked(path).toString());
const source = readFileSync(new URL("avatar-equipment-layer.js", web), "utf8");
const avatars = [...source.matchAll(/prepared: "([^"]+)"/g)].map(match => fileURLToPath(new URL(match[1].slice(1), web)));
// Every avatar the lab's catalog copy lists (web/assets/avatar-catalog.json, written with the table by the catalog's apply.mjs).
assert.equal(avatars.length, JSON.parse(readFileSync(new URL("assets/avatar-catalog.json", web), "utf8")).avatars.length);
const itemUrl = fileURLToPath(new URL("vendor/avatar-evaluator-v1/mannequin/assets/items/items.json", web));
const items = await loadItemLibrary({ readBytes, readJson, url: itemUrl });
assert.equal(items.production.length, 7);
const report = { engine: THREE.REVISION, scope: "real-input CPU/resource equivalence, not raster output", avatars: [], items: items.production, negativeControls: [], files: [] };
function syntheticDescriptor(root) {
  return readAvatarBindDescription({ holder: root, bones: { joint: root.children.find(node => node.isBone) }, skinnedMeshes: [] });
}
function syntheticRoot(material = new THREE.MeshStandardMaterial()) {
  const root = new THREE.Group(), joint = new THREE.Bone(), group = new THREE.Group(); joint.name = "joint";
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material); root.add(joint, group); group.add(mesh);
  return { root, group, mesh, dispose() { mesh.geometry.dispose(); for (const value of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) value.dispose(); } };
}
const visibilityCases = [];
for (const hidden of [null, "mesh", "group", "root"]) {
  const fixture = syntheticRoot(); if (hidden) fixture[hidden].visible = false;
  const descriptor = syntheticDescriptor(fixture.root), adapter = new ThreeRenderAdapter(THREE), binding = adapter.bindSkin(descriptor);
  assert.equal(binding.meshes[0].visible, hidden === null, `effective ${hidden || "visible"} visibility`);
  assert.equal(binding.meshes[0].geometry.groups.length, 6, "scalar material keeps valid box groups");
  const malformed = structuredClone(descriptor); delete malformed.resources.meshes[0].visible;
  assert.throws(() => adapter.bindSkin(malformed), /visibility/);
  visibilityCases.push(hidden || "visible"); adapter.dispose(); fixture.dispose();
}
const physicalCases = { anisotropy: .5, anisotropyRotation: .5, clearcoat: .5, clearcoatRoughness: .2, ior: 1.7,
  iridescence: 1, iridescenceIOR: 1.5, sheen: 1, sheenRoughness: .4, transmission: .5, thickness: .3,
  attenuationDistance: 4, specularIntensity: .5, dispersion: .2, sheenColor: new THREE.Color(.1, 0, 0),
  attenuationColor: new THREE.Color(.8, 1, 1), specularColor: new THREE.Color(.8, 1, 1),
  clearcoatNormalScale: new THREE.Vector2(.8, 1), iridescenceThicknessRange: [100, 500] };
{
  const fixture = syntheticRoot(new THREE.MeshPhysicalMaterial());
  const adapter = new ThreeRenderAdapter(THREE); adapter.bindSkin(syntheticDescriptor(fixture.root)); adapter.dispose(); fixture.dispose();
}
for (const [field, value] of Object.entries(physicalCases)) {
  const material = new THREE.MeshPhysicalMaterial(); material[field] = value;
  const fixture = syntheticRoot(material);
  assert.throws(() => syntheticDescriptor(fixture.root), new RegExp(`physical extension: ${field}`)); fixture.dispose();
}
{
  const fixture = syntheticRoot(Array.from({ length: 6 }, () => new THREE.MeshStandardMaterial()));
  const descriptor = syntheticDescriptor(fixture.root), adapter = new ThreeRenderAdapter(THREE); adapter.bindSkin(descriptor);
  const invalid = structuredClone(descriptor); invalid.resources.meshes[0].materials.pop();
  assert.throws(() => adapter.bindSkin(invalid), /missing group material/);
  adapter.dispose(); fixture.dispose();
}
report.syntheticControls = { visibility: visibilityCases, scalarBox: "accepted", completeArray: "accepted", invalidArrayIndex: "rejected", physicalDefaults: "accepted", physicalNondefaults: Object.keys(physicalCases) };
const maxError = (a, b) => Math.max(...a.map((value, index) => Math.abs(value - b[index])));
const near = (a, b, label, tolerance = 1e-8) => assert(maxError(a, b) < tolerance, `${label}: ${maxError(a, b)}`);
const materialFields = ["opacity", "transparent", "alphaTest", "side", "roughness", "metalness", "vertexColors", "depthTest", "depthWrite", "toneMapped", "normalMapType"];
function compareMaterial(a, b) {
  assert.notEqual(a, b);
  for (const field of materialFields) assert.equal(a[field], b[field], field);
  for (const field of ["color", "emissive", "normalScale"]) near(a[field].toArray(), b[field].toArray(), field);
  for (const channel of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap", "alphaMap"]) {
    if (!a[channel]) { assert(!b[channel]); continue; }
    const x = a[channel], y = b[channel]; assert.notEqual(x, y); assert.notEqual(x.source, y.source); assert.notEqual(x.image, y.image); assert.notEqual(x.image.data.buffer, y.image.data.buffer);
    assert.deepEqual(x.image.data, y.image.data);
    for (const field of ["colorSpace", "channel", "wrapS", "wrapT", "minFilter", "magFilter", "flipY", "premultiplyAlpha", "generateMipmaps"]) assert.equal(x[field], y[field], channel + field);
    // The renderer draws a texture whose matrixAutoUpdate is on with the matrix of its offset, repeat and rotation
    // (KHR_texture_transform sets those), updated at draw time; with no draw here, update it as the draw does.
    if (x.matrixAutoUpdate) x.updateMatrix();
    near(x.matrix.toArray(), y.matrix.toArray(), "texture transform");
  }
}
function shaderNormal(mesh, index) {
  const geometry = mesh.geometry, normal = new THREE.Vector3().fromBufferAttribute(geometry.attributes.normal, index);
  if (mesh.isSkinnedMesh) {
    const indices = new THREE.Vector4().fromBufferAttribute(geometry.attributes.skinIndex, index), weights = new THREE.Vector4().fromBufferAttribute(geometry.attributes.skinWeight, index);
    const skin = new THREE.Matrix4(); skin.elements.fill(0);
    for (let j = 0; j < 4; j++) {
      const k = indices.getComponent(j), matrix = new THREE.Matrix4().multiplyMatrices(mesh.skeleton.bones[k].matrixWorld, mesh.skeleton.boneInverses[k]);
      for (let n = 0; n < 16; n++) skin.elements[n] += matrix.elements[n] * weights.getComponent(j);
    }
    skin.premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
    normal.applyMatrix3(new THREE.Matrix3().setFromMatrix4(skin));
  }
  return normal.applyMatrix3(new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld)).normalize();
}
let representative;
const channelControls = { normalMap: 0, colorSpace: 0 };
for (const url of avatars) {
  const library = await loadAvatarLibrary({ readBytes, readJson, url });
  const instance = createAvatarInstance(library), tuning = createTuning(library.data);
  const parent = new THREE.Group(); parent.position.set(3, 2, -5); parent.rotation.set(.2, .4, -.1); parent.scale.set(1.1, .8, 1.3);
  parent.add(instance.holder); instance.holder.position.set(.2, .6, -.3); instance.holder.rotation.y = -.3;
  parent.updateMatrixWorld(true);
  const motion = new AvatarMotion(instance, library, tuning), solvers = new SolverStack(instance, library.body), equipment = new Equipment(instance, library, items, motion, solvers);
  const descriptor = readAvatarBindDescription(instance, items);
  assert.equal(readAvatarBindDescription(instance, items).resources.geometries, descriptor.resources.geometries, "immutable resources captured once");
  const transfer = structuredClone(descriptor), adapter = new ThreeRenderAdapter(THREE), binding = adapter.bindSkin(transfer);
  assert.equal(binding.meshes.length, instance.skinnedMeshes.length);
  const drawParent = new THREE.Group(); drawParent.position.set(-7, .3, 4); drawParent.scale.set(.8, 1.4, .7); drawParent.add(binding.root);
  let vertexError = 0, normalError = 0, displacement = 0, itemError = 0; const initial = new Map();
  for (let phase = 0; phase < items.production.length + 1; phase++) {
    equipment.drop(); if (phase > 0) assert(equipment.take(items.production[phase - 1]), `${library.id}: item ${items.production[phase - 1]} refused`);
    solvers.restore(); motion.update(.17, { speed: phase ? tuning.walkSpeed : 0, phase: "none", phaseTime: 0, turnRate: 0, vy: 0, crouchTime: tuning.crouchStanding, jumpStyle: "standing" });
    solvers.run({ dt: .17, floorY: instance.holder.position.y }); parent.updateMatrixWorld(true);
    const pose = readEvaluatedAvatarPose({ instance, equipment, catalogKey: library.id }); adapter.setSkinPose(binding, pose);
    binding.meshes.forEach((mesh, meshIndex) => {
      const original = instance.skinnedMeshes[meshIndex]; original.skeleton.update();
      assert.notEqual(original, mesh); assert.notEqual(original.geometry, mesh.geometry);
      compareMaterial(original.material, mesh.material);
      assert.deepEqual(original.geometry.index.array, mesh.geometry.index.array);
      for (const [name, attribute] of Object.entries(original.geometry.attributes)) { assert.notEqual(attribute.array.buffer, mesh.geometry.attributes[name].array.buffer); assert.deepEqual(Array.from(attribute.array), Array.from(mesh.geometry.attributes[name].array)); }
      near(original.bindMatrix.toArray(), mesh.bindMatrix.toArray(), "per-mesh bind");
      for (let i = 0; i < original.geometry.attributes.position.count; i += 97) {
        const a = original.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(original.geometry.attributes.position, i)).applyMatrix4(original.matrixWorld);
        const b = mesh.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, i)).applyMatrix4(mesh.matrixWorld);
        vertexError = Math.max(vertexError, a.distanceTo(b));
        normalError = Math.max(normalError, shaderNormal(original, i).distanceTo(shaderNormal(mesh, i)));
        const key = `${meshIndex}/${i}`; if (phase === 0) initial.set(key, a); else displacement = Math.max(displacement, initial.get(key).distanceTo(b));
      }
    });
    for (const slot of [equipment.held, equipment.worn].filter(Boolean)) {
      const item = binding.items.get(slot.item.id); itemError = Math.max(itemError, maxError(slot.node.matrixWorld.elements, item.matrixWorld.elements));
      const original = [], copied = []; slot.node.traverse(node => { if (node.isMesh) original.push(node); }); item.traverse(node => { if (node.isMesh) copied.push(node); });
      assert.equal(copied.length, original.length); original.forEach((mesh, i) => {
        compareMaterial(mesh.material, copied[i].material); near(mesh.matrixWorld.elements, copied[i].matrixWorld.elements, "item child transform");
        assert.notEqual(mesh.geometry, copied[i].geometry);
        for (const [name, attribute] of Object.entries(mesh.geometry.attributes)) {
          const clone = copied[i].geometry.attributes[name]; assert.notEqual(attribute.array.buffer, clone.array.buffer);
          assert.deepEqual(Array.from(attribute.array), Array.from(clone.array)); assert.equal(attribute.normalized, clone.normalized);
        }
      });
    }
  }
  assert(vertexError < 1e-7 && normalError < 1e-7 && itemError < 1e-7); assert(displacement > .02, "visible non-rigid motion control");
  const pose = readEvaluatedAvatarPose({ instance, equipment });
  // Sensitivity controls change valid data, not merely input validation. A
  // rest-pose-only renderer, lost bind space or lost fit must fail equivalence.
  const reference = instance.skinnedMeshes[0], rendered = binding.meshes[0];
  const vertexDistance = () => {
    let difference = 0;
    for (let i = 0; i < reference.geometry.attributes.position.count; i += 97) {
      const a = reference.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(reference.geometry.attributes.position, i)).applyMatrix4(reference.matrixWorld);
      const b = rendered.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(rendered.geometry.attributes.position, i)).applyMatrix4(rendered.matrixWorld);
      difference = Math.max(difference, a.distanceTo(b));
    }
    return difference;
  };
  const restOnly = structuredClone(pose); restOnly.jointLocalMatrices = descriptor.bindLocalMatrices;
  adapter.setSkinPose(binding, restOnly); assert(vertexDistance() > .02, "rest-only fault must break measured deformation"); adapter.setSkinPose(binding, pose);
  const bind = rendered.bindMatrix.clone(); rendered.bindMatrix.elements[12] += .2;
  assert(vertexDistance() > .01, "bad bind space must break positions"); rendered.bindMatrix.copy(bind);
  const withBadFit = structuredClone(pose); withBadFit.attachments[0].itemMatrix[12] += .2;
  adapter.setSkinPose(binding, withBadFit);
  const fitted = equipment.held || equipment.worn;
  assert(maxError(fitted.node.matrixWorld.elements, binding.items.get(fitted.item.id).matrixWorld.elements) > .01, "bad fit must break attachment agreement"); adapter.setSkinPose(binding, pose);
  // The two channel controls need the channel: a character whose first material has no normal map (or no color map)
  // cannot lose it; each control must still run on at least one character (checked after the loop).
  const normalMap = rendered.material.normalMap;
  if (normalMap) {
    rendered.material.normalMap = null;
    assert.throws(() => compareMaterial(reference.material, rendered.material), "missing normal channel must fail material agreement"); rendered.material.normalMap = normalMap;
    channelControls.normalMap += 1;
  }
  if (rendered.material.map) {
    const colorSpace = rendered.material.map.colorSpace; rendered.material.map.colorSpace = "";
    assert.throws(() => compareMaterial(reference.material, rendered.material), "wrong color interpretation must fail"); rendered.material.map.colorSpace = colorSpace;
    channelControls.colorSpace += 1;
  }
  const invalid = structuredClone(pose); invalid.jointLocalMatrices[0][0] = NaN;
  const before = binding.root.matrix.toArray(); assert.throws(() => adapter.setSkinPose(binding, invalid), /finite/); assert.deepEqual(binding.root.matrix.toArray(), before);
  const alien = new ThreeRenderAdapter(THREE); assert.throws(() => alien.setSkinPose(binding, pose), /belongs/);
  let disposals = 0; binding.meshes[0].geometry.addEventListener("dispose", () => disposals++);
  const ownedCounts = new Map();
  binding.root.traverse(node => {
    const materials = node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : [];
    for (const resource of [node.geometry, ...materials, ...materials.flatMap(material => Object.values(material).filter(value => value?.isTexture))].filter(Boolean)) {
      if (!ownedCounts.has(resource)) { ownedCounts.set(resource, 0); resource.addEventListener("dispose", () => ownedCounts.set(resource, ownedCounts.get(resource) + 1)); }
    }
  });
  assert(adapter.disposeSkin(binding)); assert(!adapter.disposeSkin(binding)); adapter.dispose(); assert.equal(disposals, 1);
  assert([...ownedCounts.values()].every(count => count === 1), "every owned geometry/material/texture releases exactly once");
  assert.throws(() => adapter.setSkinPose(binding, pose), /disposed/);
  assert.throws(() => adapter.bindSkin(transfer), /disposed/);
  report.avatars.push({ id: library.id, meshes: binding.meshes.length, joints: descriptor.jointIds.length, textures: descriptor.resources.textures.length, vertexError, normalError, itemError, displacement });
  representative ||= descriptor;
}
assert(channelControls.normalMap > 0 && channelControls.colorSpace > 0, `the channel controls ran on no character: ${JSON.stringify(channelControls)}`);
report.sensitivityControls = ["rest-only joints", "lost bind space", "incorrect fitted attachment", "missing normal map", "wrong texture color space"];
report.channelControlRuns = channelControls;
// Execute the departing-instance cleanup method against borrowed resource
// controls. These are library objects: the instance owns only its skeleton.
const cleanupBody = source.slice(source.indexOf("  _disposeModel(root) {") + "  _disposeModel(root) {".length, source.indexOf("\n  }", source.indexOf("  _disposeModel(root) {")));
const cleanup = new Function("root", cleanupBody);
const cachedRoot = new THREE.Group(); cachedRoot.userData.loaderOwnedResources = true;
let borrowedDisposals = 0, skeletonDisposals = 0;
const cachedMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial());
cachedMesh.geometry.addEventListener("dispose", () => borrowedDisposals++); cachedMesh.material.addEventListener("dispose", () => borrowedDisposals++);
cachedMesh.skeleton = { dispose() { skeletonDisposals++; } }; cachedRoot.add(cachedMesh); cleanup(cachedRoot);
assert.equal(borrowedDisposals, 0, "departing instances cannot dispose cached geometry/materials"); assert.equal(skeletonDisposals, 1);
for (const [name, mutate, error] of [
  ["missing geometry", d => { d.resources.geometries = []; }, /missing mesh/],
  ["bad weighted joint", d => { d.resources.geometries[0].attributes.skinIndex.data[0] = 65535; }, /indices\/weights/],
  ["invalid bind", d => { d.resources.meshes[0].skin.bindMatrix[0] = NaN; }, /bind space/],
  ["cyclic parent", d => { d.parentJointIds[0] = d.jointIds[0]; }, /cyclic/],
  ["missing normal texture", d => { d.resources.textures = []; }, /material texture/],
  ["missing normal attribute", d => { delete d.resources.geometries[0].attributes.normal; }, /mesh normals/],
  ["missing texture coordinates", d => { delete d.resources.geometries[0].attributes.uv; }, /UV channel/],
  ["bad alpha material", d => { d.resources.materials[0].opacity = NaN; }, /material values/],
]) {
  const descriptor = structuredClone(representative); mutate(descriptor); assert.throws(() => new ThreeRenderAdapter(THREE).bindSkin(descriptor), error); report.negativeControls.push(name);
}
report.files = [...files].map(([path, sha256]) => ({ path, sha256 }));
console.log(JSON.stringify(report, null, 2));
