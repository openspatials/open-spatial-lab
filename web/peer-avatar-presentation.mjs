const PEER_AVATAR_MIN_PLAYER_VIEW_SEPARATION_M = 0.72;
const PEER_AVATAR_OVERLAP_DISTANCE_M = 0.48;

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

/** Render lifetime only. The existing peer reducer owns membership and self-identity filtering. */
export function createPeerAvatarPresentation({
  createLayer,
  getLocalAvatar,
  isPlayer,
  variants,
  logLine,
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
      if (disposed || layers.get(clientId) !== layer) return;
      while (true) {
        const wanted = (layer.__latestPeerAvatar || pose)?.avatar_variant;
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
        if ((layer.__latestPeerAvatar || pose)?.avatar_variant !== wanted) continue;
        break;
      }
      layer.__variantPrimed = true;
      layer.setAvatar(layer.__latestPeerAvatar || pose);
    } catch (error) {
      if (!disposed && layers.get(clientId) === layer)
        logLine(
          `co-presence: peer avatar unavailable: ${error?.message || error}`
        );
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
      void prime(peer.client_id, layer, pose);
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
      layer.setAvatar(pose);
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
