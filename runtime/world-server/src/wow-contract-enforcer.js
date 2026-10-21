'use strict';

/*
 * ALWAYS-ON, CONTRACT-DRIVEN WoW enforcement.
 *
 * Supersedes the env-gated (`OSL_WOW_VALIDATE`) validation that
 * lived as hand-written wrappers at each handler call site inside server.js.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The old layer had two defects that CONF-1 (parent, ledger)
 * closes:
 *
 *   1. It was OPT-IN. `OSL_WOW_VALIDATE` unset => no validation at all, and a
 *      launcher that forgot the flag served an UNENFORCED contract surface in
 *      total silence. (Three launchers set it; the module default was OFF, and
 *      `runtime/world-server/launch_backend_nodes.sh` never
 *      set it — so the "default OFF" was real, not theoretical.)
 *
 *   2. It was a PARALLEL LIST. `wowValidate(res, 'world', ...)`,
 *      `wowValidateNodeResponse(...)`, `wowValidateNodeRequest('OSLFlatNode')`
 *      hand-encoded, at each call site, which endpoint carries which schema.
 *      That list could — and did — diverge from `wow-spec/schema.yaml` without
 *      anything failing. Drift between the contract and its enforcement is this
 *      project's documented recurring defect.
 *
 * WHAT THIS FILE DOES
 * -------------------
 * It derives the enforcement table AT STARTUP from the contract document's own
 * `paths` object (`wow-spec/generated/schema.json`, built from
 * `wow-spec/schema.yaml` by `npm run wow-schema-json`):
 *
 *     contract paths  ->  { METHOD, path template, requestBody schema,
 *                           per-status response schema }
 *
 * Nothing in server.js states which schema an endpoint carries any more. Add,
 * remove, rename or re-type an operation in the contract and enforcement moves
 * with it, with no matching edit anywhere in this lane.
 *
 * FAIL-CLOSED
 * -----------
 * There is no env var, flag or launcher switch that disables enforcement.
 * `createContractEnforcer()` THROWS if the contract cannot be loaded or
 * declares no `/wow` operations — the server refuses to start rather than serve
 * an unenforced surface. `OSL_WOW_VALIDATE` is not read anywhere in this lane.
 *
 * DEPENDENCY BOUNDARY (unchanged)
 * -------------------------------
 * The route table is built from plain JSON with ZERO third-party dependencies.
 * ajv is required LAZILY, on the first payload actually validated, exactly as
 * `wow-spec/validate.js` has always done. If ajv is unavailable the verdict is
 * the same `error` header the env-gated layer emitted, and write requests are
 * still refused — i.e. the degradation is byte-for-byte what the previous
 * validation-ON path did, never a silent pass.
 *
 * REUSE-OVER-REBUILD
 * ----------------------------------------------
 * This is still an ADDITIVE layer on the existing vanilla-Node server. It is
 * NOT Express and NOT express-openapi-validator: the handlers stay exactly where
 * they are and call in. literal "migrate to Express" instruction is
 * declined because the interface requirement names this backend directly.
 */

const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTRACT_JSON_PATH = path.join(REPO_ROOT, 'wow-spec', 'generated', 'schema.json');
const VALIDATE_MODULE_PATH = path.join(REPO_ROOT, 'wow-spec', 'validate');

// Must match the $id `wow-spec/validate.js` registers its component bundle
// under; asserted at build time so a rename there fails loudly here.
const BUNDLE_ID = 'osl-wow-spec';
const WOW_PREFIX = '/wow/';
const JSON_MEDIA_TYPE = 'application/json';
const HTTP_METHODS = [ 'get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace' ];

/*
 * The DECLARED content variants this server serves in addition to the default
 * the contract states for an operation.
 *
 * These are NOT a parallel schema list: each one is ANCHORED IN the contract and
 * verified against it at startup (the header parameter must be declared on that
 * operation, the schema must exist in the contract's components). If the
 * contract stops declaring the anchor, construction THROWS: the variant cannot
 * outlive the contract clause that authorises it.
 *
 * The default node form is the canonical `Node` (children embedded). The variants
 * here are the explicit `flat` form (the labeled OSLFlatNode, children are ids) and
 * the `node` form of the graph root.
 *
 * `contract_declared` records whether the contract declares the variant at the
 * OPERATION level. An undeclared variant is surfaced on the wire (X-OSL-WoW-Contract)
 * and in describe(); it is never a silent omission.
 */
