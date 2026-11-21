// web/wow-extension-mount.mjs
//
// The async mount pass for the extensions a world's nodes carry. buildWowScene (web/wow-scene.mjs) finds and checks
// the declarations (`extension_nodes`); this pass fetches each module, loads it with the extension host's
// loadExtension (one Web Worker per extension), and draws the scene nodes it makes under the node that carries it, in
// that node's frame.
//
// The order, per declaration:
//   1. A declaration buildWowScene refused stays refused (stage `declaration`).
//   2. The world file must be served from this page's origin (stage `origin`). Nothing is fetched otherwise.
//   3. module.url is resolved against the world file URL and fetched (stage `fetch`).
//   4. The attachment-confined tokens the declaration requests are granted by host policy, with the prompted tokens a
//      current grant record already holds for this placement (web/wow-extension-consent.mjs). Any other requested
//      token is listed as needing consent. With a document, the pass then shows one consent dialog per extension (one
//      at a time), while the extension runs with what it has; each token the user allows joins its grant at once
//      (extension.setGrant). Without a document nothing is asked and nothing more is granted.
//   5. loadExtension checks the integrity, the imports and the memory, and starts the worker (stages `integrity`,
//      `imports`, `memory`, `worker`, `init`, `open`).
//   6. Each host node becomes a Group `ue-node:<name>` under a container in the carrying node's group. A node with a
//      resource is loaded with the injected glTF loader; one that does not load gets the labeled "unavailable"
//      placeholder. Node updates (node-set-transform and the others) are applied as the extension makes them.
//
// The result also carries withdraw(record), which takes a record's prompted tokens back at once (the next call returns
// -2 and its requests in flight are aborted), and pointer({ object, type, point }), which hands a pointer event on a
// `ue-node:` object to the attachment that made it, only while that attachment holds ue.input.pointer: one enter or
// leave per change of the node under the pointer, and at most 30 events per second per attachment.
//
// While the document is hidden (document.visibilityState "hidden"), no timer and no pointer event reaches an extension:
// pointer() sends nothing and each extension is paused (extension.setPaused), so its host holds each timer that comes
// due and fires it once when the page is visible again. The host's time budgets (a soft and a hard limit per call, a
// budget per second) are its own; a record's extension.overruns counts its calls over the soft limit.
//
// A node may also point to signed carrier manifests (`universal_extension_manifests`). Before any module is fetched,
// each carrier is fetched, its signature verified, its dates checked and each extension's signed entity.statusRef (if
// any) resolved, and only then are its extension facets read (web/wow-extension-manifest-adapter.mjs; stages `manifest-fetch`, `signature`,
// `validity`, `status`, `facet`). Its extensions
// follow the node's own declarations, with the next indices, and run by the same steps 2 to 6. Their grants and storage
// are keyed by the carrier subject, the key the signature verified under, module.integrity and attach, never by the
// manifest or facet @id.
//
// Every refusal or failure leaves a warn-tinted marker named `ue-refused:<stage>:<label>#<index>` or
// `ue-failed:<stage>:<label>#<index>`, with the stage in userData.ueStage. Nothing throws out of the pass.
//
// PURE of the DOM and of `three` (THREE, loadExtension, fetch and the glTF loader are injected). The input side is
// renderer-neutral: host node descriptions in, objects out. Renderer-specific object building is the few functions
// marked THREE below; an X3D adapter can replace them.
import { createUnavailableAssetPlaceholder, extensionTokensNeedingConsent, makeExtensionMarker, resolveAssetUri, EXTENSION_CONSENT_NOTE, EXTENSION_HOST_GRANTED_TOKENS } from "./wow-scene.mjs";
import { drawLabelCanvas } from "./label-canvas.mjs";
import { createConsentQueue, createGrantStore, placementKeyOf, POINTER_TOKEN, promptedTokens, purposeOf } from "./wow-extension-consent.mjs";
import { readCarrierManifest } from "./wow-extension-manifest-adapter.mjs";
import { verifyManifestProfileA } from "./signing/um-signature-profile-a.mjs";

/** Stages at which the Lab refuses a declaration before it runs; the others are failures. */
const REFUSAL_STAGES = new Set(["declaration", "origin", "manifest-fetch", "signature", "validity", "status", "facet", "integrity", "compile", "imports", "memory"]);
const UE_ROOT_BASE = 2 ** 40;
/** Pointer events: at most this many per second per attachment. */
export const POINTER_EVENTS_PER_SECOND = 30;
const POINTER_TYPES = new Set(["move", "down", "up", "click"]);

