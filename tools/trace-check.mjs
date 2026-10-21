// Trace check: fails when a file carries private project-management traces (internal ids,
// private paths, workflow wording) or a secret-shaped value. Run: npm run trace-check
//
// The rules are stored encoded so this file never matches its own rules or other scanners.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = resolve(process.argv[2] || join(dirname(SCRIPT), ".."));
const SKIP_DIRS = new Set([".git", ".runtime", ".dev", "node_modules", "diagnostics", "evidence"]);
const BINARY = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".otf", ".wasm", ".bin", ".ktx2", ".hdr", ".mp4", ".mp3", ".ogg", ".wav"]);
const decode = (value) => JSON.parse(Buffer.from(value, "base64").toString("utf8"));
const RULES = decode("W1siYWJzb2x1dGUgdXNlciBwYXRoIiwiXFwvVXNlcnNcXC9bQS1aYS16XSIsIiIsImZhaWwiXSxbImhvbWUtcmVsYXRpdmUgcHJpdmF0ZSBwYXRoIiwiflxcLyg/OlxcLmFnZW50c3x3b3JrfERlc2t0b3B8RG9jdW1lbnRzfExpYnJhcnkpXFxiIiwiIiwiZmFpbCJdLFsiYWdlbnQgd29ya2luZy1maWxlIHBhdGgiLCJcXC5kZXZcXC9haVxcL3xzdWJ0YXNrLWNvbW1zfFxcL3dvcmtvcmRlcnNcXC98XFxiV08tSU5ERVhcXGIiLCIiLCJmYWlsIl0sWyJ3b3JrIG9yZGVyIGlkIiwiXFxiV08tW0EtWjAtOV0rKD86LVtBLVphLXowLTldKykrfFxcYldPLT9cXGR7Miw0fVtBLVphLXpdP1xcYiIsImkiLCJmYWlsIl0sWyJwcm9wb3NhbCBvciBkZWNpc2lvbiBpZCIsIlxcYlBST1AtW0EtWjAtOV0rKD86LVtBLVphLXowLTldKykrfFxcYkRDTC1cXGQrfFxcYkQtXFxkezJ9XFxiIiwiIiwiZmFpbCJdLFsid29yayBvcmRlciBudW1iZXIgaW4gYSBuYW1lIiwiXFxid29cXGR7MiwzfSg/PVstX0EtWl18XFxiKSIsIiIsImZhaWwiXSxbIndvcmsgb3JkZXIgd29yZCIsIlxcYldPcz9cXGIoPyFbLVxcZF0pIiwiIiwiZmFpbCJdLFsiYWdlbnQgb3IgbW9kZWwgbmFtZSIsIlxcYig/OkNsYXVkZXxDb2RleHxGYWJsZXxPcHVzfFNvbm5ldHxIYWlrdXxHZW1pbml8Q2hhdEdQVHxHUFQtXFxkfENvcGlsb3R8SGVybWVzKVxcYnxcXGJDdXJzb3IgKD86SURFfGFnZW50fGVkaXRvcnxydWxlcz8pXFxifFxcLmN1cnNvclxcLyIsIiIsImZhaWwiXSxbImFnZW50IHJvbGUgb3IgcHJvY2VzcyB3b3JkIiwiXFxiKD86c3Rld2FyZHxvcmNoZXN0cmF0b3IgYWdlbnR8ZGV2LXdvcmtlcnxzdWItP2FnZW50cz98QUdFTlQtU1RBVEV8dGFzayBwYWNrZXR8bGVhc2UgcmVsZWFzZXxwYXJlbnQgYXNzaW1pbGF0aW9ufHNtYXJ0IGNvbW1pdHxnbG9iYWwgY29tbWl0fHRoaXMgd29ya2VyfG9yY2hlc3RyYXRvcidzIHNlcmlhbGl6ZWR8cmVzdWx0XFwubWR8YnkgdGhlICg/Om9yY2hlc3RyYXRvcnxpbnRlZ3JhdG9yKSlcXGIiLCJpIiwiZmFpbCJdLFsib3duZXIgcHJvY2VzcyBwaHJhc2UiLCJcXGJvd25lcig/OidzfFxcXFwncyk/XFxzKyg/OmRpcmVjdGl2ZXxydWxpbmd8ZGVjaXNpb258c2FpZHxhc2tlZHx3YW50c3x3YW50ZWR8YXBwcm92ZWR8Y2hvc2V8cmVqZWN0ZWR8cmVxdWVzdHxpbnN0cnVjdGlvbnxtYW5kYXRlfGdhdGV8d29yZHxnb3xpc3N1ZXM/fHJlcXVpcmVtZW50fHJldmlld3xyZXBvcnRlZHxzYXd8c2Vlc3xnb3R8Y2FufGV4cGxpY2l0bHl8c2NyZWVuc2hvdHxkZWZlY3R8ZGVtb3xyZWdyZXNzaW9ufGNhbGwpXFxifFxcYm93bmVyLSg/OmdhdGVkfHNlbGVjdGVkfGFwcHJvdmVkfGNvbmZpcm1lZHxyZXBvcnRlZHxyZW1vdmVkfHZpc2libGV8Ymxlc3NlZHxmYWNpbmd8bGFuZ3VhZ2UpXFxifFxcYm93bmVyXFxzKiNcXGR8XFwob3duZXJbLDpdXFxzKig/OlxcZHs0fXxbXCLigJxdKXwoPzpcXC9cXC98XFwqfFxcKClcXHMqb3duZXI6XFxzKltcIuKAnF18XFxidGhlIG93bmVyKD86J3MpP1xcYig/ISBvZlxcYikiLCJpIiwiZmFpbCJdLFsicHJpdmF0ZSB3b3JrZmxvdyBtYXJrZXIiLCJNU0YtbG9jYWx8cHJvamVjdC1ub3Rlc3xERVYtREVNTyIsImkiLCJmYWlsIl0sWyJwcml2YXRlIHJlcG9zaXRvcnkgb3Igd29ya3NwYWNlIiwib3Blbi1zcGF0aWFsLWxhYi1kZXZ8c3BhdGlhbC1jb21wdXRpbmctcmVzZWFyY2gtcHJvamVjdHMtbXNmfHhyLXJ1bnRpbWUtY29tcGFyaXNvbnxtc2Ytd2ctdG9vbHxvYnNpZGlhbi12YXVsdHxJTkJPWC12YXVsdHxcXGJwZWVybWVzaC12cHNcXGIiLCJpIiwiZmFpbCJdLFsic2VjcmV0LXNoYXBlZCB2YWx1ZSIsIi0tLS0tQkVHSU4gW0EtWiBdKlBSSVZBVEUgS0VZLS0tLS18QUtJQVswLTlBLVpdezE2fXxnaFtvcHVzcl1fW0EtWmEtejAtOV9dezIwLH18b3NsLSg/OmRldnxkZW1vKS1bYS16MC05LV0qdG9rZW58c2stW0EtWmEtejAtOV17MjAsfSIsImkiLCJmYWlsIl0sWyJ3b3JrIG9yZGVyIG51bWJlciBpbiBhIGNvZGUgbmFtZSIsIltBLVphLXpfJF1bQS1aYS16MC05XyRdKig/OldvfFdPKVxcZHsyLDN9fFxcYl9fd29cXGR7MiwzfV98XFxiT1NMX1dPXFxkKyIsIiIsIndhcm4iXV0=")
  .map(([label, pattern, flags, level]) => ({ label, pattern: new RegExp(pattern, flags), level }));
