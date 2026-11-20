import { normalizePortalTraversal, portalFrameForLocation } from "./live-adapter-portal-geometry.mjs";
import { arrivalFrame } from "./main-demo-portals.mjs";
import { refreshWorldMatrix } from "./three-world-matrix.mjs";
import { prepareWorld } from "./soft-body-world.mjs";

// The Scene Manager loads lazily through #scene-manager: index.html's import map in the browser, package.json's "imports" in Node.
const loadSceneManager = () => import("#scene-manager");
// The importers sit beside the Scene Manager in the engine folder; each is loaded from the manager's resolved address.
const IMPORTERS = Object.freeze({ x3d: Object.freeze(["../import/x3d/to-scene.mjs", "x3dImporter"]), gltf: Object.freeze(["../import/gltf/to-scene.mjs", "gltfImporter"]) });
const loadImporter = async (format) => {
  const [path, name] = IMPORTERS[format];
  return (await import(new URL(path, import.meta.resolve("#scene-manager")).href))[name];
};

const ANCHOR = "anchor-portal-world.x3d.json";
const SOFT = "soft-body.x3d.json";
/** glTF files the document route admits, under web/assets/worlds/, by their SHA-256. */
const GLTF_FILES = Object.freeze({
  "Duck.glb": "65bf938f54d6073e619e76e007820bbf980cdc3dc0daec0d94830ffc4ae54ab5",
  "BoomBox.glb": "f8b918445ebdd006768232205a62f5182d2208ca57f84c6ccc084943c0bc8f15",
  "Lantern.glb": "a79458c4b02d695187a952f23a63b8bf278e7bc3d316a3c2a314f2d6974181f1",
  "ToyCar.glb": "01a60862de55cd4b9f3acfab0b0def86451800f9c42467fcd61052c16cb9838c",
});
/** What the route asks of a glTF layer, which has no NavigationInfo: X3D's default navigation (headlight on) and a framed view when it has no camera. */
const GLTF_VIEW = Object.freeze({ navigation: Object.freeze({ modes: ["EXAMINE", "ANY"], speed: 1, avatarSize: [0.25, 1.6, 0.75], headlight: true }), frame: true });
const PORTAL_KEY = "x3d-document:PortalAnchor";
const LISTED_PAGE = /^\/w\/([a-z0-9-]+)\/$/;
const APERTURE_STANDOFF_M = 0.012; // the app's aperture offset (three-portal-surfaces.mjs)

/**
 * The authored PortalAnchor disc as one standard portal entry (an entry with `wow_resource`) for the app's portal
 * window, or `{ entry: null, reason }`. Reads only the typed document, the realization's own object map and the
 * browser's worlds list: the destination is the listed world whose `/w/{key}/` page the Anchor's url names, at its
 * address, with no join; nothing is taken from metadata and nothing falls back.
 */
