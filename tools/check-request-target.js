'use strict';

/*
 * Check: a request target that a server cannot read is answered 400 and never stops the process.
 * Run: npm run check:request-target
 *
 * The check sends request targets that cannot be parsed to a real world server and to the real frontend, each on an
 * isolated port from 23500 up, and then asks each for a normal page. A planted fault takes the guard out of the world server; the check must turn red,
 * either with a wrong answer or with the server stopping.
 */

const net = require('net');
const path = require('path');
const { ROOT, httpReq } = require('./arch-i1/lib');
const { world } = require('./arch-i2/worlds');
const { createFrontendServer } = require(path.join(ROOT, 'src', 'serve.js'));

const UNREADABLE = ['//', '//wow/world', '/wow/spatial/%E0%A4%A', '/wow/portal/%ZZ', '/wow/spatial/1/node/%'];
const GUARD = [
  'try { return handleRequest(req, res); }\n        catch (err) { return rejectUnreadableRequest(res, err); }',
  'return handleRequest(req, res);',
];

/** One raw request, so the target is sent exactly as written; resolves with the status code, or 0 with no answer. */
function rawStatus(port, target) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    const done = () => resolve(Number((/^HTTP\/1\.1 (\d{3})/.exec(data) || [])[1]) || 0);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('close', done);
    socket.on('error', () => {});
    socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
  });
}

/** Sends every unreadable target, then a normal request; ok only if each answer is 4xx and the server still answers. */
async function probe(port, normalPath) {
  const answers = [];
  for (const target of UNREADABLE) answers.push(`${target} -> ${await rawStatus(port, target)}`);
  const after = await httpReq('GET', port, normalPath, null, {}).then((r) => r.status, () => 0);
  const ok = answers.every((a) => /-> 4\d\d$/.test(a)) && after === 200;
  return { ok, detail: `${answers.join('; ')}; then ${normalPath} -> ${after}` };
}

/** Runs fn with uncaught throws recorded instead of stopping this process, as a stopped server would be. */
async function guarded(fn) {
  const crashes = [];
  const onCrash = (err) => crashes.push(String(err && err.message || err));
  process.on('uncaughtException', onCrash);
  try {
    const result = await fn();
    await new Promise((r) => setTimeout(r, 200));
    return crashes.length ? { ok: false, detail: `the server threw out of its handler: ${crashes[0]}; ${result.detail}` } : result;
  } finally {
    process.removeListener('uncaughtException', onCrash);
  }
}

async function main() {
  const base = Number(process.env.OSL_REQUEST_TARGET_PORT) || 23500;
  let failed = 0;
  const report = (label, r) => { console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${label}\n          ${r.detail}`); if (!r.ok) failed += 1; };

  console.log('Check: an unreadable request target is answered 400 and never stops the server');
  const a = await world('a', base);
  report('world server', await guarded(() => probe(base, '/wow/world')));

  const frontend = await createFrontendServer(base + 1, { backendPorts: { a: base, b: base, lobby: base, airport: base } });
  report('frontend', await guarded(() => probe(base + 1, '/')));
  await new Promise((r) => frontend.close(r));
  a.close();

  const mutant = await world('a', base + 2, { edits: { server: [GUARD] } });
  const red = await guarded(() => probe(base + 2, '/wow/world'));
  console.log(`  ${red.ok ? 'FAIL  planted fault not caught' : 'red   planted fault caught'}: the world server without its guard\n          ${red.detail}`);
  if (red.ok) failed += 1;
  try { mutant.close(); } catch (e) { /* a stopped server has nothing to close */ }

  console.log(failed ? `FAIL: ${failed} problem(s)` : 'PASS: 2/2 checks pass; 1 planted fault, red');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error('check error', err && err.stack); process.exit(2); });
