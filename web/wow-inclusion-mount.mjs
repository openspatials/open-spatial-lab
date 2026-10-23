// web/wow-inclusion-mount.mjs
//
// Shows what a world includes (web/wow-inclusion.mjs) in the `?wow=` player's three.js scene.
//
// After buildWowScene has built world A, this composes A with its inclusions and, for each node of A
// that links another world's Spatial, Node or World, builds the included graph with buildWowScene
// (`bare`: no floor, grid or lights) and mounts it under that node. Included content can include in
// turn, up to the nesting limit and the budget. A link that fails keeps the node's placeholder,
// tinted, with a label naming the reason: "unreachable", "forbidden", "over budget" and the rest.
//
// Model links are left to mountWowSceneAssets, the scene's model loader. A model that sits inside
// included content goes through filterIncludedEnvironment first, so the included world's sun and
// cameras never reach the host.

import {
  composeInclusions,
  observeComposition,
  bundleOfGraph,
  filterIncludedEnvironment,
  INCLUSION_STATUS,
  DEFAULT_BUDGET,
  DEFAULT_NESTING_LIMIT,
} from "./wow-inclusion.mjs";

const COLOR_FAILED = 0xff6b3a;

/** A text label above a placeholder; browser only (it draws on a canvas). */
function labelSprite(THREE, text, doc) {
  if (!doc || typeof doc.createElement !== "function") return null;
  const canvas = doc.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "rgba(20, 12, 8, 0.82)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#ff6b3a";
  ctx.lineWidth = 6;
  ctx.strokeRect(3, 3, canvas.width - 6, canvas.height - 6);
  ctx.fillStyle = "#ffd9c8";
  ctx.font = "bold 54px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.scale.set(2.4, 0.6, 1);
  sprite.position.y = 1.5;
  sprite.renderOrder = 10;
  sprite.name = `wow-inclusion-label:${text}`;
  return sprite;
}

function tint(object3D, color) {
  object3D.traverse((o) => {
    const materials = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of materials) {
      if (m.color && typeof m.color.setHex === "function") m.color.setHex(color);
      if (m.emissive && typeof m.emissive.setHex === "function") m.emissive.setHex(color);
    }
  });
}

/**
 * Compose world A and mount its inclusions.
 *
 * @param {object} opts
 *   built            buildWowScene's result for world A
 *   hostUrl          A's Spatial URL ({A}/wow/spatial/{id})
 *   THREE, buildWowScene
 *   fetch            the fetch to read with (the browser's by default)
 *   nestingLimit, budget
 *   document         for the placeholder labels (none in Node)
 * @returns {Promise<{composition, modelNodes, summary}>}  modelNodes are the asset records, host and
 *   included, that the model loader should load; included ones carry `included: true`.
 */
export async function mountWowInclusions(opts) {
  const composition = await composeInclusions(opts.hostUrl, {
    fetch: opts.fetch,
    nestingLimit: Number.isInteger(opts.nestingLimit) ? opts.nestingLimit : DEFAULT_NESTING_LIMIT,
    budget: Number.isInteger(opts.budget) ? opts.budget : DEFAULT_BUDGET,
  });
  return applyComposition(composition, opts);
}

/**
 * Iteration 3: mount A's inclusions and keep them live. A follows the event stream of each world it
 * shows (at most `streamBudget`, 8 by default); each change re-composes with conditional reads and
 * re-mounts the included content. `onModels(modelNodes)` loads the models of re-mounted content.
 */
export async function mountLiveInclusions(opts) {
  let applied = null;
  const live = await observeComposition(opts.hostUrl, {
    fetch: opts.fetch,
    WebSocket: opts.WebSocket,
    nestingLimit: Number.isInteger(opts.nestingLimit) ? opts.nestingLimit : DEFAULT_NESTING_LIMIT,
    budget: Number.isInteger(opts.budget) ? opts.budget : DEFAULT_BUDGET,
    streamBudget: opts.streamBudget,
    onUpdate: (composition) => {
      if (applied) applied.undo();
      applied = applyComposition(composition, opts);
      if (opts.onModels) opts.onModels(applied.modelNodes.filter((n) => n.included));
      if (opts.onUpdate) opts.onUpdate(applied.summary, live);
    },
  });
  applied = applyComposition(live.composition, opts);
  return { ...applied, live, current: () => applied };
}

