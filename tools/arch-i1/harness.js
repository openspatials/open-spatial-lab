'use strict';

/*
 * Boots world servers for the iteration 1 proof, real or mutated.
 *
 * A mutant server is built from real source with exact string edits (see lib.loadMutant), wired
 * from the store up through the runtime to the server, so a check goes red only when the server
 * really behaves differently.
 */

const path = require('path');
const { ROOT, loadMutant, makeTempDir } = require('./lib');

const SRC = path.join('runtime', 'world-server', 'src');
const abs = (name) => path.join(ROOT, SRC, name);

/** The server module for a set of edits: { store, anchor, runtime, server, mirrors } are arrays of [from, to]. */
function loadServerModule(edits) {
  edits = edits || {};
  const store = edits.store ? loadMutant(path.join(SRC, 'spatial-graph.js'), edits.store) : require(abs('spatial-graph.js'));
  const anchor = edits.anchor ? loadMutant(path.join(SRC, 'spatial-anchor.js'), edits.anchor) : require(abs('spatial-anchor.js'));
  const changedRuntime = Boolean(edits.store || edits.anchor || edits.runtime);
  const runtime = changedRuntime
    ? loadMutant(path.join(SRC, 'runtime-state.js'), edits.runtime || [], { './spatial-graph': store, './spatial-anchor': anchor })
    : require(abs('runtime-state.js'));
  const mirrors = edits.mirrors ? loadMutant(path.join(SRC, 'mirrors.js'), edits.mirrors) : require(abs('mirrors.js'));
  if (!changedRuntime && !edits.server && !edits.mirrors) return require(abs('server.js'));
  return loadMutant(path.join(SRC, 'server.js'), edits.server || [], { './spatial-graph': store, './runtime-state': runtime, './mirrors': mirrors });
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
