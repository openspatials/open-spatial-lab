'use strict';

/*
 * Iteration 5, the body and the items through a join (contract section 9: RB.4, RB.5, RB.11, RB.12, and the
 * converter of 9.8).
 *
 *   CV1  the converter, in Node: a known wire value converts to the exact receiver input. The contract's own box item
 *        (section 9.3) converts to the catalog's box, and every catalog item written in the wire form converts back to
 *        its catalog entry on every field section 9.8 maps. Sophie's body (her <id>.body.json), written in the wire
 *        form, converts back to the same roles, parents, hands, feet, volumes, source digest, height and forearm
 *        radius, and to the same rest pose and arm and leg bone lengths within 1e-6 m and 1e-3 m
 *   RB4  the digest, in Node: the receiver hashes the avatar file it fetched (User.AvatarURI) and compares the hash with
 *        body.model.digest. When they match it fits; when they differ it refuses the model with "details do not match
 *        the file", fits nothing and refuses every item for that reason. An item whose file does not match its
 *        fit.model.digest is refused alone with the same reason, and the other items stay
 *   RB5  the size, in Node: a world with a target height of 1.7 m sets User.osl_drawn_height_m to the visitor's
 *        preferred_height_m (1.85) when it accepted one, and to its target when the visitor sent none; the receiver
 *        draws at that height: measures.height_m equals it, and every other measure is the source measure times
 *        drawn height / source height
 *   RB12 untrusted shapes, in Node: the world checks the body and the items at the join (R5.9). A body with a rotation
 *        that is not of length 1, a parent after its child, a repeated name, a required role missing, a grip axis
 *        of zero length, parallel grip and forward axes, or a number sent as null (how JSON writes a non-finite
 *        number) is not satisfied, "malformed: expected ...", with its reason. 33 items are not satisfied (at most
 *        32). One bad item among good ones is refused alone: the answer and the record list it in items_refused with
 *        its reason (the record by its place in the list, one entry per item facet), the others reach the User,
 *        and the join proceeds. A number too large for JSON's numbers (1e400, read as Infinity) cannot be signed,
 *        so a join that carries one is refused by the integrity check and recorded; the world's own body and item
 *        checks refuse NaN and Infinity with a reason that names the number
 *   RB11 other visitors see the same fit, in a browser, in the main demo: a visitor joins world B (Location B) with
 *        avatar, display name, preferences (1.85 m), body (Sophie's) and items (hammer, helmet). B's User carries the
 *        body and the items as sent, and the drawn height. A second client, the main demo page in B, draws that
 *        visitor (its live pose names it by its User id and asks for Adam with no items) from the User: Sophie, at
 *        1.85 m within 0.01 m, holding the hammer and wearing the helmet, with the body's file digest checked, and
 *        with the same measures (each within 0.01 m, the receiver's contact limit) as the visitor's own files give
 *        at that height, both from the User's details and from the body it draws
 *
 * Every check also runs against planted faults, each an exact edit of the real code, which must turn it red.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, run, line, httpReq, loadMutant, loadEsmMutant, makeTempDir } = require('../arch-i1/lib');
const lab = require('./lab');
const { wireBody, wireItem, digest } = require('./wire-writer');

const WEB = path.join(ROOT, 'web');
const WIRE = path.join('web', 'avatar', 'runtime', 'wire.mjs');
const SOPHIE = path.join(WEB, 'assets', 'actionforge', 'characters', 'sophie');
const ADAM_GLB = path.join(WEB, 'assets', 'actionforge', 'characters', 'adam', 'adam.glb');
const ITEMS_DIR = path.join(WEB, 'vendor', 'avatar-evaluator-v1', 'mannequin', 'assets', 'items');
const MANNEQUIN = path.join(WEB, 'assets', 'actionforge', 'avatars', 'mannequin.body.json');
const RECEIVER_LIMIT_M = 0.01; // the receiver's contact limit (RB.6, RB.7, RB.10): the tolerance of "the same fit"
const TARGET_HEIGHT_M = 1.7;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** World B's claims for a body: avatar required; the rest optional. */
const BODY_CLAIMS = Object.freeze([
  { name: 'avatar', required: true },
  { name: 'display_name', required: false },
  { name: 'preferences', required: false },
  { name: 'body', required: false },
  { name: 'items', required: false },
]);

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const bytesOf = (file) => { const b = fs.readFileSync(file); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const clone = (v) => JSON.parse(JSON.stringify(v));

/** The proof's fixtures: Sophie's body and the catalog, in the wire form, with their files. */
function fixtures(assetBase) {
  const body = readJson(path.join(SOPHIE, 'sophie.body.json'));
  const catalog = readJson(path.join(ITEMS_DIR, 'items.json'));
  const reference = readJson(MANNEQUIN).measures;
  const item = (id) => {
    const entry = catalog.items.find((it) => it.id === id);
    return wireItem(entry, { bytes: fs.readFileSync(path.join(ITEMS_DIR, entry.file)), assetUri: assetBase + 'vendor/avatar-evaluator-v1/mannequin/assets/items/' + entry.file, reference });
  };
  return { body, catalog, reference, wire: wireBody(body, fs.readFileSync(path.join(SOPHIE, 'sophie.glb'))), item };
}

/** The receiver's converter, real or with exact edits. A missing module is a plain failure with its name. */
async function receiver(edits) {
  if (!fs.existsSync(path.join(ROOT, WIRE))) throw new Error('the receiver has no converter from the wire form (' + WIRE + ' does not exist)');
  if (edits && edits.length) return loadEsmMutant(WIRE, edits, []);
  return import(pathToFileURL(path.join(ROOT, WIRE)).href);
}

/** A file-backed readBytes for the receiver in Node: a URL under assetBase reads the file under web/. */
function fileReader(assetBase) {
  return async (url) => {
    if (!url.startsWith(assetBase)) throw new Error('not a lab file: ' + url);
    return bytesOf(path.join(WEB, decodeURIComponent(url.slice(assetBase.length))));
  };
}

const close = (a, b, tol) => Math.abs(a - b) <= tol;
const vecClose = (a, b, tol) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => close(x, b[i], tol));
const unitQ = (q) => { const n = Math.hypot(...q); return q.map((x) => x / n); };
const sameQ = (a, b, tol) => vecClose(a, b, tol) || vecClose(a, b.map((x) => -x), tol);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function bodyChecks(ports, options) {
  await converterCheck();
  await digestCheck();
  await sizeCheck(ports);
  await shapesCheck(ports);
  if (options && options.browser === false) line('  (RB11 not run: OSL_ARCH_I5_SKIP_BROWSER=1; the proof does not pass without it)');
  else await sameFitCheck(ports);
}

