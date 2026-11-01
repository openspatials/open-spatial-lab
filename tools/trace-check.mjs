// Trace check: fails when a file or a file name carries private project-management traces (internal ids,
// private paths and folders, workflow wording) or a secret-shaped value. Run: npm run trace-check
//
// Every run first plants a fault for each rule in a temporary folder and fails unless each one is caught and a
// clean file stays clean. The rules and the planted faults are stored encoded so this file never matches its own
// rules or other scanners. They are generic: they name no private folder, repository or id.
//
// Names that only one private copy of the lab knows, such as its own folders and repositories, stay out of this
// repository. Name a JSON file outside the repository in TRACE_CHECK_PRIVATE_RULES and its rules, path parts and
// planted faults are added to these:
//   { "rules": [[label, pattern, flags, "fail" | "warn"], ...], "path_parts": ["folder/", ...],
//     "plants": { "lines": [[label, line], ...], "paths": [[label, path], ...], "clean": [line, ...] } }
// Without the variable the public rules run alone.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(process.argv[2] || join(dirname(SCRIPT), ".."));
const SKIP_DIRS = new Set([".git", ".runtime", ".dev", "node_modules", "diagnostics", "evidence"]);
const BINARY = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".wasm", ".bin", ".ktx2", ".hdr", ".mp4", ".mp3", ".ogg", ".wav"]);
const decode = (value) => JSON.parse(Buffer.from(value, "base64").toString("utf8"));
const toRule = ([label, pattern, flags, level]) => ({ label, pattern: new RegExp(pattern, flags), level });
const PUBLIC_RULES = decode("W1siYWJzb2x1dGUgdXNlciBwYXRoIiwiXFwvVXNlcnNcXC9bQS1aYS16XSIsIiIsImZhaWwiXSxbImhvbWUtcmVsYXRpdmUgcHJpdmF0ZSBwYXRoIiwiflxcLyg/Ondvcmt8RGVza3RvcHxEb2N1bWVudHN8TGlicmFyeSlcXGIiLCIiLCJmYWlsIl0sWyJhZ2VudCB3b3JraW5nLWZpbGUgcGF0aCIsIlxcL3dvcmtvcmRlcnNcXC8iLCIiLCJmYWlsIl0sWyJ3b3JrIG9yZGVyIGlkIiwiXFxiV08tW0EtWjAtOV0rKD86LVtBLVphLXowLTldKykrfFxcYldPLT9cXGR7Miw0fVtBLVphLXpdP1xcYiIsImkiLCJmYWlsIl0sWyJwcm9wb3NhbCBvciBkZWNpc2lvbiBpZCIsIlxcYlBST1AtW0EtWjAtOV0rKD86LVtBLVphLXowLTldKykrfFxcYkRDTC1cXGQrfFxcYkQtXFxkezJ9XFxiIiwiIiwiZmFpbCJdLFsid29yayBvcmRlciBudW1iZXIgaW4gYSBuYW1lIiwiXFxid29cXGR7MiwzfSg/PVstX0EtWl18XFxiKSIsIiIsImZhaWwiXSxbIndvcmsgb3JkZXIgd29yZCIsIlxcYldPcz9cXGIoPyFbLVxcZF0pIiwiIiwiZmFpbCJdLFsiYWdlbnQgb3IgbW9kZWwgbmFtZSIsIlxcYig/OkNsYXVkZXxDb2RleHxGYWJsZXxPcHVzfFNvbm5ldHxIYWlrdXxHZW1pbml8Q2hhdEdQVHxHUFQtXFxkfENvcGlsb3R8SGVybWVzKVxcYnxcXGJDdXJzb3IgKD86SURFfGFnZW50fGVkaXRvcnxydWxlcz8pXFxifFxcLmN1cnNvclxcLyIsIiIsImZhaWwiXSxbImFnZW50IHJvbGUgb3IgcHJvY2VzcyB3b3JkIiwiXFxiKD86b3JjaGVzdHJhdG9yIGFnZW50fHN1Yi0/YWdlbnRzP3x0YXNrIHBhY2tldHx0aGlzIHdvcmtlcnxieSB0aGUgKD86b3JjaGVzdHJhdG9yfGludGVncmF0b3IpKVxcYiIsImkiLCJmYWlsIl0sWyJvd25lciBwcm9jZXNzIHBocmFzZSIsIlxcYm93bmVyKD86J3N8XFxcXCdzKT9cXHMrKD86ZGlyZWN0aXZlfHJ1bGluZ3xkZWNpc2lvbnxzYWlkfGFza2VkfHdhbnRzfHdhbnRlZHxhcHByb3ZlZHxjaG9zZXxyZWplY3RlZHxyZXF1ZXN0fGluc3RydWN0aW9ufG1hbmRhdGV8Z2F0ZXx3b3JkfGdvfGlzc3Vlcz98cmVxdWlyZW1lbnR8cmV2aWV3fHJlcG9ydGVkfHNhd3xzZWVzfGdvdHxjYW58ZXhwbGljaXRseXxzY3JlZW5zaG90fGRlZmVjdHxkZW1vfHJlZ3Jlc3Npb258Y2FsbClcXGJ8XFxib3duZXItKD86Z2F0ZWR8c2VsZWN0ZWR8YXBwcm92ZWR8Y29uZmlybWVkfHJlcG9ydGVkfHJlbW92ZWR8dmlzaWJsZXxibGVzc2VkfGZhY2luZ3xsYW5ndWFnZSlcXGJ8XFxib3duZXJcXHMqI1xcZHxcXChvd25lclssOl1cXHMqKD86XFxkezR9fFtcIuKAnF0pfCg/OlxcL1xcL3xcXCp8XFwoKVxccypvd25lcjpcXHMqW1wi4oCcXXxcXGJ0aGUgb3duZXIoPzoncyk/XFxiKD8hIG9mXFxiKSIsImkiLCJmYWlsIl0sWyJzZWNyZXQtc2hhcGVkIHZhbHVlIiwiLS0tLS1CRUdJTiBbQS1aIF0qUFJJVkFURSBLRVktLS0tLXxBS0lBWzAtOUEtWl17MTZ9fGdoW29wdXNyXV9bQS1aYS16MC05X117MjAsfXxvc2wtKD86ZGV2fGRlbW8pLVthLXowLTktXSp0b2tlbnxzay1bQS1aYS16MC05XXsyMCx9IiwiaSIsImZhaWwiXSxbInByaXZhdGUgd29yayBmb2xkZXIiLCJbQS1aYS16MC05Xy5dKy13b3JrKD86W1xcL1xcXFxdfFxccysoPzpmb2xkZXJ8ZGlyZWN0b3J5KVxcYikiLCJpIiwiZmFpbCJdLFsiYXVkaXQgaWQiLCIoPzpefFteQS1aYS16MC05XSlDQS1cXGR7Myx9KD8hXFxkKSIsImkiLCJmYWlsIl0sWyJwcml2YXRlIHZvbHVtZSBwYXRoIiwiXFwvVm9sdW1lc1xcL1tBLVphLXowLTldIiwiIiwiZmFpbCJdLFsid29yayBvcmRlciBudW1iZXIgaW4gYSBjb2RlIG5hbWUiLCJbQS1aYS16XyRdW0EtWmEtejAtOV8kXSooPzpXb3xXTylcXGR7MiwzfXxcXGJfX3dvXFxkezIsM31ffFxcYk9TTF9XT1xcZCsiLCIiLCJ3YXJuIl1d").map(toRule);
const PUBLIC_PATH_PARTS = decode("WyIuZGV2LyIsIndvcmtvcmRlcnMvIiwiZ292ZXJuYW5jZS8iLCJyZXBvcnRzLyIsImF1ZGl0cy8iLCJmaW5kaW5ncy8iLCJzZXNzaW9ucy8iXQ==");
// A planted line for every rule (some rules get more than one), planted file and folder names, and clean lines.
const PUBLIC_PLANTS = decode("eyJsaW5lcyI6W1siYWJzb2x1dGUgdXNlciBwYXRoIiwic2VlIC9Vc2Vycy9zb21lb25lL3Byb2plY3QvZmlsZS50eHQiXSxbImhvbWUtcmVsYXRpdmUgcHJpdmF0ZSBwYXRoIiwiY29waWVkIGZyb20gfi93b3JrL25vdGVzIl0sWyJhZ2VudCB3b3JraW5nLWZpbGUgcGF0aCIsInNhdmVkIGluIGRvY3Mvd29ya29yZGVycy90b2RheS5tZCJdLFsid29yayBvcmRlciBpZCIsImNsb3NlcyBXTy1FWEFNUExFLTEiXSxbInByb3Bvc2FsIG9yIGRlY2lzaW9uIGlkIiwiYXMgUFJPUC1FWEFNUExFLTEgc2F5cyJdLFsid29yayBvcmRlciBudW1iZXIgaW4gYSBuYW1lIiwidG9vbHMvd28wMDAtY2hlY2subWpzIl0sWyJ3b3JrIG9yZGVyIHdvcmQiLCJzZWUgdGhlIFdPIGZvciB0aGlzIl0sWyJhZ2VudCBvciBtb2RlbCBuYW1lIiwid3JpdHRlbiB3aXRoIENsYXVkZSJdLFsiYWdlbnQgcm9sZSBvciBwcm9jZXNzIHdvcmQiLCJoYW5kZWQgdG8gYSBzdWItYWdlbnQiXSxbIm93bmVyIHByb2Nlc3MgcGhyYXNlIiwidGhlIG93bmVyIHNhaWQgc28iXSxbInNlY3JldC1zaGFwZWQgdmFsdWUiLCJrZXkgQUtJQUFCQ0RFRkdISUpLTE1OT1AiXSxbInByaXZhdGUgd29yayBmb2xkZXIiLCJ0aGUgcGFja2FnZSBpbiBleGFtcGxlLXdvcmsvaW5jb21pbmciXSxbInByaXZhdGUgd29yayBmb2xkZXIiLCJpbiB0aGUgc2FtcGxlLXdvcmsgZm9sZGVyIl0sWyJhdWRpdCBpZCIsInBsYW50ZWQgZm9yIENBLTAwMCJdLFsicHJpdmF0ZSB2b2x1bWUgcGF0aCIsImNkIC9Wb2x1bWVzL2Rpc2svbGFiIl0sWyJ3b3JrIG9yZGVyIG51bWJlciBpbiBhIGNvZGUgbmFtZSIsImNvbnN0IHJlZ2lzdGVyV28wMDAgPSAxOyJdXSwicGF0aHMiOltbInByaXZhdGUgcHJvamVjdCBwYXRoIiwicmVwb3J0cy9ub3Rlcy5tZCJdLFsiYXVkaXQgaWQiLCJub3Rlcy9DQS0wMDAubWQiXSxbInByaXZhdGUgd29yayBmb2xkZXIiLCJleGFtcGxlLXdvcmsvcmVhZG1lLnR4dCJdXSwiY2xlYW4iOlsiQSBwb3J0YWwgbGVhZHMgdG8gTG9jYXRpb24gQi4iLCJucG0gcnVuIHRyYWNlLWNoZWNrIiwibmV0d29yay8iLCJ0aGUgM0QgY2FudmFzIiwiaG9tZXdvcmsgYW5kIHRlYW13b3JrIiwiYSBDQS0xMiBjYWJsZSJdfQ==");

