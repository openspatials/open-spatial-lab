// web/wow-inclusion.mjs
//
// Iteration 2: a node in world A shows a graph, or a node subtree, of world B.
//
// THE LINK. A node's `spatialAssetURI` names either a model or a Web of Worlds resource: a `Spatial`,
// a `Node` or the `wow/world` resource of any world (decision 4, 2026-10-22). The client tells them
// apart by the media type of the answer, never by the address and never by looking at the body: an
// answer labelled `application/wow+json` is another world's content, a `model/...` answer is a model,
// and anything else gets a placeholder (RFC 9110 §8.3; W3C Architecture of the WWW §2.5).
//
// THE RULES.
//   - The including node stands in for the included node's parent: the included node keeps its own
//     localTransform, under the including node.
//   - B stays the owner of its content. Every included node keeps its URL at B; the registry lists B's URLs.
//   - A whole world (`wow/world`) shows its default graph (the first of `spatials`) at the including
//     node, and its other anchored graphs where their GeoPoses put them relative to the default graph.
//     A graph with no anchor is not shown.
//   - The host sets a nesting limit and a budget of included graphs. Places in the budget are handed
//     out in tree order (depth first, children in order), so every run shows the same graphs.
//   - A cycle is detected by URL on the inclusion path before anything is fetched; the same world
//     included twice on different branches is not a cycle.
//   - A failure shows a placeholder with its reason: unreachable, forbidden, not found, over budget,
//     cycle, nesting limit, or not a Web of Worlds resource.
//   - Reads are conditional: a reader keeps each answer's entity tag and asks again with
//     If-None-Match, so an unchanged resource costs a 304.
//   - The included world's environment does not apply to the host: an included model loses its
//     directional, hemisphere and ambient lights and its cameras; its point and spot lights stay.
//
// PURE: no DOM and no three.js import; `fetch` is passed in. It runs in Node for the iteration 2
// proof (npm run arch-i2-proof) and in the browser for the `?wow=` player.

import { frameFromGeoPose, ecefToLocal, directionInFrame, readGeoPose } from "./wow-geopose.mjs";
import { worldBaseOf, openWorldStream } from "./wow-observe.mjs";

export const WOW_MEDIA_TYPE = "application/wow+json";
// What an inclusion request accepts: the Web of Worlds type first, then the glTF model types.
export const WOW_INCLUSION_ACCEPT =
  "application/wow+json, model/gltf-binary;q=0.9, model/gltf+json;q=0.9, model/*;q=0.8, */*;q=0.1";

export const INCLUSION_STATUS = Object.freeze({
  INCLUDED: "included",
  MODEL: "model",
  UNREACHABLE: "unreachable",
  FORBIDDEN: "forbidden",
  NOT_FOUND: "not found",
  OVER_BUDGET: "over budget",
  CYCLE: "cycle",
  NESTING_LIMIT: "nesting limit",
  NOT_WOW: "not a Web of Worlds resource",
});

export const DEFAULT_NESTING_LIMIT = 3;
export const DEFAULT_BUDGET = 16;
// Iteration 3: a live host follows each world it shows through that world's event stream, and holds
// at most this many streams, its own included, handed out in tree order.
export const DEFAULT_STREAM_BUDGET = 8;
// The type that marks an included node as its world's environment, through the JSON-LD context that
// types node `properties`. Provisional, as the context's terms are.
export const ENVIRONMENT_IRI = "urn:webofworlds:term:Environment";

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** The media type of a Content-Type header value, lower case, without parameters. */
export function mediaTypeOf(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

export function isWowMediaType(contentType) {
  return mediaTypeOf(contentType) === WOW_MEDIA_TYPE;
}

export function isModelMediaType(contentType) {
  return mediaTypeOf(contentType).startsWith("model/");
}

/** Resolve a URI reference against the URL of the resource that holds it. Null when it is not http(s). */
export function resolveReference(reference, baseUrl) {
  if (typeof reference !== "string" || !reference) return null;
  let url;
  try {
    url = new URL(reference, baseUrl);
  } catch {
    return null;
  }
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
}

// ---------------------------------------------------------------------------------------------
// 4x4 column-major matrices (the API's localTransform layout).
// ---------------------------------------------------------------------------------------------

export function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

export function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** The inverse of an affine column-major matrix. */
export function invertAffine(m) {
  const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!det) throw new Error("matrix is not invertible");
  const r = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
  const t = [m[12], m[13], m[14]];
  const tx = -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]);
  const ty = -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]);
  const tz = -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2]);
  return [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, tx, ty, tz, 1];
}

