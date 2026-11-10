import { createPresenceController, PRESENCE_TIMING } from "./live-adapter-presence-controller.mjs";
import { createPeerPresenceReducer, PEER_PRESENCE_TIMING } from "./live-adapter-peer-presence-reducer.mjs";
import { createRuntimeStreamController } from "./live-adapter-runtime-stream-controller.mjs";
import { DEFAULT_AVATAR_VARIANT } from "./avatar-equipment-layer.js";
import { resolveEquipmentItems } from "./equipment-view.js";

export function bindLivePresence({
  transport, clientMode, clientId, supported, getBase, getLocationId, getAvatar,
  getHandoffInFlight, onForcePose, onCloseEventStreams, onLog, getPeerContext,
  onEmit, onArrival, onDepartureMirror, onArrivalMirror, onEquipmentStatus,
  onExternalPresenceDeparture, getActiveEndpointKey, getDesiredEventEndpointKeys,
  isEndpointKey, onRuntimeState, onPresenceDeparture, onPresenceDepartureApplied, fallbackPollMs,
}) {
  const presence = createPresenceController({
    transport, clientMode, playerId: clientId, clientId, supported, getBase, getLocationId,
    getAvatar, getHandoffInFlight, onForcePose, onCloseEventStreams, onLog,
  });
  const peers = createPeerPresenceReducer({
    clientMode, clientId, controlledIdentity: () => presence.controlledIdentity(),
    getContext: getPeerContext, defaultAvatarVariant: DEFAULT_AVATAR_VARIANT,
    onEmit, onArrival, onDepartureMirror, onArrivalMirror,
    onResolveEquipment: items => resolveEquipmentItems(items), onEquipmentStatus, onExternalPresenceDeparture,
  });
  const streams = createRuntimeStreamController({
    getActiveEndpointKey, getDesiredEventEndpointKeys, isEndpointKey, onRuntimeState,
    onPresenceDeparture, onPresenceDepartureApplied, onLog, fallbackPollMs,
    fallbackPeerStaleMs: PEER_PRESENCE_TIMING.stale_ms,
    fallbackServerTtlMs: PRESENCE_TIMING.requested_ttl_ms,
  });
  return { presence, peers, streams };
}
