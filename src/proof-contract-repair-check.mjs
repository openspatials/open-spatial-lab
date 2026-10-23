import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertHomepagePhaseOrder,
  feature_HOMEPAGE_PHASE_ORDERS,
} from "./homepage-scroll-e2e.mjs";
import {
  createOwnedBrowserTeardown,
  listExactProfileProcesses,
} from "./owned-browser-teardown.mjs";
import { rendererControls, rendererGate } from "./clean-webgl-ui-smoke.mjs";

const mutation = process.env.feature_MUTATION || "";
let checks = 0;

async function check(name, action) {
  await action();
  checks += 1;
  console.log(`PASS ${String(checks).padStart(2, "0")} ${name}`);
}

class ExitedChild extends EventEmitter {
  constructor(pid, profilePath) {
    super();
    this.pid = pid;
    this.exitCode = 0;
    this.signalCode = null;
    this.spawnargs = ["/owned/browser", `--user-data-dir=${profilePath}`];
  }

  kill() {
    throw new Error("an already-exited main child must not be signaled");
  }
}

function processTable(rows) {
  return rows.map((entry) => `${entry.pid} ${entry.ppid} ${entry.command}`).join("\n");
}

function browserFor(child) {
  return { process: () => child, close: async () => {} };
}

function rendererFixture() {
  const gateCompletedAt = 100;
  const requiredAssets = [
    {
      path: "/assets/avatars/glb/readyplayerme_cyberpunk.glb",
      url: "http://127.0.0.1:9193/assets/avatars/glb/readyplayerme_cyberpunk.glb",
      request_count: 1,
      response_status: 200,
      content_length: "5613180",
      loading_failed_count: 0,
      terminal: { kind: "Network.loadingFinished", before_journey: true, before_teardown: true },
      body: {
        available: true,
        bytes: 5613180,
        sha256: "cde6cd4d6a92a5b604b08449165a97d3e52112295255543429b85fe144962306",
      },
    },
    {
      path: "/assets/mocap/locomotion-mocap.derived.glb",
      url: "http://127.0.0.1:9193/assets/mocap/locomotion-mocap.derived.glb",
      request_count: 1,
      response_status: 200,
      content_length: "488324",
      loading_failed_count: 0,
      terminal: { kind: "Network.loadingFinished", before_journey: true, before_teardown: true },
      body: {
        available: true,
        bytes: 488324,
        sha256: "22b30ba44b592af394f82e62f06036c67b51f68408cf22261bda44d911b22e67",
      },
    },
  ];
  const readinessSample = (sampleSeq, observedWallMs) => ({
    source: "window.__assembly",
    sample_seq: sampleSeq,
    observed_wall_ms: observedWallMs,
    assembly_ready: true,
    equipment_ready: true,
    assembly_disposed: false,
    avatar: {
      variant: "readyplayerme-cyberpunk",
      switch_in_flight: false,
      model_height_m: 1.8,
      head_height_m: 1.65,
      current_animation_state: "idle",
      locomotion_states: ["idle", "walk", "run", "jump"],
    },
  });
  return {
    mode: "webgl",
    asset_delivery: {
      server_prewarm: [{ ok: true }, { ok: true }],
      browser: { gate_applied: true, gate_passed: true, gate_completed_at_ms: gateCompletedAt, required_assets: requiredAssets },
    },
    product_readiness: {
      gate_applied: true,
      gate_passed: true,
      gate_completed_at_ms: 200,
      samples: [readinessSample(1, 120), readinessSample(2, 140)],
    },
    journey: { started_at_ms: 220 },
    renderer: {
      initial: { renderer_kind: "webgl", actual_context: true, context_lost: false, sample_seq: 1, canvas_token: "canvas-1" },
      final: { renderer_kind: "webgl", actual_context: true, context_lost: false, sample_seq: 2, canvas_token: "canvas-1" },
      events: { lost: [], restored: [], fallback_get_context_count: 0 },
    },
    health: {
      context_creation_errors: [],
      fallback_messages: [],
      console_errors: [],
      page_errors: [],
      request_failure_filtering_applied: false,
      raw_request_failures: [],
      request_failures: [],
      bad_responses: [],
    },
    viewports: [{ ok: true }, { ok: true }],
    cleanup: {
      product_disposed: true,
      network_quiet_before_page_close: true,
      in_flight_before_page_close: 0,
      page_close_completed: true,
      page_close_started_at_ms: 300,
      page_close_completed_at_ms: 320,
      in_flight_after_page_close: 0,
      browser: { ok: true, outcome: "kill-exit" },
      profile_removed: true,
      profile_processes_after: [],
      profile_release_observed_at_ms: 340,
    },
  };
}

