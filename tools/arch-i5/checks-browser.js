'use strict';

/*
 * Iteration 5, the ID1 after view in a browser.
 *
 *   V1  in the iteration 4 `?wow=` player, a visitor enters world A (which asks only for the display name),
 *       crosses A's portal to world B by a mouse click, and enters B, which asks for the avatar and the
 *       preferences (required) and the display name (optional). The page sends each world only what it
 *       asks for, B answers proceed and records it, and the page then draws the avatar B accepted (Sophie)
 *       at the preferred height B accepted (1.85 m, measured on the rendered model within 2 cm). A panel
 *       shows what was asked, what was sent and B's recorded outcome. A and B receive different pointers,
 *       and no pointer appears in any URL or Referer header either world received from the browser.
 *
 * It runs in Chrome for Testing, headless (found by tools/find-browser.mjs), with the lab's own frontend.
 */

const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, run } = require('../arch-i1/lib');
const lab = require('./lab');

const EXPECTED_VARIANT = lab.ACCEPTED_VARIANT;
const EXPECTED_HEIGHT = 1.85;

async function waitHandshake(page) {
  await page.waitForFunction(() => document.body.dataset.wowHandshake, { timeout: 180000 });
  return page.evaluate(() => window.__wowHandshake ? {
    asked: window.__wowHandshake.asked, sent: window.__wowHandshake.sent, refused: window.__wowHandshake.refused,
    outcome: window.__wowHandshake.record && window.__wowHandshake.record.outcome, answer: window.__wowHandshake.answer,
    applied: window.__wowHandshake.applied, panel: (document.getElementById('wow-handshake-panel') || {}).innerText || null,
  } : { error: document.body.dataset.wowHandshake });
}

