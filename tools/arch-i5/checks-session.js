'use strict';

/*
 * Iteration 5, following and departing, beside the join.
 *
 *   SE1  follow, in a browser, in the main demo: a page opened at `#follow=user.{id}` stands at the node that places
 *        that user (within 1 cm) and keeps to it when that user moves; a page opened at `#Follow` (the verb matched
 *        case-insensitively, as web/wow-url.mjs matches it) follows the world as a new user: the world lists one more
 *        present user, and the page says it follows the world
 *   SE2  depart, in Node: DELETE /wow/user/{userId} of a visitor who joined by POST /wow/user ends the visit (GET of
 *        that User answers 404), sends exactly one user_left for that user on the event stream, and the record of
 *        the join stays readable with the same outcome
 *   SE3  ids, in Node: in one world, users who join by the handshake (POST /wow/user) and users who register presence
 *        (/fabric/presence/register) never get the same User id, and each id reads back its own user
 *   SE4  count, in Node: one proceeding handshake join raises World.users.active_user_count by one, and DELETE of that
 *        User lowers it by one; active_user_count_source names the handshake users
 *   SE5  follow, in a browser, in the `?wow=` viewer: a page opened at `#follow=user.{id}` puts the visitor (the
 *        viewer's camera) at the node that places that user (within 1 cm on the floor, at eye height), not at the
 *        default spawn; when that user moves, the visitor keeps to the user's node with no fragment change; after that
 *        user moves again, a fragment change to `#follow=user/{id}` puts the visitor at the new node; a fragment change
 *        to `#join=node.{n}` then puts it at node n, and it stays there (no longer following) when the user moves
 *   SE6  arrival at role=player, in a browser, in the `?wow=` viewer: a page opened at `#join=node.{n}` puts the embodied
 *        avatar at node n (within 1 cm on the floor), and a page opened at `#follow=user.{id}` puts it at the node that
 *        places that user and keeps it there when that user moves; the orbit camera follows the avatar from there and
 *        does not put it back at the world spawn
 *   ID11 the pilot of present users: a user present by /fabric/presence/register made no handshake, so GET /wow/user/{id}
 *        (by User id and by player id) reads pilot "unstated", never human (in Node); in a browser, in the main demo, a
 *        second page shows the first page's avatar (a present user of world A) with the shared user label, which reads
 *        "pilot not stated"; the page read that User itself: it made GET /wow/user/{id} at the active world's address with
 *        answer 200, and the label's name equals the name that User carries (a User read that fails also reads
 *        "pilot not stated", so the label alone does not prove the read)
 *
 * Every check also runs against planted faults, each an exact edit of the real code, which must turn it red. SE1 serves
 * its planted faults to the page in place of the real module (request interception), as V1 does.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, run, line, httpReq, makeTempDir, staleEdit } = require('../arch-i1/lib');
const lab = require('./lab');
const { departWire } = require('../wow-conformance/wire-checks');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ONE_CM = 0.01;
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Poll `fn` until it returns a truthy value or `ms` pass; returns the last value (no throw, so a miss is a plain failure). */
async function poll(fn, ms, every) {
  const end = Date.now() + ms;
  let value = null;
  for (;;) {
    value = await fn();
    if (value || Date.now() > end) return value;
    await sleep(every || 100);
  }
}

// ---- SE1: the main demo against its own four worlds, in this process, on the proof's ports ----------------------

/** The four worlds of worlds.json and the frontend, on proof ports, with their spatial data in a temporary folder. */
async function mainDemoLab(ports) {
  const backendPorts = { a: ports.next(), b: ports.next(), lobby: ports.next(), airport: ports.next() };
  const frontendPort = ports.next();
  const { startBackends, assertNotLiveDemoPorts } = require(path.join(ROOT, 'src', 'orchestrator.js'));
  assertNotLiveDemoPorts(Object.assign({ frontend: frontendPort }, backendPorts));
  const saved = process.env.OSL_WOW_SPATIAL_DIR;
  process.env.OSL_WOW_SPATIAL_DIR = makeTempDir('i5-se1');
  let backends;
  try {
    backends = await startBackends({ backendPorts });
  } finally {
    if (saved === undefined) delete process.env.OSL_WOW_SPATIAL_DIR;
    else process.env.OSL_WOW_SPATIAL_DIR = saved;
  }
  const frontend = await require(path.join(ROOT, 'src', 'serve.js')).createFrontendServer(frontendPort, { backendPorts });
  return {
    backendPorts,
    front: 'http://127.0.0.1:' + frontendPort,
    close: async () => {
      await new Promise((resolve) => frontend.close(resolve));
      await backends.stop();
    },
  };
}

/** The pose of the node that places a user, read as any client reads it: GET /wow/user/{id}, then the node and its parents. */
async function userNodePose(port, userId, arrivalAt) {
  const r = await httpReq('GET', port, '/wow/user/' + userId, null, { Accept: lab.WOW });
  const ref = r.json && typeof r.json.node === 'string' ? /node\/(\d+)$/.exec(r.json.node) : null;
  if (!ref) return null;
  const arrival = await arrivalAt('http://127.0.0.1:' + port + '/', Number(ref[1]));
  return arrival ? { node: Number(ref[1]), position: arrival.position, yaw: arrival.yaw } : null;
}

/** The present users a world lists (its presence registry), by player id. */
async function presentPlayers(port) {
  const r = await httpReq('GET', port, '/fabric/presence', null);
  return ((r.json && r.json.occupancy && r.json.occupancy.avatars) || []).map((a) => a.player_id);
}

/** Open the main demo as a Player and wait until the world and the avatar are up (as tools/arch-i4/main-demo/lab.mjs does). */
async function openPlayer(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.dataset.assemblyReady === '1' && window.__assembly && window.__assembly.debugState, { timeout: 120000 });
  await page.evaluate(() => { const b = document.querySelector('[data-testid="start-exploring"]'); if (b) b.click(); });
  await page.waitForFunction(() => window.__assembly.equipmentReady?.() !== false && window.__assembly.debugState().avatar, { timeout: 120000 });
}

