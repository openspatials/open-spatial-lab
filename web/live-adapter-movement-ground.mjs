import { createAirportWalkableSurfaceContract, resolveAirportGroundSurface } from "./airport-walkable-surface.mjs";

export function resolveAvatarGround(surface, x, z) {
  if (!surface) {
    return {
      ok: true,
      reason: null,
      query_x_m: Number(x),
      query_z_m: Number(z),
      surface_id: "legacy-world-ground-plane",
      surface_y_m: 0,
      classification: "walkable",
      resolver_source: "legacy_world_ground_plane",
    };
  }
  return resolveAirportGroundSurface(surface, x, z);
}
export function publishGroundSurface(controls, query) {
  if (!controls || !query) return;
  controls.ground_query_ok = query.ok === true;
  controls.ground_query_reason = query.reason || null;
  controls.ground_surface_id = query.surface_id || null;
  controls.ground_y_m = Number.isFinite(query.surface_y_m) ? query.surface_y_m : null;
  controls.logical_ground_y_m = Number.isFinite(query.surface_y_m) ? query.surface_y_m : null;
  controls.rendered_surface_y_m = Number.isFinite(query.surface_y_m) ? query.surface_y_m : null;
  controls.ground_query_xz_m = [query.query_x_m, query.query_z_m];
  controls.ground_resolver_source = query.resolver_source || null;
}
export function restoredAvatarPose(pose, worldAvatar, surface) {
  if (!pose || !Array.isArray(pose.position)) return null;
  const px = Number(pose.position[0]);
  const pz = Number(pose.position[2]);
  if (!Number.isFinite(px) || !Number.isFinite(pz)) return null;
  const ground = resolveAvatarGround(surface, px, pz);
  if (!ground.ok) return null;
  const py = surface
    ? ground.surface_y_m
    : Number.isFinite(Number(pose.position[1])) ? Number(pose.position[1]) : ground.surface_y_m;
  const restored = [px, py, pz];
  const yaw = Number.isFinite(Number(pose.rotation_y))
    ? Number(pose.rotation_y)
    : worldAvatar
      ? worldAvatar.rotation_y
      : 0;
  return { position: restored, yaw, ground };
}
function localWalkWorld(opts, resolved, identity, spawn) {
  return {
    _provenance: identity.provenance,
    role_binding: identity.role,
    location_id: spawn.spatialID,
    world_id: spawn.spatialID,
    session_id: null,
    title: opts.title || "WoW world",
    claim_boundary: resolved.proof_boundary || {
      application_level_handoff: true,
      native_teleportxr_teleport: false,
      first_party_teleportxr_browser_rendering: false,
      standards_conformance: false,
    },
    portal: null,
    portals: [],
    avatar: {
      _provenance: identity.provenance,
      avatar_id: "avatar-local-001",
      continuity_id: "avatar-local-001",
      display_name: "poc-user",
      spawn_position: spawn.position.slice(),
      rotation_y: spawn.yaw,
    },
    arrival: null,
    initial_arrival_count: 0,
  };
}
export function localWalkState(opts, resolved, identity, adoptSurface) {
  const spawn = Array.isArray(opts.spawn) ? opts.spawn : [0, 0, 0, 0];
  const spawnPos = [Number(spawn[0]) || 0, Number(spawn[1]) || 0, Number(spawn[2]) || 0];
  const spawnYaw = Number.isFinite(Number(spawn[3])) ? Number(spawn[3]) : 0;
  const spatialID = opts.spatialID || resolved.spatialID || "wow-world";
  const surface = spatialID === "world-airport-terminal"
    ? createAirportWalkableSurfaceContract(resolved.graph)
    : null;
  adoptSurface(surface);
  if (surface && !surface.ok) {
    throw new Error(`airport walkable-surface contract invalid: ${surface.reason}`);
  }
  const spawnGround = resolveAvatarGround(surface, spawnPos[0], spawnPos[2]);
  if (!spawnGround.ok) throw new Error(`avatar spawn has no classified walkable surface: ${spawnGround.reason}`);
  if (surface) spawnPos[1] = spawnGround.surface_y_m;
  const world = localWalkWorld(opts, resolved, identity, { spatialID, position: spawnPos, yaw: spawnYaw });
  const b = opts.bounds;
  const bounds =
    b && Number.isFinite(Number(b.minX)) && Number.isFinite(Number(b.maxX))
      ? {
          minX: Number(b.minX),
          maxX: Number(b.maxX),
          minZ: Number(b.minZ),
          maxZ: Number(b.maxZ),
        }
      : null;

  return { world, bounds, ground: spawnGround };
}
