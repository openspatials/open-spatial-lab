'use strict';

/*
 * Iteration 5, the contribution to the Web of Worlds files (stage A: the World API overlay only; no user
 * manifest overlay yet).
 *
 *   W1  the iteration 5 patch applies to the World API at main after iterations 1 to 4, and the patched
 *       World API passes the OpenAPI 3.0 schema, declares every path parameter and resolves every $ref; on both
 *       GeoPose forms of iteration 1
 *   W2  the text offered (on both forms), the lab's contract (wow-spec/schema.yaml) and what the world server
 *       does on the wire say the same thing: World.identity, World.claims, World.issues, POST /wow/user with its
 *       body and answer, the joining paragraph, and beside it the following and departing paragraphs and the
 *       DELETE /wow/user/{userId} text; on the event stream a proceeding join sends user_joined and its depart
 *       user_left (the wire, not only the text); User.pilot, and on the wire GET /wow/user/{id} carries the pilot
 *       the join stated, and a join without a pilot statement proceeds and its User reads pilot "unstated".
 *       The served contract is compared as later iterations leave it: a JoinAnswer member or a POST /wow/user status
 *       that a later overlay (iteration 6 or above, read from wow-spec/overlays/) adds is not counted as a difference
 *       for iteration 5; any other addition still is
 *   W3  the conformance vocabulary of iteration 5: the World API after iteration 5 still carries the BCP 14
 *       paragraph once; the joining paragraph makes joining opt-in (OPTIONAL for a world; a world that states
 *       identity MUST also state claims and issues; a world that states no identity takes no joins and the
 *       paragraph does not apply to it) and states no rule that every world states identity, claims and issues,
 *       offered on both forms and served; each normative sentence iteration 5 adds (the joining paragraph, World.identity,
 *       World.claims, World.issues, POST /wow/user, UserJoin, JoinAnswer and its trust rule, and the following and
 *       departing paragraphs and DELETE /wow/user/{userId} beside the join, the pilot statement in UserJoin and
 *       User.pilot, a join without one not refused for that alone, recorded and shown as not stated, never as
 *       human) uses a key word; World and World.identity carry no required member, UserJoin [manifest, proof],
 *       JoinAnswer [outcome,
 *       satisfied, not_satisfied], and the World.claims items and JoinAnswer's satisfied and not_satisfied items
 *       [name, required]; the offer on both GeoPose forms, the served contract and its build say the same; every
 *       document that uses key words (the World API and this overlay's README.md) carries the BCP 14 paragraph
 *       exactly once
 *   W4  neutral wording: no added line of any overlay of iterations 1 to 5, in either GeoPose form (the lines a
 *       patch adds, and every line of an overlay README.md), names the Universal Manifest, OpenSpatials, the Lab
 *       (Open Spatial Lab, OSL), an x-osl label or a person
 */

const fs = require('fs');
const path = require('path');
const { ROOT, run, staleEdit } = require('../arch-i1/lib');
const up = require('../arch-i1/upstream');
const words = require('../arch-i1/conformance-words');
const { openApiValidator, eachForm, swap } = require('../arch-i2/checks-overlay');
const { loadIteration4 } = require('../arch-i4/checks-overlay');
const lab = require('./lab');
const { joinWire } = require('../wow-conformance/wire-checks');

const OVERLAY_5 = path.join(ROOT, 'wow-spec', 'overlays', 'iteration-5');
const PARAGRAPHS = ['Joining.'];

/** An exact edit of the patch text; one that no longer matches exactly once is stale (a harness error). */
function patchEdit(from, to) {
  return (p) => {
    const count = p.split(from).length - 1;
    if (count !== 1) throw staleEdit('wow-spec/overlays/iteration-5/OpenSpatialWorld.API.yaml.patch', from, count);
    return p.replace(from, () => to);
  };
}

/**
 * The World API with iterations 1 to 5 applied, on the GeoPose form `form` of iteration 1 (with, the default, or
 * without); `edits` may change the iteration 5 patch first, and `edits.four` the earlier ones as loadIteration4 takes them.
 */
function loadIteration5(edits, form) {
  edits = edits || {};
  const four = loadIteration4(edits.four || null, form);
  let patch = up.read(path.join(OVERLAY_5, 'OpenSpatialWorld.API.yaml.patch'));
  if (edits['OpenSpatialWorld.API.yaml.patch']) patch = edits['OpenSpatialWorld.API.yaml.patch'](patch);
  const worldText = up.applyUnifiedDiff(four.worldText, patch);
  return { world: up.yaml.load(worldText), worldText };
}

/** What iteration 5 says, read from one API description. */
function iteration5Text(doc) {
  const canon = (n) => (n === undefined ? null : JSON.parse(JSON.stringify(up.withoutLabels(n), (k, v) => (k === 'description' && typeof v === 'string' ? up.squash(v) : v))));
  const schemas = doc.components.schemas;
  const paragraphs = String((doc.info || {}).description || '').split(/\n\s*\n/).map(up.squash);
  const post = ((doc.paths || {})['/wow/user'] || {}).post || {};
  return {
    worldIdentity: canon(schemas.World.properties.identity),
    worldClaims: canon(schemas.World.properties.claims),
    worldIssues: canon(schemas.World.properties.issues),
    userJoin: canon(schemas.UserJoin),
    joinAnswer: canon(schemas.JoinAnswer),
    joinDescription: post.description ? up.squash(post.description) : null,
    joinStatuses: Object.keys(post.responses || {}).sort().join(',') || null,
    paragraphs: PARAGRAPHS.map((start) => paragraphs.find((p) => p.startsWith(start)) || null),
  };
}

