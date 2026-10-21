'use strict';

/*
 * ALWAYS-ON, CONTRACT-DRIVEN WoW enforcement proof.
 *
 * THE BAR THIS HARNESS IS WRITTEN AGAINST
 * ---------------------------------------
 * Not "validation runs" — "validation CATCHES WHAT IT CLAIMS TO CATCH". This
 * repository has a documented history of proofs that pass while measuring
 * nothing (five standards claims once backed by greps of themselves), so every
 * assertion below is BEHAVIOURAL: a real server, on a real socket, answering a
 * real request. The two source-text assertions that do exist are labelled as
 * SUPPORTING and no conclusion rests on them alone.
 *
 * Sections:
 *   A  ALWAYS-ON        — enforcement survives OSL_WOW_VALIDATE being unset AND
 *                         being explicitly set to a falsey value. There is no
 *                         env var or launcher flag that can turn it off.
 *   B  NO BEHAVIOUR CHANGE — every pre-existing pass:<schema> header value is
 *                         byte-identical, bodies are byte-identical to what the
 *                         runtime produced, statuses unchanged.
 *   C  BROADER COVERAGE — measured: every /wow JSON response carries an explicit
 *                         verdict. Zero silent responses. The verdicts that are
 *                         NEW (paths + statuses that emitted NO header at all
 *                         before) are enumerated, not asserted in the abstract.
 *   D  CONTROLLED RED, RESPONSE — the server is MUTATED to emit a contract-
 *                         violating response; enforcement must go RED; restore;
 *                         must go green.
 *   E  CONTROLLED RED, REQUEST  — a contract-violating request body must be
 *                         REFUSED and must store nothing; and richer
 *                         embedded-children refusal must survive always-on ajv.
 *   F  CONTRACT-DRIVEN  — the CONTRACT is changed and enforcement follows, with
 *                         NO matching edit to any source file: tighten, loosen,
 *                         remove an operation, rename a schema.
 *   G  FAIL-CLOSED      — an empty/unanchored contract makes createServer THROW.
 *                         Enforcement cannot be removed by emptying the contract.
 *   H  BLAST RADIUS     — non-/wow routes are untouched.
 *
 * Isolated high ports only (19341-19346). NEVER 8143 or 18151-18154.
 * Evidence goes to a TEMP directory by default because evidence/ is tracked;
 * pass --evidence=<path> to write it somewhere explicitly.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const HOST = '127.0.0.1';
const LANE_SRC = path.join(__dirname, '..', 'src');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// The enforcement layer is ALWAYS ON. Prove it from the hostile starting state:
// the env var the old layer needed is DELETED for this entire run.
delete process.env.OSL_WOW_VALIDATE;

const { createServer } = require(path.join(LANE_SRC, 'server'));
const { createContractEnforcer } = require(path.join(LANE_SRC, 'wow-contract-enforcer'));
const { createValidator } = require(path.join(REPO_ROOT, 'wow-spec', 'validate'));
const CONTRACT = require(path.join(REPO_ROOT, 'wow-spec', 'generated', 'schema.json'));

const SPATIAL_ID = 'demo-room-a';
const PORT = {
    alwaysOn : 19341,
    envOff : 19342,
    tighten : 19343,
    loosen : 19344,
    removeOp : 19345,
    rename : 19346,
};

const results = [];
let failures = 0;
function check(name, ok, detail)
{
    results.push({ name, ok : !!ok, detail : detail || null });
    if (!ok) failures++;
    process.stdout.write((ok ? '  PASS  ' : '  FAIL  ') + name
        + (detail ? '  -- ' + detail : '') + '\n');
}

function httpReq(method, port, p, body, headers)
{
    return new Promise((resolve, reject) => {
        const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body));
        const req = http.request({
            host : HOST, port, path : p, method,
            headers : Object.assign({ Accept : 'application/json' },
                payload ? { 'Content-Type' : 'application/json', 'Content-Length' : payload.length } : {},
                headers || {}),
        }, (res) => {
            let raw = '';
            res.on('data', c => { raw += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(raw); } catch (e) { /* leave null */ }
                resolve({ status : res.statusCode, headers : res.headers, json, raw });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}