// ---- CV1 ----------------------------------------------------------------------------------------------------------

/** The fields section 9.8 maps, of one catalog item, as the receiver reads them (scale 1 is the same as none). */
function mappedItem(entry) {
  const out = { id: entry.id, mode: entry.mode, hands: entry.hands };
  if (entry.hands === 1) out.hand = entry.hand;
  if (entry.contacts) out.contacts = Object.fromEntries(Object.entries(entry.contacts).map(([s, c]) => [s, { point: c.point, grip_axis: c.grip_axis, forward_axis: c.forward_axis, ...(c.slide_m !== undefined ? { slide_m: c.slide_m } : {}) }]));
  if (entry.size_m) out.size_m = entry.size_m;
  if (entry.scale !== undefined && entry.scale !== 1) out.scale = entry.scale;
  if (entry.scale_m_per_unit !== undefined) out.scale_m_per_unit = entry.scale_m_per_unit;
  if (entry.stance) out.stance = entry.stance;
  if (entry.grip) out.grip = { clip: entry.grip.clip, time: entry.grip.time };
  if (entry.placement) {
    const p = entry.placement;
    const worn = entry.mode === 'worn';
    out.placement = { anchor: p.anchor };
    for (const k of ['contact_on_hand', 'rotation', 'attach_point', 'scale_with', 'clear_of_torso_m', 'offset']) if (p[k] !== undefined) out.placement[k] = p[k];
    if (p.scale_reference_m !== undefined && !worn) out.placement.scale_reference_m = p.scale_reference_m;
  }
  return out;
}

/** The converter's item with its keys in the same order as mappedItem, so the two compare as JSON. */
function sortedLike(expected, got) {
  if (!got || typeof got !== 'object' || Array.isArray(got) || !expected || typeof expected !== 'object' || Array.isArray(expected)) return got;
  const out = {};
  for (const k of Object.keys(expected)) if (k in got) out[k] = sortedLike(expected[k], got[k]);
  for (const k of Object.keys(got)) if (!(k in out)) out[k] = got[k];
  if ('scale' in out && out.scale === 1) delete out.scale;
  return out;
}

/** The contract's box (section 9.3), its fit as written there; the digest and the address are the proof's. */
function contractBox(boxBytes) {
  return {
    itemId: 'box', assetUri: 'https://a.example/items/box.glb', mode: 'held',
    fit: {
      model: { digest: digest(boxBytes) },
      size: [0.26, 0.222, 0.262],
      scale: { by: 'torsoWidth', reference: 0.3435 },
      placement: { anchor: 'upperChest', offset: { up: { measure: 'torsoHeight', factor: -0.35 } }, clearOfTorso: 0.065, rotation: [0, 0, 0, 1] },
      contacts: [
        { hand: 'left', on: 'palm', point: [0.13, 0.05, 0], gripAxis: [0, 1, 0], forwardAxis: [0, 0, 1], slide: 0.125 },
        { hand: 'right', on: 'palm', point: [-0.13, 0.05, 0], gripAxis: [0, 1, 0], forwardAxis: [0, 0, 1], slide: 0.125 },
      ],
      stance: { pack: 'actionforge-cc0', clip: 'walk_carry_loop' },
      grip: { pack: 'actionforge-cc0', clip: 'walk_carry_loop', time: 0 },
    },
  };
}

