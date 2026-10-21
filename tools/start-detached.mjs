import { openSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [, , pidFile, logFile, command, ...args] = process.argv;
if (!pidFile || !logFile || !command) throw new Error("pid file, log file, and command are required");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const log = openSync(logFile, "w");
const child = spawn(command, args, {
  cwd: root,
  detached: true,
  stdio: ["ignore", log, log],
});
child.unref();
writeFileSync(pidFile, `${child.pid}\n`, "utf8");
