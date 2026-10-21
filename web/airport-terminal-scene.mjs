// airport-terminal content mounted into the existing
// WoW Three.js scene. This is content presentation, not a second renderer:
// buildWowScene still owns the scene/camera/root, mountWowSceneAssets still
// loads NPC avatar nodes, and app.js still owns avatar movement/camera input.

import {
  createAirportWalkableSurfaceContract,
  resolveAirportGroundSurface,
} from "./airport-walkable-surface.mjs";
import { createAirportEntityRuntime } from "./airport-entity-runtime.mjs";
// Glassline AR HUD overlay (additive; browser-only, fail-safe).
import { initAirportHudOverlay } from "./hud/airport-hud-overlay.mjs";

function terminalNodeList(graph) {
  const raw = graph && graph.nodes;
  return Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
}

function terminalNodePosition(node) {
  const matrix = node && Array.isArray(node.localTransform) ? node.localTransform : null;
  return matrix && matrix.length === 16
    ? [Number(matrix[12]) || 0, Number(matrix[13]) || 0, Number(matrix[14]) || 0]
    : [0, 0, 0];
}

function terminalBoxMesh(THREE, name, size, position, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function terminalSignMesh(THREE, doc, label, background, foreground, width, height) {
  let material;
  if (doc && typeof doc.createElement === "function") {
    const canvas = doc.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = foreground;
      ctx.lineWidth = 14;
      ctx.strokeRect(7, 7, canvas.width - 14, canvas.height - 14);
      ctx.fillStyle = foreground;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      let fontSize = 110;
      do {
        ctx.font = `800 ${fontSize}px system-ui, sans-serif`;
        fontSize -= 4;
      } while (fontSize > 44 && ctx.measureText(label).width > 930);
      ctx.fillText(label, 512, 132);
      const texture = new THREE.CanvasTexture(canvas);
      texture.needsUpdate = true;
      material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, toneMapped: false });
    }
  }
  if (!material) {
    material = new THREE.MeshBasicMaterial({ color: background, side: THREE.DoubleSide });
  }
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  sign.name = `airport-sign:${label}`;
  sign.userData.airportLabel = label;
  return sign;
}

function terminalStorefront(THREE, doc, node, materials) {
  const ext = node.webofworlds_extension || {};
  const [x, , z] = terminalNodePosition(node);
  const side = x < 0 ? -1 : 1;
  const accent = new THREE.MeshStandardMaterial({
    color: Number(ext.accent) || 0x2aa7a1,
    emissive: Number(ext.accent) || 0x2aa7a1,
    emissiveIntensity: 0.08,
    roughness: ext.category === "duty-free" ? 0.28 : 0.7,
    metalness: ext.category === "duty-free" ? 0.45 : 0.05,
  });
  const group = new THREE.Group();
  group.name = `airport-store:${ext.category}:${node.label}`;
  group.userData.airportStore = { category: ext.category, label: node.label };
  group.position.set(x, 0, z);

  group.add(terminalBoxMesh(THREE, "store-floor", [6.2, 0.12, 5.8], [0, 0.06, 0], materials.storeFloor));
  group.add(terminalBoxMesh(THREE, "store-back-wall", [0.22, 4.8, 5.8], [side * 3, 2.4, 0], materials.wall));
  group.add(terminalBoxMesh(THREE, "store-canopy", [6.2, 0.32, 5.8], [0, 4.65, 0], accent));
  group.add(terminalBoxMesh(THREE, "store-counter", [2.2, 1.05, 4.6], [-side * 1.85, 0.55, 0.2], accent));

  const sign = terminalSignMesh(THREE, doc, ext.sign || node.label, ext.sign_background || "#133249", "#ffffff", 5.2, 1.15);
  sign.position.set(-side * 1.75, 3.55, -2.48);
  sign.rotation.y = Math.PI;
  group.add(sign);

  if (ext.category === "coffee") {
    for (const dz of [-1.35, 0, 1.35]) {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.42, 18), materials.coffeeCup);
      cup.name = "coffee-cup-display";
      cup.position.set(-side * 2.0, 1.28, dz);
      group.add(cup);
    }
    group.add(terminalBoxMesh(THREE, "coffee-menu", [0.12, 1.65, 2.4], [side * 2.82, 2.5, 0], materials.menu));
  } else if (ext.category === "news") {
    for (const dz of [-1.7, 0, 1.7]) {
      group.add(terminalBoxMesh(THREE, "news-magazine-rack", [1.35, 1.8, 0.45], [side * 1.65, 0.95, dz], materials.newsRack));
    }
  } else if (ext.category === "duty-free") {
    for (const dz of [-1.6, 0, 1.6]) {
      group.add(terminalBoxMesh(THREE, "duty-free-display", [1.2, 0.85, 1.05], [side * 1.45, 0.48, dz], materials.dutyDisplay));
      const bottle = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.55, 16), materials.bottle);
      bottle.name = "duty-free-bottle";
      bottle.position.set(side * 1.45, 1.2, dz);
      group.add(bottle);
    }
  } else if (ext.category === "food") {
    for (let i = -2; i <= 2; i += 1) {
      const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.27, 0.58, 18), materials.stool);
      stool.name = "food-counter-stool";
      stool.position.set(-side * 3.0, 0.3, i * 0.9);
      group.add(stool);
    }
    for (let i = -2; i <= 2; i += 1) {
      group.add(terminalBoxMesh(THREE, "food-awning-stripe", [0.42, 0.26, 5.7], [-side * (2.0 + i * 0.43), 4.25, 0], i % 2 ? materials.awningLight : accent));
    }
  }
  return group;
}

