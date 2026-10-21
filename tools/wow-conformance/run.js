'use strict';

/*
 * tools/wow-conformance/run.js — (Lane F). CLI wrapper.
 *
 * Standalone "WoW conformance" check AND a gate battery can require.
 * It:
 *   - runs the contract-first FIXTURE pass always (no server needed);
 *   - when driving the LIVE server: load-gates (1-min load < 14, standing
 *     hygiene rule), boots 041 on an ISOLATED high port (default 18991 — NEVER
 *     8143 / 18151-18153 / :3000), hits every WoW endpoint, validates the real
 *     responses against the wow-spec surface, and honestly marks
 *     contract-only / not-yet-implemented endpoints;
 *   - surfaces every labeled non-canonical extension (no cosmetic green);
 *   - writes evidence to evidence/wow-conformance.json and exits non-zero on any
 *     real conformance failure (contract-only 404s do NOT fail the run).
 *
 * THIS HARNESS USED TO LIE ABOUT ITSELF.
 *   Under load >= 14 it silently downgraded to fixtures-only, wrote that thin result
 *   OVER a fixtures+live evidence file, and exited 0. A degraded run was byte-for-byte
 *   indistinguishable from a full one to anybody reading the exit code, and the richer
 *   evidence it destroyed was uncommitted, so the loss was unrecoverable. Now:
 *     - a load-gated run is DEFERRED, not passed: assertions.ok=false, exit 3;
 *     - a NARROWER run may not overwrite a RICHER one — the write is REFUSED, the good
 *       file is preserved, and the degraded run goes to *.degraded.json (exit 4);
 *     - the evidence records its mode, the load it ran at, and an explicit
 *       `coverage.not_covered` list, so coverage can be told from completeness.
 *
 * Usage:
 *   node tools/wow-conformance/run.js                # fixtures + live (load-gated)
 *   node tools/wow-conformance/run.js --fixtures-only  # contract-first only, no server
 *   OSL_WOW_CONFORMANCE_PORT=19001 node tools/wow-conformance/run.js
 *
 * Exit: 0=pass 1=conformance FAIL 2=crash/protected-port 3=DEFERRED 4=WRITE REFUSED
 *
 * ADDITIVE / REUSE-OVER-REBUILD: consumes wow-spec/validate.js and
 * runtime/041 createServer as-is. Does not modify server, client, or spec.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOST = '127.0.0.1';
const DEFAULT_PORT = 18991; // isolated; roundtrip.js uses 18971, live demo uses 18151-18153
const FORBIDDEN_PORTS = new Set([ 8143, 18151, 18152, 18153, 3000 ]);

const { runWowConformance } = require('./conformance');
const { createValidator } = require(path.join(REPO_ROOT, 'wow-spec', 'validate'));

function parseArgs(argv)
{
    const a = { fixturesOnly: false };
    for (const arg of argv.slice(2)) {
        if (arg === '--fixtures-only' || arg === '--fixtures') a.fixturesOnly = true;
        else if (arg === '--live') a.fixturesOnly = false;
    }
    return a;
}

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

// ---- coverage rank + refuse-to-clobber ----------------
// A run that saw LESS must never overwrite the evidence of a run that saw MORE.
// Ranked so the comparison is explicit rather than an ad-hoc string test.
const COVERAGE_RANK = { 'fixtures-only': 1, 'fixtures+live': 2 };
function coverageRank(mode) { return COVERAGE_RANK[mode] || 0; }

// Exit codes (mirrors src/e2e-driver.mjs, the repo's canonical deferral idiom):
//   0 = ran, assertions pass, got the coverage that was asked for
//   1 = a REAL conformance failure
//   2 = crash / refused a protected port
//   3 = DEFERRED — live coverage was requested but the load gate blocked it
//   4 = EVIDENCE WRITE REFUSED — this run is NARROWER than the evidence on disk
const EXIT = { OK: 0, FAIL: 1, CRASH: 2, DEFERRED: 3, WRITE_REFUSED: 4 };

/*
 * The evidence write, guarded.
 *
 * WHY REFUSE RATHER THAN MERGE: merging a fresh fixtures-only run into an existing
 * fixtures+live file would stamp a NEW captured_at on a STALE live section — which is
 * precisely the lie this repo has been closing all week (a fresh timestamp vouching for
 * an observation that this run did not make). A reader would reasonably believe the live
 * section had just been observed. So a narrower run does not get to touch the canonical
 * path at all: the rich file survives byte-for-byte, and the degraded run is still
 * written — loudly, to its own path — so the run is never invisible either.
 */
