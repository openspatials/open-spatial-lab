import { createPortalTraversalHandoffController } from "./live-adapter-portal-traversal-controller.mjs";
import { HANDOFF_PHASES, PROVENANCE } from "./vendor/scene-core/frontend-contract.js";
import { defaultEquippedItems, resolveEquipmentItems } from "./equipment-view.js";
import { DEFAULT_AVATAR_VARIANT } from "./avatar-equipment-layer.js";
import { signManifestOntoPacket, verifyManifestFromPacket } from "./live-adapter-crossing-manifest.mjs";
import { publishCrossingDiagnostics } from "./live-adapter-crossing-diagnostics.mjs";

export function bindPortalTraversal({ getSigningWorld, getSigningTransport, isDisposed, ...capabilities }) {
  return createPortalTraversalHandoffController({
    ...capabilities, handoffPhases: HANDOFF_PHASES, provenance: PROVENANCE,
    crypto: {
      signManifest: packet => {
        return signManifestOntoPacket(packet, getSigningWorld(), getSigningTransport(), DEFAULT_AVATAR_VARIANT);
      },
      verifyManifest: packet => verifyManifestFromPacket(packet),
      enrichManifest: (packet, operation) => publishCrossingDiagnostics(packet, {
        ...operation, transport: getSigningTransport(),
        isCurrent: () => !isDisposed() && operation.isCurrent(),
      }),
    },
    assets: { defaultEquippedItems, resolveEquipmentItems, defaultAvatarVariant: DEFAULT_AVATAR_VARIANT },
  });
}