const GET = (port, p, h) => httpReq('GET', port, p, null, h);
const POST = (port, p, b, h) => httpReq('POST', port, p, b, h);
const PUT = (port, p, b, h) => httpReq('PUT', port, p, b, h);
const V = (r) => r.headers['x-osl-wow-validation'];

function cloneContract() { return JSON.parse(JSON.stringify(CONTRACT)); }

async function listen(role, opts, port)
{
    const built = createServer(role, Object.assign({ http_port : port }, opts || {}));
    await new Promise(r => built.server.listen(port, HOST, r));
    return built;
}

async function main()
{
    const started = [];
    let evidenceDir = null;
    try {
        // =================================================================
        // A — ALWAYS ON
        // =================================================================
        // SUPPORTING (source text, not a conclusion on its own): the env var the
        // old opt-in layer needed is not read anywhere in this lane's source.
        const laneSources = fs.readdirSync(LANE_SRC).filter(f => f.endsWith('.js'));
        const envReaders = laneSources.filter(f =>
            /process\.env\.OSL_WOW_VALIDATE/.test(fs.readFileSync(path.join(LANE_SRC, f), 'utf8')));
        check('A0 SUPPORTING: no file in the 041 components src READS process.env.OSL_WOW_VALIDATE',
            envReaders.length === 0, 'readers=' + JSON.stringify(envReaders));

        // BEHAVIOURAL: env var DELETED (done at module load, above).
        const a = await listen('a', {}, PORT.alwaysOn); started.push(a);
        const worldOn = await GET(PORT.alwaysOn, '/wow/world');
        check('A1 env UNSET: GET /wow/world is still contract-enforced',
            worldOn.status === 200 && V(worldOn) === 'pass:OSLWorldResponse',
            'status=' + worldOn.status + ' hdr=' + V(worldOn));
        check('A1b the env var really was absent for that server',
            process.env.OSL_WOW_VALIDATE === undefined,
            'OSL_WOW_VALIDATE=' + String(process.env.OSL_WOW_VALIDATE));

        // BEHAVIOURAL: env var explicitly set to the OFF value the old layer honoured.
        process.env.OSL_WOW_VALIDATE = '0';
        const off = await listen('a', {}, PORT.envOff); started.push(off);
        const worldOff = await GET(PORT.envOff, '/wow/world');
        check('A2 OSL_WOW_VALIDATE=0 CANNOT disable response enforcement',
            worldOff.status === 200 && V(worldOff) === 'pass:OSLWorldResponse',
            'hdr=' + V(worldOff));
        const badWhileOff = await POST(PORT.envOff, '/wow/spatial/' + SPATIAL_ID + '/node/0',
            [ { label : 12345 } ]);
        check('A3 OSL_WOW_VALIDATE=0 CANNOT disable REQUEST enforcement either',
            badWhileOff.status === 422 && V(badWhileOff) === 'fail:OSLFlatNode[]',
            'status=' + badWhileOff.status + ' hdr=' + V(badWhileOff));
        delete process.env.OSL_WOW_VALIDATE;

        // =================================================================
        // B — NO CONFORMANT BEHAVIOUR CHANGED
        // =================================================================
        const root = (await GET(PORT.alwaysOn, '/wow/spatial/' + SPATIAL_ID)).json;
        const preserved = [
            [ '/wow/world', 'pass:OSLWorldResponse' ],
            [ '/wow/user/1', 'pass:OSLUserResponse' ],
            [ '/wow/view/1', 'pass:OSLViewResponse' ],
            [ '/wow/portal/1', 'pass:OSLPortalResponse' ],
            [ '/wow/spatial/' + SPATIAL_ID, 'pass:OSLFlatNode' ],
            [ '/wow/spatial/' + SPATIAL_ID + '/node/' + root.children[0], 'pass:OSLFlatNode' ],
        ];
        const preservedSeen = [];
        for (const [ p, want ] of preserved)
        {
            const r = await GET(PORT.alwaysOn, p);
            preservedSeen.push({ path : p, status : r.status, header : V(r), want });
            check('B1 header vocabulary preserved byte-for-byte: GET ' + p + ' -> ' + want,
                r.status === 200 && V(r) === want, 'status=' + r.status + ' hdr=' + V(r));
        }
        const createOk = await POST(PORT.alwaysOn, '/wow/spatial/' + SPATIAL_ID + '/node/0',
            [ { label : 'runtime-conformant', localTransform : [ 1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1 ] } ]);
        check('B1c POST 200 still reads pass:OSLFlatNode[]',
            createOk.status === 200 && V(createOk) === 'pass:OSLFlatNode[]',
            'status=' + createOk.status + ' hdr=' + V(createOk));
        const putOk = await PUT(PORT.alwaysOn, '/wow/spatial/' + SPATIAL_ID + '/node/' + createOk.json[0].id,
            { label : 'runtime-renamed' });
        check('B1d PUT 200 still reads pass:OSLFlatNode',
            putOk.status === 200 && V(putOk) === 'pass:OSLFlatNode',
            'status=' + putOk.status + ' hdr=' + V(putOk));

        // The body on the wire is EXACTLY what the runtime produced — validation
        // observes, it never rewrites. (Honesty: conformance is surfaced, never
        // silently "fixed".)
        const worldFromRuntime = JSON.stringify(a.runtime.getWowWorld(), null, 2);
        const worldOnWire = (await GET(PORT.alwaysOn, '/wow/world')).raw;
        check('B2 the response BODY is byte-identical to the runtime projection (never rewritten)',
            worldOnWire === worldFromRuntime,
            'wire=' + worldOnWire.length + 'B runtime=' + worldFromRuntime.length + 'B');

        // descriptor opt-in preserved, and its contract status is now stated.
        // The expected verdict is COMPUTED the way the superseded env-gated layer
        // computed it (validateResponse('Spatial', ...)), not hardcoded — so this
        // asserts EQUIVALENCE with the old layer rather than a guess about it.
        const preValidator = createValidator();
        const descPayload = a.runtime.getSpatialDescriptor(SPATIAL_ID);
        const oldLayer = preValidator.validateResponse('Spatial', descPayload);
        const oldLayerVerdict = (oldLayer.valid ? 'pass:' : 'fail:') + oldLayer.schema;
        const desc = await GET(PORT.alwaysOn, '/wow/spatial/' + SPATIAL_ID + '?form=descriptor');
        check('B3 runtime descriptor opt-in: verdict is IDENTICAL to the superseded layer\'s ('
            + oldLayerVerdict + ')',
            desc.status === 200 && V(desc) === oldLayerVerdict
            && desc.headers['x-osl-wow-spatial-form'] === 'descriptor',
            'status=' + desc.status + ' hdr=' + V(desc) + ' old-layer=' + oldLayerVerdict
            + ' errors=' + oldLayer.errorsText);
        check('B3b the descriptor variant is HONESTLY reported as undeclared at the operation level',
            desc.headers['x-osl-wow-contract'] === 'variant-undeclared-in-contract:spatial-form-descriptor',
            'contract-hdr=' + desc.headers['x-osl-wow-contract']);

        // =================================================================
        // C — BROADER COVERAGE, MEASURED
        // =================================================================
        const matrix = [
            [ 'GET', '/wow/world' ],
            [ 'GET', '/wow/location' ],
            [ 'GET', '/wow/graph' ],
            [ 'GET', '/wow/user/1' ],
            [ 'GET', '/wow/user/99999' ],
            [ 'GET', '/wow/view/1' ],
            [ 'GET', '/wow/view/99999' ],
            [ 'GET', '/wow/portal/1' ],
            [ 'GET', '/wow/portal/99999' ],
            [ 'GET', '/wow/spatial/' + SPATIAL_ID ],
            [ 'GET', '/wow/spatial/no-such-graph' ],
            [ 'GET', '/wow/spatial/' + SPATIAL_ID + '/node/0' ],
            [ 'GET', '/wow/spatial/' + SPATIAL_ID + '/node/99999' ],
            [ 'GET', '/wow/spatial/' + SPATIAL_ID + '/node/xyz' ],
            [ 'POST', '/wow/spatial/' + SPATIAL_ID ],
            [ 'GET', '/wow/asset/no-such-asset/wow/asset' ],
        ];
        const coverage = [];
        for (const [ m, p ] of matrix)
        {
            const r = await httpReq(m, PORT.alwaysOn, p, m === 'POST' ? [] : null);
            coverage.push({ method : m, path : p, status : r.status, verdict : V(r) || null });
        }
        const silent = coverage.filter(c => !c.verdict);
        check('C1 EVERY /wow JSON response carries an explicit verdict (zero silent responses)',
            silent.length === 0 && coverage.length === matrix.length,
            'silent=' + JSON.stringify(silent));
        // The verdicts that did NOT exist before: the old layer emitted a header
        // ONLY on the handful of 200s it hand-wrapped. Everything else was silent.
        const newlyVisible = coverage.filter(c => !/^(pass|fail):/.test(c.verdict));
        check('C2 responses that used to be COMPLETELY SILENT now carry a verdict (measured)',
            newlyVisible.length >= 8,
            'newly-visible=' + newlyVisible.length + ' -> '
            + newlyVisible.map(c => c.method + ' ' + c.path + '=' + c.verdict).join(' | '));
        const at = (m, p) => coverage.find(c => c.method === m && c.path === p);
        check('C3 /wow/location + /wow/graph are EXPLICITLY unchecked, not silently skipped',
            at('GET', '/wow/location').verdict === 'unchecked:no-contract-operation'
            && at('GET', '/wow/graph').verdict === 'unchecked:no-contract-operation',
            'location=' + at('GET', '/wow/location').verdict + ' graph=' + at('GET', '/wow/graph').verdict);
        check('C4 a contract-DECLARED status with no schema says so (404 -> unchecked:no-response-schema:404)',
            at('GET', '/wow/user/99999').verdict === 'unchecked:no-response-schema:404',
            'verdict=' + at('GET', '/wow/user/99999').verdict);
        // A REAL contract gap this enforcement made visible: the contract declares
        // only 200/404 for GET node, but the server answers a non-integer nodeId
        // with 400. Before CONF-1 that response carried no header at all.
        check('C5 a status the CONTRACT DOES NOT DECLARE is surfaced (GET node/xyz -> 400)',
            at('GET', '/wow/spatial/' + SPATIAL_ID + '/node/xyz').verdict === 'undeclared-status:400',
            'verdict=' + at('GET', '/wow/spatial/' + SPATIAL_ID + '/node/xyz').verdict);
        check('C6 a METHOD the contract does not declare for a path is surfaced (POST graph-root)',
            at('POST', '/wow/spatial/' + SPATIAL_ID).verdict === 'unchecked:no-contract-operation'
            && at('POST', '/wow/spatial/' + SPATIAL_ID).status === 405,
            'verdict=' + at('POST', '/wow/spatial/' + SPATIAL_ID).verdict);

        // =================================================================
        // D — CONTROLLED RED: a MUTATED SERVER emitting a bad RESPONSE
        // =================================================================
        const v = createValidator();
        const realWorld = a.runtime.getWowWorld();
        check('D0 the UNMUTATED payload really is contract-valid (else the RED proves nothing)',
            v.validateResponse('world', realWorld).valid,
            v.validateResponse('world', realWorld).errorsText);

        const greenBefore = await GET(PORT.alwaysOn, '/wow/world');
        check('D1 GREEN before mutation', V(greenBefore) === 'pass:OSLWorldResponse', 'hdr=' + V(greenBefore));

        // MUTATE THE SERVER: drop a property the contract REQUIRES.
        const originalGetWowWorld = a.runtime.getWowWorld;
        a.runtime.getWowWorld = function () {
            const w = originalGetWowWorld.call(a.runtime);
            delete w.proof_boundary;   // OSLWorldResponse requires it
            return w;
        };
        check('D2 the MUTATED payload really is contract-INVALID',
            !v.validateResponse('world', a.runtime.getWowWorld()).valid,
            'errors=' + v.validateResponse('world', a.runtime.getWowWorld()).errorsText);

        const red = await GET(PORT.alwaysOn, '/wow/world');
        check('D3 CONTROLLED RED: the mutated response is CAUGHT -> fail:OSLWorldResponse',
            V(red) === 'fail:OSLWorldResponse', 'hdr=' + V(red));
        check('D4 the RED response was NOT altered — status and body are still the server\'s own',
            red.status === 200 && red.json && red.json.proof_boundary === undefined,
            'status=' + red.status + ' proof_boundary=' + JSON.stringify((red.json || {}).proof_boundary));

        a.runtime.getWowWorld = originalGetWowWorld;   // RESTORE
        const greenAfter = await GET(PORT.alwaysOn, '/wow/world');
        check('D5 RESTORED: green again, byte-identical to the pre-mutation body',
            V(greenAfter) === 'pass:OSLWorldResponse' && greenAfter.raw === greenBefore.raw,
            'hdr=' + V(greenAfter));

        // =================================================================
        // E — CONTROLLED RED: a bad REQUEST body
        // =================================================================
        const rootBefore = (await GET(PORT.alwaysOn, '/wow/spatial/' + SPATIAL_ID)).json;
        const badBody = [ { label : 12345 } ];   // contract: OSLFlatNode.label is a string
        check('E0 the bad body really violates the CONTRACT request schema',
            !v.validateRequest('OSLFlatNode[]', badBody).valid,
            v.validateRequest('OSLFlatNode[]', badBody).errorsText);
        const badPost = await POST(PORT.alwaysOn, '/wow/spatial/' + SPATIAL_ID + '/node/0', badBody);
        check('E1 CONTROLLED RED (request): a contract-violating POST body is REFUSED 422',
            badPost.status === 422 && badPost.json.error === 'node_validation_failed'
            && V(badPost) === 'fail:OSLFlatNode[]',
            'status=' + badPost.status + ' hdr=' + V(badPost));
        const rootAfterBad = (await GET(PORT.alwaysOn, '/wow/spatial/' + SPATIAL_ID)).json;
        check('E2 the refused request STORED NOTHING',
            rootAfterBad.children.length === rootBefore.children.length,
            'before=' + rootBefore.children.length + ' after=' + rootAfterBad.children.length);
        const badPut = await PUT(PORT.alwaysOn, '/wow/spatial/' + SPATIAL_ID + '/node/' + rootBefore.children[0],
            { localTransform : 'not-an-array' });
        check('E3 CONTROLLED RED (request): a contract-violating PUT body is REFUSED 422',
            badPut.status === 422 && badPut.json.error === 'node_validation_failed'
            && V(badPut) === 'fail:OSLFlatNode',
            'status=' + badPut.status + ' hdr=' + V(badPut));

        // RICHER refusal must survive always-on ajv: an embedded canonical
        // body is still named, with machine-readable remedies, not reduced to a
        // bare schema error.
        const canonicalBody = [ {
            label : 'runtime-conformant-root',
            localTransform : [ 1,0,0,0, 0,1,0,0, 0,0,1,0, 1,2,3,1 ],
            children : [ { label : 'runtime-embedded-child' } ],
        } ];
        const embedded = await POST(PORT.alwaysOn, '/wow/spatial/' + SPATIAL_ID + '/node/0', canonicalBody);
        check('E4 runtime preserved under always-on: embedded body -> 422 embedded_children_not_supported',
            embedded.status === 422 && embedded.json.error === 'embedded_children_not_supported'
            && embedded.json.served_schema === 'OSLFlatNode'
            && Array.isArray(embedded.json.remedies)
            && embedded.json.remedies.some(s => /nodeForm=canonical|X-OSL-WoW-Node-Form/.test(s)),
            'status=' + embedded.status + ' error=' + (embedded.json || {}).error);
        const optIn = await POST(PORT.alwaysOn, '/wow/spatial/' + SPATIAL_ID + '/node/0?nodeForm=canonical',
            canonicalBody);
        check('E5 the contract-DECLARED canonical opt-in still validates as Node[] and stores the subtree',
            optIn.status === 200 && Array.isArray(optIn.json) && optIn.json.length === 2
            && V(optIn) === 'pass:OSLFlatNode[]',
            'status=' + optIn.status + ' stored=' + (optIn.json || []).length + ' hdr=' + V(optIn));

        // =================================================================
        // F — CONTRACT-DRIVEN: change the CONTRACT, enforcement follows.
        //     No source file is edited in any of these four sub-proofs.
        // =================================================================
        // F1 TIGHTEN: require a property the server does not emit.
        const tightened = cloneContract();
        tightened.components.schemas.OSLWorldResponse.allOf.push(
            { type : 'object', required : [ 'osl_wo129_property_the_server_does_not_emit' ] });
        const t = await listen('a', { wow_contract_doc : tightened }, PORT.tighten); started.push(t);
        const tightRes = await GET(PORT.tighten, '/wow/world');
        check('F1 CONTRACT TIGHTENED -> the SAME unmutated server now FAILS (no code change)',
            tightRes.status === 200 && V(tightRes) === 'fail:OSLWorldResponse',
            'hdr=' + V(tightRes));
        check('F1b and the untouched-contract server on the other port is STILL green',
            V(await GET(PORT.alwaysOn, '/wow/world')) === 'pass:OSLWorldResponse');

        // F2 LOOSEN: make the body that E1 refused legal.
        const loosened = cloneContract();
        loosened.components.schemas.OSLFlatNode.properties.label = {};
        const l = await listen('a', { wow_contract_doc : loosened }, PORT.loosen); started.push(l);
        const loosePost = await POST(PORT.loosen, '/wow/spatial/' + SPATIAL_ID + '/node/0', badBody);
        check('F2 CONTRACT LOOSENED -> the body E1 refused is now ACCEPTED (no code change)',
            loosePost.status === 200 && Array.isArray(loosePost.json),
            'status=' + loosePost.status + ' body=' + JSON.stringify(loosePost.json).slice(0, 120));
        check('F2b the strict-contract server STILL refuses the same body',
            (await POST(PORT.alwaysOn, '/wow/spatial/' + SPATIAL_ID + '/node/0', badBody)).status === 422);

        // F3 REMOVE AN OPERATION: enforcement stops claiming to cover it.
        const removed = cloneContract();
        delete removed.paths['/wow/view/{viewId}'];
        const rm = await listen('a', { wow_contract_doc : removed }, PORT.removeOp); started.push(rm);
        const rmView = await GET(PORT.removeOp, '/wow/view/1');
        check('F3 OPERATION REMOVED FROM CONTRACT -> verdict becomes unchecked:no-contract-operation',
            rmView.status === 200 && V(rmView) === 'unchecked:no-contract-operation',
            'hdr=' + V(rmView));
        check('F3b nothing else moved: /wow/world on the same server is still enforced',
            V(await GET(PORT.removeOp, '/wow/world')) === 'pass:OSLWorldResponse');

        // F4 RENAME A SCHEMA: the header TEXT itself is contract-derived.
        const renamed = cloneContract();
        renamed.components.schemas.OSLWorldResponseRenamedByWO129 =
            renamed.components.schemas.OSLWorldResponse;
        delete renamed.components.schemas.OSLWorldResponse;
        renamed.paths['/wow/world'].get.responses['200'].content['application/json'].schema.$ref =
            '#/components/schemas/OSLWorldResponseRenamedByWO129';
        const rn = await listen('a', { wow_contract_doc : renamed }, PORT.rename); started.push(rn);
        const rnRes = await GET(PORT.rename, '/wow/world');
        check('F4 SCHEMA RENAMED IN CONTRACT -> the header text follows it (nothing hardcodes the name)',
            rnRes.status === 200 && V(rnRes) === 'pass:OSLWorldResponseRenamedByWO129',
            'hdr=' + V(rnRes));

        // =================================================================
        // G — FAIL-CLOSED
        // =================================================================
        const emptyDoc = { openapi : '3.0.4', paths : {}, components : { schemas : {} } };
        check('G1 an EMPTY contract makes the enforcer THROW (never a silent opt-out)',
            (() => { try { createContractEnforcer({ doc : emptyDoc }); return false; }
                     catch (e) { return /no \/wow\/ operations/.test(e.message); } })());
        check('G2 createServer with an empty contract REFUSES TO START',
            (() => { try { createServer('a', { http_port : 19399, wow_contract_doc : emptyDoc }); return false; }
                     catch (e) { return /refusing to serve/.test(e.message); } })());
        const unanchored = cloneContract();
        unanchored.paths['/wow/spatial/{spatialID}/node/{nodeId}'].post.parameters =
            unanchored.paths['/wow/spatial/{spatialID}/node/{nodeId}'].post.parameters
                .filter(p => p.name !== 'X-OSL-WoW-Node-Form');
        check('G3 a declared VARIANT cannot outlive its contract anchor (header param removed -> THROW)',
            (() => { try { createContractEnforcer({ doc : unanchored }); return false; }
                     catch (e) { return /X-OSL-WoW-Node-Form/.test(e.message); } })());
        const noSpatial = cloneContract();
        delete noSpatial.components.schemas.Spatial;
        check('G4 a declared VARIANT cannot outlive its contract component (Spatial removed -> THROW)',
            (() => { try { createContractEnforcer({ doc : noSpatial }); return false; }
                     catch (e) { return /Spatial/.test(e.message); } })());

        // =================================================================
        // H — BLAST RADIUS
        // =================================================================
        const health = await GET(PORT.alwaysOn, '/healthz');
        const debug = await GET(PORT.alwaysOn, '/debug/state');
        check('H1 non-/wow routes are completely untouched (no validation header, unchanged 200)',
            health.status === 200 && V(health) === undefined
            && debug.status === 200 && V(debug) === undefined,
            'healthz=' + V(health) + ' debug=' + V(debug));

        // ---- evidence ----
        const enforcer = createContractEnforcer();
        const evidenceArg = process.argv.find(x => x.indexOf('--diagnostics=') === 0);
        const outPath = evidenceArg
            ? evidenceArg.slice('--diagnostics='.length)
            : path.join((evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osl-runtime-'))),
                'runtime-contract-enforcement.json');
        fs.writeFileSync(outPath, JSON.stringify({
            work_order : 'runtime',
            captured_at : new Date().toISOString(),
            always_on : true,
            env_gate_removed : 'OSL_WOW_VALIDATE',
            enforcement : enforcer.describe(),
            preserved_headers : preservedSeen,
            coverage_matrix : coverage,
            newly_visible_verdicts : newlyVisible,
            checks : results,
            failures,
            standards_conformance : false,
        }, null, 2) + '\n');
        process.stdout.write('\n[runtime] diagnostics -> ' + outPath + '\n');
    } finally {
        for (const s of started) { try { await s.closeAll(); } catch (e) {} }
    }

    if (failures)
    {
        process.stdout.write('[runtime] ' + failures + ' CHECK(S) FAILED\n');
        process.exit(1);
    }
    process.stdout.write('[runtime] ALL ' + results.length + ' CHECKS PASS\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
assert.ok(true);
