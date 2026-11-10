// Plain, transferable rendering inputs. The evaluator remains the sole pose writer.
const snapshots = new WeakMap();
const itemSnapshots = new WeakMap();
const wraps = { 1000: "repeat", 1001: "clamp", 1002: "mirror" };
const filters = { 1003: "nearest", 1004: "nearest-mipmap-nearest", 1005: "nearest-mipmap-linear", 1006: "linear", 1007: "linear-mipmap-nearest", 1008: "linear-mipmap-linear" };

function requireStandardPhysicalDefaults(material) {
  if (!material.isMeshPhysicalMaterial) return;
  const defaults = { anisotropy: 0, anisotropyRotation: 0, clearcoat: 0, clearcoatRoughness: 0, ior: 1.5,
    iridescence: 0, iridescenceIOR: 1.3, sheen: 0, sheenRoughness: 1, transmission: 0, thickness: 0,
    attenuationDistance: Infinity, specularIntensity: 1, dispersion: 0 };
  for (const [field, value] of Object.entries(defaults)) {
    if (material[field] !== undefined && material[field] !== value) throw new TypeError(`Unsupported avatar physical extension: ${field}`);
  }
  for (const [field, values] of Object.entries({ sheenColor: [0, 0, 0], attenuationColor: [1, 1, 1], specularColor: [1, 1, 1], clearcoatNormalScale: [1, 1], iridescenceThicknessRange: [100, 400] })) {
    const actual = material[field]?.toArray?.() || material[field];
    if (!actual || actual.length !== values.length || actual.some((value, i) => value !== values[i])) throw new TypeError(`Unsupported avatar physical extension: ${field}`);
  }
}

/** Copy raw attribute storage, retaining normalized integer attributes and stride. */
function attributeData(attribute) {
  if (!attribute || attribute.isInstancedBufferAttribute) throw new TypeError("Unsupported avatar attribute");
  const source = attribute.isInterleavedBufferAttribute ? attribute.data.array : attribute.array;
  const data = new source.constructor(attribute.count * attribute.itemSize);
  for (let i = 0; i < attribute.count; i++) for (let j = 0; j < attribute.itemSize; j++)
    data[i * attribute.itemSize + j] = source[i * (attribute.data?.stride || attribute.itemSize) + (attribute.offset || 0) + j];
  return { components: attribute.itemSize, normalized: attribute.normalized, data };
}

/** Decoded RGBA8 in source row order; no engine texture/image crosses the boundary. */
function texturePixels(texture) {
  const image = texture.image;
  if (!image?.width || !image?.height) throw new TypeError(`Texture ${texture.name} has no decoded pixels`);
  if (image.data) {
    if (!(image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray) || image.data.length !== image.width * image.height * 4)
      throw new TypeError(`Texture ${texture.name} requires RGBA8 pixels`);
    return new Uint8Array(image.data);
  }
  const canvas = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(image.width, image.height) : globalThis.document?.createElement("canvas");
  if (!canvas) throw new TypeError(`Texture ${texture.name}: pixel extraction requires a canvas or RGBA8 image`);
  canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  context.drawImage(image, 0, 0);
  return new Uint8Array(context.getImageData(0, 0, image.width, image.height).data);
}

