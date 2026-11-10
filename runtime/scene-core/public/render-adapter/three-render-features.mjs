export function threeCapabilities(THREE, renderer, scene) {
  const feature = (status, level, reason, limits = []) => ({ status, level, reason, limits, evidenceScope: "current three.js adapter and scene" });
  return {
    engine: "three", version: `r${THREE.REVISION}`,
    features: {
      skinning: feature("supported", "evaluated joint matrices", "The existing avatar evaluator supplies the pose."),
      gltf: feature("supported", "skinned glTF", "Loaded through the shared asset loader; native clips do not own a second clock."),
      physicalMaterials: feature("supported", "standard materials", "Metalness and roughness are mapped to three.js materials."),
      shadows: feature(renderer?.shadowMap?.enabled ? "supported" : "limited", renderer?.shadowMap?.enabled ? "enabled" : "off", "Shadows follow the current world lighting settings."),
      environment: { ...feature("limited", scene?.environment ? "world image lighting" : "no environment image", "Neutral environment URIs load through a host resolver (setEnvironmentResolver) as equirectangular linear float data; intensity is applied as envMapIntensity on standard/physical materials present when it is applied. Without a resolver, URI loading and intensity are reported unsupported and existing world environments are preserved. No rendered GPU qualification.", ["materials added after the environment is applied keep their own envMapIntensity", "the environment stays on the scene it was applied to when the adapter adopts another scene"]), resolver: "supported" },
      portalPreview: feature("supported", "live destination texture", "Uses the current world's renderer and destination access filtering."),
      directPose: feature("supported", "direct matrices", "No text attributes or extra animation mixer."),
      picking: feature("untested", "world controls", "Pointer behavior is owned by the existing world controls; generic adapter picking is not qualified."),
      clipping: feature("limited", "one plane", "The adapter accepts one global plane; full portal optical parity is separately qualified."),
    },
  };
}

export function bindThreeSkin(asset, rig) {
  const nodes = new Map();
  asset.traverse(node => { if (node.isBone) nodes.set(node.name, node); });
  if (!rig?.jointIds?.length || new Set(rig.jointIds).size !== rig.jointIds.length)
    return { supported: false, reason: "A unique joint map is required." };
  const bones = rig.jointIds.map(id => nodes.get(id));
  if (bones.some(bone => !bone)) return { supported: false, reason: "The asset does not contain every mapped joint." };
  asset.updateMatrixWorld(true);
  const mappedParents = bones.map((bone, index) => {
    if (rig.jointFrame !== "nearest-mapped-parent-or-holder") return null;
    const parent = rig.parentJointIds[index] == null ? asset : nodes.get(rig.parentJointIds[index]);
    if (!parent) throw new TypeError("Mapped joint parent is missing from the asset");
    return parent;
  });
  return { supported: true, bones, mappedParents, root: asset };
}

export function applyThreePose(binding, matrices) {
  if (!binding?.supported) return binding;
  if (!Array.isArray(matrices) || matrices.length !== binding.bones.length || matrices.some(m => m?.length !== 16 || !Array.from(m).every(Number.isFinite)))
    throw new TypeError("Joint pose must contain one finite column-major matrix per mapped joint");
  binding.root.updateMatrixWorld(true);
  const localMatrices = binding.bones.map((bone, index) => {
    const wanted = bone.matrix.clone().fromArray(matrices[index]);
    const parent = binding.mappedParents[index];
    if (parent) wanted.premultiply(bone.parent.matrixWorld.clone().invert().multiply(parent.matrixWorld));
    return wanted;
  });
  binding.bones.forEach((bone, index) => {
    const wanted = localMatrices[index];
    // The three.js fast path shares the evaluator graph. Leave its matrix
    // update policy intact when the completed pose is already present.
    if (wanted.elements.every((value, i) => Math.abs(value - bone.matrix.elements[i]) < 1e-9)) return;
    bone.matrix.copy(wanted);
    bone.matrixAutoUpdate = false;
    bone.matrixWorldNeedsUpdate = true;
  });
  binding.root.updateMatrixWorld(true);
  return true;
}

// Neutral environment images: rows run top (+Y) to bottom, like an image file,
// in linear RGB(A) float radiance. r160 has no RGBFormat, so RGB is widened.
const ENVIRONMENT_CHANNELS = Object.freeze({ "equirect-linear-rgb": 3, "equirect-linear-rgba": 4 });

