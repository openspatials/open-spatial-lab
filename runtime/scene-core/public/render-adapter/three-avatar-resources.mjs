// The three reference for the plain avatar resource contract. No evaluator nodes
// or loaders are retained; every GPU resource below belongs to this binding.
const wraps = { repeat: 1000, clamp: 1001, mirror: 1002 };
const filters = { nearest: 1003, "nearest-mipmap-nearest": 1004, "nearest-mipmap-linear": 1005, linear: 1006, "linear-mipmap-nearest": 1007, "linear-mipmap-linear": 1008 };
const finite = (values, length) => values?.length === length && Array.from(values).every(Number.isFinite);
const requireValue = (ok, message) => { if (!ok) throw new TypeError(`Avatar resources: ${message}`); };

function validateResourceSet(resources, jointIds) {
  for (const table of ["geometries", "materials", "textures", "meshes"]) {
    requireValue(Array.isArray(resources?.[table]), `missing ${table}`);
    requireValue(resources[table].every(value => typeof value.id === "string") && new Set(resources[table].map(value => value.id)).size === resources[table].length, `duplicate/missing ${table} IDs`);
  }
  const geometries = new Map(resources.geometries.map(value => [value.id, value]));
  const materials = new Set(resources.materials.map(value => value.id)), textures = new Set(resources.textures.map(value => value.id));
  for (const texture of resources.textures) {
    requireValue(texture.format === "rgba8" && Number.isInteger(texture.width) && texture.width > 0 && Number.isInteger(texture.height) && texture.height > 0 && texture.pixels instanceof Uint8Array && texture.pixels.length === texture.width * texture.height * 4, `invalid RGBA8 texture ${texture.id}`);
    requireValue(["srgb", "srgb-linear", "data"].includes(texture.colorSpace) && finite(texture.uvMatrix, 9) && wraps[texture.wrapS] && wraps[texture.wrapT] && filters[texture.minFilter] && filters[texture.magFilter], `invalid texture interpretation ${texture.id}`);
    requireValue(Number.isInteger(texture.channel) && texture.channel >= 0 && texture.channel <= 3 && Number.isFinite(texture.anisotropy), `invalid texture channel/sampler ${texture.id}`);
    requireValue([texture.flipY, texture.premultiplyAlpha, texture.generateMipmaps].every(value => typeof value === "boolean"), `invalid texture flags ${texture.id}`);
  }
  for (const material of resources.materials) {
    requireValue(material.model === "metallic-roughness" && ["front", "back", "double"].includes(material.side), `unsupported material ${material.id}`);
    requireValue(finite(material.color, 3) && finite(material.emissive, 3) && finite(material.normalScale, 2) && [material.metalness, material.roughness, material.opacity, material.alphaTest, material.emissiveIntensity, material.aoIntensity].every(Number.isFinite), `invalid material values ${material.id}`);
    requireValue([material.transparent, material.depthTest, material.depthWrite, material.vertexColors, material.flatShading, material.toneMapped].every(value => typeof value === "boolean") && ["tangent", "object"].includes(material.normalSpace), `invalid material flags ${material.id}`);
    for (const [channel, id] of Object.entries(material.maps)) requireValue(["map", "normalMap", "metalnessMap", "roughnessMap", "emissiveMap", "aoMap", "alphaMap"].includes(channel) && textures.has(id), `invalid material texture ${material.id}.${channel}`);
  }
  for (const geometry of resources.geometries) {
    const count = geometry.attributes?.position?.data?.length / 3;
    requireValue(Number.isInteger(count) && count > 0 && geometry.attributes.position.components === 3, `invalid positions ${geometry.id}`);
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      requireValue(["position", "normal", "uv", "uv1", "uv2", "uv3", "color", "tangent", "skinIndex", "skinWeight"].includes(name), `unsupported attribute ${name}`);
      requireValue(ArrayBuffer.isView(attribute.data) && !(attribute.data instanceof DataView) && Number.isInteger(attribute.components) && attribute.components >= 1 && attribute.components <= 4 && attribute.data.length === count * attribute.components && Array.from(attribute.data).every(Number.isFinite), `invalid attribute ${geometry.id}.${name}`);
    }
    if (geometry.index) requireValue(geometry.index.components === 1 && Array.from(geometry.index.data).every(index => Number.isInteger(index) && index >= 0 && index < count), `invalid indices ${geometry.id}`);
    const drawCount = geometry.index?.data.length || count;
    requireValue(Array.isArray(geometry.groups) && geometry.groups.every(group => Number.isInteger(group.start) && group.start >= 0 && Number.isInteger(group.count) && group.count >= 0 && group.start + group.count <= drawCount && Number.isInteger(group.materialIndex)), `invalid groups ${geometry.id}`);
    requireValue(Number.isInteger(geometry.drawRange?.start) && geometry.drawRange.start >= 0 && (geometry.drawRange.count == null || Number.isInteger(geometry.drawRange.count) && geometry.drawRange.count >= 0), `invalid draw range ${geometry.id}`);
  }
  for (const mesh of resources.meshes) {
    requireValue(geometries.has(mesh.geometry) && mesh.materials?.length && mesh.materials.every(id => materials.has(id)), `missing mesh resource ${mesh.id}`);
    const attributes = geometries.get(mesh.geometry).attributes;
    requireValue(attributes.normal?.components === 3, `missing mesh normals ${mesh.id}`);
    for (const id of mesh.materials) {
      const material = resources.materials.find(value => value.id === id);
      requireValue(!material.vertexColors || attributes.color, `missing vertex colors ${mesh.id}`);
      for (const textureId of Object.values(material.maps)) {
        const texture = resources.textures.find(value => value.id === textureId);
        requireValue(attributes[texture.channel ? `uv${texture.channel}` : "uv"]?.components === 2, `missing texture UV channel ${mesh.id}`);
      }
    }
    requireValue(finite(mesh.localMatrix, 16) && (mesh.parentJointId == null || jointIds.includes(mesh.parentJointId)), `invalid mesh transform ${mesh.id}`);
    requireValue(typeof mesh.visible === "boolean" && typeof mesh.materialArray === "boolean", `invalid mesh visibility/material mode ${mesh.id}`);
    requireValue(mesh.materialArray || mesh.materials.length === 1, `scalar mesh requires one material ${mesh.id}`);
    if (mesh.materialArray) requireValue(geometries.get(mesh.geometry).groups.every(group => group.materialIndex >= 0 && group.materialIndex < mesh.materials.length), `missing group material ${mesh.id}`);
    if (mesh.skin) {
      const skin = mesh.skin, attributes = geometries.get(mesh.geometry).attributes;
      requireValue(["attached", "detached"].includes(skin.bindMode) && finite(skin.bindMatrix, 16) && finite(skin.bindMatrixInverse, 16), `invalid skin bind space ${mesh.id}`);
      requireValue(skin.jointIds?.length && skin.jointIds.every(id => jointIds.includes(id)) && skin.inverseBindMatrices?.length === skin.jointIds.length && skin.inverseBindMatrices.every(matrix => finite(matrix, 16)), `invalid skin joints/binds ${mesh.id}`);
      requireValue(attributes.skinIndex?.components === 4 && attributes.skinWeight?.components === 4, `missing weighted joints ${mesh.id}`);
      requireValue(!attributes.skinIndex.normalized && Array.from(attributes.skinIndex.data).every(index => Number.isInteger(index) && index >= 0 && index < skin.jointIds.length) && Array.from(attributes.skinWeight.data).every(weight => weight >= 0), `invalid joint indices/weights ${mesh.id}`);
      for (let i = 0; i < attributes.skinWeight.data.length; i += 4) requireValue(attributes.skinWeight.data.slice(i, i + 4).some(weight => weight > 0), `zero weighted vertex ${mesh.id}`);
    }
  }
}

