'use strict';

/*
 * Iteration 5, stage A: the identity handshake, in Node, against lab world servers.
 *
 *   ID6  both directions: the World states its identity, its claims (each required or optional) and what it
 *        issues; the agent checks the base URL before it discloses anything
 *   ID5  minimum disclosure: a world receives only the claims it asks for (read from the world's own log)
 *   ID1  claims at entry: the outcome (proceed, proceed-in-part, deny), the claims satisfied and not, and the
 *        world's record of each outcome
 *   ID2  self-assertion: a self-asserted claim is reported as self-asserted, and so is one carrying a
 *        credential from an issuer the world does not list (the visitor's own key among them); a world that
 *        requires an issuer refuses it with the reason
 *   ID4  tampering: a copied manifest fails the holder proof, an altered one or one signed by another key
 *        than its subject the integrity check; the lab's signing vectors are reused, and an independent
 *        computation agrees with the lab's signing code
 *   ID7  no tracking: two worlds receive different pointers, signatures and proofs for the same visitor, and
 *        no pointer appears in any URL or Referer header a world received
 *   ID9  preferences without a height: `language` alone satisfies the preferences claim; the provisional
 *        accessibility members are shape-checked; the world reports each member it received as applied or not
 *   ID10 the pilot statement: every join carries one (human, agent or hybrid); the world copies it onto the User
 *        (User.pilot) and refuses a join without one, or with another value; a client shows hybrid as an agent
 *
 * Every check also runs against planted faults, each an exact edit of the real code, which must turn it red.
 */

const path = require('path');
const nodeCrypto = require('crypto');
const { spawnSync } = require('child_process');
const { ROOT, run, httpReq } = require('../arch-i1/lib');
const lab = require('./lab');

/** Post a join body to a world, as any client could. */
async function postJoin(world, body, query) {
  return httpReq('POST', world.port, world.prefix + '/wow/user' + (query || ''), body, { Accept: 'application/wow+json' });
}

const names = (list) => (list || []).map((c) => c.name).sort().join(',');
const lastRecord = (world) => { const all = world.records() || []; return all[all.length - 1] || null; };

/** The record matches the answer: the same outcome and the same claims named, each with its required mark. */
function recordMatches(world, answer, before) {
  const all = world.records() || [];
  if (all.length !== before + 1) return 'the world holds ' + (all.length - before) + ' new record(s) for one join, not 1';
  const rec = all[all.length - 1];
  if (!answer) return 'no answer';
  if (rec.outcome !== answer.outcome) return 'recorded ' + rec.outcome + ' but answered ' + answer.outcome;
  const key = (list) => (list || []).map((c) => c.name + ':' + c.required).sort().join(',');
  if (key(rec.satisfied) !== key(answer.satisfied) || key(rec.not_satisfied) !== key(answer.not_satisfied)) return 'the record names other claims than the answer';
  return null;
}

