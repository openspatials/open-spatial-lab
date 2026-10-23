// A headless observer process, not a user: given only data-point URLs, it prints one JSON line per
// change, with the value, the world's revision and the time of the change.
// Usage: node tools/arch-i3/observer-cli.mjs <data-point URL> [<data-point URL> ...]
// OSL_OBSERVE_MODULE swaps in another build of web/wow-observe.mjs (the proof's planted faults).
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const modulePath = process.env.OSL_OBSERVE_MODULE || join(here, "..", "..", "web", "wow-observe.mjs");
const { createObserver } = await import(pathToFileURL(modulePath).href);

const print = (line) => process.stdout.write(JSON.stringify(line) + "\n");
const observer = createObserver({
  onChange: (p) => print({ kind: "change", url: p.url, value: p.value === undefined ? null : p.value, revision: p.revision, time: p.time, status: p.status }),
});
for (const url of process.argv.slice(2)) {
  const p = await observer.watch(url);
  print({ kind: "first", url, value: p.value === undefined ? null : p.value, revision: p.revision, time: p.time, status: p.status });
}
// Ready once every world's stream has said hello.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 400 && [...observer.streams.values()].some((s) => s.state.status !== "live"); i += 1) await wait(25);
print({ kind: "ready" });
process.on("SIGTERM", () => { observer.close(); process.exit(0); });
