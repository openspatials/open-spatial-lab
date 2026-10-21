'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB_ROOT = path.join(ROOT, 'web');
const SCENE_CORE_ROOT = path.join(ROOT, 'runtime', 'scene-core', 'public');
const NODE_MODULES = path.join(ROOT, 'node_modules');
const DEFAULT_BACKEND_PORTS = Object.freeze({ a: 18151, b: 18152, lobby: 18153, airport: 18154 });
const WORLD_KEYS = new Set(Object.keys(DEFAULT_BACKEND_PORTS));

const MIME = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.vrm': 'model/gltf-binary',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

function safeJoin(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); }
  catch { return null; }
  const candidate = path.resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`) ? candidate : null;
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value, null, 2));
  response.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(body);
}

function serveFile(response, filePath) {
  fs.readFile(filePath, (error, bytes) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('404 not found');
      return;
    }
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    response.end(bytes);
  });
}

function backendHealth(key, port) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/healthz', timeout: 1200 }, (response) => {
      response.resume();
      response.on('end', () => resolve({ key, ok: response.statusCode === 200, status: response.statusCode || 0 }));
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => resolve({ key, ok: false, status: 0 }));
  });
}

function proxyHttp(key, request, response, backendPorts) {
  const prefix = `/api/${key}`;
  const targetPath = request.url.startsWith(prefix) ? request.url.slice(prefix.length) || '/' : request.url;
  const proxy = http.request({
    hostname: '127.0.0.1',
    port: backendPorts[key],
    path: targetPath,
    method: request.method,
    headers: { ...request.headers, host: `127.0.0.1:${backendPorts[key]}` },
  }, (backendResponse) => {
    const headers = { ...backendResponse.headers };
    delete headers['access-control-allow-origin'];
    headers['access-control-allow-origin'] = '*';
    response.writeHead(backendResponse.statusCode || 502, headers);
    backendResponse.pipe(response);
  });
  proxy.on('error', (error) => sendJson(response, 502, { ok: false, error: 'backend_unavailable', message: error.message }));
  request.pipe(proxy);
}

function proxyWebSocket(request, clientSocket, head, backendPorts) {
  const parsed = new URL(request.url, 'http://127.0.0.1');
  const match = parsed.pathname.match(/^\/api\/(a|b|lobby|airport)\/(runtime-state|events)$/);
  if (!match) {
    clientSocket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  const [, key, route] = match;
  const proxy = http.request({
    hostname: '127.0.0.1',
    port: backendPorts[key],
    path: `/${route}${parsed.search}`,
    method: 'GET',
    headers: { ...request.headers, host: `127.0.0.1:${backendPorts[key]}` },
  });
  const fail = () => {
    if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  };
  proxy.once('upgrade', (backendResponse, backendSocket, backendHead) => {
    const headers = [];
    for (let index = 0; index < backendResponse.rawHeaders.length; index += 2) {
      headers.push(`${backendResponse.rawHeaders[index]}: ${backendResponse.rawHeaders[index + 1]}`);
    }
    clientSocket.write(`HTTP/${backendResponse.httpVersion} ${backendResponse.statusCode} ${backendResponse.statusMessage}\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (backendHead.length) clientSocket.write(backendHead);
    if (head.length) backendSocket.write(head);
    backendSocket.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => backendSocket.destroy());
    backendSocket.pipe(clientSocket);
    clientSocket.pipe(backendSocket);
  });
  proxy.once('response', (backendResponse) => { backendResponse.resume(); fail(); });
  proxy.once('error', fail);
  proxy.end();
}

function createFrontendServer(port = 8143, options = {}) {
  const backendPorts = { ...DEFAULT_BACKEND_PORTS, ...(options.backendPorts || {}) };
  const server = http.createServer(async (request, response) => {
    const parsed = new URL(request.url, 'http://127.0.0.1');
    let urlPath = parsed.pathname;
    let worldKey = 'a';
    const worldMatch = urlPath.match(/^\/w\/(a|b|lobby|airport)(\/.*)?$/);
    if (worldMatch) {
      worldKey = worldMatch[1];
      if (!worldMatch[2]) {
        response.writeHead(301, { Location: `/w/${worldKey}/${parsed.search}`, 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      urlPath = worldMatch[2];
      request.url = `${urlPath}${parsed.search}`;
    }

    if (request.method === 'OPTIONS' && (urlPath.startsWith('/api/') || urlPath.startsWith('/wow'))) {
      response.writeHead(204, {
        'Access-Control-Allow-Headers': 'Content-Type,Accept',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Origin': '*',
      });
      response.end();
      return;
    }
    if (urlPath === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method === 'GET' && urlPath === '/healthz') {
      const backends = await Promise.all(Object.entries(backendPorts).map(([key, backendPort]) => backendHealth(key, backendPort)));
      const ok = backends.every((backend) => backend.ok);
      sendJson(response, ok ? 200 : 503, { ok, frontend: { ok: true }, backends });
      return;
    }
    if (urlPath === '/wow' || urlPath.startsWith('/wow/')) {
      proxyHttp(worldKey, request, response, backendPorts);
      return;
    }
    const apiMatch = urlPath.match(/^\/api\/(a|b|lobby|airport)(?:\/|$)/);
    if (apiMatch) {
      proxyHttp(apiMatch[1], request, response, backendPorts);
      return;
    }

    const staticRoutes = [
      ['/vendor/scene-core/', SCENE_CORE_ROOT],
      ['/vendor-three-examples/', path.join(NODE_MODULES, 'three', 'examples', 'jsm')],
      ['/vendor-vrm/', path.join(NODE_MODULES, '@pixiv', 'three-vrm', 'lib')],
    ];
    for (const [prefix, root] of staticRoutes) {
      if (!urlPath.startsWith(prefix)) continue;
      const file = safeJoin(root, urlPath.slice(prefix.length));
      if (!file) {
        response.writeHead(400);
        response.end('bad path');
      } else {
        serveFile(response, file);
      }
      return;
    }
    if (urlPath === '/') urlPath = '/index.html';
    const file = safeJoin(WEB_ROOT, urlPath);
    if (!file) {
      response.writeHead(400);
      response.end('bad path');
    } else {
      serveFile(response, file);
    }
  });

  server.on('upgrade', (request, socket, head) => proxyWebSocket(request, socket, head, backendPorts));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      console.log(`[frontend] Open Spatial Lab listening on http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}

module.exports = { createFrontendServer };

if (require.main === module) {
  const port = Number(process.argv[2]) || 8143;
  const backendPorts = {
    a: Number(process.env.BACKEND_A_PORT) || DEFAULT_BACKEND_PORTS.a,
    b: Number(process.env.BACKEND_B_PORT) || DEFAULT_BACKEND_PORTS.b,
    lobby: Number(process.env.BACKEND_LOBBY_PORT) || DEFAULT_BACKEND_PORTS.lobby,
    airport: Number(process.env.BACKEND_AIRPORT_PORT) || DEFAULT_BACKEND_PORTS.airport,
  };
  createFrontendServer(port, { backendPorts }).catch((error) => {
    console.error(`Open Spatial Lab frontend failed: ${error.message}`);
    process.exit(1);
  });
}
