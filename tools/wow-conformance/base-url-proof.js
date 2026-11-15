'use strict';

/*
 * tools/wow-conformance/base-url-proof.js — `npm run proof:corpus`.
 *
 * The conformance corpus runs against any Web of Worlds server named by a base URL
 * (`run.js --base <url>`). This proof shows that it does, and that it can fail:
 *
 *   1. it starts one Lab world in this process, on an isolated high port (never a port run.js protects), at a
 *      path prefix, with the identity handshake, a preview and placement writes on, so that every part of the
 *      wire suite has something to run against;
 *   2. it runs `run.js --base <that world's base URL> --writes --lab-crossing` in a child process: it must exit 0,
 *      say that it booted nothing, report every collected wire check as PASS (a skip is not a pass), and leave
 *      the Lab's own evidence file (diagnostics/wow-conformance.json) as it was;
 *   3. it runs the same command against planted-fault worlds, one at a time (each an exact edit of the real
 *      server source): a depart that leaves the user present, and a crossing that sends no portal_activate.
 *      Each run must exit 1 and name the check that failed;
 *   4. it shuts every world down.
 *
 * Exit: 0 when every step holds, 1 otherwise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUN = path.join(__dirname, 'run.js');
const PROTECTED_PORTS = new Set([ 8143, 18151, 18152, 18153, 3000, 18991 ]); // run.js's protected ports, and its own default
const PORT = Number(process.env.OSL_WOW_CORPUS_PORT || 18993);
const PREFIX = '/w/b';
const BASE = 'http://127.0.0.1:' + PORT + PREFIX;
const EVIDENCE = path.join(REPO_ROOT, 'diagnostics', 'wow-conformance.json');

/** The wire checks the corpus collects, by the id run.js prints. */
const WIRE_CHECKS = [ 'i1:U3', 'i2:O2', 'i3:W2', 'i4:W2', 'i4:P10', 'i5:W2', 'i5:SE2' ];
/**
 * The verdict each must get against the Lab world. i4:P10 is PARTIAL, never PASS: the corpus is no client and does
 * not navigate, so "before navigation" is not measured, and the run must name that one skip and no other.
 */
const EXPECTED = { 'i4:P10': 'PARTIAL' };
const P10_SKIP = /skipped \(not a pass\): before navigation: /;

/** The world's configuration: the handshake (it accepts joins), a room with a preview of both forms. */
const CONFIG = {
    base_path: PREFIX,
    handshake: {
        base: BASE + '/',
        label: 'Corpus world',
        claims: [ { name: 'avatar', required: true }, { name: 'preferences', required: true }, { name: 'display_name', required: false } ],
        issues: [],
    },
    room: { size_m: [ 12, 12 ] },
    preview: { node_label: 'Room view', radius_m: 6, image: 'preview.png' },
};

/** Planted faults: exact edits of the server source, as the arch-i5 SE2 and arch-i4 P10 planted faults make them. */
const FAULTS = [
    { name: 'a depart that leaves the user present', edits: { 'runtime-handshake.js': [ [ '        users.delete(key);\n', '' ] ] }, failed: 'i5:SE2' },
    { name: 'a crossing that sends no portal_activate', edits: { 'runtime-handoff.js': [ [ '        this.emitPortalActivate(wowId, playerId);\n', '' ] ] }, failed: 'i4:P10' },
];

const results = [];
function step(name, ok, detail)
{
    results.push({ name, ok });
    console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
}

const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);

/** Start one Lab world (real, or with planted-fault edits) on PORT. */
async function startWorld(edits)
{
    const { boot } = require(path.join(REPO_ROOT, 'tools', 'arch-i1', 'harness'));
    return boot('b', PORT, { edits: edits || null, config: JSON.parse(JSON.stringify(CONFIG)) });
}