function localTransformOf(node) {
  const t = node && node.localTransform;
  return Array.isArray(t) && t.length === 16 && t.every((v) => Number.isFinite(Number(v))) ? t.map(Number) : IDENTITY.slice();
}

/**
 * Where graph `other` sits in graph `base`'s frame, from their GeoPose anchors (EPSG 9837 through the
 * shared GeoPose implementation): its origin, and its axes turned into base's axes.
 */
export function relativeGraphPlacement(baseGeoPose, otherGeoPose) {
  const base = frameFromGeoPose(baseGeoPose);
  const other = frameFromGeoPose(otherGeoPose);
  const origin = ecefToLocal(base, other.origin);
  const [x, y, z] = other.axes.map((axis) => directionInFrame(base, axis));
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, origin[0], origin[1], origin[2], 1];
}

// ---------------------------------------------------------------------------------------------
// Reading Web of Worlds resources, with conditional requests.
// ---------------------------------------------------------------------------------------------

/**
 * A reader of Web of Worlds resources. It keeps each answer and its entity tag; a later read of the
 * same URL with `revalidate` sends If-None-Match and reuses the kept answer on 304.
 *
 * @param {{fetch: Function, accept?: string, headers?: object}} opts
 */
export function createWowReader(opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("createWowReader needs a fetch function");
  const accept = opts.accept || WOW_INCLUSION_ACCEPT;
  const cache = new Map();
  const stats = { requests: 0, not_modified: 0, changed: 0, failed: 0 };
  const log = [];

  async function get(url, { revalidate = false } = {}) {
    const kept = cache.get(url);
    if (kept && !revalidate) return { ...kept, fromCache: true };
    const headers = { Accept: accept, ...(opts.headers || {}) };
    if (kept && kept.etag) headers["If-None-Match"] = kept.etag;
    stats.requests += 1;
    let response;
    try {
      response = await fetchImpl(url, { headers, cache: "no-store" });
    } catch (error) {
      stats.failed += 1;
      log.push({ url, status: 0, error: String((error && error.message) || error) });
      return { url, status: 0, error: String((error && error.message) || error) };
    }
    if (response.status === 304 && kept) {
      stats.not_modified += 1;
      log.push({ url, status: 304 });
      return { ...kept, status: 304, fromCache: true };
    }
    const type = response.headers.get("content-type") || "";
    const etag = response.headers.get("etag") || null;
    let body = null;
    if (response.ok && /^application\/(json|[\w.-]+\+json)$/.test(mediaTypeOf(type))) {
      try { body = await response.json(); } catch { body = null; }
    } else {
      // A model or an error: its bytes are the model loader's business, not the composer's.
      try { await response.arrayBuffer(); } catch { /* ignore */ }
    }
    const answer = { url, status: response.status, type, etag, body };
    if (kept && kept.etag !== etag) stats.changed += 1;
    if (response.ok) cache.set(url, answer);
    else cache.delete(url);
    log.push({ url, status: response.status, etag });
    return answer;
  }

  /** The answer's status and media type alone (HEAD: the same header fields as GET, no body). */
  async function head(url) {
    stats.requests += 1;
    try {
      const response = await fetchImpl(url, { method: "HEAD", headers: { Accept: accept, ...(opts.headers || {}) }, cache: "no-store" });
      log.push({ url, status: response.status, method: "HEAD" });
      return { url, status: response.status, type: response.headers.get("content-type") || "" };
    } catch (error) {
      stats.failed += 1;
      log.push({ url, status: 0, method: "HEAD", error: String((error && error.message) || error) });
      return null;
    }
  }

  return { get, head, stats, log, cache, fetch: fetchImpl };
}

