/**
 * Pure airport walkable-surface contract shared by scene presentation and
 * local-avatar grounding. Only fixture entries explicitly classified as
 * `walkable` are candidates; all other scene geometry is excluded by design.
 */

const CONTRACT_SCHEMA = "osl.airport-walkable-surface.v1";
const QUERY_EPSILON_M = 1e-9;

function terminalDefinition(graph) {
  const raw = graph && graph.nodes;
  const nodes = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : [];
  const node = nodes.find(
    (entry) => entry?.webofworlds_extension?.airport_terminal
  );
  return node?.webofworlds_extension?.airport_terminal || null;
}

function finiteVec3(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const parsed = value.map(Number);
  return parsed.every(Number.isFinite) ? parsed : null;
}

function normalizeSurface(surface, index) {
  if (!surface || typeof surface !== "object") return null;
  const center = finiteVec3(surface.center_m);
  const size = finiteVec3(surface.size_m);
  if (
    typeof surface.surface_id !== "string" ||
    !surface.surface_id ||
    typeof surface.classification !== "string" ||
    surface.shape !== "box" ||
    !center ||
    !size ||
    size.some((value) => value <= 0)
  ) {
    return null;
  }
  return Object.freeze({
    surface_id: surface.surface_id,
    classification: surface.classification,
    shape: "box",
    center_m: Object.freeze(center),
    size_m: Object.freeze(size),
    render_material: typeof surface.render_material === "string" ? surface.render_material : null,
    priority: Number.isFinite(Number(surface.priority)) ? Number(surface.priority) : 0,
    source_index: index,
    top_y_m: center[1] + size[1] / 2,
  });
}

/**
 * Parse the airport terminal's authored surface declarations fail-closed.
 * Invalid/missing declarations produce an unusable contract rather than a
 * guessed y=0 plane.
 */
export function createAirportWalkableSurfaceContract(graph) {
  const definition = terminalDefinition(graph);
  const declared = Array.isArray(definition?.walkable_surfaces)
    ? definition.walkable_surfaces
    : [];
  const parsed = declared.map(normalizeSurface);
  const invalidCount = parsed.filter((surface) => !surface).length;
  const surfaces = parsed.filter(Boolean);
  const walkable = surfaces.filter((surface) => surface.classification === "walkable");
  const duplicateIds = surfaces
    .map((surface) => surface.surface_id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  const ok = !!definition && declared.length > 0 && invalidCount === 0 && walkable.length > 0 && duplicateIds.length === 0;
  return Object.freeze({
    schema: CONTRACT_SCHEMA,
    ok,
    source: "airport_terminal.walkable_surfaces",
    resolver: "classified_box_top_at_current_xz",
    fallback: "fail_closed_retain_last_valid_xz",
    surfaces: Object.freeze(surfaces),
    walkable_surface_count: walkable.length,
    invalid_surface_count: invalidCount,
    duplicate_surface_ids: Object.freeze([...new Set(duplicateIds)]),
    reason: ok
      ? null
      : !definition
        ? "airport_terminal_definition_missing"
        : declared.length === 0
          ? "walkable_surfaces_missing"
          : invalidCount > 0
            ? "walkable_surface_invalid"
            : duplicateIds.length > 0
              ? "walkable_surface_id_duplicate"
              : "walkable_surface_classification_missing",
  });
}

/** Resolve the highest explicitly walkable box top containing the current X/Z. */
export function resolveAirportGroundSurface(contract, x, z) {
  const queryX = Number(x);
  const queryZ = Number(z);
  if (!contract?.ok || !Number.isFinite(queryX) || !Number.isFinite(queryZ)) {
    return Object.freeze({
      ok: false,
      reason: !contract?.ok ? contract?.reason || "walkable_surface_contract_invalid" : "ground_query_non_finite",
      query_x_m: Number.isFinite(queryX) ? queryX : null,
      query_z_m: Number.isFinite(queryZ) ? queryZ : null,
      surface_id: null,
      surface_y_m: null,
      resolver_source: contract?.source || "airport_terminal.walkable_surfaces",
    });
  }
  const matches = contract.surfaces
    .filter((surface) => {
      if (surface.classification !== "walkable" || surface.shape !== "box") return false;
      const halfX = surface.size_m[0] / 2;
      const halfZ = surface.size_m[2] / 2;
      return (
        queryX >= surface.center_m[0] - halfX - QUERY_EPSILON_M &&
        queryX <= surface.center_m[0] + halfX + QUERY_EPSILON_M &&
        queryZ >= surface.center_m[2] - halfZ - QUERY_EPSILON_M &&
        queryZ <= surface.center_m[2] + halfZ + QUERY_EPSILON_M
      );
    })
    .sort((a, b) =>
      b.top_y_m - a.top_y_m ||
      b.priority - a.priority ||
      a.surface_id.localeCompare(b.surface_id) ||
      a.source_index - b.source_index
    );
  const selected = matches[0] || null;
  return Object.freeze(selected
    ? {
        ok: true,
        reason: null,
        query_x_m: queryX,
        query_z_m: queryZ,
        surface_id: selected.surface_id,
        surface_y_m: selected.top_y_m,
        classification: selected.classification,
        resolver_source: contract.source,
      }
    : {
        ok: false,
        reason: "outside_classified_walkable_surface",
        query_x_m: queryX,
        query_z_m: queryZ,
        surface_id: null,
        surface_y_m: null,
        resolver_source: contract.source,
      });
}

/**
 * Integrate one vertical-motion tick relative to a resolved local ground Y.
 * Grounded state is snapped to that absolute surface each tick; airborne state
 * retains free motion until it crosses that surface, never a hard-coded zero.
 */
export function integrateAirportVerticalMotion({
  position_y_m,
  ground_y_m,
  velocity_y_mps,
  grounded,
  jump_requested,
  delta_seconds,
  jump_speed_mps,
  gravity_mps2,
}) {
  const groundY = Number(ground_y_m);
  const dt = Number(delta_seconds);
  if (!Number.isFinite(groundY) || !Number.isFinite(dt) || dt < 0) {
    throw new TypeError("airport vertical integration requires finite ground_y_m and non-negative delta_seconds");
  }
  let y = Number.isFinite(Number(position_y_m)) ? Number(position_y_m) : groundY;
  let velocity = Number.isFinite(Number(velocity_y_mps)) ? Number(velocity_y_mps) : 0;
  let isGrounded = grounded !== false;
  if (isGrounded) y = groundY;
  if (jump_requested === true && isGrounded) {
    velocity = Number(jump_speed_mps) || 0;
    isGrounded = false;
  }
  if (!isGrounded) {
    velocity -= (Number(gravity_mps2) || 0) * dt;
    y += velocity * dt;
    if (y <= groundY) {
      y = groundY;
      velocity = 0;
      isGrounded = true;
    }
  }
  return Object.freeze({
    position_y_m: y,
    velocity_y_mps: velocity,
    grounded: isGrounded,
    jump_height_m: Math.max(0, y - groundY),
    ground_y_m: groundY,
  });
}

export default {
  createAirportWalkableSurfaceContract,
  resolveAirportGroundSurface,
  integrateAirportVerticalMotion,
};
