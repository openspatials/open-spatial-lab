'use strict';

/*
 * Iteration 2, the browser's cross-origin rules.
 *
 *   I11  a page served from world A's origin reads world B's Spatial, reads its ETag, and gets 304 on a
 *        repeat with If-None-Match. B allows the read with Access-Control-Allow-Origin and exposes ETag,
 *        which a page could not read otherwise; the conditional repeat needs a preflight B answers.
 *
 * It runs in Chrome (found by tools/find-browser.mjs). It always runs; machine load never defers it.
 */

const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, run } = require('../arch-i1/lib');
const w = require('./worlds');

async function browserChecks(ports) {
  const noCors = { serverEdits: { server: [["const CORS_POLICY = cfg.cors_allowed_origins === undefined ? '*' : cfg.cors_allowed_origins;", 'const CORS_POLICY = [];']] } };
  let browser = null;
  try {
    await run('I11', 'a page served from A\'s origin reads B\'s Spatial across origins, reads its ETag, and gets 304 on a repeat', async (impl) => {
      if (!browser) {
        const { findBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools', 'find-browser.mjs')).href);
        const chrome = findBrowser();
        if (!chrome) return { ok: false, detail: 'no Chrome found: set PUPPETEER_EXECUTABLE_PATH to run I11' };
        const puppeteer = require(require.resolve('puppeteer-core', { paths: [ROOT] }));
        browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });
      }
      const B = await w.world('b', ports.next(), { base: '/w/b', edits: impl.serverEdits });
      const A = await w.world('a', ports.next());
      const page = await browser.newPage();
      try {
        // Any page of A's origin will do: the read below is a script on that origin.
        await page.goto('http://127.0.0.1:' + A.port + '/healthz', { waitUntil: 'domcontentloaded' });
        const result = await page.evaluate(async (url) => {
          try {
            const first = await fetch(url, { headers: { Accept: 'application/wow+json' }, cache: 'no-store' });
            const etag = first.headers.get('ETag');
            const type = first.headers.get('Content-Type');
            await first.text();
            const again = await fetch(url, { headers: { Accept: 'application/wow+json', 'If-None-Match': etag || '' }, cache: 'no-store' });
            return { origin: location.origin, first: first.status, etag, type, again: again.status };
          } catch (error) {
            return { origin: location.origin, error: String(error) };
          }
        }, B.spatialUrl(1));
        const ok = !result.error && result.first === 200 && !!result.etag && result.again === 304 && result.type === w.WOW;
        return {
          ok,
          detail: result.error
            ? `from ${result.origin}: the read failed (${result.error})`
            : `from ${result.origin}: ${result.first} ${result.type}, ETag ${result.etag ? 'readable' : 'NOT readable'}, repeat ${result.again}`,
        };
      } finally {
        await page.close();
        await A.close();
        await B.close();
      }
    }, {}, [{ name: 'a B without cross-origin headers', impl: noCors }]);
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { browserChecks };