async function converterCheck() {
  const translationAlone = [['    const here = { p: add(up.p, qrot(up.q, bone.t)), q: qmul(up.q, bone.r) };\n', '    const here = { p: add(up.p, bone.t), q: qmul(up.q, bone.r) };\n']];
  const axesSwapped = [['      point: c.point, grip_axis: c.gripAxis, forward_axis: c.forwardAxis, ', '      point: c.point, grip_axis: c.forwardAxis, forward_axis: c.gripAxis, ']];
  await run('CV1', 'the converter from the wire form (contract 9.8): the contract\'s own box item converts to the catalog\'s box exactly, every catalog item written in the wire form converts back to its catalog entry on every mapped field, and Sophie\'s body written in the wire form converts back to her body file: the same roles, parents, hands, feet, volumes, source digest, height and forearm radius, and the same rest pose (1e-6 m) and arm and leg bone lengths (1e-3 m)', async (impl) => {
    const wire = await receiver(impl.edits);
    const failures = [];
    const fx = fixtures('http://lab.invalid/');
    // 1. The known wire value of the contract: the box.
    const boxEntry = fx.catalog.items.find((it) => it.id === 'box');
    const fromContract = wire.itemFromWire(contractBox(fs.readFileSync(path.join(ITEMS_DIR, boxEntry.file))));
    const expectBox = mappedItem(boxEntry);
    delete expectBox.hand; // a two-handed item's `hand` is not sent (section 9.8)
    if (!same(sortedLike(expectBox, fromContract), expectBox)) failures.push('the contract\'s box converts to ' + JSON.stringify(sortedLike(expectBox, fromContract)) + ', not the catalog\'s ' + JSON.stringify(expectBox));
    // 2. Every catalog item, written in the wire form and read back.
    let items = 0;
    for (const entry of fx.catalog.items) {
      const expect = mappedItem(entry);
      if (entry.hands === 2) delete expect.hand;
      const got = sortedLike(expect, wire.itemFromWire(fx.item(entry.id)));
      if (!same(got, expect)) failures.push(`item ${entry.id} converts to ${JSON.stringify(got)}, not ${JSON.stringify(expect)}`);
      else items++;
    }
    // 3. Sophie's body.
    const b = fx.body;
    const got = wire.bodyFromWire(fx.wire);
    const roles = Object.fromEntries(Object.entries(b.roles).filter(([, n]) => typeof n === 'string'));
    if (!same(Object.entries(got.roles).sort(), Object.entries(roles).sort())) failures.push('the roles differ');
    let worstP = 0, worstQ = 0;
    for (const [name, node] of Object.entries(b.rest_pose)) {
      const g = got.rest_pose[name];
      if (!g) { failures.push('bone ' + name + ' is missing'); continue; }
      if (g.parent !== node.parent) failures.push(`bone ${name}: parent ${g.parent}, not ${node.parent}`);
      worstP = Math.max(worstP, ...g.position_m.map((x, i) => Math.abs(x - node.position_m[i])));
      const q = unitQ(node.rotation);
      worstQ = Math.max(worstQ, Math.min(Math.max(...g.rotation.map((x, i) => Math.abs(x - q[i]))), Math.max(...g.rotation.map((x, i) => Math.abs(x + q[i])))));
    }
    if (worstP > 1e-6 || worstQ > 1e-6) failures.push(`the rest pose differs by up to ${worstP.toExponential(2)} m and ${worstQ.toExponential(2)} in a rotation`);
    for (const s of ['l', 'r']) {
      const h = b.hands[s], g = got.hands[s];
      if (!g || !same(g.grip_frame.knuckle_axis, h.grip_frame.knuckle_axis) || !same(g.grip_frame.forward_axis, h.grip_frame.forward_axis) || !same(g.palm_m, h.palm_m) || g.hand_length_m !== h.hand_length_m) failures.push('hand ' + s + ' differs');
      else if (!g.hollow || g.hollow.grip !== h.hollow.grip) failures.push(`hand ${s}: the default hollow is ${g.hollow && g.hollow.grip}, not ${h.hollow.grip}`);
      else for (const [key, v] of Object.entries(h.hollows)) if (!g.hollows[key] || !same(g.hollows[key].position_m, v.position_m) || g.hollows[key].radius_m !== v.radius_m) failures.push(`hand ${s}: hollow ${key} differs`);
      const f = b.feet[s], gf = got.feet[s];
      if (!gf || gf.length_m !== f.length_m || gf.sole_height_m !== f.sole_height_m || !same(gf.sole_points_m, f.sole_points_m)) failures.push('foot ' + s + ' differs');
    }
    const vol = (v) => ({ origin_role: v.origin_role, min_m: v.min_m, max_m: v.max_m });
    if (!same(vol(got.volumes.head), vol(b.volumes.head)) || !same(vol(got.volumes.torso), vol(b.volumes.torso))) failures.push('the head or torso volume differs');
    for (const [k, v] of Object.entries(b.volumes.torso_parts)) if (!got.volumes.torso_parts[k] || !same(vol(got.volumes.torso_parts[k]), vol(v))) failures.push('torso part ' + k + ' differs');
    if (got.source.sha256 !== b.source.sha256) failures.push(`source.sha256 ${got.source.sha256}, not ${b.source.sha256}`);
    if (got.measures.height_m !== b.measures.height_m || got.measures.forearm_radius_m !== b.measures.forearm_radius_m) failures.push('the height or the forearm radius differs');
    if (got.rig.structure !== b.rig.structure) failures.push('the structure differs');
    let worstL = 0;
    const lengthRoles = ['leftShoulder', 'rightShoulder', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'];
    for (const r of lengthRoles) worstL = Math.max(worstL, Math.abs((got.bone_lengths_m[r] ?? Infinity) - b.bone_lengths_m[r]));
    if (!(worstL <= 1e-3)) failures.push(`the arm and leg bone lengths differ by up to ${worstL} m`);
    if (failures.length) return { ok: false, detail: failures.join('; ') };
    return { ok: true, detail: `the contract's box -> the catalog's box; ${items}/${fx.catalog.items.length} catalog items read back exactly; Sophie's ${Object.keys(b.rest_pose).length} bones: rest pose within ${worstP.toExponential(1)} m and ${worstQ.toExponential(1)}, ${lengthRoles.length} bone lengths within ${worstL.toFixed(5)} m, hands, feet, volumes, roles and source digest equal` };
  }, {}, [
    { name: 'a converter that adds a bone\'s translation without its parent\'s rotation', impl: { edits: translationAlone } },
    { name: 'a converter that swaps an item\'s grip and forward axes', impl: { edits: axesSwapped } },
  ]);
}

// ---- RB4 ----------------------------------------------------------------------------------------------------------

async function digestCheck() {
  const skipDigest = [['  if (got !== null) out.model = got === wire.model.digest ? { ok: true, digest: got } : { ok: false, reason: MODEL_MISMATCH, digest: got, stated: wire.model.digest };\n', '  if (got !== null) out.model = { ok: true, digest: got };\n']];
  await run('RB4', 'the digest: the receiver hashes the avatar file it fetched and compares it with body.model.digest; a match fits, a mismatch refuses the model with "details do not match the file" and fits no item; an item whose file does not match its digest is refused alone with the same reason', async (impl) => {
    const wire = await receiver(impl.edits);
    const base = 'http://lab.invalid/';
    const fx = fixtures(base);
    const readBytes = fileReader(base);
    const userOf = (body, items) => ({ id: 1, AvatarURI: base + 'assets/actionforge/characters/sophie/sophie.glb', osl_drawn_height_m: 1.85, body, items });
    const failures = [];
    // A match.
    const good = await wire.receiveVisitor(userOf(fx.wire, [fx.item('hammer'), fx.item('helmet')]), { readBytes, targetHeight: TARGET_HEIGHT_M });
    if (!good.model || !good.model.ok || !good.body || good.items.length !== 2) failures.push('matching details: ' + JSON.stringify({ model: good.model, items: good.items.map((i) => i.id), refused: good.refused }));
    // Details of another file (Adam's).
    const other = clone(fx.wire);
    other.model.digest = digest(fs.readFileSync(ADAM_GLB));
    const bad = await wire.receiveVisitor(userOf(other, [fx.item('hammer')]), { readBytes, targetHeight: TARGET_HEIGHT_M });
    if (!bad.model || bad.model.ok !== false || bad.model.reason !== wire.MODEL_MISMATCH || wire.MODEL_MISMATCH !== 'details do not match the file') failures.push('details of another file: the model reads ' + JSON.stringify(bad.model) + ', not refused with "details do not match the file"');
    if (bad.body || bad.items.length || !bad.refused.length || bad.refused.some((r) => r.reason !== 'details do not match the file')) failures.push('details of another file: the receiver fitted ' + JSON.stringify({ body: !!bad.body, items: bad.items.map((i) => i.id), refused: bad.refused }));
    // One item whose details belong to another file (the torch's), beside a good one.
    const wrongItem = fx.item('hammer');
    wrongItem.fit.model.digest = fx.item('torch').fit.model.digest;
    const mixed = await wire.receiveVisitor(userOf(fx.wire, [wrongItem, fx.item('helmet')]), { readBytes, targetHeight: TARGET_HEIGHT_M });
    const refusedHammer = mixed.refused.find((r) => r.itemId === 'hammer');
    if (!mixed.model.ok || !refusedHammer || refusedHammer.reason !== 'details do not match the file' || mixed.items.map((i) => i.id).join() !== 'helmet') failures.push('an item of another file: ' + JSON.stringify({ items: mixed.items.map((i) => i.id), refused: mixed.refused }));
    if (failures.length) return { ok: false, detail: failures.join('; ') };
    return { ok: true, detail: `Sophie's details on sophie.glb (${good.model.digest.slice(0, 19)}...): fitted, hammer and helmet; on adam.glb's digest: "${bad.model.reason}", no body, ${bad.refused.length} item refused; a hammer with the torch's digest: refused "${refusedHammer.reason}", the helmet stays` };
  }, {}, [
    { name: 'a receiver that skips the digest compare', impl: { edits: skipDigest } },
  ]);
}

// ---- RB5 ----------------------------------------------------------------------------------------------------------

async function sizeCheck(ports) {
  const sourceHeight = [['  out.body = scaleBody(bodyFromWire(wire), out.drawn_height_m);\n', '  out.body = bodyFromWire(wire);\n']];
  await run('RB5', 'the size: a world (target height 1.7 m) sets User.osl_drawn_height_m from the visitor\'s preferred_height_m (1.85 m) or, with none sent, from its target; the receiver draws at that height: measures.height_m equals it and every measure is the source measure times drawn height / source height', async (impl) => {
    const agent = await lab.agent();
    const W = await lab.handshakeWorld('b', ports.next(), { label: 'RB5 world', claims: BODY_CLAIMS });
    const failures = [];
    const notes = [];
    try {
      const base = 'http://lab.invalid/';
      const fx = fixtures(base);
      const readBytes = fileReader(base);
      const users = [];
      for (const [label, prefs, expect] of [['preferred 1.85 m', { preferred_height_m: 1.85 }, 1.85], ['no preferred height', null, null]]) {
        const claims = { avatar: { uri: base + 'assets/actionforge/characters/sophie/sophie.glb' }, display_name: 'Ada', body: fx.wire };
        if (prefs) claims.preferences = prefs;
        const entered = await agent.enterWorld(W.base, { wallet: { claims, pilot: 'agent' } });
        if (entered.status !== 201) { failures.push(`${label}: the join answered ${entered.status} ${JSON.stringify(entered.answer && (entered.answer.reason || entered.answer.not_satisfied))}`); continue; }
        const user = (await httpReq('GET', W.port, '/' + entered.answer.user, null, { Accept: lab.WOW })).json || {};
        const worldTarget = W.built.handshake.targetHeight ? W.built.handshake.targetHeight() : undefined;
        const want = expect !== null ? expect : worldTarget;
        if (!user.body) { failures.push(`${label}: the User carries no body`); continue; }
        if (expect === null && worldTarget !== TARGET_HEIGHT_M) failures.push(`${label}: the world states its target height as ${worldTarget}, not ${TARGET_HEIGHT_M}`);
        if (user.osl_drawn_height_m !== want) failures.push(`${label}: User.osl_drawn_height_m is ${user.osl_drawn_height_m}, not ${want}`);
        users.push([label, user, want]);
      }
      if (failures.length) return { ok: false, detail: failures.join('; ') };
      // The receiver draws at the height the world set.
      const wire = await receiver(impl.edits);
      const source = wire.measuresOf(wire.bodyFromWire(fx.wire));
      for (const [label, user, want] of users) {
        const fit = await wire.receiveVisitor(user, { readBytes, targetHeight: 1.0 });
        if (!fit.measures) { failures.push(`${label}: the receiver did not fit (${JSON.stringify(fit.model)})`); continue; }
        const k = want / source.height_m;
        const off = Object.keys(source).filter((m) => !close(fit.measures[m], source[m] * k, 1e-9));
        if (!close(fit.drawn_height_m, want, 1e-12) || !close(fit.measures.height_m, want, 1e-9)) failures.push(`${label}: drawn at ${fit.drawn_height_m}, measured height ${fit.measures.height_m}, not ${want}`);
        else if (off.length) failures.push(`${label}: measures not scaled by ${k.toFixed(4)}: ${off.map((m) => `${m} ${fit.measures[m].toFixed(4)} (want ${(source[m] * k).toFixed(4)})`).join(', ')}`);
        else notes.push(`${label}: drawn ${want} m (from ${fit.height_from}), arm length ${fit.measures.arm_length_m.toFixed(4)} m = ${source.arm_length_m.toFixed(4)} x ${k.toFixed(4)}`);
      }
    } finally {
      await W.close();
    }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : notes.join('; ') };
  }, {}, [
    { name: 'a receiver that draws at the source height', impl: { edits: sourceHeight } },
  ]);
}

