// What a crossing shows and keeps in the main demo, seen from the page: a turn through a portal, the same document, the
// destination's own scene, and how another visitor sees the one who crossed.
//   node tools/behavior/crossing-views.check.mjs [--faults] [--only id,id]
import { allNodes, arrivalOf, getJson, worldPortals } from "../arch-i4/main-demo/world-data.mjs";
import { openPlayer } from "../arch-i4/main-demo/lab.mjs";
import { angleBetween, expect, fixed, holdKeys, pageFacts, runBehavior, sleep, waitUntil, walkTo } from "./kit.mjs";
import { FACING_RAD, lobbyUrl, portalNamed, walkInto, yawOf } from "./crossing-walk.mjs";
import { lastPushedDeparture, markDocument, peerFrames, peerIds, recordPeerFrames, sceneFacts, speakOnPeerChannel, stopSpeaking, windowFacts } from "./page-reads.mjs";

const MARK = "opened before the crossing";
const PINNED_AVATAR = "rpm-female-ninja"; // a starting avatar the page accepts in its address: not the default, and loaded from a file, so a peer shown too early is seen in another avatar for a while
const TRAVERSAL = "web/live-adapter-portal-traversal-controller.mjs";
const PEERS = "web/live-adapter-peer-presence-reducer.mjs";

/** Where the walker stands and looks right after arriving, then 0.3 s of W: it must walk on into the room. */
async function expectEmergence(page, arrival, label) {
  const inward = yawOf(arrival.pose.forward);
  const arrived = await pageFacts(page);
  const turned = angleBetween(arrived.facing, inward);
  expect(turned <= FACING_RAD, `${label}: arrived facing ${fixed(turned)} rad off the way into the room`);
  const walk = await holdKeys(page, ["w"], 0.3);
  const heading = angleBetween(walk.heading, inward);
  expect(walk.distance > 0.3 && heading <= FACING_RAD, `${label}: W walked ${fixed(walk.distance)} m, ${fixed(heading)} rad off the way into the room`);
  const looks = angleBetween(walk.after.cameraYaw, walk.after.facing);
  expect(looks <= FACING_RAD, `${label}: the camera looks ${fixed(looks)} rad away from the way the walker faces`);
  return `${label}: faced ${fixed(turned)} rad off, W walked on ${fixed(heading)} rad off`;
}

/** One crossing from the Lobby to Location A that several statements read: the page, marked first, and what it says after. */
const tripToA = (ctx) => ctx.once("trip", async () => {
  const page = await ctx.visit(lobbyUrl(ctx.lab));
  await markDocument(page, MARK);
  const before = await sceneFacts(page);
  const portal = portalNamed(await worldPortals(ctx.lab.address("lobby")), "Portal to Location A");
  await walkInto(page, portal, "location-a");
  const after = await waitUntil(() => sceneFacts(page).catch(() => null), "the page never answered after the crossing", { limitMs: 90000 });
  return { before, after };
});

/** A watcher in Location A and a visitor who walks in from the Lobby wearing a chosen avatar: what the watcher drew. */
async function watchCrosserArrive(ctx) {
  const { lab } = ctx;
  const walker = await ctx.visit(`${lobbyUrl(lab)}&avatar_variant=${PINNED_AVATAR}`);
  // The page wears its default avatar until the chosen one has loaded, which can take long on a loaded machine.
  const wearing = await waitUntil(async () => {
    const variant = (await sceneFacts(walker)).ownVariant;
    return variant === PINNED_AVATAR ? variant : null;
  }, `the crosser never wore ${PINNED_AVATAR} (the check would be vacuous)`, { limitMs: 90000 });
  const watcher = await ctx.visit(`${lab.front}/w/a/?intro=bypass`, { sameProfileAs: walker });
  await recordPeerFrames(watcher);
  await walker.bringToFront();
  await walkInto(walker, portalNamed(await worldPortals(lab.address("lobby")), "Portal to Location A"), "location-a");
  await watcher.bringToFront(); // a browser draws only the page in front: the watcher draws the crosser from here on
  await waitUntil(async () => (await peerFrames(watcher)).some((peer) => peer.rendered), "the watcher never drew the crosser", { limitMs: 120000 });
  return { wearing, drawn: (await peerFrames(watcher)).filter((peer) => peer.rendered), after: (await sceneFacts(walker)).ownVariant };
}


const postJson = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** Where a visitor arriving in Location A stands: a place every window and page there takes in. */
async function spotInA(lab) {
  const portal = portalNamed(await worldPortals(lab.address("lobby")), "Portal to Location A");
  return { portal, spot: (await arrivalOf(portal.resource.destination)).pose.position };
}

/** Another document of the visitor's own browser, which can speak on the peer channel but draws nothing. */
async function speakerBeside(ctx, page) {
  const speaker = await ctx.visit(`${ctx.lab.front}/robots.txt`, { sameProfileAs: page, open: false });
  await speaker.goto(`${ctx.lab.front}/robots.txt`);
  await page.bringToFront();
  return speaker;
}