/** Which Web of Worlds resource a body is, once its media type says it is one. */
export function resourceKind(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (Array.isArray(body.spatials) || body.content !== undefined) return "world";
  if (body.rootNodeID !== undefined) return "spatial";
  if (body.localTransform !== undefined || body.children !== undefined) return "node";
  return null;
}

/** The URL of a graph's node: the API's path, `{spatial}/node/{id}`. */
function nodeUrlOf(spatialUrl, id) {
  return `${spatialUrl.replace(/\/+$/, "")}/node/${id}`;
}

/** The URL of a world's graph from the world's URL: the base-URL rule, base plus `wow/spatial/{id}`. */
function spatialUrlOfWorld(worldUrl, id) {
  const base = worldUrl.replace(/wow\/world\/?(\?.*)?$/, "");
  return `${base}wow/spatial/${id}`;
}

// ---------------------------------------------------------------------------------------------
// Composition.
// ---------------------------------------------------------------------------------------------

/**
 * Compose world A's graph with everything it includes.
 *
 * @param {string} hostUrl   A's Spatial URL ({A}/wow/spatial/{id})
 * @param {object} opts      { fetch | reader, nestingLimit, budget }
 * @returns {Promise<object>} the composition:
 *   - nodes: every node shown, host and included, in tree order, each with its URL, its matrix in
 *     A's frame (`world`), its matrix in its own graph (`graphLocal`, from the including node's frame)
 *     and the graph it belongs to;
 *   - registry: node URL -> the node's placements (B's URLs, never copies);
 *   - inclusions: every content link met, with its status and depth;
 *   - graphs: every included graph, with its placement;
 *   - assets: model links, with whether they sit inside included content;
 *   - cycles: the cycles found, each with its path.
 */