async function handshakeChecks(ports) {
  // The proof's visitor is software acting alone, so it states pilot "agent" (User.pilot; the agent always sends a pilot statement).
  const WALLET = { claims: { avatar: { uri: 'http://127.0.0.1:1/assets/actionforge/characters/sophie/sophie.glb', label: 'Sophie' }, display_name: 'Ada', preferences: { preferred_height_m: 1.85 }, age: 99 }, pilot: 'agent' };

  // ---- ID6 --------------------------------------------------------------------------------------------
  const agentSkipsCheck = { agent: [['  if (!check.ok) return { base, world, asked, plan: null, sent: [], pointer: null, status: null, answer: null, refused: check.reason };\n', '']] };
  const worldWithoutIssues = { server: { handshake: [['            issues : issues.slice(),\n', '']] } };
  const worldWithoutRequiredMarks = { server: { handshake: [['        required : c.required === true,\n', '']] } };
  await run('ID6', 'both directions: the World resource states its identity (base URL), the claims it asks for (each required or optional) and what it issues (stage A: empty); the agent checks the base URL before disclosing, and to a World naming another base URL it sends nothing', async (impl) => {
    const failures = [];
    const hs = await lab.agent(impl.agent);
    const B = await lab.handshakeWorld('b', ports.next(), { base: '/w/b', edits: impl.server });
    const M = await lab.handshakeWorld('b', ports.next(), { base: '/w/m', statedBase: 'http://127.0.0.1:9/w/elsewhere/', edits: impl.server });
    try {
      const world = (await httpReq('GET', B.port, '/w/b/wow/world', null, { Accept: lab.WOW })).json;
      if (!world.identity || world.identity.base !== B.base) failures.push('identity: ' + JSON.stringify(world.identity));
      const claimsOk = Array.isArray(world.claims) && world.claims.length === lab.B_CLAIMS.length
        && lab.B_CLAIMS.every((c) => world.claims.some((d) => d.name === c.name && d.required === c.required));
      if (!claimsOk) failures.push('claims: ' + JSON.stringify(world.claims));
      if (!Array.isArray(world.issues)) failures.push('issues: ' + JSON.stringify(world.issues));
      const good = await hs.enterWorld(B.spatialUrl(1), { wallet: WALLET });
      if (good.refused || good.status !== 201) failures.push('to the true world: ' + (good.refused || good.status));
      const bad = await hs.enterWorld(M.spatialUrl(1), { wallet: WALLET });
      const posts = lab.joinsReceived(M);
      if (!bad.refused) failures.push('to a World naming another base URL the agent did not refuse');
      if (posts.length) failures.push('that world received ' + posts.length + ' join(s) carrying ' + Object.keys((posts[0].json && posts[0].json.manifest && posts[0].json.manifest.claims) || {}).join(', '));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `B states identity ${world.identity.base}, claims ${world.claims.map((c) => c.name + (c.required ? ' (required)' : ' (optional)')).join(', ')}, issues [${world.issues.join(', ')}]; a World naming another base URL got no join (the agent: "${bad.refused}")` };
    } finally {
      await B.close();
      await M.close();
    }
  }, {}, [
    { name: 'an agent that discloses to a World naming another base URL', impl: agentSkipsCheck },
    { name: 'a World that states no issues list', impl: worldWithoutIssues },
    { name: 'a World whose claims carry no required mark', impl: worldWithoutRequiredMarks },
  ]);

  // ---- ID5 --------------------------------------------------------------------------------------------
  const sendsEverything = { agent: [['  for (const name of plan.send) values[name] = wallet.claims[name];\n', '  for (const name of Object.keys(wallet.claims)) values[name] = wallet.claims[name];\n']] };
  const ignoresWithhold = { agent: [['    if (withhold.includes(claim.name)) withheld.push(claim.name);\n', '    if (false) withheld.push(claim.name);\n']] };
  await run('ID5', 'minimum disclosure (UC04-R02): read from what each world received, a join carries only the claims that world asks for, required or optional, and none the visitor withholds', async (impl) => {
    const failures = [];
    const hs = await lab.agent(impl.agent);
    const B = await lab.handshakeWorld('b', ports.next(), { base: '/w/b' });
    const A = await lab.handshakeWorld('a', ports.next(), { claims: lab.A_CLAIMS });
    try {
      await hs.enterWorld(B.base, { wallet: WALLET });
      await hs.enterWorld(B.base, { wallet: WALLET, withhold: ['display_name'] });
      await hs.enterWorld(A.base, { wallet: WALLET });
      const seen = [];
      for (const [world, asked, withheld] of [[B, lab.B_CLAIMS, [[], ['display_name']]], [A, lab.A_CLAIMS, [[]]]]) {
        const joins = lab.joinsReceived(world);
        if (joins.length !== withheld.length) failures.push(`${world.base} received ${joins.length} joins, not ${withheld.length}`);
        joins.forEach((j, i) => {
          const got = Object.keys((j.json && j.json.manifest && j.json.manifest.claims) || {}).sort();
          const want = asked.map((c) => c.name).filter((n) => !(withheld[i] || []).includes(n)).sort();
          seen.push(got.join('+'));
          if (got.join(',') !== want.join(',')) failures.push(`${world.base} join ${i + 1} carried [${got}] where it asked for [${want}]`);
        });
      }
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `the worlds received only what they asked for: B ${seen[0]}, B with the display name withheld ${seen[1]}, A ${seen[2]} (the visitor also holds age, sent to neither)` };
    } finally {
      await B.close();
      await A.close();
    }
  }, {}, [
    { name: 'an agent whose join carries a claim the world did not ask for', impl: sendsEverything },
    { name: 'an agent that sends a claim the visitor withholds', impl: ignoresWithhold },
  ]);

  // ---- ID1 --------------------------------------------------------------------------------------------
  const H = (edits) => ({ server: { handshake: edits } });
  await run('ID1', 'claims at entry: B asks for avatar and preferences (required) and display name (optional); all sent: proceed, and B\'s User carries the avatar and preferences; display name withheld: proceed-in-part naming it (optional); only the avatar sent, or the avatar and display name: deny naming preferences (required); values of the wrong shape are not satisfied (malformed): deny when required, proceed-in-part when optional; B records each outcome with the claims its answer names', async (impl) => {
    const failures = [];
    const hs = await lab.agent();
    const B = await lab.handshakeWorld('b', ports.next(), { base: '/w/b', edits: impl.server });
    try {
      const notes = [];
      // 1. Everything B asks for: proceed.
      let before = (B.records() || []).length;
      const all = await hs.enterWorld(B.base, { wallet: WALLET });
      const a1 = all.answer || {};
      if (all.status !== 201 || a1.outcome !== 'proceed') failures.push('all sent: ' + all.status + ' ' + a1.outcome);
      if (names(a1.satisfied) !== 'avatar,display_name,preferences' || (a1.not_satisfied || []).length) failures.push('all sent: satisfied [' + names(a1.satisfied) + '], not satisfied [' + names(a1.not_satisfied) + ']');
      const r1 = recordMatches(B, a1, before);
      if (r1) failures.push('all sent: ' + r1);
      const user = a1.user ? (await httpReq('GET', B.port, '/w/b/' + a1.user, null, { Accept: lab.WOW })).json : null;
      if (!user || user.AvatarURI !== WALLET.claims.avatar.uri || JSON.stringify(user.osl_preferences) !== JSON.stringify(WALLET.claims.preferences) || user.name !== 'Ada') failures.push('B\'s User: ' + JSON.stringify(user && { name: user.name, AvatarURI: user.AvatarURI, osl_preferences: user.osl_preferences }));
      else notes.push(`proceed, User ${a1.user} (${user.AvatarURI.split('/').pop()}, ${user.osl_preferences.preferred_height_m} m)`);
      // 2. The optional display name withheld: proceed-in-part, naming it.
      before = (B.records() || []).length;
      const part = await hs.enterWorld(B.base, { wallet: WALLET, withhold: ['display_name'] });
      const a2 = part.answer || {};
      const named2 = (a2.not_satisfied || []).find((c) => c.name === 'display_name');
      if (part.status !== 201 || a2.outcome !== 'proceed-in-part' || !named2 || named2.required !== false || (a2.not_satisfied || []).length !== 1) failures.push('display name withheld: ' + part.status + ' ' + a2.outcome + ', not satisfied ' + JSON.stringify(a2.not_satisfied));
      const r2 = recordMatches(B, a2, before);
      if (r2) failures.push('display name withheld: ' + r2);
      else notes.push('proceed-in-part naming display_name (optional)');
      // 3. Only the avatar sent: deny, naming preferences.
      before = (B.records() || []).length;
      const deny = await hs.enterWorld(B.base, { wallet: WALLET, withhold: ['preferences', 'display_name'] });
      const a3 = deny.answer || {};
      const named3 = (a3.not_satisfied || []).find((c) => c.name === 'preferences');
      if (deny.sent.join(',') !== 'avatar') failures.push('only the avatar: the agent sent ' + deny.sent.join(','));
      if (deny.status !== 403 || a3.outcome !== 'deny' || !named3 || named3.required !== true || a3.user) failures.push('only the avatar: ' + deny.status + ' ' + a3.outcome + ', not satisfied ' + JSON.stringify(a3.not_satisfied) + (a3.user ? ', user ' + a3.user : ''));
      const r3 = recordMatches(B, a3, before);
      if (r3) failures.push('only the avatar: ' + r3);
      else notes.push('deny naming preferences (required), with the avatar alone and with the avatar and display name');
      // 4. Preferences withheld, the display name sent: deny again, naming preferences.
      before = (B.records() || []).length;
      const deny2 = await hs.enterWorld(B.base, { wallet: WALLET, withhold: ['preferences'] });
      const a4 = deny2.answer || {};
      if (deny2.status !== 403 || a4.outcome !== 'deny' || names(a4.not_satisfied) !== 'preferences' || a4.user) failures.push('preferences withheld: ' + deny2.status + ' ' + a4.outcome + ', not satisfied ' + JSON.stringify(a4.not_satisfied));
      const r4 = recordMatches(B, a4, before);
      if (r4) failures.push('preferences withheld: ' + r4);
      // 5. Values of the wrong shape (avatar 5, preferences "tall", display name ""): deny, all three named malformed.
      before = (B.records() || []).length;
      const bad = await postJoin(B, await hs.presentation({ values: { avatar: 5, preferences: 'tall', display_name: '' }, key: await hs.visitKey(), audience: B.base, pilot: 'agent' }));
      const a5 = bad.json || {};
      const malformed5 = (a5.not_satisfied || []).filter((c) => /^malformed/.test(c.reason || ''));
      if (bad.status !== 403 || a5.outcome !== 'deny' || names(malformed5) !== 'avatar,display_name,preferences' || (a5.satisfied || []).length || a5.user) failures.push('malformed values: ' + bad.status + ' ' + a5.outcome + ', satisfied [' + names(a5.satisfied) + '], not satisfied ' + JSON.stringify(a5.not_satisfied) + (a5.user ? ', user ' + a5.user : ''));
      const r5 = recordMatches(B, a5, before);
      if (r5) failures.push('malformed values: ' + r5);
      // 6. Only the optional display name malformed (""): proceed-in-part naming it, and the User gets no empty name.
      before = (B.records() || []).length;
      const half = await postJoin(B, await hs.presentation({ values: { avatar: WALLET.claims.avatar, preferences: WALLET.claims.preferences, display_name: '' }, key: await hs.visitKey(), audience: B.base, pilot: 'agent' }));
      const a6 = half.json || {};
      const n6 = (a6.not_satisfied || []).find((c) => c.name === 'display_name');
      const u6 = a6.user ? (await httpReq('GET', B.port, '/w/b/' + a6.user, null, { Accept: lab.WOW })).json : null;
      if (half.status !== 201 || a6.outcome !== 'proceed-in-part' || !n6 || !/^malformed/.test(n6.reason || '') || (a6.not_satisfied || []).length !== 1 || !u6 || !u6.name) failures.push('an empty display name: ' + half.status + ' ' + a6.outcome + ', not satisfied ' + JSON.stringify(a6.not_satisfied) + ', User ' + JSON.stringify(u6));
      const r6 = recordMatches(B, a6, before);
      if (r6) failures.push('an empty display name: ' + r6);
      else if (n6) notes.push(`wrong shapes (avatar 5, preferences "tall", display name ""): deny naming all three malformed ("${(malformed5[0] || {}).reason}"); only the display name empty: proceed-in-part naming it ("${n6.reason}"), User name "${u6 && u6.name}"`);
      // The record is also served at the URL the answer names.
      const served = a3.record ? await httpReq('GET', B.port, '/w/b/' + a3.record, null) : null;
      if (!served || served.status !== 200 || served.json.outcome !== a3.outcome) failures.push('the record URL answered ' + (served && served.status));
      const rec = lastRecord(B);
      const recText = rec ? JSON.stringify(rec) : '';
      if (rec && (/did:key/.test(recText) || /nonce/.test(recText))) failures.push('the record holds a pointer or nonce');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : notes.join('; ') + `; B holds ${B.records().length} records, each matching its answer, with no pointer in them` };
    } finally {
      await B.close();
    }
  }, {}, [
    { name: 'a B that answers proceed-in-part while a required claim is missing', impl: H([['            if (requiredMissing.length) outcome = shared.OUTCOME.DENY;\n', '            if (requiredMissing.length) outcome = shared.OUTCOME.PART;\n']]) },
    { name: 'a B that answers proceed while a required claim is missing', impl: H([['            const requiredMissing = notSatisfied.filter((c) => c.required);\n', '            const requiredMissing = notSatisfied.filter((c) => c.required && false);\n']]) },
    { name: 'a B that denies without naming the missing required claim (preferences)', impl: H([['            answer = { outcome, satisfied, not_satisfied : notSatisfied };\n', '            answer = { outcome, satisfied, not_satisfied : notSatisfied.filter((c) => !c.required) };\n']]) },
    { name: 'a B that answers proceed when an optional claim is withheld', impl: H([['            else if (optionalMissing.length) outcome = shared.OUTCOME.PART;\n', '']]) },
    { name: 'a B that does not name the withheld optional claim', impl: H([['            answer = { outcome, satisfied, not_satisfied : notSatisfied };\n', '            answer = { outcome, satisfied, not_satisfied : notSatisfied.filter((c) => c.required) };\n']]) },
    { name: 'a B that records an outcome other than the one it answered', impl: H([['            outcome : answer.outcome,\n', '            outcome : \'proceed\',\n']]) },
    { name: 'a B that records no outcome', impl: H([['        records.push(rec);\n', '']]) },
    { name: 'a B whose User does not carry the avatar it was sent', impl: H([["                if (isObject(accepted.avatar) && typeof accepted.avatar.uri === 'string') user.AvatarURI = accepted.avatar.uri;\n", '']]) },
    { name: 'a B that counts a claim as satisfied whatever its value (no shape check)', impl: H([["        if (shape && !shape.ok(entry.value)) return { satisfied : false, reason : 'malformed: expected ' + shape.expected };\n", '']]) },
  ]);

  // ---- ID9 --------------------------------------------------------------------------------------------
  const PREFS_ALL = { preferred_height_m: 1.7, language: 'fr-CA', captions: true, reduced_motion: true, seated: false, text_scale: 1.25, input: ['gaze', 'voice'], reduced_flashing: true, x_lab_unknown: 'ignored' };
  await run('ID9', 'preferences without a height: P asks for preferences (required); preferences holding only language "fr-CA" are satisfied (proceed); every member (preferred_height_m, language, captions, reduced_motion, seated, text_scale, input, reduced_flashing, and one the world does not know) proceeds, and the answer and the record report each member received with applied true or false (the height applied, the others not, none dropped); accessibility members of the wrong shape, an ill-formed language tag, an empty object and one holding only an unknown member are not satisfied (malformed); the agent\'s sample preferences stay { preferred_height_m: 1.85 } and the agent and the world name the same members', async (impl) => {
    const failures = [];
    const notes = [];
    const hs = await lab.agent();
    const handshakeModule = require(path.join(ROOT, 'runtime', 'world-server', 'src', 'runtime-handshake.js'));
    const P = await lab.handshakeWorld('b', ports.next(), { base: '/w/p', claims: [{ name: 'preferences', required: true }], edits: impl.server });
    const reportOf = (a) => (a && a.osl_preferences_applied) || null;
    const sameReport = (rec, a) => JSON.stringify(rec && rec.osl_preferences_applied) === JSON.stringify(reportOf(a));
    try {
      // 1. Language alone: satisfied, proceed, and the report names language (received, not applied).
      const lang = await hs.enterWorld(P.base, { wallet: { claims: { preferences: { language: 'fr-CA' } }, pilot: 'agent' } });
      const a1 = lang.answer || {};
      const s1 = (a1.satisfied || []).find((c) => c.name === 'preferences');
      if (lang.status !== 201 || a1.outcome !== 'proceed' || !s1) failures.push('language alone: ' + lang.status + ' ' + a1.outcome + ', not satisfied ' + JSON.stringify(a1.not_satisfied));
      else {
        const r1 = reportOf(a1);
        if (JSON.stringify(r1) !== JSON.stringify({ language: false })) failures.push('language alone: the answer reports ' + JSON.stringify(r1) + ', not { language: false }');
        else if (!sameReport(lastRecord(P), a1)) failures.push('language alone: the record reports ' + JSON.stringify((lastRecord(P) || {}).osl_preferences_applied));
        else notes.push('{ language: "fr-CA" } alone: proceed, reported ' + JSON.stringify(r1));
      }
      // 2. Every member, sent by the agent: proceed; each received member reported once, the height applied.
      const every = await hs.enterWorld(P.base, { wallet: { claims: { preferences: PREFS_ALL }, pilot: 'agent' } });
      const a2 = every.answer || {};
      const r2 = reportOf(a2) || {};
      const received = lab.joinsReceived(P).slice(-1)[0];
      const carried = received && received.json && received.json.manifest.claims.preferences && received.json.manifest.claims.preferences.value;
      if (JSON.stringify(carried) !== JSON.stringify(PREFS_ALL)) failures.push('the agent sent ' + JSON.stringify(carried) + ', not every member');
      if (every.status !== 201 || a2.outcome !== 'proceed') failures.push('every member: ' + every.status + ' ' + a2.outcome + ', not satisfied ' + JSON.stringify(a2.not_satisfied));
      else {
        const missing = Object.keys(PREFS_ALL).filter((m) => typeof r2[m] !== 'boolean');
        const extra = Object.keys(r2).filter((m) => !(m in PREFS_ALL));
        const wrong = Object.keys(PREFS_ALL).filter((m) => typeof r2[m] === 'boolean' && r2[m] !== (m === 'preferred_height_m'));
        if (missing.length) failures.push('every member: the report drops ' + missing.join(', ') + ' (' + JSON.stringify(r2) + ')');
        if (extra.length) failures.push('every member: the report names members not received: ' + extra.join(', '));
        if (wrong.length) failures.push('every member: applied is wrong for ' + wrong.join(', ') + ' (the lab applies only preferred_height_m)');
        if (!sameReport(lastRecord(P), a2)) failures.push('every member: the record reports ' + JSON.stringify((lastRecord(P) || {}).osl_preferences_applied) + ', the answer ' + JSON.stringify(r2));
        const user = a2.user ? (await httpReq('GET', P.port, '/w/p/' + a2.user, null, { Accept: lab.WOW })).json : null;
        if (!user || !user.osl_preferences || user.osl_preferences.preferred_height_m !== 1.7 || 'x_lab_unknown' in user.osl_preferences) failures.push('every member: the User carries ' + JSON.stringify(user && user.osl_preferences));
        if (!missing.length && !extra.length && !wrong.length) notes.push('every member: proceed, reported ' + JSON.stringify(r2));
      }
      // 3. Wrong shapes: each is not satisfied (malformed), and nothing is reported as applied.
      const bad = [
        { captions: 'yes' }, { reduced_motion: 1 }, { seated: 'no' }, { reduced_flashing: null },
        { text_scale: 0 }, { text_scale: '2' }, { input: 'gaze' }, { input: [3] }, { input: [''] },
        { language: 'not a tag!' }, { language: '' }, { language: 42 },
        { preferred_height_m: -1, language: 'fr' }, { language: 'fr-CA', reduced_motion: 'on' },
        {}, { x_lab_unknown: true },
      ];
      const accepted = [];
      for (const value of bad) {
        const r = await postJoin(P, await hs.presentation({ values: { preferences: value }, key: await hs.visitKey(), audience: P.base, pilot: 'agent' }));
        const a = r.json || {};
        const n = (a.not_satisfied || []).find((c) => c.name === 'preferences');
        if (r.status !== 403 || a.outcome !== 'deny' || !n || !/^malformed/.test(n.reason || '') || a.user || reportOf(a)) accepted.push(JSON.stringify(value) + ' -> ' + r.status + ' ' + a.outcome + (reportOf(a) ? ' reported ' + JSON.stringify(reportOf(a)) : ''));
      }
      if (accepted.length) failures.push('wrong shapes not refused as malformed: ' + accepted.join('; '));
      else notes.push(bad.length + ' wrong shapes refused as malformed, none reported as applied');
      // 4. The agent's sample is unchanged, and the agent and the world name the same members.
      if (JSON.stringify(hs.LAB_WALLET.claims.preferences) !== JSON.stringify({ preferred_height_m: 1.85 })) failures.push('the agent\'s sample preferences changed: ' + JSON.stringify(hs.LAB_WALLET.claims.preferences));
      const agentMembers = (hs.PREFERENCE_MEMBERS || []).slice().sort().join(',');
      const worldMembers = Object.keys(handshakeModule.PREFERENCE_MEMBERS || {}).sort().join(',');
      if (!agentMembers || agentMembers !== worldMembers) failures.push('the agent names members [' + agentMembers + '], the world [' + worldMembers + ']');
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : notes.join('; ') + '; the agent and the world name the same ' + worldMembers.split(',').length + ' members' };
    } finally {
      await P.close();
    }
  }, {}, [
    { name: 'a world that still requires the height', impl: H([["    if (known.length === 0) return false;\n", "    if (!known.includes('preferred_height_m')) return false;\n"]]) },
    { name: 'a world that drops reduced_motion silently from the report', impl: H([['                for (const member of Object.keys(accepted.preferences)) applied[member] = outcome !== shared.OUTCOME.DENY && PREFERENCES_APPLIED.includes(member);\n', "                for (const member of Object.keys(accepted.preferences).filter((m) => m !== 'reduced_motion')) applied[member] = outcome !== shared.OUTCOME.DENY && PREFERENCES_APPLIED.includes(member);\n"]]) },
    { name: 'a world that does not shape-check the accessibility members', impl: H([['    return known.every((k) => PREFERENCE_MEMBERS[k](v[k]));\n', '    return true;\n']]) },
    { name: 'a world that reports every received member as applied', impl: H([['                for (const member of Object.keys(accepted.preferences)) applied[member] = outcome !== shared.OUTCOME.DENY && PREFERENCES_APPLIED.includes(member);\n', '                for (const member of Object.keys(accepted.preferences)) applied[member] = outcome !== shared.OUTCOME.DENY;\n']]) },
    { name: 'a world that records no report of what it applied', impl: H([['        ...(answer.osl_preferences_applied ? { osl_preferences_applied : Object.assign({}, answer.osl_preferences_applied) } : {}),\n', '']]) },
  ]);

  // ---- ID10 -------------------------------------------------------------------------------------------
  // The pilot statement (User.pilot): what the visitor states about who is at the controls. Every join carries one;
  // the world copies it onto the User it makes and never supplies one; a client shows hybrid as an agent.
  const pilotPanel = async (user) => {
    // The `?wow=` player's panel (web/wow-handshake-mount.mjs), drawn into a stand-in document, as the page draws it.
    const mount = await import(require('url').pathToFileURL(path.join(ROOT, 'web', 'wow-handshake-mount.mjs')).href);
    const el = { style: {}, setAttribute() {}, remove() {}, innerHTML: '' };
    const doc = { getElementById: () => null, createElement: () => el, body: { appendChild() {} } };
    const run = { result: { base: 'http://127.0.0.1:1/w/q/', world: { identity: { base: 'http://127.0.0.1:1/w/q/' } }, asked: [{ name: 'display_name', required: false }], sent: ['display_name'], refused: null, answer: { outcome: 'proceed', user: 'wow/user/' + user.id } }, record: { outcome: 'proceed', satisfied: [{ name: 'display_name', required: false, trust: 'self-asserted' }], not_satisfied: [] }, user };
    mount.mountHandshakePanel(doc, run, {});
    return String(el.innerHTML || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  };
  await run('ID10', 'the pilot statement (User.pilot): Q asks only for the display name (optional); the agent\'s join always carries a pilot statement; a join stated "agent" yields User.pilot "agent" and one stated "hybrid" User.pilot "hybrid" (read back by GET /wow/user/{id}); a join without a pilot statement, or with another value ("robot", "Human", ""), is answered deny with the reason, recorded, and makes no User (never a silent "human"); the client shows "hybrid" as an agent (pilotShownAs: agent for agent and hybrid), in the user label and in the ?wow= player\'s panel', async (impl) => {
    const failures = [];
    const notes = [];
    const hs = await lab.agent(impl.agent);
    const Q = await lab.handshakeWorld('b', ports.next(), { base: '/w/q', claims: [{ name: 'display_name', required: false }], edits: impl.server });
    const userOf = async (a) => (a && a.user ? (await httpReq('GET', Q.port, '/w/q/' + a.user, null, { Accept: lab.WOW })).json : null);
    try {
      // 1. Agent-piloted and hybrid joins, by the agent: the world copies the statement onto the User.
      const users = {};
      for (const pilot of ['agent', 'hybrid']) {
        const entered = await hs.enterWorld(Q.base, { wallet: { claims: { display_name: pilot === 'agent' ? 'Agent Ada' : 'Hybrid Ada' }, pilot } });
        const received = lab.joinsReceived(Q).slice(-1)[0];
        const carried = received && received.json ? received.json.pilot : undefined;
        if (carried !== pilot) failures.push(`a join stated "${pilot}": the agent sent pilot ${JSON.stringify(carried)}`);
        const user = await userOf(entered.answer);
        users[pilot] = user;
        if (entered.status !== 201 || !user) failures.push(`a join stated "${pilot}": ${entered.status} ${(entered.answer || {}).outcome} "${(entered.answer || {}).reason || ''}"`);
        else if (user.pilot !== pilot) failures.push(`a join stated "${pilot}": User.pilot is ${JSON.stringify(user.pilot)}`);
        else notes.push(`stated "${pilot}": User ${(entered.answer || {}).user} pilot "${user.pilot}"`);
      }
      // 2. No pilot statement, or one of another value: deny with the reason, recorded, no User, nothing defaulted.
      const refused = [];
      for (const [label, pilot] of [['no pilot statement', undefined], ['"robot"', 'robot'], ['"Human"', 'Human'], ['""', '']]) {
        const body = await hs.presentation({ values: { display_name: 'Ada' }, key: await hs.visitKey(), audience: Q.base, pilot: 'agent' });
        if (pilot === undefined) delete body.pilot;
        else body.pilot = pilot;
        const before = (Q.records() || []).length;
        const r = await postJoin(Q, body);
        const a = r.json || {};
        const recorded = recordMatches(Q, a, before);
        if (r.status !== 403 || a.outcome !== 'deny' || !/pilot/.test(a.reason || '') || a.user || recorded) failures.push(`${label}: ${r.status} ${a.outcome} "${a.reason || ''}"${a.user ? ', user ' + a.user : ''}${recorded ? ' (' + recorded + ')' : ''}`);
        else refused.push(`${label}: deny, "${a.reason}"`);
      }
      if (refused.length === 4) notes.push(refused.join('; ') + '; each recorded, no User');
      // 3. The client: hybrid is shown as an agent, in the label and in the player's panel.
      const shown = typeof hs.pilotShownAs === 'function' ? ['agent', 'hybrid', 'human', undefined].map((p) => hs.pilotShownAs(p)) : null;
      if (!shown) failures.push('the client has no pilotShownAs');
      else if (shown[0] !== 'agent' || shown[1] !== 'agent' || shown[2] !== 'human' || shown[3] !== null) failures.push('pilotShownAs gives agent -> ' + shown[0] + ', hybrid -> ' + shown[1] + ', human -> ' + shown[2] + ', none -> ' + shown[3]);
      const hybridUser = users.hybrid && users.hybrid.pilot === 'hybrid' ? users.hybrid : { id: 1, name: 'Hybrid Ada', pilot: 'hybrid' };
      const label = typeof hs.userLabel === 'function' ? hs.userLabel(hybridUser) : null;
      if (!label) failures.push('the client has no user label (userLabel)');
      else if (!/\bagent\b/.test(label) || /human/i.test(label) || label.indexOf(hybridUser.name) === -1) failures.push(`the hybrid user is labelled "${label}"`);
      const panel = await pilotPanel(hybridUser);
      if (!/\bagent\b/.test(panel) || /human/i.test(panel) || panel.indexOf(hybridUser.name) === -1) failures.push(`the player's panel shows the hybrid user as "${panel.slice(0, 200)}"`);
      if (shown && label) notes.push(`the hybrid user is labelled "${label}", in the panel too`);
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : notes.join('; ') };
    } finally {
      await Q.close();
    }
  }, {}, [
    { name: 'a world that omits pilot from the User it makes', impl: H([['                user.pilot = presented.pilot;\n', '']]) },
    { name: 'a client that shows hybrid as human', impl: { agent: [['  return pilot === "agent" || pilot === "hybrid" ? "agent" : pilot === "human" ? "human" : null;\n', '  return pilot === "agent" ? "agent" : pilot === "human" || pilot === "hybrid" ? "human" : null;\n']] } },
    { name: 'a world that takes a join without a pilot statement as human', impl: H([["        if (body.pilot === undefined) return { ok : false, reason : 'no pilot statement (pilot: human, agent or hybrid)' };\n", "        if (body.pilot === undefined) body.pilot = 'human';\n"]]) },
    { name: 'a world that accepts a pilot statement of another value', impl: H([["        if (!PILOTS.includes(body.pilot)) return { ok : false, reason : 'pilot statement malformed: expected human, agent or hybrid' };\n", '']]) },
    { name: 'an agent whose join carries no pilot statement', impl: { agent: [['  return { manifest, proof, pilot };\n', '  return { manifest, proof };\n']] } },
  ]);

  // ---- ID2 --------------------------------------------------------------------------------------------
  await run('ID2', 'self-assertion: a self-asserted age (99) is reported as self-asserted, not verified; at a world that lists no issuer, an age with a credential signed by the visitor\'s own key, or by a key the world does not know, is still self-asserted; a world whose policy requires an issuer for age refuses a self-asserted age with the reason; the same age signed by an issuer the world lists is issuer-verified, and one signed by an unlisted issuer is refused with the reason', async (impl) => {
    const failures = [];
    const hs = await lab.agent();
    const issuer = await lab.labIssuer();
    const stranger = await lab.labIssuer('4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb');
    const C = await lab.handshakeWorld('b', ports.next(), { base: '/w/c', claims: [{ name: 'age', required: true }], edits: impl.server });
    const D = await lab.handshakeWorld('b', ports.next(), { base: '/w/d', claims: [{ name: 'age', required: true, issuers: [issuer.did] }], edits: impl.server });
    try {
      const self = await hs.enterWorld(C.base, { wallet: WALLET });
      const sat = ((self.answer || {}).satisfied || []).find((c) => c.name === 'age');
      if (!sat || sat.trust !== 'self-asserted') failures.push('C reports the self-asserted age as ' + JSON.stringify(sat));
      // At C (no issuer listed), a credential proves nothing about who the issuer is: anyone can make a key.
      const own = await hs.visitKey();
      const selfSigned = await postJoin(C, await hs.presentation({ values: { age: 30 }, key: own, audience: C.base, credentials: { age: own }, pilot: 'agent' }));
      const ss = ((selfSigned.json || {}).satisfied || []).find((c) => c.name === 'age');
      const lastC = lab.joinsReceived(C).slice(-1)[0];
      const selfIssued = lastC && lastC.json && lastC.json.manifest.claims.age && lastC.json.manifest.claims.age.credential;
      if (!selfIssued || selfIssued.issuer !== own.did) failures.push('the harness did not send a credential signed by the visit key');
      if (selfSigned.status !== 201 || !ss || ss.trust !== 'self-asserted') failures.push('C reports an age credential signed by the visitor\'s own key as ' + selfSigned.status + ' ' + JSON.stringify(ss));
      const strangerAtC = await hs.enterWorld(C.base, { wallet: Object.assign({}, WALLET, { claims: Object.assign({}, WALLET.claims, { age: 30 }), credentials: { age: stranger } }) });
      const sc = ((strangerAtC.answer || {}).satisfied || []).find((c) => c.name === 'age');
      if (strangerAtC.status !== 201 || !sc || sc.trust !== 'self-asserted') failures.push('C reports an age credential from a key it does not know as ' + strangerAtC.status + ' ' + JSON.stringify(sc));
      const refused = await hs.enterWorld(D.base, { wallet: WALLET });
      const ra = refused.answer || {};
      const why = (ra.not_satisfied || []).find((c) => c.name === 'age');
      if (refused.status !== 403 || ra.outcome !== 'deny' || !why || !/requires an issuer/.test(why.reason || '') || why.trust !== 'self-asserted') failures.push('D answered ' + refused.status + ' ' + ra.outcome + ' ' + JSON.stringify(why));
      const rec = lastRecord(D);
      if (!rec || rec.outcome !== 'deny' || !rec.not_satisfied.some((c) => c.name === 'age' && /requires an issuer/.test(c.reason))) failures.push('D\'s record: ' + JSON.stringify(rec));
      const issued = await hs.enterWorld(D.base, { wallet: Object.assign({}, WALLET, { claims: Object.assign({}, WALLET.claims, { age: 30 }), credentials: { age: issuer } }) });
      const ia = ((issued.answer || {}).satisfied || []).find((c) => c.name === 'age');
      if (issued.status !== 201 || !ia || ia.trust !== 'issuer-verified') failures.push('an issued age at D: ' + issued.status + ' ' + JSON.stringify(ia));
      const unlisted = await hs.enterWorld(D.base, { wallet: Object.assign({}, WALLET, { claims: Object.assign({}, WALLET.claims, { age: 30 }), credentials: { age: stranger } }) });
      const uw = ((unlisted.answer || {}).not_satisfied || []).find((c) => c.name === 'age');
      if (unlisted.status !== 403 || (unlisted.answer || {}).outcome !== 'deny' || !uw || !/does not accept the issuer/.test(uw.reason || '')) failures.push('an age from an unlisted issuer at D: ' + unlisted.status + ' ' + (unlisted.answer || {}).outcome + ' ' + JSON.stringify(uw));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `C (no issuer listed): age 99 satisfied as "${sat.trust}"; an age credential signed by the visit key itself: "${ss.trust}"; one from a key C does not know: "${sc.trust}"; D (issuer required): deny, "${why.reason}", recorded; age signed by the listed issuer: issuer-verified, proceed; signed by an unlisted issuer: deny, "${uw.reason}"` };
    } finally {
      await C.close();
      await D.close();
    }
  }, {}, [
    { name: 'a world that reports a self-asserted age as verified', impl: H([['        let trust = shared.TRUST.SELF;\n', '        let trust = shared.TRUST.ISSUER;\n']]) },
    { name: 'a world that admits a self-asserted age where it requires an issuer', impl: H([['        if (claim.issuers && trust !== shared.TRUST.ISSUER)\n', '        if (false)\n']]) },
    { name: 'a world that accepts an issuer it does not list', impl: H([['            if (claim.issuers && claim.issuers.indexOf(c.issuer) !== -1) trust = shared.TRUST.ISSUER;\n', '            if (claim.issuers) trust = shared.TRUST.ISSUER;\n']]) },
    { name: 'a world that calls any credential that verifies issuer-verified (its own key, a stranger\'s)', impl: H([['            if (claim.issuers && claim.issuers.indexOf(c.issuer) !== -1) trust = shared.TRUST.ISSUER;\n', '            trust = shared.TRUST.ISSUER;\n']]) },
  ].map((m) => ({ name: m.name, impl: m.impl })));

  // ---- ID4 --------------------------------------------------------------------------------------------
  await run('ID4', 'tampering: a copied manifest fails the holder proof (replayed with its audience and nonce; re-proved by another key; presented to another world); an altered manifest, and a manifest signed by another key than its subject (with a valid holder proof by the subject), fail the integrity check; each refusal is recorded; the lab\'s signing vectors (RFC 8032, RFC 8785, did:key) pass, and an independent computation (node:crypto, own canonical form) verifies what the agent signed', async (impl) => {
    const failures = [];
    const notes = [];
    const hs = await lab.agent();
    const signing = await import(require('url').pathToFileURL(path.join(ROOT, 'web', 'signing', 'index.mjs')).href);
    const B = await lab.handshakeWorld('b', ports.next(), { base: '/w/b', edits: impl.server });
    const A = await lab.handshakeWorld('a', ports.next(), { claims: lab.B_CLAIMS });
    try {
      // The vectors.
      const v = spawnSync(process.execPath, [path.join(ROOT, 'web', 'signing', 'verify-vectors.mjs')], { encoding: 'utf8' });
      const total = /TOTAL: (\d+)\s+PASS: (\d+)\s+FAIL: (\d+)/.exec(v.stdout || '');
      const passes = total ? Number(total[2]) : 0;
      if (v.status !== 0 || !total || Number(total[3]) !== 0 || passes !== Number(total[1]) || passes < 91) failures.push(`signing vectors: exit ${v.status}, ${total ? total[0] : 'no total line'}`);
      else notes.push(`${passes} of ${total[1]} signing vectors pass`);
      // A real join, as captured by B.
      const first = await hs.enterWorld(B.base, { wallet: WALLET });
      if (first.status !== 201) failures.push('the real join: ' + first.status + ' ' + JSON.stringify(first.answer));
      const captured = lab.joinsReceived(B)[0].json;
      // Two computations agree: node:crypto over an independent canonical form verifies the manifest and the proof.
      const canon = (x) => (Array.isArray(x) ? '[' + x.map(canon).join(',') + ']' : x && typeof x === 'object' ? '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}' : JSON.stringify(x));
      const raw = signing.resolveDidKey(captured.manifest.subject).rawPublicKey;
      const pub = nodeCrypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw)]), format: 'der', type: 'spki' });
      const independent = (signed) => {
        const unsigned = Object.assign({}, signed);
        const sig = unsigned.signature;
        delete unsigned.signature;
        return nodeCrypto.verify(null, Buffer.from(canon(unsigned), 'utf8'), pub, Buffer.from(sig.value, 'base64url'));
      };
      const digest = 'sha-256:' + nodeCrypto.createHash('sha256').update(canon(captured.manifest), 'utf8').digest('base64url');
      if (!independent(captured.manifest) || !independent(captured.proof) || digest !== captured.proof.manifest_digest) failures.push('node:crypto does not agree with the lab\'s signing code');
      else notes.push('node:crypto agrees (manifest, proof, digest)');
      const tries = [];
      const expectDeny = async (label, body, pattern) => {
        const before = (B.records() || []).length;
        const r = await postJoin(B, body);
        const rec = lastRecord(B);
        const recorded = (B.records() || []).length === before + 1 && rec && rec.outcome === 'deny';
        if (r.status !== 403 || !r.json || r.json.outcome !== 'deny' || !pattern.test(r.json.reason || '') || !recorded) failures.push(`${label}: ${r.status} ${r.json && r.json.outcome} "${r.json && r.json.reason}"${recorded ? '' : ' (no deny recorded)'}`);
        else tries.push(label);
      };
      // 1. Replayed as captured: same audience, same nonce.
      await expectDeny('a replay', captured, /replay/);
      // 2. The copied manifest re-proved by another holder's key.
      const thief = await hs.visitKey();
      const theirs = await hs.presentation({ values: {}, key: thief, audience: B.base, pilot: 'agent' });
      const reproved = Object.assign({}, theirs.proof);
      delete reproved.signature;
      reproved.manifest_digest = await hs.manifestDigest(captured.manifest);
      await expectDeny('a copy re-proved by another key', { manifest: captured.manifest, proof: await signing.attachSignatureProfileA(reproved, thief.privateKey, { created: null }) }, /not signed by the manifest subject/);
      // 3. A join made for world A, presented to B.
      const key = await hs.visitKey();
      const forA = await hs.presentation({ values: { avatar: WALLET.claims.avatar, preferences: WALLET.claims.preferences }, key, audience: A.base, pilot: 'agent' });
      await expectDeny('a join made for another world', forA, /it was made for http/);
      // 4. An altered manifest: another avatar written in after signing.
      const k2 = await hs.visitKey();
      const fresh = await hs.presentation({ values: { avatar: WALLET.claims.avatar, preferences: WALLET.claims.preferences }, key: k2, audience: B.base, pilot: 'agent' });
      const altered = JSON.parse(JSON.stringify(fresh));
      altered.manifest.claims.avatar.value.uri = 'http://127.0.0.1:1/assets/someone-else.glb';
      await expectDeny('an altered manifest', altered, /^integrity check failed/);
      // 5. A manifest whose subject is key 1 but whose signature is key 2's, with a valid holder proof by key 1
      //    over that manifest's digest: only the integrity check can refuse it.
      const k3 = await hs.visitKey();
      const k4 = await hs.visitKey();
      const wrongSigner = await signing.attachSignatureProfileA({ type: hs.MANIFEST_TYPE, label: hs.LABEL, subject: k3.did, claims: { avatar: { value: WALLET.claims.avatar }, preferences: { value: WALLET.claims.preferences } } }, k4.privateKey, { created: null });
      const subjectProof = await signing.attachSignatureProfileA({ type: hs.HOLDER_PROOF_TYPE, audience: B.base, nonce: nodeCrypto.randomBytes(32).toString('base64url'), created: new Date().toISOString(), manifest_digest: await hs.manifestDigest(wrongSigner) }, k3.privateKey, { created: null });
      await expectDeny('a manifest signed by another key than its subject', { manifest: wrongSigner, proof: subjectProof }, /^integrity check failed/);
      // The unaltered one still enters (its nonce is fresh).
      const ok = await postJoin(B, fresh);
      if (ok.status !== 201) failures.push('the unaltered manifest: ' + ok.status + ' ' + JSON.stringify(ok.json && ok.json.reason));
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : notes.join('; ') + '; denied and recorded: ' + tries.join(', ') + '; the unaltered manifest enters' };
    } finally {
      await B.close();
      await A.close();
    }
  }, {}, [
    { name: 'a world that lets a copied manifest replayed with its original audience and nonce pass', impl: H([["        if (seenNonces.has(proof.nonce)) return { ok : false, reason : 'holder proof failed: its nonce was already used (a replay)' };\n", '']]) },
    { name: 'a world that skips the integrity check', impl: H([["        if (!integrity.ok) return { ok : false, reason : 'integrity check failed: ' + integrity.reason };\n", '']]) },
    { name: 'a world that accepts a holder proof signed by another key', impl: H([["        if (!held.ok) return { ok : false, reason : 'holder proof failed: not signed by the manifest subject (' + held.reason + ')' };\n", '']]) },
    { name: 'a world that accepts a holder proof made for another world', impl: H([["        if (!sameBase(proof.audience, spec.base)) return { ok : false, reason : 'holder proof failed: it was made for ' + proof.audience + ', not this world' };\n", '']]) },
  ]);

  // ---- ID7 --------------------------------------------------------------------------------------------
  const oneKey = { agent: [['  const key = await visitKey();\n', '  const key = globalThis.__oslOneKey || (globalThis.__oslOneKey = await visitKey());\n']] };
  const pointerInReferer = { agent: [['    headers: { "Content-Type": "application/json", Accept: "application/wow+json, application/json" },\n', '    headers: { "Content-Type": "application/json", Accept: "application/wow+json, application/json", Referer: base + "?visitor=" + encodeURIComponent(key.did) },\n']] };
  const pointerInUrl = { agent: [['  const r = await f(new URL("wow/user", base).href, {\n', '  const r = await f(new URL("wow/user?visitor=" + encodeURIComponent(key.did), base).href, {\n']] };
  await run('ID7', 'no tracking (UC04-R14): the same visitor entering A and then B gives them different pointers (did:key subjects), signatures and proof values, a new pointer on each visit, and no pointer in any URL or Referer header either world received', async (impl) => {
    const failures = [];
    delete globalThis.__oslOneKey;
    const hs = await lab.agent(impl.agent);
    const A = await lab.handshakeWorld('a', ports.next(), { claims: lab.B_CLAIMS });
    const B = await lab.handshakeWorld('b', ports.next(), { base: '/w/b' });
    try {
      await hs.enterWorld(A.base, { wallet: WALLET });
      await hs.enterWorld(B.base, { wallet: WALLET });
      await hs.enterWorld(B.base, { wallet: WALLET });
      const ja = lab.joinsReceived(A).map((j) => j.json);
      const jb = lab.joinsReceived(B).map((j) => j.json);
      if (ja.length !== 1 || jb.length !== 2 || ja.concat(jb).some((j) => !j)) return { ok: false, detail: `A received ${ja.length} joins and B ${jb.length}` };
      const pointers = ja.concat(jb).map((j) => j.manifest.subject);
      if (new Set(pointers).size !== 3) failures.push('pointers repeat: ' + pointers.map((p) => p.slice(0, 20)).join(', '));
      const values = (j) => [j.manifest.signature.value, j.proof.signature.value, j.proof.nonce];
      const va = new Set(values(ja[0]));
      if (jb.some((j) => values(j).some((x) => va.has(x)))) failures.push('a signature, proof or nonce value reaches both worlds');
      const leaks = [];
      for (const [name, world] of [['A', A], ['B', B]]) {
        for (const e of world.log) {
          for (const p of pointers) {
            const needle = p.slice('did:key:'.length);
            if ((e.url && decodeURIComponent(e.url).includes(needle)) || (e.referer && decodeURIComponent(e.referer).includes(needle))) leaks.push(`${name} ${e.method} ${e.url.slice(0, 60)}`);
          }
        }
      }
      if (leaks.length) failures.push('a pointer in a URL or Referer: ' + leaks.slice(0, 2).join('; '));
      const requests = A.log.length + B.log.length;
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `3 joins, 3 different pointers; no signature, proof or nonce value shared; ${requests} requests logged, none with a pointer in its URL or Referer` };
    } finally {
      await A.close();
      await B.close();
    }
  }, {}, [
    { name: 'an agent that sends the same pointer (continuity id) to A and B', impl: oneKey },
    { name: 'an agent that puts the pointer in the join URL', impl: pointerInUrl },
    { name: 'an agent that sends the pointer in the join\'s Referer header', impl: pointerInReferer },
  ]);
}

module.exports = { handshakeChecks };