const OVERLAYS_ROOT = path.join(ROOT, 'wow-spec', 'overlays');
/** The later iterations (6 and above) whose overlay folder exists, in order. */
function laterIterations() {
  return fs.readdirSync(OVERLAYS_ROOT).map((d) => /^iteration-(\d+)$/.exec(d)).filter((m) => m && Number(m[1]) >= 6).map((m) => Number(m[1])).sort((a, b) => a - b);
}
/**
 * What later overlays (iteration 6 and above) add to the points iteration5Text compares: the JoinAnswer members and
 * the POST /wow/user statuses. Read by applying each later overlay's World API patch, in order, on the unedited
 * iteration 5 text of form `form` (a folder's without-rotation-sentences patch serves the without-form when it has one).
 */
function laterAdditions(form) {
  const five = loadIteration5(null, form);
  let text = five.worldText;
  for (const n of laterIterations()) {
    const dir = path.join(OVERLAYS_ROOT, 'iteration-' + n);
    const own = path.join(dir, 'without-rotation-sentences', 'OpenSpatialWorld.API.yaml.patch');
    const file = form === 'without' && fs.existsSync(own) ? own : path.join(dir, 'OpenSpatialWorld.API.yaml.patch');
    if (fs.existsSync(file)) text = up.applyUnifiedDiff(text, up.read(file));
  }
  const later = up.yaml.load(text);
  const members = (doc) => Object.keys((((doc.components || {}).schemas || {}).JoinAnswer || {}).properties || {});
  const statuses = (doc) => Object.keys((((doc.paths || {})['/wow/user'] || {}).post || {}).responses || {});
  const before = { members: members(five.world), statuses: statuses(five.world) };
  return {
    members: members(later).filter((m) => !before.members.includes(m)),
    statuses: statuses(later).filter((s) => !before.statuses.includes(s)),
  };
}
/** A copy of the served contract without what later overlays add to iteration 5's points (laterAdditions). */
function withoutLaterAdditions(contract, additions) {
  const doc = JSON.parse(JSON.stringify(contract));
  const answer = ((doc.components || {}).schemas || {}).JoinAnswer;
  for (const m of additions.members) if (answer && answer.properties) delete answer.properties[m];
  const post = ((doc.paths || {})['/wow/user'] || {}).post;
  for (const s of additions.statuses) if (post && post.responses) delete post.responses[s];
  return doc;
}

/** The follow and depart text iteration 5 puts beside the join, read from one API description; null where it is absent. */
function sessionText(doc) {
  const paragraphs = String((doc.info || {}).description || '').split(/\n\s*\n/).map(up.squash);
  const del = ((((doc.paths || {})['/wow/user/{userId}'] || {}).delete) || {}).description;
  return {
    followParagraph: paragraphs.find((p) => p.startsWith('Following.')) || null,
    departParagraph: paragraphs.find((p) => p.startsWith('Departing.')) || null,
    deleteDescription: del ? up.squash(del) : null,
  };
}

/** The pilot statement iteration 5 adds to the User (User.pilot), read from one API description; null where it is absent. */
function pilotText(doc) {
  const user = ((doc.components || {}).schemas || {}).User || {};
  const pilot = (user.properties || {}).pilot;
  return { userPilot: pilot === undefined ? null : JSON.stringify(up.withoutLabels(pilot), (k, v) => (k === 'description' && typeof v === 'string' ? up.squash(v) : v)) };
}

