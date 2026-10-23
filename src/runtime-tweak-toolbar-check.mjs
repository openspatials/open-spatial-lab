#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  clampPaletteSize,
  copyAllTweakText,
  createRunTweakRegistry,
  formatTweakLine,
  validateTweakRegistry,
} from "../web/runtime-tweak-controller.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mutation = process.argv.find((argument) => argument.startsWith("--mutate="))?.slice(9) || null;
const mutationArms = new Set([
  "binding-cycle-speed",
  "binding-cycle-distance",
  "measured-range",
  "registry-render",
  "copy-row",
  "copy-all-freshness",
  "resize-bounds",
]);

if (mutation && !mutationArms.has(mutation)) {
  console.error(`Unknown mutation arm: ${mutation}`);
  process.exit(2);
}

const source = {
  app: await readFile(resolve(root, "web/app.js"), "utf8"),
  adapter: await readFile(resolve(root, "web/live-adapter.js"), "utf8"),
  avatar: await readFile(resolve(root, "web/avatar-equipment-layer.js"), "utf8"),
  controller: await readFile(resolve(root, "web/runtime-tweak-controller.mjs"), "utf8"),
  html: await readFile(resolve(root, "web/index.html"), "utf8"),
};

if (mutation === "binding-cycle-speed") {
  source.avatar = source.avatar.replace("runCycleSpeed * clipDuration", "speedMps / WALK_NATURAL_SPEED_MPS");
}
if (mutation === "binding-cycle-distance") {
  source.adapter = source.adapter.replace(
    "calibration.run_cycle_speed * calibration.run_cycle_distance",
    "sourceSpeed"
  );
}
if (mutation === "registry-render") {
  source.controller = source.controller.replace("registry.map((entry) => {", "registry.slice(0, 2).map((entry) => {");
}