/** Run run.js against BASE in a child process; returns { code, out }. */
function runCorpus(outFile)
{
    return new Promise((resolve) => {
        const args = [ RUN, '--base', BASE, '--writes', '--lab-crossing', '--out', outFile ];
        console.log('  $ node ' + path.relative(REPO_ROOT, RUN) + ' ' + args.slice(1).join(' '));
        const child = spawn(process.execPath, args, { cwd: REPO_ROOT, env: process.env, stdio: [ 'ignore', 'pipe', 'pipe' ] });
        let out = '';
        const take = (chunk) => { out += chunk; for (const l of String(chunk).split('\n')) if (l) process.stdout.write('  | ' + l + '\n'); };
        child.stdout.on('data', take);
        child.stderr.on('data', take);
        const timer = setTimeout(() => { out += '\n(base-url-proof: run.js timed out after 240 s)\n'; child.kill(); }, 240000);
        child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
}

/** The wire-suite verdict run.js printed for one check id: PASS, FAIL, PARTIAL, SKIP or null. */
function verdictOf(out, id)
{
    const m = new RegExp('^\\s*(PASS|FAIL|PARTIAL|SKIP)\\s+' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'm').exec(out);
    return m ? m[1] : null;
}

async function main()
{
    if (PROTECTED_PORTS.has(PORT)) { console.error('REFUSING protected port ' + PORT); process.exit(2); }
    // The world is this proof's own, on 127.0.0.1, with a throwaway graph: node writes are on (read per request).
    process.env.OSL_PLACEMENT_WRITES = '1';
    console.log('1-minute load (information only): ' + os.loadavg()[0].toFixed(2));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osl-wow-corpus-'));
    const evidenceBefore = sha(EVIDENCE);

    // ---- 2. a Lab world: the corpus passes ---------------------------------------------------------
    console.log('\n== the corpus against a Lab world at ' + BASE + ' ==');
    let world = await startWorld(null);
    let good;
    try { good = await runCorpus(path.join(tmp, 'good.json')); }
    finally { await world.close(); world = null; }
    step('run.js --base accepts the base URL and boots nothing', /^target: /m.test(good.out) && /nothing booted/.test(good.out),
        /^target: /m.test(good.out) ? null : 'no "target:" line: --base is not accepted');
    step('run.js --base against a Lab world exits 0', good.code === 0, 'exit ' + good.code);
    const verdicts = WIRE_CHECKS.map((id) => [ id, verdictOf(good.out, id) ]);
    const skips = (good.out.match(/skipped \(not a pass\): .*/g) || []);
    step('every collected wire check ran and passed, except the one part a non-client cannot measure (a skip is not a pass)',
        verdicts.every(([id, v]) => v === (EXPECTED[id] || 'PASS')) && skips.length === 1 && P10_SKIP.test(skips[0]),
        verdicts.map(([id, v]) => id + ' ' + (v || 'not reported')).join(', ') + '; skipped parts: ' + (skips.length ? skips.join(' | ') : 'none'));
    step('the --out evidence was written, and the Lab evidence file is unchanged', fs.existsSync(path.join(tmp, 'good.json')) && sha(EVIDENCE) === evidenceBefore,
        'diagnostics/wow-conformance.json ' + (sha(EVIDENCE) === evidenceBefore ? 'unchanged' : 'CHANGED'));

    // ---- 3. planted-fault worlds: the corpus fails and names the check -----------------------------
    for (const fault of FAULTS) {
        console.log('\n== the corpus against a planted fault: ' + fault.name + ' ==');
        world = await startWorld(fault.edits);
        let bad;
        try { bad = await runCorpus(path.join(tmp, 'fault.json')); }
        finally { await world.close(); world = null; }
        const v = verdictOf(bad.out, fault.failed);
        step('planted fault (' + fault.name + '): run.js exits 1 and names ' + fault.failed + ' as failed', bad.code === 1 && v === 'FAIL',
            'exit ' + bad.code + ', ' + fault.failed + ' ' + (v || 'not reported'));
    }
    step('the Lab evidence file is unchanged after every run', sha(EVIDENCE) === evidenceBefore);

    fs.rmSync(tmp, { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' proof steps pass'
        + (failed.length ? '; FAILED: ' + failed.map((r) => r.name).join('; ') : ''));
    process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('base-url-proof crashed:', err); process.exit(1); });
