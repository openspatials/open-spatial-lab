'use strict';

/*
 * Helpers for the iteration 1 proof (frames, GeoPose and a clean node tree).
 *
 * Every check runs twice. First against the real implementation, which must pass. Then against
 * each mutant, an implementation edited to break exactly what the check claims to measure, which
 * must fail. A check that passes for a mutant measures nothing, and the proof fails for it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { pathToFileURL } = require('url');
const http = require('http');
const { spawnSync } = require('child_process');

// These proofs create and move nodes on their own worlds, on isolated loopback ports. Those writes are opt-in on a
// running lab (runtime/world-server/src/local-only.js), so each check run() starts turns them on while it runs and puts
// the setting back as it was when it ends. Importing this file sets nothing: a module that loads these helpers to build
// worlds of its own gets the default, writes off. No launch or deploy file sets it either.
const OPT_IN = 'OSL_PLACEMENT_WRITES';
async function withPlacementWrites(fn) {
  const saved = process.env[OPT_IN];
  process.env[OPT_IN] = '1';
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env[OPT_IN];
    else process.env[OPT_IN] = saved;
  }
}

const ROOT = path.resolve(__dirname, '..', '..');
const results = [];
const loadAtStart = os.loadavg()[0];

/*
 * A planted fault whose edit no longer matches its code exactly once is STALE: it tests nothing. That is a
 * harness error, never a red verdict. Every edit applier reports it here before it throws, so run() sees it
 * even where a check catches the throw itself.
 */
const staleEdits = [];
function staleEdit(where, from, count) {
  const error = new Error('mutant edit matches ' + count + ' times in ' + where + ': ' + String(from).slice(0, 70));
  error.staleEdit = true;
  staleEdits.push(error.message);
  return error;
}

function line(text) { process.stdout.write(text + '\n'); }

/**
 * Run one check.
 *
 * @param {string} id        check name, such as "F2"
 * @param {string} title     what it claims
 * @param {function} fn      (impl) => { ok, detail } | Promise of the same
 * @param {object} impl      the real implementation
 * @param {Array<{name:string, impl:object, why?:string}>} mutants   implementations that must fail
 */
async function run(id, title, fn, impl, mutants) {
  const entry = { id, title, ok: true, detail: null, warnings: [], mutants: [] };
  let real;
  const runReal = async () => withWarnings(async () => {
    try { real = await withPlacementWrites(() => fn(impl)); } catch (error) { real = { ok: false, detail: 'threw: ' + (error && error.stack || error) }; }
  });
  entry.warnings = await runReal();
  // A real run that failed the way machine load makes a check fail (a timeout, or a check that says it is
  // load sensitive) is run once more, and the second result counts. Planted faults are never re-run.
  if (!real.ok && (/timed? ?out|timeout|exceeded/i.test(String(real.detail || '')) || real.loadSensitive === true)) {
    const first = real.detail || null;
    const load = os.loadavg()[0];
    line('  re-run once after a failure load can cause (1-minute load ' + load.toFixed(2) + '): first try: ' + first);
    entry.retry = { first_detail: first, load: Number(load.toFixed(2)) };
    entry.warnings = await runReal();
  }
  entry.detail = real.detail || null;
  if (!real.ok) entry.ok = false;
  // The real implementation must serve only what its own contract accepts. A validator line from the
  // real run is a defect, not noise; deliberate bad input belongs to a mutant or to a refused request.
  const invalid = entry.warnings.filter((warning) => warning.startsWith('[wow-validate]'));
  if (invalid.length) {
    entry.ok = false;
    entry.detail = (entry.detail ? entry.detail + '; ' : '') + 'the real implementation served ' + invalid.length + ' response(s) its contract refuses';
  }
  for (const mutant of mutants || []) {
    let verdict;
    const staleBefore = staleEdits.length;
    const warnings = await withWarnings(async () => {
      try { verdict = await withPlacementWrites(() => fn(mutant.impl)); } catch (error) { verdict = { ok: false, detail: 'threw: ' + (error && error.message || error) }; }
    });
    const stale = staleEdits.slice(staleBefore);
    if (stale.length) {
      // Its edit did not apply, so the check never met the fault: a harness error that fails the proof.
      entry.mutants.push({ name: mutant.name, red: false, stale: true, detail: stale.join('; '), warnings });
      entry.ok = false;
      entry.harness_error = true;
      continue;
    }
    const red = !verdict.ok;
    entry.mutants.push({ name: mutant.name, red, detail: verdict.detail || null, warnings });
    if (!red) entry.ok = false;
  }
  results.push(entry);
  line((entry.ok ? '  PASS  ' : '  FAIL  ') + id + '  ' + title);
  if (real.detail) line('          ' + real.detail);
  for (const warning of entry.warnings) line('          real run warns: ' + warning);
  for (const m of entry.mutants) {
    if (m.stale) {
      line('          mutant STALE ' + m.name + '  <- HARNESS ERROR: its edit no longer matches the code, so it tests nothing');
      line('            ' + m.detail);
      continue;
    }
    line('          mutant ' + (m.red ? 'red   ' : 'GREEN ') + m.name + (m.red ? '' : '  <- the check does not notice this break'));
    for (const warning of m.warnings) line('            it warns: ' + warning);
  }
  return entry;
}

