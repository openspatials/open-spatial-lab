const BOARDING_SCHEMA = "osl.airport-gate-boarding.v1";
const CREDENTIAL_SCHEMA = "osl.local-demo-boarding-credential.v1";
const AIRPORT_LOCATION_ID = "location-airport";
const MOVEMENT_CODES = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "ShiftRight",
]);
const PHASE_ORDER = Object.freeze(["ready", "admitted", "boarding", "completed"]);

export const AIRPORT_BOARDING_SESSION_RULE = Object.freeze({
  persistence: "airport_session_only",
  same_airport_resume: "admission remains active after walking away and resumes on return to Gate A12",
  cancellation: "clear credential and admission; return to ready when still near Gate A12",
  airport_exit: "clear the journey and completion count; re-entry starts unstarted",
  new_session: "page reload or application reset starts unstarted",
  claim_boundary: "local-demo state only; not a ticket, airline connection, identity verification, security clearance, legal travel authorization, or real boarding",
});

function nonEmptyText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function position3(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const position = value.slice(0, 3).map(Number);
  return position.every(Number.isFinite) ? position : null;
}

function planarDistance(position, target) {
  const point = position3(position);
  return point && target ? Math.hypot(point[0] - target[0], point[2] - target[2]) : Number.POSITIVE_INFINITY;
}

/**
 * Normalize the one graph-authored Gate A12 local-demo boarding contract.
 * Invalid metadata fails closed without breaking airport walking.
 */