/** Mount one composition into A's built scene. Returns what to load, and `undo` to take it out again. */
export function applyComposition(composition, opts) {
  const { built, hostUrl, THREE, buildWowScene } = opts;
  const added = []; // [object, parent] pairs this mount added
  const hidden = []; // [placeholder, parent] pairs this mount removed
  const summary = {
    host: hostUrl,
    graphs_shown: 0,
    placeholders: [],
    models: 0,
    cycles: composition.cycles.length,
    streams: composition.streams.length,
    environment_left_out: composition.environment.length,
    by_status: {},
  };
  const modelNodes = [];

  // World A's own asset nodes, by node id.
  const hostAssets = new Map((built.asset_nodes || []).map((a) => [Number(a.id), a]));
  for (const record of composition.nodes) {
    if (record.depth !== 0) continue;
    const assetNode = hostAssets.get(Number(record.id));
    if (!assetNode) continue;
    place(record, assetNode);
  }
  for (const inclusion of composition.inclusions) {
    summary.by_status[inclusion.status] = (summary.by_status[inclusion.status] || 0) + 1;
  }
  return {
    composition,
    modelNodes,
    summary,
    undo() {
      for (const [object, parent] of added) parent.remove(object);
      for (const [placeholder, parent] of hidden) if (!placeholder.parent) parent.add(placeholder);
    },
  };

  function attach(parent, object) {
    parent.add(object);
    added.push([object, parent]);
  }

  function place(record, assetNode) {
    const inclusion = record.inclusion;
    if (!inclusion) {
      // A scheme the lab knows (osl-primitive:, osl-portal:) or a link nobody fetched: leave it to
      // the model loader, as before.
      if (!record.included) modelNodes.push(assetNode);
      return;
    }
    if (inclusion.status === INCLUSION_STATUS.MODEL) {
      assetNode.uri = inclusion.target;
      assetNode.included = record.included;
      modelNodes.push(assetNode);
      summary.models += 1;
      return;
    }
    if (inclusion.status !== INCLUSION_STATUS.INCLUDED) {
      markFailed(assetNode, inclusion.status);
      summary.placeholders.push({ node: record.url, status: inclusion.status, target: inclusion.target });
      return;
    }
    // Included: build each shown graph and mount it under the including node.
    for (const graph of inclusion.graphs) {
      if (!graph.shown) continue;
      const bundle = bundleOfGraph(composition, graph);
      const sub = buildWowScene(bundle, THREE, { bare: true, source: `included:${graph.url}` });
      sub.root.name = `wow-included:${graph.url}`;
      sub.root.userData.inclusion = { from: graph.url, via: record.url, depth: graph.depth };
      attach(assetNode.group, sub.root);
      summary.graphs_shown += 1;
      // The included graph's own links: deeper inclusions and models.
      const subAssets = new Map((sub.asset_nodes || []).map((a) => [Number(a.id), a]));
      for (const inner of composition.nodes) {
        if (inner.instance !== graph.instance) continue;
        const innerAsset = subAssets.get(bundle.idOf.get(inner.url));
        if (!innerAsset) continue;
        place(inner, innerAsset);
      }
    }
    if (inclusion.overBudget) {
      // Some of a world's graphs fit the budget and some did not: say so on the node.
      const label = labelSprite(THREE, INCLUSION_STATUS.OVER_BUDGET, opts.document);
      if (label) attach(assetNode.group, label);
    }
    if (assetNode.placeholder && assetNode.placeholder.parent) {
      hidden.push([assetNode.placeholder, assetNode.placeholder.parent]);
      assetNode.placeholder.parent.remove(assetNode.placeholder);
    }
  }

  function markFailed(assetNode, status) {
    const placeholder = assetNode.placeholder;
    if (placeholder) {
      tint(placeholder, COLOR_FAILED);
      placeholder.userData.inclusionStatus = status;
      placeholder.name = `wow-inclusion-${status.replace(/\s+/g, "-")}:${assetNode.label}`;
      const label = labelSprite(THREE, status, opts.document);
      if (label) attach(placeholder, label);
    }
    assetNode.inclusion_status = status;
  }
}

/**
 * A cloneScene for mountWowSceneAssets that drops the included world's environment from models
 * inside included content (filterIncludedEnvironment) and leaves the host's own models alone.
 */
export function environmentAwareClone(baseClone) {
  return (template, rec) => {
    const model = baseClone(template, rec);
    if (rec && rec.included) {
      const result = filterIncludedEnvironment(model);
      model.userData.includedEnvironment = result;
    }
    return model;
  };
}
