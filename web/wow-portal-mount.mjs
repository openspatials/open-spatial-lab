/*
 * Portals in the `?wow=` player (iteration 4, and the placement tool). Browser only: three.js and a canvas
 * for labels.
 *
 * Each portal of the shown world is drawn at the node that places it: a ring, and inside it what the
 * destination allows to be seen (web/wow-portal.mjs, previewOf):
 *   - the nodes of its preview, as a small model of the destination within the ring, with any portal
 *     among them shown closed (a grey disc);
 *   - its preview image;
 *   - a plain colour, when it declares no preview.
 * A portal without a destination is grey and says so. Crossing (cross(id)) is plain navigation to the
 * destination; a refused crossing leaves the visitor here and shows the reason on the ring.
 *
 * A portal with an active radius (`active_radius_m`) sleeps until the visitor comes within that distance on
 * the floor: then it wakes and loads its preview. A sleeping portal is dim, shows its radius on the floor and
 * does not cross. A portal without one is always awake.
 *
 * mountPlacementTool() is the placement mode: click the floor to place a portal, drag a portal to move it,
 * set its active radius and destination; each change is saved to the world through its Web of Worlds API.
 *
 * applyJoinArrival() is the other half: a page opened at `...#join=node.{n}` puts its camera at node n's
 * pose, looking along the node's +Z axis.
 */

import { readPortals, previewOf, crossPortal, arrivalAt, entryBase, readFlatNode, placePortal, moveNode, changePortal, PREVIEW_COLOR } from "./wow-portal.mjs";
import { WOW_MEDIA_TYPE } from "./wow-inclusion.mjs";
import { worldBaseOf } from "./wow-observe.mjs";

const RING_RADIUS = 1.0;
const RING_CENTER_Y = 1.25;
const EYE_HEIGHT = 1.6;
const ARRIVAL_STAND_OFF_M = 2.0;
const WAKE_INTERVAL_MS = 150;
const COLOR_RING = 0x58d6ff;
const COLOR_GREY = 0x7a808c;
const COLOR_ASLEEP = 0x3b5a78;
const COLOR_SELECTED = 0xffc94a;
const LABEL_OPEN = { background: "rgba(8, 18, 32, 0.88)", stroke: "#58d6ff", color: "#d8f3ff" };
const LABEL_GREY = { background: "rgba(24, 24, 28, 0.88)", stroke: "#9aa0aa", color: "#e4e6ea" };
const LABEL_ASLEEP = { background: "rgba(10, 16, 26, 0.85)", stroke: "#3b5a78", color: "#9fb6cc" };
const LABEL_REFUSED = { background: "rgba(28, 12, 6, 0.9)", stroke: "#ff6b3a", color: "#ffd9c8" };

/**
 * Draw the portals of the world shown from `hostUrl` (a Spatial URL) under their nodes in `built`
 * (buildWowScene's result). Returns { portals, cross(id), summary(), pickables(), screenPoint(id),
 * refresh(), ... }; each portal entry is a summary for tests, and pickables() names the objects a click can
 * land on. `opts.visitor()` says where the visitor stands (the camera's position when absent).
 */