const avatarPosition = (page) => page.evaluate(() => { const d = window.__assembly.debugState(); return d.avatar && d.avatar.position ? d.avatar.position.slice() : null; });
const arrivalNote = (page) => page.evaluate(() => { try { return JSON.parse(document.body.dataset.mainJoinArrival || 'null'); } catch (e) { return null; } });

async function sessionChecks(ports, options) {
  const { arrivalAt } = await import(pathToFileURL(path.join(ROOT, 'web', 'wow-portal.mjs')).href);
  if (options && options.browser === false) line('  (SE1 not run: OSL_ARCH_I5_SKIP_BROWSER=1; the proof does not pass without it)');
  else await followCheck(ports, arrivalAt);
  await departCheck(ports);
  await idsCheck(ports);
  await countCheck(ports);
  if (!(options && options.browser === false)) await viewerFollowCheck(ports, arrivalAt);
  else line('  (SE5 not run: OSL_ARCH_I5_SKIP_BROWSER=1; the proof does not pass without it)');
  if (!(options && options.browser === false)) await playerArrivalCheck(ports, arrivalAt);
  else line('  (SE6 not run: OSL_ARCH_I5_SKIP_BROWSER=1; the proof does not pass without it)');
  if (!(options && options.browser === false)) await presentPilotCheck(ports);
  else line('  (ID11 not run: OSL_ARCH_I5_SKIP_BROWSER=1; the proof does not pass without it)');
}

async function followCheck(ports, arrivalAt) {

  // ---- SE1 --------------------------------------------------------------------------------------------
  const followAtSpawn = { web: { 'main-demo-wiring.mjs': [['    const followUser = following ? /^user[./](\\d+)$/i.exec(String(aspectId || "")) : null;\n', '    const followUser = null;\n']] } };
  const followDoesNotKeep = { web: { 'main-demo-wiring.mjs': [['    if (followUser && arrival.arrived) keepFollowing(target, arrival);\n', '']] } };
  let browser = null;
  try {
    await run('SE1', 'follow, in the main demo: a page opened at #follow=user.{id} stands at the node that places that user (within 1 cm) and keeps to it when that user moves; a page opened at #Follow (the verb matched case-insensitively) follows the world as a new user: the world lists one more present user and the page says it follows the world', async (impl) => {
      if (!browser) {
        const { findBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools', 'find-browser.mjs')).href);
        const chrome = findBrowser();
        if (!chrome) return { ok: false, detail: 'no Chrome found: set PUPPETEER_EXECUTABLE_PATH to run SE1' };
        const puppeteer = require(require.resolve('puppeteer-core', { paths: [ROOT] }));
        browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1280, height: 800 } });
      }
      // The page's modules with exact string edits, served in place of the real ones.
      const sources = {};
      for (const [file, edits] of Object.entries(impl.web || {})) {
        let source = fs.readFileSync(path.join(ROOT, 'web', file), 'utf8');
        for (const [from, to] of edits) {
          const count = source.split(from).length - 1;
          if (count !== 1) throw staleEdit('web/' + file, from, count);
          source = source.replace(from, () => to);
        }
        sources[file] = source;
      }
      const L = await mainDemoLab(ports);
      const A = L.backendPorts.a;
      const failures = [];
      const notes = [];
      let heartbeat = null;
      const context = await browser.createBrowserContext();
      try {
        // The user to follow: a present user of world A, placed by a node, who keeps beating.
        const leader = { player_id: 'se1-followed', display_name: 'followed', position: [3.2, 0, -2.4], rotation_y: 0.6, ttl_ms: 60000 };
        const reg = await httpReq('POST', A, '/fabric/presence/register', leader);
        if (reg.status !== 200 && reg.status !== 201) return { ok: false, detail: 'the followed user could not register: ' + reg.status + ' ' + reg.body.slice(0, 160) };
        heartbeat = setInterval(() => { httpReq('POST', A, '/fabric/presence/heartbeat', leader).catch(() => {}); }, 2000);
        const user = (await httpReq('GET', A, '/wow/user/' + leader.player_id, null, { Accept: lab.WOW })).json;
        const userId = user && user.id;
        const first = await userNodePose(A, userId, arrivalAt);
        if (!first) return { ok: false, detail: 'the followed user ' + userId + ' is placed by no node: ' + JSON.stringify(user && user.node) };

        const page = await context.newPage();
        if (Object.keys(sources).length) {
          await page.setRequestInterception(true);
          page.on('request', (req) => {
            let file = '';
            try { file = new URL(req.url()).pathname.split('/').pop(); } catch (e) { file = ''; }
            if (sources[file]) req.respond({ status: 200, contentType: 'text/javascript; charset=utf-8', body: sources[file] }).catch(() => {});
            else req.continue().catch(() => {});
          });
        }
        // 1. #follow=user.{id}: the page stands at the user's node.
        await openPlayer(page, `${L.front}/w/a/?intro=bypass#follow=user.${userId}`);
        const near = (target) => async () => { const p = await avatarPosition(page); return p && distance(p, target) <= ONE_CM ? p : null; };
        const atFirst = await poll(near(first.position), 30000, 200);
        const p1 = await avatarPosition(page);
        if (!atFirst) failures.push(`after opening #follow=user.${userId} the visitor stands at ${JSON.stringify(p1)}, ${p1 ? distance(p1, first.position).toFixed(3) : '?'} m from node ${first.node} at ${JSON.stringify(first.position.map((v) => +v.toFixed(3)))} (arrival: ${JSON.stringify(await arrivalNote(page))})`);
        else notes.push(`arrived ${(distance(atFirst, first.position) * 1000).toFixed(1)} mm from user ${userId}'s node ${first.node}`);
        // 2. The user moves: the page keeps to the user's node.
        if (atFirst) {
          leader.position = [-2.6, 0, 1.8];
          leader.rotation_y = -1.1;
          await httpReq('POST', A, '/fabric/presence/heartbeat', leader);
          const second = await userNodePose(A, userId, arrivalAt);
          if (!second || distance(second.position, first.position) < 1) failures.push('the followed user\'s node did not move: ' + JSON.stringify(second));
          else {
            const atSecond = await poll(near(second.position), 20000, 200);
            const p2 = await avatarPosition(page);
            if (!atSecond) failures.push(`the user moved to ${JSON.stringify(second.position.map((v) => +v.toFixed(3)))}, but the visitor stays at ${JSON.stringify(p2)}, ${p2 ? distance(p2, second.position).toFixed(3) : '?'} m from it`);
            else notes.push(`kept to it when the user moved ${distance(second.position, first.position).toFixed(2)} m (${(distance(atSecond, second.position) * 1000).toFixed(1)} mm off)`);
            if (atSecond && !impl.web) {
              await sleep(1500);
              await page.screenshot({ path: path.join(ROOT, 'diagnostics', 'arch-i5-se1-follow.png') }).catch(() => {});
            }
          }
        }
        await page.close();

        // 3. #Follow: the page follows the world as a new user.
        const before = await presentPlayers(A);
        const world = await context.newPage();
        if (Object.keys(sources).length) {
          await world.setRequestInterception(true);
          world.on('request', (req) => {
            let file = '';
            try { file = new URL(req.url()).pathname.split('/').pop(); } catch (e) { file = ''; }
            if (sources[file]) req.respond({ status: 200, contentType: 'text/javascript; charset=utf-8', body: sources[file] }).catch(() => {});
            else req.continue().catch(() => {});
          });
        }
        await openPlayer(world, `${L.front}/w/a/?intro=bypass#Follow`);
        const added = await poll(async () => { const now = await presentPlayers(A); const fresh = now.filter((p) => !before.includes(p)); return fresh.length ? fresh : null; }, 20000, 250);
        const note = await poll(async () => { const n = await world.evaluate(() => { try { return JSON.parse(document.body.dataset.mainJoinArrival || 'null'); } catch (e) { return null; } }); return n && n.intent ? n : null; }, 10000, 250);
        if (!added) failures.push('after opening #Follow no new present user appeared in world A (present: ' + JSON.stringify(await presentPlayers(A)) + ')');
        if (!note || note.intent !== 'follow' || note.target !== 'world') failures.push('after opening #Follow the page says ' + JSON.stringify(note) + ', not that it follows the world');
        if (added && note && note.intent === 'follow' && note.target === 'world') notes.push(`#Follow: one more present user (${added.length} new), following the world`);
        await world.close();
        return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : notes.join('; ') };
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        await context.close().catch(() => {});
        await L.close();
      }
    }, {}, [
      { name: 'a follow that places the visitor at the default spawn', impl: followAtSpawn },
      { name: 'a follow that arrives at the user but does not keep to the user when the user moves', impl: followDoesNotKeep },
    ]);
  } finally {
    if (browser) await browser.close();
  }

}

