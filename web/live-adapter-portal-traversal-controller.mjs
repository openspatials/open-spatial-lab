import {
  clonePosition,
  crossingYawDeltaRad,
  fabricPortalKey,
  mapCameraAcrossCrossing,
  mapTransformBetweenPortalFrames,
  normalizePortalTraversal,
  portalCrossingDirection,
  portalEntrySideAllowed,
  portalLocalCoordinates,
  roundNumber,
  roundVec3,
  yawFromVector,
} from "./live-adapter-portal-geometry.mjs";
import {
  geoPoseShapedFromTransform,
  GEOPOSE_CONFORMANCE,
} from "./geopose-basic-sdu.mjs";
import {
  IWPS_CONFORMANCE,
  iwpsQueryTeleportFromHandoff,
} from "./iwps-query-teleport.mjs";
import { UM_CONFORMANCE } from "./conformance/um-conformance.mjs";

const PORTAL_TRANSITION_PHASES = Object.freeze({
  WALKTHROUGH: "portal_walkthrough",
});

function copiedCrossing(crossing) {
  if (!crossing) return null;
  return {
    ...crossing,
    phase_history: (crossing.phase_history || []).slice(),
    server_notifications: crossing.server_notifications
      ? {
          exit_intent: { ...crossing.server_notifications.exit_intent },
          arrival: { ...crossing.server_notifications.arrival },
        }
      : null,
  };
}

function mutableHost(readHostSnapshot) {
  const host = readHostSnapshot();
  return {
    ...host,
    controls: { ...(host.controls || {}) },
    avatar: host.avatar
      ? {
          ...host.avatar,
          position: clonePosition(host.avatar.position, [0, 0, 0]),
          locomotion: host.avatar.locomotion ? { ...host.avatar.locomotion } : host.avatar.locomotion,
        }
      : null,
  };
}

function portalControlReset(controls, startsEmbodied, reason) {
  return {
    ...controls,
    portal_distance_m: null,
    portal_center: null,
    portal_radius_m: null,
    portal_frame: null,
    portal_target_frame: null,
    portal_frame_id: null,
    portal_frame_position: null,
    portal_frame_forward: null,
    portal_frame_up: null,
    portal_frame_right: null,
    portal_frame_width_m: null,
    portal_frame_height_m: null,
    portal_trigger_depth_m: null,
    portal_linked_target_portal_id: null,
    portal_local_coordinates: null,
    portal_signed_plane_distance_m: null,
    portal_plane_distance_abs_m: null,
    portal_inside_oval_aperture: false,
    inside_oval_aperture: false,
    inside_trigger_volume: false,
    portal_crossing_direction: "unknown",
    portal_last_crossing_direction: null,
    portal_entry_crossing_direction: null,
    portal_traversal_mode: null,
    portal_allowed_entry_side: null,
    portal_blocked_entry_side: null,
    portal_current_entry_side: null,
    portal_entry_side_allowed: true,
    portal_traversal_rejected_count: 0,
    portal_last_traversal_rejection: null,
    portal_frame_mapping: null,
    mapped_exit_transform: null,
    mapped_exit_yaw: null,
    portal_target_location_id: null,
    portal_target_world_id: null,
    portal_trigger_rearmed: startsEmbodied,
    portal_rearm_required: false,
    portal_exited_since_arrival: startsEmbodied,
    portal_handoff_source_ready: false,
    portal_handoff_target_ready: false,
    portal_handshake_ready: false,
    return_handshake_ready: false,
    portal_ready_blocker: reason,
    inside_portal_trigger: false,
    auto_handoff_ready: false,
    portal_transition_phase: "none",
    portal_transition_elapsed_s: 0,
    portal_transition_phase_history: [],
    portal_focus_portal_id: null,
    portal_count: 0,
    portals: [],
  };
}

/**
 * Canonical portal traversal and handoff owner.
 *
 * The host boundary is deliberately capability-based: no adapter, mutable host
 * state, controls object, or accepted private controller is injected.
 * Promotion stays in-memory in this controller; it never calls location.reload().
 */