export async function mountPortals(opts) {
  const { built, hostUrl, THREE, document, buildWowScene } = opts;
  const io = { fetch: opts.fetch };
  const base = worldBaseOf(hostUrl);
  const hostGraph = /wow\/spatial\/(\d+)/.exec(hostUrl)?.[1] || "1";
  let entries = [];
  let generation = 0;
  let placing = false;
  let selected = null;

  /** The scene group of node `nodeId`: the one built with the scene, or one made now for a node placed since. */
  async function groupOf(nodeId) {
    const known = built.node_groups && built.node_groups.get(nodeId);
    if (known) return known;
    const node = await readFlatNode(base, hostGraph, nodeId, io);
    if (!node || !Number.isInteger(node.parent)) return null;
    const parent = await groupOf(node.parent);
    if (!parent) return null;
    const group = new THREE.Group();
    group.name = `wow:${node.label != null ? node.label : node.id}`;
    group.matrixAutoUpdate = false;
    group.matrix.fromArray(Array.isArray(node.localTransform) && node.localTransform.length === 16 ? node.localTransform.map(Number) : new THREE.Matrix4().toArray());
    parent.add(group);
    if (built.node_groups) built.node_groups.set(nodeId, group);
    return group;
  }

  async function load() {
    const run = ++generation;
    const found = await readPortals(base, io);
    if (run !== generation) return;
    const drawn = [];
    for (const p of found) {
      if (p.nodeId === null || !p.nodeUrl.includes(`/wow/spatial/${hostGraph}/node/`)) continue;
      const group = await groupOf(p.nodeId);
      if (run !== generation) return;
      if (!group) continue;
      drawn.push(await drawEntry(p, group));
      if (run !== generation) return;
    }
    for (const old of entries) undraw(old);
    entries = drawn;
    for (const entry of entries) {
      entry.object.visible = true;
      if (entry.circle) entry.circle.visible = true;
    }
    updateWake();
    paintAll();
    publish();
    if (opts.onPickables) opts.onPickables(pickables());
  }

  async function drawEntry(p, group) {
    const portalObject = new THREE.Group();
    portalObject.name = `wow-portal:${p.id}`;
    portalObject.position.y = RING_CENTER_Y;
    // Drawn but hidden until the whole set is ready, so a refresh swaps old for new in one frame.
    portalObject.visible = false;
    // The front of a portal (its node's +Z) is where its preview is seen from. When it faces away from the
    // middle of the world, turn the drawing round, so a visitor in the world sees the front.
    group.updateWorldMatrix(true, false);
    const at = new THREE.Vector3().setFromMatrixPosition(group.matrixWorld);
    const front = new THREE.Vector3(0, 0, 1).transformDirection(group.matrixWorld);
    if (facesAway([at.x, at.z], [front.x, front.z])) portalObject.rotation.y = Math.PI;
    group.add(portalObject);
    // The ring marks the portal's place, so the node's own position marker is hidden.
    for (const child of group.children) if (/^wow-group-gizmo:/.test(child.name || "")) child.visible = false;
    const radius = Number(p.resource.active_radius_m) > 0 ? Number(p.resource.active_radius_m) : null;
    const entry = {
      id: p.id,
      label: p.resource.label || `Portal ${p.id}`,
      destination: p.resource.destination || null,
      // placed with the placement tool (its resource says so); a portal from the world's configuration is not
      placed: p.resource.placed === true,
      node: p.nodeUrl,
      nodeId: p.nodeId,
      radius,
      awake: radius === null,
      distance: null,
      preview: null,
      previewState: "none", // none | loading | loaded
      refusal: null,
      object: portalObject,
      group,
      resource: p.resource,
      ring: ring(THREE, COLOR_ASLEEP),
      content: new THREE.Group(),
      circle: null,
    };
    portalObject.add(entry.ring);
    // The whole opening is what a visitor clicks, seen from any angle: an invisible disc in the ring's plane.
    portalObject.add(hitDisc(THREE));
    portalObject.add(entry.content);
    if (radius) {
      entry.circle = radiusCircle(THREE, radius);
      entry.circle.visible = false;
      group.add(entry.circle);
      entry.content.add(disc(THREE, 0x0d141f));
      entry.preview = { kind: "asleep" };
    } else {
      await loadPreview(entry);
    }
    paint(entry);
    return entry;
  }

  function undraw(entry) {
    entry.group.remove(entry.object);
    if (entry.circle) entry.group.remove(entry.circle);
  }

  /** Load what the destination allows to be seen, into the ring. */
  async function loadPreview(entry) {
    entry.previewState = "loading";
    const preview = await previewOf(entry.resource, io).catch((error) => ({ kind: "unreachable", color: PREVIEW_COLOR, reason: String(error.message || error) }));
    entry.content.clear();
    entry.preview = { kind: preview.kind };
    entry.open = preview.kind === "nodes" || preview.kind === "image" || preview.kind === "color";
    if (preview.kind === "nodes") {
      // A backdrop behind the model, so the destination reads as lying beyond the ring.
      const backdrop = disc(THREE, 0x0b1222);
      backdrop.position.z = -RING_RADIUS;
      entry.content.add(backdrop);
      const model = previewModel(preview, THREE, buildWowScene);
      entry.content.add(model.root);
      entry.preview.nodes = preview.nodes.length;
      entry.preview.closed = preview.nodes.filter((n) => n.closed).length;
      entry.preview.node_ids = preview.nodes.map((n) => n.id);
      if (opts.onModels) opts.onModels(model.assetNodes);
    } else if (preview.kind === "image") {
      const face = disc(THREE, 0xffffff);
      entry.content.add(face);
      entry.preview.image = preview.image;
      entry.preview.image_loaded = false;
      new THREE.TextureLoader().load(preview.image, (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace || texture.colorSpace;
        face.material.map = texture;
        face.material.needsUpdate = true;
        entry.preview.image_loaded = true;
        publish();
      }, undefined, () => { entry.preview.image_error = true; publish(); });
    } else if (preview.kind === "color") {
      entry.content.add(disc(THREE, new THREE.Color(preview.color).getHex()));
      entry.preview.color = preview.color;
    } else {
      entry.content.add(disc(THREE, 0x2a2d33));
      entry.preview.reason = preview.reason;
    }
    entry.previewState = "loaded";
    entry.second = preview.kind === "none" ? "no destination"
      : preview.kind === "unreachable" ? `offline: ${hostOf(entry.destination)}`
      : `→ ${hostOf(entry.destination)}`;
  }

  /** Ring colour and label, from the portal's state. */
  function paint(entry) {
    const color = entry.id === selected ? COLOR_SELECTED : !entry.awake || entry.previewState !== "loaded" ? COLOR_ASLEEP : entry.open ? COLOR_RING : COLOR_GREY;
    entry.ring.material.color.setHex(color);
    entry.ring.material.emissive.setHex(color);
    if (entry.circle) entry.circle.material.opacity = placing || entry.id === selected ? 0.75 : entry.awake ? 0.35 : 0.2;
    let lines;
    let style;
    if (entry.refusal) {
      lines = ["crossing refused", String(entry.refusal).replace(/https?:\/\//g, "").replace(/\/ did not/, " did not").replace(/^destination offline: /, "offline: ")];
      style = LABEL_REFUSED;
    } else if (!entry.awake) {
      lines = [entry.label, `asleep · wakes within ${formatMeters(entry.radius)}`];
      style = LABEL_ASLEEP;
    } else if (entry.previewState !== "loaded") {
      lines = [entry.label, "waking · loading its preview"];
      style = LABEL_ASLEEP;
    } else {
      lines = [entry.label, entry.second];
      style = entry.open ? LABEL_OPEN : LABEL_GREY;
    }
    const key = JSON.stringify([lines, style.stroke]);
    if (entry.labelKey === key) return;
    entry.labelKey = key;
    if (entry.labelObject) entry.object.remove(entry.labelObject);
    entry.labelObject = null;
    const label = portalLabel(THREE, document, lines, style);
    if (label) {
      placeLabel(label);
      entry.object.add(label);
      entry.labelObject = label;
    }
  }

  function paintAll() {
    for (const entry of entries) paint(entry);
  }

  /** Where the visitor stands: opts.visitor(), or the camera. */
  function visitorAt() {
    const v = opts.visitor ? opts.visitor() : null;
    if (Array.isArray(v) && v.length >= 3) return new THREE.Vector3(Number(v[0]), Number(v[1]), Number(v[2]));
    return opts.camera ? opts.camera.position.clone() : null;
  }

  /** Wake each portal whose active radius the visitor is within, on the floor; the others sleep. */
  function updateWake() {
    const visitor = visitorAt();
    if (!visitor) return;
    let changed = false;
    for (const entry of entries) {
      entry.group.updateWorldMatrix(true, false);
      const at = new THREE.Vector3().setFromMatrixPosition(entry.group.matrixWorld);
      entry.distance = Math.hypot(at.x - visitor.x, at.z - visitor.z);
      if (entry.radius === null) continue;
      const inside = entry.distance <= entry.radius;
      if (inside === entry.awake) continue;
      entry.awake = inside;
      if (inside) entry.refusal = null;
      changed = true;
      if (inside && entry.previewState === "none") {
        void loadPreview(entry).then(() => { paint(entry); publish(); });
      }
      paint(entry);
    }
    if (changed) publish();
  }

  async function cross(id) {
    const entry = entries.find((e) => e.id === Number(id));
    if (!entry) return { crossed: false, reason: `no portal ${id}` };
    if (!entry.awake) {
      entry.refusal = `asleep: come within ${formatMeters(entry.radius)} to wake it`;
      paint(entry);
      publish();
      return { crossed: false, reason: entry.refusal };
    }
    const result = await crossPortal(entry.resource, { ...io, navigate: opts.navigate });
    if (!result.crossed) {
      entry.refusal = result.reason;
      paint(entry);
      publish();
    }
    return result;
  }

  function publish() {
    if (opts.onUpdate) opts.onUpdate(entries.map(summaryOf));
  }

  function pickables() {
    // what a click can land on: each portal's whole object (ring, face, preview and label)
    return entries.map((e) => ({ id: e.id, object: e.object }));
  }

  await load();
  const timer = setInterval(updateWake, WAKE_INTERVAL_MS);
  return {
    portals: entries.map(summaryOf),
    cross,
    summary: () => entries.map(summaryOf),
    pickables,
    screenPoint,
    refresh: load,
    base,
    graph: Number(hostGraph),
    entry: (id) => entries.find((e) => e.id === Number(id)) || null,
    /** The scene group the graph's node `nodeId` is drawn in, made now if it was placed since. */
    groupOf,
    setPlacing(on) { placing = !!on; paintAll(); },
    select(id) { selected = id == null ? null : Number(id); paintAll(); },
    dispose() { clearInterval(timer); for (const entry of entries) undraw(entry); entries = []; },
  };

  /** Where portal `id`'s ring center is on the page, in client pixels, or null when it is not in view. */
  function screenPoint(id) {
    const entry = entries.find((e) => e.id === Number(id));
    if (!entry || !opts.camera || !opts.canvas) return null;
    const v = new THREE.Vector3();
    entry.object.getWorldPosition(v);
    v.project(opts.camera);
    if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
    const r = opts.canvas.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }
}

/**
 * The placement mode of the `?wow=` player: a panel with a switch, and, while it is on, a click on the floor
 * places a portal there (a node under the graph's root, then the portal that names it), a drag moves a
 * portal (its node), and a click on a portal selects it so its name, destination and active radius can be
 * changed and saved. Every change is written to the world through its Web of Worlds API; the drawing is then
 * read back from the world. `mounted` is mountPortals' result; `viewControls` is mountViewControls' result.
 * The destinations offered are the worlds the frontend lists (GET worlds.json), plus "no destination".
 */
export function mountPlacementTool({ THREE, document, mounted, viewControls, camera, canvas, fetch, worldsUrl, startOn, onChange }) {
  const io = { fetch };
  const state = { on: false, selected: null, last: null, error: null, worlds: [] };
  const panel = document.createElement("div");
  panel.className = "wow-placement-panel";
  Object.assign(panel.style, {
    position: "absolute", right: "12px", top: "84px", zIndex: "6", width: "300px", padding: "10px 12px",
    borderRadius: "8px", background: "rgba(8, 18, 32, 0.9)", color: "#d8f3ff", border: "1px solid #2b4a66",
    font: "13px ui-monospace, Menlo, monospace", boxSizing: "border-box",
  });
  panel.innerHTML = `
    <button type="button" id="wow-place-toggle" style="width:100%;padding:8px;font:inherit;font-weight:bold;cursor:pointer;border-radius:6px;border:1px solid #58d6ff;background:#10283d;color:#d8f3ff">Placement mode: off</button>
    <div id="wow-place-body" style="display:none;margin-top:8px">
      <div id="wow-place-help" style="color:#9fb6cc;margin-bottom:8px;line-height:1.35">Click the floor to place a portal. Drag a placed portal to move it. Click a placed portal to edit it.</div>
      <div id="wow-place-selected" style="margin-bottom:6px;font-weight:bold">No portal selected</div>
      <label style="display:block;margin:4px 0">Name <input id="wow-place-label" type="text" value="Portal" style="width:100%;box-sizing:border-box;font:inherit"></label>
      <label style="display:block;margin:4px 0">Destination <select id="wow-place-destination" style="width:100%;box-sizing:border-box;font:inherit"></select></label>
      <label style="display:block;margin:4px 0">Active radius (m) <input id="wow-place-radius" type="number" min="0.5" max="100" step="0.5" value="3" style="width:100%;box-sizing:border-box;font:inherit"></label>
      <button type="button" id="wow-place-save" style="width:100%;margin-top:6px;padding:6px;font:inherit;cursor:pointer;border-radius:6px;border:1px solid #58d6ff;background:#10283d;color:#d8f3ff" disabled>Save portal</button>
      <div id="wow-place-status" style="margin-top:8px;color:#9fb6cc;line-height:1.35;word-break:break-word"></div>
    </div>`;
  if (canvas.parentNode) canvas.parentNode.appendChild(panel);
  const $ = (id) => panel.querySelector(`#${id}`);
  const fields = { label: $("wow-place-label"), destination: $("wow-place-destination"), radius: $("wow-place-radius") };
  // Typing in the panel is not walking.
  for (const el of Object.values(fields)) el.addEventListener("keydown", (event) => event.stopPropagation());

  function status(text, error) {
    $("wow-place-status").textContent = text;
    $("wow-place-status").style.color = error ? "#ffb59a" : "#9fb6cc";
    state.error = error ? text : null;
    report();
  }

  function report() {
    const summary = { on: state.on, selected: state.selected, last: state.last, error: state.error };
    if (onChange) onChange(summary);
  }

  async function loadWorlds() {
    try {
      const r = await fetch(worldsUrl, { cache: "no-store" });
      state.worlds = r.ok ? (await r.json()).worlds || [] : [];
    } catch { state.worlds = []; }
    const here = mounted.base;
    const select = fields.destination;
    select.innerHTML = "";
    for (const w of state.worlds) {
      if (new URL(w.address).href === here) continue;
      const option = document.createElement("option");
      option.value = w.address;
      option.textContent = `${w.name} (${w.address.replace(/^https?:\/\//, "").replace(/\/$/, "")})`;
      select.appendChild(option);
    }
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "No destination";
    select.appendChild(none);
  }

  function setOn(on) {
    state.on = !!on;
    $("wow-place-toggle").textContent = `Placement mode: ${state.on ? "on" : "off"}`;
    $("wow-place-toggle").style.background = state.on ? "#1d4a2c" : "#10283d";
    $("wow-place-body").style.display = state.on ? "block" : "none";
    mounted.setPlacing(state.on);
    viewControls.setPlacement(state.on ? handlers : null);
    if (!state.on) select(null);
    report();
  }

  function select(id) {
    state.selected = id == null ? null : Number(id);
    mounted.select(state.selected);
    const entry = state.selected == null ? null : mounted.entry(state.selected);
    $("wow-place-save").disabled = !entry || !entry.placed;
    $("wow-place-selected").textContent = !entry ? "No portal selected"
      : `Portal ${entry.id}: ${entry.label}${entry.placed ? "" : " (from the world's configuration: not moved or changed here)"}`;
    if (entry) {
      fields.label.value = entry.label;
      fields.radius.value = entry.radius == null ? "" : String(entry.radius);
      const options = [...fields.destination.options].map((o) => o.value);
      let value = entry.destination ? (() => { try { return entryBase(entry.destination); } catch { return entry.destination; } })() : "";
      if (!options.includes(value)) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        fields.destination.insertBefore(option, fields.destination.lastChild);
      }
      fields.destination.value = value;
    }
    report();
  }

  function radiusValue() {
    const r = Number(fields.radius.value);
    return fields.radius.value === "" ? null : Number.isFinite(r) && r > 0 ? r : NaN;
  }

  /**
   * A pose on the floor, as the localTransform of a node under `parent`: at `point`, its +Z facing the middle of
   * the world, as every portal in the lab faces; a portal placed at the middle faces the camera.
   */
  function localTransformAt(parent, point) {
    const atMiddle = Math.hypot(point.x, point.z) < 0.5;
    const yaw = atMiddle ? Math.atan2(camera.position.x - point.x, camera.position.z - point.z) : Math.atan2(-point.x, -point.z);
    const world = new THREE.Matrix4().makeRotationY(yaw).setPosition(point.x, 0, point.z);
    parent.updateWorldMatrix(true, false);
    const local = new THREE.Matrix4().copy(parent.matrixWorld).invert().multiply(world);
    return local.toArray().map((v) => (Math.abs(v) < 1e-9 ? 0 : Math.round(v * 1e6) / 1e6));
  }

  const handlers = {
    async onFloor(point) {
      if (!point) return;
      const radius = radiusValue();
      if (Number.isNaN(radius)) { status("The active radius must be a number of meters above 0.", true); return; }
      const spatial = await fetch(new URL(`wow/spatial/${mounted.graph}`, mounted.base).href, { headers: { Accept: `${WOW_MEDIA_TYPE}, application/json;q=0.9` }, cache: "no-store" }).then((r) => r.json()).catch(() => null);
      const root = spatial && Number.isInteger(spatial.rootNodeID) ? spatial.rootNodeID : null;
      const parent = root == null ? null : await mounted.groupOf(root);
      if (!parent) { status("Could not read this world's graph root, so nothing was placed.", true); return; }
      const label = fields.label.value.trim() || "Portal";
      status(`Placing ${label} at (${point.x.toFixed(2)}, ${point.z.toFixed(2)})…`);
      try {
        const placed = await placePortal(mounted.base, {
          graph: mounted.graph, parent: root, localTransform: localTransformAt(parent, point),
          label, destination: fields.destination.value || null, active_radius_m: radius,
        }, io);
        await mounted.refresh();
        state.last = { action: "placed", portal: placed.portal.id, node: placed.node.id, at: [point.x, 0, point.z], radius, destination: placed.portal.destination || null };
        select(placed.portal.id);
        status(`Placed portal ${placed.portal.id} (node ${placed.node.id}) at (${point.x.toFixed(2)}, ${point.z.toFixed(2)}). Saved to ${mounted.base}wow/portal/${placed.portal.id}.`);
      } catch (error) {
        status(`Not placed: ${error.message}`, true);
      }
    },
    onPick(id) { select(id); },
    onDragStart(id) {
      select(id);
      const entry = mounted.entry(id);
      if (!entry) return false;
      // Only portals placed with this tool move; a press on a configured portal is a click or a look-around.
      if (!entry.placed) { status(`Portal ${id} comes from the world's configuration, so it is not moved here.`); return false; }
      return true;
    },
    onDrag(id, point) {
      const entry = mounted.entry(id);
      if (!entry || !point || !entry.group.parent) return;
      entry.group.matrix.fromArray(localTransformAt(entry.group.parent, point));
      entry.group.matrixWorldNeedsUpdate = true;
    },
    async onDragEnd(id, point) {
      const entry = mounted.entry(id);
      if (!entry || !point || !entry.group.parent) return;
      const transform = localTransformAt(entry.group.parent, point);
      try {
        await moveNode(mounted.base, mounted.graph, entry.nodeId, transform, io);
        await mounted.refresh();
        state.last = { action: "moved", portal: id, node: entry.nodeId, at: [point.x, 0, point.z] };
        select(id);
        status(`Moved portal ${id} to (${point.x.toFixed(2)}, ${point.z.toFixed(2)}). Saved to node ${entry.nodeId} of graph ${mounted.graph}.`);
      } catch (error) {
        await mounted.refresh();
        status(`Not moved: ${error.message}`, true);
      }
    },
  };

  $("wow-place-toggle").addEventListener("click", () => setOn(!state.on));
  $("wow-place-save").addEventListener("click", async () => {
    if (state.selected == null) return;
    const radius = radiusValue();
    if (Number.isNaN(radius)) { status("The active radius must be a number of meters above 0.", true); return; }
    const id = state.selected;
    try {
      const saved = await changePortal(mounted.base, id, { label: fields.label.value.trim() || "Portal", destination: fields.destination.value || null, active_radius_m: radius }, io);
      await mounted.refresh();
      state.last = { action: "saved", portal: id, radius: saved.active_radius_m == null ? null : saved.active_radius_m, destination: saved.destination || null, label: saved.label };
      select(id);
      status(`Saved portal ${id}: ${saved.destination ? `to ${hostOf(saved.destination)}` : "no destination"}, ${saved.active_radius_m == null ? "always awake" : `wakes within ${formatMeters(saved.active_radius_m)}`}.`);
    } catch (error) {
      status(`Not saved: ${error.status === 409 ? "this portal comes from the world's configuration, so it is not changed here" : error.message}`, true);
    }
  });

  const ready = loadWorlds().then(() => { setOn(!!startOn); });
  return { ready, state, setOn, select, dispose() { viewControls.setPlacement(null); panel.remove(); } };
}

/**
 * The page a browser opens to cross to `destination`, from the page at `pageUrl` showing the world at
 * `hostUrl`. A destination that is already a player page (it names its world in a `wow` parameter) is
 * opened as it is. A destination that is a world's own address (a world server's base URL) is opened in this
 * same player: `wow` names the destination's default graph, and its `#join=node.{n}` is kept. With no
 * `#join`, the visitor arrives at the destination's portal that leads back here, when there is one.
 */
export async function playerUrlFor(destination, { pageUrl, hostUrl, fetch }) {
  const target = new URL(destination);
  if (target.searchParams.get("wow")) return target.href;
  const base = entryBase(target.href);
  let graph = 1;
  try {
    const r = await fetch(new URL("wow/world", base).href, { headers: { Accept: `${WOW_MEDIA_TYPE}, application/json;q=0.9` }, cache: "no-store" });
    const world = r.ok ? await r.json() : null;
    if (world && Array.isArray(world.spatials) && world.spatials.length) graph = world.spatials[0];
  } catch { /* the default graph */ }
  let hash = /^#join=node[./]\d+$/.test(decodeURIComponent(target.hash)) ? target.hash : "";
  if (!hash && hostUrl) {
    const here = worldBaseOf(hostUrl);
    const back = (await readPortals(base, { fetch }).catch(() => []))
      .find((p) => p.nodeId !== null && typeof p.resource.destination === "string" && sameBase(p.resource.destination, here));
    if (back) hash = `#join=node.${back.nodeId}`;
  }
  const page = new URL(pageUrl);
  page.searchParams.set("wow", new URL(`wow/spatial/${graph}`, base).href);
  page.hash = hash;
  return page.href;
}

/** True when a direction (x, z) at a place (x, z) points away from the middle of the world (its origin). */
function facesAway(place, direction) {
  return -place[0] * direction[0] - place[1] * direction[1] < -1e-6;
}

function sameBase(destination, base) {
  try { return entryBase(destination) === new URL(base).href; } catch { return false; }
}

/**
 * At `#join=node.{n}`, put the camera at node n's pose: at the node's position, raised to eye height,
 * looking along the node's +Z axis (so the node's own pitch tilts the view). Returns the arrival
 * (wow-portal.mjs, arrivalAt), or null.
 */
export async function applyJoinArrival({ hostUrl, camera, hash, fetch }) {
  const match = /^#?join=node[./](\d+)$/.exec(decodeURIComponent(String(hash || "")));
  if (!match || !camera) return null;
  const arrival = await arrivalAt(worldBaseOf(hostUrl), Number(match[1]), { fetch });
  if (!arrival) return { arrived: false, reason: `arrival node ${match[1]} not found` };
  const m = arrival.matrix;
  const length = Math.hypot(m[8], m[9], m[10]) || 1;
  let forward = [m[8] / length, m[9] / length, m[10] / length];
  // Arriving at a node that places one of this world's portals (the way back), stand a little in front
  // of it, along its +Z, rather than inside the ring.
  const base = worldBaseOf(hostUrl);
  const atPortal = (await readPortals(base, { fetch }).catch(() => [])).some((p) => p.nodeUrl === arrival.node);
  // Arriving at a portal, stand a little in front of it facing the middle of the world (its origin), so the
  // visitor looks into the world rather than along a wall. A portal at the middle keeps its own front.
  if (atPortal) {
    const toMiddle = [-arrival.position[0], -arrival.position[2]];
    const away = Math.hypot(toMiddle[0], toMiddle[1]);
    if (away > 0.5) forward = [toMiddle[0] / away, 0, toMiddle[1] / away];
    else {
      if (facesAway([arrival.position[0], arrival.position[2]], [forward[0], forward[2]])) forward = forward.map((v) => -v);
      forward = [forward[0], 0, forward[2]];
    }
  }
  const step = atPortal ? ARRIVAL_STAND_OFF_M : 0;
  const flat = Math.hypot(forward[0], forward[2]) || 1;
  const eye = [
    arrival.position[0] + (forward[0] / flat) * step,
    arrival.position[1] + EYE_HEIGHT,
    arrival.position[2] + (forward[2] / flat) * step,
  ];
  camera.position.set(eye[0], eye[1], eye[2]);
  // At a portal, look a little down into the world, so its floor and things are in view.
  const drop = atPortal ? -1.4 : 0;
  camera.lookAt(eye[0] + forward[0] * 5, eye[1] + forward[1] * 5 + drop, eye[2] + forward[2] * 5);
  camera.updateMatrixWorld(true);
  return { arrived: true, ...arrival };
}

/**
 * A label above a ring: the portal's name, then where it leads or why not. A long second line wraps onto more
 * rows rather than shrinking past reading size. Browser only (canvas). The sprite's `userData.height_m` is its
 * height in meters, so the caller can set its bottom just above the ring.
 */
export function portalLabel(THREE, doc, lines, style) {
  if (!doc || typeof doc.createElement !== "function") return null;
  const WIDTH = 1024;
  const PAD = 28;
  const measure = doc.createElement("canvas").getContext("2d");
  if (!measure) return null;
  const font = (size) => `bold ${size}px ui-monospace, Menlo, monospace`;
  const rows = [];
  lines.forEach((line, i) => {
    let size = i === 0 ? 76 : 48;
    const min = i === 0 ? 52 : 40;
    measure.font = font(size);
    while (measure.measureText(line).width > WIDTH - 2 * PAD && size > min) {
      size -= 2;
      measure.font = font(size);
    }
    // Wrap what still does not fit, at spaces.
    let row = "";
    for (const word of String(line).split(" ")) {
      const next = row ? `${row} ${word}` : word;
      if (row && measure.measureText(next).width > WIDTH - 2 * PAD) { rows.push({ text: row, size }); row = word; }
      else row = next;
    }
    rows.push({ text: row, size });
  });
  const height = PAD * 2 + rows.reduce((sum, r) => sum + r.size * 1.3, 0);
  const canvas = doc.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = Math.ceil(height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = 8;
  ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  ctx.fillStyle = style.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let y = PAD;
  for (const r of rows) {
    ctx.font = font(r.size);
    ctx.fillText(r.text, WIDTH / 2, y + (r.size * 1.3) / 2);
    y += r.size * 1.3;
  }
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, transparent: true }));
  const widthM = 2.4;
  sprite.scale.set(widthM, (widthM * canvas.height) / WIDTH, 1);
  sprite.userData.height_m = sprite.scale.y;
  sprite.renderOrder = 10;
  sprite.name = `wow-portal-label:${lines[0]}`;
  return sprite;
}