await check("Step 2 and Step 3 require distinct exact direct-child orders", () => {
  assertHomepagePhaseOrder([...feature_HOMEPAGE_PHASE_ORDERS.step2], "step2");
  assertHomepagePhaseOrder([...feature_HOMEPAGE_PHASE_ORDERS.step3], "step3");
  assert.notDeepEqual(feature_HOMEPAGE_PHASE_ORDERS.step2, feature_HOMEPAGE_PHASE_ORDERS.step3);
});

await check("Step 2 rejects omission, duplication, reordering, and relaxed extras", () => {
  const expected = [...feature_HOMEPAGE_PHASE_ORDERS.step2];
  const assertOrder = mutation === "relaxed-order"
    ? (candidate) => assert.equal(expected.every((key) => candidate.includes(key)), true)
    : (candidate) => assertHomepagePhaseOrder(candidate, "step2");
  assert.throws(() => assertOrder(expected.slice(1)));
  assert.throws(() => assertOrder([expected[0], expected[0], ...expected.slice(1)]));
  assert.throws(() => assertOrder([expected[1], expected[0], ...expected.slice(2)]));
  assert.throws(() => assertOrder([...expected, "extra"]));
});

await check("Step 3 rejects canvas naming, omission, duplication, and reordering", () => {
  const expected = [...feature_HOMEPAGE_PHASE_ORDERS.step3];
  assert.throws(() => assertHomepagePhaseOrder(["canvas", ...expected.slice(1)], "step3"));
  assert.throws(() => assertHomepagePhaseOrder(expected.slice(1), "step3"));
  assert.throws(() => assertHomepagePhaseOrder([expected[0], expected[0], ...expected.slice(1)], "step3"));
  assert.throws(() => assertHomepagePhaseOrder([expected[1], expected[0], ...expected.slice(2)], "step3"));
});

await check("exact-profile matcher excludes prefix and different-profile processes", () => {
  const profile = path.join(os.tmpdir(), "runtime-exact-profile-matcher");
  const exactArgument = `--user-data-dir=${profile}`;
  const rows = [
    { pid: 41_001, ppid: 1, command: `/owned/helper --type=utility ${exactArgument} --service=network` },
    { pid: 41_002, ppid: 1, command: `/unrelated/helper --type=utility ${exactArgument}-unrelated --service=network` },
    { pid: 41_003, ppid: 1, command: `/other/helper --user-data-dir=${profile}-other --service=network` },
  ];
  assert.deepEqual(
    listExactProfileProcesses(profile, { processTableFn: () => processTable(rows) }).map((entry) => entry.pid),
    [41_001],
  );
});

await check("exact-profile teardown reaps only the attributable process and removes its profile", async () => {
  const profile = path.join(os.tmpdir(), "runtime-owned-profile-clean");
  const exactArgument = `--user-data-dir=${profile}`;
  const exactPid = 41_011;
  const unrelatedPid = 41_012;
  let rows = [
    { pid: exactPid, ppid: 1, command: `/owned/helper --type=utility ${exactArgument} --service=network` },
    { pid: unrelatedPid, ppid: 1, command: `/unrelated/helper --type=utility ${exactArgument}-unrelated --service=network` },
  ];
  let profilePresent = true;
  const signals = [];
  const removals = [];
  const result = await createOwnedBrowserTeardown(browserFor(new ExitedChild(41_010, profile)), {
    profilePath: profile,
    processTableFn: () => processTable(rows),
    sendSignalFn: (pid, signal) => {
      signals.push({ pid, signal });
      if (pid === exactPid) rows = rows.filter((entry) => entry.pid !== pid);
      return true;
    },
    removeProfileFn: async (target) => { removals.push(target); profilePresent = false; },
    profileExistsFn: () => profilePresent,
    profilePollMs: 1,
    termTimeoutMs: 2,
    killTimeoutMs: 2,
    onLog: () => {},
  }).shutdown();
  if (mutation === "unrelated-process-kill") signals.push({ pid: unrelatedPid, signal: "SIGKILL" });
  assert.equal(result.ok, true);
  assert.equal(result.profile.ok, true);
  assert.deepEqual(signals, [{ pid: exactPid, signal: "SIGTERM" }]);
  assert.deepEqual(removals, [profile]);
  assert.deepEqual(rows.map((entry) => entry.pid), [unrelatedPid]);
});