const NODE_PATH = '/wow/spatial/{spatialID}/node/{nodeId}';
const SPATIAL_PATH = '/wow/spatial/{spatialID}';
const isFlat = (ctx) => !!ctx && ctx.nodeForm === 'flat';
const flatVariant = (kind, method, schema_name, array, item_component) => ({
    id : 'node-form-flat-' + kind + '-' + method.toLowerCase(),
    kind,
    method,
    template : NODE_PATH,
    status : kind === 'response' ? 200 : undefined,
    selector : isFlat,
    requires_header_param : 'X-OSL-WoW-Node-Form',
    schema_name,
    item_component,
    array,
    contract_declared : true,
    why : 'the explicit `X-OSL-WoW-Node-Form: flat` form, declared as a header parameter on this operation; '
        + 'the node is the labeled OSLFlatNode and is validated as such.',
});
const DECLARED_VARIANTS = [
    flatVariant('request', 'POST', 'OSLFlatNode[]', true, 'OSLFlatNode'),
    flatVariant('request', 'PUT', 'OSLFlatNode', false, 'OSLFlatNode'),
    flatVariant('response', 'GET', 'OSLFlatNode', false, 'OSLFlatNode'),
    flatVariant('response', 'POST', 'OSLFlatNode[]', true, 'OSLFlatNode'),
    flatVariant('response', 'PUT', 'OSLFlatNode', false, 'OSLFlatNode'),
    {
        id : 'spatial-form-node-flat',
        kind : 'response',
        method : 'GET',
        template : SPATIAL_PATH,
        status : 200,
        selector : (ctx) => !!ctx && ctx.spatialForm === 'node' && ctx.nodeForm === 'flat',
        requires_header_param : 'X-OSL-WoW-Spatial-Form',
        schema_name : 'OSLFlatNode',
        array : false,
        contract_declared : true,
        why : '`form=node` with the node form `flat`: the graph root as the labeled OSLFlatNode.',
    },
    {
        id : 'spatial-form-node',
        kind : 'response',
        method : 'GET',
        template : SPATIAL_PATH,
        status : 200,
        selector : (ctx) => !!ctx && ctx.spatialForm === 'node',
        requires_header_param : 'X-OSL-WoW-Spatial-Form',
        schema_name : 'Node',
        array : false,
        contract_declared : true,
        why : '`form=node`: the graph root itself, as the canonical Node, instead of the Spatial.',
    },
];

/** '#/components/schemas/X' -> 'X'; array-of-$ref -> 'X[]'; else null. */
function schemaDisplayName(schema)
{
    if (!schema || typeof schema !== 'object') return null;
    if (typeof schema.$ref === 'string')
    {
        const m = /#\/components\/schemas\/(.+)$/.exec(schema.$ref);
        return m ? m[1] : null;
    }
    if (schema.type === 'array' && schema.items)
    {
        const inner = schemaDisplayName(schema.items);
        return inner ? inner + '[]' : null;
    }
    return null;
}

/**
 * Rewrite intra-document `#/components/schemas/X` refs onto the bundle id that
 * wow-spec/validate.js registered, so a schema lifted OUT of `paths` still
 * resolves its component refs when compiled standalone.
 */
function rewriteRefs(node)
{
    if (Array.isArray(node)) return node.map(rewriteRefs);
    if (node && typeof node === 'object')
    {
        const out = {};
        for (const key of Object.keys(node))
        {
            const value = node[key];
            if (key === '$ref' && typeof value === 'string' && value.indexOf('#/components/schemas/') === 0)
                out[key] = BUNDLE_ID + value;
            else out[key] = rewriteRefs(value);
        }
        return out;
    }
    return node;
}

/** OpenAPI path template -> anchored RegExp over a URL pathname. */
function templateToRegex(template)
{
    const parts = String(template).split('/').map((segment) => {
        if (/^\{[^{}]+\}$/.test(segment)) return '[^/]+';
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    });
    return new RegExp('^' + parts.join('/') + '$');
}

function jsonSchemaOf(content)
{
    if (!content || typeof content !== 'object') return null;
    const media = content[JSON_MEDIA_TYPE];
    if (!media || !media.schema) return null;
    return media.schema;
}