export function ownX3dPortalEntry({ state, selection, worlds = [], THREE }) {
  const none = (reason) => Object.freeze({ entry: null, reason });
  const anchor = state?.document?.nodes?.find((node) => node.type === "Anchor" && node.def === "PortalAnchor");
  if (!anchor) return none("x3d_portal_anchor_missing");
  const authoredUrl = anchor.fields.url;
  if (authoredUrl.length !== 1 || authoredUrl[0] !== selection.destination) return none("x3d_portal_url_not_admitted");
  const key = LISTED_PAGE.exec(authoredUrl[0])?.[1];
  const world = key ? worlds.find((candidate) => candidate.key === key) : null;
  if (!world || typeof world.address !== "string") return none("x3d_portal_destination_not_listed");
  const discs = [];
  const walk = (node) => {
    if (node.type === "Shape") { if (node.children.geometry?.type === "Cylinder") discs.push(node); return; }
    for (const child of node.children.children ?? []) walk(child);
  };
  for (const child of anchor.children.children) walk(child);
  if (discs.length !== 1) return none("x3d_portal_disc_not_unique");
  const shape = discs[0], realized = state.realization.objects.get(shape.id) ?? [];
  if (realized.length !== 1) return none("x3d_portal_disc_instanced");
  const mesh = realized[0];
  refreshWorldMatrix(mesh);
  const world4 = mesh.matrixWorld;
  const center = new THREE.Vector3().setFromMatrixPosition(world4).toArray();
  const forward = new THREE.Vector3(0, 1, 0).transformDirection(world4).toArray();
  const semantic = state.runtime.matrixOf(mesh.userData.source.instance);
  const semanticResidual = Math.max(...world4.elements.map((value, i) => Math.abs(value - semantic[i])));
  const { radius, height } = shape.children.geometry.fields;
  const viewpoint = state.runtime.viewpoints[0]?.position ?? null;
  const signedViewpoint = viewpoint ? viewpoint.reduce((sum, v, i) => sum + (v - center[i]) * forward[i], 0) : null;
  const ground = [center[0], 0, center[2]];
  const frame = { ...portalFrameForLocation({ portalId: PORTAL_KEY, locationId: null, triggerPosition: ground, forward,
    targetLocationId: world.location_id }), position: center.slice(), ground_center: ground, width_m: 2 * radius,
  height_m: 2 * radius, pose_source: "x3d_authored_disc" };
  const metadataRadius = anchor.children.metadata?.children?.value?.find?.((v) => v.fields?.name === "radius_m")?.fields?.value?.[0] ?? null;
  const entry = {
    string_portal_id: PORTAL_KEY, portal_id: PORTAL_KEY, location_id: null,
    target_location_id: world.location_id ?? null, target_world_id: world.world_id ?? null,
    frame, target_frame: arrivalFrame({ position: [0, 0, 0], forward: [0, 0, 1], locationId: world.location_id ?? null }),
    traversal: normalizePortalTraversal({ mode: "one_way", allowed_entry_side: "front" }),
    wow_resource: { id: null, label: anchor.fields.description, destination: world.address, node: null },
    destination: world.address, active_radius_m: null,
    x3d_document_portal: { file: selection.filename, anchor_id: anchor.id, authored_url: authoredUrl[0], radius_m: radius, forward_source: "cylinder_axis" },
  };
  return Object.freeze({ entry, reason: null, disc: Object.freeze({ mesh, center, forward, radius_m: radius, height_m: height,
    semantic_residual: semanticResidual, viewpoint_signed_distance_m: signedViewpoint, metadata_radius_m: metadataRadius,
    world_key: world.key }) });
}

/** A content selection is separate from the renderer and the active server world. */
export function ownX3dDocumentSelection({ explicitRoute = false, world = null, portal = null } = {}) {
  let filename = world;
  if (portal) {
    if (portal.portal_id !== "lobby-portal-d" || portal.world !== "lobby" || portal.x3d_world !== SOFT)
      throw new TypeError("Unadmitted X3D portal selection");
    filename = portal.x3d_world;
  } else if (!explicitRoute) {
    if (world != null) throw new TypeError("X3D document requires an explicit route or selected portal");
    return null;
  }
  if (filename == null) filename = ANCHOR;
  // The importer is picked by file type: .glb files go to the glTF importer, the two X3D worlds to the X3D importer.
  if (!portal && Object.hasOwn(GLTF_FILES, filename)) return Object.freeze({ filename, format: "gltf", assetPath: `/assets/worlds/${filename}`,
    mediaType: "model/gltf-binary", sha256: GLTF_FILES[filename], compatibility: undefined, destination: null });
  if (filename !== ANCHOR && filename !== SOFT) throw new TypeError("Unknown X3D document");
  return Object.freeze({ filename, format: "x3d", assetPath: `/x3d-worlds/${filename}`, mediaType: "model/x3d+json",
    sha256: filename === SOFT ? "c7b42847b502f9c895bec63e05eb5cbc7423e11a8dce47447b0897c05c50a0e6" : "db7491aaa754aa3e33ef409e3812d6803ecb986b07f9f21cbbbe93405b043441",
    compatibility: filename === SOFT ? "carlson-soft-body-1" : undefined,
    destination: filename === SOFT ? "/w/lobby/" : "/w/b/" });
}

export function ownX3dShellUrl(search, withBase) {
  const params = new URLSearchParams(search);
  const selection = ownX3dDocumentSelection({ explicitRoute: true, world: params.get("world") });
  params.delete("world"); params.delete("active"); params.delete("wow");
  params.set("x3dDocument", selection.filename); params.set("renderer", "own-x3d");
  params.set("role", "player"); params.set("intro", "bypass");
  return `${withBase("/index.html")}?${params}`;
}