// The optional private rules. A file that cannot be read or does not have the shape above stops the run.
function loadPrivateRules() {
  const named = process.env.TRACE_CHECK_PRIVATE_RULES;
  const none = { used: false, rules: [], pathParts: [], plants: { lines: [], paths: [], clean: [] } };
  if (!named) return none;
  const file = realpathSync(resolve(named));
  const fromRoot = relative(realpathSync(ROOT), file);
  if (!fromRoot.startsWith("..") && !isAbsolute(fromRoot)) throw new Error("TRACE_CHECK_PRIVATE_RULES names a file inside the repository; keep private rules outside it");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const isList = (value, test) => Array.isArray(value) && value.every(test);
  const isPair = (item) => Array.isArray(item) && item.length === 2 && item.every((part) => typeof part === "string");
  const isRule = (item) => Array.isArray(item) && item.length === 4 && item.every((part) => typeof part === "string") && ["fail", "warn"].includes(item[3]);
  const plants = data.plants || {};
  if (!isList(data.rules || [], isRule)) throw new Error("private rules: rules must be [label, pattern, flags, fail|warn] lists");
  if (!isList(data.path_parts || [], (part) => typeof part === "string" && part)) throw new Error("private rules: path_parts must be strings");
  if (!isList(plants.lines || [], isPair) || !isList(plants.paths || [], isPair) || !isList(plants.clean || [], (line) => typeof line === "string")) {
    throw new Error("private rules: plants must hold lines and paths as [label, text] pairs and clean as strings");
  }
  return {
    used: true,
    rules: (data.rules || []).map(toRule),
    pathParts: (data.path_parts || []).map((part) => part.toLowerCase()),
    plants: { lines: plants.lines || [], paths: plants.paths || [], clean: plants.clean || [] },
  };
}