async function overlayChecks(ports) {
  // ---- W1 ---------------------------------------------------------------------------------------------
  const staleContext = { edits: { 'OpenSpatialWorld.API.yaml.patch': patchEdit('         default:\n           description: Unexpected error\n+  /wow/user:', '         default:\n           description: An unexpected error\n+  /wow/user:') } };
  const badType = { edits: { 'OpenSpatialWorld.API.yaml.patch': patchEdit('+              required:\n+                type: boolean\n+              issuers:', '+              required:\n+                type: flag\n+              issuers:') } };
  await run('W1', 'the iteration 5 patch applies to the World API at main after iterations 1 to 4, and the patched World API passes the OpenAPI 3.0 schema with every path parameter declared and every $ref resolving', async (impl) => {
    const failures = [];
    eachForm(failures, (form) => {
      const out = loadIteration5(impl.edits, form);
      const validate = openApiValidator();
      if (!validate(out.world)) failures.push(form + '-form: OpenAPI 3.0 schema: ' + validate.errors.slice(0, 2).map((e) => e.instancePath + ' ' + e.message).join('; '));
      const params = up.pathParameterProblems(out.world);
      if (params.length) failures.push(form + '-form: ' + params[0]);
      const refs = up.refProblems(out.world);
      if (refs.length) failures.push(form + '-form: ' + refs[0]);
      const text = iteration5Text(out.world);
      for (const [key, value] of Object.entries(text)) if (!value || (Array.isArray(value) && value.some((x) => !x))) failures.push(form + '-form: ' + key + ' is missing');
    });
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'on both GeoPose forms the patch applies after iterations 1 to 4; the World API passes the OpenAPI 3.0 schema with no path parameter or $ref problem; World.identity, World.claims, World.issues, POST /wow/user (UserJoin, JoinAnswer; 201, 400, 403, 404) and the joining paragraph are there' };
  }, {}, [
    { name: 'a patch whose context no longer matches iteration 4\'s text', impl: staleContext },
    { name: 'a patch that is not valid OpenAPI (type: flag)', impl: badType },
  ]);

  // ---- W2 ---------------------------------------------------------------------------------------------
  const offerDrifts = { edits: { 'OpenSpatialWorld.API.yaml.patch': patchEdit('+        satisfied, an optional claim not satisfied MUST give proceed-in-part. Otherwise the outcome MUST be\n', '+        satisfied, an optional claim not satisfied MUST give proceed. Otherwise the outcome MUST be\n') } };
  const worldWithoutIdentity = { server: { handshake: [["            identity : { base : spec.base, ...(spec.label ? { label : spec.label } : {}) },\n", '']] } };
  const offerWithoutFollow = { edits: { 'OpenSpatialWorld.API.yaml.patch': patchEdit('+    Following. ', '+    Tracking. ') } };
  const joinSendsNoUserJoined = { server: { handshake: [["                emitEvent({ type : 'user_joined', user : Object.assign({}, user), urls : [ 'wow/user/' + id ] });\n", '']] } };
  const departSendsNoUserLeft = { server: { handshake: [["        emitEvent({ type : 'user_left', userId : key, user : { id : key, name : user.name }, urls : [ 'wow/user/' + key ] });\n", '']] } };
  const offerPilotDrifts = { edits: { 'OpenSpatialWorld.API.yaml.patch': patchEdit('+            MUST show a user whose pilot is hybrid as an agent', '+            MAY show a user whose pilot is hybrid as an agent') } };
  const userWithoutPilot = { server: { handshake: [['                user.pilot = presented.pilot;\n', '']] } };
  const offerUnstatedDrifts = { edits: { 'OpenSpatialWorld.API.yaml.patch': patchEdit('+            MUST NOT treat that user as human.', '+            MAY treat that user as human.') } };
  const contractAddsJoinAnswerMember = { mutateContract: (doc) => { doc.components.schemas.JoinAnswer.properties.welcome = { type: 'string', description: 'A greeting for the visitor.' }; } };
  const serverDefaultsHuman = { server: { handshake: [["        if (body.pilot === undefined) return { ok : true, reason : null, pilot : UNSTATED };\n", "        if (body.pilot === undefined) return { ok : true, reason : null, pilot : 'human' };\n"]] } };
  await run('W2', 'the offered text and the lab\'s contract agree on World.identity, World.claims, World.issues, UserJoin, JoinAnswer, the join operation, the joining paragraph, and the following and departing text beside it (two paragraphs and DELETE /wow/user/{userId}); on the wire the World states identity, claims and issues, POST /wow/user answers with a JoinAnswer the contract accepts (201 and 403), the proceeding join sends one user_joined for its User on the event stream and the denied one none, and DELETE of that User sends one user_left for it; the offer and the contract agree on User.pilot, and on the wire GET /wow/user/{id} of the proceeding join carries the pilot it stated; a join without a pilot statement proceeds (201) and GET /wow/user/{id} of its User reads pilot "unstated"', async (impl) => {
    const failures = [];
    const contract = up.yaml.load(up.read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    if (impl.mutateContract) impl.mutateContract(contract);
    const bs = sessionText(contract);
    for (const [key, value] of Object.entries(bs)) if (!value) failures.push('the lab contract: ' + key + ' is missing');
    const bp = pilotText(contract);
    for (const [key, value] of Object.entries(bp)) if (!value) failures.push('the lab contract: ' + key + ' is missing');
    let later = null;
    eachForm(failures, (form) => {
      const additions = laterAdditions(form);
      if (form === 'with') later = additions;
      const b = iteration5Text(withoutLaterAdditions(contract, additions));
      const offered = loadIteration5(impl.edits, form).world;
      const a = iteration5Text(offered);
      for (const key of Object.keys(a)) if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) failures.push(form + '-form: ' + key + ' differs between the offer and the lab contract');
      const as = sessionText(offered);
      for (const key of Object.keys(as)) {
        if (!as[key]) failures.push(form + '-form: the offer has no ' + key);
        else if (as[key] !== bs[key]) failures.push(form + '-form: ' + key + ' differs between the offer and the lab contract');
      }
      const ap = pilotText(offered);
      for (const key of Object.keys(ap)) {
        if (!ap[key]) failures.push(form + '-form: the offer has no ' + key);
        else if (ap[key] !== bp[key]) failures.push(form + '-form: ' + key + ' differs between the offer and the lab contract');
      }
    });
    // On the wire (the wire half is shared with the conformance corpus: tools/wow-conformance/wire-checks.js joinWire).
    const hs = await lab.agent();
    const B = await lab.handshakeWorld('b', ports.next(), { base: '/w/b', edits: impl.server });
    try {
      const wallet = { claims: { avatar: { uri: 'http://127.0.0.1:1/a.glb' }, preferences: { preferred_height_m: 1.7 } } };
      const r = await joinWire(B.base, { agent: hs, wallet, withholds: [[], ['preferences']], expectStatuses: '201,403', pilot: 'agent', eventsUrl: B.base + 'events', requireValidationHeader: true });
      failures.push(...r.problems);
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'offer (both GeoPose forms) = lab contract on 12 points (with the following and departing paragraphs, the DELETE /wow/user/{userId} text and User.pilot; not counted, as later overlays add them: JoinAnswer ' + (later && later.members.length ? later.members.join(', ') : 'none') + ', POST /wow/user ' + (later && later.statuses.length ? later.statuses.join(', ') : 'none') + '); on the wire: the World states identity, claims and issues (pass:OSLWorldResponse); the joins answered ' + r.statuses.join(' and ') + '; the event stream carried ' + r.wire };
    } finally {
      await B.close();
    }
  }, {}, [
    { name: 'an offer whose outcome rule drifted from the contract', impl: offerDrifts },
    { name: 'a server whose World states no identity', impl: worldWithoutIdentity },
    { name: 'an offer without the following paragraph', impl: offerWithoutFollow },
    { name: 'a server whose proceeding join sends no user_joined', impl: joinSendsNoUserJoined },
    { name: 'a server whose depart sends no user_left', impl: departSendsNoUserLeft },
    { name: 'an offer whose User.pilot text drifted from the contract (hybrid shown as an agent: MAY)', impl: offerPilotDrifts },
    { name: 'a server whose User carries no pilot', impl: userWithoutPilot },
    { name: 'an offer whose User.pilot text drifted from the contract (an unstated user treated as human: MAY)', impl: offerUnstatedDrifts },
    { name: 'a server that defaults a missing pilot statement to human', impl: serverDefaultsHuman },
    { name: 'a served contract whose JoinAnswer has a member no later overlay adds', impl: contractAddsJoinAnswerMember },
  ]);

  await vocabularyCheck();
  await neutralWordingCheck();
}