/** Environment files the document route admits, under web/x3d-worlds/environments/ (made by tools/x3d/). */
const ENVIRONMENTS = Object.freeze(["sky-gradient.hdr"]);
const INTENSITY = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * The environment the document route lights its scene with: `file` (query x3dEnvironment) names an admitted file and
 * `intensity` (query x3dEnvironmentIntensity, default 1) a finite number >= 0. Neither given: null, and the route makes
 * no lighting call. Anything else is refused with an error that names the parameter, never a silent fallback.
 */
export function ownX3dEnvironmentSelection({ file = null, intensity = null } = {}, withBase = path => path) {
  if (file == null) {
    if (intensity != null) throw new TypeError("x3dEnvironmentIntensity needs x3dEnvironment=<admitted file>");
    return null;
  }
  if (!ENVIRONMENTS.includes(file)) throw new TypeError(`Unknown X3D environment ${JSON.stringify(file)}; admitted: ${ENVIRONMENTS.join(", ")}`);
  let value = 1;
  if (intensity != null) {
    value = INTENSITY.test(intensity) ? Number(intensity) : NaN;
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`x3dEnvironmentIntensity must be a finite number >= 0, not ${JSON.stringify(intensity)}`);
  }
  const assetPath = `/x3d-worlds/environments/${file}`, url = withBase(assetPath);
  return Object.freeze({ file, assetPath, url, intensity: value,
    lighting: Object.freeze({ environment: Object.freeze({ asset: url, intensity: value }) }) });
}

/** Lighting status for debugState: the admitted environment and how its load ended; null without one. */
export function ownX3dLightingStatus(environment, lighting) {
  if (!environment) return null;
  const ready = lighting?.environment ?? null;
  return Object.freeze({ file: environment.file, asset: environment.url, intensity: environment.intensity,
    status: ready?.status ?? lighting?.environmentStatus ?? lighting?.status ?? "not-applied", reason: ready?.reason ?? null });
}

/** Same destination/base/server policy used by the existing dedicated viewer. */
export function x3dDestinationUrl(url, { renderer, serverOrigin, withBase, withServer, locationHref }) {
  const world = serverOrigin ? /^\/w\/([a-z0-9-]+)\/$/.exec(url)?.[1] : null;
  const target = new URL(world ? withBase("/") : withServer(url), locationHref);
  if (world && world !== "lobby") target.searchParams.set("active", world);
  target.searchParams.set("renderer", renderer);
  target.searchParams.set("role", "player"); target.searchParams.set("intro", "bypass");
  return target.origin === new URL(locationHref).origin ? `${target.pathname}${target.search}` : target.href;
}

/**
 * Guarded asynchronous preparation for the existing synchronous scene commit.
 * `lighting` is an optional host lighting description. An environment stays on the
 * scene where it was installed, so it is applied after every document load and
 * before publication; with no description no lighting call is made.
 */