function terminalGateArea(THREE, doc, node, materials) {
  const ext = node.webofworlds_extension || {};
  const boarding = ext.boarding && typeof ext.boarding === "object" ? ext.boarding : null;
  const [x, , z] = terminalNodePosition(node);
  const group = new THREE.Group();
  group.name = `airport-gate:${ext.gate || node.label}`;
  group.userData.airportGate = {
    gate: ext.gate,
    flight: ext.flight,
    label: node.label,
    boardingSchema: boarding?.schema || null,
  };
  group.position.set(x, 0, z);

  group.add(terminalBoxMesh(THREE, "gate-window-wall", [22, 6.2, 0.28], [0, 3.05, 5.5], materials.glass));
  group.add(terminalBoxMesh(THREE, "gate-jetbridge-door", [3.0, 3.6, 0.4], [0, 1.8, 5.22], materials.door));
  group.add(terminalBoxMesh(THREE, "gate-desk", [4.6, 1.15, 1.45], [4.2, 0.6, 1.6], materials.gateDesk));

  const sign = terminalSignMesh(
    THREE,
    doc,
    `${ext.gate || "A12"}  •  ${ext.flight || "FLIGHT 482"}  •  LOCAL DEMO BOARDING`,
    "#102b4e",
    "#f6d365",
    10.5,
    1.55
  );
  sign.position.set(0, 4.65, 2.2);
  sign.rotation.y = Math.PI;
  group.add(sign);

  for (const side of [-1, 1]) {
    for (const dz of [-2.5, -0.8, 0.9]) {
      for (let i = 0; i < 4; i += 1) {
        const seat = terminalBoxMesh(THREE, "gate-seat", [0.72, 0.18, 0.72], [side * (3.0 + i * 0.85), 0.52, dz], materials.seat);
        const back = terminalBoxMesh(THREE, "gate-seat-back", [0.72, 0.72, 0.16], [side * (3.0 + i * 0.85), 0.88, dz + 0.28], materials.seat);
        group.add(seat, back);
      }
    }
  }

  const marker = new THREE.Mesh(new THREE.TorusGeometry(1.8, 0.13, 12, 48), materials.destination);
  marker.name = "gate-arrival-marker";
  marker.rotation.x = Math.PI / 2;
  marker.position.set(0, 0.08, 1.2);
  group.add(marker);

  if (boarding) {
    const components = boarding.components && typeof boarding.components === "object" ? boarding.components : {};
    const threshold = boarding.threshold && typeof boarding.threshold === "object" ? boarding.threshold : {};
    const thresholdCenter = Array.isArray(threshold.center_m) ? threshold.center_m : [x, 0, z + 4.5];
    const laneEntryZ = Number(components.entry_z_m);
    const thresholdZ = Number(thresholdCenter[2]);
    const halfWidth = Number(components.half_width_m) || Number(threshold.half_width_m) || 1.45;
    if (Number.isFinite(laneEntryZ) && Number.isFinite(thresholdZ) && thresholdZ > laneEntryZ && halfWidth > 0) {
      const laneLength = thresholdZ - laneEntryZ;
      const laneCenterZ = (laneEntryZ + thresholdZ) / 2 - z;
      const laneFloor = terminalBoxMesh(
        THREE,
        "gate-a12-boarding-components",
        [halfWidth * 2, 0.045, laneLength],
        [Number(components.center_x_m) - x || 0, 0.13, laneCenterZ],
        materials.boardingLane,
      );
      laneFloor.userData.airportBoardingLane = {
        schema: boarding.schema,
        flight_id: boarding.flight_id,
        gate_id: boarding.gate_id,
      };
      group.add(laneFloor);
      const thresholdLine = terminalBoxMesh(
        THREE,
        "gate-a12-boarding-threshold",
        [halfWidth * 2, 0.065, 0.18],
        [Number(thresholdCenter[0]) - x || 0, 0.17, thresholdZ - z],
        materials.boardingThreshold,
      );
      thresholdLine.userData.airportBoardingThreshold = {
        crossing_direction: threshold.crossing_direction || null,
        local_demo_only: true,
      };
      group.add(thresholdLine);
    }
  }
  return group;
}

