// How the avatar moves in the main demo, as a Player with real keyboard and mouse input.
//   node tools/behavior/movement.check.mjs [--faults] [--only id,id]
//
// Every distance is for a hold counted in the movement loop's own time (see kit.mjs): on a loaded machine a second of
// wall time can give the loop anything from 0.05 s to a full second, but a second of its time is always the same walk.
// The avatar runtime turns the avatar to the keys' direction (on the spot first) and speeds it up before it walks at
// pace, so each walk is measured after kit.PACE_S of that.
import { angleBetween, blurWindow, expect, faceYaw, fixed, holdKeys, inRange, PACE_S, pageFacts, planar, runBehavior, sleep, untilClock, WALK_M, waitUntil, walkTo, worldRecord } from "./kit.mjs";

const HOLD_S = 0.6;
const HEADING_RAD = 0.15;
const RUN_OVER_WALK = [3.0, 5.0]; // the jog, 4.8 to 5.0 m/s, against the walk, 1.06 to 1.15 m/s: 4.2 to 4.7 times
const RUN_SETTLE_S = 1.3; // half a turn, then the speed-up to the jog at about 7.5 m/s per second
const RUN_HOLD_S = 0.3; // 1.4 to 1.5 m of the jog, which keeps it on the open floor
const COAST_M = 0.45; // what may still pass after a release, measured over 0.5 s of the loop's time (the runtime stops a walk in 0.07 m); a stuck key gives 0.6 m
const DRAG_PX = 200;
const DRAG_RAD = [0.7, 1.4]; // measured 1.04 (0.0052 rad per pixel)
const JUMP_PEAK_M = [0.45, 1.2]; // the runtime's jump tops out at 0.75 m
const LANDED_M = 0.02;
const STILL_M = 0.02;
const PERIMETER_M = 5.6; // measured stop at 5.4; the room's walls are at 6
const TO_PERIMETER_S = 2.6; // from z 3.6: a turn, then 1.8 m at walking pace
const RECORD_M = 0.05;
const PEER_M = 0.3;

const lobby = (ctx) => `${ctx.lab.front}/index.html?role=player&intro=bypass`;
const visitor = (ctx) => ctx.once("visitor", () => ctx.visit(lobby(ctx)));

/** The middle of the Lobby's open half, turned to walk along +X with the walls and the portals out of reach. */
async function atOpenFloor(ctx, x = -1) {
  const page = await visitor(ctx);
  await page.bringToFront();
  await walkTo(page, x, 2);
  await faceYaw(page, Math.PI / 2);
  await sleep(300);
  return page;
}

function expectWalk(walk, keys, wantedHeading) {
  expect(inRange(walk.distance, WALK_M), `${keys} walked ${fixed(walk.distance)} m in ${HOLD_S} s of loop time, not ${WALK_M.join(" to ")} m`);
  const off = angleBetween(walk.heading, wantedHeading);
  expect(off <= HEADING_RAD, `${keys} walked ${fixed(off)} rad off the way it should go`);
  const body = angleBetween(walk.after.facing, walk.heading);
  expect(body <= HEADING_RAD, `${keys} walked with the avatar facing ${fixed(body)} rad off the way it walks`);
  return `${keys}: ${fixed(walk.distance)} m, ${fixed(off)} rad off, the avatar facing ${fixed(body)} rad off its way`;
}

