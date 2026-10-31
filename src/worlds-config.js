'use strict';

/*
* The lab's worlds, from one configuration file (worlds.json at the repository root, or the file named by
* OSL_WORLDS). The launch script, the world-server orchestrator, the frontend server (src/serve.js), the
* check (tools/check-worlds.mjs) and the browser client (GET /worlds.json on the frontend) all read it, so
* adding a world is an edit to this file and a restart: no code change. See ADD-A-WORLD-CHECKLIST.md.
*
* A world entry:
*   key       short name used in frontend routes (/w/{key}/, /api/{key}/): lowercase letters, digits, '-'
*   name      what a person reads
*   port      the port its world server listens on (127.0.0.1)
*   address   its base URL, where clients and portals reach it; its port must be `port`
*   anchor    where its graph 1 sits on Earth: { lat, lon, h }
*   template  optional: a built-in world (a, b, lobby, airport) whose configuration it runs. Without one, the
*             world is a plain room with no configured portals (portals to and from it are placed with the
*             placement tool).
*   room      optional: the room colour (a plain room, or a, b, lobby)
*   preview_radius_m  optional: what a portal into this world shows, in meters around its room view
*
* For the commands that predate this file, OSL_FRONTEND_PORT and OSL_BACKEND_{A,B,LOBBY,AIRPORT}_PORT
* (or BACKEND_{A,B,LOBBY,AIRPORT}_PORT) still override the port of those four worlds and the frontend; the
* address follows the port.
*
* Command line (used by the launch and stop scripts):
*   node src/worlds-config.js frontend-port   the frontend port
*   node src/worlds-config.js world-ports     every world's port, space separated
*   node src/worlds-config.js file            the configuration file in use
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_FILE = path.join(ROOT, 'worlds.json');
const TEMPLATES = Object.freeze([ 'a', 'b', 'lobby', 'airport' ]);
const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

function configFile(env = process.env) {
  return env.OSL_WORLDS ? path.resolve(env.OSL_WORLDS) : DEFAULT_FILE;
}

function envPort(env, key) {
  const name = key.toUpperCase();
  return Number(env['OSL_BACKEND_' + name + '_PORT']) || Number(env['BACKEND_' + name + '_PORT']) || null;
}

function withPort(address, port) {
  try {
    const u = new URL(address);
    u.port = String(port);
    return u.href;
  } catch (e) {
    return address;
  }
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
* `x3d_portals`: portals that exist only on the X3D paths (`?renderer=x3dom`, `?renderer=x_ite`). Each stands in the
* listed world `world`, at `position` on its floor, and opens the X3D JSON world `x3d_world` from web/x3d-worlds/.
* No world server knows it, and the three.js path does not show it.
*/
function readX3dPortals(raw, worldKeys, problems) {
  const out = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const id = String((entry && entry.portal_id) || '');
    const label = 'x3d portal "' + id + '"';
    if (!id) problems.push('an x3d portal has no portal_id');
    if (!worldKeys.has(String(entry && entry.world))) problems.push(label + ': world "' + (entry && entry.world) + '" is not listed');
    if (!/^[A-Za-z0-9._-]+\.json$/.test(String(entry && entry.x3d_world))) problems.push(label + ': x3d_world must be a file name in web/x3d-worlds/');
    const position = entry && entry.position;
    if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) problems.push(label + ': position needs x, y and z numbers');
    const color = String((entry && entry.color) || '');
    if (!HEX_COLOR.test(color)) problems.push(label + ': color must be #rrggbb');
    const radius = Number(entry && entry.radius_m);
    if (!(radius > 0)) problems.push(label + ': radius_m must be a positive number');
    out.push({ portal_id: id, label: String((entry && entry.label) || id), world: String(entry && entry.world), x3d_world: String(entry && entry.x3d_world), position, radius_m: radius, color });
  }
  return out;
}

