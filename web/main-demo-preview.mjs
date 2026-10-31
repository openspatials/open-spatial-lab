/*
 * A portal's see-through view in the main demo, from its destination's bounded preview. The window itself (the camera
 * glued through the portal frames, the screen-space opening, the crossing takeover) stays in
 * web/portal-spatial-preview.mjs; this builds the scene it looks into, and only from what the destination declared
 * (web/main-demo-portals.mjs, resolveBoundedPreview):
 *   - the preview's nodes, with any portal among them closed, in the world's own frame;
 *   - its image, or a plain colour, filling the opening;
 *   - a plain dark surface when there is no destination or it is offline.
 *
 * A preview that holds a world's authored airport terminal draws it with the same presentation code the airport
 * itself uses (web/airport-terminal-scene.mjs), for the storefronts, travelers and signs it declares.
 */

const COLOR_CLOSED_RING = 0x7a808c;
const COLOR_CLOSED_FACE = 0x2a2d33;
const COLOR_NOWHERE = 0x2a2d33;
const COLOR_OFFLINE = 0x28344f;
const WAY_BACK_REACH_M = 0.25;
const RING_CENTER_Y = 1.35;

/** A plain scene: what a portal shows of a destination that declares an image, a colour or nothing it can show. */
function flatComposition(content, { THREE }) {
  const scene = new THREE.Scene();
  let disposeTexture = null;
  if (content.preview_kind === "image" && content.image) {
    scene.background = new THREE.Color(COLOR_OFFLINE);
    new THREE.TextureLoader().load(content.image, (texture) => {
      texture.colorSpace = THREE.SRGBColorSpace || texture.colorSpace;
      scene.background = texture;
      disposeTexture = () => texture.dispose();
    });
  } else if (content.preview_kind === "color" && content.color) {
    scene.background = new THREE.Color(content.color);
  } else {
    scene.background = new THREE.Color(content.preview_kind === "none" ? COLOR_NOWHERE : COLOR_OFFLINE);
  }
  return {
    scene,
    source: "world_preview_flat",
    revision: content.revision,
    semantic_inventory: [],
    presentation: { preview_kind: content.preview_kind, assets: { status: "settled", requested: 0, loaded: 0, failed: 0 } },
    update: null,
    dispose: () => { if (disposeTexture) disposeTexture(); },
  };
}

/** The graph buildWowScene reads, from the preview's flat list: the root, with every other node as its child. */
function previewGraph(content) {
  const [rootNode, ...others] = content.nodes;
  const nodes = {};
  for (const node of content.nodes) {
    const authored = node.extension && node.extension.authored_wow_content;
    // A world's authored node stands in the graph as a labeled primitive; its look is the presentation's.
    const proxy = authored && /^osl-primitive:/i.test(String(node.spatialAssetURI || ""));
    nodes[node.id] = {
      id: node.id,
      label: node.label,
      names: node.names,
      localTransform: node.matrix,
      ...(node.spatialAssetURI && !proxy && !node.closed ? { spatialAssetURI: node.spatialAssetURI } : {}),
      ...(node.appearanceURI && !proxy ? { appearanceURI: node.appearanceURI } : {}),
      children: node === rootNode ? others.map((other) => other.id) : [],
      webofworlds_extension: { ...(node.extension || {}), source_url: node.url },
    };
  }
  return { spatialID: content.arrival, root: rootNode.id, nodes };
}

/** A portal inside a preview shows closed: its ring in grey and a plain face. Its destination is never read. */
function closedPortal(THREE, node) {
  const group = new THREE.Group();
  group.name = `wow-portal-closed:${node.label || node.id}`;
  group.position.y = RING_CENTER_Y;
  group.scale.set(0.9, 1.4, 1);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1, 0.075, 18, 80),
    new THREE.MeshStandardMaterial({ color: COLOR_CLOSED_RING, roughness: 0.6 }),
  );
  ring.name = "wow-portal-closed-ring";
  const face = new THREE.Mesh(
    new THREE.CircleGeometry(0.97, 72),
    new THREE.MeshBasicMaterial({ color: COLOR_CLOSED_FACE, side: THREE.DoubleSide }),
  );
  face.name = "wow-portal-closed-face";
  group.add(ring, face);
  return group;
}