const statements = [
  { id: "release-stops", says: `Releasing the keys stops it within ${COAST_M} m`, async run(ctx) {
    const page = await visitor(ctx);
    const walk = await holdKeys(page, ["s"], HOLD_S);
    expect(walk.distance > 0.5, `S walked only ${fixed(walk.distance)} m (the check would be vacuous)`);
    const released = await pageFacts(page);
    const later = await untilClock(page, 0.5);
    const coast = planar(later.position, walk.after.position);
    expect(coast <= COAST_M && !later.moving, `after the release it went on ${fixed(coast)} m; moving: ${later.moving}`);
    return `went on ${fixed(coast)} m, ${fixed(planar(released.position, walk.after.position))} m of it before the first read`;
  } },
  { id: "w-along-facing", says: `W walks along the facing direction, the avatar facing its way, ${WALK_M.join(" to ")} m in ${HOLD_S} s of loop time`, async run(ctx) {
    const page = await atOpenFloor(ctx);
    const walk = await holdKeys(page, ["w"], HOLD_S);
    const detail = expectWalk(walk, "W", walk.after.basis);
    const facing = angleBetween(walk.after.facing, walk.after.basis);
    expect(facing <= HEADING_RAD, `after W the avatar faces ${fixed(facing)} rad off the facing direction`);
    return detail;
  } },
  { id: "s-against-facing", says: `S turns the avatar round and walks it against the facing direction, ${WALK_M.join(" to ")} m in ${HOLD_S} s of loop time`, async run(ctx) {
    const page = await atOpenFloor(ctx, 0.5);
    const walk = await holdKeys(page, ["s"], HOLD_S);
    return expectWalk(walk, "S", walk.after.basis + Math.PI);
  } },
  { id: "a-d-across-facing", says: `A and D turn the avatar and walk it across the facing direction, left and right, ${WALK_M.join(" to ")} m each`, async run(ctx) {
    const page = await atOpenFloor(ctx);
    const left = await holdKeys(page, ["a"], HOLD_S);
    const right = await holdKeys(page, ["d"], HOLD_S);
    return `${expectWalk(left, "A", left.after.basis + Math.PI / 2)}; ${expectWalk(right, "D", right.after.basis - Math.PI / 2)}`;
  } },
  { id: "diagonal-is-not-faster", says: `W and D together walk no faster than W alone: ${WALK_M.join(" to ")} m in ${HOLD_S} s of loop time, half way between forward and right`, async run(ctx) {
    const page = await atOpenFloor(ctx);
    const walk = await holdKeys(page, ["w", "d"], HOLD_S);
    return expectWalk(walk, "W and D", walk.after.basis - Math.PI / 4);
  } },
  { id: "shift-runs", says: `Shift makes it faster than walking, ${RUN_OVER_WALK.join(" to ")} times`, async run(ctx) {
    const page = await atOpenFloor(ctx);
    const walk = await holdKeys(page, ["w"], HOLD_S);
    const run = await holdKeys(page, ["Shift", "s"], RUN_HOLD_S, { settle: RUN_SETTLE_S });
    const ratio = run.speed / walk.speed;
    expect(inRange(ratio, RUN_OVER_WALK), `with Shift it moved ${fixed(ratio)} times the walking speed (${fixed(run.speed)} against ${fixed(walk.speed)} m/s)`);
    return `${fixed(run.speed)} against ${fixed(walk.speed)} m/s of loop time`;
  } },
  { id: "drag-turns", says: `A drag of ${DRAG_PX} px turns the facing direction ${DRAG_RAD.join(" to ")} rad, the way it was dragged`, async run(ctx) {
    const page = await visitor(ctx);
    const before = await pageFacts(page);
    const box = await page.$eval("#scene-mount", (mount) => { const r = mount.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.8 }; });
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x + DRAG_PX, box.y, { steps: 6 });
    await page.mouse.up();
    const after = await untilClock(page, 0.6);
    const turned = before.basis - after.basis;
    const wrapped = Math.atan2(Math.sin(turned), Math.cos(turned));
    expect(inRange(wrapped, DRAG_RAD), `a drag to the right turned the facing direction ${fixed(wrapped)} rad, not ${DRAG_RAD.join(" to ")}`);
    return `turned ${fixed(wrapped)} rad`;
  } },
  { id: "space-lifts", says: `Space lifts it ${JUMP_PEAK_M.join(" to ")} m`, async run(ctx) {
    const page = await atOpenFloor(ctx);
    const jump = await ctx.once("jump", () => jumpOnce(page));
    expect(inRange(jump.peak, JUMP_PEAK_M), `Space lifted it ${fixed(jump.peak)} m, not ${JUMP_PEAK_M.join(" to ")} m`);
    return `peak ${fixed(jump.peak)} m`;
  } },
  { id: "lands-at-floor", says: `It lands within ${LANDED_M} m of floor height`, async run(ctx) {
    const page = await atOpenFloor(ctx);
    const jump = await ctx.once("jump", () => jumpOnce(page));
    expect(jump.landed !== null, `it never landed: still ${fixed(jump.last)} m up after ${jump.waited} s of loop time`);
    expect(Math.abs(jump.landed - jump.floor) <= LANDED_M, `it landed ${fixed(jump.landed - jump.floor)} m from floor height`);
    return `landed at ${fixed(jump.landed)} m, floor ${fixed(jump.floor)} m`;
  } },
  { id: "typing-does-not-move", says: `Keys typed in a text field move it no more than ${STILL_M} m`, async run(ctx) {
    const page = await atOpenFloor(ctx);
    await page.click('[data-testid="rail-toggle"]');
    await sleep(600);
    await page.click("#wow-id-input");
    const before = await pageFacts(page);
    await page.keyboard.down("w");
    const after = await untilClock(page, 0.3);
    await page.keyboard.up("w");
    await page.keyboard.type("asd", { delay: 40 });
    const end = await pageFacts(page);
    const typed = await page.$eval("#wow-id-input", (input) => input.value);
    await page.$eval("#wow-id-input", (input) => input.blur());
    await page.click('[data-testid="panel-close"]');
    const moved = Math.max(planar(after.position, before.position), planar(end.position, before.position));
    expect(moved <= STILL_M, `typing moved the avatar ${fixed(moved)} m`);
    expect(/asd$/.test(typed), `the text field holds "${typed}" (the check would be vacuous)`);
    return `the field holds "${typed}"; moved ${fixed(moved)} m`;
  } },
  { id: "blur-stops", says: `A window blur stops a held key: ${COAST_M} m at most, with the key still down`, async run(ctx) {
    const page = await atOpenFloor(ctx, -1);
    const start = await pageFacts(page);
    await page.keyboard.down("w");
    const going = await untilClock(page, PACE_S);
    expect(planar(going.position, start.position) > 0.2, `W walked only ${fixed(planar(going.position, start.position))} m before the blur (the check would be vacuous)`);
    await blurWindow(page);
    const later = await untilClock(page, 0.5);
    await page.keyboard.up("w");
    const moved = planar(later.position, going.position);
    expect(moved <= COAST_M, `with the window blurred and the key down it went on ${fixed(moved)} m`);
    return `went on ${fixed(moved)} m`;
  } },
  { id: "perimeter-stops", says: `The Lobby's perimeter stops it: it stays inside ${PERIMETER_M} m and stands, with W still down`, async run(ctx) {
    const page = await visitor(ctx);
    await page.bringToFront();
    await walkTo(page, 1, 3.6);
    await faceYaw(page, 0);
    await page.keyboard.down("w");
    await untilClock(page, TO_PERIMETER_S);
    const atIt = await pageFacts(page);
    const later = await untilClock(page, 0.5);
    await page.keyboard.up("w");
    expect(later.position[2] <= PERIMETER_M, `it passed through: at z ${fixed(later.position[2])} m, the perimeter is ${PERIMETER_M} m`);
    expect(later.position[2] > 4.8, `it stopped short at z ${fixed(later.position[2])} m (the check would be vacuous)`);
    expect(planar(later.position, atIt.position) <= STILL_M, `at the perimeter it still moved ${fixed(planar(later.position, atIt.position))} m`);
    return `stands at z ${fixed(later.position[2])} m with W down`;
  } },
  { id: "world-record-follows", says: `The world's own record of the avatar follows to within ${RECORD_M} m`, async run(ctx) {
    const page = await atOpenFloor(ctx);
    await holdKeys(page, ["w"], HOLD_S);
    const { playerId, position } = await pageFacts(page);
    let seen = null;
    await waitUntil(async () => {
      const record = (await worldRecord(ctx.lab, "lobby")).avatars.find((avatar) => avatar.player_id === playerId);
      seen = record ? record.position : null;
      return seen && planar(seen, position) <= RECORD_M;
    }, () => `the world's record stands ${seen ? fixed(planar(seen, position)) : "no"} m from the avatar`, { limitMs: 15000 });
    return `record ${fixed(planar(seen, position))} m from the avatar`;
  } },
  { id: "second-visitor-sees", says: `A second visitor in the same world sees the first one move, to within ${PEER_M} m`, async run(ctx) {
    const page = await atOpenFloor(ctx);
    const second = await ctx.visit(lobby(ctx), { sameProfileAs: page });
    const first = await pageFacts(page);
    const peerOf = async () => (await pageFacts(second, { with: ["peers"] })).peers.find((peer) => peer.player_id === first.playerId);
    const seenBefore = await waitUntil(peerOf, "the second visitor never saw the first", { limitMs: 30000 });
    await page.bringToFront();
    const walk = await holdKeys(page, ["w"], HOLD_S);
    await sleep(800);
    await second.bringToFront();
    let seen = null;
    await waitUntil(async () => {
      seen = await peerOf();
      return seen && planar(seen.position, walk.after.position) <= PEER_M;
    }, () => `the second visitor sees the first ${seen ? fixed(planar(seen.position, walk.after.position)) : "no"} m from where it is`, { limitMs: 15000 });
    expect(seen.rendered, "the second visitor holds the first but does not draw it");
    await second.close();
    return `first moved ${fixed(walk.distance)} m; the second saw it go from ${seenBefore.position.map((v) => fixed(v, 1))} to ${seen.position.map((v) => fixed(v, 1))}`;
  } },
];