/**
 * A visitor in the Lobby, 1.4 m in front of the portal to Location A, and a second document of the same browser that
 * speaks for two people in A: a real peer, and a copy of the visitor (the visitor's own id from another client).
 */
const crowdInA = (ctx) => ctx.once("crowd-in-a", async () => {
  const { lab } = ctx;
  const page = await ctx.visit(lobbyUrl(lab));
  const me = (await pageFacts(page)).playerId;
  const { portal, spot } = await spotInA(lab);
  const speaker = await speakerBeside(ctx, page);
  const peerId = `${me}-peer`;
  await speakOnPeerChannel(speaker, [
    { id: peerId, clientId: peerId, location: "location-a", position: spot },
    { id: me, clientId: `${me}-copy`, location: "location-a", position: spot },
  ]);
  const [x, , z] = portal.pose.position;
  const [fx, , fz] = portal.pose.forward;
  await walkTo(page, x + fx * 1.4, z + fz * 1.4);
  await waitUntil(async () => Object.values((await windowFacts(page)).windows).some((w) => w.drawn.includes(peerId)), "the window never drew the peer in Location A", { limitMs: 120000 });
  return { page, peerId, me };
});

const statements = [
  { id: "emerges-into-the-room", says: `After a crossing that turns the walker 90 degrees, and the one back, W walks into the room, within ${FACING_RAD} rad`, async run(ctx) {
    const { lab } = ctx;
    const page = await ctx.visit(lobbyUrl(lab));
    const toB = portalNamed(await worldPortals(lab.address("lobby")), "Portal to Location B");
    await walkInto(page, toB, "location-b");
    const there = await expectEmergence(page, await arrivalOf(toB.resource.destination), "Lobby to B");
    const back = portalNamed(await worldPortals(lab.address("b")), "Portal to Lobby");
    await walkInto(page, back, "location-lobby");
    const home = await expectEmergence(page, await arrivalOf(back.resource.destination), "B to Lobby");
    return `${there}; ${home}`;
  } },
  { id: "crossing-keeps-the-page", says: "A crossing happens in the page the visitor opened: nothing reloads, and the page counts one promotion", async run(ctx) {
    const { before, after } = await tripToA(ctx);
    expect(before.mark === MARK, "the mark was not set before the crossing (the check would be vacuous)");
    expect(after.mark === MARK, `the page was replaced during the crossing: its mark is ${after.mark}`);
    expect(after.navigations === 1 && after.samePage && after.promotions === 1, `the page reports ${after.navigations} navigations, same page ${after.samePage}, ${after.promotions} promotions`);
    return "same document, one navigation, one promotion";
  } },
  { id: "scene-from-destination-graph", says: "After a crossing the page's scene is built from the destination's own graph, and the crossing says so", async run(ctx) {
    const { before, after } = await tripToA(ctx);
    expect(before.sceneGraph && before.sceneGraph.spatialId, "the Lobby page names no scene graph (the check would be vacuous)");
    const wanted = await ctx.once("graph-of-a", () => graphOf(ctx.lab.address("a")));
    expect(after.sceneGraph && after.sceneGraph.spatialId === wanted.spatialId && after.sceneGraph.nodes === wanted.nodes, `the page's scene graph is ${JSON.stringify(after.sceneGraph)}, not ${JSON.stringify(wanted)}`);
    expect(after.crossingGraph && after.crossingGraph.spatialId === wanted.spatialId, `the crossing names the scene graph ${JSON.stringify(after.crossingGraph)}, not ${wanted.spatialId}`);
    return `${wanted.spatialId}, ${wanted.nodes} nodes, as the page and the crossing say`;
  } },
  { id: "watcher-sees-crosser-in-its-own-avatar", says: "A visitor who watches someone cross draws them in their own avatar from the first frame, and the crosser keeps it", async run(ctx) {
    const { wearing, drawn, after } = await watchCrosserArrive(ctx);
    const wrong = drawn.filter((peer) => peer.variant !== wearing);
    expect(wrong.length === 0, `the watcher drew the crosser as ${wrong.map((peer) => `${peer.variant} for ${peer.frames} frames`).join(", ")}, not ${wearing}`);
    expect(after === wearing, `the crosser wears ${after} after the crossing, not ${wearing}`);
    return `drawn as ${wearing} in ${drawn.reduce((sum, peer) => sum + peer.frames, 0)} frames`;
  } },
  { id: "own-copy-not-drawn", says: "A portal window draws a real peer who stands in the destination, and never a copy of the visitor", async run(ctx) {
    const { page, peerId, me } = await crowdInA(ctx);
    await sleep(2000);
    const { windows } = await windowFacts(page);
    const hasSelf = Object.entries(windows).filter(([, w]) => w.drawn.includes(me)).map(([key]) => key);
    expect(hasSelf.length === 0, `the window of ${hasSelf.join(", ")} draws the visitor's own copy`);
    expect(Object.values(windows).some((w) => w.drawn.includes(peerId)), "the peer is not drawn");
    return "the peer is drawn; the visitor's own copy is not";
  } },
  { id: "departed-peer-leaves-by-push", says: "When a peer departs the world a visitor stands in, the world's push removes it from the visitor's page", async run(ctx) {
    const { lab } = ctx;
    const page = await ctx.visit(`${lab.front}/w/a/?intro=bypass`);
    const peerId = `${(await pageFacts(page)).playerId}-peer`;
    const speaker = await speakerBeside(ctx, page);
    await postJson(`${lab.address("a")}fabric/presence/register`, { player_id: peerId, client_id: peerId });
    await speakOnPeerChannel(speaker, [{ id: peerId, clientId: peerId, location: "location-a", position: (await spotInA(lab)).spot }]);
    await waitUntil(async () => (await peerIds(page)).includes(peerId), "the page never held the peer", { limitMs: 60000 });
    await stopSpeaking(speaker);
    await sleep(300);
    await postJson(`${lab.address("a")}fabric/presence/depart`, { player_id: peerId });
    const pushed = await waitUntil(async () => {
      const departure = await lastPushedDeparture(page);
      return departure && departure.playerId === peerId ? departure : null;
    }, "the world's push that the peer left never reached the page", { limitMs: 60000 });
    expect(!(await peerIds(page)).includes(peerId), "the page still holds the peer that left");
    return `the push for ${pushed.playerId} reached the page and the peer is gone`;
  } },
];

