'use strict';

/*
 * Helpers for the A2 proof and the demo: one place with two layers, behind one local address.
 *
 *   {origin}/                      the page (web/live-data-layers.html)
 *   {origin}/w/weather/...         the weather layer's world, with its stand-in source
 *   {origin}/w/game/...            the game layer's world, whose server mirrors the weather value
 *
 * The two worlds are real lab world servers on their own loopback ports, booted with those path
 * prefixes; the host forwards requests and event streams to them, so a browser sees one origin.
 * Planted faults: serverEdits (the game world's server), layerEdits (web/live-data-layers.mjs as the
 * proof uses it to build the layers) and webEdits ({ file: edits } for the page's files).
 */

const fs = require('fs');
const net = require('net');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, makeTempDir, staleEdit, loadEsmMutant, httpReq } = require('../arch-i1/lib');
const w = require('../arch-i2/worlds');
const { startWeather } = require('../../runtime/world-server/src/live-data-weather');

const WEB_FILES = ['live-data-layers.html', 'live-data-page.mjs', 'live-data-layers.mjs', 'wow-observe.mjs'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting for ' + (what || 'a condition'));
    await sleep(25);
  }
}

/** The folder the page is served from: web/ itself, or a copy with exact string edits. */
function webDir(webEdits) {
  if (!webEdits || !Object.keys(webEdits).length) return path.join(ROOT, 'web');
  const dir = makeTempDir('a2-web');
  for (const name of WEB_FILES) {
    let source = fs.readFileSync(path.join(ROOT, 'web', name), 'utf8');
    for (const [from, to] of webEdits[name] || []) {
      const count = source.split(from).length - 1;
      if (count !== 1) throw staleEdit('web/' + name, from, count);
      source = source.replace(from, () => to);
    }
    fs.writeFileSync(path.join(dir, name), source);
  }
  return dir;
}

/** The layers module, real or with exact string edits. */
async function layersModule(layerEdits) {
  if (!layerEdits || !layerEdits.length) return import(pathToFileURL(path.join(ROOT, 'web', 'live-data-layers.mjs')).href);
  return loadEsmMutant('web/live-data-layers.mjs', layerEdits, []);
}

/**
 * One local address: the page's files, and each world under its path prefix, event streams included.
 * routes: { '/w/weather/': port, ... }.
 */
async function startHost(port, routes, dir, bind) {
  const routeOf = (url) => Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
  const server = http.createServer((req, res) => {
    const route = routeOf(req.url);
    if (route) {
      const upstream = http.request({ host: '127.0.0.1', port: route[1], path: req.url, method: req.method, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
      return;
    }
    let name = new URL(req.url, 'http://x').pathname.replace(/^\//, '');
    if (name === '') name = 'live-data-layers.html';
    if (!WEB_FILES.includes(name)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)], 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(dir, name)).pipe(res);
  });
  server.on('upgrade', (req, socket, head) => {
    const route = routeOf(req.url);
    if (!route) { socket.destroy(); return; }
    const upstream = net.connect(route[1], '127.0.0.1', () => {
      let text = req.method + ' ' + req.url + ' HTTP/1.1\r\n';
      for (let i = 0; i < req.rawHeaders.length; i += 2) text += req.rawHeaders[i] + ': ' + req.rawHeaders[i + 1] + '\r\n';
      upstream.write(text + '\r\n');
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const end = () => { socket.destroy(); upstream.destroy(); };
    upstream.on('error', end);
    socket.on('error', end);
    socket.on('close', end);
    upstream.on('close', end);
  });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind || '127.0.0.1', resolve); });
  return {
    port,
    origin: 'http://127.0.0.1:' + port,
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

/**
 * One place with its two layers. ports: { next() }. opts: { serverEdits, layerEdits, webEdits,
 * initial (°C), staleAfterSeconds, threshold }. Returns the worlds, the host, both data points, the
 * page URL, and startWeather(spec) for the weather layer's stand-in source.
 */
async function place(ports, opts) {
  opts = opts || {};
  const hostPort = ports.next();
  const W = await w.world('b', ports.next(), { base: '/w/weather' });
  const G = await w.world('a', ports.next(), { base: '/w/game', edits: opts.serverEdits });
  let host = null;
  try {
    host = await startHost(hostPort, { '/w/weather/': W.port, '/w/game/': G.port }, webDir(opts.webEdits));
    const origin = host.origin;
    const layers = await layersModule(opts.layerEdits);
    const initial = opts.initial === undefined ? 5 : opts.initial;
    const stale = opts.staleAfterSeconds || 3;
    const weatherProps = layers.weatherLayerProperties({ contextUrl: origin + '/w/weather/wow/context.jsonld', temperature: initial, staleAfterSeconds: stale });
    const [wn] = await W.add(1, await W.rootOf(1), [{ label: 'weather station', localTransform: w.IDENTITY, properties: weatherProps }]);
    const weatherPoint = origin + '/w/weather/wow/spatial/1/node/' + wn + '#/properties/temperature';
    const gameProps = layers.gameLayerProperties({ contextUrl: origin + '/w/game/wow/context.jsonld', weatherPoint, temperature: initial, threshold: opts.threshold || 0, staleAfterSeconds: stale });
    const [gn] = await G.add(1, await G.rootOf(1), [{ label: 'pond', localTransform: w.IDENTITY, properties: gameProps }]);
    const gamePoint = origin + '/w/game/wow/spatial/1/node/' + gn + '#/properties/temperature';
    const pageUrl = origin + '/?weather=' + encodeURIComponent(weatherPoint) + '&game=' + encodeURIComponent(gamePoint);
    return {
      W, G, host, origin, layers,
      weatherNode: wn, gameNode: gn, weatherPoint, gamePoint, pageUrl,
      startWeather: (spec) => startWeather(W.server.built.runtime, Object.assign({ node_id: wn }, spec || {})),
      async close() {
        await host.close();
        await G.close();
        await W.close();
      },
    };
  } catch (error) {
    if (host) await host.close();
    await G.close();
    await W.close();
    throw error;
  }
}

async function worldDoc(world) {
  return (await httpReq('GET', world.port, world.prefix + '/wow/world', null, { Accept: w.WOW })).json;
}

/** Count the requests a world server receives. */
function requestLog(world) {
  const log = [];
  const listener = (req) => log.push({ method: req.method, url: req.url });
  world.server.built.server.on('request', listener);
  return { log, stop: () => world.server.built.server.off('request', listener) };
}

module.exports = { w, sleep, until, place, startHost, webDir, layersModule, worldDoc, requestLog, httpReq, WEB_FILES };