// ---------------------------------------------------------------------------------------------------
// W3, the conformance vocabulary of iteration 5.

/**
 * The `required` list of each schema iteration 5 touches, by a name for where it sits. World keeps no required
 * member, and neither does World.identity (a world states it, but the World stays valid without it). UserJoin
 * requires the manifest and the proof, JoinAnswer the outcome and both claim lists, and each claim item (asked
 * for in World.claims, or answered in JoinAnswer) its name and whether it is required.
 */
const REQUIRED_I5 = {
  World: [],
  'World.identity': [],
  'World.claims items': ['name', 'required'],
  UserJoin: ['manifest', 'proof'],
  JoinAnswer: ['outcome', 'satisfied', 'not_satisfied'],
  'JoinAnswer.satisfied items': ['name', 'required'],
  'JoinAnswer.not_satisfied items': ['name', 'required'],
};
/** The schemas REQUIRED_I5 names, read from one document's components.schemas. */
function listedSchemas(schemas) {
  const s = schemas || {};
  const prop = (schema, name) => (((schema || {}).properties || {})[name]) || undefined;
  const items = (schema) => (schema && schema.items) || undefined;
  return {
    World: s.World,
    'World.identity': prop(s.World, 'identity'),
    'World.claims items': items(prop(s.World, 'claims')),
    UserJoin: s.UserJoin,
    JoinAnswer: s.JoinAnswer,
    'JoinAnswer.satisfied items': items(prop(s.JoinAnswer, 'satisfied')),
    'JoinAnswer.not_satisfied items': items(prop(s.JoinAnswer, 'not_satisfied')),
  };
}

const schemaText5 = (name, prop) => (doc) => (prop ? doc.components.schemas[name].properties[prop] : doc.components.schemas[name]).description;
const para5 = (start) => (doc) => String((doc.info || {}).description || '').split(/\n\s*\n/).map(up.squash).find((p) => p.startsWith(start)) || '';
const joinText = (doc) => ((((doc.paths || {})['/wow/user'] || {}).post) || {}).description;
const deleteText = (doc) => ((((doc.paths || {})['/wow/user/{userId}'] || {}).delete) || {}).description;
const trustText = (doc) => doc.components.schemas.JoinAnswer.properties.satisfied.items.properties.trust.description;
/** The normative sentences iteration 5 adds to the World API. Each anchor is a phrase of the sentence, found before and after the key words. */
const SENTENCES_I5 = [
  { where: 'info.description (joining is optional for a world)', text: para5('Joining.'), anchor: 'OPTIONAL for a world' },
  { where: 'info.description (a world that states identity also states claims and issues)', text: para5('Joining.'), anchor: 'who it is' },
  { where: 'info.description (the agent reads the World resource from that base URL)', text: para5('Joining.'), anchor: 'read the World resource' },
  { where: 'info.description (the agent checks identity.base first)', text: para5('Joining.'), anchor: 'identity.base is that base URL' },
  { where: 'info.description (only then it joins)', text: para5('Joining.'), anchor: 'Only then' },
  { where: 'info.description (only the claims asked for)', text: para5('Joining.'), anchor: 'in a signed manifest' },
  { where: 'info.description (the answer states the outcome)', text: para5('Joining.'), anchor: 'proceed-in-part or deny' },
  { where: 'info.description (a world records every outcome)', text: para5('Joining.'), anchor: 'record every outcome' },
  { where: 'info.description (the answer grants no permission)', text: para5('Joining.'), anchor: 'permission' },
  { where: 'info.description (nothing about the visitor in a URL)', text: para5('Joining.'), anchor: 'in a URL' },
  { where: 'info.description (made for one world and one visit)', text: para5('Joining.'), anchor: 'another world' },
  { where: 'World.identity (checked before disclosure)', text: schemaText5('World', 'identity'), anchor: 'before it discloses' },
  { where: 'World.claims (the agent sends only these)', text: schemaText5('World', 'claims'), anchor: 'only these' },
  { where: 'World.claims (issuers)', text: schemaText5('World', 'claims'), anchor: 'one of those issuers' },
  { where: 'World.issues (may be empty)', text: schemaText5('World', 'issues'), anchor: 'empty' },
  { where: 'POST /wow/user (only the claims asked for)', text: joinText, anchor: 'holding only the claims' },
  { where: 'POST /wow/user (a world records every outcome)', text: joinText, anchor: 'every outcome' },
  { where: 'POST /wow/user (the answer grants no permission)', text: joinText, anchor: 'permission' },
  { where: 'POST /wow/user (nothing about the visitor in a URL)', text: joinText, anchor: 'in a URL' },
  { where: 'UserJoin (the manifest carries only the claims asked for)', text: schemaText5('UserJoin'), anchor: 'carries only the claims' },
  { where: 'UserJoin (the holder proof)', text: schemaText5('UserJoin'), anchor: 'controls the manifest' },
  { where: 'JoinAnswer (a required claim not satisfied)', text: schemaText5('JoinAnswer'), anchor: 'A required claim not satisfied' },
  { where: 'JoinAnswer (an optional claim not satisfied)', text: schemaText5('JoinAnswer'), anchor: 'optional claim not satisfied' },
  { where: 'JoinAnswer (each claim listed once)', text: schemaText5('JoinAnswer'), anchor: 'listed once' },
  { where: 'JoinAnswer (the answer grants no permission)', text: schemaText5('JoinAnswer'), anchor: 'permission' },
  { where: 'JoinAnswer trust (a credential from another issuer)', text: trustText, anchor: 'any other issuer' },
  { where: 'info.description (#follow joins as a new or existing user)', text: para5('Following.'), anchor: 'new or existing user' },
  { where: 'info.description (the follow verb is matched case-insensitively)', text: para5('Following.'), anchor: 'case-insensitively' },
  { where: 'info.description (#follow=user.{id} places the visitor at that user\'s node and keeps it there)', text: para5('Following.'), anchor: 'keep the visitor there' },
  { where: 'info.description (a followed user no longer present)', text: para5('Following.'), anchor: 'no longer present' },
  { where: 'info.description (DELETE /wow/user/{userId} ends the visit)', text: para5('Departing.'), anchor: 'end that user' },
  { where: 'info.description (user_left once on the event stream)', text: para5('Departing.'), anchor: 'user_left' },
  { where: 'info.description (the join record stays)', text: para5('Departing.'), anchor: 'record' },
  { where: 'DELETE /wow/user/{userId} (the user no longer present)', text: deleteText, anchor: 'no longer be present' },
  { where: 'DELETE /wow/user/{userId} (user_left once)', text: deleteText, anchor: 'user_left' },
  { where: 'DELETE /wow/user/{userId} (the join record stays)', text: deleteText, anchor: 'record' },
  { where: 'UserJoin (the pilot statement)', text: schemaText5('UserJoin'), anchor: 'statement of who is at the controls' },
  { where: 'UserJoin (a join without a pilot statement is not refused for that alone)', text: schemaText5('UserJoin'), anchor: 'without a pilot statement' },
  { where: 'UserJoin (a pilot statement of another value is denied)', text: schemaText5('UserJoin'), anchor: 'present with another value' },
  { where: 'UserJoin (recorded and shown as not stated)', text: schemaText5('UserJoin'), anchor: 'record and show that join as not stated' },
  { where: 'UserJoin (not treated as human)', text: schemaText5('UserJoin'), anchor: 'not treat it as human' },
  { where: 'User.pilot (unstated for a join without a pilot statement)', text: schemaText5('User', 'pilot'), anchor: 'set it to unstated' },
  { where: 'User.pilot (an unstated user not treated as human)', text: schemaText5('User', 'pilot'), anchor: 'treat that user as human' },
  { where: 'User.pilot (unstated shown as not stated)', text: schemaText5('User', 'pilot'), anchor: 'unstated as not stated' },
  { where: 'User.pilot (copied from the join)', text: schemaText5('User', 'pilot'), anchor: 'copy it from the join' },
  { where: 'User.pilot (the visitor\'s statement, not proof)', text: schemaText5('User', 'pilot'), anchor: 'not as proof' },
  { where: 'User.pilot (hybrid shown as an agent)', text: schemaText5('User', 'pilot'), anchor: 'hybrid as an agent' },
];
/**
 * Joining is opt-in: the sentences the joining paragraph carries for that, and the rule for every world it must not
 * carry (a world that states no identity takes no joins, so a rule that every world states them contradicts it).
 */