// How each binding's host nodes attach. A node whose parent is another node of the same extension goes under that
// node; a root node (rp1: no parent; ue-core/0: the attachment root) goes under the extension's container.
const RP1_NODES = Object.freeze({ isRoot: (node) => node.parent === null || node.parent === undefined });
const UE_CORE_NODES = Object.freeze({ isRoot: (node, attachment) => String(node.parent) === String(UE_ROOT_BASE + attachment) });
const NODE_ADAPTERS = Object.freeze({
  "rp1-sneeze-call": RP1_NODES,
  "ue-core/0": UE_CORE_NODES,
});

const oneLine = (error) => String((error && error.message) || error).replace(/\s+/g, " ").trim();
const poseKey = (node) => JSON.stringify([node.position || null, node.rotation || null, node.scale || null]);

function disposeObject(root) {
  if (!root || typeof root.traverse !== "function") return;
  root.traverse((object) => {
    if (object.geometry && typeof object.geometry.dispose === "function") object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
    for (const material of materials) {
      if (material && material.map && typeof material.map.dispose === "function") material.map.dispose();
      if (material && typeof material.dispose === "function") material.dispose();
    }
  });
}

/**
 * mountWowExtensions(extensionNodes, THREE, opts) -> Promise<{ records, mounted, refused, failed, needs_consent,
 * summary, sync(), unmount() }>
 *
 * @param {Array}  extensionNodes  buildWowScene's `extension_nodes`
 * @param {object} THREE           injected Three.js namespace
 * @param {object} opts            { loadExtension, worldUrl, pageOrigin, loadGltf?, fetch?, document?, shouldMount?,
 *                                   syncMs?, storage?, grantStore?, verifyManifest?, now?, statusTransport?, fetchLimitMs? }
 * `storage` (the page's localStorage) holds the remembered grants and the extensions' storage; `grantStore` (from
 * createGrantStore) keeps session grants across mount passes of one page. `verifyManifest` (default
 * verifyManifestProfileA), `now` (default Date.now), `statusTransport` (default: a GET through `fetch`) and
 * `fetchLimitMs` (default 10 s, the limit of the carrier fetch and of each status fetch) go to the carrier manifest
 * adapter.
 * Never rejects. `unmount()` shuts every extension down and removes what the pass drew.
 */
