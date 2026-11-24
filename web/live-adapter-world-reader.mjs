import { readGeoPose } from "./wow-geopose.mjs";
import { flattenCanonicalNode } from "./wow-graph.mjs";
import { readPortalResources } from "./main-demo-portals.mjs";

/**
 * A Spatial's extent: { min, max }, each three finite numbers, in meters, in the graph's frame. An extent whose
 * `min` exceeds `max` on an axis, or that is not two corners of three numbers, is treated as absent (null).
 */
export function readSpatialExtent(value) {
  const corner = (c) => Array.isArray(c) && c.length === 3 && c.every((n) => typeof n === "number" && Number.isFinite(n));
  if (!value || typeof value !== "object" || !corner(value.min) || !corner(value.max)) return null;
  for (let axis = 0; axis < 3; axis += 1) {
    if (value.min[axis] > value.max[axis]) return null;
  }
  return { min: value.min.slice(), max: value.max.slice() };
}

export async function readGraph(graphUrl, doc, { transport, onLog }) {
  let rootNode = doc;
  let anchor = null;
  let anchorError = null;
  let extent = null;
  if (doc && doc.rootNodeID !== undefined && doc.children === undefined) {
    const read = readGeoPose(doc.geoPose);
    if (read.ok) anchor = read.geoPose;
    else anchorError = read.error;
    extent = readSpatialExtent(doc.extent);
    const base = String(graphUrl).replace(/\/$/, "");
    rootNode = await transport.getJson(`${base}/node/${encodeURIComponent(doc.rootNodeID)}`);
  }
  const walked = await walkCanonicalGraph(graphUrl, rootNode, { transport, onLog });
  return { rootId: Number(rootNode.id), nodes: walked.nodes, stats: walked.stats, anchor, anchorError, extent };
}

export async function walkCanonicalGraph(graphUrl, rootNode, { transport, onLog }) {
  const CAP = 4096;
  const base = String(graphUrl).replace(/\/$/, "");
  const nodes = {};
  const stats = { fetched: 0, failed: 0, cap_hit: false };
  const queue = [];
  const take = (node) => {
    const flat = flattenCanonicalNode(node);
    Object.assign(nodes, flat.nodes);
    for (const child of Array.isArray(node.children) ? node.children : []) {
      if (typeof child === "number" || typeof child === "string") queue.push(Number(child));
    }
  };
  take(rootNode);
  const seen = new Set([Number(rootNode.id)]);
  while (queue.length) {
    if (Object.keys(nodes).length >= CAP) { stats.cap_hit = true; break; }
    const id = Number(queue.shift());
    if (seen.has(id) || nodes[id]) continue;
    seen.add(id);
    try {
      const n = await transport.getJson(`${base}/node/${encodeURIComponent(id)}`);
      if (n && n.id != null) {
        take(n);
        stats.fetched += 1;
      } else {
        stats.failed += 1;
      }
    } catch (err) {
      stats.failed += 1;
      onLog(`wow: node ${id} fetch failed (${err.message})`);
    }
  }
  return { nodes, stats };
}

export async function readWorld({ wowRef, base, transport, onLog }) {
  if (!wowRef) throw new Error("initWow requires a wowRef (?wow=<url|id>)");
  const looksLikeDoc = /[/.]/.test(wowRef) || /^https?:/i.test(wowRef);
  const graphUrl = looksLikeDoc
    ? wowRef
    : `${base}/wow/spatial/${encodeURIComponent(wowRef)}`;
  onLog(`wow: opening world "${wowRef}" -> graph ${graphUrl}`);
  const doc = await transport.getJson(graphUrl);

  let graph, source, canonicalWalk = null;
  if (doc && doc.nodes && (Array.isArray(doc.nodes) || typeof doc.nodes === "object")) {
    const hasExplicitRoot = doc.root != null || doc.rootId != null;
    graph = {
      spatialID: doc.spatialID || doc.spatial_id || wowRef,
      root: doc.root != null ? doc.root : doc.rootId != null ? doc.rootId : null,
      nodes: doc.nodes,
      title: doc.title || null,
      world: doc.world || null,
      // World-level members: a place's extension store and withdrawn list (web/wow-extension-place-store.mjs).
      webofworlds_extension: doc.webofworlds_extension || null,
    };
    source = hasExplicitRoot ? "bundled-world-graph" : "bundled-world-graph";
  } else if (doc && doc.id !== undefined) {
    const read = await readGraph(graphUrl, doc, { transport, onLog });
    graph = { spatialID: wowRef, root: read.rootId, nodes: read.nodes, anchor: read.anchor };
    source = "canonical-walk";
    canonicalWalk = read.stats;
  } else {
    throw new Error(
      `wow graph at ${graphUrl} is neither a dev-bundle {root,nodes} nor a canonical root Node {id,children}`
    );
  }

  const nodeCount =
    graph.nodes && !Array.isArray(graph.nodes)
      ? Object.keys(graph.nodes).length
      : (graph.nodes || []).length;

  const resolved = worldResolution({ graph, source, graphUrl, doc, canonicalWalk, nodeCount });
  onLog(
    `wow: resolved spatialID=${graph.spatialID} nodes=${nodeCount} source=${source}` +
      (canonicalWalk ? ` (walk: fetched=${canonicalWalk.fetched} failed=${canonicalWalk.failed})` : "")
  );
  return resolved;
}