export async function composeInclusions(hostUrl, opts = {}) {
  const reader = opts.reader || createWowReader({ fetch: opts.fetch });
  const nestingLimit = Number.isInteger(opts.nestingLimit) ? opts.nestingLimit : DEFAULT_NESTING_LIMIT;
  const budget = Number.isInteger(opts.budget) ? opts.budget : DEFAULT_BUDGET;
  const revalidate = !!opts.revalidate;
  const streamBudget = Number.isInteger(opts.streamBudget) ? opts.streamBudget : Infinity;

  const out = {
    host: hostUrl,
    nestingLimit,
    budget,
    nodes: [],
    registry: new Map(),
    inclusions: [],
    graphs: [],
    assets: [],
    cycles: [],
    graphsUsed: 0,
    // Iteration 3: the worlds whose event streams a live host holds, in tree order, and the included
    // nodes left out as their world's environment.
    streams: [],
    environment: [],
    stats: reader.stats,
  };

  const read = (url) => reader.get(url, { revalidate });

  const host = await read(hostUrl);
  if (host.status !== 200 && host.status !== 304) throw new Error(`host graph ${hostUrl} answered ${host.status || host.error}`);
  if (!isWowMediaType(host.type)) throw new Error(`host graph ${hostUrl} is not served as ${WOW_MEDIA_TYPE} (got ${host.type || "none"})`);
  const hostRootUrl = nodeUrlOf(hostUrl, host.body.rootNodeID);
  const hostRoot = await read(hostRootUrl);
  if (!hostRoot.body || !isWowMediaType(hostRoot.type)) throw new Error(`host root ${hostRootUrl} did not answer as ${WOW_MEDIA_TYPE}`);
  const hostGraph = addGraph({ url: hostUrl, rootUrl: hostRootUrl, depth: 0, placement: IDENTITY.slice(), anchor: host.body.geoPose || null, host: true });
  takeStream(worldBaseOf(hostUrl));
  await walk(hostRoot.body, hostRootUrl, IDENTITY.slice(), IDENTITY.slice(), { depth: 0, path: [hostUrl], graph: hostGraph }, null);
  return out;

  // Each shown graph is an instance: the same graph included on two branches is shown twice.
  function addGraph(graph) {
    graph.instance = out.graphs.length;
    out.graphs.push(graph);
    return graph;
  }

  async function walk(node, url, parentWorld, parentGraphLocal, ctx, parentUrl) {
    // The included world's environment does not apply to the host: an included node typed as
    // environment (through its properties' JSON-LD context) is left out, with its subtree.
    if (ctx.depth > 0 && node.properties && node.properties["@type"] !== undefined && (await isEnvironment(node.properties, url))) {
      out.environment.push(url);
      return;
    }
    const local = localTransformOf(node);
    const record = {
      url,
      id: node.id,
      label: node.label != null ? String(node.label) : String(node.id),
      parent: parentUrl,
      depth: ctx.depth,
      included: ctx.depth > 0,
      graph: ctx.graph.url,
      instance: ctx.graph.instance,
      local,
      graphLocal: multiply(parentGraphLocal, local),
      world: multiply(parentWorld, local),
      spatialAssetURI: typeof node.spatialAssetURI === "string" ? node.spatialAssetURI : null,
      inclusion: null,
      asset: null,
    };
    out.nodes.push(record);
    // The registry is keyed by each node's URL at its owner; a node shown twice has two placements.
    if (!out.registry.has(url)) out.registry.set(url, []);
    out.registry.get(url).push(record);

    if (record.spatialAssetURI) {
      const target = resolveReference(record.spatialAssetURI, url);
      if (target) await include(record, target, ctx);
      else record.asset = { uri: record.spatialAssetURI, kind: "scheme" };
    }
    for (const child of Array.isArray(node.children) ? node.children : []) {
      if (!child || typeof child !== "object") continue; // the canonical Node embeds its children
      await walk(child, new URL(String(child.id), url).href, record.world, record.graphLocal, ctx, url);
    }
  }

  async function include(record, target, ctx) {
    const depth = ctx.depth + 1;
    const inclusion = { node: record.url, target, depth, status: null, kind: null, graphs: [], detail: null };
    record.inclusion = inclusion;

    // What can stop a link: a cycle, the nesting limit, or the budget. They count included graphs only;
    // a model needs no level and no place, so past the limit or the budget the label alone (HEAD) decides.
    let blocked = null;
    if (ctx.path.includes(target)) blocked = INCLUSION_STATUS.CYCLE;
    else if (depth > nestingLimit) blocked = INCLUSION_STATUS.NESTING_LIMIT;
    else if (out.graphsUsed >= budget) blocked = INCLUSION_STATUS.OVER_BUDGET;
    if (blocked === INCLUSION_STATUS.CYCLE) {
      inclusion.status = INCLUSION_STATUS.CYCLE;
      inclusion.detail = `the inclusion path already holds ${target}`;
      out.cycles.push({ at: record.url, target, depth, path: ctx.path.concat([target]) });
      out.inclusions.push(inclusion);
      return;
    }
    if (blocked) {
      const label = await reader.head(target);
      if (!label || !isModelMediaType(label.type)) return refuse(inclusion, blocked, depth);
    }

    const answer = await read(target);
    const failure = failureOf(answer);
    if (failure) {
      inclusion.status = failure;
      inclusion.detail = answer.error || `HTTP ${answer.status}`;
      out.inclusions.push(inclusion);
      return;
    }
    if (!isWowMediaType(answer.type)) {
      if (isModelMediaType(answer.type)) {
        // Not an inclusion: a model, loaded by the model loader.
        inclusion.status = INCLUSION_STATUS.MODEL;
        record.asset = { uri: target, kind: "model", type: mediaTypeOf(answer.type), included: record.included, node: record.url, world: record.world };
        out.assets.push(record.asset);
        out.inclusions.push(inclusion);
        return;
      }
      inclusion.status = INCLUSION_STATUS.NOT_WOW;
      inclusion.detail = `answered ${mediaTypeOf(answer.type) || "no type"}`;
      out.inclusions.push(inclusion);
      return;
    }
    // The label said model, but the answer is a graph: the limit holds after all.
    if (blocked) return refuse(inclusion, blocked, depth);

    const kind = resourceKind(answer.body);
    inclusion.kind = kind;
    // Its world needs an event stream; past the stream budget its content is "over budget".
    if (!takeStream(worldBaseOf(target))) return refuse(inclusion, INCLUSION_STATUS.OVER_BUDGET, depth);
    out.inclusions.push(inclusion);
    const path = ctx.path.concat([target]);

    if (kind === "node") {
      if (!takePlace(inclusion)) return;
      const graph = addGraph({ url: target, rootUrl: target, depth, placement: IDENTITY.slice(), anchor: null, via: record.url, shown: true });
      inclusion.graphs.push(graph);
      inclusion.status = INCLUSION_STATUS.INCLUDED;
      await walk(answer.body, target, record.world, IDENTITY.slice(), { depth, path, graph }, null);
      return;
    }

    // A Spatial is one graph; a World is its default graph plus its other anchored graphs.
    let graphs;
    if (kind === "spatial") {
      graphs = [{ url: target, spatial: answer.body, placement: IDENTITY.slice() }];
    } else if (kind === "world") {
      const ids = Array.isArray(answer.body.spatials) ? answer.body.spatials : [];
      if (!ids.length) {
        inclusion.status = INCLUSION_STATUS.NOT_FOUND;
        inclusion.detail = "the world lists no graphs (spatials)";
        return;
      }
      graphs = [];
      let baseAnchor = null;
      for (const [index, id] of ids.entries()) {
        const url = spatialUrlOfWorld(target, id);
        if (path.includes(url)) {
          out.cycles.push({ at: record.url, target: url, depth, path: path.concat([url]) });
          continue;
        }
        const spatial = await read(url);
        if (failureOf(spatial) || !isWowMediaType(spatial.type) || resourceKind(spatial.body) !== "spatial") continue;
        const anchor = spatial.body.geoPose ? readGeoPose(spatial.body.geoPose) : null;
        if (index === 0) {
          baseAnchor = anchor && anchor.ok ? anchor.geoPose : null;
          graphs.push({ url, spatial: spatial.body, placement: IDENTITY.slice() });
        } else if (anchor && anchor.ok && baseAnchor) {
          graphs.push({ url, spatial: spatial.body, placement: relativeGraphPlacement(baseAnchor, anchor.geoPose) });
        } else {
          inclusion.graphs.push({ url, shown: false, reason: "no anchor" });
        }
      }
    } else {
      inclusion.status = INCLUSION_STATUS.NOT_WOW;
      inclusion.detail = "a Web of Worlds answer that is neither a World, a Spatial nor a Node";
      return;
    }

    let shown = 0;
    let rootProblem = null;
    for (const g of graphs) {
      if (!takePlace(inclusion)) break;
      const rootUrl = nodeUrlOf(g.url, g.spatial.rootNodeID);
      const root = await read(rootUrl);
      const rootFailure = failureOf(root);
      if (rootFailure || !isWowMediaType(root.type)) {
        out.graphsUsed -= 1;
        rootProblem = rootFailure || INCLUSION_STATUS.NOT_WOW;
        inclusion.graphs.push({ url: g.url, shown: false, reason: rootFailure || "root not served as " + WOW_MEDIA_TYPE });
        continue;
      }
      const graph = addGraph({ url: g.url, rootUrl, depth, placement: g.placement, anchor: g.spatial.geoPose || null, via: record.url, shown: true });
      inclusion.graphs.push(graph);
      shown += 1;
      // The graph's placement relative to the default graph sits between the including node and the
      // graph's root, so `graphLocal` stays relative to the default graph's origin.
      await walk(root.body, rootUrl, multiply(record.world, g.placement), g.placement, {
        depth,
        path: path.concat([g.url]),
        graph,
      }, null);
    }
    if (!inclusion.status) {
      inclusion.status = shown ? INCLUSION_STATUS.INCLUDED
        : inclusion.overBudget ? INCLUSION_STATUS.OVER_BUDGET
          : rootProblem || INCLUSION_STATUS.NOT_FOUND;
    }
  }

  function takeStream(base) {
    if (out.streams.includes(base)) return true;
    if (out.streams.length >= streamBudget) return false;
    out.streams.push(base);
    return true;
  }

  /** True when a `properties` object's @type expands, through its JSON-LD context, to ENVIRONMENT_IRI. */
  async function isEnvironment(properties, baseUrl) {
    const terms = {};
    for (const ctx of [].concat(properties["@context"] || [])) {
      let doc = ctx;
      if (typeof ctx === "string") {
        const url = resolveReference(ctx, baseUrl);
        const answer = url ? await read(url) : null;
        doc = answer && answer.body ? answer.body["@context"] : null;
      }
      if (doc && typeof doc === "object") Object.assign(terms, doc);
    }
    const expand = (value, depth) => {
      if (typeof value !== "string" || depth > 8) return null;
      if (Object.prototype.hasOwnProperty.call(terms, value)) {
        const def = terms[value];
        return expand(typeof def === "string" ? def : def && def["@id"], depth + 1);
      }
      const colon = value.indexOf(":");
      if (colon > 0) {
        const prefix = value.slice(0, colon);
        const def = terms[prefix];
        const iri = typeof def === "string" ? def : def && def["@id"];
        return iri ? iri + value.slice(colon + 1) : value;
      }
      return null;
    };
    return [].concat(properties["@type"]).some((t) => expand(t, 0) === ENVIRONMENT_IRI);
  }

  function refuse(inclusion, status, depth) {
    inclusion.status = status;
    inclusion.detail = status === INCLUSION_STATUS.NESTING_LIMIT ? `level ${depth} is past the nesting limit of ${nestingLimit}` : null;
    out.inclusions.push(inclusion);
  }

  function takePlace(inclusion) {
    if (out.graphsUsed >= budget) {
      if (!inclusion.status) inclusion.status = inclusion.graphs.some((g) => g.shown) ? INCLUSION_STATUS.INCLUDED : INCLUSION_STATUS.OVER_BUDGET;
      inclusion.overBudget = (inclusion.overBudget || 0) + 1;
      return false;
    }
    out.graphsUsed += 1;
    return true;
  }
}