export function createAirportBoardingContract(airportTerminal) {
  const gate = airportTerminal && airportTerminal.gate && typeof airportTerminal.gate === "object"
    ? airportTerminal.gate
    : null;
  const raw = gate && gate.boarding && typeof gate.boarding === "object" ? gate.boarding : null;
  const errors = [];
  if (!raw) errors.push("gate.boarding is missing");
  const approach = raw && raw.approach && typeof raw.approach === "object" ? raw.approach : {};
  const components = raw && raw.components && typeof raw.components === "object" ? raw.components : {};
  const threshold = raw && raw.threshold && typeof raw.threshold === "object" ? raw.threshold : {};
  const credential = raw && raw.credential && typeof raw.credential === "object" ? raw.credential : {};
  const approachPosition = position3(approach.position_m);
  const thresholdPosition = position3(threshold.center_m);
  const interactionRadius = Number(approach.interaction_radius_m);
  const laneCenterX = Number(components.center_x_m);
  const laneEntryZ = Number(components.entry_z_m);
  const laneHalfWidth = Number(components.half_width_m);
  const thresholdHalfWidth = Number(threshold.half_width_m);
  const flightId = nonEmptyText(raw?.flight_id);
  const flightNumber = nonEmptyText(raw?.flight_number);
  const gateId = nonEmptyText(raw?.gate_id);
  const destinationLabel = nonEmptyText(raw?.destination_label);
  const acceptedValue = nonEmptyText(credential.accepted_value);

  if (raw?.schema !== BOARDING_SCHEMA) errors.push(`boarding schema must be ${BOARDING_SCHEMA}`);
  if (!nonEmptyText(raw?.provenance)) errors.push("boarding provenance is missing");
  if (!flightId) errors.push("flight_id is missing");
  if (!flightNumber) errors.push("flight_number is missing");
  if (!gateId) errors.push("gate_id is missing");
  if (!destinationLabel) errors.push("destination_label is missing");
  if (!approachPosition) errors.push("approach.position_m must contain three finite numbers");
  if (!Number.isFinite(interactionRadius) || interactionRadius <= 0) errors.push("approach.interaction_radius_m must be positive");
  if (!Number.isFinite(laneCenterX)) errors.push("components.center_x_m must be finite");
  if (!Number.isFinite(laneEntryZ)) errors.push("components.entry_z_m must be finite");
  if (!Number.isFinite(laneHalfWidth) || laneHalfWidth <= 0) errors.push("components.half_width_m must be positive");
  if (!thresholdPosition) errors.push("threshold.center_m must contain three finite numbers");
  if (threshold.crossing_direction !== "+z") errors.push("threshold.crossing_direction must be +z");
  if (!Number.isFinite(thresholdHalfWidth) || thresholdHalfWidth <= 0) errors.push("threshold.half_width_m must be positive");
  if (thresholdPosition && Number.isFinite(laneEntryZ) && thresholdPosition[2] <= laneEntryZ) {
    errors.push("threshold must be beyond the boarding-components entry");
  }
  if (credential.schema !== CREDENTIAL_SCHEMA) errors.push(`credential schema must be ${CREDENTIAL_SCHEMA}`);
  if (!acceptedValue) errors.push("credential.accepted_value is missing");
  if (!nonEmptyText(credential.display_hint)) errors.push("credential.display_hint is missing");
  if (!nonEmptyText(raw?.claim_boundary)) errors.push("boarding claim_boundary is missing");

  return Object.freeze({
    ok: errors.length === 0,
    source: "airport_terminal.gate.boarding",
    errors: Object.freeze(errors),
    schema: raw?.schema || null,
    provenance: nonEmptyText(raw?.provenance),
    flight_id: flightId,
    flight_number: flightNumber,
    gate_id: gateId,
    destination_label: destinationLabel,
    gate_label: nonEmptyText(gate?.gate),
    flight_label: nonEmptyText(gate?.flight),
    approach: Object.freeze({
      position_m: Object.freeze((approachPosition || [0, 0, 0]).slice()),
      interaction_radius_m: Number.isFinite(interactionRadius) && interactionRadius > 0 ? interactionRadius : 0,
    }),
    components: Object.freeze({
      center_x_m: Number.isFinite(laneCenterX) ? laneCenterX : 0,
      entry_z_m: Number.isFinite(laneEntryZ) ? laneEntryZ : 0,
      half_width_m: Number.isFinite(laneHalfWidth) && laneHalfWidth > 0 ? laneHalfWidth : 0,
    }),
    threshold: Object.freeze({
      center_m: Object.freeze((thresholdPosition || [0, 0, 0]).slice()),
      crossing_direction: threshold.crossing_direction || null,
      half_width_m: Number.isFinite(thresholdHalfWidth) && thresholdHalfWidth > 0 ? thresholdHalfWidth : 0,
    }),
    credential: Object.freeze({
      schema: credential.schema || null,
      accepted_value: acceptedValue,
      format: nonEmptyText(credential.format),
      display_hint: nonEmptyText(credential.display_hint),
      purpose: nonEmptyText(credential.purpose),
    }),
    session_rule: Object.freeze({ ...AIRPORT_BOARDING_SESSION_RULE, ...(raw?.session_rule || {}) }),
    claim_boundary: nonEmptyText(raw?.claim_boundary) || AIRPORT_BOARDING_SESSION_RULE.claim_boundary,
  });
}

/** Classify a visible, non-secret local-demo credential without external lookup. */
export function classifyAirportBoardingCredential(value, contract) {
  const normalized = nonEmptyText(value);
  if (!normalized) return Object.freeze({ ok: false, state: "missing", reason: "Enter the local-demo credential to continue." });
  const match = /^OSL-DEMO-([A-Z0-9]+)-([A-Z][0-9]+)$/i.exec(normalized);
  if (!match) {
    return Object.freeze({ ok: false, state: "invalid", reason: "That value is not an OSL local-demo boarding credential." });
  }
  const expectedFlight = String(contract?.flight_number || "").replace(/\s+/g, "").toUpperCase();
  const expectedGate = String(contract?.gate_id || "").toUpperCase();
  if (match[1].toUpperCase() !== expectedFlight || match[2].toUpperCase() !== expectedGate) {
    return Object.freeze({ ok: false, state: "wrong_flight", reason: `That local-demo credential is not for ${contract?.flight_number || "this flight"} at Gate ${expectedGate || "A12"}.` });
  }
  if (normalized.toUpperCase() !== String(contract?.credential?.accepted_value || "").toUpperCase()) {
    return Object.freeze({ ok: false, state: "invalid", reason: "That local-demo credential was not issued by this authored Gate A12 demo contract." });
  }
  return Object.freeze({ ok: true, state: "valid", reason: null });
}

