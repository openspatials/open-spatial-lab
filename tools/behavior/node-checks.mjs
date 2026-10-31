// Named checks that run in Node, and the planted faults that prove each one can fail. A check file lists its checks with
// check(id, says, fn), then ends with finish({ checkFile, faults }). A failed check prints "FAIL id: message".
//
// A fault is { statement, name, expect, edits: [{ file, find, replace }] }. Each runs the check file's own copy inside a
// copy of the code with the edits applied (plantFaults), and counts as caught only when that copy exits non-zero and
// prints a FAIL line for `statement` whose message matches `expect`. `--only id,id` runs only the faults of those checks. A fault whose edit no longer applies, or that is
// caught only by another check, is a harness error (exit 2). Faults run after the checks, once, unless OSL_PLANTED is set.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CODE, HarnessError, plantFaults } from "../arch-i4/main-demo/lab.mjs";

const FAULT_LIMIT_MS = 180000;

const oneLine = (error) => String((error && error.message) || error).replace(/\s+/g, " ").trim();

function runCopy(checkFile, edits, dir) {
  const code = plantFaults({ dir, edits });
  const run = spawnSync(process.execPath, [join(code, checkFile)], {
    cwd: code, env: { ...process.env, OSL_PLANTED: "1" }, encoding: "utf8", timeout: FAULT_LIMIT_MS,
  });
  return { status: run.status, timedOut: Boolean(run.error), output: `${run.stdout || ""}${run.stderr || ""}` };
}

function verdictOf(fault, run) {
  if (run.status === 0) return { verdict: "MISSED", detail: "every check still passed" };
  const failed = run.output.split("\n").filter((line) => line.startsWith("FAIL "));
  const own = failed.find((line) => line.startsWith(`FAIL ${fault.statement}:`));
  if (own && fault.expect.test(own)) return { verdict: "CAUGHT", detail: own.slice(5, 220) };
  return { verdict: "OTHER", detail: failed.length ? `caught for another reason: ${failed[0].slice(0, 200)}` : `no FAIL line: ${run.output.slice(-300)}` };
}

function runFault(fault, dir) {
  let run = runCopy(fault.checkFile, fault.edits, dir);
  if (run.timedOut) run = runCopy(fault.checkFile, fault.edits, dir);
  return verdictOf(fault, run);
}

function runFaults(checkFile, faults, title) {
  const counts = { caught: 0, missed: 0, harness: 0 };
  const dir = join(CODE, ".runtime", "behavior", title);
  for (const fault of faults) {
    try {
      const { verdict, detail } = runFault({ ...fault, checkFile }, dir);
      if (verdict === "CAUGHT") counts.caught += 1;
      else if (verdict === "MISSED") counts.missed += 1;
      else counts.harness += 1;
      console.log(`${verdict === "OTHER" ? "HARNESS ERROR" : verdict}  ${fault.statement}: planted: ${fault.name} -> ${detail}`);
    } catch (error) {
      if (!(error instanceof HarnessError)) throw error;
      counts.harness += 1;
      console.log(`HARNESS ERROR  ${fault.statement}: planted: ${fault.name} -> ${error.message}`);
    }
  }
  return counts;
}

export function nodeChecks(title) {
  const ran = { passed: 0, failed: 0 };
  const known = new Set();
  return {
    async check(id, says, fn) {
      known.add(id);
      try {
        await fn();
        ran.passed += 1;
        console.log(`PASS  ${id}: ${says}`);
      } catch (error) {
        ran.failed += 1;
        console.log(`FAIL ${id}: ${oneLine(error)}`);
      }
    },
    async finish({ checkFile, faults = [] }) {
      const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;
      const chosen = faults.filter((fault) => !only || only.includes(fault.statement));
      let code = ran.failed ? 1 : 0;
      const planted = !process.env.OSL_PLANTED && !ran.failed;
      for (const fault of planted ? chosen : []) {
        if (!known.has(fault.statement)) { console.log(`HARNESS ERROR  a planted fault names no check: ${fault.statement}`); code = 2; }
      }
      if (planted && code === 0) {
        const counts = runFaults(checkFile, chosen, title);
        console.log(`${title}: ${ran.passed} checks pass; ${counts.caught} faults caught, ${counts.missed} missed, ${counts.harness} harness errors`);
        code = counts.harness ? 2 : counts.missed ? 1 : 0;
      } else if (!planted) {
        console.log(`${title}: ${ran.passed} checks pass, ${ran.failed} fail`);
      }
      // A module under test may leave a timer running, which would keep this process alive for ever.
      process.exit(code);
    },
  };
}