/** Hide what a scene builder adds for looking at a bare graph: its reference grid and node markers. */
function hideBuilderAids(root, { keepFloor }) {
  root.traverse((node) => {
    const name = String(node.name || "");
    if (node.type === "GridHelper" && !name.startsWith("wow-osl-grid:")) node.visible = false;
    if (name.startsWith("wow-group-gizmo:")) node.visible = false;
    if (name === "wow-floor" && !keepFloor) node.visible = false;
  });
}

/** The scene a portal's window looks into. `deps` are the shared builders, injected so this file stays free of them. */
export function composeBoundedPreview(content, context, deps) {
  const { THREE, buildWowScene, mountAirportTerminalContent, mountWowSceneAssets, loadGltf, cloneScene, cache, document: doc, motionPreference } = deps;
  if (content.preview_kind !== "nodes") return flatComposition(content, deps);
  const width = Math.max(1, Number(context && context.width) || 1);
  const height = Math.max(1, Number(context && context.height) || 1);
  const graph = previewGraph(content);
  const built = buildWowScene(graph, THREE, { width, height, source: "portal_bounded_preview" });
  const terminal = content.nodes.some((node) => node.extension && node.extension.airport_terminal);
  const airportTerminal = terminal
    ? mountAirportTerminalContent(graph, built, THREE, { document: doc, motionPreference, hudOverlay: false, partial: true })
    : null;
  hideBuilderAids(built.scene, { keepFloor: terminal });
  // The preview's coordinates are relative to its arrival node; the world says where that node stands.
  built.root.matrixAutoUpdate = false;
  built.root.matrix.fromArray(content.world_transform);
  built.root.matrixWorldNeedsUpdate = true;

  const way = content.window_frame && content.window_frame.ground_center;
  const closed = [];
  for (const node of content.nodes) {
    if (!node.closed) continue;
    const group = built.node_groups.get(Number(node.id));
    if (!group) continue;
    group.updateWorldMatrix(true, false);
    const at = group.matrixWorld.elements;
    // The portal the visitor would arrive through stands exactly on the plane being looked through: the ring they
    // are looking through is its picture, so it is not drawn again across the opening.
    const wayBack = content.join_in_preview && way && Math.hypot(at[12] - way[0], at[14] - way[2]) <= WAY_BACK_REACH_M;
    closed.push({ id: node.id, label: node.label, way_back: !!wayBack });
    if (!wayBack) group.add(closedPortal(THREE, node));
  }

  const assets = {
    status: built.asset_nodes && built.asset_nodes.length ? "pending" : "settled",
    requested: built.asset_nodes ? built.asset_nodes.length : 0,
    loaded: 0,
    failed: 0,
  };
  let disposed = false;
  if (built.asset_nodes && built.asset_nodes.length) {
    void mountWowSceneAssets(built.asset_nodes, THREE, {
      loadGltf,
      cloneScene,
      cache,
      shouldMount: () => !disposed,
      // A listed world's `/assets/...` are this frontend's; another world's are at its own address.
      baseUrl: content.listed ? undefined : content.base,
      onAsset: (item, model, assetRecord) => {
        void built.airport_entity_runtime?.attachAsset(item, model, assetRecord);
      },
    }).then((summary) => Object.assign(assets, summary, { status: "settled" }))
      .catch((error) => Object.assign(assets, { status: "error", error: (error && error.message) || String(error) }));
  }
  return {
    scene: built.scene,
    source: "world_preview_nodes",
    revision: content.revision,
    semantic_inventory: Array.from(built.scene.children || [], (node) => node.name || node.type),
    presentation: {
      preview_kind: "nodes",
      node_ids: content.nodes.map((node) => node.id),
      radius_m: content.radius_m,
      closed_portals: closed,
      airport_terminal: airportTerminal,
      render_summary: built.render_summary,
      assets,
    },
    update: (seconds, camera) => built.airport_entity_runtime?.update(seconds, camera),
    dispose: () => {
      disposed = true;
      built.airport_hud_overlay?.dispose();
      built.airport_entity_runtime?.dispose();
    },
  };
}