/**
 * Run fn and return the world servers' warnings it caused ([wow-validate], [spatial-anchor]), so each
 * one is printed under the run that caused it: the real implementation or a named mutant. The servers
 * run in this process, so a warning raised while fn is awaited belongs to fn.
 */
async function withWarnings(fn) {
  const caught = [];
  const original = console.warn;
  console.warn = (...args) => {
    const text = args.map(String).join(' ');
    if (/^\[(wow-validate|spatial-anchor)\]/.test(text)) caught.push(text.length > 220 ? text.slice(0, 217) + '...' : text);
    else original.apply(console, args);
  };
  try { await fn(); } finally { console.warn = original; }
  return caught;
}

/** A pure run of one assertion with no mutant (used where the negative cases are part of the check). */
async function runPlain(id, title, fn) {
  return run(id, title, fn, null, []);
}

/** Load a module from source with exact string edits applied, so a mutant is a real edit of real code. */
function loadMutant(relativeFile, edits, overrides) {
  const file = path.join(ROOT, relativeFile);
  let source = fs.readFileSync(file, 'utf8');
  for (const [from, to] of edits) {
    const count = source.split(from).length - 1;
    if (count !== 1) throw staleEdit(relativeFile, from, count);
    source = source.replace(from, () => to);
  }
  const dir = path.dirname(file);
  // `overrides` swaps what a relative require returns, so a mutant of one module can be wired into the modules above it.
  const localRequire = (id) => (overrides && Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : id.startsWith('.') ? require(path.resolve(dir, id)) : require(id));
  // A UMD module also publishes itself on globalThis (Osl*). A mutant must not replace the real one.
  const globals = Object.keys(globalThis).filter((key) => key.startsWith('Osl'));
  const saved = new Map(globals.map((key) => [key, globalThis[key]]));
  let mod = { exports: {} };
  try {
    if (source.includes('import(')) {
      // A vm script cannot run import(), so a module that has one is compiled by Node's CommonJS loader,
      // under its real file name and outside the require cache.
      mod = new Module(file, module);
      mod.filename = file;
      mod.paths = Module._nodeModulePaths(dir);
      mod.require = localRequire;
      mod._compile(source, file);
    } else {
      const fn = vm.runInThisContext('(function (exports, require, module, __filename, __dirname) {' + source + '\n})', { filename: relativeFile + '#mutant' });
      fn.call(mod.exports, mod.exports, localRequire, mod, file, dir);
    }
  } finally {
    for (const key of Object.keys(globalThis).filter((k) => k.startsWith('Osl'))) {
      if (saved.has(key)) globalThis[key] = saved.get(key);
      else delete globalThis[key];
    }
  }
  return mod.exports;
}