async function browserChecks(ports) {
  const userWithoutAvatar = { server: { handshake: [["                if (isObject(accepted.avatar) && typeof accepted.avatar.uri === 'string') user.AvatarURI = accepted.avatar.uri;\n", '']] } };
  // The page's agent with exact edits, served in place of web/wow-handshake.mjs: it puts the pointer in the page
  // URL and lets the full URL go out as the join's Referer.
  const refererLeak = { agent: [
    ['    referrerPolicy: "no-referrer",\n', '    referrerPolicy: "unsafe-url",\n'],
    ['  const r = await f(new URL("wow/user", base).href, {\n', '  if (globalThis.history && globalThis.location) { const u = new URL(globalThis.location.href); u.searchParams.set("visitor", key.did); globalThis.history.replaceState(globalThis.history.state, "", u.href); }\n  const r = await f(new URL("wow/user", base).href, {\n'],
  ] };
  const userWithoutPreferences = { server: { handshake: [['                if (isObject(accepted.preferences)) user.osl_preferences = JSON.parse(JSON.stringify(accepted.preferences));\n', '']] } };
  let browser = null;
  try {
    await run('V1', 'the ID1 after view, in a browser: in the ?wow= player the visitor enters A (sends only the display name), crosses to B by a mouse click on the portal, and enters B with the avatar and preferences B asked for: B answers and records proceed, the page draws Sophie at 1.85 m (measured, within 2 cm), the panel shows asked, sent and the recorded outcome; A and B receive different pointers and no pointer in any URL or Referer', async (impl) => {
      if (!browser) {
        const { findBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools', 'find-browser.mjs')).href);
        const chrome = findBrowser();
        if (!chrome) return { ok: false, detail: 'no Chrome found: set PUPPETEER_EXECUTABLE_PATH to run V1' };
        const puppeteer = require(require.resolve('puppeteer-core', { paths: [ROOT] }));
        browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1280, height: 800 } });
      }
      const frontendPort = ports.next();
      const frontend = await require(path.join(ROOT, 'src', 'serve.js')).createFrontendServer(frontendPort, { backendPorts: { a: 1, b: 1, lobby: 1, airport: 1 } });
      const FRONT = 'http://127.0.0.1:' + frontendPort;
      const { A, B, arrival, player } = await lab.crossingWorlds({ frontend: FRONT, ports: { a: ports.next(), b: ports.next() }, edits: impl.server });
      const page = await browser.newPage();
      const failures = [];
      if (impl.agent) {
        const source = lab.agentSource(impl.agent);
        await page.setRequestInterception(true);
        page.on('request', (req) => {
          let file = '';
          try { file = new URL(req.url()).pathname; } catch (e) { file = ''; }
          if (file.endsWith('/wow-handshake.mjs')) req.respond({ status: 200, contentType: 'text/javascript; charset=utf-8', body: source }).catch(() => {});
          else req.continue().catch(() => {});
        });
      }
      try {
        await page.goto(player(A), { waitUntil: 'domcontentloaded', timeout: 60000 });
        const inA = await waitHandshake(page);
        if (inA.error || (inA.sent || []).join(',') !== 'display_name' || inA.outcome !== 'proceed' || (inA.applied && inA.applied.variant)) failures.push('in A: ' + JSON.stringify({ sent: inA.sent, outcome: inA.outcome, applied: inA.applied, error: inA.error }));
        await page.screenshot({ path: path.join(ROOT, 'diagnostics', 'arch-i5-v1-world-a.png') }).catch(() => {});
        await page.waitForFunction(() => document.body.dataset.wowPortalsReady, { timeout: 180000 });
        // As a person does: close the welcome card, then click the portal where it is drawn.
        const start = await page.$('#btn-start-exploring');
        if (start && await start.isIntersectingViewport().catch(() => false)) await start.click().catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 500));
        const portals = await page.evaluate(() => (window.__wowPortals && window.__wowPortals.summary ? window.__wowPortals.summary() : []));
        const toB = portals.find((p) => /World B/.test(p.label || '') || (p.destination || '').includes(encodeURIComponent(B.spatialUrl(1))));
        if (!toB) return { ok: false, detail: failures.concat(['the portal to B is not drawn: ' + JSON.stringify(portals.map((p) => p.label))]).join('; ') };
        const point = await page.evaluate((id) => window.__wowPortals.screenPoint(id), toB.id);
        let how = 'a mouse click on the portal';
        if (point) {
          await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }), page.mouse.click(point.x, point.y)]);
        } else {
          failures.push('the portal to B is not in view, so it cannot be clicked');
          how = 'none';
        }
        if (!point) return { ok: false, detail: failures.join('; ') };
        const inB = await waitHandshake(page);
        const url = page.url();
        if (!url.includes(encodeURIComponent(B.spatialUrl(1))) || !url.endsWith('#join=node.' + arrival)) failures.push('navigated to ' + url);
        const sent = (inB.sent || []).slice().sort().join(',');
        if (inB.error || sent !== 'avatar,display_name,preferences' || inB.outcome !== 'proceed') failures.push('in B: ' + JSON.stringify({ sent: inB.sent, outcome: inB.outcome, error: inB.error }));
        // What the page draws, once the avatar has loaded at its height.
        let rendered = null;
        try {
          await page.waitForFunction((v) => { const r = window.__wowHandshake && window.__wowHandshake.rendered && window.__wowHandshake.rendered(); return r && r.variant === v && r.loaded && !r.switching && r.height_applied && Number.isFinite(r.rendered_height_m); }, { timeout: 90000 }, EXPECTED_VARIANT);
        } catch (e) { /* read what is there */ }
        rendered = await page.evaluate(() => window.__wowHandshake && window.__wowHandshake.rendered && window.__wowHandshake.rendered());
        if (!rendered || rendered.variant !== EXPECTED_VARIANT || !rendered.loaded) failures.push('the page draws ' + JSON.stringify(rendered && { variant: rendered.variant, loaded: rendered.loaded }) + ', not ' + EXPECTED_VARIANT);
        else if (!(Math.abs(rendered.rendered_height_m - EXPECTED_HEIGHT) <= 0.02)) failures.push(`the avatar is drawn ${rendered.rendered_height_m} m tall, not ${EXPECTED_HEIGHT} m`);
        const panel = inB.panel || '';
        if (!/asked for/i.test(panel) || !/Sent/i.test(panel) || !/proceed/.test(panel) || !/avatar/.test(panel)) failures.push('the panel reads: ' + JSON.stringify(panel.slice(0, 160)));
        await page.screenshot({ path: path.join(ROOT, 'diagnostics', 'arch-i5-v1-world-b.png') }).catch(() => {});
        // What each world received from the browser.
        const recB = B.records() || [];
        if (!recB.length || recB[recB.length - 1].outcome !== 'proceed') failures.push('B recorded ' + JSON.stringify(recB.map((r) => r.outcome)));
        const ja = lab.joinsReceived(A).map((j) => j.json);
        const jb = lab.joinsReceived(B).map((j) => j.json);
        const claimsOf = (j) => Object.keys((j && j.manifest && j.manifest.claims) || {}).sort().join(',');
        if (ja.length !== 1 || claimsOf(ja[0]) !== 'display_name') failures.push('A received ' + ja.map(claimsOf).join(' | '));
        if (jb.length !== 1 || claimsOf(jb[0]) !== 'avatar,display_name,preferences') failures.push('B received ' + jb.map(claimsOf).join(' | '));
        const pointers = ja.concat(jb).map((j) => j && j.manifest && j.manifest.subject).filter(Boolean);
        if (pointers.length !== 2 || pointers[0] === pointers[1]) failures.push('pointers: ' + pointers.join(', '));
        let referers = 0;
        for (const e of A.log.concat(B.log)) {
          if (e.referer) referers += 1;
          for (const p of pointers) {
            const needle = p.slice('did:key:'.length);
            if (decodeURIComponent(e.url).includes(needle)) failures.push('a pointer in the URL of ' + e.method + ' ' + e.url.slice(0, 60));
            if (e.referer && decodeURIComponent(e.referer).includes(needle)) failures.push('a pointer in the Referer of ' + e.method + ' ' + e.url.slice(0, 60));
          }
        }
        return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `A: sent display_name only, proceed; crossed by ${how}; B: sent avatar, display_name, preferences, recorded proceed; the page draws ${rendered.variant} at ${rendered.rendered_height_m.toFixed(3)} m; the panel shows asked, sent and the outcome; pointers differ; ${A.log.length + B.log.length} requests from the browser (${referers} with a Referer), none carrying a pointer` };
      } finally {
        await page.close();
        await new Promise((resolve) => frontend.close(resolve));
        await A.close();
        await B.close();
      }
    }, {}, [
      { name: 'a B whose User does not carry the avatar it accepted (the page keeps its own default)', impl: userWithoutAvatar },
      { name: 'a B whose User does not carry the preferences it accepted (the page keeps the authored height)', impl: userWithoutPreferences },
      { name: 'a page that puts the pointer in its URL and lets that URL go out as the join\'s Referer (referrerPolicy unsafe-url)', impl: refererLeak },
    ]);
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { browserChecks };