function failureOf(answer) {
  if (!answer || answer.status === 0 || answer.error) return INCLUSION_STATUS.UNREACHABLE;
  if (answer.status === 403 || answer.status === 401) return INCLUSION_STATUS.FORBIDDEN;
  if (answer.status === 404 || answer.status === 410) return INCLUSION_STATUS.NOT_FOUND;
  if (answer.status >= 400) return INCLUSION_STATUS.UNREACHABLE;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Writes that cannot lose an update.
// ---------------------------------------------------------------------------------------------

/**
 * Change a node at its owner without losing someone else's update: read it, change it, PUT it with
 * If-Match; on 412 read it again and retry. Returns { status, attempts, statuses, node }.
 *
 * @param {string} nodeUrl
 * @param {(node: object) => object} change   returns the body to PUT, from the node as read
 * @param {{fetch: Function, retries?: number, etag?: string}} opts   `etag` replaces the first read's
 *        tag, for a caller that read the node earlier
 */
export async function writeNodeSafely(nodeUrl, change, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const retries = Number.isInteger(opts.retries) ? opts.retries : 1;
  const statuses = [];
  let etag = opts.etag || null;
  let node = opts.node || null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (!node || !etag) {
      const r = await fetchImpl(nodeUrl, { headers: { Accept: WOW_MEDIA_TYPE }, cache: "no-store" });
      statuses.push(`GET ${r.status}`);
      if (!r.ok) return { status: r.status, attempts: attempt, statuses, node: null };
      etag = r.headers.get("etag");
      node = await r.json();
    }
    const body = change(JSON.parse(JSON.stringify(node)));
    const put = await fetchImpl(nodeUrl, {
      method: "PUT",
      headers: { Accept: WOW_MEDIA_TYPE, "Content-Type": WOW_MEDIA_TYPE, "If-Match": etag },
      body: JSON.stringify(body),
    });
    statuses.push(`PUT ${put.status}`);
    if (put.status !== 412) {
      const value = put.ok ? await put.json() : null;
      return { status: put.status, attempts: attempt + 1, statuses, node: value, etag: put.headers.get("etag") };
    }
    node = null; // read again: someone else changed it
    etag = null;
  }
  return { status: 412, attempts: retries + 1, statuses, node: null };
}