// Folders the proof makes (world-server stores, copies of mutated ES modules) are removed when it exits.
const tempDirs = [];
function makeTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osl-arch-i1-' + label + '-'));
  if (!tempDirs.length) {
    process.once('exit', () => {
      for (const made of tempDirs) {
        try { fs.rmSync(made, { recursive: true, force: true }); } catch (error) { /* best effort */ }
      }
    });
  }
  tempDirs.push(dir);
  return dir;
}

/**
 * The ES-module twin of loadMutant: the file is copied, with its exact string edits, into a fresh
 * folder next to copies of the sibling modules it imports, and imported from there.
 */
async function loadEsmMutant(relativeFile, edits, siblings) {
  const file = path.join(ROOT, relativeFile);
  let source = fs.readFileSync(file, 'utf8');
  for (const [from, to] of edits) {
    const count = source.split(from).length - 1;
    if (count !== 1) throw staleEdit(relativeFile, from, count);
    source = source.replace(from, () => to);
  }
  const dir = makeTempDir('esm');
  for (const sibling of siblings || []) fs.copyFileSync(path.join(path.dirname(file), sibling), path.join(dir, sibling));
  const out = path.join(dir, path.basename(file));
  fs.writeFileSync(out, source);
  return import(pathToFileURL(out).href);
}

/** Run a Python script and return its stdout; a missing interpreter is a failure, not a skip. */
function python(scriptName) {
  const result = spawnSync('python3', [path.join(__dirname, scriptName)], { encoding: 'utf8' });
  if (result.error) throw new Error('python3 is required to run ' + scriptName + ': ' + result.error.message);
  if (result.status !== 0) throw new Error(scriptName + ' exited ' + result.status + ': ' + result.stderr);
  return result.stdout;
}

/** Seeded generator, so a failure reproduces. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function httpReq(method, port, requestPath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined && body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const headers = Object.assign({ Accept: 'application/json' }, extraHeaders || {});
    if (data !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers, agent: false }, (res) => {
      let out = '';
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = out ? JSON.parse(out) : null; } catch (error) { /* leave null */ }
        resolve({ status: res.statusCode, headers: res.headers, json, body: out });
      });
    });
    req.on('error', reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

function finish(outputName, label) {
  label = label || 'iteration 1 proof';
  const failed = results.filter((r) => !r.ok);
  const stale = results.reduce((n, r) => n + r.mutants.filter((m) => m.stale).length, 0);
  const mutants = results.reduce((n, r) => n + r.mutants.length, 0) - stale;
  line('');
  line((results.length - failed.length) + '/' + results.length + ' checks pass; ' + mutants + ' mutants, all red where the check holds'
    + (stale ? '; ' + stale + ' stale (harness error: their edits no longer apply)' : ''));
  line('1-minute load (information only, nothing is skipped for it): ' + loadAtStart.toFixed(2) + ' at the start, ' + os.loadavg()[0].toFixed(2) + ' at the end');
  if (stale) line('HARNESS ERROR: stale planted faults in ' + results.filter((r) => r.harness_error).map((r) => r.id).join(', '));
  if (failed.length) line('FAILED: ' + failed.map((r) => r.id).join(', '));
  try {
    const dir = path.join(ROOT, 'diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, outputName), JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2) + '\n');
  } catch (error) { /* diagnostics are best effort */ }
  if (failed.length) line('FAIL: ' + label);
  else line('PASS: ' + label);
  process.exitCode = failed.length ? 1 : 0;
}

module.exports = { ROOT, results, staleEdits, staleEdit, line, run, runPlain, makeTempDir, loadMutant, loadEsmMutant, python, mulberry32, httpReq, finish };