const PATH_PARTS = decode("WyIuZGV2LyIsIi5hZ2VudHMvIiwid29ya29yZGVycy8iLCJnb3Zlcm5hbmNlLyIsInJlcG9ydHMvIiwiYXVkaXRzLyIsImZpbmRpbmdzLyIsInNlc3Npb25zLyJd");

function walk(current) {
  const files = [];
  for (const name of readdirSync(current).sort()) {
    if (SKIP_DIRS.has(name)) continue;
    const absolute = join(current, name);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) files.push(...walk(absolute));
    else if (stat.isFile()) files.push(relative(ROOT, absolute).split(sep).join("/"));
  }
  return files;
}

// Tracked files plus new files git does not ignore; a plain folder walk outside a git checkout.
function listFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter((path) => path && existsSync(join(ROOT, path)));
  } catch {
    return walk(ROOT);
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

const self = relative(ROOT, SCRIPT).split(sep).join("/");
const failures = [];
const warnings = [];
let scanned = 0;
for (const path of listFiles()) {
  if (path === self || path.split("/").some((part) => SKIP_DIRS.has(part))) continue;
  scanned += 1;
  const lower = path.toLowerCase();
  for (const part of PATH_PARTS) if (lower.includes(part)) failures.push({ rule: "private project path", path, line: 0 });
  const text = searchableText(path, readFileSync(join(ROOT, path)));
  if (text === null) continue;
  text.split(/\r?\n/).forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) (rule.level === "warn" ? warnings : failures).push({ rule: rule.label, path, line: index + 1 });
    }
  });
}

for (const hit of failures) console.log(`FAIL ${hit.rule}: ${hit.path}${hit.line ? `:${hit.line}` : ""}`);
console.log(JSON.stringify({
  status: failures.length ? "FAIL" : "PASS",
  files_scanned: scanned,
  failures: failures.length,
  warnings: warnings.length,
  warning_rules: [...new Set(warnings.map((hit) => hit.rule))],
  warning_files: new Set(warnings.map((hit) => hit.path)).size,
}, null, 2));
if (failures.length) process.exitCode = 1;