// ---- RB12 ---------------------------------------------------------------------------------------------------------

async function shapesCheck(ports) {
  const acceptsNonFinite = { server: { handshake: [["const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);\n", "const isFiniteNumber = (v) => typeof v === 'number';\n"]] } };
  await run('RB12', 'untrusted shapes at the join (R5.9): a body with a rotation not of length 1, a parent after its child, a repeated name, a required role missing, a zero grip axis, parallel grip and forward axes, or a number sent as null is not satisfied with its reason; 33 items are not satisfied; one bad item is refused alone (answer and record items_refused, by item) and the others reach the User; a number too large for JSON is refused by the integrity check; the world\'s own checks refuse NaN and Infinity', async (impl) => {
    const agent = await lab.agent();
    const handshakeModule = impl.server ? loadMutant(path.join('runtime', 'world-server', 'src', 'runtime-handshake.js'), impl.server.handshake) : require(path.join(ROOT, 'runtime', 'world-server', 'src', 'runtime-handshake.js'));
    const W = await lab.handshakeWorld('b', ports.next(), { label: 'RB12 world', claims: BODY_CLAIMS, edits: impl.server });
    const failures = [];
    const notes = [];
    try {
      const base = 'http://lab.invalid/';
      const fx = fixtures(base);
      const join = (claims) => agent.enterWorld(W.base, { wallet: { claims: Object.assign({ avatar: { uri: base + 'assets/actionforge/characters/sophie/sophie.glb' } }, claims), pilot: 'agent' } });
      const notSat = (entered, name) => ((entered.answer && entered.answer.not_satisfied) || []).find((c) => c.name === name);
      const recordOf = async (entered) => (await httpReq('GET', W.port, '/' + entered.answer.record, null, { Accept: lab.WOW })).json || {};
      // 1. Bad bodies, each not satisfied with its reason.
      const bodies = [
        ['a rotation not of length 1', (b) => { b.bones[5].r = [0, 0, 0, 0.9]; }, /\br\b|length 1/],
        ['a parent after its child', (b) => { b.bones[5].parent = 9; }, /parent/],
        ['a repeated name', (b) => { b.bones[6].name = b.bones[5].name; }, /name/],
        ['a required role missing', (b) => { const i = b.bones.findIndex((x) => x.role === 'leftLowerArm'); delete b.bones[i].role; }, /leftLowerArm/],
        ['a zero grip axis', (b) => { b.hands.left.gripAxis = [0, 0, 0]; }, /gripAxis|non-zero/],
        ['parallel grip and forward axes', (b) => { b.hands.right.forwardAxis = b.hands.right.gripAxis.map((x) => 2 * x); }, /parallel/],
        ['a number sent as null', (b) => { b.bones[7].t[1] = null; }, /finite/],
      ];
      for (const [label, spoil, says] of bodies) {
        const body = clone(fx.wire);
        spoil(body);
        const entered = await join({ body });
        const n = notSat(entered, 'body');
        const user = entered.answer && entered.answer.user ? (await httpReq('GET', W.port, '/' + entered.answer.user, null, { Accept: lab.WOW })).json : null;
        if (!n || !/^malformed: expected /.test(n.reason) || !says.test(n.reason)) failures.push(`${label}: body ${n ? 'not satisfied: ' + JSON.stringify(n.reason) : 'satisfied'} (status ${entered.status})`);
        else if (user && user.body) failures.push(`${label}: the User carries the bad body`);
        else notes.push(`${label}: "${n.reason}"`);
      }
      // 2. Too many items.
      const many = Array.from({ length: 33 }, () => fx.item('hammer'));
      const tooMany = await join({ body: fx.wire, items: many });
      const nItems = notSat(tooMany, 'items');
      if (!nItems || !/^malformed: expected .*32/.test(nItems.reason)) failures.push(`33 items: ${nItems ? JSON.stringify(nItems.reason) : 'satisfied'}`);
      else notes.push(`33 items: "${nItems.reason}"`);
      // 3. One bad item among good ones.
      const badItem = fx.item('torch');
      badItem.itemId = 'bad-torch';
      badItem.fit.contacts[0].gripAxis = [0, 0, 0];
      const mixed = await join({ body: fx.wire, items: [fx.item('hammer'), badItem, fx.item('helmet')] });
      const answerRefused = (mixed.answer && mixed.answer.items_refused) || null;
      if (mixed.status !== 201 || !mixed.answer.user) failures.push(`one bad item: the join answered ${mixed.status} ${JSON.stringify(mixed.answer && mixed.answer.outcome)}`);
      else {
        const user = (await httpReq('GET', W.port, '/' + mixed.answer.user, null, { Accept: lab.WOW })).json || {};
        const rec = await recordOf(mixed);
        const ids = Array.isArray(user.items) ? user.items.map((i) => i.itemId) : null;
        if (!Array.isArray(answerRefused) || answerRefused.length !== 1 || answerRefused[0].itemId !== 'bad-torch' || !/^malformed: expected /.test(answerRefused[0].reason)) failures.push('one bad item: the answer lists items_refused ' + JSON.stringify(answerRefused));
        else if (!Array.isArray(rec.items_refused) || rec.items_refused.length !== 1 || rec.items_refused[0].itemId !== 'bad-torch' || rec.items_refused[0].item !== 1 || rec.items_refused[0].reason !== answerRefused[0].reason) failures.push('one bad item: the record lists items_refused ' + JSON.stringify(rec.items_refused));
        else if (!ids || ids.join() !== 'hammer,helmet') failures.push('one bad item: the User carries items ' + JSON.stringify(ids));
        else if (notSat(mixed, 'items')) failures.push('one bad item: the whole items claim is not satisfied');
        else notes.push(`one bad item: ${mixed.answer.outcome}, refused alone ("${answerRefused[0].reason}", record item 1), the User carries hammer, helmet`);
      }
      // 4. A number too large for JSON (read as Infinity): it cannot be signed, so the integrity check refuses it.
      const key = await agent.visitKey();
      const pres = await agent.presentation({ values: { avatar: { uri: base + 'assets/actionforge/characters/sophie/sophie.glb' }, body: Object.assign(clone(fx.wire), { height: 1.25 }) }, key, audience: W.base, pilot: 'agent' });
      const text = JSON.stringify(pres).replace('"height":1.25', '"height":1e400');
      const huge = await httpReq('POST', W.port, '/wow/user', text, { Accept: lab.WOW });
      const hugeReason = huge.json && huge.json.reason;
      if (huge.status !== 403 || !/integrity check failed/.test(String(hugeReason)) || !(huge.json && huge.json.record)) failures.push(`a number too large for JSON: ${huge.status} ${JSON.stringify(hugeReason)}`);
      else notes.push(`1e400 in the body: 403 deny, recorded, "${String(hugeReason).slice(0, 90)}..."`);
      // 5. The world's own checks of a body and an item, on NaN and Infinity.
      if (typeof handshakeModule.shapeProblem !== 'function') failures.push('the world has no shapeProblem(name, value) to check a body or an item');
      else {
        for (const [what, value] of [['NaN in a bone', (() => { const b = clone(fx.wire); b.bones[3].t[0] = NaN; return b; })()], ['Infinity as the height', Object.assign(clone(fx.wire), { height: Infinity })]]) {
          const said = handshakeModule.shapeProblem('body', value);
          if (!said || !/finite/.test(said)) failures.push(`${what}: the world's body check says ${JSON.stringify(said)}`);
          else notes.push(`${what}: "${said}"`);
        }
        const nanItem = fx.item('hammer');
        nanItem.fit.size[1] = NaN;
        const saidItem = handshakeModule.shapeProblem('item', nanItem);
        if (!saidItem || !/finite/.test(saidItem)) failures.push(`NaN in an item: the world's item check says ${JSON.stringify(saidItem)}`);
        else notes.push(`NaN in an item: "${saidItem}"`);
      }
    } finally {
      await W.close();
    }
    return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : notes.join('; ') };
  }, {}, [
    { name: 'a world that accepts a non-finite number', impl: acceptsNonFinite },
  ]);
}

