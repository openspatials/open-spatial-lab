'use strict';

/*
 * Iteration 1, the world extent.
 *
 *   X1  `Spatial.extent` { min: [x, y, z], max: [x, y, z] }, in meters, in the graph's frame: the box the graph
 *       occupies. Both GeoPose forms offer it with the sentences "On every axis, `min` MUST NOT exceed `max`."
 *       and "A reader MUST treat an extent whose `min` exceeds `max` as absent."; the served contract and its
 *       build carry the same schema (offered equals served); a world configured with an extent serves it on
 *       GET /wow/spatial/{id}, valid against the contract; a world configured without one serves none; a
 *       configured extent whose min exceeds max on an axis, or that is not two corners of three numbers, is
 *       refused with 422 and a named reason: the server does not start (how a world meets the first sentence);
 *       and the Lab's reader of the Spatial resource (web/live-adapter-world-reader.mjs, readGraph) keeps a good
 *       extent and treats a bad one as absent (the second sentence).
 *
 * The extent is part of the world's configuration, like the graph's anchor: it is set in the same anchor
 * fixture (`spatial_anchors`, graphs[i].extent) that the other iteration 1 checks pass to the server. The
 * contract has no operation that writes a Spatial, so the configuration is where an extent is set and refused.
 */

const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, run, httpReq, staleEdit, loadEsmMutant } = require('./lib');
const { boot } = require('./harness');
const { read, patchText, loadPatched, squash, yaml } = require('./upstream');
const { canon } = require('./checks-upstream');
const words = require('./conformance-words');

const GENERATED = path.join(ROOT, 'wow-spec', 'generated', 'schema.json');
const { SPATIAL_ANCHORS } = require(path.join(ROOT, 'runtime', 'world-server', 'src', 'config.js'));