export function prepareOwnX3dScene({ rendererPreparation, selection, fetchDocument, loadAmmo,
  createPhysics, readViewer, readPermission = () => [], dispatchIntent = () => {}, isCurrent, lighting = null, worlds = [] }) {
  const adapter = rendererPreparation.handle;
  try {
    if (adapter?.kind !== "own-x3d") throw new TypeError("X3D documents require the own-X3D adapter");
    if (typeof selection?.filename !== "string") throw new TypeError("An explicit X3D document selection is required");
    selection = ownX3dDocumentSelection({ explicitRoute: true, world: selection.filename });
  } catch (error) { rendererPreparation.dispose(); throw error; }
  const abort = new AbortController();
  // documents: the Scene Manager's host for this route (scene/manager.mjs), made once its module has loaded.
  let retired = false, state = null, physics = null, elapsed = 0, lightingResult = null, documents = null;
  let portal = null, portalReason = null, aperture = null, idleMaterial = null, applied = 0, windowTarget = null;
  const dispatched = new Set();
  const assertCurrent = () => {
    abort.signal.throwIfAborted();
    if (retired || !isCurrent()) throw new DOMException("X3D scene retired", "AbortError");
  };
  function dispatch(intent) {
    if (!intent || retired || !isCurrent() || !state.runtime.isCurrent(intent.generation)) return false;
    const allowed = readPermission();
    if (!allowed.includes(intent.anchorId) || intent.urls.length !== 1 || intent.urls[0] !== selection.destination) return false;
    const key = `${intent.generation}:${intent.anchorId}:${intent.urls[0]}`;
    if (dispatched.has(key)) return false;
    assertCurrent();
    dispatched.add(key);
    dispatchIntent(intent, selection);
    return true;
  }
  /** The authored disc as a window: a host overlay on the disc's front cap, shown with the manager's window material. */
  function createPortal() {
    const THREE = adapter.raw;
    const found = ownX3dPortalEntry({ state, selection, worlds, THREE });
    portalReason = found.reason;
    if (!found.entry) return;
    const { disc, entry } = found;
    idleMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    aperture = new THREE.Mesh(new THREE.CircleGeometry(disc.radius_m, 64), idleMaterial);
    aperture.name = "x3d-portal-aperture";
    aperture.rotation.x = -Math.PI / 2; // circle normal +Z onto the cylinder axis +Y
    aperture.position.y = disc.height_m / 2 + APERTURE_STANDOFF_M;
    aperture.visible = false;
    disc.mesh.parent.add(aperture);
    aperture.updateMatrixWorld(true);
    const round = (values) => values.map((v) => Number(v.toFixed(6)));
    portal = Object.freeze({
      key: PORTAL_KEY,
      entry,
      apply(surface) {
        if (retired || !isCurrent() || !aperture) return;
        if (surface && surface.material) {
          aperture.material = surface.material; aperture.visible = true; applied += 1;
          windowTarget = surface.record?.portalEntry?.target_frame ?? windowTarget;
        }
        else { aperture.material = idleMaterial; aperture.visible = false; }
      },
      debug() {
        return {
          key: PORTAL_KEY, reason: null,
          entry: { frame: { position: entry.frame.position.slice(), forward: entry.frame.forward.slice(), right: entry.frame.right.slice(),
            up: entry.frame.up.slice(), width_m: entry.frame.width_m, height_m: entry.frame.height_m, pose_source: entry.frame.pose_source },
          destination: entry.destination, target_location_id: entry.target_location_id, target_world_id: entry.target_world_id,
          traversal: { mode: entry.traversal.mode, allowed_entry_side: entry.traversal.allowed_entry_side }, wow_resource: { ...entry.wow_resource },
          x3d_document_portal: { ...entry.x3d_document_portal } },
          disc: { center: round(disc.center), forward: round(disc.forward), radius_m: disc.radius_m, height_m: disc.height_m,
            semantic_matrix_residual: disc.semantic_residual, viewpoint_signed_distance_m: disc.viewpoint_signed_distance_m,
            metadata_radius_m: disc.metadata_radius_m, world_key: disc.world_key },
          overlay: aperture ? { name: aperture.name, visible: aperture.visible, attached: !!aperture.parent,
            window_material: aperture.material !== idleMaterial, applied_frames: applied } : null,
          // The frame the window is glued to now (the destination preview's own window frame once it is read).
          window_target_frame: windowTarget ? { position: windowTarget.position.slice(), forward: windowTarget.forward.slice(),
            right: windowTarget.right.slice(), up: windowTarget.up.slice(), pose_source: windowTarget.pose_source ?? null } : null,
        };
      },
    });
  }
  function dispose() {
    if (retired) return;
    retired = true;
    abort.abort();
    const failures = [];
    // The host aperture overlay is not X3D's: it leaves the realized disc and frees its own geometry and idle
    // material. The window material on it is the preview manager's and is never disposed here.
    for (const release of [() => aperture?.removeFromParent(), () => aperture?.geometry.dispose(), () => idleMaterial?.dispose()]) {
      try { release(); } catch (error) { failures.push(error); }
    }
    for (const release of [() => documents?.cancel(), () => physics?.dispose(), () => rendererPreparation.dispose(), () => documents?.dispose()]) {
      try { release(); } catch (error) { failures.push(error); }
    }
    physics = null;
    if (failures.length) throw new AggregateError(failures, "X3D host disposal failed");
  }
  const handle = Object.freeze({
    get state() { return state; },
    get adapter() { return adapter; },
    get elapsedSeconds() { return elapsed; },
    get lighting() { return lightingResult; },
    get portal() { return portal; },
    get portalReason() { return portalReason; },
    evaluateFrame(delta) {
      if (retired || !isCurrent() || !state) return;
      const viewer = readViewer(state), paused = viewer.paused === true;
      const seconds = Math.min(.05, Math.max(0, Number(delta) || 0));
      if (!paused) elapsed += seconds;
      physics?.step(seconds, { paused, armMovement: viewer.armMovement ?? 0 });
      if (retired || !isCurrent()) return;
      adapter.syncScene();
      const result = documents.step({ time: elapsed, position: viewer.position,
        orientation: viewer.orientation, allowedAnchors: readPermission(), paused });
      for (const intent of result.intents) dispatch(intent);
    },
    renderFrame(timestamp) { if (!retired && isCurrent() && state) adapter.requestRender(timestamp); },
    activate(ray) {
      if (retired || !isCurrent() || !state) return false;
      const allowedAnchors = readPermission();
      const hit = documents.pick({ ...ray, allowedIds: allowedAnchors });
      return hit ? dispatch(documents.activate(hit.anchorId, { time: elapsed, allowedAnchors })) : false;
    },
    dispatch, dispose,
  });
  return Object.freeze({ handle, dispose, async ready() {
    try {
      await rendererPreparation.ready(); assertCurrent();
      const response = await fetchDocument(selection.assetPath, { signal: abort.signal }); assertCurrent();
      if (!response.ok) throw new Error(`X3D document answered ${response.status}`);
      const gltf = selection.format === "gltf";
      const original = gltf ? new Uint8Array(await response.arrayBuffer()) : await response.text(); assertCurrent();
      const digest = await crypto.subtle.digest("SHA-256", gltf ? original : new TextEncoder().encode(original)); assertCurrent();
      const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
      if (sha256 !== selection.sha256) throw new Error("X3D document digest does not match admitted source");
      const { createSceneHost } = await loadSceneManager(); assertCurrent();
      const importer = await loadImporter(selection.format); assertCurrent();
      documents = createSceneHost({ renderer: adapter });
      // X3D needs the soft-body preparation, its compatibility name and the portal binding; the X3D importer also hands
      // back the document it read, which the portal window below reads. glTF is read in report mode.
      let read = null;
      const source = { uri: selection.assetPath, mediaType: selection.mediaType, ...(gltf ? { bytes: original } : { text: original }) };
      const loaded = await documents.load(source, gltf ? { importer, mode: "report", signal: abort.signal, ...GLTF_VIEW }
        : { importer, mode: "strict", signal: abort.signal, centerOf: (entity) => entity.extras.x3d.centerOfRotation,
          options: { compatibility: selection.compatibility, preparePhysics: prepareWorld,
            portalBindings: [{ sensor: "PortalTrigger", anchor: "PortalAnchor" }], onDocument: (document) => { read = document; } } });
      state = Object.freeze({ ...loaded, document: read });
      assertCurrent();
      if (state.realization.preparedPhysics) {
        const ammo = await loadAmmo({ signal: abort.signal }); assertCurrent();
        physics = createPhysics(ammo, state.realization.preparedPhysics, state.realization.sink);
        assertCurrent();
      }
      createPortal();
      // A layer with no camera: the application moves the renderer's camera to the host's framed viewpoint.
      const view = state.runtime.viewpoints[0];
      if (view?.framed) {
        const camera = adapter.camera;
        camera.position.fromArray(view.position); camera.quaternion.set(0, 0, 0, 1);
        camera.near = view.near; camera.far = view.far; camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
      }
      // Texture images decode asynchronously in the renderer; the route is ready once they have.
      const images = adapter.sceneRoot?.userData?.imagesReady;
      if (images) { await images; assertCurrent(); }
      if (lighting) {
        const { environmentReady, ...result } = adapter.setLighting(lighting) ?? {};
        const environment = environmentReady ? await environmentReady : null;
        assertCurrent();
        lightingResult = Object.freeze({ ...result, environment });
      }
    } catch (error) {
      try { dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], "X3D preparation failed"); }
      throw error;
    }
  } });
}