/** One jump: the height it reaches and where it comes down, read as often as the page answers. */
async function jumpOnce(page) {
  const start = await pageFacts(page);
  await page.keyboard.press("Space");
  const result = { floor: start.position[1], peak: 0, landed: null, last: start.position[1], waited: 0 };
  let airborne = false;
  for (;;) {
    const facts = await pageFacts(page);
    result.peak = Math.max(result.peak, facts.position[1] - start.position[1]);
    result.last = facts.position[1];
    result.waited = fixed(facts.clock - start.clock, 1);
    if (!facts.grounded) airborne = true;
    if (airborne && facts.grounded) { result.landed = facts.position[1]; return result; }
    if (facts.clock - start.clock > 4) return result;
    await sleep(20);
  }
}

const MOVE = "web/movement-camera-controller.mjs";
const ADAPTER = "web/live-adapter.js";
const LOCOMOTION = "web/avatar/runtime/locomotion.mjs";
const faults = [
  { statement: "release-stops", name: "a released key is never cleared", expect: /after the release it went on/, edits: [{ file: MOVE, find: "      controlState[control] = pressed;\n", replace: "      if (pressed) controlState[control] = true;\n" }] },
  { statement: "w-along-facing", name: "the walking speed is off by half", expect: /W walked 0\.\d+ m in/, edits: [{ file: LOCOMOTION, find: "const walkRate = 1.2;", replace: "const walkRate = 0.6;" }] },
  { statement: "s-against-facing", name: "S walks forward", expect: /S walked [\d.]+ rad off/, edits: [{ file: ADAPTER, find: "const forward = (controls.forward ? 1 : 0) - (controls.back ? 1 : 0);", replace: "const forward = (controls.forward || controls.back ? 1 : 0);" }] },
  { statement: "a-d-across-facing", name: "A and D swapped", expect: /A walked [\d.]+ rad off/, edits: [{ file: ADAPTER, find: "const strafe = (controls.right ? 1 : 0) - (controls.left ? 1 : 0);", replace: "const strafe = (controls.left ? 1 : 0) - (controls.right ? 1 : 0);" }] },
  { statement: "a-d-across-facing", name: "the avatar is drawn facing its old way, so it walks sideways", expect: /[AD] walked with the avatar facing/, edits: [{ file: ADAPTER, find: "    avatar.rotation_y = loco.yaw;\n", replace: "" }] },
  { statement: "diagonal-is-not-faster", name: "a diagonal step that is not scaled down", expect: /W and D walked [\d.]+ m in/, edits: [{ file: LOCOMOTION, find: "      else target = Math.abs(err) > 120 * DEG ? base * 0.3 : base;", replace: "      else target = (Math.abs(err) > 120 * DEG ? base * 0.3 : base) * Math.hypot(fwd, right);" }] },
  { statement: "shift-runs", name: "the loop never passes the run key on", expect: /with Shift it moved/, edits: [{ file: MOVE, find: "? { ...controlState, run: runModifierKeys.size > 0, camera_yaw: movementBasisYaw() }", replace: "? { ...controlState, run: false, camera_yaw: movementBasisYaw() }" }] },
  { statement: "drag-turns", name: "a mouse drag turns the camera the wrong way", expect: /a drag to the right turned the facing direction/, edits: [{ file: MOVE, find: "    orbitCamera.lastY = event.clientY;\n    orbitCamera.targetAzimuth -= dx *", replace: "    orbitCamera.lastY = event.clientY;\n    orbitCamera.targetAzimuth += dx *" }] },
  { statement: "space-lifts", name: "a jump far too weak", expect: /Space lifted it/, edits: [{ file: LOCOMOTION, find: "    jumpApex: 0.75,", replace: "    jumpApex: 0.15," }] },
  { statement: "lands-at-floor", name: "no gravity, so it never comes down", expect: /it never landed/, edits: [{ file: LOCOMOTION, find: "      this.vy -= T.gravity * dt;\n", replace: "" }] },
  { statement: "typing-does-not-move", name: "keys typed in a field reach the controls", expect: /typing moved the avatar/, edits: [{ file: MOVE, find: "    if (pressed && typingTarget) return;\n", replace: "" }] },
  { statement: "blur-stops", name: "a held key not cleared on blur", expect: /with the window blurred and the key down/, edits: [{ file: MOVE, find: `    addListener(windowTarget, "blur", resetControlState);\n`, replace: "" }] },
  { statement: "perimeter-stops", name: "the perimeter check removed", expect: /it passed through/, edits: [{ file: ADAPTER, find: "p[2] = clamp(wantZ, mb ? mb.minZ : -WORLD_LIMIT, mb ? mb.maxZ : WORLD_LIMIT);", replace: "p[2] = wantZ;" }] },
  { statement: "world-record-follows", name: "the heartbeat reports the spawn point, not the avatar", expect: /the world's record stands/, edits: [{ file: "web/live-adapter-presence-controller.mjs", find: "      position: roundedPosition(avatar.position),\n", replace: "      position: [0, 0, 0],\n" }] },
  { statement: "second-visitor-sees", name: "a visitor keeps a peer's first position", expect: /the second visitor sees the first [\d.]+ m from where it is/, edits: [{ file: "web/live-adapter-peer-presence-reducer.mjs", find: "      position: clonePosition(message.position, [0, 0, 0]),\n      rotation_y: Number(message.rotation_y) || 0,\n      avatar_variant:", replace: "      position: previous ? previous.position : clonePosition(message.position, [0, 0, 0]),\n      rotation_y: Number(message.rotation_y) || 0,\n      avatar_variant:" }] },
];

await runBehavior({ title: "movement", firstPort: 36120, statements, faults });