function buildOperations(doc)
{
    const paths = (doc && doc.paths) || {};
    const operations = [];
    for (const template of Object.keys(paths))
    {
        if (String(template).indexOf(WOW_PREFIX) !== 0) continue;
        const item = paths[template];
        if (!item || typeof item !== 'object') continue;
        for (const method of HTTP_METHODS)
        {
            const op = item[method];
            if (!op || typeof op !== 'object') continue;

            const requestSchema = jsonSchemaOf(op.requestBody && op.requestBody.content);
            const responses = {};
            const declaredStatuses = [];
            for (const status of Object.keys(op.responses || {}))
            {
                declaredStatuses.push(String(status));
                const schema = jsonSchemaOf((op.responses[status] || {}).content);
                if (schema)
                    responses[String(status)] = {
                        schema,
                        name : schemaDisplayName(schema) || ('inline:' + method.toUpperCase() + ' ' + template + ' ' + status),
                    };
            }

            operations.push({
                method : method.toUpperCase(),
                template,
                regex : templateToRegex(template),
                operation_id : op.operationId || null,
                literal_segments : String(template).split('/')
                    .filter((s) => s && !/^\{[^{}]+\}$/.test(s)).length,
                header_params : (op.parameters || [])
                    .filter((p) => p && p.in === 'header' && p.name)
                    .map((p) => String(p.name)),
                request : requestSchema ? {
                    schema : requestSchema,
                    name : schemaDisplayName(requestSchema)
                        || ('inline:' + method.toUpperCase() + ' ' + template + ' request'),
                } : null,
                responses,
                declared_statuses : declaredStatuses,
            });
        }
    }
    // Most-specific template first, so `/wow/spatial/{id}/node/{n}` is never
    // shadowed by a looser sibling.
    operations.sort((a, b) => (b.literal_segments - a.literal_segments)
        || (b.template.length - a.template.length));
    return operations;
}

/**
 * Build the always-on, contract-driven enforcer.
 *
 * @param {object} [opts]
 * @param {object} [opts.doc] OPERATIONAL override for proof harnesses only —
 *   the same precedent as `cfg.bind_port` in server.js. Drive the enforcer from
 *   an alternate contract document to prove enforcement FOLLOWS the contract.
 *   Unset for every production caller. It cannot be used to DISABLE enforcement:
 *   a doc with no /wow operations throws.
 * @throws when the contract is unloadable or declares no /wow operations, or a
 *   declared variant's contract anchor has disappeared.
 */