/**
* Read and check the configuration. Returns { file, frontend: { port }, worlds: [...], problems: [...] }.
* Each problem is a sentence that names the world. With `strict`, any problem throws.
*/
function loadWorlds(opts = {}) {
  const env = opts.env || process.env;
  const file = opts.file ? path.resolve(opts.file) : configFile(env);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = [];
  const frontendPort = Number(env.OSL_FRONTEND_PORT) || Number(doc.frontend && doc.frontend.port) || 8143;
  const worlds = [];
  const seenKeys = new Set();
  const seenPorts = new Map();
  for (const [ index, raw ] of (Array.isArray(doc.worlds) ? doc.worlds : []).entries()) {
    const entry = raw && typeof raw === 'object' ? raw : {};
    const key = String(entry.key || '');
    const name = String(entry.name || key || 'world ' + (index + 1));
    const label = name + (key ? ' (' + key + ')' : '');
    if (!KEY_PATTERN.test(key)) problems.push(label + ': key "' + key + '" must be lowercase letters, digits or "-"');
    else if (seenKeys.has(key)) problems.push(label + ': key "' + key + '" is listed twice');
    seenKeys.add(key);
    const port = (TEMPLATES.includes(key) && envPort(env, key)) || Number(entry.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(label + ': port "' + entry.port + '" is not a port number');
    else if (port === frontendPort) problems.push(label + ': port ' + port + ' is the frontend port');
    else if (seenPorts.has(port)) problems.push(label + ': port ' + port + ' is also the port of ' + seenPorts.get(port));
    seenPorts.set(port, label);
    let address = typeof entry.address === 'string' ? entry.address : '';
    if (address && TEMPLATES.includes(key) && envPort(env, key)) address = withPort(address, port);
    let addressPort = null;
    try {
      const u = new URL(address);
      addressPort = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
      if (!/^https?:$/.test(u.protocol)) problems.push(label + ': address ' + address + ' is not an http(s) URL');
    } catch (e) {
      problems.push(label + ': address "' + address + '" is not a URL');
    }
    if (addressPort !== null && addressPort !== port) problems.push(label + ': address ' + address + ' names port ' + addressPort + ', but its port is ' + port);
    if (address && !address.endsWith('/')) address += '/';
    const anchor = entry.anchor || {};
    if (![ anchor.lat, anchor.lon, anchor.h ].every(v => Number.isFinite(Number(v))))
      problems.push(label + ': anchor needs lat, lon and h numbers');
    const template = entry.template != null ? String(entry.template) : (TEMPLATES.includes(key) ? key : null);
    if (template !== null && !TEMPLATES.includes(template)) problems.push(label + ': template "' + template + '" is not one of ' + TEMPLATES.join(', '));
    const ring = entry.portal_ring === undefined || entry.portal_ring === null ? null : entry.portal_ring;
    if (ring && !(HEX_COLOR.test(ring.color) && HEX_COLOR.test(ring.fill)))
      problems.push(label + ': portal_ring needs color and fill, each as #rrggbb');
    worlds.push({
      key, name, port, address,
      anchor: { lat: Number(anchor.lat), lon: Number(anchor.lon), h: Number(anchor.h) },
      template,
      location_id: template ? null : 'location-' + key,
      room: typeof entry.room === 'string' ? entry.room : null,
      preview_radius_m: Number(entry.preview_radius_m) || null,
      portal_ring: ring ? { color: ring.color, fill: ring.fill } : null,
    });
  }
  if (!worlds.length) problems.push(file + ': lists no worlds');
  const x3dPortals = readX3dPortals(doc.x3d_portals, seenKeys, problems);
  const loaded = { file, frontend: { port: frontendPort }, worlds, x3d_portals: x3dPortals, problems };
  if (opts.strict && problems.length)
    throw new Error('the worlds configuration ' + file + ' has problems:\n  - ' + problems.join('\n  - '));
  return loaded;
}

/** The address a visitor reaches a world at: its listed address, or {OSL_PUBLIC_ORIGIN}/w/{key}/ on a live public lab. */
function publicAddress(world, env = process.env) {
  const origin = String(env.OSL_PUBLIC_ORIGIN || '').replace(/\/$/, '');
  return origin ? origin + '/w/' + world.key + '/' : world.address;
}

/**
* What a browser may read: names, keys, ports, addresses, and each world's ids. A built-in world's ids come from
* its server configuration; a new world's follow from its key, as src/orchestrator.js gives them.
*/
function publicWorlds(loaded, env = process.env) {
  const { NODES } = require('../runtime/world-server/src/config.js');
  return {
    frontend: loaded.frontend,
    worlds: loaded.worlds.map((w) => {
      const builtIn = w.template === w.key ? NODES[w.key] : null;
      const firstPortal = builtIn && builtIn.portals && builtIn.portals[0];
      return {
        key: w.key,
        name: w.name,
        port: w.port,
        address: publicAddress(w, env),
        built_in: !!builtIn,
        location_id: builtIn ? builtIn.location_id : w.location_id,
        world_id: builtIn ? builtIn.world_id : 'world-' + w.key,
        session_id: builtIn ? builtIn.session_id : 'local-session-' + w.key,
        portal_id: firstPortal ? firstPortal.portal_id : null,
        portal_ring: w.portal_ring,
      };
    }),
    x3d_portals: loaded.x3d_portals,
  };
}

module.exports = { loadWorlds, publicWorlds, publicAddress, withPort, configFile, TEMPLATES, DEFAULT_FILE };

if (require.main === module) {
  try {
    const loaded = loadWorlds({ strict: true });
    const what = process.argv[2];
    if (what === 'frontend-port') console.log(loaded.frontend.port);
    else if (what === 'world-ports') console.log(loaded.worlds.map(w => w.port).join(' '));
    else if (what === 'file') console.log(loaded.file);
    else { console.error('usage: node src/worlds-config.js frontend-port|world-ports|file'); process.exit(2); }
  } catch (error) {
    console.error('ERROR: ' + error.message);
    process.exit(1);
  }
}