/** Set a label's bottom a little above the ring. */
function placeLabel(label) {
  label.position.y = RING_RADIUS + 0.25 + (label.userData.height_m || 0.6) / 2;
}

function summaryOf(entry) {
  return {
    id: entry.id, label: entry.label, destination: entry.destination, node: entry.node, placed: entry.placed, preview: entry.preview, refusal: entry.refusal,
    active_radius_m: entry.radius, awake: entry.awake, distance_m: entry.distance == null ? null : Math.round(entry.distance * 1000) / 1000,
  };
}

function formatMeters(m) {
  return `${Number(m).toFixed(Number(m) % 1 ? 1 : 0)} m`;
}

/** The active radius drawn on the floor around a portal's node: a thin ring, faint unless placing. */
function radiusCircle(THREE, radius) {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(Math.max(0, radius - 0.06), radius, 96),
    new THREE.MeshBasicMaterial({ color: COLOR_RING, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.03;
  mesh.name = "wow-portal-radius";
  return mesh;
}

/** A destination as a person reads it: the world it leads to (its base URL, without the scheme). */
function hostOf(url) {
  try { const u = new URL(entryBase(url)); return u.host + u.pathname.replace(/\/$/, ""); } catch { return String(url || ""); }
}

function ring(THREE, color) {
  const mesh = new THREE.Mesh(
    new THREE.TorusGeometry(RING_RADIUS, 0.07, 16, 64),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.35, roughness: 0.4 }),
  );
  mesh.name = "wow-portal-ring";
  return mesh;
}

