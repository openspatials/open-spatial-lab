// A log of what a page asks for: every HTTP request and every WebSocket it opens, with the world it went to.
// A world is named by the frontend's /api/{key}/ route, or by its own address.

/** Start logging `page`. `worlds` is [{ key, address }]; `front` is the frontend's origin. */
export async function recordRequests(page, { worlds, front }) {
  const entries = [];
  const client = await page.createCDPSession();
  await client.send("Network.enable");
  const classify = (url) => {
    let u;
    try { u = new URL(url); } catch { return { world: null, path: url }; }
    for (const w of worlds) {
      const a = new URL(w.address);
      if (u.host === a.host) return { world: w.key, path: u.pathname + u.search, direct: true };
    }
    if (u.origin === front || u.origin === front.replace("http:", "ws:")) {
      const m = /^\/api\/([^/]+)(\/.*)?$/.exec(u.pathname);
      if (m) return { world: m[1], path: (m[2] || "/") + u.search, proxied: true };
      const n = /^\/w\/([^/]+)\/(wow.*|api.*|events.*)$/.exec(u.pathname);
      if (n) return { world: n[1], path: `/${n[2]}${u.search}`, proxied: true };
      return { world: null, path: u.pathname + u.search, frontend: true };
    }
    return { world: null, path: url, external: true };
  };
  const push = (kind, url, method) => entries.push({ kind, method, url, at: Date.now(), ...classify(url) });
  client.on("Network.requestWillBeSent", (e) => push("http", e.request.url, e.request.method));
  client.on("Network.webSocketCreated", (e) => push("ws", e.url, "WS"));
  return {
    entries,
    mark() { return entries.length; },
    since(mark) { return entries.slice(mark); },
    forWorld(key, mark = 0) { return entries.slice(mark).filter((e) => e.world === key); },
    external(mark = 0) { return entries.slice(mark).filter((e) => e.external); },
    summary(mark = 0) {
      const out = {};
      for (const e of entries.slice(mark)) {
        if (!e.world) continue;
        const key = `${e.kind === "ws" ? "WS " : `${e.method} `}${e.path.replace(/\?.*$/, "")}`;
        (out[e.world] = out[e.world] || {})[key] = ((out[e.world] || {})[key] || 0) + 1;
      }
      return out;
    },
  };
}
