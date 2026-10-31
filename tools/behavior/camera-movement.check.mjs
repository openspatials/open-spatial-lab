// The camera, the header controls and the arrival, in the main demo, as a Player with real keys and a real mouse.
//   node tools/behavior/camera-movement.check.mjs [--faults] [--only id,id]
//
// Distances are for holds counted in the movement loop's own time (see kit.mjs).
import { openPlayer } from "../arch-i4/main-demo/lab.mjs";
import { worldPortals } from "../arch-i4/main-demo/world-data.mjs";
import { angleBetween, expect, fixed, holdKeys, pageFacts, planar, recordRequests, runBehavior, sleep, untilClock, waitUntil, walkThrough, walkTo, faceYaw } from "./kit.mjs";
import { cameraPageFacts, chooseNoEquipment, growFooter, pressHeaderCamera, pressReturnToLobby } from "./camera-page-facts.mjs";
import { cameraMovementFaults } from "./camera-movement-faults.mjs";

const FIRST_PERSON_M = 1.0; // the camera sits in the head; a third-person camera is 3.4 m behind
const THIRD_PERSON_M = 2.0;
const CARRY_ON_M = 0.3; // what a key held through a crossing may still walk; 2.35 m/s would give 1.9 m in 0.8 s
const FRESH_PRESS_M = 0.8;
const CROSS_LIMIT_MS = 90000;
const AGAIN_RAD = 0.15;
const GROWN_FOOTER_PX = 90;

const lobbyUrl = (ctx, extra = "") => `${ctx.lab.front}/index.html?role=player&intro=bypass${extra}`;
const visitor = (ctx) => ctx.once("visitor", () => ctx.visit(lobbyUrl(ctx)));
const cameraAway = (facts) => planar(facts.camera, facts.position);

