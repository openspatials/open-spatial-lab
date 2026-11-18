'use strict';

/*
 * A2, the page in a headless browser (Chrome for Testing, found by tools/find-browser.mjs).
 *
 *   L2  the age: each value shows its age, computed from the `time` of the change that set it; a value
 *       older than its layer's osl:staleAfterSeconds is marked stale, on a page that was open while it
 *       aged and on a page opened after it aged.
 *   L4  the reaction: after each weather change, the game layer's next update carries the new value and
 *       the pond shows the state the game layer's rule gives for it, in that same update. A screenshot
 *       is taken after each change.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, run } = require('../arch-i1/lib');
const lab = require('./lab');
const { SERIES } = require('./checks-layers');

const SCREENS = path.join(ROOT, 'diagnostics', 'arch-a2', 'screens');

async function launch() {
  const { findBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools', 'find-browser.mjs')).href);
  const chrome = findBrowser();
  const puppeteer = require(require.resolve('puppeteer-core', { paths: [ROOT] }));
  return puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });
}

const readCards = (page) => page.evaluate(() => ['weather', 'game'].map((layer) => {
  const el = document.getElementById(layer);
  return {
    layer, time: el.dataset.time || '', revision: el.dataset.revision || '', value: el.dataset.value, status: el.dataset.status || '',
    stale: el.dataset.stale === '1', staleClass: el.classList.contains('stale'), age: el.querySelector('.age').textContent, now: Date.now(),
  };
}));
const ageSeconds = (text) => (/^([\d.]+) s$/.test(text) ? Number(RegExp.$1) : null);

async function open(browser, url) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1040, height: 640 });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await lab.until(async () => (await readCards(page)).every((c) => c.status === 'ok' && c.time), 15000, 'both layers on the page');
  return page;
}

async function browserChecks(ports) {
  let browser = null;
  const ensure = async () => { if (!browser) browser = await launch(); return browser; };
  try {
    const neverStale = { webEdits: { 'live-data-page.mjs': [['    const stale = isStale(el.dataset.time, limit, now);', '    const stale = false;']] } };
    const ageFromReceipt = { webEdits: { 'live-data-page.mjs': [['    const age = ageOf(el.dataset.time, now);\n    const stale = isStale(el.dataset.time, limit, now);', '    const age = ageOf(el.dataset.received, now);\n    const stale = isStale(el.dataset.received, limit, now);']] } };
    await run('L2', 'each layer\'s value shows its age, computed from the time of the change that set it; a value older than its layer\'s osl:staleAfterSeconds (3 s) is marked stale, both on a page open while it aged and on a page opened after', async (impl) => {
      const b = await ensure();
      const p = await lab.place(ports, impl);
      const pages = [];
      try {
        const page = await open(b, p.pageUrl);
        pages.push(page);
        const log = await p.startWeather({ values: [2, -1, 1.5], interval_ms: 700 }).done;
        const last = log[log.length - 1];
        await lab.until(async () => (await readCards(page)).every((c) => JSON.parse(c.value) === last.temperature), 5000, 'the last value on the page').catch(() => null);
        await lab.sleep(300);
        const failures = [];
        const fresh = await readCards(page);
        for (const c of fresh) {
          const shown = ageSeconds(c.age);
          const want = (c.now - Date.parse(c.time)) / 1000;
          if (shown === null) failures.push(`${c.layer}: no age shown (${c.age})`);
          else if (Math.abs(shown - want) > 0.75) failures.push(`${c.layer}: age ${c.age}, but its change was ${want.toFixed(1)} s ago`);
          if (c.stale || c.staleClass) failures.push(`${c.layer}: marked stale at ${c.age}`);
        }
        if (fresh[0].time !== last.time) failures.push('the weather value\'s time is not its change\'s');
        await lab.sleep(3000 + 1200);
        const aged = await readCards(page);
        for (const c of aged) if (!(c.stale && c.staleClass)) failures.push(`${c.layer}: not marked stale on the open page at ${c.age}`);
        const later = await open(b, p.pageUrl);
        pages.push(later);
        await lab.sleep(400);
        const reopened = await readCards(later);
        for (const c of reopened) {
          const shown = ageSeconds(c.age);
          if (!(c.stale && c.staleClass)) failures.push(`${c.layer}: not marked stale on a page opened later, at ${c.age}`);
          if (shown === null || shown < 3) failures.push(`${c.layer}: a page opened later shows age ${c.age}`);
        }
        return { ok: failures.length === 0, detail: failures.length ? failures.join('; ') : `fresh: weather ${fresh[0].age}, game ${fresh[1].age}, neither stale; ${(4.2).toFixed(1)} s later: both stale (${aged[0].age}, ${aged[1].age}); a page opened later: both stale (${reopened[0].age}, ${reopened[1].age})` };
      } finally {
        for (const pg of pages) await pg.close();
        await p.close();
      }
    }, {}, [
      { name: 'a page that never marks a value stale', impl: neverStale },
      { name: 'a page that computes age from when it received a value, not from the change\'s time', impl: ageFromReceipt },
    ]);

    const lags = { webEdits: { 'live-data-page.mjs': [['  const state = game ? reaction(game, value) : "unknown";', '  const state = game ? reaction(game, last === undefined ? value : last) : "unknown";']] } };
    await run('L4', 'after each weather change, the game layer\'s next update carries the new value and the pond shows the state the game layer\'s rule gives for it (frozen below 0 °C), in that same update; a screenshot is taken after each change', async (impl) => {
      const b = await ensure();
      const p = await lab.place(ports, impl);
      const shots = [];
      const real = !impl.webEdits;
      let page = null;
      try {
        if (real) { fs.rmSync(SCREENS, { recursive: true, force: true }); fs.mkdirSync(SCREENS, { recursive: true }); }
        page = await open(b, p.pageUrl);
        const game = (await p.G.node(1, p.gameNode)).json.properties;
        // The page's first game update (the starting value) must be in before the series starts, or a late one counts as a change.
        await lab.until(() => page.evaluate(() => window.__liveData.history.some((h) => h.layer === 'game')), 5000, 'the page\'s first game update');
        const startAt = await page.evaluate(() => window.__liveData.history.length);
        const shoot = async (name) => { if (real) { const file = path.join(SCREENS, name); await page.screenshot({ path: file }); shots.push(path.relative(ROOT, file)); } };
        await shoot('00-start-5C-' + (await page.evaluate(() => document.getElementById('pond-state').dataset.state)) + '.png');
        const source = p.startWeather({ values: SERIES, interval_ms: 1200 });
        const seen = [];
        for (let i = 0; i < SERIES.length; i += 1) {
          await lab.until(() => source.log.length > i, 5000, 'weather change ' + (i + 1));
          const want = SERIES[i];
          await lab.until(async () => (await readCards(page))[1].value === JSON.stringify(want), 3000, 'the game layer to carry ' + want).catch(() => null);
          const state = await page.evaluate(() => document.getElementById('pond-state').dataset.state);
          seen.push({ value: want, state, expected: p.layers.reaction(game, want) });
          await shoot(String(i + 1).padStart(2, '0') + '-' + String(want).replace('-', 'minus') + 'C-' + state + '.png');
        }
        await source.done;
        await lab.sleep(500);
        const history = await page.evaluate((from) => window.__liveData.history.slice(from), startAt);
        const failures = [];
        const updates = [];
        for (const h of history) if (h.layer === 'game' && !updates.some((u) => u.revision === h.revision)) updates.push(h);
        const values = updates.map((u) => u.value);
        if (JSON.stringify(values) !== JSON.stringify(SERIES)) failures.push(`the game layer's updates carry ${JSON.stringify(values)}, the weather changed through ${JSON.stringify(SERIES)}`);
        for (const u of history.filter((h) => h.layer === 'game')) {
          const want = p.layers.reaction(game, u.value);
          if (u.state !== want) failures.push(`revision ${u.revision}: value ${u.value} shown as ${u.state}, the rule gives ${want}`);
        }
        for (const s of seen) if (s.state !== s.expected) failures.push(`after ${s.value} °C the pond shows ${s.state}`);
        const states = new Set(seen.map((s) => s.expected));
        if (states.size < 2) failures.push('the series never crosses the threshold');
        return { ok: failures.length === 0, detail: failures.length ? failures.slice(0, 4).join('; ') : `${SERIES.length} weather changes, ${updates.length} game updates, each carrying its value and the pond's state in the same update (${seen.map((s) => s.value + '→' + s.state).join(', ')}); ${shots.length} screenshots in ${path.relative(ROOT, SCREENS)}` };
      } finally {
        if (page) await page.close();
        await p.close();
      }
    }, {}, [{ name: 'a page whose pond follows the game layer one update late', impl: lags }]);
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { browserChecks };
