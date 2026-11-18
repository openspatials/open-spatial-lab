'use strict';

/*
 * A local demo of three visible changes: player arrival, pilot labels and follow, from a BUILT site
 * package, in one process.
 *
 *   node tools/arch-i5/owner-demo.js [--port <start-page port>] [--tree <built app dir>] [--pid-file <file>] [--out <json>]
 *
 * Ports, from --port P (default 34700):
 *   P      the start page (/), and the built app tree as the site serves it (static files under
 *          /projects/open-spatial-lab/app/, as release-check/x3d-world-x3dom.mjs serves it)
 *   P+1    the world servers' origin (src/serve.js): /worlds.json, /api/{key}/..., the streams. The tree must be
 *          built with --server-origin http://127.0.0.1:P+1; the process refuses to start otherwise.
 *   P+2-5  the four worlds of worlds.json (a, b, lobby, airport), as mainDemoLab in checks-session.js builds them
 *   P+6    the arrival world: a world that states a handshake, with one node away from its spawn (as SE6 builds it)
 *
 * The start page has three numbered links (player arrival; pilot label, 2a then 2b; follow). /follow sends the visitor
 * to the main demo at #follow=user.{id}, where {id} is the User of the earliest present user of world A (the page
 * opened at link 2a). /status.json says what the process serves. Placement writes are on only while the worlds are
 * built, as link-worlds.js does. The process writes its pid file, prints the start-page address and runs until stopped
 * (SIGTERM or SIGINT), and removes the pid file when it stops.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { ROOT, makeTempDir, httpReq } = require('../arch-i1/lib');
const lab = require('./lab');

const APP_BASE = '/projects/open-spatial-lab/app';
// The built app tree: --tree, or OSL_DEMO_TREE.
const DEFAULT_TREE = process.env.OSL_DEMO_TREE || null;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.vrm': 'model/gltf-binary', '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.x3d': 'model/x3d+xml', '.map': 'application/json',
};

function readArgs(argv) {
  const out = { port: 34700, tree: DEFAULT_TREE, 'pid-file': null, out: null };
  for (let i = 0; i < argv.length; i += 2) {
    const key = String(argv[i]).replace(/^--/, '');
    if (!(key in out) || argv[i + 1] === undefined) throw new Error('usage: owner-demo.js [--port <n>] [--tree <built app dir>] [--pid-file <file>] [--out <json>]');
    out[key] = argv[i + 1];
  }
  out.port = Number(out.port);
  if (!out.tree) throw new Error('give the built app tree: --tree <dir> or OSL_DEMO_TREE');
  out.tree = path.resolve(out.tree);
  out['pid-file'] = path.resolve(out['pid-file'] || path.join(path.dirname(out.tree), 'owner-demo.pid'));
  return out;
}

/** The static app tree under APP_BASE, a directory answered by its index.html. */
function serveTree(tree, pathname, res) {
  let file = path.resolve(tree, '.' + pathname.slice(APP_BASE.length));
  if (file !== tree && !file.startsWith(tree + path.sep)) { res.writeHead(400); res.end('bad path'); return; }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (e, data) => {
      if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function startPage(links) {
  const item = (n, title, href, text) => `  <li><b>${n}. ${title}:</b> <a id="link-${n}" href="${escapeHtml(href)}" target="_blank">${escapeHtml(text)}</a></li>\n`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visible changes demo</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}
li{margin:.6rem 0}code{font-size:.9em}p.note{color:#555}</style></head>
<body>
<h1>Three visible changes</h1>
<p>Each link opens a new tab of the built site package. Allow about 20 seconds for a world to load.</p>
<ol style="list-style:none;padding:0">
${item('1', 'Player arrival', links.arrival, 'open the player at #join=node.' + links.arrivalNode + '; your avatar stands at that node, beside the duck, not at the world spawn')}${item('2a', 'Pilot label', links.main, 'open the main demo in Location A (first page)')}${item('2b', 'Pilot label', links.main, 'open it again in a second tab; the first page\'s avatar is labelled "(pilot not stated)"')}${item('3', 'Follow', '/follow', 'open a page at #follow=user.{id} of the first page\'s user; it arrives at that user, and stays with it when you walk with WASD in the first page')}</ol>
<p class="note">Link 3 follows the earliest present user of Location A, which is the page from link 2a while it stays open.</p>
</body></html>
`;
}

async function main() {
  const args = readArgs(process.argv.slice(2));
  const P = args.port;
  if (!Number.isInteger(P) || P < 1024 || P > 65000) throw new Error('--port must be a port number, got ' + args.port);
  const ports = { start: P, server: P + 1, a: P + 2, b: P + 3, lobby: P + 4, airport: P + 5, arrival: P + 6 };
  const SERVER = 'http://127.0.0.1:' + ports.server;
  const START = 'http://127.0.0.1:' + ports.start;
  const APP = START + APP_BASE;

  // The tree must talk to the world servers this process starts.
  const config = fs.readFileSync(path.join(args.tree, 'osl-app-config.js'), 'utf8');
  if (!config.includes(`window.__OSL_SERVER_ORIGIN__ = ${JSON.stringify(SERVER)};`)) throw new Error(`${args.tree} was not built with --server-origin ${SERVER}`);
  if (!config.includes(`window.__OSL_BASE_PATH__ = ${JSON.stringify(APP_BASE)};`)) throw new Error(`${args.tree} was not built with --base ${APP_BASE}`);

  const { startBackends, assertNotLiveDemoPorts } = require(path.join(ROOT, 'src', 'orchestrator.js'));
  assertNotLiveDemoPorts(ports);
  const backendPorts = { a: ports.a, b: ports.b, lobby: ports.lobby, airport: ports.airport };

  // Building the worlds writes nodes: those writes are opt-in (runtime/world-server/src/local-only.js), so they are
  // turned on only while the worlds are built, and put back as they were.
  const savedWrites = process.env.OSL_PLACEMENT_WRITES;
  const savedDir = process.env.OSL_WOW_SPATIAL_DIR;
  process.env.OSL_PLACEMENT_WRITES = '1';
  let backends, frontend, arrivalWorld, arrivalNode;
  try {
    process.env.OSL_WOW_SPATIAL_DIR = makeTempDir('owner-demo');
    backends = await startBackends({ backendPorts });
    if (savedDir === undefined) delete process.env.OSL_WOW_SPATIAL_DIR; else process.env.OSL_WOW_SPATIAL_DIR = savedDir;
    frontend = await require(path.join(ROOT, 'src', 'serve.js')).createFrontendServer(ports.server, { backendPorts });
    arrivalWorld = await lab.handshakeWorld('a', ports.arrival, { label: 'Arrival world', claims: lab.A_CLAIMS });
    [arrivalNode] = await arrivalWorld.add(1, await arrivalWorld.rootOf(1), [{ label: 'demo arrival', localTransform: lab.placed(-3, 0, 1.5, 90) }]);
    await arrivalWorld.add(1, arrivalNode, [{ label: 'duck', localTransform: lab.placed(0, 0, 1.2, 0, 0.6), spatialAssetURI: APP + '/assets/worlds/Duck.glb' }]);
  } finally {
    if (savedWrites === undefined) delete process.env.OSL_PLACEMENT_WRITES; else process.env.OSL_PLACEMENT_WRITES = savedWrites;
    if (savedDir === undefined) delete process.env.OSL_WOW_SPATIAL_DIR; else process.env.OSL_WOW_SPATIAL_DIR = savedDir;
  }

  const links = {
    arrivalNode,
    arrival: `${APP}/index.html?role=player&intro=bypass&avatar_variant=${lab.DEFAULT_VARIANT}&wow=${encodeURIComponent(arrivalWorld.spatialUrl(1))}#join=node.${arrivalNode}`,
    main: `${APP}/index.html?role=player&active=a&intro=bypass`,
    follow: (userId) => `${APP}/index.html?role=player&active=a&intro=bypass#follow=user.${userId}`,
  };

  /** The User of the earliest present user of world A (by registration time), or null. */
  async function firstPresentUser() {
    const r = await httpReq('GET', ports.a, '/fabric/presence', null);
    const avatars = ((r.json && r.json.occupancy && r.json.occupancy.avatars) || []).slice()
      .sort((x, y) => String(x.registered_at).localeCompare(String(y.registered_at)));
    if (!avatars.length) return null;
    const user = (await httpReq('GET', ports.a, '/wow/user/' + encodeURIComponent(avatars[0].player_id), null, { Accept: lab.WOW })).json;
    return user && user.id != null ? { id: user.id, player_id: avatars[0].player_id } : null;
  }

  const page = startPage(links);
  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { res.writeHead(400); res.end('bad path'); return; }
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page);
    } else if (pathname === '/follow') {
      firstPresentUser().then((user) => {
        if (!user) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end('<!doctype html><meta charset="utf-8"><title>Follow</title><p>No one is present in Location A yet. Open link 2a first, wait until its world has loaded, then open link 3 again.</p><p><a href="/">Back to the start page</a></p>');
          return;
        }
        res.writeHead(302, { Location: links.follow(user.id), 'Cache-Control': 'no-store' });
        res.end();
      }).catch((error) => { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('world A did not answer: ' + error.message); });
    } else if (pathname === '/status.json') {
      firstPresentUser().catch(() => null).then((user) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ports, server_origin: SERVER, arrival_world: arrivalWorld.base, arrival_node: arrivalNode, links: { arrival: links.arrival, main: links.main, follow: '/follow' }, follow_target: user, pid: process.pid }, null, 2));
      });
    } else if (pathname.startsWith(APP_BASE + '/')) {
      serveTree(args.tree, pathname, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 not found');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(ports.start, '127.0.0.1', resolve); });

  fs.writeFileSync(args['pid-file'], process.pid + '\n');
  const info = {
    start_page: START + '/',
    ports,
    server_origin: SERVER,
    arrival_world: arrivalWorld.base,
    arrival_node: arrivalNode,
    links: { arrival: links.arrival, main: links.main, follow: START + '/follow' },
    tree: args.tree,
    pid: process.pid,
    pid_file: args['pid-file'],
    started_at: new Date().toISOString(),
  };
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(info, null, 2) + '\n');
  process.stdout.write('ready ' + JSON.stringify(info) + '\n');
  process.stdout.write('Open the start page: ' + START + '/\n');

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { if (fs.readFileSync(args['pid-file'], 'utf8').trim() === String(process.pid)) fs.unlinkSync(args['pid-file']); } catch (e) { /* gone */ }
    // Open browser connections would keep the servers from closing: drop them, and leave after 5 s whatever is left.
    setTimeout(() => process.exit(0), 5000).unref();
    for (const s of [server, frontend]) if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
    await Promise.allSettled([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => frontend.close(resolve)),
      arrivalWorld.close(),
      backends.stop(),
    ]);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((error) => { process.stderr.write((error && error.stack) || String(error)); process.stderr.write('\n'); process.exit(1); });
