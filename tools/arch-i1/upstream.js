'use strict';

/*
 * Reading and patching the vendored upstream API descriptions for the iteration 1 proof.
 *
 *   applyUnifiedDiff   applies a unified diff to a text with no outside tool, so a mutant is an edit of the patch text
 *   loadPatched        the vendored World and Asset descriptions, with the overlay patches applied and parsed
 *   pathParameterProblems   the OpenAPI rule that every {name} in a path is declared, and nothing else is
 *   refProblems        every internal $ref resolves
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { ROOT } = require('./lib');

const UPSTREAM = path.join(ROOT, 'wow-spec', 'upstream', 'wowapi-d39a1a0');
const OVERLAY = path.join(ROOT, 'wow-spec', 'overlays', 'iteration-1');
const WORLD = 'specification/OpenSpatialWorld/API.yaml';
const ASSET = 'specification/OpenSpatialAsset/API.yaml';

const read = (file) => fs.readFileSync(file, 'utf8');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

/**
 * Apply a unified diff to `original`. Each hunk's old lines (context and removals) must match exactly,
 * at the position the hunk names or at the nearest one. Counts in the hunk header are not trusted.
 * Throws a message that names the hunk when one does not apply.
 */
function applyUnifiedDiff(original, patchText) {
  const hunks = [];
  for (const line of patchText.split('\n')) {
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (!m) throw new Error('bad hunk header: ' + line);
      hunks.push({ start: Number(m[1]), lines: [] });
    } else if (hunks.length && !line.startsWith('\\') && /^[ +-]/.test(line)) {
      hunks[hunks.length - 1].lines.push([line[0], line.slice(1)]);
    }
  }
  if (!hunks.length) throw new Error('the patch has no hunks');
  const lines = original.split('\n');
  let delta = 0;
  hunks.forEach((hunk, index) => {
    const oldLines = hunk.lines.filter(([tag]) => tag !== '+').map(([, text]) => text);
    const newLines = hunk.lines.filter(([tag]) => tag !== '-').map(([, text]) => text);
    const expected = hunk.start - 1 + delta;
    let found = -1;
    for (let distance = 0; distance <= lines.length && found < 0; distance += 1) {
      for (const at of [expected - distance, expected + distance]) {
        if (at >= 0 && at + oldLines.length <= lines.length && oldLines.every((text, i) => lines[at + i] === text)) { found = at; break; }
      }
    }
    if (found < 0) throw new Error('hunk ' + (index + 1) + ' (line ' + hunk.start + ') does not apply: ' + JSON.stringify(oldLines.slice(0, 2)));
    lines.splice(found, oldLines.length, ...newLines);
    delta += found - expected + newLines.length - oldLines.length;
  });
  return lines.join('\n');
}

/**
 * The World and Asset descriptions with the overlay patches applied. `edits` swaps in patch text,
 * for a mutant: { world: (patchText) => patchText, asset: (patchText) => patchText }.
 */
function loadPatched(edits) {
  edits = edits || {};
  const out = {};
  for (const [name, rel, patchFile] of [['world', WORLD, 'OpenSpatialWorld.API.yaml.patch'], ['asset', ASSET, 'OpenSpatialAsset.API.yaml.patch']]) {
    const original = read(path.join(UPSTREAM, rel));
    let patch = read(path.join(OVERLAY, patchFile));
    if (edits[name]) patch = edits[name](patch);
    const text = applyUnifiedDiff(original, patch);
    out[name] = { original, text, doc: yaml.load(text), originalDoc: yaml.load(original) };
  }
  return out;
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function resolvePointer(doc, ref) {
  if (!ref.startsWith('#/')) return undefined;
  return ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), doc);
}

/** The OpenAPI 3.0 rule on path parameters: a path parameter is `in: path`, `required: true`, and named in the path template. */
function pathParameterProblems(doc) {
  const problems = [];
  for (const [route, item] of Object.entries(doc.paths || {})) {
    const template = [...route.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    const shared = item.parameters || [];
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const label = method.toUpperCase() + ' ' + route;
      const declared = [...shared, ...(op.parameters || [])]
        .map((p) => (p && p.$ref ? resolvePointer(doc, p.$ref) : p))
        .filter((p) => p && p.in === 'path');
      for (const p of declared) if (p.required !== true) problems.push(label + ': path parameter ' + p.name + ' is not required: true');
      const names = declared.map((p) => p.name);
      for (const name of template) if (!names.includes(name)) problems.push(label + ': {' + name + '} is not declared');
      for (const name of names) if (!template.includes(name)) problems.push(label + ': ' + name + ' is declared but is not in the path');
    }
  }
  return problems;
}

/** Every internal `$ref` resolves. */
function refProblems(doc) {
  const problems = [];
  (function walk(node, where) {
    if (Array.isArray(node)) node.forEach((x, i) => walk(x, where + '[' + i + ']'));
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') { if (resolvePointer(doc, value) === undefined) problems.push(where + ': ' + value + ' does not resolve'); }
        else walk(value, where + '.' + key);
      }
    }
  })(doc, '$');
  return problems;
}

/** Strip `x-osl-*` keys, so OSL's labels do not count as differences from the offered text. */
function withoutLabels(node) {
  if (Array.isArray(node)) return node.map(withoutLabels);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).filter(([key]) => !key.startsWith('x-osl-')).map(([key, value]) => [key, withoutLabels(value)]));
  }
  return node;
}

const squash = (text) => String(text).replace(/\s+/g, ' ').trim();

module.exports = { UPSTREAM, OVERLAY, WORLD, ASSET, read, sha256, applyUnifiedDiff, loadPatched, pathParameterProblems, refProblems, withoutLabels, squash, yaml };
