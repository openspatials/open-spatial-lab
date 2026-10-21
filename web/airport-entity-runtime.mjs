// one bounded owner for airport manifest cards and
// stationary humanoid idle mixers. The selected scene renderer calls update();
// this module never creates a frame loop, renderer, global listener, or HUD.

import { validateAirportEntityInventory } from "./airport-entity-manifest.mjs";
import { verifyManifestProfileA } from "./signing/um-signature-profile-a.mjs";
import { withBase } from "./base-path.mjs";

const CARD_LIMIT = 6;
const CARD_DISTANCE_M = 21;
const MOCAP_URLS = Object.freeze({ locomotion: withBase("/assets/mocap/locomotion-mocap.derived.glb") });

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function fitLine(context, value, maxWidth) {
  const source = String(value || "");
  if (context.measureText(source).width <= maxWidth) return source;
  let text = source;
  while (text.length > 1 && context.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
  return `${text}…`;
}

function drawManifestCard(context, card, invalidReason = null) {
  const width = context.canvas.width;
  const height = context.canvas.height;
  context.clearRect(0, 0, width, height);
  context.save();
  context.shadowColor = invalidReason ? "rgba(255, 173, 73, .72)" : "rgba(66, 229, 255, .72)";
  context.shadowBlur = 30;
  roundedRect(context, 24, 24, width - 48, height - 48, 34);
  context.fillStyle = "rgba(4, 24, 39, .88)";
  context.fill();
  context.lineWidth = 7;
  context.strokeStyle = invalidReason ? "rgba(255, 173, 73, .92)" : "rgba(66, 229, 255, .92)";
  context.stroke();
  context.shadowBlur = 0;

  const title = invalidReason ? card.node_label : card.display_name;
  const typeRole = invalidReason ? "MANIFEST UNAVAILABLE" : `${card.entity_type.toUpperCase()}  ·  ${card.role.toUpperCase()}`;
  const summary = invalidReason ? invalidReason : card.summary;
  context.textBaseline = "alphabetic";
  context.font = "700 43px system-ui, sans-serif";
  context.fillStyle = "#f4fbff";
  context.fillText(fitLine(context, title, width - 112), 58, 93);
  context.font = "700 22px system-ui, sans-serif";
  context.fillStyle = invalidReason ? "#ffbf69" : "#42e5ff";
  context.fillText(fitLine(context, typeRole, width - 112), 58, 137);
  context.font = "500 26px system-ui, sans-serif";
  context.fillStyle = "#dbeaf2";
  context.fillText(fitLine(context, summary, width - 112), 58, 199);
  context.font = "600 20px system-ui, sans-serif";
  context.fillStyle = "#f6d365";
  context.fillText(invalidReason ? "FAIL-CLOSED · NO BORROWED DATA" : "AUTHORED DEMO · SIMULATED · UNVERIFIED IDENTITY", 58, 274);
  context.font = "500 17px ui-monospace, monospace";
  context.fillStyle = "#86aebb";
  const seam = invalidReason ? `node ${card.node_id}` : `${card.manifest_version} · ${card.object_id}`;
  context.fillText(fitLine(context, seam, width - 112), 58, 313);
  context.restore();
}

function createCardMesh(THREE, documentTarget, card) {
  let texture = null;
  let canvas = null;
  if (documentTarget && typeof documentTarget.createElement === "function") {
    canvas = documentTarget.createElement("canvas");
    canvas.width = 768;
    canvas.height = 360;
    const context = canvas.getContext("2d");
    if (context && context.canvas && typeof context.save === "function" && typeof context.arcTo === "function") {
      drawManifestCard(context, card, card.ok ? null : card.errors.join("; "));
      texture = new THREE.CanvasTexture(canvas);
      if ("colorSpace" in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
    }
  }
  const material = new THREE.MeshBasicMaterial({
    color: texture ? 0xffffff : card.ok ? 0x0b6e83 : 0x91551e,
    map: texture,
    transparent: true,
    opacity: 0.94,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.45, 1.62), material);
  mesh.name = `airport-manifest-card:${card.object_id || card.node_id}`;
  mesh.position.set(...card.anchor_position_m);
  mesh.renderOrder = 4;
  mesh.userData.airportManifestCard = {
    node_id: card.node_id,
    subject_id: card.subject_id,
    manifest_id: card.manifest_id,
    manifest_version: card.manifest_version,
    object_id: card.object_id,
    anchor_id: card.anchor_id,
    source: "fixture-universal-manifest-publicProfile",
  };
  return { card, mesh, texture, canvas, signature_status: card.ok ? "checking" : "structural-invalid" };
}

function repaintInvalid(cardState, reason) {
  const context = cardState.canvas?.getContext?.("2d");
  if (context) {
    drawManifestCard(context, cardState.card, reason);
    cardState.texture.needsUpdate = true;
  } else if (cardState.mesh?.material?.color) {
    cardState.mesh.material.color.setHex(0x91551e);
  }
}

/** Create cards now; attach real idle mixers later as each GLB clone lands. */
export function createAirportEntityRuntime(graph, built, THREE, opts = {}) {
  if (!built?.root || !THREE) return null;
  const inventory = validateAirportEntityInventory(graph);
  const group = new THREE.Group();
  group.name = "airport-entity-manifest-cards";
  group.userData.airportManifestCards = true;
  built.root.add(group);

  const cardStates = inventory.records.map(({ card }) => createCardMesh(THREE, opts.document, card));
  const recordByNode = new Map(inventory.records.map((record) => [String(record.node.id), record]));
  const cardByNode = new Map(cardStates.map((state) => [state.card.node_id, state]));
  for (const state of cardStates) group.add(state.mesh);

  const actors = new Map();
  const phaseOffsets = inventory.records
    .filter(({ node }) => ["npc-traveler", "store-staff"].includes(node.webofworlds_extension?.role))
    .map(({ node }) => Number(node.webofworlds_extension?.idle_animation?.phase_offset));
  const debug = {
    inventory_ok: inventory.ok,
    inventory_errors: inventory.errors.slice(),
    eligible_entities: inventory.records.length,
    manifest_cards: cardStates.length,
    visible_cards: 0,
    max_visible_cards: CARD_LIMIT,
    max_card_distance_m: CARD_DISTANCE_M,
    structural_valid_cards: cardStates.filter((state) => state.card.ok).length,
    signature_valid_cards: 0,
    signature_invalid_cards: cardStates.filter((state) => !state.card.ok).length,
    actor_assets_expected: phaseOffsets.length,
    actor_assets_attached: 0,
    idle_mixers_active: 0,
    idle_phase_offsets: phaseOffsets,
    update_owners: 1,
    independent_frame_loops: 0,
    disposed: false,
  };

  let disposed = false;
  const frustum = new THREE.Frustum();
  const projection = new THREE.Matrix4();
  const point = new THREE.Vector3();

  for (const state of cardStates) {
    if (!state.card.ok) continue;
    void verifyManifestProfileA(state.card.manifest).then((report) => {
      if (disposed) return;
      if (report.ok) {
        state.signature_status = "valid";
        debug.signature_valid_cards += 1;
      } else {
        state.signature_status = "invalid";
        debug.signature_invalid_cards += 1;
        repaintInvalid(state, `Invalid manifest signature (${report.reason || "verification failed"}).`);
      }
    }).catch((error) => {
      if (disposed) return;
      state.signature_status = "invalid";
      debug.signature_invalid_cards += 1;
      repaintInvalid(state, `Manifest verification failed (${error?.message || String(error)}).`);
    });
  }

  async function attachAsset(entry, model, assetRecord) {
    if (disposed || entry?.status !== "loaded" || !model || !assetRecord) return false;
    const record = recordByNode.get(String(assetRecord.id));
    if (!record || !["npc-traveler", "store-staff"].includes(record.card.semantic_role)) return false;
    if (actors.has(record.card.node_id)) return true;
    const [{ createGlbHumanoidAvatar }, { createRetargetedLocomotionClips }] = await Promise.all([
      import("./avatar/glb-humanoid.mjs"),
      import("./procedural-animation.js"),
    ]);
    if (disposed) return false;
    const builtAvatar = createGlbHumanoidAvatar(model, { assetId: record.node.webofworlds_extension?.npc_asset?.catalog_id });
    if (!builtAvatar.avatar) {
      debug.inventory_errors.push(`node ${record.card.node_id}: GLB humanoid unavailable (${builtAvatar.report?.reason || "mapping failed"})`);
      return false;
    }
    const actorState = { avatar: builtAvatar.avatar, mixer: null, action: null, phase: Number(record.node.webofworlds_extension?.idle_animation?.phase_offset) || 0 };
    actors.set(record.card.node_id, actorState);
    debug.actor_assets_attached = actors.size;
    try {
      const clips = await createRetargetedLocomotionClips(actorState.avatar, MOCAP_URLS);
      if (disposed || !actors.has(record.card.node_id)) return false;
      if (!clips.idle || !clips.idle.tracks.length) throw new Error("retargeted idle produced no tracks");
      actorState.mixer = new THREE.AnimationMixer(actorState.avatar.scene);
      actorState.action = actorState.mixer.clipAction(clips.idle);
      actorState.action.enabled = true;
      actorState.action.setLoop(THREE.LoopRepeat, Infinity);
      actorState.action.setEffectiveWeight(1);
      actorState.action.setEffectiveTimeScale(opts.motionPreference?.isReduced?.() ? 0.42 : 1);
      actorState.action.play();
      actorState.action.time = clips.idle.duration * actorState.phase;
      actorState.mixer.update(0);
      actorState.avatar.update(0);
      debug.idle_mixers_active += 1;
      return true;
    } catch (error) {
      debug.inventory_errors.push(`node ${record.card.node_id}: idle unavailable (${error?.message || String(error)})`);
      return false;
    }
  }

  function update(deltaSeconds, camera) {
    if (disposed) return;
    const delta = Math.max(0, Math.min(0.05, Number(deltaSeconds) || 0));
    for (const actor of actors.values()) {
      if (!actor.mixer) continue;
      actor.mixer.update(delta);
      actor.avatar.update(delta);
    }
    if (!camera) return;
    camera.updateMatrixWorld?.(true);
    projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projection);
    const candidates = [];
    for (const state of cardStates) {
      state.mesh.visible = false;
      state.mesh.getWorldPosition(point);
      const distance = point.distanceTo(camera.position);
      if (distance <= CARD_DISTANCE_M && frustum.containsPoint(point)) candidates.push({ state, distance });
    }
    candidates.sort((a, b) => a.distance - b.distance || a.state.card.node_id.localeCompare(b.state.card.node_id));
    for (const candidate of candidates.slice(0, CARD_LIMIT)) {
      candidate.state.mesh.quaternion.copy(camera.quaternion);
      candidate.state.mesh.visible = true;
    }
    debug.visible_cards = Math.min(candidates.length, CARD_LIMIT);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const actor of actors.values()) {
      try { actor.action?.stop(); } catch {}
      try { actor.mixer?.stopAllAction(); } catch {}
      try { actor.mixer?.uncacheRoot(actor.avatar.scene); } catch {}
    }
    actors.clear();
    for (const state of cardStates) {
      group.remove(state.mesh);
      try { state.mesh.geometry.dispose(); } catch {}
      try { state.texture?.dispose(); } catch {}
      try { state.mesh.material.dispose(); } catch {}
    }
    group.parent?.remove(group);
    debug.idle_mixers_active = 0;
    debug.visible_cards = 0;
    debug.disposed = true;
  }

  const runtime = { update, attachAsset, dispose, debugState: () => ({ ...debug, inventory_errors: debug.inventory_errors.slice() }) };
  built.airport_entity_runtime = runtime;
  built.render_summary.airport_entities = debug;
  if (opts.document?.body) {
    opts.document.body.setAttribute("data-airport-manifest-cards", String(cardStates.length));
    opts.document.body.setAttribute("data-airport-store-staff", String(inventory.counts.staff));
  }
  return runtime;
}

export default { createAirportEntityRuntime };