const statements = [
  { id: "header-camera-button", says: "The header camera button switches to first person and back", async run(ctx) {
    const page = await visitor(ctx);
    await page.bringToFront();
    const third = await pageFacts(page);
    expect(cameraAway(third) > THIRD_PERSON_M, `the camera starts ${fixed(cameraAway(third))} m from the walker (the check would be vacuous)`);
    await pressHeaderCamera(page);
    const first = await untilClock(page, 0.4);
    const pressed = (await cameraPageFacts(page)).headerCameraPressed;
    expect(cameraAway(first) < FIRST_PERSON_M && pressed === "true", `after the press the camera is ${fixed(cameraAway(first))} m from the walker and the button says ${pressed}`);
    await pressHeaderCamera(page);
    const back = await untilClock(page, 0.4);
    expect(cameraAway(back) > THIRD_PERSON_M, `the second press left the camera ${fixed(cameraAway(back))} m from the walker`);
    return `third ${fixed(cameraAway(third))} m, first ${fixed(cameraAway(first))} m, third again ${fixed(cameraAway(back))} m`;
  } },
  { id: "footer-height-follows", says: "The footer's measured height is published, and follows it when the footer grows", async run(ctx) {
    const page = await ctx.visit(lobbyUrl(ctx));
    const before = await cameraPageFacts(page);
    expect(before.footerPublished === `${Math.ceil(before.footerHeight)}px`, `the footer is ${fixed(before.footerHeight, 1)} px high and the page published "${before.footerPublished}"`);
    await growFooter(page, GROWN_FOOTER_PX);
    const grown = await waitUntil(async () => {
      const facts = await cameraPageFacts(page);
      return facts.footerPublished === `${GROWN_FOOTER_PX}px` && facts;
    }, async () => `the page publishes "${(await cameraPageFacts(page)).footerPublished}" for a footer that is now ${GROWN_FOOTER_PX} px high, so it does not follow the footer`, { limitMs: 10000 });
    return `${fixed(before.footerHeight, 1)} px published as ${before.footerPublished}; after growing, ${grown.footerPublished}`;
  } },
  { id: "mission-marks-journey", says: "mission=denver-skyport marks the page as that journey and only that page", async run(ctx) {
    const plain = await cameraPageFacts(await visitor(ctx));
    const mission = await cameraPageFacts(await ctx.visit(lobbyUrl(ctx, "&mission=denver-skyport")));
    expect(mission.mission === "portal-c-server-backed", `with mission=denver-skyport the page is marked "${mission.mission}"`);
    expect(plain.mission === null, `a page with no mission is marked "${plain.mission}"`);
    return `marked "${mission.mission}"`;
  } },
  { id: "arrives-without-equipment", says: "A visitor wears nothing, unless noequip=0 asks for the default gear, and can choose none again", async run(ctx) {
    const plain = await cameraPageFacts(await visitor(ctx));
    expect(plain.worn === 0, `a new visitor arrived wearing ${plain.worn} items`);
    const geared = await ctx.visit(lobbyUrl(ctx, "&noequip=0"));
    const gear = await cameraPageFacts(geared);
    expect(gear.worn > 0, "with noequip=0 the visitor wears nothing (the check would be vacuous)");
    await chooseNoEquipment(geared);
    const none = await cameraPageFacts(geared);
    expect(none.worn === 0, `after choosing no equipment the visitor still wears ${none.worn} items`);
    return `${plain.worn} by default, ${gear.worn} with noequip=0, ${none.worn} after choosing none`;
  } },
  { id: "boot-reads-no-destination-region", says: "Opening the Lobby reads no region from the worlds behind its portals", async run(ctx) {
    const page = await ctx.visit(lobbyUrl(ctx), { open: false });
    const requests = await recordRequests(page, { worlds: ctx.lab.doc.worlds, front: ctx.lab.front });
    await openPlayer(page, lobbyUrl(ctx));
    await sleep(3000);
    const seen = ["a", "b", "airport"].map((key) => requests.forWorld(key));
    expect(seen.every((entries) => entries.length > 0), "the page asked some destination worlds nothing at all (the check would be vacuous)");
    const regions = seen.flat().filter((entry) => entry.path.includes("/fabric/region"));
    expect(regions.length === 0, `the page read a region from a destination: ${regions.map((entry) => `${entry.world}${entry.path}`).join(", ")}`);
    const marks = (await cameraPageFacts(page)).apertureMarks;
    expect(marks.length === 0, `the page carries destination marks: ${marks.join(", ")}`);
    return `${seen.flat().length} requests to the destination worlds, none for a region`;
  } },
  { id: "jump-keeps-the-loop-running", says: "After a jump it lands and W still walks", async run(ctx) {
    const page = await visitor(ctx);
    await page.bringToFront();
    await walkTo(page, -1, 2);
    await faceYaw(page, Math.PI / 2);
    await page.keyboard.press("Space");
    await untilClock(page, 1.5);
    const landed = await pageFacts(page);
    expect(landed.grounded, "it never landed after the jump");
    const walk = await holdKeys(page, ["w"], 0.6);
    expect(walk.distance > FRESH_PRESS_M, `W walked only ${fixed(walk.distance)} m after the jump`);
    return `landed, then W walked ${fixed(walk.distance)} m`;
  } },
  { id: "held-key-stops-at-crossing", says: "A key held through a crossing does not carry on walking until pressed again", async run(ctx) {
    const { page, arrived } = await crossingTrip(ctx);
    const later = await untilClock(page, 0.8);
    const carried = planar(later.position, arrived.position);
    expect(carried <= CARRY_ON_M, `with W still down after the crossing it walked on ${fixed(carried)} m`);
    await page.keyboard.up("w");
    const fresh = await holdKeys(page, ["w"], 0.6);
    expect(fresh.distance > FRESH_PRESS_M, `a fresh press of W walked only ${fixed(fresh.distance)} m (the check would be vacuous)`);
    return `walked on ${fixed(carried)} m with W down; a fresh press walked ${fixed(fresh.distance)} m`;
  } },
  { id: "arrival-names-destination", says: "The arrival toast names the world just entered", async run(ctx) {
    const { page, lab } = await crossingTrip(ctx);
    const name = lab.world("a").name;
    const toast = await waitUntil(async () => (await pageFacts(page)).toasts.find((text) => /ARRIVED/.test(text)), "no arrival toast appeared", { limitMs: 20000 });
    expect(toast.includes(name), `the arrival toast "${toast}" names no destination (${name})`);
    return `"${toast}"`;
  } },
  { id: "return-to-lobby-camera", says: "Returning to the Lobby puts the camera back behind the walker", async run(ctx) {
    const { page } = await crossingTrip(ctx);
    await page.keyboard.up("w");
    const turned = await pageFacts(page);
    await faceYaw(page, turned.basis + 1.5);
    const away = angleBetween((await pageFacts(page)).basis, Math.PI);
    expect(away > 0.5, `the camera was turned only ${fixed(away)} rad (the check would be vacuous)`);
    await pressReturnToLobby(page);
    const home = await waitUntil(async () => { const facts = await pageFacts(page); return facts.location === "location-lobby" && facts; }, "the return to the Lobby never finished", { limitMs: 60000 });
    const settled = await untilClock(page, 1);
    const off = angleBetween(settled.basis, Math.PI);
    expect(off <= AGAIN_RAD, `after the return the camera is ${fixed(off)} rad from its starting view, not within ${AGAIN_RAD}`);
    return `back in ${home.location}, ${fixed(off)} rad from the starting view`;
  } },
];

/** One walk from the Lobby into Location A with W held all the way and left down. The page is left in Location A. */
const crossingTrip = (ctx) => ctx.once("trip", async () => {
  const { lab } = ctx;
  const page = await ctx.visit(lobbyUrl(ctx));
  const portal = (await worldPortals(lab.address("lobby"))).find((p) => p.resource.label === "Portal to Location A");
  expect(portal, "the Lobby has no portal to Location A");
  const [x, , z] = portal.pose.position;
  const [fx, , fz] = portal.pose.forward;
  const seen = await walkThrough(page, { from: [x + fx * 1.4, z + fz * 1.4], yaw: Math.atan2(-fx, -fz), expect: "location-a", timeoutMs: CROSS_LIMIT_MS, release: false });
  expect(seen.location_id === "location-a", `the walk did not cross: still in ${seen.location_id} (timed out after ${CROSS_LIMIT_MS / 1000} s)`);
  const arrived = await untilClock(page, 0.4);
  return { page, lab, arrived };
});

await runBehavior({ title: "camera-movement", firstPort: 36320, statements, faults: cameraMovementFaults });