/**
 * Add airport-specific authored content under buildWowScene's existing root.
 * The fixture remains authoritative: storefronts, NPCs, and the gate are graph
 * nodes; this pass only gives the terminal/store/gate semantic nodes their
 * recognizable native Three.js presentation.
 */
export function mountAirportTerminalContent(graph, built, THREE, opts = {}) {
  const nodes = terminalNodeList(graph);
  const terminalRoot = nodes.find((node) => node && node.webofworlds_extension && node.webofworlds_extension.airport_terminal);
  if (!terminalRoot || !built || !built.root) return null;

  const definition = terminalRoot.webofworlds_extension.airport_terminal;
  const walkableSurface = createAirportWalkableSurfaceContract(graph);
  if (!walkableSurface.ok) {
    throw new Error(`airport terminal walkable-surface contract invalid: ${walkableSurface.reason}`);
  }
  const stores = nodes.filter((node) => node && node.webofworlds_extension && node.webofworlds_extension.role === "storefront");
  const travelers = nodes.filter((node) => node && node.webofworlds_extension && node.webofworlds_extension.role === "npc-traveler");
  const staff = nodes.filter((node) => node && node.webofworlds_extension && node.webofworlds_extension.role === "store-staff");
  const gateNode = nodes.find((node) => node && node.webofworlds_extension && node.webofworlds_extension.role === "flight-gate");
  if (stores.length !== 4 || travelers.length !== 5 || staff.length !== 4 || !gateNode) {
    throw new Error("airport terminal fixture requires 4 storefronts, 5 NPC travelers, 4 store staff, and one flight gate");
  }

  const group = new THREE.Group();
  group.name = "airport-terminal-content";
  group.userData.airportTerminal = true;
  built.root.add(group);

  const materials = {
    wall: new THREE.MeshStandardMaterial({ color: 0xd9e2ea, roughness: 0.76 }),
    floor: new THREE.MeshStandardMaterial({ color: 0xb8c5d0, roughness: 0.64, metalness: 0.08 }),
    runner: new THREE.MeshStandardMaterial({ color: 0x284963, roughness: 0.84 }),
    storeFloor: new THREE.MeshStandardMaterial({ color: 0x38404b, roughness: 0.75 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x7cc7e8, transparent: true, opacity: 0.38, roughness: 0.1, metalness: 0.15 }),
    beam: new THREE.MeshStandardMaterial({ color: 0x6d7d89, roughness: 0.35, metalness: 0.55 }),
    menu: new THREE.MeshStandardMaterial({ color: 0x172129, roughness: 0.5 }),
    coffeeCup: new THREE.MeshStandardMaterial({ color: 0xf5f0e6, roughness: 0.45 }),
    newsRack: new THREE.MeshStandardMaterial({ color: 0xf3c94d, roughness: 0.55 }),
    dutyDisplay: new THREE.MeshStandardMaterial({ color: 0x111820, roughness: 0.25, metalness: 0.55 }),
    bottle: new THREE.MeshStandardMaterial({ color: 0xd8a5ff, transparent: true, opacity: 0.78, roughness: 0.15 }),
    stool: new THREE.MeshStandardMaterial({ color: 0x5e2f24, roughness: 0.7 }),
    awningLight: new THREE.MeshStandardMaterial({ color: 0xfff1d4, roughness: 0.8 }),
    door: new THREE.MeshStandardMaterial({ color: 0x2f475b, roughness: 0.45, metalness: 0.3 }),
    gateDesk: new THREE.MeshStandardMaterial({ color: 0x286f9d, roughness: 0.42 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x567180, roughness: 0.58, metalness: 0.2 }),
    destination: new THREE.MeshStandardMaterial({ color: 0x42e5ff, emissive: 0x42e5ff, emissiveIntensity: 1.4 }),
    boardingLane: new THREE.MeshStandardMaterial({ color: 0x194c74, emissive: 0x194c74, emissiveIntensity: 0.32, roughness: 0.72 }),
    boardingThreshold: new THREE.MeshStandardMaterial({ color: 0xf6d365, emissive: 0xf6d365, emissiveIntensity: 0.9, roughness: 0.5 }),
  };

  const width = Number(definition.width_m) || 24;
  const length = Number(definition.length_m) || 86;
  const height = Number(definition.height_m) || 6.4;
  const centerZ = length / 2 - 4;
  for (const surface of walkableSurface.surfaces) {
    const material = materials[surface.render_material];
    if (!material) throw new Error(`airport walkable surface ${surface.surface_id} has unknown render material`);
    const mesh = terminalBoxMesh(THREE, surface.surface_id, surface.size_m, surface.center_m, material);
    mesh.userData.walkableSurface = {
      surface_id: surface.surface_id,
      classification: surface.classification,
      top_y_m: surface.top_y_m,
      resolver_source: walkableSurface.source,
    };
    group.add(mesh);
  }

  for (let z = 2; z <= length - 4; z += 8) {
    for (const side of [-1, 1]) {
      group.add(terminalBoxMesh(THREE, "airport-structure-column", [0.42, height, 0.42], [side * (width / 2 - 0.75), height / 2, z], materials.beam));
      group.add(terminalBoxMesh(THREE, "airport-window-bay", [0.14, height - 1.1, 7.2], [side * (width / 2 - 0.25), height / 2, z], materials.glass));
    }
    group.add(terminalBoxMesh(THREE, "airport-overhead-beam", [width - 1.5, 0.28, 0.36], [0, height - 0.15, z], materials.beam));
  }
  for (const x of [-7.4, 7.4]) {
    group.add(terminalBoxMesh(THREE, "airport-ceiling-light", [4.2, 0.12, length - 4], [x, height, centerZ], materials.awningLight));
  }

  const entrySign = terminalSignMesh(THREE, opts.document, definition.title || "SKYPORT • CONCOURSE A", "#123a5c", "#ffffff", 12, 1.6);
  entrySign.position.set(0, 4.8, 3.2);
  entrySign.rotation.y = Math.PI;
  group.add(entrySign);
  const wayfinding = terminalSignMesh(THREE, opts.document, "GATES A10–A18  →", "#f4cf45", "#10243b", 8.5, 1.25);
  wayfinding.position.set(0, 4.15, terminalNodePosition(gateNode)[2] - 4.5);
  wayfinding.rotation.y = Math.PI;
  group.add(wayfinding);

  for (const store of stores) group.add(terminalStorefront(THREE, opts.document, store, materials));
  group.add(terminalGateArea(THREE, opts.document, gateNode, materials));

  // The graph builder's blue wire cubes are a generic async-loading fallback.
  // Airport people have explicit cards and an honest no-avatar failure state, so
  // suppress their proxies from first paint; successful assets still retire and
  // dispose these hidden placeholders through mountWowSceneAssets.
  const airportActorIds = new Set([...travelers, ...staff].map((node) => String(node.id)));
  for (const asset of built.asset_nodes || []) {
    if (!airportActorIds.has(String(asset.id)) || !asset.placeholder) continue;
    asset.placeholder.visible = false;
    asset.placeholder.userData.airportProxySuppressed = true;
  }

  const entityRuntime = createAirportEntityRuntime(graph, built, THREE, {
    document: opts.document,
    motionPreference: opts.motionPreference,
  });

  const entryPosition = definition.entry_spawn?.position_m || [0, 0, 0];
  const entryGround = resolveAirportGroundSurface(walkableSurface, entryPosition[0], entryPosition[2]);
  if (!entryGround.ok) throw new Error(`airport entry spawn has no classified walkable surface: ${entryGround.reason}`);
  const summary = {
    mounted: true,
    title: definition.title || null,
    walk_path: definition.walk_path || "entry → commons → flight gate",
    concourse: { width_m: width, length_m: length, height_m: height },
    storefront_count: stores.length,
    storefront_categories: stores.map((node) => node.webofworlds_extension.category),
    storefront_labels: stores.map((node) => node.label),
    storefronts: stores.map((node) => {
      const extension = node.webofworlds_extension || {};
      const shopping = extension.shopping && typeof extension.shopping === "object"
        ? extension.shopping
        : null;
      return {
        node_id: String(node.id),
        label: node.label,
        category: extension.category || null,
        sign: extension.sign || node.label,
        position_m: terminalNodePosition(node),
        catalog_schema: shopping?.schema || null,
        interaction_radius_m: shopping?.interaction_radius_m ?? null,
        availability: shopping?.availability || null,
        availability_reason: shopping?.availability_reason || null,
        pickup_label: shopping?.pickup_label || null,
        claim_boundary: shopping?.claim_boundary || null,
        catalog: Array.isArray(shopping?.catalog)
          ? shopping.catalog.map((item) => ({ ...item }))
          : shopping?.catalog ?? null,
      };
    }),
    npc_count: travelers.length,
    npc_labels: travelers.map((node) => node.label),
    staff_count: staff.length,
    staff_labels: staff.map((node) => node.label),
    entity_manifests: entityRuntime ? built.render_summary.airport_entities : null,
    gate: {
      label: gateNode.label,
      gate: gateNode.webofworlds_extension.gate,
      flight: gateNode.webofworlds_extension.flight,
      position: terminalNodePosition(gateNode),
      boarding: gateNode.webofworlds_extension.boarding
        ? JSON.parse(JSON.stringify(gateNode.webofworlds_extension.boarding))
        : null,
    },
    walkable_surface: {
      schema: walkableSurface.schema,
      source: walkableSurface.source,
      resolver: walkableSurface.resolver,
      fallback: walkableSurface.fallback,
      surfaces: walkableSurface.surfaces.map((surface) => ({
        surface_id: surface.surface_id,
        classification: surface.classification,
        shape: surface.shape,
        center_m: surface.center_m.slice(),
        size_m: surface.size_m.slice(),
        top_y_m: surface.top_y_m,
      })),
      entry_ground: { ...entryGround },
    },
    reused: [
      "buildWowScene scene/camera/root",
      "mountWowSceneAssets + loadGltfSceneAsset for NPC avatar nodes",
      "AvatarEquipmentLayer for the local player",
      "adapter.stepAvatar + existing WASD/orbit/first-person controls",
    ],
    phase_boundary: "compact physical airport, staffed storefront browsing/pickup-list metadata, graph-authored Gate A12 journey, stationary non-lockstep idles, and authored entity-manifest cards; no airline connectivity, real ticket or identity verification, security clearance, legal travel authorization, destination flight world, pathfinding, exchange, transaction overlay, or general HUD",
  };
  built.render_summary.airport_terminal = summary;

  // mount the additive Glassline AR HUD overlay: a glass
  // Entity Tag above each of the 9 fixture entities (4 storefronts + 5
  // travelers) with click→Detail Card. Self-contained CSS2D-style DOM layer over
  // the WebGL canvas, driven by built.camera. No avatar/movement/portal/render
  // code is touched. initAirportHudOverlay is fully guarded: it no-ops in
  // headless/Node (no opts.document) and never throws into the scene mount.
  // Portal previews opt out because this page-level layer belongs only to the
  // selected Airport scene, never to Airport content rendered through Lobby.
  if (opts.hudOverlay !== false) {
    built.airport_hud_overlay = initAirportHudOverlay({
      THREE,
      camera: built.camera,
      scene: built.scene,
      document: opts.document,
      stores,
      travelers,
    });
  }

  return summary;
}

export default { mountAirportTerminalContent };
