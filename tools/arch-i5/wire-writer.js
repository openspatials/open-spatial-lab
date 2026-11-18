'use strict';

/*
 * The sender's side of contract section 9, for the proof: it writes the wire form of a body and of an item from the
 * receiver's own files (an <id>.body.json and the item catalog), as section 9.8 maps the names. It runs in the
 * other direction from the receiver's converter (web/avatar/runtime/wire.mjs) and shares no code with it, so a
 * converter check that reads this wire form back tests the converter, not a copy of itself.
 *
 *   wireBody(body, glbBytes)          the wire body: model { digest, forward }, height, structure, bones (parent before
 *                                     child, t and r from the avatar-frame position_m and rotation), forearmRadius,
 *                                     hands, feet, volumes
 *   wireItem(item, { bytes, assetUri, reference })   one item entity: { itemId, assetUri, mode, fit }
 *   digest(bytes)                     "sha-256:" and the hex SHA-256
 */

const crypto = require('crypto');

const digest = (bytes) => 'sha-256:' + crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const SIDE = { l: 'left', r: 'right' };
const YAW_FORWARD = [[0, '+Z'], [Math.PI, '-Z'], [-Math.PI / 2, '+X'], [Math.PI / 2, '-X']];
const camel = (name) => name.replace(/_m$/, '').replace(/_([a-z])/g, (m, c) => c.toUpperCase());

function conj(q) { return [-q[0], -q[1], -q[2], q[3]]; }
function mul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function rotate(q, v) { const p = mul(mul(q, [v[0], v[1], v[2], 0]), conj(q)); return [p[0], p[1], p[2]]; }
function unit(q) { const n = Math.hypot(...q); return q.map((x) => x / n); }

function wireBody(body, glbBytes) {
  // Bones in an order where a parent comes before its children.
  const names = Object.keys(body.rest_pose);
  const order = [];
  const placed = new Set();
  const visit = (name) => {
    if (placed.has(name)) return;
    const parent = body.rest_pose[name].parent;
    if (parent) visit(parent);
    placed.add(name);
    order.push(name);
  };
  names.forEach(visit);
  const index = new Map(order.map((n, i) => [n, i]));
  const roleOf = new Map(Object.entries(body.roles).filter(([, n]) => typeof n === 'string').map(([r, n]) => [n, r]));
  const bones = order.map((name) => {
    const node = body.rest_pose[name];
    const q = unit(node.rotation);
    const bone = { name };
    if (node.parent) {
      const up = body.rest_pose[node.parent];
      const upQ = unit(up.rotation);
      const inv = conj(upQ);
      bone.parent = index.get(node.parent);
      bone.t = rotate(inv, node.position_m.map((x, i) => x - up.position_m[i]));
      bone.r = unit(mul(inv, q));
    } else {
      bone.t = node.position_m.slice();
      bone.r = q;
    }
    if (roleOf.has(name)) bone.role = roleOf.get(name);
    return bone;
  });
  const hand = (h) => {
    const entries = Object.entries(h.hollows || {});
    const first = h.hollow && h.hollow.grip;
    entries.sort(([a], [b]) => (a === first ? -1 : b === first ? 1 : 0));
    return {
      gripAxis: h.grip_frame.knuckle_axis,
      forwardAxis: h.grip_frame.forward_axis,
      palm: h.palm_m,
      length: h.hand_length_m,
      hollows: entries.map(([key, v]) => {
        const at = key.lastIndexOf('@');
        return { clip: key.slice(0, at), time: Number(key.slice(at + 1)), point: v.position_m, ...(v.radius_m !== undefined ? { radius: v.radius_m } : {}) };
      }),
    };
  };
  const foot = (f) => ({ length: f.length_m, soleHeight: f.sole_height_m, solePoints: { foot: f.sole_points_m.foot, toes: f.sole_points_m.toes } });
  const volume = (v) => ({ bone: v.origin_role, min: v.min_m, max: v.max_m });
  const yaw = body.rig.facing_yaw_rad || 0;
  return {
    model: { digest: digest(glbBytes), forward: (YAW_FORWARD.find(([y]) => Math.abs(y - yaw) < 1e-6) || [0, '+Z'])[1] },
    height: body.measures.height_m,
    structure: body.rig.structure,
    bones,
    forearmRadius: body.measures.forearm_radius_m,
    hands: { left: hand(body.hands.l), right: hand(body.hands.r) },
    feet: { left: foot(body.feet.l), right: foot(body.feet.r) },
    volumes: {
      head: volume(body.volumes.head),
      torso: volume(body.volumes.torso),
      torsoParts: Object.values(body.volumes.torso_parts).map(volume),
    },
  };
}

/** One catalog item as a wire item entity. reference: the measures of the body a worn item's scale refers to. */
function wireItem(item, { bytes, assetUri, reference }) {
  const p = item.placement || {};
  const fit = { model: { digest: digest(bytes) } };
  if (item.size_m) fit.size = item.size_m;
  const fileScale = item.scale_m_per_unit !== undefined ? item.scale_m_per_unit : item.scale;
  if (fileScale !== undefined) fit.fileScale = fileScale;
  if (p.scale_with) fit.scale = { by: camel(p.scale_with), reference: p.scale_reference_m !== undefined ? p.scale_reference_m : reference[p.scale_with] };
  if (item.contacts) {
    fit.contacts = Object.entries(item.contacts).map(([side, c]) => ({
      hand: SIDE[side],
      on: p.contact_on_hand || 'hollow',
      point: c.point,
      gripAxis: c.grip_axis,
      forwardAxis: c.forward_axis,
      ...(c.slide_m !== undefined ? { slide: c.slide_m } : {}),
    }));
  }
  if (p.anchor && p.anchor !== 'hand') {
    const placement = { anchor: p.anchor };
    if (p.offset) {
      placement.offset = {};
      for (const [part, o] of Object.entries(p.offset)) {
        placement.offset[part] = { ...(o.measure ? { measure: camel(o.measure) } : {}), ...(o.factor !== undefined ? { factor: o.factor } : {}), ...(o.add_m !== undefined ? { add: o.add_m } : {}) };
      }
    }
    if (p.clear_of_torso_m !== undefined) placement.clearOfTorso = p.clear_of_torso_m;
    if (p.rotation) placement.rotation = p.rotation;
    if (p.attach_point) placement.attachPoint = p.attach_point;
    fit.placement = placement;
  }
  if (item.stance) fit.stance = { pack: 'actionforge-cc0', clip: item.stance };
  if (item.grip) fit.grip = { pack: 'actionforge-cc0', clip: item.grip.clip, time: item.grip.time };
  return { itemId: item.id, assetUri, mode: item.mode, fit };
}

module.exports = { wireBody, wireItem, digest };