async function departCheck(ports) {
  // ---- SE2 --------------------------------------------------------------------------------------------
  const WALLET = { claims: { avatar: { uri: 'http://127.0.0.1:1/assets/actionforge/characters/sophie/sophie.glb', label: 'Sophie' }, display_name: 'Ada', preferences: { preferred_height_m: 1.85 } }, pilot: 'agent' };
  const departLeavesUser = { server: { handshake: [['        users.delete(key);\n', '']] } };
  const departSendsNothing = { server: { handshake: [["        emitEvent({ type : 'user_left', userId : key, user : { id : key, name : user.name }, urls : [ 'wow/user/' + key ] });\n", '']] } };
  const departDropsRecord = { server: { handshake: [['        users.delete(key);\n', "        users.delete(key);\n        for (const r of records) if (r.user === 'wow/user/' + key) recordsById.delete(r.id);\n"]] } };
  await run('SE2', 'depart: DELETE /wow/user/{userId} of a visitor who joined by POST /wow/user ends the visit (the User answers 404 afterwards), sends exactly one user_left for that user on the event stream, and the record of the join stays readable with the same outcome', async (impl) => {
    // On the wire (the wire half is shared with the conformance corpus: tools/wow-conformance/wire-checks.js departWire).
    const hs = await lab.agent();
    const B = await lab.handshakeWorld('b', ports.next(), { base: '/w/b', edits: impl.server });
    try {
      const r = await departWire(B.base, { agent: hs, wallet: WALLET, eventsUrl: B.base + 'events', requireRecord: true });
      if (r.fatal) return { ok: false, detail: r.fatal };
      const failures = r.problems;
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : r.detail };
    } finally {
      await B.close();
    }
  }, {}, [
    { name: 'a depart that leaves the user present', impl: departLeavesUser },
    { name: 'a depart that drops the record of the join', impl: departDropsRecord },
    { name: 'a depart that sends no user_left', impl: departSendsNothing },
  ]);
}

const SE_WALLET = { claims: { avatar: { uri: 'http://127.0.0.1:1/assets/actionforge/characters/sophie/sophie.glb', label: 'Sophie' }, display_name: 'Ada', preferences: { preferred_height_m: 1.85 } }, pilot: 'agent' };

