'use strict';

/*
 * Headless check of the visible-changes demo (tools/arch-i5/owner-demo.js): it starts the demo, opens each start-page link in
 * headless Chrome for Testing, asserts what the link promises, and stops everything. Run it through
 * demo-servers/browser-run.sh.
 *
 *   node tools/arch-i5/owner-demo-check.js [--port <start-page port>] [--tree <built app dir>] [--shots <dir>]
 *
 *   1  player arrival (as SE6): the ?wow= player opened at link 1 (#join=node.{n}) puts the embodied avatar within 1 cm
 *      on the floor of node n, still there 1.5 s later, with the orbit camera following it
 *   2  pilot label (as ID11): link 2a, then link 2b; the second page shows the first page's avatar with a label that
 *      ends "(pilot not stated)", does not say human, and is drawn on the avatar; world A reads that user's pilot
 *      "unstated"
 *   3  follow (as SE1): link 3 (/follow) opens #follow=user.{id} of the first page's user; the page stands within 1 cm
 *      of the node that places that user; after the first page walks with W, the user's node moves and the follow
 *      page keeps within 1 cm of it
 * One screenshot per feature goes to --shots. Exit 0 only when all three pass.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { ROOT, httpReq, makeTempDir } = require('../arch-i1/lib');
const lab = require('./lab');

const ONE_CM = 0.01;
const ORBIT_REACH = 6;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const floor = (p, q) => Math.hypot(p[0] - q[0], p[2] - q[2]);
const fmt = (p) => JSON.stringify(p && p.map((v) => +v.toFixed(3)));
const stamp = () => new Date().toISOString();
const say = (text) => process.stdout.write(`${stamp()} ${text}\n`);

async function poll(fn, ms, every) {
  const end = Date.now() + ms;
  let value = null;
  for (;;) {
    value = await fn();
    if (value || Date.now() > end) return value;
    await sleep(every || 100);
  }
}

function readArgs(argv) {
  const out = { port: '34700', tree: null, shots: path.join(ROOT, 'diagnostics') };
  for (let i = 0; i < argv.length; i += 2) {
    const key = String(argv[i]).replace(/^--/, '');
    if (!(key in out) || argv[i + 1] === undefined) throw new Error('usage: owner-demo-check.js [--port <n>] [--tree <dir>] [--shots <dir>]');
    out[key] = argv[i + 1];
  }
  return out;
}

/** Start owner-demo.js as a child and wait for its ready line. */
function startDemo(args, pidFile) {
  const argv = [path.join(__dirname, 'owner-demo.js'), '--port', args.port, '--pid-file', pidFile];
  if (args.tree) argv.push('--tree', args.tree);
  const child = spawn(process.execPath, argv, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('owner-demo.js gave no ready line in 120 s:\n' + out.slice(-2000))); }, 120000);
    const onData = (chunk) => {
      out += chunk;
      const m = /^ready (\{.*\})$/m.exec(out);
      if (m) { clearTimeout(timer); resolve({ child, info: JSON.parse(m[1]) }); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error('owner-demo.js exited ' + code + ':\n' + out.slice(-2000))); });
  });
}

/** The links of the start page, read from the page itself, as a person would follow them. */
async function startLinks(page, startUrl) {
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  return page.evaluate(() => Object.fromEntries([...document.querySelectorAll('a[id^="link-"]')].map((a) => [a.id.slice(5), a.href])));
}

/** Open the main demo as a Player and wait until the world and the avatar are up (as checks-session.js openPlayer). */
async function openPlayer(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.dataset.assemblyReady === '1' && window.__assembly && window.__assembly.debugState, { timeout: 120000 });
  await page.evaluate(() => { const b = document.querySelector('[data-testid="start-exploring"]'); if (b) b.click(); });
  await page.waitForFunction(() => window.__assembly.equipmentReady?.() !== false && window.__assembly.debugState().avatar, { timeout: 120000 });
}

const avatarPosition = (page) => page.evaluate(() => { const d = window.__assembly.debugState(); return d.avatar && d.avatar.position ? d.avatar.position.slice() : null; });