let privateRules;
let privateRulesError = null;
try {
  privateRules = loadPrivateRules();
} catch (error) {
  privateRulesError = error.message;
  privateRules = { used: false, rules: [], pathParts: [], plants: { lines: [], paths: [], clean: [] } };
}
const RULES = [...PUBLIC_RULES, ...privateRules.rules];
const PATH_PARTS = [...PUBLIC_PATH_PARTS, ...privateRules.pathParts];
const PLANTS = {
  lines: [...PUBLIC_PLANTS.lines, ...privateRules.plants.lines],
  paths: [...PUBLIC_PLANTS.paths, ...privateRules.plants.paths],
  clean: [...PUBLIC_PLANTS.clean, ...privateRules.plants.clean],
};

function walk(root, current = root) {
  const files = [];
  for (const name of readdirSync(current).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const absolute = join(current, name);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) files.push(...walk(root, absolute));
    else if (stat.isFile()) files.push(relative(root, absolute).split(sep).join("/"));
  }
  return files;
}

// Tracked files plus new files git does not ignore; a plain folder walk outside a git checkout.
function listFiles(root, useGit) {
  if (!useGit) return walk(root);
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter((path) => path && existsSync(join(root, path)));
  } catch {
    return walk(root);
  }
}

function searchableText(path, bytes) {
  const extension = extname(path).toLowerCase();
  if (extension === ".glb" || extension === ".vrm") {
    const chunks = [];
    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const length = bytes.readUInt32LE(offset);
      if (bytes.readUInt32LE(offset + 4) === 0x4e4f534a) chunks.push(bytes.subarray(offset + 8, offset + 8 + length).toString("utf8"));
      offset += 8 + length;
    }
    return chunks.join("\n");
  }
  return BINARY.has(extension) ? null : bytes.toString("utf8");
}

