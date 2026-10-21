import {
  clonePosition,
  roundNumber,
  roundVec3,
} from "./live-adapter-portal-geometry.mjs";

const PLAYER_POSE_MIN_INTERVAL_MS = 66;
const PLAYER_POSE_MIN_POSITION_DELTA_M = 0.005;
const PLAYER_POSE_MIN_YAW_DELTA_RAD = 0.005;
const PEER_PLAYER_POSE_STALE_MS = 4000;
const CHANNEL_NAME = "open-spatial-lab-peer-presence";

export function createPeerPresenceReducer({
  clientMode,
  clientId,
  controlledIdentity,
  getContext,
  defaultAvatarVariant,
  createBroadcastChannel = typeof BroadcastChannel !== "undefined"
    ? (name) => new BroadcastChannel(name)
    : null,
  nowMs = () => Date.now(),
  onEmit = () => {},
  onArrival = () => {},
  onDepartureMirror = () => {},
  onArrivalMirror = () => {},
  onResolveEquipment = () => Promise.resolve(null),
  onEquipmentStatus = () => {},
  onExternalPresenceDeparture = () => ({}),
} = {}) {
  let peerVisibility = {};
  let playerPoseSeq = 0;
  let playerPoseSentCount = 0;
  let lastPlayerPoseSent = null;
  let livePlayerPose = null;
  let peerPlayerPoses = {};
  let channel = null;

  function context() {
    return getContext() || {};
  }

  function localVisibleAvatarCount() {
    const avatar = context().avatar;
    if (!avatar) return 0;
    const visual = avatar.transition_visual;
    return visual && visual.visible === false ? 0 : 1;
  }

  function post(message) {
    const active = ensureChannel();
    if (active) active.postMessage(message);
  }

  function playerPoseDebug() {
    if (clientMode !== "player") return null;
    return {
      enabled: true,
      channel: CHANNEL_NAME,
      message_type: "player-pose",
      min_interval_ms: PLAYER_POSE_MIN_INTERVAL_MS,
      throttle:
        "min-interval (~15 Hz ceiling) + meaningful position/yaw delta + locomotion/transition edges; never every frame",
      sent_count: playerPoseSentCount,
      last_seq: playerPoseSeq,
      last_sent_at: lastPlayerPoseSent ? new Date(lastPlayerPoseSent.at).toISOString() : null,
      last_location_id: lastPlayerPoseSent ? lastPlayerPoseSent.location_id : null,
      last_position: lastPlayerPoseSent ? roundVec3(lastPlayerPoseSent.position, 4) : null,
      last_rotation_y: lastPlayerPoseSent
        ? roundNumber(lastPlayerPoseSent.rotation_y, 6)
        : null,
    };
  }

  function broadcastPlayerPose({ force = false } = {}) {
    const current = context();
    if (current.wowLocalWalk) return false;
    if (clientMode !== "player" || !current.avatar || !current.world) return false;
    const avatar = current.avatar;
    const controls = current.controls || {};
    const now = nowMs();
    const position = clonePosition(avatar.position, [0, 0, 0]);
    const rotationY = Number(avatar.rotation_y) || 0;
    const moving = controls.moving === true;
    const movementMode = controls.movement_mode || (moving ? (controls.run_mode ? "run" : "walk") : "idle");
    const runMode = controls.run_mode === true || movementMode === "run";
    const speedMps = Number(controls.speed_mps) || 0;
    const transitionPhase = controls.portal_transition_phase || "none";
    const visualVisible = !avatar.transition_visual || avatar.transition_visual.visible !== false;
    const last = lastPlayerPoseSent;
    const movedEnough =
      !last ||
      Math.hypot(
        position[0] - last.position[0],
        position[1] - last.position[1],
        position[2] - last.position[2],
      ) >= PLAYER_POSE_MIN_POSITION_DELTA_M ||
      Math.abs(rotationY - last.rotation_y) >= PLAYER_POSE_MIN_YAW_DELTA_RAD;
    const stateEdge =
      !!last &&
      (last.moving !== moving ||
        last.movement_mode !== movementMode ||
        last.run_mode !== runMode ||
        last.transition_phase !== transitionPhase ||
        last.visible !== visualVisible);
    const intervalElapsed = !last || now - last.at >= PLAYER_POSE_MIN_INTERVAL_MS;
    if (!force && !stateEdge && !(movedEnough && intervalElapsed)) return false;
    playerPoseSeq += 1;
    playerPoseSentCount += 1;
    lastPlayerPoseSent = {
      at: now,
      position,
      rotation_y: rotationY,
      moving,
      movement_mode: movementMode,
      run_mode: runMode,
      transition_phase: transitionPhase,
      visible: visualVisible,
      location_id: current.world.location_id,
    };
    post({
      type: "player-pose",
      client_id: clientId,
      player_id: controlledIdentity().player_id,
      seq: playerPoseSeq,
      at: now,
      location_id: current.world.location_id,
      world_id: current.world.world_id,
      avatar_id: avatar.avatar_id || null,
      continuity_id: avatar.continuity_id || null,
      display_name: avatar.display_name || null,
      position: roundVec3(position, 4),
      rotation_y: roundNumber(rotationY, 6),
      locomotion: {
        moving,
        movement_mode: movementMode,
        run_mode: runMode,
        speed_mps: speedMps,
        movement_direction: controls.movement_direction || "none",
        facing_semantics: controls.facing_semantics || "still",
        grounded: controls.grounded !== false,
        jump_height_m: Number(controls.jump_height_m || 0),
        portal_transition_phase: transitionPhase,
      },
      transition_visual: avatar.transition_visual ? { ...avatar.transition_visual } : null,
      avatar_variant: avatar.avatar_variant || defaultAvatarVariant,
      equippedItems: Array.isArray(avatar.equippedItems) ? avatar.equippedItems : [],
    });
    return true;
  }

  function applyPlayerPoseMirror(message) {
    if (clientMode !== "observer" || !message) return;
    const current = context();
    if (!current.world || message.location_id !== current.world.location_id || !current.avatar) return;
    const avatar = current.avatar;
    if (
      message.continuity_id &&
      avatar.continuity_id &&
      message.continuity_id !== avatar.continuity_id
    ) return;
    avatar.position = clonePosition(message.position, avatar.position);
    avatar.rotation_y = Number(message.rotation_y) || 0;
    avatar.transition_visual = message.transition_visual && typeof message.transition_visual === "object"
      ? { ...message.transition_visual }
      : avatar.transition_visual
        ? { visible: true, scale: 1, spin_y: 0 }
        : avatar.transition_visual;
    if (typeof message.avatar_variant === "string" && message.avatar_variant) {
      avatar.avatar_variant = message.avatar_variant;
    }
    if (Array.isArray(message.equippedItems)) {
      const incoming = JSON.stringify(message.equippedItems.map((item) => item.itemId).sort());
      const existing = JSON.stringify(
        (Array.isArray(avatar.equippedItems) ? avatar.equippedItems : [])
          .map((item) => item.itemId)
          .sort(),
      );
      if (incoming !== existing) {
        avatar.equippedItems = message.equippedItems;
        onResolveEquipment(message.equippedItems)
          .then((status) => { onEquipmentStatus(status); onEmit(); })
          .catch(() => {});
      }
    }
    const locomotion = message.locomotion || {};
    avatar.locomotion = {
      ...(avatar.locomotion || {}),
      moving: locomotion.moving === true,
      movement_mode: locomotion.movement_mode || (locomotion.moving ? (locomotion.run_mode ? "run" : "walk") : "idle"),
      run_mode: locomotion.run_mode === true || locomotion.movement_mode === "run",
      speed_mps: Number(locomotion.speed_mps) || 0,
      movement_direction: locomotion.movement_direction || "none",
      facing_semantics: locomotion.facing_semantics || "still",
      grounded: locomotion.grounded !== false,
      jump_height_m: Number(locomotion.jump_height_m || 0),
      portal_transition_phase: locomotion.portal_transition_phase || "none",
      mirrored_from_player_pose: true,
    };
    livePlayerPose = {
      from_client_id: message.client_id || null,
      location_id: message.location_id,
      avatar_id: message.avatar_id || null,
      continuity_id: message.continuity_id || null,
      seq: Number(message.seq) || 0,
      applied_count: (livePlayerPose ? Number(livePlayerPose.applied_count) : 0) + 1,
      position: roundVec3(message.position, 4),
      rotation_y: roundNumber(Number(message.rotation_y) || 0, 6),
      moving: locomotion.moving === true,
      movement_mode: locomotion.movement_mode || (locomotion.moving ? (locomotion.run_mode ? "run" : "walk") : "idle"),
      run_mode: locomotion.run_mode === true || locomotion.movement_mode === "run",
      speed_mps: Number(locomotion.speed_mps) || 0,
      transition_phase: locomotion.portal_transition_phase || "none",
      applied_at: new Date(nowMs()).toISOString(),
      render_only: true,
      note:
        "live player pose mirrored onto the observer's ONE existing avatar; no backend request, no second avatar",
    };
    onEmit();
  }

  function recordPeerPlayerPose(message) {
    if ((clientMode !== "player" && clientMode !== "observer") || !message || !message.client_id) return;
    const playerId = message.player_id || message.client_id;
    if (clientMode === "player" && playerId === controlledIdentity().player_id) return;
    const previous = peerPlayerPoses[message.client_id];
    peerPlayerPoses[message.client_id] = {
      client_id: message.client_id,
      player_id: playerId,
      seq: Number(message.seq) || 0,
      at: Number(message.at) || nowMs(),
      received_at: nowMs(),
      location_id: message.location_id || null,
      world_id: message.world_id || null,
      avatar_id: message.avatar_id || null,
      continuity_id: message.continuity_id || null,
      display_name: message.display_name || null,
      position: clonePosition(message.position, [0, 0, 0]),
      rotation_y: Number(message.rotation_y) || 0,
      avatar_variant: message.avatar_variant || defaultAvatarVariant,
      equippedItems: Array.isArray(message.equippedItems) ? message.equippedItems : [],
      locomotion: message.locomotion && typeof message.locomotion === "object"
        ? { ...message.locomotion }
        : {},
      transition_visual: message.transition_visual && typeof message.transition_visual === "object"
        ? { ...message.transition_visual }
        : null,
      applied_count: (previous ? Number(previous.applied_count) : 0) + 1,
    };
    if (clientMode === "observer") {
      const current = context();
      const locomotion = message.locomotion || {};
      if (current.world && message.location_id === current.world.location_id) {
        livePlayerPose = {
          from_client_id: message.client_id || null,
          location_id: message.location_id,
          avatar_id: message.avatar_id || null,
          continuity_id: message.continuity_id || null,
          seq: Number(message.seq) || 0,
          applied_count: (livePlayerPose ? Number(livePlayerPose.applied_count) : 0) + 1,
          position: roundVec3(message.position, 4),
          rotation_y: roundNumber(Number(message.rotation_y) || 0, 6),
          moving: locomotion.moving === true,
          transition_phase: locomotion.portal_transition_phase || "none",
          applied_at: new Date(nowMs()).toISOString(),
          render_only: true,
          note: "live player pose recorded as a keyed observer/server-view player; no backend request",
        };
      }
    }
    onEmit({ broadcastVisibility: false });
  }

  function peerPlayersDebug() {
    if (clientMode !== "player" && clientMode !== "observer") return [];
    const now = nowMs();
    const current = context();
    const locationId = current.world ? current.world.location_id : null;
    const output = [];
    for (const [peerClientId, pose] of Object.entries(peerPlayerPoses)) {
      if (now - pose.received_at > PEER_PLAYER_POSE_STALE_MS) {
        delete peerPlayerPoses[peerClientId];
        continue;
      }
      output.push({
        client_id: peerClientId,
        player_id: pose.player_id || peerClientId,
        co_present: !!locationId && pose.location_id === locationId,
        location_id: pose.location_id,
        world_id: pose.world_id,
        avatar_id: pose.avatar_id,
        continuity_id: pose.continuity_id,
        display_name: pose.display_name,
        position: roundVec3(pose.position, 4),
        rotation_y: roundNumber(pose.rotation_y, 6),
        avatar_variant: pose.avatar_variant,
        equippedItems: pose.equippedItems,
        locomotion: pose.locomotion,
        transition_visual: pose.transition_visual,
        seq: pose.seq,
        applied_count: pose.applied_count,
        last_seen_ms: now - pose.received_at,
      });
    }
    return output;
  }

  function coPresentPeerCount() {
    return peerPlayersDebug().filter((peer) => peer.co_present).length;
  }

  function visibilityDebug() {
    const current = context();
    const locationId = current.world && current.world.location_id;
    if (clientMode === "observer") {
      // an observer has no local embodied avatar. Its only
      // visible players are keyed, co-present player-pose records. Falling back
      // to context.avatar here turned the backend's hosted compatibility avatar
      // into phantom occupancy when the authoritative registry was empty.
      const local = peerPlayersDebug().filter((peer) => peer.co_present).length;
      return {
        location_id: locationId,
        local_avatar_visible: local > 0,
        local_visible_avatar_count: local,
        peer_visible_avatar_count: 0,
        peer_visible_by_location: {},
        visible_avatar_count: local,
        one_avatar_visible_invariant: local <= 1,
        one_avatar_per_player_invariant: true,
      };
    }
    const local = localVisibleAvatarCount();
    const perLocation = {};
    for (const record of Object.values(peerVisibility)) {
      if (!record || !record.location_id || record.location_id === locationId) continue;
      perLocation[record.location_id] = Math.max(
        Number(perLocation[record.location_id] || 0),
        Number(record.visible_avatar_count || 0),
      );
    }
    const peer = Object.values(perLocation).reduce((sum, count) => sum + count, 0);
    return {
      location_id: locationId,
      local_avatar_visible: local === 1,
      local_visible_avatar_count: local,
      peer_visible_avatar_count: peer,
      peer_visible_by_location: perLocation,
      visible_avatar_count: local + peer,
      one_avatar_visible_invariant: local + peer <= 1,
      one_avatar_per_player_invariant: true,
    };
  }

  function broadcastVisibility() {
    const current = context();
    post({
      type: "visibility-state",
      client_id: clientId,
      location_id: current.world && current.world.location_id,
      visible_avatar_count: localVisibleAvatarCount(),
      phase: current.phase,
      at: nowMs(),
    });
  }

  function removeDepartedPlayer(input = {}) {
    const playerId = input.playerId;
    const targetLocationId = input.locationId || null;
    const receivedAtMs = input.receivedAtMs == null ? nowMs() : input.receivedAtMs;
    let removed = 0;
    let stalePruneDueAtMs = null;
    if (playerId) {
      for (const [peerClientId, pose] of Object.entries(peerPlayerPoses)) {
        if (
          (pose.player_id || peerClientId) === playerId &&
          (!targetLocationId || pose.location_id === targetLocationId)
        ) {
          stalePruneDueAtMs = pose.received_at + PEER_PLAYER_POSE_STALE_MS;
          delete peerPlayerPoses[peerClientId];
          removed += 1;
        }
      }
    }
    const external = onExternalPresenceDeparture({ ...input, playerId, targetLocationId, receivedAtMs });
    return { peer_pose_removed: removed, stale_prune_due_at_ms: stalePruneDueAtMs, ...(external || {}) };
  }

  function handleMessage(event) {
    const message = event.data;
    const current = context();
    if (
      message && message.type === "arrival" && clientMode === "observer" && message.packet &&
      message.packet.target && current.world && message.packet.target.location_id === current.world.location_id
    ) {
      onArrival(message.packet);
    } else if (message && message.type === "player-crossing" && message.packet && clientMode === "observer") {
      const source = message.packet.source && message.packet.source.location_id;
      const target = message.packet.target && message.packet.target.location_id;
      if (current.world && source === current.world.location_id) onDepartureMirror(message.packet);
      else if (current.world && target === current.world.location_id) onArrivalMirror(message.packet);
    } else if (message && message.type === "player-pose" && clientMode === "observer") {
      recordPeerPlayerPose(message);
    } else if (
      message && message.type === "player-pose" && clientMode === "player" &&
      (message.player_id || message.client_id) !== controlledIdentity().player_id
    ) {
      recordPeerPlayerPose(message);
    } else if (
      message && message.type === "player-pose-request" && clientMode === "player" &&
      message.client_id !== clientId
    ) {
      broadcastPlayerPose({ force: true });
    } else if (
      message && message.type === "visibility-state" && message.client_id && message.client_id !== clientId
    ) {
      const previous = peerVisibility[message.client_id];
      const next = {
        location_id: message.location_id || null,
        visible_avatar_count: Number(message.visible_avatar_count || 0),
        at: message.at || nowMs(),
      };
      const changed = !previous || previous.location_id !== next.location_id ||
        previous.visible_avatar_count !== next.visible_avatar_count;
      peerVisibility[message.client_id] = next;
      if (changed) onEmit({ broadcastVisibility: false });
    }
  }

  function ensureChannel() {
    if (!channel && createBroadcastChannel) {
      channel = createBroadcastChannel(CHANNEL_NAME);
      channel.onmessage = handleMessage;
    }
    return channel;
  }

  function listenForCrossWindow() {
    ensureChannel();
    if (clientMode === "observer" || clientMode === "player") {
      const current = context();
      post({
        type: "player-pose-request",
        client_id: clientId,
        location_id: current.world ? current.world.location_id : null,
        at: nowMs(),
      });
    }
  }

  function snapshot() {
    return { peerPlayerPoses, livePlayerPose };
  }

  function clear() {
    peerPlayerPoses = {};
    livePlayerPose = null;
  }

  function restore(saved = {}) {
    peerPlayerPoses = saved.peerPlayerPoses || {};
    livePlayerPose = saved.livePlayerPose || null;
  }

  function resetBroadcastState() {
    livePlayerPose = null;
    lastPlayerPoseSent = null;
  }

  function clearLivePlayerPose() {
    livePlayerPose = null;
  }

  function livePoseDebug() {
    return livePlayerPose ? { ...livePlayerPose } : null;
  }

  function dispose() {
    if (channel) {
      channel.onmessage = null;
      if (typeof channel.close === "function") channel.close();
    }
    channel = null;
  }

  return {
    channel: ensureChannel,
    listenForCrossWindow,
    broadcast: post,
    broadcastVisibility,
    broadcastPlayerPose,
    applyPlayerPoseMirror,
    recordPeerPlayerPose,
    removeDepartedPlayer,
    peerPlayersDebug,
    coPresentPeerCount,
    visibilityDebug,
    playerPoseDebug,
    livePoseDebug,
    snapshot,
    clear,
    restore,
    resetBroadcastState,
    clearLivePlayerPose,
    dispose,
  };
}

export const PEER_PRESENCE_TIMING = Object.freeze({
  pose_interval_ms: PLAYER_POSE_MIN_INTERVAL_MS,
  stale_ms: PEER_PLAYER_POSE_STALE_MS,
});