await check("stubborn exact-profile process fails closed and preserves the profile", async () => {
  const profile = path.join(os.tmpdir(), "runtime-owned-profile-stubborn");
  const exactPid = 41_021;
  const rows = [{
    pid: exactPid,
    ppid: 1,
    command: `/owned/helper --type=utility --user-data-dir=${profile} --service=network`,
  }];
  let profilePresent = true;
  let removals = 0;
  const signals = [];
  const result = await createOwnedBrowserTeardown(browserFor(new ExitedChild(41_020, profile)), {
    profilePath: profile,
    processTableFn: () => processTable(rows),
    sendSignalFn: (pid, signal) => { signals.push({ pid, signal }); return true; },
    removeProfileFn: async () => { removals += 1; profilePresent = false; },
    profileExistsFn: () => profilePresent,
    profilePollMs: 1,
    termTimeoutMs: 2,
    killTimeoutMs: 2,
    onLog: () => {},
  }).shutdown();
  const accepted = mutation === "accept-profile-leak" ? true : result.ok;
  assert.equal(accepted, false);
  assert.equal(result.profile.outcome, "profile-processes-remained");
  assert.deepEqual(signals, [
    { pid: exactPid, signal: "SIGTERM" },
    { pid: exactPid, signal: "SIGKILL" },
  ]);
  assert.equal(removals, 0);
  assert.equal(profilePresent, true);
});

await check("profile ownership mismatch fails closed without signals or removal", async () => {
  const profile = path.join(os.tmpdir(), "runtime-owned-profile-mismatch");
  const child = new ExitedChild(41_030, `${profile}-other`);
  let signals = 0;
  let removals = 0;
  const result = await createOwnedBrowserTeardown(browserFor(child), {
    profilePath: profile,
    processTableFn: () => "",
    sendSignalFn: () => { signals += 1; return true; },
    removeProfileFn: async () => { removals += 1; },
    profileExistsFn: () => true,
    onLog: () => {},
  }).shutdown();
  assert.equal(result.ok, false);
  assert.equal(result.profile.outcome, "profile-ownership-failed-closed");
  assert.equal(signals, 0);
  assert.equal(removals, 0);
});

await check("runtime rejects early profile release and a surviving profile process", () => {
  const fixture = rendererFixture();
  assert.equal(rendererGate(fixture).ok, true);
  const controls = rendererControls(fixture);
  assert.equal(controls.every((control) => control.rejected), true);
  const earlyClose = controls.find((control) => control.name === "early-page-profile-close");
  const processLeak = controls.find((control) => control.name === "profile-process-leak");
  assert.equal(mutation === "accept-early-close" ? false : earlyClose?.rejected, true);
  assert.equal(processLeak?.rejected, true);
});

if (!mutation) {
  for (const name of ["relaxed-order", "unrelated-process-kill", "accept-profile-leak", "accept-early-close"]) {
    let red = false;
    try {
      execFileSync(process.execPath, [fileURLToPath(import.meta.url)], {
        env: { ...process.env, feature_MUTATION: name },
        stdio: "pipe",
      });
    } catch (error) {
      red = Number.isInteger(error.status) && error.status !== 0;
    }
    assert.equal(red, true, `controlled mutation ${name} must turn RED`);
    console.log(`RED_CAUGHT ${name}`);
  }
  console.log(`feature_PROOF_CONTRACT_REPAIR PASS ${checks}/${checks} mutations=4/4`);
}