// ---------------------------------------------------------------------------------------------
// The included world's environment.
// ---------------------------------------------------------------------------------------------

/**
 * Remove what belongs to an included world's environment from a loaded model (a three.js Object3D):
 * directional, hemisphere and ambient lights, and cameras. Point and spot lights are content and stay.
 * Returns what was removed and what was kept, by type.
 */
export function filterIncludedEnvironment(object3D) {
  const removed = [];
  const kept = [];
  const doomed = [];
  object3D.traverse((child) => {
    if (child.isDirectionalLight || child.isHemisphereLight || child.isAmbientLight || child.isCamera) doomed.push(child);
    else if (child.isLight) kept.push(child.type);
  });
  for (const child of doomed) {
    removed.push(child.type);
    if (child.parent) child.parent.remove(child);
  }
  return { removed, kept };
}

/**
 * One shown graph instance as a graph bundle `{ spatialID, root, nodes }` that the scene builder
 * (buildWowScene) renders: ids are local to the bundle, children are ids, and the root's transform is
 * the graph's placement times the root's own transform. A node that holds an inclusion keeps no
 * spatialAssetURI in the bundle: its inclusion is mounted from the composition instead. Each bundle
 * node carries its URL at its owner (webofworlds_extension.source_url).
 */
export function bundleOfGraph(composition, graph) {
  const records = composition.nodes.filter((n) => n.instance === graph.instance);
  const idOf = new Map(records.map((n, index) => [n.url, index + 1]));
  const nodes = {};
  for (const n of records) {
    const id = idOf.get(n.url);
    nodes[id] = {
      id,
      label: n.label,
      localTransform: n.url === graph.rootUrl ? multiply(graph.placement, n.local) : n.local,
      ...(n.spatialAssetURI && !n.inclusion ? { spatialAssetURI: n.spatialAssetURI } : {}),
      ...(n.asset && n.asset.kind === "model" ? { spatialAssetURI: n.asset.uri } : {}),
      children: [],
      webofworlds_extension: { source_url: n.url },
    };
  }
  for (const n of records) {
    if (n.parent && idOf.has(n.parent)) nodes[idOf.get(n.parent)].children.push(idOf.get(n.url));
  }
  return { spatialID: graph.url, root: idOf.get(graph.rootUrl), nodes, idOf };
}

