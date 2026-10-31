'use strict';

/*
 * Iteration 4, rendering in a browser.
 *
 *   R1  the `?wow=` player of world A draws each portal at the node that places it: the bounded preview of
 *       B with B's own portal closed, C's preview image, D's plain colour, an offline destination and a
 *       portal with no destination. Crossing the offline portal and the one with no destination is refused
 *       on the page. Crossing to B, by a mouse click on its ring, navigates there, and the page's camera
 *       arrives at node n's pose: its position within 1 cm of a plain double-precision reference, at eye
 *       height.
 *
 * It runs in Chrome (found by tools/find-browser.mjs) with the lab's own frontend. It always runs; machine
 * load never defers it.
 */

const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, run } = require('../arch-i1/lib');
const lab = require('./lab');

const { w } = lab;
const EYE_HEIGHT = 1.6;

async function browserChecks(ports) {
  const everyNode = { serverEdits: { portalStandard: [['                if (distance > d.radius_m) continue;\n', '']] } };
  const portalsWithoutNode = { serverEdits: { portalStandard: [['                ...(store ? { node : nodeRef(store, added.node_id) } : {}),\n', '']] } };
  let browser = null;
  try {
    await run('R1', 'in a browser, the ?wow= player draws each portal at its node with what its destination allows (a bounded preview with a closed portal inside, an image, a plain colour, offline, no destination); refused crossings stay on the page; crossing to B navigates there and the camera arrives at node n within 1 cm', async (impl) => {
      if (!browser) {
        const { findBrowser } = await import(pathToFileURL(path.join(ROOT, 'tools', 'find-browser.mjs')).href);
        const chrome = findBrowser();
        if (!chrome) return { ok: false, detail: 'no Chrome found: set PUPPETEER_EXECUTABLE_PATH to run R1' };
        const puppeteer = require(require.resolve('puppeteer-core', { paths: [ROOT] }));
        browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1280, height: 800 } });
      }
      const frontendPort = ports.next();
      // The page needs only the lab's static files and these worlds; it must never reach the demo's backends.
      const frontend = await require(path.join(ROOT, 'src', 'serve.js')).createFrontendServer(frontendPort, { backendPorts: { a: 1, b: 1, lobby: 1, airport: 1 } });
      const FRONT = 'http://127.0.0.1:' + frontendPort;
      const edits = { edits: impl.serverEdits };
      const B = await w.world('b', ports.next(), Object.assign({ base: '/w/b' }, edits));
      const C = await w.world('b', ports.next(), Object.assign({ base: '/w/c' }, edits));
      const D = await w.world('b', ports.next(), Object.assign({ base: '/w/d' }, edits));
      const A = await w.world('a', ports.next(), edits);
      const player = (world, join) => `${FRONT}/index.html?role=source&intro=bypass&wow=${encodeURIComponent(world.spatialUrl(1))}${join == null ? '' : `#join=node.${join}`}`;
      const page = await browser.newPage();
      try {
        const [hall] = await B.add(1, await B.rootOf(1), [{ label: 'hall', localTransform: lab.placed(30, 0, 10, 70) }]);
        const [n] = await B.add(1, hall, [{ label: 'arrival n', localTransform: lab.placed(2, 0, 1, 180) }]);
        const [, , innerPortal] = await B.add(1, n, [
          { label: 'near', localTransform: lab.placed(3, 0, 0) },
          { label: 'far', localTransform: lab.placed(0, 0, 30) },
          { label: 'B portal', localTransform: lab.placed(0, 0, 4) },
        ]);
        B.server.built.runtime.addPortal({ node_id: innerPortal, destination: player(D), label: 'B onward' });
        B.server.built.runtime.setPreview({ node_id: n, radius_m: 10 });
        C.server.built.runtime.setPreview({ image: `${FRONT}/assets/hud/storefront-frontier-news--profile.jpg` });
        const nodes = await A.add(1, await A.rootOf(1), [-6, -3, 0, 3, 6].map((x, i) => ({ label: `portal ${i + 1}`, localTransform: lab.placed(x, 0, 0) })));
        const rt = A.server.built.runtime;
        const ids = [
          rt.addPortal({ node_id: nodes[0], destination: player(B, n), label: 'To B' }).id,
          rt.addPortal({ node_id: nodes[1], destination: player(C), label: 'To C' }).id,
          rt.addPortal({ node_id: nodes[2], destination: player(D), label: 'To D' }).id,
          rt.addPortal({ node_id: nodes[3], destination: `${FRONT}/index.html?role=source&intro=bypass&wow=${encodeURIComponent('http://127.0.0.1:1/wow/spatial/1')}`, label: 'Offline' }).id,
          rt.addPortal({ node_id: nodes[4], label: 'Nowhere' }).id,
        ];
        const expectedPreview = (await lab.withinRadius(B, 1, n, 10)).length;
        const failures = [];
        await page.goto(player(A), { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction(() => document.body.dataset.wowPortalsReady, { timeout: 180000 });
        await page.waitForFunction(() => (window.__wowPortals.summary() || []).every((p) => p.preview && (p.preview.kind !== 'image' || p.preview.image_loaded || p.preview.image_error)), { timeout: 60000 }).catch(() => {});
        const summary = await page.evaluate(() => (window.__wowPortals && window.__wowPortals.summary ? window.__wowPortals.summary() : []));
        const byId = new Map(summary.map((p) => [p.id, p]));
        const kind = (id) => byId.get(id) && byId.get(id).preview;
        // A is a lab world: its two demo portals are drawn too, beside the five made here.
        const drawn = ids.filter((id) => byId.has(id)).length;
        if (drawn !== 5) failures.push(`${drawn} of the 5 portals drawn (${summary.length} in all)`);
        const toB = kind(ids[0]) || {};
        if (toB.kind !== 'nodes' || toB.nodes !== expectedPreview || toB.closed !== 1) failures.push('to B: ' + JSON.stringify(toB) + ` (expected ${expectedPreview} nodes, 1 closed)`);
        if ((kind(ids[1]) || {}).kind !== 'image' || !(kind(ids[1]) || {}).image_loaded) failures.push('to C: ' + JSON.stringify(kind(ids[1])));
        if ((kind(ids[2]) || {}).kind !== 'color') failures.push('to D: ' + JSON.stringify(kind(ids[2])));
        if ((kind(ids[3]) || {}).kind !== 'unreachable') failures.push('offline: ' + JSON.stringify(kind(ids[3])));
        if ((kind(ids[4]) || {}).kind !== 'none') failures.push('nowhere: ' + JSON.stringify(kind(ids[4])));
        const refusals = await page.evaluate(async (offline, nowhere) => [await window.__wowPortals.cross(offline), await window.__wowPortals.cross(nowhere)], ids[3], ids[4]);
        if (refusals.some((r) => r.crossed) || !/offline/.test(refusals[0].reason || '') || !/no destination/.test(refusals[1].reason || '')) failures.push('refusals: ' + JSON.stringify(refusals));
        await page.screenshot({ path: path.join(ROOT, 'diagnostics', 'arch-i4-r1-host.png') }).catch(() => {});
        if (!byId.has(ids[0])) return { ok: false, detail: failures.concat(['the portal to B is not drawn, so it cannot be crossed']).join('; ') };
        // Cross as a person does: a mouse click on the portal where it is drawn on the page.
        const point = await page.evaluate((id) => window.__wowPortals.screenPoint(id), ids[0]);
        if (!point) return { ok: false, detail: failures.concat(['the portal to B is not in view, so it cannot be clicked']).join('; ') };
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
          page.mouse.click(point.x, point.y),
        ]);
        await page.waitForFunction(() => document.body.dataset.wowArrival, { timeout: 180000 });
        const arrival = await page.evaluate(() => ({ url: location.href, arrival: window.__wowArrival }));
        const ref = lab.reference({ chains: { n: await lab.chainOf(B, 1, n) } }).positions.n;
        const at = arrival.arrival && arrival.arrival.position;
        const cam = arrival.arrival && arrival.arrival.camera;
        const off = at ? lab.distance(at, ref) : Infinity;
        const camOff = cam ? lab.distance(cam, [ref[0], ref[1] + EYE_HEIGHT, ref[2]]) : Infinity;
        if (!arrival.url.includes(encodeURIComponent(B.spatialUrl(1))) || !arrival.url.endsWith('#join=node.' + n)) failures.push('navigated to ' + arrival.url);
        if (!(off <= 0.01) || !(camOff <= 0.01)) failures.push(`arrived at ${JSON.stringify(at)}, camera ${JSON.stringify(cam)}; the reference is ${JSON.stringify(ref)}`);
        await page.screenshot({ path: path.join(ROOT, 'diagnostics', 'arch-i4-r1-arrival.png') }).catch(() => {});
        return { ok: failures.length === 0, detail: (failures.length ? failures.join('; ') : `the 5 portals drawn (B: ${toB.nodes} preview nodes, 1 closed; C: image; D: colour; offline; nowhere), with A's 2 demo portals; both refusals stayed on the page; arrived at node ${n}, ${(off * 1000).toFixed(3)} mm from the reference, camera at eye height (${(camOff * 1000).toFixed(3)} mm)`) };
      } finally {
        await page.close();
        await new Promise((resolve) => frontend.close(resolve));
        await A.close();
        await B.close();
        await C.close();
        await D.close();
      }
    }, {}, [
      { name: 'a B whose preview URL returns every node', impl: everyNode },
      { name: 'a world whose portals name no node', impl: portalsWithoutNode },
    ]);
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { browserChecks };
