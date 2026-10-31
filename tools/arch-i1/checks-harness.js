'use strict';

/*
 * The proof harness itself (tools/arch-i1/lib.js, which every arch-iN proof uses).
 *
 *   H1  a planted fault whose edit no longer matches its code is reported as stale: a harness error that fails
 *       the proof. It is never counted as red, because a fault that never applied tests nothing.
 *
 * H1 runs a probe check through a fresh copy of the harness, with one planted fault whose edit is not in the
 * file. Its own planted fault is a harness that counts that stale fault as caught again.
 */

const { run, loadMutant } = require('./lib');

const LIB = 'tools/arch-i1/lib.js';

/** Run fn with this process's output held back, so the probe's own report lines do not mix with the proof's. */
async function quietly(fn) {
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { return await fn(); } finally { process.stdout.write = write; }
}

async function harnessChecks() {
  const countsStaleAsCaught = { lib: () => loadMutant(LIB, [['    const stale = staleEdits.slice(staleBefore);\n', '    const stale = [];\n']]) };
  await run('H1', 'a planted fault whose edit no longer matches its code is reported as stale, a harness error that fails the proof, and never counted as red (caught)', async (impl) => {
    const lib = impl.lib(); // a fresh copy of the harness, with its own results
    const entry = await quietly(() => lib.run('H1-probe', 'a check that measures nothing', async (i) => {
      if (i && i.load) i.load();
      return { ok: true };
    }, {}, [{ name: 'a planted fault whose edit is not in the file', impl: { load: () => lib.loadMutant(LIB, [['this text is not in the harness', '']]) } }]));
    const fault = entry.mutants[0] || {};
    const ok = fault.stale === true && fault.red === false && entry.ok === false && entry.harness_error === true;
    return {
      ok,
      detail: ok
        ? 'the stale planted fault is reported as stale (' + fault.detail.slice(0, 60) + '...), the probe check fails as a harness error, and it is not counted as red'
        : 'the stale planted fault came out as ' + JSON.stringify({ red: fault.red, stale: fault.stale, check_ok: entry.ok }),
    };
  }, { lib: () => loadMutant(LIB, []) }, [
    { name: 'a harness that counts a stale planted fault as caught', impl: countsStaleAsCaught },
  ]);
}

module.exports = { harnessChecks };
