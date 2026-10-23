/**
 * clean WebGL final UI smoke.
 *
 * Two fresh headed Chrome processes prove WebGL creation/retention across the
 * desktop and narrow UI journeys. A third fresh process forces getContext()
 * failure and proves Canvas2D remains resilient while remaining categorically
 * ineligible for the WebGL gate.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import net from "node:net";
import path from "node:path";
import { createOwnedBrowserTeardown, listExactProfileProcesses } from "./owned-browser-teardown.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCENE_CORE = path.join(ROOT, "runtime", "scene-core");
const diagnostics = process.env.feature_EVIDENCE_ROOT
  ? path.resolve(process.env.feature_EVIDENCE_ROOT)
  : path.join(
    ROOT,
    ".dev",
    "ai",
    "diagnostics",
    "2026-07-18-14-11-55Z-runtime",
  );
const PORTS = Object.freeze({ frontend: 9193, a: 19191, b: 19192, lobby: 19193 });
const BASE = `http://127.0.0.1:${PORTS.frontend}`;
const VIEWPORTS = Object.freeze([
  { name: "desktop", width: 1200, height: 800, deviceScaleFactor: 1 },
  { name: "narrow", width: 390, height: 844, deviceScaleFactor: 1 },
]);
const ASSET_PREWARM_EXPECTED = Object.freeze({
  "/assets/avatars/glb/readyplayerme_cyberpunk.glb": Object.freeze({
    bytes: 5613180,
    sha256: "cde6cd4d6a92a5b604b08449165a97d3e52112295255543429b85fe144962306",
  }),
  "/assets/mocap/locomotion-mocap.derived.glb": Object.freeze({
    bytes: 488324,
    sha256: "22b30ba44b592af394f82e62f06036c67b51f68408cf22261bda44d911b22e67",
  }),
});
const EXPECTED_LOCOMOTION_STATES = Object.freeze(["idle", "walk", "run", "jump"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function protectedBrowserMains() {
  const executables = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ];
  const records = [];
  for (const executable of executables) {
    const scan = spawnSync("/usr/bin/pgrep", ["-lf", executable], { encoding: "utf8" });
    if (scan.status === 1 && !scan.error) continue;
    if (scan.error || scan.status !== 0) {
      throw new Error(`protected browser snapshot failed for ${executable}: ${scan.error?.message || scan.stderr || scan.status}`);
    }
    for (const line of scan.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
      const command = line.replace(/^\d+\s+/, "");
      if (command === executable || command.startsWith(`${executable} `)) records.push(line);
    }
  }
  return records.sort().join("\n");
}

function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export function rendererGate(run) {
  const problems = [];
  const need = (condition, message) => { if (!condition) problems.push(message); };
  const browserAssets = run.asset_delivery?.browser;
  const readiness = run.product_readiness;
  const requiredAssets = browserAssets?.required_assets || [];
  need(run.mode === "webgl", "run is not a WebGL arm");
  need(run.asset_delivery?.server_prewarm?.length === 2, "server prewarm provenance is absent");
  need(browserAssets?.gate_applied === true, "browser asset-completion gate was omitted");
  need(browserAssets?.gate_passed === true, "browser asset-completion gate did not pass");
  need(requiredAssets.length === Object.keys(ASSET_PREWARM_EXPECTED).length, "browser asset validation is incomplete");
  for (const [assetPath, expected] of Object.entries(ASSET_PREWARM_EXPECTED)) {
    const asset = requiredAssets.find((entry) => entry.path === assetPath);
    need(asset?.url === `${BASE}${assetPath}`, `${assetPath}: exact browser URL was not observed`);
    need(asset?.request_count === 1, `${assetPath}: expected exactly one browser request`);
    need(asset?.response_status === 200, `${assetPath}: browser response was not HTTP 200`);
    need(Number(asset?.content_length) === expected.bytes, `${assetPath}: browser content length drifted`);
    need(asset?.terminal?.kind === "Network.loadingFinished", `${assetPath}: browser request did not finish successfully`);
    need(asset?.terminal?.before_journey === true, `${assetPath}: browser completion occurred after the UI journey began`);
    need(asset?.terminal?.before_teardown === true, `${assetPath}: browser completion overlapped teardown`);
    need(asset?.body?.available === true, `${assetPath}: browser response body was unavailable`);
    need(asset?.body?.bytes === expected.bytes, `${assetPath}: browser response body byte count drifted`);
    need(asset?.body?.sha256 === expected.sha256, `${assetPath}: browser response body hash drifted`);
    need(asset?.loading_failed_count === 0, `${assetPath}: a required browser request aborted or failed`);
  }
  need(readiness?.gate_applied === true, "product loader-readiness gate was omitted");
  need(readiness?.gate_passed === true, "product loader-readiness gate did not pass");
  need(readiness?.samples?.length >= 2, "product loader readiness was not sampled twice");
  for (const sample of readiness?.samples || []) {
    need(sample.source === "window.__assembly", "product loader readiness was forged");
    need(sample.assembly_ready === true && sample.equipment_ready === true, "product loader was not truthfully ready");
    need(sample.assembly_disposed === false, "product loader was already disposed at readiness");
    need(sample.avatar?.variant === "readyplayerme-cyberpunk", "default avatar loader did not settle on the required variant");
    need(sample.avatar?.switch_in_flight === false, "avatar loader was still switching");
    need(sample.avatar?.model_height_m > 0 && sample.avatar?.head_height_m > 0, "avatar render geometry was not ready");
    need(sample.avatar?.current_animation_state === "idle", "avatar locomotion did not settle at idle");
    for (const state of EXPECTED_LOCOMOTION_STATES) {
      need(sample.avatar?.locomotion_states?.includes(state), `product loader is missing the ${state} clip`);
    }
    need(sample.observed_wall_ms >= browserAssets?.gate_completed_at_ms, "product loader readiness predates browser completion");
  }
  need(readiness?.samples?.[1]?.sample_seq > readiness?.samples?.[0]?.sample_seq, "product loader telemetry is stale");
  need(run.journey?.started_at_ms >= readiness?.gate_completed_at_ms, "UI journey began before product readiness");
  need(run.renderer?.initial?.renderer_kind === "webgl", "initial renderer is not WebGL");
  need(run.renderer?.final?.renderer_kind === "webgl", "final renderer is not WebGL");
  need(run.renderer?.initial?.actual_context === true, "initial live WebGL context is absent");
  need(run.renderer?.final?.actual_context === true, "final live WebGL context is absent");
  need(run.renderer?.initial?.context_lost === false, "initial context is lost");
  need(run.renderer?.final?.context_lost === false, "final context is lost");
  need(run.renderer?.final?.sample_seq > run.renderer?.initial?.sample_seq, "renderer telemetry is stale");
  need(
    run.renderer?.initial?.canvas_token === run.renderer?.final?.canvas_token,
    "renderer canvas identity changed during the UI journey",
  );
  need(run.renderer?.events?.lost?.length === 0, "webglcontextlost was observed");
  need(run.renderer?.events?.restored?.length === 0, "unexpected webglcontextrestored was observed");
  need(run.renderer?.events?.fallback_get_context_count === 0, "fallback context creation was observed");
  need(run.health?.context_creation_errors?.length === 0, "WebGL context-creation errors reached console");
  need(run.health?.fallback_messages?.length === 0, "Canvas2D fallback activated during WebGL arm");
  need(run.health?.console_errors?.length === 0, "console errors were observed");
  need(run.health?.page_errors?.length === 0, "page errors were observed");
  need(run.health?.request_failure_filtering_applied === false, "request-failure filtering was applied");
  need(
    JSON.stringify(run.health?.raw_request_failures) === JSON.stringify(run.health?.request_failures),
    "request failures were filtered or relabeled",
  );
  need(run.health?.raw_request_failures?.length === 0, "raw request failures were observed");
  need(run.health?.request_failures?.length === 0, "request failures were observed");
  need(run.health?.bad_responses?.length === 0, "HTTP error responses were observed");
  need(run.viewports?.length === 2 && run.viewports.every((entry) => entry.ok), "desktop/narrow UI contract failed");
  need(run.cleanup?.product_disposed === true, "product teardown did not run");
  need(run.cleanup?.network_quiet_before_page_close === true, "network was not quiescent before page close");
  need(run.cleanup?.in_flight_before_page_close === 0, "page close began with requests in flight");
  need(run.cleanup?.page_close_completed === true, "page did not close cleanly");
  need(run.cleanup?.page_close_started_at_ms > readiness?.gate_completed_at_ms, "page closed before product readiness");
  need(run.cleanup?.page_close_started_at_ms > browserAssets?.gate_completed_at_ms, "page closed before browser asset completion");
  need(run.cleanup?.in_flight_after_page_close === 0, "page close concealed an in-flight request");
  need(run.cleanup?.browser?.ok === true, "owned browser cleanup failed");
  need(run.cleanup?.profile_removed === true, "browser profile was not removed");
  need(run.cleanup?.profile_processes_after?.length === 0, "browser/profile process leaked");
  need(
    run.cleanup?.profile_release_observed_at_ms >= run.cleanup?.page_close_completed_at_ms,
    "profile release was accepted before page close completed",
  );
  return { ok: problems.length === 0, problems };
}

export function rendererControls(baseline) {
  const arms = [
    ["omitted-browser-completion-gate", (run) => { run.asset_delivery.browser.gate_applied = false; }],
    ["early-page-profile-close", (run) => {
      run.cleanup.page_close_started_at_ms = run.product_readiness.gate_completed_at_ms - 1;
      run.cleanup.profile_release_observed_at_ms = run.cleanup.page_close_started_at_ms - 1;
    }],
    ["accepted-aborted-required-asset", (run) => {
      const asset = run.asset_delivery.browser.required_assets[0];
      asset.terminal.kind = "Network.loadingFailed";
      asset.terminal.error_text = "net::ERR_ABORTED";
      asset.loading_failed_count = 1;
    }],
    ["server-prewarm-only-success", (run) => {
      run.asset_delivery.browser.required_assets = [];
      run.asset_delivery.browser.gate_passed = true;
    }],
    ["forged-or-stale-loader-ready", (run) => {
      run.product_readiness.samples[0].source = "synthetic-ready-flag";
      run.product_readiness.samples[0].observed_wall_ms = run.asset_delivery.browser.gate_completed_at_ms - 1;
    }],
    ["request-failure-filtering", (run) => {
      run.health.raw_request_failures.push({ url: `${BASE}/synthetic-required.glb`, error: "net::ERR_ABORTED" });
    }],
    ["context-creation-failure", (run) => { run.renderer.initial.actual_context = false; }],
    ["fallback-as-success", (run) => { run.renderer.final.renderer_kind = "canvas2d"; }],
    ["context-loss", (run) => { run.renderer.events.lost.push({ synthetic: true }); }],
    ["stale-telemetry", (run) => { run.renderer.final.sample_seq = run.renderer.initial.sample_seq; }],
    ["renderer-replacement", (run) => { run.renderer.final.canvas_token = "replacement-canvas"; }],
    ["browser-leak", (run) => { run.cleanup.browser.ok = false; run.cleanup.browser.outcome = "synthetic-leak"; }],
    ["profile-leak", (run) => { run.cleanup.profile_removed = false; }],
    ["profile-process-leak", (run) => {
      run.cleanup.profile_processes_after.push({ pid: 31_084, command: "synthetic exact-profile survivor" });
    }],
  ];
  return arms.map(([name, mutate]) => {
    const candidate = structuredClone(baseline);
    mutate(candidate);
    const verdict = rendererGate(candidate);
    return { name, rejected: verdict.ok === false, problems: verdict.problems };
  });
}

function initiatorFacts(initiator) {
  const frames = [];
  for (let stack = initiator?.stack; stack; stack = stack.parent) {
    for (const frame of stack.callFrames || []) {
      frames.push({
        function_name: frame.functionName || "",
        url: frame.url || "",
        line_number: frame.lineNumber,
        column_number: frame.columnNumber,
      });
    }
  }
  return {
    type: initiator?.type || null,
    url: initiator?.url || null,
    line_number: initiator?.lineNumber ?? null,
    frames,
  };
}

function headerValue(headers, name) {
  return Object.entries(headers || {})
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? null;
}

function requiredAssetPath(url) {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== BASE || parsed.search || parsed.hash) return null;
    return Object.hasOwn(ASSET_PREWARM_EXPECTED, parsed.pathname) ? parsed.pathname : null;
  } catch {
    return null;
  }
}

async function installBrowserAssetTrace(page) {
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");
  const requests = new Map();
  const inFlight = new Set();
  const pendingBodyReads = new Set();
  const observers = new Set();
  let phase = "pre-navigation";
  let gateCompletedAtMs = null;

  const notify = () => {
    for (const observer of [...observers]) observer();
  };
  const waitForEventPredicate = (predicate, timeoutMs, label) => new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      observers.delete(check);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      try { if (predicate()) finish(); }
      catch (error) { finish(error); }
    };
    const timer = setTimeout(() => finish(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    observers.add(check);
    check();
  });

  cdp.on("Network.requestWillBeSent", (payload) => {
    const record = {
      request_id: payload.requestId,
      url: payload.request.url,
      path: requiredAssetPath(payload.request.url),
      method: payload.request.method,
      resource_type: payload.type || null,
      document_url: payload.documentURL,
      initiator: initiatorFacts(payload.initiator),
      started_cdp_timestamp: payload.timestamp,
      started_wall_ms: Date.now(),
      phase_at_start: phase,
      response: null,
      terminal: null,
      body: null,
    };
    requests.set(payload.requestId, record);
    inFlight.add(payload.requestId);
    notify();
  });
  cdp.on("Network.responseReceived", (payload) => {
    const record = requests.get(payload.requestId);
    if (!record) return;
    record.response = {
      observed_wall_ms: Date.now(),
      cdp_timestamp: payload.timestamp,
      status: payload.response.status,
      status_text: payload.response.statusText,
      mime_type: payload.response.mimeType,
      protocol: payload.response.protocol,
      content_length: headerValue(payload.response.headers, "content-length"),
      cache_control: headerValue(payload.response.headers, "cache-control"),
      from_disk_cache: payload.response.fromDiskCache === true,
      from_service_worker: payload.response.fromServiceWorker === true,
      timing: payload.response.timing || null,
    };
    notify();
  });
  const finishRequest = (kind, payload) => {
    const record = requests.get(payload.requestId);
    if (!record) return;
    record.terminal = {
      kind,
      observed_wall_ms: Date.now(),
      cdp_timestamp: payload.timestamp,
      duration_ms: Math.round((payload.timestamp - record.started_cdp_timestamp) * 1000),
      encoded_data_length: payload.encodedDataLength ?? null,
      error_text: payload.errorText || null,
      canceled: payload.canceled === true,
      blocked_reason: payload.blockedReason || null,
      phase,
    };
    inFlight.delete(payload.requestId);
    if (record.path && kind === "Network.loadingFinished") {
      const task = cdp.send("Network.getResponseBody", { requestId: payload.requestId })
        .then(({ body, base64Encoded }) => {
          const bytes = Buffer.from(body, base64Encoded ? "base64" : "utf8");
          record.body = {
            available: true,
            bytes: bytes.length,
            sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
            base64_encoded: base64Encoded,
          };
        })
        .catch((error) => { record.body = { available: false, error: error.message }; })
        .finally(() => { pendingBodyReads.delete(task); notify(); });
      pendingBodyReads.add(task);
    }
    notify();
  };
  cdp.on("Network.loadingFinished", (payload) => finishRequest("Network.loadingFinished", payload));
  cdp.on("Network.loadingFailed", (payload) => finishRequest("Network.loadingFailed", payload));

  const recordsForPath = (assetPath) => [...requests.values()].filter((record) => record.path === assetPath);
  const requiredTerminalsPresent = () => Object.keys(ASSET_PREWARM_EXPECTED)
    .every((assetPath) => recordsForPath(assetPath).some((record) => record.terminal));
  const assetSnapshot = (gateApplied) => {
    const requiredAssets = Object.entries(ASSET_PREWARM_EXPECTED).map(([assetPath, expected]) => {
      const matches = recordsForPath(assetPath);
      const record = matches[0] || null;
      const terminal = record?.terminal ? {
        ...record.terminal,
        before_journey: !["journey", "teardown", "page-close"].includes(record.terminal.phase),
        before_teardown: !["teardown", "page-close"].includes(record.terminal.phase),
      } : null;
      return {
        path: assetPath,
        url: record?.url || null,
        expected,
        request_count: matches.length,
        loading_failed_count: matches.filter((entry) => entry.terminal?.kind === "Network.loadingFailed").length,
        request_id: record?.request_id || null,
        resource_type: record?.resource_type || null,
        document_url: record?.document_url || null,
        initiator: record?.initiator || null,
        phase_at_start: record?.phase_at_start || null,
        response_status: record?.response?.status ?? null,
        content_length: record?.response?.content_length ?? null,
        response: record?.response || null,
        terminal,
        body: record?.body || null,
      };
    });
    const gatePassed = gateApplied && requiredAssets.every((asset) => {
      const expected = ASSET_PREWARM_EXPECTED[asset.path];
      return asset.request_count === 1 && asset.url === `${BASE}${asset.path}` &&
        asset.response_status === 200 && Number(asset.content_length) === expected.bytes &&
        asset.terminal?.kind === "Network.loadingFinished" && asset.terminal.before_journey === true &&
        asset.terminal.before_teardown === true && asset.body?.available === true &&
        asset.body.bytes === expected.bytes && asset.body.sha256 === expected.sha256 &&
        asset.loading_failed_count === 0;
    });
    return {
      gate_applied: gateApplied,
      gate_passed: gatePassed,
      gate_completed_at_ms: gateCompletedAtMs,
      exact_url_policy: "origin + pathname match; query/hash forbidden",
      required_assets: requiredAssets,
      in_flight_count: inFlight.size,
      all_request_count: requests.size,
    };
  };

  return {
    setPhase(nextPhase) { phase = nextPhase; },
    async waitForRequiredAssets(timeoutMs = 60_000) {
      await waitForEventPredicate(requiredTerminalsPresent, timeoutMs, "required browser asset terminals");
      await Promise.allSettled([...pendingBodyReads]);
      gateCompletedAtMs = Date.now();
      return assetSnapshot(true);
    },
    async waitForQuiet(timeoutMs = 15_000, quietMs = 250) {
      return new Promise((resolve, reject) => {
        let quietTimer = null;
        const finish = (error) => {
          clearTimeout(timeoutTimer);
          if (quietTimer) clearTimeout(quietTimer);
          observers.delete(check);
          if (error) reject(error); else resolve(true);
        };
        const check = () => {
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = null;
          if (inFlight.size === 0) {
            quietTimer = setTimeout(() => {
              if (inFlight.size === 0) finish();
              else check();
            }, quietMs);
          }
        };
        const timeoutTimer = setTimeout(
          () => finish(new Error(`network quiescence timed out after ${timeoutMs} ms with ${inFlight.size} request(s)`)),
          timeoutMs,
        );
        observers.add(check);
        check();
      });
    },
    async flush() { await Promise.allSettled([...pendingBodyReads]); },
    snapshot(gateApplied = gateCompletedAtMs != null) { return assetSnapshot(gateApplied); },
    inFlightCount() { return inFlight.size; },
  };
}

async function productReadinessSample(page, sampleSeq) {
  return page.evaluate((sequence) => {
    const assembly = window.__assembly;
    const visual = assembly?.avatarVisualState?.() || null;
    const locomotionStates = (visual?.locomotion_clips || []).map((clip) => String(clip).split("(", 1)[0].toLowerCase());
    return {
      source: "window.__assembly",
      sample_seq: sequence,
      observed_wall_ms: Date.now(),
      observed_browser_ms: performance.now(),
      assembly_ready: assembly?.ready === true,
      assembly_disposed: assembly?.disposed === true,
      equipment_ready: assembly?.equipmentReady?.() === true,
      avatar: visual ? {
        variant: visual.avatar_variant || null,
        switch_in_flight: visual.avatar_switch_in_flight === true,
        model_height_m: visual.avatar_model_height_m,
        head_height_m: visual.avatar_head_height_m,
        locomotion_clips: visual.locomotion_clips || [],
        locomotion_states: locomotionStates,
        current_animation_state: visual.current_animation_state || null,
      } : null,
    };
  }, sampleSeq);
}

async function waitForProductReadiness(page, browserGateCompletedAtMs) {
  await page.waitForFunction((states) => {
    const assembly = window.__assembly;
    const visual = assembly?.avatarVisualState?.();
    const clips = (visual?.locomotion_clips || []).map((clip) => String(clip).split("(", 1)[0].toLowerCase());
    return assembly?.ready === true && assembly?.disposed !== true && assembly?.equipmentReady?.() === true &&
      visual?.avatar_variant === "readyplayerme-cyberpunk" && visual?.avatar_switch_in_flight === false &&
      visual?.avatar_model_height_m > 0 && visual?.avatar_head_height_m > 0 &&
      visual?.current_animation_state === "idle" && states.every((state) => clips.includes(state));
  }, { timeout: 60_000, polling: 100 }, EXPECTED_LOCOMOTION_STATES);
  const samples = [await productReadinessSample(page, 1)];
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await sleep(120);
  samples.push(await productReadinessSample(page, 2));
  const gateCompletedAtMs = Date.now();
  const gatePassed = samples.every((sample) =>
    sample.source === "window.__assembly" && sample.assembly_ready === true &&
    sample.assembly_disposed === false && sample.equipment_ready === true &&
    sample.avatar?.variant === "readyplayerme-cyberpunk" && sample.avatar.switch_in_flight === false &&
    sample.avatar.model_height_m > 0 && sample.avatar.head_height_m > 0 &&
    sample.avatar.current_animation_state === "idle" &&
    EXPECTED_LOCOMOTION_STATES.every((state) => sample.avatar.locomotion_states.includes(state)) &&
    sample.observed_wall_ms >= browserGateCompletedAtMs,
  ) && samples[1].sample_seq > samples[0].sample_seq;
  return {
    gate_applied: true,
    gate_passed: gatePassed,
    browser_asset_gate_completed_at_ms: browserGateCompletedAtMs,
    gate_completed_at_ms: gateCompletedAtMs,
    samples,
  };
}

async function installRendererTelemetry(page, forceFallback) {
  await page.evaluateOnNewDocument((fallback) => {
    const original = HTMLCanvasElement.prototype.getContext;
    const telemetry = {
      sample_seq: 0,
      get_context: [],
      lost: [],
      restored: [],
      forced_fallback: fallback,
    };
    window.__wo310RendererTelemetry = telemetry;
    HTMLCanvasElement.prototype.getContext = function instrumentedGetContext(type, ...args) {
      const requested = String(type || "").toLowerCase();
      if (fallback && (requested === "webgl" || requested === "webgl2" || requested === "experimental-webgl")) {
        telemetry.get_context.push({ type: requested, returned: false, forced: true, at: performance.now() });
        return null;
      }
      const context = original.call(this, type, ...args);
      if (requested.includes("webgl")) {
        telemetry.get_context.push({ type: requested, returned: !!context, forced: false, at: performance.now() });
      }
      return context;
    };
    document.addEventListener("webglcontextlost", (event) => {
      telemetry.lost.push({ at: performance.now(), default_prevented: event.defaultPrevented });
    }, true);
    document.addEventListener("webglcontextrestored", () => {
      telemetry.restored.push({ at: performance.now() });
    }, true);
  }, forceFallback);
}

async function rendererSample(page) {
  return page.evaluate(() => {
    const telemetry = window.__wo310RendererTelemetry;
    telemetry.sample_seq += 1;
    const scene = window.__assembly?.scene || null;
    const implementation = scene?._impl || null;
    const renderer = implementation?.renderer || null;
    const canvas = renderer?.domElement || implementation?.canvas || null;
    const context = renderer?.getContext?.() || null;
    if (canvas && !canvas.__wo310CanvasToken) {
      canvas.__wo310CanvasToken = `canvas-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
    const extension = context?.getExtension?.("WEBGL_debug_renderer_info") || null;
    const parameter = (key) => {
      try { return context && key != null ? context.getParameter(key) : null; }
      catch { return null; }
    };
    return {
      sample_seq: telemetry.sample_seq,
      sampled_at_ms: performance.now(),
      renderer_kind: window.__assembly?.debugState?.().renderer_kind || window.__assembly?.rendererKind || null,
      actual_context: !!context,
      context_lost: context?.isContextLost?.() ?? null,
      canvas_connected: canvas?.isConnected === true,
      canvas_token: canvas?.__wo310CanvasToken || null,
      webgl_version: parameter(context?.VERSION),
      shading_language_version: parameter(context?.SHADING_LANGUAGE_VERSION),
      vendor: parameter(context?.VENDOR),
      renderer: parameter(context?.RENDERER),
      unmasked_vendor: extension ? parameter(extension.UNMASKED_VENDOR_WEBGL) : null,
      unmasked_renderer: extension ? parameter(extension.UNMASKED_RENDERER_WEBGL) : null,
    };
  });
}

async function currentUiProbe(page, viewportName, phase) {
  return page.evaluate(({ viewportName: name, phase: moment }) => {
    const rect = (element) => {
      const value = element?.getBoundingClientRect();
      return value ? {
        left: Number(value.left.toFixed(3)), top: Number(value.top.toFixed(3)),
        right: Number(value.right.toFixed(3)), bottom: Number(value.bottom.toFixed(3)),
        width: Number(value.width.toFixed(3)), height: Number(value.height.toFixed(3)),
      } : null;
    };
    const snapshot = window.__assembly.chrome.snapshot();
    const footer = document.querySelector("footer.controls");
    const header = document.querySelector("header.role-banner");
    const anchors = Array.from(document.querySelectorAll("footer.controls .footer-link")).map((link) => ({
      label: link.textContent.trim(), href: link.href, visible: getComputedStyle(link).display !== "none",
    }));
    const sourceLink = document.querySelector("header.role-banner .header-github-link");
    const edge = snapshot.menu?.left ?? 0;
    const panel = snapshot.panel;
    const footerRect = rect(footer);
    const headerRect = rect(header);
    const panelContained = !panel || (
      panel.left >= 0 && panel.right <= innerWidth &&
      panel.top >= (headerRect?.bottom || 0) && panel.bottom <= (footerRect?.top || innerHeight)
    );
    return {
      viewport: name,
      phase: moment,
      inner: { width: innerWidth, height: innerHeight },
      snapshot,
      footer: footerRect,
      header: headerRect,
      footer_links: anchors,
      source_link: sourceLink ? {
        label: sourceLink.textContent.trim(), href: sourceLink.href,
        target: sourceLink.target, rel: sourceLink.rel, visible: getComputedStyle(sourceLink).display !== "none",
      } : null,
      no_jump_in: !document.body.innerText.includes("Jump in"),
      symmetric_menu_inset: Math.abs(edge - (innerWidth - snapshot.menu.right)) <= 0.5,
      panel_contained: panelContained,
      no_horizontal_overflow: document.documentElement.scrollWidth <= innerWidth,
      no_vertical_body_overflow: document.documentElement.scrollHeight <= innerHeight,
      edge,
    };
  }, { viewportName, phase });
}

function uiProblems(records) {
  const problems = [];
  for (const record of records) {
    const prefix = `${record.viewport}/${record.phase}`;
    if (!record.no_jump_in) problems.push(`${prefix}: Jump in returned`);
    if (!record.symmetric_menu_inset) problems.push(`${prefix}: header/menu inset is asymmetric`);
    if (!record.panel_contained) problems.push(`${prefix}: Inspector escaped header/footer/viewport bounds`);
    if (!record.no_horizontal_overflow) problems.push(`${prefix}: horizontal overflow`);
    if (!record.no_vertical_body_overflow) problems.push(`${prefix}: body overflow`);
    const expected = [
      ["labs.peers.social/open-spatial-lab", "https://labs.peers.social/open-spatial-lab/"],
    ];
    if (JSON.stringify(record.footer_links.map((entry) => [entry.label, entry.href])) !== JSON.stringify(expected)) {
      problems.push(`${prefix}: footer order/hrefs differ`);
    }
    if (
      record.source_link?.label !== "GitHub ↗"
      || record.source_link?.href !== "https://github.com/openspatials/open-spatial-lab"
      || record.source_link?.target !== "_blank"
      || record.source_link?.rel !== "noopener noreferrer"
      || record.source_link?.visible !== true
    ) problems.push(`${prefix}: top GitHub source link differs`);
  }
  return problems;
}

async function exerciseViewport(page, profile, runId) {
  await page.setViewport(profile);
  await page.evaluate(() => window.__assembly.viewport.forceSync());
  await sleep(150);
  const records = [];
  const toggle = await page.$("#btn-rail-toggle");
  const expanded = await page.$eval("#btn-rail-toggle", (button) => button.getAttribute("aria-expanded"));
  if (expanded !== "true") await toggle.click();
  await sleep(100);
  records.push(await currentUiProbe(page, profile.name, "open"));

  const cameraBefore = await page.$eval("#btn-camera-toggle", (button) => ({
    hidden: button.hidden,
    mode: button.dataset.serverViewMode,
    label: button.getAttribute("aria-label"),
    pressed: button.getAttribute("aria-pressed"),
    text: button.textContent.trim(),
  }));
  await page.click("#btn-camera-toggle");
  await page.waitForFunction(() => {
    const button = document.getElementById("btn-camera-toggle");
    return button?.dataset.serverViewMode === "top_down" && button.getAttribute("aria-pressed") === "true";
  }, { timeout: 10_000, polling: 50 });
  const cameraTopDown = await page.$eval("#btn-camera-toggle", (button) => ({
    mode: button.dataset.serverViewMode,
    label: button.getAttribute("aria-label"),
    pressed: button.getAttribute("aria-pressed"),
    text: button.textContent.trim(),
  }));
  await page.click("#btn-camera-toggle");
  await page.waitForFunction(() => {
    const button = document.getElementById("btn-camera-toggle");
    return button?.dataset.serverViewMode === "third_person" && button.getAttribute("aria-pressed") === "false";
  }, { timeout: 10_000, polling: 50 });
  const cameraRestored = await page.$eval("#btn-camera-toggle", (button) => ({
    mode: button.dataset.serverViewMode,
    label: button.getAttribute("aria-label"),
    pressed: button.getAttribute("aria-pressed"),
    text: button.textContent.trim(),
  }));
  const cameraOk =
    cameraBefore.hidden === false && cameraBefore.mode === "third_person" && cameraBefore.text === "" &&
    cameraTopDown.mode === "top_down" && cameraTopDown.pressed === "true" && cameraTopDown.text === "" &&
    cameraRestored.mode === "third_person" && cameraRestored.pressed === "false" && cameraRestored.text === "";

  const strip = await page.$(".panel-control-strip");
  const stripBox = await strip.boundingBox();
  assert.ok(stripBox, `${profile.name} Inspector strip has no geometry`);
  await page.mouse.move(stripBox.x + 40, stripBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(Math.max(24, stripBox.x - 60), Math.min(profile.height - 180, stripBox.y + 70), { steps: 5 });
  await page.mouse.up();
  await sleep(100);
  const dragged = await currentUiProbe(page, profile.name, "dragged");
  records.push(dragged);

  await page.focus("#rail-resizer");
  await page.keyboard.press("ArrowLeft");
  await page.focus("#panel-height-resizer");
  await page.keyboard.press("ArrowUp");
  await sleep(100);
  const resized = await currentUiProbe(page, profile.name, "resized");
  records.push(resized);

  await page.click("#btn-panel-close");
  await page.click("#btn-rail-toggle");
  await sleep(120);
  const reset = await currentUiProbe(page, profile.name, "reset");
  records.push(reset);
  const geometryOk =
    dragged.snapshot.dock === "free" &&
    resized.snapshot.size_mode === "manual" &&
    reset.snapshot.dock === "right" &&
    reset.snapshot.size_mode === "auto" &&
    reset.snapshot.preferred_size == null;

  await page.screenshot({
    path: path.join(diagnostics, `${runId}-${profile.name}-ui.png`),
    fullPage: false,
  });
  const problems = uiProblems(records);
  if (!cameraOk) problems.push(`${profile.name}: camera icon semantics/toggle/reset failed`);
  if (!geometryOk) problems.push(`${profile.name}: Inspector drag/resize/reopen-reset failed`);
  return { name: profile.name, ok: problems.length === 0, camera: { before: cameraBefore, top_down: cameraTopDown, restored: cameraRestored }, records, problems };
}

async function runBrowserArm({ id, executablePath, forceFallback, serverPrewarm }) {
  const run = {
    id,
    mode: forceFallback ? "canvas2d-fallback" : "webgl",
    started_at: new Date().toISOString(),
    browser: {},
    asset_delivery: { server_prewarm: structuredClone(serverPrewarm || []), browser: null },
    product_readiness: null,
    journey: {},
    renderer: { events: {} },
    health: {},
    viewports: [],
    cleanup: {},
  };
  const puppeteer = require("puppeteer-core");
  let browser;
  let owner;
  let page;
  let trace;
  const consoleRecords = [];
  const pageErrors = [];
  const requestFailures = [];
  const badResponses = [];
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      timeout: 90_000,
      args: [
        "--no-sandbox",
        "--password-store=basic",
        "--use-mock-keychain",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--window-size=1200,800",
      ],
      defaultViewport: VIEWPORTS[0],
    });
    const spawnArgs = browser.process()?.spawnargs || [];
    const profileArg = spawnArgs.find((arg) => arg.startsWith("--user-data-dir="));
    const profile = profileArg ? profileArg.slice("--user-data-dir=".length) : null;
    owner = createOwnedBrowserTeardown(browser, { label: `runtime-${id}`, profilePath: profile });
    run.browser = {
      pid: browser.process()?.pid || null,
      version: await browser.version(),
      spawn_args: spawnArgs,
      profile,
    };
    page = await browser.newPage();
    await installRendererTelemetry(page, forceFallback);
    trace = await installBrowserAssetTrace(page);
    page.on("console", (message) => consoleRecords.push({ type: message.type(), text: message.text() }));
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) => requestFailures.push({ url: request.url(), error: request.failure()?.errorText || null }));
    page.on("response", (response) => { if (response.status() >= 400) badResponses.push({ url: response.url(), status: response.status() }); });
    trace.setPhase("navigation-load-boundary");
    await page.goto(`${BASE}/index.html?role=source`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForSelector('body[data-assembly-ready="1"]', { timeout: 30000 });
    await page.waitForFunction(() => window.__assembly?.ready === true, { timeout: 30000, polling: 100 });
    if (!forceFallback) {
      trace.setPhase("browser-asset-completion");
      run.asset_delivery.browser = await trace.waitForRequiredAssets();
      assert.equal(
        run.asset_delivery.browser.gate_passed,
        true,
        `${id}: exact browser asset completion failed: ${JSON.stringify(run.asset_delivery.browser.required_assets)}`,
      );
      trace.setPhase("product-loader-readiness");
      run.product_readiness = await waitForProductReadiness(page, run.asset_delivery.browser.gate_completed_at_ms);
      assert.equal(run.product_readiness.gate_passed, true, `${id}: product loader readiness did not pass`);
    } else {
      run.asset_delivery.browser = {
        ...trace.snapshot(false),
        not_applicable_reason: "forced Canvas2D resiliency arm is not eligible for the WebGL asset gate",
      };
      run.product_readiness = {
        gate_applied: false,
        gate_passed: false,
        not_applicable_reason: "forced Canvas2D resiliency arm",
        samples: [],
      };
    }
    trace.setPhase("journey");
    run.journey.started_at_ms = Date.now();
    run.renderer.initial = await rendererSample(page);
    if (!forceFallback) {
      for (const profileDefinition of VIEWPORTS) {
        run.viewports.push(await exerciseViewport(page, profileDefinition, id));
      }
    } else {
      const fallbackProbe = await currentUiProbe(page, "fallback", "ready");
      run.viewports = [{ name: "fallback", ok: fallbackProbe.no_jump_in && fallbackProbe.footer_links.length === 1, records: [fallbackProbe], problems: [] }];
      await page.screenshot({ path: path.join(diagnostics, `${id}-canvas2d-fallback.png`) });
    }
    await sleep(300);
    run.renderer.final = await rendererSample(page);
    run.renderer.events = await page.evaluate(() => ({
      lost: window.__wo310RendererTelemetry.lost,
      restored: window.__wo310RendererTelemetry.restored,
      get_context: window.__wo310RendererTelemetry.get_context,
      fallback_get_context_count: window.__wo310RendererTelemetry.get_context.filter((entry) => entry.forced).length,
    }));
    run.journey.completed_at_ms = Date.now();
    run.fallback_resiliency = forceFallback ? {
      page_ready: true,
      renderer_kind: run.renderer.final.renderer_kind,
      actual_context: run.renderer.final.actual_context,
      footer_present: run.viewports[0].records[0].footer_links.length === 1,
    } : null;
  } catch (error) {
    run.failure = { name: error.name, message: error.message, stack: error.stack };
  } finally {
    if (page && !page.isClosed()) {
      trace?.setPhase("teardown");
      run.cleanup.product_dispose_started_at_ms = Date.now();
      try {
        const disposal = await page.evaluate(() => {
          const assembly = window.__assembly;
          const available = typeof assembly?.dispose === "function";
          if (available) assembly.dispose();
          return {
            available,
            assembly_ready_after: assembly?.ready === true,
            assembly_disposed_after: assembly?.disposed === true,
            body_ready_after: document.body.dataset.assemblyReady || null,
          };
        });
        run.cleanup.product_disposal = disposal;
        run.cleanup.product_disposed = disposal.available === true && disposal.assembly_disposed_after === true;
      } catch (error) {
        run.cleanup.product_disposed = false;
        run.cleanup.product_disposal_error = error.message;
      }
      try {
        run.cleanup.network_quiet_before_page_close = await trace.waitForQuiet();
      } catch (error) {
        run.cleanup.network_quiet_before_page_close = false;
        run.cleanup.network_quiet_error = error.message;
      }
      await trace?.flush();
      run.cleanup.in_flight_before_page_close = trace?.inFlightCount() ?? null;
      trace?.setPhase("page-close");
      run.cleanup.page_close_started_at_ms = Date.now();
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("page.close timed out after 4000 ms")), 4_000);
          page.close({ runBeforeUnload: false }).then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); },
          );
        });
        run.cleanup.page_close_completed = true;
      } catch (error) {
        run.cleanup.page_close_completed = false;
        run.cleanup.page_close_error = error.message;
      }
      run.cleanup.page_close_completed_at_ms = Date.now();
      run.cleanup.in_flight_after_page_close = trace?.inFlightCount() ?? null;
    } else {
      run.cleanup.product_disposed = false;
      run.cleanup.network_quiet_before_page_close = false;
      run.cleanup.in_flight_before_page_close = trace?.inFlightCount() ?? null;
      run.cleanup.page_close_completed = page?.isClosed() === true;
      run.cleanup.in_flight_after_page_close = trace?.inFlightCount() ?? null;
    }
    if (trace) {
      const gateApplied = run.asset_delivery.browser?.gate_applied === true;
      run.asset_delivery.browser = {
        ...trace.snapshot(gateApplied),
        ...(forceFallback ? {
          not_applicable_reason: "forced Canvas2D resiliency arm is not eligible for the WebGL asset gate",
        } : {}),
      };
    }
    const rawRequestFailures = structuredClone(requestFailures);
    run.health = {
      console: structuredClone(consoleRecords),
      console_errors: consoleRecords.filter((entry) => entry.type === "error"),
      page_errors: structuredClone(pageErrors),
      raw_request_failures: rawRequestFailures,
      request_failures: structuredClone(rawRequestFailures),
      request_failure_filtering_applied: false,
      bad_responses: structuredClone(badResponses),
      context_creation_errors: consoleRecords.filter((entry) => /WebGL context could not be created|Error creating WebGL context/i.test(entry.text)),
      fallback_messages: consoleRecords.filter((entry) => /canvas2d fallback|degrading to canvas2d/i.test(entry.text)),
    };
    if (owner) run.cleanup.browser = await owner.shutdown();
    else run.cleanup.browser = { ok: false, outcome: "browser-owner-unavailable" };
    const profile = run.browser.profile;
    let profileProcesses = ["profile path unavailable"];
    let profileRemoved = false;
    if (profile) {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        profileProcesses = listExactProfileProcesses(profile);
        profileRemoved = !existsSync(profile);
        if (profileProcesses.length === 0 && profileRemoved) break;
        await sleep(100);
      }
    }
    run.cleanup.profile_removed = profileRemoved;
    run.cleanup.profile_processes_after = profileProcesses;
    run.cleanup.profile_release_observed_at_ms = Date.now();
    run.finished_at = new Date().toISOString();
  }
  if (!forceFallback) run.verdict = rendererGate(run);
  return run;
}

async function main() {
  await mkdir(diagnostics, { recursive: true });
  const protectedBefore = protectedBrowserMains();
  const { startBackends } = require("./orchestrator.js");
  const backends = await startBackends({ log: console.log, backendPorts: { a: PORTS.a, b: PORTS.b, lobby: PORTS.lobby } });
  const frontend = spawn(process.execPath, [path.join(ROOT, "src", "serve.js"), String(PORTS.frontend)], {
    stdio: "inherit",
    env: { ...process.env, BACKEND_A_PORT: String(PORTS.a), BACKEND_B_PORT: String(PORTS.b), BACKEND_LOBBY_PORT: String(PORTS.lobby) },
  });
  const diagnostics = {
    work_order: "runtime",
    command: "npm run runtime-clean-webgl-ui",
    captured_at: new Date().toISOString(),
    ports: PORTS,
    protected_before: protectedBefore,
    load: spawnSync("uptime", [], { encoding: "utf8" }).stdout.trim(),
    runs: [], controls: [], cleanup: { frontend_pid: frontend.pid },
  };
  let primaryError = null;
  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try { if ((await fetch(`${BASE}/`)).ok) break; } catch {}
      if (attempt === 79) throw new Error("isolated frontend did not become ready");
      await sleep(100);
    }
    const { findBrowser } = await import(path.join(SCENE_CORE, "scripts", "find-browser.mjs"));
    const executablePath = process.env.feature_BROWSER_EXECUTABLE
      ? path.resolve(process.env.feature_BROWSER_EXECUTABLE)
      : findBrowser();
    assert.ok(executablePath, "no local Chrome/Chromium found");
    diagnostics.browser_executable = executablePath;
    diagnostics.asset_prewarm = [];
    for (const [assetPath, expected] of Object.entries(ASSET_PREWARM_EXPECTED)) {
      const response = await fetch(`${BASE}${assetPath}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      const record = {
        path: assetPath,
        status: response.status,
        bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        browser_request_health_exempt: false,
        purpose:
          "prove the isolated server can deliver the exact cold asset completely before " +
          "the two fresh browser/profile WebGL gates",
      };
      diagnostics.asset_prewarm.push(record);
      assert.equal(response.ok, true, `asset prewarm failed for ${assetPath}`);
      assert.equal(record.bytes, expected.bytes, `asset prewarm byte count drifted for ${assetPath}`);
      assert.equal(record.sha256, expected.sha256, `asset prewarm hash drifted for ${assetPath}`);
    }
    diagnostics.runs.push(await runBrowserArm({
      id: "webgl-run-1", executablePath, forceFallback: false, serverPrewarm: diagnostics.asset_prewarm,
    }));
    diagnostics.runs.push(await runBrowserArm({
      id: "webgl-run-2", executablePath, forceFallback: false, serverPrewarm: diagnostics.asset_prewarm,
    }));
    const fallback = await runBrowserArm({
      id: "fallback-arm", executablePath, forceFallback: true, serverPrewarm: diagnostics.asset_prewarm,
    });
    diagnostics.fallback = fallback;
    for (const run of diagnostics.runs) {
      assert.equal(run.verdict?.ok, true, `${run.id}: ${run.verdict?.problems?.join("; ") || run.failure?.message}`);
    }
    assert.equal(fallback.fallback_resiliency?.page_ready, true, "Canvas2D fallback did not keep the page ready");
    assert.equal(fallback.fallback_resiliency?.renderer_kind, "canvas2d", "forced fallback did not select Canvas2D");
    assert.equal(fallback.fallback_resiliency?.actual_context, false, "forced fallback unexpectedly retained WebGL");
    assert.equal(fallback.health?.raw_request_failures?.length, 0, "Canvas2D fallback had request failures");
    assert.equal(fallback.health?.page_errors?.length, 0, "Canvas2D fallback had page errors");
    assert.equal(fallback.health?.bad_responses?.length, 0, "Canvas2D fallback had HTTP errors");
    assert.equal(fallback.cleanup?.product_disposed, true, "Canvas2D fallback product teardown failed");
    assert.equal(fallback.cleanup?.network_quiet_before_page_close, true, "Canvas2D fallback did not quiesce before close");
    assert.equal(fallback.cleanup?.in_flight_before_page_close, 0, "Canvas2D fallback closed with requests in flight");
    assert.equal(fallback.cleanup?.page_close_completed, true, "Canvas2D fallback page did not close cleanly");
    assert.equal(fallback.cleanup?.in_flight_after_page_close, 0, "Canvas2D fallback close concealed an in-flight request");
    assert.equal(fallback.cleanup?.browser?.ok, true, "Canvas2D fallback browser cleanup failed");
    assert.equal(fallback.cleanup?.profile_removed, true, "Canvas2D fallback profile was not removed");
    assert.equal(fallback.cleanup?.profile_processes_after?.length, 0, "Canvas2D fallback profile process leaked");
    const fallbackAsWebgl = rendererGate({ ...structuredClone(fallback), mode: "webgl" });
    diagnostics.fallback.webgl_gate = fallbackAsWebgl;
    assert.equal(fallbackAsWebgl.ok, false, "Canvas2D fallback was incorrectly accepted as WebGL");
    diagnostics.controls = rendererControls(diagnostics.runs[0]);
    assert.equal(diagnostics.controls.every((arm) => arm.rejected), true, "one or more renderer controls did not fail closed");
  } catch (error) {
    primaryError = error;
    diagnostics.failure = { name: error.name, message: error.message, stack: error.stack };
  } finally {
    try { frontend.kill("SIGTERM"); diagnostics.cleanup.frontend_term_sent = true; }
    catch (error) { primaryError ||= error; }
    try { await backends.stop(); diagnostics.cleanup.backends_stopped = true; }
    catch (error) { primaryError ||= error; }
    await sleep(500);
    diagnostics.cleanup.frontend_stopped = frontend.exitCode != null || frontend.signalCode != null;
    const portStates = {};
    for (const [name, port] of Object.entries(PORTS)) portStates[name] = await portIsOpen(port);
    diagnostics.cleanup.port_open_after = portStates;
    diagnostics.cleanup.ports_released = Object.values(portStates).every((open) => open === false);
    if (!diagnostics.cleanup.frontend_stopped) primaryError ||= new Error("owned frontend remained alive");
    if (!diagnostics.cleanup.backends_stopped) primaryError ||= new Error("owned backend shutdown was not proven");
    if (!diagnostics.cleanup.ports_released) primaryError ||= new Error("one or more owned ports remained open");
    diagnostics.protected_after = protectedBrowserMains();
    diagnostics.cleanup.protected_unchanged = diagnostics.protected_after === diagnostics.protected_before;
    if (!diagnostics.cleanup.protected_unchanged) primaryError ||= new Error("protected listeners changed");
    diagnostics.outcome = primaryError ? "FAIL" : "PASS";
    await writeFile(path.join(diagnostics, "runtime-clean-webgl-ui-diagnostics.json"), `${JSON.stringify(diagnostics, null, 2)}\n`);
  }
  if (primaryError) throw primaryError;
  console.log(`feature_CLEAN_WEBGL PASS fresh_runs=2 fallback=PASS_AS_RESILIENCY_ONLY controls=${diagnostics.controls.length}`);
  console.log(`diagnostics=${path.join(diagnostics, "runtime-clean-webgl-ui-diagnostics.json")}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`feature_CLEAN_WEBGL FAIL: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
