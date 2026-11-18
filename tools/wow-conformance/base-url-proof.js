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
 *   4. iteration 5 is opt-in: it starts one Lab world with no join setup (no handshake config) and runs
 *      `run.js --base <it>`: it must exit 0, and report i5:W2 and i5:SE2 each as N/A (not applicable, never FAIL,
 *      never PASS) with the reason NA_REASON, and i6:G1 as N/A with the reason I6_NA_REASON (iteration 6 is opt-in
 *      too: the world serves no protected resource metadata); the "not applicable:" lines are exactly these three,
 *      by check id. Planted fault: a corpus that marks such a world failed (the gate on
 *      World.identity removed from tools/wow-conformance/wire-checks.js by an exact edit, loaded through a
 *      --require hook in the child only): run.js must then exit 1 and name i5:W2 as failed;
 *   5. it shuts every world down.
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
/** The checks of iteration 5, and the reason the corpus must give for each on a world that states no identity. */
const I5_CHECKS = [ 'i5:W2', 'i5:SE2' ];
const NA_REASON = 'the World states no identity: iteration 5 joining is opt-in';
/** The check of iteration 6 the corpus runs, and its reason on a world that serves no protected resource metadata. */
const I6_CHECKS = [ 'i6:G1' ];
const I6_NA_REASON = 'the world serves no protected resource metadata: iteration 6 authorization is opt-in';
/** The same world with no join setup: no handshake config, so the World states no identity. */
const NO_JOIN_CONFIG = { base_path: PREFIX };
/** Planted fault in the corpus itself: the iteration-5 gate removed, so every world runs the i5 checks (S17's behaviour). */
const CORPUS_FAULT = { file: 'wire-checks.js', from: "const iteration5 = world.identity !== undefined && world.identity !== null;", to: 'const iteration5 = true;' };

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
async function startWorld(edits, config)
{
    const { boot } = require(path.join(REPO_ROOT, 'tools', 'arch-i1', 'harness'));
    return boot('b', PORT, { edits: edits || null, config: JSON.parse(JSON.stringify(config || CONFIG)) });
}

/**
 * Run run.js against BASE in a child process; returns { code, out }. opts.args replaces the default arguments after
 * --base; opts.preload is a module the child loads first (node --require).
 */
function runCorpus(outFile, opts)
{
    opts = opts || {};
    return new Promise((resolve) => {
        const args = [ RUN, '--base', BASE ].concat(opts.args || [ '--writes', '--lab-crossing', '--out', outFile ]);
        console.log('  $ node ' + path.relative(REPO_ROOT, RUN) + ' ' + args.slice(1).join(' ') + (opts.preload ? '   (child preloads the planted fault)' : ''));
        const child = spawn(process.execPath, (opts.preload ? [ '--require', opts.preload ] : []).concat(args), { cwd: REPO_ROOT, env: process.env, stdio: [ 'ignore', 'pipe', 'pipe' ] });
        let out = '';
        const take = (chunk) => { out += chunk; for (const l of String(chunk).split('\n')) if (l) process.stdout.write('  | ' + l + '\n'); };
        child.stdout.on('data', take);
        child.stderr.on('data', take);
        const timer = setTimeout(() => { out += '\n(base-url-proof: run.js timed out after 240 s)\n'; child.kill(); }, 240000);
        child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
    });
}

/**
 * A --require hook for the child: it applies one exact edit to one tools/wow-conformance module as it loads. When
 * the edit's target is not in the source, the child prints why and exits 3, so the planted fault cannot pass unseen.
 */
function writeCorpusFaultHook(dir, fault)
{
    const file = path.join(dir, 'corpus-fault-hook.js');
    fs.writeFileSync(file, [
        "'use strict';",
        "const fs = require('fs');",
        "const target = " + JSON.stringify(path.join(__dirname, fault.file)) + ";",
        "const from = " + JSON.stringify(fault.from) + ";",
        "const to = " + JSON.stringify(fault.to) + ";",
        "const js = require.extensions['.js'];",
        "require.extensions['.js'] = function (module, filename) {",
        "    if (filename !== target) return js(module, filename);",
        "    const source = fs.readFileSync(filename, 'utf8');",
        "    if (source.split(from).length !== 2) { console.log('planted fault: edit target not found once in ' + filename + ': ' + from); process.exit(3); }",
        "    module._compile(source.replace(from, to), filename);",
        "};",
        '',
    ].join('\n'));
    return file;
}

