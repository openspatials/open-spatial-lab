import { sceneDriver } from "./application-scene-driver.mjs";
import { avatarDriver } from "./application-avatar-driver.mjs";
import { movementDriver } from "./application-movement-driver.mjs";
import { panelDriver } from "./application-panel-driver.mjs";

export function createApplicationDriver(readers, commands, owners) {
  return {
    role: readers.role,
    connectionStatus: readers.connectionStatus,
    contract: readers.contract,
    adapter: owners.adapter,
    debugState: readers.debugState,
    crossingGuardFailures: readers.crossingGuardFailures,
    phaseLog: readers.phaseLog,
    activatePortal: () => owners.adapter.activatePortal(),
    triggerHandoff: () => owners.adapter.triggerHandoff(),
    applyArrival: (pkt) => owners.adapter.applyArrival(pkt),
    refreshPreviewReadOnlyState: () =>
      owners.adapter.refreshPreviewReadOnlyState(),
    reset: commands.reset,
    returnToLobby: () => owners.adapter.returnToLobby(),
    phase: () => owners.adapter.state.phase,
    dispose: commands.dispose,
    ready: true,
    ...sceneDriver(readers, owners),
    ...avatarDriver(readers, owners),
    ...movementDriver(readers, owners),
    ...panelDriver(readers, owners),
  };
}