async function main() {
  const args = readArgs(process.argv.slice(2));
  fs.mkdirSync(args.shots, { recursive: true });
  const { arrivalAt } = await import(pathToFileURL(path.join(ROOT, 'web', 'wow-portal.mjs')).href);
  const { findBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools', 'find-browser.mjs')).href);
  const chrome = findBrowser();
  if (!chrome) throw new Error('no Chrome found: run through demo-servers/browser-run.sh');
  const puppeteer = require(require.resolve('puppeteer-core', { paths: [ROOT] }));

  const pidFile = path.join(makeTempDir('owner-demo-check'), 'owner-demo.pid');
  say('starting owner-demo.js');
  const { child, info } = await startDemo(args, pidFile);
  say('demo ready at ' + info.start_page + ' (pid ' + info.pid + ')');
  const A = info.ports.a;
  const results = [];
  let browser = null;
  try {
    browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1280, height: 800 } });
    const startPage = await browser.newPage();
    const links = await startLinks(startPage, info.start_page);
    await startPage.close();
    say('start-page links: ' + JSON.stringify(links));
    for (const id of ['1', '2a', '2b', '3']) if (!links[id]) throw new Error('the start page has no link ' + id);

    // ---- 1. Player arrival ---------------------------------------------------------------------------------
    {
      const failures = [];
      let detail = '';
      const node = Number((/#join=node\.(\d+)$/.exec(links['1']) || [])[1]);
      const target = Number.isFinite(node) ? await arrivalAt(info.arrival_world, node) : null;
      if (!target) failures.push('link 1 names no node of the arrival world: ' + links['1']);
      else {
        const page = await browser.newPage();
        try {
          await page.goto(links['1'], { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForFunction(() => document.body.dataset.wowAvatarEmbodied === '1' && document.body.dataset.wowPortalsReady && window.__wowViewControls && window.__wow && window.__wow.avatarState, { timeout: 180000 });
          const read = () => page.evaluate(() => {
            const a = window.__wow.avatarState();
            const c = window.__wowViewControls.pose ? window.__wowViewControls.pose().position : null;
            return { avatar: a && a.position ? a.position.slice() : null, camera: c };
          });
          const got = await poll(async () => { const r = await read(); return r.avatar && floor(r.avatar, target.position) <= ONE_CM ? r : null; }, 30000, 200);
          if (!got) {
            const r = await read();
            failures.push(`the avatar stands at ${fmt(r.avatar)}, ${r.avatar ? floor(r.avatar, target.position).toFixed(3) : '?'} m on the floor from node ${node} at ${fmt(target.position)}`);
          } else {
            await sleep(1500);
            const later = await read();
            if (!later.avatar || floor(later.avatar, target.position) > ONE_CM) failures.push(`the avatar reached node ${node} but 1.5 s later stands at ${fmt(later.avatar)}`);
            else if (!later.camera || floor(later.camera, later.avatar) > ORBIT_REACH) failures.push(`the camera stands ${later.camera ? floor(later.camera, later.avatar).toFixed(2) : '?'} m from the avatar, not following it`);
            else detail = `#join=node.${node}: the avatar stands ${(floor(later.avatar, target.position) * 1000).toFixed(1)} mm from the node (still there 1.5 s later), the orbit camera ${floor(later.camera, later.avatar).toFixed(2)} m behind it`;
          }
          await page.screenshot({ path: path.join(args.shots, 'feature-1-player-arrival.png') }).catch(() => {});
        } catch (error) {
          failures.push('the page did not come up: ' + error.message);
        } finally {
          await page.close().catch(() => {});
        }
      }
      results.push({ id: '1', name: 'player arrival', ok: failures.length === 0, detail: failures.length ? failures.join('; ') : detail });
      say(`${failures.length ? 'FAIL' : 'PASS'} 1 player arrival: ${results[results.length - 1].detail}`);
    }

    // ---- 2. Pilot label; 3. Follow (the same first page) ---------------------------------------------------
    const context = await browser.createBrowserContext();
    try {
      const first = await context.newPage();
      await openPlayer(first, links['2a']);
      const firstId = await first.evaluate(() => { const d = window.__assembly.debugState(); return (d.presence_registration && d.presence_registration.player_id) || null; });
      say('page 2a is up as player ' + firstId);
      {
        const failures = [];
        let detail = '';
        const second = await context.newPage();
        try {
          await openPlayer(second, links['2b']);
          const labelled = await poll(async () => {
            const peers = await second.evaluate(() => window.__assembly.peerAvatars());
            return (peers || []).find((p) => p.player_id === firstId && p.label && p.label.text) || null;
          }, 60000, 500);
          if (!labelled) {
            const peers = await second.evaluate(() => window.__assembly.peerAvatars());
            failures.push(`page 2b shows no labelled avatar of page 2a's player ${firstId} (peers: ${JSON.stringify((peers || []).map((p) => ({ player_id: p.player_id, rendered: p.rendered, label: p.label || null })))})`);
          } else {
            const text = labelled.label.text;
            const user = (await httpReq('GET', A, '/wow/user/' + encodeURIComponent(firstId), null, { Accept: lab.WOW })).json || {};
            if (!/\(pilot not stated\)$/.test(text)) failures.push(`the first page's avatar is labelled ${JSON.stringify(text)}, not "pilot not stated"`);
            if (/human/i.test(text)) failures.push(`the first page's avatar is labelled ${JSON.stringify(text)}, as human`);
            if (user.name && !text.startsWith(user.name)) failures.push(`the label ${JSON.stringify(text)} does not name the user ${JSON.stringify(user.name)}`);
            if (!labelled.label.drawn) failures.push(`the label ${JSON.stringify(text)} is not drawn on the avatar`);
            if (user.pilot !== 'unstated') failures.push(`world A reads player ${firstId} with pilot ${JSON.stringify(user.pilot)}`);
            if (!failures.length) detail = `page 2b labels page 2a's avatar (player ${firstId}) ${JSON.stringify(text)}, drawn on the avatar; world A reads that user's pilot "unstated"`;
            await sleep(1500);
            await second.screenshot({ path: path.join(args.shots, 'feature-2-pilot-label.png') }).catch(() => {});
          }
        } catch (error) {
          failures.push('a page did not come up: ' + error.message);
        } finally {
          await second.close().catch(() => {});
        }
        results.push({ id: '2', name: 'pilot label', ok: failures.length === 0, detail: failures.length ? failures.join('; ') : detail });
        say(`${failures.length ? 'FAIL' : 'PASS'} 2 pilot label: ${results[results.length - 1].detail}`);
      }

      {
        const failures = [];
        const notes = [];
        const user = (await httpReq('GET', A, '/wow/user/' + encodeURIComponent(firstId), null, { Accept: lab.WOW })).json || {};
        const nodeOf = async () => {
          const u = (await httpReq('GET', A, '/wow/user/' + user.id, null, { Accept: lab.WOW })).json;
          const ref = u && typeof u.node === 'string' ? /node\/(\d+)$/.exec(u.node) : null;
          if (!ref) return null;
          const at = await arrivalAt('http://127.0.0.1:' + A + '/', Number(ref[1]));
          return at ? { node: Number(ref[1]), position: at.position } : null;
        };
        const follow = await context.newPage();
        try {
          await openPlayer(follow, links['3']);
          const hash = await follow.evaluate(() => location.hash);
          if (hash.toLowerCase() !== ('#follow=user.' + user.id).toLowerCase()) failures.push(`link 3 opened ${JSON.stringify(hash)}, not #follow=user.${user.id} (page 2a's user)`);
          const before = await nodeOf();
          if (!before) failures.push(`page 2a's user ${user.id} is placed by no node`);
          const near = (target) => async () => { const p = await avatarPosition(follow); return p && distance(p, target) <= ONE_CM ? p : null; };
          const at1 = before ? await poll(near(before.position), 30000, 200) : null;
          if (before && !at1) { const p = await avatarPosition(follow); failures.push(`the follow page stands at ${fmt(p)}, ${p ? distance(p, before.position).toFixed(3) : '?'} m from user ${user.id}'s node ${before.node} at ${fmt(before.position)}`); }
          else if (at1) notes.push(`#follow=user.${user.id}: arrived ${(distance(at1, before.position) * 1000).toFixed(1)} mm from user ${user.id}'s node ${before.node}`);
          if (at1) {
            // Page 2a walks with W; its heartbeats carry the new position, which moves the user's node.
            await first.bringToFront();
            const p0 = await avatarPosition(first);
            await first.keyboard.down('w');
            await sleep(2500);
            await first.keyboard.up('w');
            const p1 = await avatarPosition(first);
            notes.push(`page 2a walked ${p0 && p1 ? floor(p0, p1).toFixed(2) : '?'} m with W`);
            const after = await poll(async () => { const n = await nodeOf(); return n && distance(n.position, before.position) >= 0.5 ? n : null; }, 20000, 500);
            await follow.bringToFront();
            if (!after) failures.push(`after page 2a walked ${p0 && p1 ? floor(p0, p1).toFixed(2) : '?'} m with W, user ${user.id}'s node did not move (still ${fmt((await nodeOf() || {}).position)})`);
            else {
              const at2 = await poll(near(after.position), 20000, 200);
              const p = await avatarPosition(follow);
              if (!at2) failures.push(`user ${user.id}'s node moved ${distance(after.position, before.position).toFixed(2)} m to ${fmt(after.position)}, but the follow page stands at ${fmt(p)}, ${p ? distance(p, after.position).toFixed(3) : '?'} m from it`);
              else notes.push(`kept to the user when the user's node moved ${distance(after.position, before.position).toFixed(2)} m (${(distance(at2, after.position) * 1000).toFixed(1)} mm off)`);
            }
          }
          await sleep(1500);
          await follow.screenshot({ path: path.join(args.shots, 'feature-3-follow.png') }).catch(() => {});
        } catch (error) {
          failures.push('the follow page did not come up: ' + error.message);
        } finally {
          await follow.close().catch(() => {});
        }
        results.push({ id: '3', name: 'follow', ok: failures.length === 0, detail: failures.length ? failures.join('; ') : notes.join('; ') });
        say(`${failures.length ? 'FAIL' : 'PASS'} 3 follow: ${results[results.length - 1].detail}`);
      }
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill('SIGTERM');
    const ended = await poll(() => child.exitCode !== null || child.signalCode !== null, 10000, 200);
    if (!ended) child.kill('SIGKILL');
    say('demo stopped (pid ' + info.pid + ')');
  }
  const passed = results.filter((r) => r.ok).length;
  say(`${passed}/${results.length} owner-demo links pass`);
  for (const r of results) say(`  ${r.ok ? 'PASS' : 'FAIL'} ${r.id} ${r.name}: ${r.detail}`);
  say(`screenshots: ${['feature-1-player-arrival.png', 'feature-2-pilot-label.png', 'feature-3-follow.png'].map((f) => path.join(args.shots, f)).join(', ')}`);
  process.exit(passed === 3 && results.length === 3 ? 0 : 1);
}

main().catch((error) => { process.stderr.write((error && error.stack) || String(error)); process.stderr.write('\n'); process.exit(1); });