async function idsCheck(ports) {
  // ---- SE3 --------------------------------------------------------------------------------------------
  // The old pair of separate counters: the handshake counts its own ids from 1001, as presence does.
  const separateCounters = { server: { handshake: [['    const nextUserId = deps.nextUserId;\n', '    let ownUserId = 1000;\n    const nextUserId = () => ++ownUserId;\n']] } };
  await run('SE3', 'ids: in one world, users who join by the handshake (POST /wow/user) and users who register presence never get the same User id, and each id reads back its own user', async (impl) => {
    const failures = [];
    const hs = await lab.agent();
    const B = await lab.handshakeWorld('b', ports.next(), { base: '/w/b', edits: impl.server });
    try {
      const users = [];
      const present = async (playerId, name) => {
        const reg = await httpReq('POST', B.port, '/w/b/fabric/presence/register', { player_id: playerId, display_name: name, position: [1, 0, 1], ttl_ms: 60000 });
        if (reg.status !== 200 && reg.status !== 201) { failures.push('presence register of ' + playerId + ' answered ' + reg.status + ' ' + reg.body.slice(0, 120)); return; }
        const u = (await httpReq('GET', B.port, '/w/b/wow/user/' + playerId, null, { Accept: lab.WOW })).json;
        if (!u || !Number.isInteger(u.id)) { failures.push('the presence user ' + playerId + ' reads ' + JSON.stringify(u).slice(0, 120)); return; }
        users.push({ kind: 'presence', id: u.id, name });
      };
      const joined = async () => {
        const entered = await hs.enterWorld(B.base, { wallet: SE_WALLET });
        const m = /^wow\/user\/(\d+)$/.exec((entered.answer && entered.answer.user) || '');
        if (entered.status !== 201 || !m) { failures.push('the join answered ' + entered.status + ' ' + JSON.stringify(entered.answer && entered.answer.user)); return; }
        users.push({ kind: 'handshake', id: Number(m[1]), name: 'Ada' });
      };
      await present('se3-present-1', 'present one');
      await joined();
      await joined();
      await present('se3-present-2', 'present two');
      const ids = users.map((u) => u.id);
      const shared = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (shared.length) failures.push('ids given: ' + users.map((u) => u.kind + ' ' + u.id).join(', ') + '; shared by two users: ' + Array.from(new Set(shared)).join(', '));
      // Each id reads back its own user (the handshake user is read first, so a shared id hides the presence user).
      for (const u of users) {
        const r = await httpReq('GET', B.port, '/w/b/wow/user/' + u.id, null, { Accept: lab.WOW });
        const name = r.json && (r.json.name || r.json.display_name);
        if (r.status !== 200 || name !== u.name) failures.push(`GET /wow/user/${u.id} (the ${u.kind} user ${JSON.stringify(u.name)}) reads ${r.status} ${JSON.stringify(name)}`);
      }
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : 'ids given: ' + users.map((u) => u.kind + ' ' + u.id).join(', ') + '; all different, and each reads back its own user' };
    } finally {
      for (const p of ['se3-present-1', 'se3-present-2']) await httpReq('POST', B.port, '/w/b/fabric/presence/depart', { player_id: p }).catch(() => {});
      await B.close();
    }
  }, {}, [
    { name: 'the old pair of separate counters (the handshake counts its own ids from 1001, as presence does)', impl: separateCounters },
  ]);
}

async function countCheck(ports) {
  // ---- SE4 --------------------------------------------------------------------------------------------
  const countIgnoresHandshake = { server: { handshake: [['        count : () => users.size,\n', '        count : () => 0,\n']] } };
  await run('SE4', 'count: one proceeding handshake join raises World.users.active_user_count by one, and DELETE of that User lowers it by one; active_user_count_source names the handshake users', async (impl) => {
    const failures = [];
    const hs = await lab.agent();
    const B = await lab.handshakeWorld('b', ports.next(), { base: '/w/b', edits: impl.server });
    try {
      const world = async () => (await httpReq('GET', B.port, '/w/b/wow/world', null, { Accept: lab.WOW })).json || {};
      const countOf = (w) => (w.users ? w.users.active_user_count : undefined);
      const w0 = await world();
      const c0 = countOf(w0);
      if (!Number.isInteger(c0)) return { ok: false, detail: 'the World has no active_user_count: ' + JSON.stringify(w0.users) };
      const entered = await hs.enterWorld(B.base, { wallet: SE_WALLET });
      const m = /^wow\/user\/(\d+)$/.exec((entered.answer && entered.answer.user) || '');
      if (entered.status !== 201 || !m) return { ok: false, detail: 'the join answered ' + entered.status + ' ' + JSON.stringify(entered.answer && entered.answer.outcome) };
      const w1 = await world();
      const c1 = countOf(w1);
      if (c1 !== c0 + 1) failures.push(`after one proceeding join active_user_count is ${c1}, not ${c0 + 1} (before: ${c0})`);
      const source = (w1.webofworlds_extension && w1.webofworlds_extension.active_user_count_source) || '';
      if (!/handshake/i.test(source)) failures.push('active_user_count_source does not name the handshake users: ' + JSON.stringify(source));
      const del = await httpReq('DELETE', B.port, '/w/b/wow/user/' + m[1], null, { Accept: lab.WOW });
      if (del.status !== 200) failures.push('DELETE /wow/user/' + m[1] + ' answered ' + del.status);
      const c2 = countOf(await world());
      if (c2 !== c1 - 1) failures.push(`after DELETE of user ${m[1]} active_user_count is ${c2}, not ${c1 - 1}`);
      return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `active_user_count ${c0}, ${c1} after the join of user ${m[1]}, ${c2} after its DELETE; source: ${JSON.stringify(source)}` };
    } finally {
      await B.close();
    }
  }, {}, [
    { name: 'a count that ignores handshake users', impl: countIgnoresHandshake },
  ]);
}

