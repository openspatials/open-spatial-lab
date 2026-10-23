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

const ROOT = path.resolve(__dirname, '..', '..');
const results = [];

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
  entry.warnings = await withWarnings(async () => {
    try { real = await fn(impl); } catch (error) { real = { ok: false, detail: 'threw: ' + (error && error.stack || error) }; }
  });
  entry.detail = real.detail || null;
  // A check that could not run here (the machine-load gate) is a deferral: never a pass, never a failure.
  if (real.deferred) {
    entry.deferred = true;
    results.push(entry);
    line('  DEFER ' + id + '  ' + title);
    line('          ' + entry.detail);
    return entry;
  }
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
    const warnings = await withWarnings(async () => {
      try { verdict = await fn(mutant.impl); } catch (error) { verdict = { ok: false, detail: 'threw: ' + (error && error.message || error) }; }
    });
    const red = !verdict.ok;
    entry.mutants.push({ name: mutant.name, red, detail: verdict.detail || null, warnings });
    if (!red) entry.ok = false;
  }
  results.push(entry);
  line((entry.ok ? '  PASS  ' : '  FAIL  ') + id + '  ' + title);
  if (real.detail) line('          ' + real.detail);
  for (const warning of entry.warnings) line('          real run warns: ' + warning);
  for (const m of entry.mutants) {
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
    if (count !== 1) throw new Error('mutant edit matches ' + count + ' times in ' + relativeFile + ': ' + from.slice(0, 70));
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
    if (count !== 1) throw new Error('mutant edit matches ' + count + ' times in ' + relativeFile + ': ' + from.slice(0, 70));
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
  const deferred = results.filter((r) => r.deferred);
  const mutants = results.reduce((n, r) => n + r.mutants.length, 0);
  line('');
  line((results.length - failed.length - deferred.length) + '/' + results.length + ' checks pass; ' + mutants + ' mutants, all red where the check holds'
    + (deferred.length ? '; deferred: ' + deferred.map((r) => r.id).join(', ') : ''));
  if (failed.length) line('FAILED: ' + failed.map((r) => r.id).join(', '));
  try {
    const dir = path.join(ROOT, 'diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, outputName), JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2) + '\n');
  } catch (error) { /* diagnostics are best effort */ }
  if (failed.length) line('FAIL: ' + label);
  else if (deferred.length) line('DEFERRED: ' + label + ' (' + deferred.map((r) => r.id).join(', ') + ' not run; every other check passes)');
  else line('PASS: ' + label);
  // 3, as the conformance runner uses it: nothing failed, but not everything ran.
  process.exitCode = failed.length ? 1 : deferred.length ? 3 : 0;
}

module.exports = { ROOT, results, line, run, runPlain, makeTempDir, loadMutant, loadEsmMutant, python, mulberry32, httpReq, finish };
