'use strict';

/*
 * Boots world servers for the iteration 1 proof, real or mutated.
 *
 * A mutant server is built from real source with exact string edits (see lib.loadMutant), wired
 * from the store up through the runtime to the server, so a check goes red only when the server
 * really behaves differently.
 */

const fs = require('fs');
const path = require('path');
const { ROOT, loadMutant, makeTempDir } = require('./lib');

const SRC = path.join('runtime', 'world-server', 'src');
const abs = (name) => path.join(ROOT, SRC, name);

// The legacy edit keys name the modules the proofs first planted faults in. Any other key that ends in
// '.js' names a file in the server's src folder directly (the runtime is split across many modules).
const EDIT_FILES = { store: 'spatial-graph.js', anchor: 'spatial-anchor.js', portalStandard: 'portal-standard.js', runtime: 'runtime-state.js', server: 'server.js', mirrors: 'mirrors.js' };

/** The relative requires of one src module, as written: ['./spatial-graph', ...]. */
const localRequires = new Map();
function relativeRequires(file) {
  if (!localRequires.has(file)) {
    const source = fs.readFileSync(abs(file), 'utf8');
    const found = [];
    for (const m of source.matchAll(/require\(\s*'(\.\/[^']+)'\s*\)/g)) {
      const target = m[1].replace(/^\.\//, '').replace(/\.js$/, '') + '.js';
      if (fs.existsSync(abs(target))) found.push({ id: m[1], file: target });
    }
    localRequires.set(file, found);
  }
  return localRequires.get(file);
}

/**
 * The server module for a set of edits: an object whose keys are a legacy name (store, anchor,
 * portalStandard, runtime, server, mirrors) or a src file name, each an array of [from, to].
 * Every src module that requires an edited module, directly or through others, is loaded again
 * from source with the mutated module wired in, so a fault planted in any module reaches the server.
 */
function loadServerModule(edits) {
  const byFile = new Map();
  for (const [key, list] of Object.entries(edits || {})) {
    if (!list) continue;
    const file = EDIT_FILES[key] || (key.endsWith('.js') ? key : null);
    if (!file || !fs.existsSync(abs(file))) throw new Error('unknown server edit target: ' + key);
    byFile.set(file, (byFile.get(file) || []).concat(list));
  }
  if (!byFile.size) return require(abs('server.js'));
  const dirty = new Map();
  const visiting = new Set();
  function isDirty(file) {
    if (dirty.has(file)) return dirty.get(file);
    if (visiting.has(file)) return byFile.has(file);
    visiting.add(file);
    const value = byFile.has(file) || relativeRequires(file).some((dep) => isDirty(dep.file));
    visiting.delete(file);
    dirty.set(file, value);
    return value;
  }
  const loaded = new Map();
  function load(file) {
    if (!isDirty(file)) return require(abs(file));
    if (loaded.has(file)) return loaded.get(file);
    const overrides = {};
    for (const dep of relativeRequires(file)) if (isDirty(dep.file)) overrides[dep.id] = load(dep.file);
    const mod = loadMutant(path.join(SRC, file), byFile.get(file) || [], overrides);
    loaded.set(file, mod);
    return mod;
  }
  return load('server.js');
}

function tempDir(label) {
  return makeTempDir(label);
}

/**
 * Start one world server. `role` is a world server role ('a', 'b', 'lobby', 'airport').
 * Options: edits (a mutant), config (extra server config), dir (the folder for node ids and graphs).
 */
async function boot(role, port, options) {
  options = options || {};
  const dir = options.dir || tempDir(role);
  const savedDir = process.env.OSL_WOW_SPATIAL_DIR;
  process.env.OSL_WOW_SPATIAL_DIR = dir;
  let built;
  try {
    built = loadServerModule(options.edits).createServer(role, Object.assign({ http_port: port }, options.config || {}));
  } finally {
    if (savedDir === undefined) delete process.env.OSL_WOW_SPATIAL_DIR;
    else process.env.OSL_WOW_SPATIAL_DIR = savedDir;
  }
  await new Promise((resolve, reject) => {
    built.server.once('error', reject);
    built.server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port,
    dir,
    built,
    async close() {
      try { await built.closeAll(); } catch (error) { /* already closed */ }
    },
  };
}

module.exports = { boot, loadServerModule, tempDir };
