// Planted faults for a check that runs in Node, not in a page. A fault is exact string edits in a copy of the code
// (made by plantFaults, as for the page checks); the check file itself runs in that copy and must fail, with a message
// that matches the reason the fault is planted for.
//
//   if (process.argv.includes("--faults")) runPlantedFaults({ file: "src/some-check.mjs", faults: [
//     { name: "what is broken", expect: /the check's own failure message/, edits: [{ file, find, replace }] },
//   ] });
//
// Exit 0: every fault caught for its reason. Exit 1: a fault was missed (the check stayed green). Exit 2: a harness
// error (an edit no longer applies, or the check failed for another reason).
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { basename, join } from "node:path";
import { CODE, HarnessError, plantFaults } from "../arch-i4/main-demo/lab.mjs";

const RUN_LIMIT_MS = 180000;
const LOAD_FAILURE = /ETIMEDOUT|timed out|ENOMEM|EAGAIN/i;

function runIn(code, file) {
  const run = spawnSync(process.execPath, [join(code, file)], { cwd: code, env: process.env, encoding: "utf8", timeout: RUN_LIMIT_MS });
  const text = `${run.stdout || ""}${run.stderr || ""}${run.error ? String(run.error.message) : ""}`;
  return { ok: run.status === 0, text };
}

function plantedOnce(file, fault, dir) {
  const code = plantFaults({ dir, edits: fault.edits });
  try {
    return runIn(code, file);
  } finally {
    rmSync(code, { recursive: true, force: true });
  }
}

/** Run each fault once; a run that failed the way a loaded machine fails gets one more. */
export function runPlantedFaults({ file, faults }) {
  const dir = join(CODE, ".runtime", "behavior", "planted", basename(file, ".mjs"));
  const counts = { caught: 0, missed: 0, harness: 0 };
  for (const fault of faults) {
    const started = Date.now();
    let verdict;
    let detail;
    try {
      let result = plantedOnce(file, fault, dir);
      if (!result.ok && !fault.expect.test(result.text) && LOAD_FAILURE.test(result.text)) result = plantedOnce(file, fault, dir);
      const lines = result.text.split("\n");
      detail = (lines.find((line) => fault.expect.test(line)) || lines.find((line) => /Error/.test(line)) || "no failure line").trim().slice(0, 200);
      if (result.ok) verdict = "MISSED";
      else if (fault.expect.test(result.text)) verdict = "CAUGHT";
      else verdict = "HARNESS ERROR, CAUGHT FOR ANOTHER REASON";
    } catch (error) {
      if (!(error instanceof HarnessError)) throw error;
      verdict = "HARNESS ERROR";
      detail = error.message;
    }
    if (verdict === "CAUGHT") counts.caught += 1;
    else if (verdict === "MISSED") counts.missed += 1;
    else counts.harness += 1;
    console.log(`${verdict}  ${basename(file)}: planted: ${fault.name} -> ${detail} (${Math.round((Date.now() - started) / 1000)} s)`);
  }
  console.log(`${basename(file)}: ${counts.caught} faults caught, ${counts.missed} missed, ${counts.harness} harness errors`);
  process.exitCode = counts.harness ? 2 : counts.missed ? 1 : 0;
}
