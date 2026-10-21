/**
 * Owns the fixture-backed client-scene lifecycle while LiveAdapter remains the
 * physical host-state and cross-domain composition boundary.
 */
export function createClientSceneLifecycleController({
  nowIso,
  resolveClientGraph,
  readHostState,
  installClientSceneState,
  restoreLobbyState,
  endpointDebug,
  defaultEquippedItems,
  presence,
  runtimeStreams,
  peers,
  prefetch,
  updatePortalStatus,
  emitState,
  dispatchCrossing,
} = {}) {
  let activeRecord = null;

  async function resolve(target) {
    if (!target || typeof target.graph_endpoint !== "string" || !target.graph_endpoint) {
      throw new Error("client scene load requires target.graph_endpoint");
    }
    return resolveClientGraph(target);
  }

  async function enter({ target, contract, resolved, bounds } = {}) {
    const host = readHostState();
    if (host.clientMode !== "player") return { ok: false, reason: "not_player" };
    if (activeRecord) return { ok: false, reason: "client_scene_load_active" };
    if (!target || target.transition !== "client_scene_load") {
      return { ok: false, reason: "invalid_client_scene_load_target" };
    }
    if (!contract || !resolved || !resolved.graph || contract.spatial_id !== target.spatial_id) {
      return { ok: false, reason: "invalid_client_scene_load_contract" };
    }
    if (
      !contract.proof_boundary ||
      contract.proof_boundary.application_level_handoff !== false ||
      contract.proof_boundary.standards_conformance !== false
    ) {
      return { ok: false, reason: "client_scene_load_claim_boundary_mismatch" };
    }
    if (!host.avatar) return { ok: false, reason: "missing_avatar" };

    const origin = {
      activeEndpointKey: host.activeEndpointKey,
      previewEndpointKey: host.previewEndpointKey,
      endpoint: host.endpoint,
      previewEndpoint: host.previewEndpoint,
      base: host.base,
      portalId: host.portalId,
      world: host.world,
      controls: JSON.parse(JSON.stringify(host.controls || {})),
      preview: host.preview,
      portalPreviews: host.portalPreviews,
      phase: host.phase,
      arrivalCount: host.arrivalCount,
      movementBounds: host.movementBounds ? { ...host.movementBounds } : null,
      wowLocalWalk: host.wowLocalWalk,
      wowResolved: host.wowResolved,
      wowSceneSource: host.wowSceneSource,
      boundaryOk: host.boundaryOk,
      boundaryProblems: host.boundaryProblems.slice(),
      peerPresence: peers.snapshot(),
    };

    await presence.departPresence({ base: host.base, reason: "client_scene_load" });
    presence.stopHeartbeat();
    presence.clearRegistration();
    runtimeStreams.closeRuntimeStream();

    const spawn = contract.entry_spawn.position.slice(0, 3).map(Number);
    activeRecord = {
      origin,
      target: { ...target },
      contract: JSON.parse(JSON.stringify(contract)),
      entered_at: nowIso(),
    };
    const installed = installClientSceneState({
      origin,
      target,
      contract,
      resolved,
      bounds,
      spawn,
      avatar: host.avatar,
    });
    activeRecord.reciprocal = installed.reciprocal || {
      portal: null,
      synthesized: false,
      reason: "automatic_reciprocal_unavailable",
    };
    peers.clear();
    prefetch.reset({
      reason: "client_scene_load",
      world: installed.world,
      clientMode: host.clientMode,
    });
    updatePortalStatus();
    emitState();

    return {
      ok: true,
      kind: "client_scene_load",
      portal_id: target.portal_id,
      from: endpointDebug(origin.endpoint, origin.world),
      to: endpointDebug(installed.endpoint, installed.world),
      same_context: true,
      same_player: true,
      no_page_reload: true,
      application_level_handoff: false,
    };
  }

  async function returnToLobby(options = {}) {
    if (!activeRecord) return { ok: false, reason: "client_scene_load_not_active" };
    const current = readHostState();
    const restoring = activeRecord;
    const from = endpointDebug(current.endpoint, current.world);
    const avatar = current.avatar;
    const equippedItems = avatar && Array.isArray(avatar.equippedItems)
      ? avatar.equippedItems
      : defaultEquippedItems();
    const reciprocalPortal = restoring.reciprocal && restoring.reciprocal.portal;
    const viaReciprocal = !!(
      options.reciprocalPortalId &&
      reciprocalPortal &&
      (reciprocalPortal.string_portal_id || reciprocalPortal.portal_id) === options.reciprocalPortalId
    );

    const restored = restoreLobbyState({
      origin: restoring.origin,
      avatar,
      equippedItems,
      arrival: viaReciprocal ? reciprocalPortal.arrival : null,
    });
    peers.restore(restoring.origin.peerPresence);
    activeRecord = null;
    prefetch.reset({
      reason: "return_from_client_scene_load",
      world: restored.world,
      clientMode: current.clientMode,
    });
    updatePortalStatus();
    runtimeStreams.connectRuntimeStream(restored.activeEndpointKey);
    await presence.registerPresence({ spawnReason: "return_from_client_scene_load" });
    peers.broadcastPlayerPose({ force: true });
    emitState();

    const detail = {
      kind: "return_to_lobby",
      from,
      to: endpointDebug(restored.endpoint, restored.world),
      same_context: true,
      same_player: true,
      no_page_reload: true,
      application_level_handoff: false,
      via_reciprocal_portal: viaReciprocal,
      portal_id: viaReciprocal ? options.reciprocalPortalId : null,
      arrival: viaReciprocal ? JSON.parse(JSON.stringify(reciprocalPortal.arrival)) : null,
    };
    dispatchCrossing(detail);
    return { ok: true, ...detail };
  }

  function active() {
    return !!activeRecord;
  }

  function debug() {
    return activeRecord
      ? {
          active: true,
          transition: "client_scene_load",
          target: { ...activeRecord.target },
          contract: JSON.parse(JSON.stringify(activeRecord.contract)),
          entered_at: activeRecord.entered_at,
          same_context: true,
          same_player: true,
          no_page_reload: true,
          application_level_handoff: false,
          reciprocal: activeRecord.reciprocal
            ? JSON.parse(JSON.stringify(activeRecord.reciprocal))
            : null,
        }
      : { active: false };
  }

  return Object.freeze({ resolve, enter, returnToLobby, active, debug });
}