export function createPortalTraversalHandoffController(options) {
  const {
    handoffPhases: HANDOFF_PHASES,
    provenance: PROVENANCE,
    transport,
    nowMs = () => Date.now(),
    nowIso = () => new Date().toISOString(),
    readHostSnapshot,
    applyTraversalPatch,
    resolveEndpointForLocation,
    oppositeEndpointKey,
    endpointDebug,
    promoteActiveEndpoint,
    deriveFabricExitPose,
    recordMarkerComparison,
    previewDebug,
    navigatorDebug,
    broadcastPlayerPose,
    emitState,
    dispatchCrossing,
    visualTransition,
    log,
    presence,
    peers,
    prefetch,
    policy,
    crypto,
    assets,
    validation,
    movement,
    motionPreference = null,
    portalAtomicityOracle = null,
  } = options || {};

  if (!HANDOFF_PHASES || !PROVENANCE) {
    throw new Error("portal traversal controller requires handoffPhases/provenance contracts");
  }
  if (!transport || typeof transport.getJson !== "function" || typeof transport.postJson !== "function") {
    throw new Error("portal traversal controller requires transport.getJson/postJson");
  }
  if (typeof readHostSnapshot !== "function" || typeof applyTraversalPatch !== "function") {
    throw new Error("portal traversal controller requires readHostSnapshot/applyTraversalPatch");
  }

  let handoffInFlight = false;
  let lastAutoHandoffId = null;
  let transition = null;
  let transitionCommitStarted = false;
  let transitionNoticeSent = false;
  let portalRuntime = {};
  let lastPortalSignedDistance = null;
  let portalLastCrossingDirection = null;
  let traversalRejectedCount = 0;
  let lastTraversalRejection = null;
  let phaseHistory = [];
  let rearmRequired = false;
  let exitedSinceArrival = false;
  let portalPlaneCrossedAtMs = null;
  let crossingTimings = null;
  let lastExitPacket = null;
  let pendingCameraContinuity = null;
  let crossing = null;
  let umSignOnExit = null;
  let umVerifyOnArrival = null;
  let playerHandoffProfile = null;
  const portalAtomicityMode = ["microtask", "task", "raf", "all"].includes(portalAtomicityOracle)
    ? portalAtomicityOracle
    : null;
  const visualAtomicity = portalAtomicityMode
    ? {
        mode: portalAtomicityMode,
        armed_count: 0,
        completed_count: 0,
        violation_count: 0,
        last: null,
      }
    : null;

  function patchHost(patch) {
    applyTraversalPatch(patch);
  }

  function pushCrossingPhase(name) {
    if (phaseHistory[phaseHistory.length - 1] !== name) phaseHistory.push(name);
    const host = mutableHost(readHostSnapshot);
    host.controls.portal_transition_phase_history = phaseHistory.slice();
    patchHost({ controls: host.controls });
    if (crossing) {
      crossing.phase = name;
      const history = crossing.phase_history;
      if (history[history.length - 1] !== name) history.push(name);
    }
  }

  // Test-only, loopback-gated visual-edge oracle. A clean commit + crossing
  // dispatch completes synchronously, so every scheduled boundary is cancelled
  // or observes a closed token. A yielded microtask/task/rAF observes the open
  // token and makes the crossing fail closed.
  function armVisualAtomicityTripwire() {
    if (!visualAtomicity) return null;
    const token = {
      id: visualAtomicity.armed_count + 1,
      open: true,
      observed: [],
      task_id: null,
      raf_id: null,
    };
    const observe = (boundary) => {
      if (!token.open) return;
      token.observed.push(boundary);
      visualAtomicity.violation_count += 1;
      visualAtomicity.last = {
        token_id: token.id,
        status: "violation",
        observed_boundaries: token.observed.slice(),
      };
    };
    visualAtomicity.armed_count += 1;
    visualAtomicity.last = { token_id: token.id, status: "armed", observed_boundaries: [] };
    if (portalAtomicityMode === "microtask" || portalAtomicityMode === "all") {
      globalThis.queueMicrotask(() => observe("microtask"));
    }
    if (portalAtomicityMode === "task" || portalAtomicityMode === "all") {
      token.task_id = globalThis.setTimeout(() => observe("task"), 0);
    }
    if (portalAtomicityMode === "raf" || portalAtomicityMode === "all") {
      if (typeof globalThis.requestAnimationFrame !== "function") {
        throw new Error("portal visual atomicity tripwire requires requestAnimationFrame");
      }
      token.raf_id = globalThis.requestAnimationFrame(() => observe("raf"));
    }
    return token;
  }

  function completeVisualAtomicityTripwire(token) {
    if (!token) return;
    token.open = false;
    if (token.task_id !== null) globalThis.clearTimeout(token.task_id);
    if (token.raf_id !== null && typeof globalThis.cancelAnimationFrame === "function") {
      globalThis.cancelAnimationFrame(token.raf_id);
    }
    if (token.observed.length > 0) {
      throw new Error(
        `portal visual atomicity tripwire observed ${token.observed.join(",")} boundary before crossing dispatch completed`,
      );
    }
    visualAtomicity.completed_count += 1;
    visualAtomicity.last = { token_id: token.id, status: "complete", observed_boundaries: [] };
  }

  function updatePortalStatus(input = {}) {
    const host = mutableHost(readHostSnapshot);
    const controls = host.controls;
    if (!controls) return { evaluations: [], avatar: host.avatar, transitionRequest: null };
    const portals =
      host.world && Array.isArray(host.world.portals) && host.world.portals.length
        ? host.world.portals
        : host.world && host.world.portal
          ? [host.world.portal]
          : [];
    const portal = portals[0] || null;
    const avatar = host.avatar;
    if (!portal) {
      const reset = portalControlReset(controls, false, "no_portal");
      reset.portal_last_crossing_direction = portalLastCrossingDirection;
      reset.portal_entry_crossing_direction = transition
        ? transition.entry_crossing_direction
        : controls.portal_entry_crossing_direction;
      reset.portal_transition_phase_history = phaseHistory.slice();
      reset.portal_rearm_required = rearmRequired;
      reset.portal_exited_since_arrival = exitedSinceArrival;
      lastPortalSignedDistance = null;
      patchHost({ controls: reset });
      return { evaluations: [], avatar, transitionRequest: null };
    }

    const validKeys = new Set(portals.map((entry) => fabricPortalKey(entry)));
    for (const key of Object.keys(portalRuntime)) {
      if (!validKeys.has(key)) delete portalRuntime[key];
    }

    const evaluations = portals.map((entry) => {
      const portalKey = fabricPortalKey(entry);
      const runtime = portalRuntime[portalKey] || (portalRuntime[portalKey] = {
        lastSignedDistance: null,
        lastCrossingDirection: null,
      });
      const frame = entry.frame || null;
      const portalCenter = clonePosition(
        frame && frame.position,
        entry.trigger && entry.trigger.position ? entry.trigger.position : [0, 0, 0],
      );
      const ev = {
        portal: entry,
        portal_key: portalKey,
        runtime,
        frame,
        targetFrame: entry.target_frame || null,
        portalCenter,
        portalRadius: Number(entry.trigger.radius_m || 0),
        sourceReady: !entry.source_location_id || entry.source_location_id === host.world.location_id,
        targetReady: !!entry.target_location_id && !!entry.target_base_url,
        traversal: normalizePortalTraversal(entry.traversal),
        local: null,
        previousSignedZ: runtime.lastSignedDistance,
        crossingDirection: "unknown",
        distance: null,
        centerDistance: null,
        insideOval: false,
        inside: false,
        currentSide: null,
        entrySideAllowedNow: true,
        crossedPlaneFromFront: false,
        crossedPlaneFromBack: false,
        crossedPlane: false,
        crossingEntrySide: null,
        crossingCommitAllowed: false,
      };
      if (!avatar) {
        runtime.lastSignedDistance = null;
        return ev;
      }
      const local = portalLocalCoordinates(frame, avatar.position || [0, 0, 0]);
      ev.local = local;
      ev.crossingDirection = portalCrossingDirection(
        runtime.lastSignedDistance,
        local && local.signed_plane_distance_m,
      );
      if (!["unknown", "steady", "leaving_plane"].includes(ev.crossingDirection)) {
        runtime.lastCrossingDirection = ev.crossingDirection;
      }
      runtime.lastSignedDistance = local ? local.signed_plane_distance_m : null;
      ev.distance = local
        ? local.plane_distance_abs_m
        : Math.hypot(
            Number(avatar.position && avatar.position[0]) - Number(portalCenter[0]),
            Number(avatar.position && avatar.position[2]) - Number(portalCenter[2]),
          );
      ev.centerDistance = Math.hypot(
        Number(avatar.position && avatar.position[0]) - Number(portalCenter[0]),
        Number(avatar.position && avatar.position[2]) - Number(portalCenter[2]),
      );
      ev.insideOval = local ? local.inside_oval_aperture === true : false;
      ev.inside = local ? local.inside_trigger_volume === true : false;
      ev.currentSide = local ? local.side : null;
      ev.entrySideAllowedNow =
        ev.currentSide === "front" || ev.currentSide === "back"
          ? portalEntrySideAllowed(ev.traversal, ev.currentSide)
          : true;
      ev.crossedPlaneFromFront =
        ev.previousSignedZ !== null &&
        Number(ev.previousSignedZ) > 0 &&
        local &&
        Number(local.signed_plane_distance_m) <= 0 &&
        ev.insideOval;
      ev.crossedPlaneFromBack =
        ev.previousSignedZ !== null &&
        Number(ev.previousSignedZ) < 0 &&
        local &&
        Number(local.signed_plane_distance_m) >= 0 &&
        ev.insideOval;
      ev.crossedPlane = ev.crossedPlaneFromFront || ev.crossedPlaneFromBack;
      ev.crossingEntrySide = ev.crossedPlaneFromFront ? "front" : ev.crossedPlaneFromBack ? "back" : null;
      ev.crossingCommitAllowed =
        ev.crossingEntrySide !== null && portalEntrySideAllowed(ev.traversal, ev.crossingEntrySide);
      return ev;
    });

    let focus = evaluations[0];
    if (avatar) {
      for (const ev of evaluations) {
        const fd = focus.centerDistance == null ? Infinity : focus.centerDistance;
        const ed = ev.centerDistance == null ? Infinity : ev.centerDistance;
        if (
          ed < fd - 1e-9 ||
          (Math.abs(ed - fd) <= 1e-9 && String(ev.portal_key) < String(focus.portal_key))
        ) {
          focus = ev;
        }
      }
    }

    const frame = focus.frame;
    const targetFrame = focus.targetFrame;
    controls.portal_traversal_mode = focus.traversal.mode;
    controls.portal_allowed_entry_side = focus.traversal.allowed_entry_side;
    controls.portal_blocked_entry_side = focus.traversal.blocked_entry_side;
    controls.portal_traversal_rejected_count = traversalRejectedCount;
    controls.portal_last_traversal_rejection = lastTraversalRejection;
    controls.portal_center = focus.portalCenter;
    controls.portal_radius_m = focus.portalRadius;
    controls.portal_frame = frame;
    controls.portal_target_frame = targetFrame;
    controls.portal_frame_id = frame ? frame.portal_id : null;
    controls.portal_frame_position = frame ? frame.position : null;
    controls.portal_frame_forward = frame ? frame.forward : null;
    controls.portal_frame_up = frame ? frame.up : null;
    controls.portal_frame_right = frame ? frame.right : null;
    controls.portal_frame_width_m = frame ? frame.width_m : null;
    controls.portal_frame_height_m = frame ? frame.height_m : null;
    controls.portal_trigger_depth_m = frame ? frame.trigger_depth_m : null;
    controls.portal_linked_target_portal_id = frame ? frame.linked_target_portal_id : null;
    controls.portal_target_location_id = focus.portal.target_location_id || null;
    controls.portal_target_world_id = focus.portal.target_world_id || null;
    controls.portal_handoff_source_ready = focus.sourceReady;
    controls.portal_handoff_target_ready = focus.targetReady;
    controls.portal_rearm_required = rearmRequired;
    controls.portal_exited_since_arrival = exitedSinceArrival;
    controls.portal_focus_portal_id = focus.portal_key;
    controls.portal_count = evaluations.length;
    controls.portals = evaluations.map((ev) => ({
      portal_id: ev.portal_key,
      label: ev.portal.label || null,
      target_location_id: ev.portal.target_location_id || null,
      transition:
        ev.portal.traversal && typeof ev.portal.traversal.transition === "string"
          ? ev.portal.traversal.transition
          : null,
      center: Array.isArray(ev.portalCenter) ? ev.portalCenter.slice(0, 3) : null,
      distance_m: ev.distance != null ? Number(ev.distance.toFixed(3)) : null,
      center_distance_m: ev.centerDistance != null ? Number(ev.centerDistance.toFixed(3)) : null,
      inside_oval_aperture: ev.insideOval,
      inside_trigger_volume: ev.inside,
      current_entry_side: ev.currentSide,
      entry_side_allowed: ev.entrySideAllowedNow,
      traversal_mode: ev.traversal.mode,
      crossed_plane: ev.crossedPlane,
      crossing_commit_allowed: ev.crossingCommitAllowed,
      is_focus: ev === focus,
    }));

    if (!avatar) {
      controls.portal_distance_m = null;
      controls.inside_portal_trigger = false;
      controls.auto_handoff_ready = false;
      controls.portal_handshake_ready = false;
      controls.return_handshake_ready = false;
      controls.portal_trigger_rearmed = !rearmRequired || exitedSinceArrival;
      controls.portal_ready_blocker = "no_avatar";
      controls.portal_local_coordinates = null;
      controls.portal_signed_plane_distance_m = null;
      controls.portal_plane_distance_abs_m = null;
      controls.portal_inside_oval_aperture = false;
      controls.inside_oval_aperture = false;
      controls.inside_trigger_volume = false;
      controls.portal_current_entry_side = null;
      controls.portal_entry_side_allowed = true;
      controls.portal_crossing_direction = "unknown";
      controls.portal_last_crossing_direction = portalLastCrossingDirection;
      controls.portal_entry_crossing_direction = transition
        ? transition.entry_crossing_direction
        : controls.portal_entry_crossing_direction;
      controls.portal_transition_phase_history = phaseHistory.slice();
      lastPortalSignedDistance = null;
      patchHost({ controls });
      return { evaluations, avatar, transitionRequest: null };
    }

    portalLastCrossingDirection =
      focus.runtime.lastCrossingDirection || portalLastCrossingDirection;
    lastPortalSignedDistance = focus.runtime.lastSignedDistance;
    const insideAny = evaluations.some((ev) => ev.inside);
    if (rearmRequired && !insideAny) exitedSinceArrival = true;
    const rearmed = !rearmRequired || exitedSinceArrival;
    const handshakeReady =
      focus.inside &&
      rearmed &&
      focus.entrySideAllowedNow &&
      focus.sourceReady &&
      focus.targetReady &&
      !handoffInFlight &&
      host.phase !== HANDOFF_PHASES.DEPARTED;
    const currentTransform = validation.transformSnapshot(avatar);
    const frameMapping = transition && transition.portal_frame_mapping
      ? transition.portal_frame_mapping
      : mapTransformBetweenPortalFrames({
          sourceFrame: frame,
          targetFrame,
          entryTransform: currentTransform,
          entryLocal: focus.local,
        });
    controls.portal_distance_m = focus.distance != null ? Number(focus.distance.toFixed(3)) : null;
    controls.portal_local_coordinates = focus.local;
    controls.portal_signed_plane_distance_m = focus.local ? focus.local.signed_plane_distance_m : null;
    controls.portal_plane_distance_abs_m = focus.local ? focus.local.plane_distance_abs_m : null;
    controls.portal_inside_oval_aperture = focus.insideOval;
    controls.inside_oval_aperture = focus.insideOval;
    controls.inside_trigger_volume = focus.inside;
    controls.portal_crossing_direction = focus.crossingDirection;
    controls.portal_last_crossing_direction = portalLastCrossingDirection;
    controls.portal_current_entry_side = focus.currentSide;
    controls.portal_entry_side_allowed = focus.entrySideAllowedNow;
    controls.portal_entry_crossing_direction = transition
      ? transition.entry_crossing_direction
      : controls.portal_entry_crossing_direction;
    controls.portal_transition_phase_history = phaseHistory.slice();
    controls.portal_frame_mapping = frameMapping;
    controls.mapped_exit_transform = frameMapping && frameMapping.mapped_exit_transform;
    controls.mapped_exit_yaw = frameMapping && frameMapping.exit_yaw_radians;
    controls.inside_portal_trigger = focus.inside;
    controls.portal_trigger_rearmed = rearmed;
    controls.portal_rearm_required = rearmRequired;
    controls.portal_exited_since_arrival = exitedSinceArrival;
    controls.portal_handshake_ready = handshakeReady;
    controls.return_handshake_ready = handshakeReady;
    controls.auto_handoff_ready = handshakeReady;
    controls.portal_ready_blocker = !focus.sourceReady
      ? "source_not_ready"
      : !focus.targetReady
        ? "target_not_ready"
        : !focus.entrySideAllowedNow
          ? "one_way_blocked_side"
          : !focus.inside
            ? focus.insideOval
              ? "outside_trigger_depth"
              : "outside_oval_aperture"
            : !rearmed
              ? "awaiting_exit_reentry"
              : handoffInFlight
                ? "handoff_in_flight"
                : host.phase === HANDOFF_PHASES.DEPARTED
                  ? "departed"
                  : "ready";

    let transitionRequest = null;
    if (
      !input.skipTransitionStart &&
      rearmed &&
      !transition &&
      !handoffInFlight &&
      [HANDOFF_PHASES.IDLE, HANDOFF_PHASES.ARRIVED, HANDOFF_PHASES.PORTAL_ACTIVE].includes(host.phase)
    ) {
      const crossingOrder = [focus, ...evaluations.filter((ev) => ev !== focus)];
      for (const ev of crossingOrder) {
        if (!ev.crossedPlane || !ev.sourceReady || !ev.targetReady) continue;
        if (ev.crossingCommitAllowed) {
          transitionRequest = { source: "plane_crossing", portal: ev.portal };
          break;
        }
        recordTraversalRejection(ev.traversal, ev.crossingEntrySide, ev.local, ev.portal);
      }
    }
    let nextPhase = host.phase;
    const anyPortalActive = evaluations.some((ev) => ev.inside && ev.entrySideAllowedNow);
    if (
      anyPortalActive &&
      rearmed &&
      (host.phase === HANDOFF_PHASES.IDLE || host.phase === HANDOFF_PHASES.ARRIVED)
    ) {
      nextPhase = HANDOFF_PHASES.PORTAL_ACTIVE;
    }
    avatar.locomotion = { ...controls };
    patchHost({ phase: nextPhase, controls, avatar, avatarMode: "merge" });
    return { evaluations, avatar, transitionRequest };
  }

  function recordTraversalRejection(traversal, entrySide, local, portalArg) {
    const host = mutableHost(readHostSnapshot);
    const portal = portalArg || (host.world && host.world.portal) || null;
    traversalRejectedCount += 1;
    lastTraversalRejection = {
      at: nowIso(),
      portal_id: portal ? portal.portal_id : null,
      portal_key: fabricPortalKey(portal),
      entry_side: entrySide,
      crossing: entrySide === "front" ? "front_to_back" : "back_to_front",
      allowed_entry_side: traversal.allowed_entry_side,
      reason: "one_way_blocked_side",
      signed_plane_distance_m: local ? local.signed_plane_distance_m : null,
    };
    host.controls.portal_traversal_rejected_count = traversalRejectedCount;
    host.controls.portal_last_traversal_rejection = lastTraversalRejection;
    patchHost({ controls: host.controls });
    emitState();
  }

  function activate() {
    const host = mutableHost(readHostSnapshot);
    if (!host.avatar) return false;
    if (host.phase !== HANDOFF_PHASES.IDLE && host.phase !== HANDOFF_PHASES.ARRIVED) return false;
    patchHost({ phase: HANDOFF_PHASES.PORTAL_ACTIVE });
    return true;
  }

  function beginTransition(input = {}) {
    const host = mutableHost(readHostSnapshot);
    if (!host.avatar || transition || handoffInFlight) return false;
    const portal = input.portal || (host.world && host.world.portal);
    if (!portal) return false;
    const portalKey = fabricPortalKey(portal);
    const runtime = portalRuntime[portalKey] || null;
    const entryTransform = validation.transformSnapshot(host.avatar);
    const entryLocal = portalLocalCoordinates(portal.frame, entryTransform.position);
    const entryCrossingDirection =
      (runtime && runtime.lastCrossingDirection) ||
      host.controls.portal_crossing_direction ||
      portalLastCrossingDirection ||
      "unknown";
    const frameMapping = mapTransformBetweenPortalFrames({
      sourceFrame: portal.frame,
      targetFrame: portal.target_frame,
      entryTransform,
      entryLocal,
    });
    phaseHistory = [PORTAL_TRANSITION_PHASES.WALKTHROUGH];
    transitionCommitStarted = false;
    transitionNoticeSent = false;
    portalPlaneCrossedAtMs = nowMs();
    crossingTimings = { plane_crossed_at: nowIso() };
    transition = {
      source: input.source || "operator",
      phase: PORTAL_TRANSITION_PHASES.WALKTHROUGH,
      elapsed: 0,
      portal,
      portal_key: portalKey,
      entry_transform: entryTransform,
      entry_portal_local: entryLocal,
      entry_crossing_direction: entryCrossingDirection,
      portal_frame_mapping: frameMapping,
      exit_transform: null,
    };
    host.controls.enabled = true;
    host.controls.moving = true;
    host.controls.auto_handoff_ready = true;
    host.controls.portal_transition_phase = PORTAL_TRANSITION_PHASES.WALKTHROUGH;
    host.controls.portal_transition_elapsed_s = 0;
    host.controls.portal_transition_phase_history = phaseHistory.slice();
    host.controls.portal_entry_crossing_direction = entryCrossingDirection;
    host.controls.portal_last_crossing_direction = portalLastCrossingDirection || entryCrossingDirection;
    host.controls.portal_frame_mapping = frameMapping;
    host.controls.mapped_exit_transform = frameMapping && frameMapping.mapped_exit_transform;
    host.controls.mapped_exit_yaw = frameMapping && frameMapping.exit_yaw_radians;
    patchHost({ phase: PORTAL_TRANSITION_PHASES.WALKTHROUGH, controls: host.controls });
    emitState();
    void commitPortalHandoff();
    return true;
  }

  function stepTransition(input = {}) {
    const host = mutableHost(readHostSnapshot);
    if (!transition || !host.avatar) return { controls: host.controls, moved: false };
    const dt = Number(input.deltaSeconds ?? input) || 0;
    transition.elapsed += dt;
    if (motionPreference?.isReduced?.() === true) {
      host.controls.enabled = true;
      host.controls.moving = false;
      host.controls.movement_direction = "none";
      host.controls.last_planar_delta = [0, 0, 0];
      host.controls.facing_semantics = "still";
      host.controls.portal_transition_phase = transition.phase;
      host.controls.portal_transition_elapsed_s = Number(transition.elapsed.toFixed(3));
      host.controls.portal_transition_phase_history = phaseHistory.slice();
      host.avatar.locomotion = { ...host.controls };
      patchHost({ controls: host.controls, avatar: host.avatar, avatarMode: "merge" });
      return { controls: host.controls, moved: false };
    }
    const yaw = Number(host.avatar.rotation_y) || 0;
    const dx = Math.sin(yaw) * movement.speedMps * dt;
    const dz = Math.cos(yaw) * movement.speedMps * dt;
    const position = clonePosition(host.avatar.position, [0, 0, 0]);
    position[0] += dx;
    position[2] += dz;
    host.avatar.position = position;
    host.controls.enabled = true;
    host.controls.moving = true;
    host.controls.movement_direction = "portal_walkthrough";
    host.controls.last_planar_delta = [Number(dx.toFixed(4)), 0, Number(dz.toFixed(4))];
    host.controls.facing_semantics = movement.facingSemanticsFromDelta(dx, dz);
    host.controls.portal_transition_phase = transition.phase;
    host.controls.portal_transition_elapsed_s = Number(transition.elapsed.toFixed(3));
    host.controls.portal_transition_phase_history = phaseHistory.slice();
    host.avatar.locomotion = { ...host.controls };
    patchHost({ controls: host.controls, avatar: host.avatar, avatarMode: "merge" });
    return { controls: host.controls, moved: true };
  }

  function shouldAutoHandoff() {
    const host = readHostSnapshot();
    return !!transition && host.controls.portal_transition_phase !== "none" && !transitionNoticeSent;
  }

  function markAutoHandoffObserved() {
    transitionNoticeSent = true;
  }

  function triggerHandoff() {
    const host = readHostSnapshot();
    if (!host.avatar || handoffInFlight) return false;
    if (transition) return true;
    const focusKey = host.controls ? host.controls.portal_focus_portal_id : null;
    const portals = host.world && Array.isArray(host.world.portals) ? host.world.portals : [];
    const portal =
      (focusKey && portals.find((entry) => fabricPortalKey(entry) === focusKey)) ||
      (host.world && host.world.portal) ||
      null;
    return beginTransition({ source: "operator", portal });
  }

  function denyCrossing(receipt) {
    const host = mutableHost(readHostSnapshot);
    log(
      `RP1 FAIL-CLOSED: crossing DENIED (${receipt.action || "default-deny"}) — ` +
        `${(receipt.reasons && receipt.reasons[0]) || "fail-closed"} [demo mode: ${receipt.demo_mode}]`,
    );
    transition = null;
    handoffInFlight = false;
    transitionCommitStarted = false;
    rearmRequired = true;
    exitedSinceArrival = false;
    host.controls.enabled = true;
    host.controls.moving = false;
    host.controls.portal_transition_phase = "none";
    host.controls.portal_transition_elapsed_s = 0;
    patchHost({ phase: HANDOFF_PHASES.IDLE, controls: host.controls });
    updatePortalStatus();
    emitState();
  }

  async function commitPortalHandoff() {
    let host = mutableHost(readHostSnapshot);
    if (!host.avatar || handoffInFlight || transitionCommitStarted) return;
    const receipt = policy.evaluateRp1Gate();
    if (receipt && receipt.decision === "deny") {
      denyCrossing(receipt);
      return;
    }
    transitionCommitStarted = true;
    handoffInFlight = true;
    const crossingPortal = (transition && transition.portal) || (host.world && host.world.portal) || null;
    const crossingPortalKey = fabricPortalKey(crossingPortal) || host.portalId;
    const timings = crossingTimings || (crossingTimings = {});
    const stageStart = nowMs();
    let packet;
    try {
      const registration = presence.snapshot();
      const identity = presence.controlledIdentity();
      packet = await transport.postJson(`${host.base}/portal/exit-intent`, {
        portal_id: crossingPortalKey,
        ...(registration && registration.supported && identity && identity.player_id
          ? { player_id: identity.player_id }
          : {}),
      });
      timings.exit_intent_ms = nowMs() - stageStart;
    } catch (error) {
      log(`exit-intent failed: ${error.message}`);
      handoffInFlight = false;
      transitionCommitStarted = false;
      transition = null;
      host.controls.portal_transition_phase = "none";
      host.controls.portal_transition_elapsed_s = 0;
      patchHost({ phase: HANDOFF_PHASES.IDLE, controls: host.controls });
      updatePortalStatus();
      emitState();
      return;
    }

    const commitIso = nowIso();
    const activeTransition = transition || {};
    const avatarTransform = validation.transformSnapshot(host.avatar);
    const frameMapping = activeTransition.portal_frame_mapping || mapTransformBetweenPortalFrames({
      sourceFrame: crossingPortal && crossingPortal.frame,
      targetFrame: crossingPortal && crossingPortal.target_frame,
      entryTransform: activeTransition.entry_transform || avatarTransform,
      entryLocal: activeTransition.entry_portal_local,
    });
    const mappedExitTransform = frameMapping && frameMapping.mapped_exit_transform;
    if (mappedExitTransform && packet.target) {
      packet.target.arrival_position = clonePosition(mappedExitTransform.position, packet.target.arrival_position);
      packet.target.arrival_rotation_y = mappedExitTransform.rotation_y;
    }
    const equippedItems = Array.isArray(host.avatar.equippedItems)
      ? host.avatar.equippedItems
      : assets.defaultEquippedItems();
    const sourceLocationId = packet.source && packet.source.location_id;
    const targetLocationId = packet.target && packet.target.location_id;
    const handoffDirection = `${sourceLocationId || host.world.location_id}->${targetLocationId || "unknown"}`;
    const locomotionState = {
      ...host.controls,
      enabled: false,
      moving: false,
      portal_transition_phase: PORTAL_TRANSITION_PHASES.WALKTHROUGH,
    };
    const poseSnapshot = {
      captured_at: commitIso,
      location_id: host.world.location_id,
      world_id: host.world.world_id,
      handoff_direction: handoffDirection,
      transform: avatarTransform,
      locomotion_state: locomotionState,
      movement_direction: host.controls.movement_direction,
      facing_semantics: host.controls.facing_semantics,
      portal_frame_transform: frameMapping,
    };
    const identity = presence.controlledIdentity();
    packet.avatar_context = {
      ...(packet.avatar_context || {}),
      controlled_identity: identity,
      player_id: identity.player_id,
      transform: avatarTransform,
      equippedItems,
      avatar_variant: host.avatar.avatar_variant || assets.defaultAvatarVariant,
      equipment_profile: "msf.phase0b.avatar-equipment.v0",
      pose_snapshot: poseSnapshot,
      locomotion_state: locomotionState,
      portal_entry_transform: activeTransition.entry_transform || avatarTransform,
      portal_center_transform: activeTransition.entry_transform || avatarTransform,
      portal_departure_transform: avatarTransform,
      portal_exit_transform: mappedExitTransform || avatarTransform,
      portal_frame_transform: frameMapping,
      mapped_exit_transform: mappedExitTransform || null,
      mapped_exit_yaw: frameMapping ? frameMapping.exit_yaw_radians : null,
      capture_timestamp: commitIso,
      source_location_id: sourceLocationId || host.world.location_id,
      target_location_id: targetLocationId || null,
      handoff_direction: handoffDirection,
      iwps_style_pose_capture: {
        _claim: "IWPS-style transform and pose/locomotion capture for local validation only; no IWPS conformance claim.",
        transform: avatarTransform,
        pose_snapshot: poseSnapshot,
        locomotion_state: locomotionState,
        portal_entry_transform: activeTransition.entry_transform || avatarTransform,
        portal_center_transform: activeTransition.entry_transform || avatarTransform,
        portal_departure_transform: avatarTransform,
        portal_exit_transform: mappedExitTransform || avatarTransform,
        portal_frame_transform: frameMapping,
        mapped_exit_transform: mappedExitTransform || null,
      },
      geopose_shaped_pose: geoPoseShapedFromTransform(avatarTransform),
    };
    packet.assets = {
      avatar_equipment_profile: packet.avatar_context.equipment_profile,
      equippedItems: packet.avatar_context.equippedItems.map((item) => ({
        itemId: item.itemId,
        assetUri: item.assetUri,
        mode: item.mode,
        attachmentPoint: item.attachmentPoint,
      })),
      iwps_style_pose_payload: "avatar_context.iwps_style_pose_capture",
      note: "IWPS assets placement scaffold; reference-only, no IWPS conformance claim.",
    };
    packet.fabric_prefetch_proof = prefetch.proofBlock(commitIso, crossingPortalKey);
    umSignOnExit = await crypto.signManifest(packet, host.world, transport);
    if (umSignOnExit && umSignOnExit.signed) {
      log(
        `crossing: signed v0.4 UM manifest on exit (Profile A; subject ${umSignOnExit.did_subject || "?"}); ` +
          "carried in the handoff for verify-on-arrival",
      );
    } else {
      log(`crossing: UM manifest sign-on-exit did not complete (${(umSignOnExit && umSignOnExit.error) || "unknown"})`);
    }
    pendingCameraContinuity = host.lastCameraTransform
      ? {
          cameraTransform: {
            position: Array.isArray(host.lastCameraTransform.position)
              ? host.lastCameraTransform.position.slice(0, 3)
              : null,
            target: Array.isArray(host.lastCameraTransform.target)
              ? host.lastCameraTransform.target.slice(0, 3)
              : null,
            rotation_y: Number(host.lastCameraTransform.rotation_y) || 0,
          },
          entry_position: clonePosition((activeTransition.entry_transform || avatarTransform).position, [0, 0, 0]),
          entry_yaw: Number((activeTransition.entry_transform || avatarTransform).rotation_y) || 0,
        }
      : null;
    lastExitPacket = packet;
    lastAutoHandoffId = packet.handoff_id;
    if (visualTransition && typeof visualTransition.begin === "function") {
      visualTransition.begin({
        kind: "server_backed_portal_crossing",
        handoff_id: packet.handoff_id || null,
        source_location_id: sourceLocationId || host.world.location_id,
        target_location_id: targetLocationId || null,
      });
    }
    transition = null;
    rearmRequired = false;
    exitedSinceArrival = false;
    host.controls.enabled = false;
    host.controls.moving = false;
    host.controls.portal_transition_phase = "none";
    host.controls.portal_transition_elapsed_s = 0;
    patchHost({
      phase: HANDOFF_PHASES.DEPARTED,
      ...(host.clientMode === "player" ? {} : { avatar: null, equipmentStatus: null }),
      handoffId: packet.handoff_id,
      lastHandoffDirection: handoffDirection,
      lastHandoffPayload: packet,
      lastPosePayload: packet.avatar_context.iwps_style_pose_capture,
      controls: host.controls,
    });
    if (host.clientMode === "player") {
      pushCrossingPhase("source_exit_committed");
      updatePortalStatus();
      void _completePlayerCrossing(packet);
      return;
    }
    if (visualTransition && typeof visualTransition.commit === "function") {
      visualTransition.commit();
    }
    handoffInFlight = false;
    updatePortalStatus();
    emitState();
    peers.broadcast({ type: "arrival", packet, at: nowMs() });
  }

  async function _completePlayerCrossing(packet) {
    const initial = mutableHost(readHostSnapshot);
    const fromEndpoint = initial.endpoint;
    const fromWorld = initial.world;
    const frameMapping = packet.avatar_context && packet.avatar_context.portal_frame_transform;
    const traversedSourceFrame = frameMapping ? frameMapping.source_portal_frame : null;
    const traversedTargetFrame = frameMapping ? frameMapping.target_portal_frame : null;
    const targetKey =
      resolveEndpointForLocation(packet && packet.target ? packet.target.location_id : null) ||
      resolveEndpointForLocation(traversedTargetFrame ? traversedTargetFrame.location_id : null) ||
      oppositeEndpointKey(initial.activeEndpointKey);
    const targetEndpoint = initial.resolveEndpoint(targetKey);
    const commitStartMs = nowMs();
    const timings = crossingTimings || (crossingTimings = {});
    crossing = {
      kind: "world_navigator_composition_crossing",
      handoff_id: packet.handoff_id || null,
      phase: "target_arrival_posting",
      phase_history: ["source_exit_committed", "target_arrival_posting"],
      started_at: nowIso(),
      completed_at: null,
      from: endpointDebug(fromEndpoint, fromWorld),
      to: endpointDebug(targetEndpoint, null),
      active_endpoint_switched: false,
      no_reload_rule: "one JS context; child fabric promoted to root — never location.reload()/assign(), never URL navigation",
      server_notifications: {
        exit_intent: {
          endpoint: `${fromEndpoint.proxy_base}/portal/exit-intent`,
          role: "server-side crossing notification (IWPS-shaped, labeled); not load-bearing for the composition",
          posted: true,
          accepted: true,
          handoff_id: packet.handoff_id || null,
        },
        arrival: {
          endpoint: `${targetEndpoint.proxy_base}/portal/arrival`,
          role: "server-side crossing notification (IWPS-shaped, labeled); not load-bearing for the composition",
          posted: false,
          accepted: false,
          arrival_count_after: null,
        },
      },
      fabric_promotion: null,
      exit_pose: null,
      marker_comparison: null,
    };
    try {
      let stageStart = nowMs();
      const targetDebugStart = nowMs();
      crossing.server_notifications.arrival.posted = true;
      const arrivalPromise = transport
        .postJson(`${targetEndpoint.proxy_base}/portal/arrival`, packet)
        .then(() => {
          crossing.server_notifications.arrival.accepted = true;
          timings.arrival_post_ms = nowMs() - targetDebugStart;
          return transport.getJson(`${targetEndpoint.proxy_base}/debug/state`).catch(() => null);
        })
        .catch((error) => {
          crossing.server_notifications.arrival.accepted = false;
          crossing.server_notifications.arrival.error = error.message;
          timings.arrival_post_ms = nowMs() - targetDebugStart;
          log(`crossing: arrival notification failed (${error.message}); composition continues`);
          return null;
        });
      // Existing phase-history compatibility: this phase marks that the
      // non-load-bearing arrival notification was committed to transport, not
      // that its response may gate visual composition.
      pushCrossingPhase("target_arrival_committed");
      stageStart = nowMs();
      umVerifyOnArrival = await crypto.verifyManifest(packet);
      timings.um_verify_ms = nowMs() - stageStart;
      crossing.um_manifest_verification = umVerifyOnArrival;
      if (umVerifyOnArrival && umVerifyOnArrival.present) {
        log(
          umVerifyOnArrival.verified === true
            ? `crossing: v0.4 UM manifest VERIFIED on arrival (signature verified: true; subject ${umVerifyOnArrival.did_subject || "?"}; keyRef consistency ${(umVerifyOnArrival.checks && umVerifyOnArrival.checks.keyRefConsistency) || "?"})`
            : `crossing: v0.4 UM manifest FAILED verification on arrival (signature verified: false; reason: ${umVerifyOnArrival.reason}) — surfaced, not swallowed`,
        );
      }
      peers.broadcast({
        type: "player-crossing",
        packet,
        handoff_id: packet.handoff_id || null,
        source_location_id: packet.source && packet.source.location_id,
        target_location_id: packet.target && packet.target.location_id,
        arrival_posted: crossing.server_notifications.arrival.accepted,
        at: nowMs(),
      });
      pushCrossingPhase("active_endpoint_switching");
      stageStart = nowMs();
      const promoted = await promoteActiveEndpoint(targetKey, packet);
      timings.promote_ms = nowMs() - stageStart;
      crossing.fabric_promotion = promoted.promotion;
      crossing.destination_scene_source = promoted.destinationSceneSource;
      const host = mutableHost(readHostSnapshot);
      crossing.to = endpointDebug(host.endpoint, host.world);
      crossing.active_endpoint_switched = true;
      pushCrossingPhase("fabric_promoted_to_root");
      const exitPose = deriveFabricExitPose(frameMapping);
      crossing.exit_pose = exitPose;
      const mappedCamera = pendingCameraContinuity && traversedSourceFrame && traversedTargetFrame
        ? mapCameraAcrossCrossing({
            sourceFrame: traversedSourceFrame,
            targetFrame: traversedTargetFrame,
            cameraTransform: pendingCameraContinuity.cameraTransform,
            avatarEntryPosition: pendingCameraContinuity.entry_position,
            avatarEntryYaw: pendingCameraContinuity.entry_yaw,
            avatarExitPosition: clonePosition(exitPose.position, [0, 0, 0]),
            avatarExitYaw: Number(exitPose.rotation_y) || 0,
          })
        : null;
      const crossingYawDelta = crossingYawDeltaRad(traversedSourceFrame, traversedTargetFrame);
      crossing.traversed_edge = {
        source: "packet.avatar_context.portal_frame_transform",
        source_portal_id: traversedSourceFrame ? traversedSourceFrame.portal_id : null,
        target_portal_id: traversedTargetFrame ? traversedTargetFrame.portal_id : null,
        source_location_id: traversedSourceFrame ? traversedSourceFrame.location_id : null,
        target_location_id: traversedTargetFrame ? traversedTargetFrame.location_id : null,
      };
      crossing.heading_continuity = traversedSourceFrame && traversedTargetFrame && crossingYawDelta !== null
        ? {
            source_portal_id: traversedSourceFrame.portal_id || null,
            target_portal_id: traversedTargetFrame.portal_id || null,
            source_frame_yaw_rad: Number(yawFromVector(traversedSourceFrame.forward, 0).toFixed(6)),
            target_frame_yaw_rad: Number(yawFromVector(traversedTargetFrame.forward, 0).toFixed(6)),
            crossing_yaw_delta_rad: Number(crossingYawDelta.toFixed(6)),
            target_into_room_forward: traversedTargetFrame.forward.slice(0, 3),
            entry_rotation_y: pendingCameraContinuity
              ? Number(pendingCameraContinuity.entry_yaw.toFixed(6))
              : null,
            exit_rotation_y: Number((Number(exitPose.rotation_y) || 0).toFixed(6)),
            frames_source: "packet.avatar_context.portal_frame_transform",
          }
        : null;
      crossing.camera_mapping = mappedCamera
        ? {
            ...mappedCamera,
            frame_source: "packet.avatar_context.portal_frame_transform",
            source_portal_id: traversedSourceFrame.portal_id || null,
            target_portal_id: traversedTargetFrame.portal_id || null,
            crossing_yaw_delta_rad: Number(crossingYawDelta.toFixed(6)),
            movement_basis_forward: mappedCamera.forward.slice(0, 3),
            source_camera_transform: {
              position: Array.isArray(pendingCameraContinuity.cameraTransform.position)
                ? pendingCameraContinuity.cameraTransform.position.slice(0, 3)
                : null,
              target: Array.isArray(pendingCameraContinuity.cameraTransform.target)
                ? pendingCameraContinuity.cameraTransform.target.slice(0, 3)
                : null,
              rotation_y: Number(pendingCameraContinuity.cameraTransform.rotation_y) || 0,
            },
            source_avatar_entry_transform: {
              position: pendingCameraContinuity.entry_position.slice(0, 3),
              rotation_y: Number(pendingCameraContinuity.entry_yaw) || 0,
            },
          }
        : null;
      pendingCameraContinuity = null;
      const equippedItems = packet.avatar_context && Array.isArray(packet.avatar_context.equippedItems)
        ? packet.avatar_context.equippedItems
        : assets.defaultEquippedItems();
      const serverAvatar = fromWorld.avatar || {};
      const carriedPose = packet.avatar_context && packet.avatar_context.pose_snapshot;
      const carriedLocomotion =
        (packet.avatar_context && packet.avatar_context.locomotion_state) ||
        (carriedPose && carriedPose.locomotion_state) ||
        null;
      const carriedGrounded = carriedLocomotion ? carriedLocomotion.grounded !== false : true;
      const carriedJumpHeight = carriedLocomotion ? Number(carriedLocomotion.jump_height_m) || 0 : 0;
      const rawFacing =
        (carriedPose && carriedPose.facing_semantics) ||
        (carriedLocomotion && carriedLocomotion.facing_semantics) ||
        "still";
      const carriedFacing = typeof rawFacing === "string" && rawFacing.startsWith("portal_") ? "still" : rawFacing;
      const controls = {
        ...host.controls,
        enabled: true,
        moving: false,
        movement_mode: "idle",
        run_mode: false,
        speed_mps: 0,
        movement_direction: "none",
        last_planar_delta: [0, 0, 0],
        facing_semantics: carriedFacing,
        grounded: carriedGrounded,
        jump_height_m: carriedJumpHeight,
        portal_transition_phase: "none",
        portal_transition_elapsed_s: 0,
      };
      const avatar = {
        avatar_id: serverAvatar.avatar_id || fromWorld.avatar.avatar_id,
        continuity_id: serverAvatar.continuity_id || fromWorld.avatar.continuity_id,
        display_name: serverAvatar.display_name || fromWorld.avatar.display_name,
        position: clonePosition(
          exitPose.position,
          packet.target && packet.target.arrival_position
            ? packet.target.arrival_position
            : host.world.arrival.position,
        ),
        rotation_y: Number(exitPose.rotation_y) || 0,
        source_location_id: packet.source && packet.source.location_id,
        equippedItems,
        avatar_variant: packet.avatar_context.avatar_variant || assets.defaultAvatarVariant,
        pose_continuity: {
          source: "packet.avatar_context.pose_snapshot",
          preserved_facing_semantics: carriedFacing,
          preserved_grounded: carriedGrounded,
          preserved_jump_height_m: roundNumber(carriedJumpHeight, 3),
          captured_rotation_y: carriedPose ? Number(carriedPose.transform && carriedPose.transform.rotation_y) : null,
          applied_rotation_y: Number(exitPose.rotation_y) || 0,
        },
        _provenance: PROVENANCE.LIVE,
      };
      avatar.locomotion = { ...controls, enabled: true };
      transition = null;
      transitionCommitStarted = false;
      rearmRequired = true;
      exitedSinceArrival = false;
      lastPortalSignedDistance = null;
      portalLastCrossingDirection = null;
      portalRuntime = {};
      patchHost({
        phase: HANDOFF_PHASES.ARRIVED,
        handoffId: packet.handoff_id || null,
        avatar,
        avatarMode: "merge",
        controls,
      });
      updatePortalStatus();
      const markerComparison = recordMarkerComparison();
      crossing.marker_comparison = markerComparison;
      // The synchronous crossing listener consumes the traversed portal frames
      // from this profile while it remaps heading/camera at the visual edge.
      playerHandoffProfile = buildPlayerHandoffProfile(packet, exitPose, markerComparison);
      patchHost({ playerHandoffProfile });
      // visual commit: destination state is complete before releasing
      // the source projection. The crossing listener synchronously remaps the
      // camera, publishes/recomposes the destination scene, and rehosts the
      // same rig before this turn can yield to requestAnimationFrame.
      if (visualTransition && typeof visualTransition.commit === "function") {
        visualTransition.commit();
      }
      const visualAtomicityToken = armVisualAtomicityTripwire();
      dispatchCrossing(copiedCrossing(crossing));
      completeVisualAtomicityTripwire(visualAtomicityToken);
      emitState();
      broadcastPlayerPose({ force: true });

      // Remaining non-load-bearing completion begins only after the complete
      // destination visual application. Presence remains ordered and fenced,
      // but no network work can split commit from dispatch/recompose/remap.
      stageStart = nowMs();
      const targetDebug = await arrivalPromise;
      timings.target_debug_wait_ms = nowMs() - stageStart;
      timings.target_debug_total_ms = nowMs() - targetDebugStart;
      crossing.server_notifications.arrival.arrival_count_after =
        targetDebug && targetDebug.session ? targetDebug.session.arrival_count : null;
      if (targetDebug && targetDebug.session) {
        patchHost({ arrivalCount: targetDebug.session.arrival_count });
      }
      stageStart = nowMs();
      const equipmentStatus = await assets.resolveEquipmentItems(equippedItems);
      timings.equipment_resolve_ms = nowMs() - stageStart;
      patchHost({ equipmentStatus });
      const presenceStart = nowMs();
      await presence.departPresence({ base: fromEndpoint.proxy_base, reason: "portal_departure" });
      const destinationRegistration = await presence.registerPresence({ spawnReason: "portal_arrival" });
      const registrationAccepted = destinationRegistration !== null;
      timings.presence_handoff_ms = nowMs() - presenceStart;
      const presenceRegistration = presence.snapshot();
      crossing.presence_registration = {
        accepted: registrationAccepted,
        source_base: fromEndpoint.proxy_base,
        destination_base: targetEndpoint.proxy_base,
        committed_base: presenceRegistration ? presenceRegistration.registered_base || null : null,
      };
      if (registrationAccepted) {
        pushCrossingPhase("destination_arrived");
        crossing.completed_at = nowIso();
        crossing.controls_resume_ms = nowMs() - commitStartMs;
      } else {
        pushCrossingPhase("destination_registration_failed");
        log(`crossing: destination presence registration failed; ownership retained at ${crossing.presence_registration.committed_base || "none"}`);
      }
      if (playerHandoffProfile && playerHandoffProfile.server_switch) {
        playerHandoffProfile.server_switch.transition_phase_history = phaseHistory.slice();
        playerHandoffProfile.server_switch.controls_resume_ms = crossing.controls_resume_ms ?? null;
      }
      patchHost({ playerHandoffProfile });
      handoffInFlight = false;
      timings.step_in_delay_ms = portalPlaneCrossedAtMs != null ? nowMs() - portalPlaneCrossedAtMs : null;
      crossing.timings = { ...timings };
      emitState();
      const finalHost = readHostSnapshot();
      const nav = navigatorDebug();
      log(
        `crossing complete: presence now in ${finalHost.world.location_id} (root fabric ${nav && nav.root_fabric ? nav.root_fabric.container : "?"}); same context marker ${markerComparison && markerComparison.marker_identity_equal ? "IDENTICAL" : "MISMATCH"}; exit pose ${JSON.stringify(exitPose.position)} yaw ${exitPose.rotation_y}`,
      );
    } catch (error) {
      if (crossing) {
        crossing.phase = "failed";
        crossing.error = error.message;
      }
      handoffInFlight = false;
      transitionCommitStarted = false;
      if (visualTransition && typeof visualTransition.abort === "function") {
        visualTransition.abort({ restore: true });
      }
      const recovered = mutableHost(readHostSnapshot);
      if (recovered.controls) {
        recovered.controls.enabled = true;
        recovered.controls.moving = false;
        recovered.controls.portal_transition_phase = "none";
        recovered.controls.portal_transition_elapsed_s = 0;
      }
      patchHost({ phase: HANDOFF_PHASES.IDLE, controls: recovered.controls });
      log(`crossing FAILED: ${error.message}`);
      emitState();
    }
  }

  function buildPlayerHandoffProfile(packet, exitPose, markerComparison) {
    const host = readHostSnapshot();
    const marker = host.playerContextMarker || {};
    const frameMapping = packet.avatar_context && packet.avatar_context.portal_frame_transform;
    const controlled = presence.controlledIdentity();
    const identity = {
      player_id: (packet.avatar_context && packet.avatar_context.player_id) || controlled.player_id,
      client_id: controlled.client_id,
      avatar_id: host.avatar ? host.avatar.avatar_id : null,
      continuity_id: host.avatar ? host.avatar.continuity_id : null,
      display_name: host.avatar ? host.avatar.display_name : null,
    };
    const equippedItems = packet.avatar_context && Array.isArray(packet.avatar_context.equippedItems)
      ? packet.avatar_context.equippedItems
      : [];
    const from = (crossing && crossing.from) || {};
    const to = (crossing && crossing.to) || endpointDebug(host.endpoint, host.world);
    return {
      profile_version: "msf.player-view-handoff.v0.1",
      application_profile: "local_player_view_portal_proof",
      proof_contract: "runtime",
      handoff_id: packet.handoff_id || null,
      capture_timestamp: packet.avatar_context && packet.avatar_context.capture_timestamp,
      issued_at: nowIso(),
      identity,
      source_location: {
        location_id: from.location_id || (packet.source && packet.source.location_id) || null,
        world_id: from.world_id || null,
        session_id: from.session_id || null,
        endpoint_key: from.endpoint_key || null,
        proxy_base: from.proxy_base || null,
        base_url: from.backend_base_url || null,
      },
      target_location: {
        location_id: to.location_id || (packet.target && packet.target.location_id) || null,
        world_id: to.world_id || null,
        session_id: to.session_id || null,
        endpoint_key: to.endpoint_key || null,
        proxy_base: to.proxy_base || null,
        base_url: to.backend_base_url || null,
        arrival_endpoint: `${to.proxy_base || host.base}/portal/arrival`,
      },
      portal: {
        source_portal_id: frameMapping && frameMapping.source_portal_frame
          ? frameMapping.source_portal_frame.portal_id
          : null,
        target_portal_id: frameMapping && frameMapping.target_portal_frame
          ? frameMapping.target_portal_frame.portal_id
          : null,
        source_portal_frame: frameMapping ? frameMapping.source_portal_frame : null,
        target_portal_frame: frameMapping ? frameMapping.target_portal_frame : null,
        entry_local_coordinates: frameMapping ? frameMapping.entry_local_coordinates : null,
        lateral_offset_m: frameMapping ? frameMapping.lateral_offset_m : null,
        exit_offset_m: frameMapping ? frameMapping.exit_offset_m : null,
      },
      player_pose_at_crossing: {
        transform: packet.avatar_context ? packet.avatar_context.transform : null,
        pose_snapshot: packet.avatar_context ? packet.avatar_context.pose_snapshot : null,
        locomotion_state: packet.avatar_context ? packet.avatar_context.locomotion_state : null,
        portal_entry_transform: packet.avatar_context ? packet.avatar_context.portal_entry_transform : null,
        portal_center_transform: packet.avatar_context ? packet.avatar_context.portal_center_transform : null,
        portal_departure_transform: packet.avatar_context ? packet.avatar_context.portal_departure_transform : null,
        portal_exit_transform: packet.avatar_context ? packet.avatar_context.portal_exit_transform : null,
        mapped_exit_transform: frameMapping ? frameMapping.mapped_exit_transform : null,
        mapped_exit_yaw: frameMapping ? frameMapping.exit_yaw_radians : null,
        fabric_derived_exit_pose: exitPose || null,
      },
      camera: host.lastCameraTransform
        ? {
            camera_mode: "orbit_follow",
            camera_transform: {
              position: Array.isArray(host.lastCameraTransform.position)
                ? roundVec3(host.lastCameraTransform.position, 4)
                : null,
              target: Array.isArray(host.lastCameraTransform.target)
                ? roundVec3(host.lastCameraTransform.target, 4)
                : null,
              rotation_y: roundNumber(Number(host.lastCameraTransform.rotation_y) || 0, 6),
              orientation: Array.isArray(host.lastCameraTransform.orientation)
                ? host.lastCameraTransform.orientation.slice(0, 4)
                : null,
            },
          }
        : null,
      preview: previewDebug(),
      server_switch: {
        active_endpoint_before: from.endpoint_key || null,
        active_endpoint_after: host.activeEndpointKey,
        active_proxy_base_before: from.proxy_base || null,
        active_proxy_base_after: host.base,
        active_backend_base_url_before: from.backend_base_url || null,
        active_backend_base_url_after: host.endpoint.backend_base_url,
        active_location_before: from.location_id || null,
        active_location_after: host.world ? host.world.location_id : null,
        active_world_before: from.world_id || null,
        active_world_after: host.world ? host.world.world_id : null,
        preview_promoted_to_active: true,
        promotion_mechanism: crossing ? crossing.fabric_promotion : null,
        same_js_context_marker: {
          marker_id: marker.marker_id || null,
          context_id: marker.context_id || null,
          created_at: marker.created_at || null,
          boot_href: marker.boot_href || null,
          current_href: marker.current_href || null,
          same_marker_after_crossing: marker.same_marker_after_crossing,
          crossing_comparison: markerComparison || marker.crossing_comparison || null,
        },
        transition_phase_history: phaseHistory.slice(),
        window_href_before: marker.boot_href || null,
        window_href_after: markerComparison ? markerComparison.href_after_crossing : null,
        document_navigation_count: markerComparison
          ? markerComparison.navigation_entry_count_after_crossing
          : null,
        active_endpoint_switched: crossing && crossing.active_endpoint_switched === true,
        controls_resume_ms: crossing ? crossing.controls_resume_ms ?? null : null,
      },
      avatar_context: {
        equipment_profile: packet.avatar_context && packet.avatar_context.equipment_profile,
        equippedItems,
        avatar_variant: packet.avatar_context.avatar_variant || assets.defaultAvatarVariant,
      },
      um_shaped_envelope: {
        _claim: "UM-shaped portable user envelope for local validation only; no Universal Manifest conformance claim.",
        subject: identity,
        facets: {
          avatar_equipment: {
            equipment_profile: packet.avatar_context && packet.avatar_context.equipment_profile,
            equippedItems,
          },
          pose: packet.avatar_context ? packet.avatar_context.pose_snapshot : null,
          continuity: {
            continuity_id: identity.continuity_id,
            source_location_id: packet.source ? packet.source.location_id : null,
            target_location_id: packet.target ? packet.target.location_id : null,
            handoff_id: packet.handoff_id || null,
          },
        },
      },
      iwps_query_teleport: iwpsQueryTeleportFromHandoff(packet, {
        query_endpoint: crossing && crossing.server_notifications && crossing.server_notifications.exit_intent
          ? crossing.server_notifications.exit_intent.endpoint
          : null,
        teleport_endpoint: crossing && crossing.server_notifications && crossing.server_notifications.arrival
          ? crossing.server_notifications.arrival.endpoint
          : null,
      }),
      pose_capture: {
        _claim: "the demo's own rich pose/locomotion capture (labeled); IWPS itself has only a single opaque `location`.",
        pose_capture_fields:
          packet.avatar_context && packet.avatar_context.iwps_style_pose_capture
            ? Object.keys(packet.avatar_context.iwps_style_pose_capture)
            : [],
        pose_capture_payload: "last_handoff_payload.avatar_context.iwps_style_pose_capture",
      },
      geopose_shaped_pose:
        packet.avatar_context && packet.avatar_context.geopose_shaped_pose
          ? packet.avatar_context.geopose_shaped_pose
          : geoPoseShapedFromTransform(packet.avatar_context ? packet.avatar_context.transform : null),
      proof_boundary: {
        application_level_handoff: true,
        native_teleportxr_teleport: false,
        first_party_teleportxr_browser_rendering: false,
        standards_conformance: false,
        um_conformance: { ...UM_CONFORMANCE },
        iwps_conformance: { ...IWPS_CONFORMANCE },
        ogc_geopose_conformance: false,
        ogc_geopose_basic_sdu_schema_valid: GEOPOSE_CONFORMANCE.basic_sdu_schema_valid,
        web_of_worlds_conformance: false,
        spatial_fabric_conformance: false,
        c2pa_signed_provenance: false,
        public_demo_readiness: false,
        production_readiness: false,
      },
    };
  }

  function applyDepartureMirror(packet) {
    const host = mutableHost(readHostSnapshot);
    transition = null;
    transitionCommitStarted = false;
    handoffInFlight = false;
    host.controls.enabled = false;
    host.controls.moving = false;
    host.controls.portal_transition_phase = "none";
    host.controls.portal_transition_elapsed_s = 0;
    peers.clearLivePlayerPose();
    patchHost({
      phase: HANDOFF_PHASES.DEPARTED,
      handoffId: packet.handoff_id || null,
      avatar: null,
      equipmentStatus: null,
      lastHandoffDirection:
        (packet.avatar_context && packet.avatar_context.handoff_direction) ||
        `${packet.source && packet.source.location_id}->${packet.target && packet.target.location_id}`,
      lastHandoffPayload: packet,
      lastPosePayload: packet.avatar_context ? packet.avatar_context.iwps_style_pose_capture : null,
      controls: host.controls,
    });
    updatePortalStatus();
    log(`player crossing mirrored: presence departed this world (handoff ${packet.handoff_id || "?"})`);
    emitState();
  }

  async function applyArrivalState(packet, debug) {
    const host = mutableHost(readHostSnapshot);
    const arrivalPosition = Array.isArray(packet.target && packet.target.arrival_position)
      ? clonePosition(packet.target.arrival_position, host.world.arrival.position)
      : host.world.arrival.position.slice();
    const controls = {
      ...host.controls,
      enabled: true,
      moving: false,
      movement_mode: "idle",
      run_mode: false,
      speed_mps: 0,
      movement_direction: "none",
      last_planar_delta: [0, 0, 0],
      facing_semantics: "still",
      grounded: true,
      jump_height_m: 0,
      portal_transition_phase: "none",
      portal_transition_elapsed_s: 0,
    };
    const avatar = {
      avatar_id: debug.avatar.avatar_id,
      continuity_id: debug.avatar.continuity_id,
      display_name: debug.avatar.display_name,
      position: arrivalPosition,
      rotation_y: debug.avatar.transform.rotation_y,
      source_location_id: debug.avatar.handoff_context && debug.avatar.handoff_context.source_location_id,
      equippedItems:
        packet.avatar_context && Array.isArray(packet.avatar_context.equippedItems)
          ? packet.avatar_context.equippedItems
          : [],
      avatar_variant: packet.avatar_context && packet.avatar_context.avatar_variant
        ? packet.avatar_context.avatar_variant
        : assets.defaultAvatarVariant,
      _provenance: PROVENANCE.LIVE,
    };
    avatar.locomotion = { ...controls, enabled: true };
    umVerifyOnArrival = await crypto.verifyManifest(packet);
    if (umVerifyOnArrival && umVerifyOnArrival.present) {
      log(
        umVerifyOnArrival.verified === true
          ? `arrival: v0.4 UM manifest VERIFIED (signature verified: true; subject ${umVerifyOnArrival.did_subject || "?"})`
          : `arrival: v0.4 UM manifest FAILED verification (verified: false; reason: ${umVerifyOnArrival.reason}) — surfaced, not swallowed`,
      );
    }
    transition = null;
    transitionCommitStarted = false;
    rearmRequired = true;
    exitedSinceArrival = false;
    lastPortalSignedDistance = null;
    portalLastCrossingDirection = null;
    portalRuntime = {};
    phaseHistory = [];
    patchHost({
      phase: HANDOFF_PHASES.ARRIVED,
      handoffId: debug.debug.handoff.last_arrival && debug.debug.handoff.last_arrival.handoff_id,
      arrivalCount: debug.session.arrival_count,
      avatar,
      controls,
      lastHandoffDirection:
        packet.avatar_context && packet.avatar_context.handoff_direction
          ? packet.avatar_context.handoff_direction
          : `${packet.source && packet.source.location_id}->${packet.target && packet.target.location_id}`,
      lastHandoffPayload: packet,
      lastPosePayload: packet.avatar_context && packet.avatar_context.iwps_style_pose_capture,
    });
    updatePortalStatus();
    patchHost({ equipmentStatus: await assets.resolveEquipmentItems(avatar.equippedItems) });
    emitState();
    if (host.clientMode === "observer") {
      peers.broadcast({
        type: "player-pose-request",
        client_id: host.clientId,
        location_id: host.world ? host.world.location_id : null,
        at: nowMs(),
      });
    }
  }

  async function applyArrivalMirror(packet) {
    const host = readHostSnapshot();
    if (packet.target && packet.target.location_id && packet.target.location_id !== host.world.location_id) return;
    let debug;
    try {
      debug = await transport.getJson(`${host.base}/debug/state`);
    } catch (error) {
      log(`arrival mirror read failed: ${error.message}`);
      return;
    }
    await applyArrivalState(packet, debug);
    log(`player crossing mirrored: presence arrived in this world (handoff ${packet.handoff_id || "?"}); no duplicate arrival POST`);
  }

  async function applyLegacyArrival(packet) {
    const host = readHostSnapshot();
    const value = packet || lastExitPacket;
    if (!value || !value.handoff_id) {
      log("applyArrival called with no packet");
      return;
    }
    if (value.target && value.target.location_id && value.target.location_id !== host.world.location_id) return;
    try {
      await transport.postJson(`${host.base}/portal/arrival`, value);
    } catch (error) {
      log(`arrival POST failed: ${error.message}`);
      return;
    }
    const debug = await transport.getJson(`${host.base}/debug/state`);
    await applyArrivalState(value, debug);
  }

  function reset(input = {}) {
    const host = mutableHost(readHostSnapshot);
    const startsEmbodied = input.startsEmbodied === true;
    handoffInFlight = false;
    lastAutoHandoffId = null;
    transition = null;
    transitionCommitStarted = false;
    transitionNoticeSent = false;
    portalRuntime = {};
    lastPortalSignedDistance = null;
    portalLastCrossingDirection = null;
    traversalRejectedCount = 0;
    lastTraversalRejection = null;
    phaseHistory = [];
    rearmRequired = false;
    exitedSinceArrival = startsEmbodied;
    portalPlaneCrossedAtMs = null;
    crossingTimings = null;
    lastExitPacket = null;
    pendingCameraContinuity = null;
    crossing = null;
    umSignOnExit = null;
    umVerifyOnArrival = null;
    playerHandoffProfile = null;
    const controls = portalControlReset(host.controls, startsEmbodied, input.reason || "reset");
    patchHost({ controls, playerHandoffProfile: null });
    return controls;
  }

  function debug() {
    return {
      crossing: copiedCrossing(crossing),
      portal_transition: transition
        ? {
            phase: transition.phase,
            elapsed_s: Number(transition.elapsed.toFixed(3)),
            entry_transform: transition.entry_transform,
            entry_portal_local: transition.entry_portal_local,
            portal_frame_mapping: transition.portal_frame_mapping,
            exit_transform: transition.exit_transform,
          }
        : null,
      um_signing: {
        signed_on_exit: umSignOnExit || null,
        verified_on_arrival: umVerifyOnArrival || null,
      },
      player_handoff_profile: playerHandoffProfile,
      visual_atomicity: visualAtomicity
        ? {
            mode: visualAtomicity.mode,
            armed_count: visualAtomicity.armed_count,
            completed_count: visualAtomicity.completed_count,
            violation_count: visualAtomicity.violation_count,
            last: visualAtomicity.last
              ? {
                  ...visualAtomicity.last,
                  observed_boundaries: visualAtomicity.last.observed_boundaries.slice(),
                }
              : null,
          }
        : null,
      in_flight: handoffInFlight,
      transition_commit_started: transitionCommitStarted,
      transition_notice_sent: transitionNoticeSent,
      last_auto_handoff_id: lastAutoHandoffId,
      last_portal_signed_distance: lastPortalSignedDistance,
      last_crossing_direction: portalLastCrossingDirection,
      traversal_rejected_count: traversalRejectedCount,
      last_traversal_rejection: lastTraversalRejection ? { ...lastTraversalRejection } : null,
      rearm_required: rearmRequired,
      exited_since_arrival: exitedSinceArrival,
      phase_history: phaseHistory.slice(),
      timings: crossingTimings ? { ...crossingTimings } : null,
    };
  }

  return Object.freeze({
    activate,
    updatePortalStatus,
    beginTransition,
    stepTransition,
    shouldAutoHandoff,
    markAutoHandoffObserved,
    triggerHandoff,
    inTransition: () => !!transition,
    inFlight: () => handoffInFlight,
    applyLegacyArrival,
    applyDepartureMirror,
    applyArrivalMirror,
    reset,
    crossingDebug: () => copiedCrossing(crossing),
    debug,
  });
}