/** The id and size of a world's own composition graph, as its route gives them. */
async function graphOf(address) {
  const { json } = await getJson(`${address}wow/spatial/1`);
  return { spatialId: json.webofworlds_extension.spatial_id, nodes: (await allNodes(address, 1)).length - 1 }; // the page counts the nodes under the root
}

const faults = [
  { statement: "emerges-into-the-room", name: "the camera is mapped from the portal it left on both ends", expect: /W walked [\d.]+ m, [\d.]+ rad off the way into the room|the camera looks/, edits: [{ file: TRAVERSAL, find: "            targetFrame: traversedTargetFrame,\n            cameraTransform: pendingCameraContinuity.cameraTransform,", replace: "            targetFrame: traversedSourceFrame,\n            cameraTransform: pendingCameraContinuity.cameraTransform," }] },
  { statement: "crossing-keeps-the-page", name: "the page reloads after it arrives", expect: /the page was replaced during the crossing/, edits: [{ file: TRAVERSAL, find: "      crossing.destination_scene_source = promoted.destinationSceneSource;\n", replace: "      crossing.destination_scene_source = promoted.destinationSceneSource;\n      setTimeout(() => location.reload(), 500);\n" }] },
  { statement: "scene-from-destination-graph", name: "the crossing keeps the scene graph of the world it left", expect: /the page's scene graph is/, edits: [{ file: "web/live-adapter.js", find: "    const promotedSceneSource = await this._resolveWowSceneGraph({\n      base: this.base,", replace: "    const promotedSceneSource = this._lastCrossingSceneSource || null;\n    void ({\n      base: this.base," }] },
  { statement: "scene-from-destination-graph", name: "the crossing record names no scene source", expect: /the crossing names the scene graph null/, edits: [{ file: TRAVERSAL, find: "      crossing.destination_scene_source = promoted.destinationSceneSource;\n", replace: "      crossing.destination_scene_source = null;\n" }] },
  { statement: "watcher-sees-crosser-in-its-own-avatar", name: "a peer is shown while its own avatar is still loading", expect: /the watcher drew the crosser as/, edits: [{ file: "web/app.js", find: "          try { await layer.switchAvatarVariant(wantVariant); } catch {}\n", replace: "          layer.switchAvatarVariant(wantVariant).catch(() => {});\n" }] },
  { statement: "watcher-sees-crosser-in-its-own-avatar", name: "the crossing packet drops the avatar", expect: /the crosser wears \S+ after the crossing|the watcher drew the crosser as/, edits: [{ file: TRAVERSAL, find: "      avatar_variant: host.avatar.avatar_variant || assets.defaultAvatarVariant,", replace: "      avatar_variant: assets.defaultAvatarVariant," }] },
  { statement: "own-copy-not-drawn", name: "no guard keeps the visitor's own id out of what the page draws", expect: /draws the visitor's own copy/, edits: [
    { file: "web/app.js", find: "    controlledPlayerId: () => adapter.controlledIdentity().player_id,\n", replace: "    controlledPlayerId: () => null,\n" },
    { file: PEERS, find: "      (message.player_id || message.client_id) !== controlledIdentity().player_id\n", replace: "      true\n" },
    { file: PEERS, find: "    if (clientMode === \"player\" && playerId === controlledIdentity().player_id) return;\n", replace: "" },
  ] },
  { statement: "departed-peer-leaves-by-push", name: "the push that a peer left is ignored", expect: /the world's push that the peer left never reached the page/, edits: [{ file: "web/live-adapter-runtime-stream-controller.mjs", find: "            const departure = onPresenceDeparture(endpointKey, message);\n            recordDeparture(departure);\n            onPresenceDepartureApplied(departure);\n", replace: "" }] },
];

await runBehavior({ title: "crossing-views", firstPort: 36200, statements, faults });
