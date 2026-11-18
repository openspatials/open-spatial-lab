// wire.mjs: the receiver's side of a body and items that arrive through a join (contract section 9, 9.8).
//
// A world copies the `body` and `items` it accepted onto the User it makes (RB.11). This module turns that wire form
// into the receiver's own input (the shapes of <id>.body.json and of the item catalog, which fitting/ reads), checks the
// details against the files they describe (RB.4), and sizes the body to the height the world set (RB.5). It loads no
// three.js and no file of its own: the page and Node use it the same way.
//
// Public API
//   bodyFromWire(wire)                the receiver's body input (osl-fitting-body/1 fields the fitting reads) from a wire
//                                     body: roles, rest_pose (avatar frame), hands, feet, volumes, bone_lengths_m, measures
//                                     (forearm_radius_m sent, the rest worked out here), source.sha256. A wire body carries
//                                     no file-local bone values; a receiver takes those from the file it fetched.
//   itemFromWire(entity)              the receiver's catalog item from a wire item entity ({ itemId, assetUri, mode, fit })
//   measuresOf(body)                  the measures section 9.3 names, worked out from a receiver body: height_m,
//                                     hips_height_m, leg_length_m, arm_length_m, shoulder_width_m, hip_width_m,
//                                     torso_height_m, torso_width_m, torso_depth_m, head_height_m, head_width_m, head_depth_m
//   scaleBody(body, drawnHeight)      RB.5: every length times drawnHeight / measures.height_m (a new body)
//   digestOf(bytes)                   "sha-256:" and the hex SHA-256 of the bytes
//   receiveVisitor(user, options)     RB.4 and RB.5 for one User: { model, drawn_height_m, height_from, body, measures,
//                                     items, refused }. options: readBytes(url) -> ArrayBuffer, targetHeight (the world's
//                                     target height, used when the User carries no drawn height), knownItem(itemId) ->
//                                     true for an item this receiver can draw.
//   MODEL_MISMATCH                    the reason RB.4 gives: "details do not match the file"

export const MODEL_MISMATCH = "details do not match the file";

const SIDES = Object.freeze({ left: "l", right: "r" });
const FORWARD_YAW = Object.freeze({ "+Z": 0, "-Z": Math.PI, "+X": -Math.PI / 2, "-X": Math.PI / 2 });
// A wire measure name (camelCase) and the receiver's (snake_case, in meters).
const measureName = (name) => `${name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)}_m`;
// A bone's length: from its joint to the next role's joint (section 9.2).
const NEXT_ROLE = Object.freeze(Object.fromEntries([
  ["hips", "spine"], ["spine", "chest"], ["chest", "upperChest"], ["upperChest", "neck"], ["neck", "head"],
  ...["left", "right"].flatMap((s) => [
    [`${s}Shoulder`, `${s}UpperArm`], [`${s}UpperArm`, `${s}LowerArm`], [`${s}LowerArm`, `${s}Hand`],
    [`${s}UpperLeg`, `${s}LowerLeg`], [`${s}LowerLeg`, `${s}Foot`], [`${s}Foot`, `${s}Toes`],
  ]),
]));