const FORM_NAMES = ['with', 'without'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const GOOD = { min: [-6.5, -0.25, -7], max: [6.5, 4.75, 7] };
const REFUSALS = [
  ['an extent whose min exceeds max on the y axis', { min: [-1, 3, -1], max: [1, 2, 1] }, 'SPATIAL_EXTENT_MIN_EXCEEDS_MAX', /\by axis\b/],
  ['an extent whose min exceeds max on the x axis only by a little', { min: [1.0001, 0, 0], max: [1, 1, 1] }, 'SPATIAL_EXTENT_MIN_EXCEEDS_MAX', /\bx axis\b/],
  ['an extent whose min has two numbers', { min: [0, 0], max: [1, 1, 1] }, 'SPATIAL_EXTENT_FORMAT', /three finite numbers/],
];
const SENTENCES = ['On every axis, `min` MUST NOT exceed `max`.', 'A reader MUST treat an extent whose `min` exceeds `max` as absent.'];

/** The Lab's client reader of the Spatial resource, with its sibling imports pointed at the real web/ files when it is a mutant. */
const READER = 'web/live-adapter-world-reader.mjs';
function loadReader(edits) {
  if (!edits) return import(pathToFileURL(path.join(ROOT, READER)).href);
  const real = (name) => ['from "./' + name + '"', 'from "' + pathToFileURL(path.join(ROOT, 'web', name)).href + '"'];
  return loadEsmMutant(READER, [real('wow-geopose.mjs'), real('wow-graph.mjs'), real('main-demo-portals.mjs'), ...edits]);
}

/** World A's anchor fixture with an extent on graph 1. */
const fixtureWith = (extent) => ({ graphs: [Object.assign({}, SPATIAL_ANCHORS.a.graphs[0], { extent })] });

/** The problems of one schema document's Spatial.extent: its shape and its normative sentence. */
function shapeProblems(doc, label) {
  const problems = [];
  const spatial = (((doc || {}).components || {}).schemas || {}).Spatial || {};
  const extent = (spatial.properties || {}).extent;
  if (!extent) return [label + ': Spatial has no extent'];
  if ((spatial.required || []).includes('extent')) problems.push(label + ': Spatial.extent is required; it is optional');
  if (extent.type !== 'object' || !same([...(extent.required || [])].sort(), ['max', 'min'])) problems.push(label + ': Spatial.extent is not an object that requires min and max');
  for (const corner of ['min', 'max']) {
    const c = (extent.properties || {})[corner] || {};
    if (c.type !== 'array' || c.minItems !== 3 || c.maxItems !== 3 || !c.items || c.items.type !== 'number') problems.push(label + ': Spatial.extent.' + corner + ' is not three numbers');
  }
  const text = squash(extent.description || '');
  if (!/\bin meters\b/.test(text) || !/the graph's frame/.test(text)) problems.push(label + ': Spatial.extent does not say it is in meters, in the graph\'s frame');
  const sentences = squash(extent.description || '').split(/(?<=\.)\s+/);
  for (const wanted of SENTENCES) {
    if (sentences.includes(wanted)) continue;
    const near = words.sentenceWith(extent.description, wanted.includes('reader') ? 'reader' : 'axis');
    problems.push(label + ': Spatial.extent lacks the sentence "' + wanted + '"' + (near ? ' (it says "' + squash(near) + '")' : ''));
  }
  if (sentences.some((x) => /\bserver MUST refuse an extent\b/.test(x))) problems.push(label + ': Spatial.extent still says a server MUST refuse an extent, an act no client request carries');
  return problems;
}

/** Edit patch text exactly once, or report the planted fault as stale. */
function swap(text, from, to, where) {
  const count = text.split(from).length - 1;
  if (count !== 1) throw staleEdit(where, from, count);
  return text.replace(from, () => to);
}

async function extentChecks(ports) {
  const W = 'wow-spec/overlays/iteration-1/OpenSpatialWorld.API.yaml.patch';
  const dropsExtent = { edits: { 'runtime-spatial.js': [['            ...(extent ? { extent : JSON.parse(JSON.stringify(extent)) } : {}),\n', '']] }, expect: /^X1 on the wire: a world configured with an extent serves none/ };
  const acceptsMinOverMax = { edits: { 'spatial-anchor.js': [['        if (value.min[axis] > value.max[axis])\n', '        if (false)\n']] }, expect: /^X1 refusal: an extent whose min exceeds max on the y axis: the server started/ };
  const withoutKeyword = { patch: { with: { world: (p) => swap(p, 'A reader MUST treat an extent', 'A reader treats an extent', W) } }, expect: /^X1 offered \(with-form\): Spatial\.extent lacks the sentence "A reader MUST/ };
  const readerKeepsBad = { readerEdits: [['    if (value.min[axis] > value.max[axis]) return null;\n', '']], expect: /^X1 reader: an extent whose min exceeds max on the y axis is kept/ };
  const servedDrifts = { mutateOsl: (osl) => { osl.components.schemas.Spatial.properties.extent.properties.max.minItems = 2; }, expect: /^X1 served contract: Spatial\.extent\.max is not three numbers|^X1 offered \(with-form\) and served differ/ };

  await run('X1', 'the world extent: Spatial.extent {min, max}, in meters, in the graph\'s frame, offered in both GeoPose forms with "On every axis, min MUST NOT exceed max" and "A reader MUST treat an extent whose min exceeds max as absent"; served equals offered and built; a world configured with an extent serves it on GET /wow/spatial/{id}, a world without one serves none, a bad configured extent is refused with 422 and a named reason, and the Lab\'s reader treats a bad extent as absent', async (impl) => {
    const failures = [];
    const edits = impl.patch || {};

    // 1. The offered text, both forms: the shape and the sentence.
    const offered = {};
    for (const form of FORM_NAMES) {
      let patched;
      try { patchText('world', form, edits[form]); patched = loadPatched(edits[form] || null, form); }
      catch (error) { if (error && error.staleEdit) throw error; failures.push('X1 offered (' + form + '-form): a patch does not apply: ' + String(error && error.message).slice(0, 120)); continue; }
      failures.push(...shapeProblems(patched.world.doc, 'X1 offered (' + form + '-form)'));
      offered[form] = ((patched.world.doc.components.schemas.Spatial || {}).properties || {}).extent;
    }

    // 2. The served contract and its build: the same shape and sentence, and equal to the offered text.
    const osl = yaml.load(read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    if (impl.mutateOsl) impl.mutateOsl(osl);
    const generated = JSON.parse(read(GENERATED));
    failures.push(...shapeProblems(osl, 'X1 served contract'));
    failures.push(...shapeProblems(generated, 'X1 generated schema.json'));
    const served = ((osl.components.schemas.Spatial || {}).properties || {}).extent;
    const built = ((generated.components.schemas.Spatial || {}).properties || {}).extent;
    for (const form of FORM_NAMES) if (offered[form] && served && !same(canon(offered[form]), canon(served))) failures.push('X1 offered (' + form + '-form) and served differ in Spatial.extent');
    if (served && built && !same(canon(served), canon(built))) failures.push('X1 generated schema.json is not the served contract in Spatial.extent');

    // 3. On the wire: a world configured with an extent serves it, valid; a world without one serves none.
    const { createValidator } = require(path.join(ROOT, 'wow-spec', 'validate'));
    const validator = createValidator({ doc: generated });
    const s = await boot('a', ports.next(), { edits: impl.edits, config: { spatial_anchors: fixtureWith(GOOD) } });
    try {
      const r = await httpReq('GET', s.port, '/wow/spatial/1');
      if (r.status !== 200 || !r.json) failures.push('X1 on the wire: GET /wow/spatial/1 answered ' + r.status);
      else if (r.json.extent === undefined) failures.push('X1 on the wire: a world configured with an extent serves none on GET /wow/spatial/1');
      else {
        if (!same(r.json.extent, GOOD)) failures.push('X1 on the wire: GET /wow/spatial/1 serves the extent ' + JSON.stringify(r.json.extent) + ', configured ' + JSON.stringify(GOOD));
        const v = validator.validate('Spatial', r.json);
        if (!v.valid) failures.push('X1 on the wire: the Spatial with its extent is not valid: ' + String(v.errorsText).slice(0, 120));
      }
    } finally { await s.close(); }
    const plain = await boot('a', ports.next(), { edits: impl.edits });
    try {
      const r = await httpReq('GET', plain.port, '/wow/spatial/1');
      if (r.status !== 200 || !r.json) failures.push('X1 on the wire: a world without an extent: GET /wow/spatial/1 answered ' + r.status);
      else if (r.json.extent !== undefined) failures.push('X1 on the wire: a world configured without an extent serves ' + JSON.stringify(r.json.extent));
    } finally { await plain.close(); }

    // 4. A bad extent is refused where it is set, the configuration: 422 and a named reason, and the server does not start.
    for (const [name, extent, code, reason] of REFUSALS) {
      let started = null;
      try { started = await boot('a', ports.next(), { edits: impl.edits, config: { spatial_anchors: fixtureWith(extent) } }); }
      catch (error) {
        if (error.code !== code) failures.push('X1 refusal: ' + name + ': refused with ' + (error.code || error.message) + ', wanted ' + code);
        else if (error.status !== 422) failures.push('X1 refusal: ' + name + ': refused with status ' + error.status + ', wanted 422');
        else if (!reason.test(String(error.reason || ''))) failures.push('X1 refusal: ' + name + ': the reason "' + error.reason + '" does not name it');
        continue;
      }
      await started.close();
      failures.push('X1 refusal: ' + name + ': the server started');
    }

    // 5. The reader side: the Lab's reader of the Spatial resource keeps a good extent and treats a bad one as absent.
    let reader = null;
    try { reader = await loadReader(impl.readerEdits); } catch (error) { if (error && error.staleEdit) throw error; failures.push('X1 reader: ' + READER + ' does not load: ' + String(error && error.message).slice(0, 120)); }
    if (reader) {
      const transport = { getJson: async () => ({ id: 0, children: [] }) };
      const readExtent = async (extent) => {
        const doc = Object.assign({ id: 1, rootNodeID: 0 }, extent === undefined ? {} : { extent: JSON.parse(JSON.stringify(extent)) });
        const graph = await reader.readGraph('/w/a/wow/spatial/1', doc, { transport, onLog() {} });
        return Object.prototype.hasOwnProperty.call(graph, 'extent') ? graph.extent : undefined;
      };
      const good = await readExtent(GOOD);
      if (!same(good, GOOD)) failures.push('X1 reader: a good extent reads as ' + JSON.stringify(good) + ', served ' + JSON.stringify(GOOD));
      for (const [name, extent] of REFUSALS) {
        const got = await readExtent(extent);
        if (got !== null && got !== undefined) failures.push('X1 reader: ' + name + ' is kept as ' + JSON.stringify(got) + '; a reader MUST treat it as absent');
      }
      const none = await readExtent(undefined);
      if (none !== null && none !== undefined) failures.push('X1 reader: a Spatial without an extent reads as ' + JSON.stringify(none));
    }

    if (impl.expect) return { ok: !failures.some((f) => impl.expect.test(f)), detail: failures.slice(0, 4).join('; ') || 'no failure' };
    return {
      ok: failures.length === 0,
      detail: failures.length
        ? failures.length + ' problem(s): ' + failures.slice(0, 6).join('; ')
        : 'both forms offer Spatial.extent {min, max} (3 numbers each, optional) with the MUST NOT exceed and reader-MUST sentences; served = offered = built; a world configured with '
          + JSON.stringify(GOOD) + ' serves it on GET /wow/spatial/1, valid, and a world without one serves none; ' + REFUSALS.length + ' bad extents refused with 422 and a named reason, the server not started; the reader (' + READER + ') keeps the good extent and reads the same ' + REFUSALS.length + ' as absent',
    };
  }, { edits: null, readerEdits: null }, [
    { name: 'a server that drops the extent (caught as: X1 on the wire, a world configured with an extent serves none)', impl: dropsExtent },
    { name: 'a server that accepts an extent whose min exceeds max (caught as: X1 refusal, the server started)', impl: acceptsMinOverMax },
    { name: 'a with-form whose reader sentence has no key word (caught as: X1 offered, Spatial.extent lacks the sentence "A reader MUST ...")', impl: withoutKeyword },
    { name: 'a reader that keeps an extent whose min exceeds max (caught as: X1 reader, the extent is kept)', impl: readerKeepsBad },
    { name: 'a served contract whose extent max allows 2 numbers (caught as: X1 served contract, max is not three numbers)', impl: servedDrifts },
  ]);
}

module.exports = { extentChecks };
