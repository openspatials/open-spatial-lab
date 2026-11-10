export function movementDriver(readers, owners) {
  const { adapter, movementCameraController } = owners;
  const { isPlayer } = readers;
  return {
    controlState: movementCameraController.controlState(),
    movementDebug: () => movementCameraController.movementDebug(),
    moveAvatar: (input, dt = 0.1) => adapter.stepAvatar(input || {}, dt),
    exitPoseParity: () => movementCameraController.exitPoseParity(),
    crossingHeadingContinuity: () =>
      movementCameraController.crossingHeadingContinuity(),
    cameraMode: () => movementCameraController.playerCameraMode(),
    setCameraMode: (mode) => movementCameraController.setPlayerCameraMode(mode),
    toggleCameraMode: () => movementCameraController.togglePlayerCameraMode(),
    serverViewMode: () => movementCameraController.serverViewMode(),
    setServerViewMode: (mode) =>
      movementCameraController.setServerViewMode(mode),
    toggleServerViewMode: () => movementCameraController.toggleServerViewMode(),
    serverViewCameraState: () =>
      movementCameraController.serverViewCameraState(),
    movementBasisYaw: () =>
      isPlayer ? movementCameraController.movementBasisYaw() : null,
    groundingState: () => movementCameraController.groundingState(),
    orbitCamera: (dAzimuth = 0, dPolar = 0, dDistance = 0) =>
      movementCameraController.orbitBy(dAzimuth, dPolar, dDistance),
    orbitCameraState: () => movementCameraController.orbitState(),
    cameraWallOcclusionState: () =>
      movementCameraController.cameraWallOcclusionState(),
  };
}
