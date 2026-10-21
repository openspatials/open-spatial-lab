'use strict';

/*
 * wow-spec ajv validation layer.
 *
 * The ADDITIVE, COMPATIBLE request/response validation mechanism for OSL's
 * WoW surface. It compiles the OpenAPI component schemas from
 * `generated/schema.json` with ajv and exposes a tiny validate() API that the
 * existing dependency-free 041 handlers (and the client / conformance lanes)
 * call directly. It is NOT an Express / express-openapi-validator middleware:
 * per the reuse-over-rebuild mandate (PROP §12) the vanilla-Node server
 * is preserved; validation is invoked from inside its existing handlers.
 *
 * ajv is required lazily by createValidator(), so a plain serve that never
 * enables validation loads no third-party dependency at all.
 */

const path = require('path');

const SCHEMA_JSON_PATH = path.join(__dirname, 'generated', 'schema.json');

// read kind -> the schema OSL ACTUALLY SERVES for it.
//   * the four read surfaces -> the OSL response COMPOSITE (canonical + labeled ext)
//   * `node` -> OSLFlatNode, the LABELED, NON-CANONICAL flat (id-ref children)
//     node shape the /wow/spatial/* paths serve. It is NOT the canonical `Node`
//     (which embeds child objects) — that divergence is DECLARED in schema.yaml
//     and surfaced by the conformance lane. Validating served nodes against the
//     schema we actually implement is what lets the conformance lane report the
//     canonical diff HONESTLY (canonical_node_valid:false) instead of bending the
//     canonical schema to make our shape look conformant.
const RESPONSE_SCHEMA_BY_KIND = {
    world: 'OSLWorldResponse', World: 'OSLWorldResponse',
    user: 'OSLUserResponse', User: 'OSLUserResponse',
    view: 'OSLViewResponse', View: 'OSLViewResponse',
    portal: 'OSLPortalResponse', Portal: 'OSLPortalResponse',
    node: 'OSLFlatNode', Node: 'OSLFlatNode',
};

// canonical read kind -> the PURE canonical schema (for the conformance lane
// to diff canonical-vs-actual). `node` -> the canonical `Node`, which
// EMBEDS child Node objects per the open spec. OSL's served flat nodes are
// EXPECTED to fail this — that is the declared divergence, reported not hidden.
const CANONICAL_SCHEMA_BY_KIND = {
    world: 'World', World: 'World',
    user: 'User', User: 'User',
    view: 'View', View: 'View',
    portal: 'Portal', Portal: 'Portal',
    node: 'Node', Node: 'Node',
};

const BUNDLE_ID = 'osl-wow-spec';

function loadDoc()
{
    // require() caches; generated/schema.json is produced by build-schema-json.js
    // (committed artifact). Falls through with a clear error if not yet built.
    try {
        return require(SCHEMA_JSON_PATH);
    } catch (e) {
        throw new Error(
            'wow-spec/generated/schema.json not found — run `npm run wow-schema-json` first. ('
            + e.message + ')');
    }
}

/**
 * Build a validator over the wow-spec component schemas.
 * Lazily requires ajv + ajv-formats (only when validation is enabled).
 */
function createValidator(opts)
{
    opts = opts || {};
    const Ajv = require('ajv');
    const addFormats = require('ajv-formats');
    const doc = opts.doc || loadDoc();
    if (!doc.components || !doc.components.schemas)
        throw new Error('wow-spec schema.json missing components.schemas');

    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    // Register the component bundle so intra-doc `#/components/schemas/X`
    // $refs (e.g. GeoPose, ProofBoundary) resolve.
    ajv.addSchema({ $id: BUNDLE_ID, components: { schemas: doc.components.schemas } });

    const cache = new Map();
    function getValidate(schemaName)
    {
        if (cache.has(schemaName)) return cache.get(schemaName);
        if (!doc.components.schemas[schemaName])
            throw new Error('unknown wow-spec schema: ' + schemaName);
        const v = ajv.compile({ $ref: BUNDLE_ID + '#/components/schemas/' + schemaName });
        cache.set(schemaName, v);
        return v;
    }

    function result(schemaName, validateFn, data)
    {
        const valid = validateFn(data);
        return {
            valid: !!valid,
            schema: schemaName,
            errors: valid ? null : validateFn.errors,
            errorsText: valid ? null : ajv.errorsText(validateFn.errors, { separator: '; ' }),
        };
    }

    /** Validate `data` against a named component schema. */
    function validate(schemaName, data)
    {
        return result(schemaName, getValidate(schemaName), data);
    }

    /** Validate a /wow response against its OSL response composite. */
    function validateResponse(kind, data)
    {
        return validate(RESPONSE_SCHEMA_BY_KIND[kind] || kind, data);
    }

    /** Validate a payload against the PURE canonical schema (no extensions). */
    function validateCanonical(kind, data)
    {
        return validate(CANONICAL_SCHEMA_BY_KIND[kind] || kind, data);
    }

    const arrayCache = new Map();
    /**
     * Validate a request body against a named schema, or against an ARRAY of a
     * named schema using the `X[]` suffix (e.g. 'OSLFlatNode[]' for the
     * node-create body, 'Node[]' for a canonical node array).
     */
    function validateRequest(schemaName, data)
    {
        const m = /^(.+?)(?:\[\]|Array)$/.exec(schemaName);
        if (m)
        {
            const itemSchema = m[1];
            if (!doc.components.schemas[itemSchema])
                throw new Error('unknown wow-spec schema: ' + itemSchema);
            const key = itemSchema + '[]';
            if (!arrayCache.has(key))
                arrayCache.set(key, ajv.compile({
                    type: 'array',
                    items: { $ref: BUNDLE_ID + '#/components/schemas/' + itemSchema },
                }));
            return result(key, arrayCache.get(key), data);
        }
        return validate(schemaName, data);
    }

    return {
        ajv,
        doc,
        schemaNames: Object.keys(doc.components.schemas),
        validate,
        validateResponse,
        validateCanonical,
        validateRequest,
        RESPONSE_SCHEMA_BY_KIND,
        CANONICAL_SCHEMA_BY_KIND,
    };
}

let shared = null;
/** Process-wide shared validator (cached). */
function getValidator()
{
    if (!shared) shared = createValidator();
    return shared;
}

module.exports = {
    createValidator,
    getValidator,
    RESPONSE_SCHEMA_BY_KIND,
    CANONICAL_SCHEMA_BY_KIND,
    SCHEMA_JSON_PATH,
};
