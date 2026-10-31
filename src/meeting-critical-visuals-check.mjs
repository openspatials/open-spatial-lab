import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const index = readFileSync(join(root, "web/index.html"), "utf8");
const bootstrap = readFileSync(join(root, "web/demo-shell-bootstrap.mjs"), "utf8");

assert.match(index, /id="demo-launcher-mount"/);
assert.match(index, /id="btn-views-home"/);
assert.match(bootstrap, /isBareEntry/);
assert.match(bootstrap, /introPreference === "force"/);
assert.match(bootstrap, /await import\("\.\/app\.js\?v=/);
assert.match(bootstrap, /mission=denver-skyport/);

// What the page does with the mission, equipment and destination reads is run, not read:
// tools/behavior/camera-movement.check.mjs (mission-marks-journey, arrives-without-equipment, boot-reads-no-destination-region).
console.log("MEETING_CRITICAL_VISUALS_CHECK PASS launcher=integrated");
