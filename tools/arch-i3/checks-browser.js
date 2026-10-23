'use strict';

/*
 * Iteration 3, the dashboard in a browser.
 *
 *   O8   a static page served from a third origin (web/wow-dashboard.html) shows B's temperature and A's
 *        user count; each value shows its source world, its revision and its age, computed from the
 *        change's `time`, and follows B's changes
 *
 * It runs in Chrome (found by tools/find-browser.mjs), behind the lab's machine-load gate: with the 1-minute
 * load at or above OSL_WOW_LOAD_GATE (14 by default) it is DEFERRED, never passed. Set
 * OSL_ARCH_I3_FORCE_BROWSER=1 to run it anyway; the run is then recorded as forced.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { pathToFileURL } = require('url');
const { ROOT, run } = require('../arch-i1/lib');
const lab = require('./lab');

const { w } = lab;
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

/** A static host for the lab's web pages, on its own origin. */
async function pageHost(port) {
  const server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, 'web', name);
    if (!/^wow-[\w.-]+\.(html|mjs|js)$/.test(name) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return { base: 'http://127.0.0.1:' + port, close: () => new Promise((r) => server.close(r)) };
}

async function browserChecks(ports) {
  const noCors = { serverEdits: { server: [["const CORS_POLICY = cfg.cors_allowed_origins === undefined ? '*' : cfg.cors_allowed_origins;", 'const CORS_POLICY = [];']] } };
  const gate = Number(process.env.OSL_WOW_LOAD_GATE || 14);
  const load1 = os.loadavg()[0];
  const forced = process.env.OSL_ARCH_I3_FORCE_BROWSER === '1';
  let browser = null;
  try {
    await run('O8', 'a static page from a third origin shows B\'s temperature and A\'s user count, each with its source world, revision and age (from `time`), and follows B\'s changes', async (impl) => {
      if (load1 >= gate && !forced) return { ok: true, deferred: true, detail: `DEFERRED by the machine-load gate: 1-minute load ${load1.toFixed(2)} >= ${gate}` };
      if (!browser) {
        const { findBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools', 'find-browser.mjs')).href);
        const chrome = findBrowser();
        if (!chrome) return { ok: false, detail: 'no Chrome found: set PUPPETEER_EXECUTABLE_PATH to run O8' };
        const puppeteer = require(require.resolve('puppeteer-core', { paths: [ROOT] }));
        browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });
      }
      const A = await w.world('a', ports.next());
      const B = await w.world('b', ports.next(), { base: '/w/b', edits: impl.serverEdits });
      const pages = await pageHost(ports.next());
      const page = await browser.newPage();
      try {
        const [n] = await B.add(1, await B.rootOf(1), [{ label: 'node n', localTransform: w.IDENTITY, properties: { temperature: 20 } }]);
        const points = [B.nodeUrl(1, n) + '#/properties/temperature', A.worldUrl() + '#/users/active_user_count'];
        await page.goto(pages.base + '/wow-dashboard.html?' + points.map((p) => 'point=' + encodeURIComponent(p)).join('&'), { waitUntil: 'domcontentloaded' });
        const read = () => page.evaluate(() => [...document.querySelectorAll('.point')].map((el) => ({
          world: el.dataset.world || '', revision: el.dataset.revision, value: el.dataset.value, time: el.dataset.time,
          age: el.querySelector('.age').textContent, status: el.querySelector('.status').textContent,
        })));
        await lab.until(async () => (await read()).every((c) => c.status === 'ok' && c.world), 15000, 'both values on the page').catch(() => null);
        const log = await B.server.built.runtime.startSimulator({ node_id: n, interval_ms: 400, count: 2 }).done;
        await lab.sleep(1200);
        const cards = await read();
        const [temp, users] = cards;
        const failures = [];
        if (!temp || temp.status !== 'ok') failures.push('B\'s temperature: ' + JSON.stringify(temp));
        else {
          if (Number(temp.revision) !== log[1].revision) failures.push(`B's revision on the page is ${temp.revision}, the last change was ${log[1].revision}`);
          if (JSON.parse(temp.value) !== log[1].temperature) failures.push(`B's value on the page is ${temp.value}`);
          if (temp.time !== log[1].time) failures.push('the page\'s time is not the change\'s');
          if (!/ s$/.test(temp.age)) failures.push('no age shown: ' + temp.age);
          if (!/Location B/.test(temp.world)) failures.push('source world shown as ' + temp.world);
        }
        if (!users || users.status !== 'ok' || JSON.parse(users.value) !== 0 || !/Location A/.test(users.world)) failures.push('A\'s user count: ' + JSON.stringify(users));
        else {
          const aRevision = (await lab.worldDoc(A)).revision;
          if (users.revision === '' || Number(users.revision) !== aRevision) failures.push(`A's revision on the page is "${users.revision}", A's World reports ${aRevision}`);
          if (!/ s$/.test(users.age)) failures.push('no age shown for A\'s value: ' + users.age);
        }
        return { ok: failures.length === 0, detail: (forced && load1 >= gate ? `FORCED past the load gate (load ${load1.toFixed(2)}): ` : '') + (failures.length ? failures.join('; ') : `from ${pages.base}: ${temp.world.split(' · ')[0]} ${JSON.parse(temp.value)} at revision ${temp.revision}, age ${temp.age}; ${users.world.split(' · ')[0]} users ${users.value} at revision ${users.revision}, age ${users.age}`) };
      } finally {
        await page.close();
        await pages.close();
        await A.close();
        await B.close();
      }
    }, {}, [{ name: 'a B that allows no other origin', impl: noCors }]);
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { browserChecks };
