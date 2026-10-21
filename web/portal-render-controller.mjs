const HOSTED_POINT_RELOAD_MS = 100;
const CLIENT_READ_INTERVAL_MIN_MS = 100;
const CLIENT_READ_INTERVAL_MAX_MS = 10000;
const DRAG_POST_THROTTLE_MS = 120;
const DEMO_DRAG_LIMIT_M = 5.4;

function disposeMesh(mesh) {
  try {
    if (mesh.parent) mesh.parent.remove(mesh);
    mesh.geometry?.dispose?.();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => material?.dispose?.());
  } catch {}
}

/** Shared hosted-object projection used by the direct scene and every legacy
 * canonical portal composition. The caller retains lifecycle/refresh ownership;
 * this only reconciles stable object IDs into one mesh instance per map. */
export function syncHostedSceneObjectMeshes({
  THREE,
  meshes,
  parent,
  objects,
  version = null,
  layer = null,
  setLayerRecursive = null,
  preservePositionForId = null,
  configureMesh = null,
}) {
  if (!parent || !(meshes instanceof Map)) {
    return { object_ids: [], created: 0, removed: 0, geometry_updated: 0, structure_changed: false };
  }
  const seen = new Set();
  let created = 0;
  let removed = 0;
  let geometryUpdated = 0;
  for (const definition of Array.isArray(objects) ? objects : []) {
    if (!definition?.object_id) continue;
    const objectId = String(definition.object_id);
    const shape = definition.shape === "sphere" ? "sphere" : "box";
    const sizeM = Math.max(0.15, Number(definition.size_m) || 0.5);
    const color = new THREE.Color(String(definition.color || "#8899aa"));
    seen.add(objectId);
    let mesh = meshes.get(objectId);
    if (!mesh) {
      const geometry = shape === "sphere"
        ? new THREE.SphereGeometry(sizeM / 2, 24, 18)
        : new THREE.BoxGeometry(sizeM, sizeM, sizeM);
      mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          color,
          roughness: 0.55,
          metalness: 0.1,
          emissive: color.clone().multiplyScalar(0.18),
        }),
      );
      mesh.name = `demo-scene-object-${objectId}`;
      mesh.userData.demoDrag = { kind: "scene-object", object_id: objectId };
      mesh.userData.portalDynamicBounds = true;
      if (layer != null && typeof setLayerRecursive === "function") setLayerRecursive(mesh, layer);
      parent.add(mesh);
      meshes.set(objectId, mesh);
      created += 1;
    } else if (
      mesh.userData.hostedSceneObject?.shape !== shape ||
      mesh.userData.hostedSceneObject?.size_m !== sizeM
    ) {
      mesh.geometry?.dispose?.();
      mesh.geometry = shape === "sphere"
        ? new THREE.SphereGeometry(sizeM / 2, 24, 18)
        : new THREE.BoxGeometry(sizeM, sizeM, sizeM);
      geometryUpdated += 1;
    }
    mesh.material?.color?.copy?.(color);
    mesh.material?.emissive?.copy?.(color)?.multiplyScalar?.(0.18);
    if (preservePositionForId !== objectId) {
      const position = Array.isArray(definition.position) ? definition.position : [0, 0, 0];
      mesh.position.set(Number(position[0]) || 0, Number(position[1]) || 0, Number(position[2]) || 0);
    }
    mesh.userData.hostedSceneObject = {
      object_id: objectId,
      shape,
      size_m: sizeM,
      color: `#${color.getHexString()}`,
      version,
      projection_authority: "shared_hosted_scene_object_projection_v1",
      geometry_type: mesh.geometry?.type || null,
      material_type: mesh.material?.type || null,
      material_authority: "shared_hosted_scene_object_standard_material_v1",
    };
    mesh.visible = true;
    if (typeof configureMesh === "function") configureMesh(mesh, definition);
  }
  for (const [id, mesh] of [...meshes.entries()]) {
    if (seen.has(id)) continue;
    disposeMesh(mesh);
    meshes.delete(id);
    removed += 1;
  }
  return {
    object_ids: [...seen],
    created,
    removed,
    geometry_updated: geometryUpdated,
    structure_changed: created > 0 || removed > 0,
  };
}

export function disposeHostedSceneObjectMeshes(meshes) {
  if (!(meshes instanceof Map)) return 0;
  const count = meshes.size;
  meshes.forEach(disposeMesh);
  meshes.clear();
  return count;
}

/**
 * Owns the demonstration-only hosted-point/portal-render editor lifecycle.
 * Scene composition and portal-preview camera/frame math stay with their
 * existing owners; this controller receives only the narrow host accessors it
 * needs to mirror hosted objects and update the existing proof surfaces.
 */
