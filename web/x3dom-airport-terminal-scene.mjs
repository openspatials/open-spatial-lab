// Ported by hand from Nicholas Polys's public fork npolys/open-spatial-lab, commit 99175b4b6,
// web/x3dom-airport-terminal-scene.mjs. Apache-2.0, like the rest of the lab. Nicholas Polys is co-author of lab commit ef702ec.
// Changes in this copy: a partial terminal for a preview, and the sign is exported; X_ITE uses this file too.

import { createAirportWalkableSurfaceContract, resolveAirportGroundSurface, } from "./airport-walkable-surface.mjs";

// X3DOM-native sibling of airport-terminal-scene.mjs's mountAirportTerminalContent — Stage 1 of
// the X3DOM airport-parity work: the terminal's STRUCTURAL geometry and signage (walls, columns,
// window bays, ceiling lights, storefronts, gate area, entry/wayfinding signs). Deliberately does
// NOT port createAirportEntityRuntime (NPC/staff avatars + signed manifest-card billboards) —
// staged as a separate follow-on, per this project's own established "one phase at a time, check
// in before continuing" delivery convention. terminalNodeList/terminalNodePosition below are
// copied verbatim from the original — pure JS reading plain graph-node data, no THREE dependency
// at all, so there's nothing to port for them.
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
function terminalBoxMesh(adapter, name, size, position, material) {
    const geometry = adapter.createGeometry({ type: "box", width: size[0], height: size[1], depth: size[2] });
    const mesh = adapter.createMesh(geometry, material);
    adapter.setName(mesh, name);
    adapter.setPosition(mesh, position[0], position[1], position[2]);
    return mesh;
}
// Canvas-drawn signage, same drawing code as the THREE version — adapter.createCanvasTexture()
// already existed pre-session (used by the portal-preview capture path) and needs no changes to
// serve this too. Uses a white diffuse base + the texture as `map`: this vendored X3DOM build's
// emissiveColor does NOT get texture-modulated (confirmed empirically during the earlier portal-
// aperture black-rendering investigation — see x3dom-portal-traversal-glue.mjs's header comment),
// only diffuseColor does, so the sign has to ride the same lit-diffuse path the aperture plane's
// own material already relies on rather than an "unlit" emissive trick.
export function terminalSignMesh(adapter, documentTarget, label, background, foreground, width, height) {
    let material;
    if (documentTarget && typeof documentTarget.createElement === "function") {
        const canvas = documentTarget.createElement("canvas");
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
            const textureHandle = adapter.createCanvasTexture(canvas);
            material = adapter.createMaterial({ type: "standard", color: 0xffffff, side: "double", map: textureHandle });
        }
    }
    if (!material) {
        material = adapter.createMaterial({ type: "standard", color: background, side: "double" });
    }
    const geometry = adapter.createGeometry({ type: "plane", width, height });
    const sign = adapter.createMesh(geometry, material);
    adapter.setName(sign, `airport-sign:${label}`);
    adapter.setUserData(sign, "airportLabel", label);
    return sign;
}
function terminalStorefront(adapter, documentTarget, node, materials) {
    const ext = node.webofworlds_extension || {};
    const [x, , z] = terminalNodePosition(node);
    const side = x < 0 ? -1 : 1;
    const accent = adapter.createMaterial({
        type: "standard",
        color: Number(ext.accent) || 0x2aa7a1,
        emissive: Number(ext.accent) || 0x2aa7a1,
        emissiveIntensity: 0.08,
    });
    const group = adapter.createGroup(`airport-store:${ext.category}:${node.label}`);
    adapter.setUserData(group, "airportStore", { category: ext.category, label: node.label });
    adapter.setPosition(group, x, 0, z);
    adapter.add(group, terminalBoxMesh(adapter, "store-floor", [6.2, 0.12, 5.8], [0, 0.06, 0], materials.storeFloor));
    adapter.add(group, terminalBoxMesh(adapter, "store-back-wall", [0.22, 4.8, 5.8], [side * 3, 2.4, 0], materials.wall));
    adapter.add(group, terminalBoxMesh(adapter, "store-canopy", [6.2, 0.32, 5.8], [0, 4.65, 0], accent));
    adapter.add(group, terminalBoxMesh(adapter, "store-counter", [2.2, 1.05, 4.6], [-side * 1.85, 0.55, 0.2], accent));
    const sign = terminalSignMesh(adapter, documentTarget, ext.sign || node.label, ext.sign_background || "#133249", "#ffffff", 5.2, 1.15);
    adapter.setPosition(sign, -side * 1.75, 3.55, -2.48);
    adapter.setRotationAxis(sign, "y", Math.PI);
    adapter.add(group, sign);
    if (ext.category === "coffee") {
        for (const dz of [-1.35, 0, 1.35]) {
            const geometry = adapter.createGeometry({ type: "cylinder", radiusTop: 0.2, height: 0.42 });
            const cup = adapter.createMesh(geometry, materials.coffeeCup);
            adapter.setName(cup, "coffee-cup-display");
            adapter.setPosition(cup, -side * 2.0, 1.28, dz);
            adapter.add(group, cup);
        }
        adapter.add(group, terminalBoxMesh(adapter, "coffee-menu", [0.12, 1.65, 2.4], [side * 2.82, 2.5, 0], materials.menu));
    }
    else if (ext.category === "news") {
        for (const dz of [-1.7, 0, 1.7]) {
            adapter.add(group, terminalBoxMesh(adapter, "news-magazine-rack", [1.35, 1.8, 0.45], [side * 1.65, 0.95, dz], materials.newsRack));
        }
    }
    else if (ext.category === "duty-free") {
        for (const dz of [-1.6, 0, 1.6]) {
            adapter.add(group, terminalBoxMesh(adapter, "duty-free-display", [1.2, 0.85, 1.05], [side * 1.45, 0.48, dz], materials.dutyDisplay));
            const geometry = adapter.createGeometry({ type: "cylinder", radiusTop: 0.14, height: 0.55 });
            const bottle = adapter.createMesh(geometry, materials.bottle);
            adapter.setName(bottle, "duty-free-bottle");
            adapter.setPosition(bottle, side * 1.45, 1.2, dz);
            adapter.add(group, bottle);
        }
    }
    else if (ext.category === "food") {
        for (let i = -2; i <= 2; i += 1) {
            const geometry = adapter.createGeometry({ type: "cylinder", radiusTop: 0.27, height: 0.58 });
            const stool = adapter.createMesh(geometry, materials.stool);
            adapter.setName(stool, "food-counter-stool");
            adapter.setPosition(stool, -side * 3.0, 0.3, i * 0.9);
            adapter.add(group, stool);
        }
        for (let i = -2; i <= 2; i += 1) {
            adapter.add(group, terminalBoxMesh(adapter, "food-awning-stripe", [0.42, 0.26, 5.7], [-side * (2.0 + i * 0.43), 4.25, 0], i % 2 ? materials.awningLight : accent));
        }
    }
    return group;
}
function terminalGateArea(adapter, documentTarget, node, materials) {
    const ext = node.webofworlds_extension || {};
    const boarding = ext.boarding && typeof ext.boarding === "object" ? ext.boarding : null;
    const [x, , z] = terminalNodePosition(node);
    const group = adapter.createGroup(`airport-gate:${ext.gate || node.label}`);
    adapter.setUserData(group, "airportGate", {
        gate: ext.gate,
        flight: ext.flight,
        label: node.label,
        boardingSchema: boarding?.schema || null,
    });
    adapter.setPosition(group, x, 0, z);
    adapter.add(group, terminalBoxMesh(adapter, "gate-window-wall", [22, 6.2, 0.28], [0, 3.05, 5.5], materials.glass));
    adapter.add(group, terminalBoxMesh(adapter, "gate-jetbridge-door", [3.0, 3.6, 0.4], [0, 1.8, 5.22], materials.door));
    adapter.add(group, terminalBoxMesh(adapter, "gate-desk", [4.6, 1.15, 1.45], [4.2, 0.6, 1.6], materials.gateDesk));
    const sign = terminalSignMesh(adapter, documentTarget, `${ext.gate || "A12"}  •  ${ext.flight || "FLIGHT 482"}  •  LOCAL DEMO BOARDING`, "#102b4e", "#f6d365", 10.5, 1.55);
    adapter.setPosition(sign, 0, 4.65, 2.2);
    adapter.setRotationAxis(sign, "y", Math.PI);
    adapter.add(group, sign);
    for (const side of [-1, 1]) {
        for (const dz of [-2.5, -0.8, 0.9]) {
            for (let i = 0; i < 4; i += 1) {
                const seat = terminalBoxMesh(adapter, "gate-seat", [0.72, 0.18, 0.72], [side * (3.0 + i * 0.85), 0.52, dz], materials.seat);
                const back = terminalBoxMesh(adapter, "gate-seat-back", [0.72, 0.72, 0.16], [side * (3.0 + i * 0.85), 0.88, dz + 0.28], materials.seat);
                adapter.add(group, seat);
                adapter.add(group, back);
            }
        }
    }
    const markerGeometry = adapter.createGeometry({ type: "torus", innerRadius: 0.13, outerRadius: 1.8 });
    const marker = adapter.createMesh(markerGeometry, materials.destination);
    adapter.setName(marker, "gate-arrival-marker");
    adapter.setRotationAxis(marker, "x", Math.PI / 2);
    adapter.setPosition(marker, 0, 0.08, 1.2);
    adapter.add(group, marker);
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
            const laneFloor = terminalBoxMesh(adapter, "gate-a12-boarding-components", [halfWidth * 2, 0.045, laneLength], [Number(components.center_x_m) - x || 0, 0.13, laneCenterZ], materials.boardingLane);
            adapter.setUserData(laneFloor, "airportBoardingLane", {
                schema: boarding.schema,
                flight_id: boarding.flight_id,
                gate_id: boarding.gate_id,
            });
            adapter.add(group, laneFloor);
            const thresholdLine = terminalBoxMesh(adapter, "gate-a12-boarding-threshold", [halfWidth * 2, 0.065, 0.18], [Number(thresholdCenter[0]) - x || 0, 0.17, thresholdZ - z], materials.boardingThreshold);
            adapter.setUserData(thresholdLine, "airportBoardingThreshold", {
                crossing_direction: threshold.crossing_direction || null,
                local_demo_only: true,
            });
            adapter.add(group, thresholdLine);
        }
    }
    return group;
}
export function mountAirportTerminalContentX3dom(graph, adapter, opts = {}) {
    // `parent` — same shape as mountCanonicalWorldContent(adapter, parent, world): callers control
    // exactly which group this mounts into (worldContentGroup for the active-world case, so it's
    // cleared/rebuilt on every crossing the same way canonical content already is; a destination
    // adapter's own sceneRoot for the portal-preview case, alongside buildWowScene's generic
    // floor/grid/lights, which stay as-is — three.js's own live airport path doesn't hide those
    // either, only GridHelper/gizmo debug markers via hideStageDebugVisuals, so this isn't a
    // parity regression). Deliberately NOT defaulting to adapter.sceneRoot: buildWowScene owns
    // that directly for the portal-preview case (its own background/floor/lights setup), and the
    // active-world case has its own worldContentGroup scoping mountCanonicalWorldContent already
    // relies on — this function should never assume it owns the whole scene.
    const parent = opts.parent || adapter?.sceneRoot;
    const nodes = terminalNodeList(graph);
    const terminalRoot = nodes.find((node) => node && node.webofworlds_extension && node.webofworlds_extension.airport_terminal);
    if (!terminalRoot || !adapter || !parent)
        return null;
    const definition = terminalRoot.webofworlds_extension.airport_terminal;
    const walkableSurface = createAirportWalkableSurfaceContract(graph);
    if (!walkableSurface.ok) {
        throw new Error(`airport terminal walkable-surface contract invalid: ${walkableSurface.reason}`);
    }
    const stores = nodes.filter((node) => node && node.webofworlds_extension && node.webofworlds_extension.role === "storefront");
    const travelers = nodes.filter((node) => node && node.webofworlds_extension && node.webofworlds_extension.role === "npc-traveler");
    const staff = nodes.filter((node) => node && node.webofworlds_extension && node.webofworlds_extension.role === "store-staff");
    const gateNode = nodes.find((node) => node && node.webofworlds_extension && node.webofworlds_extension.role === "flight-gate");
    // Lab change: a preview holds only the part of the terminal its world lets a portal show.
    if (!opts.partial && (stores.length !== 4 || travelers.length !== 5 || staff.length !== 4 || !gateNode)) {
        throw new Error("airport terminal fixture requires 4 storefronts, 5 NPC travelers, 4 store staff, and one flight gate");
    }
    const group = adapter.createGroup("airport-terminal-content");
    adapter.setUserData(group, "airportTerminal", true);
    adapter.add(parent, group);
    const materials = {
        wall: adapter.createMaterial({ type: "standard", color: 0xd9e2ea }),
        floor: adapter.createMaterial({ type: "standard", color: 0xb8c5d0 }),
        runner: adapter.createMaterial({ type: "standard", color: 0x284963 }),
        storeFloor: adapter.createMaterial({ type: "standard", color: 0x38404b }),
        glass: adapter.createMaterial({ type: "standard", color: 0x7cc7e8, transparent: true, opacity: 0.38, side: "double" }),
        beam: adapter.createMaterial({ type: "standard", color: 0x6d7d89 }),
        menu: adapter.createMaterial({ type: "standard", color: 0x172129 }),
        coffeeCup: adapter.createMaterial({ type: "standard", color: 0xf5f0e6 }),
        newsRack: adapter.createMaterial({ type: "standard", color: 0xf3c94d }),
        dutyDisplay: adapter.createMaterial({ type: "standard", color: 0x111820 }),
        bottle: adapter.createMaterial({ type: "standard", color: 0xd8a5ff, transparent: true, opacity: 0.78 }),
        stool: adapter.createMaterial({ type: "standard", color: 0x5e2f24 }),
        awningLight: adapter.createMaterial({ type: "standard", color: 0xfff1d4 }),
        door: adapter.createMaterial({ type: "standard", color: 0x2f475b }),
        gateDesk: adapter.createMaterial({ type: "standard", color: 0x286f9d }),
        seat: adapter.createMaterial({ type: "standard", color: 0x567180 }),
        destination: adapter.createMaterial({ type: "standard", color: 0x42e5ff, emissive: 0x42e5ff, emissiveIntensity: 1.4 }),
        boardingLane: adapter.createMaterial({ type: "standard", color: 0x194c74, emissive: 0x194c74, emissiveIntensity: 0.32 }),
        boardingThreshold: adapter.createMaterial({ type: "standard", color: 0xf6d365, emissive: 0xf6d365, emissiveIntensity: 0.9 }),
    };
    const width = Number(definition.width_m) || 24;
    const length = Number(definition.length_m) || 86;
    const height = Number(definition.height_m) || 6.4;
    const centerZ = length / 2 - 4;
    for (const surface of walkableSurface.surfaces) {
        const material = materials[surface.render_material];
        if (!material)
            throw new Error(`airport walkable surface ${surface.surface_id} has unknown render material`);
        const mesh = terminalBoxMesh(adapter, surface.surface_id, surface.size_m, surface.center_m, material);
        adapter.setUserData(mesh, "walkableSurface", {
            surface_id: surface.surface_id,
            classification: surface.classification,
            top_y_m: surface.top_y_m,
            resolver_source: walkableSurface.source,
        });
        adapter.add(group, mesh);
    }
    for (let z = 2; z <= length - 4; z += 8) {
        for (const side of [-1, 1]) {
            adapter.add(group, terminalBoxMesh(adapter, "airport-structure-column", [0.42, height, 0.42], [side * (width / 2 - 0.75), height / 2, z], materials.beam));
            adapter.add(group, terminalBoxMesh(adapter, "airport-window-bay", [0.14, height - 1.1, 7.2], [side * (width / 2 - 0.25), height / 2, z], materials.glass));
        }
        adapter.add(group, terminalBoxMesh(adapter, "airport-overhead-beam", [width - 1.5, 0.28, 0.36], [0, height - 0.15, z], materials.beam));
    }
    for (const x of [-7.4, 7.4]) {
        adapter.add(group, terminalBoxMesh(adapter, "airport-ceiling-light", [4.2, 0.12, length - 4], [x, height, centerZ], materials.awningLight));
    }
    const entrySign = terminalSignMesh(adapter, opts.document, definition.title || "SKYPORT • CONCOURSE A", "#123a5c", "#ffffff", 12, 1.6);
    adapter.setPosition(entrySign, 0, 4.8, 3.2);
    adapter.setRotationAxis(entrySign, "y", Math.PI);
    adapter.add(group, entrySign);
    if (gateNode) {
        const wayfinding = terminalSignMesh(adapter, opts.document, "GATES A10–A18  →", "#f4cf45", "#10243b", 8.5, 1.25);
        adapter.setPosition(wayfinding, 0, 4.15, terminalNodePosition(gateNode)[2] - 4.5);
        adapter.setRotationAxis(wayfinding, "y", Math.PI);
        adapter.add(group, wayfinding);
    }
    for (const store of stores)
        adapter.add(group, terminalStorefront(adapter, opts.document, store, materials));
    if (gateNode)
        adapter.add(group, terminalGateArea(adapter, opts.document, gateNode, materials));
    const entryPosition = definition.entry_spawn?.position_m || [0, 0, 0];
    const entryGround = resolveAirportGroundSurface(walkableSurface, entryPosition[0], entryPosition[2]);
    if (!entryGround.ok)
        throw new Error(`airport entry spawn has no classified walkable surface: ${entryGround.reason}`);
    const summary = {
        mounted: true,
        title: definition.title || null,
        walk_path: definition.walk_path || "entry → commons → flight gate",
        concourse: { width_m: width, length_m: length, height_m: height },
        storefront_count: stores.length,
        storefront_categories: stores.map((node) => node.webofworlds_extension.category),
        storefront_labels: stores.map((node) => node.label),
        npc_count: travelers.length,
        npc_labels: travelers.map((node) => node.label),
        staff_count: staff.length,
        staff_labels: staff.map((node) => node.label),
        gate: gateNode ? {
            label: gateNode.label,
            gate: gateNode.webofworlds_extension.gate,
            flight: gateNode.webofworlds_extension.flight,
            position: terminalNodePosition(gateNode),
        } : null,
        walkable_surface: {
            schema: walkableSurface.schema,
            source: walkableSurface.source,
            resolver: walkableSurface.resolver,
            fallback: walkableSurface.fallback,
            entry_ground: { ...entryGround },
        },
        stage: "1-structural-geometry-only",
        deferred: ["npc-and-staff-avatars (Stage 2)", "signed-manifest-card-billboards (Stage 3)", "airport-specific HUD storefront/traveler tags (Stage 3)"],
    };
    return summary;
}
export default { mountAirportTerminalContentX3dom };