// ---------------------------------------------------------------------------------------------
// Live inclusion (iteration 3).
// ---------------------------------------------------------------------------------------------

/**
 * Compose world A and keep the composition current. A holds one event stream for each world it shows,
 * within the stream budget; an event that names a resource the composition read starts a new
 * composition with conditional reads, so only what changed is read again. No polling.
 *
 * @param {string} hostUrl
 * @param {object} opts   composeInclusions' options, plus WebSocket, token, streamBudget and
 *                        onUpdate(composition, event)
 */
export async function observeComposition(hostUrl, opts = {}) {
  const reader = createWowReader({ fetch: opts.fetch });
  const streamBudget = Number.isInteger(opts.streamBudget) ? opts.streamBudget : DEFAULT_STREAM_BUDGET;
  const options = { ...opts, reader, streamBudget };
  let composition = await composeInclusions(hostUrl, options);
  const streams = new Map();
  let running = Promise.resolve();
  let closed = false;
  const live = { updates: 0, events: 0 };

  function recompose(evt) {
    running = running.then(async () => {
      if (closed) return;
      composition = await composeInclusions(hostUrl, { ...options, revalidate: true });
      live.updates += 1;
      sync();
      if (opts.onUpdate) opts.onUpdate(composition, evt);
    }).catch(() => {});
    return running;
  }

  function sync() {
    for (const base of composition.streams) {
      if (streams.has(base)) continue;
      streams.set(base, openWorldStream(base, {
        fetch: opts.fetch,
        WebSocket: opts.WebSocket,
        token: typeof opts.token === "function" ? opts.token(base) : opts.token,
        onEvent: (evt) => {
          live.events += 1;
          const named = (evt.urls || []).map((u) => new URL(u, base).href);
          if (named.some((u) => reader.cache.has(u))) return recompose(evt);
          return undefined;
        },
        onResync: (evt) => recompose(evt),
      }));
    }
    for (const [base, stream] of streams) {
      if (!composition.streams.includes(base)) { stream.close(); streams.delete(base); }
    }
  }

  sync();
  return {
    get composition() { return composition; },
    streams,
    live,
    idle: () => running,
    close() { closed = true; for (const stream of streams.values()) stream.close(); },
  };
}