/**
 * Own one Gate A12 local-demo journey. Movement, notifications, activity, and
 * authored-scene lifecycle remain delegated through injected existing seams.
 */
export function createAirportBoardingJourneyController({
  isPlayer,
  documentTarget,
  lookup,
  releaseMovement,
  focusFallback,
  showToast,
  publishNotification,
  logger,
  isTypingTarget,
  nowIso = () => new Date().toISOString(),
}) {
  const body = documentTarget.body;
  const listeners = [];
  const state = {
    mounted: false,
    inAirport: false,
    airportSource: null,
    contract: createAirportBoardingContract(null),
    phase: "idle",
    near: false,
    distanceM: null,
    panelOpen: false,
    previousFocus: null,
    credentialInput: "",
    credentialState: "unvalidated",
    rejectionReason: null,
    admitted: false,
    completionCount: 0,
    validationAttempts: 0,
    lastPosition: null,
    lastAction: null,
    lastResetReason: null,
    status: "Approach Gate A12 to begin the local-demo boarding journey.",
    statusTone: "neutral",
    sessionEpoch: 1,
    eventSequence: 0,
  };

  const listen = (target, type, handler) => {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, handler);
    listeners.push([target, type, handler]);
  };
  const setStatus = (message, tone = "neutral") => {
    state.status = message;
    state.statusTone = tone;
  };
  const phaseIndex = (phase) => PHASE_ORDER.indexOf(phase);
  const setText = (id, value) => {
    const element = lookup(id);
    if (element) element.textContent = value;
  };

  function progressSteps() {
    const current = phaseIndex(state.phase);
    return PHASE_ORDER.map((phase, index) => ({
      id: phase,
      label: phase === "ready" ? "Gate ready" : phase[0].toUpperCase() + phase.slice(1),
      done: state.phase === "completed" || (current >= 0 && index <= current),
    }));
  }

  function publish(eventType, title, summary, status = state.phase) {
    const at = nowIso();
    const record = {
      id: `airport-boarding-${state.sessionEpoch}-${++state.eventSequence}-${eventType}`,
      kind: "airport_boarding_local_demo",
      event_type: eventType,
      status,
      title,
      summary,
      created_at: at,
      updated_at: at,
      source: { location_id: AIRPORT_LOCATION_ID, world_id: "world-airport-terminal" },
      destination: {
        location_id: AIRPORT_LOCATION_ID,
        world_id: "world-airport-terminal",
        world_title: `${state.contract.gate_id || "A12"} · ${state.contract.destination_label || "local demo"}`,
      },
      boarding: {
        flight_id: state.contract.flight_id,
        flight_number: state.contract.flight_number,
        gate_id: state.contract.gate_id,
        credential_state: state.credentialState,
        completion_count: state.completionCount,
        physical_threshold_required: true,
      },
      steps: progressSteps(),
      claim_boundary: state.contract.claim_boundary || AIRPORT_BOARDING_SESSION_RULE.claim_boundary,
    };
    if (typeof publishNotification === "function") publishNotification(record);
    if (typeof logger === "function") logger(`airport boarding: ${eventType} · ${summary}`);
    return record;
  }

  function renderProgress() {
    const current = phaseIndex(state.phase);
    for (let index = 0; index < PHASE_ORDER.length; index += 1) {
      const phase = PHASE_ORDER[index];
      const element = lookup(`boarding-progress-${phase}`);
      if (!element) continue;
      const done = state.phase === "completed" || (current >= 0 && index <= current);
      element.dataset.state = done ? "done" : state.phase === "rejected" && phase === "ready" ? "error" : "waiting";
      element.setAttribute("aria-current", phase === state.phase ? "step" : "false");
    }
  }

  function affordanceLabel() {
    if (state.phase === "completed") return `Local-demo boarding complete · ${state.contract.gate_id}`;
    if (state.phase === "boarding") return `Boarding components active · cross the ${state.contract.gate_id} threshold`;
    if (state.phase === "admitted") return `Admitted · walk through the ${state.contract.gate_id} boarding components`;
    if (state.phase === "rejected") return `Credential rejected · correct and retry at ${state.contract.gate_id}`;
    return `Board ${state.contract.flight_number || "local-demo flight"} at ${state.contract.gate_id || "A12"} · E`;
  }

  function render() {
    const activeJourney = state.admitted || state.phase === "boarding" || state.phase === "completed";
    const affordance = lookup("boarding-journey-affordance");
    const visible = !!(isPlayer && state.inAirport && state.contract.ok && (state.near || activeJourney));
    if (affordance) {
      affordance.hidden = !visible;
      affordance.disabled = false;
      affordance.textContent = affordanceLabel();
      affordance.setAttribute("aria-expanded", String(state.panelOpen));
      affordance.setAttribute("aria-label", `${affordanceLabel()}. Local demo only; not a real ticket or boarding authorization.`);
    }
    const panel = lookup("boarding-journey-panel");
    if (panel) panel.hidden = !state.panelOpen;
    setText("boarding-journey-title", `${state.contract.gate_id || "A12"} · ${state.contract.flight_number || "Local demo flight"}`);
    setText("boarding-journey-meta", `${state.contract.destination_label || "Destination label unavailable"} · graph-authored local demo`);
    setText("boarding-credential-hint", state.contract.credential.display_hint
      ? `Visible local-demo value: ${state.contract.credential.display_hint}`
      : "The authored local-demo credential is unavailable.");
    const credential = lookup("boarding-credential-input");
    if (credential) {
      // A state observation can render between the browser mutating a focused
      // input and dispatching its input event. Preserve that in-flight DOM
      // value; the input handler will reconcile it into controller state.
      const preservesFocusedEdit = state.panelOpen
        && documentTarget.activeElement === credential
        && !state.admitted
        && state.phase !== "boarding"
        && state.phase !== "completed";
      if (!preservesFocusedEdit && credential.value !== state.credentialInput) {
        credential.value = state.credentialInput;
      }
      credential.disabled = state.admitted || state.phase === "boarding" || state.phase === "completed";
      credential.setAttribute("aria-invalid", String(state.phase === "rejected"));
      credential.setAttribute("aria-describedby", "boarding-credential-hint boarding-journey-status");
    }
    const validate = lookup("btn-boarding-validate");
    if (validate) validate.disabled = !state.contract.ok || state.admitted || state.phase === "boarding" || state.phase === "completed";
    const cancel = lookup("btn-boarding-cancel");
    if (cancel) cancel.hidden = state.phase === "completed";
    const status = lookup("boarding-journey-status");
    if (status) {
      status.textContent = state.status;
      status.dataset.state = state.statusTone;
    }
    renderProgress();
    body.setAttribute("data-airport-boarding-phase", state.phase);
    body.setAttribute("data-airport-boarding-open", String(state.panelOpen));
    body.setAttribute("data-airport-boarding-completion-count", String(state.completionCount));
    body.setAttribute("data-airport-boarding-credential", state.credentialState);
    if (state.near) {
      body.setAttribute("data-airport-boarding-nearby", state.contract.gate_id || "A12");
      body.setAttribute("data-airport-boarding-distance", state.distanceM?.toFixed(2) || "0.00");
    } else {
      body.removeAttribute("data-airport-boarding-nearby");
      body.removeAttribute("data-airport-boarding-distance");
    }
  }

  function restoreFocus(reason) {
    const fallback = typeof focusFallback === "function" ? focusFallback() : null;
    const preferred = reason === "left_range" || reason === "airport_exit" || reason === "dispose" || reason === "admitted"
      ? fallback
      : state.previousFocus;
    for (const target of [preferred, fallback]) {
      if (!target || typeof target.focus !== "function" || target.hidden === true) continue;
      try {
        target.focus();
        return true;
      } catch {}
    }
    return false;
  }

  function closePanel(reason = "close") {
    const wasOpen = state.panelOpen;
    state.panelOpen = false;
    state.lastAction = `close:${reason}`;
    if (typeof releaseMovement === "function") releaseMovement();
    render();
    if (wasOpen) restoreFocus(reason);
    state.previousFocus = null;
    return debug();
  }

  function open(source = "pointer") {
    const activeJourney = state.admitted || state.phase === "boarding" || state.phase === "completed";
    if (!isPlayer || !state.inAirport || !state.contract.ok || (!state.near && !activeJourney)) return debug();
    if (!state.panelOpen) {
      state.previousFocus = documentTarget.activeElement && documentTarget.activeElement !== body
        ? documentTarget.activeElement
        : lookup("boarding-journey-affordance");
    }
    state.panelOpen = true;
    state.lastAction = `open:${source}`;
    if (typeof releaseMovement === "function") releaseMovement();
    if (!state.admitted && state.phase !== "completed") {
      setStatus(
        state.phase === "rejected"
          ? state.rejectionReason
          : `Enter the visible local-demo credential for ${state.contract.flight_number} at Gate ${state.contract.gate_id}.`,
        state.phase === "rejected" ? "error" : "neutral",
      );
    }
    render();
    (state.admitted || state.phase === "completed"
      ? lookup("btn-boarding-close")
      : lookup("boarding-credential-input"))?.focus?.();
    return debug();
  }

  function setCredential(value) {
    state.credentialInput = String(value ?? "");
    if (state.phase === "rejected") {
      state.phase = "ready";
      state.credentialState = "unvalidated";
      state.rejectionReason = null;
      setStatus("Credential updated. Validate again when ready.", "neutral");
    }
    state.lastAction = "credential:edit";
    render();
    return debug();
  }

  function reject(classification) {
    state.phase = "rejected";
    state.credentialState = classification.state;
    state.rejectionReason = classification.reason;
    state.admitted = false;
    state.validationAttempts += 1;
    state.lastAction = `reject:${classification.state}`;
    setStatus(`${classification.reason} Correct the value and retry, or cancel to resume movement.`, "error");
    render();
    lookup("boarding-credential-input")?.focus?.();
    publish(`credential_rejected_${classification.state}`, "Local-demo credential rejected", classification.reason, "rejected");
    if (typeof showToast === "function") showToast("Credential rejected", `${classification.reason} Local demo only.`, "failed");
    return { ok: false, credential_state: classification.state, state: debug() };
  }

  function validate() {
    if (!state.panelOpen || !state.contract.ok || state.admitted || state.phase === "completed") {
      return { ok: false, credential_state: state.credentialState, state: debug() };
    }
    const classification = classifyAirportBoardingCredential(state.credentialInput, state.contract);
    if (!classification.ok) return reject(classification);
    state.phase = "admitted";
    state.credentialState = "valid";
    state.rejectionReason = null;
    state.admitted = true;
    state.validationAttempts += 1;
    state.lastAction = "credential:admitted";
    setStatus("Admitted in local-demo state. Walk through the marked Gate A12 components and physically cross the yellow threshold.", "success");
    publish("admitted", "Gate A12 local-demo admission", "Credential matched the graph-authored local-demo flight; physical threshold crossing is still required.", "admitted");
    if (typeof showToast === "function") showToast("Local-demo admission ready", "Walk through Gate A12; this is not a real ticket or authorization.", "arrived");
    closePanel("admitted");
    return { ok: true, credential_state: "valid", state: debug() };
  }

  function complete() {
    if (!state.admitted || state.completionCount > 0 || state.phase === "completed") return false;
    state.phase = "completed";
    state.completionCount = 1;
    state.lastAction = "physical_threshold:completed";
    setStatus("Gate A12 local-demo journey completed once after physical threshold crossing. No real boarding occurred.", "success");
    publish("completed", "Gate A12 local-demo journey complete", "Avatar physically crossed the authored boarding threshold after admission; no real boarding occurred.", "completed");
    if (typeof showToast === "function") showToast("Local-demo boarding complete", "Physical Gate A12 threshold crossed once · no real boarding occurred", "arrived");
    render();
    return true;
  }

  function cancel(reason = "cancelled") {
    if (state.phase === "completed") return { ok: true, unchanged: true, state: debug() };
    const shouldPublish = state.phase !== "idle" || state.credentialInput.length > 0;
    state.sessionEpoch += 1;
    state.eventSequence = 0;
    state.phase = state.near && state.contract.ok ? "ready" : "idle";
    state.credentialInput = "";
    state.credentialState = "unvalidated";
    state.rejectionReason = null;
    state.admitted = false;
    state.completionCount = 0;
    state.validationAttempts = 0;
    state.lastAction = `reset:${reason}`;
    state.lastResetReason = reason;
    setStatus(
      state.phase === "ready"
        ? "Journey cancelled. Gate A12 is ready for a new local-demo credential."
        : "Journey cancelled. Approach Gate A12 to start again.",
      "neutral",
    );
    closePanel(reason);
    if (shouldPublish) publish("cancelled", "Gate A12 local-demo journey cancelled", "Credential and admission state cleared; movement is available.", state.phase);
    return { ok: true, unchanged: false, state: debug() };
  }

  function resetJourney(reason, { keepAirport = true, publishReset = true } = {}) {
    const hadState = state.phase !== "idle" || state.admitted || state.completionCount > 0 || state.credentialInput.length > 0;
    const oldContract = state.contract;
    state.sessionEpoch += 1;
    state.eventSequence = 0;
    state.phase = "idle";
    state.near = false;
    state.distanceM = null;
    state.panelOpen = false;
    state.credentialInput = "";
    state.credentialState = "unvalidated";
    state.rejectionReason = null;
    state.admitted = false;
    state.completionCount = 0;
    state.validationAttempts = 0;
    state.lastPosition = null;
    state.lastAction = `reset:${reason}`;
    state.lastResetReason = reason;
    if (!keepAirport) {
      state.inAirport = false;
      state.airportSource = null;
      state.contract = createAirportBoardingContract(null);
    }
    setStatus(
      reason === "airport_exit"
        ? "Airport exit cleared the Gate A12 local-demo journey. Re-entry starts unstarted."
        : "New local-demo session started. Approach Gate A12 to begin.",
      "neutral",
    );
    if (typeof releaseMovement === "function") releaseMovement();
    restoreFocus(reason);
    state.previousFocus = null;
    if (publishReset && hadState && oldContract.ok) {
      state.contract = oldContract;
      publish(`${reason}_reset`, "Gate A12 local-demo journey reset", state.status, "idle");
      if (!keepAirport) state.contract = createAirportBoardingContract(null);
    }
    render();
    return debug();
  }

  function observe({ locationId, avatarPosition, airportTerminal }) {
    const isAirport = isPlayer && locationId === AIRPORT_LOCATION_ID;
    if (!isAirport) {
      if (state.inAirport || state.phase !== "idle") resetJourney("airport_exit", { keepAirport: false });
      else render();
      return debug();
    }

    state.inAirport = true;
    if (state.airportSource !== airportTerminal) {
      state.airportSource = airportTerminal;
      state.contract = createAirportBoardingContract(airportTerminal);
    }
    const position = position3(avatarPosition);
    const previous = state.lastPosition;
    state.distanceM = state.contract.ok ? planarDistance(position, state.contract.approach.position_m) : null;
    state.near = state.contract.ok && state.distanceM <= state.contract.approach.interaction_radius_m;

    if (!state.contract.ok) {
      state.phase = "idle";
      state.admitted = false;
      setStatus(`Gate A12 local-demo contract unavailable: ${state.contract.errors.join("; ")}`, "error");
      if (state.panelOpen) closePanel("contract_invalid");
    } else if (state.admitted && state.phase !== "completed" && position) {
      const insideLane = Math.abs(position[0] - state.contract.components.center_x_m) <= state.contract.components.half_width_m;
      if (insideLane && position[2] >= state.contract.components.entry_z_m && state.phase === "admitted") {
        state.phase = "boarding";
        state.lastAction = "physical_lane:boarding";
        setStatus("Inside the Gate A12 local-demo boarding components. Continue forward across the yellow physical threshold.", "success");
        publish("boarding", "Gate A12 boarding components entered", "Avatar entered the authored components after local-demo admission; threshold crossing remains required.", "boarding");
      }
      const crossedThreshold = previous
        && previous[2] < state.contract.threshold.center_m[2]
        && position[2] >= state.contract.threshold.center_m[2]
        && Math.abs(position[0] - state.contract.threshold.center_m[0]) <= state.contract.threshold.half_width_m;
      if (crossedThreshold) complete();
    } else if (!state.admitted && state.phase !== "completed") {
      if (state.near && state.phase === "idle") {
        state.phase = "ready";
        state.lastAction = "approach:ready";
        setStatus(`Gate ${state.contract.gate_id} is ready. Enter the visible local-demo credential to request admission.`, "neutral");
        publish("ready", "Gate A12 local-demo journey ready", `${state.contract.flight_number} to ${state.contract.destination_label} is available only as graph-authored local-demo state.`, "ready");
      } else if (!state.near && (state.phase === "ready" || state.phase === "rejected")) {
        state.phase = "idle";
        state.credentialInput = "";
        state.credentialState = "unvalidated";
        state.rejectionReason = null;
        setStatus("Approach Gate A12 to begin the local-demo boarding journey.", "neutral");
        if (state.panelOpen) closePanel("left_range");
      }
    }
    state.lastPosition = position ? position.slice() : null;
    render();
    return debug();
  }

  function onKeyDown(event) {
    if (state.panelOpen) {
      if (MOVEMENT_CODES.has(event.code)) {
        const typing = typeof isTypingTarget === "function" && isTypingTarget(event.target);
        event.stopPropagation?.();
        if (!typing && !(event.code === "Space" && event.target?.tagName?.toLowerCase?.() === "button")) {
          event.preventDefault?.();
        }
        if (typeof releaseMovement === "function") releaseMovement();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault?.();
        event.stopPropagation?.();
        closePanel("escape");
      } else if (event.key === "Enter" && event.target === lookup("boarding-credential-input")) {
        event.preventDefault?.();
        validate();
      }
      return;
    }
    const typing = typeof isTypingTarget === "function" && isTypingTarget(event.target);
    if ((event.code === "KeyE" || String(event.key).toLowerCase() === "e") && !event.repeat && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault?.();
      open("keyboard");
    }
  }

  function onKeyUp(event) {
    if (!state.panelOpen || !MOVEMENT_CODES.has(event.code)) return;
    event.stopPropagation?.();
    if (!(event.code === "Space" && event.target?.tagName?.toLowerCase?.() === "button")) event.preventDefault?.();
    if (typeof releaseMovement === "function") releaseMovement();
  }

  function debug() {
    return {
      mounted: state.mounted,
      in_airport: state.inAirport,
      contract_ok: state.contract.ok,
      contract_source: state.contract.source,
      contract_errors: state.contract.errors.slice(),
      provenance: state.contract.provenance,
      flight_id: state.contract.flight_id,
      flight_number: state.contract.flight_number,
      gate_id: state.contract.gate_id,
      destination_label: state.contract.destination_label,
      approach_position_m: state.contract.approach.position_m.slice(),
      interaction_radius_m: state.contract.approach.interaction_radius_m,
      components: { ...state.contract.components },
      threshold: { ...state.contract.threshold, center_m: state.contract.threshold.center_m.slice() },
      phase: state.phase,
      near_gate: state.near,
      distance_m: state.distanceM === null ? null : Number(state.distanceM.toFixed(3)),
      panel_open: state.panelOpen,
      credential_state: state.credentialState,
      credential_length: state.credentialInput.length,
      rejection_reason: state.rejectionReason,
      admitted: state.admitted,
      completion_count: state.completionCount,
      validation_attempts: state.validationAttempts,
      last_position: state.lastPosition ? state.lastPosition.slice() : null,
      last_action: state.lastAction,
      last_reset_reason: state.lastResetReason,
      status: state.status,
      status_tone: state.statusTone,
      listener_count: listeners.length,
      notification_sequence: state.eventSequence,
      session_epoch: state.sessionEpoch,
      session_rule: state.contract.session_rule,
      claim_boundary: state.contract.claim_boundary || AIRPORT_BOARDING_SESSION_RULE.claim_boundary,
    };
  }

  function mount() {
    if (state.mounted) return controller;
    state.mounted = true;
    listen(lookup("boarding-journey-affordance"), "click", () => open("pointer"));
    listen(lookup("btn-boarding-close"), "click", () => closePanel("button"));
    listen(lookup("btn-boarding-cancel"), "click", () => cancel("cancelled"));
    listen(lookup("btn-boarding-validate"), "click", () => validate());
    listen(lookup("boarding-credential-input"), "input", (event) => setCredential(event.target?.value || ""));
    listen(documentTarget, "keydown", onKeyDown);
    listen(documentTarget, "keyup", onKeyUp);
    render();
    return controller;
  }

  function dispose() {
    if (state.panelOpen) closePanel("dispose");
    for (const [target, type, handler] of listeners.splice(0)) target.removeEventListener(type, handler);
    state.mounted = false;
    state.inAirport = false;
    state.airportSource = null;
    state.contract = createAirportBoardingContract(null);
    state.phase = "idle";
    state.near = false;
    state.distanceM = null;
    state.panelOpen = false;
    state.credentialInput = "";
    state.credentialState = "unvalidated";
    state.rejectionReason = null;
    state.admitted = false;
    state.completionCount = 0;
    state.lastPosition = null;
    body.removeAttribute("data-airport-boarding-phase");
    body.removeAttribute("data-airport-boarding-open");
    body.removeAttribute("data-airport-boarding-completion-count");
    body.removeAttribute("data-airport-boarding-credential");
    body.removeAttribute("data-airport-boarding-nearby");
    body.removeAttribute("data-airport-boarding-distance");
    const affordance = lookup("boarding-journey-affordance");
    const panel = lookup("boarding-journey-panel");
    if (affordance) affordance.hidden = true;
    if (panel) panel.hidden = true;
    return controller;
  }

  const driver = () => Object.freeze({
    open: () => open("driver"),
    close: closePanel,
    setCredential,
    validate,
    cancel,
    observe,
    reset: (reason = "new_session") => resetJourney(reason, { keepAirport: true }),
    state: debug,
  });
  const controller = Object.freeze({
    mount,
    dispose,
    observe,
    open,
    close: closePanel,
    setCredential,
    validate,
    cancel,
    reset: (reason = "new_session") => resetJourney(reason, { keepAirport: true }),
    debug,
    driver,
  });
  return controller;
}

export default {
  AIRPORT_BOARDING_SESSION_RULE,
  classifyAirportBoardingCredential,
  createAirportBoardingContract,
  createAirportBoardingJourneyController,
};