export async function readSceneGraph(o, { transport, onLog }) {
  const base = o.base;
  const spatialId = o.spatialId || null;
  const record = sceneSourceRecord(o);
  const result = { record, resolved: null };
  try {
    const url =
      o.graphEndpoint ||
      (spatialId ? `${base}/wow/spatial/${encodeURIComponent(spatialId)}` : null);
    if (!url) throw new Error("no spatialId / graphEndpoint to resolve");
    record.graph_url = url;
    const doc = await transport.getJson(url);
    let graph;
    if (doc && doc.nodes && (Array.isArray(doc.nodes) || typeof doc.nodes === "object")) {
      graph = {
        spatialID: doc.spatialID || doc.spatial_id || spatialId,
        root: doc.root != null ? doc.root : doc.rootId != null ? doc.rootId : null,
        nodes: doc.nodes,
      };
    } else if (doc && doc.id !== undefined) {
      const read = await readGraph(url, doc, { transport, onLog });
      graph = { spatialID: spatialId || String(doc.id), root: read.rootId, nodes: read.nodes, anchor: read.anchor };
      record.canonical_walk = read.stats;
      record.anchor = read.anchor;
      record.anchor_error = read.anchorError;
    } else {
      throw new Error("neither a bundle {root,nodes} nor a canonical root Node {id,children}");
    }
    const nodeCount =
      graph.nodes && !Array.isArray(graph.nodes)
        ? Object.keys(graph.nodes).length
        : (graph.nodes || []).length;
    const resolved = sceneResolution({ o, graph, doc, url, record, nodeCount });
    result.resolved = resolved;
    record.ok = true;
    record.spatialID = graph.spatialID;
    record.root_id = graph.root;
    record.node_count = nodeCount;
    onLog(
      `wow-scene-source: ${graph.spatialID} graph-sourced (${nodeCount} nodes) from ${url} — ` +
        `replaces the .msf child-fabric as the scene source; .msf not required`
    );
  } catch (e) {
    record.error = e.message;
    onLog(
      `wow-scene-source: graph resolve best-effort failed (${e.message}); ` +
        `crossing continues on the /wow projection (no .msf dependency)`
    );
  }
  return result;
}

function sceneSourceRecord(o) {
  return {
    ok: false,
    via: "wow_composition_graph",
    resolved_from: o.resolvedFrom || null,
    graph_url: null,
    spatialID: null,
    root_id: null,
    node_count: 0,
    canonical_walk: null,
    anchor: null,
    anchor_error: null,
    node_positions_source: "node.localTransform (graph-sourced)",
    resolved_at: new Date().toISOString(),
    error: null,
  };
}

function sceneResolution({ o, graph, doc, url, record, nodeCount }) {
  return {
      graph,
      source: "wow_composition_graph",
      spatialID: graph.spatialID,
      node_count: nodeCount,
      graph_url: url,
      base_url: (doc && doc.base_url) || null,
      canonical_walk: record.canonical_walk,
      authored_graph: Boolean(o.graphEndpoint),
      world: null,
      proof_boundary: null,
    };
}

export async function readRootFabric(base, transport) {
  try { return await transport.getJson(`${base}/fabric.json`); }
  catch { return null; }
}

export function readPortals(base, wowWorld, { transport, onLog }) {
  return readPortalResources({
  getJson: (url) => transport.getJson(url), base, wowWorld,
  onSkip: (resource, why) => onLog(`portal ${resource.id} not shown: ${why}`),
  });
}

function worldResolution({ graph, source, graphUrl, doc, canonicalWalk, nodeCount }) {
  return {
    graph,
    source,
    spatialID: graph.spatialID,
    node_count: nodeCount,
    graph_url: graphUrl,
    base_url: (doc && doc.base_url) || null,
    canonical_walk: canonicalWalk,
    world: null,
    proof_boundary: null,
  };
}