/** Snapshot one model in its root frame. Resource IDs are deterministic traversal indices. */
export function captureAvatarResources(root, jointIds = new Map()) {
  const geometryIds = new Map(), materialIds = new Map(), textureIds = new Map();
  const geometries = [], materials = [], textures = [], meshes = [];
  const textureId = texture => {
    if (!texture) return null;
    if (textureIds.has(texture)) return textureIds.get(texture);
    if (texture.isCompressedTexture || texture.isCubeTexture || texture.mapping !== 300 || !wraps[texture.wrapS] || !wraps[texture.wrapT] || !filters[texture.minFilter] || !filters[texture.magFilter])
      throw new TypeError(`Unsupported texture mapping/sampler: ${texture.name}`);
    if (!["", "srgb", "srgb-linear"].includes(texture.colorSpace)) throw new TypeError(`Unsupported texture color space: ${texture.colorSpace}`);
    const uvMatrix = texture.matrix.clone();
    if (texture.matrixAutoUpdate) uvMatrix.setUvTransform(texture.offset.x, texture.offset.y, texture.repeat.x, texture.repeat.y, texture.rotation, texture.center.x, texture.center.y);
    const id = `texture-${textures.length}`; textureIds.set(texture, id);
    textures.push({ id, name: texture.name, width: texture.image.width, height: texture.image.height, pixels: texturePixels(texture),
      format: "rgba8", colorSpace: texture.colorSpace || "data", channel: texture.channel || 0,
      uvMatrix: uvMatrix.toArray(), wrapS: wraps[texture.wrapS], wrapT: wraps[texture.wrapT],
      minFilter: filters[texture.minFilter], magFilter: filters[texture.magFilter],
      flipY: texture.flipY, premultiplyAlpha: texture.premultiplyAlpha, generateMipmaps: texture.generateMipmaps, anisotropy: texture.anisotropy });
    return id;
  };
  const materialId = material => {
    if (materialIds.has(material)) return materialIds.get(material);
    if (!material.isMeshStandardMaterial)
      throw new TypeError(`Unsupported avatar material: ${material.type}`);
    requireStandardPhysicalDefaults(material);
    if (material.blending !== 1 || material.premultipliedAlpha || material.alphaHash)
      throw new TypeError(`Unsupported avatar blend policy: ${material.name}`);
    const maps = {};
    const channels = ["map", "normalMap", "metalnessMap", "roughnessMap", "emissiveMap", "aoMap", "alphaMap"];
    for (const [key, value] of Object.entries(material)) if (value?.isTexture && !channels.includes(key))
      throw new TypeError(`Unsupported avatar material channel: ${key}`);
    for (const key of channels) if (material[key]) maps[key] = textureId(material[key]);
    const id = `material-${materials.length}`; materialIds.set(material, id);
    materials.push({ id, name: material.name, model: "metallic-roughness", color: material.color.toArray(), emissive: material.emissive.toArray(),
      metalness: material.metalness, roughness: material.roughness, emissiveIntensity: material.emissiveIntensity,
      opacity: material.opacity, transparent: material.transparent, alphaTest: material.alphaTest, side: ["front", "back", "double"][material.side],
      depthTest: material.depthTest, depthWrite: material.depthWrite, vertexColors: material.vertexColors, flatShading: material.flatShading,
      toneMapped: material.toneMapped, normalScale: material.normalScale.toArray(), normalSpace: material.normalMapType === 0 ? "tangent" : "object",
      aoIntensity: material.aoMapIntensity, maps });
    return id;
  };
  root.updateWorldMatrix(true, true);
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    if (mesh.isInstancedMesh) throw new TypeError(`Instanced avatar meshes require explicit instance transforms: ${mesh.name}`);
    const geometry = mesh.geometry;
    if (Object.keys(geometry.morphAttributes).length) throw new TypeError(`Morph resources require a separate contract: ${mesh.name}`);
    if (!geometryIds.has(geometry)) {
      const id = `geometry-${geometries.length}`; geometryIds.set(geometry, id);
      geometries.push({ id, attributes: Object.fromEntries(Object.entries(geometry.attributes).map(([key, value]) => [key, attributeData(value)])),
        index: geometry.index ? attributeData(geometry.index) : null, groups: geometry.groups.map(group => ({ ...group })),
        drawRange: { start: geometry.drawRange.start, count: Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.count : null } });
    }
    let parent = mesh.parent;
    while (parent && parent !== root && !jointIds.has(parent)) parent = parent.parent;
    parent = parent && jointIds.has(parent) ? parent : root;
    const skin = mesh.isSkinnedMesh ? { jointIds: mesh.skeleton.bones.map(bone => {
      if (!jointIds.has(bone)) throw new TypeError(`Skin joint missing from mapped rig: ${bone.name}`);
      return jointIds.get(bone);
    }), inverseBindMatrices: mesh.skeleton.boneInverses.map(matrix => matrix.toArray()), bindMatrix: mesh.bindMatrix.toArray(),
    bindMatrixInverse: mesh.bindMatrixInverse.toArray(), bindMode: mesh.bindMode } : null;
    let visible = true;
    for (let node = mesh; node; node = node.parent) {
      visible = visible && node.visible;
      if (node === root) break;
    }
    meshes.push({ id: `mesh-${meshes.length}`, name: mesh.name, geometry: geometryIds.get(geometry),
      materials: (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(materialId), materialArray: Array.isArray(mesh.material),
      parentJointId: jointIds.get(parent) || null, localMatrix: parent.matrixWorld.clone().invert().multiply(mesh.matrixWorld).toArray(),
      visible, castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow, frustumCulled: mesh.frustumCulled, renderOrder: mesh.renderOrder, skin });
  });
  return { geometries, materials, textures, meshes };
}

export function readAvatarResources(instance, items = null) {
  if (!snapshots.has(instance)) snapshots.set(instance, captureAvatarResources(instance.holder, new Map(Object.entries(instance.bones).map(([id, bone]) => [bone, id]))));
  if (items && !itemSnapshots.has(items)) {
    itemSnapshots.set(items, Object.fromEntries(items.production.map(id => [id, captureAvatarResources(items.templates.get(id))])));
  }
  return { ...snapshots.get(instance), items: items ? itemSnapshots.get(items) : {} };
}