/** The wire-suite verdict run.js printed for one check id: PASS, FAIL, PARTIAL, SKIP, N/A or null. */
function verdictOf(out, id)
{
    const m = new RegExp('^\\s*(PASS|FAIL|PARTIAL|SKIP|N/A)\\s+' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'm').exec(out);
    return m ? m[1] : null;
}

/** Each "not applicable:" line run.js printed, with the id of the check line it follows: [[id, reason]]. */
function naOf(out)
{
    const found = [];
    let id = null;
    for (const l of String(out).split('\n')) {
        const c = /^\s*(?:\|\s*)?(PASS|FAIL|PARTIAL|SKIP|N\/A)\s+(i\d+:[A-Z0-9]+)\b/.exec(l);
        if (c) { id = c[2]; continue; }
        const n = /not applicable: (.*)$/.exec(l);
        if (n) found.push([ id, n[1] ]);
    }
    return found;
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

    // ---- 4. iteration 5 is opt-in: a world with no join setup gets N/A, never FAIL -------------------
    console.log('\n== the corpus against a Lab world with no join setup (no handshake config) at ' + BASE + ' ==');
    world = await startWorld(null, NO_JOIN_CONFIG);
    let plain;
    try { plain = await runCorpus(null, { args: [] }); }
    finally { await world.close(); world = null; }
    const naLines = (plain.out.match(/not applicable: .*/g) || []);
    const i5 = I5_CHECKS.map((id) => [ id, verdictOf(plain.out, id) ]);
    const i6 = I6_CHECKS.map((id) => [ id, verdictOf(plain.out, id) ]);
    // Each "not applicable:" line, by the id of the check it follows; exactly the i5 and the i6 checks, each with its reason.
    const naById = naOf(plain.out);
    const wantNa = I5_CHECKS.map((id) => [ id, NA_REASON ]).concat(I6_CHECKS.map((id) => [ id, I6_NA_REASON ]));
    const naExact = naLines.length === wantNa.length && naById.length === wantNa.length
        && wantNa.every(([id, reason]) => naById.filter(([nid, r]) => nid === id && r === reason).length === 1);
    step('run.js --base against a world with no join setup exits 0, with i5:W2 and i5:SE2 each N/A for the opt-in reason, and i6:G1 N/A for its opt-in reason (no protected resource metadata)',
        plain.code === 0 && i5.every(([, v]) => v === 'N/A') && i6.every(([, v]) => v === 'N/A') && naExact,
        'exit ' + plain.code + ', ' + i5.concat(i6).map(([id, v]) => id + ' ' + (v || 'not reported')).join(', ') + '; ' + (naById.length ? naById.map(([id, r]) => id + ': not applicable: ' + r).join(' | ') : 'no "not applicable:" line'));

    console.log('\n== planted fault in the corpus: a corpus that marks a world with no join setup failed ==');
    const hook = writeCorpusFaultHook(tmp, CORPUS_FAULT);
    world = await startWorld(null, NO_JOIN_CONFIG);
    let marked;
    try { marked = await runCorpus(null, { args: [], preload: hook }); }
    finally { await world.close(); world = null; }
    const mv = verdictOf(marked.out, 'i5:W2');
    step('planted fault (a corpus that marks a world with no join setup failed): run.js exits 1 and names i5:W2 as failed', marked.code === 1 && mv === 'FAIL',
        'exit ' + marked.code + ', i5:W2 ' + (mv || 'not reported'));

    step('the Lab evidence file is unchanged after every run', sha(EVIDENCE) === evidenceBefore);

    fs.rmSync(tmp, { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' proof steps pass'
        + (failed.length ? '; FAILED: ' + failed.map((r) => r.name).join('; ') : ''));
    process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('base-url-proof crashed:', err); process.exit(1); });