const JOINING_OPT_IN = [
  { what: 'makes joining OPTIONAL for a world', re: /(?:^|\. )Joining is OPTIONAL for a world\./ },
  { what: 'requires a world that states identity to MUST also state claims and issues', re: /(?:^|\. )A world that states who it is in its World resource \(identity[^)]*\) MUST also state the claims it asks a visitor for \(claims[^)]*\) and the credential types it issues \(issues[^)]*\)\./ },
  { what: 'says that a world that states no identity takes no joins and the paragraph does not apply to it', re: /(?:^|\. )A world that states no identity takes no joins, and the rules of this paragraph do not apply to it\./ },
];
const EVERY_WORLD = /\bA world MUST state in its World resource\b/;
/** The opt-in problems of one document's joining paragraph. */
function optInProblems(doc, label) {
  const text = para5('Joining.')(doc);
  if (!text) return [label + ' joining paragraph: missing'];
  const problems = [];
  for (const { what, re } of JOINING_OPT_IN) if (!re.test(text)) problems.push(label + ' joining paragraph: no sentence that ' + what);
  if (EVERY_WORLD.test(text)) problems.push(label + ' joining paragraph: states identity, claims and issues as a rule for every world ("A world MUST state in its World resource")');
  return problems;
}
const GENERATED = path.join(ROOT, 'wow-spec', 'generated', 'schema.json');
const OVERLAY_README_5 = path.join(OVERLAY_5, 'README.md');
/** How many times a text carries the BCP 14 paragraph. */
const bcp14Count = (text) => up.squash(text || '').split(up.squash(words.BCP14)).length - 1;
/**
 * A document that uses key words must carry the BCP 14 paragraph exactly once. `paragraphText` is where the
 * paragraph is counted when it differs from the text (the World API's parsed info.description: its YAML escapes quotes).
 */
function paragraphProblems(text, label, paragraphText) {
  const used = words.keywordCount(text);
  const n = bcp14Count(paragraphText === undefined ? text : paragraphText);
  return used && n !== 1 ? [label + ': ' + used + ' key words and the BCP 14 paragraph ' + n + ' times, wanted once'] : [];
}

