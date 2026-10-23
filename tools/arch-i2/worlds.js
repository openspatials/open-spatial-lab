'use strict';

/*
 * Worlds for the iteration 2 proof.
 *
 * Each world is a real lab world server (runtime/world-server), booted in this process on an isolated
 * port, real or with a planted fault (see ../arch-i1/harness.js). World B sits at the path prefix
 * /w/b/, so its resources are {B}/wow/... with {B} = http://127.0.0.1:<port>/w/b. Models are served
 * by a small static server with their model media types, the way any asset host serves them.
 */

const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const { boot } = require('../arch-i1/harness');
const { ROOT, httpReq, loadEsmMutant } = require('../arch-i1/lib');

const WOW = 'application/wow+json';
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translation = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const scaled = (s, x, y, z) => [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, y, z, 1];
/** A turn about +Y by `deg`, a uniform scale `s`, then a move to (x, y, z). */
function yawScaled(deg, s, x, y, z) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r) * s;
  const n = Math.sin(r) * s;
  return [c, 0, -n, 0, 0, s, 0, 0, n, 0, c, 0, x, y, z, 1];
}

const G1 = { lat: 47.7, lon: -122.3, h: 11.5 };
const pose = (p) => ({ position: { lat: p.lat, lon: p.lon, h: p.h }, angles: { yaw: 0, pitch: 0, roll: 0 } });

/** Boot one world. role: a world server role; options.base: the path prefix; options.edits: a planted fault. */
async function world(role, port, options) {
  options = options || {};
  const config = Object.assign({}, options.config || {});
  if (options.base) config.base_path = options.base;
  const server = await boot(role, port, { edits: options.edits, config });
  const base = 'http://127.0.0.1:' + port + (options.base || '');
  const prefix = options.base || '';
  const api = {
    port,
    base,
    server,
    spatialUrl: (id) => base + '/wow/spatial/' + (id === undefined ? 1 : id),
    worldUrl: () => base + '/wow/world',
    nodeUrl: (graph, id) => base + '/wow/spatial/' + graph + '/node/' + id,
    async rootOf(graph) {
      const r = await httpReq('GET', port, prefix + '/wow/spatial/' + graph, null, { Accept: WOW });
      if (r.status !== 200) throw new Error('GET spatial ' + graph + ': ' + r.status);
      return r.json.rootNodeID;
    },
    /** Create nodes under a parent; returns their ids in order. */
    async add(graph, parentId, nodes) {
      const r = await httpReq('POST', port, prefix + '/wow/spatial/' + graph + '/node/' + parentId, nodes, { Accept: WOW });
      if (r.status !== 200 || !Array.isArray(r.json)) throw new Error('create under ' + parentId + ': ' + r.status + ' ' + r.body.slice(0, 160));
      return r.json.map((n) => n.id);
    },
    async node(graph, id, headers) {
      return httpReq('GET', port, prefix + '/wow/spatial/' + graph + '/node/' + id, null, Object.assign({ Accept: WOW }, headers || {}));
    },
    async put(graph, id, body, headers) {
      return httpReq('PUT', port, prefix + '/wow/spatial/' + graph + '/node/' + id, body, Object.assign({ Accept: WOW }, headers || {}));
    },
    close: () => server.close(),
  };
  return api;
}

// ---- Models -----------------------------------------------------------------------------------------

