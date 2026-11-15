'use strict';

/*
 * The overlay proof: the proposed Web of Worlds edits of iterations 1 to 5, on both GeoPose forms of
 * iteration 1, with no browser.   Run: npm run arch-overlays-proof
 *
 *   U1-U5, E1    iteration 1's text, both forms               (tools/arch-i1/checks-upstream.js)
 *   X1-offered   iteration 1's Spatial.extent as offered, both forms, against the served contract
 *                (the shape and sentence rules of tools/arch-i1/checks-extent.js; its wire part stays in arch-i1-proof)
 *   i2 O1-O4     iteration 2 on top of iteration 1, O3 its     (tools/arch-i2/checks-overlay.js)
 *                conformance vocabulary (and the overlay README.md's BCP 14 paragraph), O4 the README's scope paragraph
 *   i3 W1-W3     iteration 3 on top of iterations 1 and 2,    (tools/arch-i3/checks-overlay.js)
 *                W3 its conformance vocabulary
 *   i4 W1-W3     iteration 4 on top of iterations 1 to 3,      (tools/arch-i4/checks-overlay.js)
 *                W3 its conformance vocabulary
 *   i5 W1-W4     iteration 5 (stage A, the identity handshake)  (tools/arch-i5/checks-overlay.js)
 *                on top of iterations 1 to 4, W3 its conformance vocabulary, W4 neutral wording on every
 *                overlay of iterations 1 to 5
 *
 * Each check runs on both forms (with and without the two rotation sentences), so a text step can be re-proved
 * quickly. The checks that also measure the wire (U3, U4, E1, O2, W2) start lab world servers in this process,
 * on isolated ports from 26000 up (set OSL_ARCH_OVERLAYS_PORT_A to change the first), clear of the other proofs'
 * ports. No browser starts. The full arch-i1..i5 proofs stay the acceptance runs.
 */

const path = require('path');
const { ROOT, finish, line, run, loadMutant, staleEdit } = require('../arch-i1/lib');
const { read, patchText, loadPatched, yaml } = require('../arch-i1/upstream');
const { canon } = require('../arch-i1/checks-upstream');

/*
 * X1's offered-text rules, read from checks-extent.js itself so they are not restated here: that module keeps
 * them private, so it is loaded from its source with one added export, and nothing else changed.
 */
const extent = loadMutant(path.join('tools', 'arch-i1', 'checks-extent.js'), [
  ['module.exports = { extentChecks };', 'module.exports = { extentChecks, shapeProblems, FORM_NAMES };'],
]);

function swap(text, from, to, where) {
  const count = text.split(from).length - 1;
  if (count !== 1) throw staleEdit(where, from, count);
  return text.replace(from, () => to);
}

async function extentOfferedCheck() {
  const W = 'wow-spec/overlays/iteration-1/OpenSpatialWorld.API.yaml.patch';
  const WW = 'wow-spec/overlays/iteration-1/without-rotation-sentences/OpenSpatialWorld.API.yaml.patch';
  const withoutKeyword = { patch: { with: { world: (p) => swap(p, 'A reader MUST treat an extent', 'A reader treats an extent', W) } } };
  const withoutTwoNumbers = { patch: { without: { world: (p) => swap(p, '+            min:\n+              type: array\n+              items:\n+                type: number\n+              minItems: 3\n', '+            min:\n+              type: array\n+              items:\n+                type: number\n+              minItems: 2\n', WW) } } };
  const servedDrifts = { mutateOsl: (osl) => { osl.components.schemas.Spatial.properties.extent.properties.max.minItems = 2; } };
  await run('X1-offered', 'the world extent as offered: both GeoPose forms offer Spatial.extent {min, max}, in meters, in the graph\'s frame, with "On every axis, min MUST NOT exceed max" and "A reader MUST treat an extent whose min exceeds max as absent", and each equals the served contract', async (impl) => {
    const failures = [];
    const edits = impl.patch || {};
    const offered = {};
    for (const form of extent.FORM_NAMES) {
      let patched;
      try { patchText('world', form, edits[form]); patched = loadPatched(edits[form] || null, form); }
      catch (error) { if (error && error.staleEdit) throw error; failures.push('X1 offered (' + form + '-form): a patch does not apply: ' + String(error && error.message).slice(0, 120)); continue; }
      failures.push(...extent.shapeProblems(patched.world.doc, 'X1 offered (' + form + '-form)'));
      offered[form] = ((patched.world.doc.components.schemas.Spatial || {}).properties || {}).extent;
    }
    const osl = yaml.load(read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    if (impl.mutateOsl) impl.mutateOsl(osl);
    failures.push(...extent.shapeProblems(osl, 'X1 served contract'));
    const served = ((osl.components.schemas.Spatial || {}).properties || {}).extent;
    for (const form of extent.FORM_NAMES) if (offered[form] && served && JSON.stringify(canon(offered[form])) !== JSON.stringify(canon(served))) failures.push('X1 offered (' + form + '-form) and served differ in Spatial.extent');
    return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 4).join('; ') : 'both forms offer Spatial.extent {min, max} (3 numbers each, optional) with the MUST NOT exceed and reader-MUST sentences, each equal to the served contract' };
  }, { patch: null }, [
    { name: 'a with-form whose reader sentence has no key word', impl: withoutKeyword },
    { name: 'a without-form whose extent min allows 2 numbers (only the without-form changes)', impl: withoutTwoNumbers },
    { name: 'a served contract whose extent max allows 2 numbers', impl: servedDrifts },
  ]);
}

async function main() {
  line('Overlay proof: the proposed Web of Worlds edits of iterations 1 to 5, on both GeoPose forms');
  const base = Number(process.env.OSL_ARCH_OVERLAYS_PORT_A) || 26000;
  let used = 0;
  const ports = { next: () => base + used++ };

  line('Iteration 1');
  await require('../arch-i1/checks-upstream').upstreamChecks(ports);
  await extentOfferedCheck();
  line('Iteration 2');
  await require('../arch-i2/checks-overlay').overlayChecks(ports);
  line('Iteration 3');
  await require('../arch-i3/checks-overlay').overlayChecks(ports);
  line('Iteration 4');
  await require('../arch-i4/checks-overlay').overlayChecks(ports);
  line('Iteration 5');
  await require('../arch-i5/checks-overlay').overlayChecks(ports);
  finish('arch-overlays.json', 'overlay proof');
  process.exit(process.exitCode || 0);
}

main().catch((error) => {
  process.stderr.write((error && error.stack) || String(error));
  process.stderr.write('\n');
  process.exit(1);
});
