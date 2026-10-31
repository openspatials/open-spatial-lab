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

// A portal shows its destination through that world's own preview: the boot-time read of Server B's region, and the
// airport aperture machine before it, stay gone (iteration 4).
assert.doesNotMatch(app, /loadBackendApertureMachine/);
assert.doesNotMatch(app, /data-server-b-aperture-entities/);
assert.doesNotMatch(app, /loadAirportApertureMachine/);
assert.doesNotMatch(app, /data-airport-aperture-entities/);

console.log("MEETING_CRITICAL_VISUALS_CHECK PASS launcher=integrated equipment=empty portal-content=A+B+C(C=server-backed) boot-time-destination-reads=retired");
