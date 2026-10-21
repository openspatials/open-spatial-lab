'use strict';

/*
 * wow-spec public entry.
 *
 * OSL's typed, validated OpenSpatialWorld contract surface. One YAML
 * (schema.yaml) drives: TypeScript types (generated/wow-types.d.ts via
 * openapi-typescript) AND runtime ajv validation (generated/schema.json via
 * validate.js). Server (runtime/041) and client (web/live-adapter.js)
 * single-source both from here.
 */

const path = require('path');
const validate = require('./validate');

module.exports = {
    // absolute path to the human source of truth (openapi-typescript reads this)
    apiSpecPath: path.join(__dirname, 'schema.yaml'),
    // absolute path to the compiled machine schema (ajv loads this)
    schemaJsonPath: validate.SCHEMA_JSON_PATH,
    // absolute path to the generated shared TypeScript types
    typesPath: path.join(__dirname, 'generated', 'wow-types.d.ts'),

    // ajv validation layer
    createValidator: validate.createValidator,
    getValidator: validate.getValidator,

    // schema-name maps (canonical read kind -> schema name)
    RESPONSE_SCHEMA_BY_KIND: validate.RESPONSE_SCHEMA_BY_KIND,
    CANONICAL_SCHEMA_BY_KIND: validate.CANONICAL_SCHEMA_BY_KIND,
};