async function vocabularyCheck() {
  const W5P = 'wow-spec/overlays/iteration-5/OpenSpatialWorld.API.yaml.patch';
  const W2P = 'wow-spec/overlays/iteration-2/OpenSpatialWorld.API.yaml.patch';
  const API = 'OpenSpatialWorld.API.yaml.patch';
  const names = Object.keys(REQUIRED_I5);
  const joiningWithoutKeyword = { edits: { [API]: (p) => swap(p, 'it MUST check that identity.base is that base URL', 'it checks that identity.base is that base URL', W5P) }, expect: /^with-form: offered World API after iteration 5 info\.description \(the agent checks identity\.base first\): .* has no key word/ };
  const identityWithoutKeyword = { edits: { [API]: (p) => swap(p, '+            Who this world is: the base URL it stands behind. A visitor\'s agent MUST check that it is the base\n', '+            Who this world is: the base URL it stands behind. A visitor\'s agent checks that it is the base\n', W5P) }, expect: /^with-form: offered World API after iteration 5 World\.identity \(checked before disclosure\): .* has no key word/ };
  const userJoinWithoutList = { mutateOffered: (doc) => { delete doc.components.schemas.UserJoin.required; }, expect: /^with-form: offered World API after iteration 5 UserJoin has no required list/ };
  const claimItemsWithoutList = { mutateOffered: (doc) => { delete doc.components.schemas.World.properties.claims.items.required; }, expect: /^with-form: offered World API after iteration 5 World\.claims items has no required list/ };
  const worldWithRequired = { mutateOffered: (doc) => { doc.components.schemas.World.required = ['identity']; }, expect: /^with-form: offered World API after iteration 5 World has required \["identity"\], wanted no required member/ };
  const unstatedWithoutKeyword = { edits: { [API]: (p) => swap(p, 'It MUST NOT treat it as human.', 'It does not treat it as human.', W5P) }, expect: /^with-form: offered World API after iteration 5 UserJoin \(not treated as human\): .* has no key word/ };
  const pilotWithoutKeyword = { edits: { [API]: (p) => swap(p, 'A client\n+            MUST show a user whose pilot is hybrid as an agent', 'A client\n+            shows a user whose pilot is hybrid as an agent', W5P) }, expect: /^with-form: offered World API after iteration 5 User\.pilot \(hybrid shown as an agent\): .* has no key word/ };
  const servedDiffers = { mutateOsl: (osl) => { osl.components.schemas.JoinAnswer.required = ['outcome', 'satisfied']; }, expect: /^served contract JoinAnswer requires|^with-form: served and offered differ: JoinAnswer / };
  const servedWithoutKeyword = { mutateOsl: (osl) => { osl.info.description = swap(osl.info.description, 'A world MUST record every outcome.', 'A world should record every outcome.', 'wow-spec/schema.yaml info.description'); }, expect: /^served contract info\.description \(a world records every outcome\): .* has no key word/ };
  const buildNotRebuilt = { mutateGenerated: (doc) => { delete doc.components.schemas.UserJoin.required; }, expect: /^generated schema\.json UserJoin has no required list/ };
  const apiWithoutBcp14 = { edits: { four: { three: { two: { world: (p) => swap(p, '\n     The key words ', '\n-    The key words ', W2P) } } } }, expect: /^with-form: offered World API after iteration 5: \d+ key words and the BCP 14 paragraph 0 times/ };
  const OPT_IN_START = '+    Joining. Joining is OPTIONAL for a world. A world that states who it is in its World resource (identity, its base URL) MUST also state the claims it asks a visitor for (claims, each claim name marked required or optional) and the credential types it issues (issues, which MAY be empty). A world that states no identity takes no joins, and the rules of this paragraph do not apply to it. ';
  const EVERY_WORLD_START = '+    Joining. A world MUST state in its World resource who it is (identity, its base URL), the claims it asks a visitor for (claims, each claim name marked required or optional) and the credential types it issues (issues, which MAY be empty). ';
  const everyWorldMust = { edits: { [API]: (p) => swap(p, OPT_IN_START, EVERY_WORLD_START, W5P) }, expect: /^with-form: offered World API after iteration 5 joining paragraph: states identity, claims and issues as a rule for every world/ };
  const servedEveryWorldMust = { mutateOsl: (osl) => { osl.info.description = swap(osl.info.description, OPT_IN_START.slice(5), EVERY_WORLD_START.slice(5), 'wow-spec/schema.yaml info.description'); }, expect: /^served contract joining paragraph: states identity, claims and issues as a rule for every world/ };
  const overlayReadmeWithoutBcp14 = { overlayReadme: (t) => swap(t, words.BCP14, 'Key words are used as defined elsewhere.', 'wow-spec/overlays/iteration-5/README.md'), expect: /^the iteration 5 overlay README\.md: \d+ key words and the BCP 14 paragraph 0 times/ };

  await run('W3', 'the conformance vocabulary of iteration 5: the World API after iteration 5 carries the BCP 14 paragraph once; the joining paragraph makes joining opt-in (OPTIONAL for a world; a world that states identity MUST also state claims and issues; a world that states no identity takes no joins and the paragraph does not apply to it) and states no rule that every world states identity, claims and issues, offered on both forms and served; each normative sentence iteration 5 adds (the joining paragraph: joining optional, identity stated with claims and issues, identity.base checked before anything is disclosed, only the claims asked for, the outcome, every outcome recorded, no permission granted, nothing about the visitor in a URL, nothing reused for another world; World.identity, World.claims, World.issues, POST /wow/user, UserJoin, JoinAnswer and its trust rule; the pilot statement: a join without one not refused for that alone, recorded and shown as not stated, never treated as human) uses a key word; World and World.identity keep no required member, UserJoin [manifest, proof], JoinAnswer [outcome, satisfied, not_satisfied], every claim item [name, required]; served equals offered equals built; on both GeoPose forms; every document with key words carries the BCP 14 paragraph once', async (impl) => {
    const failures = [];
    const osl = up.yaml.load(up.read(path.join(ROOT, 'wow-spec', 'schema.yaml')));
    if (impl.mutateOsl) impl.mutateOsl(osl);
    const generated = JSON.parse(up.read(GENERATED));
    if (impl.mutateGenerated) impl.mutateGenerated(generated);
    let count = null;
    eachForm(failures, (form) => {
      const out = loadIteration5(impl.edits, form);
      if (impl.mutateOffered) impl.mutateOffered(out.world);
      const label = form + '-form: offered World API after iteration 5';
      failures.push(...paragraphProblems(out.worldText, label, (out.world.info || {}).description));
      if (!words.hasBcp14((out.world.info || {}).description)) failures.push(label + ': no BCP 14 paragraph citing RFC 2119 and RFC 8174 in info.description');
      failures.push(...words.sentenceProblems(out.world, SENTENCES_I5, label));
      failures.push(...optInProblems(out.world, label));
      failures.push(...words.requiredProblems(listedSchemas(out.world.components.schemas), REQUIRED_I5, label));
      for (const diff of words.requiredDiffs(listedSchemas(out.world.components.schemas), listedSchemas(osl.components.schemas), names)) failures.push(form + '-form: served and offered differ: ' + diff);
      if (form === 'with') count = words.keywordCount(SENTENCES_I5.map((e) => { try { return words.sentenceWith(e.text(out.world), e.anchor) || ''; } catch (error) { return ''; } }).join(' '));
    });
    let overlayReadme = up.read(OVERLAY_README_5);
    if (impl.overlayReadme) overlayReadme = impl.overlayReadme(overlayReadme);
    if (!words.keywordCount(overlayReadme)) failures.push('the iteration 5 overlay README.md uses no key word, though the text it describes does');
    failures.push(...paragraphProblems(overlayReadme, 'the iteration 5 overlay README.md'));
    // The served contract carries the same sentences with their key words, and its build the same lists.
    failures.push(...words.sentenceProblems(osl, SENTENCES_I5, 'served contract'));
    failures.push(...optInProblems(osl, 'served contract'));
    failures.push(...words.requiredProblems(listedSchemas(osl.components.schemas), REQUIRED_I5, 'served contract'));
    failures.push(...words.requiredProblems(listedSchemas(generated.components.schemas), REQUIRED_I5, 'generated schema.json'));
    for (const diff of words.requiredDiffs(listedSchemas(osl.components.schemas), listedSchemas(generated.components.schemas), names)) failures.push('generated schema.json is not the served contract: ' + diff);

    if (impl.expect) return { ok: !failures.some((f) => impl.expect.test(f)), detail: failures.slice(0, 4).join('; ') || 'no failure' };
    return {
      ok: failures.length === 0,
      detail: failures.length
        ? failures.length + ' problem(s): ' + failures.slice(0, 6).join('; ')
        : 'the World API after iteration 5 carries the BCP 14 paragraph once on both forms; the joining paragraph is opt-in (offered on both forms and served) and has no rule for every world; ' + SENTENCES_I5.length + ' normative sentences in the World API (' + (count || 0) + ' key words) each use one, offered on both forms and served; required lists: ' + Object.entries(REQUIRED_I5).map(([n, l]) => n + (l.length ? ' [' + l.join(', ') + ']' : ' none')).join(', ') + '; served = offered = built; the World API and the overlay README.md each carry the BCP 14 paragraph once',
    };
  }, {}, [
    { name: 'a joining sentence without a key word (the identity.base check)', impl: joiningWithoutKeyword },
    { name: 'a World.identity description without a key word', impl: identityWithoutKeyword },
    { name: 'an offered UserJoin without its required list', impl: userJoinWithoutList },
    { name: 'offered World.claims items without their required list', impl: claimItemsWithoutList },
    { name: 'an offered World with a required member', impl: worldWithRequired },
    { name: 'a served contract whose JoinAnswer required list differs from the offer', impl: servedDiffers },
    { name: 'a served contract whose record-every-outcome sentence has no key word', impl: servedWithoutKeyword },
    { name: 'a generated schema.json not rebuilt from the served contract (UserJoin without its list)', impl: buildNotRebuilt },
    { name: 'a World API with key words but no BCP 14 paragraph', impl: apiWithoutBcp14 },
    { name: 'an overlay README.md with key words but no BCP 14 paragraph', impl: overlayReadmeWithoutBcp14 },
    { name: 'a User.pilot sentence without a key word (hybrid shown as an agent)', impl: pilotWithoutKeyword },
    { name: 'a UserJoin sentence without a key word (a join without a pilot statement not treated as human)', impl: unstatedWithoutKeyword },
    { name: 'an offered joining paragraph with the old rule for every world ("A world MUST state in its World resource ...")', impl: everyWorldMust },
    { name: 'a served joining paragraph with the old rule for every world ("A world MUST state in its World resource ...")', impl: servedEveryWorldMust },
  ]);
}

