import { userLabel } from "./wow-handshake.mjs";

const PEER_AVATAR_MIN_PLAYER_VIEW_SEPARATION_M = 0.72;
const PEER_AVATAR_OVERLAP_DISTANCE_M = 0.48;
/** This client's target height for a User that carries a body and no drawn height (RB.5), in meters. */
const RECEIVER_TARGET_HEIGHT_M = 1.7;

export function playerViewSeparatedPeerAvatar(
  peerAvatar,
  peerIndex,
  isPlayer,
  local
) {
  if (!isPlayer || !local) return peerAvatar;
  if (!Array.isArray(peerAvatar.position)) return peerAvatar;
  if (!Array.isArray(local.position)) return peerAvatar;

  const localX = Number(local.position[0]) || 0;
  const localZ = Number(local.position[2]) || 0;
  const peerX = Number(peerAvatar.position[0]) || 0;
  const peerZ = Number(peerAvatar.position[2]) || 0;
  const dx = peerX - localX;
  const dz = peerZ - localZ;
  const distance = Math.hypot(dx, dz);
  if (distance >= PEER_AVATAR_OVERLAP_DISTANCE_M) return peerAvatar;

  let ux = 0;
  let uz = 0;
  if (distance > 0.001) {
    ux = dx / distance;
    uz = dz / distance;
  } else {
    const side = peerIndex % 2 === 0 ? 1 : -1;
    const yaw = Number(local.rotation_y) || 0;
    ux = Math.cos(yaw) * side;
    uz = -Math.sin(yaw) * side;
  }

  const position = peerAvatar.position.slice(0, 3);
  position[0] = localX + ux * PEER_AVATAR_MIN_PLAYER_VIEW_SEPARATION_M;
  position[2] = localZ + uz * PEER_AVATAR_MIN_PLAYER_VIEW_SEPARATION_M;
  return {
    ...peerAvatar,
    position,
    visual_separation: {
      applied: true,
      reason: "same_spawn_player_view_overlap",
      original_position: peerAvatar.position.slice(0, 3),
      rendered_position: position.slice(0, 3),
      distance_before_m: Number(distance.toFixed(4)),
      min_separation_m: PEER_AVATAR_MIN_PLAYER_VIEW_SEPARATION_M,
    },
  };
}

function peerPose(peer) {
  return {
    avatar_id: peer.avatar_id,
    continuity_id: peer.continuity_id,
    display_name: peer.display_name,
    position: peer.position,
    rotation_y: peer.rotation_y,
    avatar_variant: peer.avatar_variant,
    equippedItems: peer.equippedItems,
    locomotion: peer.locomotion,
    transition_visual: peer.transition_visual,
  };
}

/**
 * The fit a User carries (contract RB.4, RB.5, RB.11): when the world copied the visitor's `body` and `items` onto its
 * User, this client draws the visitor from them, not from its own copy. The receiver (web/avatar/runtime/wire.mjs)
 * checks the body against the avatar file it fetches (RB.4), sizes it to the height the world set (RB.5) and checks
 * each item against its file. The visitor is drawn as the avatar variant whose file is the User's AvatarURI, at that
 * height, with the accepted items; a body that does not match its file is drawn with no fitting and no items. Returns
 * null for a User with no body (no module is loaded then).
 */
async function fitFromUser(user, variants) {
  if (!user || !user.body) return null;
  const [wire, avatar] = await Promise.all([import("./avatar/runtime/wire.mjs"), import("./avatar/actionforge-avatar.mjs")]);
  const labIdOf = Object.fromEntries(Object.entries(avatar.RUNTIME_ITEMS).map(([lab, runtime]) => [runtime, lab]));
  const readBytes = async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.arrayBuffer();
  };
  const fit = await wire.receiveVisitor(user, { readBytes, targetHeight: RECEIVER_TARGET_HEIGHT_M, knownItem: (id) => !!labIdOf[id] });
  const pathOf = (url) => {
    try { return new URL(url, globalThis.location ? globalThis.location.href : undefined).pathname; } catch { return null; }
  };
  const variant = fit.model && fit.model.ok
    ? Object.values(variants || {}).find((v) => v && v.url && pathOf(v.url) === pathOf(user.AvatarURI))
    : null;
  return {
    wire,
    fit,
    variant: variant ? variant.key : null,
    records: fit.items.map((item) => ({ itemId: labIdOf[item.id], mode: item.mode })),
  };
}