/**
 * What a portal's ring says about its state: a portal that leads nowhere, whose destination is offline, or that sleeps
 * until a visitor comes near changes colour and carries a label; one the placement tool placed carries its name.
 * `group` is the ring's group in the live scene. Returns the state's name.
 */
/** The active radius of a placed portal, drawn on the floor around it, as the placement tool shows it. */
function syncRadiusCircle(THREE, group, entry, selected) {
  const radius = Number(entry.active_radius_m) || 0;
  let circle = group.userData.oslRadiusCircle || null;
  if (circle && circle.userData.radius !== radius) {
    group.remove(circle);
    circle.geometry.dispose();
    circle.material.dispose();
    circle = group.userData.oslRadiusCircle = null;
  }
  if (!radius) return;
  if (!circle) {
    circle = new THREE.Mesh(
      new THREE.RingGeometry(Math.max(0, radius - 0.04), radius, 96),
      new THREE.MeshBasicMaterial({ color: 0x59c8ff, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }),
    );
    circle.name = "wow-portal-radius";
    circle.userData.radius = radius;
    circle.rotation.x = -Math.PI / 2;
    group.add(circle);
    group.userData.oslRadiusCircle = circle;
  }
  // The ring's group is scaled to the oval and raised to its center: undo both for the floor.
  const scale = group.scale;
  circle.scale.set(1 / (scale.x || 1), 1 / (scale.z || 1), 1);
  circle.position.y = (0.03 - group.position.y) / (scale.y || 1);
  circle.material.opacity = selected ? 0.75 : 0.4;
}

const RING_STATES = Object.freeze({
  none: { color: COLOR_CLOSED_RING, second: "no destination" },
  unreachable: { color: 0xff6b3a, second: "offline" },
  asleep: { color: 0x3b5a78 },
});

export function applyPortalRingState({ THREE, document: doc, group, ring, entry, state, selected, destinationName, makeLabel }) {
  if (!group || !ring || !ring.material) return state;
  syncRadiusCircle(THREE, group, entry, selected);
  if (ring.userData.oslRingColor === undefined) ring.userData.oslRingColor = ring.material.color.getHex();
  const look = RING_STATES[state] || null;
  const color = selected ? 0xffc94a : look ? look.color : ring.userData.oslRingColor;
  ring.material.color.setHex(color);
  ring.material.emissive.setHex(color);
  const asleepLine = state === "asleep" ? `asleep · wakes within ${Number(entry.active_radius_m).toFixed(Number(entry.active_radius_m) % 1 ? 1 : 0)} m` : null;
  const lines = look || entry.placed ? [entry.label || "Portal", asleepLine || (look && look.second) || `→ ${destinationName || "its destination"}`] : null;
  const key = JSON.stringify(lines);
  if (group.userData.oslLabelKey !== key) {
    group.userData.oslLabelKey = key;
    if (group.userData.oslLabel) {
      group.remove(group.userData.oslLabel);
      group.userData.oslLabel.material?.map?.dispose?.();
      group.userData.oslLabel.material?.dispose?.();
      group.userData.oslLabel = null;
    }
    const sprite = lines && makeLabel ? makeLabel(THREE, doc, lines, state === "unreachable"
      ? { background: "rgba(28, 12, 6, 0.9)", stroke: "#ff6b3a", color: "#ffd9c8" }
      : { background: "rgba(8, 18, 32, 0.88)", stroke: "#9aa0aa", color: "#e4e6ea" }) : null;
    if (sprite) {
      // The ring's group is scaled to the oval; the label keeps its own proportions, above the ring.
      const scale = group.scale;
      sprite.scale.set(sprite.scale.x / (scale.x || 1), sprite.scale.y / (scale.y || 1), 1);
      sprite.position.y = 1 + 0.15 + (sprite.scale.y * (scale.y || 1)) / 2 / (scale.y || 1);
      group.add(sprite);
      group.userData.oslLabel = sprite;
    }
  }
  return state;
}
