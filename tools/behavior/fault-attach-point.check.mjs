// A Player re-read its world's hosted point ten times a second, with no regard for a read still under way. On a slow
// link the reads queue in the browser in front of the requests a crossing needs. Slow replies come from a small proxy in
// front of the frontend, so the browser's own limits apply as they do on a real link.
//   node tools/behavior/fault-attach-point.check.mjs [--faults] [--only id,id]
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import { openPlayer } from "../arch-i4/main-demo/lab.mjs";
import { getJson, worldPortals } from "../arch-i4/main-demo/world-data.mjs";
import { expect, fixed, recordRequests, runBehavior, sleep, waitUntil, walkTo } from "./kit.mjs";
import { CROSS_LIMIT_MS, lobbyUrl, portalNamed, walkInto } from "./crossing-walk.mjs";

const READ = "/demo/um/attach-point";
const CONTROLLER = "web/portal-render-controller.mjs";
const DEFAULT_INTERVAL_MS = 1000;
const MAX_READS_PER_S = 1.5;
const IDLE_WINDOW_MS = 10000;
const SLOW_REPLY_MS = 1500;
const QUEUE_BUILDS_MS = 20000; // at the old pace, about 150 reads were waiting by then
const CROSSING_LIMIT_MS = 15000;
const NO_READ_WHILE_HUNG_MS = 8000;
const READ_AFTER_HUNG_MS = 25000;
const ARRIVAL_READ_LIMIT_MS = 6000; // the interval is set to 10 s just before the crossing
const LONG_INTERVAL_MS = 10000;
const SHOW_MOVE_LIMIT_MS = DEFAULT_INTERVAL_MS * 2 + 5000; // two reads, and time for a loaded machine
const PROXY_PORT_OFFSET = 90;

const readsOf = (requests, mark) => requests.since(mark).filter((entry) => entry.path.startsWith(READ));
const perSecond = (count, ms) => count / (ms / 1000);