// Quaternions [x, y, z, w] and vectors, by hand: no three.js here.
function qmul(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
function qrot(q, v) {
  const p = qmul(qmul(q, [v[0], v[1], v[2], 0]), [-q[0], -q[1], -q[2], q[3]]);
  return [p[0], p[1], p[2]];
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;

export function bodyFromWire(wire) {
  const bones = wire.bones;
  const world = [];
  const restPose = {};
  const roles = {};
  bones.forEach((bone, i) => {
    const up = Number.isInteger(bone.parent) ? world[bone.parent] : { p: [0, 0, 0], q: [0, 0, 0, 1] };
    const here = { p: add(up.p, qrot(up.q, bone.t)), q: qmul(up.q, bone.r) };
    world[i] = here;
    restPose[bone.name] = {
      parent: Number.isInteger(bone.parent) ? bones[bone.parent].name : null,
      position_m: here.p,
      rotation: here.q,
      scale: [1, 1, 1],
    };
    if (typeof bone.role === "string") roles[bone.role] = bone.name;
  });
  const hand = (h) => {
    const hollows = {};
    for (const entry of h.hollows || []) hollows[`${entry.clip}@${entry.time}`] = { position_m: entry.point, ...(entry.radius !== undefined ? { radius_m: entry.radius } : {}) };
    const first = (h.hollows || [])[0];
    return {
      grip_frame: { knuckle_axis: h.gripAxis, forward_axis: h.forwardAxis },
      palm_m: h.palm,
      hand_length_m: h.length,
      ...(first ? { hollow: { grip: `${first.clip}@${first.time}`, ...hollows[`${first.clip}@${first.time}`] } } : {}),
      hollows,
    };
  };
  const foot = (f) => ({ length_m: f.length, sole_height_m: f.soleHeight, sole_points_m: { foot: f.solePoints.foot, toes: f.solePoints.toes } });
  const volume = (v) => ({ origin_role: v.bone, min_m: v.min, max_m: v.max });
  const body = {
    schema: "osl-fitting-body/1",
    rig: { structure: wire.structure, facing_yaw_rad: FORWARD_YAW[wire.model.forward] ?? 0 },
    roles,
    rest_pose: restPose,
    hands: Object.fromEntries(Object.entries(SIDES).filter(([side]) => wire.hands && wire.hands[side]).map(([side, s]) => [s, hand(wire.hands[side])])),
    feet: Object.fromEntries(Object.entries(SIDES).filter(([side]) => wire.feet && wire.feet[side]).map(([side, s]) => [s, foot(wire.feet[side])])),
    volumes: {
      head: volume(wire.volumes.head),
      torso: volume(wire.volumes.torso),
      torso_parts: Object.fromEntries((wire.volumes.torsoParts || []).map((v) => [v.bone, volume(v)])),
    },
    source: { sha256: String(wire.model.digest).replace(/^sha-256:/, "") },
  };
  body.bone_lengths_m = boneLengths(body);
  body.measures = { forearm_radius_m: wire.forearmRadius, ...measuresOf({ ...body, measures: { height_m: wire.height } }) };
  return body;
}

function boneLengths(body) {
  const at = (role) => (body.roles[role] && body.rest_pose[body.roles[role]] ? body.rest_pose[body.roles[role]].position_m : null);
  const out = {};
  for (const [role, next] of Object.entries(NEXT_ROLE)) {
    const a = at(role), b = at(next);
    if (a && b) out[role] = dist(a, b);
  }
  return out;
}

export function measuresOf(body) {
  const at = (role) => {
    const name = body.roles[role];
    if (!name || !body.rest_pose[name]) throw new Error(`body has no ${role}`);
    return body.rest_pose[name].position_m;
  };
  const has = (role) => !!(body.roles[role] && body.rest_pose[body.roles[role]]);
  const toeY = ["left", "right"].map((s) => at(has(`${s}Toes`) ? `${s}Toes` : `${s}Foot`)[1]);
  const extent = (v, i) => v.max_m[i] - v.min_m[i];
  const torso = body.volumes.torso, head = body.volumes.head;
  return {
    height_m: body.measures.height_m,
    hips_height_m: at("hips")[1] - Math.min(...toeY),
    leg_length_m: mean(["left", "right"].map((s) => dist(at(`${s}UpperLeg`), at(`${s}LowerLeg`)) + dist(at(`${s}LowerLeg`), at(`${s}Foot`)))),
    arm_length_m: mean(["left", "right"].map((s) => dist(at(`${s}UpperArm`), at(`${s}LowerArm`)) + dist(at(`${s}LowerArm`), at(`${s}Hand`)))),
    shoulder_width_m: dist(at("leftUpperArm"), at("rightUpperArm")),
    hip_width_m: dist(at("leftUpperLeg"), at("rightUpperLeg")),
    torso_height_m: dist(at("hips"), at(has("neck") ? "neck" : "head")),
    torso_width_m: extent(torso, 0),
    torso_depth_m: extent(torso, 2),
    head_height_m: extent(head, 1),
    head_width_m: extent(head, 0),
    head_depth_m: extent(head, 2),
  };
}

export function scaleBody(body, drawnHeight) {
  const k = drawnHeight / body.measures.height_m;
  const v = (a) => a.map((x) => x * k);
  const out = JSON.parse(JSON.stringify(body));
  for (const node of Object.values(out.rest_pose)) node.position_m = v(node.position_m);
  for (const h of Object.values(out.hands)) {
    h.palm_m = v(h.palm_m);
    h.hand_length_m *= k;
    for (const entry of [h.hollow, ...Object.values(h.hollows)].filter(Boolean)) {
      entry.position_m = v(entry.position_m);
      if (entry.radius_m !== undefined) entry.radius_m *= k;
    }
  }
  for (const f of Object.values(out.feet)) {
    f.length_m *= k;
    f.sole_height_m *= k;
    for (const list of Object.values(f.sole_points_m)) list.forEach((p, i) => { list[i] = v(p); });
  }
  for (const vol of [out.volumes.head, out.volumes.torso, ...Object.values(out.volumes.torso_parts)]) {
    vol.min_m = v(vol.min_m);
    vol.max_m = v(vol.max_m);
  }
  for (const key of Object.keys(out.bone_lengths_m)) out.bone_lengths_m[key] *= k;
  for (const key of Object.keys(out.measures)) out.measures[key] *= k;
  return out;
}

export function itemFromWire(entity) {
  const fit = entity.fit || {};
  const contacts = Array.isArray(fit.contacts) ? fit.contacts : [];
  const item = { id: entity.itemId, mode: entity.mode, hands: contacts.length };
  if (contacts.length === 1) item.hand = SIDES[contacts[0].hand];
  if (contacts.length) {
    item.contacts = Object.fromEntries(contacts.map((c) => [SIDES[c.hand], {
      point: c.point, grip_axis: c.gripAxis, forward_axis: c.forwardAxis, ...(c.slide !== undefined ? { slide_m: c.slide } : {}),
    }]));
  }
  if (fit.size) item.size_m = fit.size;
  const worn = !contacts.length && !!fit.placement;
  if (fit.fileScale !== undefined) item[worn ? "scale_m_per_unit" : "scale"] = fit.fileScale;
  if (fit.stance) item.stance = fit.stance.clip;
  if (fit.grip) item.grip = { clip: fit.grip.clip, time: fit.grip.time };
  const on = contacts.length ? contacts[0].on || "hollow" : undefined;
  if (fit.placement) {
    const p = fit.placement;
    const offset = {};
    for (const [part, o] of Object.entries(p.offset || {})) {
      offset[part] = { ...(o.measure ? { measure: measureName(o.measure) } : {}), ...(o.factor !== undefined ? { factor: o.factor } : {}), ...(o.add !== undefined ? { add_m: o.add } : {}) };
    }
    item.placement = {
      anchor: p.anchor,
      ...(on ? { contact_on_hand: on } : {}),
      ...(p.rotation ? { rotation: p.rotation } : {}),
      ...(p.attachPoint ? { attach_point: p.attachPoint } : {}),
      ...(fit.scale ? { scale_with: measureName(fit.scale.by) } : {}),
      ...(fit.scale && !worn ? { scale_reference_m: fit.scale.reference } : {}),
      ...(p.clearOfTorso !== undefined ? { clear_of_torso_m: p.clearOfTorso } : {}),
      ...(Object.keys(offset).length ? { offset } : {}),
    };
  } else if (contacts.length) {
    item.placement = { anchor: "hand", contact_on_hand: on };
  }
  return item;
}

const hex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

export async function digestOf(bytes) {
  return `sha-256:${hex(await globalThis.crypto.subtle.digest("SHA-256", bytes))}`;
}

export async function receiveVisitor(user, { readBytes, targetHeight, knownItem = () => true } = {}) {
  const out = { model: null, drawn_height_m: null, height_from: null, body: null, measures: null, items: [], refused: [] };
  const wire = user && user.body;
  if (!wire || typeof user.AvatarURI !== "string") return out;
  // RB.4: the details belong to the file the receiver fetched.
  let got = null;
  try { got = await digestOf(await readBytes(user.AvatarURI)); } catch (error) { got = null; out.model = { ok: false, reason: `the avatar file could not be read (${error && error.message || error})` }; }
  if (got !== null) out.model = got === wire.model.digest ? { ok: true, digest: got } : { ok: false, reason: MODEL_MISMATCH, digest: got, stated: wire.model.digest };
  // RB.5: the world sets the drawn height, from the visitor's preferred_height_m or its own target.
  const drawn = Number(user.osl_drawn_height_m);
  out.drawn_height_m = Number.isFinite(drawn) && drawn > 0 ? drawn : targetHeight;
  out.height_from = Number.isFinite(drawn) && drawn > 0 ? "the world (User.osl_drawn_height_m)" : "this receiver's target height";
  if (!out.model.ok) {
    // No fitting from details that do not belong to the file: the avatar is drawn plain, and no item is fitted.
    for (const entity of user.items || []) out.refused.push({ itemId: entity && entity.itemId, reason: out.model.reason });
    return out;
  }
  out.body = scaleBody(bodyFromWire(wire), out.drawn_height_m);
  out.measures = measuresOf(out.body);
  for (const entity of user.items || []) {
    const item = itemFromWire(entity);
    let reason = null;
    if (!knownItem(item.id)) reason = "this receiver has no such item";
    else {
      let itemDigest = null;
      try { itemDigest = await digestOf(await readBytes(entity.assetUri)); } catch (error) { reason = `the item file could not be read (${error && error.message || error})`; }
      if (!reason && itemDigest !== entity.fit.model.digest) reason = MODEL_MISMATCH;
    }
    if (reason) out.refused.push({ itemId: item.id, reason });
    else out.items.push(item);
  }
  return out;
}
