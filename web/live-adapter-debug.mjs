// Pure diagnostic projections; callers supply current data, never a mutable host or transport.
function signingDebug(signing) {
  return {
    signed_on_exit: signing.signed_on_exit,
    verified_on_arrival: signing.verified_on_arrival,
    ...(Object.hasOwn(signing, "optional_diagnostics") ? { optional_diagnostics: signing.optional_diagnostics } : {}),
    scope_note:
      "v0.4 UM manifest signed on exit (Signature Profile A: Ed25519 + JCS-RFC8785 + did:key subject binding) " +
      "and verified on arrival (runtime verifier). Schema-valid v0.4 + real signature; NOT evaluator conformance. " +
      "um_conformance unchanged.",
  };
}

function identityDebug(identity) {
  return identity
    ? {
        ...identity,
        scope_note:
          "UM IDENTITY spine (Ed25519 + JCS-RFC8785 + did:key) over the OpenUserManifest content " +
          "{name,age,avatarAssetURI}, fronted via /wow/user as a labeled non-canonical additive field. " +
          "REAL signature, byte-exact verify; NOT standards conformance (standards_conformance stays false). " +
          "Separate from um_signing (crossing) and the deferred .msf RS256/x5c engine spine.",
      }
    : null;
}

function endpointDebug(resolution) {
  return resolution
    ? {
        resolved_from_services: resolution.resolved_from_services,
        base: resolution.base,
        provenance: resolution.provenance,
        resolution_rule: resolution.resolution_rule,
      }
    : null;
}

export function projectLiveDebug(world, state, diagnostics) {
  return {
    role: diagnostics.role,
    mode: diagnostics.mode,
    client_mode: diagnostics.clientMode,
    provenance: diagnostics.provenance,
    active: diagnostics.active,
    preview: diagnostics.preview,
    portal_previews: state.portal_previews || null,
    controlled_identity: diagnostics.controlledIdentity,
    player_context_marker: diagnostics.playerContextMarker,
    navigator: diagnostics.navigator,
    crossing: diagnostics.traversal.crossing,
    client_scene_load: diagnostics.clientSceneLoad,
    wow_scene_source: diagnostics.wowSceneSource || null,
    um_signing: signingDebug(diagnostics.traversal.um_signing),
    um_identity: identityDebug(diagnostics.umIdentity),
    rp1_fail_closed: diagnostics.rp1FailClosed,
    fabric_prefetch: diagnostics.fabricPrefetch,
    presence_registration: diagnostics.presence,
    presence_push: diagnostics.presencePush,
    wow_endpoints: endpointDebug(diagnostics.endpointResolution),
    view_match: diagnostics.viewMatch || null,
    player_handoff_profile: diagnostics.traversal.player_handoff_profile || null,
    location_id: world.location_id,
    world_id: world.world_id,
    session_id: world.session_id,
    phase: state.phase,
    handoff_id: state.handoff_id,
    session: { arrival_count: state.arrival_count },
    avatar: state.avatar,
    controls: state.controls,
    portal_transition: diagnostics.traversal.portal_transition,
    visibility: diagnostics.visibility,
    live_player_pose: diagnostics.livePose,
    peer_players: diagnostics.peers,
    co_present_peer_count: diagnostics.peerCount,
    player_pose_broadcast: diagnostics.poseBroadcast,
    last_handoff_direction: state.last_handoff_direction,
    last_handoff_payload: state.last_handoff_payload,
    last_pose_payload: state.last_pose_payload,
    geopose_shaped_pose: state.avatar
      ? diagnostics.avatarGeoPose
      : (state.last_handoff_payload &&
          state.last_handoff_payload.avatar_context &&
          state.last_handoff_payload.avatar_context.geopose_shaped_pose) ||
        null,
    equipment_status: state.equipment_status,
    claim_boundary: world.claim_boundary,
    proof_boundary: diagnostics.proofBoundary,
    proof_boundary_check: diagnostics.boundaryStatus,
  };
}

function panelEndpoints(resolution) {
  return resolution
    ? {
        resolved_from_services: resolution.resolved_from_services,
        resolution_rule: resolution.resolution_rule,
        world: resolution.provenance.world.resolved_path,
        user: resolution.provenance.user.resolved_path,
        portal: resolution.provenance.portal.resolved_path,
        view: resolution.provenance.view.resolved_path,
        provenance: resolution.provenance,
        line: resolution.resolved_from_services
          ? "resolved from services[] → " +
            ["world", "user", "portal", "view"]
              .map((k) => resolution.provenance[k].resolved_path)
              .join(", ")
          : "using fallback constants (manifest advertised no WoW services[])",
      }
    : null;
}

export function projectApiPanel(active, target, facts) {
  const { root, world, resolution, viewMatch, validation, specIdentity } = facts;
  const services = Array.isArray(root && root.services) ? root.services : [];
  return {
    spec_identity: { ...specIdentity },
    wow_contract_validation: validation,
    active: {
      endpoint_key: active.endpoint_key,
      proxy_base: active.proxy_base,
      location_id: world ? world.location_id : active.location_id,
      portal_id: active.portal_id,
    },
    target: {
      endpoint_key: target.endpoint_key,
      proxy_base: target.proxy_base,
      location_id: target.location_id,
      portal_id: target.portal_id,
    },
    services: services.map((svc) => ({
      name: svc.name,
      type: svc.type,
      endpoint: svc.endpoint,
      default_id: svc.default_id ?? null,
    })),
    services_line: services.length
      ? "fabric services[] → " + services.map((svc) => svc.endpoint).join(", ")
      : "fabric services[] → (root fabric not loaded)",
    resolved_endpoints: panelEndpoints(resolution),
    view_match: viewMatch || null,
  };
}