/** An invisible disc filling the ring's opening, so a click anywhere inside the ring reaches the portal. */
function hitDisc(THREE) {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(RING_RADIUS, 48),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, colorWrite: false, depthWrite: false, side: THREE.DoubleSide }),
  );
  mesh.name = "wow-portal-hit";
  return mesh;
}

function disc(THREE, color) {
  const mesh = new THREE.Mesh(
    new THREE.CircleGeometry(RING_RADIUS * 0.97, 64),
    new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
  );
  mesh.name = "wow-portal-face";
  return mesh;
}

/**
 * The preview's nodes as a small model inside the ring: the arrival node at the ring's center, the
 * radius fitted inside the ring, set a little behind it, and a closed portal drawn as a gray disc.
 */
function previewModel(preview, THREE, buildWowScene) {
  const nodes = {};
  preview.nodes.forEach((n, index) => {
    nodes[index + 1] = {
      id: index + 1,
      label: n.label,
      localTransform: n.matrix,
      ...(n.spatialAssetURI && !n.closed ? { spatialAssetURI: n.spatialAssetURI } : {}),
      ...(n.appearanceURI ? { appearanceURI: n.appearanceURI } : {}),
      children: index === 0 ? preview.nodes.slice(1).map((_, k) => k + 2) : [],
      webofworlds_extension: { source_url: n.url, ...(n.role ? { role: n.role } : {}) },
    };
  });
  const sub = buildWowScene({ spatialID: preview.arrival, root: 1, nodes }, THREE, { bare: true, source: `preview:${preview.arrival}` });
  // Seen through the ring, the destination lies beyond it: the arrival node's +Z (the way a visitor
  // faces on arrival) points away from the viewer, and the model is tilted a little toward the viewer
  // so its ground can be read.
  const holder = new THREE.Group();
  holder.name = `wow-preview:${preview.arrival}`;
  holder.position.set(0, -RING_RADIUS * 0.45, -0.25);
  holder.rotation.x = 0.35;
  const turned = new THREE.Group();
  turned.rotation.y = Math.PI;
  turned.scale.setScalar((RING_RADIUS * 0.6) / Math.max(1, preview.radius_m));
  turned.add(sub.root);
  // A preview shows the destination's things, not the markers of its transform-only nodes.
  sub.root.traverse((o) => { if (/^wow-group-gizmo:/.test(o.name || "")) o.visible = false; });
  holder.add(turned);
  preview.nodes.forEach((n, index) => {
    if (!n.closed) return;
    const group = sub.node_groups && sub.node_groups.get(index + 1);
    if (!group) return;
    const closed = new THREE.Mesh(
      new THREE.CircleGeometry(1.0, 32),
      new THREE.MeshBasicMaterial({ color: COLOR_GREY, side: THREE.DoubleSide }),
    );
    closed.name = "wow-portal-closed";
    closed.position.y = RING_CENTER_Y;
    group.add(closed);
  });
  return { root: holder, assetNodes: sub.asset_nodes || [] };
}
