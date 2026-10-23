import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(root, "web/app.js"), "utf8");
const index = readFileSync(join(root, "web/index.html"), "utf8");
const bootstrap = readFileSync(join(root, "web/demo-shell-bootstrap.mjs"), "utf8");

assert.match(index, /id="demo-launcher-mount"/);
assert.match(index, /id="btn-views-home"/);
assert.match(bootstrap, /isBareEntry/);
assert.match(bootstrap, /introPreference === "force"/);
assert.match(bootstrap, /await import\("\.\/app\.js\?v=/);
assert.match(bootstrap, /mission=denver-skyport/);
assert.match(app, /const launcherMissionParam = params\.get\("mission"\)/);
assert.match(app, /launcherMissionParam === "denver-skyport"/);
// migrated Airport Portal C off the same-browser
// client_scene_load path onto the real airport BACKEND. The airport content is
// now wired through the server-backed mission, not a client-scene target, so
// assert the server-backed Portal C marker instead of the retired resolver call.
assert.match(app, /portal-c-server-backed/);
assert.match(app, /detail\.kind === "return_to_lobby"[\s\S]*seedOrbitCamera\(\{ azimuth: 0 \}\)/);

assert.match(app, /const noEquipParam = params\.get\("noequip"\) !== "0"/);
assert.match(app, /avatarSelectorRemoveAllEquipment/);
assert.match(app, /applyNoEquipmentChoice/);

// routed the same-origin proxy bases through the public
// base-path helper, so the Server-B aperture load now uses apiBase("b").
// NOTE (post-P5): the Server-B aperture machine is being retired by the active
// P4 lane in web/app.js; if that call is removed, this B-aperture pair
// (loadBackendApertureMachine + data-server-b-aperture-entities) belongs to that
// lane to reconcile. Re-verify this whole check once app.js settles (load < 14).
assert.match(app, /loadBackendApertureMachine\(apiBase\("b"\), "location-b-portal"\)/);
// retired the same-browser airport aperture machine + its aperture-entity
// attribute; the airport now renders from the live backend scene
// (data-airport-backend-scene / live_backend_authored_wow_graph in the scene
// layer). Assert the retired client-scene airport wiring stays gone.
assert.doesNotMatch(app, /loadAirportApertureMachine/);
assert.match(app, /data-server-b-aperture-entities/);
assert.doesNotMatch(app, /data-airport-aperture-entities/);
assert.match(app, /suppressReturnPortal: true/);
assert.match(app, /destination_portal: null/);

console.log("MEETING_CRITICAL_VISUALS_CHECK PASS launcher=integrated equipment=empty portal-content=A+B+C(C=server-backed) airport-client-scene-aperture=retired duplicate-rings=suppressed");
