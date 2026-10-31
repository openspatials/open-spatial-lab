// Checks every world the worlds configuration lists (worlds.json, or the file named by OSL_WORLDS), by name:
//
//   - the configuration itself: keys, ports and addresses that clash or do not agree;
//   - launched: the running launch started it, on its listed port (the launch records what it started in
//     .runtime/launched-worlds.json, or $OSL_RUN_DIR/launched-worlds.json);
//   - answers: its world server answers at its address, and it is the world the list says;
//   - routed: the frontend reaches it at /api/{key}/;
//   - portals: every portal of every answering world leads to a listed world that answers. A portal into a
//     world whose server is not running wakes but cannot deliver the visitor; this check names it first.
//
// A missing port is always reported, never skipped. Exits 0 only when every listed world passes.
//
// Usage: node tools/check-worlds.mjs [--json]
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { entryBase } from "../web/wow-portal.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { loadWorlds } = require("../src/worlds-config.js");
const { NODES } = require("../runtime/world-server/src/config.js");
const ACCEPT = "application/wow+json, application/json;q=0.9";

async function getJson(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { Accept: ACCEPT }, signal: controller.signal });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json };
  } catch (error) {
    const cause = error.cause && error.cause.code ? error.cause.code : error.name === "AbortError" ? "no answer in time" : error.message;
    return { status: 0, error: cause };
  } finally {
    clearTimeout(timer);
  }
}

function expectedLocation(world) {
  return world.template === world.key ? NODES[world.key].location_id : world.location_id;
}

function launchRecord() {
  const file = join(process.env.OSL_RUN_DIR || join(ROOT, ".runtime"), "launched-worlds.json");
  try { return { file, record: JSON.parse(readFileSync(file, "utf8")) }; } catch { return { file, record: null }; }
}

export async function checkWorlds() {
  const config = loadWorlds();
  const { file: recordFile, record } = launchRecord();
  const launched = new Map(((record && record.worlds) || []).map((w) => [w.key, w]));
  const results = [];
  const problems = config.problems.map((text) => ({ world: null, text: `configuration: ${text}` }));
  const answering = new Map();

  for (const world of config.worlds) {
    const name = `${world.name} (${world.key}, port ${world.port})`;
    const result = { key: world.key, name: world.name, port: world.port, address: world.address, launched: false, answers: false, routed: false, problems: [] };
    const fail = (text) => { result.problems.push(text); problems.push({ world: world.key, text: `${name}: ${text}` }); };

    // Launched: the running launch started this world on this port.
    const started = launched.get(world.key);
    if (!record) fail(`port ${world.port} is missing from the launch: there is no launch record (${recordFile}); start the lab with npm start`);
    else if (!started) fail(`port ${world.port} is missing from the launch: the running launch (started ${record.started_at}) did not start this world; restart the lab (npm stop, npm start)`);
    else if (started.port !== world.port) fail(`port ${world.port} is missing from the launch: the running launch started this world on port ${started.port}; restart the lab`);
    else result.launched = true;

    // Answers: its world server answers at its address, as the world the list says.
    const health = await getJson(new URL("healthz", world.address).href);
    if (health.status !== 200) fail(`does not answer at ${world.address} (${health.status ? `HTTP ${health.status}` : health.error})`);
    else if (health.json && health.json.location_id !== expectedLocation(world)) fail(`port ${world.port} answers as ${health.json.location_id}, not as ${expectedLocation(world)}`);
    else { result.answers = true; answering.set(world.key, world); }

    // Routed: the frontend reaches it.
    const routed = await getJson(`http://127.0.0.1:${config.frontend.port}/api/${world.key}/healthz`);
    if (routed.status !== 200) fail(`the frontend (port ${config.frontend.port}) does not reach it at /api/${world.key}/ (${routed.status ? `HTTP ${routed.status}` : routed.error})`);
    else result.routed = true;
    results.push(result);
  }

  // Launched worlds that are no longer listed: not a failure, but said.
  const notes = [];
  for (const [key, w] of launched) {
    if (!config.worlds.some((world) => world.key === key)) notes.push(`${w.name} (${key}, port ${w.port}) is running but no longer listed; restart the lab to stop it`);
  }

  // Portals: each leads to a listed world that answers.
  const portals = [];
  const byBase = new Map(config.worlds.map((w) => [new URL(w.address).href, w]));
  for (const world of answering.values()) {
    const doc = await getJson(new URL("wow/world", world.address).href);
    const count = Number(doc.json && doc.json.portals && doc.json.portals.portal_count) || 0;
    for (let id = 1; id <= count; id += 1) {
      const portal = await getJson(new URL(`wow/portal/${id}`, world.address).href);
      if (portal.status !== 200 || !portal.json) continue;
      const label = `portal ${id} "${portal.json.label || ""}" in ${world.name}`;
      const destination = portal.json.destination;
      if (!destination) { portals.push({ world: world.key, id, destination: null, ok: true, note: "leads nowhere" }); continue; }
      let base;
      try { base = entryBase(destination); } catch { base = null; }
      const target = base && byBase.get(base);
      let text = null;
      if (!base) text = `${label} leads to ${destination}, which is not a URL`;
      else if (!target) text = `${label} leads to ${base}, port ${new URL(base).port || 80}, which is not a listed world`;
      else if (!answering.has(target.key)) text = `${label} leads to ${target.name} (port ${target.port}), which does not answer: the portal would wake but not deliver the visitor`;
      portals.push({ world: world.key, id, destination, target: target ? target.key : null, ok: !text });
      if (text) problems.push({ world: world.key, portal: id, text });
    }
  }
  return { config: config.file, launch_record: recordFile, frontend: config.frontend, worlds: results, portals, notes, problems, ok: problems.length === 0 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await checkWorlds();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Worlds configuration: ${report.config}`);
    for (const w of report.worlds) {
      console.log(`${w.problems.length ? "FAIL" : "OK  "} ${w.name} (${w.key}) port ${w.port} ${w.address}: ${w.problems.length ? w.problems.join("; ") : "launched, answers, reached through the frontend"}`);
    }
    for (const p of report.problems.filter((p) => !p.world || p.portal)) console.log(`FAIL ${p.text}`);
    console.log(`Portals checked: ${report.portals.length}`);
    for (const n of report.notes) console.log(`NOTE ${n}`);
    console.log(report.ok ? "PASS: every listed world is launched and answers." : `FAIL: ${report.problems.length} problem(s).`);
  }
  process.exit(report.ok ? 0 : 1);
}