export async function mountWowExtensions(extensionNodes, THREE, opts = {}) {
  const nodes = Array.isArray(extensionNodes) ? extensionNodes : [];
  const loadExtension = typeof opts.loadExtension === "function" ? opts.loadExtension : null;
  const loadGltf = typeof opts.loadGltf === "function" ? opts.loadGltf : null;
  const fetchModule = typeof opts.fetch === "function" ? opts.fetch : (url, init) => globalThis.fetch(url, init);
  const shouldMount = typeof opts.shouldMount === "function" ? opts.shouldMount : () => true;
  const doc = opts.document || null;
  const worldUrl = opts.worldUrl;
  const pageOrigin = opts.pageOrigin;
  const granted = new Set(EXTENSION_HOST_GRANTED_TOKENS);
  const syncMs = Number.isFinite(opts.syncMs) && opts.syncMs > 0 ? opts.syncMs : 100;
  const storage = opts.storage || null;
  const grantStore = opts.grantStore || createGrantStore({ storage });
  const consent = doc ? createConsentQueue(doc) : null;
  const listeners = new Set();
  const notifyChange = () => { for (const listener of [...listeners]) { try { listener(); } catch {} } };
  let worldOrigin = null;
  try { worldOrigin = new URL(worldUrl).origin; } catch { worldOrigin = null; }

  const records = [];
  const addRecord = (node, index, declaration, validation, carrier = null) => records.push({
    node_id: node.node_id, label: node.label, index, node, group: node.group,
    declaration, validation, carrier,
    status: "pending", stage: null, error: null,
    extension: null, attachment: null, module_url: null, grant: [], host_grant: [], needs_consent: [], placement_key: null,
    pointer: { times: [] }, overruns: 0,
    container: null, marker: null, objects: new Map(),
  });
  for (const node of nodes) node.validations.forEach((validation, index) => addRecord(node, index, node.declarations[index], validation));
  // Carrier manifests: fetched and verified (only from a world on this page's origin) before any module is fetched.
  const carrierRefs = (node) => (Array.isArray(node.manifest_refs) ? node.manifest_refs : []);
  const readCarrier = (node, ref) => {
    if (ref.error) return { ok: false, stage: "declaration", detail: ref.error };
    if (worldOrigin !== pageOrigin) return { ok: false, stage: "origin", detail: `the world file is served from ${worldOrigin}, not from this page's origin ${pageOrigin}` };
    return readCarrierManifest({ manifestUrl: resolveAssetUri(ref.url, worldUrl), nodeId: node.node_id, fetch: fetchModule, now: opts.now, verify: opts.verifyManifest || verifyManifestProfileA, statusTransport: opts.statusTransport, fetchLimitMs: opts.fetchLimitMs })
      .catch((error) => ({ ok: false, stage: "manifest-fetch", detail: oneLine(error) }));
  };
  const carried = await Promise.all(nodes.map((node) => Promise.all(carrierRefs(node).map((ref) => readCarrier(node, ref)))));
  nodes.forEach((node, at) => {
    let index = node.validations.length;
    for (const read of carried[at]) {
      if (!read.ok) { addRecord(node, index++, null, { ok: false, stage: read.stage, detail: read.detail }); continue; }
      for (const item of read.extensions) {
        addRecord(node, index++, null, item.ok ? { ok: true, effective: item.effective } : { ok: false, stage: item.stage, detail: item.detail }, item.ok ? item.carrier : null);
      }
    }
  });
  const needsConsent = [];
  const gltfCache = new Map();
  let attachments = 0;
  let unmounted = false;
  let timer = null;

  // ---- THREE: markers, labels and node objects ----

  function label(object, lines, warn) {
    if (!doc) return;
    const canvas = drawLabelCanvas(doc, lines, { background: "rgba(10, 12, 18, 0.85)", stroke: warn ? "#ff6b3a" : "#7ee0a8", color: "#ffffff" }, { width: 768 });
    if (!canvas) return;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, transparent: true }));
    const width = 1.4;
    sprite.scale.set(width, (width * canvas.height) / canvas.width, 1);
    sprite.position.y = 1.15;
    sprite.name = `ue-label:${lines[0]}`;
    object.add(sprite);
  }

  function markStage(record, status, stage, detail) {
    const prefix = status === "refused" ? "ue-refused" : "ue-failed";
    const name = `${prefix}:${stage}:${record.label}#${record.index}`;
    // A declaration buildWowScene refused already has its marker.
    let marker = record.group.children.find((child) => child.name === name) || null;
    if (!marker) {
      marker = makeExtensionMarker(THREE, name, { stage, detail });
      marker.position.x = 0.75 * record.index;
      record.group.add(marker);
      marker.userData.ueMountMarker = true;
    }
    if (doc && !marker.children.some((child) => /^ue-label:/.test(child.name))) label(marker, [record.label, `${status} at ${stage}`], true);
    record.marker = marker;
  }

  function createNodeObject(record, node) {
    const object = new THREE.Group();
    object.name = `ue-node:${node.name || node.composed}`;
    object.userData = {
      composed: node.composed, reference: node.reference || "", kind: node.kind || null, class: node.class ?? null,
      attachment: node.attachment, extension: `${record.label}#${record.index}`,
    };
    return object;
  }

  function placeNode(object, node) {
    const position = Array.isArray(node.position) && node.position.length === 3 ? node.position : [0, 0, 0];
    const rotation = Array.isArray(node.rotation) && node.rotation.length === 4 ? node.rotation : [0, 0, 0, 1];
    const scale = Array.isArray(node.scale) && node.scale.length === 3 ? node.scale : [1, 1, 1];
    object.position.fromArray(position);
    object.quaternion.fromArray(rotation);
    object.scale.fromArray(scale);
    object.userData.poseKey = poseKey(node);
  }
  const changed = (object, node) => object.userData.poseKey !== poseKey(node);

  async function loadResource(record, object, node) {
    for (const child of [...object.children]) if (child.userData && child.userData.ueResource) {
      object.remove(child);
      disposeObject(child);
    }
    const reference = node.reference || "";
    object.userData.reference = reference;
    if (!reference) return;
    const url = resolveAssetUri(reference, worldUrl);
    let model = null, error = null;
    try {
      if (!loadGltf) throw new Error("no glTF loader injected");
      if (!gltfCache.has(url)) gltfCache.set(url, Promise.resolve().then(() => loadGltf(url, { label: record.label, uri: reference })));
      const template = await gltfCache.get(url);
      if (!template) throw new Error("the loader returned no scene");
      model = template.clone(true);
      model.name = `ue-resource:${reference}`;
    } catch (failure) {
      error = oneLine(failure);
      model = createUnavailableAssetPlaceholder(THREE, `${node.name || node.composed}`);
      model.userData.ueResourceError = error;
      if (doc) label(model, [node.name || String(node.composed), "model unavailable"], true);
    }
    if (unmounted || object.userData.reference !== reference || !object.parent) {
      disposeObject(model);
      return;
    }
    model.userData.ueResource = true;
    object.add(model);
  }

  // ---- Host nodes -> objects ----

  /** Applies the extension's current host nodes: creates, moves, re-parents and removes objects. */
  function sync(record) {
    if (record.status !== "mounted" || !record.extension || !record.container) return;
    const adapter = NODE_ADAPTERS[record.validation.effective.module.binding];
    const list = record.extension.nodes;
    const seen = new Set();
    for (const node of list) {
      seen.add(node.composed);
      let object = record.objects.get(node.composed);
      if (!object) {
        object = createNodeObject(record, node);
        record.objects.set(node.composed, object);
        record.container.add(object);
        placeNode(object, node);
        if (doc) label(object, [node.name || String(node.composed)], false);
        void loadResource(record, object, node);
      }
      else if (changed(object, node)) placeNode(object, node);
      if ((node.reference || "") !== object.userData.reference) void loadResource(record, object, node);
    }
    for (const node of list) {
      const object = record.objects.get(node.composed);
      const parent = adapter.isRoot(node, record.attachment.index) ? record.container : record.objects.get(String(node.parent)) || record.container;
      if (object.parent !== parent) parent.add(object);
    }
    for (const [composed, object] of record.objects) {
      if (seen.has(composed)) continue;
      object.removeFromParent();
      disposeObject(object);
      record.objects.delete(composed);
    }
  }

  // ---- The pass ----

  function settle(record, status, stage, detail) {
    record.status = status;
    record.stage = stage;
    record.error = detail;
    markStage(record, status, stage, detail);
    return record;
  }
  const refuse = (record, stage, detail) => settle(record, "refused", stage, detail);
  const fail = (record, stage, detail) => settle(record, REFUSAL_STAGES.has(stage) ? "refused" : "failed", stage, detail);
  const failure = (record, extension) => fail(record, (extension && extension.stage) || "worker", (extension && extension.error) || "loadExtension gave no extension");

  async function mountOne(record) {
    if (!record.validation.ok) return refuse(record, record.validation.stage || "declaration", record.validation.detail);
    const effective = record.validation.effective;
    if (!NODE_ADAPTERS[effective.module.binding]) return refuse(record, "declaration", `the mount has no node adapter for binding ${effective.module.binding}`);
    if (worldOrigin !== pageOrigin) return refuse(record, "origin", `the world file is served from ${worldOrigin}, not from this page's origin ${pageOrigin}; the Lab runs extensions only from world files served from its own origin`);
    if (!loadExtension) return fail(record, "worker", "no extension host injected");

    // A carrier's module.url resolves against the carrier manifest's URL.
    const moduleUrl = resolveAssetUri(effective.module.url, record.carrier ? record.carrier.manifest_url : worldUrl);
    record.module_url = moduleUrl;
    let bytes;
    try {
      const response = await fetchModule(moduleUrl);
      if (!response || !response.ok) throw new Error(`HTTP ${response && response.status}`);
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      return fail(record, "fetch", `${moduleUrl}: ${oneLine(error)}`);
    }

    // Host policy: only the attachment-confined tokens, and only where requested; with the prompted tokens a current
    // grant record holds for this placement.
    const requested = effective.requests;
    const grant = requested.filter((token) => granted.has(token));
    record.host_grant = [...grant];
    const placement = record.carrier ? { world: "", node: record.carrier.placement } : { world: worldUrl, node: String(record.node_id) };
    record.placement_key = placementKeyOf({ ...placement, integrity: effective.module.integrity, attach: effective.attach });
    for (const token of grantStore.granted(record.placement_key, effective)) if (!grant.includes(token)) grant.push(token);
    record.grant = grant;
    record.needs_consent = extensionTokensNeedingConsent(effective).filter((token) => !grant.includes(token));
    record.attachment = { index: (attachments += 1), fabric: { Data: effective.data || {} }, placement };

    const extension = await loadExtension({ bytes, declaration: effective, grant, attachment: record.attachment, ...(storage ? { storage } : {}) });
    record.extension = extension || null;
    if (!extension || !extension.ok) return failure(record, extension);
    if (unmounted || !shouldMount()) {
      try { await extension.shutdown(); } catch {}
      record.status = "cancelled";
      return record;
    }
    if (record.needs_consent.length) {
      needsConsent.push({ node_id: record.node_id, label: record.label, index: record.index, tokens: record.needs_consent, note: EXTENSION_CONSENT_NOTE });
    }
    record.status = "mounted";
    const container = new THREE.Group();
    container.name = `ue-extension:${record.label}#${record.index}`;
    container.userData = { binding: effective.module.binding, module: moduleUrl, attachment: record.attachment.index };
    record.container = container;
    record.group.add(container);
    sync(record);
    return record;
  }

  await Promise.all(records.map((record) => mountOne(record).catch((error) => fail(record, "worker", oneLine(error)))));

  // ---- Consent, withdrawal and pointer input ----

  const promptedOf = (record) => record.grant.filter((token) => !record.host_grant.includes(token));
  async function applyGrant(record, grant) {
    record.grant = grant;
    record.needs_consent = extensionTokensNeedingConsent(record.validation.effective).filter((token) => !grant.includes(token));
    if (record.extension && typeof record.extension.setGrant === "function" && record.status === "mounted") {
      await record.extension.setGrant(record.attachment.index, grant);
    }
    notifyChange();
  }
  // One dialog per extension that requests prompted tokens it does not hold yet, in the records' order.
  async function askConsent(record) {
    const effective = record.validation.effective;
    const asked = promptedTokens(effective).filter((token) => !record.grant.includes(token));
    if (!asked.length) return;
    const answer = await consent.ask({
      extension: `${record.label}#${record.index}`, label: record.label, moduleUrl: record.module_url, integrity: effective.module.integrity,
      tokens: asked, purposes: Object.fromEntries(asked.map((token) => [token, purposeOf(effective, token)])),
      ...(record.carrier ? { carrier: { subject: record.carrier.subject, fingerprint: record.carrier.fingerprint } } : {}),
    });
    if (unmounted || record.status !== "mounted" || !answer.allowed.length) return;
    const allowed = asked.filter((token) => answer.allowed.includes(token));
    grantStore.grant(record.placement_key, effective, allowed, { remember: answer.remember });
    await applyGrant(record, [...new Set([...record.grant, ...allowed])]);
  }
  const consentDone = consent
    ? (async () => { for (const record of records) if (record.status === "mounted" && !unmounted) await askConsent(record); })().catch(() => {})
    : Promise.resolve();

  function withdraw(record) {
    if (!record || !record.placement_key) return false;
    const withdrawnAt = grantStore.withdraw(record.placement_key);
    void applyGrant(record, [...record.host_grant]);
    return withdrawnAt;
  }
  function stateOf(record) {
    if (record.status === "refused" || record.status === "failed") return record.status;
    if (record.status === "mounted" && record.extension && record.extension.running !== false) return "running";
    if (record.status === "pending") return "pending";
    return "ended";
  }

  // A hidden page: no pointer event is sent, and every extension is paused until the page is visible.
  const isHidden = () => !!doc && doc.visibilityState === "hidden";
  const applyVisibility = () => {
    const hidden = isHidden();
    for (const record of records) if (record.extension && typeof record.extension.setPaused === "function") record.extension.setPaused(hidden);
  };
  const watchesVisibility = !!doc && typeof doc.addEventListener === "function";
  if (watchesVisibility) doc.addEventListener("visibilitychange", applyVisibility);
  if (isHidden()) applyVisibility();

  // Pointer input. `object` is the hit object (or one under it) or null for none; `point` is the world point.
  let hovered = null;
  const recordOfObject = (object) => {
    let node = null;
    for (let at = object; at; at = at.parent) {
      if (!node && typeof at.name === "string" && at.name.startsWith("ue-node:")) node = at;
      const record = records.find((item) => item.container && item.container === at);
      if (record) return node ? { record, node } : null;
    }
    return null;
  };
  function sendPointer(target, event, point) {
    const { record, node } = target;
    if (record.status !== "mounted" || !record.extension || typeof record.extension.notify !== "function") return false;
    if (!record.grant.includes(POINTER_TOKEN)) return false;
    const now = Date.now();
    const times = record.pointer.times.filter((at) => now - at < 1000);
    record.pointer.times = times;
    if (times.length >= POINTER_EVENTS_PER_SECOND) return false;
    times.push(now);
    const composed = Number(node.userData.composed);
    void record.extension.notify(record.attachment.index, {
      type: "pointer", attachment: record.attachment.index, node: Number.isSafeInteger(composed) ? composed : String(node.userData.composed),
      event, point: Array.isArray(point) && point.length === 3 ? point.map(Number) : [0, 0, 0],
    });
    return true;
  }
  function pointer({ object = null, type = "move", point = null } = {}) {
    if (unmounted || isHidden() || !POINTER_TYPES.has(type)) return false;
    const target = object ? recordOfObject(object) : null;
    if (type === "move") {
      const same = hovered && target && hovered.node === target.node;
      if (same || (!hovered && !target)) return false;
      if (hovered) sendPointer(hovered, "leave", point);
      hovered = target;
      if (target) sendPointer(target, "enter", point);
      return true;
    }
    return target ? sendPointer(target, type, point) : false;
  }

  // Every node's declarations are settled: its "not mounted yet" placeholder goes.
  for (const node of nodes) {
    if (node.placeholder && node.placeholder.parent) {
      node.placeholder.parent.remove(node.placeholder);
      disposeObject(node.placeholder);
    }
  }
  const live = () => records.filter((record) => record.status === "mounted");
  // Each sync also tells the panel when an extension's count of overruns changed.
  const syncAll = () => {
    let slower = false;
    for (const record of live()) {
      sync(record);
      const overruns = (record.extension && record.extension.overruns) || 0;
      if (overruns !== record.overruns) {
        record.overruns = overruns;
        slower = true;
      }
    }
    if (slower) notifyChange();
  };
  if (live().length && !unmounted) timer = setInterval(syncAll, syncMs);

  const result = {
    records,
    mounted: records.filter((record) => record.status === "mounted"),
    refused: records.filter((record) => record.status === "refused"),
    failed: records.filter((record) => record.status === "failed"),
    needs_consent: needsConsent,
    summary: null,
    grantStore,
    consentDone,
    withdraw,
    stateOf,
    promptedGrant: promptedOf,
    pointer,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sync() { for (const record of live()) sync(record); },
    async unmount() {
      if (unmounted) return;
      unmounted = true;
      if (timer) clearInterval(timer);
      if (watchesVisibility && typeof doc.removeEventListener === "function") doc.removeEventListener("visibilitychange", applyVisibility);
      if (consent) consent.clear();
      for (const record of records) {
        if (record.extension && record.extension.ok) {
          try { await record.extension.shutdown(); } catch {}
        }
        for (const object of record.objects.values()) disposeObject(object);
        record.objects.clear();
        if (record.container) {
          record.container.removeFromParent();
          disposeObject(record.container);
          record.container = null;
        }
        if (record.marker && record.marker.userData.ueMountMarker) {
          record.marker.removeFromParent();
          disposeObject(record.marker);
        }
        if (record.status === "mounted") record.status = "unmounted";
      }
      notifyChange();
      listeners.clear();
    },
  };
  result.summary = {
    declarations: records.length,
    mounted: result.mounted.length,
    refused: result.refused.length,
    failed: result.failed.length,
    by_stage: Object.fromEntries([...new Set(records.map((record) => record.stage).filter(Boolean))].map((stage) => [stage, records.filter((record) => record.stage === stage).length])),
    needs_consent: needsConsent,
    rule: "extensions run only from world files served from this page's origin, only when the module's SHA-256 matches module.integrity (and, for a carrier manifest, only when its signature verifies and it is within its dates), and with the attachment-confined tokens they request plus the prompted tokens the user allowed",
  };
  return result;
}

export default { mountWowExtensions };