export function bindExplicitThreeAvatar(THREE, descriptor) {
  requireValue(descriptor?.schema === "avatar-render/1" && descriptor.units === "metres" && descriptor.matrixOrder === "column-major" && descriptor.jointFrame === "nearest-mapped-parent-or-holder", "unsupported descriptor or coordinate convention");
  const { jointIds, parentJointIds, bindLocalMatrices, resources } = descriptor;
  requireValue(Array.isArray(jointIds) && jointIds.length > 0 && jointIds.every(id => typeof id === "string") && new Set(jointIds).size === jointIds.length, "unique joint IDs required");
  requireValue(parentJointIds?.length === jointIds.length && bindLocalMatrices?.length === jointIds.length && bindLocalMatrices.every(matrix => finite(matrix, 16)), "invalid joint bind matrices");
  for (let i = 0; i < jointIds.length; i++) {
    const seen = new Set([jointIds[i]]); let parent = parentJointIds[i];
    while (parent != null) { requireValue(jointIds.includes(parent) && !seen.has(parent), `invalid/cyclic joint parent ${parent}`); seen.add(parent); parent = parentJointIds[jointIds.indexOf(parent)]; }
  }
  validateResourceSet(resources, jointIds);
  for (const item of Object.values(resources.items || {})) validateResourceSet(item, []);
  const root = new THREE.Group(); root.name = "explicit-avatar"; root.matrixAutoUpdate = false;
  const bones = jointIds.map((id, index) => { const bone = new THREE.Bone(); bone.name = id; bone.matrixAutoUpdate = false; bone.matrix.fromArray(bindLocalMatrices[index]); return bone; });
  bones.forEach((bone, index) => (parentJointIds[index] == null ? root : bones[jointIds.indexOf(parentJointIds[index])]).add(bone));
  const owned = new Set(), meshes = [], items = new Map();
  const dispose = () => { if (binding.disposed) return false; binding.disposed = true; root.removeFromParent(); for (const resource of owned) resource.dispose(); owned.clear(); return true; };
  const binding = { supported: true, explicit: true, root, bones, jointIds: [...jointIds], parentJointIds: [...parentJointIds], meshes, items, disposed: false, dispose };
  const build = (set, mount, attachment = false) => {
    const textures = new Map(set.textures.map(spec => {
      const texture = new THREE.DataTexture(new Uint8Array(spec.pixels), spec.width, spec.height, THREE.RGBAFormat, THREE.UnsignedByteType); owned.add(texture);
      Object.assign(texture, { name: spec.name, channel: spec.channel, colorSpace: spec.colorSpace === "data" ? THREE.NoColorSpace : spec.colorSpace, wrapS: wraps[spec.wrapS], wrapT: wraps[spec.wrapT], minFilter: filters[spec.minFilter], magFilter: filters[spec.magFilter], flipY: spec.flipY, premultiplyAlpha: spec.premultiplyAlpha, generateMipmaps: spec.generateMipmaps, anisotropy: spec.anisotropy, matrixAutoUpdate: false });
      texture.matrix.fromArray(spec.uvMatrix); texture.needsUpdate = true; return [spec.id, texture];
    }));
    const materials = new Map(set.materials.map(spec => {
      const material = new THREE.MeshStandardMaterial(); owned.add(material);
      for (const field of ["name", "metalness", "roughness", "emissiveIntensity", "opacity", "transparent", "alphaTest", "depthTest", "depthWrite", "vertexColors", "flatShading", "toneMapped"]) material[field] = spec[field];
      material.side = ["front", "back", "double"].indexOf(spec.side); material.color.fromArray(spec.color); material.emissive.fromArray(spec.emissive);
      material.normalScale.fromArray(spec.normalScale); material.normalMapType = spec.normalSpace === "object" ? THREE.ObjectSpaceNormalMap : THREE.TangentSpaceNormalMap; material.aoMapIntensity = spec.aoIntensity;
      for (const [channel, id] of Object.entries(spec.maps)) material[channel] = textures.get(id);
      return [spec.id, material];
    }));
    const geometries = new Map(set.geometries.map(spec => {
      const geometry = new THREE.BufferGeometry(); owned.add(geometry);
      const attribute = value => new THREE.BufferAttribute(new value.data.constructor(value.data), value.components, value.normalized);
      for (const [name, value] of Object.entries(spec.attributes)) geometry.setAttribute(name, attribute(value));
      if (spec.index) geometry.setIndex(attribute(spec.index));
      for (const group of spec.groups) geometry.addGroup(group.start, group.count, group.materialIndex);
      geometry.setDrawRange(spec.drawRange.start, spec.drawRange.count ?? Infinity); return [spec.id, geometry];
    }));
    for (const spec of set.meshes) {
      const material = spec.materials.map(id => materials.get(id));
      const mesh = new (spec.skin ? THREE.SkinnedMesh : THREE.Mesh)(geometries.get(spec.geometry), spec.materialArray ? material : material[0]);
      mesh.name = spec.name; mesh.matrixAutoUpdate = false; mesh.matrix.fromArray(spec.localMatrix);
      for (const field of ["visible", "castShadow", "receiveShadow", "frustumCulled", "renderOrder"]) mesh[field] = spec[field];
      (spec.parentJointId == null ? mount : bones[jointIds.indexOf(spec.parentJointId)]).add(mesh);
      if (spec.skin) {
        const skin = spec.skin;
        const skeleton = new THREE.Skeleton(skin.jointIds.map(id => bones[jointIds.indexOf(id)]), skin.inverseBindMatrices.map(matrix => new THREE.Matrix4().fromArray(matrix))); owned.add(skeleton);
        mesh.bindMode = skin.bindMode; mesh.bind(skeleton, new THREE.Matrix4().fromArray(skin.bindMatrix)); mesh.bindMatrixInverse.fromArray(skin.bindMatrixInverse);
      }
      if (!attachment) meshes.push(mesh);
    }
  };
  try {
    build(resources, root);
    for (const [id, resource] of Object.entries(resources.items || {})) {
      const item = new THREE.Group(); item.name = `item:${id}`; item.matrixAutoUpdate = false; item.visible = false;
      root.add(item); items.set(id, item); build(resource, item, true);
    }
    root.updateMatrixWorld(true);
    return binding;
  } catch (error) { dispose(); throw error; }
}

