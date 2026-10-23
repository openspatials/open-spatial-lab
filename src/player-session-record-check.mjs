#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPlayerSessionRecord,
  parsePlayerSessionRecord,
} from "../web/player-session-record.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = join(ROOT, "web", "player-session-record.mjs");
const moduleSource = readFileSync(MODULE_PATH, "utf8");
let checks = 0;

function check(name, assertion) {
  assertion();
  checks += 1;
  console.log(`PASS ${String(checks).padStart(2, "0")} ${name}`);
}

function buildFixture(api = { createPlayerSessionRecord, parsePlayerSessionRecord }) {
  const position = ["1.25", 2, "3.5", 99];
  const record = api.createPlayerSessionRecord({
    activeEndpointKey: "b",
    locationId: "location-b",
    position,
    rotationY: "0.75",
    orbitAzimuthRad: 1.5,
    orbitPolarRad: Number.NaN,
    orbitDistanceM: 4.25,
    cameraMode: "orbit_follow",
    savedAt: "2026-07-14T11:42:03.000Z",
  });
  return { position, record };
}

check("record construction preserves the version-1 wire keys", () => {
  const { record } = buildFixture();
  assert.deepEqual(Object.keys(record), [
    "version",
    "active_endpoint_key",
    "location_id",
    "position",
    "rotation_y",
    "orbit_azimuth_rad",
    "orbit_polar_rad",
    "orbit_distance_m",
    "camera_mode",
    "saved_at",
  ]);
  assert.equal(record.version, 1);
});

check("record construction maps composition values exactly", () => {
  const { record } = buildFixture();
  assert.deepEqual(record, {
    version: 1,
    active_endpoint_key: "b",
    location_id: "location-b",
    position: [1.25, 2, 3.5],
    rotation_y: 0.75,
    orbit_azimuth_rad: 1.5,
    orbit_polar_rad: null,
    orbit_distance_m: 4.25,
    camera_mode: "orbit_follow",
    saved_at: "2026-07-14T11:42:03.000Z",
  });
});

check("position normalization is truncated and non-mutating", () => {
  const { position, record } = buildFixture();
  assert.deepEqual(position, ["1.25", 2, "3.5", 99]);
  assert.notEqual(record.position, position);
  assert.deepEqual(record.position, [1.25, 2, 3.5]);
});

check("missing position and rotation normalize to null", () => {
  const record = createPlayerSessionRecord({
    activeEndpointKey: "a",
    locationId: null,
    position: null,
    rotationY: undefined,
    orbitAzimuthRad: undefined,
    orbitPolarRad: undefined,
    orbitDistanceM: undefined,
    cameraMode: "orbit_follow",
    savedAt: "2026-07-14T11:42:03.000Z",
  });
  assert.equal(record.position, null);
  assert.equal(record.rotation_y, null);
  assert.equal(record.orbit_azimuth_rad, null);
  assert.equal(record.orbit_polar_rad, null);
  assert.equal(record.orbit_distance_m, null);
});

check("version-1 JSON round-trips through the production parser", () => {
  const { record } = buildFixture();
  assert.deepEqual(parsePlayerSessionRecord(JSON.stringify(record)), record);
});

check("parser preserves compatible extension fields", () => {
  const record = parsePlayerSessionRecord(JSON.stringify({ version: 1, future_field: "kept" }));
  assert.equal(record.future_field, "kept");
});

check("malformed JSON fails closed", () => {
  assert.equal(parsePlayerSessionRecord("{"), null);
});

check("wrong record version fails closed", () => {
  assert.equal(parsePlayerSessionRecord(JSON.stringify({ version: 2 })), null);
});

check("empty JSON value fails closed", () => {
  assert.equal(parsePlayerSessionRecord("null"), null);
});

check("pure module owns no runtime side effects", () => {
  assert.doesNotMatch(
    moduleSource,
    /\b(?:window|document|sessionStorage|localStorage|fetch|WebSocket|THREE|setTimeout|setInterval)\b/,
  );
});

const mutationAnchor = "version: PLAYER_SESSION_RECORD_VERSION,";
assert.equal(moduleSource.includes(mutationAnchor), true, "mutation anchor missing");
const mutatedSource = moduleSource.replace(
  mutationAnchor,
  "version: PLAYER_SESSION_RECORD_VERSION + 1,",
);
const mutatedDataUrl = `data:text/javascript;base64,${Buffer.from(mutatedSource).toString("base64")}`;
const mutatedApi = await import(mutatedDataUrl);

check("deliberate version mutation turns the contract RED", () => {
  let mutationCaught = false;
  try {
    const { record } = buildFixture(mutatedApi);
    assert.equal(record.version, 1);
    assert.notEqual(mutatedApi.parsePlayerSessionRecord(JSON.stringify(record)), null);
  } catch {
    mutationCaught = true;
  }
  assert.equal(mutationCaught, true);
  console.log("RED_CAUGHT session-record-version");
});

console.log(`feature_PLAYER_SESSION_RECORD PASS ${checks}/11 mutation=1/1`);