/** The pose a fitted peer is drawn with: the User's avatar and items in place of what its live pose names. */
function withFit(layer, pose) {
  const fitted = layer.__peerFit;
  if (!fitted || !pose) return pose;
  // The live pose carries no height: the drawn height of an accepted body rides with it, or each pose would put the
  // peer back at its variant's own height (setAvatar reads preferred_height_m from the avatar state).
  const height = fitted.fit && fitted.fit.body ? fitted.fit.drawn_height_m : undefined;
  return {
    ...pose,
    avatar_variant: fitted.variant || pose.avatar_variant,
    equippedItems: fitted.records,
    ...(Number.isFinite(height) ? { preferred_height_m: height } : {}),
  };
}

/**
 * Render lifetime only. The existing peer reducer owns membership and self-identity filtering.
 * Each peer is a present user of the world: its avatar carries the shared user label (web/wow-handshake.mjs,
 * userLabel), with the name and pilot the world reads for that user (`readUser(playerId)`, GET /wow/user/{id}).
 * A present user who made no handshake reads pilot "unstated", so its label says "pilot not stated".
 * `makeLabel(text)` draws the label (a three.js object placed above the avatar), or returns null.
 */
export function createPeerAvatarPresentation({
  createLayer,
  getLocalAvatar,
  isPlayer,
  variants,
  logLine,
  readUser,
  makeLabel,
}) {
  const layers = new Map();
  let disposed = false;
  function remove(clientId, layer) {
    try {
      layer.dispose();
    } catch {}
    layers.delete(clientId);
  }
  async function prime(clientId, layer, pose) {
    try {
      await layer.ready;
      await layer.__fitting;
      if (disposed || layers.get(clientId) !== layer) return;
      while (true) {
        const wanted = withFit(layer, layer.__latestPeerAvatar || pose)?.avatar_variant;
        if (wanted && !variants[wanted])
          throw new Error(`unknown peer avatar variant '${wanted}'`);
        if (wanted && wanted !== layer.status.avatar_variant) {
          const result = await layer.switchAvatarVariant(wanted);
          if (disposed || layers.get(clientId) !== layer) return;
          if (result?.ok === false)
            throw new Error(result.error || `peer avatar '${wanted}' unavailable`);
          if (layer.status.avatar_variant !== wanted)
            throw new Error(`peer avatar '${wanted}' is not active`);
        }
        if (withFit(layer, layer.__latestPeerAvatar || pose)?.avatar_variant !== wanted) continue;
        break;
      }
      layer.__variantPrimed = true;
      layer.setAvatar(withFit(layer, layer.__latestPeerAvatar || pose));
      await applyFit(clientId, layer);
    } catch (error) {
      if (!disposed && layers.get(clientId) === layer)
        logLine(
          `co-presence: peer avatar unavailable: ${error?.message || error}`
        );
    }
  }
  /** Draw the peer at the height its User's fit sets, and state the fit on its rig (userData.peerFit, peerState). */
  async function applyFit(clientId, layer) {
    const fitted = layer.__peerFit;
    if (!fitted) return;
    if (!fitted.fit.body) {
      // RB.4: details that do not belong to the file are not used; the visitor is drawn plain, and the page says why.
      if (layer.avatarRig) layer.avatarRig.userData.peerFit = { model: fitted.fit.model, drawn_height_m: fitted.fit.drawn_height_m, variant: null, items: [], refused: fitted.fit.refused, user_measures: null, drawn_measures: null };
      logLine(`co-presence: peer ${clientId.slice(0, 18)}… not fitted from its User: ${(fitted.fit.model && fitted.fit.model.reason) || "no details"}`);
      return;
    }
    if (typeof layer.applyPreferredHeightM === "function") await layer.applyPreferredHeightM(fitted.fit.drawn_height_m);
    if (disposed || layers.get(clientId) !== layer || !layer.avatarRig) return;
    // The measures of the body this client draws with, at the same height, beside those of the User's details.
    const drawnBody = layer._actionForge && layer._actionForge.library ? layer._actionForge.library.body : null;
    let drawnMeasures = null;
    if (drawnBody) {
      const k = fitted.fit.drawn_height_m / drawnBody.measures.height_m;
      drawnMeasures = Object.fromEntries(Object.entries(fitted.wire.measuresOf(drawnBody)).map(([name, value]) => [name, value * k]));
    }
    const { fit } = fitted;
    layer.avatarRig.userData.peerFit = {
      model: fit.model,
      drawn_height_m: fit.drawn_height_m,
      height_from: fit.height_from,
      variant: fitted.variant,
      items: fit.items.map((item) => item.id),
      refused: fit.refused,
      user_measures: fit.measures,
      drawn_measures: drawnMeasures,
    };
    layer.avatarRig.userData.peerState = () => ({
      variant: layer.status ? layer.status.avatar_variant : null,
      model_height_m: layer.status ? layer.status.avatar_model_height_m : null,
      height_applied: layer.status ? layer.status.avatar_height_applied === true : false,
      attached: ((layer.status && layer.status.attachedItems) || []).map((a) => ({ itemId: a.itemId, runtime_item: a.runtime_item || null })),
    });
    logLine(`co-presence: peer ${clientId.slice(0, 18)}… drawn from its User: ${fitted.variant || "its own avatar"} at ${fit.drawn_height_m} m, items ${fit.items.map((item) => item.id).join(", ") || "none"}${fit.refused.length ? `, refused ${fit.refused.map((r) => `${r.itemId} (${r.reason})`).join(", ")}` : ""}`);
  }
  async function label(clientId, layer, peer) {
    if (typeof readUser !== "function") return;
    let user = null;
    try {
      user = await (layer.__user || readUser(peer.player_id || clientId));
    } catch {
      user = null;
    }
    if (disposed || layers.get(clientId) !== layer) return;
    const text = userLabel({ ...(user || {}), name: (user && user.name) || peer.display_name, pilot: user && user.pilot });
    layer.__peerLabel = text;
    const sprite = typeof makeLabel === "function" ? makeLabel(text) : null;
    if (sprite && layer.avatarRig) {
      sprite.name = "peer-label";
      layer.avatarRig.add(sprite);
    }
  }
  function update(peer, index) {
    const pose = playerViewSeparatedPeerAvatar(
      peerPose(peer),
      index,
      isPlayer,
      getLocalAvatar()
    );
    let layer = layers.get(peer.client_id);
    if (!layer) {
      layer = createLayer();
      layer.__isPeer = true;
      layer.__latestPeerAvatar = pose;
      // Keep the rig hidden until its own variant is active, including delayed first loads.
      layer.__variantPrimed = false;
      layers.set(peer.client_id, layer);
      // The peer's User, read once: its label, and the fit it carries (body and items through a join).
      layer.__user = typeof readUser === "function"
        ? Promise.resolve().then(() => readUser(peer.player_id || peer.client_id)).catch(() => null)
        : Promise.resolve(null);
      layer.__fitting = layer.__user
        .then((user) => fitFromUser(user, variants))
        .then((fitted) => { layer.__peerFit = fitted; return fitted; })
        .catch((error) => {
          layer.__peerFit = null;
          logLine(`co-presence: peer fit unavailable: ${error?.message || error}`);
          return null;
        });
      void prime(peer.client_id, layer, pose);
      void label(peer.client_id, layer, peer);
      logLine(
        `co-presence: peer ${peer.client_id.slice(0, 18)}… co-present in ${
          peer.location_id
        } — rendering peer avatar`
      );
    }
    layer.__latestPeerAvatar = pose;
    layer.__peerPlayerId = peer.player_id || peer.client_id;
    layer.__peerVisualSeparation = pose.visual_separation || null;
    if (layer.__variantPrimed && layer.isSettled && layer.isSettled())
      layer.setAvatar(withFit(layer, pose));
  }
  function sync(debug) {
    if (disposed) return;
    const peers = (
      Array.isArray(debug.peer_players) ? debug.peer_players : []
    ).filter((peer) => peer && peer.co_present && peer.client_id);
    const liveIds = new Set(peers.map((peer) => peer.client_id));
    for (const [clientId, layer] of layers)
      if (!liveIds.has(clientId)) {
        remove(clientId, layer);
        logLine(
          `co-presence: peer ${clientId.slice(
            0,
            18
          )}… left this world — peer avatar removed`
        );
      }
    peers.forEach(update);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [id, layer] of layers) remove(id, layer);
  }
  return Object.freeze({ sync, layers, dispose });
}
