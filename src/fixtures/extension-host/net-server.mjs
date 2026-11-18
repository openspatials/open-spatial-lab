// The test server of the network cases (Node only): the remote origin an extension fetches from. It records every
// request it answers (path, method, the Cookie and Authorization headers it received, and whether the client went
// away before the response ended), and sets CORS headers for one page origin so the browser check can read it.
//
//   /hello      200, text/plain, HELLO_BODY, with an x-lab-private header the host must not pass on
//   /redirect   302 to /target            /target   200 "target"
//   /big        200, BIG_BYTES bytes       /slow     200 "slow" after SLOW_MS
//   /__seen     the records as JSON (not recorded)      /__reset   clears them (not recorded)
import { createServer } from "node:http";

export const HELLO_BODY = "hello from the test server: é ☃";
export const BIG_BYTES = 1024 * 1024 + 1;
export const SLOW_MS = 1500;

/** Starts the server on 127.0.0.1:`port` (0: a free port). `allowOrigin` is the page origin CORS allows, or null. */
export function startNetServer({ port = 0, allowOrigin = null } = {}) {
  const records = [];
  const cors = (response) => {
    if (!allowOrigin) return;
    response.setHeader("access-control-allow-origin", allowOrigin);
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE");
    response.setHeader("access-control-allow-headers", "content-type");
    response.setHeader("access-control-expose-headers", "etag, x-lab-private");
    response.setHeader("vary", "origin");
  };
  const sockets = new Set();
  const server = createServer((request, response) => {
    cors(response);
    response.setHeader("cache-control", "no-store");
    const path = new URL(request.url, "http://localhost").pathname;
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (path === "/__seen") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(records));
      return;
    }
    if (path === "/__reset") {
      records.length = 0;
      response.writeHead(204);
      response.end();
      return;
    }
    const record = { path, method: request.method, cookie: request.headers.cookie || "", authorization: request.headers.authorization || "", aborted: false, completed: false };
    records.push(record);
    response.on("close", () => {
      if (response.writableFinished) record.completed = true;
      else record.aborted = true;
    });
    if (path === "/hello") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", etag: "\"v1\"", "x-lab-private": "not for extensions" });
      response.end(HELLO_BODY);
    } else if (path === "/redirect") {
      response.writeHead(302, { location: "/target", "content-type": "text/plain" });
      response.end("moved");
    } else if (path === "/target") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("target");
    } else if (path === "/big") {
      response.writeHead(200, { "content-type": "text/plain", "content-length": String(BIG_BYTES) });
      response.end("x".repeat(BIG_BYTES));
    } else if (path === "/slow") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.flushHeaders();
      const timer = setTimeout(() => response.end("slow"), SLOW_MS);
      response.on("close", () => clearTimeout(timer));
    } else {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("404");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        origin,
        records,
        reset() { records.length = 0; },
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