function gltfDocument(parts) {
  const positions = new Float32Array([
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 1, 5, 6, 1, 6, 2, 5, 4, 7, 5, 7, 6, 4, 0, 3, 4, 3, 7, 3, 2, 6, 3, 6, 7, 4, 5, 1, 4, 1, 0]);
  const buffer = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const doc = {
    asset: { version: '2.0', generator: 'Open Spatial Lab iteration 2 proof' },
    scene: 0,
    scenes: [{ nodes: [] }],
    nodes: [{ name: 'reference-cube', mesh: 0 }],
    meshes: [{ name: 'cube-1m', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ name: 'cube', pbrMetallicRoughness: { baseColorFactor: [0.35, 0.75, 1, 1], metallicFactor: 0, roughnessFactor: 0.6 } }],
    buffers: [{ byteLength: buffer.length, uri: 'data:application/octet-stream;base64,' + buffer.toString('base64') }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
  };
  doc.scenes[0].nodes.push(0);
  if (parts && parts.environment) {
    // KHR_lights_punctual: a sun (directional) and a lamp (point); and a camera.
    doc.extensionsUsed = ['KHR_lights_punctual'];
    doc.extensions = { KHR_lights_punctual: { lights: [
      { name: 'sun', type: 'directional', color: [1, 0.95, 0.85], intensity: 3 },
      { name: 'lamp', type: 'point', color: [1, 0.45, 0.1], intensity: 1.5, range: 6 },
    ] } };
    doc.cameras = [{ name: 'world-camera', type: 'perspective', perspective: { yfov: 0.8, znear: 0.1, zfar: 100 } }];
    doc.nodes.push({ name: 'sun', extensions: { KHR_lights_punctual: { light: 0 } }, rotation: [-0.383, 0, 0, 0.924] });
    doc.nodes.push({ name: 'lamp', extensions: { KHR_lights_punctual: { light: 1 } }, translation: [0, 1.2, 0] });
    doc.nodes.push({ name: 'camera', camera: 0, translation: [0, 1.6, 4] });
    doc.scenes[0].nodes.push(1, 2, 3);
  }
  return JSON.stringify(doc);
}

const MODELS = {
  '/models/cube.gltf': { type: 'model/gltf+json', body: () => gltfDocument() },
  // A model at an address that looks like a Web of Worlds address: only its type says what it is.
  '/wow/spatial/1/node/model.gltf': { type: 'model/gltf+json', body: () => gltfDocument() },
  '/models/environment.gltf': { type: 'model/gltf+json', body: () => gltfDocument({ environment: true }) },
};

/** A static host for the proof's models, served with their model media types. */
async function modelHost(port) {
  const server = http.createServer((req, res) => {
    const entry = MODELS[new URL(req.url, 'http://x').pathname];
    if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    const body = entry.body();
    // Entity tags, as an asset host serves them, so an unchanged model costs a 304 too.
    const etag = '"' + crypto.createHash('sha256').update(body).digest('hex').slice(0, 32) + '"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Access-Control-Allow-Origin': '*' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': entry.type, 'Content-Length': Buffer.byteLength(body), ETag: etag, 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + port;
  return { port, base, url: (p) => base + p, gltf: (p) => MODELS[p].body(), close: () => new Promise((r) => server.close(r)) };
}

// ---- The client -------------------------------------------------------------------------------------

const CLIENT = 'web/wow-inclusion.mjs';
const CLIENT_SIBLINGS = ['wow-geopose.mjs', 'wow-geopose.js'];

/** The real client module, or one with exact string edits (a planted fault). */
async function client(edits) {
  if (!edits || !edits.length) return import(pathToFileURL(path.join(ROOT, CLIENT)).href);
  return loadEsmMutant(CLIENT, edits, CLIENT_SIBLINGS);
}

/** A fetch that answers after a random delay from a seeded generator, so answers arrive out of order. */
function jitteryFetch(seed, maxMs) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return async (url, init) => {
    await new Promise((resolve) => setTimeout(resolve, Math.floor(next() * maxMs)));
    return fetch(url, init);
  };
}

/** A fetch that counts the requests to each URL. */
function countingFetch() {
  const counts = new Map();
  const f = async (url, init) => {
    counts.set(url, (counts.get(url) || 0) + 1);
    return fetch(url, init);
  };
  f.counts = counts;
  return f;
}

// ---- three.js in Node, for the models ---------------------------------------------------------------

let threeModules = null;
async function three() {
  if (!threeModules) {
    // three's file loader reports progress with the browser's ProgressEvent; Node has Event but not that.
    if (typeof globalThis.ProgressEvent === 'undefined') {
      globalThis.ProgressEvent = class ProgressEvent extends Event {
        constructor(type, init) {
          super(type);
          init = init || {};
          this.lengthComputable = !!init.lengthComputable;
          this.loaded = init.loaded || 0;
          this.total = init.total || 0;
        }
      };
    }
    const THREE = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js')).href);
    const { GLTFLoader } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'loaders', 'GLTFLoader.js')).href);
    threeModules = { THREE, GLTFLoader };
  }
  return threeModules;
}

/** Load a glTF document (text) with three.js's GLTFLoader, as the browser player does. */
async function loadGltf(text) {
  const { GLTFLoader } = await three();
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(text, '');
  return gltf.scene;
}

module.exports = {
  WOW, IDENTITY, G1, pose, translation, scaled, yawScaled,
  world, modelHost, client, jitteryFetch, countingFetch, three, loadGltf,
};
