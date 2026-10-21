#!/usr/bin/env node
/*
 * Copyright 2026 Open Spatial Lab contributors
 * SPDX-License-Identifier: Apache-2.0
 *
 * A dependency-free runner for the pinned OpenSpatialWorld fixture subset.
 * This is deliberately a small evaluator for the JSON Schema keywords used by
 * the copied subset, not a general-purpose JSON Schema implementation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_NAMES = ['World', 'User', 'Node', 'Portal', 'View', 'Spatial'];
const ENDPOINTS = [
  'GET /wow/world',
  'GET /wow/user/{userId}',
  'GET /wow/view/{viewId}',
  'GET /wow/portal/{portalId}',
  'GET /wow/spatial/{spatialID}',
  'GET /wow/spatial/{spatialID}/node/{nodeId}'
];
const DIVERGENCE_IDS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function isType(value, type) {
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateValue(value, schema, schemas, location = '$') {
  if (schema.$ref) {
    const name = schema.$ref.split('/').at(-1);
    if (!schemas[name]) return [`${location}: unresolved schema reference ${schema.$ref}`];
    return validateValue(value, schemas[name], schemas, location);
  }

  const errors = [];
  if (schema.type && !isType(value, schema.type)) {
    return [`${location}: expected ${schema.type}`];
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${location}: not in enum`);
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) errors.push(`${location}: below minimum`);
  if (typeof value === 'number' && schema.maximum !== undefined && value > schema.maximum) errors.push(`${location}: above maximum`);
  if (typeof value === 'number' && schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${location}: not above exclusiveMinimum`);

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => errors.push(...validateValue(item, schema.items, schemas, `${location}[${index}]`)));
  }

  if (isType(value, 'object')) {
    for (const required of schema.required || []) {
      if (!Object.hasOwn(value, required)) errors.push(`${location}: missing required property ${required}`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (schema.properties?.[key]) errors.push(...validateValue(child, schema.properties[key], schemas, `${location}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${location}: unexpected property ${key}`);
    }
  }
  return errors;
}

function evaluateFixture(fixture, schemas, divergences) {
  const unknownDivergences = (fixture.divergences || []).filter((id) => !divergences[id]);
  if (unknownDivergences.length) return { pass: false, errors: [`unknown divergence: ${unknownDivergences.join(', ')}`] };

  const errors = [];
  if (fixture.declaredObservation || fixture.comparison) {
    if (!fixture.divergences?.length) errors.push('declared observation has no divergence cross-link');
    if (!['GAP', `DECLARED-DIVERGENCE(${fixture.divergences?.[0]})`].includes(fixture.classification)) {
      errors.push('declared observation has an invalid classification');
    }
    if (fixture.comparison && JSON.stringify(fixture.comparison.upstream) === JSON.stringify(fixture.comparison.osl)) {
      errors.push('comparison does not exercise a difference');
    }
    if (!fixture.schema && !fixture.inlineSchema) return { pass: errors.length === 0, errors };
  }

  const schema = fixture.inlineSchema || schemas[fixture.schema];
  if (!schema) return { pass: false, errors: [`unknown schema: ${fixture.schema}`] };
  const validationErrors = validateValue(fixture.data, schema, schemas);
  const accepted = validationErrors.length === 0;
  const pass = errors.length === 0 && fixture.expect === (accepted ? 'accept' : 'reject');
  return {
    pass,
    errors: pass ? [] : [...errors, `expected ${fixture.expect}, validator ${accepted ? 'accepted' : 'rejected'}: ${validationErrors.join('; ')}`]
  };
}

function assertCatalogCoverage(fixtures) {
  const errors = [];
  const ids = fixtures.map((fixture) => fixture.id);
  if (new Set(ids).size !== ids.length) errors.push('fixture ids are not unique');

  for (const schema of SCHEMA_NAMES) {
    const cases = fixtures.filter((fixture) => fixture.schema === schema && !fixture.divergences);
    if (!cases.some((fixture) => fixture.id.includes('minimal-valid') && fixture.expect === 'accept')) errors.push(`${schema}: missing minimal-valid fixture`);
    if (!cases.some((fixture) => fixture.id.includes('rich-valid') && fixture.expect === 'accept')) errors.push(`${schema}: missing rich-valid fixture`);
    if (!cases.some((fixture) => fixture.expect === 'reject')) errors.push(`${schema}: missing negative fixture`);
    const minimal = cases.find((fixture) => fixture.id.includes('minimal-valid'));
    if (JSON.stringify(minimal?.data) !== '{}' || minimal.classification !== 'SPEC-UNDER-CONSTRAINED') errors.push(`${schema}: {} under-constrained finding is not explicit`);
  }

  for (const endpoint of ENDPOINTS) {
    const cases = fixtures.filter((fixture) => fixture.endpoint === endpoint);
    if (!cases.some((fixture) => fixture.id.includes('minimal-valid') && fixture.expect === 'accept')) errors.push(`${endpoint}: missing minimal-valid fixture`);
    if (!cases.some((fixture) => fixture.id.includes('rich-valid') && fixture.expect === 'accept')) errors.push(`${endpoint}: missing rich-valid fixture`);
    if (!cases.some((fixture) => fixture.expect === 'reject')) errors.push(`${endpoint}: missing negative fixture`);
  }

  for (const id of DIVERGENCE_IDS) {
    if (!fixtures.some((fixture) => fixture.divergences?.includes(id))) errors.push(`${id}: no exercising fixture`);
  }
  return errors;
}

function parseMutationId(args) {
  const equals = args.find((arg) => arg.startsWith('--mutate='));
  if (equals) return equals.slice('--mutate='.length);
  const index = args.indexOf('--mutate');
  return index >= 0 ? args[index + 1] : null;
}

function mutateFixture(fixture) {
  if (fixture.declaredObservation) fixture.divergences = [];
  else fixture.data = fixture.expect === 'accept' ? 42 : {};
}

function main() {
  const schemaBundle = readJson('upstream-schema-subset.json');
  const divergenceBundle = readJson('divergences.json');
  const catalogs = [
    readJson('fixtures/schema-cases.json'),
    readJson('fixtures/endpoint-cases.json'),
    readJson('fixtures/divergence-cases.json')
  ];
  const metadata = [schemaBundle, divergenceBundle, ...catalogs];
  const errors = [];
  if (metadata.some((document) => document.license !== 'Apache-2.0')) errors.push('every machine-readable corpus file must declare Apache-2.0');

  const fixtures = catalogs.flatMap((catalog) => catalog.fixtures).map((fixture) => structuredClone(fixture));
  const mutationId = parseMutationId(process.argv.slice(2));
  if (mutationId) {
    const fixture = fixtures.find((candidate) => candidate.id === mutationId);
    if (!fixture) errors.push(`unknown mutation fixture: ${mutationId}`);
    else mutateFixture(fixture);
  }

  errors.push(...assertCatalogCoverage(fixtures));
  let passed = 0;
  for (const fixture of fixtures) {
    const result = evaluateFixture(fixture, schemaBundle.schemas, divergenceBundle.divergences);
    if (result.pass) {
      passed += 1;
      console.log(`PASS ${fixture.id} -> ${fixture.classification}`);
    } else {
      console.error(`FAIL ${fixture.id} -> GAP: ${result.errors.join('; ')}`);
      errors.push(`${fixture.id}: ${result.errors.join('; ')}`);
    }
  }

  if (errors.length) {
    console.error(`\nRESULT FAIL (${passed}/${fixtures.length} fixtures passed; ${errors.length} gate error(s))`);
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nRESULT PASS (${passed}/${fixtures.length} fixtures; D1-D8 cross-linked; standards_conformance remains unclaimed)`);
}

main();
