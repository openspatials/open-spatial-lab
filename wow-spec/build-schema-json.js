'use strict';

/*
 * wow-spec build step (BUILD-TIME ONLY): compile the human-authored
 * `schema.yaml` (the single source of truth) into `generated/schema.json`,
 * the machine artifact the runtime ajv validation layer loads.
 *
 * Keeping YAML parsing at build time means `validate.js` (the runtime layer)
 * requires only ajv + ajv-formats + core `fs` — NO YAML parser in the serving
 * path. The dependency-free 041 read path stays dependency-free by default
 * (ajv is loaded only when validation is explicitly enabled).
 *
 * Run: `node wow-spec/build-schema-json.js` (or `npm run wow-schema-json`).
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const SPEC_DIR = __dirname;
const YAML_PATH = path.join(SPEC_DIR, 'schema.yaml');
const OUT_DIR = path.join(SPEC_DIR, 'generated');
const JSON_PATH = path.join(OUT_DIR, 'schema.json');

function main()
{
    const yamlText = fs.readFileSync(YAML_PATH, 'utf8');
    const doc = yaml.load(yamlText);
    if (!doc || typeof doc !== 'object' || !doc.components || !doc.components.schemas)
        throw new Error('schema.yaml did not parse into an OpenAPI doc with components.schemas');

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(JSON_PATH, JSON.stringify(doc, null, 2) + '\n', 'utf8');

    const schemaNames = Object.keys(doc.components.schemas);
    process.stdout.write(
        '[wow-spec] wrote ' + path.relative(SPEC_DIR, JSON_PATH) + ' ('
        + schemaNames.length + ' schemas: ' + schemaNames.join(', ') + ')\n');
}

main();