const results = [];
async function check(name, run) {
  try {
    await run();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

function includesAll(text, needles, label) {
  for (const needle of needles) assert.ok(text.includes(needle), `${label} missing ${needle}`);
}

function calibrationHarness() {
  const defaults = {
    run_cycle_speed: 1.4451239360192616,
    run_cycle_distance: 1.9375500814918891,
  };
  let applied = { ...defaults };
  const registry = createRunTweakRegistry({
    sourceDefaults: defaults,
    readCalibration: () => ({ ...applied }),
    applyCalibration: (values) => {
      applied = { ...values };
      return { ...applied };
    },
  });
  return { defaults, registry, read: () => ({ ...applied }) };
}

await check("single adjustable cadence registry preserves measured distance authority", () => {
  const { registry } = calibrationHarness();
  assert.deepEqual(registry.map((entry) => entry.key), ["run_cycle_speed"]);
  validateTweakRegistry(registry);
  includesAll(source.controller, ["const specifications = [", "registry.map((entry) => {", "rows.replaceChildren(...rendered)"], "registry renderer");
  assert.ok(!source.controller.includes("registry.slice(0, 2).map((entry) => {"), "renderer is capped at two rows");
});

await check("source-derived default stays inside the measured asymmetric envelope", () => {
  const { registry } = calibrationHarness();
  for (const entry of registry) {
    const defaultValue = mutation === "measured-range" && entry.key === "run_cycle_speed"
      ? entry.max + entry.step
      : entry.sourceDerivedDefault;
    assert.ok(defaultValue >= entry.min && defaultValue <= entry.max, `${entry.key} measured-range drift`);
    assert.equal(entry.currentValue, entry.sourceDerivedDefault, `${entry.key} did not load at source default`);
  }
});

await check("cycle-speed drives the shared run action without clip restart", () => {
  includesAll(source.avatar, [
    "const runCycleSpeed = Number(this.avatar?.locomotion?.run_cycle_speed)",
    "runCycleSpeed * clipDuration",
    "this.actions[desired].setEffectiveTimeScale(playbackRate)",
    "if (desired !== previous)",
  ], "avatar cycle-speed binding");
  const steadyBody = source.avatar.slice(
    source.avatar.indexOf("this.status.current_animation_state = this._animState"),
    source.avatar.indexOf("_syncRunCalibrationTelemetry(delta)")
  );
  assert.ok(!steadyBody.includes("this.actions[desired].reset()"), "steady calibration update restarts a clip");
});

await check("cycle-distance drives the existing movement owner product", () => {
  includesAll(source.adapter, [
    "calibration.run_cycle_speed * calibration.run_cycle_distance",
    "calibration.run_cycle_speed * 120",
    "runCalibration.effective_run_translation_speed_mps",
    "run_translation_speed_mps: snapshot.effective_run_translation_speed_mps",
    "p[0] + dx",
    "p[2] + dz",
  ], "movement distance binding");
  assert.ok(!source.adapter.includes("calibration\n        ? sourceSpeed"), "calibrated translation bypasses the product");
});

await check("default product recovers measured run translation", () => {
  const { defaults } = calibrationHarness();
  const runMps = defaults.run_cycle_speed * defaults.run_cycle_distance;
  assert.ok(Math.abs(runMps - 2.8) < 1e-12, `default product ${runMps} != 2.8 m/s`);
  // The stride comes with the run clip (measured from the recording), with the old constant as a fallback.
  assert.ok(source.avatar.includes("const runCycleDistance = (this._gait || DEFAULT_GAIT).runCycleDistance"));
  assert.ok(source.avatar.includes("const runCycleSpeed = translationSpeed / runCycleDistance"));
  assert.ok(source.avatar.includes("const playbackRate = runCycleSpeed * clipDuration"));
});

await check("per-row copy is deterministic and live", () => {
  const { registry } = calibrationHarness();
  registry[0].apply(registry[0].sourceDerivedDefault + 0.1);
  const actual = mutation === "copy-row"
    ? `${registry[0].key}: ${registry[0].sourceDerivedDefault.toFixed(registry[0].precision)}`
    : formatTweakLine(registry[0]);
  assert.equal(actual, "run_cycle_speed: 1.5455");
});

await check("copy-all rereads current values in registry order", () => {
  const { registry } = calibrationHarness();
  registry[0].apply(registry[0].sourceDerivedDefault + 0.1);
  const actual = mutation === "copy-all-freshness"
    ? registry.map((entry) => `${entry.key}: ${entry.sourceDerivedDefault.toFixed(entry.precision)}`).join("\n")
    : copyAllTweakText(registry);
  assert.equal(actual, "run_cycle_speed: 1.5455");
});

await check("clipboard rejection exposes selectable honest fallback", () => {
  includesAll(source.controller, [
    "Promise.reject(new Error(\"Clipboard API unavailable\"))",
    "fallback.hidden = false",
    "fallback.select()",
    "announce(`Copy failed:",
    "\"error\"",
  ], "clipboard rejection path");
});

await check("palette resize clamps at desktop and narrow bounds", () => {
  const desktop = clampPaletteSize({ width: 9999, height: 9999, viewportWidth: 1440, viewportHeight: 900 });
  const narrow = clampPaletteSize({ width: 9999, height: 9999, viewportWidth: 390, viewportHeight: 640 });
  const actual = mutation === "resize-bounds" ? { ...narrow, width: 430 } : narrow;
  assert.deepEqual({ width: desktop.width, height: desktop.height }, { width: 720, height: 720 });
  assert.equal(actual.width, 374);
  assert.equal(actual.height, 552);
  assert.ok(actual.width <= 390 - 16, "narrow palette overflows horizontally");
  includesAll(source.controller, ["pointerdown", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"], "resize interaction");
});

await check("header, dialog, focus, Escape, and app composition are wired", () => {
  includesAll(source.html, [
    'data-testid="runtime-tweak-toggle"',
    'data-testid="runtime-tweak-palette" role="dialog" aria-modal="false"',
    'data-testid="runtime-tweak-resizer" role="separator"',
    'data-testid="runtime-tweak-copy-fallback" readonly hidden',
  ], "toolbar markup");
  includesAll(source.controller, [
    "returnFocus = document.activeElement",
    "rowRefs.get(registry[0].key)?.range.focus()",
    'event.key === "Escape"',
    "returnFocus.focus()",
  ], "focus lifecycle");
  includesAll(source.app, [
    "equipmentLayer.characterizeRunCalibration(",
    "adapter.setRunCalibration({",
    "createRunTweakRegistry({",
    "createRuntimeTweakController({",
    "runtimeTweakController.mount()",
    "runtimeTweaks: runtimeTweakController",
  ], "app composition");
});

await check("session-local-only and shared supported rig path are explicit", () => {
  includesAll(source.adapter, [
    'persistence: "session-local-memory-only"',
    "this._runCalibration = Object.freeze({",
  ], "session-local calibration");
  assert.ok(!/localStorage|sessionStorage|history\.|location\.(?:hash|search)|postJson/.test(
    source.adapter.slice(source.adapter.indexOf("runCalibrationSnapshot()"), source.adapter.indexOf("stepAvatar(input"))
  ), "calibration setter gained persistence or transport");
  includesAll(source.avatar, [
    "supported GLB, VRM, and parametric facade reaches this same action map",
    "this.actions.run",
    "rig_path: this.status.avatar_render_source || this.status.avatar_variant",
  ], "shared rig path");
});

const passed = results.filter((result) => result.ok).length;
const failed = results.length - passed;
console.log(`SUMMARY passed=${passed} failed=${failed} mutation=${mutation || "none"}`);
if (mutation && failed === 0) {
  console.error(`MUTATION SURVIVED: ${mutation}`);
  process.exit(1);
}
process.exit(failed === 0 ? 0 : 1);