// ---- RB11 ---------------------------------------------------------------------------------------------------------

/** The main demo's four worlds on proof ports, world B (Location B) declaring a handshake that asks for a body. */
async function mainDemoWithJoin(ports, edits) {
  const { worldConfig, assertNotLiveDemoPorts } = require(path.join(ROOT, 'src', 'orchestrator.js'));
  const { loadWorlds, publicAddress } = require(path.join(ROOT, 'src', 'worlds-config.js'));
  const { NODES } = require(path.join(ROOT, 'runtime', 'world-server', 'src', 'config.js'));
  const { linkPortalArrivals } = require(path.join(ROOT, 'runtime', 'world-server', 'src', 'portal-standard.js'));
  const listed = loadWorlds({ strict: true }).worlds.filter((w) => ['a', 'b', 'lobby', 'airport'].includes(w.key));
  const backendPorts = Object.fromEntries(listed.map((w) => [w.key, ports.next()]));
  const frontendPort = ports.next();
  assertNotLiveDemoPorts(Object.assign({ frontend: frontendPort }, backendPorts));
  const worlds = listed.map((w) => ({ ...w, port: backendPorts[w.key], address: `http://127.0.0.1:${backendPorts[w.key]}/` }));
  const addressByLocation = {};
  for (const w of worlds) addressByLocation[w.template === w.key ? NODES[w.key].location_id : w.location_id] = publicAddress(w);
  const saved = process.env.OSL_WOW_SPATIAL_DIR;
  process.env.OSL_WOW_SPATIAL_DIR = makeTempDir('i5-rb11');
  const servers = [];
  let cfgB = null;
  try {
    for (const w of worlds) {
      const cfg = worldConfig(w, addressByLocation);
      if (w.key === 'b') {
        cfg.handshake = { base: w.address, label: w.name, claims: BODY_CLAIMS.map((c) => Object.assign({}, c)), issues: [], target_height_m: TARGET_HEIGHT_M };
        cfgB = cfg;
      }
      const built = lab.serverModule(edits).createServer(w.template === w.key ? w.key : (w.template || 'b'), cfg);
      await new Promise((resolve, reject) => { built.server.once('error', reject); built.server.listen(w.port, '127.0.0.1', resolve); });
      servers.push(built);
    }
  } finally {
    if (saved === undefined) delete process.env.OSL_WOW_SPATIAL_DIR;
    else process.env.OSL_WOW_SPATIAL_DIR = saved;
  }
  linkPortalArrivals(servers.map((s) => s.runtime));
  const frontend = await require(path.join(ROOT, 'src', 'serve.js')).createFrontendServer(frontendPort, { backendPorts });
  return {
    backendPorts,
    front: 'http://127.0.0.1:' + frontendPort,
    baseB: `http://127.0.0.1:${backendPorts.b}/`,
    locationB: cfgB.location_id,
    worldB: cfgB.world_id,
    close: async () => {
      await new Promise((resolve) => frontend.close(resolve));
      await Promise.allSettled(servers.map((s) => s.closeAll()));
    },
  };
}

