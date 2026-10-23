/*
 * load-independent proof of the WoW Core Requirements URL/hash grammar.
 *
 * This is the UNIT half of the proof. It has no timing dependence, no browser, no server, so
 * it cannot be poisoned by machine load (the box has been sitting at load 40-260).
 *
 * IT IS BUILT TO BE ABLE TO FAIL. Beyond asserting the grammar, it runs MUTATION TESTING:
 * it writes deliberately-broken copies of web/wow-url.mjs, re-runs the SAME suite against
 * each, and demands that every mutant be KILLED (i.e. that the suite goes red). A mutation
 * that survives is reported as a HOLE IN THE TEST and fails the run. This is the direct
 * countermeasure to this codebase's dominant defect class: evidence that passes while
 * measuring nothing.
 *
 *   node src/wow-url-grammar-check.mjs
 *   node src/wow-url-grammar-check.mjs --json
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const PROJECT_ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const MODULE_PATH = path.join(PROJECT_ROOT, 'web', 'wow-url.mjs');
const ORIGIN = 'http://127.0.0.1:8199';

/* ------------------------------------------------------------------ the suite */

/**
 * Every assertion runs against a MODULE OBJECT, so the identical suite can be pointed at the
 * real module (expect: all green) or at a mutant (expect: red).
 */