async function viewerFollowCheck(ports, arrivalAt) {
  // ---- SE5 --------------------------------------------------------------------------------------------
  const EYE = 1.6;
  const viewerIgnoresFollow = { web: { 'wow-portal-mount.mjs': [['  const follow = /^#?follow=user[./](\\d+)$/i.exec(fragment);\n', '  const follow = null;\n']] } };
  const viewerIgnoresFragmentChange = { web: { 'main-demo-viewer-portals.mjs': [['  listen(window, "hashchange", () => { void arrive(); });\n', '']] } };
  const viewerDoesNotKeep = { web: { 'main-demo-viewer-portals.mjs': [['      if (arrival.arrived && arrival.follow != null) keep = keepCamera(hash, arrival);\n', '']] } };
  let browser = null;
  try {
    await run('SE5', 'follow, in the ?wow= viewer: a page opened at #follow=user.{id} puts the visitor (the camera) at the node that places that user (within 1 cm on the floor, at eye height), not at the default spawn; when that user moves, the visitor keeps to the user\'s node with no fragment change; after that user moves again, a fragment change to #follow=user/{id} puts the visitor at the new node; a fragment change to #join=node.{n} then puts it at node n, where it stays when the user moves', async (impl) => {
      if (!browser) {
        const { findBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools', 'find-browser.mjs')).href);
        const chrome = findBrowser();
        if (!chrome) return { ok: false, detail: 'no Chrome found: set PUPPETEER_EXECUTABLE_PATH to run SE5' };
        const puppeteer = require(require.resolve('puppeteer-core', { paths: [ROOT] }));
        browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1280, height: 800 } });
      }
      const sources = {};
      for (const [file, edits] of Object.entries(impl.web || {})) {
        let source = fs.readFileSync(path.join(ROOT, 'web', file), 'utf8');
        for (const [from, to] of edits) {
          const count = source.split(from).length - 1;
          if (count !== 1) throw staleEdit('web/' + file, from, count);
          source = source.replace(from, () => to);
        }
        sources[file] = source;
      }
      const frontendPort = ports.next();
      const frontend = await require(path.join(ROOT, 'src', 'serve.js')).createFrontendServer(frontendPort, { backendPorts: { a: 1, b: 1, lobby: 1, airport: 1 } });
      const FRONT = 'http://127.0.0.1:' + frontendPort;
      const A = await lab.handshakeWorld('a', ports.next(), { label: 'World A', claims: lab.A_CLAIMS });
      const failures = [];
      const notes = [];
      let heartbeat = null;
      const page = await browser.newPage();
      try {
        const leader = { player_id: 'se5-followed', display_name: 'followed', position: [3.2, 0, -2.4], rotation_y: 0.6, ttl_ms: 60000 };
        const reg = await httpReq('POST', A.port, '/fabric/presence/register', leader);
        if (reg.status !== 200 && reg.status !== 201) return { ok: false, detail: 'the followed user could not register: ' + reg.status + ' ' + reg.body.slice(0, 160) };
        heartbeat = setInterval(() => { httpReq('POST', A.port, '/fabric/presence/heartbeat', leader).catch(() => {}); }, 2000);
        const user = (await httpReq('GET', A.port, '/wow/user/' + leader.player_id, null, { Accept: lab.WOW })).json;
        const userId = user && user.id;
        const first = await userNodePose(A.port, userId, arrivalAt);
        if (!first) return { ok: false, detail: 'the followed user ' + userId + ' is placed by no node: ' + JSON.stringify(user && user.node) };
        // The node a later #join=node.{n} arrives at (step 4).
        const [joinNode] = await A.add(1, await A.rootOf(1), [{ label: 'se5 arrival', localTransform: lab.placed(-3, 0, 1.5, 90) }]);
        const joinAt = await arrivalAt(A.base, joinNode);
        if (!joinAt) return { ok: false, detail: 'world A has no node ' + joinNode };
        if (Object.keys(sources).length) {
          await page.setRequestInterception(true);
          page.on('request', (req) => {
            let file = '';
            try { file = new URL(req.url()).pathname.split('/').pop(); } catch (e) { file = ''; }
            if (sources[file]) req.respond({ status: 200, contentType: 'text/javascript; charset=utf-8', body: sources[file] }).catch(() => {});
            else req.continue().catch(() => {});
          });
        }
        const camera = () => page.evaluate(() => (window.__wowViewControls && window.__wowViewControls.pose ? window.__wowViewControls.pose().position : null));
        const standsAt = (target) => async () => {
          const c = await camera();
          return c && Math.hypot(c[0] - target[0], c[2] - target[2]) <= ONE_CM && Math.abs(c[1] - (target[1] + EYE)) <= ONE_CM ? c : null;
        };
        const describe = (c, target) => `${JSON.stringify(c && c.map((v) => +v.toFixed(3)))}, ${c ? Math.hypot(c[0] - target[0], c[2] - target[2]).toFixed(3) : '?'} m on the floor from ${JSON.stringify(target.map((v) => +v.toFixed(3)))}`;
        // 1. Opened at #follow=user.{id}.
        await page.goto(`${FRONT}/index.html?role=source&intro=bypass&wow=${encodeURIComponent(A.spatialUrl(1))}#follow=user.${userId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction(() => document.body.dataset.wowPortalsReady && window.__wowViewControls, { timeout: 180000 });
        const atFirst = await poll(standsAt(first.position), 30000, 200);
        if (!atFirst) failures.push(`after opening #follow=user.${userId} the camera stands at ${describe(await camera(), first.position)} (user ${userId}'s node ${first.node}; data-wow-arrival: ${await page.evaluate(() => document.body.dataset.wowArrival || null)})`);
        else notes.push(`opened at #follow=user.${userId}: the camera stands ${(Math.hypot(atFirst[0] - first.position[0], atFirst[2] - first.position[2]) * 1000).toFixed(1)} mm from node ${first.node}, at eye height`);
        // 1b. The user moves, and nothing else changes: the viewer keeps to the user's node.
        if (atFirst) {
          leader.position = [0.8, 0, 3.6];
          leader.rotation_y = 0.2;
          await httpReq('POST', A.port, '/fabric/presence/heartbeat', leader);
          const moved = await userNodePose(A.port, userId, arrivalAt);
          if (!moved || distance(moved.position, first.position) < 1) failures.push('the followed user\'s node did not move: ' + JSON.stringify(moved));
          else {
            const kept = await poll(standsAt(moved.position), 20000, 200);
            if (!kept) failures.push(`the user moved to ${JSON.stringify(moved.position.map((v) => +v.toFixed(3)))} with no fragment change, but the camera stands at ${describe(await camera(), moved.position)}: the viewer does not keep to the user`);
            else notes.push(`kept to the user with no fragment change when the user moved ${distance(moved.position, first.position).toFixed(2)} m (${(Math.hypot(kept[0] - moved.position[0], kept[2] - moved.position[2]) * 1000).toFixed(1)} mm off)`);
          }
        }
        // 2. The user moves; a fragment change follows it to the new node.
        if (atFirst) {
          leader.position = [-2.6, 0, 1.8];
          leader.rotation_y = -1.1;
          await httpReq('POST', A.port, '/fabric/presence/heartbeat', leader);
          const second = await userNodePose(A.port, userId, arrivalAt);
          if (!second || distance(second.position, first.position) < 1) failures.push('the followed user\'s node did not move: ' + JSON.stringify(second));
          else {
            await page.evaluate((id) => { location.hash = '#follow=user/' + id; }, userId);
            const atSecond = await poll(standsAt(second.position), 20000, 200);
            if (!atSecond) failures.push(`after the user moved and the fragment changed to #follow=user/${userId} the camera stands at ${describe(await camera(), second.position)}`);
            else notes.push(`after the fragment change to #follow=user/${userId}: ${(Math.hypot(atSecond[0] - second.position[0], atSecond[2] - second.position[2]) * 1000).toFixed(1)} mm from the moved node ${second.node}`);
          }
          // 4. A fragment change to #join=node.{n}: the visitor stands at node n and no longer follows the user.
          await page.evaluate((n) => { location.hash = '#join=node.' + n; }, joinNode);
          const atJoin = await poll(standsAt(joinAt.position), 20000, 200);
          if (!atJoin) failures.push(`after the fragment change to #join=node.${joinNode} the camera stands at ${describe(await camera(), joinAt.position)}`);
          else {
            leader.position = [2.0, 0, 4.0];
            leader.rotation_y = 0;
            await httpReq('POST', A.port, '/fabric/presence/heartbeat', leader);
            await sleep(1500);
            const still = await standsAt(joinAt.position)();
            if (!still) failures.push(`at #join=node.${joinNode}, after the user moved again, the camera stands at ${describe(await camera(), joinAt.position)}: it still follows the user`);
            else notes.push(`after the fragment change to #join=node.${joinNode}: at that node, and there still 1.5 s after the user moved again`);
          }
        }
        return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : notes.join('; ') };
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        await page.close().catch(() => {});
        await new Promise((resolve) => frontend.close(resolve));
        await A.close();
      }
    }, {}, [
      { name: 'a viewer that ignores #follow', impl: viewerIgnoresFollow },
      { name: 'a viewer that does not act on a fragment change', impl: viewerIgnoresFragmentChange },
      { name: 'a viewer that arrives at the followed user once and does not keep to the user', impl: viewerDoesNotKeep },
    ]);
  } finally {
    if (browser) await browser.close();
  }
}