export function createPortalRenderController({
  THREE,
  isPlayer,
  getPortalHost,
  getScene,
  getServerViewMode,
  alignPortalVisualToTrigger,
  setPortalVisualAlignment,
  setLayerRecursive,
  childFabricLayer,
  lookup,
  documentTarget,
  windowTarget,
  nowMs,
  nowIso,
  logLine,
  writeDebugText,
  vec3Label,
  fixed3,
  isTypingTarget,
}) {
  const state = {
    started: false,
    cache: { a: null, b: null },
    versions: { a: -1, b: -1 },
    reloadCounts: { a: 0, b: 0 },
    lastReloadAt: null,
    rootMeshes: new Map(),
    rootSceneImpl: null,
    childMeshes: new Map(),
    childGroupRef: null,
    portalHandle: null,
    raycaster: null,
    pointerNdc: null,
    drag: null,
    lastDragPostAt: 0,
    dragPostCount: 0,
    playerPanelOpened: false,
    ladderFetchSeq: 0,
    settings: {
      mode: "auto",
      clientIntervalMs: HOSTED_POINT_RELOAD_MS,
      serverRepublishMs: HOSTED_POINT_RELOAD_MS,
    },
    intervalHandle: null,
  };
  const listeners = [];
  const wiredElements = new Set();
  let settingsModalWired = false;
  let refreshSettingsOpener = null;

  const portalHost = () => getPortalHost();
  const scene = () => getScene();
  const body = documentTarget.body;

  function listen(target, type, handler) {
    if (!target) return;
    target.addEventListener(type, handler);
    listeners.push([target, type, handler]);
  }

  /**
   * visibility seam.
   *
   * A hidden document paints nothing, so a hosted re-read taken while hidden
   * cannot be seen by anyone; the browser also throttles the timer that would
   * take it, so the reads that DO happen are irregular and stale by the time
   * the window comes back. Strict `=== true` keeps every non-DOM host (the
   * Node-importable check harnesses inject a documentTarget with no `hidden`
   * property) on the visible path, which is the pre-existing behavior.
   */
  function isDocumentHidden() {
    return documentTarget?.hidden === true;
  }

  /**
   * The observer resolution-ladder issues two extra hosted reads per refresh
   * (`color` + `splats`). They only ever land in the Portal-view card, which
   * ships COLLAPSED, so while the card is collapsed or the document is hidden
   * those reads paint nothing. Unknown DOM state fails OPEN — an unrecognised
   * host keeps the pre-existing read behavior rather than silently going dark.
   */
  function portalViewLadderObservable() {
    if (isDocumentHidden()) return false;
    const card = lookup("portal-view-card");
    if (!card) return true;
    if (card.hidden === true) return false;
    const classes = card.classList;
    if (classes && typeof classes.contains === "function" && classes.contains("section-collapsed")) return false;
    return true;
  }

  function wireElement(element, marker, type, handler) {
    if (!element || element.dataset[marker] === "1") return;
    element.dataset[marker] = "1";
    wiredElements.add([element, marker]);
    listen(element, type, handler);
  }

  function endpointKeys() {
    const live = portalHost();
    if (!live) return [];
    if (!isPlayer) return [live.activeEndpointKey];
    const keys = new Set([live.activeEndpointKey]);
    if (live.previewEndpointKey) keys.add(live.previewEndpointKey);
    const portals = Array.isArray(live.world?.portals)
      ? live.world.portals
      : live.world?.portal
        ? [live.world.portal]
        : [];
    for (const entry of portals) {
      const locationId = String(entry?.target_location_id || "");
      const endpointKey = locationId.startsWith("location-")
        ? locationId.slice("location-".length)
        : locationId;
      if (endpointKey) keys.add(endpointKey);
    }
    return [...keys];
  }

  function clearMeshMap(map, remove = false) {
    if (remove) map.forEach(disposeMesh);
    map.clear();
  }

  function ensurePortalDragHandle() {
    const live = portalHost();
    const activeScene = scene();
    if (isPlayer || !activeScene || !live) return;
    const impl = activeScene._impl;
    if (!impl?.scene || activeScene.rendererKind !== "webgl") return;
    const frame = live.world?.portal?.frame;
    if (!Array.isArray(frame?.position)) return;
    if (!state.portalHandle || state.portalHandle.parent !== impl.scene) {
      const sourceColored = !live.world || live.world.location_id !== "location-b";
      const handle = new THREE.Mesh(
        new THREE.CylinderGeometry(0.95, 0.95, 0.06, 40),
        new THREE.MeshBasicMaterial({
          color: sourceColored ? 0x66e0ff : 0xffc266,
          transparent: true,
          opacity: 0.32,
        })
      );
      handle.name = "demo-portal-drag-handle";
      handle.userData.demoDrag = { kind: "portal" };
      impl.scene.add(handle);
      state.portalHandle = handle;
    }
    state.portalHandle.position.set(frame.position[0], 0.04, frame.position[2]);
    state.portalHandle.visible = getServerViewMode() === "top_down";
  }

  function drawSnapshot3dPanel(canvas, snapshotValue, version) {
    if (!canvas) return;
    const context = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "#0b1020";
    context.fillRect(0, 0, width, height);
    const iso = (x, y, z) => [width / 2 + (x - z) * 11, height / 2 + (x + z) * 5.5 - y * 14 + 6];
    const corners = [iso(-6, 0, -6), iso(6, 0, -6), iso(6, 0, 6), iso(-6, 0, 6)];
    context.strokeStyle = "rgba(219,232,255,0.35)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(corners[0][0], corners[0][1]);
    for (const corner of corners.slice(1)) context.lineTo(corner[0], corner[1]);
    context.closePath();
    context.stroke();
    const value = snapshotValue || {};
    const portal = value.portal;
    if (Array.isArray(portal?.trigger_position)) {
      const [x, y] = iso(portal.trigger_position[0], 1.35, portal.trigger_position[2]);
      context.strokeStyle = "#ffbd69";
      context.lineWidth = 2;
      context.beginPath();
      context.ellipse(x, y, 6, 12, 0, 0, Math.PI * 2);
      context.stroke();
    }
    const objects = Array.isArray(value.objects) ? value.objects.slice() : [];
    objects.sort((left, right) => (left.position[0] + left.position[2]) - (right.position[0] + right.position[2]));
    for (const object of objects) {
      const position = Array.isArray(object.position) ? object.position : [0, 0, 0];
      const [x, y] = iso(position[0], position[1], position[2]);
      const size = Math.max(4, (Number(object.size_m) || 0.5) * 13);
      context.fillStyle = String(object.color || "#8899aa");
      context.strokeStyle = "rgba(255,255,255,0.4)";
      context.lineWidth = 1;
      if (object.shape === "sphere") {
        context.beginPath();
        context.arc(x, y, size / 2, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      } else {
        context.fillRect(x - size / 2, y - size / 2, size, size);
        context.strokeRect(x - size / 2, y - size / 2, size, size);
      }
    }
    context.fillStyle = "rgba(219,232,255,0.75)";
    context.font = "10px ui-monospace, Menlo, monospace";
    context.fillText(`3D snapshot · v${version != null ? version : "—"} · ${objects.length} objects`, 6, height - 6);
  }

  function renderResolutionLadder(prefix, endpointKey) {
    const live = portalHost();
    if (!live) return;
    // skip the two extra hosted reads while nothing they
    // write is observable. The card repopulates on the next re-read after it is
    // expanded, so the displayed ladder is never older than one client interval.
    if (prefix === "pv" && !portalViewLadderObservable()) {
      state.ladderFetchSeq += 1;
      return;
    }
    const attachPoint = state.cache[endpointKey];
    const sequence = ++state.ladderFetchSeq;
    const swatch = lookup(`${prefix}-color-swatch`);
    const hexElement = lookup(`${prefix}-color-hex`);
    live.demoReadPortalView(endpointKey, "color")
      .then((colorView) => {
        if (sequence !== state.ladderFetchSeq) return;
        const hex = colorView?.value ? String(colorView.value.color_hex || "") : "";
        if (swatch && hex) swatch.style.background = hex;
        if (hexElement) hexElement.textContent = hex ? `${hex} (v${colorView.version})` : "—";
      })
      .catch(() => { if (hexElement) hexElement.textContent = "unavailable"; });
    const snapshotValue = attachPoint?.value || null;
    drawSnapshot3dPanel(lookup(`${prefix}-snapshot-canvas`), snapshotValue, attachPoint?.version ?? null);
    const metaElement = lookup(`${prefix}-snapshot-meta`);
    if (metaElement) {
      metaElement.textContent = snapshotValue
        ? `${(snapshotValue.objects || []).length} objects · portal @ ${vec3Label(snapshotValue.portal?.trigger_position)}`
        : "—";
    }
    const splatsElement = lookup(`${prefix}-splats`);
    live.demoReadPortalView(endpointKey, "splats")
      .then((splatsView) => {
        if (splatsElement) {
          splatsElement.textContent = splatsView?.status === "stub_not_implemented"
            ? "STUBBED — not implemented (labeled)"
            : String(splatsView?.status || "—");
        }
      })
      .catch(() => { if (splatsElement) splatsElement.textContent = "unavailable"; });
  }

  function updatePortalViewPanel() {
    const live = portalHost();
    if (isPlayer || !live) return;
    const key = live.activeEndpointKey;
    const attachPoint = state.cache[key];
    writeDebugText("pv-reloads", `${state.reloadCounts[key] || 0} (client re-reads; no server push)`);
    if (!attachPoint) return;
    writeDebugText("pv-attach-id", String(attachPoint.attach_point_id || "—"));
    writeDebugText("pv-version", String(attachPoint.version ?? "—"));
    writeDebugText("pv-updated", String(attachPoint.updated_at || "—"));
    writeDebugText("pv-last-change", String(attachPoint.last_change || "—"));
    writeDebugText("pv-object-count", String(Array.isArray(attachPoint.value?.objects) ? attachPoint.value.objects.length : "—"));
    writeDebugText(
      "pv-portal-pose",
      attachPoint.portal_pose
        ? `${vec3Label(attachPoint.portal_pose.trigger_position)} → ${attachPoint.portal_pose.target_location_id || "?"}`
        : "—"
    );
    renderResolutionLadder("pv", key);
  }

  function updatePortalInfoPanel() {
    const live = portalHost();
    if (!isPlayer || !live || !state.playerPanelOpened) return;
    const portal = live.world?.portal || null;
    const destinationKey = live.previewEndpointKey;
    const attachPoint = destinationKey ? state.cache[destinationKey] : null;
    if (portal?.frame) {
      writeDebugText("pi-portal-id", String(portal.portal_id || "—"));
      writeDebugText("pi-route", `${live.world.location_id || "?"} → ${portal.target_location_id || "?"} (${portal.target_world_id || "?"})`);
      writeDebugText("pi-center", vec3Label(portal.frame.position));
      writeDebugText("pi-forward", vec3Label(portal.frame.forward));
      writeDebugText("pi-size", `${fixed3(portal.frame.width_m)} m × ${fixed3(portal.frame.height_m)} m`);
    }
    writeDebugText("pi-attach-id", attachPoint ? String(attachPoint.attach_point_id || "—") : "—");
    writeDebugText("pi-version", attachPoint?.version != null ? String(attachPoint.version) : "—");
    if (destinationKey) renderResolutionLadder("pi", destinationKey);
  }

  function openPortalInfoPanel() {
    if (!isPlayer) return false;
    const card = lookup("portal-info-card");
    if (!card) return false;
    card.hidden = false;
    card.classList.remove("section-collapsed");
    card.querySelector(":scope > h3")?.setAttribute("aria-expanded", "true");
    state.playerPanelOpened = true;
    body.setAttribute("data-portal-info-panel-open", "true");
    updatePortalInfoPanel();
    logLine("portal clicked: portal-info panel opened (resolution ladder = the DESTINATION hosted point re-read by this client)");
    return true;
  }

  function applyHostedPointToView(key, attachPoint) {
    const live = portalHost();
    const activeScene = scene();
    if (!live || !activeScene) return;
    const impl = activeScene._impl;
    const webgl = impl?.scene && activeScene.rendererKind === "webgl";
    const isActiveWorld = key === live.activeEndpointKey;
    const isDestinationWorld = isPlayer && key === live.previewEndpointKey;
    if (isActiveWorld) {
      if (webgl) {
        syncHostedSceneObjectMeshes({
          THREE,
          meshes: state.rootMeshes,
          parent: impl.scene,
          objects: attachPoint.value?.objects || [],
          version: attachPoint.version,
          preservePositionForId: state.drag?.kind === "scene-object" ? state.drag.id : null,
          configureMesh: (mesh, definition) => {
            // the authored airport renderer already
            // presents these graph nodes; keep only the proof projection.
            const suppressAirportWowProxy = isPlayer
              && portalHost()?.world?.location_id === "location-airport"
              && /^wow-node-\d+$/.test(String(definition.object_id));
            mesh.visible = !suppressAirportWowProxy;
            mesh.userData.airportWowProxySuppressed = suppressAirportWowProxy;
          },
        });
      }
      const trigger = attachPoint.portal_pose?.trigger_position || null;
      if (trigger && state.drag?.kind !== "portal" && typeof live.applyHostedPortalPose === "function") {
        const applied = live.applyHostedPortalPose(trigger);
        if (applied.changed) {
          setPortalVisualAlignment(alignPortalVisualToTrigger(activeScene, live.world));
          ensurePortalDragHandle();
          logLine(`hosted point v${attachPoint.version}: portal pose adopted from reload → ${vec3Label(trigger)} (visual + crossing frame follow the hosted point)`);
        }
      }
    }
    if (isDestinationWorld && webgl && impl.childFabricRender?.group) {
      syncHostedSceneObjectMeshes({
        THREE,
        meshes: state.childMeshes,
        parent: impl.childFabricRender.group,
        objects: attachPoint.value?.objects || [],
        version: attachPoint.version,
        layer: childFabricLayer,
        setLayerRecursive,
      });
      const trigger = attachPoint.portal_pose?.trigger_position || null;
      if (trigger && typeof live.applyHostedTargetPortalPose === "function") live.applyHostedTargetPortalPose(trigger);
    }
    body.setAttribute(`data-hosted-point-version-${key}`, String(attachPoint.version ?? ""));
    if (isActiveWorld && !isPlayer) updatePortalViewPanel();
    if (isDestinationWorld) updatePortalInfoPanel();
  }

  async function reloadHostedAttachPoint(key) {
    const live = portalHost();
    if (!live || typeof live.demoReadAttachPoint !== "function") return null;
    const attachPoint = await live.demoReadAttachPoint(key);
    state.reloadCounts[key] = (state.reloadCounts[key] || 0) + 1;
    state.lastReloadAt = nowIso();
    state.cache[key] = attachPoint;
    const version = Number(attachPoint?.version);
    if (Number.isFinite(version) && version !== state.versions[key]) {
      state.versions[key] = version;
      applyHostedPointToView(key, attachPoint);
    } else if (!isPlayer && key === live.activeEndpointKey) {
      writeDebugText("pv-reloads", `${state.reloadCounts[key] || 0} (client re-reads; no server push)`);
    }
    return attachPoint;
  }

  function refresh() {
    const live = portalHost();
    const activeScene = scene();
    if (!live || !activeScene) return [];
    const impl = activeScene._impl || null;
    if (impl !== state.rootSceneImpl) {
      state.rootSceneImpl = impl;
      clearMeshMap(state.rootMeshes);
      state.portalHandle = null;
      state.versions.a = -1;
      state.versions.b = -1;
      ensurePortalDragHandle();
    }
    const childGroup = isPlayer ? impl?.childFabricRender?.group || null : null;
    if (childGroup !== state.childGroupRef) {
      state.childGroupRef = childGroup;
      clearMeshMap(state.childMeshes);
      if (live.previewEndpointKey) state.versions[live.previewEndpointKey] = -1;
    }
    if (state.portalHandle) state.portalHandle.visible = getServerViewMode() === "top_down";
    return endpointKeys().map((key) => reloadHostedAttachPoint(key));
  }

  function refreshContained() {
    for (const request of refresh()) request.catch(() => {});
  }

  function pointerNdc(event) {
    const mount = lookup("scene-mount");
    if (!mount) return null;
    const rectangle = mount.getBoundingClientRect();
    if (!rectangle.width || !rectangle.height) return null;
    if (!state.pointerNdc) state.pointerNdc = new THREE.Vector2();
    state.pointerNdc.set(
      ((event.clientX - rectangle.left) / rectangle.width) * 2 - 1,
      -(((event.clientY - rectangle.top) / rectangle.height) * 2 - 1)
    );
    return state.pointerNdc;
  }

  function raycast(event, targets) {
    const activeScene = scene();
    const impl = activeScene?._impl;
    if (!impl?.camera || activeScene.rendererKind !== "webgl") return null;
    const point = pointerNdc(event);
    if (!point) return null;
    if (!state.raycaster) state.raycaster = new THREE.Raycaster();
    impl.camera.updateMatrixWorld(true);
    state.raycaster.setFromCamera(point, impl.camera);
    const hits = state.raycaster.intersectObjects(targets, true);
    return hits.length ? hits[0] : null;
  }

  function groundPoint(event) {
    const impl = scene()?._impl;
    if (!impl?.camera) return null;
    const point = pointerNdc(event);
    if (!point) return null;
    if (!state.raycaster) state.raycaster = new THREE.Raycaster();
    impl.camera.updateMatrixWorld(true);
    state.raycaster.setFromCamera(point, impl.camera);
    const ray = state.raycaster.ray;
    if (Math.abs(ray.direction.y) < 1e-6) return null;
    const distance = -ray.origin.y / ray.direction.y;
    if (distance <= 0) return null;
    return {
      x: Math.max(-DEMO_DRAG_LIMIT_M, Math.min(DEMO_DRAG_LIMIT_M, ray.origin.x + ray.direction.x * distance)),
      z: Math.max(-DEMO_DRAG_LIMIT_M, Math.min(DEMO_DRAG_LIMIT_M, ray.origin.z + ray.direction.z * distance)),
    };
  }

  function postDragUpdate(position, force) {
    const live = portalHost();
    const drag = state.drag;
    if (!drag || !live) return;
    const current = nowMs();
    if (!force && current - state.lastDragPostAt < DRAG_POST_THROTTLE_MS) return;
    state.lastDragPostAt = current;
    state.dragPostCount += 1;
    const key = live.activeEndpointKey;
    const request = drag.kind === "scene-object"
      ? live.demoMoveSceneObject(key, drag.id, position)
      : live.demoMovePortal(key, position);
    request.then(() => force ? reloadHostedAttachPoint(key) : null).catch(() => {});
  }

  function wireOverheadDragControls() {
    if (isPlayer) return;
    const mount = lookup("scene-mount");
    if (!mount) return;
    wireElement(mount, "portalOverheadDragWired", "mousedown", (event) => {
      const live = portalHost();
      if (event.button !== 0 || isTypingTarget(event.target) || getServerViewMode() !== "top_down" || !live) return;
      const impl = scene()?._impl;
      if (!impl) return;
      const targets = [...state.rootMeshes.values()];
      if (state.portalHandle) targets.push(state.portalHandle);
      if (impl.directionalPortalGroup) targets.push(impl.directionalPortalGroup);
      const hit = raycast(event, targets);
      if (!hit) return;
      let record = null;
      for (let node = hit.object; node; node = node.parent) {
        if (node.userData?.demoDrag) {
          record = node.userData.demoDrag.kind === "scene-object"
            ? { kind: "scene-object", id: node.userData.demoDrag.object_id, object3d: node, y: node.position.y }
            : { kind: "portal", id: live.world?.portal?.portal_id || "portal", object3d: node, y: 0 };
          break;
        }
        if (impl.directionalPortalGroup && node === impl.directionalPortalGroup) {
          record = { kind: "portal", id: live.world?.portal?.portal_id || "portal", object3d: node, y: 0 };
          break;
        }
      }
      if (!record) return;
      state.drag = record;
      mount.style.cursor = "grabbing";
      body.setAttribute("data-demo-drag-active", record.kind);
      event.preventDefault();
    });
    listen(windowTarget, "mousemove", (event) => {
      const drag = state.drag;
      if (!drag) return;
      const point = groundPoint(event);
      if (!point) return;
      const impl = scene()?._impl;
      if (drag.kind === "scene-object") {
        drag.object3d.position.x = point.x;
        drag.object3d.position.z = point.z;
        postDragUpdate([point.x, drag.y, point.z], false);
      } else if (impl?.directionalPortalGroup) {
        const y = impl.directionalPortalGroup.position.y;
        impl.directionalPortalGroup.position.set(point.x, y, point.z);
        state.portalHandle?.position.set(point.x, 0.04, point.z);
        postDragUpdate([point.x, 0, point.z], false);
      }
    });
    listen(windowTarget, "mouseup", (event) => {
      const drag = state.drag;
      if (!drag) return;
      const point = groundPoint(event);
      if (point) postDragUpdate(drag.kind === "scene-object" ? [point.x, drag.y, point.z] : [point.x, 0, point.z], true);
      state.drag = null;
      mount.style.cursor = "default";
      body.setAttribute("data-demo-drag-active", "");
      logLine(`${drag.kind === "portal" ? "portal" : `object ${drag.id}`} dragged (top-down view) → POSTed to the world server; hosted point version bumps and reloading clients update`);
    });
  }

  function wirePlayerPortalClick() {
    if (!isPlayer) return;
    const mount = lookup("scene-mount");
    if (!mount) return;
    let downX = 0;
    let downY = 0;
    wireElement(mount, "portalInfoClickWired", "mousedown", (event) => {
      downX = event.clientX;
      downY = event.clientY;
    });
    listen(mount, "click", (event) => {
      if (Math.hypot(event.clientX - downX, event.clientY - downY) > 6) return;
      const portalGroup = scene()?._impl?.directionalPortalGroup;
      if (portalGroup && raycast(event, [portalGroup])) openPortalInfoPanel();
    });
  }

  function applyRefreshLoop() {
    if (state.intervalHandle != null) {
      windowTarget.clearInterval(state.intervalHandle);
      state.intervalHandle = null;
    }
    body.setAttribute("data-portal-client-interval-ms", String(state.settings.clientIntervalMs));
    if (state.settings.mode !== "auto") {
      body.setAttribute("data-portal-refresh-mode", "on_demand");
      body.setAttribute("data-portal-refresh-hidden-paused", "false");
      return;
    }
    body.setAttribute("data-portal-refresh-mode", "auto");
    // pause the pull while the document is hidden. The
    // cadence, the Auto/On-demand contract and the client-PULL model are all
    // unchanged — this only declines to spend a re-read on a surface nobody can
    // see. `handleVisibilityChange` re-arms the loop AND takes an immediate
    // re-read on the way back, so a window returning to the front is never
    // showing a hosted point older than the transition itself.
    if (isDocumentHidden()) {
      body.setAttribute("data-portal-refresh-hidden-paused", "true");
      return;
    }
    body.setAttribute("data-portal-refresh-hidden-paused", "false");
    state.intervalHandle = windowTarget.setInterval(refreshContained, state.settings.clientIntervalMs);
  }

  function handleVisibilityChange() {
    applyRefreshLoop();
    if (!isDocumentHidden() && state.settings.mode === "auto") refreshContained();
  }

  function setClientReadInterval(rawMilliseconds) {
    const value = Number(rawMilliseconds);
    state.settings.clientIntervalMs = Number.isFinite(value)
      ? Math.max(CLIENT_READ_INTERVAL_MIN_MS, Math.min(CLIENT_READ_INTERVAL_MAX_MS, Math.round(value)))
      : state.settings.clientIntervalMs;
    applyRefreshLoop();
    syncRefreshControls();
    return state.settings.clientIntervalMs;
  }

  function setPortalRefreshMode(mode) {
    state.settings.mode = mode === "on_demand" ? "on_demand" : "auto";
    applyRefreshLoop();
    syncRefreshControls();
    logLine(state.settings.mode === "auto"
      ? `portal refresh: AUTO — client re-reads every ${state.settings.clientIntervalMs} ms (client PULLS; no server push)`
      : "portal refresh: ON-DEMAND — polling stopped; the 'reload now' button still re-reads the hosted point");
    return state.settings.mode;
  }

  function setServerRepublishRate(rawMilliseconds) {
    const live = portalHost();
    if (!live || typeof live.demoSetRepublishRate !== "function") return Promise.resolve(0);
    const value = Number(rawMilliseconds);
    const milliseconds = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
    state.settings.serverRepublishMs = milliseconds;
    body.setAttribute("data-server-republish-ms", String(milliseconds));
    syncRefreshControls();
    const keys = endpointKeys();
    logLine(milliseconds > 0
      ? `server republish: ON @ ${milliseconds} ms — the world server(s) [${keys.join(", ")}] now drift hosted objects; the portal view updates on the client's next re-read (server MUTATES; client PULLS — not a stream)`
      : `server republish: OFF — world server(s) [${keys.join(", ")}] apply no ambient change (pre-runtime behavior)`);
    return Promise.all(keys.map((key) => live.demoSetRepublishRate(key, milliseconds)
      .then((result) => {
        if (Number.isFinite(Number(result?.republish_rate_ms))) {
          body.setAttribute(`data-server-republish-applied-${key}`, String(result.republish_rate_ms));
        }
        return result;
      })
      .catch(() => null)))
      .then((results) => {
        const applied = results.find((result) => Number.isFinite(Number(result?.republish_rate_ms)));
        if (applied) {
          state.settings.serverRepublishMs = Number(applied.republish_rate_ms);
          syncRefreshControls();
        }
        return state.settings.serverRepublishMs;
      });
  }

  function refreshModeLine() {
    const client = state.settings.mode === "auto"
      ? `auto · client re-read every ${state.settings.clientIntervalMs} ms`
      : "on-demand · button-only (no poll)";
    const server = state.settings.serverRepublishMs > 0
      ? `server republish ${state.settings.serverRepublishMs} ms`
      : "server republish OFF";
    return `${client} · ${server} · reloadable-not-streaming (client PULLS)`;
  }

  function syncRefreshControls() {
    const auto = state.settings.mode === "auto";
    const toggle = lookup("pv-auto-toggle");
    if (toggle) toggle.checked = auto;
    for (const id of ["pv-client-interval", "hdr-client-interval"]) {
      const field = lookup(id);
      if (!field) continue;
      if (Number(field.value) !== state.settings.clientIntervalMs) field.value = String(state.settings.clientIntervalMs);
      field.disabled = !auto;
    }
    for (const id of ["pv-server-republish", "hdr-server-republish"]) {
      const field = lookup(id);
      if (field && Number(field.value) !== state.settings.serverRepublishMs) field.value = String(state.settings.serverRepublishMs);
    }
    lookup("hdr-refresh-mode-auto")?.setAttribute("aria-pressed", String(auto));
    lookup("hdr-refresh-mode-on-demand")?.setAttribute("aria-pressed", String(!auto));
    const line = refreshModeLine();
    writeDebugText("pv-refresh-mode-line", line);
    writeDebugText("hdr-refresh-mode-line", line);
    body.setAttribute("data-header-refresh-mode", state.settings.mode);
    body.setAttribute("data-server-republish-ms", String(state.settings.serverRepublishMs));
  }

  function wireRefreshInputControls() {
    const autoToggle = lookup("pv-auto-toggle");
    wireElement(autoToggle, "refreshWired", "change", () => setPortalRefreshMode(autoToggle.checked ? "auto" : "on_demand"));
    for (const id of ["hdr-refresh-mode-auto", "hdr-refresh-mode-on-demand"]) {
      const button = lookup(id);
      wireElement(button, "refreshWired", "click", () => setPortalRefreshMode(button.dataset.refreshMode));
    }
    for (const id of ["pv-client-interval", "hdr-client-interval"]) {
      const field = lookup(id);
      wireElement(field, "refreshWired", "change", () => setClientReadInterval(field.value));
    }
    for (const id of ["pv-server-republish", "hdr-server-republish"]) {
      const field = lookup(id);
      wireElement(field, "refreshWired", "change", () => setServerRepublishRate(field.value));
    }
    syncRefreshControls();
  }

  function openRefreshSettingsModal() {
    const modal = lookup("refresh-settings-modal");
    const button = lookup("btn-refresh-settings");
    if (!modal) return;
    refreshSettingsOpener = documentTarget.activeElement;
    syncRefreshControls();
    modal.hidden = false;
    body.setAttribute("data-refresh-modal-open", "true");
    button?.setAttribute("aria-expanded", "true");
    const closeButton = lookup("btn-refresh-settings-close");
    const firstSetting = lookup("hdr-refresh-mode-auto");
    try { closeButton?.focus?.(); } catch {}
    if (documentTarget.activeElement !== closeButton) {
      try { firstSetting?.focus?.(); } catch {}
    }
  }

  function closeRefreshSettingsModal() {
    const modal = lookup("refresh-settings-modal");
    const button = lookup("btn-refresh-settings");
    if (!modal) return;
    const wasOpen = !modal.hidden;
    modal.hidden = true;
    body.setAttribute("data-refresh-modal-open", "false");
    button?.setAttribute("aria-expanded", "false");
    if (!wasOpen) return;
    const opener = refreshSettingsOpener;
    refreshSettingsOpener = null;
    let restored = false;
    if (opener?.isConnected && typeof opener.focus === "function") {
      try {
        opener.focus();
        restored = documentTarget.activeElement === opener;
      } catch {}
    }
    if (!restored) {
      try { button?.focus?.(); } catch {}
    }
  }

  function wireSettingsModal() {
    if (settingsModalWired) return controller;
    settingsModalWired = true;
    wireRefreshInputControls();
    const button = lookup("btn-refresh-settings");
    const closeButton = lookup("btn-refresh-settings-close");
    const modal = lookup("refresh-settings-modal");
    wireElement(button, "refreshModalWired", "click", () => {
      if (modal && !modal.hidden) closeRefreshSettingsModal();
      else openRefreshSettingsModal();
    });
    wireElement(closeButton, "refreshModalWired", "click", closeRefreshSettingsModal);
    listen(documentTarget, "keydown", (event) => {
      if (event.key === "Escape" && modal && !modal.hidden && !isTypingTarget(event.target)) closeRefreshSettingsModal();
    });
    closeRefreshSettingsModal();
    return controller;
  }

  function mount() {
    if (state.started || !portalHost()) return controller;
    state.started = true;
    wireSettingsModal();
    const portalViewCard = lookup("portal-view-card");
    if (portalViewCard && !isPlayer) portalViewCard.hidden = false;
    const reloadButton = lookup("pv-reload-now");
    wireElement(reloadButton, "portalReloadWired", "click", () => {
      for (const key of endpointKeys()) reloadHostedAttachPoint(key).catch(() => {});
      logLine("hosted point manually re-read (reload-on-demand; the server never pushes this resource)");
    });
    wireOverheadDragControls();
    wirePlayerPortalClick();
    ensurePortalDragHandle();
    listen(documentTarget, "visibilitychange", handleVisibilityChange);
    refreshContained();
    applyRefreshLoop();
    setServerRepublishRate(state.settings.serverRepublishMs).catch(() => {});
    body.setAttribute("data-portal-render-validation", "active");
    logLine(
      `portal-render validation active: hosted scene objects + reloadable UM attach-point (client re-reads every ${state.settings.clientIntervalMs} ms in Auto mode + on demand; ` +
      "toggle Auto/On-demand + tune client interval & optional server republish in the Portal-view panel; labeled demo interpretation, NOT UM/IWPS conformance; splats rung stubbed)"
    );
    return controller;
  }

  function debug() {
    const live = portalHost();
    const activeAttachPoint = state.cache[live?.activeEndpointKey || "a"];
    return {
      started: state.started,
      endpoints_polled: endpointKeys(),
      versions: { ...state.versions },
      reload_counts: { ...state.reloadCounts },
      last_reload_at: state.lastReloadAt,
      drag_active: !!state.drag,
      drag_post_count: state.dragPostCount,
      refresh_settings: {
        mode: state.settings.mode,
        client_interval_ms: state.settings.clientIntervalMs,
        server_republish_ms: state.settings.serverRepublishMs,
        polling_active: state.intervalHandle != null,
      },
      root_object_meshes: [...state.rootMeshes.entries()].map(([id, mesh]) => ({
        object_id: id,
        position: [mesh.position.x, mesh.position.y, mesh.position.z].map((number) => Number(number.toFixed(3))),
        ...mesh.userData.hostedSceneObject,
        visible: mesh.visible,
      })),
      child_object_meshes: [...state.childMeshes.entries()].map(([id, mesh]) => ({
        object_id: id,
        position: [mesh.position.x, mesh.position.y, mesh.position.z].map((number) => Number(number.toFixed(3))),
        ...mesh.userData.hostedSceneObject,
        visible: mesh.visible,
      })),
      portal_handle_visible: state.portalHandle ? state.portalHandle.visible : null,
      player_panel_opened: state.playerPanelOpened,
      attach_point_active: activeAttachPoint ? {
        attach_point_id: activeAttachPoint.attach_point_id,
        version: activeAttachPoint.version,
        model: activeAttachPoint.model,
      } : null,
      listener_count: listeners.length,
    };
  }

  const driver = {
    state: debug,
    reloadNow: () => Promise.all(endpointKeys().map(reloadHostedAttachPoint)),
    openPortalPanel: openPortalInfoPanel,
    setRefreshMode: setPortalRefreshMode,
    setClientInterval: setClientReadInterval,
    setServerRepublish: setServerRepublishRate,
    readServerRepublish: (key) => {
      const live = portalHost();
      return typeof live?.demoReadRepublishRate === "function"
        ? live.demoReadRepublishRate(key || live.activeEndpointKey)
        : Promise.resolve(null);
    },
    settings: () => ({ ...state.settings, polling_active: state.intervalHandle != null }),
  };

  function dispose() {
    if (state.intervalHandle != null) {
      windowTarget.clearInterval(state.intervalHandle);
      state.intervalHandle = null;
    }
    for (const [target, type, handler] of listeners.splice(0)) target.removeEventListener(type, handler);
    for (const [element, marker] of wiredElements) delete element.dataset[marker];
    wiredElements.clear();
    settingsModalWired = false;
    state.drag = null;
    clearMeshMap(state.rootMeshes, true);
    clearMeshMap(state.childMeshes, true);
    if (state.portalHandle) disposeMesh(state.portalHandle);
    state.portalHandle = null;
    state.rootSceneImpl = null;
    state.childGroupRef = null;
    state.started = false;
    body.setAttribute("data-demo-drag-active", "");
    body.setAttribute("data-portal-render-validation", "inactive");
    return controller;
  }

  const controller = {
    mount,
    refresh,
    debug,
    dispose,
    wireSettingsModal,
    openRefreshSettings: openRefreshSettingsModal,
    closeRefreshSettings: closeRefreshSettingsModal,
    driver: () => driver,
    getCachedAttachPoint: (key) => state.cache[key] || null,
  };
  return controller;
}
