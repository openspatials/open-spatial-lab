// Run the pinned situation checker against this candidate, with isolated
// resources. Use the project's browser wrapper; this runner does not select a
// browser or change shared services. The checker owns its sole browser client.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CODE, createLab } from "../arch-i4/main-demo/lab.mjs";

const args = process.argv.slice(2);
const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
if (args.includes("--help")) {
  console.log("reference-qualification --checker FILE --out DIR --scratch DIR [--port-base 37419] [--path explicit|shared-three] [--plant wrong-file]");
  process.exit(0);
}
assert(process.env.OSL_HEAVY_HELD === "1" && process.env.HEAVY_RUN_SLOT_COUNT === "2", "run through browser-run.sh with HEAVY_RUN_SLOT_COUNT=2");
assert(value("--checker") && value("--out") && value("--scratch"), "checker, output and scratch directories are required");
const first = Number(value("--port-base") || 37419), resourcePath = value("--path") || "explicit";
assert(Number.isInteger(first) && first > 1024 && first < 65531);
assert(["explicit", "shared-three"].includes(resourcePath));
for (let port = first; port <= first + 4; port++) {
  const probe = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  assert.equal(probe.status, 1, `port ${port} must be free (or lsof failed): ${probe.stdout}${probe.stderr}`);
}
const out = resolve(value("--out")), scratch = resolve(value("--scratch"));
mkdirSync(out, { recursive: true }); mkdirSync(scratch, { recursive: true });
const owned = mkdtempSync(join(scratch, "renderer-reference-"));
const lab = createLab({ dir: owned, first });
const receipt = { candidate: CODE, first, resourcePath, scratch: owned, status: "RUNNING", cleanup: null };
let checker;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
  checker?.kill(signal);
  await lab.stop();
  receipt.status = "INTERRUPTED"; receipt.signal = signal;
  writeFileSync(join(out, "qualification-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  process.exit(128 + (signal === "SIGINT" ? 2 : 15));
});
try {
  lab.start();
  const command = [resolve(value("--checker")), "--out", out];
  if (value("--plant")) command.push("--plant", value("--plant"));
  const child = spawn(process.execPath, command, { cwd: CODE, stdio: "inherit", env: { ...process.env,
    OSL_CANDIDATE_CODE: CODE, OSL_CANDIDATE_BASE: `${lab.front}/`, OSL_AVATAR_RENDER: resourcePath, OSL_BROWSER_PROFILE: join(owned, "profile") } });
  checker = child;
  receipt.command = command;
  const status = await new Promise((done, reject) => { child.on("error", reject); child.on("exit", done); });
  receipt.status = status === 0 ? "PASS" : "FAIL"; receipt.exitCode = status;
  if (status !== 0) process.exitCode = 1;
} catch (error) { receipt.status = "FAIL"; receipt.error = String(error.stack || error); process.exitCode = 1; }
finally {
  await lab.stop();
  receipt.cleanup = { remainingListeners: [] };
  for (let port = first; port <= first + 4; port++) if (spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"]).status === 0) receipt.cleanup.remainingListeners.push(port);
  if (receipt.cleanup.remainingListeners.length) { receipt.status = "FAIL"; process.exitCode = 1; }
  writeFileSync(join(out, "qualification-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
}