/** The page's modules with exact string edits (a planted fault), by file name; an edit that does not match once is stale. */
function editedSources(impl) {
  const sources = {};
  for (const [file, edits] of Object.entries((impl && impl.web) || {})) {
    let source = fs.readFileSync(path.join(ROOT, 'web', file), 'utf8');
    for (const [from, to] of edits) {
      const count = source.split(from).length - 1;
      if (count !== 1) throw staleEdit('web/' + file, from, count);
      source = source.replace(from, () => to);
    }
    sources[file] = source;
  }
  return sources;
}

/** Serve `sources` to the page in place of the real modules (request interception). */
async function serveEdited(page, sources) {
  if (!Object.keys(sources).length) return;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    let file = '';
    try { file = new URL(req.url()).pathname.split('/').pop(); } catch (e) { file = ''; }
    if (sources[file]) req.respond({ status: 200, contentType: 'text/javascript; charset=utf-8', body: sources[file] }).catch(() => {});
    else req.continue().catch(() => {});
  });
}

async function playerArrivalCheck(ports, arrivalAt) {
  // ---- SE6 --------------------------------------------------------------------------------------------
  // The old spawn-only placement: at role=player the page embodies the avatar at the world spawn and nothing moves it.
  const spawnOnly = { web: { 'app.js': [['      void arriveWowAvatar();\n', '']] } };
  const ORBIT_REACH = 6; // the orbit camera stands within this many meters (on the floor) of the avatar it follows
  let browser = null;
  try {
    await run('SE6', 'arrival at role=player, in the ?wow= viewer: a page opened at #join=node.{n} puts the embodied avatar at node n (within 1 cm on the floor), and a page opened at #follow=user.{id} puts it at the node that places that user and keeps it there when that user moves; the orbit camera follows the avatar from there and does not put it back at the world spawn', async (impl) => {
      if (!browser) {
        const { findBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools', 'find-browser.mjs')).href);
        const chrome = findBrowser();
        if (!chrome) return { ok: false, detail: 'no Chrome found: set PUPPETEER_EXECUTABLE_PATH to run SE6' };
        const puppeteer = require(require.resolve('puppeteer-core', { paths: [ROOT] }));
        browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1280, height: 800 } });
      }
      const sources = editedSources(impl);
      const frontendPort = ports.next();
      const frontend = await require(path.join(ROOT, 'src', 'serve.js')).createFrontendServer(frontendPort, { backendPorts: { a: 1, b: 1, lobby: 1, airport: 1 } });
      const FRONT = 'http://127.0.0.1:' + frontendPort;
      const A = await lab.handshakeWorld('a', ports.next(), { label: 'World A', claims: lab.A_CLAIMS });
      const failures = [];
      const notes = [];
      let heartbeat = null;
      const pages = [];
      try {
        // The node to arrive at by #join, away from the spawn.
        const [joinNode] = await A.add(1, await A.rootOf(1), [{ label: 'se6 arrival', localTransform: lab.placed(-3, 0, 1.5, 90) }]);
        const joinAt = await arrivalAt(A.base, joinNode);
        if (!joinAt) return { ok: false, detail: 'world A has no node ' + joinNode };
        const leader = { player_id: 'se6-followed', display_name: 'followed', position: [3.2, 0, -2.4], rotation_y: 0.6, ttl_ms: 60000 };
        const reg = await httpReq('POST', A.port, '/fabric/presence/register', leader);
        if (reg.status !== 200 && reg.status !== 201) return { ok: false, detail: 'the followed user could not register: ' + reg.status + ' ' + reg.body.slice(0, 160) };
        heartbeat = setInterval(() => { httpReq('POST', A.port, '/fabric/presence/heartbeat', leader).catch(() => {}); }, 2000);
        const user = (await httpReq('GET', A.port, '/wow/user/' + leader.player_id, null, { Accept: lab.WOW })).json;
        const userId = user && user.id;
        const first = await userNodePose(A.port, userId, arrivalAt);
        if (!first) return { ok: false, detail: 'the followed user ' + userId + ' is placed by no node: ' + JSON.stringify(user && user.node) };

        const open = async (fragment) => {
          const page = await browser.newPage();
          pages.push(page);
          await serveEdited(page, sources);
          await page.goto(`${FRONT}/index.html?role=player&intro=bypass&avatar_variant=${lab.DEFAULT_VARIANT}&wow=${encodeURIComponent(A.spatialUrl(1))}${fragment}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForFunction(() => document.body.dataset.wowAvatarEmbodied === '1' && document.body.dataset.wowPortalsReady && window.__wowViewControls && window.__wow && window.__wow.avatarState, { timeout: 180000 });
          return page;
        };
        const read = (page) => page.evaluate(() => {
          const a = window.__wow.avatarState();
          const c = window.__wowViewControls.pose ? window.__wowViewControls.pose().position : null;
          return { avatar: a && a.position ? a.position.slice() : null, camera: c };
        });
        const floor = (p, q) => Math.hypot(p[0] - q[0], p[2] - q[2]);
        const fmt = (p) => JSON.stringify(p && p.map((v) => +v.toFixed(3)));
        // The avatar stands at `target` and the camera follows it, read twice 1.5 s apart (the camera loop runs every frame).
        const standsAt = async (page, target, what) => {
          const got = await poll(async () => { const r = await read(page); return r.avatar && floor(r.avatar, target) <= ONE_CM ? r : null; }, 30000, 200);
          if (!got) {
            const r = await read(page);
            failures.push(`${what}: the avatar stands at ${fmt(r.avatar)}, ${r.avatar ? floor(r.avatar, target).toFixed(3) : '?'} m on the floor from ${fmt(target)} (camera ${fmt(r.camera)}; arrival note ${await page.evaluate(() => document.body.dataset.wowAvatarArrival || null)})`);
            return null;
          }
          await sleep(1500);
          const later = await read(page);
          if (!later.avatar || floor(later.avatar, target) > ONE_CM) { failures.push(`${what}: the avatar reached ${fmt(target)} but 1.5 s later stands at ${fmt(later.avatar)}`); return null; }
          if (!later.camera || floor(later.camera, later.avatar) > ORBIT_REACH) { failures.push(`${what}: the camera stands at ${fmt(later.camera)}, ${later.camera ? floor(later.camera, later.avatar).toFixed(2) : '?'} m from the avatar, not following it`); return null; }
          return later;
        };

        // 1. #join=node.{n}.
        const joinPage = await open(`#join=node.${joinNode}`);
        const j = await standsAt(joinPage, joinAt.position, `opened at #join=node.${joinNode}`);
        if (j) {
          notes.push(`#join=node.${joinNode}: the avatar stands ${(floor(j.avatar, joinAt.position) * 1000).toFixed(1)} mm from the node, the orbit camera ${floor(j.camera, j.avatar).toFixed(2)} m behind it`);
          if (!impl.web) await joinPage.screenshot({ path: path.join(ROOT, 'diagnostics', 'arch-i5-se6-player-arrival.png') }).catch(() => {});
        }
        await joinPage.close();

        // 2. #follow=user.{id}, then the user moves.
        const followPage = await open(`#follow=user.${userId}`);
        const f = await standsAt(followPage, first.position, `opened at #follow=user.${userId}`);
        if (f) {
          notes.push(`#follow=user.${userId}: the avatar stands ${(floor(f.avatar, first.position) * 1000).toFixed(1)} mm from user ${userId}'s node ${first.node}`);
          leader.position = [-2.6, 0, 1.8];
          leader.rotation_y = -1.1;
          await httpReq('POST', A.port, '/fabric/presence/heartbeat', leader);
          const second = await userNodePose(A.port, userId, arrivalAt);
          if (!second || distance(second.position, first.position) < 1) failures.push('the followed user\'s node did not move: ' + JSON.stringify(second));
          else {
            const k = await standsAt(followPage, second.position, `after user ${userId} moved`);
            if (k) notes.push(`kept to the user when the user moved ${distance(second.position, first.position).toFixed(2)} m (${(floor(k.avatar, second.position) * 1000).toFixed(1)} mm off), the camera ${floor(k.camera, k.avatar).toFixed(2)} m behind`);
          }
        }
        return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : notes.join('; ') };
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        for (const page of pages) await page.close().catch(() => {});
        await new Promise((resolve) => frontend.close(resolve));
        await A.close();
      }
    }, {}, [
      { name: 'the old spawn-only placement at role=player', impl: spawnOnly },
    ]);
  } finally {
    if (browser) await browser.close();
  }
}

