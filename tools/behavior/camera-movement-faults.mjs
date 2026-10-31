// Faults planted in a copy of the demo's page code for tools/behavior/camera-movement.check.mjs; each must turn the
// named statement red, for the reason `expect` names. Update the `find` text when the code it edits moves.
const APP = "web/app.js";
const fault = (statement, name, expect, find, replace, file = APP) => ({ statement, name, expect, edits: [{ file, find, replace }] });
const READY = '  document.body.setAttribute("data-assembly-ready", "1");';

export const cameraMovementFaults = [
  fault("header-camera-button", "the header button never switches the camera", /after the press the camera is/,
    "      const next = movementCameraController.togglePlayerCameraMode();\n      cameraToggleBtn.setAttribute(", "      const next = movementCameraController.playerCameraMode();\n      cameraToggleBtn.setAttribute("),
  fault("footer-height-follows", "the footer's height is never published", /the page published ""/,
    "followFooterHeight(document);", ""),
  fault("footer-height-follows", "the footer's height is published once and never followed", /does not follow the footer/,
    "  observer.observe(footer);\n", "", "web/main-demo-footer.mjs"),
  fault("mission-marks-journey", "the mission name is not recognised", /page is marked "null"/,
    'launcherMissionParam === "denver-skyport"', 'launcherMissionParam === "denver-skyport-"'),
  fault("arrives-without-equipment", "a new visitor arrives with the default gear", /arrived wearing/,
    'params.get("noequip") !== "0" && params.get("noequip") !== "false"', 'params.get("noequip") === "0" && params.get("noequip") !== "false"'),
  fault("arrives-without-equipment", "the no-equipment choice keeps the gear", /after choosing no equipment the visitor still wears/,
    "applyNoEquipmentChoice: (items) => applyNoEquipmentChoice(items),", "applyNoEquipmentChoice: (items) => items,"),
  fault("boot-reads-no-destination-region", "the page reads a destination's region at boot", /read a region from a destination/,
    READY, `  void fetch("/api/b/fabric/region?anchor_portal_id=location-b-portal&radius_m=5", { cache: "no-store" }).catch(() => {});\n${READY}`),
  fault("boot-reads-no-destination-region", "the page marks the airport's aperture entities again", /carries destination marks/,
    READY, `  document.body.setAttribute("data-airport-aperture-entities", "0");\n${READY}`),
  fault("jump-keeps-the-loop-running", "the page's pose call goes to a method the adapter lacks", /never landed|W walked only/,
    "broadcastPlayerPose: (options) => adapter.broadcastPlayerPose(options),", "broadcastPlayerPose: (options) => adapter.broadcastPlayerPosePrivate(options),"),
  fault("jump-keeps-the-loop-running", "the adapter has no public pose call", /never landed|W walked only/,
    "  broadcastPlayerPose({ force = false } = {}) {", "  broadcastPlayerPosePrivate({ force = false } = {}) {", "web/live-adapter.js"),
  fault("held-key-stops-at-crossing", "a crossing leaves the held key down", /with W still down after the crossing/,
    "    const remapped = movementCameraController.handleCrossing(detail);", "    const remapped = null;"),
  fault("arrival-names-destination", "the arrival toast drops the world's name", /names no destination/,
    '? ["ARRIVED", destTitle, resumeMs != null', '? ["ARRIVED", resumeMs != null'),
  fault("return-to-lobby-camera", "the return to the Lobby keeps the camera heading", /after the return the camera is/,
    "    // seedOrbitCamera({ azimuth: 0 }) before applying the lobby camera.\n    movementCameraController.handleCrossing(detail);", "    // seedOrbitCamera({ azimuth: 0 }) before applying the lobby camera."),
];
