'use strict';

/*
 * Conformance vocabulary: the BCP 14 key words and the `required` lists of an API description.
 * Shared by the iteration proofs (iteration 1 first; later iterations pass their own lists).
 *
 *   BCP14              the boilerplate of RFC 8174, section 2, citing RFC 2119 and RFC 8174
 *   hasBcp14           a text carries that paragraph
 *   keywordCount       how many key words a text uses, outside the boilerplate itself
 *   sentenceProblems   each listed normative sentence is found and uses a key word
 *   requiredProblems   each listed schema has exactly its expected `required` list (none means no list)
 *   requiredDiffs      two documents give the listed schemas the same `required` lists
 *   missingRequired    the members a JSON value lacks against a schema's `required` list
 *
 * Only words in all capitals are key words (RFC 8174): "must" in lower case is ordinary English.
 */

const { squash } = require('./upstream');

const BCP14 = 'The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", '
  + '"RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as '
  + 'described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.';

const KEYWORD = /\b(?:MUST NOT|MUST|REQUIRED|SHALL NOT|SHALL|SHOULD NOT|SHOULD|NOT RECOMMENDED|RECOMMENDED|MAY|OPTIONAL)\b/g;

const hasBcp14 = (text) => squash(text || '').includes(squash(BCP14));

/** Key words used in a text, not counting the ones the boilerplate lists. */
function keywordCount(text) {
  const body = squash(text || '').split(squash(BCP14)).join(' ');
  return (body.match(KEYWORD) || []).length;
}

/** The sentence of `text` that contains `anchor` (in any case), or null. A sentence ends at a full stop followed by space. */
function sentenceWith(text, anchor) {
  const sentences = squash(text || '').split(/(?<=\.)\s+/);
  return sentences.find((s) => s.toLowerCase().includes(String(anchor).toLowerCase())) || null;
}

/**
 * Each entry is { where, text: (doc) => string, anchor }. A sentence that is missing, or that has no key
 * word, is a problem. `label` names the document in the message.
 */
function sentenceProblems(doc, list, label) {
  const problems = [];
  for (const entry of list) {
    let text = null;
    try { text = entry.text(doc); } catch (error) { text = null; }
    const sentence = sentenceWith(text, entry.anchor);
    if (!sentence) problems.push(label + ' ' + entry.where + ': no sentence with "' + entry.anchor + '"');
    else if (!(sentence.match(KEYWORD) || []).length) problems.push(label + ' ' + entry.where + ': the normative sentence "' + sentence.slice(0, 70) + '" has no key word');
  }
  return problems;
}

const sorted = (list) => JSON.stringify([...list].sort());

/** `expected` maps a schema name to its list; an empty list means the schema carries no `required` (OpenAPI 3.0 forbids an empty one). */
function requiredProblems(schemas, expected, label) {
  const problems = [];
  for (const [name, want] of Object.entries(expected)) {
    const schema = (schemas || {})[name];
    if (!schema) { problems.push(label + ' has no schema ' + name); continue; }
    const have = schema.required;
    if (!want.length) {
      if (have !== undefined) problems.push(label + ' ' + name + ' has required ' + JSON.stringify(have) + ', wanted no required member');
    } else if (!Array.isArray(have)) problems.push(label + ' ' + name + ' has no required list (wanted ' + JSON.stringify(want) + ')');
    else if (sorted(have) !== sorted(want)) problems.push(label + ' ' + name + ' requires ' + JSON.stringify(have) + ', wanted ' + JSON.stringify(want));
  }
  return problems;
}

/** The listed schemas whose `required` lists differ between two documents' schemas. */
function requiredDiffs(a, b, names) {
  const out = [];
  for (const name of names) {
    const x = ((a || {})[name] || {}).required;
    const y = ((b || {})[name] || {}).required;
    if (JSON.stringify(x === undefined ? null : [...x].sort()) !== JSON.stringify(y === undefined ? null : [...y].sort())) {
      out.push(name + ' required ' + JSON.stringify(x === undefined ? null : x) + ' against ' + JSON.stringify(y === undefined ? null : y));
    }
  }
  return out;
}

/** Members of `schema.required` that `value` does not carry (null and undefined count as missing). */
function missingRequired(schema, value) {
  if (!schema || !Array.isArray(schema.required)) return [];
  if (!value || typeof value !== 'object') return [...schema.required];
  return schema.required.filter((key) => value[key] === undefined || value[key] === null);
}

module.exports = { BCP14, KEYWORD, hasBcp14, keywordCount, sentenceWith, sentenceProblems, requiredProblems, requiredDiffs, missingRequired };