async function sameFitCheck(ports) {
  const userWithoutItems = { server: { handshake: [['                if (Array.isArray(accepted.items)) user.items = JSON.parse(JSON.stringify(accepted.items));\n', '']] } };
  let browser = null;
  try {
    await run('RB11', 'other visitors see the same fit: a visitor joins Location B with avatar, display name, preferences (1.85 m), body and items (hammer, helmet); B\'s User carries them as sent; the main demo page in B draws that visitor from the User (its live pose asks for Adam with no items): Sophie, at 1.85 m within 0.01 m, holding the hammer and wearing the helmet, the file digest checked, and the same measures (each within 0.01 m) as the visitor\'s own files give at that height, from the User\'s details and from the body it draws', async (impl) => {
      const failures = [];
      const notes = [];
      if (!browser) {
        const { findBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools', 'find-browser.mjs')).href);
        const chrome = findBrowser();
        if (!chrome) return { ok: false, detail: 'no Chrome found: set PUPPETEER_EXECUTABLE_PATH to run RB11' };
        const puppeteer = require(require.resolve('puppeteer-core', { paths: [ROOT] }));
        browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1280, height: 800 } });
      }
      const L = await mainDemoWithJoin(ports, impl.server);
      const context = await browser.createBrowserContext();
      try {
        // 1. The visitor joins B (its agent, in Node), with the files the frontend serves.
        const assetBase = L.front + '/';
        const fx = fixtures(assetBase);
        const items = [fx.item('hammer'), fx.item('helmet')];
        const agent = await lab.agent();
        const wallet = { claims: { avatar: { uri: assetBase + 'assets/actionforge/characters/sophie/sophie.glb', label: 'Sophie' }, display_name: 'Ada', preferences: { preferred_height_m: 1.85 }, body: fx.wire, items }, pilot: 'agent' };
        const entered = await agent.enterWorld(L.baseB, { wallet });
        if (entered.status !== 201 || !entered.answer || !entered.answer.user) return { ok: false, detail: `the join answered ${entered.status} ${JSON.stringify(entered.answer && (entered.answer.reason || entered.answer.not_satisfied))}` };
        const userId = Number(entered.answer.user.split('/').pop());
        const user = (await httpReq('GET', L.backendPorts.b, '/wow/user/' + userId, null, { Accept: lab.WOW })).json || {};
        if (!same(user.body, fx.wire)) failures.push(`B's User ${userId} carries ${user.body ? 'a body that differs from the one sent' : 'no body'}`);
        if (!same(user.items, items)) failures.push(`B's User ${userId} carries ${Array.isArray(user.items) ? 'items ' + JSON.stringify(user.items.map((i) => i.itemId)) : 'no items'}, not hammer, helmet as sent`);
        if (user.osl_drawn_height_m !== 1.85) failures.push(`B's User ${userId} has drawn height ${user.osl_drawn_height_m}, not 1.85`);
        if (failures.length) return { ok: false, detail: failures.join('; ') };
        // What the visitor's own files give at the drawn height (the receiver run on Sophie's body file).
        const wire = await receiver();
        const own = fx.body;
        const k = 1.85 / own.measures.height_m;
        const ownMeasures = Object.fromEntries(Object.entries(wire.measuresOf(own)).map(([m, v]) => [m, v * k]));
        // 2. The second client: the main demo page in B.
        const page = await context.newPage();
        const consoleErrors = [];
        page.on('pageerror', (e) => consoleErrors.push(String(e && e.message || e).slice(0, 200)));
        const peerLog = [];
        page.on('console', (m) => { const t = m.text(); if (/co-presence:/.test(t)) peerLog.push(t.slice(0, 400)); });
        await page.goto(`${L.front}/w/b/?intro=bypass`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction(() => document.body.dataset.assemblyReady === '1' && window.__assembly && window.__assembly.debugState, { timeout: 120000 });
        await page.evaluate(() => { const b = document.querySelector('[data-testid="start-exploring"]'); if (b) b.click(); });
        await page.waitForFunction(() => window.__assembly.equipmentReady?.() !== false && window.__assembly.debugState().avatar, { timeout: 120000 });
        const local = await page.evaluate(() => { const a = window.__assembly.debugState().avatar; return { position: a.position.slice(), yaw: Number(a.rotation_y) || 0 }; });
        // 3. The visitor's live pose, from its own client (the lab's same-machine pose lane): it names the visitor by its User
        // id, and asks for Adam with no items, so only the User can make it Sophie with the hammer and the helmet.
        const at = [local.position[0] + 2.4 * Math.sin(local.yaw), local.position[1], local.position[2] + 2.4 * Math.cos(local.yaw)];
        const visitor = await context.newPage();
        await visitor.goto(`${L.front}/assets/actionforge/characters/sophie/sophie.avatar.json`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await visitor.evaluate((pose) => {
          const channel = new BroadcastChannel('open-spatial-lab-peer-presence');
          let seq = 0;
          const send = () => channel.postMessage(Object.assign({}, pose, { seq: ++seq, at: Date.now() }));
          send();
          window.__rb11Pose = setInterval(send, 500);
        }, { type: 'player-pose', client_id: 'rb11-visitor-' + userId, player_id: String(userId), location_id: L.locationB, world_id: L.worldB, display_name: 'Ada', position: at, rotation_y: local.yaw + Math.PI, avatar_variant: 'collection-adam', equippedItems: [], locomotion: {} });
        // 4. The second page draws the visitor from the User.
        const readPeer = () => page.evaluate(() => {
          const rig = window.__assembly.__depthProbeLayers().peer;
          if (!rig) return null;
          const fit = rig.userData.peerFit || null;
          const state = typeof rig.userData.peerState === 'function' ? rig.userData.peerState() : null;
          const drawnItems = [];
          rig.traverse((o) => { if (/^item:/.test(o.name)) { let v = true; for (let p = o; p; p = p.parent) if (p.visible === false) v = false; drawnItems.push({ name: o.name, visible: v }); } });
          return { fit, state, drawnItems, peers: window.__assembly.peerAvatars().map((p) => ({ player_id: p.player_id, avatar_variant: p.avatar_variant, rendered: p.rendered })) };
        });
        const settled = (r) => r && r.fit && r.state && r.state.variant === 'collection-sophie' && r.state.attached.length >= 2 && r.drawnItems.filter((d) => d.visible).length >= 2 && Number.isFinite(r.state.model_height_m) && Math.abs(r.state.model_height_m - 1.85) <= RECEIVER_LIMIT_M;
        let seen = null;
        const end = Date.now() + 120000;
        while (Date.now() < end) {
          seen = await readPeer();
          if (settled(seen)) break;
          await sleep(500);
        }
        if (!seen || !seen.fit) {
          const read = await page.evaluate(async (id) => {
            const r = await fetch('/w/b/wow/user/' + id, { cache: 'no-store', headers: { Accept: 'application/json' } }).catch((e) => ({ ok: false, status: String(e) }));
            let j = null; try { j = r.ok ? await r.json() : null; } catch (e) { j = null; }
            const backend = document.body.getAttribute('data-active-backend-url');
            let direct = null;
            if (backend) { const d = await fetch(backend + '/wow/user/' + id, { cache: 'no-store', headers: { Accept: 'application/json' } }).catch((e) => ({ status: String(e) })); direct = d.status; }
            return { via_frontend: r.status, has_body: !!(j && j.body), has_items: !!(j && j.items), backend, via_backend: direct };
          }, userId).catch((e) => String(e));
          failures.push('the second page draws the visitor with no fit from the User (' + JSON.stringify(seen && { peers: seen.peers, state: seen.state }) + '; page ' + JSON.stringify(read) + (peerLog.length ? '; its peer log: ' + peerLog.slice(-4).join(' | ') : '') + (consoleErrors.length ? '; page errors: ' + consoleErrors.slice(0, 3).join(' | ') : '') + ')');
        }
        else {
          const { fit, state, drawnItems } = seen;
          if (!fit.model || !fit.model.ok) failures.push('the second page did not accept the body\'s file: ' + JSON.stringify(fit.model));
          if (fit.drawn_height_m !== 1.85) failures.push(`the second page draws at ${fit.drawn_height_m}, not 1.85`);
          const keys = Object.keys(ownMeasures);
          const offUser = keys.filter((m) => !(fit.user_measures && close(fit.user_measures[m], ownMeasures[m], RECEIVER_LIMIT_M)));
          const offDrawn = keys.filter((m) => !(fit.drawn_measures && close(fit.drawn_measures[m], ownMeasures[m], RECEIVER_LIMIT_M)));
          if (offUser.length) failures.push('measures from the User differ from the visitor\'s own: ' + offUser.map((m) => `${m} ${fit.user_measures && fit.user_measures[m]} vs ${ownMeasures[m].toFixed(4)}`).join(', '));
          if (offDrawn.length) failures.push('measures of the body drawn differ from the visitor\'s own: ' + offDrawn.map((m) => `${m} ${fit.drawn_measures && fit.drawn_measures[m]} vs ${ownMeasures[m].toFixed(4)}`).join(', '));
          if (!state || state.variant !== 'collection-sophie') failures.push(`the visitor is drawn as ${state && state.variant}, not collection-sophie (the User's avatar)`);
          if (!state || !Number.isFinite(state.model_height_m) || Math.abs(state.model_height_m - 1.85) > RECEIVER_LIMIT_M) failures.push(`the visitor is drawn ${state && state.model_height_m} m tall, not 1.85 within ${RECEIVER_LIMIT_M}`);
          const attached = state ? state.attached.map((a) => a.runtime_item).sort().join() : '';
          if (attached !== 'hammer,helmet') failures.push(`the visitor is drawn with items ${JSON.stringify(attached)}, not hammer, helmet (refused ${JSON.stringify(fit.refused)})`);
          const visible = drawnItems.filter((d) => d.visible).map((d) => d.name).sort().join();
          if (visible !== 'item:hammer,item:helmet') failures.push(`the items drawn on the visitor are ${JSON.stringify(visible)}`);
          if (!failures.length) {
            const worst = Math.max(...keys.map((m) => Math.abs(fit.user_measures[m] - ownMeasures[m])), ...keys.map((m) => Math.abs(fit.drawn_measures[m] - ownMeasures[m])));
            notes.push(`User ${userId} carries the body (${fx.wire.bones.length} bones), hammer, helmet and drawn height 1.85; the second page draws it as Sophie (its pose asked for Adam, no items), ${state.model_height_m} m tall, file digest ${fit.model.digest.slice(0, 19)}... checked, holding the hammer and wearing the helmet (${visible}); ${keys.length} measures within ${worst.toExponential(2)} m of the visitor's own files at 1.85 m`);
            if (!impl.server) {
              await sleep(1500);
              await page.screenshot({ path: path.join(ROOT, 'diagnostics', 'arch-i5-rb11-same-fit.png') }).catch(() => {});
            }
          }
        }
        await visitor.evaluate(() => clearInterval(window.__rb11Pose)).catch(() => {});
        return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : notes.join('; ') };
      } finally {
        await context.close().catch(() => {});
        await L.close();
      }
    }, {}, [
      { name: 'a User that drops items', impl: userWithoutItems },
    ]);
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { bodyChecks, sameFitCheck, BODY_CLAIMS };