// Lines of third-party files that match a rule and are not private traces, each pinned by its path and the SHA-256 of
// the line, so any other change to that line fails again: X_ITE's minified code and decoders, byte for byte as
// downloaded, and the generator line John Carlson wrote in his world's head, kept as he wrote it.
const THIRD_PARTY_LINES = new Set([
  "runtime/scene-core/public/vendor/x_ite/assets/lib/draco_decoder_gltf.js:d48191b910a8be819a5d0167ad75a9f18273a928b02b5688b02e1a77e3ef6c0a",
  "runtime/scene-core/public/vendor/x_ite/assets/lib/woff2_decoder.js:a11032721079bcff222e2664cfb49c518de7d4e2ee0468d4d128a9fe03c91e8b",
  "runtime/scene-core/public/vendor/x_ite/x_ite.min.mjs:a7354787ccb0e01b9bfad0e0bf852faabd076ebcfa85d6744ba39d44961d97c9",
  "web/worlds/soft-body.json:6802afd5d6f53a33fc684d80c0ace1ac7d7e626edeeafb10062baa02c5cdf224",
  "web/x3d-worlds/soft-body.x3d.json:6802afd5d6f53a33fc684d80c0ace1ac7d7e626edeeafb10062baa02c5cdf224",
]);
const isPinnedThirdPartyLine = (path, line) => THIRD_PARTY_LINES.has(`${path}:${createHash("sha256").update(line).digest("hex")}`);

