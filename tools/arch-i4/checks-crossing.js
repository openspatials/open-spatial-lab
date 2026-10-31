'use strict';

/*
 * Iteration 4, the seamless crossing as an optional profile.
 *
 *   P9  OSL's crossing proof (tools/wow-conformance/crossing-proof.js, 75 checks on two local servers) runs
 *       on the new portal shape, where the portal carries `destination` (an entry URL) and `node` beside
 *       the demo's labeled `osl_destination`. Reported apart from the baseline crossing. With its arrival
 *       route removed (its own --negative=route mode), it fails.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const { run, ROOT } = require('../arch-i1/lib');
const lab = require('./lab');

const { w } = lab;
// Pinned so a proof cannot lose assertions unnoticed; 81 before six source-text tripwires left crossing-proof.js.
const EXPECTED_CHECKS = 75;

function crossingProof(portA, portB, negative) {
  const env = Object.assign({}, process.env, { OSL_CROSSING_PROOF_PORT_A: String(portA), OSL_CROSSING_PROOF_PORT_B: String(portB) });
  if (negative) env.OSL_CROSSING_PROOF_NEGATIVE = negative;
  else delete env.OSL_CROSSING_PROOF_NEGATIVE;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'wow-conformance', 'crossing-proof.js')], { env, encoding: 'utf8', timeout: 600000 });
  const output = (r.stdout || '') + (r.stderr || '');
  const line = output.split('\n').reverse().find((l) => l.startsWith('assertions:')) || '';
  const pass = /^assertions: ALL PASS \((\d+)\)/.exec(line);
  return { status: r.status, line, passed: pass ? Number(pass[1]) : 0 };
}

async function crossingChecks(ports) {
  await run('P9', `the seamless crossing stays an optional profile: OSL's crossing proof (${EXPECTED_CHECKS} checks on two local servers) passes on the new portal shape (destination and node beside the labeled osl_destination), reported apart; with its arrival route removed it fails`, async (impl) => {
    const failures = [];
    const A = await w.world('a', ports.next());
    let shape;
    try {
      shape = (await lab.getWow(A, '/wow/portal/1')).json;
    } finally {
      await A.close();
    }
    if (typeof shape.destination !== 'string' || typeof shape.node !== 'string' || !shape.osl_destination) failures.push('portal 1 is not the new shape: ' + JSON.stringify({ destination: shape.destination, node: shape.node, osl: !!shape.osl_destination }));
    const result = crossingProof(ports.next(), ports.next(), impl.negative);
    if (result.passed !== EXPECTED_CHECKS) failures.push(`the crossing proof: "${result.line.slice(0, 220)}"`);
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `portal 1: destination ${shape.destination}, node ${shape.node}, osl_destination kept; the crossing proof: ${result.passed} of ${EXPECTED_CHECKS} pass` };
  }, {}, [{ name: 'a destination whose arrival route is removed (the crossing proof\'s own --negative=route)', impl: { negative: 'route' } }]);
}

module.exports = { crossingChecks };