export function applyExplicitThreePose(binding, pose) {
  if (binding.disposed) throw new Error("Avatar binding is disposed");
  requireValue(pose?.rootFrame === "world" && pose.frame === "avatar-holder" && pose.jointFrame === "nearest-mapped-parent-or-holder" && pose.units === "metres" && pose.matrixOrder === "column-major", "invalid completed pose convention");
  requireValue(finite(pose.rootMatrix, 16) && pose.jointLocalMatrices?.length === binding.bones.length && pose.jointLocalMatrices.every(matrix => finite(matrix, 16)), "completed pose requires finite root/joint matrices");
  requireValue(pose.jointIds?.every((id, i) => id === binding.jointIds[i]) && pose.jointIds.length === binding.jointIds.length && pose.parentJointIds?.every((id, i) => id === binding.parentJointIds[i]) && pose.parentJointIds.length === binding.parentJointIds.length, "completed pose joint layout differs from binding");
  requireValue(Array.isArray(pose.attachments) && new Set(pose.attachments.map(item => item.itemId)).size === pose.attachments.length, "invalid attachment list");
  for (const item of pose.attachments) requireValue(binding.items.has(item.itemId) && item.frame === "avatar-holder" && item.units === "metres" && item.matrixOrder === "column-major" && finite(item.itemMatrix, 16) && finite(item.parentMatrix, 16), `missing/invalid attachment ${item.itemId}`);
  binding.root.matrix.fromArray(pose.rootMatrix);
  if (binding.root.parent) { binding.root.parent.updateWorldMatrix(true, false); binding.root.matrix.premultiply(binding.root.parent.matrixWorld.clone().invert()); }
  binding.bones.forEach((bone, i) => bone.matrix.fromArray(pose.jointLocalMatrices[i]));
  for (const item of binding.items.values()) item.visible = false;
  for (const spec of pose.attachments) { const item = binding.items.get(spec.itemId); item.matrix.fromArray(spec.itemMatrix); item.visible = true; }
  binding.root.updateMatrixWorld(true);
  for (const mesh of binding.meshes) mesh.skeleton?.update();
  return true;
}