function runSuite(M)
{
    const checks = [];
    const check = (id, ok, detail) => checks.push({ id, ok : !!ok, detail });
    const eq = (id, actual, expected) => check(
        id,
        JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );

    // ---- 1. JOIN: bare URL, #join, #join=aspect  (spec-stated) ----
    eq('join.bare.intent',        M.parseWowFragment('').intent, 'join');
    eq('join.bare.isBare',        M.parseWowFragment('').bare, true);
    eq('join.verb.intent',        M.parseWowFragment('#join').intent, 'join');
    eq('join.verb.noAspect',      M.parseWowFragment('#join').aspectId, null);
    eq('join.aspect.intent',      M.parseWowFragment('#join=4182').intent, 'join');
    eq('join.aspect.id',          M.parseWowFragment('#join=4182').aspectId, '4182');
    eq('join.aspect.noHash',      M.parseWowFragment('join=4182').aspectId, '4182');
    eq('join.emptyValue.aspect',  M.parseWowFragment('#join=').aspectId, null);
    eq('join.emptyValue.intent',  M.parseWowFragment('#join=').intent, 'join');

    // ---- 2. FOLLOW ----
    eq('follow.verb.intent',      M.parseWowFragment('#follow').intent, 'follow');
    eq('follow.aspect.intent',    M.parseWowFragment('#follow=user/avatar-local-001').intent, 'follow');
    eq('follow.aspect.id',        M.parseWowFragment('#follow=user/avatar-local-001').aspectId, 'user/avatar-local-001');

    // ---- 3. PREVIEW ----
    eq('preview.verb.intent',     M.parseWowFragment('#preview').intent, 'preview');
    eq('preview.aspect.intent',   M.parseWowFragment('#preview=4182').intent, 'preview');
    eq('preview.aspect.id',       M.parseWowFragment('#preview=4182').aspectId, '4182');

    // ---- 4. THE LOAD-BEARING CONSEQUENCE (interpretation #5) ----
    // These are the assertions the whole task turns on. If these are wrong, everything is wrong.
    eq('presence.join.registers',      M.intentRegistersPresence('join'), true);
    eq('presence.follow.registers',    M.intentRegistersPresence('follow'), true);
    eq('presence.preview.NOTregisters', M.intentRegistersPresence('preview'), false);
    eq('presence.bareUrl.registers',   M.parseWorldUrl(`${ORIGIN}/w/lobby`).registersPresence, true);
    eq('presence.preview.url.NOT',     M.parseWorldUrl(`${ORIGIN}/w/lobby#preview`).registersPresence, false);
    eq('presence.previewAspect.NOT',   M.parseWorldUrl(`${ORIGIN}/w/lobby#preview=4182`).registersPresence, false);
    eq('presence.followAspect.YES',    M.parseWorldUrl(`${ORIGIN}/w/lobby#follow=4182`).registersPresence, true);

    // ---- 5. follow target (interpretation #6) ----
    eq('followTarget.aspect', M.parseWorldUrl(`${ORIGIN}/w/lobby#follow=4182`).followTarget, '4182');
    eq('followTarget.bare',   M.parseWorldUrl(`${ORIGIN}/w/lobby#follow`).followTarget, null);
    eq('followTarget.join',   M.parseWorldUrl(`${ORIGIN}/w/lobby#join=4182`).followTarget, null);

    // ---- 6. unrecognized fragments are NOT hijacked (interpretation #4) ----
    // NOTE: '#section-2' and '#join&follow' fail the `verb[=value]` REGEX, so on their own they
    // never exercise the "is this a known WoW verb?" branch at all. Mutant M5 proved that: it
    // deleted the verb check and these cases still passed. The cases that actually reach the
    // branch are pure-letter tokens that are NOT WoW verbs — '#about', '#tab=settings'. Both
    // kinds are kept: the regex guard and the verb guard are different defences.
    eq('anchor.word.notRecognized',   M.parseWowFragment('#about').recognized, false);
    eq('anchor.word.fallsBackToJoin', M.parseWowFragment('#about').intent, 'join');
    eq('anchor.word.noAspect',        M.parseWowFragment('#about').aspectId, null);
    eq('anchor.kv.notRecognized',     M.parseWowFragment('#tab=settings').recognized, false);
    eq('anchor.kv.fallsBackToJoin',   M.parseWowFragment('#tab=settings').intent, 'join');
    eq('anchor.kv.noAspect',          M.parseWowFragment('#tab=settings').aspectId, null);
    eq('anchor.kv.noPresenceSurprise', M.parseWorldUrl(`${ORIGIN}/w/lobby#tab=settings`).registersPresence, true);
    eq('anchor.notRecognized', M.parseWowFragment('#section-2').recognized, false);
    eq('anchor.fallsBackToJoin', M.parseWowFragment('#section-2').intent, 'join');
    eq('anchor.noAspect',      M.parseWowFragment('#section-2').aspectId, null);
    eq('bare.IS.recognized',   M.parseWowFragment('').recognized, true);
    eq('join.IS.recognized',   M.parseWowFragment('#join').recognized, true);
    eq('compound.notRecognized', M.parseWowFragment('#join&follow').recognized, false);

    // ---- 7. case-insensitivity in, lowercase out (interpretation #3) ----
    eq('case.upper.intent',  M.parseWowFragment('#PREVIEW').intent, 'preview');
    eq('case.mixed.intent',  M.parseWowFragment('#Follow=X').intent, 'follow');
    eq('case.aspectPreserved', M.parseWowFragment('#follow=AbC').aspectId, 'AbC');
    eq('case.emit.lowercase', M.buildWorldUrl(`${ORIGIN}/w/a`, { intent : 'preview' }), `${ORIGIN}/w/a/#preview`);

    // ---- 8. percent-decoding ----
    eq('pct.decoded', M.parseWowFragment('#join=user%2Favatar-1').aspectId, 'user/avatar-1');

    // ---- 9. world resolution (interpretation #7) ----
    eq('world.path.lobby',   M.parseWorldUrl(`${ORIGIN}/w/lobby`).world, 'lobby');
    eq('world.path.a',       M.parseWorldUrl(`${ORIGIN}/w/a#preview`).world, 'a');
    eq('world.path.source',  M.parseWorldUrl(`${ORIGIN}/w/a`).worldSource, 'path');
    eq('world.legacyRole.a', M.parseWorldUrl(`${ORIGIN}/index.html?role=source`).world, 'a');
    eq('world.legacyRole.b', M.parseWorldUrl(`${ORIGIN}/index.html?role=target`).world, 'b');
    eq('world.legacyRole.lobby', M.parseWorldUrl(`${ORIGIN}/index.html?role=player`).world, 'lobby');
    // The bare legacy URL must agree with the APP's own default (role=source -> backend 'a').
    // An earlier draft said 'lobby' here — a module that quietly disagreed with the app.
    eq('world.default',      M.parseWorldUrl(`${ORIGIN}/index.html`).world, 'a');
    eq('world.legacyActive.b', M.parseWorldUrl(`${ORIGIN}/index.html?role=player&active=b`).world, 'b');
    eq('world.legacyStage',  M.parseWorldUrl(`${ORIGIN}/index.html?stage=1`).world, 'lobby');
    eq('world.apiBase',      M.parseWorldUrl(`${ORIGIN}/w/b`).apiBase, '/api/b');

    // ---- 10. spec composition: <worldUrl>/wow/world must be a real URL a client can GET ----
    eq('compose.wowApiBase', M.parseWorldUrl(`${ORIGIN}/w/lobby#preview`).wowApiBase, `${ORIGIN}/w/lobby/wow`);
    eq('compose.worldUrl',   M.parseWorldUrl(`${ORIGIN}/w/lobby#preview`).worldUrl, `${ORIGIN}/w/lobby/`);
    // THE TRAILING SLASH IS LOAD-BEARING: a page at `/w/a` (no slash) resolves `app.js` against
    // `/w/` -> `/w/app.js` -> 404 -> the world never boots. The browser proof caught this for
    // real; this check + mutant M8 keep it caught.
    check('compose.worldUrl_ends_in_slash',
        M.parseWorldUrl(`${ORIGIN}/w/a`).worldUrl.endsWith('/'),
        `world URL must end in '/' so a page served there resolves its relative imports; got ${M.parseWorldUrl(`${ORIGIN}/w/a`).worldUrl}`);
    check('compose.persistUrl_ends_in_slash_or_hash',
        /\/(#|$)/.test(M.parseWorldUrl(`${ORIGIN}/w/a#preview`).persistUrl),
        `persisted URL must keep the canonical trailing slash; got ${M.parseWorldUrl(`${ORIGIN}/w/a#preview`).persistUrl}`);
    check('compose.isAbsolute',
        (() => { try { return new URL(M.parseWorldUrl(`${ORIGIN}/w/a`).wowApiBase + '/world').href === `${ORIGIN}/w/a/wow/world`; } catch (_) { return false; } })(),
        'the spec\'s own composition URL/wow/world must parse to an absolute URL');

    // ---- 11. aspect resolution (interpretation #2) ----
    eq('aspect.user.qualified', M.resolveAspect('user/4182').candidates, [ '/wow/user/4182' ]);
    eq('aspect.user.kind',      M.resolveAspect('user/4182').kind, 'user');
    eq('aspect.node.needsSpatial', M.resolveAspect('node/n1', { spatialId : 'demo' }).candidates, [ '/wow/spatial/demo/node/n1' ]);
    eq('aspect.bare.probesUser', M.resolveAspect('4182').candidates[0], '/wow/user/4182');
    eq('aspect.null',           M.resolveAspect(null).candidates, []);

    // ---- 12. PERSIST + SHARE: the URL must round-trip (interpretation #8) ----
    // A URL that cannot be bookmarked back into the same state does not satisfy Persist.
    const roundTrip = (href) => {
        const a = M.parseWorldUrl(href);
        const b = M.parseWorldUrl(a.persistUrl);
        return (a.world === b.world)
            && (a.intent === b.intent)
            && (a.aspectId === b.aspectId)
            && (a.registersPresence === b.registersPresence);
    };
    check('persist.roundTrip.bare',          roundTrip(`${ORIGIN}/w/lobby`), 'bare join must round-trip');
    check('persist.roundTrip.joinAspect',    roundTrip(`${ORIGIN}/w/a#join=4182`), 'join@aspect must round-trip');
    check('persist.roundTrip.preview',       roundTrip(`${ORIGIN}/w/b#preview`), 'preview must round-trip (still a preview)');
    check('persist.roundTrip.previewAspect', roundTrip(`${ORIGIN}/w/b#preview=user/x`), 'preview@aspect must round-trip');
    check('persist.roundTrip.followAspect',  roundTrip(`${ORIGIN}/w/a#follow=4182`), 'follow@aspect must round-trip');
    check('persist.roundTrip.legacyRole',    (() => {
        const a = M.parseWorldUrl(`${ORIGIN}/index.html?role=target#preview=9`);
        const b = M.parseWorldUrl(a.persistUrl);
        return a.world === b.world && a.intent === b.intent && a.aspectId === b.aspectId;
    })(), 'a legacy ?role= URL must persist into the stable /w/ form, same world+intent+aspect');

    eq('persist.bareJoin.isClean', M.parseWorldUrl(`${ORIGIN}/w/lobby`).persistUrl, `${ORIGIN}/w/lobby/`);
    eq('persist.previewAspect.url', M.parseWorldUrl(`${ORIGIN}/w/b#preview=4182`).persistUrl, `${ORIGIN}/w/b/#preview=4182`);
    eq('share.buildsSameUrl', M.buildWorldUrl(`${ORIGIN}/w/a`, { intent : 'follow', aspectId : '4182' }), `${ORIGIN}/w/a/#follow=4182`);

    // ---- 13. the interpretation ledger must be present and complete ----
    check('ledger.exists', Array.isArray(M.WOW_CORE_INTERPRETATIONS) && M.WOW_CORE_INTERPRETATIONS.length >= 9,
        `interpretation ledger must carry every reading we took (got ${M.WOW_CORE_INTERPRETATIONS?.length})`);
    check('ledger.everyEntryHasReasoning',
        (M.WOW_CORE_INTERPRETATIONS || []).every(i => i.id && i.subject && i.spec_says && i.we_read && i.reasoning),
        'every interpretation must carry id, subject, spec_says, we_read, reasoning');

    return checks;
}

/* ------------------------------------------------------------------ mutants */

/**
 * Each mutant is a targeted lie. The suite MUST catch every one. A surviving mutant means the
 * suite is not actually measuring the thing it claims to measure.
 */
const MUTANTS = [
    {
        id : 'M1-preview-registers-presence',
        why : 'the single most important assertion: preview must NOT register presence',
        apply : (src) => src.replace(
            'return intent === WOW_INTENT.JOIN || intent === WOW_INTENT.FOLLOW;',
            'return true; /* MUTANT */'),
    },
    {
        id : 'M2-follow-drops-presence',
        why : 'follow must register presence (interpretation #5)',
        apply : (src) => src.replace(
            'return intent === WOW_INTENT.JOIN || intent === WOW_INTENT.FOLLOW;',
            'return intent === WOW_INTENT.JOIN; /* MUTANT */'),
    },
    {
        id : 'M3-aspect-ignored',
        why : 'the aspect must survive parsing — #join=4182 must not degrade to a bare join',
        apply : (src) => src.replace(
            'if (value !== \'\') aspectId = value;',
            '/* MUTANT: aspect dropped */'),
    },
    {
        id : 'M4-persist-drops-fragment',
        why : 'a URL that loses its fragment cannot be bookmarked back into the same state',
        apply : (src) => src.replace(
            'if (!aspectId) return `${base}#${verb}`;',
            'if (!aspectId) return base; /* MUTANT */')
            .replace(
                'return `${base}#${verb}=${encodeURIComponent(aspectId)}`;',
                'return base; /* MUTANT */'),
    },
    {
        id : 'M5-anchor-hijacked',
        why : 'an ordinary #anchor must not be swallowed as a WoW intent',
        apply : (src) => src.replace(
            'if (!KNOWN_INTENTS.has(verb))\n    {',
            'if (false)\n    {'),
    },
    {
        id : 'M6-world-url-not-path-composable',
        why : 'the world URL must be a path prefix, or URL/wow/world does not compose (G-NEW-1)',
        apply : (src) => src.replace(
            'return `${stripTrailingSlash(origin)}/w/${key}/`;',
            'return `${stripTrailingSlash(origin)}/index.html?world=${key}`; /* MUTANT */'),
    },
    {
        id : 'M7-legacy-role-ignored',
        why : 'the legacy ?role= entry must still resolve to the right world (nothing that exists may break)',
        apply : (src) => src.replace(
            "else if (role === 'player') { worldKey = 'lobby'; worldSource = 'query:role'; }",
            "else if (false) { /* MUTANT */ }"),
    },
    {
        id : 'M8-world-url-loses-trailing-slash',
        why : 'a world URL without its trailing slash resolves app.js against /w/ -> 404 -> the world never boots (this bug was REAL: the first browser run died on it)',
        apply : (src) => src.replace(
            'return `${stripTrailingSlash(origin)}/w/${key}/`;',
            'return `${stripTrailingSlash(origin)}/w/${key}`; /* MUTANT */'),
    },
];

/* ------------------------------------------------------------------ runner */

async function importModuleFrom(file)
{
    // cache-bust so each mutant is genuinely re-imported
    return import(`${pathToFileURL(file).href}?v=${Math.random()}`);
}

async function main()
{
    const asJson = process.argv.includes('--json');
    const src = readFileSync(MODULE_PATH, 'utf8');
    const tmp = path.join(os.tmpdir(), `runtime-mutants-${process.pid}`);
    mkdirSync(tmp, { recursive : true });

    const report = { wo : 'runtime', module : MODULE_PATH, baseline : null, mutants : [], ok : false };

    // --- baseline: the real module must be fully green ---
    const real = await importModuleFrom(MODULE_PATH);
    const baseChecks = runSuite(real);
    const baseFailed = baseChecks.filter(c => !c.ok);
    report.baseline = {
        total : baseChecks.length,
        passed : baseChecks.length - baseFailed.length,
        failed : baseFailed.length,
        failures : baseFailed.map(c => ({ id : c.id, detail : c.detail })),
    };

    if (!asJson)
    {
        printf(`\n=== runtime · WoW Core Requirements — URL/hash grammar ===\n`);
        printf(`module: ${MODULE_PATH}\n\n`);
        printf(`BASELINE (the real module — must be all green)\n`);
        printf(`  checks: ${baseChecks.length}   passed: ${report.baseline.passed}   FAILED: ${baseFailed.length}\n`);
        for (const f of baseFailed) printf(`  RED  ${f.id}: ${f.detail}\n`);
    }

    // --- mutation testing: every mutant must be KILLED ---
    let survivors = 0;
    for (const mut of MUTANTS)
    {
        const mutated = mut.apply(src);
        const applied = mutated !== src;
        const file = path.join(tmp, `${mut.id}.mjs`);
        writeFileSync(file, mutated);

        let killedBy = [];
        let importError = null;
        if (applied)
        {
            try
            {
                const M = await importModuleFrom(file);
                killedBy = runSuite(M).filter(c => !c.ok).map(c => c.id);
            }
            catch (err) { importError = err.message; killedBy = [ '(module threw)' ]; }
        }

        const killed = applied && killedBy.length > 0;
        if (!killed) survivors++;
        report.mutants.push({
            id : mut.id, why : mut.why, applied, killed,
            killed_by_count : killedBy.length,
            killed_by : killedBy.slice(0, 6),
            import_error : importError,
        });

        if (!asJson)
        {
            if (!applied)
                printf(`  HOLE ${mut.id}: mutation did not apply (source drifted) — TEST IS NOT MEASURING THIS\n`);
            else if (killed)
                printf(`  KILL ${mut.id}  (${killedBy.length} checks went red: ${killedBy.slice(0, 3).join(', ')}${killedBy.length > 3 ? ', ...' : ''})\n`);
            else
                printf(`  SURVIVED ${mut.id}: ${mut.why} — THE SUITE DID NOT CATCH THIS. HOLE IN THE TEST.\n`);
        }
    }

    rmSync(tmp, { recursive : true, force : true });

    report.ok = baseFailed.length === 0 && survivors === 0
        && report.mutants.every(m => m.applied && m.killed);

    if (asJson) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); }
    else
    {
        printf(`\nMUTANTS: ${MUTANTS.length}   killed: ${MUTANTS.length - survivors}   SURVIVED: ${survivors}\n`);
        printf(`\nRESULT: ${report.ok ? 'GREEN — grammar correct AND every mutant killed (the validation can fail)' : 'RED'}\n\n`);
    }

    process.exit(report.ok ? 0 : 1);
}

function printf(s) { process.stdout.write(s); }

main().catch(err => { console.error(err); process.exit(1); });