/** Validates a resolved environment image and copies it into adapter-owned RGBA float data. */
export function readEnvironmentImage(image) {
  if (!image || typeof image !== "object") throw new TypeError("environment image must be an object");
  const channels = Object.hasOwn(ENVIRONMENT_CHANNELS, image.kind) ? ENVIRONMENT_CHANNELS[image.kind] : 0;
  if (!channels) throw new TypeError(`environment image kind must be one of ${Object.keys(ENVIRONMENT_CHANNELS).join(", ")}`);
  const { width, height, data } = image;
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1)
    throw new TypeError("environment image width and height must be positive integers");
  if (!(data instanceof Float32Array)) throw new TypeError("environment image data must be a Float32Array");
  if (data.length !== width * height * channels)
    throw new TypeError(`environment image data length ${data.length} does not match ${width}x${height}x${channels}`);
  const rgba = new Float32Array(width * height * 4);
  for (let pixel = 0, source = 0, target = 0; pixel < width * height; pixel++, source += channels, target += 4) {
    for (let channel = 0; channel < channels; channel++) {
      const value = data[source + channel];
      if (!Number.isFinite(value)) throw new TypeError(`environment image value at index ${source + channel} is not finite`);
      rgba[target + channel] = value;
    }
    if (channels === 3) rgba[target + 3] = 1;
  }
  return { width, height, data: rgba };
}