// Each file name is checked against every rule, then each line of its text.
function scan(root, { self = null, useGit = true } = {}) {
  const failures = [];
  const warnings = [];
  let scanned = 0;
  const report = (rule, path, line) => (rule.level === "warn" ? warnings : failures).push({ rule: rule.label, path, line });
  for (const path of listFiles(root, useGit)) {
    if (path === self || path.split("/").some((part) => SKIP_DIRS.has(part))) continue;
    scanned += 1;
    const lower = path.toLowerCase();
    for (const part of PATH_PARTS) if (lower.includes(part)) failures.push({ rule: "private project path", path, line: 0 });
    for (const rule of RULES) if (rule.pattern.test(path)) report(rule, path, 0);
    const text = searchableText(path, readFileSync(join(root, path)));
    if (text === null) continue;
    text.split(/\r?\n/).forEach((line, index) => {
      if (isPinnedThirdPartyLine(path, line)) return;
      for (const rule of RULES) if (rule.pattern.test(line)) report(rule, path, index + 1);
    });
  }
  return { failures, warnings, scanned };
}

// The planted faults, written to a temporary folder and scanned the same way: each must be reported under its own
// rule, at its own line (0 for a file name), and the clean file must not be reported at all.
function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "trace-check-planted-"));
  try {
    const expected = [];
    PLANTS.lines.forEach(([label, line], index) => {
      const path = `line-${index + 1}.txt`;
      writeFileSync(join(dir, path), `An ordinary first line.\n${line}\n`);
      expected.push({ label, path, line: 2 });
    });
    for (const [label, path] of PLANTS.paths) {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), "An ordinary line.\n");
      expected.push({ label, path, line: 0 });
    }
    writeFileSync(join(dir, "clean.txt"), `${PLANTS.clean.join("\n")}\n`);
    const { failures, warnings } = scan(dir, { useGit: false });
    const hits = [...failures, ...warnings];
    const missed = expected.filter((want) => !hits.some((hit) => hit.rule === want.label && hit.path === want.path && hit.line === want.line));
    const stray = hits.filter((hit) => hit.path === "clean.txt");
    const unplanted = RULES.map((rule) => rule.label).filter((label) => !expected.some((want) => want.label === label));
    return { planted: expected.length, missed, stray, unplanted };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (privateRulesError) console.log(`FAIL private rules: ${privateRulesError}`);
const planted = selfTest();
for (const want of planted.missed) console.log(`FAULT NOT CAUGHT ${want.label}: planted ${want.line ? `at line ${want.line} of` : "as the name"} ${want.path}`);
for (const hit of planted.stray) console.log(`FAIL self-test: a clean line was reported as ${hit.rule} (line ${hit.line})`);
for (const label of planted.unplanted) console.log(`FAIL self-test: the rule "${label}" has no planted fault`);
const selfTestPassed = !planted.missed.length && !planted.stray.length && !planted.unplanted.length;

const { failures, warnings, scanned } = scan(ROOT, { self: relative(ROOT, SCRIPT).split(sep).join("/") });
for (const hit of failures) console.log(`FAIL ${hit.rule}: ${hit.path}${hit.line ? `:${hit.line}` : ""}`);
const passed = !failures.length && selfTestPassed && !privateRulesError;
console.log(JSON.stringify({
  status: passed ? "PASS" : "FAIL",
  files_scanned: scanned,
  failures: failures.length,
  warnings: warnings.length,
  warning_rules: [...new Set(warnings.map((hit) => hit.rule))],
  warning_files: new Set(warnings.map((hit) => hit.path)).size,
  private_rules: privateRules.used ? privateRules.rules.length : privateRulesError ? "not loaded" : "none",
  self_test: { planted: planted.planted, caught: planted.planted - planted.missed.length, clean_lines_reported: planted.stray.length },
}, null, 2));
if (!passed) process.exitCode = 1;