// ---------------------------------------------------------------------------------------------------
// W4, neutral wording on every overlay.

const OVERLAYS = path.join(ROOT, 'wow-spec', 'overlays');
const ITERATIONS = [1, 2, 3, 4, 5];
/** The folders that hold the without-form's own files; every other file serves both forms. */
const WITHOUT_FORM_DIRS = ['iteration-1/without-rotation-sentences', 'iteration-2/without-rotation-sentences'];
/**
 * The people named in the group's records and in this project's own records. Overlay text names none of them, nor
 * any other person; a name not on this list is not caught here.
 */
const PERSONS = ['John Carlson', 'Nicholas Polys', 'Don Brutzman', 'Rolf Kruse', 'Tracey Swales', 'James Jackson', 'Alfred Tom', 'Steve Smyth', 'Mikel Salazar', 'Grig'];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** What overlay text does not name (D4): each a label and a pattern. "lab" in lower case is the common noun, not a name. */
const NAMES = [
  ['the Universal Manifest', /universal[\s-]*manifest/i],
  ['OpenSpatials', /open[\s-]*spatials\b/i],
  ['the Lab', /open[\s-]*spatial[\s-]*lab|\bOSL\b|\bLab\b/],
  ['an x-osl label', /x-osl/i],
  ['a person', new RegExp('\\b(?:' + PERSONS.map((n) => escapeRe(n).replace(/ /g, '\\s+')).join('|') + ')\\b', 'i')],
  ['a person (a handle)', /(?:^|[\s(])@(?!context\b|type\b|id\b|version\b|vocab\b|base\b|graph\b|language\b|value\b|list\b|set\b)[A-Za-z0-9][\w-]*/],
];

/** Every overlay file of iterations 1 to 5, relative to wow-spec/overlays, in a stable order. */
function overlayFiles() {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(OVERLAYS, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  for (const n of ITERATIONS) if (fs.existsSync(path.join(OVERLAYS, 'iteration-' + n))) walk('iteration-' + n);
  return out;
}

/** The added lines of one overlay file: the lines a patch adds (not its +++ header), or every line of any other file. */
function addedLines(rel, text) {
  const lines = text.split('\n');
  if (!rel.endsWith('.patch')) return lines.map((t, i) => ({ n: i + 1, t }));
  return lines.map((t, i) => ({ n: i + 1, t })).filter((l) => l.t.startsWith('+') && !l.t.startsWith('+++')).map((l) => ({ n: l.n, t: l.t.slice(1) }));
}

async function neutralWordingCheck() {
  const fileEdit = (rel, from, to) => ({ [rel]: (t) => swap(t, from, to, 'wow-spec/overlays/' + rel) });
  const universalManifest = { files: fileEdit('iteration-5/OpenSpatialWorld.API.yaml.patch', '+    Joining. Joining is OPTIONAL', '+    Joining. As in the Universal Manifest, joining is OPTIONAL'), expect: /^iteration-5\/OpenSpatialWorld\.API\.yaml\.patch:\d+ names the Universal Manifest/ };
  const labelInWithoutForm = { files: fileEdit('iteration-2/without-rotation-sentences/OpenSpatialWorld.API.yaml.patch', '+    Frames. All coordinates', '+    Frames (x-osl-overlay: iteration-2). All coordinates'), expect: /^iteration-2\/without-rotation-sentences\/OpenSpatialWorld\.API\.yaml\.patch:\d+ names an x-osl label/ };
  const labInReadme = { files: fileEdit('iteration-3/README.md', '\nNothing here has been sent upstream.', '\nNothing here has been sent upstream by the Open Spatial Lab.'), expect: /^iteration-3\/README\.md:\d+ names the Lab/ };
  const personInPatch = { files: fileEdit('iteration-4/OpenSpatialWorld.API.yaml.patch', 'A portal inside a preview MUST show closed.', 'A portal inside a preview MUST show closed, as Don Brutzman proposed.'), expect: /^iteration-4\/OpenSpatialWorld\.API\.yaml\.patch:\d+ names a person/ };
  const openSpatials = { files: fileEdit('iteration-5/OpenSpatialWorld.API.yaml.patch', '+    Joining. Joining is OPTIONAL', '+    Joining. As in OpenSpatials, joining is OPTIONAL'), expect: /^iteration-5\/OpenSpatialWorld\.API\.yaml\.patch:\d+ names OpenSpatials/ };

  await run('W4', 'neutral wording: no added line of any overlay of iterations 1 to 5, in either GeoPose form (the lines each patch adds, and every line of each overlay README.md), names the Universal Manifest, OpenSpatials, the Lab (Open Spatial Lab, OSL), an x-osl label or a person', async (impl) => {
    const failures = [];
    const files = overlayFiles();
    const scanned = { lines: 0, perIteration: {}, withoutForm: 0 };
    for (const rel of files) {
      let text = up.read(path.join(OVERLAYS, rel));
      if (impl.files && impl.files[rel]) text = impl.files[rel](text);
      const lines = addedLines(rel, text);
      scanned.lines += lines.length;
      const it = rel.split('/')[0];
      scanned.perIteration[it] = (scanned.perIteration[it] || 0) + lines.length;
      if (WITHOUT_FORM_DIRS.some((d) => rel.startsWith(d + '/'))) scanned.withoutForm += lines.length;
      for (const { n, t } of lines) for (const [label, re] of NAMES) if (re.test(t)) failures.push(rel + ':' + n + ' names ' + label + ': "' + t.trim().slice(0, 90) + '"');
    }
    // The scan must have met every iteration and the without-form's own files, or it proves nothing.
    for (const n of ITERATIONS) if (!scanned.perIteration['iteration-' + n]) failures.push('no added line scanned in iteration-' + n);
    for (const d of WITHOUT_FORM_DIRS) if (!files.some((f) => f.startsWith(d + '/') && f.endsWith('.patch'))) failures.push('no without-form patch in ' + d);
    if (impl.expect) return { ok: !failures.some((f) => impl.expect.test(f)), detail: failures.slice(0, 4).join('; ') || 'no failure' };
    return {
      ok: failures.length === 0,
      detail: failures.length
        ? failures.length + ' hit(s): ' + failures.slice(0, 8).join('; ')
        : files.length + ' overlay files of iterations 1 to 5 (' + scanned.lines + ' added lines, ' + scanned.withoutForm + ' of them in the without-form\'s own patches) name none of: ' + NAMES.map(([l]) => l).join(', '),
    };
  }, {}, [
    { name: 'an added line of the iteration 5 patch that names the Universal Manifest', impl: universalManifest },
    { name: 'an x-osl label added to the without-form iteration 2 patch only', impl: labelInWithoutForm },
    { name: 'an overlay README.md that names the Open Spatial Lab', impl: labInReadme },
    { name: 'an added line of the iteration 4 patch that names a person', impl: personInPatch },
    { name: 'an added line of the iteration 5 patch that names OpenSpatials', impl: openSpatials },
  ]);
}

module.exports = { overlayChecks, loadIteration5, sessionText };