function environmentTexture(THREE, image, renderer) {
  const { width, height, data } = readEnvironmentImage(image);
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.flipY = true;
  // Linear filtering of float textures needs OES_texture_float_linear; without it
  // the texture would sample black, so fall back to nearest.
  const filter = renderer?.extensions?.has?.("OES_texture_float_linear") === true ? THREE.LinearFilter : THREE.NearestFilter;
  texture.magFilter = texture.minFilter = filter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

// Adapter dispose() releases this state through releaseThreeEnvironment().
function environmentState(adapter) {
  if (!adapter._environment) adapter._environment = { token: 0, owned: null, pending: null, intensity: null, materials: new Map() };
  return adapter._environment;
}

function cancelPendingEnvironment(state) {
  state.token += 1;
  if (!state.pending) return;
  const { controller } = state.pending;
  state.pending = null;
  controller.abort();
}

function restoreEnvironmentIntensity(state) {
  for (const [material, entry] of state.materials)
    if (material.envMapIntensity === entry.written) material.envMapIntensity = entry.prior;
  state.materials.clear();
  state.intensity = null;
}

// r160 has no Scene.environmentIntensity. Materials that sample the scene
// environment (no own envMap) take the value; prior values are restored.
function applyEnvironmentIntensity(adapter, state, value) {
  restoreEnvironmentIntensity(state);
  if (value == null) return;
  adapter.sceneRoot.traverse(object => {
    for (const material of [object.material].flat()) {
      if (!material?.isMeshStandardMaterial || material.envMap || state.materials.has(material)) continue;
      state.materials.set(material, { prior: material.envMapIntensity, written: value });
      material.envMapIntensity = value;
    }
  });
  state.intensity = value;
}

function releaseOwnedEnvironment(owned) {
  if (owned.scene.environment === owned.texture) owned.scene.environment = null;
  owned.texture.dispose();
}

/** Cancels a pending load, restores intensity and disposes the adapter-owned environment once. */
export function releaseThreeEnvironment(adapter) {
  const state = adapter._environment;
  if (!state) return;
  cancelPendingEnvironment(state);
  restoreEnvironmentIntensity(state);
  const owned = state.owned;
  state.owned = null;
  if (owned) releaseOwnedEnvironment(owned);
}

function requestThreeEnvironment(adapter, state, resolver, { asset, intensity }) {
  cancelPendingEnvironment(state);
  const token = state.token;
  const root = adapter.sceneRoot;
  const owned = state.owned;
  if (owned && owned.asset === asset && owned.scene === root && root.environment === owned.texture) {
    applyEnvironmentIntensity(adapter, state, intensity);
    return { status: "applied", ready: Promise.resolve({ status: "applied", asset, supported: true }) };
  }
  const controller = new AbortController();
  // A settled current request updates the latest lighting result in place of its
  // "loading" report; later calls' non-environment settings are kept.
  const settle = (outcome) => {
    if (state.token !== token) return outcome;
    state.pending = null;
    const base = adapter._lightingResult || {};
    const others = (base.unsupported || []).filter(entry => !entry.setting.startsWith("environment."));
    const failures = outcome.status === "applied" ? [] : [
      { setting: "environment.asset", reason: `Environment load failed: ${outcome.reason} The previous environment is retained.` },
      ...(intensity != null ? [{ setting: "environment.intensity", reason: "Intensity was not applied because the environment load failed." }] : []),
    ];
    const unsupported = [...others, ...failures];
    adapter._lightingResult = { ...base, supported: unsupported.length === 0, status: unsupported.length ? "limited" : "supported", unsupported,
      environment: !!adapter.sceneRoot.environment, environmentStatus: outcome.status };
    return outcome;
  };
  // Start resolution now; a synchronous throw becomes a rejection handled after
  // this request is registered.
  let resolution;
  try { resolution = Promise.resolve(resolver(asset, { signal: controller.signal })); }
  catch (error) { resolution = Promise.reject(error); }
  const discarded = { status: "discarded", asset, supported: false, reason: "A newer environment request, a clear or adapter disposal superseded this load." };
  const ready = (async () => {
    let image;
    try { image = await resolution; }
    catch (error) { return state.token === token ? settle({ status: "failed", asset, supported: false, reason: `Resolver rejected: ${error?.message || error}.` }) : discarded; }
    if (state.token !== token) return discarded;
    let texture;
    try { texture = environmentTexture(adapter.raw, image, adapter.renderer); }
    catch (error) { return settle({ status: "failed", asset, supported: false, reason: `${error.message}.` }); }
    if (state.token !== token) { texture.dispose(); return discarded; }
    const scene = adapter.sceneRoot;
    const previous = state.owned;
    scene.environment = texture;
    state.owned = { texture, asset, scene };
    if (previous) releaseOwnedEnvironment(previous);
    applyEnvironmentIntensity(adapter, state, intensity);
    return settle({ status: "applied", asset, supported: true });
  })();
  state.pending = { token, asset, controller, ready };
  return { status: "loading", ready };
}

export function applyThreeLighting(adapter, description = {}) {
  const root = adapter.sceneRoot;
  const unsupported = [];
  const shadows = typeof description.shadows === "object" ? description.shadows : { enabled: description.shadows === true };
  const resolver = typeof adapter._environmentResolver === "function" ? adapter._environmentResolver : null;
  // Environment assets are neutral URIs; a host-registered resolver turns one
  // into float data. The adapter never fetches. Without a resolver, the current
  // world environment is retained and both settings are reported unsupported.
  let environmentRequest = null;
  if (description.environment != null) {
    if (typeof description.environment !== "object" || typeof description.environment.asset !== "string")
      throw new TypeError("environment requires a neutral asset URI, not an engine texture");
    if (!resolver) {
      unsupported.push({ setting: "environment.asset", reason: "Environment asset loading is not implemented by this adapter; the current world environment is retained." });
      if (description.environment.intensity != null)
        unsupported.push({ setting: "environment.intensity", reason: "Independent environment intensity is not implemented in the bundled renderer path." });
    } else {
      const { asset, intensity } = description.environment;
      if (!asset) throw new TypeError("environment asset URI must not be empty");
      if (intensity != null && (!Number.isFinite(intensity) || intensity < 0)) throw new TypeError("environment intensity must be finite and nonnegative");
      if (adapter._disposed) throw new Error("adapter is disposed");
      environmentRequest = { asset, intensity: intensity ?? null };
    }
  }
  for (const light of adapter._descriptionLights || []) root.remove(light);
  adapter._descriptionLights = [];
  for (const [kind, spec] of [["fill", description.fill], ["key", description.key]]) {
    if (!spec) continue;
    const position = spec.direction ? spec.direction.map(value => -value) : spec.position;
    const light = kind === "key" ? adapter.createDirectionalLight({ ...spec, position: position || [0, 1, 0] }) : adapter.createAmbientLight(spec);
    light.castShadow = kind === "key" && shadows.enabled === true;
    if (light.shadow) {
      if (shadows.mapSize != null) {
        if (!Number.isInteger(shadows.mapSize) || shadows.mapSize < 1) throw new TypeError("shadow mapSize must be a positive integer");
        light.shadow.mapSize.set(shadows.mapSize, shadows.mapSize);
      }
      if (shadows.bias != null) {
        if (!Number.isFinite(shadows.bias)) throw new TypeError("shadow bias must be finite");
        light.shadow.bias = shadows.bias;
      }
    }
    root.add(light);
    adapter._descriptionLights.push(light);
  }
  if (adapter.renderer) {
    adapter.renderer.shadowMap.enabled = shadows.enabled === true;
    if (description.exposure != null) {
      if (!Number.isFinite(description.exposure) || description.exposure < 0) throw new TypeError("exposure must be finite and nonnegative");
      adapter.renderer.toneMappingExposure = description.exposure;
    }
  }
  if (description.environment === null) {
    releaseThreeEnvironment(adapter);
    root.environment = null;
  }
  const lighting = { supported: unsupported.length === 0, status: unsupported.length ? "limited" : "supported", unsupported, environment: !!root.environment, shadows: shadows.enabled === true };
  if (description.environment === null) lighting.environmentStatus = "cleared";
  if (environmentRequest) {
    const load = requestThreeEnvironment(adapter, environmentState(adapter), resolver, environmentRequest);
    lighting.environment = !!root.environment;
    lighting.environmentStatus = load.status;
    lighting.environmentReady = load.ready;
    if (load.status === "loading") { lighting.supported = false; lighting.status = "loading"; }
  }
  adapter._lightingResult = lighting;
  return adapter._lightingResult;
}