function createContractEnforcer(opts)
{
    opts = opts || {};

    let doc = opts.doc || null;
    if (!doc)
    {
        try {
            // require() caches; the file is a committed build artifact.
            doc = require(CONTRACT_JSON_PATH);
        } catch (e) {
            throw new Error('WoW contract not loadable from ' + CONTRACT_JSON_PATH
                + ' — refusing to serve an UNENFORCED contract surface. Run '
                + '`npm run wow-schema-json`. (' + e.message + ')');
        }
    }
    if (!doc.components || !doc.components.schemas)
        throw new Error('WoW contract has no components.schemas — refusing to serve unenforced.');

    const operations = buildOperations(doc);
    if (!operations.length)
        throw new Error('WoW contract declares no ' + WOW_PREFIX + ' operations — refusing to '
            + 'serve an UNENFORCED contract surface. Enforcement is always-on by design; '
            + 'an empty contract is a build failure, not an opt-out.');

    // ---- anchor every declared variant IN the contract (drift => throw) ----
    const variants = DECLARED_VARIANTS.map((v) => {
        const op = operations.find((o) => o.method === v.method && o.template === v.template);
        if (!op)
            throw new Error('declared variant `' + v.id + '` has no contract operation '
                + v.method + ' ' + v.template + ' — the contract no longer authorises it.');
        if (v.requires_header_param && op.header_params.indexOf(v.requires_header_param) === -1)
            throw new Error('declared variant `' + v.id + '` requires header parameter `'
                + v.requires_header_param + '` on ' + v.method + ' ' + v.template
                + ', which the contract no longer declares.');
        const component = v.item_component || v.requires_component || v.schema_name;
        if (!doc.components.schemas[component])
            throw new Error('declared variant `' + v.id + '` needs contract component `'
                + component + '`, which the contract no longer defines.');
        const ref = { $ref : '#/components/schemas/' + component };
        return Object.assign({}, v, {
            schema : v.array ? { type : 'array', items : ref } : ref,
        });
    });

    // ---- ajv: lazily created, exactly as the env-gated layer did ------------
    let ajvState = null;
    function ajvOrError()
    {
        if (!ajvState)
        {
            try {
                const validator = require(VALIDATE_MODULE_PATH).createValidator({ doc });
                if (!validator.ajv || !validator.ajv.getSchema(BUNDLE_ID))
                    throw new Error('wow-spec ajv component bundle `' + BUNDLE_ID
                        + '` is not registered (validate.js BUNDLE_ID drift)');
                ajvState = { validator, compiled : new Map(), error : null };
            } catch (e) {
                ajvState = { validator : null, compiled : null, error : e };
            }
        }
        return ajvState;
    }

    function runValidate(cacheKey, schema, name, data)
    {
        const state = ajvOrError();
        if (state.error)
            return { available : false, valid : false, schema : name,
                errorsText : 'validator unavailable: ' + state.error.message };
        try {
            let fn = state.compiled.get(cacheKey);
            if (!fn)
            {
                fn = state.validator.ajv.compile(rewriteRefs(schema));
                state.compiled.set(cacheKey, fn);
            }
            const valid = fn(data);
            return {
                available : true,
                valid : !!valid,
                schema : name,
                errorsText : valid ? null
                    : state.validator.ajv.errorsText(fn.errors, { separator : '; ' }),
            };
        } catch (e) {
            return { available : false, valid : false, schema : name,
                errorsText : 'validator unavailable: ' + e.message };
        }
    }

    function isWowPath(pathname)
    {
        return String(pathname || '').indexOf(WOW_PREFIX) === 0;
    }

    function match(method, pathname)
    {
        const m = String(method || '').toUpperCase();
        const p = String(pathname || '');
        for (const op of operations)
            if (op.method === m && op.regex.test(p)) return op;
        return null;
    }

    function variantFor(kind, op, ctx)
    {
        for (const v of variants)
            if (v.kind === kind && v.method === op.method && v.template === op.template
                && v.selector(ctx)) return v;
        return null;
    }

    /**
     * REQUEST verdict for a parsed JSON body.
     * @returns null when the contract declares no request body for this
     *   operation (or the path carries no contract operation at all) — the
     *   handler then behaves exactly as before. Otherwise
     *   { valid, schema, errorsText, available, variant }.
     */
    function requestVerdict(method, pathname, body, ctx)
    {
        if (!isWowPath(pathname)) return null;
        const op = match(method, pathname);
        if (!op) return null;
        const variant = variantFor('request', op, ctx);
        const entry = variant ? { schema : variant.schema, name : variant.schema_name } : op.request;
        if (!entry) return null;
        const key = 'req:' + op.method + ' ' + op.template + ':' + entry.name;
        const r = runValidate(key, entry.schema, entry.name, body);
        r.variant = variant ? variant.id : null;
        r.operation = op.method + ' ' + op.template;
        return r;
    }

    /**
     * RESPONSE verdict. NEVER alters body or status — it only produces the
     * observability header value, in the SAME vocabulary the env-gated layer
     * used (`pass:<schema>` / `fail:<schema>` / `error`), plus three EXPLICIT
     * non-silent verdicts the old layer had no word for (it simply emitted no
     * header at all):
     *
     *   unchecked:no-contract-operation   the path is under /wow/ but the
     *                                     contract declares no operation for it
     *   unchecked:no-response-schema:NNN  the contract declares this status but
     *                                     gives it no JSON schema to check
     *   undeclared-status:NNN             the server emitted a status the
     *                                     contract does not declare
     *
     * @returns null for non-/wow paths (byte-identical behaviour to before).
     */
    function responseVerdict(method, pathname, status, body, ctx)
    {
        if (!isWowPath(pathname)) return null;
        const op = match(method, pathname);
        if (!op)
            return { header : 'unchecked:no-contract-operation', checked : false,
                reason : 'no contract operation for ' + String(method).toUpperCase() + ' ' + pathname };

        const code = String(status);
        const variant = variantFor('response', op, ctx);
        let entry = null;
        if (variant && (!variant.status || String(variant.status) === code))
            entry = { schema : variant.schema, name : variant.schema_name };
        else
            entry = op.responses[code] || null;

        if (!entry)
        {
            if (op.declared_statuses.indexOf(code) !== -1)
                return { header : 'unchecked:no-response-schema:' + code, checked : false,
                    operation : op.method + ' ' + op.template };
            return { header : 'undeclared-status:' + code, checked : false,
                operation : op.method + ' ' + op.template,
                reason : 'the contract declares statuses [' + op.declared_statuses.join(',')
                    + '] for this operation' };
        }

        const key = 'res:' + op.method + ' ' + op.template + ':' + code + ':' + entry.name;
        const r = runValidate(key, entry.schema, entry.name, body);
        if (!r.available)
            return { header : 'error', checked : false, reason : r.errorsText,
                operation : op.method + ' ' + op.template };
        return {
            header : (r.valid ? 'pass:' : 'fail:') + entry.name,
            checked : true,
            valid : r.valid,
            schema : entry.name,
            errorsText : r.errorsText,
            operation : op.method + ' ' + op.template,
            variant : variant ? variant.id : null,
            // surfaced on the wire when the variant is not declared at the
            // operation level — explicit, never a silent omission.
            contract_note : (variant && !variant.contract_declared)
                ? 'variant-undeclared-in-contract:' + variant.id : null,
        };
    }

    /**
     * Machine-readable description of what enforcement was DERIVED from the
     * contract. Proof harnesses read this instead of grepping source — a grep of
     * our own source is exactly the worthless check this project has been burned
     * by before.
     */
    function describe()
    {
        return {
            always_on : true,
            env_gated : false,
            env_var_read : null,
            source : 'wow-spec contract paths (openapi ' + (doc.openapi || '?') + ')',
            contract_path : opts.doc ? '(injected)' : CONTRACT_JSON_PATH,
            operation_count : operations.length,
            operations : operations.map((op) => ({
                method : op.method,
                template : op.template,
                operation_id : op.operation_id,
                request_schema : op.request ? op.request.name : null,
                response_schemas : Object.keys(op.responses).reduce((acc, code) => {
                    acc[code] = op.responses[code].name;
                    return acc;
                }, {}),
                statuses_declared_without_schema : op.declared_statuses
                    .filter((c) => !op.responses[c]),
            })),
            declared_variants : variants.map((v) => ({
                id : v.id, kind : v.kind, operation : v.method + ' ' + v.template,
                schema : v.schema_name, contract_declared : v.contract_declared,
                anchored_by : v.requires_header_param
                    ? ('header parameter ' + v.requires_header_param)
                    : ('component ' + (v.requires_component || v.schema_name)),
                why : v.why,
            })),
            // Honest, visible statement of what enforcement does NOT cover.
            not_covered : [
                'Non-JSON /wow surfaces: the OpenSpatialAsset BYTE responses under '
                    + '/wow/asset/{assetId}/ are content-negotiated binaries (GLB/USDZ/...), '
                    + 'not JSON documents; they are outside JSON-schema enforcement and are '
                    + 'reported as unchecked:no-contract-operation when they answer in JSON.',
                '/wow paths the contract declares no operation for (e.g. /wow/location, '
                    + '/wow/graph) are REPORTED as unchecked:no-contract-operation on every '
                    + 'response rather than silently skipped. Declaring them is contract work, '
                    + 'not enforcement work.',
                'Statuses the contract declares without a JSON schema are reported as '
                    + 'unchecked:no-response-schema:<status>; there is nothing to check until '
                    + 'the contract types them.',
                'Live write-path coverage measurement is CONF-2 (a separate runtime updates).',
            ],
        };
    }

    return {
        doc,
        operations,
        operation_count : operations.length,
        isWowPath,
        match,
        requestVerdict,
        responseVerdict,
        describe,
        // exposed for proof harnesses that need to assert the degradation path
        ajvAvailable : () => !ajvOrError().error,
    };
}

module.exports = {
    createContractEnforcer,
    // exported for focused checks
    schemaDisplayName,
    templateToRegex,
    rewriteRefs,
    buildOperations,
    CONTRACT_JSON_PATH,
    BUNDLE_ID,
    DECLARED_VARIANTS,
};