function writeEvidenceGuarded(evPath, manifest)
{
    const newRank = coverageRank(manifest.mode);

    let prior = null;
    try { prior = JSON.parse(fs.readFileSync(evPath, 'utf8')); }
    catch (e) { prior = null; } // absent or corrupt -> nothing richer to protect
    const priorRank = prior ? coverageRank(prior.mode) : 0;

    if (prior && newRank < priorRank) {
        const degradedPath = evPath.replace(/\.json$/, '') + '.degraded.json';
        manifest.evidence_write = {
            canonical_path_refused: path.relative(REPO_ROOT, evPath),
            written_to: path.relative(REPO_ROOT, degradedPath),
            reason: 'REFUSED to overwrite richer diagnostics: this run is "' + manifest.mode
                + '" (rank ' + newRank + '); the file on disk is "' + prior.mode + '" (rank '
                + priorRank + ', captured_at ' + (prior.captured_at || 'unknown') + ').',
            preserved_prior_mode: prior.mode,
            preserved_prior_captured_at: prior.captured_at || null,
        };
        fs.writeFileSync(degradedPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        return { written: degradedPath, refusedCanonical: true, prior };
    }

    manifest.evidence_write = {
        written_to: path.relative(REPO_ROOT, evPath),
        replaced_mode: prior ? prior.mode : null,
        reason: prior
            ? 'Coverage did not decrease (' + (prior.mode || 'unknown') + ' -> ' + manifest.mode + ').'
            : 'No prior diagnostics on disk.',
    };
    fs.writeFileSync(evPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return { written: evPath, refusedCanonical: false, prior };
}

function printReport(report)
{
    const w = process.stdout;
    w.write('\n=== WoW conformance (' + report.mode + ') ===\n');
    const sym = {
        conformant: 'PASS        ', 'contract-only': 'CONTRACT-ONLY',
        'conformant-with-declared-divergence': 'PASS+DIVERGE',
        'not-implemented': 'NOT-IMPL    ', fail: 'FAIL        ', gap: 'GAP         ',
        error: 'ERROR       ', 'fixture-only': 'FIXTURE-OK  ',
    };
    for (const ep of report.endpoints) {
        const fix = ep.fixture ? (ep.fixture.valid ? 'fixture:ok' : 'fixture:FAIL') : 'fixture:-';
        w.write('  ' + pad(sym[ep.status] || ep.status, 14) + pad(ep.method, 5)
            + pad(ep.path, 34) + fix
            + (ep.live && ep.live.http_status ? '  http=' + ep.live.http_status : '')
            + (ep.live && ep.live.validation_header ? '  hdr=' + ep.live.validation_header : '')
            + '\n');
        if (ep.reason && (ep.status === 'contract-only' || ep.status === 'not-implemented'
            || ep.status === 'fail' || ep.status === 'gap' || ep.status === 'error'
            || ep.status === 'conformant-with-declared-divergence'))
            w.write('                ' + ep.reason + '\n');
        for (const d of ep.drift || []) w.write('                drift: ' + d + '\n');
        for (const d of ep.divergences || []) w.write('                DECLARED DIVERGENCE: ' + d + '\n');
    }

    // The divergences OSL DECLARES against the standard. Printed loudly, because a
    // reader must never mistake "PASS" here for "conforms to OpenSpatialWorld".
    if (report.declared_divergences && report.declared_divergences.length) {
        w.write('\nDECLARED divergences from the OpenSpatialWorld standard (labeled, never hidden):\n');
        for (const d of report.declared_divergences)
            w.write('  - ' + pad(d.id, 4) + pad(d.subject, 34) + d.status + '\n'
                + '        standard: ' + d.standard + '\n'
                + '        OSL:      ' + d.osl + '\n');
    }

    w.write('\nlabeled extensions in use (surfaced, honest):\n');
    if (!report.extensions_in_use.length) w.write('  (none observed)\n');
    for (const e of report.extensions_in_use)
        w.write('  - ' + pad(e.field, 24) + '-> ' + pad(e.schema, 26) + ' [' + e.endpoints.join(', ') + ']\n');

    w.write('\ngaps (contract-only / not-yet-implemented — NOT run failures):\n');
    if (!report.gaps.length) w.write('  (none)\n');
    for (const g of report.gaps)
        w.write('  - ' + pad(g.status, 16) + pad(g.method + ' ' + g.path, 34)
            + (g.tracked_by ? '(' + g.tracked_by + ')' : '') + '\n');

    w.write('\nguard self-tests (prove the checks are real, not cosmetic): '
        + (report.self_tests.ok ? 'ALL CAUGHT' : 'FAILED') + '\n');
    for (const c of report.self_tests.checks)
        w.write('  ' + (c.caught ? '[caught] ' : '[MISSED] ') + c.name + '\n');

    w.write('\nnot claimed (honesty boundary):\n');
    for (const n of report.not_claimed) w.write('  - ' + n + '\n');
}

async function bootAndRun(port)
{
    // Exercise the wired server validation path too (observability header parity
    // with wow-spec/proof). The response body is never altered by this flag.
    if (!process.env.OSL_WOW_VALIDATE) process.env.OSL_WOW_VALIDATE = '1';
    const { createServer } = require(
        path.join(REPO_ROOT, 'runtime', 'world-server', 'src', 'server'));
    const validator = createValidator();
    const built = createServer('a', { http_port: port });
    await new Promise((resolve) => built.server.listen(port, HOST, resolve));
    try {
        return await runWowConformance({ baseUrl: 'http://' + HOST + ':' + port, validator });
    } finally {
        await built.closeAll();
    }
}

async function main()
{
    const args = parseArgs(process.argv);
    const port = Number(process.env.OSL_WOW_CONFORMANCE_PORT || DEFAULT_PORT);

    const loadGate = Number(process.env.OSL_WOW_LOAD_GATE || 14);
    const load1 = os.loadavg()[0];
    const liveRequested = !args.fixturesOnly;

    let report;
    let deferred = null;   // set ONLY when live coverage was asked for and NOT obtained

    if (args.fixturesOnly) {
        // EXPLICIT fixtures-only: the caller asked for a narrow run and gets exactly
        // that. Honest, so it may exit 0 — but it still may not clobber a richer file.
        report = await runWowConformance({ validator: createValidator() });
    } else {
        if (FORBIDDEN_PORTS.has(port)) {
            console.error('REFUSING to run on protected port ' + port
                + ' (live demo / simpleWorlds). Set OSL_WOW_CONFORMANCE_PORT to an isolated high port.');
            process.exit(EXIT.CRASH);
        }
        // Load-gate the LIVE pass (standing hygiene rule: 1-min load < 14).
        console.log('1-min load average: ' + load1.toFixed(2) + ' (gate: < ' + loadGate + ')');
        if (load1 >= loadGate) {
            // this is a DEFERRAL, NOT A PASS. It used to run
            // fixtures-only, write that over the live evidence, and exit 0 — a green,
            // narrower file that no reader could distinguish from a full run. Now the
            // fixtures pass still runs (so the run is not wasted and the contract is
            // still checked), but the run is marked DEFERRED, cannot claim the canonical
            // evidence path over a richer file, and exits 3.
            deferred = {
                reason: 'live pass NOT RUN: 1-min load ' + load1.toFixed(2) + ' >= gate ' + loadGate,
                load_at_run: Number(load1.toFixed(2)),
                load_gate: loadGate,
                remedy: 're-run `npm run wow-conformance` when 1-min load < ' + loadGate
                    + ' to obtain live coverage',
            };
            report = await runWowConformance({ validator: createValidator() });
        } else {
            report = await bootAndRun(port);
            report.proof_port = port;
        }
    }

    // ---- e2e-driver manifest idiom: assertions.{ok,problems} + evidence ----
    const manifest = Object.assign({
        version_id: 'runtime',
        components: 'components F — WoW conformance (continuous)',
        title: 'Spec-first WoW conformance + contract tests',
        note: 'Validates OSL WoW responses (+ node request bodies) against the OpenSpatialWorld '
            + 'schema via the runtime wow-spec ajv surface. Surfaces every labeled non-canonical '
            + 'extension (no cosmetic green); contract-only endpoints reported as such. '
            + 'standards_conformance:false; native_teleportxr_teleport:false; '
            + 'first_party_teleportxr_browser_rendering:false. '
            + 'The /wow/spatial/* node payloads are the LABELED, non-canonical OSLFlatNode '
            + '(integer id-ref children), NOT the canonical Node (which embeds child objects) — '
            + 'a DECLARED divergence, reported per-endpoint as canonical_node_valid:false. '
            + 'See declared_divergences.',
        provenance: 'CORRECTED 2026-07-11. The previous note here claimed '
            + '"No simpleWorlds code vendored." — too strong to be supportable, and it was written to '
            + 'discharge a licensing concern. What is TRUE: no simpleWorlds SOURCE CODE is vendored, '
            + 'but OSL\'s first transcription of the canonical `Node` (children typed `integer`) and '
            + 'five operationIds (world.getWorld, user.getUser, user.deleteUser, view.getView, '
            + 'portal.getPortal) match simpleWorlds\' STALE vendored spec copy, not the open spec — '
            + 'upstream WoWAPI has exactly ONE commit ("fixed node children type"), so no published '
            + 'upstream state ever typed children as `integer`. The `Node` typing is now corrected to '
            + 'the open spec; the operationId naming is retained (naming only). Sourcing was MIXED, not '
            + 'wholesale: OSL took /wow/spatial/{spatialID}/node/{nodeId} from the OPEN SPEC and '
            + 'deliberately rejected simpleWorlds\' /wow/scene/node divergence. LICENSING: simpleWorlds\' '
            + 'license state is self-contradictory (an Apache-2.0 LICENSE file alongside '
            + '"license":"UNLICENSED" in its package.json), so OSL treats it as DO-NOT-COPY and '
            + 'single-sources the open spec.',
    }, report);
    // the run's own honesty record. A reader (or a downstream
    // gate) can tell COVERAGE from COMPLETENESS without diffing endpoint arrays.
    manifest.run_context = {
        live_requested: liveRequested,
        live_obtained: report.coverage.live_driven,
        load_at_run: Number(load1.toFixed(2)),
        load_gate: loadGate,
        exit_semantics: '0=pass 1=conformance FAIL 2=crash/protected-port '
            + '3=DEFERRED(live requested, not obtained) 4=diagnostics WRITE REFUSED(narrower than disk)',
    };
    if (deferred) manifest.deferred_live = deferred;

    // A DEFERRED run is NOT ok: live coverage was asked for and was not obtained.
    // Its empty `problems` list means "the contract is self-consistent", never
    // "the server conforms" — so it must not be allowed to read as a pass.
    const problems = report.problems.slice();
    if (deferred) problems.push('DEFERRED: ' + deferred.reason);
    manifest.assertions = {
        ok: report.problems.length === 0 && !deferred,
        deferred: Boolean(deferred),
        // Mirrored into `assertions` on purpose: a downstream gate that reads only
        // `assertions` (as stage-readiness-proof.js did) must not be able to
        // miss that this run's coverage was narrow. `ok` alone never means "conformant".
        coverage_complete: report.coverage.complete,
        mode: report.mode,
        problems,
    };

    printReport(report);

    const evDir = path.join(REPO_ROOT, 'diagnostics');
    try { fs.mkdirSync(evDir, { recursive: true }); } catch (e) {}
    const evPath = path.join(evDir, 'wow-conformance.json');
    const write = writeEvidenceGuarded(evPath, manifest);

    const passCount = report.endpoints.filter(e => e.status === 'conformant').length;
    const divergeCount = report.endpoints.filter(e => e.status === 'conformant-with-declared-divergence').length;
    const contractOnly = report.endpoints.filter(e => e.status === 'contract-only' || e.status === 'not-implemented').length;

    // ---- COVERAGE banner: a narrowed run must NEVER look like a full one -----
    console.log('\n=== COVERAGE (what this run actually looked at) ===');
    console.log('  mode: ' + report.mode + '   live endpoints validated: '
        + report.coverage.endpoints_live_validated + '/' + report.coverage.endpoints_total);
    if (!report.coverage.complete) {
        console.error('  !! PARTIAL COVERAGE — THIS IS NOT A CONFORMANCE PASS !!');
        for (const nc of report.coverage.not_covered) console.error('     NOT COVERED: ' + nc);
    }

    console.log('\nevidence -> ' + write.written);
    if (write.refusedCanonical) {
        console.error('\n!! diagnostics WRITE REFUSED !!');
        console.error('   This run is "' + manifest.mode + '"; the diagnostics on disk is "'
            + write.prior.mode + '" (captured_at ' + (write.prior.captured_at || 'unknown') + ').');
        console.error('   A NARROWER run may not overwrite a RICHER one. The good diagnostics at '
            + path.relative(REPO_ROOT, evPath) + ' is PRESERVED, untouched.');
        console.error('   This degraded run was written to ' + path.relative(REPO_ROOT, write.written)
            + ' instead, so it is recorded but cannot masquerade as full coverage.');
    }
    console.log('endpoints: ' + report.endpoints.length + '  conformant: ' + passCount
        + '  valid-but-DECLARED-DIVERGENT: ' + divergeCount
        + '  contract-only/not-impl: ' + contractOnly + '  extensions-in-use: ' + report.extensions_in_use.length);
    if (divergeCount)
        console.log('NOTE: ' + divergeCount + ' endpoint(s) validate against the LABELED OSLFlatNode, '
            + 'NOT the canonical Node. standards_conformance stays FALSE.');

    let exitCode = EXIT.OK;
    if (report.problems.length) exitCode = EXIT.FAIL;
    else if (deferred) exitCode = EXIT.DEFERRED;
    else if (write.refusedCanonical) exitCode = EXIT.WRITE_REFUSED;

    if (deferred) {
        console.error('\nWoW CONFORMANCE DEFERRED (exit 3): ' + deferred.reason);
        console.error(deferred.remedy);
    }
    console.log('\nassertions: ' + (manifest.assertions.ok ? 'ALL PASS'
        : deferred ? 'DEFERRED (NOT A PASS) -> ' + problems.join('; ')
        : 'FAIL -> ' + problems.join('; ')));
    console.log('exit: ' + exitCode);

    process.exit(exitCode);
}

if (require.main === module)
    main().catch(err => { console.error('wow-conformance crashed:', err); process.exit(2); });

module.exports = { main, bootAndRun };
