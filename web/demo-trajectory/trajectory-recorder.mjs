export const DEMO_TRAJECTORY_SIGNAL = "trajectory-v1";
export const DEMO_TRAJECTORY_SCHEMA = "osl.demo-trajectory.v1";
export const DEMO_TRAJECTORY_TARGET_HZ = 30;

export const DEMO_TRAJECTORY_SEGMENTS = Object.freeze([
  Object.freeze({
    id: "p1-lobby-to-portal-a-preview",
    label: "Player 1 Lobby → Portal A preview",
    start_anchor: Object.freeze({
      id: "lobby-player-1-start",
      label: "Player 1 lobby start",
      expected_location_id: "location-lobby",
    }),
  }),
  Object.freeze({
    id: "p1-portal-a-preview-to-location-a",
    label: "Player 1 Portal A preview → Location A arrival",
    start_anchor: Object.freeze({
      id: "portal-a-preview-stop",
      label: "Player 1 Portal A preview stop",
      expected_location_id: "location-lobby",
    }),
  }),
  Object.freeze({
    id: "p2-lobby-to-portal-b-to-location-b",
    label: "Player 2 Lobby → Portal B → Location B arrival",
    start_anchor: Object.freeze({
      id: "lobby-player-2-start",
      label: "Player 2 lobby start",
      expected_location_id: "location-lobby",
    }),
  }),
  Object.freeze({
    id: "p1-lobby-to-portal-b-peer-view-stop",
    label: "Player 1 Lobby → Portal B peer-view stop",
    start_anchor: Object.freeze({
      id: "lobby-player-1-start",
      label: "Player 1 lobby start",
      expected_location_id: "location-lobby",
    }),
  }),
  Object.freeze({
    id: "p2-remote-pose-side-step",
    label: "Player 2 remote-pose side step",
    start_anchor: Object.freeze({
      id: "location-b-player-2-remote-pose-stop",
      label: "Player 2 Location B remote-pose stop",
      expected_location_id: "location-b",
    }),
  }),
]);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function vector3(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const out = value.slice(0, 3).map(finite);
  return out.every((entry) => entry !== null) ? out : null;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function loopbackHostname(hostname) {
  const value = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

export function demoTrajectoryActivation({ location, role } = {}) {
  if (role !== "player" || !location || !loopbackHostname(location.hostname)) return false;
  const params = new URLSearchParams(location.search || "");
  return params.get("demo_authoring") === DEMO_TRAJECTORY_SIGNAL;
}

function sourceHealth(snapshot) {
  const source = snapshot && snapshot.source_health;
  if (!source) return null;
  return {
    console_error_count: Math.max(0, Number(source.console_error_count) || 0),
    page_error_count: Math.max(0, Number(source.page_error_count) || 0),
  };
}

export function captureTrajectorySample(snapshot, seq, tMs) {
  const debug = snapshot || {};
  const avatar = debug.avatar || {};
  const camera = debug.camera || {};
  const movement = debug.movement || {};
  const locomotion = avatar.locomotion_state || {};
  const portal = debug.portal || {};
  const transition = debug.transition || {};
  const locationId = debug.location_id || debug.active?.location_id || null;
  const position = vector3(avatar.position);
  const cameraPosition = vector3(camera.position);
  const cameraTarget = vector3(camera.target);
  const heading = finite(avatar.rotation_y);
  const azimuth = finite(camera.orbit?.azimuth_rad);
  const polar = finite(camera.orbit?.polar_rad);
  const distance = finite(camera.orbit?.distance_m);

  return {
    seq,
    t_ms: Number(Number(tMs).toFixed(3)),
    location: {
      location_id: locationId,
      world_id: debug.active?.world_id || debug.world_id || null,
      active_endpoint_key: debug.active?.endpoint_key || null,
    },
    avatar: {
      position,
      heading_rad: heading,
      orientation: Array.isArray(avatar.orientation) ? avatar.orientation.slice(0, 4).map(finite) : null,
    },
    camera: {
      mode: camera.view_mode || camera.mode || null,
      position: cameraPosition,
      target: cameraTarget,
      azimuth_rad: azimuth,
      polar_rad: polar,
      distance_m: distance,
    },
    locomotion: {
      moving: locomotion.moving === true || movement.movement_mode === "walk" || movement.movement_mode === "run",
      movement_mode: movement.movement_mode || locomotion.movement_mode || "idle",
      movement_direction: movement.movement_direction || locomotion.movement_direction || "none",
      run_mode: movement.run_mode === true || locomotion.run_mode === true,
      speed_mps: finite(movement.speed_mps ?? locomotion.speed_mps) ?? 0,
      facing_semantics: movement.facing_semantics || locomotion.facing_semantics || "still",
      grounded: movement.grounded !== false && locomotion.grounded !== false,
      keys_down: Array.isArray(movement.keys_down) ? [...movement.keys_down] : [],
    },
    portal: {
      phase: transition.phase || "none",
      nearest_portal_id: portal.nearest_portal_id || null,
      crossing_direction: portal.portal_crossing_direction || "unknown",
      inside_oval_aperture: portal.inside_oval_aperture === true,
      inside_trigger_volume: portal.inside_trigger_volume === true,
    },
    semantic_event_ids: [],
    source_health: sourceHealth(debug),
  };
}

function changedEvents(previous, sample) {
  if (!previous) return [];
  const events = [];
  if (previous.location.location_id !== sample.location.location_id) {
    events.push(["location_changed", sample.location.location_id || "unknown"]);
  }
  if (previous.portal.phase !== sample.portal.phase) {
    events.push(["portal_phase_changed", sample.portal.phase]);
  }
  if (previous.portal.nearest_portal_id !== sample.portal.nearest_portal_id) {
    events.push(["portal_context_changed", sample.portal.nearest_portal_id || "none"]);
  }
  if (previous.locomotion.movement_mode !== sample.locomotion.movement_mode) {
    events.push(["locomotion_changed", sample.locomotion.movement_mode]);
  }
  if (previous.locomotion.movement_direction !== sample.locomotion.movement_direction) {
    events.push(["movement_direction_changed", sample.locomotion.movement_direction]);
  }
  return events;
}

function appendSample(candidate, snapshot, tMs) {
  const sample = captureTrajectorySample(snapshot, candidate.samples.length, tMs);
  const previous = candidate.samples.at(-1) || null;
  for (const [name, value] of changedEvents(previous, sample)) {
    const event = {
      id: `event-${String(candidate.events.length + 1).padStart(4, "0")}`,
      name,
      value,
      sample_seq: sample.seq,
      t_ms: sample.t_ms,
    };
    candidate.events.push(event);
    sample.semantic_event_ids.push(event.id);
  }
  candidate.samples.push(sample);
  return sample;
}

function firstSampleOrigin(sample) {
  return {
    sample_seq: sample.seq,
    location: clone(sample.location),
    avatar: clone(sample.avatar),
    camera: clone(sample.camera),
  };
}

function requiredVector(errors, value, label) {
  if (!vector3(value)) errors.push(`${label} must contain three finite numbers`);
}

export function validateDemoTrajectory(trace) {
  const errors = [];
  if (!trace || typeof trace !== "object") return ["trace must be an object"];
  if (trace.schema_version !== DEMO_TRAJECTORY_SCHEMA) errors.push(`schema_version must be ${DEMO_TRAJECTORY_SCHEMA}`);
  if (!trace.segment?.id || !trace.segment?.label) errors.push("segment id and label are required");
  if (!trace.start_anchor?.id || !trace.start_anchor?.label || !trace.start_anchor?.expected_location_id) {
    errors.push("named start anchor id, label, and expected location are required");
  }
  if (!Array.isArray(trace.samples) || trace.samples.length < 2) {
    errors.push("at least two samples are required");
    return errors;
  }
  if (!trace.origin || trace.origin.sample_seq !== 0) errors.push("origin must reference first sample seq 0");
  if (trace.samples[0].t_ms !== 0) errors.push("first sample t_ms must be 0");
  if (trace.start_anchor?.expected_location_id && trace.samples[0].location?.location_id !== trace.start_anchor.expected_location_id) {
    errors.push("first sample location does not match the selected start anchor");
  }
  let previousTime = -Infinity;
  trace.samples.forEach((sample, index) => {
    if (sample.seq !== index) errors.push(`sample ${index} seq must be contiguous`);
    if (!Number.isFinite(sample.t_ms) || sample.t_ms <= previousTime) errors.push(`sample ${index} t_ms must be strictly monotonic`);
    previousTime = sample.t_ms;
    if (!sample.location?.location_id) errors.push(`sample ${index} location_id is required`);
    requiredVector(errors, sample.avatar?.position, `sample ${index} avatar.position`);
    if (!Number.isFinite(sample.avatar?.heading_rad)) errors.push(`sample ${index} avatar.heading_rad is required`);
    requiredVector(errors, sample.camera?.position, `sample ${index} camera.position`);
    requiredVector(errors, sample.camera?.target, `sample ${index} camera.target`);
    if (!Number.isFinite(sample.camera?.azimuth_rad) || !Number.isFinite(sample.camera?.polar_rad) || !Number.isFinite(sample.camera?.distance_m)) {
      errors.push(`sample ${index} camera orbit fields are required`);
    }
    if (!sample.locomotion?.movement_mode || !Array.isArray(sample.locomotion?.keys_down)) {
      errors.push(`sample ${index} locomotion fields are required`);
    }
    if (!sample.portal || typeof sample.portal.phase !== "string") errors.push(`sample ${index} portal phase is required`);
    if (!Array.isArray(sample.semantic_event_ids)) errors.push(`sample ${index} semantic_event_ids must be an array`);
  });
  const first = trace.samples[0];
  if (JSON.stringify(trace.origin?.location) !== JSON.stringify(first.location)
      || JSON.stringify(trace.origin?.avatar) !== JSON.stringify(first.avatar)
      || JSON.stringify(trace.origin?.camera) !== JSON.stringify(first.camera)) {
    errors.push("origin must be an exact copy of the first sample location/avatar/camera");
  }
  if (!Array.isArray(trace.events) || !trace.events.some((event) => event.name === "start_anchor" && event.value === trace.start_anchor?.id)) {
    errors.push("start_anchor semantic event is required");
  }
  return [...new Set(errors)];
}

export function assertValidDemoTrajectory(trace) {
  const errors = validateDemoTrajectory(trace);
  if (errors.length) throw new Error(`Invalid demo trajectory: ${errors.join("; ")}`);
  return trace;
}

export function createDemoTrajectoryRecorder({
  snapshot,
  persist,
  segments = DEMO_TRAJECTORY_SEGMENTS,
  targetHz = DEMO_TRAJECTORY_TARGET_HZ,
  monotonicNow = () => performance.now(),
  wallNow = () => new Date().toISOString(),
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (handle) => clearTimeout(handle),
  autoSchedule = true,
} = {}) {
  if (typeof snapshot !== "function") throw new TypeError("snapshot function is required");
  if (typeof persist !== "function") throw new TypeError("persist function is required");
  const segmentMap = new Map(segments.map((segment) => [segment.id, segment]));
  const intervalMs = 1000 / targetHz;
  const listeners = new Set();
  const acceptedTakes = [];
  let selectedSegmentId = segments[0]?.id || null;
  let status = "idle";
  let candidate = null;
  let lastAccepted = null;
  let lastError = null;
  let startedMonotonicMs = null;
  let nextTargetMs = null;
  let timer = null;

  function state() {
    return {
      status,
      selected_segment_id: selectedSegmentId,
      selected_segment_label: segmentMap.get(selectedSegmentId)?.label || null,
      elapsed_ms: candidate?.samples.at(-1)?.t_ms || 0,
      sample_count: candidate?.samples.length || 0,
      current_location: candidate?.samples.at(-1)?.location?.location_id || null,
      last_semantic_event: candidate?.events.at(-1) || lastAccepted?.trace?.events?.at(-1) || null,
      accepted_take_count: acceptedTakes.length,
      accepted_takes: acceptedTakes.map((take) => ({ receipt: clone(take.receipt), trace: clone(take.trace) })),
      candidate: clone(candidate),
      last_accepted: lastAccepted ? { receipt: clone(lastAccepted.receipt), trace: clone(lastAccepted.trace) } : null,
      error: lastError,
    };
  }

  function emit() {
    const value = state();
    for (const listener of listeners) listener(value);
  }

  function clearScheduledSample() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  function sampleNow() {
    if (status !== "recording" || !candidate) return null;
    const elapsed = monotonicNow() - startedMonotonicMs;
    const previous = candidate.samples.at(-1);
    if (previous && elapsed <= previous.t_ms) throw new Error("monotonic clock did not advance");
    const sample = appendSample(candidate, snapshot(), elapsed);
    emit();
    return sample;
  }

  function scheduleNextSample() {
    if (!autoSchedule || status !== "recording") return;
    while (nextTargetMs <= monotonicNow()) nextTargetMs += intervalMs;
    timer = schedule(() => {
      timer = null;
      try {
        sampleNow();
        nextTargetMs += intervalMs;
        scheduleNextSample();
      } catch (error) {
        clearScheduledSample();
        status = "error";
        lastError = error instanceof Error ? error.message : String(error);
        emit();
      }
    }, Math.max(0, nextTargetMs - monotonicNow()));
  }

  function setSelectedSegment(segmentId) {
    if (status === "recording") throw new Error("cannot change segment while recording");
    if (!segmentMap.has(segmentId)) throw new Error(`unknown segment: ${segmentId}`);
    selectedSegmentId = segmentId;
    lastError = null;
    if (status === "error") status = lastAccepted ? "accepted" : "idle";
    emit();
    return state();
  }

  function start() {
    if (status === "recording") throw new Error("a trajectory take is already recording");
    const segment = segmentMap.get(selectedSegmentId);
    if (!segment?.start_anchor?.id || !segment.start_anchor.label || !segment.start_anchor.expected_location_id) {
      throw new Error("selected segment is missing a named start anchor");
    }
    lastError = null;
    startedMonotonicMs = monotonicNow();
    nextTargetMs = startedMonotonicMs + intervalMs;
    candidate = {
      schema_version: DEMO_TRAJECTORY_SCHEMA,
      segment: { id: segment.id, label: segment.label },
      start_anchor: clone(segment.start_anchor),
      timing: {
        clock: "performance.now",
        target_hz: targetHz,
        target_interval_ms: Number(intervalMs.toFixed(6)),
      },
      started_at: wallNow(),
      ended_at: null,
      origin: null,
      samples: [],
      events: [{ id: "event-0001", name: "start_anchor", value: segment.start_anchor.id, sample_seq: 0, t_ms: 0 }],
    };
    const first = appendSample(candidate, snapshot(), 0);
    first.semantic_event_ids.push("event-0001");
    candidate.origin = firstSampleOrigin(first);
    if (first.location.location_id !== segment.start_anchor.expected_location_id) {
      const actual = first.location.location_id || "missing";
      candidate = null;
      throw new Error(`start anchor ${segment.start_anchor.id} requires ${segment.start_anchor.expected_location_id}, got ${actual}`);
    }
    status = "recording";
    emit();
    scheduleNextSample();
    return state();
  }

  async function done() {
    if (status !== "recording" || !candidate) throw new Error("no active trajectory take");
    clearScheduledSample();
    const elapsed = monotonicNow() - startedMonotonicMs;
    if (elapsed > candidate.samples.at(-1).t_ms) appendSample(candidate, snapshot(), elapsed);
    candidate.ended_at = wallNow();
    try {
      assertValidDemoTrajectory(candidate);
      const trace = clone(candidate);
      const receipt = await persist(trace);
      const accepted = { trace, receipt: clone(receipt) };
      acceptedTakes.push(accepted);
      lastAccepted = accepted;
      candidate = null;
      status = "accepted";
      lastError = null;
      emit();
      return clone(accepted);
    } catch (error) {
      status = "error";
      lastError = error instanceof Error ? error.message : String(error);
      emit();
      throw error;
    }
  }

  function redo() {
    clearScheduledSample();
    candidate = null;
    status = lastAccepted ? "accepted" : "idle";
    lastError = null;
    emit();
    return start();
  }

  function dispose() {
    clearScheduledSample();
    listeners.clear();
    candidate = null;
  }

  return Object.freeze({
    start,
    done,
    redo,
    dispose,
    sampleNow,
    setSelectedSegment,
    snapshot: state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state());
      return () => listeners.delete(listener);
    },
  });
}
