import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reframeCrossingCameraMapping } from "../web/movement-camera-controller.mjs";
import { nodeChecks } from "../tools/behavior/node-checks.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/crossing-camera-validation.json", import.meta.url), "utf8"));
const { check, finish } = nodeChecks("crossing-camera-validation");

function decode(value) {
  if (value && typeof value === "object" && Object.hasOwn(value, "$number")) {
    return value.$number === "undefined" ? undefined : Number(value.$number);
  }
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decode(child)]));
  return value;
}

for (const sample of fixture.cases) {
  await check(sample.name, "The public validation preserves the captured result/error and leaves source data unchanged", () => {
    const input = decode(sample.input), before = structuredClone(input);
    let actual;
    try { actual = { result: reframeCrossingCameraMapping(input) }; }
    catch (error) { actual = { error: { name: error.name, message: error.message } }; }
    assert.deepEqual(input, before, "source input changed");
    assert.deepEqual(actual, decode(sample.expected), "captured outcome changed");
  });
}

const file = "web/crossing-camera-validation.mjs";
const faults = [
  ["valid-180", "mapping uses the entry instead of exit pose", "avatarExitPosition: exitPose.position,", "avatarExitPosition: entryTransform.position,"],
  ["no-heading", "missing heading is reported as a different guard", 'return "source_heading_continuity_unavailable";', 'return "source_camera_mapping_unavailable";'],
  ["wrong-frame-source", "mapping source authority is ignored", 'mapping.frame_source === "packet.avatar_context.portal_frame_transform" &&', "true &&"],
  ["position-0.05", "position threshold loses its inclusive boundary", "record.position_correction_m > 0.05", "record.position_correction_m >= 0.05"],
  ["focus-0.050001", "focus tolerance is widened", "record.focus_correction_m > 0.05", "record.focus_correction_m > 0.06"],
  ["forward-1", "forward tolerance loses its inclusive boundary", "record.forward_correction_deg > 1", "record.forward_correction_deg >= 1"],
  ["movement_basis_forward-1.000001", "movement basis tolerance is widened", "record.movement_basis_correction_deg > 1", "record.movement_basis_correction_deg > 2"],
  ["heading-1.000001", "heading tolerance is widened", ")) > Math.PI / 180", ")) > Math.PI / 90"],
  ["zero-forward", "zero direction no longer produces its original angle", "Math.max(1e-9, Math.hypot(...actual.slice(0, 3).map(Number)))", "Math.hypot(...actual.slice(0, 3).map(Number))"],
].map(([statement, name, find, replace]) => ({ statement, name, expect: /captured outcome changed/, edits: [{ file, find, replace }] }));
faults.push({ statement: "valid-180", name: "validation mutates the source mapping", expect: /source input changed/, edits: [{ file, find: "record.pre_reframe_forward_yaw_rad = forwardYaw(mapping.forward);", replace: "mapping.position[0] += 1;\n  record.pre_reframe_forward_yaw_rad = forwardYaw(mapping.forward);" }] });

await finish({ checkFile: "src/crossing-camera-validation-check.mjs", faults });