/** Stand in front of the frontend, holding or delaying the page's reads of the hosted point. */
async function slowFront(lab, port) {
  const target = new URL(lab.front);
  const seen = { delayMs: 0, hold: false, held: [], reads: 0 };
  const sockets = new Set();
  const server = createServer((req, res) => {
    const isRead = req.url.includes(READ);
    const pass = () => {
      const upstream = httpRequest({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (reply) => {
        res.writeHead(reply.statusCode, reply.headers);
        reply.pipe(res);
      });
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    };
    if (!isRead) return pass();
    seen.reads += 1;
    if (seen.hold) return void seen.held.push(pass);
    return void setTimeout(pass, seen.delayMs);
  });
  server.on("upgrade", (req, socket, head) => {
    sockets.add(socket);
    const upstream = connect(Number(target.port), target.hostname, () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise((done) => server.listen(port, "127.0.0.1", done));
  return {
    seen,
    url: `http://127.0.0.1:${port}/index.html?role=player&intro=bypass`,
    origin: `http://127.0.0.1:${port}`,
    // Upgraded sockets are not the server's any more, so they are closed here or close() would wait for ever.
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    },
  };
}

/**
 * A Player with its requests logged from the first one, every request that failed, and the reads of the hosted point
 * the browser holds at once. These are counted in the browser: it can keep same-address reads waiting before they reach
 * a socket, so a server never sees the queue.
 */
async function playerAt(ctx, url, front = ctx.lab.front) {
  const page = await ctx.visit(url, { open: false });
  const requests = await recordRequests(page, { worlds: ctx.lab.doc.worlds, front });
  const failed = [];
  const reads = { started: 0, underWay: new Map(), most: 0 };
  const worldOf = (request) => new URL(request.url()).pathname;
  page.on("request", (request) => {
    if (!request.url().includes(READ)) return;
    const world = worldOf(request);
    reads.started += 1;
    reads.underWay.set(world, (reads.underWay.get(world) || 0) + 1);
    reads.most = Math.max(reads.most, reads.underWay.get(world));
  });
  const settled = (request) => {
    if (request.url().includes(READ)) reads.underWay.set(worldOf(request), reads.underWay.get(worldOf(request)) - 1);
  };
  page.on("requestfinished", settled);
  page.on("requestfailed", (request) => {
    settled(request);
    failed.push(request.failure()?.errorText || "failed");
  });
  await openPlayer(page, url);
  return { page, requests, failed, reads };
}

const lobbyPortalToA = async (lab) => portalNamed(await worldPortals(lab.address("lobby")), "Portal to Location A");
const unavailable = (page) => page.evaluate(() => document.body.textContent.includes("World connection unavailable"));
const insufficient = (failed) => failed.filter((text) => text.includes("ERR_INSUFFICIENT_RESOURCES")).length;

/** The time from the plane of the portal to arrival, by the page's own phase log. */
async function crossingMs(page) {
  const log = await page.evaluate(() => window.__assembly.phaseLog());
  const arrived = log.filter((entry) => entry.phase === "arrived").at(-1);
  const entered = log.filter((entry) => entry.phase === "portal_walkthrough").at(-1);
  return arrived && entered ? arrived.at_ms - entered.at_ms : null;
}

const setInterval_ = (page, ms) => page.evaluate((value) => {
  const field = document.getElementById("hdr-client-interval");
  field.value = String(value);
  field.dispatchEvent(new Event("change"));
}, ms);

/** The walk most statements read: the Lobby at rest, into Location A, Location A at rest. */
const walk = (ctx) => ctx.once("walk", async () => {
  const { lab } = ctx;
  const { page, requests, failed } = await playerAt(ctx, lobbyUrl(lab));
  await sleep(1000);
  let mark = requests.mark();
  let started = Date.now();
  await sleep(IDLE_WINDOW_MS);
  const lobbyReads = readsOf(requests, mark);
  const lobbyRate = perSecond(lobbyReads.length, Date.now() - started);
  const portal = await lobbyPortalToA(lab);
  await walkTo(page, portal.pose.position[0], portal.pose.position[2] + 1.4);
  await walkInto(page, portal, "location-a");
  const crossing = await crossingMs(page);
  mark = requests.mark();
  started = Date.now();
  await sleep(IDLE_WINDOW_MS);
  const aReads = readsOf(requests, mark);
  const aRate = perSecond(aReads.length, Date.now() - started);
  return { page, requests, failed, lobbyReads, lobbyRate, aReads, aRate, crossing };
});

const statements = [
  { id: "reads-at-a-preview-pace", says: `A Player's re-reads of the hosted point stay under ${MAX_READS_PER_S} a second, on a real walk`, async run(ctx) {
    const { lobbyRate, aRate, crossing } = await walk(ctx);
    expect(lobbyRate <= MAX_READS_PER_S, `attach-point reads at ${fixed(lobbyRate, 1)}/s in the Lobby`);
    expect(aRate <= MAX_READS_PER_S, `attach-point reads at ${fixed(aRate, 1)}/s in Location A`);
    expect(lobbyRate > 0 && aRate > 0, "no attach-point reads at all: the client pull stopped");
    return `${fixed(lobbyRate, 1)}/s in the Lobby, ${fixed(aRate, 1)}/s in Location A; crossing ${crossing} ms`;
  } },
  { id: "reads-only-the-world-shown", says: "It reads only the world the visitor is in: a destination is asked only for what it declares", async run(ctx) {
    const { lobbyReads, aReads } = await walk(ctx);
    const others = [...lobbyReads.filter((entry) => entry.world !== "lobby"), ...aReads.filter((entry) => entry.world !== "a")];
    expect(!others.length, `a destination was read: ${[...new Set(others.map((entry) => entry.world))].join(", ")}`);
    return `${lobbyReads.length} reads of the Lobby, ${aReads.length} of Location A, none of another world`;
  } },
  { id: "walk-stays-connected", says: "The walk ends with no request refused for resources and no connection message", async run(ctx) {
    const { page, failed } = await walk(ctx);
    expect(!insufficient(failed), `${insufficient(failed)} requests failed with ERR_INSUFFICIENT_RESOURCES`);
    expect(!(await unavailable(page)), "the page says World connection unavailable");
    return `${failed.length} failed requests, none for resources; no connection message`;
  } },
  { id: "panel-contract", says: "Auto re-reads, On-demand does not, Reload now reads once, and the interval field rules the pace", async run(ctx) {
    const { page, requests } = await playerAt(ctx, lobbyUrl(ctx.lab));
    const shown = await page.evaluate(() => document.getElementById("hdr-client-interval").value);
    expect(Number(shown) === DEFAULT_INTERVAL_MS, `the interval field says ${shown} ms`);
    const click = (id) => page.evaluate((target) => document.getElementById(target).click(), id);
    await click("hdr-refresh-mode-on-demand");
    await sleep(500);
    let mark = requests.mark();
    await sleep(3000);
    const whileOff = readsOf(requests, mark).length;
    expect(whileOff === 0, `On-demand still read ${whileOff} times in 3 s`);
    mark = requests.mark();
    await click("pv-reload-now");
    await sleep(1500);
    const reloaded = readsOf(requests, mark).length;
    expect(reloaded === 1, `Reload now read ${reloaded} times`);
    await click("hdr-refresh-mode-auto");
    await setInterval_(page, 2000);
    await sleep(500);
    mark = requests.mark();
    const started = Date.now();
    await sleep(8000);
    const rate = perSecond(readsOf(requests, mark).length, Date.now() - started);
    expect(rate > 0.2 && rate <= 0.7, `at a 2000 ms interval, Auto read ${fixed(rate, 2)} times a second`);
    await page.close();
    return `On-demand 0 reads, Reload now 1, Auto at 2000 ms ${fixed(rate, 2)}/s`;
  } },
  { id: "arrival-reads-at-once", says: "A world just arrived in is read at once, not at the next interval", async run(ctx) {
    const { lab } = ctx;
    const { page, requests } = await playerAt(ctx, lobbyUrl(lab));
    const portal = await lobbyPortalToA(lab);
    await walkTo(page, portal.pose.position[0], portal.pose.position[2] + 1.4);
    const crossing = walkInto(page, portal, "location-a");
    await waitUntil(async () => {
      const log = await page.evaluate(() => window.__assembly.phaseLog());
      return log.some((entry) => entry.phase === "portal_active" || entry.phase === "portal_walkthrough");
    }, "the walker never reached the portal", { limitMs: CROSS_LIMIT_MS, everyMs: 50 });
    await setInterval_(page, LONG_INTERVAL_MS);
    await crossing;
    const started = Date.now();
    await waitUntil(() => requests.forWorld("a").some((entry) => entry.path.startsWith(READ)), () => `no read of Location A ${ARRIVAL_READ_LIMIT_MS / 1000} s after arrival`, { limitMs: ARRIVAL_READ_LIMIT_MS, everyMs: 50 });
    const waited = Date.now() - started;
    await page.close();
    return `first read of Location A ${waited} ms after the page showed it, with the interval at ${LONG_INTERVAL_MS} ms`;
  } },
  { id: "hosted-move-shows", says: "A hosted point moved in the world the visitor is in shows within two intervals", async run(ctx) {
    const { lab } = ctx;
    const { page } = await playerAt(ctx, lobbyUrl(lab));
    const post = (path, body) => fetch(`${lab.address("lobby")}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((reply) => reply.json());
    // The server's drift rewrites a moved object around its old home on its next tick.
    await post("demo/republish-rate", { republish_rate_ms: 0 });
    const { json } = await getJson(`${lab.address("lobby")}demo/scene-objects`);
    const object = json.objects[0];
    const to = [object.position[0] + 0.6, object.position[1], object.position[2] - 0.4];
    await sleep(DEFAULT_INTERVAL_MS * 2);
    const started = Date.now();
    await post("demo/scene-objects/move", { object_id: object.object_id, position: to });
    const at = () => page.evaluate((id) => window.__assembly.portalRender.state().root_object_meshes.find((mesh) => mesh.object_id === id)?.position, object.object_id);
    await waitUntil(async () => {
      const position = await at();
      return position && Math.hypot(position[0] - to[0], position[2] - to[2]) < 0.05;
    }, async () => `the object stands at ${await at()}, moved to ${to}`, { limitMs: SHOW_MOVE_LIMIT_MS });
    const shownAfter = Date.now() - started;
    await post("demo/republish-rate", { republish_rate_ms: 100 });
    await page.close();
    return `${object.object_id} showed its new place after ${shownAfter} ms`;
  } },
  { id: "slow-replies-one-read-at-a-time", says: `With replies taking ${SLOW_REPLY_MS} ms a world has one read under way, and the crossing still takes its usual time`, async run(ctx) {
    const front = await slowFront(ctx.lab, ctx.first + PROXY_PORT_OFFSET);
    let visitor = null;
    try {
      front.seen.delayMs = SLOW_REPLY_MS;
      visitor = await playerAt(ctx, front.url, front.origin);
      const { page, failed, reads } = visitor;
      await sleep(QUEUE_BUILDS_MS);
      expect(reads.most <= 1, `${reads.most} reads of one world at once, with replies taking ${SLOW_REPLY_MS} ms`);
      const portal = await lobbyPortalToA(ctx.lab);
      await walkTo(page, portal.pose.position[0], portal.pose.position[2] + 1.4);
      await walkInto(page, portal, "location-a");
      const crossing = await crossingMs(page);
      expect(crossing !== null && crossing <= CROSSING_LIMIT_MS, `the crossing took ${crossing} ms with slow replies`);
      expect(!insufficient(failed), `${insufficient(failed)} requests failed with ERR_INSUFFICIENT_RESOURCES`);
      expect(!(await unavailable(page)), "the page says World connection unavailable");
      return `${reads.started} reads, at most ${reads.most} under way; crossing ${crossing} ms; no failed read for resources`;
    } finally {
      if (visitor) await visitor.page.close();
      await front.close();
    }
  } },
  { id: "hung-read-gives-way", says: "A read that never answers holds back the next one, but not for ever", async run(ctx) {
    const front = await slowFront(ctx.lab, ctx.first + PROXY_PORT_OFFSET);
    let visitor = null;
    try {
      visitor = await playerAt(ctx, front.url, front.origin);
      const { reads } = visitor;
      front.seen.hold = true;
      await waitUntil(() => front.seen.held.length >= 1, "no read came to hold", { limitMs: 10000, everyMs: 50 });
      // The proxy can hold a read before the page's own request event for it comes in, so the count is the proxy's.
      const startedAtHold = front.seen.reads;
      const started = Date.now();
      await sleep(NO_READ_WHILE_HUNG_MS);
      const during = reads.started - startedAtHold;
      expect(during === 0, `${during} reads went out while one hung`);
      await waitUntil(() => reads.started > startedAtHold, "the world was never read again after a read hung", { limitMs: READ_AFTER_HUNG_MS - NO_READ_WHILE_HUNG_MS, everyMs: 100 });
      return `the next read went out ${Date.now() - started} ms after the one that hung`;
    } finally {
      if (visitor) await visitor.page.close();
      await front.close();
    }
  } },
];

const faults = [
  { statement: "reads-at-a-preview-pace", name: "the old pace of ten reads a second", expect: /attach-point reads at [\d.]+\/s/, edits: [{ file: CONTROLLER, find: "const CLIENT_READ_INTERVAL_DEFAULT_MS = 1000;", replace: "const CLIENT_READ_INTERVAL_DEFAULT_MS = 100;" }] },
  { statement: "reads-only-the-world-shown", name: "every world is read, as the public lab's older code does", expect: /a destination was read/, edits: [{ file: CONTROLLER, find: "return [live.activeEndpointKey];", replace: "return [\"lobby\", \"a\", \"b\", \"airport\"];" }] },
  { statement: "slow-replies-one-read-at-a-time", name: "a read goes out while one is under way", expect: /reads of one world at once/, edits: [{ file: CONTROLLER, find: ".filter((key) => !readInFlight(key))", replace: "" }] },
  { statement: "arrival-reads-at-once", name: "a new world waits for the next interval", expect: /no read of Location A/, edits: [{ file: CONTROLLER, find: "if (!worldChanged && nowMs()", replace: "if (nowMs()" }] },
  { statement: "panel-contract", name: "On-demand keeps reading", expect: /On-demand still read/, edits: [{ file: CONTROLLER, find: "if (state.settings.mode !== \"auto\") {", replace: "if (false) {" }] },
  { statement: "hung-read-gives-way", name: "a read that hangs stops the world being read", expect: /never read again/, edits: [{ file: CONTROLLER, find: "nowMs() - read.startedAt < READ_GIVE_UP_MS", replace: "true" }] },
];

await runBehavior({ title: "fault-attach-point", firstPort: 40000, statements, faults });