async function presentPilotCheck(ports) {
  // ---- ID11 -------------------------------------------------------------------------------------------
  const presenceReadAsHuman = { server: { users: [["            pilot : 'unstated', // a present user made no handshake, so it stated no pilot: never human\n", "            pilot : 'human',\n"]] } };
  const labelWithoutPilot = { web: { 'peer-avatar-presentation.mjs': [['    const text = userLabel({ ...(user || {}), name: (user && user.name) || peer.display_name, pilot: user && user.pilot });\n', '    const text = (user && user.name) || peer.display_name;\n']] } };
  const userReadFails = { web: { 'scene-runtime-controller.mjs': [['      const base=lastPeerDebug?.active?.backend_base_url;\n', '      return null;\n']] } };
  let browser = null;
  try {
    await run('ID11', 'the pilot of present users: a user present by /fabric/presence/register made no handshake, so GET /wow/user/{id} (by User id and by player id) reads pilot "unstated", never human; in the main demo a second page shows the first page\'s avatar (a present user of world A) with the shared user label, which reads "pilot not stated"', async (impl) => {
      const failures = [];
      const notes = [];
      // 1. On the wire, in Node.
      const B = await lab.handshakeWorld('b', ports.next(), { base: '/w/b', edits: impl.server });
      try {
        const reg = await httpReq('POST', B.port, '/w/b/fabric/presence/register', { player_id: 'id11-present', display_name: 'Present Pat', position: [1, 0, 1], ttl_ms: 60000 });
        if (reg.status !== 200 && reg.status !== 201) return { ok: false, detail: 'presence register answered ' + reg.status + ' ' + reg.body.slice(0, 120) };
        const byPlayer = await httpReq('GET', B.port, '/w/b/wow/user/id11-present', null, { Accept: lab.WOW });
        const id = byPlayer.json && byPlayer.json.id;
        const byId = await httpReq('GET', B.port, '/w/b/wow/user/' + id, null, { Accept: lab.WOW });
        for (const [how, r] of [['by player id', byPlayer], ['by User id ' + id, byId]]) {
          const pilot = r.json ? r.json.pilot : undefined;
          if (r.status !== 200 || pilot !== 'unstated') failures.push(`GET /wow/user (${how}) of a present user answered ${r.status} with pilot ${JSON.stringify(pilot)}, not "unstated"`);
        }
        if (!failures.length) notes.push(`present user ${id} (player id id11-present) reads pilot "unstated" by both ids`);
      } finally {
        await httpReq('POST', B.port, '/w/b/fabric/presence/depart', { player_id: 'id11-present' }).catch(() => {});
        await B.close();
      }
      // 2. In a browser: the main demo, two pages in world A; the second shows the first's avatar with its label.
      if (!browser) {
        const { findBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools', 'find-browser.mjs')).href);
        const chrome = findBrowser();
        if (!chrome) return { ok: false, detail: 'no Chrome found: set PUPPETEER_EXECUTABLE_PATH to run ID11' };
        const puppeteer = require(require.resolve('puppeteer-core', { paths: [ROOT] }));
        browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1280, height: 800 } });
      }
      const sources = editedSources(impl);
      const L = await mainDemoLab(ports);
      const context = await browser.createBrowserContext();
      try {
        const first = await context.newPage();
        await serveEdited(first, sources);
        await openPlayer(first, `${L.front}/w/a/?intro=bypass`);
        const firstId = await first.evaluate(() => { const d = window.__assembly.debugState(); return (d.presence_registration && d.presence_registration.player_id) || null; });
        const second = await context.newPage();
        const userReads = [];
        second.on('response', (res) => {
          try {
            const req = res.request();
            if (req.method() === 'GET' && /\/wow\/user\/[^/?#]+$/.test(new URL(res.url()).pathname)) userReads.push({ url: res.url(), status: res.status() });
          } catch (e) { /* not a URL */ }
        });
        await serveEdited(second, sources);
        await openPlayer(second, `${L.front}/w/a/?intro=bypass`);
        const labelled = await poll(async () => {
          const peers = await second.evaluate(() => window.__assembly.peerAvatars());
          return (peers || []).find((p) => p.label && p.label.text) || null;
        }, 60000, 500);
        if (!labelled) {
          const peers = await second.evaluate(() => window.__assembly.peerAvatars());
          failures.push('the second page shows no labelled peer avatar (peers: ' + JSON.stringify((peers || []).map((p) => ({ player_id: p.player_id, rendered: p.rendered, label: p.label || null }))) + ')');
        } else {
          const text = labelled.label.text;
          const user = (await httpReq('GET', L.backendPorts.a, '/wow/user/' + encodeURIComponent(labelled.player_id), null, { Accept: lab.WOW })).json || {};
          if (!/\(pilot not stated\)$/.test(text)) failures.push(`the present user's avatar is labelled ${JSON.stringify(text)}, not as "pilot not stated"`);
          if (/human/i.test(text)) failures.push(`the present user's avatar is labelled ${JSON.stringify(text)}, as human`);
          if (user.name && !text.startsWith(user.name)) failures.push(`the label ${JSON.stringify(text)} does not name the user ${JSON.stringify(user.name)}`);
          // The page read the User: the label's name is the name the world's User carries, and the page's own GET of
          // that User at the active world's address answered 200.
          const labelName = text.replace(/ \(pilot not stated\)$/, '');
          if (typeof user.name !== 'string' || !user.name.trim()) failures.push(`world A's User for ${labelled.player_id} carries no name to compare with the label ${JSON.stringify(text)}`);
          else if (labelName !== user.name) failures.push(`the label's name ${JSON.stringify(labelName)} is not the name the world's User carries, ${JSON.stringify(user.name)}`);
          const activeBase = await second.evaluate(() => { const d = window.__assembly.debugState(); return (d && d.active && d.active.backend_base_url) || null; });
          const wanted = activeBase ? `${activeBase}/wow/user/${encodeURIComponent(labelled.player_id)}` : null;
          const read = userReads.find((r) => r.url === wanted && r.status === 200);
          if (!activeBase) failures.push('the second page states no active world address (debugState().active.backend_base_url)');
          else if (!read) failures.push(`the second page made no GET ${wanted} with answer 200 (its User reads: ${JSON.stringify(userReads)})`);
          else notes.push(`the second page read GET ${wanted}: 200; the label's name ${JSON.stringify(labelName)} is the User's name`);
          if (!labelled.label.drawn) failures.push(`the label ${JSON.stringify(text)} is not drawn on the avatar`);
          if (user.pilot !== 'unstated') failures.push(`world A reads the present user ${labelled.player_id} with pilot ${JSON.stringify(user.pilot)}`);
          if (failures.length === 0) {
            notes.push(`the second page labels the first page's avatar (player ${labelled.player_id}${firstId && firstId === labelled.player_id ? ', the first page' : ''}) ${JSON.stringify(text)}, drawn on the avatar; world A reads that user's pilot "unstated"`);
            if (!impl.web && !impl.server) {
              await sleep(1500);
              await second.screenshot({ path: path.join(ROOT, 'diagnostics', 'arch-i5-id11-present-label.png') }).catch(() => {});
            }
          }
        }
        return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : notes.join('; ') };
      } finally {
        await context.close().catch(() => {});
        await L.close();
      }
    }, {}, [
      { name: 'a world that reads a present user as human', impl: presenceReadAsHuman },
      { name: 'an avatar label with no pilot', impl: labelWithoutPilot },
      { name: 'a page whose User read gives null (readUser returns null)', impl: userReadFails },
    ]);
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { sessionChecks, presentPilotCheck };
