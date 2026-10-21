// ES-module face of web/wow-geopose.js, the one implementation the world server also loads.
// Importing the file runs it as a module, where it publishes its API on globalThis.
import "./wow-geopose.js";

const api = globalThis.OslWowGeoPose;

export const {
  WGS84,
  ROTATION_CONVENTION,
  READ_ERRORS,
  READ_WARNINGS,
  ecef,
  enuAxes,
  geodetic,
  rotationFromAngles,
  anglesFromRotation,
  frameFromGeoPose,
  localToEcef,
  ecefToLocal,
  directionInFrame,
  geographicToLocal,
  localToGeographic,
  localPoseToGeoPose,
  readGeoPose,
} = api;
