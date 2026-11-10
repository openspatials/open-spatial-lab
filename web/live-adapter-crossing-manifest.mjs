import { buildAndSignManifest as umBuildAndSignManifest, verifyManifestSignatureDetailed as umVerifyManifestSignatureDetailed } from "./manifest/um-manifest-emitter.mjs";
import { makeAvatarDefinition as umMakeAvatarDefinition, makeLoadingPointer as umMakeLoadingPointer } from "./manifest/interfaces.mjs";

export function crossingStateFromPacket(packet, world, defaultAvatarVariant) {
  const ctx = (packet && packet.avatar_context) || {};
  const continuityId =
    (world && world.avatar && world.avatar.continuity_id) ||
    (packet && packet.source && packet.source.continuity_id) ||
    "avatar-local-001";
  const handoffId = (packet && packet.handoff_id) || null;
  const sourceLocationId =
    (packet && packet.source && packet.source.location_id) ||
    (ctx.source_location_id) ||
    (world && world.location_id) ||
    null;
  const targetLocationId =
    (packet && packet.target && packet.target.location_id) || ctx.target_location_id || null;
  const equippedItems = Array.isArray(ctx.equippedItems) ? ctx.equippedItems : [];
  const state = {
    continuityId,
    handoffId,
    sourceLocationId,
    targetLocationId,
    avatar: umMakeAvatarDefinition({
      avatarId: (world && world.avatar && world.avatar.avatar_id) || continuityId || "avatar",
      variant: ctx.avatar_variant || defaultAvatarVariant,
      displayName: (world && world.avatar && world.avatar.display_name) || null,
      equipmentProfile: ctx.equipment_profile || null,
      equippedItems,
      poseRef: "avatar_context.geopose_shaped_pose",
    }),
  };
  const destUrl =
    (packet && packet.target && (packet.target.base_url || packet.target.destination_url)) || null;
  if (destUrl) {
    state.loading = umMakeLoadingPointer({
      target: destUrl,
      pointerId: `loading-${handoffId || continuityId || "crossing"}`,
      label: "destination loading target",
    });
  }
  return state;
}

export async function signManifestOntoPacket(packet, world, transport, defaultAvatarVariant) {
  if (!packet || typeof packet !== "object") return null;
  try {
    const state = crossingStateFromPacket(packet, world, defaultAvatarVariant);
    const { manifest, signed, didKey } = await umBuildAndSignManifest(state, { bindDidSubject: true });
    if (!signed || !manifest || !manifest.signature || !manifest.signature.value) {
      return { signed: false, error: "emitter did not return a signed manifest" };
    }
    packet.avatar_context = packet.avatar_context || {};
    packet.avatar_context.um_manifest_v04 = manifest;

    return {
      signed: true,
      standard: "Universal Manifest v0.4",
      signature_profile: "A (Ed25519 + JCS-RFC8785)",
      did_subject: didKey || manifest.subject || null,
      key_ref: manifest.signature.keyRef || null,
      manifest_id: manifest["@id"] || null,
      um_conformance_claimed: false,
      note: "signed on exit; verified on arrival. Schema-valid v0.4 + Signature Profile A; NOT evaluator-conformant.",
    };
  } catch (e) {
    return { signed: false, error: (e && e.message) || "sign-on-exit threw" };
  }
}

export async function verifyManifestFromPacket(packet) {
  const manifest =
    packet && packet.avatar_context && packet.avatar_context.um_manifest_v04
      ? packet.avatar_context.um_manifest_v04
      : null;
  if (!manifest) {
    return { present: false, verified: null, reason: "no-signed-manifest-in-packet" };
  }
  try {
    const report = await umVerifyManifestSignatureDetailed(manifest);
    return {
      present: true,
      verified: report.ok === true,
      reason: report.reason,
      checks: report.checks || {},
      did_subject: manifest.subject || null,
      key_ref: manifest.signature && manifest.signature.keyRef ? manifest.signature.keyRef : null,
      manifest_id: manifest["@id"] || null,
      handoff_id: (packet && packet.handoff_id) || null,
      standard: "Universal Manifest v0.4 · Signature Profile A",
      um_conformance_claimed: false,
      verified_at: new Date().toISOString(),
    };
  } catch (e) {
    return { present: true, verified: false, reason: `verify-threw:${(e && e.message) || "error"}` };
  }
}
