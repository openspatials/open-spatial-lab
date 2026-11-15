'use strict';

/*
 * Helpers for the iteration 3 proof: worlds, the observer and inclusion clients (real or with a planted
 * fault), a separate observer process, presence, raw event streams, and request logs.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { ROOT, httpReq, makeTempDir, staleEdit } = require('../arch-i1/lib');
const w = require('../arch-i2/worlds');
const { openEventStream } = require('../wow-conformance/wire-checks');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until fn() is truthy, or throw after `ms`. */
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting for ' + (what || 'a condition'));
    await sleep(25);
  }
}

/**
 * A web module, real or with exact string edits applied. A mutant is written with copies of its sibling
 * modules into a fresh folder, so a module that imports it (also copied) gets the mutant.
 * Returns { module, file } where file is the path of the module asked for.
 */
async function webModule(name, edits, target) {
  const SIBLINGS = ['wow-observe.mjs', 'wow-inclusion.mjs', 'wow-inclusion-mount.mjs', 'wow-geopose.mjs', 'wow-geopose.js'];
  if (!edits || !edits.length) {
    const file = path.join(ROOT, 'web', target || name);
    return { module: await import(pathToFileURL(file).href), file };
  }
  const dir = makeTempDir('i3');
  for (const sibling of SIBLINGS) fs.copyFileSync(path.join(ROOT, 'web', sibling), path.join(dir, sibling));
  let source = fs.readFileSync(path.join(ROOT, 'web', name), 'utf8');
  for (const [from, to] of edits) {
    const count = source.split(from).length - 1;
    if (count !== 1) throw staleEdit('web/' + name, from, count);
    source = source.replace(from, () => to);
  }
  fs.writeFileSync(path.join(dir, name), source);
  const file = path.join(dir, target || name);
  return { module: await import(pathToFileURL(file).href), file };
}

const observe = (edits) => webModule('wow-observe.mjs', edits);
const inclusion = (edits) => webModule('wow-inclusion.mjs', edits);
const inclusionWithObserver = (edits) => webModule('wow-observe.mjs', edits, 'wow-inclusion.mjs');

/** Register a user in a world (a player joining), and the matching departure. */
async function join(world, playerId) {
  const r = await httpReq('POST', world.port, (world.prefix || '') + '/fabric/presence/register', { player_id: playerId, display_name: playerId, avatar_id: 'proof-avatar' });
  if (r.status !== 201) throw new Error('register ' + playerId + ': ' + r.status + ' ' + r.body.slice(0, 120));
  return r.json;
}
async function leave(world, playerId) {
  const r = await httpReq('POST', world.port, (world.prefix || '') + '/fabric/presence/depart', { player_id: playerId });
  if (r.status >= 300) throw new Error('depart ' + playerId + ': ' + r.status);
  return r.json;
}

async function worldDoc(world) {
  const r = await httpReq('GET', world.port, (world.prefix || '') + '/wow/world', null, { Accept: w.WOW });
  return r.json;
}

/** Count the requests a world server receives, by method. */
function requestLog(world) {
  const log = [];
  const listener = (req) => log.push({ method: req.method, url: req.url, at: Date.now() });
  world.server.built.server.on('request', listener);
  return { log, stop: () => world.server.built.server.off('request', listener) };
}

/**
 * A raw RFC 6455 client, for what a browser client cannot do (choose its Origin header) and to time a
 * close. Returns { status, messages, closedAt, send(text), close() }. The client itself is shared with the
 * conformance corpus (tools/wow-conformance/wire-checks.js openEventStream), which takes a full URL.
 */
function rawStream(port, pathWithQuery, headers) {
  return openEventStream('http://127.0.0.1:' + port + pathWithQuery, headers);
}

/**
 * The separate headless observer process: given only data-point URLs, it prints one JSON line per change.
 * `modulePath` swaps in a planted fault of the observer module.
 */
function observerProcess(urls, modulePath) {
  const env = Object.assign({}, process.env, modulePath ? { OSL_OBSERVE_MODULE: modulePath } : {});
  const child = spawn(process.execPath, [path.join(__dirname, 'observer-cli.mjs'), ...urls], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  let partial = '';
  child.stdout.on('data', (chunk) => {
    partial += chunk.toString('utf8');
    let at;
    while ((at = partial.indexOf('\n')) !== -1) {
      const text = partial.slice(0, at);
      partial = partial.slice(at + 1);
      try { lines.push(Object.assign(JSON.parse(text), { received_at: Date.now() })); } catch (e) { /* not JSON */ }
    }
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    lines,
    child,
    stderr: () => stderr,
    ready: () => until(() => lines.some((l) => l.kind === 'ready'), 15000, 'the observer process'),
    stop: () => new Promise((resolve) => { child.once('exit', resolve); child.kill(); }),
  };
}

/** The values of one data point an observer process reported, by revision. */
function changesOf(lines, url) {
  return lines.filter((l) => l.kind === 'change' && l.url === url);
}

module.exports = { w, sleep, until, observe, inclusion, inclusionWithObserver, webModule, join, leave, worldDoc, requestLog, rawStream, observerProcess, changesOf, httpReq };
