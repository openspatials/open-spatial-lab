// The avatar roster: every character the shared asset catalog shows in the lab is offered, and a character's model is
// fetched only when it is the session's starting avatar, or picked or previewed in the selector.
//   node tools/behavior/avatar-roster.check.mjs [--faults] [--only id,id]
//
// The roster is the lab's copy of the catalog (web/assets/avatar-catalog.json, written by the catalog's apply.mjs with
// the AVATAR_VARIANTS table). A character model is a GLB under /assets/actionforge/characters/<id>/<id>.glb; the check
// logs every request for one, with the code that asked for it (async call stacks on). A model the airport's actors ask
// for (web/airport-entity-runtime.mjs: the airport crowd, drawn in the Lobby's portal preview of the airport) is world
// content and is reported apart; every other model is an avatar model and must be the start, the preview or a pick.
import { expect, runBehavior, sleep, waitUntil } from "./kit.mjs";
import { openPlayer } from "../arch-i4/main-demo/lab.mjs";

const SETTLE_MS = 2500; // after the avatar is up: time for any late or deferred model load to start
const MODEL = /\/assets\/actionforge\/characters\/([^/?#]+)\/\1\.glb(?:[?#]|$)/;

const lobby = (ctx, query = "") => `${ctx.lab.front}/index.html?role=player&intro=bypass${query}`;

/** The roster as the lab serves it: [{ key, url }] in catalog order. */
async function roster(ctx) {
  const response = await fetch(`${ctx.lab.front}/assets/avatar-catalog.json`);
  expect(response.ok, `the lab's avatar list did not load (HTTP ${response.status})`);
  const list = await response.json();
  expect(Array.isArray(list.avatars) && list.avatars.length > 1, "the lab's avatar list has fewer than two avatars");
  return list.avatars.map((a) => ({ key: a.key, url: a.url, id: MODEL.exec(a.url)?.[1] || null }));
}

const WORLD_ACTOR = /airport-entity-runtime\.mjs/;

/** Every character model request of `page`, with whether the airport's actors asked for it. */
async function recordModels(page) {
  const entries = [];
  const byId = new Map();
  const client = await page.createCDPSession();
  await client.send("Network.enable");
  await client.send("Debugger.enable");
  await client.send("Debugger.setAsyncCallStackDepth", { maxDepth: 128 });
  client.on("Network.requestWillBeSent", (e) => {
    const id = MODEL.exec(e.request.url)?.[1];
    if (!id) return;
    const files = [];
    for (let stack = e.initiator.stack; stack; stack = stack.parent) for (const frame of stack.callFrames) files.push(frame.url);
    const entry = { id, url: e.request.url, worldActor: files.some((f) => WORLD_ACTOR.test(f)), status: null };
    entries.push(entry);
    byId.set(e.requestId, entry);
  });
  client.on("Network.responseReceived", (e) => { if (byId.has(e.requestId)) byId.get(e.requestId).status = e.response.status; });
  return { entries };
}

/** A new visitor whose every character model request is logged from the first one. */
async function loggedVisitor(ctx, query) {
  const page = await ctx.visit(lobby(ctx, query), { open: false, startingAvatar: null }); // random-start needs the random start
  const log = await recordModels(page);
  await openPlayer(page, lobby(ctx, query));
  await sleep(SETTLE_MS);
  return { page, log };
}

/** The distinct avatar models (not the airport's actors) the page has asked for, by character folder id. */
const modelsFetched = (log) => [...new Set(log.entries.filter((e) => !e.worldActor).map((e) => e.id))];
const actorModels = (log) => [...new Set(log.entries.filter((e) => e.worldActor).map((e) => e.id))];

function onlyThese(log, allowed, when) {
  const fetched = modelsFetched(log);
  const extra = fetched.filter((id) => !allowed.includes(id));
  expect(!extra.length, `${when}: fetched ${extra.length} character model(s) not picked: ${extra.join(", ")} (fetched ${fetched.join(", ")}; allowed ${allowed.join(", ")})`);
  return fetched;
}

/** The starting avatar for the pinned statements: the last character of the roster, which is not the default. */
async function pinnedStart(ctx) {
  const list = await roster(ctx);
  const start = list[list.length - 1];
  return { list, start };
}

async function waitForModel(log, id, what) {
  await waitUntil(() => log.entries.some((e) => !e.worldActor && e.id === id && e.status === 200), `${what}: the model ${id}.glb was not fetched`, { limitMs: 120000 });
}

const statements = [
  { id: "boot-starting-model-only", says: "A session that starts as a non-default character fetches that character's model and no other", async run(ctx) {
    const { start } = await pinnedStart(ctx);
    const { log } = await ctx.once("pinned", () => loggedVisitor(ctx, `&avatar_variant=${encodeURIComponent(start.key)}`));
    await waitForModel(log, start.id, "at boot");
    const fetched = onlyThese(log, [start.id], "at boot");
    expect(fetched.length === 1, `at boot: fetched ${fetched.length} character models, not 1`);
    return `started as ${start.key}; avatar models fetched: ${fetched.join(", ")}; airport actors' models: ${actorModels(log).join(", ") || "none"}`;
  } },
  { id: "random-start-one-model", says: "A new session (random start) fetches exactly one character model, one of the roster", async run(ctx) {
    const list = await roster(ctx);
    const { log } = await loggedVisitor(ctx, "");
    await waitUntil(() => modelsFetched(log).length > 0, "at boot: no character model was fetched", { limitMs: 120000 });
    await sleep(SETTLE_MS);
    const fetched = modelsFetched(log);
    expect(fetched.length === 1, `at boot: fetched ${fetched.length} character models (${fetched.join(", ")}), not 1`);
    expect(list.some((a) => a.id === fetched[0]), `at boot: ${fetched[0]} is not in the roster`);
    return `fetched ${fetched[0]} only, of ${list.length} in the roster`;
  } },
  { id: "selector-roster-and-picks", says: "The selector offers every character in the lab's catalog copy, in its order, and fetches only the previewed and picked models", async run(ctx) {
    const { list, start } = await pinnedStart(ctx);
    const { page, log } = await ctx.once("pinned", () => loggedVisitor(ctx, `&avatar_variant=${encodeURIComponent(start.key)}`));
    await waitForModel(log, start.id, "at boot");
    await page.evaluate(() => document.getElementById("btn-switch-avatar").click());
    await waitUntil(() => page.evaluate(() => {
      const modal = document.getElementById("avatar-selector-modal");
      return modal && !modal.hidden && document.getElementById("avatar-selector-preview")?.getAttribute("aria-busy") !== "true" && document.body.dataset.avatarSelectorOpen === "true";
    }), "the avatar selector did not open", { limitMs: 120000 });
    await sleep(SETTLE_MS);
    const chips = await page.$$eval("#avatar-selector-avatar-list [data-avatar-variant]", (nodes) => nodes.map((n) => n.dataset.avatarVariant));
    const want = list.map((a) => a.key);
    expect(chips.length === want.length && chips.every((k, i) => k === want[i]), `the selector offers ${chips.length} characters, the catalog copy lists ${want.length}; first difference at ${chips.findIndex((k, i) => k !== want[i])}`);
    onlyThese(log, [start.id], "after opening the selector");
    // Picks the page has not fetched yet, where the roster has them: the runtime reuses a model it already holds (the
    // airport actors' copies), so a pick of one of those makes no request to see.
    const others = list.filter((a) => a.key !== start.key);
    const fresh = others.filter((a) => !actorModels(log).includes(a.id));
    const picks = [...fresh, ...others.filter((a) => !fresh.includes(a))].slice(0, 2);
    for (const pick of picks) {
      const held = actorModels(log).includes(pick.id);
      await page.evaluate((key) => document.querySelector(`[data-testid="avatar-selector-avatar-${key}"]`).click(), pick.key);
      if (!held) await waitForModel(log, pick.id, `after picking ${pick.key}`);
      await waitUntil(() => page.evaluate(() => document.getElementById("avatar-selector-preview")?.getAttribute("aria-busy") !== "true"), `the preview of ${pick.key} did not finish loading`, { limitMs: 120000 });
    }
    await sleep(SETTLE_MS);
    const allowed = [start.id, ...picks.map((p) => p.id)];
    const fetched = onlyThese(log, allowed, "after two picks");
    const never = list.filter((a) => !fetched.includes(a.id) && !actorModels(log).includes(a.id)).length;
    return `${chips.length} characters offered; avatar models fetched: ${fetched.join(", ")}; airport actors' models: ${actorModels(log).join(", ") || "none"}; ${never} of the roster never fetched`;
  } },
];

const faults = [
  {
    statement: "selector-roster-and-picks",
    name: "eager load: opening the selector fetches every roster model",
    expect: /after opening the selector: fetched \d+ character model\(s\) not picked/,
    edits: [{
      file: "web/avatar-selector-controller.mjs",
      find: "    // opening the selector loads ONLY the current preview candidate, never the roster.\n    await requestPreviewVariant();",
      replace: "    await Promise.all(enumerableVariantKeys().map((key) => fetch(variants[key].url).then((r) => r.arrayBuffer()).catch(() => null)));\n    await requestPreviewVariant();",
    }],
  },
  {
    statement: "boot-starting-model-only",
    name: "the live avatar layer loads the default avatar before the starting one",
    expect: /at boot: fetched \d+ character model\(s\) not picked: adam/,
    edits: [{
      file: "web/app.js",
      find: "      initialVariant: adapter.state.avatar ? adapter.state.avatar.avatar_variant : null,\n",
      replace: "",
    }],
  },
];

await runBehavior({ title: "avatar-roster", firstPort: 40640, statements, faults });
